import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 従業員問い合わせ管理：既存の「コード.gs」と Inquiry.gs を同じ模擬環境で動かす結合テスト（すべて架空データ・LINEへの送信なし）
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const GROUP = 'C' + 'a'.repeat(32), OTHER_GROUP = 'C' + 'b'.repeat(32);
const ADMIN = U(7), STAFF = U(8), OUTSIDER = U(9);
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const row = (code, name, dept, userId, { lineOk = true } = {}) => ["'" + code, name, '', '在籍', dept, userId, '', '', lineOk, true, '', '', '', ''];

function setup(props = { INQ_MODE: 'on' }, { files = ['AlcoholCheck.gs', 'Inquiry.gs'], now = '2026-11-05T14:12:00+09:00' } = {}) {
  const g = createGas({ files, now });
  const master = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = master.insertSheet('従業員マスタ');
  [HEAD, row('90001', '試験 一郎', '部署A', U(1)), row('90002', '試験 二郎', '部署B', U(2), { lineOk: false }), row('90003', '試験 三郎', '部署A', '')]
    .forEach((r) => m.appendRow(r));
  const gs = master.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [GROUP, '勤怠管理', '2026-10-15', '有効'], [OTHER_GROUP, '部署A', '2026-10-15', '有効']].forEach((r) => gs.appendRow(r));
  const book = g.newSpreadsheet('【テスト】従業員問い合わせ管理（架空）');
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: master.getId(), INQ_SPREADSHEET_ID: book.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake',
    LINE_ADMIN_USER_ID: ADMIN, ...props });
  g.line.members[GROUP] = { [STAFF]: '担当A', [ADMIN]: '管理者' };
  g.line.profiles[U(1)] = 'いちろう'; g.line.profiles[U(4)] = 'よんちゃん'; g.line.profiles[ADMIN] = '管理者';
  return { g, master, book };
}

let seq = 0;
const userMsg = (userId, message, id = 'ev' + ++seq) => ({ type: 'message', webhookEventId: id, replyToken: 'rt-' + id, timestamp: 0,
  source: { type: 'user', userId }, message: { id: 'm' + id, ...(typeof message === 'string' ? { type: 'text', text: message } : message) } });
const press = (data, { userId = STAFF, groupId = GROUP, id = 'ev' + ++seq } = {}) => ({ type: 'postback', webhookEventId: id, replyToken: 'rt-' + id,
  source: groupId ? { type: 'group', groupId, userId } : { type: 'user', userId }, postback: { data } });
const post = (g, ...events) => g.ctx.doPost({ postData: { contents: JSON.stringify({ destination: 'x', events }) } });

function since(g, n) {
  const f = g.fetches.slice(n);
  return { push: f.filter((x) => x.url.endsWith('/push')), reply: f.filter((x) => x.url.endsWith('/reply')) };
}
const sheet = (book, name) => book.getSheetByName(name);
const cases = (book) => (sheet(book, '問い合わせ') ? sheet(book, '問い合わせ').dump().slice(1) : []);
const dataOf = (msg, i) => msg.contents.footer.contents[i].action.data;

test('INQ結合: 設定が未設定なら何もしない（今と同じ）', () => {
  const { g, book } = setup({});
  const n = g.fetches.length;
  post(g, userMsg(U(1), '明日のシフトについて相談です'));
  assert.equal(g.fetches.length, n);
  assert.equal(book.getSheetByName('問い合わせ'), null);
});

test('INQ結合: Inquiry.gs が無くても、社員番号以外のメッセージで既存の処理がエラーにならない', () => {
  const { g } = setup({ INQ_MODE: 'on' }, { files: ['AlcoholCheck.gs'] });
  const n = g.fetches.length;
  post(g, userMsg(U(1), '明日のシフトについて相談です'), press('inq|1|take|Q-20261105-001|abcdef'));
  assert.equal(g.fetches.length, n);   // エラーの知らせも送らない
});

test('INQ結合: 登録済みの従業員の問い合わせ → 受付・勤怠管理グループへボタンつきで通知（返信はしない）', () => {
  const { g, book } = setup();
  const n = g.fetches.length;
  post(g, userMsg(U(1), '明日のシフトの件で確認したいことがあります。\nよろしくお願いします'));
  const { push, reply } = since(g, n);
  assert.equal(reply.length, 0);
  assert.equal(push.length, 1);
  assert.equal(push[0].body.to, GROUP);
  const msg = push[0].body.messages[0];
  assert.equal(msg.type, 'flex');
  assert.deepEqual([...msg.contents.body.contents].map((x) => x.text), ['【問い合わせ】11/5 14:12', '試験 一郎（部署A）', '状況：未対応',
    '要約：シフト・希望休／シフト', '内容：「明日のシフトの件で確認したいことがありま…」']);
  assert.ok(!JSON.stringify(msg.contents.body).includes('Q-'));   // 本文に案件番号は出さない
  assert.equal(msg.contents.footer.contents[0].action.displayText, '対応します（試験 一郎（部署A））');
  assert.match(dataOf(msg, 0), /^inq\|1\|take\|Q-20261105-001\|[a-f][0-9a-f]{5}$/);   // 先頭は英字（数字だけだとシートで数値に変わるため）
  const c = cases(book);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0][0], c[0][1], c[0][2], c[0][3], c[0][4], c[0][5]], ['Q-20261105-001', '未対応', '90001', '試験 一郎', '部署A', '登録済み']);
  const log = sheet(book, 'やりとり').dump();
  assert.equal(log[1][2], '受付');
  assert.equal(log[1][3], '明日のシフトの件で確認したいことがあります。\nよろしくお願いします');
});

test('INQ結合: 記録のみ（record）は送信・返信をしない', () => {
  const { g, book } = setup({ INQ_MODE: 'record' });
  const n = g.fetches.length;
  post(g, userMsg(U(4), '問い合わせです'), press('inq|1|take|Q-20261105-001|abcdef'));
  const { push, reply } = since(g, n);
  assert.equal(push.length + reply.length, 0);
  assert.equal(cases(book).length, 1);
  g.ctx.INQ_remind();
  assert.equal(since(g, n).push.length, 0);
});

test('INQ結合: 同じイベントの再送は二重に受け付けない（一時記憶が消えた後も、受信記録で防ぐ）', () => {
  const { g, book } = setup();
  const ev = userMsg(U(1), '有給の残りを教えてください');
  post(g, ev); post(g, ev);
  for (const k of Object.keys(g.cache)) delete g.cache[k];   // 6時間が過ぎて一時記憶が消えた
  post(g, ev, ev);
  assert.equal(cases(book).length, 1);
  assert.equal(sheet(book, 'やりとり').dump().length, 2);
  assert.equal(g.fetches.filter((f) => f.url.endsWith('/push')).length, 1);
});

test('INQ結合: プロフィールが取れない送信者（友だちでない・偽のデータ）は案件にしない', () => {
  const { g, book } = setup();
  g.line.profiles[U(5)] = null;
  const n = g.fetches.length;
  post(g, userMsg(U(5), 'こんにちは'));
  assert.equal(cases(book).length, 0);
  assert.equal(since(g, n).push.length, 0);
  assert.equal(sheet(book, '受信記録').dump()[1][2], '実在確認できず');
});

test('INQ結合: 定型連絡・スタンプは記録だけ（通知しない）。画像は案件にする', () => {
  const { g, book } = setup();
  const n = g.fetches.length;
  post(g, userMsg(U(1), '退勤しました。'), userMsg(U(1), { type: 'sticker', packageId: '1', stickerId: '2' }));
  assert.equal(since(g, n).push.length, 0);
  assert.equal(cases(book).length, 0);
  const r = sheet(book, '定型連絡').dump();
  assert.deepEqual([r[1][1], r[1][4], r[2][4]], ['90001', '退勤しました。', '（スタンプ）']);
  post(g, userMsg(U(1), { type: 'image', contentProvider: { type: 'line' } }));
  assert.equal(cases(book)[0][9], '（画像）');
  assert.equal(since(g, n).push.length, 1);
});

test('INQ結合: 機密を含むときは通知に内容を出さず、シートにも伏せて保存する', () => {
  const { g, book } = setup();
  const n = g.fetches.length;
  post(g, userMsg(U(1), '給与の振込口座を変えたいです。口座番号は1234567です'));
  const msg = since(g, n).push[0].body.messages[0];
  assert.equal(msg.contents.body.contents[3].text, '要約：⚠給与・明細');                  // 機密ありは分類だけ
  assert.equal(msg.contents.body.contents[4].text, '内容：機密を含むため、チャットで確認してください');
  assert.ok(!JSON.stringify(msg).includes('1234567'));
  const c = cases(book)[0];
  assert.equal(c[10], true);
  const all = JSON.stringify(book.sheets.map((s) => s.dump()));
  assert.ok(!all.includes('1234567'));
  assert.equal(sheet(book, 'やりとり').dump()[1][3], '給与の振込口座＊＊＊');
});

test('INQ結合: 未登録の人は「氏名不明（表示名）」で受け付け、社員番号の案内は1回だけ返信', () => {
  const { g, book } = setup();
  const n = g.fetches.length;
  post(g, userMsg(U(4), '面接の日程について'));
  let s = since(g, n);
  assert.equal(s.push[0].body.messages[0].contents.body.contents[1].text, '氏名不明（よんちゃん）');
  assert.equal(cases(book)[0][5], '未登録');                                                 // シートの紐付けは今までどおり
  assert.equal(s.reply.length, 1);
  assert.match(s.reply[0].body.messages[0].text, /社員番号/);
  // 対応済みにした後の新しい問い合わせでも、案内は繰り返さない
  const c = cases(book)[0];
  post(g, press(`inq|1|done|${c[0]}|${c[20]}`));
  const m = g.fetches.length;
  post(g, userMsg(U(4), 'もう一つ質問です'));
  s = since(g, m);
  assert.equal(s.reply.length, 0);
  assert.equal(cases(book).length, 2);
  assert.equal(sheet(book, '案内済み').dump().length, 2);
});

test('INQ結合: LINE確認済みでない人は「確認待ち」（推測で紐付けない・案内もしない）', () => {
  const { g, book } = setup();
  g.line.profiles[U(2)] = 'じろう';
  const n = g.fetches.length;
  post(g, userMsg(U(2), '質問があります'));
  const s = since(g, n);
  assert.equal(s.push[0].body.messages[0].contents.body.contents[1].text, '氏名不明（じろう）');
  assert.equal(s.reply.length, 0);
  assert.deepEqual([cases(book)[0][2], cases(book)[0][3], cases(book)[0][5]], ['', '', '確認待ち']);
});

test('INQ結合: 社員番号だけのメッセージは今までどおり登録（問い合わせにしない）', () => {
  const { g, book, master } = setup();
  g.line.profiles[U(3)] = 'さぶろう';
  post(g, userMsg(U(3), '９０００３'));
  assert.equal(cases(book).length, 0);
  assert.equal(master.getSheetByName('従業員マスタ').dump()[3][5], U(3));
});

test('INQ結合: ボタン（対応します → 二重押し → 対応済み → 古いボタン）', () => {
  const { g, book } = setup();
  post(g, userMsg(U(1), '相談です'));
  const [id, token] = [cases(book)[0][0], cases(book)[0][20]];
  const replies = () => g.fetches.filter((f) => f.url.endsWith('/reply')).map((f) => f.body.messages[0].text);
  post(g, press(`inq|1|take|${id}|${token}`));
  assert.equal(cases(book)[0][1], '対応中');
  assert.equal(cases(book)[0][13], '担当A');
  post(g, press(`inq|1|take|${id}|${token}`, { userId: ADMIN }));
  assert.equal(cases(book)[0][13], '担当A');   // 二重押し：担当は変わらない
  g.clock.now += 60 * 60000;
  post(g, press(`inq|1|done|${id}|${token}`, { userId: ADMIN }));
  assert.equal(cases(book)[0][1], '対応済み');
  assert.equal(cases(book)[0][16], '管理者');
  post(g, press(`inq|1|take|${id}|${token}`));
  assert.equal(cases(book)[0][1], '対応済み');
  const w = '試験 一郎（部署A）の問い合わせ';   // 案件番号は出さない
  assert.deepEqual(replies(), [`${w}を、担当Aさんが対応中にしました。`, `${w}は、担当Aさんが対応中です。`,
    `${w}を対応済みにしました（管理者さん）。`, `${w}は対応済みです（11/5（木） 15:12・管理者さん）。`]);
  assert.equal(g.fetches.filter((f) => f.url.endsWith('/push')).length, 1);   // ボタンの結果は返信だけ（送信数に数えない）
  const kinds = sheet(book, 'やりとり').dump().slice(1).map((r) => r[2]);
  assert.deepEqual(kinds, ['受付', '対応開始', '対応済み']);
});

test('INQ結合: 偽のボタン・メンバー外・ほかのグループ・ほかの機能の postback は何も変えない', () => {
  const { g, book } = setup();
  post(g, userMsg(U(1), '相談です'));
  const [id, token] = [cases(book)[0][0], cases(book)[0][20]];
  const wrong = token === '000000' ? '111111' : '000000';
  post(g, press(`inq|1|done|${id}|${wrong}`));                              // 合言葉の不一致
  post(g, press(`inq|1|done|${id}|${token}`, { userId: OUTSIDER }));       // メンバーでない
  post(g, press(`inq|1|done|${id}|${token}`, { groupId: OTHER_GROUP }));   // 勤怠管理グループ以外
  post(g, press('ea|1|approve|EA-20261105-001'));                          // 社員管理AIのもの
  post(g, press(`inq|1|done|${id}|${token}`, { userId: '' }));             // 送信者が分からない（パソコン版など）
  assert.equal(cases(book)[0][1], '未対応');
  const replies = g.fetches.filter((f) => f.url.endsWith('/reply')).map((f) => f.body.messages[0].text);
  assert.equal(replies.length, 3);
  assert.match(replies[0], /このボタンは使えません/);
  assert.match(replies[1], /メンバーであることを確認できなかった/);
  assert.match(replies[2], /スマートフォンのLINEから/);
});

test('INQ結合: 同じ人の追記（未対応は通知しない／対応中は30分に1回まで）', () => {
  const { g, book } = setup();
  post(g, userMsg(U(1), '1通目'));
  const n0 = g.fetches.length;
  post(g, userMsg(U(1), '2通目（未対応への追記）'));
  assert.equal(since(g, n0).push.length, 0);
  assert.equal(cases(book).length, 1);
  assert.equal(cases(book)[0][12], 1);
  const [id, token] = [cases(book)[0][0], cases(book)[0][20]];
  post(g, press(`inq|1|take|${id}|${token}`));
  const n1 = g.fetches.length;
  post(g, userMsg(U(1), '3通目'));
  g.clock.now += 10 * 60000; post(g, userMsg(U(1), '4通目（10分後）'));
  g.clock.now += 21 * 60000; post(g, userMsg(U(1), '5通目（31分後）'));
  const pushes = since(g, n1).push.map((p) => p.body.messages[0].text);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0], '【問い合わせ・追記】試験 一郎（部署A）から追記があります。チャットをご確認ください（担当：担当A）');
  assert.equal(cases(book)[0][12], 4);
  assert.equal(sheet(book, 'やりとり').dump().filter((r) => r[2] === '追記').length, 4);
  // 対応済みの後は新しい案件
  post(g, press(`inq|1|done|${id}|${token}`));
  post(g, userMsg(U(1), '別の件です'));
  assert.equal(cases(book).length, 2);
  assert.equal(cases(book)[1][0], 'Q-20261105-002');
});

test('INQ結合: リマインド（未完了だけ・前日から継続・0件は送らない・土日の設定）', () => {
  const { g, book } = setup({ INQ_MODE: 'on' }, { now: '2026-11-06T16:00:00+09:00' });   // 金曜
  g.ctx.INQ_remind();
  assert.equal(g.fetches.filter((f) => f.url.endsWith('/push')).length, 0);   // 案件なし
  post(g, userMsg(U(1), '金曜の相談'));
  g.clock.now = new Date('2026-11-07T09:00:00+09:00').getTime();             // 土曜
  const n = g.fetches.length;
  g.ctx.INQ_remind();
  const p = since(g, n).push;
  assert.equal(p.length, 1);
  assert.equal(p[0].body.to, GROUP);
  assert.equal(p[0].body.messages[0].text, '【問い合わせ 未完了1件】11/7 9:00\n\n① 試験 一郎（部署A）\n状況：未対応（前日から）\n要約：その他／金曜の相談\n内容：「金曜の相談」');
  g.scriptProps.setProperty('INQ_REMIND_DAYS', 'weekdays');
  const m = g.fetches.length;
  g.ctx.INQ_remind();
  assert.equal(since(g, m).push.length, 0);
});

test('INQ結合: 試験用（INQ_NOTIFY_TO=admin）は管理者の個別LINEへ送り、個別LINEのボタンも使える', () => {
  const { g, book } = setup({ INQ_MODE: 'on', INQ_NOTIFY_TO: 'admin' });
  const n = g.fetches.length;
  post(g, userMsg(U(1), '試験の問い合わせ'));
  const p = since(g, n).push;
  assert.deepEqual(p.map((x) => x.body.to), [ADMIN]);
  const data = dataOf(p[0].body.messages[0], 0);
  post(g, press(data, { userId: U(1), groupId: null }));   // 管理者以外の個別LINEからは無効
  assert.equal(cases(book)[0][1], '未対応');
  post(g, press(data, { userId: ADMIN, groupId: null }));
  assert.equal(cases(book)[0][1], '対応中');
});

test('INQ結合: 勤怠管理グループが未登録・送信失敗なら管理者の個別LINEへ', () => {
  const { g, master } = setup();
  master.getSheetByName('LINEグループ').getRange(2, 4).setValue('退出');
  const n = g.fetches.length;
  post(g, userMsg(U(1), '相談です'));
  assert.deepEqual(since(g, n).push.map((x) => x.body.to), [ADMIN]);
});

test('INQ結合: 問い合わせの処理が失敗しても doPost と既存の処理は止まらない（管理者へ1日1回だけ知らせる）', () => {
  const { g, book } = setup();
  g.scriptProps.deleteProperty('INQ_SPREADSHEET_ID');
  const n = g.fetches.length;
  const out = post(g, userMsg(U(1), '相談1'), userMsg(U(1), '相談2'));
  assert.equal(out.getContent(), 'OK');
  const s = since(g, n);
  assert.equal(s.push.length, 1);
  assert.equal(s.push[0].body.to, ADMIN);
  assert.match(s.push[0].body.messages[0].text, /問い合わせの処理で問題がありました/);
  assert.equal(cases(book).length, 0);
});

test('INQ結合: グループの部門登録・普段の会話・社員管理AIの言葉は今までどおり', () => {
  const { g, book } = setup();
  const n = g.fetches.length;
  const gmsg = (text) => ({ type: 'message', webhookEventId: 'g' + ++seq, replyToken: 'rt-g' + seq, source: { type: 'group', groupId: OTHER_GROUP, userId: STAFF }, message: { type: 'text', id: 'x', text } });
  post(g, gmsg('おつかれさまです'), gmsg('入社'), gmsg('【退社】社員番号：90001'));
  assert.equal(g.fetches.length, n);   // どれにも反応しない
  post(g, gmsg('部門登録 部署B'));
  assert.match(since(g, n).reply[0].body.messages[0].text, /部署B/);
  assert.equal(book.getSheetByName('問い合わせ'), null);
});

test('INQ結合: まとめのトリガーは9時台・15時台の2つ（何度作っても増えない・既存のトリガーには触れない）', () => {
  const { g } = setup();
  g.ctx.ScriptApp.newTrigger('alcoholCheckMorning').timeBased().atHour(8).create();
  g.ctx.ScriptApp.newTrigger('INQ_remind').timeBased().atHour(17).create();                   // 以前の17時のトリガーがあっても
  g.ctx.INQ_setupRemindTriggers(); g.ctx.INQ_setupRemindTriggers(); g.ctx.INQ_setupTriggers();
  assert.deepEqual(g.triggers.map((t) => [t.fn, t.at]), [['alcoholCheckMorning', 8], ['INQ_remind', 9], ['INQ_remind', 15]]);
  g.ctx.INQ_removeRemindTriggers();
  assert.deepEqual(g.triggers.map((t) => t.fn), ['alcoholCheckMorning']);
});

test('INQ結合: 準備（INQ_setup）でタブを作り、止める（INQ_stop）と何もしない。将来のAI返信用の確認', () => {
  const { g, book } = setup();
  g.ctx.INQ_setup();
  assert.deepEqual(book.sheets.map((s) => s.getName()), ['問い合わせ', 'やりとり', '定型連絡', '受信記録', '案内済み']);
  post(g, userMsg(U(1), '相談です'));
  assert.equal(g.ctx.INQ_activeCaseFor(U(1)).state, '未対応');
  assert.equal(g.ctx.INQ_activeCaseFor(U(4)), null);
  g.ctx.INQ_stop();
  const n = g.fetches.length;
  post(g, userMsg(U(1), '止めた後'));
  assert.equal(g.fetches.length, n);
  assert.equal(sheet(book, 'やりとり').dump().length, 2);
});

test('INQ結合: 設定表示に問い合わせの項目とトリガーが出る（値は出さない）', () => {
  const { g } = setup({ INQ_MODE: 'record' });
  const lines = g.ctx.AC_settingsReport(g.scriptProps.getProperties(), [{ fn: 'INQ_remind', type: '時間主導' }], { version: g.ctx.AC_CODE_VERSION });
  const text = [...lines].join('\n');
  assert.match(text, /INQ_MODE：record/);
  assert.match(text, /INQ_SPREADSHEET_ID：設定あり/);
  assert.match(text, /・INQ_remind（時間主導）$/m);
  assert.ok(!text.includes(g.scriptProps.getProperty('INQ_SPREADSHEET_ID') + '）'));
});

test('INQ結合: ボタンの合言葉は先頭が英字（数字だけの合言葉がシートで数値に変わってボタンが使えなくなるのを防ぐ）', () => {
  const { g } = setup();
  const orig = g.ctx.Utilities.getUuid;
  g.ctx.Utilities.getUuid = () => '01234567-89ab-cdef-0123-456789abcdef';   // 以前なら「012345」になる
  const t = g.ctx.INQ_token_();
  g.ctx.Utilities.getUuid = orig;
  assert.match(t, /^[a-f][0-9a-f]{5}$/);
  assert.equal(t, 'a12345');
  for (let i = 0; i < 200; i++) assert.match(g.ctx.INQ_token_(), /^[a-f][0-9a-f]{5}$/);
});
