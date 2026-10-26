import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import {
  SLOTS, minutesToForbidden, canRetryRun, slotFor, watchPlan, slim, getWithRetry, runRecord,
  checkDay, readManifest, replayFirstSeen, pruneOld, ensureDirs, acquireLock,
} from '../src/tot-watch-record.js';

// 架空データのみ。日本時間の時刻を Date にする
const jst = s => new Date(`${s}+09:00`);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
const noWait = async () => {};

/** 架空のToT応答。氏名・位置情報・メッセージも混ぜて、保存されないことを確かめる */
function fakeTot({ fail = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    calls.push({ url, opt });
    const p = new URL(url).pathname;
    const name = p.startsWith('/v1.0/employees') ? 'employees' : p.includes('/requests/') ? 'requests'
      : p.includes('/daily-schedules') ? 'schedules' : 'timerecord';
    if (fail[name]) return { ok: false, status: fail[name], json: async () => ({}) };
    const j = {
      employees: [{ key: 'k1', code: '0501', lastName: '試験', firstName: '太郎', hiredDate: '2026-11-10' }],
      schedules: [{ date: '2026-11-01', dailySchedules: [{ date: '2026-11-01', employeeKey: 'k1',
        clockInSchedule: '2026-11-01T09:00+09:00', clockOutSchedule: '2026-11-01T18:00+09:00', workDayTypeName: '平日',
        holidaysObtained: { halfdayHolidays: [{ name: '有休' }] } }] }],
      timerecord: [{ date: '2026-11-01', dailyWorkings: [{ date: '2026-11-01', employeeKey: 'k1', timeRecord: [
        { time: '2026-11-01T09:00:00+09:00', code: '1', name: '出勤', latitude: 35.1, longitude: 139.1 },
        { time: '2026-11-01T12:00:00+09:00', code: '3', name: '休憩開始' }] }] }],
      requests: { requests: [{ requestKey: 'r1', date: '2026-11-01', employeeKey: 'k1', status: 'applying',
        applicant: { type: 'employee', key: 'k1' }, message: '打刻を忘れました（秘密）', adminComment: 'メモ',
        requested: [{ time: '2026-11-01T18:00:00+09:00', code: '2', isDelete: false }], current: [] }] },
    }[name];
    return { ok: true, status: 200, json: async () => j };
  };
  return { fetchImpl, calls };
}

test('記録: 予定の枠は8:02・10:02〜16:02・22:35の9回', () => {
  assert.deepEqual(SLOTS, ['08:02', '10:02', '11:02', '12:02', '13:02', '14:02', '15:02', '16:02', '22:35']);
  assert.equal(slotFor(jst('2026-11-01T10:02:05')), '10:02');
  assert.equal(slotFor(jst('2026-11-01T22:40:00')), '22:35');
  assert.match(slotFor(jst('2026-11-01T19:30:00')), /^手動-1930$/);
});

test('記録: cron 2行の書き方で、予定の9回すべてが禁止時間帯の外', () => {
  const hours = [8, 10, 11, 12, 13, 14, 15, 16];   // 「2 8,10-16 * * *」
  for (const h of hours) assert.ok(minutesToForbidden(jst(`2026-11-01T${String(h).padStart(2, '0')}:02:00`)) > 0, `${h}:02`);
  assert.ok(minutesToForbidden(jst('2026-11-01T22:35:00')) > 0);   // 「35 22 * * *」
  assert.equal(minutesToForbidden(jst('2026-11-01T09:02:00')), 0);
  assert.equal(minutesToForbidden(jst('2026-11-01T17:45:00')), 0);
});

test('記録: 5分後のやり直しは、禁止時間帯に入らずに終われるときだけ', () => {
  assert.ok(canRetryRun(jst('2026-11-01T08:03:00')));    // 8:30まで27分
  assert.ok(!canRetryRun(jst('2026-11-01T08:20:00')));   // 8:30まで10分
  assert.ok(canRetryRun(jst('2026-11-01T16:03:00')));    // 17:30まで87分
  assert.ok(canRetryRun(jst('2026-11-01T22:36:00')));
});

test('記録: 取得範囲（前日〜当日、今月と前月の打刻申請）', () => {
  const p = watchPlan('2026-11-01').map(x => x.path);
  assert.ok(p.some(x => x.includes('/daily-workings/timerecord?start=2026-10-31&end=2026-11-01')));
  assert.ok(p.some(x => x.includes('/daily-schedules?start=2026-10-31&end=2026-11-01')));
  assert.ok(p.includes('/requests/timerecords/2026-11') && p.includes('/requests/timerecords/2026-10'));
  assert.ok(p.some(x => x.includes('additionalFields=hiredDate')));
});

test('記録: 保存する項目に氏名・メッセージ・コメント・位置情報が入らない。出勤・退勤以外の打刻は捨てる', async () => {
  const { fetchImpl } = fakeTot();
  const dir = tmpDir();
  await runRecord({ env: { TOT_ACCESS_TOKEN: 'tok' }, fetchImpl, now: () => jst('2026-11-01T10:02:00'), wait: noWait, log: () => {}, dir });
  const file = fs.readdirSync(path.join(dir, 'raw'))[0];
  const text = fs.readFileSync(path.join(dir, 'raw', file), 'utf8');
  for (const bad of ['試験', '太郎', '秘密', 'メモ', 'latitude', '139.1', 'tok', '休憩']) assert.ok(!text.includes(bad), bad);
  const snap = JSON.parse(text);
  assert.deepEqual(snap.data.timerecord[0].punches, [{ code: '1', time: '2026-11-01T09:00:00+09:00' }]);
  assert.deepEqual(snap.data.requests['2026-11'][0].requested, [{ code: '2', time: '2026-11-01T18:00:00+09:00', isDelete: false }]);
  assert.equal(snap.data.employees[0].hiredDate, '2026-11-10');
  assert.deepEqual(snap.data.schedules[0].halfdayHolidays, ['有休']);
  assert.equal(file, '2026-11-01_1002.json');
  assert.equal((fs.statSync(path.join(dir, 'raw', file)).mode & 0o777), 0o600);
});

test('記録: ToTへはGETだけ（書き込みなし）。ログに個人情報・トークンを出さない', async () => {
  const { fetchImpl, calls } = fakeTot();
  const logs = [];
  await runRecord({ env: { TOT_ACCESS_TOKEN: 'tok' }, fetchImpl, now: () => jst('2026-11-01T10:02:00'), wait: noWait, log: m => logs.push(m), dir: tmpDir() });
  assert.equal(calls.length, 5);
  assert.ok(calls.every(c => c.opt.method === 'GET' && c.url.startsWith('https://api.kingtime.jp/')));
  assert.ok(!/試験|太郎|秘密|tok/.test(logs.join('')));
});

test('記録: 件数だけ表示するモードはファイルを作らない', async () => {
  const { fetchImpl } = fakeTot();
  const dir = path.join(tmpDir(), 'none');
  const logs = [];
  await runRecord({ env: { TOT_ACCESS_TOKEN: 't' }, fetchImpl, now: () => jst('2026-11-01T10:02:00'), wait: noWait, log: m => logs.push(m), dir, dryRun: true });
  assert.ok(!fs.existsSync(dir));
  assert.match(logs[0], /"dryRun":true/);
});

test('記録: 禁止時間帯には何もしない', async () => {
  const { fetchImpl, calls } = fakeTot();
  const r = await runRecord({ env: { TOT_ACCESS_TOKEN: 't' }, fetchImpl, now: () => jst('2026-11-01T09:02:00'), wait: noWait, log: () => {}, dir: tmpDir() });
  assert.ok(r.skipped);
  assert.equal(calls.length, 0);
});

test('記録: 混雑・サーバーエラーは最大3回再試行、権限エラーは再試行しない', async () => {
  let n = 0;
  const waits = [];
  const r = await getWithRetry('/x', { token: 't', now: () => jst('2026-11-01T10:02:00'), wait: async ms => waits.push(ms),
    fetchImpl: async () => (++n < 3 ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => [1] }) });
  assert.equal(r.status, 200);
  assert.deepEqual(waits, [5000, 30000]);
  n = 0;
  const r2 = await getWithRetry('/x', { token: 't', now: () => jst('2026-11-01T10:02:00'), wait: noWait,
    fetchImpl: async () => { n++; return { ok: false, status: 403 }; } });
  assert.equal(r2.status, 403);
  assert.equal(n, 1);
});

test('記録: 再試行の途中で禁止時間帯に入ったら、それ以上ToTへ問い合わせない', async () => {
  let t = jst('2026-11-01T08:29:58').getTime(), calls = 0;
  await assert.rejects(getWithRetry('/x', { token: 't', now: () => new Date(t), wait: async ms => { t += ms; },
    fetchImpl: async () => { calls++; return { ok: false, status: 503 }; } }), /禁止時間帯/);
  assert.equal(calls, 1);
});

test('記録: 一部失敗なら5分後に1回やり直す。失敗した項目は記録に残る', async () => {
  let t = jst('2026-11-01T10:02:00').getTime(), round = 0;
  const dir = tmpDir();
  const base = fakeTot();
  const fetchImpl = async (url, opt) => {
    if (url.includes('/requests/')) { if (round === 0) return { ok: false, status: 403 }; }
    return base.fetchImpl(url, opt);
  };
  const waits = [];
  await runRecord({ env: { TOT_ACCESS_TOKEN: 't' }, fetchImpl, now: () => new Date(t), log: () => {}, dir,
    wait: async ms => { waits.push(ms); if (ms === 300000) round = 1; t += ms; } });
  const m = readManifest(dir);
  assert.equal(m.length, 2);
  assert.equal(m[0].ok, false);
  assert.equal(m[0].parts['requests:2026-11'], 403);
  assert.equal(m[1].ok, true);
  assert.ok(waits.includes(300000));
  assert.ok(checkDay(dir, '2026-11-01', m, { upTo: '10:02' }).ok.includes('10:02'));
});

test('記録: 同じ枠が2回動いても重複しない。実行中の鍵があれば何もしない', async () => {
  const dir = tmpDir();
  const { fetchImpl, calls } = fakeTot();
  const args = { env: { TOT_ACCESS_TOKEN: 't' }, fetchImpl, now: () => jst('2026-11-01T10:02:00'), wait: noWait, log: () => {}, dir };
  await runRecord(args);
  const r = await runRecord({ ...args, now: () => jst('2026-11-01T10:05:00') });
  assert.ok(r.skipped);
  assert.equal(calls.length, 5);
  assert.equal(readManifest(dir).length, 1);
  ensureDirs(dir);
  const release = acquireLock(dir);
  assert.ok(release);
  assert.equal(acquireLock(dir), null);
  release();
});

test('記録: 書きかけのファイルが残らない（一時ファイルなし）', async () => {
  const dir = tmpDir();
  await runRecord({ env: { TOT_ACCESS_TOKEN: 't' }, fetchImpl: fakeTot().fetchImpl, now: () => jst('2026-11-01T10:02:00'), wait: noWait, log: () => {}, dir });
  assert.ok(fs.readdirSync(path.join(dir, 'raw')).every(f => !f.includes('.tmp-')));
});

test('点検: 欠け（実行なし）・失敗・壊れたファイルを見分ける', async () => {
  const dir = tmpDir();
  const { fetchImpl } = fakeTot();
  for (const h of ['08:02', '10:02', '11:02']) {
    await runRecord({ env: { TOT_ACCESS_TOKEN: 't' }, fetchImpl, now: () => jst(`2026-11-01T${h}:00`), wait: noWait, log: () => {}, dir });
  }
  fs.appendFileSync(path.join(dir, 'raw', '2026-11-01_1102.json'), ' ');   // 壊れた（指紋が合わない）
  const st = checkDay(dir, '2026-11-01');
  assert.deepEqual(st.ok, ['08:02', '10:02']);
  assert.deepEqual(st.broken, ['11:02']);
  assert.deepEqual(st.missing, ['12:02', '13:02', '14:02', '15:02', '16:02', '22:35']);
  assert.equal(st.healthy, false);
});

test('点検: 22:35の回はその日の点検・まとめ（圧縮）、8:02の回は前日分を点検し直す', async () => {
  const dir = tmpDir();
  const { fetchImpl } = fakeTot();
  const logs = [];
  for (const h of ['08:02', '10:02', '11:02', '12:02', '13:02', '14:02', '15:02', '16:02', '22:35']) {
    await runRecord({ env: { TOT_ACCESS_TOKEN: 't' }, fetchImpl, now: () => jst(`2026-11-01T${h}:00`), wait: noWait, log: m => logs.push(m), dir });
  }
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'status', '2026-11-01.json'), 'utf8'));
  assert.equal(st.healthy, true);
  const gz = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'archive', '2026-11-01.jsonl.gz'))).toString().trim().split('\n');
  assert.equal(gz.length, 9);
  await runRecord({ env: { TOT_ACCESS_TOKEN: 't' }, fetchImpl, now: () => jst('2026-11-02T08:02:00'), wait: noWait, log: m => logs.push(m), dir });
  assert.ok(logs.some(l => l.includes('"check":"2026-11-01"') && l.includes('"healthy":true')));
});

test('保存期間: 約13か月より古い記録だけを消す', () => {
  const dir = tmpDir();
  ensureDirs(dir);
  fs.writeFileSync(path.join(dir, 'raw', '2025-09-01_1002.json'), '{}');
  fs.writeFileSync(path.join(dir, 'raw', '2026-10-01_1002.json'), '{}');
  fs.writeFileSync(path.join(dir, 'archive', '2025-09-01.jsonl.gz'), '');
  assert.equal(pruneOld(dir, '2026-11-01'), 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'raw')), ['2026-10-01_1002.json']);
});

test('取り込み（後で使う）: 最初に確認した日時・後から差し込まれた打刻・消えた打刻・正常な深夜退勤', () => {
  const snap = (at, punches, date = '2026-11-01') => ({ fetchedAt: jst(at).toISOString(), parts: { timerecord: 200 },
    data: { timerecord: [{ date, employeeKey: 'k1', punches }] } });
  const p = (code, t) => ({ code, time: `${t}+09:00` });
  const snaps = [
    snap('2026-11-01T10:02:00', [p('1', '2026-11-01T09:00:00')]),
    snap('2026-11-01T16:02:00', [p('1', '2026-11-01T09:00:00')]),
    // 13:00の退勤が16:02には無く、22:35に初めて現れた → 後から差し込まれた
    snap('2026-11-01T22:35:00', [p('1', '2026-11-01T09:00:00'), p('2', '2026-11-01T13:00:00')]),
    // 23:30の深夜退勤が翌朝8:02に初めて現れた → 正常（23:45以降の取得はこれが最初）
    snap('2026-11-02T08:02:00', [p('1', '2026-11-01T09:00:00'), p('2', '2026-11-01T23:30:00')]),
  ];
  const m = replayFirstSeen(snaps, 15);
  assert.equal(m.get('k1|2026-11-01|1|2026-11-01T09:00:00+09:00').firstSeen, jst('2026-11-01T10:02:00').toISOString());
  assert.equal(m.get('k1|2026-11-01|1|2026-11-01T09:00:00+09:00').insertedLate, false);
  assert.equal(m.get('k1|2026-11-01|2|2026-11-01T13:00:00+09:00').insertedLate, true);
  assert.equal(m.get('k1|2026-11-01|2|2026-11-01T13:00:00+09:00').disappeared, jst('2026-11-02T08:02:00').toISOString());
  assert.equal(m.get('k1|2026-11-01|2|2026-11-01T23:30:00+09:00').insertedLate, false);
});

test('既存: tot-relay.js・tot-client.js・Apps Scriptのコード・cron設定は main から変わっていない', () => {
  const diff = execFileSync('git', ['diff', '--name-only', 'main', '--', 'src/tot-relay.js', 'src/tot-client.js', 'gas/AlcoholCheck.gs', 'gas/test/', 'deploy/'], { encoding: 'utf8' });
  assert.equal(diff.trim(), '');
});
