import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 管理本部の本人への「未申請の打刻漏れ」のお知らせ（すべて架空データ）
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

const EMP = [501, 502, 503, 504, 508, 509].map((c) => ({ key: 'k' + c, code: String(c) }));
const W = (key, date, isError) => ({ date, employeeKey: key, isError, overtime: 0, totalWork: 480 });
const day = (date, list) => ({ date, dailyWorkings: list });
// 架空の勤務：一郎 10/22・10/24・10/25 がエラー、10/19（8日前）もエラー、今日10/27（対象外）
const WORK = [
  day('2026-10-19', [W('k501', '2026-10-19', true)]),
  day('2026-10-22', [W('k501', '2026-10-22', true), W('k502', '2026-10-22', true)]),
  day('2026-10-24', [W('k501', '2026-10-24', true), W('k503', '2026-10-24', true), W('k504', '2026-10-24', true)]),
  day('2026-10-25', [W('k501', '2026-10-25', true), W('k502', '2026-10-25', false), W('k508', '2026-10-25', true)]),
  day('2026-10-27', [W('k502', '2026-10-27', true)]),
];
const RQ = (key, date, status, type = 'timerecords') => ({ type, date, requestedDate: '2026-10-26', employeeKey: key, requestKey: key + date + status, status });
// 一郎 10/24：承認待ちの打刻申請／二郎 10/22：承認済み／一郎 10/25：差し戻し（＝まだ直っていないので知らせる）／一郎 10/22：残業申請（打刻申請ではない）
const REQS = [RQ('k501', '2026-10-24', 'applying'), RQ('k502', '2026-10-22', 'approved'), RQ('k501', '2026-10-25', 'rejected'), RQ('k501', '2026-10-22', 'applying', 'overtimes')];
const RES = { employees: EMP, workings: WORK, requests: REQS };

function putLatest(g, results, today = '2026-10-27', at = '2026-10-27T07:05:30+09:00') {
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today, fetchedAt: at, results }), updated: new Date(at).getTime() };
}
function hourly(g) {
  const n = g.fetches.length;
  g.ctx.alcoholCheckImportTot();
  return g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
}

test('打刻漏れ：エラー勤務のうち、同じ日に承認待ち・承認済みの打刻申請がある日を除く（7日前まで・今日は除く）', () => {
  const { g } = setup();
  const list = JSON.parse(JSON.stringify(g.ctx.AC_unrequestedPunchErrors(RES, '2026-10-27')));
  assert.deepEqual(list.map((p) => p.tot + ':' + p.date),
    ['501:2026-10-22', '503:2026-10-24', '504:2026-10-24', '501:2026-10-25', '508:2026-10-25']);
});

test('打刻漏れ：管理本部・在籍・LINE確認済みの本人だけ、本人の日付だけ（他部署・LINE未確認・TOTコード重複は入らない）', () => {
  const { g, m } = setup();
  const list = JSON.parse(JSON.stringify(g.ctx.AC_punchSelfNotices(RES, m.dump(), '2026-10-27')));
  assert.deepEqual(list.map((x) => [x.code, x.dates]), [['90001', ['2026-10-22', '2026-10-25']]]);
  assert.equal(list[0].userId, U(1));
  const one = g.ctx.AC_punchSelfMessage(['2026-10-22'], null, {}, '2026-10-27');
  assert.match(one, /10\/22（木）の勤怠について、打刻が確認できていません/);
  const two = g.ctx.AC_punchSelfMessage(['2026-10-22', '2026-10-25'], null, {}, '2026-10-27');
  assert.match(two, /10\/22（木）、10\/25（日）の勤怠について/);
  assert.ok(!/二郎|三郎|四郎/.test(two));
});

test('打刻漏れ：未設定なら何もしない／record は送らずに「打刻漏れ本人通知」シートへ記録。管理者や他の通知は送らない', () => {
  const { g, ss } = setup({ DRY_RUN: 'false' });
  putLatest(g, RES);
  assert.equal(hourly(g).length, 0);
  assert.equal(ss.getSheetByName('打刻漏れ本人通知'), null);
  const { g: g2, ss: ss2 } = setup({ DRY_RUN: 'false', PUNCH_SELF_NOTIFY: 'record' });
  putLatest(g2, RES);
  assert.equal(hourly(g2).length, 0);
  const rec = ss2.getSheetByName('打刻漏れ本人通知').dump();
  assert.deepEqual(rec.slice(1).map((r) => [r[1], r[3], r[5]]), [['90001', '2026-10-22、2026-10-25', '記録のみ（送信しない）']]);
  assert.match(rec[1][4], /10\/22（木）、10\/25（日）/);
  assert.equal(ss2.getSheetByName('承認待ち本人通知'), null);   // 承認待ちの設定は未設定のまま
});

test('打刻漏れ：on で本人へ1通。同じ日の打刻漏れは次の日に繰り返さない。夜の既存通知で送った日・お知らせ停止の日は除く。DRY_RUN が false でなければ送らない', () => {
  const { g, ss, pz } = setup({ DRY_RUN: 'false', PUNCH_SELF_NOTIFY: 'on' });
  putLatest(g, RES);
  const p1 = hourly(g);
  assert.deepEqual(p1.map((f) => f.body.to), [U(1)]);
  assert.match(p1[0].body.messages[0].text, /10\/22（木）、10\/25（日）/);
  // 翌日：10/26 に新しいエラー、10/22・10/25 は申請がまだ（＝知らせ済みなので繰り返さない）
  g.clock.now = new Date('2026-10-28T07:10:00+09:00').getTime();
  const WORK2 = [...WORK, day('2026-10-26', [W('k501', '2026-10-26', true)])];
  putLatest(g, { ...RES, workings: WORK2 }, '2026-10-28', '2026-10-28T07:05:30+09:00');
  const p2 = hourly(g);
  assert.deepEqual(p2.map((f) => f.body.to), [U(1), U(2)]);   // 一郎：新しい10/26だけ／二郎：前日まで「今日」だった10/27
  assert.match(p2[0].body.messages[0].text, /10\/26（月）の勤怠について/);
  assert.match(p2[1].body.messages[0].text, /10\/27（火）の勤怠について/);
  assert.ok(!/10\/22|10\/25/.test(p2[0].body.messages[0].text));
  // 3日目：新しい日が無ければ送らない（記録は「送らない」）
  g.clock.now = new Date('2026-10-29T07:10:00+09:00').getTime();
  putLatest(g, { ...RES, workings: WORK2 }, '2026-10-29', '2026-10-29T07:05:30+09:00');
  assert.equal(hourly(g).length, 0);
  const rec = ss.getSheetByName('打刻漏れ本人通知').dump().slice(1).map((r) => r[5]);
  assert.deepEqual(rec.slice(0, 3), ['送信', '送信', '送信']);
  assert.equal(rec.length, 5);
  rec.slice(3).forEach((r) => assert.match(r, /^送らない（.*お知らせ済み/));

  const { g: g3 } = setup({ DRY_RUN: 'false', PUNCH_SELF_NOTIFY: 'on' });
  g3.userProps.setProperty('att:2026-10-22:punch:501', 'x');                 // 夜の既存の勤怠通知で送った日
  pz3(g3);
  putLatest(g3, RES);
  assert.equal(hourly(g3).length, 0);                                          // 10/22 は送信済み・10/25 は停止期間
  const { g: g4 } = setup({ PUNCH_SELF_NOTIFY: 'on' });                       // DRY_RUN 未設定
  putLatest(g4, RES);
  assert.equal(hourly(g4).length, 0);
});
function pz3(g) {
  const ss = g.ctx.SpreadsheetApp.openById(g.scriptProps.getProperty('EMPLOYEE_MASTER_ID'));
  ss.getSheetByName('お知らせ停止').appendRow(["'90001", '試験 一郎', '2026-10-25', '2026-10-25', '休み', '勤怠のみ']);
}

test('打刻漏れ：勤務データの読み取りエラーがある日は行わない（承認待ちのお知らせも同様）', () => {
  const { g, ss } = setup({ DRY_RUN: 'false', PUNCH_SELF_NOTIFY: 'on', REQUEST_SELF_NOTIFY: 'on' });
  putLatest(g, { ...RES, workings: [...WORK, { _error: 'x' }] });
  assert.equal(hourly(g).length, 0);
  assert.equal(ss.getSheetByName('打刻漏れ本人通知'), null);
});
