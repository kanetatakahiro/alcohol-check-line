// さくらのVPS（固定IP）で10分ごとに動かす：Touch On Time（TOT）の日別スケジュールへの書き込み（版 2026-11-13c）。
// 設計：docs/TOT_SCHEDULE_SYNC_DESIGN.md。Apps Script（gas/TotSync.gs）の「反映待ち」を取りに行き、1件ずつ TOT に書き込んで結果を返す。
//  1. Apps Script の Webアプリへ { type: 'tot-write-queue' } → 反映待ちを受け取る（Apps Script が「反映中」にする。TOT_WRITE=on のときだけ届く）
//  2. 1件ずつ：その日のスケジュールと打刻を読み直す（GET）→ 過ぎた日・打刻がある日は書かない → もう目的の内容なら書かない
//     → PUT /daily-schedules/{employeeKey}/{date}（反映前に予定が無かった日を元に戻すときは DELETE）→ もう一度読んで確かめる
//  3. { type: 'tot-write-result' } で結果（反映前のスケジュールを含む）を返す
// 必要な環境変数（サーバーの .env。Gitには入れない）：
//   TOT_ACCESS_TOKEN  読み取り用（今の中継と同じ）
//   TOT_WRITE_TOKEN   書き込み用（連携希望項目「日別スケジュールデータ（書き込み）」）。無ければ何もしない
//   GAS_WEBAPP_URL・TOT_SYNC_SECRET  今の中継と同じ
// 試し実行：node --env-file=.env src/tot-write.js --dry-run
//   反映待ちを「反映中」にせずに受け取り（peek）、TOT を読むだけで、書き込む予定の件数をログに出す（TOT へは書かない・結果も返さない）
// ログに出すもの：受付番号・操作・結果・理由・日数・HTTP状態だけ。トークン・合言葉・従業員識別キー・氏名・時刻・備考は出さない。
import { assertAllowedTime, validateDate } from './tot-client.js';
import { japanDate } from './reconcile.js';
import { addDays } from './tot-relay.js';

const API = 'https://api.kingtime.jp/v1.0';
export const DAY_TYPE = { 平日: '1', 法定休日: '2', 法定外休日: '3' };
const MAX_ITEMS = 10;

/** 日本時間の分（0〜1439） */
function japanMinute(d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  return Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value);
}

/** 利用禁止の時間帯（8:30〜10:00・17:30〜18:30）の10分前からは始めない（途中で禁止の時間帯に入らないように） */
export function safeToRun(now) {
  const m = japanMinute(now);
  return !((m >= 500 && m < 600) || (m >= 1040 && m < 1110));
}

export function dayTypeCode(name) { return DAY_TYPE[String(name || '').trim()] || ''; }

export function holidayOf(s) {
  const f = s && s.holidaysObtained && s.holidaysObtained.fulltimeHoliday;
  return f && f.code !== undefined && f.code !== null && f.code !== '' ? String(f.code) : '';
}

/** 予定が何も無い（出勤予定も休暇も無い） */
export function isEmpty(s) {
  const h = (s && s.holidaysObtained) || {};
  return !s || (!s.clockInSchedule && !holidayOf(s) && !(h.halfdayHolidays || []).length && !(h.hourHolidays || []).length);
}

/** 日時の文字（2026-11-15T09:00+09:00）の日付を n 日ずらす */
export function shiftIso(iso, n) {
  const m = /^(\d{4}-\d{2}-\d{2})(T.*)$/.exec(String(iso || ''));
  return m ? addDays(m[1], n) + m[2] : iso;
}

function daysBetween(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); }

/** 反映前のスケジュールとして保存する形（GET の形のまま、使う項目だけ）。予定が無ければ null */
export function snapshot(s) {
  if (isEmpty(s)) return null;
  const out = {};
  for (const k of ['workPlaceDivisionCode', 'clockInSchedule', 'clockOutSchedule', 'workFixedStart', 'workFixedEnd', 'startEndBreakSchedule',
    'holidaysObtained', 'workDayTypeName', 'note']) if (s[k] !== undefined && s[k] !== null && s[k] !== '') out[k] = s[k];
  return out;
}

/** GET の形 → PUT の本文。勤務日種別を読み替えられなければ null */
export function toPutBody(s) {
  const b = {}, h = s.holidaysObtained || {};
  if (s.workPlaceDivisionCode) b.workPlaceDivisionCode = String(s.workPlaceDivisionCode);
  for (const k of ['clockInSchedule', 'clockOutSchedule', 'workFixedStart', 'workFixedEnd']) if (s[k]) b[k] = s[k];
  if ((s.startEndBreakSchedule || []).length) b.startEndBreakSchedule = s.startEndBreakSchedule.map(x => ({ start: x.start, end: x.end }));
  if (holidayOf(s)) b.fulltimeHoliday = { code: Number(holidayOf(s)) };
  if ((h.halfdayHolidays || []).length) b.halfdayHolidays = h.halfdayHolidays.map(x => ({ typeName: /PM/i.test(x.typeName) ? 'PM半休' : 'AM半休', code: Number(x.code) }));
  if ((h.hourHolidays || []).length) b.hourHolidays = h.hourHolidays.map(x => ({ start: x.start, end: x.end, code: Number(x.code) }));
  const t = dayTypeCode(s.workDayTypeName);
  if (!t) return null;
  b.workDayTypeCode = t;
  if (s.note) b.note = String(s.note);
  return b;
}

const same = (a, b) => (!a && !b) || (!!a && !!b && Date.parse(a) === Date.parse(b));
/** 今のスケジュール（GET の形）が、PUT の本文と同じ内容か（全日休暇・出勤と退勤の予定・勤務日種別で比べる） */
export function matches(cur, body) {
  if (!body) return isEmpty(cur);
  if (!cur) return false;
  const h = body.fulltimeHoliday ? String(body.fulltimeHoliday.code) : '';
  return holidayOf(cur) === h && same(cur.clockInSchedule, body.clockInSchedule) && same(cur.clockOutSchedule, body.clockOutSchedule)
    && dayTypeCode(cur.workDayTypeName) === String(body.workDayTypeCode || '1');
}

function joinNote(note, mark) {
  const n = String(note || '').trim();
  return (n.includes(mark) ? n : [n, mark].filter(Boolean).join(' ')).slice(0, 200);
}

/** 1件の対象の日 */
export function itemDates(item) {
  if (item.op === 'undo') return Object.keys(item.before || {}).sort();
  if (item.kind === 'swap') return [item.from, item.to];
  return (item.dates || []).slice();
}

/**
 * 1件の書き込みの計画（TOT は読み直したあと）。sched：{ 日付: その人のスケジュール }、punched：{ 日付: true }
 * 戻り値：{ status: 'ready'|'already'|'failed', reason, writes: [{ date, body（null は DELETE） }], skipped: [日付], before: { 日付: snapshot } }
 */
export function planItem(item, sched, punched, today) {
  const dates = itemDates(item), fail = reason => ({ status: 'failed', reason, writes: [], skipped: [], before: {} });
  if (!dates.length) return fail('noWork');
  dates.forEach(validateDate);
  if (dates.some(d => d < today)) return fail('past');
  if (dates.some(d => punched[d])) return fail('punched');
  const writes = [], skipped = [], before = {};
  if (item.op === 'undo') {
    for (const d of dates) {
      const target = item.before[d], cur = sched[d];
      if (!target) { if (!isEmpty(cur)) writes.push({ date: d, body: null }); continue; }
      const body = toPutBody(target);
      if (!body) return fail('dayType');
      if (!matches(cur, body)) writes.push({ date: d, body });
    }
    return { status: writes.length ? 'ready' : 'already', reason: '', writes, skipped, before };
  }
  if (item.kind === 'swap') {
    const a = sched[item.from], b = sched[item.to];
    if (a && a.clockInSchedule && !holidayOf(a) && holidayOf(b)) return { status: 'already', reason: '', writes, skipped, before };
    if (!(holidayOf(a) && b && b.clockInSchedule && !holidayOf(b))) return fail('cannotSwap');
    const ta = dayTypeCode(b.workDayTypeName), tb = dayTypeCode(a.workDayTypeName);
    if (!ta || !tb) return fail('dayType');
    const n = daysBetween(item.to, item.from), sh = x => shiftIso(x, n);
    const bodyA = { workDayTypeCode: ta, note: joinNote(a.note, item.note) };
    if (b.workPlaceDivisionCode) bodyA.workPlaceDivisionCode = String(b.workPlaceDivisionCode);
    for (const k of ['clockInSchedule', 'clockOutSchedule', 'workFixedStart', 'workFixedEnd']) if (b[k]) bodyA[k] = sh(b[k]);
    if ((b.startEndBreakSchedule || []).length) bodyA.startEndBreakSchedule = b.startEndBreakSchedule.map(x => ({ start: sh(x.start), end: sh(x.end) }));
    const bodyB = { fulltimeHoliday: { code: Number(holidayOf(a)) }, workDayTypeCode: tb, note: joinNote(b.note, item.note) };
    const wpd = b.workPlaceDivisionCode || a.workPlaceDivisionCode;
    if (wpd) bodyB.workPlaceDivisionCode = String(wpd);
    before[item.from] = snapshot(a); before[item.to] = snapshot(b);
    return { status: 'ready', reason: '', writes: [{ date: item.from, body: bodyA }, { date: item.to, body: bodyB }], skipped, before };
  }
  // 欠勤・有給休暇：出勤の予定がある日だけを全日休暇にする（休みの日・予定の無い日は変えない）
  const code = String(item.holidayCode || '');
  if (!code) return fail('noWork');
  let already = 0;
  for (const d of dates) {
    const cur = sched[d], h = holidayOf(cur);
    if (h === code) { already++; continue; }
    if (h || !cur || !cur.clockInSchedule) { skipped.push(d); continue; }
    const t = dayTypeCode(cur.workDayTypeName);
    if (!t) return fail('dayType');
    const body = { fulltimeHoliday: { code: Number(code) }, workDayTypeCode: t, note: joinNote(cur.note, item.note) };
    if (cur.workPlaceDivisionCode) body.workPlaceDivisionCode = String(cur.workPlaceDivisionCode);
    before[d] = snapshot(cur);
    writes.push({ date: d, body });
  }
  if (writes.length) return { status: 'ready', reason: '', writes, skipped, before };
  return already ? { status: 'already', reason: '', writes, skipped, before } : { ...fail('noWork'), skipped };
}

/** 日付の一覧を、62日以内のまとまりに分ける（GET の期間の上限） */
export function spans(dates) {
  const s = [...new Set(dates)].sort(), out = [];
  for (const d of s) {
    const last = out[out.length - 1];
    if (last && daysBetween(last.start, d) < 62) last.end = d; else out.push({ start: d, end: d });
  }
  return out;
}

export async function runWrite({ env = process.env, fetchImpl = fetch, now = () => new Date(), dryRun = false,
  wait = ms => new Promise(r => setTimeout(r, ms)), log = console.log } = {}) {
  const read = env.TOT_ACCESS_TOKEN, write = env.TOT_WRITE_TOKEN, url = env.GAS_WEBAPP_URL, secret = env.TOT_SYNC_SECRET;
  if (!read || !url || !secret) throw new Error('サーバーの .env に TOT_ACCESS_TOKEN / GAS_WEBAPP_URL / TOT_SYNC_SECRET を設定してください。');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('GAS_WEBAPP_URL の形式を確認してください。');
  if (!write && !dryRun) { log(JSON.stringify({ skip: 'TOT_WRITE_TOKEN がないため何もしません' })); return { skipped: 'noToken' }; }
  if (!safeToRun(now())) { log(JSON.stringify({ skip: 'TOT の利用禁止の時間帯（の直前）のため何もしません' })); return { skipped: 'time' }; }
  const today = japanDate(now());

  const gas = async (payload) => {
    const res = await fetchImpl(url, { method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, secret }) });
    return { status: res.status, text: await res.text() };
  };
  let first = true;
  const tot = async (method, path, token, body) => {
    if (!first) await wait(1100);
    first = false;
    assertAllowedTime(now());
    const res = await fetchImpl(`${API}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let json = null;
    if (res.status !== 204) { try { json = await res.json(); } catch { json = null; } }
    const errors = !res.ok && json && Array.isArray(json.errors) ? json.errors.slice(0, 5).map(e => ({ code: e.code, message: e.message })) : [];
    return { ok: res.ok, status: res.status, json, errors };
  };
  /** その人の、対象の日のスケジュールと打刻を読む */
  const readDays = async (key, dates) => {
    const sched = {}, punched = {};
    for (const r of spans(dates)) {
      const s = await tot('GET', `/daily-schedules?start=${r.start}&end=${r.end}`, read);
      if (!s.ok) throw Object.assign(new Error('read'), { status: s.status });
      for (const day of Array.isArray(s.json) ? s.json : []) for (const x of day.dailySchedules || []) if (x.employeeKey === key) sched[x.date] = x;
      const t = await tot('GET', `/daily-workings/timerecord?employeeKeys=${encodeURIComponent(key)}&start=${r.start}&end=${r.end}`, read);
      if (!t.ok) throw Object.assign(new Error('read'), { status: t.status });
      for (const day of Array.isArray(t.json) ? t.json : []) for (const x of day.dailyWorkings || []) if (x.employeeKey === key && (x.timeRecord || []).length) punched[x.date] = true;
    }
    return { sched, punched };
  };

  const q = await gas({ type: 'tot-write-queue', peek: dryRun });
  let queue;
  try { queue = JSON.parse(q.text); } catch { queue = null; }
  if (!queue || !queue.ok) throw new Error(`Apps Script から反映待ちを受け取れませんでした（HTTP ${q.status}）。`);
  const items = (queue.items || []).slice(0, MAX_ITEMS), summary = [];
  for (const item of items) {
    const written = [];
    let result;
    try {
      if (!item || !item.id || !item.employeeKey) continue;
      const dates = itemDates(item);
      const { sched, punched } = await readDays(item.employeeKey, dates);
      const p = planItem(item, sched, punched, today);
      if (dryRun) { summary.push({ id: item.id, op: item.op, status: p.status, reason: p.reason, writes: p.writes.length, skipped: p.skipped.length }); continue; }
      result = { status: p.status === 'ready' ? 'done' : p.status, reason: p.reason, errors: [], written, skipped: p.skipped, before: p.before };
      for (const w of p.writes) {
        const path = `/daily-schedules/${encodeURIComponent(item.employeeKey)}/${w.date}`;
        const r = w.body ? await tot('PUT', path, write, w.body) : await tot('DELETE', path, write);
        if (!r.ok) { result = { ...result, status: 'failed', reason: 'api', errors: r.errors.length ? r.errors : [{ code: r.status, message: 'HTTP ' + r.status }] }; break; }
        written.push(w.date);
      }
      if (result.status === 'done' && written.length) {
        const after = await readDays(item.employeeKey, written);
        const bad = p.writes.filter(w => written.includes(w.date) && !matches(after.sched[w.date], w.body));
        if (bad.length) result = { ...result, status: 'failed', reason: 'verify' };
      }
    } catch (e) {
      // 読み取りの失敗・禁止の時間帯：まだ書いていなければ結果を返さない（Apps Script が30分後にもう一度渡す）
      if (!written.length) { summary.push({ id: item.id, op: item.op, status: 'retry', http: e && e.status }); continue; }
      result = { ...(result || {}), status: 'failed', reason: 'api', errors: [{ code: e && e.status || 0, message: '書き込みの途中で止まりました' }], written };
    }
    const r = await gas({ type: 'tot-write-result', id: item.id, op: item.op, ...result });
    summary.push({ id: item.id, op: item.op, status: result.status, reason: result.reason, written: written.length, skipped: (result.skipped || []).length, gas: r.text.slice(0, 20) });
  }
  log(JSON.stringify({ today, dryRun, items: items.length, summary }));
  return { items: items.length, summary };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWrite({ dryRun: process.argv.includes('--dry-run') }).catch(e => { console.error(e.message); process.exitCode = 1; });
}
