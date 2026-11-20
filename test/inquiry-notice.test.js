import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 版 2026-11-20b：問い合わせのお知らせの内容（200文字・まとめは50文字・写真・スタンプ・ファイル・30分以内の続き）と、
// 送り先「従業員連絡」グループ（未登録・退出なら勤怠管理グループ）。すべて架空データ・LINEへの送信なし
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const KANRI = 'C' + 'a'.repeat(32), OTHER = 'C' + 'b'.repeat(32), EMP = 'C' + 'c'.repeat(32);
const ADMIN = U(7), STAFF = U(8);
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const row = (code, name, dept, userId) => ["'" + code, name, '', '在籍', dept, userId, '', '', true, true, '', '', '', ''];

function setup({ props = {}, emp = '有効', now = '2026-11-24T10:00:00+09:00', files = ['AlcoholCheck.gs', 'Inquiry.gs'] } = {}) {
  const g = createGas({ files, now });
  const master = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = master.insertSheet('従業員マスタ');
  [HEAD, row('90001', '試験 一郎', '部署A', U(1))].forEach((r) => m.appendRow(r));
  const gs = master.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [KANRI, '勤怠管理', '2026-10-15', '有効'], [OTHER, '部署A', '2026-10-15', '有効']]
    .concat(emp ? [[EMP, '従業員連絡', '2026-11-20', emp]] : []).forEach((r) => gs.appendRow(r));
  const book = g.newSpreadsheet('【テスト】従業員問い合わせ管理（架空）');
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: master.getId(), INQ_SPREADSHEET_ID: book.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake',
    LINE_ADMIN_USER_ID: ADMIN, INQ_MODE: 'on', ...props });
  g.line.members[KANRI] = { [STAFF]: '担当A', [ADMIN]: '管理者' };
  g.line.members[EMP] = { [STAFF]: '担当A' };
  g.line.profiles[U(1)] = 'いちろう'; g.line.profiles[ADMIN] = '管理者';
  return { g, master, book };
}

let seq = 0;
const userMsg = (userId, message, id = 'nv' + ++seq) => ({ type: 'message', webhookEventId: id, replyToken: 'rt-' + id, timestamp: 0,
  source: { type: 'user', userId }, message: { id: 'm' + id, ...(typeof message === 'string' ? { type: 'text', text: message } : message) } });
const grp = (groupId, ext, id = 'nv' + ++seq) => ({ webhookEventId: id, replyToken: 'rt-' + id, source: { type: 'group', groupId, userId: STAFF }, ...ext });
const post = (g, ...events) => g.ctx.doPost({ postData: { contents: JSON.stringify({ destination: 'x', events }) } });
const since = (g, n) => {
  const f = g.fetches.slice(n);
  return { push: f.filter((x) => x.url.endsWith('/push')), reply: f.filter((x) => x.url.endsWith('/reply')) };
};
const bodyLines = (msg) => msg.contents.body.contents.map((x) => x.text);
const content = (msg) => bodyLines(msg).find((t) => t.startsWith('内容：'));
const caseRows = (book) => book.getSheetByName('問い合わせ').dump().slice(1);

// ---------------- 純粋関数 ----------------
test('20b: 内容の表示（受付は200文字まで・超えたら「…（続きはチャットで）」、まとめは50文字まで）', () => {
  const { g } = setup();
  const X = g.ctx;
  const c = (head, extra = {}) => ({ head, secret: false, ...extra });
  assert.equal(X.INQ_shownHead(c('短い相談です'), false), '「短い相談です」');
  const t200 = 'あ'.repeat(200), t201 = 'あ'.repeat(201);
  assert.equal(X.INQ_shownHead(c(X.INQ_head(t200)), false), '「' + t200 + '」');                              // 200文字ちょうどはそのまま
  assert.equal(X.INQ_shownHead(c(X.INQ_head(t201)), false), '「' + t200 + '…（続きはチャットで）」');          // 超えたら続きはチャットで
  assert.equal(X.INQ_shownHead(c('相談があるのですが…'), false), '「相談があるのですが…」');                    // 本人が打った「…」は切れた印にしない
  assert.equal(X.INQ_shownHead(c('い'.repeat(50)), false, true), '「' + 'い'.repeat(50) + '」');               // まとめ：50文字ちょうど
  assert.equal(X.INQ_shownHead(c('い'.repeat(51)), false, true), '「' + 'い'.repeat(50) + '…」');             // まとめ：51文字 → 50文字＋…
  assert.equal(X.INQ_shownHead(c(X.INQ_head(t201)), false, true), '「' + 'あ'.repeat(50) + '…」');
  assert.equal(X.INQ_shownHead(c('い'.repeat(20) + '…'), false, true), '「' + 'い'.repeat(20) + '…」');      // 前の版（20文字）の行もそのまま読める
  // 機密・要注意は内容を出さない（今までどおり）
  assert.equal(X.INQ_shownHead(c('x', { secret: true }), false), '機密を含むため、チャットで確認してください');
  assert.equal(X.INQ_shownHead(c('x'), true, true), '（内容はチャットで確認してください）');
});

test('20b: 30分以内の続きをつなぐ（200文字まで・写真は枚数を数える）', () => {
  const { g } = setup();
  const X = g.ctx;
  assert.equal(X.INQ_joinHead('明日の件です', '10時からでも大丈夫ですか'), '明日の件です／10時からでも大丈夫ですか');
  assert.equal(X.INQ_joinHead('', '最初'), '最初');
  assert.equal(X.INQ_joinHead('写真を送ります', '［写真1枚］'), '写真を送ります／［写真1枚］');
  assert.equal(X.INQ_joinHead('写真を送ります／［写真1枚］', '［写真1枚］'), '写真を送ります／［写真2枚］');
  const long = X.INQ_joinHead('あ'.repeat(190), 'い'.repeat(30));
  assert.equal(long, 'あ'.repeat(190) + '／' + 'い'.repeat(9) + '…');                                       // 合計200文字まで
  assert.equal(X.INQ_joinHead(long, 'もっと'), long);                                                     // すでに切れていればそのまま
  const T = Date.parse('2026-11-24T10:00:00+09:00');
  assert.equal(X.INQ_isContinuation(T, T + 30 * 60000), true);
  assert.equal(X.INQ_isContinuation(T, T + 30 * 60000 + 1), false);
  assert.equal(X.INQ_isContinuation(0, T), false);
});

test('20b: 送り先の順（従業員連絡 → 勤怠管理）と、ボタンを受け付けるグループ', () => {
  const { g } = setup();
  const X = g.ctx;
  const plan = (b, k) => JSON.parse(JSON.stringify(X.INQ_targetPlan(b, k)));
  const both = { 勤怠管理: ['K'], 従業員連絡: ['E'], 部署A: ['A'] };
  assert.deepEqual(plan(both, 'inquiry'), [{ dept: '従業員連絡', list: ['E'] }, { dept: '勤怠管理', list: ['K'] }]);
  assert.deepEqual(plan(both, 'admin'), [{ dept: '勤怠管理', list: ['K'] }]);                                  // TOT反映・管理者へのお知らせは勤怠管理のまま
  assert.deepEqual(plan({ 勤怠管理: ['K'] }, 'inquiry'), [{ dept: '勤怠管理', list: ['K'] }]);                // 従業員連絡が未登録・退出
  assert.deepEqual(plan({}, 'inquiry'), []);
  assert.deepEqual([...X.INQ_staffGroups(both)], ['K', 'E']);
  // 「LINEグループ」タブの状態「退出」は AC_groupsByDept で除かれる
  const by = X.AC_groupsByDept([['グループID', '部門（所属）', '登録日時', '状態'], ['E', '従業員連絡', '', '退出'], ['K', '勤怠管理', '', '有効']]);
  assert.deepEqual(plan(by, 'inquiry'), [{ dept: '勤怠管理', list: ['K'] }]);
});

// ---------------- 結合（コード.gs ＋ Inquiry.gs） ----------------
test('20b結合: 従業員連絡が登録済みなら受付のお知らせはそちらへ（200文字以内はそのまま・超えたら続きはチャットで）', () => {
  const { g, book } = setup();
  let n = g.fetches.length;
  const t150 = '明日のシフトの件で確認したいことがあります。' + 'う'.repeat(128);
  post(g, userMsg(U(1), t150));
  let p = since(g, n).push;
  assert.deepEqual(p.map((x) => x.body.to), [EMP]);
  assert.equal(content(p[0].body.messages[0]), '内容：「' + t150 + '」');
  assert.equal(caseRows(book)[0][9], t150);
  // 別の人（未登録）の長い問い合わせ
  g.line.profiles[U(4)] = 'よんちゃん';
  n = g.fetches.length;
  const t250 = 'シフトの相談です。' + 'え'.repeat(241);
  post(g, userMsg(U(4), t250));
  p = since(g, n).push;
  assert.equal(p[0].body.to, EMP);
  assert.equal(content(p[0].body.messages[0]), '内容：「' + [...t250].slice(0, 200).join('') + '…（続きはチャットで）」');
  assert.ok(p[0].body.messages[0].altText.length <= 400);
});

test('20b結合: 写真・ファイルの表示、30分以内の続きは1件にまとめて内容をつなぐ（まとめは50文字まで）', () => {
  const { g, book } = setup();
  let n = g.fetches.length;
  post(g, userMsg(U(1), { type: 'image', contentProvider: { type: 'line' } }));
  let p = since(g, n).push;
  assert.equal(p.length, 1);
  assert.equal(content(p[0].body.messages[0]), '内容：「［写真1枚］」');
  g.clock.now += 60000;
  n = g.fetches.length;
  post(g, userMsg(U(1), { type: 'image', contentProvider: { type: 'line' } }), userMsg(U(1), '車のキズの件です。どうしたらよいですか'));
  assert.equal(since(g, n).push.length, 0);                                  // 未対応への続きはお知らせを増やさない（今までどおり）
  assert.equal(caseRows(book).length, 1);                                    // 1件にまとめる
  assert.equal(caseRows(book)[0][9], '［写真2枚］／車のキズの件です。どうしたらよいですか');
  g.clock.now += 31 * 60000;                                                 // 30分を過ぎた続きはつながない（追記の回数だけ）
  post(g, userMsg(U(1), 'あとから一言'));
  assert.equal(caseRows(book)[0][9], '［写真2枚］／車のキズの件です。どうしたらよいですか');
  assert.equal(caseRows(book)[0][12], 3);
  // ファイル
  g.line.profiles[U(4)] = 'よんちゃん';
  n = g.fetches.length;
  post(g, userMsg(U(4), { type: 'file', fileName: '架空の申請書.pdf', fileSize: 100 }));
  assert.equal(content(since(g, n).push[0].body.messages[0]), '内容：「［ファイル（架空の申請書.pdf）］」');
  // まとめ（50文字まで）は従業員連絡グループへ
  post(g, userMsg(U(4), 'お'.repeat(60)));
  g.clock.now = new Date('2026-11-24T15:00:00+09:00').getTime();
  n = g.fetches.length;
  g.ctx.INQ_remind();
  p = since(g, n).push;
  assert.deepEqual(p.map((x) => x.body.to), [EMP]);
  const text = p[0].body.messages[0].text;
  assert.match(text, /内容：「［写真2枚］／車のキズの件です。どうしたらよいですか」/);
  const fileLine = text.split('\n').find((l) => l.startsWith('内容：「［ファイル'));
  assert.equal(fileLine, '内容：「' + [...('［ファイル（架空の申請書.pdf）］／' + 'お'.repeat(60))].slice(0, 50).join('') + '…」');
});

test('20b結合: スタンプは「［スタンプ］」で記録（案件にはしない・今までどおり）', () => {
  const { g, book } = setup();
  const n = g.fetches.length;
  post(g, userMsg(U(1), { type: 'sticker', packageId: '1', stickerId: '2' }));
  assert.equal(since(g, n).push.length, 0);
  assert.equal(book.getSheetByName('定型連絡').dump()[1][4], '［スタンプ］');
});

test('20b結合: 機密・要注意は内容を出さない（続きで要注意の言葉が入ったときも）', () => {
  const { g, book } = setup();
  let n = g.fetches.length;
  post(g, userMsg(U(1), '暗証番号を忘れました'));
  let msg = since(g, n).push[0].body.messages[0];
  assert.equal(content(msg), '内容：機密を含むため、チャットで確認してください');
  g.line.profiles[U(4)] = 'よんちゃん';
  n = g.fetches.length;
  post(g, userMsg(U(4), '上司からのパワハラについて相談したいです'));
  msg = since(g, n).push[0].body.messages[0];
  assert.equal(content(msg), '内容：（内容はチャットで確認してください）');
  // 普通の問い合わせの続きに要注意の言葉が入った：まとめでは内容を出さない
  g.line.profiles[U(5)] = 'ごろう';
  post(g, userMsg(U(5), '来週の件で相談です'));
  g.ctx.INQ_classifyFill_();                                                  // 分類が先に「その他」で埋まっていても
  g.clock.now += 5 * 60000;
  post(g, userMsg(U(5), '実は体調が悪くて病院に行きます'));
  const r = caseRows(book).find((x) => x[7] === 'ごろう');
  assert.equal(r[9], '来週の件で相談です／実は体調が悪くて病院に行きます');
  g.clock.now = new Date('2026-11-24T15:00:00+09:00').getTime();
  n = g.fetches.length;
  g.ctx.INQ_remind();
  const text = since(g, n).push[0].body.messages[0].text;
  assert.ok(!text.includes('病院'), text);
  assert.ok(!text.includes('パワハラ'));
  assert.ok(!text.includes('暗証番号'));
  assert.match(text, /氏名不明（ごろう）\n状況：[^\n]+\n要約：⚠健康・体調\n内容：（内容はチャットで確認してください）/);
});

test('20b結合: 従業員連絡が未登録・退出なら勤怠管理グループへ（受付・まとめ）', () => {
  for (const emp of [null, '退出']) {
    const { g } = setup({ emp });
    let n = g.fetches.length;
    post(g, userMsg(U(1), '相談です'));
    assert.deepEqual(since(g, n).push.map((x) => x.body.to), [KANRI], String(emp));
    g.clock.now = new Date('2026-11-24T15:00:00+09:00').getTime();
    n = g.fetches.length;
    g.ctx.INQ_remind();
    assert.deepEqual(since(g, n).push.map((x) => x.body.to), [KANRI], String(emp));
  }
});

test('20b結合: 従業員連絡へ送れなければ勤怠管理へ、どちらも無理なら管理者へ', () => {
  const { g } = setup();
  g.line.pushFail.add(EMP);
  let n = g.fetches.length;
  post(g, userMsg(U(1), '相談です'));
  assert.deepEqual(since(g, n).push.map((x) => x.body.to), [EMP, KANRI]);
  g.line.pushFail.add(KANRI);
  g.line.profiles[U(4)] = 'よんちゃん';
  n = g.fetches.length;
  post(g, userMsg(U(4), '別の相談です'));
  const p = since(g, n).push;
  assert.deepEqual(p.map((x) => x.body.to), [EMP, KANRI, ADMIN]);
  assert.match(p[2].body.messages[0].text, /（従業員連絡グループ・勤怠管理グループへ送れなかったため、こちらへお知らせしました）$/);
});

test('20b結合: ボタン・「1.3対応済み」は従業員連絡グループでも使える（ほかの部門のグループは無反応）', () => {
  const { g, book } = setup();
  let n = g.fetches.length;
  post(g, userMsg(U(1), '相談です'));
  const data = since(g, n).push[0].body.messages[0].contents.footer.contents[0].action.data;
  n = g.fetches.length;
  post(g, grp(OTHER, { type: 'postback', postback: { data } }));
  assert.equal(caseRows(book)[0][1], '未対応');
  post(g, grp(EMP, { type: 'postback', postback: { data } }));
  assert.equal(caseRows(book)[0][1], '対応中');
  assert.match(since(g, n).reply[0].body.messages[0].text, /担当Aさんが対応中にしました/);
  g.clock.now = new Date('2026-11-24T15:00:00+09:00').getTime();
  g.ctx.INQ_remind();
  n = g.fetches.length;
  post(g, grp(EMP, { type: 'message', message: { id: 'mx', type: 'text', text: '1対応済み' } }));
  assert.equal(caseRows(book)[0][1], '対応済み');
  assert.match(since(g, n).reply[0].body.messages[0].text, /対応済みにしました/);
});

test('20b結合: 「部門登録 従業員連絡」で登録できる（勤怠管理・部署の登録はそのまま）', () => {
  const { g, master } = setup({ emp: null });
  const NEW = 'C' + 'd'.repeat(32);
  let n = g.fetches.length;
  post(g, grp(NEW, { type: 'message', message: { id: 'r1', type: 'text', text: '部門登録 従業員連絡' } }));
  const r = since(g, n).reply[0].body.messages[0].text;
  assert.match(r, /「従業員連絡」のグループとして登録しました/);
  assert.match(r, /問い合わせと、9時・15時の未対応のまとめをこちらへ/);
  const rows = master.getSheetByName('LINEグループ').dump();
  assert.deepEqual(rows.at(-1).filter((_, i) => i !== 2), [NEW, '従業員連絡', '有効']);
  // 登録後は受付のお知らせがそちらへ
  n = g.fetches.length;
  post(g, userMsg(U(1), '相談です'));
  assert.deepEqual(since(g, n).push.map((x) => x.body.to), [NEW]);
  // Inquiry.gs が無ければ「従業員連絡」は登録できない（今までと同じ）
  const g2 = setup({ emp: null, files: ['AlcoholCheck.gs'] }).g;
  n = g2.fetches.length;
  post(g2, grp(NEW, { type: 'message', message: { id: 'r2', type: 'text', text: '部門登録 従業員連絡' } }));
  assert.match(since(g2, n).reply[0].body.messages[0].text, /という部門が見つかりませんでした/);
});

test('20b結合: 管理者へのお知らせ（朝のまとめ）・飲酒検知（CRIT）の宛先は勤怠管理のまま', () => {
  const files = ['AlcoholCheck.gs', 'Inquiry.gs', 'Notices.gs', 'TotSync.gs', 'OfficeTask.gs'];
  const { g } = setup({ props: { ADMIN_NOTIFY: 'digest' }, files, now: '2026-11-24T08:00:00+09:00' });
  post(g, userMsg(U(1), '相談です'));
  g.ctx.AC_pushLine_('【有給の年5日】テスト');
  g.clock.now = new Date('2026-11-24T09:00:00+09:00').getTime();
  const n = g.fetches.length;
  g.ctx.INQ_remind();
  const p = since(g, n).push;
  assert.deepEqual(p.map((x) => x.body.to), [EMP, KANRI]);                   // 問い合わせのまとめ → 従業員連絡、管理者へのお知らせ → 勤怠管理
  assert.match(p[0].body.messages[0].text, /^【問い合わせ 未完了1件】/);
  assert.equal(p[0].body.messages.length, 1);
  assert.match(p[1].body.messages[0].text, /^【管理本部へのお知らせ】[\s\S]*有給の年5日/);
  const dest = JSON.parse(JSON.stringify(g.ctx.AC_alertDestinations_(g.scriptProps)));
  assert.deepEqual(dest.map((d) => d.to), [ADMIN, KANRI]);                  // 飲酒検知：従業員連絡には送らない
});
