import test from 'node:test';
import assert from 'node:assert/strict';
import { createTotClient, assertAllowedTime, validateDate } from '../src/tot-client.js';

const date = '2026-10-07';
const now = () => new Date(`${date}T19:00:00+09:00`);
const payloads = () => [[{ key: 'fake-key', code: '001' }],
  { date, dailyWorkings: [{ date, employeeKey: 'fake-key', timeRecord: [] }] },
  { date, dailySchedules: [{ date, employeeKey: 'fake-key' }] }];
function setup(data = payloads()) {
  const calls = [], waits = [];
  const client = createTotClient({ token: 'fake-token', now,
    wait: async ms => { waits.push(ms); }, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => data.shift() };
    } });
  return { client, calls, waits };
}
test('GETだけで順に取得し、リダイレクトを拒否・日付指定・間隔を確保する', async () => {
  const { client, calls, waits } = setup();
  const result = await client.readDay(date);
  assert.equal(result.employees[0].code, '001');
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 1000]);
  assert.ok(calls[0].url.endsWith(`/employees?date=${date}&includeResigner=false`));
  for (const call of calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, 'Bearer fake-token');
  }
});
test('禁止時間帯の境界を日本時間で判定する', () => {
  for (const time of ['08:30', '09:59', '17:30', '18:29']) {
    assert.throws(() => assertAllowedTime(new Date(`${date}T${time}:00+09:00`)));
  }
  for (const time of ['08:29', '10:00', '17:29', '18:30']) {
    assert.doesNotThrow(() => assertAllowedTime(new Date(`${date}T${time}:00+09:00`)));
  }
});
test('外部の例外に含まれる秘密情報を返さず、途中失敗では結果を返さない', async () => {
  let count = 0;
  const client = createTotClient({ token: 'fake-token', now, wait: async () => {},
    fetchImpl: async () => {
      if (++count === 2) throw new Error('secret-value');
      return { ok: true, json: async () => payloads()[0] };
    } });
  await assert.rejects(client.readDay(date), e => !e.message.includes('secret-value'));
  assert.equal(count, 2);
});
test('不正な日付・欠けた応答・日付違い・未知の従業員を拒否する', async () => {
  assert.throws(() => validateDate('2026-02-30'));
  assert.throws(() => createTotClient({ token: '' }));
  for (const replacement of [{ date }, { date: '2026-10-06', dailyWorkings: [] },
    { date, dailyWorkings: [{ date, employeeKey: 'unknown' }] }]) {
    const data = payloads(); data[1] = replacement;
    await assert.rejects(setup(data).client.readDay(date));
  }
});
test('同じクライアントへの同時呼出しも直列化する', async () => {
  const { client, calls, waits } = setup([...payloads(), ...payloads()]);
  await Promise.all([client.readDay(date), client.readDay(date)]);
  assert.equal(calls.length, 6);
  assert.equal(waits.length, 5);
});
