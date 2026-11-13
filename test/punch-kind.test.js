import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 打刻漏れの「出勤」「退勤」の区別（版 2026-11-13a）。すべて架空データ・模擬環境（LINEには送らない）
const U = (c) => 'U' + String(c).repeat(32).slice(0, 32);
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日', '入社日'];
const MASTER = [HEAD, ["'90001", '試験 一郎', '', '在籍', '管理本部', U(1), '', '', true, true, '', '正社員', '001', '', '']];
const EMP = [{ key: 'k001', code: '001' }];
const E = (date) => ({ employeeKey: 'k001', date, isError: true, overtime: 0, lateNightOvertime: 0 });
const T = (date, codes) => ({ employeeKey: 'k001', date, timeRecord: codes.map((c) => ({ code: String(c) })) });
const TODAY = '2026-11-13';   // 金曜

// 11/9：出勤だけ（→退勤の打刻）／11/10：退勤だけ（→出勤の打刻）／11/11：休憩だけ（→出勤・退勤の打刻）／11/12：出勤2・退勤2（同じ数→打刻）
// 11/6：timerecord の行が無い（→打刻）／11/2：直近7日より前（timerecord の期間外→打刻。毎週の催促だけに入る）
function results() {
  return {
    employees: EMP,
    workings: [{ dailyWorkings: ['2026-11-02', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'].map(E) }],
    timerecord: [{ dailyWorkings: [T('2026-11-09', [1, 3, 4]), T('2026-11-10', [2]), T('2026-11-11', [3, 4]), T('2026-11-12', [1, 2, 1, 2])] }],
    requests: [],
    schedules: [],
  };
}
const gas = () => createGas({ files: ['AlcoholCheck.gs', 'Notices.gs'], now: TODAY + 'T12:00:00+09:00' });

test('出勤・退勤の区別：共通の関数で4通り（出勤 > 退勤→退勤／退勤 > 出勤→出勤／両方0→出勤・退勤／同じ数・行なし→分からない）', () => {
  const X = gas().ctx;
  const idx = { ...X.AC_punchKindIndex(results()) };
  assert.deepEqual(idx, { '1:2026-11-09': 'out', '1:2026-11-10': 'in', '1:2026-11-11': 'both', '1:2026-11-12': '' });
  assert.deepEqual(['out', 'in', 'both', '', undefined].map((k) => X.AC_punchKindLabel(k)), ['退勤の打刻', '出勤の打刻', '出勤・退勤の打刻', '打刻', '打刻']);
  assert.deepEqual({ ...X.AC_punchKindIndex({ employees: EMP }) }, {});                                  // timerecord 無し
  assert.deepEqual({ ...X.AC_punchKindIndex({ employees: EMP, timerecord: [{ _error: 403 }] }) }, {});   // 読み取りエラー
});

test('出勤・退勤の区別：夜のお知らせ（E-40）の打刻漏れの行', () => {
  const X = gas().ctx;
  const items = [...X.AC_nightSelfItems(results(), TODAY, false)].map((x) => ({ ...x }));
  const text = X.AC_nightSelfMessage(items, TODAY);
  assert.ok(text.includes('・11/6（金）の打刻の内容をご確認ください。\n・11/9（月）の退勤の打刻が確認できません。\n・11/10（火）の出勤の打刻が確認できません。\n'
    + '・11/11（水）の出勤・退勤の打刻が確認できません。\n・11/12（木）の打刻の内容をご確認ください。'), text);
  assert.ok(!text.includes('11/2（'));                                                                    // 夜は直近7日だけ（今までどおり）
  // 種類の分からない行は今までどおり
  assert.match(X.AC_nightSelfMessage([{ kind: 'punch', date: '2026-11-09' }], TODAY), /・11\/9（月）の打刻の内容をご確認ください。/);
});

test('出勤・退勤の区別：管理本部の本人へのお知らせ（E-42）は版 2026-11-13e から夜のお知らせ（E-40）と同じ形・同じ口調', () => {
  const X = gas().ctx;
  const list = [...X.AC_punchSelfNotices(results(), MASTER, TODAY)].map((x) => ({ ...x, dates: [...x.dates], kinds: { ...x.kinds } }));
  assert.deepEqual(list[0].dates, ['2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
  assert.deepEqual(list[0].kinds, { '2026-11-09': 'out', '2026-11-10': 'in', '2026-11-11': 'both' });
  const all = X.AC_punchSelfMessage(list[0].dates, null, {}, TODAY, list[0].kinds);
  assert.equal(all, 'お疲れ様です😊\n勤怠のお知らせです。\n\n【打刻】\n・11/6（金）の打刻の内容をご確認ください。\n・11/9（月）の退勤の打刻が確認できません。\n'
    + '・11/10（火）の出勤の打刻が確認できません。\n・11/11（水）の出勤・退勤の打刻が確認できません。\n・11/12（木）の打刻の内容をご確認ください。\n'
    + '→ Touch On Timeでご確認いただき、打刻漏れがあった場合は「打刻修正申請」をお願いいたします。\n\nご確認のほどよろしくお願いいたします！');
  assert.equal(X.AC_punchSelfMessage(['2026-11-12'], null, {}, TODAY), X.AC_nightSelfMessage([{ kind: 'punch', date: '2026-11-12' }], TODAY));
  assert.ok(!/お疲れ様です！|打刻が確認できていません/.test(all), '以前の E-08 の文は使わない');
});

test('出勤・退勤の区別：毎週月曜の催促（E-78）は「・11/5（木）出勤の打刻」の形。分からない日・期間外の日は日付だけ', () => {
  const X = gas().ctx;
  const plan = X.AC_weeklyPunchItems(results(), TODAY);
  const dates = [...plan.byTot['1']], kinds = {};
  dates.forEach((d) => { if (plan.kinds['1:' + d]) kinds[d] = plan.kinds['1:' + d]; });
  const text = X.AC_weeklyPunchMessage(dates, TODAY, {}, kinds);
  assert.ok(text.includes('【申請が確認できていない打刻漏れ】\n・11/2（月）\n・11/6（金）\n・11/9（月）退勤の打刻\n・11/10（火）出勤の打刻\n・11/11（水）出勤・退勤の打刻\n・11/12（木）\n→ Touch On Time'), text);
});

// ---------------- 版 2026-11-13e：判定の直し（11/13 安藤さんの指摘：出勤1・退勤2 の人に「打刻が確認できていません」） ----------------
const T2 = (date, codes) => ({ employeeKey: 'k001', date, timeRecord: codes.map((c) => ({ code: String(c) })) });
const R6 = () => ({
  employees: EMP,
  workings: [{ dailyWorkings: ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-02'].map(E) }],
  // 11/6 出勤1・退勤0／11/7 出勤0・退勤1／11/8 両方0（休憩だけ）／11/9 出勤1・退勤2／11/10 出勤2・退勤1／11/11 出勤2・退勤0／11/12 出勤2・退勤2／11/2 期間外
  timerecord: [{ dailyWorkings: [T2('2026-11-06', [1]), T2('2026-11-07', [2]), T2('2026-11-08', [3, 4]), T2('2026-11-09', [1, 2, 2]), T2('2026-11-10', [1, 1, 2]),
    T2('2026-11-11', [1, 1]), T2('2026-11-12', [1, 2, 1, 2])] }],
  requests: [], schedules: [],
});

test('13e 判定：6通り（退勤なし・出勤なし・両方なし・二重打刻〔多い方と回数〕・同じ数・期間外）', () => {
  const X = gas().ctx;
  assert.deepEqual({ ...X.AC_punchKindIndex(R6()) }, { '1:2026-11-06': 'out', '1:2026-11-07': 'in', '1:2026-11-08': 'both', '1:2026-11-09': 'dup:out:2',
    '1:2026-11-10': 'dup:in:2', '1:2026-11-11': 'out', '1:2026-11-12': '' });
  assert.deepEqual([[1, 0], [0, 1], [0, 0], [1, 2], [2, 1], [2, 0], [0, 3], [2, 2], [3, 1]].map(([a, b]) => X.AC_punchKindClass(a, b)),
    ['out', 'in', 'both', 'dup:out:2', 'dup:in:2', 'out', 'in', '', 'dup:in:3']);
});

test('13e 夜のお知らせ（E-40）：二重打刻は「は退勤の打刻が2回あります。」と削除の案内。打刻漏れの案内は漏れの行があるときだけ', () => {
  const X = gas().ctx;
  const items = [...X.AC_nightSelfItems(R6(), TODAY, false)].map((x) => ({ ...x }));
  const text = X.AC_nightSelfMessage(items, TODAY);
  assert.equal(text, 'お疲れ様です😊\n勤怠のお知らせです。\n\n【打刻】\n・11/6（金）の退勤の打刻が確認できません。\n・11/7（土）の出勤の打刻が確認できません。\n'
    + '・11/8（日）の出勤・退勤の打刻が確認できません。\n・11/9（月）は退勤の打刻が2回あります。\n・11/10（火）は出勤の打刻が2回あります。\n'
    + '・11/11（水）の退勤の打刻が確認できません。\n・11/12（木）の打刻の内容をご確認ください。\n'
    + '→ Touch On Timeでご確認いただき、打刻漏れがあった場合は「打刻修正申請」をお願いいたします。\n'
    + '→ Touch On Timeでご確認いただき、「打刻修正申請」で不要な打刻の削除をお願いいたします。\n\nご確認のほどよろしくお願いいたします！');
  // 二重打刻だけの人：打刻漏れの案内は出さない
  const only = X.AC_nightSelfMessage([{ kind: 'punch', date: '2026-11-12', punchKind: 'dup:out:2' }], TODAY);
  assert.equal(only, 'お疲れ様です😊\n勤怠のお知らせです。\n\n【打刻】\n・11/12（木）は退勤の打刻が2回あります。\n→ Touch On Timeでご確認いただき、「打刻修正申請」で不要な打刻の削除をお願いいたします。\n\nご確認のほどよろしくお願いいたします！');
});

test('13e 管理本部の本人へのお知らせ（E-42）：事例（出勤1・退勤2）に「出勤の打刻が確認できません」と送らない', () => {
  const X = gas().ctx;
  const list = [...X.AC_punchSelfNotices(R6(), MASTER, TODAY)].map((x) => ({ ...x, dates: [...x.dates], kinds: { ...x.kinds } }));
  const text = X.AC_punchSelfMessage(['2026-11-09'], null, {}, TODAY, list[0].kinds);
  assert.match(text, /^お疲れ様です😊\n勤怠のお知らせです。\n\n【打刻】\n・11\/9（月）は退勤の打刻が2回あります。\n→ Touch On Timeでご確認いただき、「打刻修正申請」で不要な打刻の削除をお願いいたします。\n\nご確認のほどよろしくお願いいたします！$/);
  assert.ok(!/出勤の打刻が確認できません/.test(text));
  assert.match(X.AC_punchSelfMessage(['2026-11-11'], null, {}, TODAY, list[0].kinds), /11\/11（水）の退勤の打刻が確認できません。/);   // 出勤2・退勤0
});

test('13e 毎週月曜の催促（E-78）：二重打刻は「・11/9（月）退勤の打刻が2回」。同じ数・期間外は日付だけ', () => {
  const X = gas().ctx;
  const plan = X.AC_weeklyPunchItems(R6(), TODAY);
  const dates = [...plan.byTot['1']], kinds = {};
  dates.forEach((d) => { if (plan.kinds['1:' + d]) kinds[d] = plan.kinds['1:' + d]; });
  const text = X.AC_weeklyPunchMessage(dates, TODAY, {}, kinds);
  assert.ok(text.includes('・11/2（月）\n・11/6（金）退勤の打刻\n・11/7（土）出勤の打刻\n・11/8（日）出勤・退勤の打刻\n・11/9（月）退勤の打刻が2回\n・11/10（火）出勤の打刻が2回\n・11/11（水）退勤の打刻\n・11/12（木）\n'), text);
});
