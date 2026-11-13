import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 確認用の関数 tools/scheduleShapeCheck.gs（読み取りだけ）。すべて架空データ・模擬環境（LINEへの送信なし）
const TODAY = '2026-11-13';
const S = (k, date, o = {}) => ({ date, employeeKey: k, workDayTypeName: '平日', scheduleTypeName: '通常', ...o });
const W = (k, date, o = {}) => ({ date, employeeKey: k, workdayTypeName: '平日', assigned: 480, totalWork: 480, isError: false, ...o });

function setup(results) {
  const g = createGas({ files: ['AlcoholCheck.gs', '../tools/scheduleShapeCheck.gs'], now: TODAY + 'T12:00:00+09:00' });
  if (results) g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today: TODAY, mode: 'morning', fetchedAt: 'x', results }), updated: new Date(TODAY + 'T07:05:30+09:00').getTime() };
  return g;
}
const RES = {
  schedules: [{ date: TODAY, dailySchedules: [
    S('kaaa', TODAY, { clockInSchedule: TODAY + 'T09:00:00+09:00', clockOutSchedule: TODAY + 'T18:00:00+09:00', note: '架空の備考' }),
    S('kbbb', TODAY, { workDayTypeName: '法定外休日' }),
    S('kccc', TODAY, { holidaysObtained: { fulltimeHoliday: { code: 1, name: '有休' } } }),
  ] }],
  workings: [{ date: '2026-11-12', dailyWorkings: [
    W('kaaa', '2026-11-12'),
    W('kbbb', '2026-11-12', { assigned: 0, totalWork: 0, holidaysObtained: { fulltimeHoliday: { code: 9, name: '欠勤' } } }),
    W('kccc', '2026-11-12', { workdayTypeName: '法定休日', assigned: 0, totalWork: 0 }),
  ] }],
};

test('scheduleShapeCheck：項目名と、勤務日種別・休暇区分（名前とコード）・組み合わせの件数だけを出す', () => {
  const g = setup(RES);
  const r = g.ctx.scheduleShapeCheck();
  assert.equal(r.schedules.rows, 3);
  assert.deepEqual({ ...r.schedules.full }, { '有休（code 1）': 1 });
  assert.deepEqual({ ...r.schedules.combo }, { '時刻あり・全日休暇なし・平日': 1, '時刻なし・全日休暇なし・法定外休日': 1, '時刻なし・全日休暇あり・平日': 1 });
  assert.deepEqual({ ...r.workings.full }, { '欠勤（code 9）': 1 });
  assert.deepEqual({ ...r.workings.types }, { 平日: 2, 法定休日: 1 });
  const log = g.logs.join('\n');
  assert.match(log, /項目名：.*clockInSchedule 1件/);
  for (const s of ['kaaa', 'kbbb', 'kccc', 'T09:00', '架空の備考']) assert.ok(!log.includes(s), s + ' をログに出さない');
  assert.equal(g.fetches.length, 0);
});

test('scheduleShapeCheck：ファイルが無い・読み取りエラーのときは数えない。書き込みをしない', () => {
  assert.equal(setup().ctx.scheduleShapeCheck(), null);
  const g = setup({ schedules: [{ _error: 403 }], workings: RES.workings });
  const before = JSON.stringify(g.drive.files), props = JSON.stringify(g.scriptProps.getProperties());
  const r = g.ctx.scheduleShapeCheck();
  assert.equal(r.schedules, null);
  assert.match(g.logs.join('\n'), /日別スケジュール.*データが無い、または読み取りエラー/);
  assert.equal(JSON.stringify(g.drive.files), before);
  assert.equal(JSON.stringify(g.scriptProps.getProperties()), props);
});
