import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Apps Scriptのファイルを読み込み、純粋関数だけをテストする（架空データのみ）
const ctx = { module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL('../gas/AlcoholCheck.gs', import.meta.url), 'utf8'), ctx);
const { AC_reconcile, AC_buildMessage, AC_parseEmployeeCode, AC_buildRegistry,
  AC_planNotifications, AC_buildPersonalMessage, AC_planRegistration, AC_rosterNames, AC_mergeRoster, AC_nameKey, AC_isValidDate, AC_isRetired, AC_buildTestMessage, AC_namesForCode } = ctx.module.exports;

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

test('GAS: 本人向け文面に日付と区分を入れ、他人の情報を含めない', () => {
  const m = AC_buildPersonalMessage('2026-10-08', '出勤前');
  assert.match(m, /本日（10\/8）の出勤前/);
  assert.doesNotMatch(m, /試験/);
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

test('GAS: テストモードの文面（未実施・実施済み・対象外・マスタに無い）', () => {
  const r = { targets: ['試験 太郎', '試験 花子'], missing: ['試験 太郎'] };
  const names = [...AC_namesForCode([MASTER_HEADER, mrow("'90001", '試験 太郎')], '90001')];
  assert.deepEqual(names, ['試験 太郎']);
  assert.match(AC_buildTestMessage('2026-10-08', '出勤前', '90001', names, r), /^【テスト／試験 太郎さん宛て】\n【アルコールチェック】本日（10\/8）の出勤前/);
  assert.match(AC_buildTestMessage('2026-10-08', '出勤前', '90002', ['試験 花子'], r), /実施済みのため/);
  assert.match(AC_buildTestMessage('2026-10-08', '出勤前', '90003', ['試験 次郎'], r), /対象外/);
  assert.match(AC_buildTestMessage('2026-10-08', '出勤前', '99999', [], r), /見つかりません/);
});
