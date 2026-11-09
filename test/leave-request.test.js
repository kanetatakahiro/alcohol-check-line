import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 希望休の申請期限の案内（毎月10日 12:00・gas/LeaveRequest.gs）。すべて架空データ
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const ADMIN = 'U' + 'a'.repeat(32);
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const row = (code, name, { dept = '部署A', status = '在籍', userId = U(code.slice(-1)), lineOk = true, retiredOn = '', category = '正社員' } = {}) =>
  ["'" + code, name, '', status, dept, userId, '', '', lineOk, false, '', category, '', retiredOn ? "'" + retiredOn : ''];
const MASTER = [HEAD,
  row('90001', '試験 一郎', { dept: '管理本部' }),
  row('90002', '試験 二郎', { dept: '部署B', category: 'パート' }),       // 所属・雇用形態は問わない
  row('90003', '試験 三郎', { status: '退職' }),
  row('90004', '試験 四郎', { lineOk: false }),                          // LINE未確認
  row('90005', '試験 五郎', { userId: '' }),                             // LINE未登録
  row('90006', '試験 六郎', { retiredOn: '2026-11-01' }),               // 退職日が過去
  row('90007', '試験 七郎', { retiredOn: '2026-11-30' }),               // 退職日が先（送る）
  row('90008', '試験 八郎'),                                             // 除外の社員番号
  row('90009', '試験 九郎'),                                             // お知らせ停止（全部）
  row('91001', '試験 十郎', { userId: U(2) }),                           // 二郎と同じLINE
  row('91002', '試験 十一郎', { userId: U('b') }),                       // お知らせ停止（勤怠のみ）
  row('91003', '試験 十二郎', { userId: U('c') }),                       // お知らせ停止は終わっている（送る）
  row('', '試験 番号なし', { userId: U('d') }),
];
const SEND = [U(1), U(2), U(7)];   // 送る人：一郎・二郎・七郎・十二郎（U('c')）
SEND.push(U('c'));

function setup(props = {}, now = '2026-11-10T12:05:00+09:00') {
  const g = createGas({ files: ['AlcoholCheck.gs', 'LeaveRequest.gs'], now });
  const ss = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = ss.insertSheet('従業員マスタ');
  MASTER.forEach((r) => m.appendRow(r));
  const pz = ss.insertSheet('お知らせ停止');
  pz.appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  pz.appendRow(["'90009", '試験 九郎', '2026-11-01', '', '休職', '全部']);
  pz.appendRow(["'91002", '試験 十一郎', '2026-11-09', '2026-11-12', '', '勤怠のみ']);
  pz.appendRow(["'91003", '試験 十二郎', '2026-10-01', '2026-11-09', '', '全部']);
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: ss.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN,
    LEAVE_REQUEST_EXCLUDE_CODES: '90008、 99999', ...props });
  return { g, ss, m };
}
const pushes = (g, from = 0) => g.fetches.slice(from).filter((f) => f.url.endsWith('/push'));
const toEmployees = (list) => list.filter((f) => f.body.to !== ADMIN);
const toAdmin = (list) => list.filter((f) => f.body.to === ADMIN);
const sheetRows = (ss) => { const sh = ss.getSheetByName('希望休案内'); return sh ? sh.getDataRange().getValues().slice(1) : []; };

test('希望休：社員番号の一覧を読む（「、」「,」・空白・全角数字・重複）', () => {
  const { g } = setup();
  assert.deepEqual([...g.ctx.AC_parseCodeList('90008、９００１０, 90011　90008')], ['90008', '90010', '90011']);
  assert.deepEqual([...g.ctx.AC_parseCodeList('')], []);
  assert.deepEqual([...g.ctx.AC_parseCodeList(null)], []);
});

test('希望休：{月}・{期限} の決め方（翌月・今月15日の曜日・12月→1月の年またぎ）', () => {
  const { g } = setup();
  assert.deepEqual({ ...g.ctx.AC_leaveRequestVars('2026-11-10') }, { target: '2026-12', month: '12', deadline: '11月15日（日）' });
  assert.deepEqual({ ...g.ctx.AC_leaveRequestVars('2026-12-10') }, { target: '2027-01', month: '1', deadline: '12月15日（火）' });
  assert.deepEqual({ ...g.ctx.AC_leaveRequestVars('2027-01-10') }, { target: '2027-02', month: '2', deadline: '1月15日（金）' });
});

test('希望休：文面（指定の文。「有給」「残り」は入らない。「LINE文面」シートの上書きでも {月}・{期限} が入る）', () => {
  const { g } = setup();
  const t = g.ctx.AC_leaveRequestMessage('2026-12-10', {});
  assert.equal(t, '【希望休の申請のお知らせ】\n1月分の希望休は、12月15日（火）までにToTから申請をお願いします📅\n\n'
    + '・希望休は月4日までです\n・土日のお休みは基本的に取れません\n　取得したい場合は、必ず上長の許可を取ったうえで、申請の理由と承認者の名前を入れて申請してください\n\n'
    + '申請に漏れがないか確認をお願いします。\n（承認はシフト確定後になります）\n\nわからないことがあれば、このトークで気軽に聞いてくださいね。');
  assert.doesNotMatch(t, /有給|有休|残り|\{/);
  const ov = g.ctx.AC_leaveRequestMessage('2026-11-10', { leaveRequest: ['{月}月分は{期限}まで（{月}月）'] });
  assert.equal(ov, '12月分は11月15日（日）まで（12月）');
});

test('希望休：対象者（在籍・退職日の前・LINE確認済み・社員番号あり。除外・お知らせ停止・同じLINEの重複を除く）', () => {
  const { g, m } = setup();
  const idx = { 90009: [{ from: '2026-11-01', until: '9999-12-31', attendanceOnly: false }],
    91002: [{ from: '2026-11-09', until: '2026-11-12', attendanceOnly: true }],
    91003: [{ from: '2026-10-01', until: '2026-11-09', attendanceOnly: false }] };
  const r = JSON.parse(JSON.stringify(g.ctx.AC_leaveRequestTargets(m.dump(), '2026-11-10', idx, ['90008'])));
  assert.deepEqual(r.targets.map((x) => x.code), ['90001', '90002', '90007', '91003']);
  assert.deepEqual(r.targets.map((x) => x.userId), SEND);
  assert.deepEqual(r.skipped.map((x) => x.code + ':' + x.reason.split('（')[0]),
    ['90008:除外の社員番号', '90009:お知らせ停止中', '91001:同じLINEの重複', '91002:お知らせ停止中']);
});

test('希望休：未設定なら何もしない（送信・シート・管理者への報告なし）', () => {
  const { g, ss } = setup();
  g.ctx.alcoholCheckLeaveRequestNotice();
  assert.equal(pushes(g).length, 0);
  assert.equal(ss.getSheetByName('希望休案内'), null);
});

test('希望休：record は送らずに「希望休案内」シートへ記録し、管理者へ件数だけ報告する', () => {
  const { g, ss } = setup({ LEAVE_REQUEST_NOTIFY: 'record', DRY_RUN: 'false' });
  g.ctx.alcoholCheckLeaveRequestNotice();
  const p = pushes(g);
  assert.equal(toEmployees(p).length, 0);
  assert.equal(toAdmin(p).length, 1);
  const rep = toAdmin(p)[0].body.messages[0].text;
  assert.match(rep, /12月分の申請期限の案内（記録のみ・送信していません）\n対象：4人/);
  assert.match(rep, /お知らせ停止 2人／除外の社員番号 1人／同じLINEの重複 1人/);
  assert.doesNotMatch(rep, /試験|9000|9100/);   // 氏名・社員番号は入れない
  const rows = sheetRows(ss);
  assert.deepEqual(rows.map((r) => r[2] + ':' + r[4]), ['90001:記録のみ（送信しない）', '90002:記録のみ（送信しない）', '90007:記録のみ（送信しない）',
    '91003:記録のみ（送信しない）', '90008:送らない（除外の社員番号）', '90009:送らない（お知らせ停止中）',
    '91001:送らない（同じLINEの重複（社員番号 90002 に送る））', '91002:送らない（お知らせ停止中）']);
  assert.equal(rows[0][1], '2026-12');
  assert.match(rows[0][5], /^【希望休の申請のお知らせ】\n12月分の希望休は、11月15日（日）までに/);
});

test('希望休：on でも DRY_RUN が "false" でなければ送らない（記録のみ）', () => {
  const { g, ss } = setup({ LEAVE_REQUEST_NOTIFY: 'on' });
  g.ctx.alcoholCheckLeaveRequestNotice();
  assert.equal(toEmployees(pushes(g)).length, 0);
  assert.equal(sheetRows(ss)[0][4], '記録のみ（送信しない）');
});

test('希望休：on は対象者へ1人1通送り、同じ月の2回目は誰にも送らない', () => {
  const { g, ss } = setup({ LEAVE_REQUEST_NOTIFY: 'on', DRY_RUN: 'false' });
  g.ctx.alcoholCheckLeaveRequestNotice();
  const p = pushes(g);
  assert.deepEqual(toEmployees(p).map((f) => f.body.to), SEND);
  assert.match(toEmployees(p)[0].body.messages[0].text, /^【希望休の申請のお知らせ】\n12月分の希望休は、11月15日（日）までにToTから申請/);
  assert.match(toAdmin(p)[0].body.messages[0].text, /12月分の申請期限の案内\n送信：4人\n送れなかった人：0人/);
  assert.equal(sheetRows(ss).filter((r) => r[4] === '送信').length, 4);
  const n = g.fetches.length, rowsBefore = sheetRows(ss).length;
  g.clock.now += 3600 * 1000;   // 同じ日の13時台にもう一度
  g.ctx.alcoholCheckLeaveRequestNotice();
  assert.equal(toEmployees(pushes(g, n)).length, 0);
  assert.equal(sheetRows(ss).filter((r) => r[4] === '送信').length, 4);
  assert.equal(sheetRows(ss).length - rowsBefore, 4);   // 除いた人の行だけ（送った人の行は増えない）
});

test('希望休：on は10日以外には送らない（record は記録できる）', () => {
  const { g, ss } = setup({ LEAVE_REQUEST_NOTIFY: 'on', DRY_RUN: 'false' }, '2026-11-11T12:05:00+09:00');
  g.ctx.alcoholCheckLeaveRequestNotice();
  assert.equal(pushes(g).length, 0);
  assert.equal(ss.getSheetByName('希望休案内'), null);
  g.scriptProps.setProperty('LEAVE_REQUEST_NOTIFY', 'record');
  g.ctx.alcoholCheckLeaveRequestNotice();
  assert.equal(toEmployees(pushes(g)).length, 0);
  assert.equal(sheetRows(ss).filter((r) => r[4] === '記録のみ（送信しない）').length, 4);
});

test('希望休：途中で送れなかった人は、再実行で送れなかった人にだけ送る', () => {
  const { g, ss } = setup({ LEAVE_REQUEST_NOTIFY: 'on', DRY_RUN: 'false' });
  g.line.pushFail.add(U(2)).add(U(7));
  g.ctx.alcoholCheckLeaveRequestNotice();
  assert.deepEqual(sheetRows(ss).slice(0, 4).map((r) => r[4]), ['送信', '送信失敗', '送信失敗', '送信']);
  assert.match(toAdmin(pushes(g))[0].body.messages[0].text, /送信：2人\n送れなかった人：2人（もう一度/);
  g.line.pushFail.clear();
  const n = g.fetches.length;
  g.ctx.alcoholCheckLeaveRequestNotice();
  const p = pushes(g, n);
  assert.deepEqual(toEmployees(p).map((f) => f.body.to), [U(2), U(7)]);
  assert.match(toAdmin(p)[0].body.messages[0].text, /送信：2人\n送れなかった人：0人\n今月すでに送った人：2人/);
});

test('希望休：翌月は新しい月として送る。3か月より前の送信記録は消す。既存の「sent:」の自動削除では消えない', () => {
  const { g } = setup({ LEAVE_REQUEST_NOTIFY: 'on', DRY_RUN: 'false' });
  g.userProps.setProperty('leavereq:2026-08:' + U(9), 'x');
  g.ctx.alcoholCheckLeaveRequestNotice();
  assert.equal(g.userProps.getProperty('leavereq:2026-08:' + U(9)), null);
  assert.ok(g.userProps.getProperty('leavereq:2026-12:' + U(1)));
  g.ctx.AC_cleanupSentKeys_(g.userProps, '2026-11-30');
  assert.ok(g.userProps.getProperty('leavereq:2026-12:' + U(1)));
  g.clock.now = new Date('2026-12-10T12:05:00+09:00').getTime();
  const n = g.fetches.length;
  g.ctx.alcoholCheckLeaveRequestNotice();
  const p = toEmployees(pushes(g, n));
  assert.equal(p.length, 4);
  assert.match(p[0].body.messages[0].text, /1月分の希望休は、12月15日（火）までに/);
});

test('希望休：トリガーは毎月10日・12時台に1つだけ作り、ほかのトリガーは消さない。消すときもこのトリガーだけ', () => {
  const { g } = setup();
  g.ctx.INQ_remind = () => {};
  g.ctx.ScriptApp.newTrigger('alcoholCheckMorning').timeBased().atHour(8).everyDays(1).create();
  g.ctx.alcoholCheckSetupLeaveRequestTrigger();
  g.ctx.alcoholCheckSetupLeaveRequestTrigger();
  const lr = g.triggers.filter((t) => t.fn === 'alcoholCheckLeaveRequestNotice');
  assert.equal(lr.length, 1);
  assert.equal(lr[0].monthDay, 10);
  assert.equal(lr[0].at, 12);
  assert.equal(g.triggers.length, 2);
  g.ctx.alcoholCheckSetupTriggers();   // 既存の通知のトリガーを作り直しても、希望休のトリガーは残る
  assert.equal(g.triggers.filter((t) => t.fn === 'alcoholCheckLeaveRequestNotice').length, 1);
  g.ctx.alcoholCheckRemoveLeaveRequestTrigger();
  assert.equal(g.triggers.filter((t) => t.fn === 'alcoholCheckLeaveRequestNotice').length, 0);
  assert.ok(g.triggers.some((t) => t.fn === 'alcoholCheckMorning'));
});

test('希望休：設定の表示（LEAVE_REQUEST_NOTIFY は値、除外の社員番号は「設定あり」だけ。トリガーはこのコードの関数）', () => {
  const { g } = setup({ LEAVE_REQUEST_NOTIFY: 'record' });
  const text = [...g.ctx.AC_settingsReport(g.scriptProps.getProperties(), [{ fn: 'alcoholCheckLeaveRequestNotice', type: '時間主導' }],
    { version: g.ctx.AC_CODE_VERSION })].join('\n');
  assert.match(text, /・LEAVE_REQUEST_NOTIFY：record/);
  assert.match(text, /・LEAVE_REQUEST_EXCLUDE_CODES：設定あり/);
  assert.doesNotMatch(text, /90008/);
  assert.match(text, /・alcoholCheckLeaveRequestNotice（時間主導）\n/);
  assert.doesNotMatch(text, /alcoholCheckLeaveRequestNotice（時間主導）　※/);
});

test('希望休：確認用の関数は送らず、シートも作らない', () => {
  const { g, ss } = setup({ LEAVE_REQUEST_NOTIFY: 'on', DRY_RUN: 'false' });
  g.ctx.alcoholCheckLeaveRequestPreview();
  assert.equal(pushes(g).length, 0);
  assert.equal(ss.getSheetByName('希望休案内'), null);
  assert.ok(g.logs.some((l) => /送る人 4人・除く人 4人/.test(l)));
  assert.ok(!g.logs.some((l) => /試験|90001/.test(l)));
});
