import test from 'node:test';
import assert from 'node:assert/strict';
import { toSyncDay, runSync, addDays } from '../src/tot-sync.js';

// 架空データのみ
test('TOT同期: 従業員キーを社員コードに置き換え、内部キーは渡さない', () => {
  const d = toSyncDay('2026-10-14', [{ key: 'k1', code: '501' }], { date: '2026-10-14', dailySchedules: [
    { employeeKey: 'k1', date: '2026-10-14', clockInSchedule: 'x' }, { employeeKey: 'zz', date: '2026-10-14' }] });
  assert.deepEqual(d, { date: '2026-10-14', rows: [{ code: '501', date: '2026-10-14', schedule: { date: '2026-10-14', clockInSchedule: 'x' } }] });
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
});

test('TOT同期: 取得先は404/405なら次を試し、Apps Scriptへ合言葉付きで送る', async () => {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    calls.push({ url, opt });
    if (url.startsWith('https://script.google.com')) return { ok: true, status: 200, text: async () => 'OK 1' };
    if (url.includes('/employees')) return { ok: true, status: 200, json: async () => [{ key: 'k1', code: '501' }] };
    if (url.includes('/daily-schedules/')) return { ok: false, status: 405 };
    return { ok: true, status: 200, json: async () => ({ dailySchedules: [{ employeeKey: 'k1', date: '2026-10-14' }] }) };
  };
  const logs = [];
  await runSync({ env: { TOT_ACCESS_TOKEN: 't', GAS_WEBAPP_URL: 'https://script.google.com/macros/s/abc/exec', TOT_SYNC_SECRET: 's', TOT_SYNC_DAYS: '1' },
    fetchImpl, now: () => new Date('2026-10-13T22:00:00Z'), wait: async () => {}, log: m => logs.push(m) });
  const post = calls.at(-1);
  assert.equal(post.opt.method, 'POST');
  const body = JSON.parse(post.opt.body);
  assert.equal(body.secret, 's');
  assert.equal(body.days[0].rows[0].code, '501');
  assert.ok(!JSON.stringify(logs).includes('501'));   // ログに個人のデータを出さない
});

test('TOT同期: 利用禁止時間帯や設定不足では止まる', async () => {
  await assert.rejects(runSync({ env: {} }), /\.env/);
  await assert.rejects(runSync({ env: { TOT_ACCESS_TOKEN: 't', GAS_WEBAPP_URL: 'https://script.google.com/macros/s/abc/exec', TOT_SYNC_SECRET: 's' },
    fetchImpl: async () => ({ ok: true }), now: () => new Date('2026-10-14T00:00:00Z') }), /禁止時間帯/);
});
