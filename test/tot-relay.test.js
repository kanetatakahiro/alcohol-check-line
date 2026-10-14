import test from 'node:test';
import assert from 'node:assert/strict';
import { runRelay, plan } from '../src/tot-relay.js';

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
