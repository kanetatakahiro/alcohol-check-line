import test from 'node:test';
import assert from 'node:assert/strict';
import { runRelay, plan, pickPaidLeaves, collect, addMonths } from '../src/tot-relay.js';

// 架空データのみ
test('TOT中継: 取得範囲（シフト31日分・勤務は前月1日から昨日まで）', () => {
  const p = plan('2026-01-05');
  assert.ok(p.find(x => x.name === 'schedules').path.includes('start=2026-01-05&end=2026-02-04'));
  assert.ok(p.find(x => x.name === 'workings').path.includes('start=2025-12-01&end=2026-01-04'));
});

test('TOT中継: 取得結果を合言葉付きで送り、ログには件数と状態だけ', async () => {
  const calls = [], logs = [];
  const fetchImpl = async (url, opt) => {
    calls.push({ url, opt });
    if (url.startsWith('https://script.google.com')) return { ok: true, status: 200, text: async () => 'OK {}' };
    if (url.includes('/daily-schedules')) return { ok: false, status: 403, json: async () => ({ errors: [{ code: 100, message: '認証に失敗しました' }] }) };
    return { ok: true, status: 200, json: async () => [{ key: 'k1', code: '0501', lastName: '試験' }] };
  };
  await runRelay({ env: { TOT_ACCESS_TOKEN: 't', GAS_WEBAPP_URL: 'https://script.google.com/macros/s/abc/exec', TOT_SYNC_SECRET: 's' },
    fetchImpl, now: () => new Date('2026-10-13T22:00:00Z'), wait: async () => {}, log: m => logs.push(m) });
  const body = JSON.parse(calls.at(-1).opt.body);
  assert.equal(body.secret, 's');
  assert.equal(body.results.schedules._error, 403);
  assert.equal(body.results.employees[0].code, '0501');
  assert.ok(!logs.join('').includes('試験'));
});

test('TOT中継: 設定不足・利用禁止時間帯では止まる', async () => {
  await assert.rejects(runRelay({ env: {} }), /\.env/);
  await assert.rejects(runRelay({ env: { TOT_ACCESS_TOKEN: 't', GAS_WEBAPP_URL: 'https://script.google.com/macros/s/abc/exec', TOT_SYNC_SECRET: 's' },
    fetchImpl: async () => ({ ok: true }), now: () => new Date('2026-10-14T00:00:00Z') }), /禁止時間帯/);
});

test('TOT中継: 夜（20時以降）は今日の打刻まで取る', () => {
  assert.ok(plan('2026-10-14', 'night').find(x => x.name === 'timerecord').path.endsWith('end=2026-10-14'));
  assert.ok(plan('2026-10-14').find(x => x.name === 'timerecord').path.endsWith('end=2026-10-13'));
});

test('TOT中継: 28日以降の朝だけ翌月1日〜末日のシフトも取る', () => {
  assert.equal(plan('2026-10-27').find(x => x.name === 'nextSchedules'), undefined);
  assert.equal(plan('2026-10-28', 'night').find(x => x.name === 'nextSchedules'), undefined);
  assert.ok(plan('2026-10-28').find(x => x.name === 'nextSchedules').path.endsWith('start=2026-11-01&end=2026-11-30'));
  assert.ok(plan('2026-12-31').find(x => x.name === 'nextSchedules').path.endsWith('start=2027-01-01&end=2027-01-31'));
  assert.ok(plan('2027-01-28').find(x => x.name === 'nextSchedules').path.endsWith('start=2027-02-01&end=2027-02-28'));
});

test('TOT中継: 朝は月別勤怠12か月と申請（今月・前月）、月曜だけ1年分の有休', () => {
  const tue = plan('2026-10-13');
  assert.equal(tue.filter(x => x.name === 'monthlies').length, 12);
  assert.ok(tue.find(x => x.name === 'monthlies').path.endsWith('/2026-10'));
  assert.ok(tue.filter(x => x.name === 'monthlies').at(-1).path.endsWith('/2025-11'));
  assert.equal(tue.filter(x => x.name === 'requests').length, 6);
  assert.equal(tue.filter(x => x.name === 'paidLeaves').length, 0);
  const mon = plan('2026-10-12');
  const pl = mon.filter(x => x.name === 'paidLeaves');
  assert.equal(pl.length, 6);
  assert.ok(pl[0].path.endsWith('start=2026-08-12&end=2026-10-11'));
  assert.ok(mon[0].path.includes('additionalFields=hiredDate'));
  assert.equal(plan('2026-10-12', 'night').filter(x => x.group).length, 0);
  assert.equal(addMonths('2026-01', -1), '2025-12');
});

test('TOT中継: 有休の日だけを取り出す（半休は0.5、時間休は数えない）', () => {
  const days = [{ dailyWorkings: [
    { employeeKey: 'a', date: '2026-10-01', holidaysObtained: { fulltimeHoliday: { name: '有休' }, halfdayHolidays: [], hourHolidays: [] } },
    { employeeKey: 'b', date: '2026-10-01', holidaysObtained: { fulltimeHoliday: { name: '公休' }, halfdayHolidays: [], hourHolidays: [] } },
    { employeeKey: 'c', date: '2026-10-01', holidaysObtained: { fulltimeHoliday: {}, halfdayHolidays: [{ name: '有休' }], hourHolidays: [] } },
    { employeeKey: 'd', date: '2026-10-01', holidaysObtained: { fulltimeHoliday: {}, halfdayHolidays: [], hourHolidays: [{ name: '有休' }] } },
  ] }];
  assert.deepEqual(pickPaidLeaves(days), [{ employeeKey: 'a', date: '2026-10-01', days: 1 }, { employeeKey: 'c', date: '2026-10-01', days: 0.5 }]);
  const r = {};
  collect(r, { name: 'requests', group: true, type: 'timerecords', path: '/x' }, { requests: [{ status: 'applying', message: '理由' }] });
  collect(r, { name: 'requests', group: true, type: 'overtimes', path: '/y' }, { _error: 403 });
  assert.equal(r.requests[0].status, 'applying');
  assert.equal(r.requests[0].message, undefined);   // 申請理由などは送らない
  assert.deepEqual(r.requests[1], { _error: 403, path: '/y' });
});
