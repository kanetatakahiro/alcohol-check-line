import test from 'node:test';
import assert from 'node:assert/strict';
import { planItem, runWrite, safeToRun, toPutBody, matches, shiftIso, spans, snapshot } from '../src/tot-write.js';

// VPS の TOT への書き込み（src/tot-write.js・版 2026-11-13c）。すべて架空データ。TOT・Apps Script は模擬（通信しない）
const TODAY = '2026-11-13';
const T = (d, hm) => `${d}T${hm}+09:00`;
const work = (d, o = {}) => ({ date: d, employeeKey: 'k001', clockInSchedule: T(d, '09:00'), clockOutSchedule: T(d, '18:00'), workDayTypeName: '平日',
  workPlaceDivisionCode: '100', startEndBreakSchedule: [{ start: T(d, '12:00'), end: T(d, '13:00') }], note: '架空の備考', ...o });
const off = (d, code = 9, o = {}) => ({ date: d, employeeKey: 'k001', workDayTypeName: '法定外休日', workPlaceDivisionCode: '100', holidaysObtained: { fulltimeHoliday: { code, name: { 9: '公休', 1: '有休', 3: '欠勤' }[code] } }, ...o });
const by = (...xs) => Object.fromEntries(xs.map((x) => [x.date, x]));
const LEAVE = (dates, code = '3') => ({ id: 'S-20261113-001', op: 'apply', employeeKey: 'k001', note: 'LINE承認：S-20261113-001', kind: 'leave', holidayCode: code, dates });
const SWAP = { id: 'S-20261113-002', op: 'apply', employeeKey: 'k001', note: 'LINE承認：S-20261113-002', kind: 'swap', from: '2026-11-21', to: '2026-11-20' };

test('計画：欠勤・有給は出勤の日だけを全日休暇に（出勤先・勤務日種別は引き継ぎ、時刻と休憩は消す）。休みの日は変えない', () => {
  const p = planItem(LEAVE(['2026-11-16', '2026-11-17', '2026-11-18']), by(work('2026-11-16'), off('2026-11-17', 3), off('2026-11-18')), {}, TODAY);
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.writes, [{ date: '2026-11-16', body: { fulltimeHoliday: { code: 3 }, workDayTypeCode: '1', note: '架空の備考 LINE承認：S-20261113-001', workPlaceDivisionCode: '100' } }]);
  assert.deepEqual(p.skipped, ['2026-11-18']);
  assert.deepEqual(Object.keys(p.before), ['2026-11-16']);
  assert.equal(p.before['2026-11-16'].clockInSchedule, T('2026-11-16', '09:00'));
  // すでに全部が目的の内容 → already。全部が休み → noWork
  assert.equal(planItem(LEAVE(['2026-11-17']), by(off('2026-11-17', 3)), {}, TODAY).status, 'already');
  assert.deepEqual([planItem(LEAVE(['2026-11-18'], '1'), by(off('2026-11-18')), {}, TODAY)].map((x) => [x.status, x.reason]), [['failed', 'noWork']]);
});

test('計画：過ぎた日・打刻のある日は全部を書かない。勤務日種別が読めなければ書かない', () => {
  assert.equal(planItem(LEAVE(['2026-11-12', '2026-11-16']), by(work('2026-11-16')), {}, TODAY).reason, 'past');
  assert.equal(planItem(LEAVE(['2026-11-13', '2026-11-16']), by(work('2026-11-13'), work('2026-11-16')), { '2026-11-13': true }, TODAY).reason, 'punched');
  assert.equal(planItem(LEAVE(['2026-11-13']), by(work('2026-11-13')), {}, TODAY).status, 'ready');   // 今日でも打刻が無ければ書く
  assert.equal(planItem(LEAVE(['2026-11-16']), by(work('2026-11-16', { workDayTypeName: '不明' })), {}, TODAY).reason, 'dayType');
});

test('計画：休みの変更は入れ替え（休みの日 ← 出勤の日の予定を日付をずらして、出勤の日 ← 休みの日の休暇区分と勤務日種別）', () => {
  const p = planItem(SWAP, by(off('2026-11-21'), work('2026-11-20', { clockOutSchedule: T('2026-11-21', '01:00') })), {}, TODAY);
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.writes, [
    { date: '2026-11-21', body: { workDayTypeCode: '1', note: 'LINE承認：S-20261113-002', workPlaceDivisionCode: '100', clockInSchedule: T('2026-11-21', '09:00'),
      clockOutSchedule: T('2026-11-22', '01:00'), startEndBreakSchedule: [{ start: T('2026-11-21', '12:00'), end: T('2026-11-21', '13:00') }] } },
    { date: '2026-11-20', body: { fulltimeHoliday: { code: 9 }, workDayTypeCode: '3', note: '架空の備考 LINE承認：S-20261113-002', workPlaceDivisionCode: '100' } },
  ]);
  assert.deepEqual(Object.keys(p.before).sort(), ['2026-11-20', '2026-11-21']);
  // もう入れ替わっている → already。入れ替えられない（両方出勤・休みの日が無い） → cannotSwap
  assert.equal(planItem(SWAP, by(work('2026-11-21'), off('2026-11-20')), {}, TODAY).status, 'already');
  assert.equal(planItem(SWAP, by(work('2026-11-21'), work('2026-11-20')), {}, TODAY).reason, 'cannotSwap');
  assert.equal(planItem(SWAP, by(work('2026-11-20')), {}, TODAY).reason, 'cannotSwap');
});

test('計画：元に戻す（保存した予定を PUT、予定の無かった日は DELETE、同じなら書かない）', () => {
  const before = { '2026-11-16': snapshot(work('2026-11-16')), '2026-11-17': null, '2026-11-18': snapshot(off('2026-11-18')) };
  const p = planItem({ id: 'S-20261113-001', op: 'undo', employeeKey: 'k001', before }, by(off('2026-11-16', 3), off('2026-11-17', 3), off('2026-11-18')), {}, TODAY);
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.writes.map((w) => [w.date, w.body && w.body.clockInSchedule, w.body === null]), [['2026-11-16', T('2026-11-16', '09:00'), false], ['2026-11-17', null, true]]);
  assert.deepEqual(p.writes[0].body.startEndBreakSchedule, [{ start: T('2026-11-16', '12:00'), end: T('2026-11-16', '13:00') }]);
});

test('部品：時間帯・日付のずらし・GET の期間・PUT の本文と比べ方', () => {
  const at = (hm) => new Date(`2026-11-13T${hm}:00+09:00`);
  assert.deepEqual(['07:03', '08:19', '08:20', '09:59', '10:00', '17:19', '17:20', '18:29', '18:30', '22:53'].map((h) => safeToRun(at(h))),
    [true, true, false, false, true, true, false, false, true, true]);
  assert.equal(shiftIso('2026-11-30T09:00+09:00', 2), '2026-12-02T09:00+09:00');
  assert.deepEqual(spans(['2026-11-20', '2026-11-16', '2027-02-01', '2026-11-20']), [{ start: '2026-11-16', end: '2026-11-20' }, { start: '2027-02-01', end: '2027-02-01' }]);
  const b = toPutBody(off('2026-11-18', 9, { note: 'x' }));
  assert.deepEqual(b, { workPlaceDivisionCode: '100', fulltimeHoliday: { code: 9 }, workDayTypeCode: '3', note: 'x' });
  assert.equal(matches(off('2026-11-18'), b), true);
  assert.equal(matches(work('2026-11-18'), b), false);
  assert.equal(matches({ clockInSchedule: '2026-11-18T09:00:00+09:00', clockOutSchedule: '2026-11-18T18:00:00+09:00', workDayTypeName: '平日' },
    { clockInSchedule: '2026-11-18T09:00+09:00', clockOutSchedule: '2026-11-18T18:00+09:00', workDayTypeCode: '1' }), true);   // 秒の有無は同じ
  assert.equal(toPutBody({ workDayTypeName: '' }), null);
});

// ---- 模擬の TOT と Apps Script ----
const GAS = 'https://script.google.com/macros/s/fake-id/exec';
const ENV = { TOT_ACCESS_TOKEN: 'read-token', TOT_WRITE_TOKEN: 'write-token', GAS_WEBAPP_URL: GAS, TOT_SYNC_SECRET: 'fake-secret' };
function fake({ items = [], sched = {}, punches = {}, failPut = null }) {
  const calls = [], results = [];
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchImpl = async (url, opt) => {
    const auth = opt.headers && opt.headers.Authorization;
    calls.push({ method: opt.method, url: url.replace('https://api.kingtime.jp/v1.0', ''), auth, body: opt.body ? JSON.parse(opt.body) : null });
    if (url === GAS) {
      const b = JSON.parse(opt.body);
      assert.equal(b.secret, 'fake-secret');
      if (b.type === 'tot-write-queue') return res(200, { ok: true, mode: 'on', items });
      results.push(b);
      return res(200, 'OK');
    }
    const u = new URL(url), path = u.pathname.replace('/v1.0', '');
    if (opt.method === 'GET' && path === '/daily-schedules') {
      const s = u.searchParams.get('start'), e = u.searchParams.get('end');
      return res(200, [{ date: s, dailySchedules: Object.values(sched).filter((x) => x.date >= s && x.date <= e).concat([{ ...work(s), employeeKey: 'k999' }]) }]);
    }
    if (opt.method === 'GET' && path === '/daily-workings/timerecord') {
      assert.equal(u.searchParams.get('employeeKeys'), 'k001');
      return res(200, [{ dailyWorkings: Object.keys(punches).map((d) => ({ date: d, employeeKey: 'k001', timeRecord: [{ code: '1' }] })) }]);
    }
    const m = /^\/daily-schedules\/k001\/(\d{4}-\d{2}-\d{2})$/.exec(path);
    if (m && (opt.method === 'PUT' || opt.method === 'DELETE')) {
      assert.equal(auth, 'Bearer write-token', '書き込みは書き込み用のトークン');
      if (failPut === m[1]) return res(400, { errors: [{ code: 999, message: '架空のエラー' }] });
      if (opt.method === 'DELETE') { delete sched[m[1]]; return res(204, null); }
      const b = JSON.parse(opt.body);
      sched[m[1]] = { date: m[1], employeeKey: 'k001', clockInSchedule: b.clockInSchedule, clockOutSchedule: b.clockOutSchedule,
        workDayTypeName: { 1: '平日', 2: '法定休日', 3: '法定外休日' }[b.workDayTypeCode], ...(b.fulltimeHoliday ? { holidaysObtained: { fulltimeHoliday: { code: b.fulltimeHoliday.code } } } : {}) };
      return res(200, { date: m[1] });
    }
    throw new Error('想定外の通信先 ' + opt.method + ' ' + path);
  };
  return { fetchImpl, calls, results, sched };
}
const run = (f, o = {}) => { const logs = []; return runWrite({ env: ENV, fetchImpl: f.fetchImpl, now: () => new Date('2026-11-13T12:03:00+09:00'), wait: async () => {}, log: (x) => logs.push(x), ...o }).then((r) => ({ r, logs })); };

test('実行：欠勤を書き込み → 読み直して確かめ → 結果（反映前のスケジュール付き）を返す。ログに従業員識別キー・トークン・備考を出さない', async () => {
  const f = fake({ items: [LEAVE(['2026-11-16', '2026-11-18'])], sched: by(work('2026-11-16'), off('2026-11-18')) });
  const { logs } = await run(f);
  assert.deepEqual(f.calls.filter((c) => c.method !== 'GET' && c.method !== 'POST').map((c) => [c.method, c.url]), [['PUT', '/daily-schedules/k001/2026-11-16']]);
  assert.equal(f.calls.filter((c) => c.method === 'GET').every((c) => c.auth === 'Bearer read-token'), true);
  assert.equal(f.results.length, 1);
  const r = f.results[0];
  assert.deepEqual([r.type, r.id, r.op, r.status, r.written, r.skipped], ['tot-write-result', 'S-20261113-001', 'apply', 'done', ['2026-11-16'], ['2026-11-18']]);
  assert.equal(r.before['2026-11-16'].clockInSchedule, T('2026-11-16', '09:00'));
  assert.equal(f.sched['2026-11-16'].holidaysObtained.fulltimeHoliday.code, 3);
  const log = logs.join('\n');
  for (const s of ['k001', 'read-token', 'write-token', 'fake-secret', '架空の備考', '09:00']) assert.ok(!log.includes(s), s);
});

test('実行：打刻がある日は書かずに失敗を返す／TOT のエラーは code と message を返す', async () => {
  const f = fake({ items: [LEAVE(['2026-11-16'])], sched: by(work('2026-11-16')), punches: { '2026-11-16': true } });
  await run(f);
  assert.equal(f.calls.some((c) => c.method === 'PUT'), false);
  assert.deepEqual([f.results[0].status, f.results[0].reason], ['failed', 'punched']);
  const g = fake({ items: [SWAP], sched: by(off('2026-11-21'), work('2026-11-20')), failPut: '2026-11-20' });
  await run(g);
  assert.deepEqual([g.results[0].status, g.results[0].reason, g.results[0].written, g.results[0].errors], ['failed', 'api', ['2026-11-21'], [{ code: 999, message: '架空のエラー' }]]);
});

test('実行：書き込み用のトークンが無い・禁止の時間帯の直前は何もしない（Apps Script にも行かない）。試し実行は peek で読むだけ', async () => {
  const f = fake({ items: [LEAVE(['2026-11-16'])], sched: by(work('2026-11-16')) });
  assert.deepEqual((await run(f, { env: { ...ENV, TOT_WRITE_TOKEN: '' } })).r, { skipped: 'noToken' });
  assert.deepEqual((await run(f, { now: () => new Date('2026-11-13T08:25:00+09:00') })).r, { skipped: 'time' });
  assert.equal(f.calls.length, 0);
  const { r, logs } = await run(f, { dryRun: true, env: { ...ENV, TOT_WRITE_TOKEN: '' } });
  assert.equal(JSON.parse(f.calls[0].body ? JSON.stringify(f.calls[0].body) : '{}').peek, true);
  assert.equal(f.calls.some((c) => c.method === 'PUT' || c.method === 'DELETE'), false);
  assert.equal(f.results.length, 0);
  assert.deepEqual(r.summary, [{ id: 'S-20261113-001', op: 'apply', method: '', status: 'ready', reason: '', writes: 1, skipped: 0, requests: 0 }]);
  assert.match(logs[0], /"dryRun":true/);
});

test('実行：読み取りに失敗したら結果を返さない（Apps Script が30分後にもう一度渡す）', async () => {
  const f = fake({ items: [LEAVE(['2026-11-16'])], sched: by(work('2026-11-16')) });
  const orig = f.fetchImpl;
  f.fetchImpl = async (url, opt) => (url.includes('/daily-schedules?') ? { ok: false, status: 429, json: async () => ({}), text: async () => '' } : orig(url, opt));
  const { r } = await run(f);
  assert.equal(f.results.length, 0);
  assert.deepEqual(r.summary, [{ id: 'S-20261113-001', op: 'apply', status: 'retry', http: 429 }]);
});
