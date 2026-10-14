// さくらのVPS（固定IP）で動かす中継役：TOTのAPIから勤怠データを読み取り（GETのみ）、
// 合言葉付きでApps Script（Webアプリ）へそのまま渡す。判定や通知はApps Script側で行う。
// トークン・合言葉・取得データはログに出さない（件数とHTTP状態のみ）。
// 必要な環境変数（サーバーの .env。Gitには入れない）：
//   TOT_ACCESS_TOKEN  TOTのアクセストークン
//   GAS_WEBAPP_URL    Apps ScriptのWebアプリURL（/exec）
//   TOT_SYNC_SECRET   Apps Script側の TOT_SYNC_SECRET と同じ合言葉
import { assertAllowedTime, validateDate } from './tot-client.js';
import { japanDate } from './reconcile.js';

const API = 'https://api.kingtime.jp/v1.0';

export function addDays(date, n) {
  validateDate(date);
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * 取得する範囲。
 *  朝（morning）：シフトは今日から31日先まで、勤務実績は前月1日から昨日まで（シフト反映・勤怠チェック表）
 *  夜（night、20時以降）：上に加えて、今日の予定と打刻（当日の勤怠状況のお知らせ用）
 *  毎月28日以降の朝：翌月1日〜末日のシフトも取る（翌月分のシフトを管理シートへ反映するため）
 */
export function nextMonthRange(today) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const start = `${ny}-${String(nm).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return { start, end: `${start.slice(0, 8)}${String(last).padStart(2, '0')}` };
}

export function plan(today, mode = 'morning') {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const prev = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
  const yesterday = addDays(today, -1);
  const night = mode === 'night';
  const items = [
    { name: 'employees', path: `/employees?date=${today}&includeResigner=false` },
    { name: 'schedules', path: `/daily-schedules?start=${today}&end=${addDays(today, 30)}` },
    { name: 'workings', path: `/daily-workings?start=${prev}&end=${yesterday}` },
    { name: 'timerecord', path: `/daily-workings/timerecord?start=${addDays(today, -7)}&end=${night ? today : yesterday}` },
  ];
  if (!night && Number(today.slice(8, 10)) >= 28) {
    const r = nextMonthRange(today);
    items.push({ name: 'nextSchedules', path: `/daily-schedules?start=${r.start}&end=${r.end}` });
  }
  return items;
}

/** 日本時間の時（0〜23） */
export function japanHour(d) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(d));
}

export async function runRelay({ env = process.env, fetchImpl = fetch, now = () => new Date(),
  wait = ms => new Promise(r => setTimeout(r, ms)), log = console.log } = {}) {
  const token = env.TOT_ACCESS_TOKEN, url = env.GAS_WEBAPP_URL, secret = env.TOT_SYNC_SECRET;
  if (!token || !url || !secret) throw new Error('サーバーの .env に TOT_ACCESS_TOKEN / GAS_WEBAPP_URL / TOT_SYNC_SECRET を設定してください。');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('GAS_WEBAPP_URL の形式を確認してください。');
  const today = japanDate(now());
  const mode = japanHour(now()) >= 20 ? 'night' : 'morning';   // 20時以降の実行は当日の勤怠状況用
  const results = {}, status = {};
  let first = true;
  for (const item of plan(today, mode)) {
    if (!first) await wait(1100);
    first = false;
    assertAllowedTime(now());
    const res = await fetchImpl(`${API}${item.path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    status[item.name] = res.status;
    if (res.ok) results[item.name] = await res.json();
    else {
      // エラー本文はTOTのエラーコードと文言だけを取り出す（個人情報は含まれない）
      let errors = null;
      try { errors = ((await res.json()).errors || []).map(e => ({ code: e.code, message: e.message })); } catch { /* 本文なし */ }
      results[item.name] = { _error: res.status, errors };
    }
  }
  const res = await fetchImpl(url, {
    method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'tot-raw', secret, fetchedAt: now().toISOString(), today, mode, results }),
  });
  const text = await res.text();
  log(JSON.stringify({ today, mode, status, gas: res.status, result: text.slice(0, 120) }));
  if (!res.ok || !/^OK/.test(text)) throw new Error(`Apps Scriptへの受け渡しに失敗しました（HTTP ${res.status}）。`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRelay().catch(e => { console.error(e.message); process.exitCode = 1; });
}
