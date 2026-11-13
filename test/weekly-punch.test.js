import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 毎週月曜10:00の本人向けの打刻漏れの催促（版 2026-11-13a）。すべて架空データ・模擬環境（LINEには送らない）
const U = (c) => 'U' + String(c).repeat(32).slice(0, 32);
const ADMIN = 'U' + 'a'.repeat(32);
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'LeaveRequest.gs', 'Notices.gs'];
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
const text = (f) => f.body.messages[0].text;
const logRows = (mf) => { const sh = mf.getSheetByName('通知送信履歴'); return sh ? sh.getDataRange().getValues().slice(1).filter((r) => String(r[2]).includes('毎週月曜')) : []; };

const EXPECT = 'お疲れ様です😊\n今月の打刻のお知らせです。\n\n【申請が確認できていない打刻漏れ】\n・11/2（月）\n・11/9（月）\n・11/10（火）\n'
  + '→ Touch On Timeでご確認いただき、「打刻修正申請」をお願いいたします。\n月末までにご申請いただけますと、月初の勤怠の締めがスムーズになります。\n\nご確認のほどよろしくお願いいたします！';

test('毎週の催促：on で1人1通。申請中・承認済みの日は外し、却下・申請なしの日だけ。前月と当日は入らない／全部申請済み・ATT-02 OFF・停止中・LINE未登録には送らない', () => {
  const { g, mf } = setup({ WEEKLY_PUNCH_NOTIFY: 'on' });
  save(g);
  const { c, push } = run(g);
  assert.deepEqual(push.map((f) => f.body.to), [U(1)]);                       // 管理者へのエラー通知も無し
  assert.equal(text(push[0]), EXPECT);
  assert.deepEqual({ people: c.people, dates: c.dates, sent: c.sent, requested: c.requested, setting: c.setting, paused: c.paused, unreg: c.unreg, noMaster: c.noMaster },
    { people: 1, dates: 3, sent: 1, requested: 4, setting: 1, paused: 1, unreg: 1, noMaster: 1 });
  const rows = logRows(mf);
  const res = (code) => rows.filter((r) => r[4] === code).map((r) => r[1] + ':' + r[6]);
  assert.deepEqual(res('90001'), ['ATT-02:送信']);
  assert.equal(rows.find((r) => r[4] === '90001')[8], EXPECT);                // 文面も記録
  assert.equal(rows.find((r) => r[4] === '90001')[5], 'att:2026-11-16:weeklypunch:1');
  assert.deepEqual(res('90002'), []);                                          // 全部申請済みの人は対象にならない
  assert.deepEqual(res('90003'), ['ATT-02:除外（お知らせ設定でOFF）']);
  assert.deepEqual(res('90004'), ['ATT-02:除外（お知らせ停止中）']);
  assert.deepEqual(res('90005'), ['ATT-02:除外（LINE未登録）']);
  assert.ok(!/試験|9000/.test(text(push[0])));
});

test('毎週の催促：同じ週の2回目は送らない（水曜に手で実行しても）。次の週はまた送る。送信に失敗した人は同じ週に送り直せる', () => {
  const { g } = setup({ WEEKLY_PUNCH_NOTIFY: 'on' });
  save(g);
  assert.equal(toSelf(run(g).push).length, 1);
  assert.equal(toSelf(run(g).push).length, 0);
  g.clock.now = new Date('2026-11-18T10:00:00+09:00').getTime();
  save(g, '2026-11-18');
  const again = run(g);
  assert.equal(toSelf(again.push).length, 0);
  assert.equal(again.c.already, 1);
  g.clock.now = new Date('2026-11-23T10:00:00+09:00').getTime();
  save(g, '2026-11-23');
  assert.deepEqual(toSelf(run(g).push).map((f) => f.body.to), [U(1), U(4)]);   // 四郎さんは停止期間（〜11/20）が終わったので送る

  const s = setup({ WEEKLY_PUNCH_NOTIFY: 'on' }).g;
  save(s);
  s.line.pushFail.add(U(1));
  const f = run(s);
  assert.equal(f.c.failed, 1);
  s.line.pushFail.clear();
  assert.deepEqual(toSelf(run(s).push).map((x) => x.body.to), [U(1)]);
});

test('毎週の催促：申請のデータが無い・読み取りエラー・今朝のデータでないときは誰にも送らず、管理者へエラーを知らせる（1日1回）', () => {
  for (const [res, today, why] of [
    [results({ requests: undefined }), MON, /申請のデータが無い/],
    [results({ requests: [...results().requests, { _error: 403, path: '/requests/schedules/2026-11' }] }), MON, /申請のデータが無い、または読み取りエラー/],
    [results({ workings: [{ _error: 500 }] }), MON, /勤務のデータが無い/],
    [results(), '2026-11-15', /今朝のTOTのデータが届いていない（最後のデータ：2026-11-15）/],
  ]) {
    const { g, mf } = setup({ WEEKLY_PUNCH_NOTIFY: 'on' });
    save(g, today, res);
    const { c, push } = run(g);
    assert.equal(c, null);
    assert.equal(toSelf(push).length, 0);
    assert.equal(push.length, 1);
    assert.equal(push[0].body.to, ADMIN);
    assert.match(text(push[0]), /【エラー】毎週月曜の打刻漏れの催促を送れませんでした/);
    assert.match(text(push[0]), why);
    assert.equal(logRows(mf).length, 0);
    assert.equal(run(g).push.length, 0);                                       // 同じ日の2回目は管理者へも送らない
  }
  const { g } = setup({ WEEKLY_PUNCH_NOTIFY: 'on' });
  assert.equal(run(g).push[0].body.to, ADMIN);                                  // tot-latest.json が無いとき
});

test('毎週の催促：record は送らずに文面ごと記録（同じ週は1回）。未設定は何もしない。DRY_RUN が false でない on も記録だけ', () => {
  const { g, mf } = setup({ WEEKLY_PUNCH_NOTIFY: 'record' });
  save(g);
  assert.equal(run(g).push.length, 0);
  const rec = logRows(mf).filter((r) => r[4] === '90001');
  assert.deepEqual(rec.map((r) => r[6]), ['記録（送信しない）']);
  assert.equal(rec[0][8], EXPECT);
  const n = logRows(mf).length;
  run(g);
  assert.equal(logRows(mf).length, n);

  const u = setup();
  save(u.g);
  assert.equal(run(u.g).c, null);
  assert.equal(u.g.fetches.length, 0);
  assert.equal(logRows(u.mf).length, 0);
  assert.match(u.g.logs.join('\n'), /WEEKLY_PUNCH_NOTIFY が未設定のため何もしません/);

  const d = setup({ WEEKLY_PUNCH_NOTIFY: 'on', DRY_RUN: '' });
  save(d.g);
  assert.equal(run(d.g).push.length, 0);
  assert.deepEqual(logRows(d.mf).filter((r) => r[4] === '90001').map((r) => r[6]), ['記録（DRY_RUN のため送信しない）']);
});

test('毎週の催促：確認用の関数は送らず・記録せず、人数・件数・外した件数と文面の例を出す（氏名・社員番号は出さない）', () => {
  const { g, mf } = setup({ WEEKLY_PUNCH_NOTIFY: 'record' });
  save(g);
  const keys = () => JSON.stringify(Object.keys(g.userProps.getProperties()).filter((k) => k.startsWith('att:')));   // 送った・記録した・除外した、の記録
  const before = keys(), l = g.logs.length;
  const res = g.ctx.alcoholCheckWeeklyPunchPreview();
  assert.equal(g.fetches.length, 0);
  assert.equal(keys(), before);
  assert.equal(logRows(mf).length, 0);
  assert.equal(res.counts.people, 1);
  const log = g.logs.slice(l).join('\n');
  assert.match(log, /送る人数：1人・打刻漏れ 3件/);
  assert.match(log, /申請済み 4件（打刻申請・スケジュール申請が申請中・承認済みの日）／お知らせ設定OFF 1人／LINE未登録 1人／お知らせ停止中 1人／従業員マスタに無い 1人/);
  assert.ok(log.includes(EXPECT));
  assert.ok(!/試験|9000/.test(log));
  save(g, MON, results({ requests: undefined }));
  assert.match((g.ctx.alcoholCheckWeeklyPunchPreview(), g.logs.join('\n')), /送りません：申請のデータが無い/);
});

test('毎週の催促：トリガーは月曜10時台の1本だけ（作り直しても重複しない・ほかのトリガーは消さない）。設定の表示・版・LINE文面シートの上書き', () => {
  const { g } = setup();
  g.ctx.alcoholCheckSetupTriggers();
  const before = g.triggers.length;
  g.ctx.AC_setupWeeklyPunchTrigger();
  g.ctx.AC_setupWeeklyPunchTrigger();
  const w = g.triggers.filter((t) => t.fn === 'alcoholCheckWeeklyPunchReminder');
  assert.equal(w.length, 1);
  assert.equal(w[0].weekDay, 'MONDAY');
  assert.equal(w[0].at, 10);
  assert.equal(g.triggers.length, before + 1);
  g.ctx.AC_removeWeeklyPunchTrigger();
  assert.equal(g.triggers.length, before);
  assert.ok(g.ctx.AC_CODE_VERSION >= '2026-11-13a');   // 13a 以降の版に含まれる
  const t = [...g.ctx.AC_settingsReport({ WEEKLY_PUNCH_NOTIFY: 'record' }, [{ fn: 'alcoholCheckWeeklyPunchReminder', type: '時間主導' }], {})].join('\n');
  assert.match(t, /WEEKLY_PUNCH_NOTIFY：record/);
  assert.ok(!t.includes('※このコードの関数ではありません'));
  assert.match([...g.ctx.AC_settingsReport({}, [], {})].join('\n'), /WEEKLY_PUNCH_NOTIFY：未設定＝毎週月曜の打刻漏れの催促をしない/);
  // LINE文面シート（キー weeklyPunch）で直せる。{dates} に日付の行が入る
  assert.equal(g.ctx.AC_weeklyPunchMessage(['2026-11-02'], MON, { weeklyPunch: ['テスト\n{dates}\n以上'] }), 'テスト\n・11/2（月）\n以上');
  assert.equal(g.ctx.AC_weekMonday('2026-11-22'), '2026-11-16');               // 日曜は前の月曜の週
  assert.equal(g.ctx.AC_weekMonday(MON), MON);
  // 月の初日は対象の日が無い
  assert.equal(g.ctx.AC_weeklyPunchItems(results(), '2026-11-01').order.length, 0);
});
