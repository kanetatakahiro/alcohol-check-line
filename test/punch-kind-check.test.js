import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 確認用の関数 tools/punchKindCheck.gs（読み取りだけ）。すべて架空データ・模擬環境（LINEへの送信なし）
const TODAY = '2026-11-13';
const W = (k, date, isError, hol) => ({ employeeKey: k, date, isError, overtime: 0, lateNightOvertime: 0, ...(hol ? { holidaysObtained: { fulltimeHoliday: { code: 9, name: '公休' } } } : {}) });
const T = (k, date, codes) => ({ employeeKey: k, date, timeRecord: codes.map((c) => ({ code: String(c), time: date + 'T09:00:00+09:00' })) });

function setup({ mode = 'morning', results } = {}) {
  const g = createGas({ files: ['AlcoholCheck.gs', '../tools/punchKindCheck.gs'], now: TODAY + 'T12:00:00+09:00' });
  const R = results || {
    employees: [{ key: 'k1', code: '101' }, { key: 'k2', code: '102' }, { key: 'k3', code: '103' }, { key: 'k4', code: '104' }],
    workings: [{ dailyWorkings: [
      W('k1', '2026-11-12', true),   // 退勤なし（出勤1・退勤0）
      W('k1', '2026-11-11', true),   // 出勤なし（出勤0・退勤1）
      W('k4', '2026-11-12', true),   // 退勤の二重打刻（出勤1・退勤2）
      W('k4', '2026-11-11', true),   // 出勤の二重打刻（出勤2・退勤1）
      W('k4', '2026-11-10', true),   // 退勤なし（出勤2・退勤0）
      W('k4', '2026-11-09', true, true),   // 休みの日の打刻（全日休暇・出勤1・退勤1）
      W('k4', '2026-11-08', true, true),   // 全日休暇でも打刻が無ければ「両方なし」
      W('k2', '2026-11-10', true),   // 打刻なし（timerecord に行が無い）
      W('k2', '2026-11-09', true),   // 打刻なし（行はあるが出勤・退勤が0。休憩だけ）
      W('k3', '2026-11-08', true),   // 同じ数
      W('k3', '2026-11-05', true),   // 期間外（8日前。timerecord は7日前から）
      W('k3', '2026-10-20', true),   // 期間外（前月）
      W('k1', '2026-11-07', false),  // エラーでない日は数えない
      W('kX', '2026-11-12', true),   // TOTコードが分からない人は数えない
      W('k1', TODAY, true),          // 今日は数えない
    ] }],
    timerecord: [{ dailyWorkings: [
      T('k1', '2026-11-12', [1, 3, 4]), T('k1', '2026-11-11', [2]), T('k2', '2026-11-09', [3, 4]),
      T('k3', '2026-11-08', [1, 2, 1, 2]), T('k1', '2026-11-07', [1, 2]),
      T('k4', '2026-11-12', [1, 2, 2]), T('k4', '2026-11-11', [1, 1, 2]), T('k4', '2026-11-10', [1, 3, 4, 1]), T('k4', '2026-11-09', [1, 2]),
    ] }],
    requests: [], schedules: [],
  };
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today: TODAY, mode, fetchedAt: 'x', results: R }), updated: new Date(TODAY + 'T07:05:30+09:00').getTime() };
  return g;
}

test('punchKindCheck：エラー勤務の日を8つに分けて件数だけを出す（直近7日とデータ全体）', () => {
  const g = setup();
  const n = g.fetches.length;
  const r = g.ctx.punchKindCheck();
  assert.equal(r.from, '2026-11-06');
  assert.equal(r.to, '2026-11-12');
  assert.deepEqual({ ...r.recent }, { total: 10, holiday: 1, noOut: 2, noIn: 1, noBoth: 3, dupIn: 1, dupOut: 1, same: 1, outOfRange: 0 });
  assert.deepEqual({ ...r.all }, { total: 12, holiday: 1, noOut: 2, noIn: 1, noBoth: 3, dupIn: 1, dupOut: 1, same: 1, outOfRange: 2 });
  assert.equal(g.fetches.length, n);   // 送信なし
  const log = g.logs.join('\n');
  assert.match(log, /直近7日.*：10件（休みの日の打刻 1件／退勤なし 2件／出勤なし 1件／両方なし 3件／出勤の二重打刻 1件／退勤の二重打刻 1件／同じ数 1件／timerecord の期間外 0件）/);
  assert.match(log, /データ全体.*：12件/);
  for (const s of ['k1', 'k2', 'k3', 'k4', '101', '102', '103', '104', 'T09:00']) assert.ok(!log.includes(s), s + ' をログに出さない');
});

test('punchKindCheck：書き込みをしない（ファイル・スクリプトプロパティ・シート）', () => {
  const g = setup();
  const before = JSON.stringify(g.drive.files), props = JSON.stringify(g.scriptProps.getProperties()), sheets = Object.keys(g.sheets).length;
  g.ctx.punchKindCheck();
  assert.equal(JSON.stringify(g.drive.files), before);
  assert.equal(JSON.stringify(g.scriptProps.getProperties()), props);
  assert.equal(Object.keys(g.sheets).length, sheets);
});

test('punchKindCheck：夜のデータは注意を出し、timerecord の期間を今日までにする。読み取りエラー・ファイルなしは数えない', () => {
  const g = setup({ mode: 'night' });
  const r = g.ctx.punchKindCheck();
  assert.equal(r.to, TODAY);
  assert.match(g.logs.join('\n'), /朝のデータではありません/);

  const g2 = setup({ results: { employees: [], workings: [{ _error: 403 }], timerecord: [] } });
  assert.equal(g2.ctx.punchKindCheck(), null);
  assert.match(g2.logs.join('\n'), /読み取りエラーがあるため、数えません/);

  const g3 = createGas({ files: ['AlcoholCheck.gs', '../tools/punchKindCheck.gs'], now: TODAY + 'T12:00:00+09:00' });
  assert.equal(g3.ctx.punchKindCheck(), null);
  assert.match(g3.logs.join('\n'), /tot-latest.json が無い/);
});
