// さくらのVPSで手動実行する確認用：TOT APIの候補パスに GET し、HTTP状態とデータの「形」（項目名・件数）だけを表示する。
// 値（氏名・時刻など）は表示しない。トークンも表示しない。
// 使い方： node --env-file=.env src/tot-probe.js
import { assertAllowedTime } from './tot-client.js';
import { japanDate } from './reconcile.js';

const API = 'https://api.kingtime.jp/v1.0';

export function shape(v, depth = 0) {
  if (Array.isArray(v)) return v.length ? [`${v.length}件`, shape(v[0], depth + 1)] : ['0件'];
  if (v && typeof v === 'object') {
    if (depth > 2) return Object.keys(v);
    const o = {};
    for (const k of Object.keys(v).slice(0, 40)) o[k] = typeof v[k] === 'object' && v[k] !== null ? shape(v[k], depth + 1) : typeof v[k];
    return o;
  }
  return typeof v;
}

export function candidates(today) {
  const ym = today.slice(0, 7), y = today.slice(0, 4);
  return [
    `/monthly-workings/${ym}`,
    `/monthly-workings/holiday-remainings/${ym}`,
    `/monthly-workings/holidays/${ym}`,
    `/holiday-remainings/${ym}`,
    `/yearly-holidays/${y}`,
    `/yearly-workings/holidays/${y}`,
    `/requests/schedules/${ym}`,
    `/requests/overtimes/${ym}`,
    `/requests/timerecords/${ym}`,
    `/requests/overtime-limits/${ym}`,
    `/employees?additionalFields=hiredDate`,
  ];
}

async function main() {
  const token = process.env.TOT_ACCESS_TOKEN;
  if (!token) throw new Error('.env に TOT_ACCESS_TOKEN がありません');
  const paths = process.argv.slice(2).length ? process.argv.slice(2) : candidates(japanDate(new Date()));
  for (const p of paths) {
    assertAllowedTime(new Date());
    const res = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    let body = null;
    try { body = await res.json(); } catch { /* 本文なし */ }
    const out = res.ok ? shape(body) : { errors: (body && body.errors || []).map(e => ({ code: e.code, message: e.message })) };
    // 従業員一覧は hiredDate の有無だけを見る
    if (p.startsWith('/employees') && Array.isArray(body)) console.log(p, res.status, { 件数: body.length, hiredDateあり: body.filter(e => e.hiredDate).length });
    else console.log(p, res.status, JSON.stringify(out));
    await new Promise(r => setTimeout(r, 1100));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message); process.exitCode = 1; });
