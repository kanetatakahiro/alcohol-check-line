import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 夜22:30の本人向けの勤怠のお知らせ（1人1晩1通）。すべて架空データ・模擬環境（LINEには送らない）
const U = (c) => 'U' + String(c).repeat(32).slice(0, 32);
const ADMIN = 'U' + 'a'.repeat(32);
const SECRET = 'fake-secret';
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'LeaveRequest.gs', 'Notices.gs'];
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日', '入社日'];
const row = (code, name, dept, { userId = U(code.slice(-1)) } = {}) =>
  ["'" + code, name, '', '在籍', dept, userId, '', '', true, true, '', '正社員', code.slice(-3), '', ''];
const MASTER = [HEAD, row('90001', '試験 一郎', '法人カーケア'), row('90002', '試験 二郎', '法人カーケア'),
  row('90003', '試験 三郎', '法人カーケア'), row('90004', '試験 四郎', '管理本部'), row('90005', '試験 五郎', '法人カーケア', { userId: '' })];
const EMP = ['001', '002', '003', '004', '005'].map((c) => ({ key: 'k' + c, code: c, lastName: '試験', firstName: c }));
const W = (k, date, o = {}) => ({ employeeKey: k, date, isError: false, overtime: 0, lateNightOvertime: 0, ...o });

// 11/12（木）の夜。一郎：退勤の打刻なし＋打刻漏れ2日＋残業46時間（4項目）／二郎：出勤の打刻なし＋残業31時間／
// 三郎：打刻漏れ＋残業33時間（打刻漏れのチェックを外す）／四郎：打刻漏れ＋残業35時間（全部のチェックを外す）／五郎：LINE未登録
function results(today = '2026-11-12', extra = []) {
  return {
    employees: EMP,
    schedules: [{ dailySchedules: [{ employeeKey: 'k002', date: today, clockInSchedule: today + 'T09:00:00+09:00' }] }],
    workings: [{ dailyWorkings: [
      W('k001', '2026-11-05', { overtime: 2760 }), W('k001', '2026-11-10', { isError: true }), W('k001', '2026-11-11', { isError: true }),
      W('k002', '2026-11-05', { overtime: 1860 }),
      W('k003', '2026-11-05', { overtime: 1980 }), W('k003', '2026-11-11', { isError: true }),
      W('k004', '2026-11-05', { overtime: 2100 }), W('k004', '2026-11-11', { isError: true }),
      W('k005', '2026-11-11', { isError: true }), ...extra] }],
    timerecord: [{ dailyWorkings: [{ employeeKey: 'k001', date: today, timeRecord: [{ code: '1' }] }] }],
  };
}

function setup(props = {}, now = '2026-11-12T22:31:00+09:00') {
  const g = createGas({ files: FILES, now });
  const mf = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = mf.insertSheet('従業員マスタ');
  MASTER.forEach((r) => m.appendRow(r));
  mf.insertSheet('お知らせ停止').appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  mf.insertSheet('LINEグループ').appendRow(['グループID', '部門（所属）', '登録日時', '状態']);
  const ms = g.newSpreadsheet('【テスト】管理シート（架空）');
  g.sheets[g.ctx.AC_SPREADSHEET_ID] = ms;
  const sv = ms.insertSheet('2026-2028');
  sv.appendRow(['シフト表（架空）', '', '', '']);
  sv.appendRow(['', '', '', '2026-11-12']);
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: mf.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN, TOT_SYNC_SECRET: SECRET,
    DRY_RUN: 'false', NOTICE_SETTINGS: 'record', ...props });
  g.ctx.alcoholCheckSetupNoticeSettings();
  const sh = mf.getSheetByName('お知らせ設定');
  const off = (code, id) => {
    const v = sh.getDataRange().getValues();
    const col = v[0].findIndex((h) => String(h).startsWith(id + ' ')), r = v.findIndex((x) => String(x[0]) === code);
    sh.getRange(r + 1, col + 1).setValue(false);
  };
  off('90003', 'ATT-02');
  ['ATT-02', 'HR-02', 'HR-04'].forEach((id) => off('90004', id));
  g.ctx.AC_NS_CACHE = null;
  return { g, mf };
}
const night = (g, today = '2026-11-12', res = results(today), mode = 'night') => {
  const n = g.fetches.length;
  const out = g.ctx.doPost({ postData: { contents: JSON.stringify({ type: 'tot-raw', secret: SECRET, mode, today, fetchedAt: today + 'T22:30:05+09:00', results: res }) } });
  assert.match(out.getContent(), /^OK/);
  return g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
};
const toSelf = (list) => list.filter((f) => f.body.to !== ADMIN);
const text = (f) => f.body.messages[0].text;
const logRows = (mf) => { const sh = mf.getSheetByName('通知送信履歴'); return sh ? sh.getDataRange().getValues().slice(1).filter((r) => r[3] === '本人') : []; };

test('夜の本人向け：on で1人1通。4項目が重なっても1通／チェックを外した項目は文面から除く／全部外した人には送らない', () => {
  const { g, mf } = setup({ ATTENDANCE_NOTIFY: 'on' });
  const p = night(g);
  const self = toSelf(p);
  assert.deepEqual(self.map((f) => f.body.to), [U(1), U(2), U(3)]);              // 四郎さん（全部OFF）・五郎さん（LINE未登録）には送らない
  const t1 = text(self[0]);
  assert.match(t1, /本日11\/12（木）の退勤打刻がまだ確認できません。/); assert.match(t1, /・11\/10（火）の打刻が確認できません。/); assert.match(t1, /・11\/11（水）の打刻が確認できません。/);
  assert.match(t1, /45時間に達しました（現在 46\.0時間）/); assert.match(t1, /Touch On Timeでご確認いただき、打刻漏れがあった場合は「打刻修正申請」/);
  assert.ok(!/30時間/.test(t1));
  assert.match(text(self[1]), /出勤予定ですが、出勤打刻が確認できません。/); assert.match(text(self[1]), /勤怠連絡フォーム/); assert.match(text(self[1]), /30時間を超えました（現在 31\.0時間）/);
  const t3 = text(self[2]);
  assert.match(t3, /30時間を超えました/); assert.ok(!/打刻/.test(t3));            // 打刻漏れ（ATT-02）は除く
  assert.ok(!/試験|9000/.test(self.map(text).join('')));                           // 文面に氏名・社員番号は入れない
  assert.equal(p.filter((f) => f.body.to === ADMIN).length, 1);                    // 管理者への45時間の通知は今までどおり
  const rows = logRows(mf);
  const res = (code) => rows.filter((r) => r[4] === code).map((r) => r[1] + ':' + r[6]);
  assert.deepEqual(res('90001'), ['ATT-02:送信', 'ATT-02:送信', 'ATT-02:送信', 'HR-04:送信']);
  assert.deepEqual(res('90003'), ['ATT-02:除外（お知らせ設定でOFF）', 'HR-02:送信']);
  assert.deepEqual(res('90004').sort(), ['ATT-02:除外（お知らせ設定でOFF）', 'HR-02:除外（お知らせ設定でOFF）']);
  assert.deepEqual(res('90005'), ['ATT-02:除外（LINE未登録）']);
  assert.ok(rows.filter((r) => r[4] === '90001')[0][8].startsWith('お疲れ様です'));   // 文面は1人の最初の行に
});

test('夜の本人向け：2晩目は同じ内容（同じ日付の打刻漏れ・同じ月の残業）を送らない。新しい打刻漏れだけを1通で', () => {
  const { g } = setup({ ATTENDANCE_NOTIFY: 'on' });
  assert.equal(toSelf(night(g)).length, 3);
  assert.equal(toSelf(night(g)).length, 0);                                        // 同じ晩にもう一度届いても送らない
  g.clock.now = new Date('2026-11-13T22:31:00+09:00').getTime();
  const r = results('2026-11-13', [W('k001', '2026-11-12', { isError: true })]);
  r.timerecord = []; r.schedules = [];
  const p = toSelf(night(g, '2026-11-13', r));
  assert.deepEqual(p.map((f) => f.body.to), [U(1)]);
  assert.match(text(p[0]), /11\/12（木）の打刻/);
  assert.ok(!/11\/10|11\/11|残業/.test(text(p[0])));
});

test('夜の本人向け：未設定は0件（今までどおり）／record は0件で文面ごと記録／on は送信', () => {
  // 未設定：本人へは送らない。ATTENDANCE_TEST=true の管理者へのまとめは今までどおり（1通ずつの文面）
  const a = setup({ ATTENDANCE_TEST: 'true' });
  const pa = night(a.g);
  assert.equal(toSelf(pa).length, 0);
  const admin = pa.filter((f) => f.body.to === ADMIN).map(text);
  assert.ok(admin.some((t) => t.startsWith('【勤怠テスト】') && /打刻が確認できていません/.test(t)));
  assert.equal(logRows(a.mf).filter((r) => /^(送信|記録|除外)/.test(r[6])).length, 0);   // まとめの記録は無い（お知らせ設定の記録だけ）
  const b = setup();                                                                // 未設定・テストなし
  assert.equal(night(b.g).length, 0);
  // record：送らずに記録。翌晩、同じ内容は記録も増えない
  const c = setup({ ATTENDANCE_NOTIFY: 'record' });
  assert.equal(toSelf(night(c.g)).length, 0);
  const rec = logRows(c.mf);
  assert.ok(rec.length > 0 && rec.filter((r) => /^記録/.test(r[6])).every((r) => r[6] === '記録（送信しない）'));
  assert.equal(rec.filter((r) => String(r[8]).startsWith('お疲れ様です')).length, 3);   // 3人分の文面
  night(c.g);
  assert.equal(logRows(c.mf).length, rec.length);
  // record の記録は「送った」に数えない：on に切り替えると、まだ届いていない内容を送る
  c.g.scriptProps.setProperty('ATTENDANCE_NOTIFY', 'on');
  assert.equal(toSelf(night(c.g)).length, 3);
  // on：DRY_RUN が false でなければ送らずに記録
  const d = setup({ ATTENDANCE_NOTIFY: 'on', DRY_RUN: 'true' });
  assert.equal(night(d.g).length, 0);
  assert.ok(logRows(d.mf).some((r) => r[6] === '記録（DRY_RUN のため送信しない）'));
});

test('夜の本人向け：record と ATTENDANCE_TEST=true のときは、管理者へまとめた文面のテストが届く（本人へは0件）', () => {
  const { g } = setup({ ATTENDANCE_NOTIFY: 'record', ATTENDANCE_TEST: 'true' });
  const p = night(g);
  assert.equal(toSelf(p).length, 0);
  const t = p.filter((f) => f.body.to === ADMIN).map(text).find((x) => x.startsWith('【勤怠テスト】'));
  assert.match(t, /（4件）/); assert.match(t, /LINE未登録のため本番では届きません/); assert.match(t, /勤怠のお知らせです/);
});

test('夜の本人向け：朝の取り込みでは送らない。送信に失敗した人は次の晩にもう一度。お知らせ停止中は除く', () => {
  const { g, mf } = setup({ ATTENDANCE_NOTIFY: 'on' });
  assert.equal(toSelf(night(g, '2026-11-12', results(), 'morning')).length, 0);
  mf.getSheetByName('お知らせ停止').appendRow(["'90002", '試験 二郎', '2026-11-12', '2026-11-12', '休み', '全部']);
  g.line.pushFail.add(U(1));
  assert.deepEqual(toSelf(night(g)).map((f) => f.body.to).filter((t) => t !== U(1)), [U(3)]);
  assert.ok(logRows(mf).some((r) => r[4] === '90001' && r[6] === '送信失敗'));
  assert.ok(logRows(mf).some((r) => r[4] === '90002' && r[6] === '除外（お知らせ停止中）'));
  g.line.pushFail.clear();
  assert.deepEqual(toSelf(night(g)).map((f) => f.body.to), [U(1)]);
});

test('夜の本人向け：確認用の関数は送らず・記録せず、件数と文面の例だけ（氏名・社員番号は出さない）', () => {
  const { g } = setup({ ATTENDANCE_NOTIFY: 'record' });
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today: '2026-11-12', fetchedAt: 'x', results: results() }), updated: new Date('2026-11-12T22:30:10+09:00').getTime() };
  const keys = () => JSON.stringify(Object.keys(g.userProps.getProperties()).filter((k) => k.startsWith('att:')));
  const before = keys(), n = g.fetches.length, l = g.logs.length;
  const res = g.ctx.alcoholCheckNightSelfPreview();
  assert.equal(g.fetches.length, n);
  assert.equal(keys(), before);                                                     // 送った・記録した・除外した、の記録を残さない
  assert.equal(res.counts.people, 4);                                               // 一郎・二郎・三郎・五郎（五郎さんは LINE未登録）
  assert.equal(res.counts.unreg, 1);
  const log = g.logs.slice(l).join('\n');
  assert.match(log, /送る人数：4人/); assert.match(log, /除外：お知らせ設定でOFF 3件/); assert.match(log, /文面の例1/);
  assert.ok(!/試験|9000/.test(log));
  g.drive.files['tot-latest.json'].updated = new Date('2026-11-12T07:05:00+09:00').getTime();   // 朝のデータ：当日の打刻は含まない
  assert.equal(g.ctx.alcoholCheckNightSelfPreview().counts.kinds.noClockOut, undefined);
});

test('夜の本人向け：設定の表示と版', () => {
  const { g } = setup({ ATTENDANCE_NOTIFY: 'record' });
  const t = [...g.ctx.AC_settingsReport({ ATTENDANCE_NOTIFY: 'record' }, [], { version: g.ctx.AC_CODE_VERSION })].join('\n');
  assert.match(t, /ATTENDANCE_NOTIFY：record/);
  assert.match(t, /コードの版：2026-11-(09d|1\d[a-z])/);   // 2026-11-09d 以降
  assert.equal(g.ctx.AC_attNotifyMode_({ getProperty: () => 'true' }), 'on');
  assert.equal(g.ctx.AC_attNotifyMode_({ getProperty: () => null }), '');
});

// 口調のルール（docs/TONE_RULES.md・2026-11-11）：文面だけを直した（版 2026-11-11a）。全文で確かめる
test('夜の本人向け：文面（打刻だけ／打刻＋残業30時間／残業45時間／当日の打刻なし）と口調のルール', () => {
  const X = createGas({ files: FILES, now: '2026-11-12T22:31:00+09:00' }).ctx;
  const head = 'お疲れ様です😊\n勤怠のお知らせです。';
  const tail = '遅くまでお疲れ様でした。\n無理をせず、体調にはお気をつけください。';
  const guide = '→ Touch On Timeでご確認いただき、打刻漏れがあった場合は「打刻修正申請」をお願いいたします。';
  const a = X.AC_nightSelfMessage([{ kind: 'punch', date: '2026-11-09' }], '2026-11-12');
  assert.equal(a, [head, '【打刻】\n・11/9（月）の打刻が確認できません。\n' + guide, tail].join('\n\n'));
  const b = X.AC_nightSelfMessage([{ kind: 'ot30', min: 1860 }, { kind: 'punch', date: '2026-11-10' }, { kind: 'punch', date: '2026-11-09' }], '2026-11-12');
  assert.equal(b, [head, '【打刻】\n・11/9（月）の打刻が確認できません。\n・11/10（火）の打刻が確認できません。\n' + guide,
    '【今月の残業】\n・今月の残業時間が30時間を超えました（現在 31.0時間）。無理のない働き方を心がけてください。', tail].join('\n\n'));
  const c = X.AC_nightSelfMessage([{ kind: 'ot45', min: 2760 }], '2026-11-12');
  assert.equal(c, [head, '【今月の残業】\n・今月の残業時間が45時間に達しました（現在 46.0時間）。今後の業務量について、上長にご相談ください。', tail].join('\n\n'));
  const d = X.AC_nightSelfMessage([{ kind: 'noClockIn' }, { kind: 'noClockOut' }], '2026-11-12');
  assert.equal(d, [head, '【打刻】\n・本日11/12（木）の退勤打刻がまだ確認できません。勤務中の場合は、退勤時に打刻をお願いいたします。\n'
    + '・本日11/12（木）は出勤予定ですが、出勤打刻が確認できません。\n' + guide
    + '\n→ お休みに変更となった場合は、上長の承認を得たうえで、勤怠連絡フォームからご連絡をお願いいたします。\n' + X.AC_FORM_URL, tail].join('\n\n'));
  for (const s of [a, b, c, d]) {
    assert.ok(!/くださいね|してね|ましょうね/.test(s), s);                 // 「〜くださいね」は使わない
    assert.ok(s.includes('遅くまでお疲れ様でした。'));                       // 労いは残す
  }
  assert.equal(X.AC_CODE_VERSION, '2026-11-11a');
});
