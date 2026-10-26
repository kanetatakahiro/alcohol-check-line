import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker, { lineSignatureOk, forwardBody, clock } from '../workers/line-webhook/src/index.js';

// Cloudflare Workers の受け口（workers/line-webhook）の単体テスト。すべて架空の値。
const CH = 'channel-secret-not-real', FWD = 'forward-secret-not-real';
const ENV = { LINE_CHANNEL_SECRET: CH, EA_FORWARD_SECRET: FWD, GAS_WEBAPP_URL: 'https://script.google.com/macros/s/T/exec' };
const ea = (() => { const c = { module: { exports: {} } }; vm.runInNewContext(readFileSync(new URL('../gas/EmployeeAdmin.gs', import.meta.url), 'utf8'), c); return c.module.exports; })();
const sig = (s, b) => createHmac('sha256', s).update(b).digest('base64');
const req = (body, headers = {}, path = '/line/webhook', method = 'POST') => new Request(`https://w.example${path}`, { method, body: method === 'POST' ? body : undefined, headers });

async function call(r, env = ENV, gas = async () => new Response('OK')) {
  const realFetch = globalThis.fetch, realLog = console.log, calls = [];
  globalThis.fetch = async (url, opt) => { calls.push({ url, opt }); return gas(url, opt); };
  console.log = () => {};
  try { const res = await worker.fetch(r, env); return { status: res.status, calls }; } finally { globalThis.fetch = realFetch; console.log = realLog; }
}

test('受け口：LINEの署名の確認（日本語の本文・改ざん・別のシークレット・形式違い）', async () => {
  const body = new TextEncoder().encode(JSON.stringify({ events: [{ message: { text: '【入社】\n氏名：試験 花子' } }] }));
  assert.equal(await lineSignatureOk(CH, body, sig(CH, body)), true);
  assert.equal(await lineSignatureOk(CH, body, sig('other', body)), false);
  assert.equal(await lineSignatureOk(CH, body.slice(1), sig(CH, body)), false);
  assert.equal(await lineSignatureOk(CH, body, 'not base64 !!'), false);
  assert.equal(await lineSignatureOk(CH, body, ''), false);
  assert.equal(await lineSignatureOk('', body, sig(CH, body)), false);
});

test('受け口：転送の署名は Apps Script 側（EA_verifyForward）で検証できる', async () => {
  const payload = JSON.stringify({ events: [{ webhookEventId: 'E1', message: { text: '退社' } }] });
  const b = await forwardBody(FWD, payload, 1_800_000_000);
  const hmac = (s, t) => createHmac('sha256', s).update(t, 'utf8').digest('hex');
  assert.equal(ea.EA_verifyForward(b, FWD, 1_800_000_010, () => false, hmac).ok, true);
  assert.equal(ea.EA_verifyForward({ ...b, payload: payload.replace('退社', '入社') }, FWD, 1_800_000_010, () => false, hmac).ok, false);
});

test('受け口：正しい署名なら本文を変えずに転送し、Apps Script が OK なら200', async () => {
  const raw = JSON.stringify({ destination: 'U', events: [{ webhookEventId: 'E1', message: { text: '入社' } }] });
  clock.now = () => 1_800_000_000_000;
  const r = await call(req(raw, { 'x-line-signature': sig(CH, raw) }));
  clock.now = () => Date.now();
  assert.equal(r.status, 200);
  assert.equal(r.calls.length, 1);
  const fb = JSON.parse(r.calls[0].opt.body);
  assert.equal(fb.type, 'line-verified');
  assert.equal(fb.payload, raw);
  assert.equal(fb.ts, 1_800_000_000);
  assert.equal(r.calls[0].url, ENV.GAS_WEBAPP_URL);
});

test('受け口：署名違いは401・転送しない。検証ボタンは200。対象外のパス404、壊れた本文400、大きすぎ413、設定不足500', async () => {
  const raw = JSON.stringify({ events: [{ webhookEventId: 'E1' }] });
  assert.deepEqual((await call(req(raw, { 'x-line-signature': sig('x', raw) }))).status, 401);
  assert.equal((await call(req(raw))).calls.length, 0);
  const empty = JSON.stringify({ events: [] });
  assert.equal((await call(req(empty, { 'x-line-signature': sig(CH, empty) }))).status, 200);
  assert.equal((await call(req(raw, {}, '/other'))).status, 404);
  assert.equal((await call(req(null, {}, '/line/webhook', 'GET'))).status, 404);
  const bad = 'not json';
  assert.equal((await call(req(bad, { 'x-line-signature': sig(CH, bad) }))).status, 400);
  const big = 'x'.repeat(1024 * 1024 + 1);
  assert.equal((await call(req(big, { 'x-line-signature': sig(CH, big) }))).status, 413);
  assert.equal((await call(req(raw, { 'x-line-signature': sig(CH, raw) }), { ...ENV, EA_FORWARD_SECRET: '' })).status, 500);
  assert.equal((await call(req(raw, { 'x-line-signature': sig(CH, raw) }), { ...ENV, GAS_WEBAPP_URL: 'https://example.com/' })).status, 500);
});

test('受け口：Apps Script が NG・エラー・通信失敗なら500（LINEの再送に任せる）', async () => {
  const raw = JSON.stringify({ events: [{ webhookEventId: 'E1' }] });
  const h = { 'x-line-signature': sig(CH, raw) };
  assert.equal((await call(req(raw, h), ENV, async () => new Response('NG'))).status, 500);
  assert.equal((await call(req(raw, h), ENV, async () => new Response('err', { status: 500 }))).status, 500);
  assert.equal((await call(req(raw, h), ENV, async () => { throw new Error('down'); })).status, 500);
});
