// Cloudflare Workers：既存のLINE公式アカウント「REBIRTH 管理本部」の Webhook の受け口（LINE署名の確認つき）
//
// LINE → このWorker →（署名が正しいものだけ）
//   ① 既存の Apps Script「勤怠・アルコールチェック管理」へ、LINEから届いた本文をそのまま転送（社員番号登録・部門登録などは今までどおり）
//   ② 勤怠管理グループ（EA_GROUP_ID）のイベントだけ、社員管理AIの Apps Script へ合言葉の署名・時刻・nonceつきで転送
// 署名が無い・合わない受信は 401 で捨て、どちらにも届けない。本文はログに出さない。
// 転送先が失敗したときは、その転送先の分だけ KV（PENDING）に一時保存して LINE には 200 を返し、
// 5分ごとの定期実行で届くまで再送する（最長24時間。超えたら failed: に移す）。届いたら一時保存は消す。
// 社員管理AIは webhookEventId で二重処理しない。既存の Apps Script には失敗した転送だけを再送する。
//
// 設定（Cloudflare の「変数とシークレット」）
//   LINE_CHANNEL_SECRET  シークレット：既存チャネルのチャネルシークレット
//   EXISTING_GAS_URL     テキスト：既存の Apps Script のウェブアプリURL（今の Webhook URL と同じ）
//   EA_FORWARD_SECRET    シークレット：社員管理AIの Apps Script のスクリプトプロパティ EA_FORWARD_SECRET と同じ合言葉
//   GAS_WEBAPP_URL       テキスト：社員管理AIの Apps Script のウェブアプリURL
//   EA_GROUP_ID          テキスト（任意）：勤怠管理グループのID。未設定なら、グループの「入社」「退社」「取消」【入社】等・承認／却下の
//                        メッセージだけを社員管理AIへ送り、どのグループかの判定は社員管理AI側（EA_ADMIN_GROUP_ID）で行う
//   PENDING              KV名前空間のバインディング（転送できなかった分の一時保存）

const MAX_BODY = 1024 * 1024;
/** 時計（テストで差し替える） */
export const clock = { now: () => Date.now() };
const enc = new TextEncoder();

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** LINE の署名が本文と一致するか（比較は crypto.subtle.verify で一定時間） */
export async function lineSignatureOk(channelSecret, bodyBytes, header) {
  if (!channelSecret || !header) return false;
  let sig;
  try { sig = b64ToBytes(String(header)); } catch { return false; }
  if (sig.length !== 32) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(channelSecret, 'verify'), sig, bodyBytes);
}

/** Apps Script への転送の本文（gas/EmployeeAdmin.gs の EA_verifyForward と同じ形式） */
export async function forwardBody(secret, payload, nowSec, nonce = crypto.randomUUID()) {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(`${nowSec}.${nonce}.${payload}`));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { type: 'line-verified', ts: nowSec, nonce, payload, sig };
}

const GAS_URL = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

async function post(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(28000) });
    return { status: res.status, text: (await res.text()).trim() };
  } catch { return { status: -1, text: '' }; }
}

/** 社員管理AIの形式のメッセージか（gas/EmployeeAdmin.gs の EA_parseMessage と同じ判定） */
export function isEaMessage(e) {
  if (!e || e.type !== 'message' || !e.message || e.message.type !== 'text') return false;
  const t = String(e.message.text || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
  const one = t.replace(/[\s　]+/g, '');
  return one === '入社' || one === '退社' || one === '取消' || /^【\s*(入社|退社|退職|取消)\s*】/.test(t)
    || /^(承認|却下)[\s　]*EA-\d{8}-\d{3}/.test(t);
}

const RETRY_MAX_MS = 24 * 3600 * 1000;

/** 転送先ごとに送る。target='existing' は本文そのまま、'ea' は送る直前に署名を付ける */
async function deliver(env, target, payload) {
  if (target === 'existing') {
    const r = await post(env.EXISTING_GAS_URL, payload);
    return r.status === 200;
  }
  const b = await forwardBody(env.EA_FORWARD_SECRET, payload, Math.floor(clock.now() / 1000));
  const r = await post(env.GAS_WEBAPP_URL, JSON.stringify(b));
  return r.status === 200 && r.text === 'OK';
}

async function keep(env, target, payload) {
  if (!env.PENDING) return false;
  try {
    const t = clock.now();
    await env.PENDING.put(`p:${String(t).padStart(15, '0')}:${crypto.randomUUID()}:${target}`, JSON.stringify({ target, payload, first: t, tries: 1 }));
    return true;
  } catch { return false; }
}

/** 定期実行：一時保存した転送を再送する */
export async function retryPending(env) {
  if (!env.PENDING) return { sent: 0, left: 0, failed: 0 };
  const list = await env.PENDING.list({ prefix: 'p:', limit: 50 });
  let sent = 0, left = 0, failed = 0;
  for (const k of list.keys) {
    const v = await env.PENDING.get(k.name);
    if (!v) continue;
    const item = JSON.parse(v);
    if (await deliver(env, item.target, item.payload)) { await env.PENDING.delete(k.name); sent++; continue; }
    item.tries++;
    if (clock.now() - item.first > RETRY_MAX_MS) {
      await env.PENDING.put('failed:' + k.name.slice(2), JSON.stringify(item));
      await env.PENDING.delete(k.name);
      failed++;
    } else { await env.PENDING.put(k.name, JSON.stringify(item)); left++; }
  }
  console.log(`再送：届いた${sent}件／残り${left}件／断念${failed}件`);
  return { sent, left, failed };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(retryPending(env)); },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') return new Response('ok');   // 稼働確認（中身は返さない）
    if (request.method !== 'POST' || url.pathname !== '/line/webhook') return new Response('', { status: 404 });
    if (!env.LINE_CHANNEL_SECRET || !GAS_URL.test(env.EXISTING_GAS_URL || '')) {
      console.log('設定不足');
      return new Response('', { status: 500 });
    }
    const eaReady = !!(env.EA_FORWARD_SECRET && GAS_URL.test(env.GAS_WEBAPP_URL || ''));
    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_BODY) return new Response('', { status: 413 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_BODY) return new Response('', { status: 413 });
    if (!(await lineSignatureOk(env.LINE_CHANNEL_SECRET, bytes, request.headers.get('x-line-signature')))) {
      console.log('受信拒否：LINEの署名が一致しない');
      return new Response('', { status: 401 });
    }
    let raw, body;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      body = JSON.parse(raw);
    } catch { return new Response('', { status: 400 }); }
    const events = Array.isArray(body.events) ? body.events : [];
    const eaEvents = events.filter((e) => e && e.source && e.source.type === 'group'
      && (env.EA_GROUP_ID ? e.source.groupId === env.EA_GROUP_ID : isEaMessage(e)));
    const jobs = [{ target: 'existing', payload: raw }];                          // ① 既存：本文をそのまま
    // ② 社員管理AI：勤怠管理グループのイベントがあるとき（検証ボタン＝0件のときも接続確認のため送る）
    if (eaReady && (eaEvents.length > 0 || events.length === 0)) jobs.push({ target: 'ea', payload: JSON.stringify({ destination: body.destination, events: eaEvents }) });
    const work = Promise.all(jobs.map(async (j) => {
      const ok = await deliver(env, j.target, j.payload);
      // イベントがあるのに届かなかった分は一時保存（検証ボタンの0件は保存しない＝失敗をそのまま返す）
      const kept = !ok && events.length > 0 ? await keep(env, j.target, j.payload) : false;
      return { target: j.target, ok, kept };
    }));
    if (ctx && ctx.waitUntil) ctx.waitUntil(work);                                  // LINE側が先に接続を切っても最後まで行う
    const res = await work;
    console.log(`受信 ${events.length}件（社員管理 ${eaEvents.length}件）：` + res.map((r) => `${r.target}=${r.ok ? 'OK' : r.kept ? '一時保存' : '失敗'}`).join(' '));
    return res.every((r) => r.ok || r.kept) ? new Response('OK') : new Response('', { status: 500 });
  },
};
