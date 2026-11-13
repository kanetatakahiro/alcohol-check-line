import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 勤怠連絡フォームの連絡を、打刻のお知らせに【勤怠の変更】として入れる（版 2026-11-13b）。すべて架空データ・模擬環境（LINEには送らない）
const U = (c) => 'U' + String(c).repeat(32).slice(0, 32);
const ADMIN = 'U' + 'a'.repeat(32);
const SECRET = 'fake-secret';
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'LeaveRequest.gs', 'Notices.gs'];
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日', '入社日'];
const row = (code, name, dept) => ["'" + code, name, '', '在籍', dept, U(code.slice(-1)), '', '', true, true, '', '正社員', code.slice(-3), '', ''];
const MASTER = [HEAD, row('90001', '試験 一郎', '法人カーケア'), row('90002', '試験 二郎', '法人カーケア'), row('90003', '試験 三郎', '法人カーケア'),
  row('90004', '試験 四郎', '管理本部'), row('90005', '試験 五郎', '法人カーケア')];
const EMP = ['001', '002', '003', '004', '005'].map((c) => ({ key: 'k' + c, code: c }));
const E = (k, date) => ({ employeeKey: k, date, isError: true, overtime: 0, lateNightOvertime: 0 });
const Q = (k, date, type, status) => ({ type, date, employeeKey: k, requestKey: k + date + type, status, requestedDate: date });
// 回答シート（本番の設問の名前。対象者は所属ごとの列）
const FORM_HEAD = ['タイムスタンプ', '入力者（あなたのお名前）', '承認者（ご本人が入力するときのみ）', '所属（部署）', '対象者（法人カーケア）', '対象者（管理本部）', '対象者',
  '区分', '日付（開始日）', '終了日（何日か続くとき）', '変更後の休みの日（休みの変更のときだけ）', '理由・連絡事項'];
const ans = (by, who, kind, from, until = '', to = '') => {
  const care = /管理本部/.test(who) ? '' : who, adm = /管理本部/.test(who) ? who.replace('｜管理本部', '') : '';
  return ['2026/11/12 18:00:00', by, '', '', care, adm, '', kind, from, until, to, '（理由）'];
};
// 一郎：11/12 休日出勤（上長が入力）＋11/9 はフォームなし（混在）／11/3 の欠勤（別の日）
// 二郎：11/10〜11/11 欠勤（本人が入力）。フォームから「お知らせ停止」に入っている
// 三郎：11/8 は手で入れたお知らせ停止（何も送らない）、11/11 はフォームなし。11/9 の欠勤のフォームは一郎の 11/9 に効かない（別の人）
// 四郎（管理本部）：11/7 の休みを 11/14 に変更（上長が入力）
// 五郎：11/10〜11/12 欠勤。11/10・11/11 はスケジュール申請済み（期間の一部だけ）／11/6 の有給休暇は申請済み（期間の全部）
const FORMS = [
  ans('上長 太郎', '試験 一郎（90001）', '休日出勤', '2026-11-12'),
  ans('上長 太郎', '試験 一郎（90001）', '欠勤', '2026-11-03'),
  ans('試験二郎さん', '試験 二郎（90002）', '欠勤', '2026-11-10', '2026-11-11'),
  ans('上長 太郎', '試験 三郎（90003）', '欠勤', '2026-11-09'),
  ans('上長 太郎', '試験 四郎（90004）｜管理本部', '休みの変更（シフト交換など）', '2026-11-07', '', '2026-11-14'),
  ans('上長 太郎', '試験 五郎（90005）', '欠勤', '2026-11-10', '2026-11-12'),
  ans('上長 太郎', '試験 五郎（90005）', '有給休暇', '2026-11-06'),
  ans('上長 太郎', '試験 五郎（90005）', '遅刻', '2026-11-08'),   // 遅刻は使わない（今までどおり）
];
function results(today = '2026-11-13') {
  return {
    employees: EMP,
    workings: [{ dailyWorkings: [E('k001', '2026-11-09'), E('k001', '2026-11-12'), E('k002', '2026-11-10'), E('k003', '2026-11-08'), E('k003', '2026-11-11'),
      E('k004', '2026-11-07'), E('k005', '2026-11-06'), E('k005', '2026-11-08'), E('k005', '2026-11-12')] }],
    timerecord: [{ dailyWorkings: [] }],
    schedules: [],
    requests: [Q('k005', '2026-11-10', 'schedules', 'approved'), Q('k005', '2026-11-11', 'schedules', 'applying'), Q('k005', '2026-11-06', 'schedules', 'approved')],
    today,
  };
}

function setup(props = {}, now = '2026-11-13T22:31:00+09:00', { forms = FORMS } = {}) {
  const g = createGas({ files: FILES, now });
  const mf = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = mf.insertSheet('従業員マスタ');
  MASTER.forEach((r) => m.appendRow(r));
  const pz = mf.insertSheet('お知らせ停止');
  pz.appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  pz.appendRow(["'90002", '試験 二郎', '2026-11-10', '2026-11-11', 'フォーム：欠勤（入力：試験二郎さん）', '全部']);   // フォームから入った停止
  pz.appendRow(["'90003", '試験 三郎', '2026-11-08', '2026-11-08', '休み', '全部']);                              // 手で入れた停止
  mf.insertSheet('LINEグループ').appendRow(['グループID', '部門（所属）', '登録日時', '状態']);
  if (forms) { const fs = mf.insertSheet('フォームの回答 1'); [FORM_HEAD, ...forms].forEach((r) => fs.appendRow(r)); }
  const ms = g.newSpreadsheet('【テスト】管理シート（架空）');
  g.sheets[g.ctx.AC_SPREADSHEET_ID] = ms;
  const sv = ms.insertSheet('2026-2028');
  sv.appendRow(['シフト表（架空）', '', '', '']);
  sv.appendRow(['', '', '', '2026-11-13']);
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: mf.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN, TOT_SYNC_SECRET: SECRET,
    ATTENDANCE_FORM_ID: 'fake-form', DRY_RUN: 'false', NOTICE_SETTINGS: 'on', ...props });
  g.ctx.alcoholCheckSetupNoticeSettings();
  g.ctx.AC_NS_CACHE = null;
  return { g, mf };
}
const night = (g, today = '2026-11-13') => {
  const n = g.fetches.length;
  g.ctx.AC_FORM_ENTRIES_CACHE = null;
  const out = g.ctx.doPost({ postData: { contents: JSON.stringify({ type: 'tot-raw', secret: SECRET, mode: 'night', today, fetchedAt: today + 'T22:30:05+09:00', results: results(today) }) } });
  assert.match(out.getContent(), /^OK/);
  return g.fetches.slice(n).filter((f) => f.url.endsWith('/push') && f.body.to !== ADMIN);
};
const textTo = (push, c) => { const f = push.find((x) => x.body.to === U(c)); return f ? f.body.messages[0].text : null; };
const ASK_END = 'ご不明な点がございましたら、このトークでご連絡ください。\nご確認のほどよろしくお願いいたします！';

test('フォーム：休日出勤（上長が入力）＋フォームの無い打刻漏れ（混在）は1通に【打刻】と【勤怠の変更】', () => {
  const { g } = setup({ ATTENDANCE_NOTIFY: 'on' });
  const t1 = textTo(night(g), 1);
  assert.equal(t1, 'お疲れ様です😊\n勤怠のお知らせです。\n\n【打刻】\n・11/9（月）の打刻が確認できません。\n→ Touch On Timeでご確認いただき、打刻漏れがあった場合は「打刻修正申請」をお願いいたします。\n\n'
    + '【勤怠の変更】\n・上長 太郎さんより、11/12（木）は休日出勤とご連絡をいただいています。\n→ Touch On Timeから「スケジュール申請」をお願いいたします。\n\n' + ASK_END);
});

test('フォーム：お知らせ停止中の欠勤（フォームから入った停止）でも、打刻の項目は【勤怠の変更】で送る。本人の入力は「勤怠変更フォームより、」・何日か続く連絡は期間の全部の日', () => {
  const { g } = setup({ ATTENDANCE_NOTIFY: 'on' });
  const t2 = textTo(night(g), 2);
  assert.equal(t2, 'お疲れ様です😊\n勤怠のお知らせです。\n\n【勤怠の変更】\n・勤怠変更フォームより、11/10（火）〜11/11（水）は欠勤とご連絡をいただいています。\n'
    + '→ Touch On Timeから、各日の「スケジュール申請」をお願いいたします。\n\n' + ASK_END);
  // アルコールチェックなどほかのお知らせは今までどおり止まる（停止の索引そのものは変えない）
  const idx = g.ctx.AC_pauseIndex_();
  assert.equal(g.ctx.AC_isPaused(idx, '90002', '2026-11-10'), true);
  assert.equal(g.ctx.AC_isPausedForPunch(idx, '90002', '2026-11-10', true), false);
  assert.equal(g.ctx.AC_isPausedForPunch(idx, '90002', '2026-11-10', false), true);   // 回答シートが読めないときは今までどおり
});

test('フォーム：手で入れたお知らせ停止の日は今までどおり何も送らない。別の人のフォームは効かない。フォームの無い日は今までどおりの文', () => {
  const { g } = setup({ ATTENDANCE_NOTIFY: 'on' });
  const t3 = textTo(night(g), 3);
  assert.equal(t3, 'お疲れ様です😊\n勤怠のお知らせです。\n\n【打刻】\n・11/11（水）の打刻が確認できません。\n→ Touch On Timeでご確認いただき、打刻漏れがあった場合は「打刻修正申請」をお願いいたします。\n\n'
    + 'ご確認のほどよろしくお願いいたします！');   // 11/8（手で入れた停止）は入らない・【勤怠の変更】も入らない
});

test('フォーム：休みの変更は「の休みを…に変更する」と両日のスケジュール申請。期間の一部だけ申請済みなら送り、全部申請済みの連絡は送らない。遅刻は今までどおり', () => {
  const { g } = setup({ ATTENDANCE_NOTIFY: 'on' });
  const p = night(g);
  assert.match(textTo(p, 4), /【勤怠の変更】\n・上長 太郎さんより、11\/7（土）の休みを11\/14（土）に変更するとご連絡をいただいています。\n→ Touch On Timeから、11\/7（土）と11\/14（土）の両日について「スケジュール申請」をお願いいたします。/);
  const t5 = textTo(p, 5);
  assert.match(t5, /・上長 太郎さんより、11\/10（火）〜11\/12（木）は欠勤とご連絡をいただいています。/);   // 11/10・11/11 は申請済みでも、期間の一部だけなので送る
  assert.match(t5, /【打刻】\n・11\/8（日）の打刻が確認できません。/);                                    // 遅刻のフォームは使わない
  assert.ok(!t5.includes('有給休暇'));                                                                     // 11/6 は申請済み（ToT の申請で外れる）
});

test('フォーム：同じ連絡は夜のお知らせで2回送らない（次の晩も同じデータなら送らない）。record も同じ', () => {
  const { g } = setup({ ATTENDANCE_NOTIFY: 'on' });
  assert.equal(night(g).length, 5);
  g.clock.now = new Date('2026-11-14T22:31:00+09:00').getTime();
  const again = night(g, '2026-11-14');
  assert.equal(textTo(again, 1), null);
  assert.equal(textTo(again, 2), null);
  const r = setup({ ATTENDANCE_NOTIFY: 'record' });
  night(r.g);
  const rows = (r.mf.getSheetByName('通知送信履歴').getDataRange().getValues()).slice(1).filter((x) => x[3] === '本人' && String(x[5]).includes(':formchg:'));
  assert.equal(rows.length, 4);
  assert.ok(rows.every((x) => /^記録/.test(x[6])));
  const n = r.mf.getSheetByName('通知送信履歴').getLastRow();
  night(r.g);
  assert.equal(r.mf.getSheetByName('通知送信履歴').getLastRow(), n);
});

test('フォーム：回答シートが読めないときは今までどおりの文（フォームの停止も効く）で送り、ログに出す', () => {
  const { g } = setup({ ATTENDANCE_NOTIFY: 'on' }, undefined, { forms: null });
  const p = night(g);
  assert.match(textTo(p, 1), /・11\/12（木）の打刻が確認できません。/);
  assert.ok(!textTo(p, 1).includes('勤怠の変更'));
  assert.equal(textTo(p, 2), null);                                                                         // 今までどおりお知らせ停止で止まる
  assert.match(g.logs.join('\n'), /勤怠連絡フォームの回答を読めませんでした（回答シートが見つからない）/);
});

test('フォーム：管理本部の本人へのお知らせ（E-42）と毎週月曜の催促（E-78）にも入る。月曜は未申請なら毎週出す', () => {
  // E-42：四郎（管理本部）。朝の1時間ごとの処理
  const a = setup({ PUNCH_SELF_NOTIFY: 'on' }, '2026-11-13T08:00:00+09:00');
  a.g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today: '2026-11-13', fetchedAt: 'x', results: results() }), updated: new Date('2026-11-13T07:05:30+09:00').getTime() };
  a.g.ctx.AC_FORM_ENTRIES_CACHE = null;
  const n = a.g.fetches.length;
  a.g.ctx.alcoholCheckImportTot();
  const e42 = a.g.fetches.slice(n).filter((f) => f.url.endsWith('/push') && f.body.to === U(4));
  assert.equal(e42.length, 1);
  assert.match(e42[0].body.messages[0].text, /【勤怠の変更】\n・上長 太郎さんより、11\/7（土）の休みを11\/14（土）に変更するとご連絡をいただいています。/);
  assert.ok(e42[0].body.messages[0].text.endsWith(ASK_END));
  // E-78：月曜。一郎は【申請が確認できていない打刻漏れ】と【勤怠の変更】の両方
  const w = setup({ WEEKLY_PUNCH_NOTIFY: 'on' }, '2026-11-16T10:00:00+09:00');
  const save = (today) => { w.g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today, mode: 'morning', fetchedAt: 'x', results: results(today) }), updated: new Date(today + 'T07:05:30+09:00').getTime() }; };
  save('2026-11-16');
  w.g.ctx.AC_FORM_ENTRIES_CACHE = null;
  let m = w.g.fetches.length;
  w.g.ctx.alcoholCheckWeeklyPunchReminder();
  const wk = w.g.fetches.slice(m).filter((f) => f.url.endsWith('/push'));
  const t1 = textTo(wk, 1);
  assert.equal(t1, 'お疲れ様です😊\n今月の打刻のお知らせです。\n\n【申請が確認できていない打刻漏れ】\n・11/9（月）\n→ Touch On Timeでご確認いただき、「打刻修正申請」をお願いいたします。\n'
    + '月末までにご申請いただけますと、月初の勤怠の締めがスムーズになります。\n\n【勤怠の変更】\n・上長 太郎さんより、11/12（木）は休日出勤とご連絡をいただいています。\n'
    + '→ Touch On Timeから「スケジュール申請」をお願いいたします。\n\n' + ASK_END);
  const t2 = textTo(wk, 2);   // フォームの連絡だけの人：打刻漏れの段落は入れない
  assert.ok(t2.startsWith('お疲れ様です😊\n今月の打刻のお知らせです。\n\n【勤怠の変更】\n・勤怠変更フォームより、11/10（火）〜11/11（水）は欠勤'));
  assert.ok(!t2.includes('【申請が確認できていない打刻漏れ】'));
  // 次の週も、未申請なら出す
  w.g.clock.now = new Date('2026-11-23T10:00:00+09:00').getTime();
  save('2026-11-23');
  w.g.ctx.AC_FORM_ENTRIES_CACHE = null;
  m = w.g.fetches.length;
  w.g.ctx.alcoholCheckWeeklyPunchReminder();
  assert.match(textTo(w.g.fetches.slice(m).filter((f) => f.url.endsWith('/push')), 1), /11\/12（木）は休日出勤/);
});

test('フォーム：区分に休日出勤（早退とその他の間）。休日出勤はお知らせ停止に入れない。回答シートの読み取りの細かい決まり', () => {
  const { g } = setup();
  const X = g.ctx;
  assert.deepEqual([...X.AC_FORM_KINDS], ['欠勤', '有給休暇', '休みの変更（シフト交換など）', '打刻の修正', '遅刻', '早退', '休日出勤', 'その他']);
  assert.equal(X.AC_formPlan({ by: '上長 太郎', who: '試験 一郎（90001）', kind: '休日出勤', from: '2026-11-12', reason: 'x' }, { today: '2026-11-12' }).pause, null);
  const out = X.AC_formEntriesFromValues([FORM_HEAD, ...FORMS]);   // 日付が文字のままでも読める
  assert.deepEqual(Object.keys(out).sort(), ['90001', '90002', '90003', '90004', '90005']);
  assert.equal(out['90005'].length, 2);                                                                     // 遅刻は使わない
  assert.deepEqual({ ...out['90004'][0], ts: 0 }, { code: '90004', by: '上長 太郎', kind: '休みの変更（シフト交換など）', label: '休みの変更', change: true,
    from: '2026-11-07', until: '2026-11-07', changeTo: '2026-11-14', ts: 0, order: 5 });
  assert.equal(X.AC_formEntriesFromValues([['タイムスタンプ', '氏名']]), null);                              // 回答シートではない
  // 同じ日に回答が2つ：あとの回答を使う
  const sp = X.AC_formSplit(['2026-11-12'], [{ code: 'x', by: 'a', label: '欠勤', from: '2026-11-12', until: '2026-11-12', ts: 1, order: 1 },
    { code: 'x', by: 'b', label: '休日出勤', from: '2026-11-12', until: '2026-11-12', ts: 2, order: 2 }], {}, '001');
  assert.equal(sp.groups[0].entry.label, '休日出勤');
  assert.deepEqual([...X.AC_formChangeLines({ by: '試験 一郎さん', label: '欠勤', from: '2026-11-12', until: '2026-11-12' }, '試験一郎')],
    ['・勤怠変更フォームより、11/12（木）は欠勤とご連絡をいただいています。', '→ Touch On Timeから「スケジュール申請」をお願いいたします。']);
});
