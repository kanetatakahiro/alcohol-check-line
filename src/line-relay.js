// LINE Webhook の署名確認つき中継（さくらのVPSで常駐させる。社員管理AI用）
//
// LINE → https://（サブドメイン）/line/webhook → この中継 → Apps Script（doPost の 'line-verified'）
//  1. LINE の署名（X-Line-Signature）をチャネルシークレットで確かめる。違えば 401 で捨てる。
//  2. 受け取った本文をいったんファイルに保存してから、すぐ LINE に 200 を返す（LINE を待たせない）。
//  3. 保存した順に Apps Script へ転送する。転送には合言葉の署名（HMAC）・時刻・使い捨て番号（nonce）を付ける。
//     届かなければ間隔をあけて再送し、それでもだめなら failed/ に移して記録する（内容はログに出さない）。
//
// 設定（既存の .env とは別のファイル。例：/opt/alcohol-check-line/line-relay.env）
//   LINE_CHANNEL_SECRET  LINE Developers の「チャネルシークレット」
//   GAS_WEBAPP_URL       Apps Script のウェブアプリURL（既存の TOT 中継と同じもの）
//   EA_FORWARD_SECRET    Apps Script のスクリプトプロパティ EA_FORWARD_SECRET と同じ合言葉
//   LINE_RELAY_PORT      待ち受けポート（既定 8787。127.0.0.1 のみ。外からは nginx 等のHTTPS経由）
//   LINE_RELAY_SPOOL     一時保存フォルダ（既定 ./line-relay-spool）
//
// 起動：node --env-file=line-relay.env src/line-relay.js
import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 1024 * 1024;
const RETRY_WAITS_MS = [5e3, 15e3, 60e3, 300e3, 900e3, 1800e3];   // 合計約52分

export function lineSignatureOk(channelSecret, rawBody, header) {
  if (!channelSecret || !header) return false;
  const expect = createHmac('sha256', channelSecret).update(rawBody).digest();
  let got;
  try { got = Buffer.from(String(header), 'base64'); } catch { return false; }
  return got.length === expect.length && timingSafeEqual(got, expect);
}

export function forwardBody(secret, payload, nowSec, nonce = randomUUID()) {
  const sig = createHmac('sha256', secret).update(`${nowSec}.${nonce}.${payload}`, 'utf8').digest('hex');
  return { type: 'line-verified', ts: nowSec, nonce, payload, sig };
}

export function createRelay({ env = process.env, fetchImpl = fetch, now = () => Date.now(), log = (m) => console.log(m),
  wait = (ms) => new Promise((r) => setTimeout(r, ms)), retryWaits = RETRY_WAITS_MS } = {}) {
  const channelSecret = env.LINE_CHANNEL_SECRET, url = env.GAS_WEBAPP_URL, fwdSecret = env.EA_FORWARD_SECRET;
  if (!channelSecret || !url || !fwdSecret) throw new Error('line-relay.env に LINE_CHANNEL_SECRET / GAS_WEBAPP_URL / EA_FORWARD_SECRET を設定してください。');
  if (!/^https:\/\/script\.google\.com\//.test(url)) throw new Error('GAS_WEBAPP_URL が Apps Script のURLではありません。');
  const spool = env.LINE_RELAY_SPOOL || './line-relay-spool';
  const failed = join(spool, 'failed');
  mkdirSync(failed, { recursive: true });
  let running = null;

  async function forwardOne(file) {
    const payload = readFileSync(join(spool, file), 'utf8');
    for (let attempt = 0; ; attempt++) {
      let status = 0, text = '';
      try {
        // 再送のたびに新しい時刻・nonce で署名する（イベントの重複は Apps Script 側が webhookEventId で防ぐ）
        const res = await fetchImpl(url, {
          method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(30000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(forwardBody(fwdSecret, payload, Math.floor(now() / 1000))),
        });
        status = res.status; text = String(await res.text()).trim();
      } catch (e) { status = -1; }
      if (status === 200 && text === 'OK') { unlinkSync(join(spool, file)); log(`転送OK ${file}`); return true; }
      if (status === 200 && text === 'NG') { renameSync(join(spool, file), join(failed, file)); log(`転送拒否（Apps Scriptが署名を受け付けず）${file}`); return false; }
      if (attempt >= retryWaits.length) { renameSync(join(spool, file), join(failed, file)); log(`転送失敗（再送上限）${file} 状態=${status}`); return false; }
      log(`転送失敗 ${file} 状態=${status}。${Math.round(retryWaits[attempt] / 1000)}秒後に再送`);
      await wait(retryWaits[attempt]);
    }
  }

  /** 保存済みのものを古い順に転送する（同時に1本だけ） */
  function drain() {
    if (running) return running;
    const p = (async () => {
      try {
        for (;;) {
          const files = readdirSync(spool).filter((f) => f.endsWith('.json')).sort();
          if (!files.length) break;
          await forwardOne(files[0]);
        }
      } catch (e) { log(`中継の内部エラー：${e && e.code ? e.code : '不明'}（次の受信時に再開）`); }
    })();
    // 保存が無いと即座に終わるため、終了時の片付けは代入の後に行う（「実行中」のまま残らないように）
    running = p.finally(() => { running = null; });
    return running;
  }

  function handler(req, res) {
    if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200).end('ok'); return; }
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/line/webhook') { res.writeHead(404).end(); return; }
    const chunks = []; let size = 0, tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) tooBig = true; else chunks.push(c); });
    req.on('end', () => {
      if (tooBig) { res.writeHead(413).end(); log('受信拒否（大きすぎる）'); return; }
      const raw = Buffer.concat(chunks);
      if (!lineSignatureOk(channelSecret, raw, req.headers['x-line-signature'])) { res.writeHead(401).end(); log('受信拒否（LINEの署名が一致しない）'); return; }
      let n = 0;
      try { n = (JSON.parse(raw.toString('utf8')).events || []).length; } catch { res.writeHead(400).end(); return; }
      if (n === 0) { res.writeHead(200).end('OK'); return; }   // LINE Developers の「検証」ボタン
      const file = `${String(now()).padStart(15, '0')}-${randomUUID()}.json`;
      writeFileSync(join(spool, file), raw);
      res.writeHead(200).end('OK');
      log(`受信 ${n}件 ${file}`);
      drain();
    });
  }

  const server = createServer(handler);
  return { server, handler, drain, spool };
}

// 直接起動されたとき
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const relay = createRelay();
  const port = Number(process.env.LINE_RELAY_PORT || 8787);
  relay.server.listen(port, '127.0.0.1', () => { console.log(`LINE中継 起動 127.0.0.1:${port}`); relay.drain(); });
  setInterval(() => relay.drain(), 60e3).unref();   // 取り残しがあれば1分ごとに再開
}
