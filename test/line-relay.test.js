import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay, lineSignatureOk } from '../src/line-relay.js';
import { createGas } from './helpers/gas-mock.js';

// LINE署名確認つき中継のテスト。すべて架空の値。
const CH = 'channel-secret-not-real', FWD = 'forward-secret-not-real';
const GAS_URL = 'https://script.google.com/macros/s/TEST/exec';
const lineSig = (body) => createHmac('sha256', CH).update(body).digest('base64');

async function listen(relay) {
  await new Promise((r) => relay.server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${relay.server.address().port}`;
}
const env = (spool) => ({ LINE_CHANNEL_SECRET: CH, GAS_WEBAPP_URL: GAS_URL, EA_FORWARD_SECRET: FWD, LINE_RELAY_SPOOL: spool });

test('中継：LINEの署名の確認', () => {
  const body = Buffer.from('{"events":[]}');
  assert.equal(lineSignatureOk(CH, body, lineSig(body)), true);
  assert.equal(lineSignatureOk(CH, body, lineSig(Buffer.from('{"events":[1]}'))), false);
  assert.equal(lineSignatureOk(CH, body, ''), false);
  assert.equal(lineSignatureOk('', body, lineSig(body)), false);
});

test('中継：署名なし・不正は401で転送しない。検証ボタン（イベント0件）は200', async () => {
  const calls = [];
  const relay = createRelay({ env: env(mkdtempSync(join(tmpdir(), 'lr-'))), fetchImpl: async (...a) => { calls.push(a); }, log: () => {} });
  const base = await listen(relay);
  try {
    const body = JSON.stringify({ events: [{ type: 'message' }] });
    assert.equal((await fetch(`${base}/line/webhook`, { method: 'POST', body })).status, 401);
    assert.equal((await fetch(`${base}/line/webhook`, { method: 'POST', body, headers: { 'x-line-signature': lineSig('x') } })).status, 401);
    const empty = JSON.stringify({ destination: 'U', events: [] });
    assert.equal((await fetch(`${base}/line/webhook`, { method: 'POST', body: empty, headers: { 'x-line-signature': lineSig(empty) } })).status, 200);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal(calls.length, 0);
  } finally { relay.server.close(); }
});

test('中継：設定不足・Apps Script以外のURLでは起動しない', () => {
  assert.throws(() => createRelay({ env: {} }), /line-relay\.env/);
  assert.throws(() => createRelay({ env: { ...env('/tmp/x'), GAS_WEBAPP_URL: 'https://example.com/' } }), /Apps Script/);
});

test('中継：届かなければ再送し、成功したら一時保存を消す。拒否（NG）は failed へ', async () => {
  const spool = mkdtempSync(join(tmpdir(), 'lr-'));
  let n = 0;
  const answers = [() => { throw new Error('network'); }, () => ({ status: 500, text: async () => 'err' }), () => ({ status: 200, text: async () => 'OK' })];
  const relay = createRelay({ env: env(spool), fetchImpl: async () => answers[n++](), log: () => {}, wait: async () => {} });
  const base = await listen(relay);
  try {
    const body = JSON.stringify({ events: [{ type: 'message', webhookEventId: 'E1' }] });
    assert.equal((await fetch(`${base}/line/webhook`, { method: 'POST', body, headers: { 'x-line-signature': lineSig(body) } })).status, 200);
    await relay.drain();
    assert.equal(n, 3);
    assert.deepEqual(readdirSync(spool).filter((f) => f.endsWith('.json')), []);

    n = 0; answers.splice(0, 3, () => ({ status: 200, text: async () => 'NG' }));
    await fetch(`${base}/line/webhook`, { method: 'POST', body, headers: { 'x-line-signature': lineSig(body) } });
    await relay.drain();
    assert.equal(readdirSync(join(spool, 'failed')).length, 1);
  } finally { relay.server.close(); }
});

test('中継→Apps Script（模擬）まで通しで：LINEの署名つき受信が社員管理の申請になり、返信される', async () => {
  const g = createGas({ files: ['AlcoholCheck.gs', 'EmployeeAdmin.gs'], now: '2026-11-10T10:00:00+09:00' });
  const ss = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  ss.insertSheet('従業員マスタ').appendRow(['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日']);
  const G = 'C' + 'a'.repeat(32), A = 'U' + '1'.repeat(32);
  const grp = ss.insertSheet('LINEグループ'); grp.appendRow(['グループID', '部門（所属）', '登録日時', '状態']); grp.appendRow([G, '勤怠管理', '', '有効']);
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: ss.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', EA_FORWARD_SECRET: FWD, EA_MODE: 'on' });
  g.line.members[G] = { [A]: '管理A' };
  const fetchImpl = async (url, opt) => {
    assert.equal(url, GAS_URL);
    const out = g.ctx.doPost({ postData: { contents: opt.body } }).getContent();
    return { status: 200, text: async () => out };
  };
  const relay = createRelay({ env: env(mkdtempSync(join(tmpdir(), 'lr-'))), fetchImpl, now: () => g.clock.now, log: () => {} });
  const base = await listen(relay);
  try {
    const body = JSON.stringify({ destination: 'U', events: [{ type: 'message', webhookEventId: 'W1', replyToken: 'r1',
      source: { type: 'group', groupId: G, userId: A }, message: { type: 'text', id: '1', text: '退社' } }] });
    assert.equal((await fetch(`${base}/line/webhook`, { method: 'POST', body, headers: { 'x-line-signature': lineSig(body) } })).status, 200);
    await relay.drain();
    const reply = g.fetches.find((f) => f.url.endsWith('/reply'));
    assert.match(reply.body.messages[0].text, /【退社】/);
    // 同じLINEイベントの再送（LINE側の再送）は1回だけ
    await fetch(`${base}/line/webhook`, { method: 'POST', body, headers: { 'x-line-signature': lineSig(body) } });
    await relay.drain();
    assert.equal(g.fetches.filter((f) => f.url.endsWith('/reply')).length, 1);
  } finally { relay.server.close(); }
});
