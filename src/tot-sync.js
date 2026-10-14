// 固定IPのサーバーで毎朝実行：TOTから勤務予定を読み取り、Apps Script（Webアプリ）へ渡す。
// TOTへの書き込みはしない（GETのみ）。トークン・合言葉・取得データはログに出さない（件数のみ）。
// 必要な環境変数（サーバーの .env。Gitには入れない）：
//   TOT_ACCESS_TOKEN  TOTのアクセストークン
//   GAS_WEBAPP_URL    Apps ScriptのWebアプリURL（/exec）
//   TOT_SYNC_SECRET   Apps Script側の TOT_SYNC_SECRET と同じ合言葉
//   TOT_SYNC_DAYS     何日先まで取り込むか（既定 7、最大 31）
import { assertAllowedTime, validateDate } from './tot-client.js';
import { japanDate } from './reconcile.js';

const API = 'https://api.kingtime.jp/v1.0';
// 日別スケジュールの取得先は公式資料の表記ゆれに備えて2通り試す（404/405のときだけ次へ）
const SCHEDULE_PATHS = [d => `/daily-schedules/${d}`, d => `/daily-workings/schedules/${d}`];

export function addDays(date, n) {
  validateDate(date);
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** 純粋関数：TOTの応答から、社員番号ごとの勤務予定（氏名は含めない）を作る */
export function toSyncDay(date, employees, schedulesBody) {
  if (!Array.isArray(employees)) throw new Error('TOTの従業員データの形式を確認してください。');
  const codeByKey = new Map(employees.filter(e => e && e.key && e.code).map(e => [e.key, String(e.code)]));
  const rows = Array.isArray(schedulesBody) ? schedulesBody
    : (schedulesBody && (schedulesBody.dailySchedules || schedulesBody.schedules)) || null;
  if (!Array.isArray(rows)) throw new Error('TOTの勤務予定データの形式を確認してください。');
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const code = codeByKey.get(row.employeeKey);
    if (!code) continue;
    const { employeeKey, ...rest } = row;   // 内部キーは渡さない
    out.push({ code, date: row.date || date, schedule: rest });
  }
  return { date, rows: out };
}

export async function runSync({ env = process.env, fetchImpl = fetch, now = () => new Date(),
  wait = ms => new Promise(r => setTimeout(r, ms)), log = console.log } = {}) {
  const token = env.TOT_ACCESS_TOKEN, url = env.GAS_WEBAPP_URL, secret = env.TOT_SYNC_SECRET;
  if (!token || !url || !secret) throw new Error('サーバーの .env に TOT_ACCESS_TOKEN / GAS_WEBAPP_URL / TOT_SYNC_SECRET を設定してください。');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('GAS_WEBAPP_URL の形式を確認してください。');
  const daysAhead = Math.min(Math.max(Number(env.TOT_SYNC_DAYS || 7), 1), 31);
  let first = true;
  const get = async path => {
    if (!first) await wait(1100);
    first = false;
    assertAllowedTime(now());
    const res = await fetchImpl(`${API}${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    return res;
  };
  const getJson = async path => {
    const res = await get(path);
    if (!res.ok) throw Object.assign(new Error(`TOTから取得できませんでした（HTTP ${res.status}）。トークン・権限・許可IPアドレスを確認してください。`), { status: res.status });
    return res.json();
  };
  const today = japanDate(now());
  const days = [];
  let schedulePath = null;
  for (let i = 0; i < daysAhead; i++) {
    const date = addDays(today, i);
    const employees = await getJson(`/employees?date=${date}&includeResigner=false`);
    let body = null;
    for (const p of schedulePath ? [schedulePath] : SCHEDULE_PATHS) {
      const res = await get(p(date));
      if (res.ok) { body = await res.json(); schedulePath = p; break; }
      if (res.status !== 404 && res.status !== 405) {
        throw new Error(`TOTの勤務予定を取得できませんでした（HTTP ${res.status}）。`);
      }
    }
    if (!body) throw new Error('TOTの勤務予定の取得先が見つかりませんでした。');
    days.push(toSyncDay(date, employees, body));
  }
  const res = await fetchImpl(url, {
    method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(60000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'tot-sync', secret, sentAt: now().toISOString(), days }),
  });
  const text = await res.text();
  if (!res.ok || !/^OK/.test(text)) throw new Error(`Apps Scriptへの受け渡しに失敗しました（HTTP ${res.status}）。`);
  log(JSON.stringify({ from: today, days: days.length, rows: days.reduce((a, d) => a + d.rows.length, 0), result: text.slice(0, 80) }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSync().catch(e => { console.error(e.message); process.exitCode = 1; });
}
