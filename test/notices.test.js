import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// REBIRTH全社通知管理 Ver.1（gas/Notices.gs）。すべて架空データ・模擬環境（LINEには送らない）
const U = (c) => 'U' + String(c).repeat(32).slice(0, 32);
const ADMIN = 'U' + 'a'.repeat(32);
const GROUP = 'C' + 'b'.repeat(32);
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'LeaveRequest.gs', 'Notices.gs'];
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日', '入社日'];
const row = (code, name, dept, { status = '在籍', alcohol = true, retiredOn = '', userId = U(code.slice(-1)) } = {}) =>
  ["'" + code, name, '', status, dept, userId, '', '', true, alcohol, '', '正社員', code.slice(-3), retiredOn ? "'" + retiredOn : '', ''];
const MASTER = [HEAD,
  row('90001', '試験 一郎', '法人カーケア'),
  row('90002', '試験 二郎', '法人カーケア'),
  row('90003', '試験 三郎', 'リスタイル川口'),
  row('90004', '試験 四郎', '管理本部', { alcohol: false }),
  row('90005', '試験 五郎', '法人カーケア', { status: '退職' }),
];
const NAMES = ['試験 一郎', '試験 二郎', '試験 三郎'];   // シフト表で今日「出勤」の人

function setup({ props = {}, now = '2026-11-10T08:30:00+09:00', group = true, files = FILES } = {}) {
  const g = createGas({ files, now });
  const mf = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = mf.insertSheet('従業員マスタ');
  MASTER.forEach((r) => m.appendRow(r));
  mf.insertSheet('お知らせ停止').appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  const gs = mf.insertSheet('LINEグループ');
  gs.appendRow(['グループID', '部門（所属）', '登録日時', '状態']);
  if (group) gs.appendRow([GROUP, '勤怠管理', '2026-10-20', '有効']);
  // 管理シート（シフト表・アルコールチェックの回答・機器の在庫）
  const ms = g.newSpreadsheet('【テスト】管理シート（架空）');
  g.sheets[g.ctx.AC_SPREADSHEET_ID] = ms;
  const sv = ms.insertSheet('2026-2028');
  sv.appendRow(['シフト表（架空）', '', '', '']);
  sv.appendRow(['', '', '', '2026-11-10']);
  NAMES.forEach((n) => sv.appendRow(['', n, 'シフト', '出勤']));
  const fv = ms.insertSheet('フォームの回答 1');
  fv.appendRow(['タイムスタンプ', '氏名', '区分', '測定結果']);
  const inv = ms.insertSheet('アルコールチェッカー在庫');
  inv.appendRow(['従業員コード', '機器所持']);
  ['90001', '90002', '90003'].forEach((c) => inv.appendRow(["'" + c, true]));
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: mf.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN,
    DRY_RUN: 'false', NOTIFY_EMPLOYEES: 'true', NOTIFY_ADMIN: 'false', REQUIRE_DEVICE: 'true', ...props });
  return { g, mf, m, fv, gs };
}
const pushes = (g, from = 0) => g.fetches.slice(from).filter((f) => f.url.endsWith('/push'));
const tos = (list) => list.map((f) => f.body.to);
const answer = (g, fv, name, label, result, hm = '08:00') => fv.appendRow([new g.FakeDate(`2026-11-10T${hm}:00+09:00`), name, label, result]);
const sheetRows = (mf, name) => { const sh = mf.getSheetByName(name); return sh ? sh.getDataRange().getValues() : []; };
const setCell = (mf, code, id, value) => {
  const sh = mf.getSheetByName('お知らせ設定'), v = sh.getDataRange().getValues();
  const col = v[0].findIndex((h) => String(h).startsWith(id + ' ')), r = v.findIndex((x) => String(x[0]) === code);
  sh.getRange(r + 1, col + 1).setValue(value);
};

// ---------- 34項目 ----------
test('通知：35項目（版 2026-11-13d で ATT-11 を末尾に追加）がすべて登録され、IDが重ならない（勤怠11・申請労務11・安全5・社内連絡8）', () => {
  const { g } = setup();
  const list = [...g.ctx.AC_NOTICES];
  assert.equal(list.length, 35);
  assert.equal(new Set(list.map((n) => n.id)).size, 35);
  assert.equal(list.at(-1).id, 'ATT-11');
  const by = (c) => list.filter((n) => n.cat === c).length;
  assert.deepEqual([by('勤怠・シフト'), by('申請・労務'), by('車両・資格・安全'), by('社内連絡・その他')], [11, 11, 5, 8]);
  assert.deepEqual(list.filter((n) => n.status === '作らない').map((n) => n.id), ['ATT-07', 'ATT-08']);
  assert.ok(list.every((n) => n.status !== '未実装' || !n.impl));
  assert.equal(g.ctx.AC_noticeIdOf('ATT-01 希望休の案内'), 'ATT-01');
  assert.equal(g.ctx.AC_noticeIdOf('CRIT-01 飲酒検知'), null);   // 重要な通知は設定の列にならない
});

test('通知：準備の関数で5つのシートができ、従業員マスタ（A〜O列）と既存のシートは変わらない', () => {
  const { g, mf, m } = setup();
  const before = JSON.stringify(m.dump()), others = ['お知らせ停止', 'LINEグループ'].map((n) => JSON.stringify(sheetRows(mf, n)));
  g.ctx.alcoholCheckSetupNoticeSettings();
  g.ctx.alcoholCheckSetupNoticeSettings();   // 2回目でも重複しない
  assert.equal(JSON.stringify(m.dump()), before);
  assert.deepEqual(['お知らせ停止', 'LINEグループ'].map((n) => JSON.stringify(sheetRows(mf, n))), others);
  for (const n of ['お知らせ設定', '所属別お知らせ設定', 'お知らせ種類', 'お知らせ設定履歴', '通知送信履歴']) assert.ok(mf.getSheetByName(n), n);
  const s = sheetRows(mf, 'お知らせ設定');
  assert.equal(s[0].length, 4 + 35);
  assert.deepEqual(s[0].slice(0, 5), ['社員番号', '氏名', '所属', '状態', 'ATT-01 希望休の案内']);
  assert.deepEqual(s.slice(1).map((r) => String(r[0])), ['90001', '90002', '90003', '90004']);   // 退職した人の行は作らない
  assert.ok(s.slice(1).every((r) => r.slice(4).every((v) => v === true || v === false)));   // すべてチェックボックス
  const t = sheetRows(mf, 'お知らせ種類');
  assert.equal(t.length, 1 + 35 + 4);
  assert.ok(t.some((r) => r[0] === 'CRIT-01' && /止められない/.test(r[5])));
  const d = sheetRows(mf, '所属別お知らせ設定');
  assert.deepEqual(d.map((r) => r[0]), ['所属', '法人カーケア', 'リスタイル川口', '管理本部', '（その他の所属）']);
});

test('通知：所属の初期値（希望休はリスタイルOFF・法人カーケアON、打刻漏れ・申請の確認・残業の警告は両方ON、有給の2項目はOFF）', () => {
  const { g } = setup();
  const dd = (id, dept) => g.ctx.AC_noticeDeptDefault(id, dept);
  assert.deepEqual(['ATT-01', 'ATT-02', 'HR-01', 'HR-02'].map((id) => [dd(id, '法人カーケア'), dd(id, 'リスタイル川口')]),
    [[true, false], [true, true], [true, true], [true, true]]);
  assert.deepEqual([dd('ATT-03', '管理本部'), dd('ATT-04', 'リスタイル'), dd('HR-04', '管理本部')], [true, true, true]);   // 今の動きを引き継ぐ
  assert.deepEqual([dd('ATT-07', '法人カーケア'), dd('ATT-08', '法人カーケア'), dd('GEN-01', '法人カーケア')], [false, false, false]);
});

test('通知：個人の設定は1人・1項目ずつ独立して変えられる（個人 → 所属別 → その他の所属 → 初期値の順）', () => {
  const { g, mf } = setup();
  g.ctx.alcoholCheckSetupNoticeSettings();
  setCell(mf, '90001', 'ATT-03', false);
  const idx = () => g.ctx.AC_noticeIndex(sheetRows(mf, 'お知らせ設定'), sheetRows(mf, '所属別お知らせ設定'), sheetRows(mf, '従業員マスタ'));
  const e = (id, code) => g.ctx.AC_noticeEffective(idx(), id, code);
  assert.deepEqual([e('ATT-03', '90001'), e('ATT-04', '90001'), e('ATT-03', '90002')], [false, true, true]);
  // 個人の行が無い人（新しく入った人など）は所属別の値
  const i2 = g.ctx.AC_noticeIndex(null, sheetRows(mf, '所属別お知らせ設定'), [HEAD, row('90009', '試験 九郎', 'リスタイル川口'), row('90010', '試験 十郎', '新しい部署')]);
  assert.deepEqual([g.ctx.AC_noticeEffective(i2, 'ATT-01', '90009'), g.ctx.AC_noticeEffective(i2, 'ATT-01', '90010')], [false, true]);
});

test('通知：希望休の除外の社員番号は、最初に作るときだけ ATT-01 の OFF として引き継ぐ', () => {
  const { g, mf } = setup({ props: { LEAVE_REQUEST_EXCLUDE_CODES: '90002' } });
  g.ctx.alcoholCheckSetupNoticeSettings();
  const s = sheetRows(mf, 'お知らせ設定');
  assert.deepEqual(s.slice(1).map((r) => r[4]), [true, false, false, true]);   // 一郎ON・二郎OFF（除外）・三郎OFF（リスタイル）・四郎ON
  assert.ok(sheetRows(mf, 'お知らせ設定履歴').some((r) => String(r[1]) === '90002' && /除外の社員番号から引き継ぎ/.test(r[3])));
});

test('通知：入社・退職・所属変更の反映（keep は個人の設定を引き継ぐ／reset は新しい所属の初期値）と履歴', () => {
  const { g } = setup();
  const plan = (master, settings, opt) => JSON.parse(JSON.stringify(g.ctx.AC_noticeSyncPlan(master, settings, '2026-11-10', opt)));
  const first = plan(MASTER, null, {});
  const settings = [first.header, ...first.add];
  settings[1][4 + 1] = false;   // 一郎の ATT-02 を OFF に
  const moved = [HEAD, row('90001', '試験 一郎', 'リスタイル川口'), row('90002', '試験 二郎', '法人カーケア', { retiredOn: '2026-11-01' }),
    row('90003', '試験 三郎', 'リスタイル川口'), row('90004', '試験 四郎', '管理本部'), row('90006', '試験 六郎', '法人カーケア')];
  const keep = plan(moved, settings, { deptChange: 'keep' });
  assert.deepEqual(keep.add.map((r) => r[0]), ["'90006"]);
  assert.deepEqual(keep.updates.map((u) => [u.index, Object.keys(u.cells)]), [[1, ['2']], [2, ['3']]]);   // 一郎は所属だけ、二郎は状態だけ
  assert.deepEqual(keep.history.map((h) => h[2]), ['所属変更（個人の設定を引き継いだ）', '退職', '追加（所属の初期値）']);
  const reset = plan(moved, settings, { deptChange: 'reset' });
  const cells = reset.updates[0].cells;
  assert.equal(cells[4], false);   // ATT-01 はリスタイルの初期値（OFF）
  assert.equal(cells[5], true);    // ATT-02 は OFF だったが初期値（ON）に戻す
});

// ---------- アルコールチェックの案内（ATT-03・ATT-04） ----------
function runKind(g, fn, at) {
  g.clock.now = new Date(at).getTime();
  const n = g.fetches.length;
  g.ctx[fn]();
  return pushes(g, n);
}

test('通知：お知らせ設定が未設定なら、アルコールチェックの送り先・回数は Notices.gs が無いときと同じ', () => {
  const run = (files) => {
    const { g, fv } = setup({ files });
    answer(g, fv, '試験 一郎', '出勤前', '0.00');
    return ['alcoholCheckMorning@2026-11-10T08:30:00+09:00', 'alcoholCheckBeforeWork@2026-11-10T10:00:00+09:00', 'alcoholCheckEvening@2026-11-10T18:30:00+09:00',
      'alcoholCheckAfterWork@2026-11-10T20:00:00+09:00'].map((x) => { const [fn, at] = x.split('@'); return tos(runKind(g, fn, at)); });
  };
  const withNotices = run(FILES), without = run(['AlcoholCheck.gs', 'Inquiry.gs', 'LeaveRequest.gs']);
  assert.deepEqual(withNotices, without);
  assert.deepEqual(withNotices, [[U(1), U(2), U(3)], [U(2), U(3)], [U(1), U(2), U(3)], [U(1), U(2), U(3)]]);   // 10:00 は未入力の人だけ
});

test('通知：ATT-03 を OFF にすると朝の案内だけ止まり、退勤の案内・未入力の催促は届く（NOTICE_ALCOHOL_SCOPE 未設定＝guide）', () => {
  const { g, mf } = setup({ props: { NOTICE_SETTINGS: 'on' } });
  g.ctx.alcoholCheckSetupNoticeSettings();
  setCell(mf, '90001', 'ATT-03', false);
  setCell(mf, '90002', 'ATT-04', false);
  assert.deepEqual(tos(runKind(g, 'alcoholCheckMorning', '2026-11-10T08:30:00+09:00')), [U(2), U(3)]);
  assert.deepEqual(tos(runKind(g, 'alcoholCheckBeforeWork', '2026-11-10T10:00:00+09:00')), [U(1), U(2), U(3)]);   // 催促は止めない
  assert.deepEqual(tos(runKind(g, 'alcoholCheckEvening', '2026-11-10T18:30:00+09:00')), [U(1), U(3)]);
  assert.deepEqual(tos(runKind(g, 'alcoholCheckAfterWork', '2026-11-10T20:00:00+09:00')), [U(1), U(2), U(3)]);
  assert.ok(sheetRows(mf, '通知送信履歴').some((r) => r[1] === 'ATT-03' && String(r[4]) === '90001' && /送らない/.test(r[6])));
});

test('通知：NOTICE_ALCOHOL_SCOPE=guideAndFollow なら未入力の催促も止まる。record は記録だけで送る', () => {
  const { g, mf } = setup({ props: { NOTICE_SETTINGS: 'on', NOTICE_ALCOHOL_SCOPE: 'guideAndFollow' } });
  g.ctx.alcoholCheckSetupNoticeSettings();
  setCell(mf, '90001', 'ATT-03', false);
  assert.deepEqual(tos(runKind(g, 'alcoholCheckBeforeWork', '2026-11-10T10:00:00+09:00')), [U(2), U(3)]);
  const r = setup({ props: { NOTICE_SETTINGS: 'record' } });
  r.g.ctx.alcoholCheckSetupNoticeSettings();
  setCell(r.mf, '90001', 'ATT-03', false);
  assert.deepEqual(tos(runKind(r.g, 'alcoholCheckMorning', '2026-11-10T08:30:00+09:00')), [U(1), U(2), U(3)]);
  assert.ok(sheetRows(r.mf, '通知送信履歴').some((x) => x[1] === 'ATT-03' && /記録のみ/.test(x[6])));
});

test('通知：案内を OFF にしても、飲酒検知（2か所）・回答の記録・J列の対象者判定は変わらない', () => {
  const { g, mf, fv } = setup({ props: { NOTICE_SETTINGS: 'on' }, now: '2026-11-10T08:40:00+09:00' });
  g.ctx.alcoholCheckSetupNoticeSettings();
  for (const c of ['90001', '90002', '90003']) { setCell(mf, c, 'ATT-03', false); setCell(mf, c, 'ATT-04', false); }
  answer(g, fv, '試験 一郎', '出勤前', '0.25', '08:35');
  const n = g.fetches.length;
  g.ctx.alcoholCheckAlerts();
  assert.deepEqual(tos(pushes(g, n)), [ADMIN, GROUP]);
  assert.equal(sheetRows(g.sheets[g.ctx.AC_SPREADSHEET_ID] && mf, '従業員マスタ').length, MASTER.length);
  const reg = JSON.parse(JSON.stringify(g.ctx.AC_buildRegistry(sheetRows(mf, '従業員マスタ'), '2026-11-10')));
  assert.deepEqual(Object.keys(reg).sort(), ['試験一郎', '試験三郎', '試験二郎']);   // 四郎（J列なし）・五郎（退職）は入らない
});

test('通知：未実装・作らない通知は ON にしても送らない', () => {
  const { g, mf } = setup({ props: { NOTICE_SETTINGS: 'on' } });
  g.ctx.alcoholCheckSetupNoticeSettings();
  for (const id of ['ATT-05', 'ATT-07', 'ATT-08', 'HR-03', 'GEN-08']) {
    setCell(mf, '90001', id, true);
    assert.equal(g.ctx.AC_noticeCheck_(id, '90001', '2026-11-10').send, false, id);
  }
  assert.equal(g.ctx.AC_noticeCheck_('ATT-01', '90001', '2026-11-10').send, true);
});

test('通知：希望休の案内はリスタイルの人に標準で送らず、管理者への報告に人数が出る', () => {
  const { g, mf } = setup({ props: { NOTICE_SETTINGS: 'on', LEAVE_REQUEST_NOTIFY: 'on' }, now: '2026-11-10T12:05:00+09:00' });
  g.ctx.alcoholCheckSetupNoticeSettings();
  g.ctx.alcoholCheckLeaveRequestNotice();
  const p = pushes(g);
  assert.deepEqual(tos(p).filter((t) => t !== ADMIN), [U(1), U(2), U(4)]);
  assert.match(p.find((f) => f.body.to === ADMIN).body.messages[0].text, /お知らせ設定でOFF 1人/);
  assert.ok(sheetRows(mf, '希望休案内').some((r) => String(r[2]) === '90003' && /お知らせ設定でOFF/.test(r[4])));
});

// ---------- 9-1 飲酒検知 ----------
function alertSetup(opt = {}) {
  const s = setup({ now: '2026-11-10T08:40:00+09:00', ...opt });
  answer(s.g, s.fv, '試験 一郎', '出勤前', '0.25', '08:35');
  return s;
}

test('飲酒検知：勤怠管理グループと管理者の2か所へ1回ずつ。送信先ごとに記録し、同じ検知は二度送らない', () => {
  const { g, mf } = alertSetup();
  g.ctx.alcoholCheckAlerts();
  const p = pushes(g);
  assert.deepEqual(tos(p), [ADMIN, GROUP]);
  assert.match(p[0].body.messages[0].text, /【アルコール検知のお知らせ】[\s\S]*08:35 試験 一郎さん（出勤前）\n測定結果：0.25/);
  assert.equal(p[0].body.messages[0].text, p[1].body.messages[0].text);
  const log = sheetRows(mf, '通知送信履歴').filter((r) => r[1] === 'CRIT-01');
  assert.deepEqual(log.map((r) => [r[3], r[6]]), [['管理者（安全運転管理者）', '送信'], ['勤怠管理グループ', '送信']]);
  const n = g.fetches.length;
  g.clock.now += 10 * 60 * 1000;
  g.ctx.alcoholCheckAlerts();
  g.clock.now = new Date('2026-11-10T10:00:00+09:00').getTime();
  g.ctx.alcoholCheckBeforeWork();   // 各案内の回の確認でも二度送らない
  assert.equal(pushes(g, n).filter((f) => [ADMIN, GROUP].includes(f.body.to)).length, 0);
});

test('飲酒検知：別の回答（別の検知）は止めずに送る', () => {
  const { g, fv } = alertSetup();
  g.ctx.alcoholCheckAlerts();
  answer(g, fv, '試験 二郎', '出勤前', '0.30', '08:45');
  const n = g.fetches.length;
  g.clock.now += 10 * 60 * 1000;
  g.ctx.alcoholCheckAlerts();
  const p = pushes(g, n);
  assert.deepEqual(tos(p), [ADMIN, GROUP]);
  assert.match(p[0].body.messages[0].text, /試験 二郎さん/);
});

test('飲酒検知：片方が失敗しても、もう片方は送る。失敗した送信先だけ次の確認でやり直す（3回まで）', () => {
  const { g, mf } = alertSetup();
  g.line.pushFail.add(GROUP);
  g.ctx.alcoholCheckAlerts();
  assert.deepEqual(tos(pushes(g)), [ADMIN, GROUP]);   // グループは失敗
  let n = g.fetches.length;
  g.clock.now += 10 * 60 * 1000;
  g.ctx.alcoholCheckAlerts();
  assert.deepEqual(tos(pushes(g, n)), [GROUP]);   // 管理者へは二度送らない
  g.line.pushFail.clear();
  n = g.fetches.length;
  g.clock.now += 10 * 60 * 1000;
  g.ctx.alcoholCheckAlerts();
  assert.deepEqual(tos(pushes(g, n)), [GROUP]);
  n = g.fetches.length;
  g.clock.now += 10 * 60 * 1000;
  g.ctx.alcoholCheckAlerts();
  assert.equal(pushes(g, n).length, 0);
  const log = sheetRows(mf, '通知送信履歴').filter((r) => r[1] === 'CRIT-01').map((r) => r[3] + ':' + r[6]);
  assert.deepEqual(log, ['管理者（安全運転管理者）:送信', '勤怠管理グループ:送信失敗（次の確認でやり直す）', '勤怠管理グループ:送信失敗（次の確認でやり直す）', '勤怠管理グループ:送信']);
  // 3回とも失敗したら打ち切る
  const b = alertSetup();
  b.g.line.pushFail.add(GROUP);
  for (let i = 0; i < 5; i++) { b.g.ctx.alcoholCheckAlerts(); b.g.clock.now += 10 * 60 * 1000; }
  assert.equal(pushes(b.g).filter((f) => f.body.to === GROUP).length, 3);
  assert.ok(sheetRows(b.mf, '通知送信履歴').some((r) => /やり直しの上限/.test(r[6])));
});

test('飲酒検知：勤怠管理グループが未登録なら管理者へ送り「送れず」を記録。ALERT_TO_GROUP=false なら管理者だけ', () => {
  const a = alertSetup({ group: false });
  a.g.ctx.alcoholCheckAlerts();
  assert.deepEqual(tos(pushes(a.g)), [ADMIN]);
  assert.ok(sheetRows(a.mf, '通知送信履歴').some((r) => r[3] === '勤怠管理グループ' && r[6] === '送れず'));
  const b = alertSetup({ props: { ALERT_TO_GROUP: 'false' } });
  b.g.ctx.alcoholCheckAlerts();
  assert.deepEqual(tos(pushes(b.g)), [ADMIN]);
});

test('飲酒検知：お知らせ設定を全部 OFF にしても止まらない（重要な通知）。DRY_RUN は今までどおり', () => {
  const { g, mf } = alertSetup({ props: { NOTICE_SETTINGS: 'on' } });
  g.ctx.alcoholCheckSetupNoticeSettings();
  const sh = mf.getSheetByName('お知らせ設定'), v = sh.getDataRange().getValues();
  for (let r = 2; r <= v.length; r++) for (let c = 5; c <= v[0].length; c++) sh.getRange(r, c).setValue(false);
  g.ctx.alcoholCheckAlerts();
  assert.deepEqual(tos(pushes(g)), [ADMIN, GROUP]);
  const d = alertSetup({ props: { DRY_RUN: 'true' } });
  d.g.ctx.alcoholCheckAlerts();
  assert.equal(pushes(d.g).length, 0);
});

test('飲酒検知：以前のコードで送った記録（sent:日付:alert:行）があれば、新しいコードでも送らない', () => {
  const { g } = alertSetup();
  g.userProps.setProperty('sent:2026-11-10:alert:2', '2026-11-10T08:36:00.000Z');
  g.ctx.alcoholCheckAlerts();
  assert.equal(pushes(g).length, 0);
});

// ---------- 9-2 未実施の催促 ----------
test('未実施の催促：本人だけに届き、管理者・勤怠管理グループには一覧を送らない（NOTIFY_ADMIN=false のまま）', () => {
  const { g, fv } = setup({ now: '2026-11-10T10:00:00+09:00' });
  answer(g, fv, '試験 一郎', '出勤前', '0.00');
  g.ctx.alcoholCheckBeforeWork();
  assert.deepEqual(tos(pushes(g)), [U(2), U(3)]);
  assert.match(pushes(g)[0].body.messages[0].text, /まだ入力が確認できていません/);
});

// ---------- 9-3 夜の取り込み ----------
const latest = (g, at, results = { employees: [], workings: [] }, today = '2026-11-10') => {
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today, fetchedAt: at, results }), updated: new Date(at).getTime() };
};

test('夜の取り込み：状態の判定（届いていない・別の日・一部の読み取りエラー・処理のエラー・正常）', () => {
  const { g } = setup();
  const st = (f, n) => ({ ...g.ctx.AC_nightRelayStatus('2026-11-10', f, n) });
  const c = (results, today = '2026-11-10') => JSON.stringify({ today, results });
  assert.equal(st(null).ok, false);
  assert.match(st({ ymd: '2026-11-10', hm: '07:05', content: c({}) }).reason, /今夜の取り込みが届いていません（最後に届いたのは 11\/10 07:05）/);
  assert.match(st({ ymd: '2026-11-09', hm: '22:31', content: c({}) }).reason, /11\/9 22:31/);
  assert.match(st({ ymd: '2026-11-10', hm: '22:31', content: c({}, '2026-11-09') }).reason, /日付が今日ではありません/);
  assert.match(st({ ymd: '2026-11-10', hm: '22:31', content: c({ workings: [{ _error: 'x' }], employees: [] }) }).reason, /一部のデータを読み取れませんでした（workings）/);
  assert.match(st({ ymd: '2026-11-10', hm: '22:31', content: c({ employees: [] }) }, { totprocess: '22:31' }).reason, /処理の途中でエラー/);
  assert.equal(st({ ymd: '2026-11-10', hm: '22:31', content: c({ employees: [] }) }, { totprocess: '07:06' }).ok, true);   // 朝のエラーは見ない
  assert.equal(st({ ymd: '2026-11-10', hm: '22:31', content: c({ employees: [] }) }).ok, true);
});

test('夜の取り込み：22:45より前は何もしない。届いていなければ22:45以降に勤怠管理グループへ1回だけ', () => {
  const { g, mf } = setup({ now: '2026-11-10T22:40:00+09:00' });
  latest(g, '2026-11-10T07:05:30+09:00');
  g.ctx.alcoholCheckNightRelayWatch();
  assert.equal(pushes(g).length, 0);
  g.clock.now = new Date('2026-11-10T22:45:00+09:00').getTime();
  g.ctx.alcoholCheckNightRelayWatch();
  const p = pushes(g);
  assert.deepEqual(tos(p), [GROUP]);
  assert.match(p[0].body.messages[0].text, /^【勤怠の取り込みの確認】今夜22:30のToTの取り込みを確認できませんでした/);
  g.clock.now = new Date('2026-11-10T23:00:00+09:00').getTime();
  g.ctx.alcoholCheckNightRelayWatch();
  assert.equal(pushes(g).length, 1);
  assert.ok(sheetRows(mf, '通知送信履歴').some((r) => r[1] === 'CRIT-02' && r[3] === '勤怠管理グループ' && r[6] === '送信'));
});

test('夜の取り込み：届いていれば送らずに「確認」を記録する。明確なエラー（処理のエラー）は知らせる', () => {
  const a = setup({ now: '2026-11-10T22:50:00+09:00' });
  latest(a.g, '2026-11-10T22:31:00+09:00');
  a.g.ctx.alcoholCheckNightRelayWatch();
  assert.equal(pushes(a.g).length, 0);
  assert.ok(sheetRows(a.mf, '通知送信履歴').some((r) => r[1] === 'CRIT-02' && /取り込みを確認/.test(r[6])));
  const b = setup({ now: '2026-11-10T22:50:00+09:00' });
  latest(b.g, '2026-11-10T22:31:00+09:00');
  b.g.userProps.setProperty('sent:2026-11-10:notice:totprocess', '2026-11-10T13:31:10.000Z');   // 22:31（日本時間）
  b.g.ctx.alcoholCheckNightRelayWatch();
  assert.match(pushes(b.g)[0].body.messages[0].text, /処理の途中でエラー/);
});

test('夜の取り込み：グループが未登録・送れないときは管理者へ。全部送れないときは15分後にやり直す（3回まで）。NIGHT_WATCH=false で停止', () => {
  const a = setup({ now: '2026-11-10T22:46:00+09:00', group: false });
  a.g.ctx.alcoholCheckNightRelayWatch();
  assert.deepEqual(tos(pushes(a.g)), [ADMIN]);
  assert.match(pushes(a.g)[0].body.messages[0].text, /勤怠管理グループへ送れなかったため/);
  const b = setup({ now: '2026-11-10T22:46:00+09:00' });
  b.g.line.pushFail.add(GROUP).add(ADMIN);
  for (let i = 0; i < 4; i++) { b.g.ctx.alcoholCheckNightRelayWatch(); b.g.clock.now += 15 * 60 * 1000; }
  assert.equal(pushes(b.g).length, 6);   // 3回 × 2か所
  const c = setup({ now: '2026-11-10T22:46:00+09:00', props: { NIGHT_WATCH: 'false' } });
  c.g.ctx.alcoholCheckNightRelayWatch();
  assert.equal(pushes(c.g).length, 0);
});

test('夜の取り込み：トリガーは15分ごとに1つ。ほかのトリガーは消さない。設定の表示に新しい項目とトリガーが出る', () => {
  const { g } = setup();
  g.ctx.alcoholCheckSetupLeaveRequestTrigger();
  g.ctx.alcoholCheckSetupNightWatchTrigger();
  g.ctx.alcoholCheckSetupNightWatchTrigger();
  assert.deepEqual(g.triggers.map((t) => t.fn), ['alcoholCheckLeaveRequestNotice', 'alcoholCheckNightRelayWatch']);
  g.ctx.alcoholCheckRemoveNightWatchTrigger();
  assert.deepEqual(g.triggers.map((t) => t.fn), ['alcoholCheckLeaveRequestNotice']);
  const text = [...g.ctx.AC_settingsReport({ NOTICE_SETTINGS: 'record' }, [{ fn: 'alcoholCheckNightRelayWatch', type: '時間主導' }], {})].join('\n');
  assert.match(text, /・NOTICE_SETTINGS：record/);
  assert.match(text, /・ALERT_TO_GROUP：未設定＝飲酒検知を勤怠管理グループにも送る/);
  assert.match(text, /・alcoholCheckNightRelayWatch（時間主導）\n/);
});

test('通知：確認用の関数は人数だけを出し、送らない', () => {
  const { g } = setup();
  g.ctx.alcoholCheckSetupNoticeSettings();
  g.ctx.alcoholCheckNoticeSettingsPreview();
  assert.equal(pushes(g).length, 0);
  const log = g.logs.find((l) => /お知らせ設定（NOTICE_SETTINGS：off）/.test(l));
  assert.match(log, /ATT-01 希望休の案内：ON 3人/);
  assert.match(log, /ATT-07 有給休暇の取得案内：ON 0人（作らない・送らない）/);
  assert.ok(!/試験|9000/.test(log));
});
