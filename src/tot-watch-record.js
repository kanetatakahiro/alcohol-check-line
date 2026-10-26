// 打刻の記録（勤怠見守りの先行開発・A-1方式）
// さくらのVPSで動かす。ToTのAPIから読み取り（GETのみ）、必要な項目だけを VPS のフォルダに1回1ファイルで保存する。
//  - 既存の tot-relay.js（7:05・22:30）とは別のプログラム・別のcron。Apps Script・LINE・スプレッドシートには何も送らない。
//  - 保存しないもの：氏名・申請メッセージ・管理者コメント・位置情報・トークン。ログは件数と状態だけ。
//  - 予定の時刻：8:02、10:02〜16:02（毎時）、22:35。22:35の回でその日の点検・まとめ（圧縮）・古いファイルの整理をする。
//  - 8:02の回で前日（22:35の回を含む）を点検し直す。点検結果は status/ に残す（通知はしない）。
// 使い方（VPS）：
//   node --env-file=.env src/tot-watch-record.js            記録する
//   node --env-file=.env src/tot-watch-record.js --dry-run  取得して件数だけ表示する（保存しない）
//   node src/tot-watch-record.js --check                    毎営業日の確認：前日・当日の結果、最後の記録、空き容量（ToTには接続しない）
//   node src/tot-watch-record.js --check 2026-11-01         指定日の点検結果を詳しく表示する
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { assertAllowedTime } from './tot-client.js';
import { japanDate } from './reconcile.js';
import { addDays, addMonths } from './tot-relay.js';

const API = 'https://api.kingtime.jp/v1.0';
export const SCHEMA = 1;
export const SLOTS = ['08:02', '10:02', '11:02', '12:02', '13:02', '14:02', '15:02', '16:02', '22:35'];
export const RETAIN_DAYS = 400;                 // 約13か月
const FORBIDDEN = [[510, 600], [1050, 1110]];   // ToTの利用禁止時間帯（分）：8:30〜10:00・17:30〜18:30
const REQUEST_RETRY_WAITS = [5000, 30000, 60000];
const RUN_RETRY_WAIT = 5 * 60 * 1000;
const RUN_MAX_MINUTES = 10;                     // 1回の取得にかかる時間の上限の見込み（再試行の判断に使う）
const LOCK_STALE_MS = 15 * 60 * 1000;

/** 日本時間の「時×60＋分」 */
export function japanMinutes(d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  return Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value);
}

/** 次の利用禁止時間帯が始まるまでの分（禁止時間帯の中なら0） */
export function minutesToForbidden(d) {
  const m = japanMinutes(d);
  if (FORBIDDEN.some(([a, b]) => m >= a && m < b)) return 0;
  const next = FORBIDDEN.map(([a]) => (a > m ? a - m : a + 1440 - m));
  return Math.min(...next);
}

/** 5分後にやり直しても、禁止時間帯に入らずに終われるか */
export function canRetryRun(d) {
  return minutesToForbidden(d) > RUN_RETRY_WAIT / 60000 + RUN_MAX_MINUTES;
}

/** 実行時刻から記録の枠（"08:02" など）を決める。予定の時刻から±20分以内でなければ「手動-HHMM」 */
export function slotFor(d) {
  const m = japanMinutes(d);
  for (const s of SLOTS) {
    const sm = Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    if (Math.abs(m - sm) <= 20) return s;
  }
  return `手動-${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
}

/** 取得する範囲（前日〜当日の予定・打刻、今月と前月の打刻申請、在籍者のキー・コード・入社日） */
export function watchPlan(today) {
  const ym = today.slice(0, 7), y = addDays(today, -1);
  return [
    { name: 'employees', path: `/employees?date=${today}&includeResigner=false&additionalFields=hiredDate` },
    { name: 'schedules', path: `/daily-schedules?start=${y}&end=${today}` },
    { name: 'timerecord', path: `/daily-workings/timerecord?start=${y}&end=${today}` },
    { name: 'requests', month: ym, path: `/requests/timerecords/${ym}` },
    { name: 'requests', month: addMonths(ym, -1), path: `/requests/timerecords/${addMonths(ym, -1)}` },
  ];
}

const punch = x => ({ code: String(x.code), time: x.time });

/** 保存する項目だけに絞る（氏名・メッセージ・コメント・位置情報は捨てる） */
export function slim(name, data) {
  if (name === 'employees') {
    return (Array.isArray(data) ? data : []).map(e => ({ key: e.key, code: e.code, hiredDate: e.hiredDate || null }));
  }
  if (name === 'schedules') {
    const out = [];
    for (const d of Array.isArray(data) ? data : []) for (const s of d.dailySchedules || []) {
      const h = s.holidaysObtained || {};
      out.push({ date: s.date, employeeKey: s.employeeKey, clockInSchedule: s.clockInSchedule || null, clockOutSchedule: s.clockOutSchedule || null,
        workDayTypeName: s.workDayTypeName || null, scheduleTypeName: s.scheduleTypeName || null,
        fulltimeHoliday: (h.fulltimeHoliday && h.fulltimeHoliday.name) || null,
        halfdayHolidays: (h.halfdayHolidays || []).map(x => x && x.name).filter(Boolean) });
    }
    return out;
  }
  if (name === 'timerecord') {
    const out = [];
    for (const d of Array.isArray(data) ? data : []) for (const w of d.dailyWorkings || []) {
      out.push({ date: w.date, employeeKey: w.employeeKey,
        punches: (w.timeRecord || []).filter(x => String(x.code) === '1' || String(x.code) === '2').map(punch) });
    }
    return out;
  }
  if (name === 'requests') {
    return ((data && data.requests) || []).map(r => ({ requestKey: r.requestKey, date: r.date, employeeKey: r.employeeKey,
      status: r.status, applicantType: (r.applicant && r.applicant.type) || null, requestedDate: r.requestedDate || null,
      requested: [].concat(r.requested || []).map(x => ({ code: String(x.code), time: x.time, isDelete: !!x.isDelete })),
      current: [].concat(r.current || []).map(punch) }));
  }
  return null;
}

/** 1件の取得（GETのみ）。混雑・サーバーエラー・通信切れは最大3回まで再試行。禁止時間帯・権限エラーは再試行しない */
export async function getWithRetry(pathName, { token, fetchImpl, now, wait }) {
  let last = null;
  for (let i = 0; i <= REQUEST_RETRY_WAITS.length; i++) {
    if (i > 0) await wait(REQUEST_RETRY_WAITS[i - 1]);
    assertAllowedTime(now());
    try {
      const res = await fetchImpl(`${API}${pathName}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (res.ok) return { status: res.status, data: await res.json() };
      last = res.status;
      if (!(res.status === 429 || res.status >= 500)) return { status: res.status, data: null };
    } catch (e) {
      if (/禁止時間帯/.test(e.message)) throw e;
      last = 'network';
    }
  }
  return { status: last, data: null };
}

/** 1回分の取得（成否は項目ごと） */
export async function fetchSnapshot({ token, fetchImpl, now, wait }) {
  const fetchedAt = now();
  const today = japanDate(fetchedAt);
  const snap = { schema: SCHEMA, fetchedAt: fetchedAt.toISOString(), today, slot: slotFor(fetchedAt), parts: {}, data: { requests: {} } };
  let first = true;
  for (const item of watchPlan(today)) {
    if (!first) await wait(1100);
    first = false;
    const r = await getWithRetry(item.path, { token, fetchImpl, now, wait });
    const key = item.month ? `requests:${item.month}` : item.name;
    snap.parts[key] = r.status;
    if (r.data != null) {
      if (item.month) snap.data.requests[item.month] = slim('requests', r.data);
      else snap.data[item.name] = slim(item.name, r.data);
    }
  }
  snap.ok = Object.values(snap.parts).every(s => s === 200);
  return snap;
}

export function countsOf(snap) {
  const d = snap.data || {};
  return { employees: (d.employees || []).length, schedules: (d.schedules || []).length,
    punches: (d.timerecord || []).reduce((n, w) => n + w.punches.length, 0),
    requests: Object.values(d.requests || {}).reduce((n, a) => n + a.length, 0) };
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

/** 置き場所の準備（本人だけが読み書きできる権限） */
export function ensureDirs(dir) {
  for (const d of [dir, path.join(dir, 'raw'), path.join(dir, 'archive'), path.join(dir, 'status')]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

/** 同時に2つ動かないための鍵（15分以上前の鍵は古いものとして取り直す） */
export function acquireLock(dir, nowMs = Date.now()) {
  const f = path.join(dir, '.lock');
  try {
    const st = fs.statSync(f);
    if (nowMs - st.mtimeMs > LOCK_STALE_MS) fs.rmSync(f, { force: true });
  } catch { /* 鍵なし */ }
  try { fs.writeFileSync(f, String(process.pid), { flag: 'wx', mode: 0o600 }); return () => fs.rmSync(f, { force: true }); }
  catch { return null; }
}

export function rawName(snap) { return `${snap.today}_${snap.slot.replace(':', '')}.json`; }

/** 書きかけが残らないよう一時ファイル→名前変更。読み直して指紋を確かめる */
export function saveSnapshot(dir, snap) {
  const file = path.join(dir, 'raw', rawName(snap));
  const body = JSON.stringify(snap);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  const back = fs.readFileSync(file, 'utf8');
  JSON.parse(back);
  if (sha256(back) !== sha256(body)) throw new Error('保存したファイルの確認に失敗しました');
  return { file: path.basename(file), sha256: sha256(body) };
}

export function appendManifest(dir, entry) {
  fs.appendFileSync(path.join(dir, 'manifest.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

export function readManifest(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { broken: true }; } });
}

/** その日・その枠の記録が成功済みか */
export function slotDone(manifest, today, slot) {
  return manifest.some(e => e.today === today && e.slot === slot && e.ok === true);
}

/** 点検：その日の予定の枠のうち、成功・一部失敗・失敗・欠け（実行なし）を数える。ファイルの存在と指紋も確かめる */
export function checkDay(dir, date, manifest = readManifest(dir), { upTo = null } = {}) {
  const slots = upTo ? SLOTS.filter(s => s <= upTo) : SLOTS;
  const result = { date, expected: slots.length, ok: [], partial: [], failed: [], missing: [], broken: [] };
  for (const s of slots) {
    const es = manifest.filter(e => e.today === date && e.slot === s);
    const good = es.find(e => e.ok === true);
    if (good) {
      let fine = false;
      try { fine = sha256(fs.readFileSync(path.join(dir, 'raw', good.file), 'utf8')) === good.sha256; } catch { /* なし */ }
      (fine ? result.ok : result.broken).push(s);
    } else if (es.some(e => e.saved)) result.partial.push(s);
    else if (es.length) result.failed.push(s);
    else result.missing.push(s);
  }
  result.healthy = result.ok.length === result.expected;
  return result;
}

export function writeStatus(dir, st) {
  fs.writeFileSync(path.join(dir, 'status', `${st.date}.json`), JSON.stringify(st), { mode: 0o600 });
}

/** その日の記録を1つにまとめて圧縮（誤って消した場合への備え）。既にあれば作り直す */
export function archiveDay(dir, date) {
  const files = fs.readdirSync(path.join(dir, 'raw')).filter(f => f.startsWith(`${date}_`) && f.endsWith('.json')).sort();
  const lines = files.map(f => fs.readFileSync(path.join(dir, 'raw', f), 'utf8')).join('\n') + '\n';
  const out = path.join(dir, 'archive', `${date}.jsonl.gz`);
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, zlib.gzipSync(lines), { mode: 0o600 });
  fs.renameSync(tmp, out);
  return { files: files.length, archive: path.basename(out) };
}

/** 保存期間（約13か月）を過ぎた記録・まとめ・点検結果を消す */
export function pruneOld(dir, today, days = RETAIN_DAYS) {
  const limit = addDays(today, -days);
  let removed = 0;
  for (const sub of ['raw', 'archive', 'status']) {
    for (const f of fs.readdirSync(path.join(dir, sub))) {
      const d = f.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < limit) { fs.rmSync(path.join(dir, sub, f), { force: true }); removed++; }
    }
  }
  return removed;
}

/**
 * 後で取り込むとき用（純粋関数）：記録を古い順に読み、打刻ごとに「最初に確認した日時」を組み立てる。
 * insertedLate：打刻時刻＋猶予の後に取得したのに、その取得には無く、後で初めて現れた打刻（後から差し込まれた可能性）。
 * disappeared：一度確認した打刻が、同じ勤務日を含む後の取得で消えた。
 */
export function replayFirstSeen(snaps, delayMinutes = 15) {
  const ok = snaps.filter(s => s.parts && s.parts.timerecord === 200 && s.data && s.data.timerecord)
    .sort((a, b) => (a.fetchedAt < b.fetchedAt ? -1 : 1));
  const seen = new Map();
  for (const s of ok) {
    const here = new Set();
    const dates = new Set(s.data.timerecord.map(w => w.date));
    for (const w of s.data.timerecord) for (const p of w.punches) {
      const k = `${w.employeeKey}|${w.date}|${p.code}|${p.time}`;
      here.add(k);
      if (!seen.has(k)) {
        const due = new Date(new Date(p.time).getTime() + delayMinutes * 60000).toISOString();
        const missedBy = ok.find(o => o.fetchedAt >= due && o.fetchedAt < s.fetchedAt && o.data.timerecord.some(x => x.date === w.date));
        seen.set(k, { firstSeen: s.fetchedAt, lastSeen: s.fetchedAt, insertedLate: !!missedBy, disappeared: null });
      } else seen.get(k).lastSeen = s.fetchedAt;
    }
    for (const [k, v] of seen) {
      if (!here.has(k) && !v.disappeared && dates.has(k.split('|')[1])) v.disappeared = s.fetchedAt;
    }
  }
  return seen;
}

/** 1回の記録（cronから呼ぶ） */
export async function runRecord({ env = process.env, fetchImpl = fetch, now = () => new Date(), wait = ms => new Promise(r => setTimeout(r, ms)),
  log = console.log, dir = env.WATCH_DATA_DIR || path.join(os.homedir(), 'watch-data'), dryRun = false } = {}) {
  const token = env.TOT_ACCESS_TOKEN;
  if (!token) throw new Error('サーバーの .env に TOT_ACCESS_TOKEN を設定してください。');
  if (minutesToForbidden(now()) === 0) { log(JSON.stringify({ skip: 'ToTの利用禁止時間帯' })); return { skipped: true }; }
  if (dryRun) {
    const snap = await fetchSnapshot({ token, fetchImpl, now, wait });
    log(JSON.stringify({ dryRun: true, slot: snap.slot, ok: snap.ok, parts: snap.parts, counts: countsOf(snap) }));
    return { snap };
  }
  ensureDirs(dir);
  const release = acquireLock(dir, now().getTime());
  if (!release) { log(JSON.stringify({ skip: '別の記録が実行中' })); return { skipped: true }; }
  try {
    const startSlot = slotFor(now()), startDay = japanDate(now());
    if (slotDone(readManifest(dir), startDay, startSlot)) { log(JSON.stringify({ skip: '記録済み', slot: startSlot })); return { skipped: true }; }
    let snap = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let error = null;
      try { snap = await fetchSnapshot({ token, fetchImpl, now, wait }); } catch (e) { error = /禁止時間帯/.test(e.message) ? 'forbidden' : 'error'; snap = null; }
      const saved = snap && Object.values(snap.parts).some(s => s === 200) ? saveSnapshot(dir, snap) : null;
      const entry = { schema: SCHEMA, at: now().toISOString(), today: snap ? snap.today : startDay, slot: snap ? snap.slot : startSlot, attempt,
        ok: !!(snap && snap.ok), saved: !!saved, file: saved && saved.file, sha256: saved && saved.sha256,
        parts: snap ? snap.parts : null, counts: snap ? countsOf(snap) : null, error };
      appendManifest(dir, entry);
      log(JSON.stringify({ slot: entry.slot, attempt, ok: entry.ok, parts: entry.parts, counts: entry.counts, error }));
      if (entry.ok || error === 'forbidden' || attempt === 2 || !canRetryRun(now())) break;
      await wait(RUN_RETRY_WAIT);
    }
    // 点検：8:02の回は前日分（22:35を含む）、22:35の回はその日の分。結果は status/ に残す（通知はしない）
    const today = japanDate(now()), slot = slotFor(now());
    const targets = slot === '08:02' ? [addDays(today, -1), today] : slot === '22:35' ? [today] : [];
    for (const d of targets) {
      const st = checkDay(dir, d, readManifest(dir), { upTo: d === today && slot !== '22:35' ? slot : null });
      writeStatus(dir, st);
      log(JSON.stringify({ check: d, healthy: st.healthy, ok: st.ok.length, expected: st.expected,
        partial: st.partial, failed: st.failed, missing: st.missing, broken: st.broken }));
    }
    if (slot === '22:35') {
      const a = archiveDay(dir, today);
      const removed = pruneOld(dir, today);
      log(JSON.stringify({ archive: a.archive, files: a.files, removed }));
    }
    return { snap };
  } finally { release(); }
}

/**
 * 毎営業日の確認用（ToTには接続しない・読み取りのみ）：前日と当日の点検結果、最後の記録、空き容量を1画面で表示する。
 * 当日は「今の時刻までに予定されていた回」だけを数える。
 */
export function dailyReport(dir, now = new Date()) {
  const today = japanDate(now), m = japanMinutes(now);
  const upTo = SLOTS.filter(s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) + 10 <= m).pop() || null;
  const manifest = readManifest(dir);
  const fmt = st => `${st.date}：${st.healthy ? '正常' : '要確認'}（成功 ${st.ok.length}/${st.expected}`
    + (st.partial.length ? `・一部失敗 ${st.partial.join(',')}` : '') + (st.failed.length ? `・失敗 ${st.failed.join(',')}` : '')
    + (st.missing.length ? `・実行なし ${st.missing.join(',')}` : '') + (st.broken.length ? `・ファイル不一致 ${st.broken.join(',')}` : '') + '）';
  const lines = [fmt(checkDay(dir, addDays(today, -1), manifest))];
  lines.push(upTo ? fmt(checkDay(dir, today, manifest, { upTo })) : `${today}：まだ予定の回なし`);
  const last = manifest.filter(e => !e.broken).at(-1);
  lines.push(`最後の記録：${last ? `${last.today} ${last.slot}（${last.ok ? '成功' : '失敗'}）` : 'なし'}`);
  try {
    const f = fs.statfsSync(dir);
    lines.push(`空き容量：${Math.round((f.bavail * f.bsize) / 1024 / 1024)}MB`);
  } catch { lines.push('空き容量：確認できません（保存先なし）'); }
  return lines.join('\n');
}

export function showCheck(dir, date) {
  return date ? JSON.stringify(checkDay(dir, date)) : dailyReport(dir);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dir = process.env.WATCH_DATA_DIR || path.join(os.homedir(), 'watch-data');
  if (args[0] === '--check') console.log(showCheck(dir, args[1]));
  else runRecord({ dryRun: args.includes('--dry-run') }).catch(e => { console.error(e.message); process.exitCode = 1; });
}
