import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 管理本部の本人への「承認待ちの申請」のお知らせ（すべて架空データ）
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const row = (code, name, dept, tot, { status = '在籍', userId = U(code.slice(-1)), lineOk = true, retiredOn = '' } = {}) =>
  ["'" + code, name, '', status, dept, userId, '', '', lineOk, true, '', '正社員', tot, retiredOn ? "'" + retiredOn : ''];
const MASTER = [HEAD,
  row('90001', '試験 一郎', '管理本部', 501),
  row('90002', '試験 二郎', '管理本部', 502),
  row('90003', '試験 三郎', '部署A', 503),                       // 他部署
  row('90004', '試験 四郎', '管理本部', 504, { lineOk: false }), // LINE未確認
  row('90005', '試験 五郎', '管理本部', 505, { userId: '' }),    // LINE未登録
  row('90006', '試験 六郎', '管理本部', 506, { status: '退職' }),
  row('90007', '試験 七郎', '管理本部', 507, { retiredOn: '2026-10-01' }), // 退職日が過去
  row('90008', '試験 八郎', '管理本部', 508), row('90009', '試験 九郎', '管理本部', '0508'), // TOTコード重複
];
let PN = 0;
const P = (tot, type, date) => ({ tot: String(tot), type, date, requestedDate: date, key: 'x:' + (++PN) });
const PEND = [P(501, '打刻申請', '2026-10-25'), P(502, '残業申請', '2026-10-24'), P(501, 'スケジュール（休暇など）申請', '2026-10-26'),
  P(503, '打刻申請', '2026-10-25'), P(504, '打刻申請', '2026-10-25'), P(505, '打刻申請', '2026-10-25'), P(506, '打刻申請', '2026-10-25'),
  P(507, '打刻申請', '2026-10-25'), P(508, '打刻申請', '2026-10-25'), P('', '打刻申請', '2026-10-25'), P(999, '打刻申請', '2026-10-25')];

function setup(props = {}) {
  const g = createGas({ files: ['AlcoholCheck.gs'], now: '2026-10-27T07:10:00+09:00' });
  const ss = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = ss.insertSheet('従業員マスタ');
  MASTER.forEach((r) => m.appendRow(r));
  const pz = ss.insertSheet('お知らせ停止');
  pz.appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: ss.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: U(7), ...props });
  return { g, ss, m, pz };
}

test('本人宛て：管理本部・在籍・LINE確認済みの本人に、自分の申請だけ。他部署・未登録・退職・照合できない申請は入らない', () => {
  const { g, m } = setup();
  const list = JSON.parse(JSON.stringify(g.ctx.AC_selfRequestNotices(PEND, m.dump(), '2026-10-27')));
  assert.deepEqual(list.map((x) => x.code), ['90001', '90002']);
  assert.equal(list[0].items.length, 2);
  assert.match(list[0].text, /試験 一郎さん、.*2件/);
  assert.match(list[0].text, /打刻申請（2026-10-25分/);
  assert.ok(!/二郎|三郎|残業申請/.test(list[0].text));          // 他人の申請・名前は入らない
  assert.equal(list[1].items.length, 1);
  assert.ok(!/一郎|打刻申請/.test(list[1].text));
  assert.equal(list[0].userId, U(1));
});

const EMP = [501, 502, 503].map((c, i) => ({ key: 'k' + c, code: String(c), lastName: '試験', firstName: String(i) }));
const REQ = [{ type: 'timerecords', date: '2026-10-25', requestedDate: '2026-10-25', employeeKey: 'k501', requestKey: 'r1', status: 'applying' },
  { type: 'overtimes', date: '2026-10-24', requestedDate: '2026-10-24', employeeKey: 'k502', requestKey: 'r2', status: 'applying' },
  { type: 'timerecords', date: '2026-10-25', requestedDate: '2026-10-25', employeeKey: 'k503', requestKey: 'r3', status: 'applying' },
  { type: 'timerecords', date: '2026-10-20', requestedDate: '2026-10-20', employeeKey: 'k501', requestKey: 'r4', status: 'approved' }];

// 朝のTOT受信で保存される tot-latest.json を置く（夜のデータには requests が無い）
function putLatest(g, results, today = '2026-10-27', at = '2026-10-27T07:05:30+09:00') {
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today, fetchedAt: at, results }), updated: new Date(at).getTime() };
}
function hourly(g) {
  const n = g.fetches.length;
  g.ctx.alcoholCheckImportTot();   // 既存の1時間ごとの処理から呼ばれる
  return g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
}

test('本人宛て：未設定なら何もしない。朝のTOT受信（doPost）の処理の中では本人へ送らない（管理者への一覧は今までどおり）', () => {
  const { g, ss } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'on' });
  const n = g.fetches.length;
  g.ctx.AC_adminAttendanceChecks_({ employees: EMP, requests: REQ }, ss.getSheetByName('従業員マスタ').dump(), ss, '2026-10-27', g.scriptProps);
  const pushes = g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
  assert.deepEqual(pushes.map((f) => f.body.to), [U(7)]);
  assert.equal(ss.getSheetByName('承認待ち本人通知'), null);
  const { g: g2, ss: ss2 } = setup({ DRY_RUN: 'false' });   // 設定なし：ファイルも読まない
  putLatest(g2, { employees: EMP, requests: REQ, workings: [] });
  assert.equal(hourly(g2).length, 0);
  assert.equal(ss2.getSheetByName('承認待ち本人通知'), null);
});

test('本人宛て：記録のみ（record）は送らずにシートへ記録（1時間ごとの処理で1日1回）', () => {
  const { g, ss } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'record' });
  putLatest(g, { employees: EMP, requests: REQ, workings: [] });
  assert.equal(hourly(g).length, 0);
  const rec = ss.getSheetByName('承認待ち本人通知').dump();
  assert.deepEqual(rec.slice(1).map((r) => [r[1], r[3], r[5]]), [['90001', 1, '記録のみ（送信しない）'], ['90002', 1, '記録のみ（送信しない）']]);
  g.clock.now += 3600e3; hourly(g);                          // 1時間後：同じ日は繰り返さない
  assert.equal(ss.getSheetByName('承認待ち本人通知').dump().length, 3);
});

test('本人宛て：動かない条件（7時前・12時以降・前日のデータ・夜のデータ（申請なし）・申請データの読み取りエラー）', () => {
  const cases = [
    ['2026-10-27T06:30:00+09:00', () => ({ employees: EMP, requests: REQ, workings: [] }), '2026-10-27'],
    ['2026-10-27T12:10:00+09:00', () => ({ employees: EMP, requests: REQ, workings: [] }), '2026-10-27'],
    ['2026-10-27T07:30:00+09:00', () => ({ employees: EMP, requests: REQ, workings: [] }), '2026-10-26'],
    ['2026-10-27T07:30:00+09:00', () => ({ employees: EMP, workings: [] }), '2026-10-27'],
    ['2026-10-27T07:30:00+09:00', () => ({ employees: EMP, requests: [{ _error: 'x' }], workings: [] }), '2026-10-27'],
  ];
  for (const [now, res, day] of cases) {
    const { g, ss } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'on' });
    g.clock.now = new Date(now).getTime();
    putLatest(g, res(), day, day === '2026-10-26' ? '2026-10-26T22:30:00+09:00' : '2026-10-27T06:00:00+09:00');
    assert.equal(hourly(g).length, 0, now + ' ' + day);
    assert.equal(ss.getSheetByName('承認待ち本人通知'), null);
  }
});

test('本人宛て：on で本人へ1通ずつ。同じ日の2回目は送らない。DRY_RUN が false でなければ送らない。お知らせ停止中は送らない', () => {
  const { g, ss, pz } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'on' });
  pz.appendRow(["'90002", '試験 二郎', '2026-10-27', '2026-10-27', '休み', '全部']);
  putLatest(g, { employees: EMP, requests: REQ, workings: [] });
  const p1 = hourly(g);
  assert.deepEqual(p1.map((f) => f.body.to), [U(1)]);        // 一郎さん本人だけ（二郎さんは停止中。管理者の一覧はここでは送らない）
  assert.ok(!/残業申請/.test(p1[0].body.messages[0].text));
  g.userProps.deleteProperty('selfnotice:2026-10-27');      // 万一もう一度動いても
  assert.equal(hourly(g).length, 0);                          // 同じ日の2回目は本人へも重複しない
  const rec = ss.getSheetByName('承認待ち本人通知').dump().slice(1).map((r) => [r[1], r[5]]);
  assert.deepEqual(rec, [['90001', '送信'], ['90002', 'お知らせ停止中のため送らない'], ['90002', 'お知らせ停止中のため送らない']]);   // 一郎さんは新しい申請が無いので行も無い
  const { g: g2 } = setup({ REQUEST_SELF_NOTIFY: 'on' });   // DRY_RUN 未設定
  putLatest(g2, { employees: EMP, requests: REQ, workings: [] });
  assert.equal(hourly(g2).length, 0);
});

// ---------------- 1つの申請につき1回だけ（2026-11-09） ----------------
const DAY = (d, h = '07:30') => new Date(`2026-10-${d}T${h}:00+09:00`).getTime();
function morning(g, d, requests) {
  g.clock.now = DAY(d);
  putLatest(g, { employees: EMP, requests, workings: [] }, `2026-10-${d}`, `2026-10-${d}T07:05:30+09:00`);
  return hourly(g);
}
const seenKeys = (g) => Object.keys(g.userProps.getProperties()).filter((k) => k.startsWith('reqseen:')).sort();

test('本人宛て（1回だけ）：同じ申請が翌日も承認待ちなら送らない。新しい申請が1件増えたらその1件だけ。承認された申請の記録は掃除される', () => {
  const { g, ss } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'on' });
  assert.equal(morning(g, 27, REQ).length, 2);                                  // 一郎さん（r1）・二郎さん（r2）
  assert.deepEqual(seenKeys(g), ['reqseen:self:overtimes:r2', 'reqseen:self:timerecords:r1']);
  assert.equal(morning(g, 28, REQ).length, 0);                                  // 翌日も同じ申請：送らない
  const r5 = { type: 'schedules', date: '2026-10-30', requestedDate: '2026-10-29', employeeKey: 'k501', requestKey: 'r5', status: 'applying' };
  const p = morning(g, 29, [...REQ, r5]);
  assert.deepEqual(p.map((f) => f.body.to), [U(1)]);                             // 増えた1件だけ、一郎さんへ
  const t = p[0].body.messages[0].text;
  assert.match(t, /承認待ちのものが1件/); assert.match(t, /スケジュール（休暇など）申請（2026-10-30分/); assert.ok(!/2026-10-25分/.test(t));
  const approved = REQ.map((q) => (q.requestKey === 'r1' ? { ...q, status: 'approved' } : q));
  assert.equal(morning(g, 30, [...approved, r5]).length, 0);                    // r1 が承認された
  assert.deepEqual(seenKeys(g), ['reqseen:self:overtimes:r2', 'reqseen:self:schedules:r5']);   // r1 の記録は消える
  g.clock.now = DAY(30) + 10 * 86400e3; g.ctx.AC_cleanupSentKeys_(g.userProps, '2026-11-09');  // 8日の掃除では消えない
  assert.equal(seenKeys(g).length, 2);
  const rec = ss.getSheetByName('承認待ち本人通知').dump().slice(1).map((r) => [r[1], r[3], r[5]]);
  assert.deepEqual(rec, [['90001', 1, '送信'], ['90002', 1, '送信'], ['90001', 1, '送信']]);
});

test('本人宛て（1回だけ）：record は送らずに1回だけ記録。on に切り替えた日に、まだ届いていない申請を1回だけ送る', () => {
  const { g, ss } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'record' });
  assert.equal(morning(g, 27, REQ).length, 0);
  assert.equal(morning(g, 28, REQ).length, 0);
  assert.equal(ss.getSheetByName('承認待ち本人通知').dump().length, 3);           // 2日目は新しい申請が無いので行も増えない
  assert.deepEqual(seenKeys(g), ['reqseen:selfrec:overtimes:r2', 'reqseen:selfrec:timerecords:r1']);
  g.scriptProps.setProperty('REQUEST_SELF_NOTIFY', 'on');
  assert.equal(morning(g, 29, REQ).length, 2);                                  // record の記録では「知らせた」にしない
  assert.equal(morning(g, 30, REQ).length, 0);
  const res = ss.getSheetByName('承認待ち本人通知').dump().slice(1).map((r) => r[5]);
  assert.deepEqual(res, ['記録のみ（送信しない）', '記録のみ（送信しない）', '送信', '送信']);
});

test('本人宛て（1回だけ）：送信に失敗した申請は記録せず翌日にもう一度。申請データの読み取りエラーの日は記録を消さない', () => {
  const { g } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'on' });
  g.line.pushFail.add(U(1));
  assert.equal(morning(g, 27, REQ).filter((f) => f.body.to === U(2)).length, 1);
  assert.deepEqual(seenKeys(g), ['reqseen:self:overtimes:r2']);
  g.line.pushFail.clear();
  assert.deepEqual(morning(g, 28, REQ).map((f) => f.body.to), [U(1)]);
  assert.equal(morning(g, 29, [...REQ.filter((q) => q.requestKey !== 'r1'), { _error: 500 }]).length, 0);
  assert.equal(seenKeys(g).length, 2);                                          // 読めなかった日は掃除しない
});

test('管理者の一覧（1回だけ）：新しく増えた申請だけ。新しい申請が無い日は送らない。承認された申請の記録は掃除される', () => {
  const { g, ss } = setup({ DRY_RUN: 'false' });
  const mv = ss.getSheetByName('従業員マスタ').dump();
  const run = (d, requests) => {
    g.clock.now = DAY(d);
    const n = g.fetches.length;
    g.ctx.AC_adminAttendanceChecks_({ employees: EMP, requests }, mv, ss, `2026-10-${d}`, g.scriptProps);
    return g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
  };
  const p1 = run(27, REQ);
  assert.deepEqual(p1.map((f) => f.body.to), [U(7)]);
  assert.match(p1[0].body.messages[0].text, /新しく承認待ちになった申請が3件/);
  assert.equal(run(28, REQ).length, 0);                                         // 同じ申請だけ：送らない
  const r5 = { type: 'overtimes', date: '2026-10-28', requestedDate: '2026-10-28', employeeKey: 'k503', requestKey: 'r5', status: 'applying' };
  const p3 = run(29, [...REQ, r5]);
  const t = p3[0].body.messages[0].text;
  assert.match(t, /新しく承認待ちになった申請が1件/); assert.match(t, /全部で4件/); assert.match(t, /残業申請（2026-10-28分/); assert.ok(!/2026-10-25分/.test(t));
  run(30, REQ.filter((q) => q.requestKey !== 'r2').concat([r5]));             // r2 が承認・取消
  assert.ok(!seenKeys(g).includes('reqseen:admin:overtimes:r2'));
  assert.equal(seenKeys(g).filter((k) => k.startsWith('reqseen:admin:')).length, 3);
  g.line.pushFail.add(U(7));                                                    // 送れなかった申請は記録しない
  const r6 = { ...r5, requestKey: 'r6', date: '2026-10-29' };
  g.clock.now = DAY(31);
  g.ctx.AC_adminAttendanceChecks_({ employees: EMP, requests: [r5, r6] }, mv, ss, '2026-10-31', g.scriptProps);
  assert.ok(!seenKeys(g).includes('reqseen:admin:overtimes:r6'));
});

// ---------------- 止まった箇所の診断（alcoholCheckSelfNoticeDiagnose・2026-11-10c） ----------------
function diagnose(g) {
  const n = g.fetches.length, nl = g.logs.length;
  const before = JSON.stringify([g.scriptProps.getProperties(), g.userProps.getProperties()]);
  g.ctx.alcoholCheckSelfNoticeDiagnose();
  assert.equal(g.fetches.length, n);                         // 送信なし
  assert.equal(JSON.stringify([g.scriptProps.getProperties(), g.userProps.getProperties()]), before);   // 記録の書き込みなし
  const text = g.logs.slice(nl).join('\n');
  assert.ok(!/試験|U\d{32}|k50\d|r\d/.test(text), '氏名・LINE ID・申請の中身を出さない');
  return text;
}

test('診断：送らず・書き込まずに、本番の処理が最後まで進むことと、件数・人数だけを出す', () => {
  const { g, ss } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'on', NOTICE_SETTINGS: 'record' });
  g.clock.now = DAY(27);
  putLatest(g, { employees: EMP, requests: REQ, workings: [] });
  const t = diagnose(g);
  assert.match(t, /版 2026-11-10c/);
  assert.ok(!/× /.test(t), t);
  assert.match(t, /→ 本番の処理は最後まで進みます/);
  assert.match(t, /employees array 3件／requests array 4件／workings array 0件/);
  assert.match(t, /承認待ちの申請 3件／そのうちまだ知らせていない申請 3件/);
  assert.match(t, /送る相手 2人/);
  assert.match(t, /送信（記録は reqseen:self）/);
  assert.equal(ss.getSheetByName('承認待ち本人通知'), null);
  assert.equal(ss.getSheetByName('通知送信履歴'), null);
  // 実際に送った後：まだ知らせていない申請は0件、実行済みの記録で止まる
  assert.equal(hourly(g).length, 2);
  const t2 = diagnose(g);
  assert.match(t2, /× 3\. 今日の実行済みの記録/);
  assert.match(t2, /まだ知らせていない申請 1件/);             // 対象外（他部署）の人の申請だけが残る
  assert.match(t2, /送る相手 0人/);
  assert.match(t2, /「3\. 今日の実行済みの記録.*」で止まります/);
});

test('診断：止まる箇所（設定値の誤り・時間外・前日のファイル・データの形・読み取りエラー・record）', () => {
  const run = (props, { at = DAY(27), results = { employees: EMP, requests: REQ, workings: [] }, day = '2026-10-27', upd = '2026-10-27T07:05:30+09:00' } = {}) => {
    const { g } = setup({ DRY_RUN: 'false', ...props });
    g.clock.now = at;
    putLatest(g, results, day, upd);
    return diagnose(g);
  };
  assert.match(run({ REQUEST_SELF_NOTIFY: 'ON' }), /で止まります/);
  assert.match(run({ REQUEST_SELF_NOTIFY: 'ON' }), /× 1\. 設定.*REQUEST_SELF_NOTIFY="ON"／PUNCH_SELF_NOTIFY=未設定/);
  assert.match(run({ REQUEST_SELF_NOTIFY: 'ON', PUNCH_SELF_NOTIFY: 'record' }), /× 10\. REQUEST_SELF_NOTIFY が record／on/);
  const late = run({ REQUEST_SELF_NOTIFY: 'on' }, { at: DAY(27, '12:30') });
  assert.match(late, /「2\. 時刻（7〜11時台）」で止まります/);
  assert.match(late, /送る相手 2人/);                        // 時間外でも先まで診断する
  const old = run({ REQUEST_SELF_NOTIFY: 'on' }, { day: '2026-10-26', upd: '2026-10-26T22:30:00+09:00' });
  assert.match(old, /× 5\. .*更新 2026-10-26 22:30/);
  assert.match(old, /× 7\. .*today="2026-10-26"/);
  assert.match(old, /「5\. tot-latest\.json の更新日が今日」で止まります/);
  const night = run({ REQUEST_SELF_NOTIFY: 'on' }, { results: { employees: EMP, workings: { _error: 503 } } });
  assert.match(night, /× 8\. .*requests なし／workings エラー（503）（array ではない）/);
  assert.ok(!/× 9\./.test(night) && !/送る相手/.test(night));
  assert.match(run({ REQUEST_SELF_NOTIFY: 'on' }, { results: { employees: EMP, requests: [...REQ, { _error: 500 }], workings: [] } }),
    /× 9\. .*申請のエラー 1件／勤務のエラー 0件/);
  const rec = run({ REQUEST_SELF_NOTIFY: 'record' });
  assert.match(rec, /記録のみ（記録は reqseen:selfrec）/);
  assert.match(rec, /最後まで進みます/);
  const { g } = setup({ DRY_RUN: 'false', REQUEST_SELF_NOTIFY: 'on' });   // ファイルなし
  g.clock.now = DAY(27);
  assert.match(diagnose(g), /「4\. tot-latest\.json がある」で止まります/);
});
