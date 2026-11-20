import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 月末の勤怠の締め（gas/MonthClose.gs・版 2026-11-20f）。すべて架空データ・模擬環境（LINEには送らない）
const U = (c) => 'U' + String(c).repeat(32).slice(0, 32);
const ADMIN = 'U' + 'a'.repeat(32);
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'LeaveRequest.gs', 'Notices.gs', 'OfficeTask.gs', 'MonthClose.gs'];
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日', '入社日'];
const row = (code, name, dept, { userId = U(code.slice(-1)) } = {}) =>
  ["'" + code, name, '', '在籍', dept, userId, '', '', true, true, '', '正社員', code.slice(-3), '', ''];
const MASTER = [HEAD, row('90001', '試験 一郎', '法人カーケア'), row('90002', '試験 二郎', '法人カーケア'),
  row('90003', '試験 三郎', '法人カーケア'), row('90004', '試験 四郎', '管理本部'), row('90005', '試験 五郎', '法人カーケア', { userId: '' })];
const EMP = ['001', '002', '003', '004', '005', '006'].map((c) => ({ key: 'k' + c, code: c, lastName: '試験', firstName: c }));
const E = (k, date) => ({ employeeKey: k, date, isError: true, overtime: 0, lateNightOvertime: 0 });
const Q = (k, date, type, status) => ({ type, date, employeeKey: k, requestKey: k + date + type, status, requestedDate: date });
const MON = '2026-11-16';   // 月曜

// 一郎：11/2・11/9（却下）・11/10 が未申請。11/5（打刻申請・申請中）・11/6（スケジュール申請・承認済み）は外す。前月・当日は入らない
// 二郎：全部申請済み／三郎：ATT-02 OFF／四郎：お知らせ停止中／五郎：LINE未登録／006：従業員マスタに無い
function results(extra = {}) {
  return {
    employees: EMP,
    workings: [{ dailyWorkings: [
      E('k001', '2026-10-30'), E('k001', '2026-11-02'), E('k001', '2026-11-05'), E('k001', '2026-11-06'), E('k001', '2026-11-09'),
      E('k001', '2026-11-10'), E('k001', MON), { ...E('k001', '2026-11-11'), isError: false },
      E('k002', '2026-11-03'), E('k002', '2026-11-04'),
      E('k003', '2026-11-11'), E('k004', '2026-11-12'), E('k005', '2026-11-12'), E('k006', '2026-11-12'),
    ] }],
    requests: [
      Q('k001', '2026-11-05', 'timerecords', 'applying'), Q('k001', '2026-11-06', 'schedules', 'approved'),
      Q('k001', '2026-11-09', 'timerecords', 'rejected'), Q('k001', '2026-11-10', 'overtimes', 'approved'),   // 却下・残業申請は外さない
      Q('k002', '2026-11-03', 'timerecords', 'approved'), Q('k002', '2026-11-04', 'schedules', 'applying'),
    ],
    ...extra,
  };
}

function setup(props = {}, now = MON + 'T10:00:00+09:00') {
  const g = createGas({ files: FILES, now });
  const mf = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = mf.insertSheet('従業員マスタ');
  MASTER.forEach((r) => m.appendRow(r));
  mf.insertSheet('お知らせ停止').appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  mf.getSheetByName('お知らせ停止').appendRow(["'90004", '試験 四郎', '2026-11-14', '2026-11-20', '休み', '全部']);
  mf.insertSheet('LINEグループ').appendRow(['グループID', '部門（所属）', '登録日時', '状態']);
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: mf.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN,
    DRY_RUN: 'false', NOTICE_SETTINGS: 'on', ...props });
  g.ctx.alcoholCheckSetupNoticeSettings();
  const sh = mf.getSheetByName('お知らせ設定');
  const v = sh.getDataRange().getValues();
  const col = v[0].findIndex((h) => String(h).startsWith('ATT-02 ')), r = v.findIndex((x) => String(x[0]) === '90003');
  sh.getRange(r + 1, col + 1).setValue(false);
  g.ctx.AC_NS_CACHE = null;
  return { g, mf };
}
const save = (g, today = MON, res = results()) => {
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ type: 'tot-raw', mode: 'morning', today, fetchedAt: today + 'T07:05:05+09:00', results: res }),
    updated: new Date(today + 'T07:05:10+09:00').getTime() };
};
const run = (g) => {
  const n = g.fetches.length;
  const c = g.ctx.alcoholCheckWeeklyPunchReminder();
  return { c, push: g.fetches.slice(n).filter((f) => f.url.endsWith('/push')) };
};
const toSelf = (list) => list.filter((f) => f.body.to !== ADMIN);
const NOTE = '\n\n※このメッセージはAIによる自動送信です。';   // 版 2026-11-16a：本人へ送る文の最後（記録の文面には入らない）
const text = (f) => f.body.messages[0].text;

test('月末の締め: 日にちの判定（前日・月末・1〜2日・3日・4日）', () => {
  const { g } = setup();
  const P = (d) => { const p = g.ctx.MC_phase(d); return [p.kind, p.month]; };
  assert.deepEqual(P('2026-11-29'), ['eve', '2026-11']);
  assert.deepEqual(P('2026-11-30'), ['daily', '2026-11']);
  assert.deepEqual(P('2026-12-01'), ['daily', '2026-11']);
  assert.deepEqual(P('2026-12-02'), ['daily', '2026-11']);
  assert.deepEqual(P('2026-12-03'), ['final', '2026-11']);
  assert.deepEqual(P('2026-12-04'), ['done', '2026-11']);
  assert.deepEqual(P('2026-12-15'), [null, '']);
  assert.deepEqual(P('2027-02-27'), ['eve', '2027-02']);
  assert.deepEqual(P('2027-01-02'), ['daily', '2026-12']);
});

test('月末の締め: 前日は本人へ「締め前の最後のお願い」（同じ月は1回・毎週の催促とは別）', () => {
  const { g } = setup({ MONTH_CLOSE_NOTIFY: 'on' }, '2026-11-29T08:30:00+09:00');
  save(g, '2026-11-29');
  let n = g.fetches.length;
  g.ctx.monthCloseDaily();
  const p = toSelf(g.fetches.slice(n).filter((f) => f.url.endsWith('/push')));
  assert.deepEqual(p.map((f) => f.body.to).sort(), [U(1), U(4)]);                            // 四郎はお知らせ停止（〜11/20）が終わっている
  assert.match(text(p.find((f) => f.body.to === U(1))), /^【今月の締め前の最後のお願いです】\n[\s\S]*11\/2[\s\S]*11\/10/);
  n = g.fetches.length;
  g.ctx.AC_state_().deleteProperty('mclose:2026-11-29');
  g.ctx.monthCloseDaily();                                                                       // 同じ月の2回目は送らない
  assert.equal(toSelf(g.fetches.slice(n).filter((f) => f.url.endsWith('/push'))).length, 0);
});

test('月末の締め: 月末〜2日はまとめ（打刻漏れ・承認待ち・前日から）、3日は最終と上長への連絡、4日は0件なら完了。平日9時のまとめへ', () => {
  const { g } = setup({ MONTH_CLOSE_NOTIFY: 'on', ADMIN_NOTIFY: 'digest' }, '2026-12-01T08:30:00+09:00');
  save(g, '2026-12-01');
  const t1 = g.ctx.monthCloseDaily();
  assert.match(t1, /^【月末の締め】11月分\n\n① 申請していない打刻漏れ：\d+件[\s\S]*試験 一郎：11\/2、11\/9、11\/10、11\/16[\s\S]*② 承認待ちの申請：2件[\s\S]*試験 一郎：打刻申請 1件[\s\S]*試験 二郎：スケジュール（休暇など）申請 1件/);
  assert.ok(!/10\/30/.test(t1));                                                                  // 前の月は入らない
  assert.ok(!/③/.test(t1));
  const items = g.ctx.AC_digestItems_();
  assert.equal(items.length, 1); assert.match(items[0].text, /【月末の締め】11月分/);
  assert.equal(g.ctx.monthCloseDaily(), null);                                                   // 同じ日は1回
  g.clock.now = new Date('2026-12-02T08:30:00+09:00').getTime();
  const r2 = results(); r2.requests.push(Q('k001', '2026-11-02', 'timerecords', 'applying'));     // 一郎が11/2を申請した
  save(g, '2026-12-02', r2);
  const t2 = g.ctx.monthCloseDaily();
  assert.match(t2, /③ 前日から：打刻漏れ \d+件 → \d+件／承認待ち 2件 → 3件/);
  g.clock.now = new Date('2026-12-03T08:30:00+09:00').getTime();
  save(g, '2026-12-03', r2);
  assert.match(g.ctx.monthCloseDaily(), /最終の確認[\s\S]*上長から本人へ申請するよう連絡を/);
  g.clock.now = new Date('2026-12-04T08:30:00+09:00').getTime();
  save(g, '2026-12-04', r2);
  assert.equal(g.ctx.monthCloseDaily(), '');                                                     // 残っていれば完了は出さない
  g.clock.now = new Date('2026-12-07T08:30:00+09:00').getTime();
  save(g, '2026-12-07', r2);
  assert.equal(g.ctx.monthCloseDaily(), null);                                                   // 対象外の日
});

test('月末の締め: 0件なら「完了」・土日祝はまとめを作らない・未設定は何もしない・データが無ければ管理者へ', () => {
  const X = setup().g.ctx;
  const empty = { ok: true, punch: {}, pend: [] };
  assert.match(X.MC_text('done', '2026-11', empty, () => ''), /11月分の締めが完了しました/);
  assert.match(X.MC_text('daily', '2026-11', empty, () => ''), /ありません✨/);
  const s = setup({ MONTH_CLOSE_NOTIFY: 'on' }, '2026-11-30T08:30:00+09:00');
  assert.equal(s.g.ctx.monthCloseDaily(), null);                                                 // 今朝のデータが無い
  const off = setup({}, '2026-12-01T08:30:00+09:00'); save(off.g, '2026-12-01');
  assert.equal(off.g.ctx.monthCloseDaily(), null);
  const sat = setup({ MONTH_CLOSE_NOTIFY: 'on' }, '2027-01-02T08:30:00+09:00'); save(sat.g, '2027-01-02');   // 土曜
  assert.equal(sat.g.ctx.monthCloseDaily(), null);
});
