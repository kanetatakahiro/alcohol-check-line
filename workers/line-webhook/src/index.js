// Cloudflare Workers：LINE Webhook の署名確認つき受け口（社員管理AI用）
//
// 社員管理AI用の LINE 公式アカウントの Webhook URL をここにする（既存の公式アカウントの Webhook は変更しない）。
//  1. LINE の署名（X-Line-Signature＝本文の HMAC-SHA256、チャネルシークレットで計算）を確かめる。違えば 401 で捨てる。
//  2. 本文を変えずに、合言葉の署名（HMAC-SHA256）・時刻・使い捨て番号（nonce）を付けて、社員管理AIの Apps Script へ転送する。
//  3. Apps Script が 'OK' を返したら LINE に 200。失敗したら 500（LINE の「Webhookの再送」を有効にしておけば LINE が再送し、
//     Apps Script 側は webhookEventId で二重処理しない）。
// 本文（申請内容）はログに出さない。保存もしない。
//
// 秘密の設定（wrangler secret put で登録。コードやGitHubには書かない）
//   LINE_CHANNEL_SECRET  社員管理AI用LINEのチャネルシークレット
//   EA_FORWARD_SECRET    Apps Script のスクリプトプロパティ EA_FORWARD_SECRET と同じ合言葉
//   GAS_WEBAPP_URL       社員管理AI用 Apps Script のウェブアプリURL

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/line/webhook') return new Response('', { status: 404 });
    if (!env.LINE_CHANNEL_SECRET || !env.EA_FORWARD_SECRET || !/^https:\/\/script\.google\.com\//.test(env.GAS_WEBAPP_URL || '')) {
      console.log('設定不足');
      return new Response('', { status: 500 });
    }
    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_BODY) return new Response('', { status: 413 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_BODY) return new Response('', { status: 413 });
    if (!(await lineSignatureOk(env.LINE_CHANNEL_SECRET, bytes, request.headers.get('x-line-signature')))) {
      console.log('受信拒否：LINEの署名が一致しない');
      return new Response('', { status: 401 });
    }
    let payload, n = 0;
    try {
      payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      n = (JSON.parse(payload).events || []).length;
    } catch { return new Response('', { status: 400 }); }
    if (n === 0) return new Response('OK');   // LINE Developers の「検証」ボタン
    let status = 0, text = '';
    try {
      const res = await fetch(env.GAS_WEBAPP_URL, {
        method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await forwardBody(env.EA_FORWARD_SECRET, payload, Math.floor(clock.now() / 1000))),
        signal: AbortSignal.timeout(25000),
      });
      status = res.status; text = (await res.text()).trim();
    } catch { status = -1; }
    if (status === 200 && text === 'OK') { console.log(`転送OK ${n}件`); return new Response('OK'); }
    console.log(`転送失敗 状態=${status} 応答=${text === 'NG' ? 'NG' : '-'}`);
    return new Response('', { status: 500 });
  },
};
