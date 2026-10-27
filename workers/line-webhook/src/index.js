// Cloudflare Workers：既存のLINE公式アカウント「REBIRTH 管理本部」の Webhook の受け口（LINE署名の確認つき）
//
// LINE → このWorker →（署名が正しいものだけ）
//   ① 既存の Apps Script「勤怠・アルコールチェック管理」へ、LINEから届いた本文をそのまま転送（社員番号登録・部門登録などは今までどおり）
//   ② 勤怠管理グループ（EA_GROUP_ID）のイベントだけ、社員管理AIの Apps Script へ合言葉の署名・時刻・nonceつきで転送
// 署名が無い・合わない受信は 401 で捨て、どちらにも届けない。本文はログに出さず、保存もしない。
//
// 設定（Cloudflare の「変数とシークレット」）
//   LINE_CHANNEL_SECRET  シークレット：既存チャネルのチャネルシークレット
//   EXISTING_GAS_URL     テキスト：既存の Apps Script のウェブアプリURL（今の Webhook URL と同じ）
//   EA_FORWARD_SECRET    シークレット：社員管理AIの Apps Script のスクリプトプロパティ EA_FORWARD_SECRET と同じ合言葉
//   GAS_WEBAPP_URL       テキスト：社員管理AIの Apps Script のウェブアプリURL
//   EA_GROUP_ID          テキスト：勤怠管理グループのID（未設定なら社員管理AIへは転送しない＝既存への中継だけ）

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
    const eaEvents = env.EA_GROUP_ID ? events.filter((e) => e && e.source && e.source.type === 'group' && e.source.groupId === env.EA_GROUP_ID) : [];
    const jobs = [post(env.EXISTING_GAS_URL, raw)];                       // ① 既存：本文をそのまま
    // ② 社員管理AI：勤怠管理グループのイベントがあるとき（検証ボタン＝0件のときも接続確認のため送る）
    const toEa = eaReady && (eaEvents.length > 0 || events.length === 0);
    if (toEa) {
      const payload = JSON.stringify({ destination: body.destination, events: eaEvents });
      jobs.push(forwardBody(env.EA_FORWARD_SECRET, payload, Math.floor(clock.now() / 1000)).then((b) => post(env.GAS_WEBAPP_URL, JSON.stringify(b))));
    }
    const all = Promise.all(jobs);
    if (ctx && ctx.waitUntil) ctx.waitUntil(all);                          // LINE側が先に接続を切っても転送は最後まで行う
    const [ex, ea] = await all;
    const exOk = ex.status === 200, eaOk = !toEa || (ea.status === 200 && ea.text === 'OK');
    console.log(`転送 ${events.length}件：既存=${ex.status}${toEa ? ' 社員管理=' + ea.status + (ea.text === 'NG' ? '(NG)' : '') + '・' + eaEvents.length + '件' : ''}`);
    return exOk && eaOk ? new Response('OK') : new Response('', { status: 500 });
  },
};
