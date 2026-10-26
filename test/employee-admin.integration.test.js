import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createGas, signForward } from './helpers/gas-mock.js';
import worker, { clock as workerClock } from '../workers/line-webhook/src/index.js';

// 社員管理AIの結合テスト（すべて架空データ）
//  A：既存の「勤怠・アルコールチェック管理」（gas/AlcoholCheck.gs そのまま）＋既存の公式LINE
//  B：社員管理AI専用プロジェクト（EmployeeAdmin.gs＋EmployeeAdminHost.gs）＋社員管理AI用LINE（Cloudflare Workers の受け口）
//  AとBは同じ従業員マスタ（同じスプレッドシート）を使う。勤怠管理グループには両方の公式アカウントが入っている。

const CH = 'ea-channel-secret-not-real', FWD = 'ea-forward-secret-not-real';
const GAS_B = 'https://script.google.com/macros/s/EA-TEST/exec';
const ADMIN_G_A = 'C' + 'a'.repeat(32);     // 既存の公式LINEから見た勤怠管理グループ
const ADMIN_G_B = 'C' + 'e'.repeat(32);     // 社員管理AI用LINEから見た勤怠管理グループ
const DEPT_G = 'C' + 'b'.repeat(32);
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const ADMIN1 = U(1), ADMIN2 = U(2), OUTSIDER = U(9), EMP1 = U(3);
const HEAD14 = ['社員番号', '氏名', '別表記（シフト表の書き方が違う場合）', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時',
  'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const HIRE = '【入社】\n社員番号：90100\n氏名：試験 花子\n入社日：2026-11-15\n所属・拠点：部署A\n社員区分：社員\nTOTコード：600\nシフト表の書き方：はなこ\nアルコールチェック：対象';
const RETIRE = '【退社】\n社員番号：90001\n氏名：試験 一郎\n退職日：2026-11-30\n最終出社日：2026-11-20';

function setup({ mode = 'on', autoApply = false } = {}) {
  const A = createGas({ files: ['AlcoholCheck.gs'], now: '2026-11-10T10:00:00+09:00' });
  const ss = A.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = ss.insertSheet('従業員マスタ');
  m.appendRow(HEAD14);
  m.appendRow(["'90001", '試験 一郎', '', '在籍', '部署A', EMP1, '一郎', '', true, true, '', '正社員', 501, '']);
  m.appendRow(["'90002", '試験 二郎', 'しけん二郎', '在籍', '部署B', '', '', '', false, true, '', 'パート', 502, '']);
  m.appendRow(["'90003", '試験 三郎', '', '退職', '部署A', '', '', '', false, false, '', '正社員', 503, "'2026-09-30"]);
  const grp = ss.insertSheet('LINEグループ');
  grp.appendRow(['グループID', '部門（所属）', '登録日時', '状態']);
  grp.appendRow([ADMIN_G_A, '勤怠管理', new A.FakeDate(), '有効']);
  grp.appendRow([DEPT_G, '部署A', new A.FakeDate(), '有効']);
  const pause = ss.insertSheet('お知らせ停止');
  pause.appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  pause.appendRow(["'90002", '試験 二郎', '2026-11-12', '2026-11-12', '手入力の休み', '全部']);
  A.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: ss.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'existing-token-for-test', LINE_ADMIN_USER_ID: U(7) });

  const B = createGas({ files: ['EmployeeAdmin.gs', 'EmployeeAdminHost.gs'], shared: A.shared });
  B.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: ss.getId(), EA_LINE_CHANNEL_TOKEN: 'ea-token-for-test', EA_FORWARD_SECRET: FWD,
    EA_ADMIN_GROUP_ID: ADMIN_G_B, EA_MODE: mode, ...(autoApply ? { EA_AUTO_APPLY: 'true' } : {}) });
  B.line.members[ADMIN_G_B] = { [ADMIN1]: '管理A', [ADMIN2]: '管理B' };
  B.ctx.employeeAdminSetup();

  const env = { LINE_CHANNEL_SECRET: CH, EA_FORWARD_SECRET: FWD, GAS_WEBAPP_URL: GAS_B };
  let seq = 0, gasDown = 0;
  const ev = (text, { userId = ADMIN1, groupId = ADMIN_G_B, id } = {}) => ({
    type: 'message', webhookEventId: id || `EV${++seq}`, replyToken: `rt${seq}`, timestamp: A.clock.now,
    deliveryContext: { isRedelivery: false },
    source: groupId ? { type: 'group', groupId, ...(userId ? { userId } : {}) } : { type: 'user', userId },
    message: { type: 'text', id: `m${seq}`, text },
  });
  const postB = (body) => B.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent();
  const postA = (body) => A.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent();
  const sig = (raw) => createHmac('sha256', CH).update(raw).digest('base64');
  /** LINE（社員管理AI用）→ Cloudflare Workers → B。headers を変えると改ざん・署名なしの試験 */
  async function viaWorker(rawBody, headers) {
    const realFetch = globalThis.fetch, realLog = console.log;
    console.log = () => {};                         // 受け口のログ（件数だけ）は表示しない
    workerClock.now = () => B.clock.now;            // 受け口の時計を模擬の「今」に合わせる
    globalThis.fetch = async (url, opt) => {
      assert.equal(url, GAS_B);
      if (gasDown > 0) { gasDown--; throw new Error('timeout'); }
      const out = B.ctx.doPost({ postData: { contents: opt.body } }).getContent();
      return new Response(out, { status: 200 });
    };
    try {
      const res = await worker.fetch(new Request('https://ea.example.workers.dev/line/webhook', { method: 'POST', body: rawBody,
        headers: headers || { 'x-line-signature': sig(rawBody), 'content-type': 'application/json' } }), env);
      return res.status;
    } finally { globalThis.fetch = realFetch; console.log = realLog; }
  }
  const sentB = (from) => B.fetches.slice(from).filter((f) => /message\/(reply|push)$/.test(f.url));
  async function send(text, opt) {
    const n = B.fetches.length;
    const raw = JSON.stringify({ destination: 'Ubot', events: [ev(text, opt)] });
    const status = await viaWorker(raw);
    const sent = sentB(n);
    return { status, raw, sent, text: sent.map((f) => f.body.messages[0].text).join('\n---\n'), quick: sent[0] && sent[0].body.messages[0].quickReply };
  }
  const sheet = (n) => ss.getSheetByName(n);
  const reqs = () => sheet('社員管理_申請').dump().slice(1);
  const master = () => m.dump();
  const approveText = (r) => r.quick.items[0].action.text;
  return { A, B, ss, m, ev, postA, postB, sig, viaWorker, send, sheet, reqs, master, approveText, setGasDown: (n) => { gasDown = n; } };
}

test('入社：Workers経由の申請 → 承認 → 入社日に反映 → 報告。既存の読み取り（A）からも正しく見える', async () => {
  const t = setup();
  assert.match((await t.send('入社')).text, /【入社】/);
  const a = await t.send(HIRE);
  assert.equal(a.status, 200);
  assert.match(a.text, /入社の申請を受け付けました（EA-20261110-001）/);
  assert.equal(a.quick.items.length, 2);
  assert.match((await t.send(t.approveText(a), { userId: OUTSIDER })).text, /メンバーであることを確認できなかった/);
  assert.match((await t.send('承認 EA-20261110-001 000000')).text, /承認コードが違います/);
  assert.match((await t.send(t.approveText(a), { userId: ADMIN2 })).text, /承認しました。\n2026-11-15 の朝/);
  assert.equal(t.reqs()[0][1], '予約');
  assert.match((await t.send(t.approveText(a))).text, /その操作はできません/);

  t.B.clock.now = new Date('2026-11-15T05:10:00+09:00').getTime();
  t.B.ctx.employeeAdminDaily();                       // 自動反映が無効なら反映しない
  assert.equal(t.master().length, 4);
  const n = t.B.fetches.length;
  assert.match(t.B.ctx.EA_runDaily_(true)[0], /反映しました/);
  const push = t.B.fetches.slice(n).find((f) => f.url.endsWith('/push'));
  assert.equal(push.body.to, ADMIN_G_B);
  assert.equal(push.opt.headers.Authorization, 'Bearer ea-token-for-test');   // 社員管理AI用LINEから送る

  const mv = t.master(), row = mv[4];
  assert.equal(mv[0][14], '入社日');
  assert.deepEqual([row[0], row[1], row[2], row[3], row[8], row[9], row[11], row[12], row[13], row[14]],
    ['90100', '試験 花子', 'はなこ', '在籍', false, true, '正社員', '600', '', '2026-11-15']);
  assert.equal(t.reqs()[0][1], '反映済');
  assert.deepEqual(t.sheet('別表記').dump()[1].slice(0, 2), ['90100', 'はなこ']);
  // 既存（A）の関数で読む
  assert.ok([...t.A.ctx.AC_formChoices(mv)].includes('試験 花子（90100）'));
  assert.equal(t.A.ctx.AC_isRetired(row[13], '2026-11-15'), false);
  assert.equal(t.A.ctx.AC_totKey(row[12]), '600');
  // 本人が既存の公式LINEで社員番号を送る（Aの1対1登録）→ 新しい行にLINE IDが入る
  t.postA({ events: [t.ev('90100', { groupId: null, userId: U(5) })] });
  assert.equal(t.master()[4][5], U(5));
  assert.match((await t.send('【取消】\n申請番号：EA-20261110-001')).text, /反映済みの申請は取消できません/);
});

test('退社：承認でお知らせ停止 → 取消で戻す → 再申請 → 退職日の翌日に退職。既存の停止判定（A）が読める', async () => {
  const t = setup();
  const a = await t.send(RETIRE);
  assert.match(a.text, /2026-11-21〜2026-11-30 はお知らせを止めます/);
  await t.send(t.approveText(a));
  const p = t.sheet('お知らせ停止').dump();
  assert.deepEqual(p[0].slice(6), ['作成元', '管理ID']);
  assert.equal(p.length, 3);
  const idx = t.A.ctx.AC_pauseIndex(p, t.A.ctx.AC_toDateFn_());
  assert.equal(t.A.ctx.AC_isPaused(idx, '90001', '2026-11-21', 'alcohol'), true);
  assert.equal(t.A.ctx.AC_isPaused(idx, '90001', '2026-11-20', 'alcohol'), false);
  assert.match((await t.send('取消')).text, /EA-20261110-001（退社・90001・予約）/);
  assert.match((await t.send('【取消】\n申請番号：EA-20261110-001')).text, /取り消しました/);
  assert.equal(t.sheet('お知らせ停止').dump().length, 2);
  assert.equal(t.sheet('お知らせ停止').dump()[1][4], '手入力の休み');

  const b = await t.send(RETIRE.replace('最終出社日：2026-11-20', '最終出社日：'));
  await t.send(t.approveText(b));
  t.B.clock.now = new Date('2026-11-30T05:10:00+09:00').getTime();
  assert.deepEqual([...t.B.ctx.EA_runDaily_(true)], []);
  t.B.clock.now = new Date('2026-12-01T05:10:00+09:00').getTime();
  assert.match(t.B.ctx.EA_runDaily_(true)[0], /反映しました/);
  const r = t.master()[1];
  assert.deepEqual([r[3], r[13], r[5]], ['退職', '2026-11-30', EMP1]);
  assert.equal(Object.keys(t.A.ctx.AC_lineByTotCode(t.master(), '2026-12-01')).length, 0);
  assert.deepEqual(t.sheet('社員管理_変更履歴').dump().slice(1).map((h) => [h[6], h[7], h[8]]), [['在籍状況', '在籍', '退職'], ['退職日', '', '2026-11-30']]);
});

test('自動反映が有効なら、反映日を過ぎた承認はその場で反映し、グループへ報告する', async () => {
  const t = setup({ autoApply: true });
  const a = await t.send(RETIRE.replace('退職日：2026-11-30', '退職日：2026-11-09').replace('最終出社日：2026-11-20', '最終出社日：2026-11-06'));
  const b = await t.send(t.approveText(a));
  assert.match(b.text, /このあとすぐ従業員マスタに反映します/);
  assert.match(b.text, /反映しました/);
  assert.deepEqual([t.master()[1][3], t.master()[1][13]], ['退職', '2026-11-09']);
  const c = await t.send(HIRE);
  assert.match((await t.send(t.approveText(c))).text, /2026-11-15 の朝/);
  assert.equal(t.master().length, 4);
});

test('入社前に既存の公式LINEで登録した人は、その行に入社情報を書き込む。直前に別の人の登録があっても上書きしない', async () => {
  const t = setup({ autoApply: true });
  t.postA({ events: [t.ev('90200', { groupId: null, userId: U(6) })] });     // Aの1対1登録で仮の行
  assert.equal(t.master().length, 5);
  const today = '2026-11-10';
  const a = await t.send(HIRE.replace('90100', '90200').replace('2026-11-15', today).replace('TOTコード：600', 'TOTコード：'));
  assert.match(a.text, /先にLINE登録済み/);
  t.postA({ events: [t.ev('90300', { groupId: null, userId: U(8) })] });     // 承認の直前に別の人の仮の行
  await t.send(t.approveText(a));
  const mv = t.master();
  assert.equal(mv.length, 6);
  assert.deepEqual([mv[4][0], mv[4][1], mv[4][5], mv[4][10], mv[4][14]], ['90200', '試験 花子', U(6), '', today]);
  assert.deepEqual([mv[5][0], mv[5][5]], ['90300', U(8)]);
  // 新しい行の追加（appendRow）も、既存の行を上書きしない
  const c = await t.send(HIRE.replace('90100', '90400').replace('2026-11-15', today).replace('TOTコード：600', 'TOTコード：'));
  await t.send(t.approveText(c));
  assert.deepEqual(t.master().map((r) => r[0]).slice(4), ['90200', '90300', '90400']);
});

test('入力ミス・期限切れ・二重申請・パソコン版LINE', async () => {
  const t = setup();
  const e = await t.send('【入社】\n社員番号：90001\n氏名：\n入社日：2026-02-30');
  assert.match(e.text, /受け付けできませんでした/);
  assert.match(e.text, /再利用しません/);
  assert.equal(t.reqs().length, 0);
  const a = await t.send(RETIRE);
  assert.match((await t.send(RETIRE)).text, /同じ社員番号の申請（EA-20261110-001/);
  t.B.clock.now += 73 * 3600 * 1000;
  assert.match((await t.send(t.approveText(a))).text, /期限（72時間）を過ぎています/);
  assert.equal(t.reqs()[0][1], '期限切れ');
  t.B.ctx.EA_runDaily_(false);
  assert.equal(t.reqs()[1][1], '期限切れ');
  assert.match((await t.send(RETIRE, { userId: null })).text, /スマートフォンのLINEから/);
});

test('署名：署名なし・改ざん・別のチャネルの署名は Workers が401で止め、何も記録しない', async () => {
  const t = setup();
  const raw = JSON.stringify({ destination: 'Ubot', events: [t.ev(HIRE)] });
  assert.equal(await t.viaWorker(raw, { 'content-type': 'application/json' }), 401);
  assert.equal(await t.viaWorker(raw.replace('90100', '90999'), { 'x-line-signature': t.sig(raw) }), 401);   // 本文の改ざん
  assert.equal(await t.viaWorker(raw, { 'x-line-signature': createHmac('sha256', 'other').update(raw).digest('base64') }), 401);
  assert.equal(await t.viaWorker(raw, { 'x-line-signature': 'AAAA' }), 401);
  assert.equal(t.reqs().length, 0);
  assert.equal(t.sheet('社員管理_操作ログ').dump().length, 1);
  const empty = JSON.stringify({ destination: 'Ubot', events: [] });
  assert.equal(await t.viaWorker(empty), 200);          // LINE Developers の「検証」ボタン
});

test('転送：Bへの直接の送信（署名なし）・合言葉違い・古い・使い回し・本文差し替えは NG で何も記録しない', async () => {
  const t = setup();
  const nowSec = Math.floor(t.B.clock.now / 1000);
  const payload = { destination: 'Ubot', events: [t.ev(HIRE)] };
  assert.equal(t.postB(payload), 'NG');                 // LINEの本文をそのまま送っても受け付けない
  assert.equal(t.postB(signForward('wrong', payload, nowSec)), 'NG');
  assert.equal(t.postB(signForward(FWD, payload, nowSec - 301)), 'NG');
  const ok = signForward(FWD, payload, nowSec);
  assert.equal(t.postB({ ...ok, payload: ok.payload.replace('90100', '90999') }), 'NG');
  assert.equal(t.reqs().length, 0);
  assert.equal(t.postB(ok), 'OK');
  assert.equal(t.reqs().length, 1);
  assert.equal(t.postB(ok), 'NG');                      // 同じ転送の使い回し
  assert.equal(t.reqs().length, 1);
});

test('重複：Apps Script の一時的な失敗 → LINEの再送（同じ webhookEventId）でも1回だけ処理', async () => {
  const t = setup();
  const raw = JSON.stringify({ destination: 'Ubot', events: [t.ev(HIRE, { id: 'SAME-1' })] });
  t.setGasDown(1);
  assert.equal(await t.viaWorker(raw), 500);            // 届かなければ LINE に失敗を返す（LINE が再送する）
  assert.equal(t.reqs().length, 0);
  assert.equal(await t.viaWorker(raw), 200);            // LINE の再送
  assert.equal(await t.viaWorker(raw), 200);            // もう一度届いても
  assert.equal(t.reqs().length, 1);
});

test('範囲：勤怠管理グループ以外・1対1・普段の会話には反応しない。EA_MODE が off なら何もしない。記録のみモード', async () => {
  const t = setup();
  assert.equal((await t.send(HIRE, { groupId: DEPT_G })).sent.length, 0);
  assert.equal((await t.send(HIRE, { groupId: null })).sent.length, 0);
  assert.equal((await t.send('おはようございます')).sent.length, 0);
  assert.equal(t.reqs().length, 0);
  t.B.scriptProps.setProperty('EA_MODE', 'off');
  assert.equal((await t.send(HIRE)).sent.length, 0);
  t.B.scriptProps.setProperty('EA_MODE', 'record');
  assert.equal((await t.send(HIRE)).sent.length, 0);
  assert.equal(t.reqs().length, 0);
  assert.equal(t.sheet('社員管理_操作ログ').dump().at(-1)[1], '記録のみ');
});

test('グループ参加：社員管理AI用LINEを招待すると、グループIDを操作ログに記録する', async () => {
  const t = setup();
  const n = t.B.fetches.length;
  const raw = JSON.stringify({ destination: 'Ubot', events: [{ type: 'join', webhookEventId: 'J1', replyToken: 'rj', source: { type: 'group', groupId: ADMIN_G_B } }] });
  assert.equal(await t.viaWorker(raw), 200);
  assert.match(t.sheet('社員管理_操作ログ').dump().at(-1)[7], /勤怠管理グループとして設定済み/);
  assert.match(t.B.fetches.slice(n)[0].body.messages[0].text, /社員管理AIです/);
});

test('既存（A）への影響なし：同じグループの社員管理のメッセージに既存の公式LINEは反応せず、社員番号登録・部門登録・ToT中継はそのまま', async () => {
  const t = setup();
  const before = JSON.stringify(t.master());
  const nA = t.A.fetches.length;
  for (const text of ['入社', HIRE, '承認 EA-20261110-001 123456', '【取消】\n申請番号：EA-20261110-001']) t.postA({ events: [t.ev(text, { groupId: ADMIN_G_A })] });
  assert.equal(t.A.fetches.length, nA);
  assert.equal(JSON.stringify(t.master()), before);
  assert.equal(t.reqs().length, 0);
  t.postA({ events: [t.ev('90002', { groupId: null, userId: U(4) })] });
  assert.equal(t.master()[2][5], U(4));
  t.postA({ events: [t.ev('部門登録 部署B', { groupId: DEPT_G })] });
  assert.equal(t.sheet('LINEグループ').dump()[2][1], '部署B');
  assert.equal(t.postA({ type: 'tot-raw', secret: 'x' }), 'NG');
  // 社員管理の転送形式を A に送っても、A は社員管理を持たないので何もしない
  t.postA(signForward(FWD, { events: [t.ev(HIRE, { groupId: ADMIN_G_A })] }, Math.floor(t.A.clock.now / 1000)));
  assert.equal(t.reqs().length, 0);
});

test('既存のコード（gas/AlcoholCheck.gs）は main から変更していない／専用プロジェクトの複製は既存と一字一句同じ', () => {
  const src = readFileSync(new URL('../gas/AlcoholCheck.gs', import.meta.url), 'utf8');
  const host = readFileSync(new URL('../gas/EmployeeAdminHost.gs', import.meta.url), 'utf8');
  assert.match(src, /var AC_CODE_VERSION = '2026-10-22a';/);
  assert.ok(!/EA_|line-verified/.test(src));
  const copied = host.slice(host.indexOf('// ---- 既存と同じ定義'));
  const blocks = copied.slice(copied.indexOf('\n') + 1).split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  assert.ok(blocks.length >= 7);
  for (const b of blocks) assert.ok(src.includes(b), `既存と違う：${b.slice(0, 40)}`);
});

test('テスト用プロジェクトの検査（gas/test/EmployeeAdminTest.gs）が模擬環境で全件成功し、LINEへの通信は無い', () => {
  const g = createGas({ files: ['EmployeeAdmin.gs', 'EmployeeAdminHost.gs', 'test/EmployeeAdminTest.gs'], now: '2026-11-10T10:00:00+09:00' });
  g.ctx.eatSetup();
  const r = g.ctx.eatRun();
  assert.equal(r.fail, 0, g.logs.filter((l) => l.startsWith('FAIL')).join('\n'));
  assert.ok(r.total >= 30);
  assert.equal(g.fetches.length, 0);
});

test('テスト用プロジェクトの検査は、LINEのトークンがある・本番の従業員マスタなら中止する', () => {
  const g = createGas({ files: ['EmployeeAdmin.gs', 'EmployeeAdminHost.gs', 'test/EmployeeAdminTest.gs'], now: '2026-11-10T10:00:00+09:00' });
  g.scriptProps.setProperty('EA_LINE_CHANNEL_TOKEN', 'x');
  assert.throws(() => g.ctx.eatSetup(), /中止/);
  g.scriptProps.deleteProperty('EA_LINE_CHANNEL_TOKEN');
  g.scriptProps.setProperty('EMPLOYEE_MASTER_ID', '1a8gBGm-adBHybREOOSLEjL9j4OHVwA0X_EdylHIZODU');
  assert.throws(() => g.ctx.eatRun(), /中止/);
});
