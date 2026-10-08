import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Apps Scriptのファイルを読み込み、純粋関数だけをテストする（架空データのみ）
const ctx = { module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL('../gas/AlcoholCheck.gs', import.meta.url), 'utf8'), ctx);
const { AC_reconcile, AC_buildMessage, AC_parseEmployeeCode, AC_buildRegistry,
  AC_planNotifications, AC_buildPersonalMessage } = ctx.module.exports;

const uid = n => 'U' + String(n).repeat(32).slice(0, 32);   // 架空のLINEユーザーID

test('GAS: 社員番号だけのメッセージを受け付ける（全角数字可、それ以外は無視）', () => {
  assert.equal(AC_parseEmployeeCode('10033'), '10033');
  assert.equal(AC_parseEmployeeCode(' １００３３ '), '10033');
  for (const t of ['おはようございます', '10033です', '123', '1234567', '', null]) {
    assert.equal(AC_parseEmployeeCode(t), null);
  }
});

test('GAS: 登録表は確認済みの行だけ使い、同じ氏名の別登録は使わない', () => {
  const header = ['登録日時', '社員番号', '表示名', 'ID', '氏名', '確認済み'];
  const reg = AC_buildRegistry([header,
    [null, "'90001", 'a', uid(1), '試験 太郎', true],
    [null, '90002', 'b', uid(2), '試験 花子', false],          // 未確認
    [null, '90003', 'c', 'not-an-id', '試験 次郎', true],      // 不正なID
    [null, '90004', 'd', uid(4), '試験 三郎', true],
    [null, '90005', 'e', uid(5), '試験　三郎', true],          // 同じ氏名に別登録 → 使わない
  ]);
  assert.deepEqual(Object.keys(reg), ['試験太郎']);
  assert.deepEqual({ ...reg['試験太郎'] }, { code: '90001', userId: uid(1) });
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
