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

export function plan(today, mode = 'morning', opts = {}) {
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
  if (!night) {
    // 36協定：今月と過去11か月の月別勤怠（時間外・休日労働）
    for (let i = 0; i < 12; i++) items.push({ name: 'monthlies', group: true, path: `/monthly-workings/${addMonths(today.slice(0, 7), -i)}` });
    // 未承認の申請：今月と前月
    for (const t of ['timerecords', 'schedules', 'overtimes']) {
      for (let i = 0; i < 2; i++) items.push({ name: 'requests', group: true, type: t, path: `/requests/${t}/${addMonths(today.slice(0, 7), -i)}` });
    }
    // 有給の年5日：月曜の朝だけ、過去1年分の日別勤怠から有休の日だけを取り出す（61日ずつ）
    if (opts.leaves || new Date(`${today}T00:00:00Z`).getUTCDay() === 1) {
      for (let i = 0; i < 6; i++) {
        const end = addDays(today, -1 - 61 * i), start = addDays(end, -60);
        items.push({ name: 'paidLeaves', group: true, leave: true, path: `/daily-workings?start=${start}&end=${end}` });
      }
      items[0].path += '&additionalFields=hiredDate';
    }
  }
  return items;
}

export function addMonths(ym, n) {
  let y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** 日別勤怠から有休の日だけ（全日1・半日0.5）。時間単位の有休は年5日に数えないので除く */
export function pickPaidLeaves(days) {
  const out = [];
  for (const d of Array.isArray(days) ? days : []) {
    for (const w of d.dailyWorkings || []) {
      const h = w.holidaysObtained || {};
      let n = 0;
      if (h.fulltimeHoliday && /有休|有給/.test(h.fulltimeHoliday.name || '')) n = 1;
      else n = (h.halfdayHolidays || []).filter(x => /有休|有給/.test(x.name || '')).length * 0.5;
      if (n) out.push({ employeeKey: w.employeeKey, date: w.date, days: Math.min(n, 1) });
    }
  }
  return out;
}

/** 取得結果をまとめる（group は配列に連結、申請は種類を付ける、有休は必要な所だけ） */
export function collect(results, item, data) {
  if (!item.group) { results[item.name] = data; return; }
  const cur = results[item.name] || (results[item.name] = []);
  if (data && data._error) { cur.push({ _error: data._error, path: item.path.split('?')[0] }); return; }
  if (item.leave) cur.push(...pickPaidLeaves(data));
  else if (item.type) {
    cur.push(...((data && data.requests) || []).map(r => ({ type: item.type, date: r.date, requestedDate: r.requestedDate,
      employeeKey: r.employeeKey, requestKey: r.requestKey, status: r.status })));
  } else {
    // 月別勤怠は36協定の判定に使う項目だけ
    cur.push(...(Array.isArray(data) ? data : []).map(w => ({ year: w.year, month: w.month, employeeKey: w.employeeKey,
      overtime: w.overtime, nightOvertime: w.nightOvertime, legalHolidayWork: w.legalHolidayWork })));
  }
}

/** 日本時間の時（0〜23） */
export function japanHour(d) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(d));
}

export async function runRelay({ env = process.env, fetchImpl = fetch, now = () => new Date(), leaves = false,
  wait = ms => new Promise(r => setTimeout(r, ms)), log = console.log } = {}) {
  const token = env.TOT_ACCESS_TOKEN, url = env.GAS_WEBAPP_URL, secret = env.TOT_SYNC_SECRET;
  if (!token || !url || !secret) throw new Error('サーバーの .env に TOT_ACCESS_TOKEN / GAS_WEBAPP_URL / TOT_SYNC_SECRET を設定してください。');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('GAS_WEBAPP_URL の形式を確認してください。');
  const today = japanDate(now());
  const mode = japanHour(now()) >= 20 ? 'night' : 'morning';   // 20時以降の実行は当日の勤怠状況用
  const results = {}, status = {};
  let first = true;
  for (const item of plan(today, mode, { leaves })) {
    if (!first) await wait(1100);
    first = false;
    assertAllowedTime(now());
    const res = await fetchImpl(`${API}${item.path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    status[item.name] = res.ok && status[item.name] && status[item.name] !== 200 ? status[item.name] : res.status;
    if (res.ok) collect(results, item, await res.json());
    else {
      // エラー本文はTOTのエラーコードと文言だけを取り出す（個人情報は含まれない）
      let errors = null;
      try { errors = ((await res.json()).errors || []).map(e => ({ code: e.code, message: e.message })); } catch { /* 本文なし */ }
      if (item.group) collect(results, item, { _error: res.status });
      else results[item.name] = { _error: res.status, errors };
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
  runRelay({ leaves: process.argv.includes('--leaves') }).catch(e => { console.error(e.message); process.exitCode = 1; });
}
