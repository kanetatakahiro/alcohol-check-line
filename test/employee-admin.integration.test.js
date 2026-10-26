import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, signForward } from './helpers/gas-mock.js';

// 社員管理AIの結合テスト：本物の AlcoholCheck.gs ＋ EmployeeAdmin.gs を模擬Apps Scriptで動かし、
// 模擬Webhookイベント（VPS中継の署名つき転送）を doPost に入れて、シートとLINE送信（記録のみ）を確かめる。すべて架空データ。

const SECRET = 'test-forward-secret-not-real';
const ADMIN_G = 'C' + 'a'.repeat(32), DEPT_G = 'C' + 'b'.repeat(32);
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const ADMIN1 = U(1), ADMIN2 = U(2), OUTSIDER = U(9), EMP1 = U(3);
const HEAD14 = ['社員番号', '氏名', '別表記（シフト表の書き方が違う場合）', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時',
  'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];

function setup({ mode = 'on', direct = false } = {}) {
  const g = createGas({ files: ['AlcoholCheck.gs', 'EmployeeAdmin.gs'], now: '2026-11-10T10:00:00+09:00' });
  const ss = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = ss.insertSheet('従業員マスタ');
  m.appendRow(HEAD14);
  m.appendRow(["'90001", '試験 一郎', '', '在籍', '部署A', EMP1, '一郎', '', true, true, '', '正社員', 501, '']);
  m.appendRow(["'90002", '試験 二郎', 'しけん二郎', '在籍', '部署B', '', '', '', false, true, '', 'パート', 502, '']);
  m.appendRow(["'90003", '試験 三郎', '', '退職', '部署A', '', '', '', false, false, '', '正社員', 503, "'2026-09-30"]);
  const grp = ss.insertSheet('LINEグループ');
  grp.appendRow(['グループID', '部門（所属）', '登録日時', '状態']);
  grp.appendRow([ADMIN_G, '勤怠管理', new g.FakeDate(), '有効']);
  grp.appendRow([DEPT_G, '部署A', new g.FakeDate(), '有効']);
  const pause = ss.insertSheet('お知らせ停止');
  pause.appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  pause.appendRow(["'90002", '試験 二郎', '2026-11-12', '2026-11-12', '手入力の休み', '全部']);
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: ss.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake-token-for-test',
    LINE_ADMIN_USER_ID: U(7), EA_FORWARD_SECRET: SECRET, EA_MODE: mode, ...(direct ? { EA_DIRECT: 'true' } : {}) });
  g.line.members[ADMIN_G] = { [ADMIN1]: '管理A', [ADMIN2]: '管理B' };
  let seq = 0;
  const ev = (text, { userId = ADMIN1, groupId = ADMIN_G, id } = {}) => ({
    type: 'message', webhookEventId: id || `EV${++seq}`, replyToken: `rt${seq}`, timestamp: g.clock.now,
    source: groupId ? { type: 'group', groupId, ...(userId ? { userId } : {}) } : { type: 'user', userId },
    message: { type: 'text', id: `m${seq}`, text },
  });
  const post = (body) => g.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent();
  /** 署名つき転送で送り、この送信で出たLINEへの返信・送信を返す */
  const send = (text, opt) => {
    const before = g.fetches.length;
    const body = signForward(SECRET, { destination: 'Uxxx', events: [ev(text, opt)] }, Math.floor(g.clock.now / 1000));
    const out = post(body);
    const sent = g.fetches.slice(before).filter((f) => /message\/(reply|push)$/.test(f.url));
    return { out, body, sent, text: sent.map((f) => f.body.messages[0].text).join('\n---\n'), quick: sent[0] && sent[0].body.messages[0].quickReply };
  };
  /** 今の直結経路（LINE→Apps Script、署名なし）で送る。forged:true なら LINE が発行していない返信トークン */
  const sendRaw = (text, opt = {}) => {
    const before = g.fetches.length;
    const e = ev(text, opt);
    if (opt.forged) e.replyToken = 'forged-' + e.replyToken;
    const out = post({ destination: 'Uxxx', events: [e] });
    const sent = g.fetches.slice(before).filter((f) => /message\/(reply|push)$/.test(f.url));
    return { out, event: e, sent, text: sent.map((f) => f.body.messages[0].text).join('\n---\n'), quick: sent[0] && sent[0].body.messages[0].quickReply };
  };
  const sheet = (n) => ss.getSheetByName(n);
  const reqs = () => (sheet('社員管理_申請') ? sheet('社員管理_申請').dump().slice(1) : []);
  const master = () => m.dump();
  const approveText = (r) => r.quick.items[0].action.text;
  return { g, ss, m, ev, post, send, sendRaw, sheet, reqs, master, approveText };
}

const HIRE = '【入社】\n社員番号：90100\n氏名：試験 花子\n入社日：2026-11-15\n所属・拠点：部署A\n社員区分：社員\nTOTコード：600\nシフト表の書き方：はなこ\nアルコールチェック：対象';
const RETIRE = '【退社】\n社員番号：90001\n氏名：試験 一郎\n退職日：2026-11-30\n最終出社日：2026-11-20';

test('結合：EA_MODE が off なら社員管理は動かず、既存の処理だけ（返信なし・申請シートなし）', () => {
  const t = setup({ mode: 'off' });
  const r = t.send(HIRE);
  assert.equal(r.out, 'OK');
  assert.equal(r.sent.length, 0);
  assert.equal(t.sheet('社員管理_申請'), null);
});

test('結合：入社の申請 → 承認 → 入社日に反映 → 完了報告 → 既存のLINE登録・フォーム選択肢でも使える', () => {
  const t = setup();
  const tpl = t.send('入社');
  assert.match(tpl.text, /【入社】/);

  const a = t.send(HIRE);
  assert.match(a.text, /入社の申請を受け付けました（EA-20261110-001）/);
  assert.equal(a.quick.items.length, 2);
  assert.equal(t.reqs()[0][1], '申請中');

  // グループ外の人・違う承認コードは承認できない
  assert.match(t.send(t.approveText(a), { userId: OUTSIDER }).text, /メンバーであることを確認できなかった/);
  assert.match(t.send('承認 EA-20261110-001 000000').text, /承認コードが違います/);
  assert.equal(t.reqs()[0][1], '申請中');

  const b = t.send(t.approveText(a), { userId: ADMIN2 });
  assert.match(b.text, /承認しました。\n2026-11-15 の朝/);
  assert.equal(t.reqs()[0][1], '予約');
  assert.equal(t.reqs()[0][12], '管理B');
  assert.match(t.send(t.approveText(a)).text, /その操作はできません/);   // 承認コードの使い回し不可

  // 入社日前は反映しない。自動反映がオフ（EA_AUTO_APPLY 未設定）なら毎朝の処理でも反映しない
  assert.deepEqual([...t.g.ctx.EA_runDaily_(true)], []);
  t.g.clock.now = new Date('2026-11-15T05:10:00+09:00').getTime();
  t.g.ctx.employeeAdminDaily();
  assert.equal(t.master().length, 4);

  const before = t.g.fetches.length;
  const lines = t.g.ctx.EA_runDaily_(true);
  assert.match(lines[0], /反映しました/);
  const push = t.g.fetches.slice(before).find((f) => f.url.endsWith('/push'));
  assert.equal(push.body.to, ADMIN_G);

  const mv = t.master();
  assert.equal(mv[0][14], '入社日');
  const row = mv[4];
  assert.equal(row[0], '90100');                 // 文字のまま（先頭ゼロも保てる）
  assert.equal(row[1], '試験 花子');
  assert.equal(row[2], 'はなこ');
  assert.equal(row[3], '在籍');
  assert.equal(row[8], false);
  assert.equal(row[9], true);
  assert.equal(row[11], '正社員');
  assert.equal(row[12], '600');
  assert.equal(row[13], '');                     // 退職日は空（退職扱いにならない）
  assert.equal(row[14], '2026-11-15');           // 入社日は文字
  assert.equal(t.reqs()[0][1], '反映済');
  assert.ok(t.sheet('社員管理_変更履歴').dump().length >= 2);
  assert.deepEqual(t.sheet('別表記').dump()[1].slice(0, 2), ['90100', 'はなこ']);

  // 既存の機能から見えること（回帰）
  assert.ok([...t.g.ctx.AC_formChoices(mv)].includes('試験 花子（90100）'));
  assert.equal(t.g.ctx.AC_isRetired(row[13], '2026-11-15'), false);
  // 本人が公式LINEに社員番号を送る（既存の1対1登録・署名つき経路）→ 新しい行にLINE IDが入る
  const newUser = U(5);
  t.send('90100', { groupId: null, userId: newUser });
  assert.equal(t.master()[4][5], newUser);
  assert.equal(t.master().length, 5);

  // 反映済みは取消できない
  assert.match(t.send('【取消】\n申請番号：EA-20261110-001').text, /反映済みの申請は取消できません/);
});

test('結合：退社の申請 → 承認でお知らせ停止を追加 → 取消で元に戻す → 再申請 → 退職日の翌日に退職へ', () => {
  const t = setup();
  const a = t.send(RETIRE);
  assert.match(a.text, /2026-11-21〜2026-11-30 はお知らせを止めます/);
  t.send(t.approveText(a));
  const p = t.sheet('お知らせ停止').dump();
  assert.deepEqual(p[0].slice(6), ['作成元', '管理ID']);
  assert.equal(p.length, 3);
  assert.equal(p[2][0], '90001');
  assert.equal(Object.prototype.toString.call(p[2][2]), '[object Date]');   // 既存の停止処理が読める日付型
  const idx = t.g.ctx.AC_pauseIndex(p, t.g.ctx.AC_toDateFn_());
  assert.equal(t.g.ctx.AC_isPaused(idx, '90001', '2026-11-21', 'alcohol'), true);
  assert.equal(t.g.ctx.AC_isPaused(idx, '90001', '2026-11-20', 'alcohol'), false);

  // 「取消」の一言で、取消できる申請の一覧が出る
  assert.match(t.send('取消').text, /EA-20261110-001（退社・90001・予約）/);
  const c = t.send('【取消】\n申請番号：EA-20261110-001');
  assert.match(c.text, /取り消しました/);
  const p2 = t.sheet('お知らせ停止').dump();
  assert.equal(p2.length, 2);                     // AIが作った行だけ消え、手入力の行は残る
  assert.equal(p2[1][4], '手入力の休み');

  const a2 = t.send(RETIRE.replace('最終出社日：2026-11-20', '最終出社日：'));
  assert.match(a2.text, /EA-20261110-002/);
  t.send(t.approveText(a2));
  assert.equal(t.sheet('お知らせ停止').dump().length, 2);   // 最終出社日＝退職日なら停止行なし

  t.g.clock.now = new Date('2026-11-30T05:10:00+09:00').getTime();
  assert.deepEqual([...t.g.ctx.EA_runDaily_(true)], []);    // 退職日当日はまだ在籍
  t.g.clock.now = new Date('2026-12-01T05:10:00+09:00').getTime();
  assert.match(t.g.ctx.EA_runDaily_(true)[0], /反映しました/);
  const r = t.master()[1];
  assert.equal(r[3], '退職');
  assert.equal(r[13], '2026-11-30');              // 文字（日付型ではない）
  assert.equal(r[5], EMP1);                       // LINE IDなど他の列はそのまま
  assert.equal(Object.keys(t.g.ctx.AC_lineByTotCode(t.master(), '2026-12-01')).length, 0);
  const hist = t.sheet('社員管理_変更履歴').dump();
  assert.deepEqual(hist.slice(1).map((h) => [h[6], h[7], h[8]]), [['在籍状況', '在籍', '退職'], ['退職日', '', '2026-11-30']]);
});

test('結合：入社前にLINE登録した人は、その行に入社情報を書き込む（行を増やさない）', () => {
  const t = setup();
  const u = U(6);
  t.send('90200', { groupId: null, userId: u });    // 既存の1対1登録で仮の行ができる
  assert.equal(t.master().length, 5);
  const a = t.send(HIRE.replace('90100', '90200').replace('TOTコード：600', 'TOTコード：'));
  assert.match(a.text, /先にLINE登録済み/);
  assert.match(a.text, /TOTコードが空/);
  t.send(t.approveText(a));
  t.g.clock.now = new Date('2026-11-15T05:10:00+09:00').getTime();
  t.g.ctx.EA_runDaily_(true);
  const mv = t.master();
  assert.equal(mv.length, 5);
  assert.equal(mv[4][1], '試験 花子');
  assert.equal(mv[4][5], u);
  assert.equal(mv[4][10], '');
  assert.equal(mv[4][14], '2026-11-15');
});

test('結合：入力ミス・期限切れ・二重申請・パソコン版LINE', () => {
  const t = setup();
  const e = t.send('【入社】\n社員番号：90001\n氏名：\n入社日：2026-02-30');
  assert.match(e.text, /受け付けできませんでした/);
  assert.match(e.text, /再利用しません/);
  assert.equal(t.reqs().length, 0);

  const a = t.send(RETIRE);
  const dup = t.send(RETIRE);
  assert.match(dup.text, /同じ社員番号の申請（EA-20261110-001/);

  t.g.clock.now += 73 * 3600 * 1000;
  assert.match(t.send(t.approveText(a)).text, /期限（72時間）を過ぎています/);
  assert.equal(t.reqs()[0][1], '期限切れ');
  const lines = t.g.ctx.EA_runDaily_(false);       // 残りの申請も期限切れにして報告
  assert.match(lines.join(), /EA-20261113-|EA-20261110-002/);
  assert.equal(t.reqs()[1][1], '期限切れ');

  assert.match(t.send(RETIRE, { userId: null }).text, /スマートフォンのLINEから/);
});

test('結合：安全対策（署名違い・再送・同じイベント・署名なしの直結経路・別グループ）', () => {
  const t = setup();
  // 署名が違う転送は処理しない
  const bad = signForward('wrong-secret', { events: [t.ev(HIRE)] }, Math.floor(t.g.clock.now / 1000));
  assert.equal(t.post(bad), 'NG');
  // 古い転送（5分超）は処理しない
  assert.equal(t.post(signForward(SECRET, { events: [t.ev(HIRE)] }, Math.floor(t.g.clock.now / 1000) - 301)), 'NG');
  assert.equal(t.reqs().length, 0);

  const a = t.send(HIRE);
  assert.equal(t.reqs().length, 1);
  assert.equal(t.post(a.body), 'NG');              // 同じ転送の再送（nonce使用済み）
  // 同じLINEイベント（webhookEventId）を別の転送で受けても1回だけ
  const again = signForward(SECRET, { events: [t.ev(HIRE, { id: 'EV-SAME' })] }, Math.floor(t.g.clock.now / 1000));
  const again2 = signForward(SECRET, { events: [t.ev(HIRE, { id: 'EV-SAME' })] }, Math.floor(t.g.clock.now / 1000));
  t.post(again); t.post(again2);
  assert.equal(t.reqs().length, 2);

  // 署名を確かめられない直結の経路（LINE→Apps Script）では、社員管理は一切動かない
  const n = t.g.fetches.length;
  t.post({ destination: 'Uxxx', events: [t.ev(HIRE)] });
  assert.equal(t.reqs().length, 2);
  assert.equal(t.g.fetches.length, n);

  // 勤怠管理以外のグループでは反応しない
  const d = t.send(HIRE, { groupId: DEPT_G });
  assert.equal(d.sent.length, 0);
  assert.equal(t.reqs().length, 2);
});

test('結合（回帰）：署名つき経路でも既存の「部門登録」・普段の会話・TOT中継はそのまま', () => {
  const t = setup();
  const r = t.send('部門登録 部署B', { groupId: DEPT_G });
  assert.match(r.text, /「部署B」のグループとして登録しました/);
  assert.equal(t.sheet('LINEグループ').dump()[2][1], '部署B');
  assert.equal(t.send('おはようございます').sent.length, 0);
  // 署名なしの直結経路の「部門登録」も今までどおり
  t.post({ events: [t.ev('部門登録 部署A', { groupId: DEPT_G })] });
  assert.equal(t.sheet('LINEグループ').dump()[2][1], '部署A');
  // TOT中継（合言葉違い）は社員管理に渡らない
  const keys = Object.keys(t.g.cache).length;
  assert.equal(t.post({ type: 'tot-raw', secret: 'x' }), 'NG');   // 既存の合言葉チェックで止まる
  assert.equal(Object.keys(t.g.cache).length, keys);
});

test('結合：記録のみモードは返信・申請・反映をせず、操作ログだけ残す', () => {
  const t = setup({ mode: 'record' });
  const r = t.send(HIRE);
  assert.equal(r.sent.length, 0);
  assert.equal(t.reqs().length, 0);
  const log = t.sheet('社員管理_操作ログ').dump();
  assert.equal(log[1][1], '記録のみ');
  assert.equal(log[1][3], '90100');
});

test('結合：テスト用プロジェクトの検査（gas/test/EmployeeAdminTest.gs）が模擬環境で全件成功する', () => {
  const g = createGas({ files: ['AlcoholCheck.gs', 'EmployeeAdmin.gs', 'test/EmployeeAdminTest.gs'], now: '2026-11-10T10:00:00+09:00' });
  g.ctx.eatSetup();
  const r = g.ctx.eatRun();
  const fails = g.logs.filter((l) => l.startsWith('FAIL'));
  assert.equal(r.fail, 0, fails.join('\n'));
  assert.ok(r.total >= 39);
  // LINE への実際の通信は一度も起きていない
  assert.equal(g.fetches.length, 0);
});

test('結合：テスト用プロジェクトの検査は、LINEのトークンがある・本番の従業員マスタなら中止する', () => {
  const g = createGas({ files: ['AlcoholCheck.gs', 'EmployeeAdmin.gs', 'test/EmployeeAdminTest.gs'], now: '2026-11-10T10:00:00+09:00' });
  g.scriptProps.setProperty('LINE_CHANNEL_ACCESS_TOKEN', 'x');
  assert.throws(() => g.ctx.eatSetup(), /中止/);
  g.scriptProps.deleteProperty('LINE_CHANNEL_ACCESS_TOKEN');
  g.scriptProps.setProperty('EMPLOYEE_MASTER_ID', '1a8gBGm-adBHybREOOSLEjL9j4OHVwA0X_EdylHIZODU');
  assert.throws(() => g.ctx.eatRun(), /中止/);
});

// ---------- Webhookを切り替えない先行導入方式（直結経路＋返信トークン確認） ----------

test('直結：入社の申請→承認→反映が、Webhookを切り替えずに動く', () => {
  const t = setup({ direct: true });
  assert.match(t.sendRaw('入社').text, /【入社】/);
  const a = t.sendRaw(HIRE);
  assert.match(a.text, /受け付けました（EA-20261110-001）/);
  assert.equal(t.reqs()[0][1], '申請中');
  assert.match(t.sendRaw(t.approveText(a), { userId: OUTSIDER }).text, /メンバーであることを確認できなかった/);
  t.sendRaw(t.approveText(a), { userId: ADMIN2 });
  assert.equal(t.reqs()[0][1], '予約');
  t.g.clock.now = new Date('2026-11-15T05:10:00+09:00').getTime();
  assert.match(t.g.ctx.EA_runDaily_(true)[0], /反映しました/);
  assert.equal(t.master()[4][0], '90100');
  assert.equal(t.master()[4][14], '2026-11-15');
});

test('直結：LINEが発行していない返信トークン（偽のイベント）では、申請・承認・取消を一切記録しない', () => {
  const t = setup({ direct: true });
  const f = t.sendRaw(HIRE, { forged: true });
  assert.equal(t.reqs().length, 0);
  assert.equal(t.sheet('社員管理_操作ログ'), null);
  const a = t.sendRaw(RETIRE);
  // 承認コードを知っていても、偽のイベントでは承認できない
  t.sendRaw(t.approveText(a), { forged: true });
  assert.equal(t.reqs()[0][1], '申請中');
  assert.equal(t.sheet('お知らせ停止').dump().length, 2);
  t.sendRaw(t.approveText(a));
  assert.equal(t.reqs()[0][1], '予約');
  assert.equal(t.sheet('お知らせ停止').dump().length, 3);
  t.sendRaw('【取消】\n申請番号：EA-20261110-001', { forged: true });
  assert.equal(t.reqs()[0][1], '予約');
  assert.equal(t.sheet('お知らせ停止').dump().length, 3);
  assert.match(t.sendRaw('【取消】\n申請番号：EA-20261110-001').text, /取り消しました/);
  assert.equal(t.reqs()[0][1], '取消');
  assert.equal(t.sheet('お知らせ停止').dump().length, 2);
  assert.equal(f.sent.length, 1);               // 返信を試みただけ（LINEが拒否）
});

test('直結：同じイベント（webhookEventId）は1回だけ', () => {
  const t = setup({ direct: true });
  t.post({ events: [t.ev(HIRE, { id: 'SAME' })] });
  t.post({ events: [t.ev(HIRE, { id: 'SAME' })] });
  assert.equal(t.reqs().length, 1);
});

test('直結（回帰）：1対1の社員番号登録・部門登録・普段の会話・別グループ・ToT中継は今までどおり', () => {
  const t = setup({ direct: true });
  t.sendRaw('90002', { groupId: null, userId: U(4) });
  assert.equal(t.master()[2][5], U(4));
  assert.match(t.sendRaw('部門登録 部署B', { groupId: DEPT_G }).text, /「部署B」のグループとして登録しました/);
  assert.equal(t.sendRaw('おはようございます').sent.length, 0);
  assert.equal(t.sendRaw(HIRE, { groupId: DEPT_G }).sent.length, 0);
  assert.equal(t.reqs().length, 0);
  assert.equal(t.post({ type: 'tot-raw', secret: 'x' }), 'NG');
});

test('直結：EA_DIRECT が無い・EA_MODE が off なら、社員管理は動かない', () => {
  const t1 = setup();                         // EA_DIRECT なし
  assert.equal(t1.sendRaw(HIRE).sent.length, 0);
  assert.equal(t1.reqs().length, 0);
  const t2 = setup({ direct: true, mode: 'off' });
  assert.equal(t2.sendRaw(HIRE).sent.length, 0);
  assert.equal(t2.reqs().length, 0);
});

test('直結：1回の受信に社員管理と既存のイベントが混ざっていても、それぞれ処理される', () => {
  const t = setup({ direct: true });
  t.post({ events: [t.ev(HIRE), t.ev('90002', { groupId: null, userId: U(4) }), t.ev('部門登録 部署B', { groupId: DEPT_G })] });
  assert.equal(t.reqs().length, 1);
  assert.equal(t.master()[2][5], U(4));
  assert.equal(t.sheet('LINEグループ').dump()[2][1], '部署B');
});

test('自動反映が有効なら、反映日を過ぎた承認はその場で反映し、グループへ報告する', () => {
  const t = setup({ direct: true });
  t.g.scriptProps.setProperty('EA_AUTO_APPLY', 'true');
  const a = t.sendRaw(RETIRE.replace('退職日：2026-11-30', '退職日：2026-11-09').replace('最終出社日：2026-11-20', '最終出社日：2026-11-06'));
  const b = t.sendRaw(t.approveText(a));
  assert.match(b.text, /このあとすぐ従業員マスタに反映します/);
  assert.match(b.text, /反映しました/);                       // 報告（push）
  assert.equal(t.master()[1][3], '退職');
  assert.equal(t.master()[1][13], '2026-11-09');
  assert.equal(t.reqs()[0][1], '反映済');
  // 入社日が未来なら、その場では反映しない
  const c = t.sendRaw(HIRE);
  assert.match(t.sendRaw(t.approveText(c)).text, /2026-11-15 の朝/);
  assert.equal(t.master().length, 4);
});
