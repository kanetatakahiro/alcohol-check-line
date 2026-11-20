import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';
import { cards, carousels } from './helpers/inquiry-cards.js';

// 版 2026-11-20d：問い合わせの 9:00／15:00 のまとめ（A-36）を、1件1枚のカード（ボタン付き）のカルーセルで送る。
// すべて架空データ・LINEへの送信なし
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const KANRI = 'C' + 'a'.repeat(32), EMP = 'C' + 'c'.repeat(32);
const ADMIN = U(7), STAFF = U(8);
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const row = (code, name, dept, userId) => ["'" + code, name, '', '在籍', dept, userId, '', '', true, true, '', '', '', ''];

function setup({ props = {}, now = '2026-11-20T10:00:00+09:00' } = {}) {
  const g = createGas({ files: ['AlcoholCheck.gs', 'Inquiry.gs'], now });
  const master = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = master.insertSheet('従業員マスタ');
  [HEAD, row('90001', '試験 一郎', '部署A', U(1)), row('90002', '試験 二郎', '部署B', U(2))].forEach((r) => m.appendRow(r));
  const gs = master.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [KANRI, '勤怠管理', '2026-10-15', '有効'], [EMP, '従業員連絡', '2026-11-20', '有効']].forEach((r) => gs.appendRow(r));
  const book = g.newSpreadsheet('【テスト】従業員問い合わせ管理（架空）');
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: master.getId(), INQ_SPREADSHEET_ID: book.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake',
    LINE_ADMIN_USER_ID: ADMIN, INQ_MODE: 'on', ...props });
  g.line.members[EMP] = { [STAFF]: '担当A', [ADMIN]: '管理者' };
  g.line.members[KANRI] = { [STAFF]: '担当A' };
  g.line.profiles[U(1)] = 'いちろう'; g.line.profiles[U(2)] = 'じろう';
  return { g, book };
}
let seq = 0;
const userMsg = (userId, text, id = 'cv' + ++seq) => ({ type: 'message', webhookEventId: id, replyToken: 'rt-' + id, timestamp: 0,
  source: { type: 'user', userId }, message: { id: 'm' + id, type: 'text', text } });
const press = (data, groupId = EMP, id = 'cv' + ++seq) => ({ type: 'postback', webhookEventId: id, replyToken: 'rt-' + id,
  source: { type: 'group', groupId, userId: STAFF }, postback: { data } });
const post = (g, ...events) => g.ctx.doPost({ postData: { contents: JSON.stringify({ destination: 'x', events }) } });
const since = (g, n) => {
  const f = g.fetches.slice(n);
  return { push: f.filter((x) => x.url.endsWith('/push')), reply: f.filter((x) => x.url.endsWith('/reply')) };
};
const caseRows = (book) => book.getSheetByName('問い合わせ').dump().slice(1);
const at = (s) => new Date(s);
const plain = (x) => JSON.parse(JSON.stringify(x));   // 模擬環境（vm）で作った配列を、比べられる普通の配列に

// 純粋関数用の架空の案件（i 番目。受付は 11/18 9:00 から1分ずつ）
const fake = (i, extra = {}) => ({ id: 'Q-20261118-' + String(i + 1).padStart(3, '0'), state: '未対応', link: '登録済み', name: '試験 ' + (i + 1), dept: '部署A',
  at: at(`2026-11-18T09:${String(i % 60).padStart(2, '0')}:00+09:00`), head: '相談' + (i + 1), secret: false, token: 'abc' + String(i).padStart(3, '0').slice(-3),
  category: 'その他', point: '相談', staff: '', ...extra });
const NOW = at('2026-11-20T15:00:00+09:00');

test('20d: 1件・3件はカルーセル1通（並びは文字のまとめと同じ・altText・カードの中身・ボタン）', () => {
  const { g } = setup();
  const X = g.ctx;
  const one = X.INQ_remindCarousels([fake(0)], NOW);
  assert.equal(one.messages.length, 1);
  assert.equal(one.messages[0].altText, '【問い合わせ 未完了1件】11/20 15:00');
  const b = one.messages[0].contents.contents[0];
  assert.deepEqual(plain(b.body.contents.filter((x) => x.type === 'text').map((x) => x.text)),
    ['① 試験 1（部署A）', '受付：11/18 9:00（2日前）', '状況：未対応', '要約：その他／相談', '内容：「相談1」']);
  const btns = plain(b.footer.contents.map((x) => [x.action.label, x.action.data, x.action.displayText]));
  assert.deepEqual(btns, [['対応します', 'inq|1|take|Q-20261118-001|abc000', '対応します（試験 1（部署A））'],
    ['対応済みにする', 'inq|1|done|Q-20261118-001|abc000', '対応済みにします（試験 1（部署A））']]);   // 受付のお知らせと同じ postback
  // 3件：未対応が先・受付の古い順（文字のまとめと同じ）。対応中は担当を出す
  const list = [fake(0, { state: '対応中', staff: '担当A' }), fake(1, { at: at('2026-11-20T08:00:00+09:00') }), fake(2)];
  const three = X.INQ_remindCarousels(list, NOW);
  assert.equal(three.messages.length, 1);
  assert.equal(three.messages[0].altText, '【問い合わせ 未完了3件】11/20 15:00');
  const cs = cards([{ body: { messages: three.messages } }]);
  assert.deepEqual(cs.map((c) => c[0]), ['① 試験 3（部署A）', '② 試験 2（部署A）', '③ 試験 1（部署A）']);
  assert.deepEqual(cs.map((c) => c[1]), ['受付：11/18 9:02（2日前）', '受付：11/20 8:00（今日）', '受付：11/18 9:00（2日前）']);
  assert.equal(cs[2][2], '状況：対応中（担当：担当A）');
  assert.deepEqual([...three.ids], ['Q-20261118-003', 'Q-20261118-002', 'Q-20261118-001']);
  const textOrder = X.INQ_remindList(list).map((c) => c.id);
  assert.deepEqual([...three.ids], [...textOrder]);
  // 対応済みは入らない・0件は null
  assert.equal(X.INQ_remindCarousels([fake(0, { state: '対応済み' })], NOW), null);
});

test('20d: 11件は2通（10枚＋1枚）、60件は5通50枚で最後のカードに「ほか10件は…」', () => {
  const { g } = setup();
  const X = g.ctx;
  const eleven = X.INQ_remindCarousels(Array.from({ length: 11 }, (_, i) => fake(i)), NOW);
  assert.deepEqual(plain(eleven.messages.map((m) => m.contents.contents.length)), [10, 1]);
  assert.ok(eleven.messages.every((m) => m.altText === '【問い合わせ 未完了11件】11/20 15:00'));
  assert.equal(cards([{ body: { messages: eleven.messages } }])[10][0], '⑪ 試験 11（部署A）');
  assert.equal(eleven.more, 0);
  const sixty = X.INQ_remindCarousels(Array.from({ length: 60 }, (_, i) => fake(i)), NOW);
  assert.deepEqual(plain(sixty.messages.map((m) => m.contents.contents.length)), [10, 10, 10, 10, 10]);   // 1回の送信は5通まで
  assert.deepEqual([sixty.total, sixty.shown, sixty.more, sixty.ids.length], [60, 50, 10, 50]);
  const cs = cards([{ body: { messages: sixty.messages } }]);
  assert.equal(cs[20][0], '(21) 試験 21（部署A）');
  assert.equal(cs[49].at(-1), 'ほか10件は問い合わせ管理のシートで確認してください');
  assert.ok(cs.slice(0, 49).every((c) => !c.some((t) => /ほか\d+件/.test(t))));
  sixty.messages.forEach((m) => assert.ok(JSON.stringify(m).length < 30000));   // カルーセル1通の大きさの上限（50KB）に余裕
});

test('20d: 機密・要注意は内容を出さない（内容は200文字まで・超えたら続きはチャットで）', () => {
  const { g } = setup();
  const X = g.ctx;
  const list = [
    fake(0, { head: '口座＊＊＊', secret: true, category: '⚠口座・マイナンバー', point: '' }),
    fake(1, { head: '上司からのパワハラの件', category: '⚠ハラスメント・人間関係' }),
    fake(2, { head: '来週の件／実は体調が悪くて病院へ', category: 'その他' }),           // シートの分類は普通でも、内容が要注意
    fake(3, { head: 'あ'.repeat(200) + '…' }),
  ];
  const cs = cards([{ body: { messages: X.INQ_remindCarousels(list, NOW).messages } }]);
  assert.deepEqual(cs.map((c) => c.at(-1)), ['内容：機密を含むため、チャットで確認してください', '内容：（内容はチャットで確認してください）',
    '内容：（内容はチャットで確認してください）', '内容：「' + 'あ'.repeat(200) + '…（続きはチャットで）」']);
  assert.equal(cs[0][3], '要約：⚠口座・マイナンバー');
  const all = JSON.stringify(cs);
  for (const w of ['パワハラ', '病院', '口座＊']) assert.ok(!all.includes(w), w);
});

test('20d結合: まとめはカルーセルで従業員連絡グループへ。ボタンで対応中・対応済み（重ねて記録しない）', () => {
  const { g, book } = setup();
  post(g, userMsg(U(1), '有給の残りを教えてください'));
  post(g, userMsg(U(2), '来月のシフトの相談です'));
  g.clock.now = at('2026-11-20T15:00:00+09:00').getTime();
  let n = g.fetches.length;
  g.ctx.INQ_remind();
  const p = since(g, n).push;
  assert.deepEqual(p.map((x) => x.body.to), [EMP]);
  assert.equal(carousels(p).length, 1);
  assert.equal(p[0].body.messages[0].altText, '【問い合わせ 未完了2件】11/20 15:00');
  const cs = cards(p);
  assert.deepEqual(cs.map((c) => c[0]), ['① 試験 一郎（部署A）', '② 試験 二郎（部署B）']);
  const btn = (i, k) => p[0].body.messages[0].contents.contents[i].footer.contents[k].action.data;
  // ［対応します］→ 対応中・担当者
  n = g.fetches.length;
  post(g, press(btn(0, 0)));
  let r = caseRows(book)[0];
  assert.deepEqual([r[1], r[13], r[14]], ['対応中', '担当A', STAFF]);
  assert.match(since(g, n).reply[0].body.messages[0].text, /試験 一郎（部署A）の問い合わせを、担当Aさんが対応中にしました。/);
  // もう一度［対応します］→ 重ねて記録しない
  n = g.fetches.length;
  const logs = () => book.getSheetByName('やりとり').dump().length;
  let before = logs();
  post(g, press(btn(0, 0)));
  assert.equal(logs(), before);
  assert.match(since(g, n).reply[0].body.messages[0].text, /は、担当Aさんが対応中です。/);
  // ［対応済みにする］→ 対応済み・完了者・完了日時
  post(g, press(btn(0, 1)));
  r = caseRows(book)[0];
  assert.deepEqual([r[1], r[16], r[17]], ['対応済み', '担当A', STAFF]);
  assert.ok(r[18]);
  // 対応済みの案件のボタンは、どちらも重ねて記録しない
  before = logs();
  const doneAt = String(caseRows(book)[0][18]);
  n = g.fetches.length;
  post(g, press(btn(0, 1)), press(btn(0, 0)));
  assert.equal(logs(), before);
  assert.equal(String(caseRows(book)[0][18]), doneAt);
  assert.equal(caseRows(book)[0][1], '対応済み');
  since(g, n).reply.forEach((x) => assert.match(x.body.messages[0].text, /は対応済みです（.*担当Aさん）。/));
  // 未対応の2件目：いきなり［対応済みにする］（担当者も入る）
  post(g, press(btn(1, 1)));
  r = caseRows(book)[1];
  assert.deepEqual([r[1], r[13], r[16]], ['対応済み', '担当A', '担当A']);
  // 次のまとめは0件 → 送らない
  n = g.fetches.length;
  g.clock.now = at('2026-11-21T09:00:00+09:00').getTime();
  g.ctx.INQ_remind();
  assert.equal(since(g, n).push.length, 0);
});

test('20d結合: 11件は1回の送信で2通。番号で「1.3対応済み」も使える', () => {
  const { g, book } = setup();
  post(g, userMsg(U(1), '相談のテスト'));
  // 架空の案件を10件足す（受付の処理は1人1件のため、シートに直接）
  const sh = book.getSheetByName('問い合わせ'), head = sh.dump()[0];
  for (let i = 0; i < 10; i++) {
    const r = head.map(() => '');
    const set = (k, v) => { r[head.indexOf(k)] = v; };
    set('案件番号', 'Q-20261119-' + String(i + 1).padStart(3, '0')); set('状態', '未対応'); set('紐付け', '未登録'); set('LINE表示名', 'かくう' + i);
    set('受付日時', at('2026-11-19T10:00:00+09:00')); set('内容（冒頭）', '架空の相談' + i); set('機密あり', false); set('合言葉', 'abcde' + i);
    sh.appendRow(r);
  }
  g.clock.now = at('2026-11-20T15:00:00+09:00').getTime();
  let n = g.fetches.length;
  g.ctx.INQ_remind();
  const p = since(g, n).push;
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].body.messages.map((m) => m.contents.contents.length), [10, 1]);
  n = g.fetches.length;
  post(g, { type: 'message', webhookEventId: 'cvx', replyToken: 'rt-x', source: { type: 'group', groupId: EMP, userId: STAFF },
    message: { id: 'mx', type: 'text', text: '1.11対応済み' } });
  assert.match(since(g, n).reply[0].body.messages[0].text, /対応済みにしました（担当Aさん）\n① 氏名不明（かくう0）\n⑪ 試験 一郎（部署A）/);
});

test('20d結合: カルーセルを送れないときは文字のまとめ（「1.3対応済み」の案内つき）を送る', () => {
  const { g, book } = setup();
  post(g, userMsg(U(1), '有給の残りを教えてください'));
  const orig = g.ctx.INQ_pushMessages_;
  g.ctx.INQ_pushMessages_ = (to, messages) => (messages.some((m) => m.type === 'flex') ? false : orig(to, messages));   // Flex だけ失敗
  g.clock.now = at('2026-11-20T15:00:00+09:00').getTime();
  let n = g.fetches.length;
  g.ctx.INQ_remind();
  const p = since(g, n).push;
  assert.deepEqual(p.map((x) => x.body.to), [EMP]);
  assert.equal(p[0].body.messages[0].type, 'text');
  assert.match(p[0].body.messages[0].text, /^【問い合わせ 未完了1件】11\/20 15:00\n\n① 試験 一郎（部署A）\n状況：未対応（今日から）[\s\S]*1\.3対応済み/);
  n = g.fetches.length;
  post(g, { type: 'message', webhookEventId: 'cvy', replyToken: 'rt-y', source: { type: 'group', groupId: EMP, userId: STAFF },
    message: { id: 'my', type: 'text', text: '1対応済み' } });
  assert.equal(caseRows(book)[0][1], '対応済み');
  // グループにどちらも送れない（カルーセルも文字も）→ 今までどおり管理者へ文字で
  const s2 = setup();
  post(s2.g, userMsg(U(1), '相談です'));
  s2.g.line.pushFail.add(EMP); s2.g.line.pushFail.add(KANRI);
  s2.g.clock.now = at('2026-11-20T15:00:00+09:00').getTime();
  n = s2.g.fetches.length;
  s2.g.ctx.INQ_remind();
  const q = since(s2.g, n).push;
  assert.deepEqual(q.map((x) => x.body.to), [EMP, KANRI, EMP, KANRI, ADMIN]);   // カード → 文字 → 管理者
  assert.match(q[4].body.messages[0].text, /^【問い合わせ 未完了1件】[\s\S]*（従業員連絡グループ・勤怠管理グループへ送れなかったため、こちらへお知らせしました）$/);
});

test('20e: まとめは9時・12時。管理者へのお知らせ（朝のまとめ）は9時の回だけ（12時の回がトリガーのずれで 11:45〜11:59 に動いても付けない）', () => {
  const { g } = setup({ props: { ADMIN_NOTIFY: 'digest' }, now: '2026-11-20T08:00:00+09:00' });
  const X = g.ctx;
  assert.deepEqual([...X.INQ_REMIND_HOURS], [9, 12]);
  // 判定：9時の回（8:45〜9:15）は付ける、12時の回（11:45〜12:15）は付けない
  for (const hm of ['08:45', '09:00', '09:15', '10:29']) assert.equal(X.INQ_isDigestRun(hm), true, hm);
  for (const hm of ['10:30', '11:45', '11:59', '12:00', '12:15', '15:00']) assert.equal(X.INQ_isDigestRun(hm), false, hm);
  // 結合：12時の回がずれて 11:50 に動いても、管理者へのお知らせは送らず翌朝に回す
  post(g, userMsg(U(1), '相談です'));
  X.AC_pushLine_('【有給の年5日】テスト');                                     // 朝のまとめにためる（digest）
  g.clock.now = at('2026-11-20T11:50:00+09:00').getTime();
  let n = g.fetches.length;
  X.INQ_remind();
  let p = since(g, n).push;
  assert.deepEqual(p.map((x) => x.body.to), [EMP]);                        // 問い合わせのカードだけ
  assert.ok(!JSON.stringify(p).includes('管理本部へのお知らせ'));
  g.clock.now = at('2026-11-21T08:50:00+09:00').getTime();                  // 翌朝（9時の回が 8:50 に動いた）
  n = g.fetches.length;
  X.INQ_remind();
  p = since(g, n).push;
  assert.deepEqual(p.map((x) => x.body.to), [EMP, KANRI]);
  assert.match(p[1].body.messages[0].text, /^【管理本部へのお知らせ】[\s\S]*有給の年5日/);
});
