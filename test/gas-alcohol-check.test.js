import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Apps Scriptのファイルを読み込み、純粋関数だけをテストする（架空データのみ）
const ctx = { module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL('../gas/AlcoholCheck.gs', import.meta.url), 'utf8'), ctx);
const { AC_reconcile, AC_buildMessage, AC_parseEmployeeCode, AC_buildRegistry,
  AC_planNotifications, AC_planRegistration, AC_rosterNames, AC_mergeRoster, AC_nameKey, AC_isValidDate, AC_isRetired, AC_namesForCode,
  AC_messageFor, AC_morningMessage, AC_thanksMessage, AC_streak, AC_isMilestone, AC_thanksTargets, AC_buildDay,
  AC_recipientsFor, AC_weatherFromJma, AC_findAlerts, AC_notTargetReason, AC_isNormalResult, AC_deviceCodes,
  AC_filterRegistryByCodes, AC_parseTotCsv, AC_totPatternToShift, AC_buildTotCompare, AC_totScheduleItems,
  AC_attendanceFindings, AC_lineByTotCode, AC_attendanceReport, AC_punchMessage, AC_overtimeMessage, AC_careLine, AC_render, AC_composeMessage, AC_todayStatus, AC_todayStatusMessage, AC_quotaLevel, AC_nextMonth, AC_isMonthEnd, AC_monthlyApplyPlan, AC_addMonths, AC_agreementCheck, AC_paidLeavePeriod, AC_paidLeaveCheck, AC_monthlyByTot, AC_pendingRequests, AC_paidLeaveStatus, AC_pauseIndex, AC_isPaused, AC_pausedNames, AC_formChoices, AC_codeFromChoice, AC_formPlan, AC_parseDeptRegistration, AC_deptNames, AC_groupsByDept } = ctx.module.exports;

// 従業員マスタの1行（架空データ）：社員番号, 氏名, 別表記, 在籍, 所属, LINE ID, 表示名, 登録日時, LINE確認済み, アルコール対象, 備考
const mrow = (code, name, { alias = '', status = '在籍', userId = '', ok = true, alcohol = true } = {}) =>
  [code, name, alias, status, '', userId, '', '', ok, alcohol, ''];
const MASTER_HEADER = mrow('社員番号', '氏名');

const uid = n => 'U' + String(n).repeat(32).slice(0, 32);   // 架空のLINEユーザーID

test('GAS: 社員番号だけのメッセージを受け付ける（全角数字可、それ以外は無視）', () => {
  assert.equal(AC_parseEmployeeCode('10033'), '10033');
  assert.equal(AC_parseEmployeeCode(' １００３３ '), '10033');
  for (const t of ['おはようございます', '10033です', '123', '1234567', '', null]) {
    assert.equal(AC_parseEmployeeCode(t), null);
  }
});

test('GAS: 従業員マスタから本人通知に使える人だけを取り出す', () => {
  const reg = AC_buildRegistry([MASTER_HEADER,
    mrow("'90001", '試験 太郎', { alias: '試験太郎（A店）', userId: uid(1) }),
    mrow('90002', '試験 花子', { userId: uid(2), ok: false }),          // LINE未確認
    mrow('90003', '試験 次郎', { userId: 'not-an-id' }),                 // 不正なID
    mrow('90004', '試験 三郎', { userId: uid(4) }),
    mrow('90005', '試験　三郎', { userId: uid(5) }),                     // 同じ氏名に別の人 → 使わない
    mrow('90006', '試験 四郎', { userId: uid(6), status: '退職' }),      // 退職
    mrow('90007', '試験 五郎', { userId: uid(7), alcohol: false }),      // 対象外
  ]);
  assert.deepEqual(Object.keys(reg).sort(), ['試験太郎', '試験太郎（A店）'].sort());
  assert.deepEqual({ ...reg['試験太郎（A店）'] }, { code: '90001', userId: uid(1) });
});

test('GAS: LINE登録は社員番号で行を探し、別のIDで上書きしない', () => {
  const values = [MASTER_HEADER, mrow('90001', '試験 太郎'), mrow('90002', '試験 花子', { userId: uid(2) }),
    mrow('90003', 'a'), mrow('90003', 'b')];
  assert.deepEqual({ ...AC_planRegistration(values, '90001', uid(1)) }, { type: 'fill', row: 1 });
  assert.equal(AC_planRegistration(values, '90002', uid(2)).type, 'same');
  assert.equal(AC_planRegistration(values, '90002', uid(9)).type, 'conflict');
  assert.equal(AC_planRegistration(values, '90003', uid(3)).type, 'conflict');   // 番号の重複
  assert.equal(AC_planRegistration(values, '99999', uid(1)).type, 'new');
});

test('GAS: シフト表から氏名を重複なしで取り出す', () => {
  const sv = [[], ['', '氏名', '区分'], ['', '試験 太郎', 'シフト'], ['', '', '出勤前'], ['', '', '退勤後'],
    ['', '試験 花子', 'シフト'], ['', '', '出勤前'], ['', '試験　太郎', 'シフト'], ['', 19, 'シフト'], ['', '２０', 'シフト']];
  assert.deepEqual([...AC_rosterNames(sv)], ['試験 太郎', '試験 花子']);
});

test('GAS: 未実施者を本人通知と未登録に分け、管理者一覧に表示する', () => {
  const reg = { '試験太郎': { code: '90001', userId: uid(1) } };
  const plan = AC_planNotifications(['試験 太郎', '試験 花子'], reg);
  assert.deepEqual([...plan.send.map(p => p.code)], ['90001']);
  assert.deepEqual([...plan.unregistered], ['試験 花子']);
  const msg = AC_buildMessage('2026-10-08', '出勤前', { targets: ['a', 'b', 'c'], missing: ['試験 太郎', '試験 花子'] }, plan, []);
  assert.match(msg, /・試験 太郎（本人に通知）/);
  assert.match(msg, /・試験 花子（LINE未登録）/);
  assert.match(AC_buildMessage('2026-10-08', '出勤前', { targets: ['a'], missing: ['試験 太郎'] }, plan, ['試験 太郎']), /本人通知に失敗/);
});

test('GAS: 本人向け文面（2026-10-16 改訂：親しみやすく温かく、過度な感謝はしない）', () => {
  const FORM = /▼ アルコールチェック入力フォーム\nhttps:\/\/docs\.google\.com\/forms\/d\/e\/1FAIpQLSemLVglUlSIc44wxMzmd8e9g09KRDXGUruMbZ54kuWrT6ZAhA\/viewform\?usp=dialog/;
  const fb = AC_messageFor('followBefore', '2026-10-08', null);
  assert.equal(fb, 'おはようございます！😊\n\n本日の出勤前アルコールチェックについて、まだ入力が確認できていません。\n\nすでに実施済みの場合は、フォームへの入力をお願いします！\n\n未実施の場合は、運転前に必ずチェックをお願いします🚗\n\n▼ アルコールチェック入力フォーム\nhttps://docs.google.com/forms/d/e/1FAIpQLSemLVglUlSIc44wxMzmd8e9g09KRDXGUruMbZ54kuWrT6ZAhA/viewform?usp=dialog\n\nよろしくお願いします！');
  assert.match(AC_messageFor('followAfter', '2026-10-08', null), /運転終了後のアルコールチェックを実施してください🚗[\s\S]*本日も一日お疲れ様でした！$/);
  assert.match(AC_messageFor('evening', '2026-10-08', null), /^お疲れ様です！😊\n\n退勤前のアルコールチェック[\s\S]*お帰りの際はお気をつけください🚗$/);
  for (const k of ['morning', 'followBefore', 'evening', 'followAfter']) {
    const m = AC_messageFor(k, '2026-10-08', null);
    assert.match(m, FORM);                                    // 4つともフォームのURLを載せる
    assert.doesNotMatch(m, /試験|\n{3,}|\{|本当にありがとう|頼りにして/);   // 差し込み漏れ・空行の連続・過度な感謝がない
  }
  for (const m of [AC_punchMessage('2026-10-08', null), AC_overtimeMessage(1900, 30, '2026-10-08'), AC_overtimeMessage(2800, 45, '2026-10-08'),
    AC_thanksMessage(5, '2026-10-08'), AC_render('follow', '2026-10-08', {}), AC_render('registered', '2026-10-08', { code: '90001' }),
    AC_render('registeredSame', '2026-10-08', { code: '90001' }), AC_render('registeredCheck', '2026-10-08', { code: '90001' })]) {
    assert.doesNotMatch(m, /\{|\n{3,}|本当にありがとう|頼りにして/);
  }
  assert.equal(AC_render('registered', '2026-10-08', { code: '90001' }), '社員番号：90001\n\n登録を受け付けました！😊\n\n管理本部で確認後、各種お知らせが届くようになります。');
  assert.match(AC_render('follow', '2026-10-08', {}), /^友だち追加ありがとうございます！😊\n\nREBIRTH管理本部です。/);
});

const d = s => new Date(`${s}T00:00:00+09:00`);
const toDate = v => (v instanceof Date ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(v) : null);
const today = '2026-10-08';
const schedule = (todayShifts) => {
  const rows = [['', '', '', ''], ['', '氏名', '区分', d('2026-10-07'), d(today)]];
  todayShifts.forEach(([name, shift]) => {
    rows.push(['', name, 'シフト', '出勤', shift]);
    rows.push(['', '', '出勤前', '', '']);
    rows.push(['', '', '退勤後', '', '']);
  });
  return rows;
};
const ts = (date, time) => new Date(`${date}T${time}:00+09:00`);
const form = rows => [['タイムスタンプ', '氏名', 'チェック区分', '測定結果'], ...rows];
const run = (sv, fv, checkLabel = '出勤前') => AC_reconcile({ today, checkLabel, scheduleValues: sv, formValues: fv, toDate });

test('GAS: 出勤の人だけを対象にし、回答のない人を未実施にする', () => {
  const sv = schedule([['試験 太郎', '出勤'], ['試験 花子', '出勤'], ['試験 次郎', '公休'], ['試験 三郎', '有給']]);
  const r = run(sv, form([[ts(today, '07:50'), '試験 太郎', '出勤前', '0.00']]));
  assert.deepEqual([...r.targets], ['試験 太郎', '試験 花子']);
  assert.deepEqual([...r.missing], ['試験 花子']);
});

test('GAS: 前日・別区分の回答は実施済みにしない／全角空白の違いは同一視', () => {
  const sv = schedule([['試験 太郎', '出勤'], ['試験 花子', '出勤']]);
  const r = run(sv, form([
    [ts('2026-10-07', '23:59'), '試験 太郎', '出勤前', '0.00'],
    [ts(today, '08:00'), '試験 太郎', '退勤前', '0.00'],
    [ts(today, '08:00'), '試験　花子', '出勤前', '0.00'],
  ]));
  assert.deepEqual([...r.missing], ['試験 太郎']);
});

test('GAS: 日本時間の日付で判定する（UTCでは前日でも当日扱い）', () => {
  const sv = schedule([['試験 太郎', '出勤']]);
  const r = run(sv, form([[new Date('2026-10-07T23:30:00Z'), '試験 太郎', '出勤前', '0.00']]));
  assert.equal(r.missing.length, 0);
});

test('GAS: 当日の日付列がない・同名が重複している場合は中止する', () => {
  const noCol = schedule([['試験 太郎', '出勤']]); noCol[1][4] = d('2026-10-09');
  assert.throws(() => run(noCol, form([])), /日付列/);
  assert.throws(() => run(schedule([['試験 太郎', '出勤'], ['試験　太郎', '出勤']]), form([])), /同じ氏名/);
});

test('GAS: 通知文（全員実施済みなら送らない、出勤ゼロは確認を促す）', () => {
  assert.equal(AC_buildMessage(today, '出勤前', { targets: ['a'], missing: [] }), null);
  assert.match(AC_buildMessage(today, '出勤前', { targets: [], missing: [] }), /出勤」がありません/);
  assert.match(AC_buildMessage(today, '出勤前', { targets: ['a', 'b'], missing: ['b'] }), /未実施（1\/2人）\n・b/);
});

test('GAS: 名簿の取り込み（架空データ）：氏名が1人だけ一致する行に社員番号を入れ、残りは追加', () => {
  const master = [MASTER_HEADER,
    mrow('', '試験 太郎'),                 // 名簿と1人一致 → 番号を入れる
    mrow('', '試験 花子'),                 // 名簿に同名2人 → 変更しない
    mrow('', '架空 次郎'),                 // 名簿に無い
    mrow("'90009", '試験 三郎', { userId: uid(9) }),  // 番号一致 → 空欄だけ埋める
  ];
  const roster = [
    { code: 90001, totCode: 101, name: '試験太郎（旧姓）', dept: 'A店', category: '正社員' },
    { code: 90002, totCode: '', name: '試験 花子', dept: 'B店', category: 'パート' },
    { code: 90003, totCode: '', name: '試験　花子', dept: 'C店', category: 'パート' },
    { code: 90009, totCode: 109, name: '試験 三郎', dept: 'A店', category: '契約社員' },
    { code: 'abc', name: '不正' },
  ];
  const plan = AC_mergeRoster(master, roster);
  assert.equal(plan.ambiguous, 1);
  assert.equal(plan.notFound, 1);
  const byIndex = Object.fromEntries(plan.updates.map(u => [u.index, [...u.values]]));
  assert.equal(byIndex[0][0], "'90001");
  assert.equal(byIndex[0][4], 'A店');
  assert.match(byIndex[0][10], /要確認/);
  assert.equal(byIndex[3][0], "'90009");            // 番号は変えない
  assert.equal(byIndex[3][5], uid(9));              // LINE IDは保持
  assert.equal(byIndex[3][12], "'109");
  assert.equal(byIndex[1], undefined);              // 同名2人の行は変更しない
  assert.deepEqual([...plan.appends.map(r => r[0])].sort(), ["'90002", "'90003"]);
  assert.equal(plan.appends[0][9], false);          // 追加した人はアルコールチェック対象外
  assert.equal(AC_nameKey('山田 太郎（旧姓）'), '山田太郎');
});

test('GAS: 名簿内で別の人に同じ社員番号がある場合は取り込まない（架空データ）', () => {
  const master = [MASTER_HEADER, mrow('', '試験 太郎'), mrow('', '試験 次郎')];
  const roster = [
    { code: 90001, name: '試験 太郎', dept: 'A' },
    { code: 90001, name: '試験 花子', dept: 'B' },     // 番号重複
    { code: 90002, name: '試験 次郎', dept: 'C' },
    { code: 90003, name: '試験 次郎', dept: 'D' },     // 同名
  ];
  const plan = AC_mergeRoster(master, roster);
  assert.equal(plan.dupCodes, 1);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.ambiguous, 1);                      // 次郎は同名2人
  assert.equal(plan.notFound, 1);                       // 太郎は重複番号のみ → 名簿に無い扱い
  assert.deepEqual([...plan.appends.map(r => r[0])].sort(), ["'90002", "'90003"]);
});

test('GAS: 退職者の番号を付け直した場合は在籍者に番号を割り当て、退職者は番号を空ける（架空データ）', () => {
  const master = [MASTER_HEADER, mrow('', '試験 太郎'), mrow("'90005", '試験 五郎')];
  const roster = [
    { code: 90001, name: '試験 太郎', dept: 'A' },                                   // 在籍
    { code: 90001, name: '旧在籍 一郎', dept: 'B', retiredOn: '2022-03-31' },        // 同じ番号の退職者
    { code: 90002, name: '旧在籍 二郎', retiredOn: '2021-01-31' },
    { code: 90002, name: '旧在籍 三郎', retiredOn: '2021-02-28' },                   // 退職者どうしの重複
    { code: 90005, name: '試験 五郎', retiredOn: '2023/06/31' },                     // 実在しない日付
  ];
  const plan = AC_mergeRoster(master, roster, '2026-10-08');
  assert.equal(plan.dupCodes, 0);
  const u = Object.fromEntries(plan.updates.map(x => [x.index, [...x.values]]));
  assert.equal(u[0][0], "'90001");
  assert.equal(u[0][3], '在籍');
  assert.equal(u[1][3], '退職');
  assert.equal(u[1][13], '2023/06/31');
  assert.match(u[1][10], /退職日の日付を確認/);
  const appended = plan.appends.map(r => [...r]);
  assert.equal(appended.length, 3);                                  // 一郎・二郎・三郎（番号は空欄）
  assert.ok(appended.every(r => r[0] === '' && r[3] === '退職' && r[9] === false));
  // 2回目の取り込みでは、番号空欄の退職者を重複して追加しない
  const again = AC_mergeRoster([MASTER_HEADER, ...appended], roster.slice(2, 4), '2026-10-08');
  assert.equal(again.appends.length, 0);
});

test('GAS: 日付の妥当性', () => {
  assert.equal(AC_isValidDate('2023-06-30'), true);
  assert.equal(AC_isValidDate('2023/6/31'), false);
  assert.equal(AC_isValidDate('令和5年'), false);
});

test('GAS: 退職予定の人は退職日まで在籍として扱う（架空データ）', () => {
  assert.equal(AC_isRetired('', '2026-10-08'), false);
  assert.equal(AC_isRetired('2026-10-24', '2026-10-08'), false);
  assert.equal(AC_isRetired('2026-10-08', '2026-10-08'), false);   // 退職日当日はまだ在籍
  assert.equal(AC_isRetired('2026-10-07', '2026-10-08'), true);
  assert.equal(AC_isRetired('2023/6/31', '2026-10-08'), true);     // 読めない日付は退職扱い
  const plan = AC_mergeRoster([MASTER_HEADER, mrow('', '試験 太郎')],
    [{ code: 90001, name: '試験 太郎', retiredOn: '2026-10-24' }], '2026-10-08');
  const row = [...plan.updates[0].values];
  assert.equal(row[3], '在籍');
  assert.match(row[10], /退職予定/);
  // 退職日を過ぎたら、在籍のままでも本人通知に使わない
  const r = mrow('90001', '試験 太郎', { userId: uid(1) }); r[13] = '2026-10-24';
  assert.equal(Object.keys(AC_buildRegistry([MASTER_HEADER, r], '2026-10-24')).length, 1);
  assert.equal(Object.keys(AC_buildRegistry([MASTER_HEADER, r], '2026-10-25')).length, 0);
});

test('GAS: 従業員マスタから社員番号の氏名を引く', () => {
  assert.deepEqual([...AC_namesForCode([MASTER_HEADER, mrow("'90001", '試験 太郎', { alias: '試験太郎A' })], '90001')], ['試験 太郎', '試験太郎A']);
  assert.deepEqual([...AC_namesForCode([MASTER_HEADER], '90001')], []);
});

// ---- 1日の通知（架空データ） ----
const dd = s => new Date(`${s}T00:00:00+09:00`);
const ts2 = (s, hm) => new Date(`${s}T${hm}:00+09:00`);
const toDate2 = v => (v instanceof Date ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(v) : null);
const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'];
const shiftSheet = (rows) => {
  const sv = [[], ['', '氏名', '区分', ...days.map(dd)]];
  rows.forEach(([name, shifts]) => { sv.push(['', name, 'シフト', ...shifts]); sv.push(['', '', '出勤前']); sv.push(['', '', '退勤後']); });
  return sv;
};
const both = (name, day) => [[ts2(day, '08:00'), name, '出勤前', '0.14mg/L以下'], [ts2(day, '19:00'), name, '退勤前', '0.14mg/L以下']];

test('GAS: 宛先は種類ごとに出勤者全員／未入力者だけ', () => {
  const sv = shiftSheet([['試験 太郎', Array(6).fill('出勤')], ['試験 花子', Array(6).fill('出勤')], ['試験 次郎', Array(6).fill('公休')]]);
  const fv = [['ts', '氏名', '区分', '結果'], [ts2('2026-10-06', '08:00'), '試験 太郎', '出勤前', '0.14mg/L以下']];
  const d = AC_buildDay({ today: '2026-10-06', sv, fv, toDate: toDate2 });
  assert.deepEqual([...AC_recipientsFor('morning', d)], ['試験 太郎', '試験 花子']);
  assert.deepEqual([...AC_recipientsFor('evening', d)], ['試験 太郎', '試験 花子']);
  assert.deepEqual([...AC_recipientsFor('followBefore', d)], ['試験 花子']);
  assert.deepEqual([...AC_recipientsFor('followAfter', d)], ['試験 太郎', '試験 花子']);
  assert.match(AC_notTargetReason('morning', d, '試験 次郎'), /出勤」ではない/);
  assert.match(AC_notTargetReason('followBefore', d, '試験 太郎'), /入力が確認できた/);
});

test('GAS: 連続記録は出勤日だけを数え、1日でも欠けたらリセット', () => {
  // 太郎：10/6・10/5・10/4はそろい、10/3は公休で飛ばし、10/2は退勤前が欠けて止まる → 3日
  const sv = shiftSheet([['試験 太郎', ['出勤', '出勤', '公休', '出勤', '出勤', '出勤']],
    ['試験 花子', ['出勤', '出勤', '出勤', '出勤', '出勤', '出勤']]]);
  const fv = [['ts', '氏名', '区分', '結果'],
    ...both('試験 太郎', '2026-10-01'), [ts2('2026-10-02', '08:00'), '試験 太郎', '出勤前', '0.14mg/L以下'],
    ...both('試験 太郎', '2026-10-04'), ...both('試験 太郎', '2026-10-05'), ...both('試験 太郎', '2026-10-06'),
    ...days.flatMap(x => both('試験　花子', x))];
  const d = AC_buildDay({ today: '2026-10-06', sv, fv, toDate: toDate2 });
  assert.equal(AC_streak(d, '試験 太郎'), 3);
  assert.equal(AC_streak(d, '試験 花子'), 6);
  const d5 = AC_buildDay({ today: '2026-10-05', sv, fv, toDate: toDate2 });
  assert.deepEqual(JSON.parse(JSON.stringify(AC_thanksTargets(d5).map(t => [t.name, t.streak]))), [['試験 花子', 5]]);
  assert.deepEqual(JSON.parse(JSON.stringify(AC_thanksTargets(d).map(t => t.name))), []);           // 6日目は節目でない
});

test('GAS: 感謝の節目と文面（評価ではなく感謝）', () => {
  assert.deepEqual([5, 10, 20, 30, 40, 50, 60, 70].map(AC_isMilestone), Array(8).fill(true));
  assert.deepEqual([1, 4, 6, 15, 25, 55].map(AC_isMilestone), Array(6).fill(false));
  for (const n of [5, 10, 20, 30, 50, 60]) {
    const m = AC_thanksMessage(n, '2026-10-08');
    assert.match(m, /ありがとうございます/);
    assert.doesNotMatch(m, /優秀|合格|よくできました|頑張っていきましょう/);
  }
  assert.equal(AC_thanksMessage(5, '2026-10-08'), 'お疲れ様です！😊\n\nアルコールチェックの入力が、5勤務日連続となりました！\n\n毎日のご協力ありがとうございます。\n\n引き続きよろしくお願いします！');
  assert.match(AC_thanksMessage(10, '2026-10-08'), /10勤務日連続となりました！✨\n\n継続してのご対応/);
  assert.match(AC_thanksMessage(30, '2026-10-08'), /30勤務日連続となりました！✨\n\nいつもご協力/);
});

test('GAS: 気象庁の予報から天気区分を作り、朝の文面に入れる', () => {
  const jma = (code, weather, pops, temps) => [{ timeSeries: [
    { timeDefines: ['2026-10-08T05:00:00+09:00', '2026-10-09T00:00:00+09:00'], areas: [{ area: { code: '110010' }, weatherCodes: [code, '100'], weathers: [weather, '晴れ'] }] },
    { timeDefines: ['2026-10-08T06:00:00+09:00', '2026-10-08T12:00:00+09:00'], areas: [{ area: { code: '110010' }, pops }] },
    { timeDefines: ['2026-10-08T00:00:00+09:00', '2026-10-08T09:00:00+09:00'], areas: [{ area: { code: '43241' }, temps }] },
  ] }];
  assert.equal(AC_weatherFromJma(jma('100', '晴れ', ['0', '10'], ['15', '26']), '2026-10-08').kind, 'sunny');
  assert.equal(AC_weatherFromJma(jma('300', '雨', ['80', '90'], ['15', '20']), '2026-10-08').kind, 'rain');
  assert.equal(AC_weatherFromJma(jma('101', '晴れ時々くもり', ['0', '60'], ['15', '26']), '2026-10-08').kind, 'rain');
  assert.equal(AC_weatherFromJma(jma('100', '晴れ', ['0', '0'], ['24', '33']), '2026-10-08').kind, 'hot');
  assert.equal(AC_weatherFromJma(jma('200', 'くもり', ['0', '0'], ['2', '9']), '2026-10-08').kind, 'cold');
  assert.equal(AC_weatherFromJma(null, '2026-10-08'), null);
  const w = AC_weatherFromJma(jma('300', '雨', ['80', '90'], ['15', '20']), '2026-10-08');
  assert.match(AC_morningMessage('2026-10-08', w), /^おはようございます！☔\n\n今日は雨の予報です☔ 路面が滑りやすくなりますので、運転にはお気をつけください！（さいたま 最高20℃／最低15℃）\n\n本日も運転前のアルコールチェック[\s\S]*viewform\?usp=dialog\n\n今日も一日、安全運転でよろしくお願いします！🚗$/);
  const plain = AC_morningMessage('2026-10-08', null);
  assert.equal(plain, 'おはようございます！\n\n体調に気をつけて、今日も一日頑張りましょう！\n\n本日も運転前のアルコールチェックと、フォームへの入力をお願いします！\n\n▼ アルコールチェック入力フォーム\nhttps://docs.google.com/forms/d/e/1FAIpQLSemLVglUlSIc44wxMzmd8e9g09KRDXGUruMbZ54kuWrT6ZAhA/viewform?usp=dialog\n\n今日も一日、安全運転でよろしくお願いします！🚗');   // 天気が取れないときは天気に触れない
  const snowy = AC_weatherFromJma(jma('400', '雪', ['50', '80'], ['-1', '3']), '2026-10-08');
  assert.equal(snowy.snow, true);
  assert.equal(snowy.freeze, true);
});

test('GAS: 測定結果が「通常」の値以外の当日回答を拾う', () => {
  const sv = shiftSheet([['試験 太郎', Array(6).fill('出勤')]]);
  const fv = [['ts', '氏名', '区分', '結果'], [ts2('2026-10-06', '08:00'), '試験 太郎', '出勤前', '0.14mg/L以下'],
    [ts2('2026-10-06', '09:00'), '試験 太郎', '出勤前', '0.15mg/L以上'], [ts2('2026-10-05', '09:00'), '試験 太郎', '出勤前', '0.15mg/L以上']];
  const d = AC_buildDay({ today: '2026-10-06', sv, fv, toDate: toDate2 });
  const hits = AC_findAlerts(d, ['0.14mg/L以下']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].row, 3);
});

test('GAS: 0.14mg/L以下は正常、それを超える・読めない結果は要確認', () => {
  for (const s of ['0.14mg/L以下', '0.00', '0.05mg/L', '０．１４', '0.14']) assert.equal(AC_isNormalResult(s, 0.14), true, s);
  for (const s of ['0.15mg/L以上', '0.15', '0.2mg/L', '検知', '要確認', '0.14mg/L超']) assert.equal(AC_isNormalResult(s, 0.14), false, s);
  const sv = shiftSheet([['試験 太郎', Array(6).fill('出勤')]]);
  const fv = [['ts', '氏名', '区分', '結果'], [ts2('2026-10-06', '08:00'), '試験 太郎', '出勤前', '0.14mg/L以下'],
    [ts2('2026-10-06', '09:00'), '試験 太郎', '退勤前', '0.25'], [ts2('2026-10-05', '09:00'), '試験 太郎', '出勤前', '0.25']];
  const d = AC_buildDay({ today: '2026-10-06', sv, fv, toDate: toDate2 });
  const hits = AC_findAlerts(d, [], 0.14);
  assert.deepEqual([...hits.map(h => h.row)], [3]);
});

test('GAS: 機器所持にチェックがある社員番号だけに絞る（架空データ）', () => {
  const inv = [[], ['', '従業員コード', '使用者', '備考', 'LINE追加', '機器郵送先', '機器所持'],
    ['', 90001, '試験 太郎', '', true, '', true], ['', '90002', '試験 花子', '', true, '', false], ['', '', '', '', '', '', true]];
  const codes = AC_deviceCodes(inv);
  assert.deepEqual(Object.keys(codes), ['90001']);
  assert.equal(AC_deviceCodes([['a', 'b']]), null);
  const reg = { '試験太郎': { code: '90001', userId: 'U1' }, '試験花子': { code: '90002', userId: 'U2' } };
  assert.deepEqual(Object.keys(AC_filterRegistryByCodes(reg, codes)), ['試験太郎']);
});

test('GAS: TOTのパターン名をシフト表の区分へ', () => {
  assert.deepEqual(['10:00-19:00', '9:00-13:00', '公休', '希望休', '有給', '', 'keeper検定'].map(AC_totPatternToShift),
    ['出勤', '出勤', '公休', '希望休', '有給', null, '要確認']);
});

test('GAS: TOTのCSVをマスタのTOTコードで結び、シフト表と比べる（架空データ）', () => {
  const m = (code, name, tot, status = '在籍') => { const r = mrow(code, name, { status }); r[11] = '正社員'; r[12] = tot; r[13] = ''; return r; };
  const master = [MASTER_HEADER, m('90001', '試験 太郎', '501'), m('90002', '試験 花子', '502'), m('90003', '試験 退職', '503', '退職')];
  const sv = shiftSheet([['試験 太郎', ['出勤', '公休', '出勤', '出勤', '出勤', '出勤']], ['試験 花子', ['有給', '出勤', '出勤', '出勤', '出勤', '出勤']]]);
  const csv = [['従業員コード', '名前', 'パターン名', '日時（曜日なし）'],
    ['0501', 'x', '10:00-19:00', '2026/10/01'], ['501', 'x', '公休', '2026/10/02'], ['501', 'x', '公休', '2026/10/03'],
    ['502', 'x', '', '2026/10/01'], ['502', 'x', 'keeper検定', '2026/10/02'], ['503', 'x', '公休', '2026/10/01'], ['501', 'x', '公休', '2026/12/01']];
  const items = AC_parseTotCsv(csv);
  assert.equal(items.length, 7);
  const r = AC_buildTotCompare(items, master, sv, toDate2);
  assert.deepEqual([...r.rows.map(x => x[6])], ['違い', '要確認', 'マスタに無い', '未設定', '一致', '一致']);
  assert.equal(r.counts['シフト表に無い'], 1);
  assert.deepEqual(JSON.parse(JSON.stringify(r.updates)), [{ row: 2, col: 5, date: '2026-10-03', value: '公休', code: '90001' }]);
  assert.throws(() => AC_parseTotCsv([['a', 'b']]), /列/);
});

// TOT APIの形（架空データ）
const totR = {
  employees: [{ key: 'k1', code: '0501', lastName: '試験', firstName: '太郎' }, { key: 'k2', code: '0502', lastName: '試験', firstName: '花子' }],
  schedules: [{ date: '2026-10-01', dailySchedules: [
    { date: '2026-10-01', employeeKey: 'k1', scheduleTypeName: '通常勤務', clockInSchedule: '2026-10-01T10:00+09:00', clockOutSchedule: '2026-10-01T19:00+09:00', holidaysObtained: {} },
    { date: '2026-10-01', employeeKey: 'k2', scheduleTypeName: '全日休暇', holidaysObtained: { fulltimeHoliday: { code: '1', name: '有休' } } }] },
    { date: '2026-10-02', dailySchedules: [
    { date: '2026-10-02', employeeKey: 'k1', scheduleTypeName: '全日休暇', holidaysObtained: { fulltimeHoliday: { code: '9', name: '公休' } } }] }],
  workings: [
    { date: '2026-09-30', dailyWorkings: [{ date: '2026-09-30', employeeKey: 'k1', isError: false, isClosing: true, overtime: 600, lateNightOvertime: 0, totalWork: 480, late: 0, earlyLeave: 0, holidaysObtained: { fulltimeHoliday: {} } }] },
    { date: '2026-10-08', dailyWorkings: [
      { date: '2026-10-08', employeeKey: 'k1', isError: true, isClosing: false, overtime: 1500, lateNightOvertime: 400, totalWork: 500, late: 5, earlyLeave: 0, holidaysObtained: { fulltimeHoliday: {} } },
      { date: '2026-10-08', employeeKey: 'k2', isError: false, isClosing: false, overtime: 0, totalWork: 0, holidaysObtained: { fulltimeHoliday: { name: '欠勤' } } }] },
    { date: '2026-10-01', dailyWorkings: [{ date: '2026-10-01', employeeKey: 'k1', isError: true, isClosing: true, overtime: 0, totalWork: 300, holidaysObtained: {} }] }],
};

test('GAS: TOTの勤務予定（API）を時刻・休暇名にし、公休と希望休は同じ休みとして扱う（架空データ）', () => {
  const items = AC_totScheduleItems(totR);
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [
    { tot: '0501', date: '2026-10-01', pattern: '10:00-19:00' }, { tot: '0502', date: '2026-10-01', pattern: '有給' }, { tot: '0501', date: '2026-10-02', pattern: '公休' }]);
  const m = (code, name, tot) => { const r = mrow(code, name); r[11] = ''; r[12] = tot; r[13] = ''; return r; };
  const master = [MASTER_HEADER, m('90001', '試験 太郎', '501'), m('90002', '試験 花子', '502')];
  const sv = shiftSheet([['試験 太郎', ['出勤', '希望休', '出勤', '出勤', '出勤', '出勤']], ['試験 花子', ['出勤', '出勤', '出勤', '出勤', '出勤', '出勤']]]);
  const r = AC_buildTotCompare(items, master, sv, toDate2);
  assert.equal(r.counts['一致'], 2);
  assert.equal(r.counts['違い'], 1);
  assert.equal(r.updates[0].value, '有給');
});

test('GAS: 打刻漏れ等（エラー勤務・7日以内）と今月の残業を拾う（架空データ）', () => {
  const f = AC_attendanceFindings(totR, '2026-10-09');
  assert.deepEqual(JSON.parse(JSON.stringify(f.punchErrors)), [{ tot: '0501', date: '2026-10-08' }]);   // 10/1は8日前なので対象外
  assert.equal(f.overtime['0501'], 1900);   // 9月分は含めない
  assert.match(AC_punchMessage('2026-10-08', {}), /10\/8（木）の勤怠について、打刻が確認できていません/);
  assert.match(AC_overtimeMessage(1900, 30, '2026-10-08'), /30時間に達しましたので、お知らせします📢\n\n現在の残業時間：31\.6時間/);
  assert.match(AC_overtimeMessage(2800, 45, '2026-10-08'), /45時間/);
});

test('GAS: 勤怠の本人通知先はLINE確認済み・在籍の人だけ、TOTコードで引く（架空データ）', () => {
  const m = (code, name, tot, opt) => { const r = mrow(code, name, opt); r[11] = ''; r[12] = tot; r[13] = ''; return r; };
  const master = [MASTER_HEADER, m('90001', '試験 太郎', '501', { userId: uid(1), alcohol: false }), m('90002', '試験 花子', '502', { userId: uid(2), ok: false }),
    m('90003', '試験 三郎', '503', { userId: uid(3), status: '退職' })];
  assert.deepEqual(Object.keys(AC_lineByTotCode(master, '2026-10-09')), ['501']);
});

test('GAS: 勤怠チェック表（前月・今月、昨日まで）（架空データ）', () => {
  const m = (code, name, tot) => { const r = mrow(code, name); r[11] = ''; r[12] = tot; r[13] = ''; return r; };
  const rows = [...AC_attendanceReport(totR, [MASTER_HEADER, m('90001', '試験 太郎', '501')], '2026-10-09')].map(r => [...r]);
  assert.deepEqual(rows[0], ['2026-10', '90001', '試験 太郎', '501', 2, 31.7, 1, 0, 0, 0, 2, 1, '済']);
  assert.ok(rows.some(r => r[0] === '2026-10' && /マスタに無い/.test(r[2]) && r[9] === 1));
  assert.ok(rows.some(r => r[0] === '2026-09' && r[5] === 10));
});

test('GAS: シフト表が空欄の日は、TOTの「公休」では埋めない（出勤・有給は埋める）', () => {
  const m = (code, name, tot) => { const r = mrow(code, name); r[11] = ''; r[12] = tot; r[13] = ''; return r; };
  const sv = shiftSheet([['試験 太郎', ['', '', '出勤', '出勤', '出勤', '出勤']]]);
  const r = AC_buildTotCompare([{ tot: '501', date: '2026-10-01', pattern: '公休' }, { tot: '501', date: '2026-10-02', pattern: '10:00-19:00' }],
    [MASTER_HEADER, m('90001', '試験 太郎', '501')], sv, toDate2);
  assert.equal(r.counts['未設定'], 1);
  assert.equal(r.updates.length, 1);
  assert.equal(r.updates[0].value, '出勤');
});

test('GAS: 天候・気温の気遣いは朝の案内だけ（それ以外の通知には入れない）', () => {
  const w = (o) => Object.assign({ kind: 'cloudy', max: 20, min: 12, snow: false, wind: false, freeze: false, swing: false }, o);
  const care = o => AC_careLine('morning', '2026-10-08', { weather: o }).text;
  assert.match(care(w({ kind: 'rain', wind: true })), /^今日は雨の予報です☔/);         // 雨が強風より先
  assert.match(care(w({ kind: 'cold', snow: true })), /^雪や路面の凍結/);              // 雪・凍結が最優先
  assert.match(care(w({ kind: 'hot', max: 36 })), /^今日はかなり暑くなりそうです☀️/);  // 猛暑（35℃以上）
  assert.match(care(w({ kind: 'hot', max: 32 })), /^今日は気温が高くなる予報です/);
  assert.match(care(w({ kind: 'cold' })), /^今日は冷え込む予報です/);
  assert.match(care(w({ swing: true })), /^朝晩と日中の気温差/);
  assert.match(care(w({ wind: true })), /^今日は風が強い予報です/);
  assert.equal(care(w({ kind: 'sunny' })), '体調に気をつけて、今日も一日頑張りましょう！');
  assert.equal(AC_careLine('morning', '2026-10-08', { weather: w({ kind: 'sunny' }) }).usedWeather, false);
  assert.equal(care(null), '体調に気をつけて、今日も一日頑張りましょう！');                // 天気が取れない日
  for (const k of ['followBefore', 'evening', 'followAfter', 'punch', 'todayNoClockOut', 'todayNoClockIn', 'ot30', 'ot45', 'thanks']) {
    assert.equal(AC_careLine(k, '2026-12-08', { weather: w({ kind: 'rain' }), infection: 'インフルエンザ' }).text, '', k);
  }
  assert.match(AC_overtimeMessage(2800, 45, '2026-10-08'), /^お疲れ様です。\n\n今月の残業時間が45時間[\s\S]*上長とご相談ください。/);
  assert.match(AC_render('ot45Admin', '2026-10-08', { name: '試験 太郎', code: '90001', hours: '46.6' }), /36協定[\s\S]*業務量の調整/);
  const alert = AC_render('alcoholAlert', '2026-10-08', { time: '08:00', name: '試験 太郎', label: '出勤前', result: '0.20' });
  assert.match(alert, /^【アルコール検知のお知らせ】[\s\S]*運転を開始・継続させず/);
  assert.doesNotMatch(alert, /天気|ありがとう/);
});

test('GAS: 「LINE文面」シートの上書き（空欄は既定、||で日替わり）', () => {
  const ov = { followAfter: ['A {care}', 'B'], normal: ['ふだんの一言（上書き）'] };
  assert.ok(['A', 'B'].includes(AC_render('followAfter', '2026-10-08', {}, ov)));
  assert.match(AC_messageFor('morning', '2026-10-08', null, {}, ov), /ふだんの一言（上書き）/);
  assert.match(AC_messageFor('evening', '2026-10-08', null, {}, ov), /退勤前/);   // 上書きの無いキーは既定
});

test('GAS: 気遣いは朝の案内の1通だけ（同じ日の2通目以降は入れない）', () => {
  const w = { kind: 'rain', max: 20, min: 12, snow: false, wind: false, freeze: false, swing: false };
  assert.match(AC_composeMessage('morning', '2026-10-08', { weather: w }).text, /雨/);
  const again = AC_composeMessage('morning', '2026-10-08', { weather: w, careUsed: true }).text;
  assert.match(again, /^おはようございます！\n\n本日も運転前のアルコールチェック/);   // 気遣いが空でも空行が続かない
  assert.doesNotMatch(AC_composeMessage('followBefore', '2026-10-08', { weather: w }).text, /雨|路面/);
});

test('GAS: 当日の勤怠状況（22:30）：退勤の打刻なし・出勤の打刻なしを見つけ、やさしい文面にする', () => {
  const R = {
    employees: [{ key: 'k1', code: '0001' }, { key: 'k2', code: '0002' }, { key: 'k3', code: '0003' }, { key: 'k4', code: '0004' }],
    timerecord: [{ date: '2026-10-14', dailyWorkings: [
      { date: '2026-10-14', employeeKey: 'k1', timeRecord: [{ code: '1' }] },
      { date: '2026-10-14', employeeKey: 'k2', timeRecord: [{ code: '1' }, { code: '2' }] },
    ] }],
    schedules: [{ date: '2026-10-14', dailySchedules: [
      { date: '2026-10-14', employeeKey: 'k2', clockInSchedule: '2026-10-14T09:00:00+09:00' },
      { date: '2026-10-14', employeeKey: 'k3', clockInSchedule: '2026-10-14T09:00:00+09:00' },
      { date: '2026-10-14', employeeKey: 'k4' },
    ] }],
  };
  const r = JSON.parse(JSON.stringify(AC_todayStatus(R, '2026-10-14')));
  assert.deepEqual(r, [{ tot: '0001', kind: 'noClockOut' }, { tot: '0003', kind: 'noClockIn' }]);
  const out = AC_todayStatusMessage('noClockOut', '2026-10-14', {}, {});
  assert.match(out, /現在も勤務中の場合は、退勤時の打刻を忘れずにお願いします！/);
  assert.match(out, /Touch On Timeから打刻修正の申請[\s\S]*遅い時間までお疲れ様です。\n体調にもお気をつけください😊$/);   // 打刻は本人がTOTで申請できる
  const inMsg = AC_todayStatusMessage('noClockIn', '2026-10-14', {}, {});
  assert.match(inMsg, /Touch On Timeから打刻修正の申請[\s\S]*上長の承認を得たうえで、勤怠連絡フォームから報告[\s\S]*▼ 勤怠連絡フォーム\nhttps:[^\n]*viewform\n\nよろしくお願いします！$/);   // 休みへの変更はフォーム
});

test('GAS: LINE送信数のお知らせは80・95・100％の段階で、上限なしなら知らせない', () => {
  assert.equal(AC_quotaLevel(5000, 3999), 0);
  assert.equal(AC_quotaLevel(5000, 4000), 80);
  assert.equal(AC_quotaLevel(5000, 4750), 95);
  assert.equal(AC_quotaLevel(5000, 5000), 100);
  assert.equal(AC_quotaLevel(0, 9999), 0);
});

test('GAS: 翌月シフトの反映は翌月の日付だけ・数式のセルは書き換えない', () => {
  assert.equal(AC_nextMonth('2026-10-28'), '2026-11');
  assert.equal(AC_nextMonth('2026-12-28'), '2027-01');
  // 反映は月末（翌日が翌月1日）だけ
  for (const d of ['2026-10-31', '2026-11-30', '2027-02-28', '2028-02-29', '2026-12-31']) assert.equal(AC_isMonthEnd(d), true, d);
  for (const d of ['2026-10-28', '2026-10-30', '2028-02-28', '2026-11-01']) assert.equal(AC_isMonthEnd(d), false, d);
  const updates = [
    { row: 2, col: 3, date: '2026-11-01', value: '10:00-19:00' },
    { row: 2, col: 4, date: '2026-11-02', value: '公休' },
    { row: 3, col: 3, date: '2026-10-31', value: '公休' },
  ];
  const formulas = [[], [], ['', '', '', '', '=A1'], []];
  const r = JSON.parse(JSON.stringify(AC_monthlyApplyPlan(updates, formulas, '2026-11')));
  assert.deepEqual(r.apply.map(u => u.date), ['2026-11-01']);
  assert.deepEqual(r.skipped.map(u => u.date), ['2026-11-02']);
});

test('GAS: 36協定（特別条項あり）の見守り', () => {
  assert.equal(AC_addMonths('2026-01', -2), '2025-11');
  assert.equal(AC_addMonths('2026-11', 3), '2027-02');
  const H = h => h * 60;
  // 問題なし
  assert.equal(AC_agreementCheck({ '2026-10': { overtime: H(20) } }, 4, '2026-10').length, 0);
  // 今月 時間外90h＋休日15h → 100h以上で超過、2か月平均も超過
  const r = JSON.parse(JSON.stringify(AC_agreementCheck({ '2026-10': { overtime: H(90), holiday: H(15) }, '2026-09': { overtime: H(70) } }, 4, '2026-10')));
  assert.equal(r.find(x => x.kind === 'month100').level, 'over');
  assert.equal(r.find(x => x.kind === 'avg80').level, 'over');
  // 45h超が今年度6回 → 注意、7回 → 超過（起算月4月）
  const m6 = {}; ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].forEach(k => { m6[k] = { overtime: H(46) }; });
  assert.equal(AC_agreementCheck(m6, 4, '2026-10').find(x => x.kind === 'over45').level, 'warn');
  m6['2026-10'] = { overtime: H(46) };
  assert.equal(AC_agreementCheck(m6, 4, '2026-10').find(x => x.kind === 'over45').level, 'over');
  // 起算月より前の月は数えない
  assert.equal(AC_agreementCheck({ '2026-03': { overtime: H(500) }, '2026-10': { overtime: H(10) } }, 4, '2026-10').find(x => x.kind === 'year720'), undefined);
});

test('GAS: 有給の年5日（入社6か月後が基準日）', () => {
  assert.equal(AC_paidLeavePeriod('2026-06-01', '2026-10-14'), null);   // まだ付与前
  assert.deepEqual({ ...AC_paidLeavePeriod('2025-04-01', '2026-10-14') }, { start: '2026-10-01', end: '2027-09-30' });
  assert.deepEqual({ ...AC_paidLeavePeriod('2025-08-31', '2026-10-14') }, { start: '2026-02-28', end: '2027-02-27' });
  const p = { start: '2025-11-01', end: '2026-10-31' };
  assert.equal(AC_paidLeaveCheck(p, 5, '2026-10-14'), null);
  assert.equal(AC_paidLeaveCheck(p, 2, '2026-10-14').level, 'over');
  assert.equal(AC_paidLeaveCheck(p, 2, '2026-10-14').need, 3);
  assert.equal(AC_paidLeaveCheck({ start: '2026-04-01', end: '2027-03-31' }, 0, '2026-10-14'), null);   // まだ半年近くある
  assert.equal(AC_paidLeaveCheck({ start: '2026-02-01', end: '2027-01-31' }, 1, '2026-10-14').level, 'warn');
});

test('GAS: 月別勤怠・承認待ちの申請・有給の取得状況を組み立てる（架空データ）', () => {
  const emp = [{ key: 'k1', code: '0001', hiredDate: '2025-04-01' }, { key: 'k2', code: '0002', hiredDate: '2026-09-01' }];
  const m = JSON.parse(JSON.stringify(AC_monthlyByTot(emp, [
    { year: 2026, month: 10, employeeKey: 'k1', overtime: 600, nightOvertime: 60, legalHolidayWork: { normal: 480, night: 0, overtime: 0, nightOvertime: 0 } },
    { _error: 403 },
  ])));
  assert.deepEqual(m, { '0001': { '2026-10': { overtime: 660, holiday: 480 } } });
  const p = JSON.parse(JSON.stringify(AC_pendingRequests(emp, [
    { type: 'timerecords', status: 'applying', employeeKey: 'k1', date: '2026-10-02', requestedDate: '2026-10-03T10:00:00+09:00', requestKey: 'r1' },
    { type: 'timerecords', status: 'applying', employeeKey: 'k1', date: '2026-10-02', requestedDate: '2026-10-03T10:00:00+09:00', requestKey: 'r1' },
    { type: 'schedules', status: 'approved', employeeKey: 'k2', date: '2026-10-05', requestKey: 'r2' },
  ])));
  assert.deepEqual(p, [{ tot: '0001', type: '打刻申請', date: '2026-10-02', requestedDate: '2026-10-03' }]);
  const st = JSON.parse(JSON.stringify(AC_paidLeaveStatus(emp, [
    { employeeKey: 'k1', date: '2026-10-05', days: 1 }, { employeeKey: 'k1', date: '2026-09-20', days: 1 }, { employeeKey: 'k1', date: '2026-10-06', days: 0.5 },
  ], '2026-10-14')));
  assert.equal(st.length, 1);   // k2 はまだ付与前
  assert.equal(st[0].period.start, '2026-10-01');
  assert.equal(st[0].used, 1.5);   // 期間開始前の9/20は数えない
});

test('GAS: お知らせ停止（期間中はその人に送らない）', () => {
  const toDate = v => String(v || '').slice(0, 10) || null;
  const idx = AC_pauseIndex([['社員番号'], ['90001', '試験 太郎', '2026-10-14', '2026-10-21', ''], ['90002', '試験 花子', '2026-10-01', '', ''], ['', '', '2026-10-01', '', '']], toDate);
  assert.equal(AC_isPaused(idx, '90001', '2026-10-15'), true);
  assert.equal(AC_isPaused(idx, '90001', '2026-10-22'), false);
  assert.equal(AC_isPaused(idx, '90001', '2026-10-13'), false);
  assert.equal(AC_isPaused(idx, '90002', '2027-01-01'), true);   // 終了日なし
  assert.equal(AC_isPaused(idx, '90003', '2026-10-15'), false);
  const master = [MASTER_HEADER, mrow('90001', '試験 太郎'), mrow('90002', '試験 花子')];
  assert.deepEqual(Object.keys(AC_pausedNames(master, idx, '2026-10-25')), [ctx.module.exports.AC_normalizeName('試験 花子')]);
});

test('GAS: 勤怠連絡フォーム（選択肢・期間・区分ごとの止め方）', () => {
  const master = [MASTER_HEADER, mrow('90010', '試験 次郎'), mrow('90002', '試験 花子'), mrow('90003', '試験 退職', { status: '退職' })];
  assert.deepEqual([...AC_formChoices(master)], ['試験 花子（90002）', '試験 次郎（90010）']);
  assert.equal(AC_codeFromChoice('試験 花子（90002）'), '90002');
  const a = AC_formPlan({ by: '上司 一郎', who: '試験 花子（90002）', kind: '欠勤', from: '2026-10-16', until: '', reason: '体調不良' });
  assert.equal(a.code, '90002'); assert.equal(a.until, '2026-10-16'); assert.equal(a.pause.scope, '全部');
  assert.match(a.text, /試験 花子さん[\s\S]*2026-10-16[\s\S]*止めました/);
  const b = AC_formPlan({ by: 'x', who: '試験 花子（90002）', kind: '打刻の修正', from: '2026-10-20', until: '2026-10-18', reason: '' });
  assert.equal(b.from, '2026-10-18'); assert.equal(b.until, '2026-10-20'); assert.equal(b.pause.scope, '勤怠のみ');
  assert.equal(AC_formPlan({ by: 'x', who: '試験 花子（90002）', kind: '遅刻', from: '2026-10-16' }).pause, null);
  // 休みの変更：新しく休む日だけ止める。変更後の日が無ければ止めない
  const c = AC_formPlan({ by: 'x', who: '試験 花子（90002）', kind: '休みの変更（シフト交換など）', from: '2026-10-20', changeTo: '2026-10-22', reason: '' });
  assert.equal(c.from, '2026-10-22'); assert.equal(c.until, '2026-10-22'); assert.equal(c.pause.scope, '全部');
  assert.match(c.text, /2026-10-20（もともとの休み）→ 2026-10-22/);
  const d = AC_formPlan({ by: 'x', who: '試験 花子（90002）', kind: '休みの変更（シフト交換など）', from: '2026-10-20', reason: '' });
  assert.equal(d.pause, null); assert.match(d.text, /書かれていなかった/);
  // 「勤怠のみ」はアルコールチェックを止めない
  const toDate = v => String(v || '').slice(0, 10) || null;
  const idx = AC_pauseIndex([['h'], ['90002', '', '2026-10-18', '2026-10-20', '', '勤怠のみ']], toDate);
  assert.equal(AC_isPaused(idx, '90002', '2026-10-19'), true);
  assert.equal(AC_isPaused(idx, '90002', '2026-10-19', 'alcohol'), false);
});

test('GAS: 部門のグループLINE（登録コマンド・部門名・送り先）', () => {
  assert.deepEqual([...AC_parseDeptRegistration('部門登録 第一営業部')], ['第一営業部']);
  assert.deepEqual([...AC_parseDeptRegistration('部門登録：A店、B店')], ['A店', 'B店']);
  assert.equal(AC_parseDeptRegistration('おはようございます'), null);
  assert.equal(AC_parseDeptRegistration('部門登録'), null);
  const r = (code, dept, status = '在籍') => { const x = mrow(code, '試験 ' + code, { status }); x[4] = dept; return x; };
  assert.deepEqual([...AC_deptNames([MASTER_HEADER, r('1', 'A店'), r('2', 'B店'), r('3', 'A店'), r('4', 'C店', '退職')])], ['A店', 'B店']);
  const g = JSON.parse(JSON.stringify(AC_groupsByDept([['h'], ['Cg1', 'A店、B店', '', '有効'], ['Cg2', 'A店', '', '退出'], ['Cg3', 'B店', '', '有効']])));
  assert.deepEqual(g, { 'A店': ['Cg1'], 'B店': ['Cg1', 'Cg3'] });
  const plan = AC_formPlan({ by: '上司', who: '試験 花子（90002）', kind: '欠勤', from: '2026-10-16', reason: '体調不良' });
  assert.match(plan.groupText, /試験 花子さん[\s\S]*欠勤[\s\S]*体調不良[\s\S]*上司さん/);
  assert.equal(plan.groupText, '【勤怠変更の報告】\n・氏名：試験 花子さん\n・区分：欠勤\n・日付：2026-10-16\n・理由：体調不良\n・報告者：上司さん'
    + '\n\n上記の勤怠変更について報告がありました。\n内容をご確認いただきますようお願いいたします。');
  assert.doesNotMatch(plan.groupText + plan.text, /ありがとう/);   // 業務連絡には感謝の言葉を付けない
  // 承認者：上司が入力したときは行を出さない。ご本人の入力なら承認者を載せ、未記入なら管理者に確認を促す
  assert.doesNotMatch(plan.groupText, /承認者/);
  const own = AC_formPlan({ by: '試験花子', approver: '上司 一郎', who: '試験 花子（90002）', kind: '有給休暇', from: '2026-10-16', reason: '私用' });
  assert.equal(own.self, true);
  assert.match(own.groupText, /・報告者：試験花子さん\n・承認者：上司 一郎さん\n\n上記/);
  const noAp = AC_formPlan({ by: '試験 花子', who: '試験 花子（90002）', kind: 'その他', from: '2026-10-16', reason: 'x' });
  assert.match(noAp.groupText, /・承認者：（未記入）/);
  assert.match(noAp.text, /承認者が書かれていません/);
  // テスト期間：先頭に【テスト】、お知らせは止めない
  const tp = AC_formPlan({ by: '上司', who: '試験 花子（90002）', kind: '欠勤', from: '2026-10-16', reason: 'x' }, { test: true });
  assert.match(tp.groupText, /^【テスト】\n【勤怠変更の報告】/);
  // 翌月以降の日付：本人から管理本部へ直接連絡する運用なので、管理者向けに一言
  const nx = AC_formPlan({ by: '上司', who: '試験 花子（90002）', kind: '休みの変更（シフト交換など）', from: '2026-11-03', changeTo: '2026-11-05', reason: 'x' }, { today: '2026-10-15' });
  assert.match(nx.text, /翌月以降の日付です/); assert.doesNotMatch(nx.groupText, /翌月以降/);
  assert.doesNotMatch(AC_formPlan({ by: '上司', who: '試験 花子（90002）', kind: '遅刻', from: '2026-10-31', reason: 'x' }, { today: '2026-10-15' }).text, /翌月以降/);
  assert.equal(tp.pause, null); assert.match(tp.text, /テスト期間のため、お知らせは止めていません/);
});

// ---------------- 2026-10-16 追加：翌月シフトの手動実行・設定の確認（架空データのみ） ----------------
const X = ctx.module.exports;

test('GAS: 翌月シフト反映の結果行は、切り出し前と同じ形（自動反映の動きは変えない）', () => {
  const cmp = { rows: [
    ['2026-11-01', '90001', '試験 太郎', '10:00-19:00', '出勤', '公休', '違い'],
    ['2026-11-02', '90001', '試験 太郎', '公休', '公休', '', '違い'],
    ['2026-11-03', '90001', '試験 太郎', '公休', '公休', '公休', '一致'],
    ['2026-10-31', '90001', '試験 太郎', '公休', '公休', '出勤', '違い'],   // 対象の月ではない
  ] };
  const plan = { apply: [{ date: '2026-11-01', code: '90001' }], skipped: [{ date: '2026-11-02', code: '90001' }] };
  const rows = JSON.parse(JSON.stringify(X.AC_monthShiftRows(cmp, plan, '2026-11')));
  assert.deepEqual(rows.map(r => r[7]), ['TOTの値に書き換え（元の値：公休）', '数式のセルのため書き換えなし', '']);
  // 手動：過去の日は書き換えない旨と［手動］を付ける
  const rows2 = JSON.parse(JSON.stringify(X.AC_monthShiftRows(cmp, { apply: [], skipped: [] }, '2026-11',
    { past: [{ date: '2026-11-01', code: '90001' }], label: '［手動］' })));
  assert.equal(rows2[0][7], '過去の日のため書き換えなし');
  assert.equal(rows2[1][7], 'TOTの値に書き換え（元の値：空欄）［手動］');
});

test('GAS: 手動反映の対象月と元データ（翌月分が無い・古いデータでは止める）', () => {
  const emp = [{ code: '1' }];
  const s = (today, results) => JSON.parse(JSON.stringify(X.AC_manualShiftSource({ today, results }, today === '2026-10-31' ? '2026-10-31' : today)));
  // 月末の朝のデータ：翌月分のシフトを使う
  assert.deepEqual(s('2026-10-31', { employees: emp, nextSchedules: [], schedules: [] }), { month: '2026-11', key: 'nextSchedules', today: '2026-10-31' });
  // 月末の夜のデータ（翌月分が入っていない）→ 止める
  assert.ok(X.AC_manualShiftSource({ today: '2026-10-31', results: { employees: emp, schedules: [] } }, '2026-10-31').error);
  // 翌月1日のデータ：当月の予定を使う
  assert.deepEqual(s('2026-11-01', { employees: emp, schedules: [] }), { month: '2026-11', key: 'schedules', today: '2026-11-01' });
  // 月の途中のデータ → 止める
  assert.ok(X.AC_manualShiftSource({ today: '2026-11-15', results: { employees: emp, schedules: [] } }, '2026-11-15').error);
  // 2日以上前のデータ → 止める（月末のデータを翌日に使うのは可）
  assert.ok(!X.AC_manualShiftSource({ today: '2026-10-31', results: { employees: emp, nextSchedules: [] } }, '2026-11-01').error);
  assert.ok(X.AC_manualShiftSource({ today: '2026-10-31', results: { employees: emp, nextSchedules: [] } }, '2026-11-02').error);
  // 読み取りエラーが混ざったデータ・データ無し → 止める
  assert.ok(X.AC_manualShiftSource({ today: '2026-10-31', results: { employees: emp, nextSchedules: [{ _error: 'x' }] } }, '2026-10-31').error);
  assert.ok(X.AC_manualShiftSource(null, '2026-10-31').error);
});

test('GAS: 手動反映では今日より前の日を書き換えない', () => {
  const plan = { apply: [{ date: '2026-11-01' }, { date: '2026-11-02' }, { date: '2026-11-03' }], skipped: [{ date: '2026-11-05' }] };
  const r = JSON.parse(JSON.stringify(X.AC_manualShiftPlan(plan, '2026-11-02')));
  assert.deepEqual(r.apply.map(u => u.date), ['2026-11-02', '2026-11-03']);
  assert.deepEqual(r.past.map(u => u.date), ['2026-11-01']);
  assert.equal(r.skipped.length, 1);
});

test('GAS: プレビューの後にシートが変わったら反映しない（指紋の確認）', () => {
  const sv = [[], [], ['', '試験 太郎', 'シフト', '公休', '出勤']];
  const apply = [{ date: '2026-11-01', code: '90001', row: 2, col: 3, value: '出勤' }];
  const fp = X.AC_manualShiftFingerprint('2026-11', apply, sv);
  assert.equal(fp, X.AC_manualShiftFingerprint('2026-11', apply, sv));
  const edited = [[], [], ['', '試験 太郎', 'シフト', '希望休', '出勤']];   // 人がセルを直した
  assert.notEqual(fp, X.AC_manualShiftFingerprint('2026-11', apply, edited));
  assert.notEqual(fp, X.AC_manualShiftFingerprint('2026-11', [{ ...apply[0], value: '有給' }], sv));   // TOT側が変わった
  const now = 1_000_000_000;
  assert.equal(X.AC_manualRunCheck({ month: '2026-11', fp, at: now - 60_000 }, '2026-11', fp, now), '');
  assert.match(X.AC_manualRunCheck(null, '2026-11', fp, now), /先に/);
  assert.match(X.AC_manualRunCheck({ month: '2026-12', fp, at: now }, '2026-11', fp, now), /月/);
  assert.match(X.AC_manualRunCheck({ month: '2026-11', fp, at: now - 31 * 60_000 }, '2026-11', fp, now), /30分/);
  assert.match(X.AC_manualRunCheck({ month: '2026-11', fp: 'other', at: now }, '2026-11', fp, now), /変わりました/);
});

test('GAS: その月の反映が済んでいるかを結果シートで判定する（文字の日付・日付型の両方）', () => {
  const head = ['日付'];
  assert.equal(X.AC_monthShiftSheetDone([head, ['2026-11-01']], '2026-11', () => null), true);
  assert.equal(X.AC_monthShiftSheetDone([head, ['2026-10-01']], '2026-11', () => null), false);
  assert.equal(X.AC_monthShiftSheetDone([head, [{ d: 1 }]], '2026-11', () => '2026-11-03'), true);
  assert.equal(X.AC_monthShiftSheetDone([head], '2026-11', () => null), false);
  assert.equal(X.AC_monthShiftSheetDone(null, '2026-11'), false);
});

test('GAS: 設定の確認では秘密の値を表示しない・未設定は既定の動きを表示する', () => {
  const secret = 'FAKE-SECRET-VALUE-123';
  const all = { LINE_CHANNEL_ACCESS_TOKEN: secret, TOT_SYNC_SECRET: secret, LINE_ADMIN_USER_ID: 'U' + '1'.repeat(32), EMPLOYEE_MASTER_ID: 'FAKE-ID',
    TEST_CODES: '90001', ATTENDANCE_TEST: 'true', DRY_RUN: 'false', SOMETHING_NEW: secret };
  const text = [...X.AC_settingsReport(all, [{ fn: 'alcoholCheckImportTot', type: '時間主導' }, { fn: 'alcoholCheckAlerts', type: '時間主導' },
    { fn: 'alcoholCheckAlerts', type: '時間主導' }, { fn: 'oldFunction', type: '時間主導' }], { version: 'v1', lastRelay: '2026-10-16', nextMonth: '2026-11' })].join('\n');
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes('U111'));
  assert.ok(!text.includes('FAKE-ID'));
  assert.ok(!text.includes('90001'));
  assert.match(text, /LINE_CHANNEL_ACCESS_TOKEN：設定あり/);
  assert.match(text, /ATTENDANCE_RESPONSE_ID：未設定/);
  assert.match(text, /ATTENDANCE_TEST：true/);
  assert.match(text, /AGREEMENT_START_MONTH：未設定＝4月/);
  assert.match(text, /TOT_MONTHLY_APPLY：未設定＝翌月シフト反映をする/);
  assert.match(text, /そのほかの設定：1件（SOMETHING_NEW/);
  assert.match(text, /alcoholCheckAlerts が2個登録/);
  assert.match(text, /oldFunction.*このコードの関数ではありません/);
  assert.match(text, /旧CSV取り込み/);
  assert.match(text, /コードの版：v1/);
  assert.match(text, /（2026-11）のシフト反映：まだ/);
  assert.equal(typeof X.AC_CODE_VERSION, 'string');
});
