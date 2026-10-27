import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker, { lineSignatureOk, forwardBody, clock } from '../workers/line-webhook/src/index.js';

// Cloudflare Workers の受け口（workers/line-webhook）の単体テスト。すべて架空の値。
const CH = 'channel-secret-not-real', FWD = 'forward-secret-not-real';
const EX = 'https://script.google.com/macros/s/EXISTING/exec', EA = 'https://script.google.com/macros/s/EA/exec', G = 'C' + 'a'.repeat(32);
const ENV = { LINE_CHANNEL_SECRET: CH, EXISTING_GAS_URL: EX, EA_FORWARD_SECRET: FWD, GAS_WEBAPP_URL: EA, EA_GROUP_ID: G };
const ea = (() => { const c = { module: { exports: {} } }; vm.runInNewContext(readFileSync(new URL('../gas/EmployeeAdmin.gs', import.meta.url), 'utf8'), c); return c.module.exports; })();
const sig = (s, b) => createHmac('sha256', s).update(b).digest('base64');
const req = (body, headers = {}, path = '/line/webhook', method = 'POST') => new Request(`https://w.example${path}`, { method, body: method === 'POST' ? body : undefined, headers });

async function call(r, env = ENV, gas = async () => new Response('OK')) {
  const realFetch = globalThis.fetch, realLog = console.log, calls = [];
  globalThis.fetch = async (url, opt) => { calls.push({ url, opt }); return gas(url, opt); };
  console.log = () => {};
  try { const res = await worker.fetch(r, env, { waitUntil() {} }); return { status: res.status, calls }; } finally { globalThis.fetch = realFetch; console.log = realLog; }
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

test('受け口：既存へは本文をそのまま、勤怠管理グループのイベントだけ社員管理へ署名つきで転送', async () => {
  const evG = { type: 'message', webhookEventId: 'E1', source: { type: 'group', groupId: G, userId: 'U1' }, message: { type: 'text', text: '入社' } };
  const evU = { type: 'message', webhookEventId: 'E2', source: { type: 'user', userId: 'U2' }, message: { type: 'text', text: '90001' } };
  const raw = JSON.stringify({ destination: 'U', events: [evG, evU] });
  clock.now = () => 1_800_000_000_000;
  const r = await call(req(raw, { 'x-line-signature': sig(CH, raw) }));
  clock.now = () => Date.now();
  assert.equal(r.status, 200);
  assert.deepEqual(r.calls.map((c) => c.url).sort(), [EA, EX].sort());
  assert.equal(r.calls.find((c) => c.url === EX).opt.body, raw);                 // 既存へは本文そのまま
  const fb = JSON.parse(r.calls.find((c) => c.url === EA).opt.body);
  assert.equal(fb.type, 'line-verified');
  assert.equal(fb.ts, 1_800_000_000);
  assert.deepEqual(JSON.parse(fb.payload).events, [evG]);                       // 社員管理へは勤怠管理グループの分だけ
  // 勤怠管理グループ以外だけなら社員管理へは送らない
  const raw2 = JSON.stringify({ destination: 'U', events: [evU] });
  const r2 = await call(req(raw2, { 'x-line-signature': sig(CH, raw2) }));
  assert.deepEqual(r2.calls.map((c) => c.url), [EX]);
});

test('受け口：署名違いは401・どこにも転送しない。検証ボタンは両方へ。対象外のパス404、壊れた本文400、大きすぎ413、設定不足500', async () => {
  const raw = JSON.stringify({ events: [{ webhookEventId: 'E1' }] });
  assert.deepEqual((await call(req(raw, { 'x-line-signature': sig('x', raw) }))).status, 401);
  assert.equal((await call(req(raw))).calls.length, 0);
  const empty = JSON.stringify({ events: [] });
  const v = await call(req(empty, { 'x-line-signature': sig(CH, empty) }));
  assert.equal(v.status, 200);
  assert.equal(v.calls.length, 2);
  assert.equal((await call(req(raw, {}, '/other'))).status, 404);
  assert.equal((await call(req(null, {}, '/line/webhook', 'GET'))).status, 404);
  const bad = 'not json';
  assert.equal((await call(req(bad, { 'x-line-signature': sig(CH, bad) }))).status, 400);
  const big = 'x'.repeat(1024 * 1024 + 1);
  assert.equal((await call(req(big, { 'x-line-signature': sig(CH, big) }))).status, 413);
  assert.equal((await call(req(raw, { 'x-line-signature': sig(CH, raw) }), { ...ENV, EXISTING_GAS_URL: '' })).status, 500);
  assert.equal((await call(req(raw, { 'x-line-signature': sig(CH, raw) }), { ...ENV, EXISTING_GAS_URL: 'https://example.com/' })).status, 500);
  // 社員管理の設定が無ければ、既存への中継だけで200
  const only = await call(req(empty, { 'x-line-signature': sig(CH, empty) }), { LINE_CHANNEL_SECRET: CH, EXISTING_GAS_URL: EX });
  assert.equal(only.status, 200);
  assert.deepEqual(only.calls.map((c) => c.url), [EX]);
});

test('受け口：社員管理が NG・エラー・通信失敗、または既存がエラーなら500（既存への転送は行う）', async () => {
  const raw = JSON.stringify({ events: [{ webhookEventId: 'E1', source: { type: 'group', groupId: G } }] });
  const h = { 'x-line-signature': sig(CH, raw) };
  const ok = new Response('OK');
  const eaSays = (resp) => async (url) => (url === EX ? new Response('OK') : resp());
  assert.equal((await call(req(raw, h), ENV, eaSays(() => new Response('NG')))).status, 500);
  assert.equal((await call(req(raw, h), ENV, eaSays(() => new Response('err', { status: 500 })))).status, 500);
  const down = await call(req(raw, h), ENV, async (url) => { if (url === EA) throw new Error('down'); return ok; });
  assert.equal(down.status, 500);
  assert.ok(down.calls.some((c) => c.url === EX));
  assert.equal((await call(req(raw, h), ENV, async (url) => (url === EX ? new Response('', { status: 500 }) : new Response('OK')))).status, 500);
});
