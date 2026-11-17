import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 事務の業務一覧LINE（gas/OfficeTask.gs・版 2026-11-17a）。すべて架空の社員番号・LINE ID・模擬環境（LINE には送らない）
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const ADMIN = U(7), STAFF = U(1), OTHER = U(2), GROUP = 'C' + 'a'.repeat(32);
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const MH = ['ID', '業務名', '頻度', 'いつまでに', '目安（分）', '前倒しできる', '担当の流れ', 'やり方（手順）', '必要な物・リンク', 'コツ・注意',
  '困ったとき・判断が必要なとき', '完了の報告', '任せる（○／×）', '手順OK（○／直した）', '安藤さんメモ'];
const task = (id, name, min, early, ok = '○') => [id, name, '', '', min, early ? '○' : '×', '', '1. 手順A\n2. 手順B', '道具', 'コツです', '安藤さんへ', '［完了］', ok, '', ''];
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'Notices.gs', 'TotSync.gs', 'OfficeTask.gs'];

function setup(props = { OFFICE_TASK_MODE: 'on' }, now = '2026-11-17T08:00:00+09:00', shift = ['08:00', '14:00']) {
  const g = createGas({ files: FILES, now });
  const master = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = master.insertSheet('従業員マスタ');
  [HEAD, ["'90001", '試験 花子', '', '在籍', '管理本部', STAFF, '', '', true, false, '', '', '0901', ''],
    ["'90002", '試験 二郎', '', '在籍', '管理本部', OTHER, '', '', true, false, '', '', '0902', '']].forEach((r) => m.appendRow(r));
  master.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [GROUP, '勤怠管理', '2026-10-15', '有効']].forEach((r) => master.getSheetByName('LINEグループ').appendRow(r));
  const book = g.newSpreadsheet('【テスト】業務一覧（架空）');
  const s = book.insertSheet('業務マニュアル');
  [MH, task('M01', '朝の確認', 15, false), task('M02', 'スキャン', 20, true), task('M03', '領収書', 30, true), task('M04', '交通費の確認', 60, false),
    task('M05', '勤怠締め', 60, false), task('M06', '社労士へ送る', 30, false), task('M11', '在庫確認', 30, true), task('M12', '印鑑証明書', 120, false),
    task('M21', '電話・来客', 20, false), task('M22', '前倒し', 30, true), task('M09', '支払予定', 40, false, '×')].forEach((r) => s.appendRow(r));
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: master.getId(), INQ_MODE: 'off', LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN, DRY_RUN: 'false',
    OFFICE_TASK_BOOK_ID: book.getId(), OFFICE_TASK_STAFF: '90001', ...props });
  const today = now.slice(0, 10);
  const sched = shift ? [{ date: today, dailySchedules: [{ employeeKey: 'k1', date: today, clockInSchedule: today + 'T' + shift[0] + ':00+09:00', clockOutSchedule: today + 'T' + shift[1] + ':00+09:00' }] }]
    : [{ date: today, dailySchedules: [{ employeeKey: 'k1', date: today }] }];
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today, fetchedAt: 'x', results: { employees: [{ key: 'k1', code: '0901' }, { key: 'k2', code: '0902' }], schedules: sched } }),
    updated: new Date(today + 'T07:05:30+09:00').getTime() };
  g.ctx.OT_setup();
  return { g, master, book };
}
const pushes = (g, n) => g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
const replies = (g, n) => g.fetches.slice(n).filter((f) => f.url.endsWith('/reply'));
const pb = (userId, data, id) => ({ type: 'postback', webhookEventId: id, replyToken: 'rt-' + id, source: { type: 'group', groupId: GROUP, userId }, postback: { data } });
const post = (g, ...events) => g.ctx.doPost({ postData: { contents: JSON.stringify({ destination: 'x', events }) } });
const btnData = (bubble, label) => bubble.footer.contents.find((b) => b.action.label === label).action.data;

test('事務の業務一覧: 予定ルールと期間（月末から翌月にまたがる期間・週・年）', () => {
  const { g } = setup();
  const X = g.ctx;
  const ms = X.OT_periods(X.OT_parseRule('monthly:-2~3'), '2026-11-30');
  assert.deepEqual(JSON.parse(JSON.stringify(ms.map((p) => [p.key, p.start, p.end]))), [['M2026-10', '2026-09-28', '2026-10-03'], ['M2026-11', '2026-10-29', '2026-11-03'], ['M2026-12', '2026-11-28', '2026-12-03']]);
  const ws = X.OT_periods(X.OT_parseRule('weekly:5'), '2026-11-17');   // 火曜
  assert.equal(ws[1].start, '2026-11-20');
  const ys = X.OT_periods(X.OT_parseRule('yearly:11/1~12/20'), '2026-11-17');
  assert.deepEqual([ys[1].start, ys[1].end], ['2026-11-01', '2026-12-20']);
  assert.equal(X.OT_parseRule('なにか'), null);
  const sh = X.OT_shift({ clockInSchedule: '2026-11-17T09:00:00+09:00', clockOutSchedule: '2026-11-17T15:00:00+09:00' });
  assert.deepEqual([sh.minutes, sh.label], [360, '9:00〜15:00']);
  assert.equal(X.OT_shift({ clockInSchedule: '2026-11-17T08:00:00+09:00', clockOutSchedule: '2026-11-17T17:00:00+09:00' }).minutes, 480);
  assert.equal(X.OT_shift({}), null);
});

test('事務の業務一覧: 予定づくり（任せる○だけ・期限順・勤務時間の8割・入りきらない分は手が空いたとき）', () => {
  const { g } = setup();
  const X = g.ctx;
  const tasks = X.OT_tasks_(X.OT_book_());
  assert.ok(!tasks.some((t) => t.id === 'M09'));                                      // 任せる×は出さない
  // 12/1（火）：交通費（1〜3日）・勤怠締め（前月末〜3日）・在庫（1〜5日）・先週金曜の領収書（記録がないので過ぎた扱い）
  const p = X.OT_plan(tasks, '2026-12-01', 360, {}, []);
  assert.equal(p.reserve, 20);
  assert.equal(p.budget, Math.round(360 * 0.8) - 20);
  assert.equal(p.today[0].id, 'M01');                                                 // 朝の確認が最初
  assert.deepEqual(JSON.parse(JSON.stringify(p.today.map((t) => t.id).sort())), ['M01', 'M02', 'M03', 'M04', 'M05', 'M11'].sort());
  assert.ok(p.total <= p.budget);
  assert.ok(p.extra.some((t) => t.id === 'M03' && t.early));                         // 金曜の領収書は前倒しの候補
  // 勤務が短い日：期限が今日のものは必ず入り、それ以外は手が空いたときへ
  const short = X.OT_plan(tasks, '2026-12-03', 120, {}, []);
  assert.ok(short.today.some((t) => t.id === 'M04') && short.today.some((t) => t.id === 'M05'));
  assert.ok(short.extra.some((t) => t.id === 'M11'));
  // 完了済みは出ない・期限を過ぎたもの（7日以内）は先頭に
  const done = { 'M04|M2026-12': true };
  const late = X.OT_plan(tasks, '2026-12-07', 360, done, []);
  assert.ok(!late.today.some((t) => t.id === 'M04'));
  assert.equal(late.today[1].id, 'M05'); assert.ok(late.today[1].overdue);
  // 臨時の依頼
  const r = X.OT_plan(tasks, '2026-12-07', 360, {}, [{ row: 2, id: 'M12', name: '', due: '2026-12-08', memo: '2通' }]);
  const it = r.today.find((t) => t.id === 'M12');
  assert.equal(it.period, 'R2'); assert.equal(it.memo, '2通');
});

test('事務の業務一覧: 毎朝の送信（勤怠管理グループ・ボタン付き）、休みの日は送らない、record は送らずに記録', () => {
  const { g, book } = setup();
  let n = g.fetches.length;
  g.ctx.OT_morning();
  const p = pushes(g, n);
  assert.equal(p.length, 1);
  assert.equal(p[0].body.to, GROUP);
  const car = p[0].body.messages[0].contents;
  assert.equal(car.type, 'carousel');
  assert.match(car.contents[0].body.contents.map((c) => c.text || '').join('\n'), /試験さんの今日のお仕事[\s\S]*勤務：8:00〜14:00/);
  assert.equal(car.contents[1].body.contents[0].text, '1. 朝の確認');
  assert.ok(car.contents.length >= 2);
  assert.match(book.getSheetByName('送る予定の内容').dump()[1][5], /朝の確認/);
  // 休み（予定はあるが出勤時刻なし）
  const h = setup({ OFFICE_TASK_MODE: 'on' }, '2026-11-17T08:00:00+09:00', null);
  n = h.g.fetches.length; h.g.ctx.OT_morning();
  assert.equal(pushes(h.g, n).length, 0);
  // record
  const r = setup({ OFFICE_TASK_MODE: 'record' });
  n = r.g.fetches.length; r.g.ctx.OT_morning();
  assert.equal(pushes(r.g, n).length, 0);
  assert.match(r.book.getSheetByName('送る予定の内容').dump()[1][5], /^【記録のみ】/);
  // 未設定は何もしない
  const o = setup({ OFFICE_TASK_MODE: '' });
  n = o.g.fetches.length; o.g.ctx.OT_morning();
  assert.equal(pushes(o.g, n).length, 0);
});

test('事務の業務一覧: ボタン（完了・わからない・今日はできない・手が空きました）と、押せる人', () => {
  const { g, book } = setup();
  g.ctx.OT_morning();
  const car = pushes(g, 0)[0].body.messages[0].contents.contents;
  const first = car[1];
  let n = g.fetches.length;
  post(g, pb(OTHER, btnData(first, '完了'), 'e1'));                                         // ほかのメンバーは押せない
  assert.match(replies(g, n)[0].body.messages[0].text, /試験さんと管理者だけ/);
  assert.equal(book.getSheetByName('今日の仕事の記録').dump().length, 1);
  n = g.fetches.length;
  post(g, pb(STAFF, btnData(first, '完了'), 'e2'));
  assert.match(replies(g, n)[0].body.messages[0].text, /「朝の確認」を完了にしました[\s\S]*次は「/);
  post(g, pb(STAFF, btnData(first, '完了'), 'e2'));                                         // 同じイベントは1回だけ
  assert.equal(book.getSheetByName('今日の仕事の記録').dump().filter((r) => r[5] === '完了').length, 1);
  n = g.fetches.length;
  post(g, pb(STAFF, btnData(car[2], 'わからない'), 'e3'));
  assert.match(replies(g, n)[0].body.messages[0].text, /困ったとき：安藤さんへ[\s\S]*安藤さん、確認をお願いします/);
  n = g.fetches.length;
  post(g, pb(ADMIN, btnData(car[2], '今日はできない'), 'e4'));                               // 管理者も押せる
  assert.match(replies(g, n)[0].body.messages[0].text, /明日に回します/);
  // 手が空きました → 前倒しの仕事を1件ずつ
  const free = car[0].footer.contents[0].action.data;
  n = g.fetches.length;
  post(g, pb(STAFF, free, 'e5'));
  const r1 = replies(g, n)[0].body.messages;
  assert.match(r1[0].text, /次はこちら/);
  assert.equal(r1[1].type, 'flex');
  // 合言葉の違うボタンは使えない
  n = g.fetches.length;
  post(g, pb(STAFF, btnData(first, '完了').replace(/\|[^|]+$/, '|zzz'), 'e6'));
  assert.match(replies(g, n)[0].body.messages[0].text, /このボタンは使えません/);
  // 翌日の予定に完了したもの（毎日の仕事）以外の「今日はできない」が残る
  const log = book.getSheetByName('今日の仕事の記録').dump();
  assert.deepEqual(log.slice(1).map((r) => r[5]), ['完了', 'わからない', '今日はできない', '手が空きました']);
});

test('事務の業務一覧: 終業30分前のお知らせ（1回だけ）・月曜は先週のまとめ', () => {
  const { g } = setup();
  g.ctx.OT_morning();
  let n = g.fetches.length;
  g.clock.now = new Date('2026-11-17T13:00:00+09:00').getTime(); g.ctx.OT_tick();
  assert.equal(pushes(g, n).length, 0);                                                   // まだ早い
  g.clock.now = new Date('2026-11-17T13:31:00+09:00').getTime(); g.ctx.OT_tick();
  const p = pushes(g, n);
  assert.equal(p.length, 1);
  assert.match(p[0].body.messages[0].text, /【今日のお仕事 残り\d+件】[\s\S]*本日もお疲れさまでした/);
  n = g.fetches.length; g.ctx.OT_tick();
  assert.equal(pushes(g, n).length, 0);
  const text = g.ctx.OT_weeklyText([['h'], [new Date(), '2026-11-17', '2026-11-17', 'M01', '朝の確認', '完了', '花子', ''],
    [new Date(), '2026-11-18', 'x', 'M04', '交通費の確認', 'わからない', '花子', '']], '2026-11-23', '花子');
  assert.match(text, /完了：1件／わからない：1件／できなかった：0件[\s\S]*交通費の確認/);
});
