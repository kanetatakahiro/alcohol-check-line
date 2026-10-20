import test from 'node:test';
import assert from 'node:assert/strict';
import { runRelay, plan, pickPaidLeaves, collect, addMonths, punchCheckSummary } from '../src/tot-relay.js';

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

test('TOT中継（打刻だけ・--punch）：従業員と昨日・今日の打刻だけを取り、type: tot-punch で送る（勤怠のお知らせ・集計は動かさない）', async () => {
  const p = plan('2026-10-20', 'punch');
  assert.deepEqual(p.map(x => x.name), ['employees', 'timerecord']);
  assert.ok(p[1].path.includes('start=2026-10-19&end=2026-10-20'));
  const calls = [];
  const fetchImpl = async (url, opt) => {
    calls.push({ url, opt });
    if (url.startsWith('https://script.google.com')) return { ok: true, status: 200, text: async () => 'OK punch ok' };
    return { ok: true, status: 200, json: async () => [] };
  };
  await runRelay({ env: { TOT_ACCESS_TOKEN: 't', GAS_WEBAPP_URL: 'https://script.google.com/macros/s/abc/exec', TOT_SYNC_SECRET: 's' },
    fetchImpl, punch: true, now: () => new Date('2026-10-20T11:00:00Z'), wait: async () => {}, log: () => {} });   // 20:00（日本時間）
  assert.equal(calls.length, 3);                                    // TOT 2回＋Apps Script 1回（月別勤怠・申請・シフトは取らない）
  const body = JSON.parse(calls.at(-1).opt.body);
  assert.equal(body.type, 'tot-punch');
  assert.equal(body.mode, 'punch');
  // 従来の夜（22:30）は今までどおり tot-raw
  const calls2 = [];
  await runRelay({ env: { TOT_ACCESS_TOKEN: 't', GAS_WEBAPP_URL: 'https://script.google.com/macros/s/abc/exec', TOT_SYNC_SECRET: 's' },
    fetchImpl: async (url, opt) => { calls2.push({ url, opt }); return url.startsWith('https://script.google.com') ? { ok: true, status: 200, text: async () => 'OK' } : { ok: true, status: 200, json: async () => [] }; },
    now: () => new Date('2026-10-20T13:30:00Z'), wait: async () => {}, log: () => {} });
  assert.equal(JSON.parse(calls2.at(-1).opt.body).type, 'tot-raw');
  assert.equal(JSON.parse(calls2.at(-1).opt.body).mode, 'night');
});

test('TOT中継（確認だけ・--check）：Apps Scriptへは送らず、人数と最新の打刻時刻だけを表示（氏名・社員番号は出さない）', async () => {
  const calls = [], logs = [];
  const tr = [{ date: '2026-10-20', dailyWorkings: [
    { employeeKey: 'k1', date: '2026-10-20', timeRecord: [{ code: '1', time: '2026-10-20T09:00:00+09:00' }, { code: '2', time: '2026-10-20T19:55:00+09:00' }] },
    { employeeKey: 'k2', date: '2026-10-20', timeRecord: [{ code: '1', time: '2026-10-20T09:30:00+09:00' }] }] }];
  const fetchImpl = async (url, opt) => {
    calls.push({ url, opt });
    if (url.includes('/employees')) return { ok: true, status: 200, json: async () => [{ key: 'k1', code: '0501', lastName: '試験' }, { key: 'k2', code: '0502', lastName: '試験' }] };
    return { ok: true, status: 200, json: async () => tr };
  };
  await runRelay({ env: { TOT_ACCESS_TOKEN: 't', GAS_WEBAPP_URL: 'https://script.google.com/macros/s/abc/exec', TOT_SYNC_SECRET: 's' },
    fetchImpl, punch: true, check: true, now: () => new Date('2026-10-20T11:05:00Z'), wait: async () => {}, log: m => logs.push(m) });
  assert.ok(!calls.some(c => c.url.startsWith('https://script.google.com')));
  const out = JSON.parse(logs[0]);
  assert.deepEqual(out.summary, { today: '2026-10-20', employees: 2, clockedIn: 2, clockedOut: 1, working: 1, latestIn: '2026-10-20T09:30:00+09:00', latestOut: '2026-10-20T19:55:00+09:00', errors: [] });
  assert.ok(!logs.join('').includes('試験') && !logs.join('').includes('0501'));
  assert.equal(punchCheckSummary({ timerecord: { _error: 500 } }, '2026-10-20').errors[0], 'timerecord');
});
