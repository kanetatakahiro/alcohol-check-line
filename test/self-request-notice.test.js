import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 管理本部の本人への「承認待ちの申請」のお知らせ（すべて架空データ）
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const row = (code, name, dept, tot, { status = '在籍', userId = U(code.slice(-1)), lineOk = true, retiredOn = '' } = {}) =>
  ["'" + code, name, '', status, dept, userId, '', '', lineOk, true, '', '正社員', tot, retiredOn ? "'" + retiredOn : ''];
const MASTER = [HEAD,
  row('90001', '試験 一郎', '管理本部', 501),
  row('90002', '試験 二郎', '管理本部', 502),
  row('90003', '試験 三郎', '部署A', 503),                       // 他部署
  row('90004', '試験 四郎', '管理本部', 504, { lineOk: false }), // LINE未確認
  row('90005', '試験 五郎', '管理本部', 505, { userId: '' }),    // LINE未登録
  row('90006', '試験 六郎', '管理本部', 506, { status: '退職' }),
  row('90007', '試験 七郎', '管理本部', 507, { retiredOn: '2026-10-01' }), // 退職日が過去
  row('90008', '試験 八郎', '管理本部', 508), row('90009', '試験 九郎', '管理本部', '0508'), // TOTコード重複
];
const P = (tot, type, date) => ({ tot: String(tot), type, date, requestedDate: date });
const PEND = [P(501, '打刻申請', '2026-10-25'), P(502, '残業申請', '2026-10-24'), P(501, 'スケジュール（休暇など）申請', '2026-10-26'),
  P(503, '打刻申請', '2026-10-25'), P(504, '打刻申請', '2026-10-25'), P(505, '打刻申請', '2026-10-25'), P(506, '打刻申請', '2026-10-25'),
  P(507, '打刻申請', '2026-10-25'), P(508, '打刻申請', '2026-10-25'), P('', '打刻申請', '2026-10-25'), P(999, '打刻申請', '2026-10-25')];

function setup(props = {}) {
  const g = createGas({ files: ['AlcoholCheck.gs'], now: '2026-10-27T07:10:00+09:00' });
  const ss = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = ss.insertSheet('従業員マスタ');
  MASTER.forEach((r) => m.appendRow(r));
  const pz = ss.insertSheet('お知らせ停止');
  pz.appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: ss.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: U(7), ...props });
  return { g, ss, m, pz };
}

test('本人宛て：管理本部・在籍・LINE確認済みの本人に、自分の申請だけ。他部署・未登録・退職・照合できない申請は入らない', () => {
  const { g, m } = setup();
  const list = JSON.parse(JSON.stringify(g.ctx.AC_selfRequestNotices(PEND, m.dump(), '2026-10-27')));
  assert.deepEqual(list.map((x) => x.code), ['90001', '90002']);
  assert.equal(list[0].items.length, 2);
  assert.match(list[0].text, /試験 一郎さん、.*2件/);
  assert.match(list[0].text, /打刻申請（2026-10-25分/);
  assert.ok(!/二郎|三郎|残業申請/.test(list[0].text));          // 他人の申請・名前は入らない
  assert.equal(list[1].items.length, 1);
  assert.ok(!/一郎|打刻申請/.test(list[1].text));
  assert.equal(list[0].userId, U(1));
});

const EMP = [501, 502, 503].map((c, i) => ({ key: 'k' + c, code: String(c), lastName: '試験', firstName: String(i) }));
const REQ = [{ type: 'timerecords', date: '2026-10-25', requestedDate: '2026-10-25', employeeKey: 'k501', requestKey: 'r1', status: 'applying' },
  { type: 'overtimes', date: '2026-10-24', requestedDate: '2026-10-24', employeeKey: 'k502', requestKey: 'r2', status: 'applying' },
  { type: 'timerecords', date: '2026-10-25', requestedDate: '2026-10-25', employeeKey: 'k503', requestKey: 'r3', status: 'applying' },
  { type: 'timerecords', date: '2026-10-20', requestedDate: '2026-10-20', employeeKey: 'k501', requestKey: 'r4', status: 'approved' }];

// 朝のTOT受信で保存される tot-latest.json を置く（夜のデータには requests が無い）
function putLatest(g, results, today = '2026-10-27', at = '2026-10-27T07:05:30+09:00') {
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today, fetchedAt: at, results }), updated: new Date(at).getTime() };
}
function hourly(g) {
  const n = g.fetches.length;
  g.ctx.alcoholCheckImportTot();   // 既存の1時間ごとの処理から呼ばれる
  return g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
}

test('本人宛て：未設定なら何もしない。朝のTOT受信（doPost）の処理の中では本人へ送らない（管理者への一覧は今までどおり）', () => {
  const { g, ss } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'on' });
  const n = g.fetches.length;
  g.ctx.AC_adminAttendanceChecks_({ employees: EMP, requests: REQ }, ss.getSheetByName('従業員マスタ').dump(), ss, '2026-10-27', g.scriptProps);
  const pushes = g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
  assert.deepEqual(pushes.map((f) => f.body.to), [U(7)]);
  assert.equal(ss.getSheetByName('承認待ち本人通知'), null);
  const { g: g2, ss: ss2 } = setup({ DRY_RUN: 'false' });   // 設定なし：ファイルも読まない
  putLatest(g2, { employees: EMP, requests: REQ, workings: [] });
  assert.equal(hourly(g2).length, 0);
  assert.equal(ss2.getSheetByName('承認待ち本人通知'), null);
});

test('本人宛て：記録のみ（record）は送らずにシートへ記録（1時間ごとの処理で1日1回）', () => {
  const { g, ss } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'record' });
  putLatest(g, { employees: EMP, requests: REQ, workings: [] });
  assert.equal(hourly(g).length, 0);
  const rec = ss.getSheetByName('承認待ち本人通知').dump();
  assert.deepEqual(rec.slice(1).map((r) => [r[1], r[3], r[5]]), [['90001', 1, '記録のみ（送信しない）'], ['90002', 1, '記録のみ（送信しない）']]);
  g.clock.now += 3600e3; hourly(g);                          // 1時間後：同じ日は繰り返さない
  assert.equal(ss.getSheetByName('承認待ち本人通知').dump().length, 3);
});

test('本人宛て：動かない条件（7時前・12時以降・前日のデータ・夜のデータ（申請なし）・申請データの読み取りエラー）', () => {
  const cases = [
    ['2026-10-27T06:30:00+09:00', () => ({ employees: EMP, requests: REQ, workings: [] }), '2026-10-27'],
    ['2026-10-27T12:10:00+09:00', () => ({ employees: EMP, requests: REQ, workings: [] }), '2026-10-27'],
    ['2026-10-27T07:30:00+09:00', () => ({ employees: EMP, requests: REQ, workings: [] }), '2026-10-26'],
    ['2026-10-27T07:30:00+09:00', () => ({ employees: EMP, workings: [] }), '2026-10-27'],
    ['2026-10-27T07:30:00+09:00', () => ({ employees: EMP, requests: [{ _error: 'x' }], workings: [] }), '2026-10-27'],
  ];
  for (const [now, res, day] of cases) {
    const { g, ss } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'on' });
    g.clock.now = new Date(now).getTime();
    putLatest(g, res(), day, day === '2026-10-26' ? '2026-10-26T22:30:00+09:00' : '2026-10-27T06:00:00+09:00');
    assert.equal(hourly(g).length, 0, now + ' ' + day);
    assert.equal(ss.getSheetByName('承認待ち本人通知'), null);
  }
});

test('本人宛て：on で本人へ1通ずつ。同じ日の2回目は送らない。DRY_RUN が false でなければ送らない。お知らせ停止中は送らない', () => {
  const { g, ss, pz } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'on' });
  pz.appendRow(["'90002", '試験 二郎', '2026-10-27', '2026-10-27', '休み', '全部']);
  putLatest(g, { employees: EMP, requests: REQ, workings: [] });
  const p1 = hourly(g);
  assert.deepEqual(p1.map((f) => f.body.to), [U(1)]);        // 一郎さん本人だけ（二郎さんは停止中。管理者の一覧はここでは送らない）
  assert.ok(!/残業申請/.test(p1[0].body.messages[0].text));
  g.userProps.deleteProperty('selfnotice:2026-10-27');      // 万一もう一度動いても
  assert.equal(hourly(g).length, 0);                          // 同じ日の2回目は本人へも重複しない
  const rec = ss.getSheetByName('承認待ち本人通知').dump().slice(1).map((r) => [r[1], r[5]]);
  assert.deepEqual(rec, [['90001', '送信'], ['90002', 'お知らせ停止中のため送らない'], ['90001', '送信済みのため送らない'], ['90002', 'お知らせ停止中のため送らない']]);
  const { g: g2 } = setup({ REQUEST_SELF_NOTIFY: 'on' });   // DRY_RUN 未設定
  putLatest(g2, { employees: EMP, requests: REQ, workings: [] });
  assert.equal(hourly(g2).length, 0);
});
