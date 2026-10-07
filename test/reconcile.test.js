import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, japanDate } from '../src/reconcile.js';

const date = '2026-10-07';
const person = (schedule = 'work', clockedIn = true, employeeCode = '001') => ({ date, employeeCode, schedule, clockedIn });
const check = (overrides = {}) => ({ date, employeeCode: '001', checkType: 'beforeWork', completed: true, ...overrides });
const run = (attendance = [person()], checks = []) => reconcile({ date, checkType: 'beforeWork', attendance, checks });

test('打刻済みの未実施者だけが確認用候補になる', () => {
  const rows = run([person(), person('work', true, '002')], [check()]);
  assert.equal(rows[0].checkStatus, '実施済み');
  assert.equal(rows[0].notificationCandidate, false);
  assert.equal(rows[1].checkStatus, '未実施');
  assert.equal(rows[1].notificationCandidate, true);
});
test('公休・有給・出勤予定未打刻・不明を区別し、候補にしない', () => {
  for (const [schedule, label] of [['publicHoliday', '公休'], ['paidLeave', '有給'], ['work', '出勤予定・未打刻'], ['unknown', '要確認']]) {
    const [row] = run([person(schedule, false)]);
    assert.equal(row.attendanceStatus, label);
    assert.equal(row.notificationCandidate, false);
  }
});
test('前日・別区分・未完了の記録では実施済みにならない', () => {
  for (const overrides of [{ date: '2026-10-06' }, { checkType: 'afterWork' }, { completed: false }]) {
    assert.equal(run(undefined, [check(overrides)])[0].notificationCandidate, true);
  }
});
test('従業員コードの先頭ゼロを保持し、別人と混同しない', () => {
  assert.equal(run(undefined, [check({ employeeCode: '1' })])[0].notificationCandidate, true);
});
test('打刻と全日休暇の不一致は要確認とする', () => {
  for (const schedule of ['paidLeave', 'publicHoliday']) {
    const [row] = run([person(schedule)]);
    assert.equal(row.reviewRequired, true);
    assert.equal(row.notificationCandidate, false);
  }
});
test('一部休暇でも打刻済みなら出勤、未打刻なら要確認', () => {
  assert.equal(run([person('partialLeave')])[0].target, true);
  assert.equal(run([person('partialLeave', false)])[0].reviewRequired, true);
});
test('必須不備や同じ人・同日の重複があれば全体を中止する', () => {
  for (const attendance of [[person(), person()], [{ ...person(), employeeCode: 1 }], [{ ...person(), date: '2026-02-30' }], [{ ...person(), clockedIn: undefined }]]) {
    assert.throws(() => run(attendance), /処理を中止/);
  }
  assert.throws(() => run(undefined, [check({ completed: undefined })]), /処理を中止/);
  assert.throws(() => reconcile({ date, checkType: 'beforeWork', attendance: null, checks: [] }), /処理を中止/);
});
test('別日の出勤を当日の対象にしない', () => {
  assert.deepEqual(run([{ ...person(), date: '2026-10-06' }]), []);
});
test('日本時間の日付境界', () => {
  assert.equal(japanDate(new Date('2026-10-06T14:59:59Z')), '2026-10-06');
  assert.equal(japanDate(new Date('2026-10-06T15:00:00Z')), '2026-10-07');
});
