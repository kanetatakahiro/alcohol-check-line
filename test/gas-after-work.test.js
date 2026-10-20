import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 退勤後のアルコールチェック（TOTの打刻で退勤を確認・20〜23時）と、連続記録・お礼（翌朝に確定）のテスト。
// 架空データのみ。LINEへは送らず、送るはずだった宛先と文面を記録して確かめる。
const load = () => {
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(readFileSync(new URL('../gas/AlcoholCheck.gs', import.meta.url), 'utf8'), ctx);
  return ctx;
};
const ctx0 = load();
const X = ctx0.module.exports;
const arr = a => Array.from(a);

const jstHour = v => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(v));
const toDate = v => (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]' ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(v) : null);
const ts = (day, hm) => new Date(`${day}T${hm}:00+09:00`);

// TOTの打刻（daily-workings/timerecord）と従業員（employees）の形
const emp = (key, code) => ({ key, code });
const rec = (key, date, ...punches) => ({ employeeKey: key, date, timeRecord: punches.map(([code, hm]) => ({ code: String(code), time: `${date}T${hm}:00+09:00` })) });
const totResults = (records, employees = [emp('k1', '101'), emp('k2', '102'), emp('k3', '103'), emp('k4', '104')]) =>
  ({ employees, timerecord: [{ date: '2026-10-20', dailyWorkings: records }] });

test('退勤後：TOTの打刻から勤務状況を判定する（推測で退勤済みにしない）', () => {
  const now = Date.parse('2026-10-20T20:10:00+09:00');
  const s = X.AC_punchSummary(totResults([
    rec('k1', '2026-10-20', [1, '09:00'], [2, '19:40']),                     // 退勤済み
    rec('k2', '2026-10-20', [1, '09:00']),                                    // 勤務中（残業）
    rec('k3', '2026-10-20', [1, '09:00'], [2, '12:00'], [1, '13:00']),        // 外出→戻り＝勤務中
  ]), '2026-10-20', '2026-10-20T20:00:05+09:00');
  assert.equal(s.ok, true);
  assert.equal(X.AC_punchStatus(s, '101', '2026-10-20', now), 'out');
  assert.equal(X.AC_punchStatus(s, '102', '2026-10-20', now), 'working');
  assert.equal(X.AC_punchStatus(s, '103', '2026-10-20', now), 'working');
  assert.equal(X.AC_punchStatus(s, '104', '2026-10-20', now), 'none');      // TOTにいるが打刻なし
  assert.equal(X.AC_punchStatus(s, '999', '2026-10-20', now), 'unknown');   // TOTにいない
  assert.equal(X.AC_punchStatus(s, '', '2026-10-20', now), 'unknown');      // TOTコード未設定
  assert.equal(X.AC_punchStatus(s, '101', '2026-10-20', Date.parse('2026-10-20T21:20:00+09:00')), 'unknown');   // 70分より古い
  assert.equal(X.AC_punchStatus(s, '101', '2026-10-21', now), 'unknown');   // 別の日のデータ
  assert.equal(X.AC_punchStatus(null, '101', '2026-10-20', now), 'unknown');
  const failed = X.AC_punchSummary({ employees: [], timerecord: { _error: 500 } }, '2026-10-20', '2026-10-20T20:00:05+09:00');
  assert.equal(failed.ok, false);
  assert.equal(X.AC_punchStatus(failed, '101', '2026-10-20', now), 'unknown');
  assert.doesNotMatch(JSON.stringify(s), /試験|name/);                         // 保存する要約に氏名は含めない
});

// 計画（だれに何を送るか）のテスト用
const planFor = (hour, statuses, { sent = [], codes } = {}) => {
  const names = Object.keys(statuses);
  const codeOf = n => (codes || {})[n] ?? { A: '101', B: '102', C: '103', D: '104', E: '105', 管理: '10015' }[n] ?? '';
  const now = Date.parse(`2026-10-20T${hour}:20:00+09:00`);
  const recs = [];
  names.forEach(n => {
    const st = statuses[n], key = 'k' + codeOf(n);
    if (st === 'out') recs.push(rec(key, '2026-10-20', [1, '09:00'], [2, `${hour - 1}:50`]));
    if (st === 'working') recs.push(rec(key, '2026-10-20', [1, '09:00']));
  });
  const employees = names.filter(n => statuses[n] !== 'notInTot').map(n => emp('k' + codeOf(n), codeOf(n)));
  const punch = statuses._fail ? { ok: false, errors: ['timerecord'] } : X.AC_punchSummary(totResults(recs, employees), '2026-10-20', new Date(now - 15 * 60000).toISOString());
  return arr(X.AC_afterWorkPlan({ hour, today: '2026-10-20', missing: names.filter(n => n !== '_fail'), nowMs: now, punch,
    codeOf, totOf: c => c, sentBefore: who => sent.includes(who) })).map(p => ({ ...p }));
};

test('退勤後：20〜22時は退勤済み・未入力の人だけに送り、勤務中・打刻なし・確認できない人は保留', () => {
  const p = planFor(20, { A: 'out', B: 'working', C: 'none', D: 'notInTot' });
  assert.deepEqual(p.map(x => [x.name, x.action, x.template || '']), [
    ['A', 'send', 'followAfterOut'], ['B', 'hold', ''], ['C', 'hold', ''], ['D', 'hold', '']]);
  assert.match(p[1].reason, /勤務中/);
  assert.match(p[3].reason, /TOTで確認できず/);
  const p21 = planFor(21, { A: 'out', B: 'out' }, { sent: ['101'] });           // Aは20時に連絡済み
  assert.deepEqual(p21.map(x => [x.name, x.action]), [['A', 'skip'], ['B', 'send']]);
});

test('退勤後：23時の最終確認は、退勤済みなら「退勤後」、勤務中・打刻なし・確認できないなら「勤務終了後」の文面。連絡済みの人には送らない', () => {
  const p = planFor(23, { A: 'out', B: 'working', C: 'none', D: 'notInTot', E: 'out' }, { sent: ['105'] });
  assert.deepEqual(p.map(x => [x.name, x.action, x.template || '']), [
    ['A', 'send', 'followAfterOut'], ['B', 'send', 'followAfterWorking'], ['C', 'send', 'followAfterWorking'],
    ['D', 'send', 'followAfterWorking'], ['E', 'skip', '']]);
});

test('退勤後：TOTの取得に失敗した夜は、20〜22時は全員保留、23時は「勤務終了後」の文面（推測で退勤済みにしない）', () => {
  for (const h of [20, 21, 22]) {
    assert.ok(planFor(h, { A: 'out', B: 'working', _fail: true }).every(x => x.action === 'hold'), h + '時');
  }
  const p = planFor(23, { A: 'out', B: 'working', _fail: true });
  assert.deepEqual(p.map(x => [x.action, x.template]), [['send', 'followAfterWorking'], ['send', 'followAfterWorking']]);
});

test('管理監督者の特例（社員番号10015）：20時に従来の確認連絡を1回だけ。21〜23時は送らない。氏名ではなく社員番号で判定', () => {
  assert.deepEqual(Array.from(X.AC_PUNCH_EXEMPT_CODES), ['10015']);
  const p20 = planFor(20, { 管理: 'notInTot', A: 'working' });
  assert.deepEqual(p20.map(x => [x.name, x.action, x.template || '']), [['管理', 'send', 'followAfter'], ['A', 'hold', '']]);
  for (const h of [21, 22, 23]) assert.deepEqual(planFor(h, { 管理: 'notInTot' }).map(x => x.action), ['skip'], h + '時');
  assert.deepEqual(planFor(20, { 管理: 'notInTot' }, { sent: ['10015'] }).map(x => x.action), ['skip']);   // 同じ日に2回送らない
  // 同じ氏名でも社員番号が違えば特例にしない／氏名が違っても社員番号10015なら特例
  const sameName = planFor(23, { '高橋 健太': 'working' }, { codes: { '高橋 健太': '20001' } });
  assert.equal(sameName[0].template, 'followAfterWorking');
  const otherName = planFor(21, { '別表記の名前': 'notInTot' }, { codes: { '別表記の名前': '10015' } });
  assert.equal(otherName[0].action, 'skip');
  assert.match(otherName[0].reason, /特例/);
});

test('退勤後の文面：運転を開始する前のチェックをお願いする（送信前に中身を確認）', () => {
  const out = X.AC_render('followAfterOut', '2026-10-20', {});
  assert.match(out, /退勤後のアルコールチェックがまだ確認できていません。/);
  assert.match(out, /運転を開始する前にアルコールチェックを実施し、フォームへの入力をお願いします/);
  assert.match(out, /viewform/);
  const working = X.AC_render('followAfterWorking', '2026-10-20', {});
  assert.match(working, /^本日もお疲れ様です/);
  assert.match(working, /勤務終了後、車を運転開始する前にアルコールチェックを実施し、フォームへの入力をお願いします/);
  assert.doesNotMatch(out + working, /\{|\}|undefined/);
});

// 連続記録（翌朝に確定）
const sheet = (days, rows) => {
  const sv = [[], ['', '氏名', '区分', ...days.map(d => new Date(`${d}T00:00:00+09:00`))]];
  rows.forEach(([name, shifts]) => { sv.push(['', name, 'シフト', ...shifts]); sv.push(['', '', '出勤前']); sv.push(['', '', '退勤後']); });
  return sv;
};
const D5 = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];
const entries = (name, list) => list.flatMap(([day, before, after, afterDay]) => [
  ...(before ? [[ts(day, before), name, '出勤前', '0.14mg/L以下']] : []),
  ...(after ? [[ts(afterDay || day, after), name, '退勤前', '0.14mg/L以下']] : []),
]);
const streak = (fvRows, lastDay, opts = {}) => {
  const sv = sheet(D5, [['試験 太郎', ['出勤', '出勤', '公休', '出勤', '出勤', '出勤', '出勤']]]);
  const d = { sv, fv: [['ts', '氏名', '区分', '結果'], ...fvRows], toDate };
  return { ...X.AC_streakUpTo(d, '試験 太郎', lastDay, { hourOf: jstHour, ...opts }) };
};

test('連続記録：20時以降の入力もその勤務日分。日付をまたいだ残業の入力（翌朝5時より前）は前日分。確認連絡を送ったかは関係しない', () => {
  const base = [['2026-10-14', '08:00', '19:00'], ['2026-10-15', '08:00', '22:45'], ['2026-10-17', '08:00', '18:30'], ['2026-10-18', '08:00', '20:30']];
  assert.deepEqual(JSON.parse(JSON.stringify(streak(entries('試験 太郎', [...base, ['2026-10-19', '08:00', '00:40', '2026-10-20']]), '2026-10-19'))),
    { n: 5, start: '2026-10-14', end: '2026-10-19', pending: [] });                       // 19日の退勤前を20日0:40に入力 → 19日分。公休の16日は飛ばす
  assert.equal(streak(entries('試験 太郎', [...base, ['2026-10-19', '08:00', '05:30', '2026-10-20']]), '2026-10-19').n, 0);   // 翌朝5時以降は前日分にしない
  assert.equal(streak(entries('試験 太郎', [...base, ['2026-10-19', '08:00', '04:59', '2026-10-20']]), '2026-10-19').n, 5);
  assert.equal(streak(entries('試験 太郎', [...base]), '2026-10-19').n, 0);   // 19日の退勤前が無い → 0（リセット）
  // 20日0:40の「退勤前」は20日分にはならない（20日の勤務分として二重に数えない）
  const s20 = streak(entries('試験 太郎', [...base, ['2026-10-19', '08:00', '00:40', '2026-10-20'], ['2026-10-20', '08:00', '']]), '2026-10-20');
  assert.equal(s20.n, 0);
});

test('連続記録：管理監督者の特例（打刻なし）は当日23:59までの入力だけをその日分にする。打刻の有無は使わない', () => {
  const base = [['2026-10-14', '08:00', '19:00'], ['2026-10-15', '08:00', '19:00'], ['2026-10-17', '08:00', '19:00'], ['2026-10-18', '08:00', '19:00']];
  assert.equal(streak(entries('試験 太郎', [...base, ['2026-10-19', '08:00', '23:59']]), '2026-10-19', { exempt: true }).n, 5);
  assert.equal(streak(entries('試験 太郎', [...base, ['2026-10-19', '08:00', '00:10', '2026-10-20']]), '2026-10-19', { exempt: true }).n, 0);
});

test('お礼：節目を取りこぼさず、同じ節目は二度送らない。連続が途切れたら数え直す', () => {
  assert.deepEqual([0, 4, 5, 9, 10, 19, 20, 27, 30].map(n => X.AC_milestoneAtMost(n)), [0, 0, 5, 5, 10, 10, 20, 20, 30]);
  const dec = (n, start, stored, old = false, migrating = true) => JSON.parse(JSON.stringify(X.AC_thanksDecision({ n, start }, stored, old, migrating)));
  // 20時以降の入力で5日目を達成 → 翌朝お礼
  assert.equal(dec(5, 'S', { m: 0, start: 'S' }).send, true);
  // すでに5でお礼済み → 6日目は送らない、10日目で送る
  assert.equal(dec(6, 'S', { m: 5, start: 'S' }).send, false);
  assert.equal(dec(10, 'S', { m: 5, start: 'S' }).send, true);
  // 休みなどで判定が1日遅れても（11日目で初めて判定）10のお礼は取りこぼさない
  assert.deepEqual(dec(11, 'S', { m: 5, start: 'S' }), { send: true, m: 10, store: { m: 10, start: 'S' } });
  // 途切れて新しい連続が5に達したら、また5のお礼
  assert.equal(dec(5, 'T', { m: 10, start: 'S' }).send, true);
  // 途切れて節目未満 → 記録を消す（store: null）
  assert.equal(dec(3, 'T', { m: 10, start: 'S' }).store, null);
  // 移行時（記録なし）：前回の勤務日にちょうど節目で、従来の20時のお礼が無ければ送る／あれば送らない／節目を過ぎていれば送らない
  assert.equal(dec(5, 'S', null, false).send, true);
  assert.equal(dec(5, 'S', null, true).send, false);
  assert.equal(dec(7, 'S', null, false).send, false);
  assert.deepEqual(dec(7, 'S', null, false).store, { m: 5, start: 'S' });
  // 切り替え後2日目以降：記録が無い人（判定保留が解けた等）は、従来のお礼の記録が無ければ送る
  assert.equal(dec(6, 'S', null, false, false).send, true);
  assert.equal(dec(6, 'S', null, true, false).send, false);
});

test('トリガー：退勤後の確認は20・21・22・23時（各20分ごろ）。ほかの通知の時刻は変えない', () => {
  const sch = arr(X.AC_SCHEDULE).map(s => `${s.fn}@${s.hour}:${String(s.minute).padStart(2, '0')}`);
  assert.deepEqual(sch, ['alcoholCheckMorning@8:30', 'alcoholCheckBeforeWork@10:00', 'alcoholCheckEvening@18:30',
    'alcoholCheckAfterWorkHourly@20:20', 'alcoholCheckAfterWorkHourly@21:20', 'alcoholCheckAfterWorkHourly@22:20', 'alcoholCheckAfterWorkHourly@23:20']);
  const report = arr(X.AC_settingsReport({}, [0, 1, 2, 3].map(() => ({ fn: 'alcoholCheckAfterWorkHourly', type: '時間主導' })), {})).join('\n');
  assert.doesNotMatch(report, /重複/);                                          // 4つは想定どおり
  const dup = arr(X.AC_settingsReport({}, [0, 1, 2, 3, 4].map(() => ({ fn: 'alcoholCheckAfterWorkHourly', type: '時間主導' })), {})).join('\n');
  assert.match(dup, /重複/);
  const both = arr(X.AC_settingsReport({}, [{ fn: 'alcoholCheckAfterWork', type: '時間主導' }, { fn: 'alcoholCheckAfterWorkHourly', type: '時間主導' }], {})).join('\n');
  assert.match(both, /新旧両方/);
});

// ---------------- 一晩の流れを、送信せずにまとめて確認（Googleのサービスは架空のものに置き換え） ----------------
const night = ({ enabled = true, today = '2026-10-20', punchFor, master, shifts, form, exemptName = '試験 管理' } = {}) => {
  const ctx = load();
  const script = { DRY_RUN: 'false', NOTIFY_EMPLOYEES: 'true', ...(enabled ? { AFTER_WORK_TOT: 'true' } : {}) };
  const user = {};
  const store = o => ({ getProperty: k => (k in o ? o[k] : null), setProperty: (k, v) => { o[k] = String(v); }, deleteProperty: k => { delete o[k]; }, getProperties: () => ({ ...o }) });
  const sent = [], admin = [], logs = [];
  let hourNow = 20;
  Object.assign(ctx, {
    PropertiesService: { getScriptProperties: () => store(script), getUserProperties: () => store(user) },
    Utilities: { formatDate: (d, tz, f) => (f === 'H' ? String(d.__hour ?? hourNow ?? jstHour(d)) : toDate(d)) },
    Logger: { log: (f, ...a) => logs.push(String(f).replace(/%s/g, () => String(a.shift()))) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  });
  vm.runInContext(`
    AC_today_ = function () { return __today; };
    AC_state_ = function () { return PropertiesService.getUserProperties(); };
    AC_masterSheet_ = function () { return { getDataRange: function () { return { getValues: function () { return __master; } }; } }; };
    AC_loadDay_ = function (t) { return AC_buildDay({ today: t, sv: __shifts, fv: __form, toDate: __toDate }); };
    AC_pauseIndex_ = function () { return {}; };
    AC_templateOverrides_ = function () { return {}; };
    AC_loadPunch_ = function () { return __punch(); };
    AC_pushTo_ = function (to, text) { __sent.push({ to: to, text: text }); };
    AC_pushLine_ = function (text) { __admin.push(text); };
    AC_adminNotice_ = function (kind, text) { var s = PropertiesService.getUserProperties(), k = 'sent:' + __today + ':notice:' + kind; if (s.getProperty(k)) return; __admin.push(text); s.setProperty(k, '1'); };
    AC_cleanupSentKeys_ = function () {};
    AC_dispatch_ = function (kind) { __dispatched.push(kind); };
  `, Object.assign(ctx, { __today: today, __master: master, __shifts: shifts, __form: form, __toDate: toDate, __punch: punchFor, __sent: sent, __admin: admin, __dispatched: [] }));
  // 時刻を変えて毎時の確認を呼ぶ
  const at = h => { hourNow = h; ctx.__now = h; vm.runInContext('alcoholCheckAfterWorkHourly()', ctx); };
  return { ctx, at, sent, admin, logs, user, script, dispatched: ctx.__dispatched, setHour: h => { hourNow = h; } };
};
const M = (code, name, userId, tot) => [code, name, '', '在籍', '', userId, '', '', true, true, '', '', tot, ''];
const uid = n => 'U' + String(n).repeat(32).slice(0, 32);
const master = [M('社員番号', '氏名', '', ''), M('10101', '試験 退勤', uid(1), '101'), M('10102', '試験 残業', uid(2), '102'),
  M('10103', '試験 入力済', uid(3), '103'), M('10015', '試験 管理', uid(4), ''), M('10105', '試験 休み', uid(5), '105')];
const todaySheet = sheet(['2026-10-20'], [['試験 退勤', ['出勤']], ['試験 残業', ['出勤']], ['試験 入力済', ['出勤']], ['試験 管理', ['出勤']], ['試験 休み', ['公休']]]);
const formToday = [['ts', '氏名', '区分', '結果'], [ts('2026-10-20', '08:00'), '試験 退勤', '出勤前', 'x'], [ts('2026-10-20', '08:00'), '試験 残業', '出勤前', 'x'],
  [ts('2026-10-20', '08:00'), '試験 入力済', '出勤前', 'x'], [ts('2026-10-20', '19:10'), '試験 入力済', '退勤前', 'x'], [ts('2026-10-20', '08:00'), '試験 管理', '出勤前', 'x']];
const punchAt = (outFor) => () => X.AC_punchSummary(totResults(
  [rec('k101', '2026-10-20', [1, '09:00'], ...(outFor.includes('101') ? [[2, '19:30']] : [])),
    rec('k102', '2026-10-20', [1, '09:00'], ...(outFor.includes('102') ? [[2, '22:40']] : [])),
    rec('k103', '2026-10-20', [1, '09:00'], [2, '19:00'])],
  [emp('k101', '101'), emp('k102', '102'), emp('k103', '103'), emp('k105', '105')]), '2026-10-20', new Date(Date.now() - 10 * 60000).toISOString());

test('一晩の流れ（送信なし）：退勤した人には1回だけ、残業中の人は退勤まで保留、入力済み・休みの人には送らない、特例は20時だけ', () => {
  let out = ['101'];
  const n = night({ master, shifts: todaySheet, form: formToday, punchFor: () => punchAt(out)() });
  n.at(20);
  assert.deepEqual(n.sent.map(s => s.to), [uid(1), uid(4)]);                    // 退勤済みの人＋特例（従来の文面）
  assert.match(n.sent[0].text, /退勤後のアルコールチェックがまだ確認できていません/);
  assert.match(n.sent[1].text, /本日の退勤前アルコールチェックについて、まだ入力が確認できていません/);   // 特例は従来の文面
  assert.equal(n.admin.length, 1);                                              // 20時の管理者向け一覧
  assert.match(n.admin[0], /試験 残業（勤務中のため保留）/);
  n.at(20);                                                                     // 同じ時刻の再実行は何もしない
  n.at(21);
  n.at(22);
  assert.equal(n.sent.length, 2);                                               // 残業中は送らない、退勤済みにも2回目は送らない、特例も送らない
  out = ['101', '102'];                                                         // 22:40に退勤
  n.at(23);
  assert.deepEqual(n.sent.map(s => s.to), [uid(1), uid(4), uid(2)]);
  assert.match(n.sent[2].text, /退勤後のアルコールチェックがまだ確認できていません/);
  assert.equal(n.admin.length, 2);                                              // 23時の最終確認の一覧（夜の管理者向けは2通まで）
  assert.ok(!n.sent.some(s => s.to === uid(3) || s.to === uid(5)));              // 入力済み・休みの人には送らない
  assert.equal(n.dispatched.length, 0);                                         // 従来の20時の処理は動かない
});

test('一晩の流れ（送信なし）：23時もまだ勤務中なら「勤務終了後、運転開始前に」の文面を1回だけ', () => {
  const n = night({ master, shifts: todaySheet, form: formToday, punchFor: punchAt(['101']) });
  [20, 21, 22, 23].forEach(h => n.at(h));
  const toZangyo = n.sent.filter(s => s.to === uid(2));
  assert.equal(toZangyo.length, 1);
  assert.match(toZangyo[0].text, /^本日もお疲れ様です[\s\S]*勤務終了後、車を運転開始する前に/);
});

test('一晩の流れ（送信なし）：TOTが取れない夜は、管理者へ1回知らせて保留し、23時に「勤務終了後」の文面（特例は20時に従来どおり）', () => {
  const n = night({ master, shifts: todaySheet, form: formToday, punchFor: () => null });
  n.at(20);
  assert.deepEqual(n.sent.map(s => s.to), [uid(4)]);                            // 特例だけ
  assert.ok(n.admin.some(t => /TOTの打刻（退勤状況）を確認できなかった/.test(t)));
  n.at(21); n.at(22);
  assert.equal(n.admin.filter(t => /確認できなかった/.test(t)).length, 1);      // 知らせるのは1晩1回
  assert.equal(n.sent.length, 1);
  n.at(23);
  assert.deepEqual(n.sent.slice(1).map(s => s.to).sort(), [uid(1), uid(2)].sort());
  assert.ok(n.sent.slice(1).every(s => /勤務終了後、車を運転開始する前に/.test(s.text)));
});

test('切り替え（AFTER_WORK_TOT が "true" でない）：20時は従来の処理、21〜23時は何もしない', () => {
  const n = night({ enabled: false, master, shifts: todaySheet, form: formToday, punchFor: punchAt(['101']) });
  [20, 21, 22, 23].forEach(h => n.at(h));
  assert.deepEqual(n.dispatched.slice(), ['followAfter']);
  assert.equal(n.sent.length, 0);
});

test('翌朝のお礼（送信なし）：20時以降・日付をまたいで入力した人も、前回の勤務までの連続記録でお礼。二度は送らない', () => {
  const days = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];
  const sv = sheet(days, [['試験 残業', ['出勤', '出勤', '出勤', '出勤', '出勤', '出勤']], ['試験 管理', ['出勤', '出勤', '出勤', '出勤', '出勤', '出勤']], ['試験 休み', ['出勤', '出勤', '出勤', '出勤', '出勤', '公休']]]);
  const fv = [['ts', '氏名', '区分', '結果'],
    ...entries('試験 残業', [['2026-10-15', '08:00', '21:30'], ['2026-10-16', '08:00', '22:50'], ['2026-10-17', '08:00', '19:00'], ['2026-10-18', '08:00', '20:10'], ['2026-10-19', '08:00', '00:30', '2026-10-20'], ['2026-10-20', '08:00', '']]),
    ...entries('試験 管理', [['2026-10-15', '08:00', '20:30'], ['2026-10-16', '08:00', '23:59'], ['2026-10-17', '08:00', '19:00'], ['2026-10-18', '08:00', '21:00'], ['2026-10-19', '08:00', '22:00'], ['2026-10-20', '08:00', '']]),
    ...entries('試験 休み', [['2026-10-15', '08:00', '19:00'], ['2026-10-16', '08:00', '19:00'], ['2026-10-17', '08:00', '19:00'], ['2026-10-18', '08:00', '19:00'], ['2026-10-19', '08:00', '19:00']])];
  const n = night({ master, shifts: sv, form: fv, punchFor: () => null });
  n.setHour(8);
  // 日付の時刻はテスト用に実際の日本時間で判定する
  n.ctx.Utilities.formatDate = (d, tz, f) => (f === 'H' ? String(jstHour(d)) : toDate(d));
  n.ctx.__totR = totDays('k102', '102', [['2026-10-19', [1, '09:00'], [2, '23:55']]]);   // 19日は23:55退勤（0:30の入力は3時間以内）
  vm.runInContext('AC_readTotLatest_ = function () { return { today: "2026-10-20", results: __totR }; };', n.ctx);
  vm.runInContext('AC_morningThanks_()', n.ctx);
  const byTo = Object.fromEntries(n.sent.map(s => [s.to, s.text]));
  assert.match(byTo[uid(2)], /前回の勤務までで5勤務日連続/);                    // 残業（19日分を20日0:30に入力）も5日連続
  assert.match(byTo[uid(4)], /前回の勤務までで5勤務日連続/);                    // 特例：23:59までの入力はその日分、打刻なしでも未達成にしない
  assert.equal(byTo[uid(5)], undefined);                                        // 今日休みの人は次の出勤日の朝に
  assert.equal(n.sent.length, 2);
  vm.runInContext('AC_morningThanks_()', n.ctx);                                // 同じ朝の再実行
  assert.equal(n.sent.length, 2);
  assert.deepEqual(JSON.parse(n.user['thanksLast:10102']), { m: 5, start: '2026-10-15' });
});

// ---------------- ① 日付をまたいだ入力と、実際の退勤時刻（TOT）の整合 ----------------
const totDays = (key, code, list) => ({ employees: [emp(key, code)], timerecord: list.map(([date, ...punches]) => ({ date, dailyWorkings: [rec(key, date, ...punches)] })) });

test('深夜の入力（0〜5時の「退勤前」）：実際の退勤時刻から3時間以内なら前日分、過ぎていれば数えない。退勤打刻なし・データなしは判定保留', () => {
  const C = (R, entry, { ok = true, tot = '501' } = {}) => X.AC_crossEntryCheck(R, ok, tot, '2026-10-19', ts('2026-10-20', entry));
  assert.equal(C(totDays('k', '501', [['2026-10-19', [1, '09:00'], [2, '23:40']]]), '00:30'), 'ok');    // 残業で遅く退勤
  assert.equal(C(totDays('k', '501', [['2026-10-19', [1, '09:00'], [2, '21:30']]]), '00:20'), 'ok');    // 22時前の退勤でも3時間以内なら数える
  assert.equal(C(totDays('k', '501', [['2026-10-19', [1, '09:00'], [2, '21:30']]]), '00:31'), 'ng');    // 3時間を過ぎた
  assert.equal(C(totDays('k', '501', [['2026-10-19', [1, '09:00'], [2, '18:00']]]), '00:30'), 'ng');    // 遅れた入力
  assert.equal(C(totDays('k', '501', [['2026-10-19', [1, '09:00']], ['2026-10-20', [2, '00:20']]]), '00:40'), 'ok');   // 退勤が0時を過ぎ、翌日の打刻になった場合
  assert.equal(C(totDays('k', '501', [['2026-10-19', [1, '09:00']], ['2026-10-20', [2, '00:20']]]), '00:10'), 'ok');   // 退勤打刻の前の入力も前日分
  const crossSameDay = { employees: [emp('k', '501')], timerecord: [{ date: '2026-10-19', dailyWorkings: [{ employeeKey: 'k', date: '2026-10-19', timeRecord: [{ code: '1', time: '2026-10-19T09:00:00+09:00' }, { code: '2', time: '2026-10-20T01:10:00+09:00' }] }] }] };
  assert.equal(C(crossSameDay, '01:30'), 'ok');                                                                     // 前日の勤務に1:10の退勤が付いている場合
  assert.equal(C(totDays('k', '501', [['2026-10-19', [1, '09:00']]]), '00:30'), 'noOut');                        // 退勤打刻なし → 保留
  assert.equal(C(totDays('k', '501', [['2026-10-18', [1, '09:00'], [2, '18:00']]]), '00:30'), 'noOut');          // その日の打刻なし → 保留
  assert.equal(C(totDays('k', '501', [['2026-10-19', [1, '09:00'], [2, '18:00']], ['2026-10-20', [1, '09:00']]]), '00:30'), 'ng');   // 翌日の出勤は混ぜない
  assert.equal(C(totDays('k', '501', [['2026-10-19', [1, '09:00'], [2, '23:40']]]), '00:30', { ok: false }), 'noData');   // 今朝のデータでない
  assert.equal(C(null, '00:30'), 'noData');
  assert.equal(C(totDays('k', '999', [['2026-10-19', [1, '09:00'], [2, '23:40']]]), '00:30'), 'noData');    // TOTにいない
  assert.equal(C(totDays('k', '501', [['2026-10-19', [1, '09:00'], [2, '18:00']]]), '00:30', { tot: '' }), 'noTot');   // TOTコードなし
});

test('連続記録：前日分（ok）は数える、遅れた入力（ng）は数えない、判定保留（pending）は数えないが途切れさせない', () => {
  const base = [['2026-10-14', '08:00', '19:00'], ['2026-10-15', '08:00', '19:00'], ['2026-10-17', '08:00', '19:00'], ['2026-10-18', '08:00', '19:00']];
  const fv = entries('試験 太郎', [...base, ['2026-10-19', '08:00', '00:30', '2026-10-20']]);
  assert.equal(streak(fv, '2026-10-19', { crossCheck: () => 'ok' }).n, 5);
  assert.equal(streak(fv, '2026-10-19', { crossCheck: () => 'ng' }).n, 0);
  const p = streak(fv, '2026-10-19', { crossCheck: () => 'pending' });
  assert.equal(p.n, 4);                                                    // 19日は数えないが、14〜18日の連続は続く
  assert.deepEqual(Array.from(p.pending), ['2026-10-19']);
  const asked = [];
  streak(fv, '2026-10-19', { crossCheck: (d, t) => { asked.push([d, toDate(t)]); return 'ok'; } });
  assert.deepEqual(asked, [['2026-10-19', '2026-10-20']]);               // 0時以降の「退勤前」の入力だけを確かめる
});

// 朝のお礼を、TOTデータ（朝7:05の tot-latest.json）つきで、送信せずに確認する
const morning = ({ fv, sv, totR, today = '2026-10-20', totToday, user = {} }) => {
  const n = night({ today, master, shifts: sv, form: fv, punchFor: () => null });
  Object.assign(n.user, user);
  n.ctx.Utilities.formatDate = (d, tz, f) => (f === 'H' ? String(jstHour(d)) : toDate(d));
  n.ctx.__totR = totR; n.ctx.__totToday = totToday || today;
  vm.runInContext('AC_readTotLatest_ = function () { return __totR ? { today: __totToday, results: __totR } : null; };', n.ctx);
  vm.runInContext('AC_morningThanks_()', n.ctx);
  return n;
};
const days6 = ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];
const work5 = [['2026-10-15', '08:00', '19:00'], ['2026-10-16', '08:00', '19:00'], ['2026-10-17', '08:00', '19:00'], ['2026-10-18', '08:00', '19:00']];
const sv6 = sheet(days6, [['試験 残業', Array(6).fill('出勤')]]);
const fvLate = (hm = '00:30') => [['ts', '氏名', '区分', '結果'], ...entries('試験 残業', [...work5, ['2026-10-19', '08:00', hm, '2026-10-20'], ['2026-10-20', '08:00', '']])];
const out19 = (hm, extra = []) => totDays('k102', '102', [['2026-10-19', [1, '09:00'], ...(hm ? [[2, hm]] : [])], ...extra]);

test('翌朝のお礼（送信なし）：実際の退勤時刻を優先。23:40退勤・0:30入力 → お礼／21:30退勤・0:20入力 → お礼／18:00退勤・0:30入力 → 数えない', () => {
  const a = morning({ sv: sv6, fv: fvLate('00:30'), totR: out19('23:40') });
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].text, /5勤務日連続/);
  assert.equal(a.user['late:10102:2026-10-19'], 'ok');                  // 決まった判定は記録（後から変えない）
  const b = morning({ sv: sv6, fv: fvLate('00:20'), totR: out19('21:30') });
  assert.equal(b.sent.length, 1);
  const c = morning({ sv: sv6, fv: fvLate('00:30'), totR: out19('18:00') });
  assert.equal(c.sent.length, 0);
  assert.equal(c.user['late:10102:2026-10-19'], 'ng');
});

test('翌朝のお礼（送信なし）：退勤打刻なし → 判定保留（リセットせず、お礼は待つ）→ 打刻が直った朝に自動で判定してお礼', () => {
  const a = morning({ sv: sv6, fv: fvLate(), totR: out19('') });
  assert.equal(a.sent.length, 0);
  assert.equal(a.user['late:10102:2026-10-19'], undefined);             // 保留は記録しない（毎朝見直す）
  assert.equal(a.user['thanksLast:10102'], undefined);                  // お礼の記録も進めない
  assert.ok(a.logs.some(l => /判定保留のため待ちます/.test(l)));
  // 翌朝：本人の申請で退勤が23:30に直っていた
  const sv7 = sheet([...days6, '2026-10-21'], [['試験 残業', Array(7).fill('出勤')]]);
  const fv7 = [...fvLate(), [ts('2026-10-20', '19:00'), '試験 残業', '退勤前', 'x'], [ts('2026-10-21', '08:00'), '試験 残業', '出勤前', 'x']];
  const b = morning({ today: '2026-10-21', sv: sv7, fv: fv7, user: a.user, totR: out19('23:30', [['2026-10-20', [1, '09:00'], [2, '18:30']]]) });
  assert.equal(b.sent.length, 1);
  assert.match(b.sent[0].text, /6勤務日連続/);                          // 19日も数えて、15〜20日の6日連続
});

test('翌朝のお礼（送信なし）：TOTのデータが取れない・古い朝は判定保留（途切れさせない）。期限（7日）を過ぎたら、TOTの不具合なら数える／打刻が直らないままなら数えない', () => {
  const none = morning({ sv: sv6, fv: fvLate(), totR: null });
  assert.equal(none.sent.length, 0);
  assert.equal(none.user['late:10102:2026-10-19'], undefined);
  const old = morning({ sv: sv6, fv: fvLate(), totR: out19('23:40'), totToday: '2026-10-19' });   // 7:05の取得に失敗し、前日のデータのまま
  assert.equal(old.sent.length, 0);
  // 期限切れ（10/27の朝）
  const days = [...days6, '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
  const sv = sheet(days, [['試験 残業', [...Array(6).fill('出勤'), ...Array(6).fill('公休'), '出勤']]]);
  const fv = [...fvLate(), [ts('2026-10-20', '19:00'), '試験 残業', '退勤前', 'x'], [ts('2026-10-27', '08:00'), '試験 残業', '出勤前', 'x']];
  const sysFail = morning({ today: '2026-10-27', sv, fv, totR: null, user: { 'mthanks:init': '2026-10-20' } });
  assert.equal(sysFail.user['late:10102:2026-10-19'], 'ok');            // TOTの不具合 → 数える（不利にしない）
  assert.match(sysFail.sent[0].text, /6勤務日連続/);
  const noFix = morning({ today: '2026-10-27', sv, fv, totR: out19(''), user: { 'mthanks:init': '2026-10-20' } });
  assert.equal(noFix.user['late:10102:2026-10-19'], 'ng');              // 退勤打刻が直らないまま → 数えない
  assert.equal(noFix.sent.length, 0);                                   // 20日の1日だけ（節目に届かない）
});

// ---------------- ② 管理監督者（10015）：20時の確認連絡のあと、当日23:59までの入力で連続記録とお礼を維持 ----------------
test('特例（10015・送信なし）：20時に確認連絡 → 21:30に入力 → 翌朝、連続記録が続き5日連続のお礼。翌日0:10の入力では前日分にしない', () => {
  const sv = sheet(days6, [['試験 管理', Array(6).fill('出勤')]]);
  const make = after => [['ts', '氏名', '区分', '結果'], ...entries('試験 管理', [...work5, after, ['2026-10-20', '08:00', '']])];
  // 19日の夜：20時の確認連絡（従来の文面）が届く
  const eve = night({ today: '2026-10-19', master, shifts: sv, form: [['ts', '氏名', '区分', '結果'], ...entries('試験 管理', [...work5, ['2026-10-19', '08:00', '']])], punchFor: () => null });
  eve.at(20); eve.at(21); eve.at(22); eve.at(23);
  assert.equal(eve.sent.filter(s => s.to === uid(4)).length, 1);
  assert.match(eve.sent[0].text, /本日の退勤前アルコールチェックについて、まだ入力が確認できていません/);
  // 21:30に入力 → 翌朝お礼
  const ok = morning({ sv, fv: make(['2026-10-19', '08:00', '21:30']), totR: null });
  vm.runInContext('AC_morningThanks_()', ok.ctx);
  assert.equal(ok.sent.length, 1);
  assert.match(ok.sent[0].text, /5勤務日連続/);
  // 23:59に入力 → お礼
  const edge = morning({ sv, fv: make(['2026-10-19', '08:00', '23:59']), totR: null });
  vm.runInContext('AC_morningThanks_()', edge.ctx);
  assert.equal(edge.sent.length, 1);
  // 翌日0:10の入力 → 19日分にしない（打刻がないことは理由にしない。当日中という特例のルール）
  const ng = morning({ sv, fv: make(['2026-10-19', '08:00', '00:10', '2026-10-20']), totR: totDays('k999', '999', [['2026-10-19', [1, '09:00'], [2, '23:50']]]) });
  vm.runInContext('AC_morningThanks_()', ng.ctx);
  assert.equal(ng.sent.length, 0);
});

// ---------------- ② 打刻漏れが7日間直らなかったとき：フォームの「実施時刻」（任意の設問）があれば確認してから確定 ----------------
test('実施時刻：入力より前・その勤務日の0時〜翌5時・入力が実施から3時間以内なら認める。読めなければ使わない', () => {
  const S = (entry, hhmm) => X.AC_selfReportedCheck(ts('2026-10-20', entry), hhmm, '2026-10-19');
  assert.equal(S('00:30', '23:50'), 'ok');                                  // 19日23:50に実施 → 0:30に入力
  assert.equal(S('00:30', '00:10'), 'ok');                                  // 日付をまたいで0:10に実施
  assert.equal(S('00:30', '21:30'), 'ok');                                  // ちょうど3時間
  assert.equal(S('00:30', '21:00'), 'ng');                                  // 3時間30分前 → 入力が遅すぎる
  assert.equal(S('00:30', '04:00'), 'ng');                                  // 入力より後の時刻 → 前日4:00とみなし、19日の範囲外
  assert.equal(S('00:30', new Date('1899-12-30T23:40:00+09:00')), 'ok');    // フォームの時刻の値（日付つき）
  assert.equal(S('00:30', ''), null);
  assert.equal(S('00:30', 'わからない'), null);
});

test('打刻漏れが7日間直らない（送信なし）：既定ではフォームに「実施時刻」の列があっても使わず、数えない。承認後に有効にした場合だけ使う', () => {
  const days = [...days6, '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
  const sv = sheet(days, [['試験 残業', [...Array(6).fill('出勤'), ...Array(6).fill('公休'), '出勤']]]);
  const withDone = (hhmm) => {
    const fv = [...fvLate(), [ts('2026-10-20', '19:00'), '試験 残業', '退勤前', 'x'], [ts('2026-10-27', '08:00'), '試験 残業', '出勤前', 'x']].map((r, i) => [...r, '', '', i === 0 ? '実施時刻' : '']);
    const row = fv.findIndex(r => r[2] === '退勤前' && toDate(r[0]) === '2026-10-20' && jstHour(r[0]) === 0);
    fv[row][6] = hhmm;
    return fv;
  };
  assert.equal(X.AC_USE_FORM_DONE_TIME, false);
  const off = morning({ today: '2026-10-27', sv, fv: withDone('23:50'), totR: out19(''), user: { 'mthanks:init': '2026-10-20' } });
  assert.equal(off.user['late:10102:2026-10-19'], 'ng');                 // 列があっても使わない（自動で判定を変えない）
  assert.equal(off.sent.length, 0);
  assert.ok(!off.logs.some(l => /実施時刻で判定/.test(l)));
  // 承認後に有効にした場合（AC_USE_FORM_DONE_TIME = true）だけ使う
  const days2 = { today: '2026-10-27', sv, fv: withDone('23:50'), totR: out19(''), user: { 'mthanks:init': '2026-10-20' } };
  const n = night({ today: days2.today, master, shifts: sv, form: days2.fv, punchFor: () => null });
  Object.assign(n.user, days2.user);
  n.ctx.Utilities.formatDate = (d, tz, f) => (f === 'H' ? String(jstHour(d)) : toDate(d));
  n.ctx.__totR = days2.totR;
  vm.runInContext('AC_USE_FORM_DONE_TIME = true; AC_readTotLatest_ = function () { return { today: "2026-10-27", results: __totR }; }; AC_morningThanks_();', n.ctx);
  assert.equal(n.user['late:10102:2026-10-19'], 'ok');
  assert.ok(n.logs.some(l => /実施時刻で判定/.test(l)));
});

// ---------------- ③ 判定保留の間も、その後の勤務日の入力は記録が続き、保留が解けたときにお礼を取りこぼさない ----------------
test('判定保留のあとも勤務が続く（送信なし）：保留中はお礼を待ち、解けた朝に通算の日数でお礼。数えないと決まっても、その後の連続でお礼', () => {
  const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'];
  const sv = sheet(days, [['試験 残業', Array(11).fill('出勤')]]);
  // 12〜15日は通常、16日は0:30（17日）に入力・退勤打刻なし、17〜21日は通常、22日は今日
  const fv = [['ts', '氏名', '区分', '結果'], ...entries('試験 残業', [
    ['2026-10-12', '08:00', '19:00'], ['2026-10-13', '08:00', '19:00'], ['2026-10-14', '08:00', '19:00'], ['2026-10-15', '08:00', '19:00'],
    ['2026-10-16', '08:00', '00:30', '2026-10-17'],
    ['2026-10-17', '08:00', '19:00'], ['2026-10-18', '08:00', '19:00'], ['2026-10-19', '08:00', '19:00'], ['2026-10-20', '08:00', '19:00'], ['2026-10-21', '08:00', '19:00'],
    ['2026-10-22', '08:00', '']])];
  const tot16 = (out) => totDays('k102', '102', [['2026-10-16', [1, '09:00'], ...(out ? [[2, out]] : [])]]);
  // 保留中（退勤打刻なし）：12〜15日（4日）＋17〜21日（5日）は記録が続いているが、16日が保留なのでお礼は待つ
  const wait = morning({ today: '2026-10-22', sv, fv, totR: tot16(''), user: { 'mthanks:init': '2026-10-12' } });
  assert.equal(wait.sent.length, 0);
  assert.ok(wait.logs.some(l => /判定保留のため待ちます/.test(l) && /2026-10-16/.test(l)));
  // 打刻が23:50に直った朝：16日も数えて、12〜21日の10日連続 → 10日のお礼（取りこぼさない）
  const fixed = morning({ today: '2026-10-22', sv, fv, totR: tot16('23:50'), user: { 'mthanks:init': '2026-10-12' } });
  assert.equal(fixed.sent.length, 1);
  assert.match(fixed.sent[0].text, /10勤務日連続/);
  assert.deepEqual(JSON.parse(fixed.user['thanksLast:10102']), { m: 10, start: '2026-10-12' });
  // 数えないと決まった場合（18:00退勤 → 0:30の入力は遅すぎる）：16日で途切れ、17〜21日の5日連続でお礼
  const ng = morning({ today: '2026-10-22', sv, fv, totR: tot16('18:00'), user: { 'mthanks:init': '2026-10-12' } });
  assert.equal(ng.sent.length, 1);
  assert.match(ng.sent[0].text, /5勤務日連続/);
});

test('案内の文面：「運転を開始する前に」チェックを行う前提を、退勤後・勤務終了後・特例の文面すべてで維持する', () => {
  assert.match(X.AC_render('followAfterOut', '2026-10-20', {}), /運転を開始する前にアルコールチェックを実施/);
  assert.match(X.AC_render('followAfterWorking', '2026-10-20', {}), /車を運転開始する前にアルコールチェックを実施/);
  assert.match(X.AC_render('followAfter', '2026-10-20', {}), /未実施の場合は/);   // 特例（10015）は従来の文面のまま
  for (const k of ['mthanks5', 'mthanks10', 'mthanksN']) assert.doesNotMatch(X.AC_render(k, '2026-10-20', { n: 6 }), /後から|あとで/);   // お礼で後からの実施を促さない
});
