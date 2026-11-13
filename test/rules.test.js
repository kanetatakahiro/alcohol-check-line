import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';
import { checkRequests } from '../src/tot-write.js';

// 勤怠のお知らせの決まり（docs/ATTENDANCE_NOTICE_RULES.md の番号）を、1つのルールにつき1つ以上確かめる。すべて架空データ・模擬環境（LINE・TOT には送らない）。
// 「停止：」のテストは、止めたお知らせ（E-42・承認待ちの本人へのお知らせ。11/13 にスクリプトプロパティを削除）が、設定が無ければ動かないことを確かめる（コードは残す）。
const U = (c) => 'U' + String(c).repeat(32).slice(0, 32);
const ADMIN = 'U' + 'a'.repeat(32);
const SECRET = 'fake-secret';
const KANRI = 'C' + 'k'.repeat(32);
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'LeaveRequest.gs', 'Notices.gs', 'TotSync.gs'];
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日', '入社日'];
const row = (code, name, dept) => ["'" + code, name, '', '在籍', dept, U(code.slice(-1)), '', '', true, true, '', '正社員', code.slice(-3), '', ''];
const MASTER = [HEAD, row('90001', '試験 一郎', '法人カーケア'), row('90002', '試験 二郎', '管理本部'), row('90003', '試験 三郎', '法人カーケア'),
  row('90004', '試験 四郎', '法人カーケア'), row('90005', '試験 五郎', '法人カーケア')];
const EMP = ['001', '002', '003', '004', '005'].map((c) => ({ key: 'k' + c, code: c }));
const E = (k, date, o = {}) => ({ employeeKey: k, date, isError: true, overtime: 0, lateNightOvertime: 0, ...o });
const TR = (k, date, codes) => ({ employeeKey: k, date, timeRecord: codes.map((c) => ({ code: String(c) })) });
const Q = (k, date, type, status) => ({ type, date, employeeKey: k, requestKey: k + date + type, status, requestedDate: date });
const FORM_HEAD = ['タイムスタンプ', '入力者（あなたのお名前）', '承認者（ご本人が入力するときのみ）', '所属（部署）', '対象者（法人カーケア）', '対象者（管理本部）', '対象者',
  '区分', '日付（開始日）', '終了日（何日か続くとき）', '変更後の休みの日（休みの変更のときだけ）', '理由・連絡事項'];
const ans = (by, who, kind, from, until = '', to = '') => {
  const adm = /管理本部/.test(who), w = who.replace('｜管理本部', '');
  return ['2026/11/12 18:00:00', by, '', '', adm ? '' : w, adm ? w : '', '', kind, from, until, to, '（理由）'];
};
const TODAY = '2026-11-13';
const md = (d) => Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10));

// ---- お知らせ（E-40・E-42・E-78）の準備 ----
// 一郎：11/12 打刻漏れ（ATT-02 を OFF にするテストで使う）／二郎（管理本部）：11/12 打刻漏れ（管理本部も E-40・E-78 の対象）
// 三郎：11/11 は手で入れたお知らせ停止／四郎：11/10 はフォームの欠勤（本人が入力・フォームから入った停止）
// 五郎：11/9 打刻申請（申請中）・11/10 スケジュール申請（承認済み）・11/11 申請なし・11/8 打刻申請（却下）
function results(today = TODAY) {
  return {
    employees: EMP,
    workings: [{ dailyWorkings: [E('k001', '2026-11-12'), E('k002', '2026-11-12'), E('k003', '2026-11-11'), E('k004', '2026-11-10'),
      E('k005', '2026-11-08'), E('k005', '2026-11-09'), E('k005', '2026-11-10'), E('k005', '2026-11-11')] }],
    timerecord: [{ dailyWorkings: [] }],
    schedules: [],
    requests: [Q('k005', '2026-11-09', 'timerecords', 'applying'), Q('k005', '2026-11-10', 'schedules', 'approved'), Q('k005', '2026-11-08', 'timerecords', 'rejected')],
    today,
  };
}
function att(props = {}, now = TODAY + 'T22:31:00+09:00', { forms = [ans('試験四郎さん', '試験 四郎（90004）', '欠勤', '2026-11-10')] } = {}) {
  const g = createGas({ files: FILES, now });
  const mf = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = mf.insertSheet('従業員マスタ');
  MASTER.forEach((r) => m.appendRow(r));
  const pz = mf.insertSheet('お知らせ停止');
  pz.appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  pz.appendRow(["'90003", '試験 三郎', '2026-11-11', '2026-11-11', '休み', '全部']);                              // 手で入れた停止
  pz.appendRow(["'90004", '試験 四郎', '2026-11-10', '2026-11-10', 'フォーム：欠勤（入力：試験四郎さん）', '全部']);   // フォームから入った停止
  mf.insertSheet('LINEグループ').appendRow(['グループID', '部門（所属）', '登録日時', '状態']);
  if (forms) { const fs = mf.insertSheet('フォームの回答 1'); [FORM_HEAD, ...forms].forEach((r) => fs.appendRow(r)); }
  const ms = g.newSpreadsheet('【テスト】管理シート（架空）');
  g.sheets[g.ctx.AC_SPREADSHEET_ID] = ms;
  const sv = ms.insertSheet('2026-2028');
  sv.appendRow(['シフト表（架空）', '', '', '']);
  sv.appendRow(['', '', '', TODAY]);
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: mf.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN, TOT_SYNC_SECRET: SECRET,
    ATTENDANCE_FORM_ID: 'fake-form', DRY_RUN: 'false', NOTICE_SETTINGS: 'on', ATTENDANCE_NOTIFY: 'on', ...props });
  g.ctx.alcoholCheckSetupNoticeSettings();
  g.ctx.AC_NS_CACHE = null;
  return { g, mf };
}
const night = (g, today = TODAY, res = results(today)) => {
  const n = g.fetches.length;
  g.ctx.AC_FORM_ENTRIES_CACHE = null;
  const out = g.ctx.doPost({ postData: { contents: JSON.stringify({ type: 'tot-raw', secret: SECRET, mode: 'night', today, fetchedAt: today + 'T22:30:05+09:00', results: res }) } });
  assert.match(out.getContent(), /^OK/);
  return g.fetches.slice(n).filter((f) => f.url.endsWith('/push') && f.body.to !== ADMIN);
};
const morning = (g, today = TODAY, res = results(today)) => {   // 朝の1時間ごとの処理（止めた E-42・承認待ちの本人へのお知らせの入口）
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today, mode: 'morning', fetchedAt: today + 'T07:05:05+09:00', results: res }), updated: new Date(today + 'T07:05:30+09:00').getTime() };
  g.ctx.AC_FORM_ENTRIES_CACHE = null;
  const n = g.fetches.length;
  g.ctx.alcoholCheckImportTot();
  return g.fetches.slice(n).filter((f) => f.url.endsWith('/push') && f.body.to !== ADMIN);
};
const textTo = (push, c) => { const f = push.find((x) => x.body.to === U(c)); return f ? f.body.messages[0].text : null; };
const settingOff = (mf, g, code, id = 'ATT-02') => {
  const sh = mf.getSheetByName('お知らせ設定'), v = sh.getDataRange().getValues();
  const col = v[0].findIndex((h) => String(h).startsWith(id + ' ')), r = v.findIndex((x) => String(x[0]) === code);
  sh.getRange(r + 1, col + 1).setValue(false);
  g.ctx.AC_NS_CACHE = null;
};

// ---- 自動反映（TotSync.gs）の準備 ----
const T = (d, hm) => `${d}T${hm}:00+09:00`;
const work = (k, d) => ({ date: d, employeeKey: k, clockInSchedule: T(d, '09:00'), clockOutSchedule: T(d, '18:00'), workDayTypeName: '平日', workPlaceDivisionCode: '100', scheduleTypeName: '通常勤務' });
function sync(props = { TOT_WRITE: 'on' }, now = TODAY + 'T12:00:00+09:00', requests = []) {
  const g = createGas({ files: FILES, now });
  const mf = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = mf.insertSheet('従業員マスタ');
  MASTER.forEach((r) => m.appendRow(r));
  mf.insertSheet('お知らせ停止').appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  const gs = mf.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [KANRI, '勤怠管理', '', '有効']].forEach((r) => gs.appendRow(r));
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: mf.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN, TOT_SYNC_SECRET: SECRET,
    FORM_LIVE_FROM: '2026-10-20', ...props });
  if (!props.TOT_WRITE) g.scriptProps.deleteProperty('TOT_WRITE');
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today: TODAY, results: { employees: EMP, requests,
    schedules: [{ date: 'x', dailySchedules: [work('k001', '2026-11-16'), work('k001', '2026-11-17'), work('k001', '2026-11-18')] }] } }), updated: g.clock.now };
  g.line.members[KANRI] = { [U('b')]: '承認 花子', [U(1)]: '試験 一郎' };
  return { g, mf };
}
const submit = (g, a) => g.ctx.alcoholCheckOnAttendanceForm({ response: { getItemResponses: () => Object.entries({
  '入力者（あなたのお名前）': '上長 太郎', 対象者: '試験 一郎（90001）', '理由・連絡事項': '（理由）', ...a,
}).map(([t, v]) => ({ getItem: () => ({ getTitle: () => t }), getResponse: () => v })) } });
const post = (g, body) => g.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent();
const press = (g, data, uid = U('b')) => {
  const n = g.fetches.length;
  post(g, { events: [{ type: 'postback', webhookEventId: 'ev-' + Math.random(), replyToken: 'rt', source: { type: 'group', groupId: KANRI, userId: uid }, postback: { data } }] });
  const r = g.fetches.slice(n).find((f) => f.url.endsWith('/reply'));
  return r ? r.body.messages[0].text : null;
};
const pushes = (g, n = 0) => g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
const cardOf = (g) => pushes(g).map((f) => f.body.messages[0]).find((x) => x.type === 'flex' && /TOT反映の承認/.test(x.altText));
const btn = (card, i) => card.contents.footer.contents[i].action.data;
const queue = (g) => JSON.parse(post(g, { type: 'tot-write-queue', secret: SECRET }));
const caseRows = (g, mf) => mf.getSheetByName('TOT反映').dump().slice(1).map((r, i) => ({ ...g.ctx.SCH_rowToCase(r, i + 1) }));

// ======================================================================
// ルール1：打刻申請・スケジュール申請が申請中・承認済みの日は、E-40・E-78 で送らない
// ======================================================================
test('ルール1：E-40（夜）は打刻申請・スケジュール申請が申請中・承認済みの日を送らない（却下の日は送る）', () => {
  const { g } = att();
  const t5 = textTo(night(g), 5);
  assert.ok(t5.includes('・11/8（日）の') && t5.includes('・11/11（水）の'), t5);
  assert.ok(!t5.includes('11/9（月）') && !t5.includes('11/10（火）'), t5);
});

test('ルール1：E-78（月曜）は打刻申請・スケジュール申請が申請中・承認済みの日を外す', () => {
  const X = att().g.ctx;
  const plan = X.AC_weeklyPunchItems(results('2026-11-16'), '2026-11-16');
  assert.deepEqual([...plan.byTot['5']], ['2026-11-08', '2026-11-11']);
  assert.equal(plan.requested, 2);
});

// ======================================================================
// ルール2：打刻の種類（休みの日の打刻／退勤なし／出勤なし／出勤・退勤なし／二重打刻／それ以外は「内容をご確認ください」）
// ======================================================================
test('ルール2：打刻の種類の判定と、それぞれの行', () => {
  const X = att().g.ctx;
  const cls = [[1, 1, true], [1, 0], [0, 1], [0, 0], [1, 2], [2, 1], [2, 2]].map(([a, b, h]) => X.AC_punchKindClass(a, b, !!h));
  assert.deepEqual(cls, ['holiday', 'out', 'in', 'both', 'dup:out:2', 'dup:in:2', '']);
  const d = '11/12（木）';
  assert.deepEqual([...cls, 'unknown-x'].map((k) => X.AC_punchLine(d, k === 'unknown-x' ? '' : k)), [
    '・11/12（木）は休みの予定ですが、出勤・退勤の打刻があります。',
    '・11/12（木）の退勤の打刻が確認できません。',
    '・11/12（木）の出勤の打刻が確認できません。',
    '・11/12（木）の出勤・退勤の打刻が確認できません。',
    '・11/12（木）は退勤の打刻が2回あります。',
    '・11/12（木）は出勤の打刻が2回あります。',
    '・11/12（木）の打刻の内容をご確認ください。',
    '・11/12（木）の打刻の内容をご確認ください。',
  ]);
  // データから：全日休暇の日に打刻あり → 休みの日の打刻（判定の最初）。timerecord の無い日は種類なし（＝内容の確認）
  const R = { employees: EMP, workings: [{ dailyWorkings: [E('k001', '2026-11-09', { holidaysObtained: { fulltimeHoliday: { code: 9, name: '公休' } } }), E('k001', '2026-11-10')] }],
    timerecord: [{ dailyWorkings: [TR('k001', '2026-11-09', [1, 2, 2]), TR('k001', '2026-11-10', [1, 2, 2])] }] };
  assert.deepEqual({ ...X.AC_punchKindIndex(R) }, { '1:2026-11-09': 'holiday', '1:2026-11-10': 'dup:out:2' });
});

// ======================================================================
// ルール3：フォームの連絡がある日
// ======================================================================
test('ルール3：欠勤・有給・休みの変更は自動反映の対象、休日出勤は対象外（本人にスケジュール申請を依頼）', () => {
  const X = sync().g.ctx;
  assert.equal(X.SCH_requestFromForm({ kind: '欠勤', from: '2026-11-16' }, TODAY).holiday, '3');
  assert.equal(X.SCH_requestFromForm({ kind: '有給休暇', from: '2026-11-16' }, TODAY).holiday, '1');
  assert.equal(X.SCH_requestFromForm({ kind: '休みの変更（シフト交換など）', from: '2026-11-16', changeTo: '2026-11-18' }, TODAY).swap, true);
  assert.equal(X.SCH_requestFromForm({ kind: '休日出勤', from: '2026-11-16' }, TODAY), null);
  const lines = [...X.AC_formChangeLines({ by: '上長 太郎', label: '休日出勤', from: '2026-11-15', until: '2026-11-15' }, '試験 一郎')];
  assert.deepEqual(lines, ['・上長 太郎さんより、11/15（日）は休日出勤とご連絡をいただいています。', '→ Touch On Timeから「スケジュール申請」をお願いいたします。']);
});

test('ルール3：書き出しは「{入力者}さんより、」、本人の入力なら「勤怠変更フォームより、」', () => {
  const X = att().g.ctx;
  const e = { label: '欠勤', from: '2026-11-10', until: '2026-11-10' };
  assert.match(X.AC_formChangeLines({ ...e, by: '上長 太郎' }, '試験 四郎')[0], /^・上長 太郎さんより、/);
  assert.match(X.AC_formChangeLines({ ...e, by: '試験四郎さん' }, '試験 四郎')[0], /^・勤怠変更フォームより、/);
  assert.match(X.AC_formChangeLines({ ...e, by: '' }, '試験 四郎')[0], /^・勤怠変更フォームより、/);
});

// TOT反映 シートの状態ごとに、【勤怠の変更】を送るか（synced＝送らない）
function syncedByState(props) {
  const states = ['反映待ち', '反映中', '反映済み', '元に戻す待ち', '元に戻し中', '承認待ち', '失敗', '反映しない', '対象外', '承認済み（記録のみ）'];
  const { g, mf } = att(props, TODAY + 'T12:00:00+09:00', { forms: states.map((s, i) => ans('上長 太郎', '試験 一郎（90001）', '欠勤', '2026-11-' + (14 + i))) });
  const sh = g.ctx.SCH_sheetOf_(mf, 'TOT反映', g.ctx.SCH_HEADER);
  states.forEach((s, i) => {
    const d = '2026-11-' + (14 + i), x = g.ctx.SCH_HEADER.map(() => '');
    Object.assign(x, { 0: 'S-20261113-' + String(i + 1).padStart(3, '0'), 1: s, 3: "'90001", 5: '欠勤', 6: "'" + d, 7: "'" + d });
    sh.appendRow(x);
  });
  g.ctx.AC_FORM_ENTRIES_CACHE = null;
  const f = g.ctx.AC_formEntries_();
  assert.equal(f.ok, true);
  return Object.fromEntries(states.map((s, i) => [s, !!f.byCode['90001'][i].synced]));
}

test('ルール3：反映待ち・反映済み（反映中・元に戻す待ち・元に戻し中も）の連絡は本人に何も送らない。自動反映できなかった連絡（過ぎた日＝対象外・打刻あり＝失敗・承認されなかった・record）は【勤怠の変更】で依頼', () => {
  const s = syncedByState({ TOT_WRITE: 'on' });
  assert.deepEqual(s, { 反映待ち: true, 反映中: true, 反映済み: true, 元に戻す待ち: true, 元に戻し中: true,
    承認待ち: false, 失敗: false, 反映しない: false, 対象外: false, '承認済み（記録のみ）': false });
  // synced の連絡の日は、打刻の行も【勤怠の変更】も出さない（AC_formSplit の skip）
  const X = att().g.ctx;
  const e = { code: '90001', by: '上長 太郎', label: '欠勤', from: '2026-11-12', until: '2026-11-12', ts: 1, order: 1, synced: true };
  const sp = X.AC_formSplit(['2026-11-12'], [e], {}, '001');
  assert.deepEqual([sp.groups[0].skip, [...sp.rest]], [true, []]);
  // 夜：四郎の 11/10 欠勤（自動反映していない連絡）は【勤怠の変更】で依頼
  assert.match(textTo(night(att().g), 4), /【勤怠の変更】\n・勤怠変更フォームより、11\/10（火）は欠勤とご連絡をいただいています。\n→ Touch On Timeから「スケジュール申請」をお願いいたします。/);
});

test('ルール3：TOT_WRITE が on でないとき（record・未設定）は、送らない判定を効かせない（反映待ち・反映中のまま残った連絡も【勤怠の変更】で依頼。版 2026-11-13f で直した 3-a）', () => {
  for (const props of [{ TOT_WRITE: 'record' }, {}]) {
    const s = syncedByState(props);
    assert.ok(Object.values(s).every((v) => v === false), JSON.stringify(props) + ' ' + JSON.stringify(s));
  }
  // 夜：TOT_WRITE=record で「反映待ち」のまま残った四郎の 11/10 欠勤も【勤怠の変更】で依頼
  const { g, mf } = att({ TOT_WRITE: 'record' });
  const sh = g.ctx.SCH_sheetOf_(mf, 'TOT反映', g.ctx.SCH_HEADER), x = g.ctx.SCH_HEADER.map(() => '');
  Object.assign(x, { 0: 'S-20261110-001', 1: '反映待ち', 3: "'90004", 5: '欠勤', 6: "'2026-11-10", 7: "'2026-11-10" });
  sh.appendRow(x);
  assert.match(textTo(night(g), 4), /11\/10（火）は欠勤とご連絡をいただいています。/);
  const b = att({ TOT_WRITE: 'on' });                                              // on なら送らない（管理本部が反映する）
  const sh2 = b.g.ctx.SCH_sheetOf_(b.mf, 'TOT反映', b.g.ctx.SCH_HEADER);
  sh2.appendRow(x);
  assert.equal(textTo(night(b.g), 4), null);
});

// ======================================================================
// ルール4：締めの文
// ======================================================================
test('ルール4：締めは「ご確認のほどよろしくお願いいたします！」。当日の出勤打刻なしがあるときだけ「ご対応のほどよろしくお願いいたします！」', () => {
  const X = att().g.ctx;
  const end = (items) => X.AC_nightSelfMessage(items, TODAY).split('\n').at(-1);
  assert.equal(end([{ kind: 'punch', date: '2026-11-12', punchKind: 'out' }]), 'ご確認のほどよろしくお願いいたします！');
  assert.equal(end([{ kind: 'noClockOut' }]), 'ご確認のほどよろしくお願いいたします！');
  assert.equal(end([{ kind: 'ot30', min: 1900 }]), 'ご確認のほどよろしくお願いいたします！');
  assert.equal(end([{ kind: 'noClockIn' }, { kind: 'punch', date: '2026-11-12', punchKind: 'out' }]), 'ご対応のほどよろしくお願いいたします！');
  assert.equal(X.AC_weeklyPunchMessage(['2026-11-12'], '2026-11-16', {}, {}).split('\n').at(-1), 'ご確認のほどよろしくお願いいたします！');
});

// ======================================================================
// ルール5：夜のお知らせ（E-40）は同じ日・同じ連絡について1回だけ。E-78（月曜）は未申請なら毎週
// ======================================================================
test('ルール5：夜のお知らせ（E-40）は同じ日を次の晩に送らない。同じフォームの連絡も1回だけ', () => {
  const { g } = att();
  const R = (today) => ({ ...results(today), workings: [{ dailyWorkings: [E('k002', '2026-11-12')] }], requests: [] });
  assert.match(textTo(night(g, TODAY, R(TODAY)), 2), /11\/12（木）/);
  g.clock.now = new Date('2026-11-14T22:31:00+09:00').getTime();
  assert.equal(textTo(night(g, '2026-11-14', R('2026-11-14')), 2), null);
  const a = att();
  assert.ok(textTo(night(a.g), 4));
  a.g.clock.now = new Date('2026-11-14T22:31:00+09:00').getTime();
  assert.equal(textTo(night(a.g, '2026-11-14'), 4), null);
});

test('ルール5：E-78（月曜）は同じ週は1通、次の週も未申請なら出す', () => {
  const { g } = att({ WEEKLY_PUNCH_NOTIFY: 'on' }, '2026-11-16T10:00:00+09:00');
  const save = (today) => { g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today, mode: 'morning', fetchedAt: 'x', results: results(today) }), updated: new Date(today + 'T07:05:30+09:00').getTime() }; };
  const run = () => { const n = g.fetches.length; g.ctx.AC_FORM_ENTRIES_CACHE = null; g.ctx.alcoholCheckWeeklyPunchReminder(); return g.fetches.slice(n).filter((f) => f.url.endsWith('/push')); };
  save('2026-11-16');
  assert.match(textTo(run(), 5), /・11\/11（水）/);
  assert.equal(textTo(run(), 5), null);                                   // 同じ週の2回目
  g.clock.now = new Date('2026-11-23T10:00:00+09:00').getTime();
  save('2026-11-23');
  assert.match(textTo(run(), 5), /・11\/11（水）/);                       // 次の週
});

// ======================================================================
// ルール6：ATT-02 が OFF・お知らせ停止中の人には送らない。フォームによる停止中は打刻の項目だけ送る。手で入れた停止は何も送らない
// ======================================================================
test('ルール6：ATT-02 が OFF の人には送らない', () => {
  const a = att();
  assert.ok(textTo(night(a.g), 1));
  const b = att();
  settingOff(b.mf, b.g, '90001');
  assert.equal(textTo(night(b.g), 1), null);
});

test('ルール6：手で入れたお知らせ停止の日は何も送らない。フォームから入った停止の日は打刻の項目（【勤怠の変更】）を送る', () => {
  const push = night(att().g);
  assert.equal(textTo(push, 3), null);                                       // 三郎：手で入れた停止（11/11）
  assert.match(textTo(push, 4), /11\/10（火）は欠勤/);                       // 四郎：フォームから入った停止（11/10）
  const X = att().g.ctx, idx = X.AC_pauseIndex_();
  assert.equal(X.AC_isPaused(idx, '90004', '2026-11-10'), true);             // アルコールチェックなどは止まる
  assert.equal(X.AC_isPausedForPunch(idx, '90004', '2026-11-10', true), false);
  assert.equal(X.AC_isPausedForPunch(idx, '90003', '2026-11-11', true), true);
});

// ======================================================================
// ルール7：承認カードはスケジュール申請だけ。打刻申請・残業申請は出さない
// ======================================================================
test('ルール7：カードに出す本人の申請はスケジュール申請（申請中）だけ', () => {
  const rq = (date, type, key) => ({ type, date, requestedDate: '2026-11-12', employeeKey: 'k001', requestKey: key, status: 'applying', message: '架空', requested: { holidayName: '欠勤', holidayCode: '3' } });
  const { g } = sync({ TOT_WRITE: 'on' }, TODAY + 'T12:00:00+09:00', [rq('2026-11-16', 'timerecords', 'tr1'), rq('2026-11-16', 'overtimes', 'ot1'), rq('2026-11-17', 'schedules', 'sc1')]);
  assert.deepEqual([...g.ctx.SCH_pendingRequests([rq('2026-11-16', 'timerecords', 'tr1'), rq('2026-11-16', 'overtimes', 'ot1'), rq('2026-11-17', 'schedules', 'sc1')], 'k001', ['2026-11-16', '2026-11-17'])].map((q) => q.requestKey), ['sc1']);
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16', '終了日（何日か続くとき）': '2026-11-17' });
  const text = JSON.stringify(cardOf(g));
  assert.match(text, /11\/17（火）：休み（欠勤）/);
  assert.ok(!/11\/16（月）：休み（欠勤）/.test(text), '打刻申請・残業申請は出さない');
});

// ======================================================================
// ルール8：カードの対象者本人は承認できない。ToT への承認は TOT_APPROVER_KEY の管理者で行う
// ======================================================================
test('ルール8：本人のボタンは受け付けない。TOT の承認は TOT_APPROVER_KEY の管理者（無い・承認フローにいなければ承認しない）', () => {
  const { g, mf } = sync();
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  const card = cardOf(g);
  assert.equal(press(g, btn(card, 0), U(1)), 'ご自身の分は、ほかの方が承認してください。');
  assert.equal(caseRows(g, mf)[0].state, '承認待ち');
  assert.match(press(g, btn(card, 0)), /承認しました/);
  const w = [{ requestKey: 'rq1', date: '2026-11-16' }], found = { rq1: { status: 'applying', currentFlow: 1, flow: [{ level: 1, administratorKeys: ['adm-1'] }] } };
  assert.deepEqual(checkRequests(w, found, 'adm-1'), { ok: true, reason: '' });
  assert.equal(checkRequests(w, found, '').reason, 'noApprover');
  assert.equal(checkRequests(w, found, 'adm-2').reason, 'approverNotInFlow');
});

// ======================================================================
// ルール9：9:00・15:00 のまとめに承認待ちを載せる。対象の日の前日15時台に承認待ちを1回だけ再通知
// ======================================================================
test('ルール9：まとめに承認待ちの一覧。前日の15時台に1回だけ再通知（15時より前・2回目・承認待ちでない・前日でないは出さない）', () => {
  const X = sync().g.ctx, S = X.SCH_STATE;
  const c = { state: S.wait, name: '試験 一郎', label: '欠勤', from: '2026-11-14', until: '2026-11-14', changeTo: '', renotifiedAt: '' };
  assert.equal(X.SCH_remindText([c, { ...c, state: S.done }]), '【承認待ちの勤怠の変更 1件】\n・試験 一郎さん 11/14（土） 欠勤\n勤怠管理グループの承認のカードから、承認または「反映しない」を押してください。');
  assert.equal(X.SCH_remindText([{ ...c, state: S.done }]), null);
  assert.equal(X.SCH_isDueForResend(c, TODAY, 15), true);
  assert.equal(X.SCH_isDueForResend(c, TODAY, 14), false);
  assert.equal(X.SCH_isDueForResend({ ...c, renotifiedAt: new Date() }, TODAY, 15), false);
  assert.equal(X.SCH_isDueForResend({ ...c, state: S.queued }, TODAY, 15), false);
  assert.equal(X.SCH_isDueForResend({ ...c, from: '2026-11-15', until: '2026-11-15' }, TODAY, 15), false);
});

// ======================================================================
// ルール10：反映できたら本人に ATT-11 を1通。TOT_WRITE=record のときは送らず記録だけ
// ======================================================================
test('ルール10：反映できたら本人へ1通（結果の2回目は受け付けない）。record は送らず記録だけ', () => {
  const { g, mf } = sync({ TOT_WRITE: 'on', DRY_RUN: 'false' });
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  press(g, btn(cardOf(g), 0));
  const id = queue(g).items[0].id, n = g.fetches.length;
  const res = { type: 'tot-write-result', secret: SECRET, id, op: 'apply', status: 'done', written: ['2026-11-16'], before: {} };
  assert.equal(post(g, res), 'OK');
  assert.notEqual(post(g, res), 'OK');
  const self = pushes(g, n).filter((f) => f.body.to === U(1));
  assert.equal(self.length, 1);
  assert.match(self[0].body.messages[0].text, /11\/16（月）は欠勤としてスケジュールを変更しました。/);
  assert.match(mf.getSheetByName('TOT反映').dump()[1][25], /^送信済み：/);
  const b = sync({ TOT_WRITE: 'record', DRY_RUN: 'false' });
  submit(b.g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  press(b.g, btn(cardOf(b.g), 0));
  assert.match(b.mf.getSheetByName('TOT反映').dump()[1][25], /^記録のみ（TOT_WRITE=record）：/);
  assert.equal(pushes(b.g).some((f) => f.body.to === U(1)), false);
});

// ======================================================================
// ルール11：TOT_WRITE が未設定・record のとき、ToT には何も書かない
// ======================================================================
test('ルール11：TOT_WRITE が未設定ならシートもカードも作らない。未設定・record は VPS へ何も渡さない（書き込むものが無い）', () => {
  const a = sync({});
  submit(a.g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  assert.equal(a.mf.getSheetByName('TOT反映'), null);
  assert.equal(cardOf(a.g), undefined);
  assert.deepEqual([queue(a.g).mode, queue(a.g).items.length], ['off', 0]);
  const b = sync({ TOT_WRITE: 'record' });
  submit(b.g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  press(b.g, btn(cardOf(b.g), 0));
  assert.equal(caseRows(b.g, b.mf)[0].state, '承認済み（記録のみ）');
  assert.deepEqual([queue(b.g).mode, queue(b.g).items.length], ['record', 0]);
});

// ======================================================================
// ルール12：管理本部の人も、ほかの人と同じく E-40（夜）と E-78（月曜）の対象（所属で外さない）
// ======================================================================
test('ルール12：管理本部の人にも E-40・E-78 を送る', () => {
  const { g } = att();
  assert.match(textTo(night(g), 2), /・11\/12（木）の打刻の内容をご確認ください。/);   // 二郎（管理本部）
  const w = att({ WEEKLY_PUNCH_NOTIFY: 'on' }, '2026-11-16T10:00:00+09:00');
  w.g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today: '2026-11-16', mode: 'morning', fetchedAt: 'x', results: results('2026-11-16') }), updated: new Date('2026-11-16T07:05:30+09:00').getTime() };
  w.g.ctx.AC_FORM_ENTRIES_CACHE = null;
  const n = w.g.fetches.length;
  w.g.ctx.alcoholCheckWeeklyPunchReminder();
  assert.match(textTo(w.g.fetches.slice(n).filter((f) => f.url.endsWith('/push')), 2), /・11\/12（木）/);
});

// ======================================================================
// 停止：E-42（管理本部の本人への打刻漏れのお知らせ・PUNCH_SELF_NOTIFY）と、本人への承認待ちの申請のお知らせ（REQUEST_SELF_NOTIFY）
// 11/13 14:44・14:47 にスクリプトプロパティを削除して止めた。コードは残す（設定が無ければ動かない）
// ======================================================================
test('停止：PUNCH_SELF_NOTIFY・REQUEST_SELF_NOTIFY が無ければ、朝の処理は本人へ何も送らず、シートも作らない', () => {
  const { g, mf } = att({}, TODAY + 'T08:00:00+09:00');
  assert.equal(g.scriptProps.getProperty('PUNCH_SELF_NOTIFY'), null);
  assert.equal(g.scriptProps.getProperty('REQUEST_SELF_NOTIFY'), null);
  const R = { ...results(), requests: [...results().requests, Q('k002', '2026-11-12', 'timerecords', 'applying'), Q('k002', '2026-11-11', 'schedules', 'applying')] };
  assert.deepEqual(morning(g, TODAY, R), []);
  assert.equal(mf.getSheetByName('打刻漏れ本人通知'), null);
  assert.equal(mf.getSheetByName('承認待ち本人通知'), null);
  assert.equal(g.userProps.getProperty('selfnotice:' + TODAY), null);   // 1日1回の印も付けない（何もしていない）
});

test('停止：止めたあとは、管理本部の人の打刻漏れは夜のお知らせ（E-40）だけで1回届く（以前の 5-a の2回目は起きない）', () => {
  const { g } = att({}, TODAY + 'T08:00:00+09:00');
  const R = { ...results(), workings: [{ dailyWorkings: [E('k002', '2026-11-12')] }], requests: [] };
  assert.deepEqual(morning(g, TODAY, R), []);
  g.clock.now = new Date(TODAY + 'T22:31:00+09:00').getTime();
  const p = night(g, TODAY, R).filter((f) => f.body.to === U(2));
  assert.equal(p.length, 1);
  assert.match(p[0].body.messages[0].text, /11\/12（木）/);
});

// ---- お知らせ設定（gas/Notices.gs）・アルコールチェック・希望休の準備 ----
const AHEAD = ['タイムスタンプ', '氏名', '区分', '測定結果'];
const DAYS = ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'];
function alc(props = {}, now = '2026-11-10T08:30:00+09:00') {
  const g = createGas({ files: FILES, now });
  const mf = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = mf.insertSheet('従業員マスタ');
  [HEAD, row('90001', '試験 一郎', '法人カーケア'), row('90002', '試験 二郎', '法人カーケア'), row('90003', '試験 三郎', '法人カーケア')].forEach((r) => m.appendRow(r));
  mf.insertSheet('お知らせ停止').appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  const gs = mf.insertSheet('LINEグループ');
  gs.appendRow(['グループID', '部門（所属）', '登録日時', '状態']);
  gs.appendRow([KANRI, '勤怠管理', '2026-10-20', '有効']);
  const ms = g.newSpreadsheet('【テスト】管理シート（架空）');
  g.sheets[g.ctx.AC_SPREADSHEET_ID] = ms;
  const sv = ms.insertSheet('2026-2028');
  sv.appendRow(['シフト表（架空）', '', '', '']);
  sv.appendRow(['', '', '', ...DAYS]);
  ['試験 一郎', '試験 二郎', '試験 三郎'].forEach((n) => sv.appendRow(['', n, 'シフト', ...DAYS.map(() => '出勤')]));
  const fv = ms.insertSheet('フォームの回答 1');
  fv.appendRow(AHEAD);
  // 二郎：11/6〜11/10 の5日、出勤前・退勤前がそろう（11/10 の20:00 にお礼の対象＝5勤務日連続）
  DAYS.forEach((d) => { fv.appendRow([new g.FakeDate(d + 'T08:00:00+09:00'), '試験 二郎', '出勤前', '0.00']); fv.appendRow([new g.FakeDate(d + 'T19:00:00+09:00'), '試験 二郎', '退勤前', '0.00']); });
  const inv = ms.insertSheet('アルコールチェッカー在庫');
  inv.appendRow(['従業員コード', '機器所持']);
  ['90001', '90002', '90003'].forEach((c) => inv.appendRow(["'" + c, true]));
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: mf.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN,
    DRY_RUN: 'false', NOTIFY_EMPLOYEES: 'true', NOTIFY_ADMIN: 'false', REQUIRE_DEVICE: 'true', NOTICE_SETTINGS: 'on', ...props });
  g.ctx.alcoholCheckSetupNoticeSettings();
  g.ctx.AC_NS_CACHE = null;
  return { g, mf, fv };
}
const at = (g, fn, when) => { g.clock.now = new Date(when).getTime(); const n = g.fetches.length; g.ctx[fn](); return pushes(g, n); };
const tos = (list) => list.map((f) => f.body.to);
const ALC = [['alcoholCheckMorning', '2026-11-10T08:30:00+09:00'], ['alcoholCheckBeforeWork', '2026-11-10T10:00:00+09:00'],
  ['alcoholCheckEvening', '2026-11-10T18:30:00+09:00'], ['alcoholCheckAfterWork', '2026-11-10T20:00:00+09:00']];
const thanksTo = (list) => list.filter((f) => /勤務日連続/.test(f.body.messages[0].text || '')).map((f) => f.body.to);

// ======================================================================
// ルール13：希望休の案内（ATT-01）は、お知らせ設定でチェックがある人だけに送る（LEAVE_REQUEST_EXCLUDE_CODES の人も送らない）
// ======================================================================
test('ルール13：希望休の案内は ATT-01 にチェックがある人だけ。除外の社員番号の人は、チェックがあっても送らない', () => {
  const { g, mf } = alc({ LEAVE_REQUEST_NOTIFY: 'on', LEAVE_REQUEST_EXCLUDE_CODES: '90003' }, '2026-11-10T12:05:00+09:00');
  settingOff(mf, g, '90001', 'ATT-01');
  const sh = mf.getSheetByName('お知らせ設定'), v = sh.getDataRange().getValues();   // 三郎は最初に作るときに OFF で引き継がれる → あえてチェックを付ける
  sh.getRange(v.findIndex((x) => String(x[0]) === '90003') + 1, v[0].findIndex((h) => String(h).startsWith('ATT-01 ')) + 1).setValue(true);
  g.ctx.AC_NS_CACHE = null;
  g.ctx.alcoholCheckLeaveRequestNotice();
  assert.deepEqual(tos(pushes(g)).filter((t) => t !== ADMIN), [U(2)]);
  const rec = mf.getSheetByName('希望休案内').getDataRange().getValues();
  assert.ok(rec.some((r) => String(r[2]) === '90001' && /お知らせ設定でOFF/.test(r[4])));
  assert.ok(rec.some((r) => String(r[2]) === '90003' && /除外の社員番号/.test(r[4])));
});

// ======================================================================
// ルール14：アルコールチェックの案内（8:30・18:30）は ATT-03・04、入力確認（催促 10:00・20:00）は ATT-12、お礼は ATT-13 にチェックがある人だけ。
//   NOTICE_ALCOHOL_SCOPE は使わない（11/13 14:53 に all を追加 → 14:58 に削除。版 2026-11-13f で ATT-12・13 に分けた）
// ======================================================================
test('ルール14：案内は ATT-03・04、入力確認は ATT-12、お礼は ATT-13 で判定する。案内だけ止めた人にも催促・お礼は届く', () => {
  const { g, mf } = alc({});
  settingOff(mf, g, '90001', 'ATT-03');
  settingOff(mf, g, '90001', 'ATT-04');            // 一郎：案内だけ止める → 催促は届く
  settingOff(mf, g, '90003', 'ATT-12');            // 三郎：催促だけ止める → 案内は届く
  const r = ALC.map(([fn, w]) => at(g, fn, w));
  assert.deepEqual(tos(r[0]), [U(2), U(3)]);       // 8:30 案内
  assert.deepEqual(tos(r[1]), [U(1)]);             // 10:00 催促（二郎は入力済み）
  assert.deepEqual(tos(r[2]), [U(2), U(3)]);       // 18:30 案内
  assert.deepEqual(tos(r[3]).sort(), [U(1), U(2)].sort());   // 20:00 催促：一郎／お礼：二郎（ATT-04 は OFF でない）
  assert.deepEqual(thanksTo(r[3]), [U(2)]);
});

test('ルール14：お礼は ATT-13 にチェックがある人だけ（ATT-04 を止めてもお礼は届く）。NOTICE_ALCOHOL_SCOPE を入れても判定は変わらない', () => {
  for (const scope of [undefined, 'all', 'guideAndFollow']) {
    const a = alc(scope ? { NOTICE_ALCOHOL_SCOPE: scope } : {});
    settingOff(a.mf, a.g, '90002', 'ATT-04');
    assert.deepEqual(thanksTo(at(a.g, 'alcoholCheckAfterWork', '2026-11-10T20:00:00+09:00')), [U(2)], String(scope));
    const b = alc(scope ? { NOTICE_ALCOHOL_SCOPE: scope } : {});
    settingOff(b.mf, b.g, '90002', 'ATT-13');
    const p = at(b.g, 'alcoholCheckAfterWork', '2026-11-10T20:00:00+09:00');
    assert.deepEqual(thanksTo(p), [], String(scope));
    assert.deepEqual(tos(p).sort(), [U(1), U(3)].sort(), String(scope));   // 催促（ATT-12）はそのまま
  }
});

// ======================================================================
// ルール15：飲酒検知・管理者への知らせ・記録は、お知らせ設定に関係なく動く
// ======================================================================
test('ルール15：お知らせ設定を全部 OFF にしても、飲酒検知（管理者・勤怠管理グループ）と記録、管理者への知らせは止まらない', () => {
  const { g, mf, fv } = alc({}, '2026-11-10T08:40:00+09:00');
  const sh = mf.getSheetByName('お知らせ設定'), v = sh.getDataRange().getValues();
  for (let r = 2; r <= v.length; r++) for (let c = 5; c <= v[0].length; c++) sh.getRange(r, c).setValue(false);
  g.ctx.AC_NS_CACHE = null;
  fv.appendRow([new g.FakeDate('2026-11-10T08:35:00+09:00'), '試験 一郎', '出勤前', '0.25']);
  g.ctx.alcoholCheckAlerts();
  assert.deepEqual(tos(pushes(g)), [ADMIN, KANRI]);
  const log = mf.getSheetByName('通知送信履歴').getDataRange().getValues().filter((r) => r[1] === 'CRIT-01');
  assert.deepEqual(log.map((r) => r[6]), ['送信', '送信']);
  const n = g.fetches.length;
  g.ctx.AC_adminNotice_('rules-test', '【テスト】管理者への知らせ（架空）');
  assert.deepEqual(tos(pushes(g, n)), [ADMIN]);
  // 本人向けの案内は止まる（チェックが無い）
  assert.deepEqual(at(g, 'alcoholCheckEvening', '2026-11-10T18:30:00+09:00').filter((f) => f.body.to !== ADMIN && f.body.to !== KANRI), []);
});

// ======================================================================
// ルール16：反映できたときの本人へのお知らせ（ATT-11）には、誰からの連絡かを入れる（版 2026-11-13g）
// ======================================================================
test('ルール16：入力者が本人以外なら「{入力者}さんよりご連絡をいただき、」、本人（入力者が空も）なら「勤怠変更フォームにてご入力いただいた内容で、」', () => {
  const X = sync().g.ctx;
  const c = { label: '欠勤', from: '2026-11-20', until: '2026-11-20', changeTo: '', by: '上長 太郎', name: '試験 一郎' };
  assert.match(X.SCH_selfMessage(c, ['2026-11-20'], []), /^お疲れ様です😊\n上長 太郎さんよりご連絡をいただき、11\/20（金）は欠勤としてスケジュールを変更しました。/);
  for (const by of ['試験 一郎', '試験一郎さん', '']) assert.match(X.SCH_selfMessage({ ...c, by }, ['2026-11-20'], []), /^お疲れ様です😊\n勤怠変更フォームにてご入力いただいた内容で、11\/20（金）は欠勤として/, by);
  assert.match(X.SCH_selfMessage({ ...c, label: '休みの変更', from: '2026-11-12', until: '2026-11-12', changeTo: '2026-11-15' }, null, []), /上長 太郎さんよりご連絡をいただき、11\/12（木）の休みを11\/15（日）に変更しました。/);
});
