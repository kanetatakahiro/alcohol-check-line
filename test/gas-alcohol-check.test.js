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
  AC_attendanceFindings, AC_lineByTotCode, AC_attendanceReport, AC_punchMessage, AC_overtimeMessage, AC_careLine, AC_render } = ctx.module.exports;

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

test('GAS: 本人向け文面（管理本部の標準ルール：丁寧で親しみやすく、責めない、他人の情報を含めない）', () => {
  const fb = AC_messageFor('followBefore', '2026-10-08', null);
  assert.match(fb, /本日の出勤前アルコールチェックについて、フォームへの入力が確認できておりませんでした/);
  assert.match(fb, /すでに実施済みの場合は、お手数ですが入力をお願いいたします/);
  assert.match(fb, /まだ実施していない場合は、これから運転する前に必ず実施/);   // 実施済み／未実施を分けて案内
  assert.match(AC_messageFor('followAfter', '2026-10-08', null), /本日もお仕事お疲れ様でした/);
  assert.match(AC_messageFor('evening', '2026-10-08', null), /本日もお仕事ありがとうございます[\s\S]*退勤前のアルコールチェック/);
  const avoid = /バタバタしますよね|つい忘れちゃいますよね|気にしすぎなくて大丈夫|体を大事にしてくださいね|一緒に頑張りましょう|もう少しだけお待ちくださいね|至急入力|未実施です/;
  for (const k of ['morning', 'followBefore', 'evening', 'followAfter']) {
    const m = AC_messageFor(k, '2026-10-08', null);
    assert.doesNotMatch(m, avoid);
    assert.doesNotMatch(m, /試験|\n{3,}|\{/);   // 差し込み漏れ・空行の連続がない
  }
  for (const m of [AC_punchMessage('2026-10-08', null), AC_overtimeMessage(1900, 30, '2026-10-08'), AC_overtimeMessage(2800, 45, '2026-10-08'),
    AC_thanksMessage(5, '2026-10-08'), AC_render('follow', '2026-10-08', {}), AC_render('registered', '2026-10-08', { code: '90001' })]) {
    assert.doesNotMatch(m, avoid);
    assert.doesNotMatch(m, /\{/);
  }
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
    assert.match(m, /ありがとう/);
    assert.doesNotMatch(m, /優秀|合格|よくできました|頑張っていきましょう/);
  }
  assert.match(AC_thanksMessage(5, '2026-10-08'), /5勤務日連続でのご対応ありがとうございます/);
  assert.match(AC_thanksMessage(30, '2026-10-08'), /30勤務日連続/);
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
  assert.match(AC_morningMessage('2026-10-08', w), /^おはようございます！☔[\s\S]*最高20℃／最低15℃）\n路面が滑りやすく[\s\S]*アルコールチェック/);
  const plain = AC_morningMessage('2026-10-08', null);
  assert.match(plain, /^おはようございます！\n/);
  assert.doesNotMatch(plain, /晴れ|雨|℃|冷え込/);                       // 天気が取れないときは天気に触れない（推測しない）
  assert.match(plain, /ありがとうございます/);                          // 代わりに日頃の感謝
  assert.notEqual(AC_morningMessage('2026-10-08', null), AC_morningMessage('2026-10-09', null)); // 日によって言い回しが変わる
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
  assert.deepEqual(JSON.parse(JSON.stringify(r.updates)), [{ row: 2, col: 5, date: '2026-10-03', value: '公休' }]);
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
  assert.match(AC_punchMessage('2026-10-08', null), /10\/8（木）の打刻が確認できませんでした/);
  assert.match(AC_overtimeMessage(1900, 30, '2026-10-08'), /30時間に達しましたので[\s\S]*現在 31\.6時間/);
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

test('GAS: 気遣いの一文は優先順に1つ・天気の話は1人1日1回・残業や検知には入れない', () => {
  const w = (o) => Object.assign({ kind: 'cloudy', max: 20, min: 12, snow: false, wind: false, freeze: false, swing: false }, o);
  assert.match(AC_careLine('morning', '2026-10-08', { weather: w({ kind: 'rain', wind: true }) }).text, /雨の予報|雨が降りそう/);   // 安全（雨）が強風より先
  assert.match(AC_careLine('morning', '2026-10-08', { weather: w({ kind: 'cold', snow: true }) }).text, /路面|雪/);                // 雪が寒さより先
  assert.match(AC_careLine('morning', '2026-10-08', { weather: w({ kind: 'hot', max: 34 }) }).text, /水分補給/);
  assert.match(AC_careLine('morning', '2026-10-08', { weather: w({ swing: true }) }).text, /気温差/);
  assert.match(AC_careLine('morning', '2026-10-08', { weather: w({}), infection: 'インフルエンザ' }).text, /インフルエンザが流行しているようですので/);
  assert.equal(AC_careLine('morning', '2026-10-08', { weather: w({}), infection: 'インフルエンザ', infectionUsed: true }).usedInfection, false);
  const again = AC_careLine('followBefore', '2026-10-08', { weather: w({ kind: 'rain' }), weatherUsed: true });
  assert.equal(again.text, '');                                                                   // 朝に天気の話をした人には繰り返さない
  assert.equal(AC_careLine('ot30', '2026-10-08', { weather: w({ kind: 'cold' }) }).text, '');
  assert.match(AC_punchMessage('2026-10-08', w({ kind: 'cold' })), /寒い中、いつもお仕事ありがとうございます/);
  assert.match(AC_punchMessage('2026-10-08', null), /いつも業務へのご協力ありがとうございます[\s\S]*10\/8（木）の打刻が確認できませんでした/);
  assert.match(AC_overtimeMessage(2800, 45, '2026-10-08'), /上長とご相談をお願いいたします/);
  assert.match(AC_render('ot45Admin', '2026-10-08', { name: '試験 太郎', code: '90001', hours: '46.6' }), /36協定[\s\S]*業務量の調整/);
  const alert = AC_render('alcoholAlert', '2026-10-08', { time: '08:00', name: '試験 太郎', label: '出勤前', result: '0.20' });
  assert.match(alert, /^【アルコール検知のお知らせ】[\s\S]*運転を開始・継続させず/);
  assert.doesNotMatch(alert, /天気|ありがとう/);
});

test('GAS: 「LINE文面」シートの上書き（空欄は既定、||で日替わり）', () => {
  const ov = { followAfter: ['A {care}', 'B'], thanks: ['いつもありがとうございます（上書き）'] };
  assert.ok(['A', 'B'].includes(AC_render('followAfter', '2026-10-08', {}, ov)));
  assert.match(AC_messageFor('morning', '2026-10-08', null, {}, ov), /上書き/);
  assert.match(AC_messageFor('evening', '2026-10-08', null, {}, ov), /退勤前/);   // 上書きの無いキーは既定
});
