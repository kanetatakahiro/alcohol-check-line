import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 版 2026-11-16a（11/15・11/16 安藤さんの指示）：すべて架空データ・LINEへの送信なし
//  1. 問い合わせのまとめ：何日前から・受付日
//  2. 返信が要らないLINEは自動で「対応済み」
//  3. 本人への自動送信の最後に「※このメッセージはAIによる自動送信です。」
//  4. 毎週月曜の催促（E-78）の案内を種類ごとに
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const GROUP = 'C' + 'a'.repeat(32), OTHER_GROUP = 'C' + 'b'.repeat(32);
const ADMIN = U(7), STAFF = U(8);
const NOTE = '※このメッセージはAIによる自動送信です。';
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const row = (code, name, dept, userId, { lineOk = true } = {}) => ["'" + code, name, '', '在籍', dept, userId, '', '', lineOk, true, '', '', '', ''];

function setup(props = { INQ_MODE: 'on' }, { now = '2026-11-16T10:00:00+09:00' } = {}) {
  const g = createGas({ files: ['AlcoholCheck.gs', 'Inquiry.gs'], now });
  const master = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = master.insertSheet('従業員マスタ');
  [HEAD, row('90001', '試験 一郎', '部署A', U(1)), row('90002', '試験 二郎', '部署B', U(2))].forEach((r) => m.appendRow(r));
  const gs = master.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [GROUP, '勤怠管理', '2026-10-15', '有効'], [OTHER_GROUP, '部署A', '2026-10-15', '有効']].forEach((r) => gs.appendRow(r));
  const book = g.newSpreadsheet('【テスト】従業員問い合わせ管理（架空）');
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: master.getId(), INQ_SPREADSHEET_ID: book.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake',
    LINE_ADMIN_USER_ID: ADMIN, ...props });
  g.line.members[GROUP] = { [STAFF]: '担当A', [ADMIN]: '管理者' };
  g.line.profiles[U(1)] = 'いちろう'; g.line.profiles[U(2)] = 'じろう'; g.line.profiles[U(4)] = 'よんちゃん'; g.line.profiles[ADMIN] = '管理者';
  return { g, master, book };
}
let seq = 0;
const userMsg = (userId, message, id = 'v' + ++seq) => ({ type: 'message', webhookEventId: id, replyToken: 'rt-' + id, timestamp: 0,
  source: { type: 'user', userId }, message: { id: 'm' + id, ...(typeof message === 'string' ? { type: 'text', text: message } : message) } });
const press = (data, { userId = STAFF, groupId = GROUP, id = 'v' + ++seq } = {}) => ({ type: 'postback', webhookEventId: id, replyToken: 'rt-' + id,
  source: { type: 'group', groupId, userId }, postback: { data } });
const post = (g, ...events) => g.ctx.doPost({ postData: { contents: JSON.stringify({ destination: 'x', events }) } });
const since = (g, n) => { const f = g.fetches.slice(n); return { push: f.filter((x) => x.url.endsWith('/push')), reply: f.filter((x) => x.url.endsWith('/reply')) }; };
const cases = (book) => (book.getSheetByName('問い合わせ') ? book.getSheetByName('問い合わせ').dump().slice(1) : []);
const received = (book) => book.getSheetByName('受信記録').dump().slice(1).map((r) => r[2]);
const STICKER = { type: 'sticker', packageId: '1', stickerId: '2' };

// ---------------- 1. まとめ：何日前から ----------------
test('16a-1 まとめ：状況に受付日からの日数（日本時間の日付の差）と受付日。当日は「今日から」。対応中も同じ形。受付時のお知らせには付けない', () => {
  const { g } = setup();
  const X = g.ctx;
  const at = (s) => new Date(s);
  const now = at('2026-11-16T09:00:00+09:00');
  const c = (s, state = '未対応', staff = '') => ({ state, staff, at: at(s) });
  assert.equal(X.INQ_stateLabel(c('2026-11-16T08:10:00+09:00'), now), '未対応（今日から）');
  assert.equal(X.INQ_stateLabel(c('2026-11-15T23:59:00+09:00'), now), '未対応（1日前から・11/15受付）');
  assert.equal(X.INQ_stateLabel(c('2026-11-13T10:00:00+09:00'), now), '未対応（3日前から・11/13受付）');
  assert.equal(X.INQ_stateLabel(c('2026-11-12T00:01:00+09:00', '対応中', '担当A'), now), '対応中（担当：担当A）（4日前から・11/12受付）');
  // 日本時間の日付で数える（UTCでは同じ日でも、日本時間で前日なら1日前）
  assert.equal(X.INQ_stateLabel(c('2026-11-15T23:30:00+09:00'), at('2026-11-16T00:10:00+09:00')), '未対応（1日前から・11/15受付）');
  // 月・年をまたぐ
  assert.equal(X.INQ_stateLabel(c('2026-10-30T12:00:00+09:00'), at('2026-11-02T09:00:00+09:00')), '未対応（3日前から・10/30受付）');
  assert.equal(X.INQ_stateLabel(c('2026-12-31T12:00:00+09:00'), at('2027-01-01T09:00:00+09:00')), '未対応（1日前から・12/31受付）');
  // now が無い（受付時のお知らせ）は今までどおり
  assert.equal(X.INQ_stateLabel(c('2026-11-13T10:00:00+09:00'), null), '未対応');
});

test('16a-1 まとめ：9:00 のまとめに「（3日前から・11/13受付）」「（今日から）」が出る', () => {
  const { g } = setup({ INQ_MODE: 'on' }, { now: '2026-11-13T14:00:00+09:00' });
  post(g, userMsg(U(1), '有給の残りを教えてください'));
  g.clock.now = new Date('2026-11-16T08:30:00+09:00').getTime();
  post(g, userMsg(U(2), '来月のシフトの相談です'));
  g.clock.now = new Date('2026-11-16T09:00:00+09:00').getTime();
  const n = g.fetches.length;
  g.ctx.INQ_remind();
  const t = since(g, n).push[0].body.messages[0].text;
  assert.match(t, /① 試験 一郎（部署A）\n状況：未対応（3日前から・11\/13受付）\n/);
  assert.match(t, /② 試験 二郎（部署B）\n状況：未対応（今日から）\n/);
  assert.ok(!t.includes(NOTE));   // まとめ（勤怠管理グループ）にはAIの一文を付けない
});

// ---------------- 2. 返信が要らないLINE ----------------
test('16a-2 判定：承知・了解・お礼・よろしくとその言い換えだけ（記号・絵文字・空白・お疲れ様です付きも）なら true。ほかの文が少しでもあれば false', () => {
  const { g } = setup();
  const X = g.ctx;
  for (const t of ['承知しました', '承知いたしました。', '了解です！', '了解しました!', '了解', 'りょうかいです', 'ありがとうございます😊', 'ありがとうございました！！',
    'よろしくお願いします', 'よろしくお願いいたします。', 'わかりました', '分かりました🙇‍♀️', 'かしこまりました', '承知しました。ありがとうございます！',
    'お疲れ様です。承知しました。', 'お疲れさまです！ 了解です👍', '  ありがとうございます  ', '了解です。よろしくお願いします。', '承知しました！お疲れ様です！']) {
    assert.equal(X.INQ_isAckOnly(t), true, t);
  }
  for (const t of ['承知しました。ただ来週の件ですが…', '了解です。明日は休みます', 'ありがとうございます。有給の残りは何日ですか？', 'お疲れ様です', 'お疲れ様です。',
    '', '😊', 'はい', '了解です。シフトの件、確認しました', 'よろしくお願いします。添付を見てください', '有給の申請をお願いします']) {
    assert.equal(X.INQ_isAckOnly(t), false, t);
  }
  assert.equal(X.INQ_isAckMessage({ type: 'sticker', packageId: '1', stickerId: '2' }), true);
  assert.equal(X.INQ_isAckMessage({ type: 'image' }), false);
  // LINE絵文字（本文の「$」の位置）は除いて判定する
  assert.equal(X.INQ_isAckMessage({ type: 'text', text: '了解です$', emojis: [{ index: 4, length: 1, productId: 'p', emojiId: '001' }] }), true);
  assert.equal(X.INQ_isAckMessage({ type: 'text', text: '了解です$ 明日休みます', emojis: [{ index: 4, length: 1 }] }), false);
  // 要注意（⚠）の分類は閉じない。追記は対応中の案件だけ
  assert.equal(X.INQ_shouldAutoClose(true, true, '', 'その他'), true);
  assert.equal(X.INQ_shouldAutoClose(true, true, '', '⚠健康・体調'), false);
  assert.equal(X.INQ_shouldAutoClose(true, false, '対応中', '有給・休み'), true);
  assert.equal(X.INQ_shouldAutoClose(true, false, '未対応', '有給・休み'), false);
  assert.equal(X.INQ_shouldAutoClose(true, false, '対応中', '健康・体調'), false);
  assert.equal(X.INQ_shouldAutoClose(false, true, '', 'その他'), false);
});

test('16a-2 新しい受付が「承知しました！😊」だけ：対応済み・完了者「AI（自動）」・完了日時。グループへのお知らせなし・受信記録に残す・まとめに入らない', () => {
  const { g, book } = setup();
  const n = g.fetches.length;
  post(g, userMsg(U(1), '承知しました！😊'));
  const s = since(g, n);
  assert.equal(s.push.length, 0);
  assert.equal(s.reply.length, 0);
  const c = cases(book)[0];
  assert.equal(c[1], '対応済み');
  assert.equal(c[16], 'AI（自動）');
  assert.equal(new Date(c[18]).toISOString(), '2026-11-16T01:00:00.000Z');
  assert.equal(c[13], '');                                                     // 担当者は空のまま
  assert.match(received(book)[0], /^受付 Q-20261116-001（自動で対応済み：返信不要）$/);
  assert.deepEqual(book.getSheetByName('やりとり').dump().slice(1).map((r) => r[2]), ['受付', '対応済み（自動：返信不要）']);
  const m = g.fetches.length;
  g.ctx.INQ_remind();
  assert.equal(since(g, m).push.length, 0);                                    // まとめの件数に入れない（0件なら送らない）
  // 次の本当の問い合わせは新しい案件になり、今までどおり知らせる
  post(g, userMsg(U(1), '来週の有給について相談です'));
  assert.equal(cases(book).length, 2);
  assert.equal(cases(book)[1][1], '未対応');
  assert.equal(since(g, m).push.length, 1);
  // 自動で閉じた案件の古いボタンを押したとき：「AI（自動）さん」にしない
  const replies = () => g.fetches.filter((f) => f.url.endsWith('/reply')).map((f) => f.body.messages[0].text);
  post(g, press(`inq|1|done|${c[0]}|${c[20]}`));
  assert.equal(replies().at(-1), '試験 一郎（部署A）の問い合わせは対応済みです（11/16（月） 10:00・AI（自動））。');
});

test('16a-2 対応中の案件への「了解です」：対応済みにして追記の通知も送らない。未対応への「よろしくお願いします」は閉じない（質問の続き）', () => {
  const { g, book } = setup();
  post(g, userMsg(U(1), '有給の残りを教えてください'));
  const n0 = g.fetches.length;
  post(g, userMsg(U(1), 'よろしくお願いします'));                              // 未対応への追記：閉じない
  assert.equal(cases(book)[0][1], '未対応');
  assert.equal(since(g, n0).push.length, 0);                                   // 未対応への追記は今までどおり通知しない
  const [id, token] = [cases(book)[0][0], cases(book)[0][20]];
  post(g, press(`inq|1|take|${id}|${token}`));
  g.clock.now += 60 * 60000;
  const n1 = g.fetches.length;
  post(g, userMsg(U(1), '了解です。ありがとうございました！'));
  assert.equal(since(g, n1).push.length, 0);                                   // 追記の通知（30分に1回）も送らない
  const c = cases(book)[0];
  assert.deepEqual([c[1], c[13], c[16], c[12]], ['対応済み', '担当A', 'AI（自動）', 2]);
  assert.match(received(book).at(-1), /^追記 Q-20261116-001（自動で対応済み：返信不要）$/);
});

test('16a-2 ほかの文を含む・要注意（⚠）の案件・記録のみ（record）・スタンプ・未登録の人', () => {
  // ほかの文を含む：今までどおり受付・お知らせ
  const a = setup();
  let n = a.g.fetches.length;
  post(a.g, userMsg(U(1), '承知しました。ただ来週の件ですが、確認させてください'));
  assert.equal(cases(a.book)[0][1], '未対応');
  assert.equal(since(a.g, n).push.length, 1);
  // 要注意（⚠健康・体調）の案件は、対応中でも「承知しました」で閉じない
  const b = setup();
  post(b.g, userMsg(U(1), '昨日から体調が悪くて病院に行きました'));
  post(b.g, press(`inq|1|take|${cases(b.book)[0][0]}|${cases(b.book)[0][20]}`));
  b.g.clock.now += 60 * 60000;
  post(b.g, userMsg(U(1), '承知しました'));
  assert.equal(cases(b.book)[0][1], '対応中');
  // スタンプ：案件の無い人は今までどおり定型連絡。対応中の案件があれば閉じる。未対応の案件なら定型連絡
  const c = setup();
  post(c.g, userMsg(U(1), STICKER));
  assert.equal(cases(c.book).length, 0);
  assert.equal(c.book.getSheetByName('定型連絡').dump().length, 2);
  post(c.g, userMsg(U(1), '相談です'), userMsg(U(1), STICKER));
  assert.equal(cases(c.book)[0][1], '未対応');
  assert.equal(c.book.getSheetByName('定型連絡').dump().length, 3);
  post(c.g, press(`inq|1|take|${cases(c.book)[0][0]}|${cases(c.book)[0][20]}`));
  n = c.g.fetches.length;
  post(c.g, userMsg(U(1), STICKER));
  assert.deepEqual([cases(c.book)[0][1], cases(c.book)[0][16]], ['対応済み', 'AI（自動）']);
  assert.equal(since(c.g, n).push.length, 0);
  assert.equal(c.book.getSheetByName('やりとり').dump().filter((r) => r[2] === '追記')[0][3], '（スタンプ）');
  // 記録のみ（record）でも自動で対応済みにする（送信はもともと無い）
  const d = setup({ INQ_MODE: 'record' });
  post(d.g, userMsg(U(1), 'ありがとうございます'));
  assert.equal(cases(d.book)[0][1], '対応済み');
  // 未登録の人の「ありがとうございます」：社員番号の案内（返信）も送らない
  const e = setup();
  n = e.g.fetches.length;
  post(e.g, userMsg(U(4), 'ありがとうございます'));
  assert.deepEqual([since(e.g, n).push.length, since(e.g, n).reply.length], [0, 0]);
  assert.equal(cases(e.book)[0][1], '対応済み');
});

// ---------------- 3. 本人への自動送信の最後の一文 ----------------
test('16a-3 AC_withAiNote：空行を1つ入れて最後に足す。すでにあれば足さない（2回付かない）', () => {
  const { g } = setup();
  const X = g.ctx;
  assert.equal(X.AC_withAiNote('お疲れ様です😊\nよろしくお願いいたします！'), 'お疲れ様です😊\nよろしくお願いいたします！\n\n' + NOTE);
  assert.equal(X.AC_withAiNote('本文\n\n'), '本文\n\n' + NOTE);
  assert.equal(X.AC_withAiNote(X.AC_withAiNote('本文')), '本文\n\n' + NOTE);
  assert.equal(X.AC_withAiNote('本文\n\n' + NOTE + '\n'), '本文\n\n' + NOTE);
});

test('16a-3 1対1の返信（友だち追加・社員番号の登録・問い合わせの案内）には付く。グループへの返信・管理者・勤怠管理グループへのお知らせには付かない', () => {
  const { g, master } = setup();
  const n = g.fetches.length;
  post(g, { type: 'follow', webhookEventId: 'f1', replyToken: 'rt-f1', source: { type: 'user', userId: U(5) } });
  g.line.profiles[U(5)] = 'ごろう';
  post(g, userMsg(U(5), '90005'));                                               // 社員番号の登録（マスタに無い番号）
  post(g, userMsg(U(4), '面接の日程について'));                                 // 未登録の人の問い合わせ → 案内
  const gmsg = { type: 'message', webhookEventId: 'g' + ++seq, replyToken: 'rt-g' + seq, source: { type: 'group', groupId: OTHER_GROUP, userId: STAFF }, message: { type: 'text', id: 'x', text: '部門登録 部署B' } };
  post(g, gmsg);
  const s = since(g, n);
  const replies = s.reply.map((f) => f.body.messages[0].text);
  assert.equal(replies.length, 4);
  for (const t of replies.slice(0, 3)) {
    assert.ok(t.endsWith('\n\n' + NOTE), t);
    assert.equal(t.split(NOTE).length, 2);                                       // 1回だけ
  }
  assert.ok(!replies[3].includes(NOTE));                                         // グループの部門登録への返信
  for (const p of s.push) {                                                      // 管理者への登録の確認・勤怠管理グループへの受付のお知らせ
    const m = p.body.messages[0];
    assert.ok(!(m.text || m.altText || '').includes(NOTE));
  }
  assert.ok(s.push.length >= 2);
  // 「LINE文面」シートで文面を上書きしていても付く。上書きの文にすでに一文があれば2回付けない
  const sh = master.getSheetByName('LINE文面');
  const v = sh.getDataRange().getValues();
  const r = v.findIndex((x) => x[0] === 'registered');
  sh.getRange(r + 1, 3).setValue('登録しました（上書きの文）');
  const f = v.findIndex((x) => x[0] === 'follow');
  sh.getRange(f + 1, 3).setValue('友だち追加ありがとうございます\n\n' + NOTE);
  g.ctx.AC_TPL_CACHE = null;
  const m = g.fetches.length;
  g.line.profiles[U(6)] = 'ろくろう';
  post(g, userMsg(U(6), '90006'), { type: 'follow', webhookEventId: 'f2', replyToken: 'rt-f2', source: { type: 'user', userId: U(6) } });
  const r2 = since(g, m).reply.map((x) => x.body.messages[0].text);
  assert.deepEqual(r2, ['登録しました（上書きの文）\n\n' + NOTE, '友だち追加ありがとうございます\n\n' + NOTE]);
});

test('16a-3 本人へ送るところはすべて AC_pushSelf_・AC_replySelf_ を通る（AC_pushTo_ を本人に直接使わない）', async () => {
  const fs = await import('node:fs');
  const src = ['AlcoholCheck.gs', 'TotSync.gs', 'LeaveRequest.gs', 'Inquiry.gs', 'Notices.gs'].map((f) => [f, fs.readFileSync(new URL('../gas/' + f, import.meta.url), 'utf8')]);
  const direct = [];
  for (const [f, s] of src) s.split('\n').forEach((l, i) => {
    if (/function AC_(pushTo_|reply_|pushLine_|pushSelf_|replySelf_)\(/.test(l)) return;
    for (const m of l.matchAll(/AC_pushTo_\(([^,]+),/g)) direct.push(f + ':' + (i + 1) + ':' + m[1].trim());
  });
  // 本人以外：勤怠管理グループ・部署のグループ（gid・g）・管理者（AC_pushLine_ の中）・飲酒検知の送り先（d.to＝管理者・勤怠管理グループ）
  assert.deepEqual(direct.map((x) => x.split(':').slice(2).join(':')).sort(), ["PropertiesService.getScriptProperties().getProperty('LINE_ADMIN_USER_ID')", 'd.to', 'g', 'g', 'gid'].sort());
  const selfSends = src.map(([, s]) => (s.match(/AC_pushSelf_\(|AC_replySelf_\(/g) || []).length).reduce((a, b) => a + b, 0);
  assert.equal(selfSends, 13);   // 定義2つ＋使うところ11か所（夜の勤怠・承認待ち・打刻漏れ・アルコールチェック・E-40・E-78・友だち追加・登録・ATT-11・希望休・問い合わせの案内）
});

// ---------------- 4. 毎週月曜の催促の案内 ----------------
test('16a-4 毎週の催促：出てくる種類の案内だけを、打刻漏れ → 二重打刻 → 休みの日の打刻 の順に並べる', () => {
  const { g } = setup();
  const X = g.ctx;
  const G = { miss: '→ 打刻漏れは、Touch On Timeから「打刻修正申請」をお願いいたします。', dup: '→ 二重打刻は、「打刻修正申請」で不要な打刻の削除をお願いいたします。',
    holiday: '→ 休みの日の打刻は、休日出勤の場合、Touch On Timeから「スケジュール申請」をお願いいたします。' };
  const D = ['2026-11-09', '2026-11-12', '2026-11-14'];
  assert.deepEqual([...X.AC_weeklyPunchGuides(D, { '2026-11-14': 'holiday', '2026-11-12': 'dup:out:2' })], [G.miss, G.dup, G.holiday]);
  assert.deepEqual([...X.AC_weeklyPunchGuides(['2026-11-14'], { '2026-11-14': 'holiday' })], [G.holiday]);
  assert.deepEqual([...X.AC_weeklyPunchGuides(['2026-11-12'], { '2026-11-12': 'dup:in:3' })], [G.dup]);
  assert.deepEqual([...X.AC_weeklyPunchGuides(D, { '2026-11-09': 'in', '2026-11-12': 'both', '2026-11-14': 'out' })], [G.miss]);
  assert.deepEqual([...X.AC_weeklyPunchGuides([], {})], []);
  // 11/16 10:02 の記録の形：休みの日の打刻の行があれば、その案内も出る。締めは今までどおり
  const t = X.AC_weeklyPunchMessage(['2026-11-10', '2026-11-14'], '2026-11-16', {}, { '2026-11-14': 'holiday' });
  assert.equal(t, 'お疲れ様です😊\n今月の打刻のお知らせです。\n\n【申請が確認できていない打刻漏れ】\n・11/10（火）\n・11/14（土）休みの日の打刻\n'
    + G.miss + '\n' + G.holiday + '\n月末までにご申請いただけますと、月初の勤怠の締めがスムーズになります。\n\nご確認のほどよろしくお願いいたします！');
  const only = X.AC_weeklyPunchMessage(['2026-11-14'], '2026-11-16', {}, { '2026-11-14': 'holiday' });
  assert.ok(only.includes('・11/14（土）休みの日の打刻\n' + G.holiday + '\n月末までに'), only);
  assert.ok(!only.includes(G.miss));
  // 「LINE文面」シートの文面が前の案内（1行）のままでも、種類ごとの案内に置き換える
  const old = 'お疲れ様です😊\n今月の打刻のお知らせです。\n\n【申請が確認できていない打刻漏れ】\n{dates}\n→ Touch On Timeでご確認いただき、「打刻修正申請」をお願いいたします。\n月末までにご申請ください。\n\nよろしくお願いいたします！';
  const ov = X.AC_weeklyPunchMessage(['2026-11-12'], '2026-11-16', { weeklyPunch: [old] }, { '2026-11-12': 'dup:out:2' });
  assert.equal(ov, 'お疲れ様です😊\n今月の打刻のお知らせです。\n\n【申請が確認できていない打刻漏れ】\n・11/12（木）退勤の打刻が2回\n' + G.dup + '\n月末までにご申請ください。\n\nよろしくお願いいたします！');
  // 【勤怠の変更】だけの人（打刻漏れの日が無い）：打刻漏れの段落ごと出さない
  const ch = X.AC_weeklyPunchMessage([], '2026-11-16', {}, {}, [{ from: '2026-11-10', until: '2026-11-10', label: '欠勤', by: '' }], '試験 一郎');
  assert.ok(!ch.includes('【申請が確認できていない打刻漏れ】') && !ch.includes('→ 打刻漏れは') && !ch.includes('月末までに'), ch);
});
