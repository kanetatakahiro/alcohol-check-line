import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// TOT のスケジュールへの自動反映（gas/TotSync.gs・版 2026-11-13c）。すべて架空データ・模擬環境（LINE・TOT には送らない）
const U = (c) => 'U' + String(c).repeat(32).slice(0, 32);
const ADMIN = 'U' + 'a'.repeat(32);
const SECRET = 'fake-secret';
const KANRI = 'C' + 'k'.repeat(32), OTHER = 'C' + 'o'.repeat(32);
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'LeaveRequest.gs', 'Notices.gs', 'TotSync.gs'];
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日', '入社日'];
const row = (code, name, dept, tot) => ["'" + code, name, '', '在籍', dept, U(code.slice(-1)), '', '', true, true, '', '正社員', tot, '', ''];
const MASTER = [HEAD, row('90001', '試験 一郎', '法人カーケア', '001'), row('90002', '試験 二郎', '法人カーケア', '002'), row('90003', '試験 三郎', '法人カーケア', '')];
const TODAY = '2026-11-13';
const T = (d, hm) => `${d}T${hm}:00+09:00`;
const work = (k, d, o = {}) => ({ date: d, employeeKey: k, clockInSchedule: T(d, '09:00'), clockOutSchedule: T(d, '18:00'), workDayTypeName: '平日', workPlaceDivisionCode: '100', scheduleTypeName: '通常勤務', ...o });
const off = (k, d, code = 9, name = '公休') => ({ date: d, employeeKey: k, workDayTypeName: '平日', workPlaceDivisionCode: '100', scheduleTypeName: '全日休暇', holidaysObtained: { fulltimeHoliday: { code, name } } });
const SCHED = [
  work('k001', '2026-11-16'), work('k001', '2026-11-17'), off('k001', '2026-11-18'), work('k001', '2026-11-20'), off('k001', '2026-11-21'),
  work('k002', '2026-11-16'),
];

function setup(props = { TOT_WRITE: 'on' }, now = TODAY + 'T12:00:00+09:00') {
  const g = createGas({ files: FILES, now });
  const mf = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = mf.insertSheet('従業員マスタ');
  MASTER.forEach((r) => m.appendRow(r));
  mf.insertSheet('お知らせ停止').appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  const gs = mf.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [KANRI, '勤怠管理', '', '有効'], [OTHER, '法人カーケア', '', '有効']].forEach((r) => gs.appendRow(r));
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: mf.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN, TOT_SYNC_SECRET: SECRET,
    FORM_LIVE_FROM: '2026-10-20', ...props });
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today: TODAY, results: { employees: [{ key: 'k001', code: '001' }, { key: 'k002', code: '002' }], schedules: [{ date: 'x', dailySchedules: SCHED }] } }), updated: g.clock.now };
  g.line.members[KANRI] = { [U('b')]: '承認 花子', [U('c')]: '確認 次郎' };
  return { g, mf };
}
const submit = (g, a) => g.ctx.alcoholCheckOnAttendanceForm({ response: { getItemResponses: () => Object.entries({
  '入力者（あなたのお名前）': '上長 太郎', 対象者: '試験 一郎（90001）', '理由・連絡事項': '（理由）', ...a,
}).filter(([, v]) => v !== undefined).map(([t, v]) => ({ getItem: () => ({ getTitle: () => t }), getResponse: () => v })) } });
const post = (g, body) => g.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent();
const press = (g, data, { uid = U('b'), gid = KANRI, id = 'ev-' + Math.random() } = {}) => {
  const n = g.fetches.length;
  post(g, { events: [{ type: 'postback', webhookEventId: id, replyToken: 'rt', source: { type: 'group', groupId: gid, userId: uid }, postback: { data } }] });
  const r = g.fetches.slice(n).find((f) => f.url.endsWith('/reply'));
  return r ? r.body.messages[0].text : null;
};
const sheet = (mf) => mf.getSheetByName('TOT反映');
const cases = (g, mf) => sheet(mf).dump().slice(1).map((r, i) => ({ ...g.ctx.SCH_rowToCase(r, i + 1) }));
const pushes = (g, n = 0) => g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
const cardOf = (g) => pushes(g).map((f) => f.body.messages[0]).find((m) => m.type === 'flex' && /TOT反映の承認/.test(m.altText));
const btnData = (card, i) => card.contents.footer.contents[i].action.data;
const queue = (g, peek) => JSON.parse(post(g, { type: 'tot-write-queue', secret: SECRET, ...(peek ? { peek: true } : {}) }));

test('純粋関数：フォームの回答 → 反映の依頼（対象の区分・過ぎた日・期間・休みの変更）', () => {
  const X = setup().g.ctx;
  const r = { ...X.SCH_requestFromForm({ kind: '欠勤', from: '2026-11-17', until: '2026-11-16' }, TODAY) };
  assert.deepEqual({ ...r, days: [...r.days] }, { label: '欠勤', holiday: '3', swap: false, from: '2026-11-16', until: '2026-11-17', changeTo: '', days: ['2026-11-16', '2026-11-17'], reason: '' });
  assert.equal(X.SCH_requestFromForm({ kind: '有給休暇', from: '2026-11-16' }, TODAY).holiday, '1');
  const s = X.SCH_requestFromForm({ kind: '休みの変更（シフト交換など）', from: '2026-11-18', changeTo: '2026-11-20' }, TODAY);
  assert.deepEqual([s.swap, s.from, s.until, s.changeTo, [...s.days].join()], [true, '2026-11-18', '2026-11-18', '2026-11-20', '2026-11-18,2026-11-20']);
  assert.equal(X.SCH_requestFromForm({ kind: '休みの変更（シフト交換など）', from: '2026-11-18' }, TODAY), null);   // 変更後の日が無い
  for (const k of ['休日出勤', '打刻の修正', '遅刻', '早退', 'その他']) assert.equal(X.SCH_requestFromForm({ kind: k, from: '2026-11-16' }, TODAY), null, k);
  assert.equal(X.SCH_requestFromForm({ kind: '欠勤', from: '2026-11-12' }, TODAY).reason, 'past');
  assert.equal(X.SCH_requestFromForm({ kind: '欠勤', from: TODAY }, TODAY).reason, '');                      // 今日は打刻を VPS が確かめる
  assert.equal(X.SCH_requestFromForm({ kind: '欠勤', from: '2026-11-14', until: '2026-12-20' }, TODAY).reason, 'tooLong');
  assert.equal(X.SCH_requestFromForm({ kind: '休みの変更', from: '2026-11-18', changeTo: '2026-11-18' }, TODAY).reason, 'sameDay');
  assert.equal(X.SCH_nextId(['S-20261113-001', 'S-20261113-009', 'S-20261112-020'], TODAY), 'S-20261113-010');
  assert.deepEqual({ ...X.SCH_parsePostback('sch|1|approve|S-20261113-001|a1b2c3') }, { action: 'approve', id: 'S-20261113-001', token: 'a1b2c3' });
  for (const bad of ['inq|1|take|Q-20261113-001|a1b2c3', 'sch|1|delete|S-20261113-001|a1b2c3', 'sch|1|approve|S-1|a1b2c3', 'sch|1|approve|S-20261113-001|zzzzzz']) assert.equal(X.SCH_parsePostback(bad), null, bad);
});

test('純粋関数：状態は一方向（承認・反映しない・元に戻す、record は記録のみ）', () => {
  const X = setup().g.ctx, S = X.SCH_STATE;
  const d = (s, a, m = 'on') => { const r = X.SCH_decide(s, a, m); return [r.next, r.changed, r.reason]; };
  assert.deepEqual(d(S.wait, 'approve'), [S.queued, true, 'approved']);
  assert.deepEqual(d(S.wait, 'approve', 'record'), [S.recorded, true, 'recorded']);
  assert.deepEqual(d(S.wait, 'decline'), [S.declined, true, 'declined']);
  assert.deepEqual(d(S.done, 'undo'), [S.undoQueued, true, 'undo']);
  assert.deepEqual(d(S.done, 'undo', 'record'), [S.done, false, 'undoOff']);
  for (const s of [S.queued, S.sending, S.done, S.failed, S.declined, S.replaced, S.skip]) {
    assert.deepEqual(d(s, 'approve'), [s, false, 'already'], s);
    assert.deepEqual(d(s, 'decline'), [s, false, 'already'], s);
  }
  for (const s of [S.wait, S.queued, S.failed, S.undone, S.undoQueued]) assert.deepEqual(d(s, 'undo'), [s, false, 'already'], s);
});

test('純粋関数：反映する内容（予定）の説明と、入れ替えできない予定', () => {
  const X = setup().g.ctx;
  const by = Object.fromEntries(SCHED.filter((s) => s.employeeKey === 'k001').map((s) => [s.date, s]));
  const leave = X.SCH_preview(X.SCH_requestFromForm({ kind: '欠勤', from: '2026-11-16', until: '2026-11-19' }, TODAY), by);
  assert.equal(leave.ok, true);
  assert.deepEqual([...leave.lines], ['11/16（月）：9:00-18:00 の出勤 → 欠勤', '11/17（火）：9:00-18:00 の出勤 → 欠勤', '11/18（水）：休み（公休）のため変更しません', '11/19（木）：（予定がまだ読めていません）→ 欠勤']);
  const sw = X.SCH_preview(X.SCH_requestFromForm({ kind: '休みの変更', from: '2026-11-18', changeTo: '2026-11-20' }, TODAY), by);
  assert.deepEqual([sw.ok, ...sw.lines], [true, '11/18（水）：休み（公休） → 9:00-18:00 の出勤（11/20（金） の予定をそのまま）', '11/20（金）：9:00-18:00 の出勤 → 休み（公休）']);
  const ng = X.SCH_preview(X.SCH_requestFromForm({ kind: '休みの変更', from: '2026-11-16', changeTo: '2026-11-17' }, TODAY), by);   // 両方とも出勤
  assert.deepEqual([ng.ok, ng.reason], [false, 'cannotSwap']);
  const none = X.SCH_preview(X.SCH_requestFromForm({ kind: '有給休暇', from: '2026-11-18' }, TODAY), by);                           // 休みの日だけ
  assert.deepEqual([none.ok, none.reason], [false, 'noWork']);
});

test('フォーム送信 → 「TOT反映」に承認待ち・勤怠管理グループへ承認のカード。氏名・LINE ID・従業員識別キーをログに出さない', () => {
  const { g, mf } = setup();
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16', '終了日（何日か続くとき）': '2026-11-17' });
  const [c] = cases(g, mf);
  assert.equal(c.id, 'S-20261113-001');
  assert.deepEqual([c.state, c.code, c.name, c.label, c.from, c.until, c.changeTo, c.by], ['承認待ち', '90001', '試験 一郎', '欠勤', '2026-11-16', '2026-11-17', '', '上長 太郎']);
  assert.match(c.token, /^[a-f][0-9a-f]{5}$/);
  const card = cardOf(g);
  assert.ok(card, '承認のカード');
  assert.equal(pushes(g).find((f) => f.body.messages[0] === card || f.body.messages[0].type === 'flex').body.to, KANRI);
  assert.equal(btnData(card, 0), `sch|1|approve|${c.id}|${c.token}`);
  assert.equal(btnData(card, 1), `sch|1|decline|${c.id}|${c.token}`);
  const text = JSON.stringify(card);
  assert.match(text, /11\/16（月）：9:00-18:00 の出勤 → 欠勤/);
  assert.match(text, /承認すると、10分ほどで TOT のスケジュールに反映/);
  // 今までの報告（部門のグループ・勤怠管理グループ）は変わらない
  assert.ok(pushes(g).some((f) => f.body.to === OTHER && /【勤怠変更の報告】/.test(f.body.messages[0].text)));
  const log = g.logs.join('\n');
  for (const s of ['試験 一郎', U(1), 'k001', SECRET]) assert.ok(!log.includes(s), s);
});

test('フォーム送信：TOT_WRITE が未設定・対象外の区分・テスト期間なら何もしない／record はカードに「試験中」', () => {
  for (const [props, a] of [[{}, { 区分: '欠勤', '日付（開始日）': '2026-11-16' }], [{ TOT_WRITE: 'on' }, { 区分: '休日出勤', '日付（開始日）': '2026-11-16' }],
    [{ TOT_WRITE: 'on', FORM_LIVE_FROM: '2026-12-01' }, { 区分: '欠勤', '日付（開始日）': '2026-11-16' }]]) {
    const { g, mf } = setup(props);
    submit(g, a);
    assert.equal(sheet(mf), null, JSON.stringify(props));
    assert.equal(cardOf(g), undefined);
  }
  const { g } = setup({ TOT_WRITE: 'record' });
  submit(g, { 区分: '有給休暇', '日付（開始日）': '2026-11-16' });
  assert.match(JSON.stringify(cardOf(g)), /試験中：承認しても TOT には書き込みません/);
});

test('フォーム送信：過ぎた日・入れ替えできない予定・TOTコードが無い人は「対象外」（カードは送らず、短いお知らせ）', () => {
  const cases1 = [
    [{ 区分: '欠勤', '日付（開始日）': '2026-11-12' }, '過ぎた日が含まれるため'],
    [{ 区分: '休みの変更（シフト交換など）', '日付（開始日）': '2026-11-16', '変更後の休みの日（休みの変更のときだけ）': '2026-11-17' }, '入れ替えられる予定ではなかった'],
    [{ 対象者: '試験 三郎（90003）', 区分: '欠勤', '日付（開始日）': '2026-11-16' }, 'TOT従業員コードが無い'],
  ];
  for (const [a, why] of cases1) {
    const { g, mf } = setup();
    submit(g, a);
    const [c] = cases(g, mf);
    assert.equal(c.state, '対象外');
    assert.match(sheet(mf).dump()[1][18], new RegExp(why));
    assert.equal(cardOf(g), undefined);
    assert.ok(pushes(g).some((f) => f.body.to === KANRI && /TOT への自動反映の対象外/.test(f.body.messages[0].text) && new RegExp(why).test(f.body.messages[0].text)));
  }
});

test('ボタン：承認 → 反映待ち（承認者・LINE ID・日時を記録）。2回目・別の人・同じイベントの再送は進めない', () => {
  const { g, mf } = setup();
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  const card = cardOf(g);
  assert.match(press(g, btnData(card, 0), { id: 'e1' }), /試験 一郎さんの欠勤（11\/16（月））を承認しました（承認 花子さん）。10分ほどで TOT に反映/);
  let [c] = cases(g, mf);
  const v = sheet(mf).dump()[1];
  assert.deepEqual([c.state, c.approver, v[13]], ['反映待ち', '承認 花子', U('b')]);
  assert.ok(c.approvedAt instanceof g.FakeDate || c.approvedAt instanceof Date);
  assert.equal(press(g, btnData(card, 0), { id: 'e1' }), null);                                     // 同じイベントの再送：返事もしない
  assert.match(press(g, btnData(card, 1), { uid: U('c'), id: 'e2' }), /「反映待ち」です（承認 花子さん）/);   // あとから「反映しない」
  [c] = cases(g, mf);
  assert.equal(c.state, '反映待ち');
  const log = mf.getSheetByName('TOT反映の記録').dump().map((r) => r[2] + ' ' + r[3]);
  assert.ok(log.includes('approve approved（反映待ち）') && log.includes('decline already（反映待ち）'), log.join('\n'));
});

test('ボタン：勤怠管理グループ以外・メンバーでない人・合言葉の違い・TOT_WRITE が未設定は受け付けない', () => {
  const { g, mf } = setup();
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  const data = btnData(cardOf(g), 0);
  assert.equal(press(g, data, { gid: OTHER }), null);
  assert.match(press(g, data, { uid: U('d') }), /メンバーであることを確認できなかった/);
  assert.match(press(g, data.replace(/\|[0-9a-f]{6}$/, '|abcdef')), /このボタンは使えません/);
  g.scriptProps.deleteProperty('TOT_WRITE');
  assert.equal(press(g, data), null);
  assert.equal(cases(g, mf)[0].state, '承認待ち');
  // 問い合わせのボタン（inq|…）は今までどおり問い合わせへ（TOT反映は何もしない）
  g.scriptProps.setProperty('TOT_WRITE', 'on');
  assert.equal(press(g, 'inq|1|take|Q-20261113-001|abcdef'), null);
  assert.equal(cases(g, mf)[0].state, '承認待ち');
});

test('ボタン：反映しない／record の承認は記録のみ（VPS へは渡さない）', () => {
  const a = setup();
  submit(a.g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  assert.match(press(a.g, btnData(cardOf(a.g), 1)), /TOT に反映しないことにしました（承認 花子さん）/);
  assert.equal(cases(a.g, a.mf)[0].state, '反映しない');
  const b = setup({ TOT_WRITE: 'record' });
  submit(b.g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  assert.match(press(b.g, btnData(cardOf(b.g), 0)), /試験中のため TOT には書き込まず/);
  assert.equal(cases(b.g, b.mf)[0].state, '承認済み（記録のみ）');
  assert.deepEqual([...queue(b.g).items], []);
  assert.equal(queue(b.g).mode, 'record');
});

test('受け渡し：合言葉・反映中にする・peek は状態を変えない・30分たつともう一度渡す', () => {
  const { g, mf } = setup();
  submit(g, { 区分: '有給休暇', '日付（開始日）': '2026-11-16', '終了日（何日か続くとき）': '2026-11-18' });
  submit(g, { 区分: '休みの変更（シフト交換など）', '日付（開始日）': '2026-11-21', '変更後の休みの日（休みの変更のときだけ）': '2026-11-20' });
  const cards = pushes(g).map((f) => f.body.messages[0]).filter((m) => m.type === 'flex');
  cards.forEach((c) => press(g, btnData(c, 0)));
  assert.equal(post(g, { type: 'tot-write-queue', secret: 'wrong' }), 'NG');
  const pk = queue(g, true);
  assert.equal(pk.items.length, 2);
  assert.deepEqual(cases(g, mf).map((c) => c.state), ['反映待ち', '反映待ち']);
  const q = queue(g);
  assert.deepEqual(q.items.map((x) => ({ ...x, ...(x.dates ? { dates: [...x.dates] } : {}) })), [
    { id: 'S-20261113-001', op: 'apply', employeeKey: 'k001', note: 'LINE承認：S-20261113-001', kind: 'leave', holidayCode: '1', dates: ['2026-11-16', '2026-11-17', '2026-11-18'] },
    { id: 'S-20261113-002', op: 'apply', employeeKey: 'k001', note: 'LINE承認：S-20261113-002', kind: 'swap', from: '2026-11-21', to: '2026-11-20' },
  ]);
  assert.ok(!JSON.stringify(q).includes('試験 一郎'), '氏名は渡さない');
  assert.deepEqual(cases(g, mf).map((c) => c.state), ['反映中', '反映中']);
  assert.equal(queue(g).items.length, 0);                    // 2回目は渡さない
  g.clock.now += 31 * 60 * 1000;
  assert.equal(queue(g).items.length, 2);                    // 30分たっても結果が来なければ、もう一度渡す
});

test('結果：反映済み → 勤怠管理グループへ「元に戻す」ボタン付き。元に戻す → 元に戻し済み。2回目の結果は受け付けない', () => {
  const { g, mf } = setup();
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16', '終了日（何日か続くとき）': '2026-11-18' });
  press(g, btnData(cardOf(g), 0));
  queue(g);
  const before = { '2026-11-16': { clockInSchedule: T('2026-11-16', '09:00'), workDayTypeName: '平日' }, '2026-11-17': { clockInSchedule: T('2026-11-17', '09:00'), workDayTypeName: '平日' } };
  const n = g.fetches.length;
  assert.equal(post(g, { type: 'tot-write-result', secret: SECRET, id: 'S-20261113-001', op: 'apply', status: 'done', written: ['2026-11-16', '2026-11-17'], skipped: ['2026-11-18'], before }), 'OK');
  const msg = pushes(g, n)[0].body.messages[0];
  assert.equal(pushes(g, n)[0].body.to, KANRI);
  const body = JSON.stringify(msg);
  assert.match(body, /TOT のスケジュールに反映しました/);
  assert.match(body, /反映した日：11\/16（月）、11\/17（火）/);
  assert.match(body, /変更しなかった日：11\/18（水）（休み・予定なし）/);
  assert.match(body, /承認：承認 花子さん/);
  let [c] = cases(g, mf);
  assert.equal(c.state, '反映済み');
  assert.deepEqual(JSON.parse(JSON.stringify(c.beforeObj)), before);
  assert.equal(post(g, { type: 'tot-write-result', secret: SECRET, id: 'S-20261113-001', op: 'apply', status: 'failed', reason: 'api' }), 'NG state');
  // 元に戻す
  assert.match(press(g, msg.contents.footer.contents[0].action.data, { uid: U('c') }), /元に戻します（確認 次郎さん）/);
  assert.equal(cases(g, mf)[0].state, '元に戻す待ち');
  const q = queue(g);
  assert.deepEqual(JSON.parse(JSON.stringify(q.items)), [{ id: 'S-20261113-001', op: 'undo', employeeKey: 'k001', note: 'LINE承認：S-20261113-001', before }]);
  post(g, { type: 'tot-write-result', secret: SECRET, id: 'S-20261113-001', op: 'undo', status: 'done', written: ['2026-11-16', '2026-11-17'] });
  [c] = cases(g, mf);
  assert.equal(c.state, '元に戻し済み');
  assert.equal(sheet(mf).dump()[1][19], '確認 次郎');
  assert.match(pushes(g).at(-1).body.messages[0].text, /元に戻しました[\s\S]*操作：確認 次郎さん/);
});

test('結果：失敗（打刻あり・TOT のエラー）は理由と、本人のスケジュール申請のお願い', () => {
  const { g, mf } = setup();
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  press(g, btnData(cardOf(g), 0));
  queue(g);
  post(g, { type: 'tot-write-result', secret: SECRET, id: 'S-20261113-001', op: 'apply', status: 'failed', reason: 'punched' });
  const t = pushes(g).at(-1).body.messages[0].text;
  assert.match(t, /反映できませんでした\n試験 一郎さんの欠勤（11\/16（月））\n理由：その日に打刻があるため/);
  assert.match(t, /ご本人に、Touch On Time からのスケジュール申請をお願いします/);
  assert.equal(cases(g, mf)[0].state, '失敗');
  const X = g.ctx;
  assert.match(X.SCH_reasonText({ reason: 'api', errors: [{ code: 400, message: '架空のエラー' }] }), /TOT のエラーのため（code 400：架空のエラー）/);
});

test('置き換え：同じ人の日が重なる前の受付（承認待ち・反映待ち）は、あとの受付の承認で「置き換え」', () => {
  const { g, mf } = setup();
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16', '終了日（何日か続くとき）': '2026-11-17' });
  submit(g, { 区分: '有給休暇', '日付（開始日）': '2026-11-17' });
  submit(g, { 対象者: '試験 二郎（90002）', 区分: '欠勤', '日付（開始日）': '2026-11-16' });   // 別の人
  const cards = pushes(g).map((f) => f.body.messages[0]).filter((m) => m.type === 'flex');
  press(g, btnData(cards[0], 0));
  press(g, btnData(cards[1], 0));
  assert.deepEqual(cases(g, mf).map((c) => c.state), ['置き換え', '反映待ち', '承認待ち']);
  assert.match(sheet(mf).dump()[1][18], /置き換え：S-20261113-002/);
});

test('【勤怠の変更】：反映待ち・反映中・反映済みの連絡は送らない（synced）。承認待ち・失敗・反映しない・対象外は今までどおり', () => {
  const { g, mf } = setup();
  const FH = ['タイムスタンプ', '入力者（あなたのお名前）', '対象者', '区分', '日付（開始日）', '終了日（何日か続くとき）', '変更後の休みの日（休みの変更のときだけ）'];
  const fs = mf.insertSheet('フォームの回答 1');
  [FH, ['2026/11/13 9:00:00', '上長 太郎', '試験 一郎（90001）', '欠勤', '2026-11-16', '2026-11-17', ''],
    ['2026/11/13 9:01:00', '上長 太郎', '試験 一郎（90001）', '休みの変更（シフト交換など）', '2026-11-21', '', '2026-11-20'],
    ['2026/11/13 9:02:00', '上長 太郎', '試験 二郎（90002）', '欠勤', '2026-11-16', '', '']].forEach((r) => fs.appendRow(r));
  g.scriptProps.setProperty('ATTENDANCE_FORM_ID', 'fake-form');
  const sh = g.ctx.SCH_sheetOf_(mf, 'TOT反映', g.ctx.SCH_HEADER);
  const r = (id, state, code, label, from, until, to = '') => { const x = g.ctx.SCH_HEADER.map(() => ''); Object.assign(x, { 0: id, 1: state, 3: "'" + code, 5: label, 6: "'" + from, 7: "'" + until, 8: to ? "'" + to : '' }); return x; };
  sh.appendRow(r('S-20261113-001', '反映済み', '90001', '欠勤', '2026-11-16', '2026-11-17'));
  sh.appendRow(r('S-20261113-002', '反映中', '90001', '休みの変更', '2026-11-21', '2026-11-21', '2026-11-20'));
  sh.appendRow(r('S-20261113-003', '失敗', '90002', '欠勤', '2026-11-16', '2026-11-16'));
  g.ctx.AC_FORM_ENTRIES_CACHE = null;
  const f = g.ctx.AC_formEntries_();
  assert.equal(f.ok, true);
  assert.deepEqual([...f.byCode['90001'].map((e) => !!e.synced)], [true, true]);
  assert.deepEqual([...f.byCode['90002'].map((e) => !!e.synced)], [false]);
  const sp = g.ctx.AC_formSplit(['2026-11-16', '2026-11-20'], f.byCode['90001'], {}, '001');
  assert.deepEqual([...sp.groups.map((x) => x.skip)], [true, true]);
  assert.equal(g.ctx.AC_formSplit(['2026-11-16'], f.byCode['90002'], {}, '002').groups[0].skip, false);
});

test('見守り：反映待ちが3時間以上止まっていたら、中継の受け取りのときに管理者へ（1日1回）', () => {
  const { g } = setup();
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  press(g, btnData(cardOf(g), 0));
  assert.equal(g.ctx.SCH_watch_(), 0);
  g.clock.now += 3 * 60 * 60 * 1000;
  assert.equal(g.ctx.SCH_watch_(), 1);
  const toAdmin = pushes(g).filter((f) => f.body.to === ADMIN).map((f) => f.body.messages[0].text);
  assert.ok(toAdmin.some((t) => /TOT への反映が1件、3時間以上止まっています/.test(t)), toAdmin.join('\n'));
});

test('受け渡し：tot-latest.json が無いときは渡さずに待たせる（管理者へ）／従業員が見つからなければ失敗', () => {
  const { g, mf } = setup();
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  press(g, btnData(cardOf(g), 0));
  const saved = g.drive.files['tot-latest.json'];
  delete g.drive.files['tot-latest.json'];
  assert.equal(queue(g).items.length, 0);
  assert.equal(cases(g, mf)[0].state, '反映待ち');
  assert.ok(pushes(g).some((f) => f.body.to === ADMIN && /tot-latest\.json）が読めない/.test(f.body.messages[0].text)));
  g.drive.files['tot-latest.json'] = { ...saved, content: saved.content.replace('"code":"001"', '"code":"099"') };
  assert.equal(queue(g).items.length, 0);
  assert.equal(cases(g, mf)[0].state, '失敗');
  assert.match(pushes(g).at(-1).body.messages[0].text, /TOT の従業員が見つからないため/);
});

// ======================================================================
// 版 2026-11-13d：本人のスケジュール申請の承認・棄却／本人による承認の拒否／まとめと前日の再通知／本人へのお知らせ（ATT-11）
// ======================================================================
const RQ = (date, o = {}) => ({ type: 'schedules', date, requestedDate: '2026-11-12', employeeKey: 'k001', requestKey: 'rq-' + date, status: 'applying',
  message: '架空の申請メッセージ', requested: { clockInSchedule: '', clockOutSchedule: '', holidayName: '欠勤', holidayCode: '3', workDayTypeName: '平日', scheduleTypeName: '全日休暇' }, ...o });
const withRequests = (g, reqs) => {
  const f = g.drive.files['tot-latest.json'], d = JSON.parse(f.content);
  d.results.requests = reqs;
  g.drive.files['tot-latest.json'] = { ...f, content: JSON.stringify(d) };
};
const live = (props = {}) => setup({ TOT_WRITE: 'on', DRY_RUN: 'false', ...props });

test('13d 純粋関数：同じ人・同じ日の申請中のスケジュール申請だけを拾う（打刻申請・残業申請・ほかの人・ほかの日・承認済みは拾わない）', () => {
  const X = setup().g.ctx;
  const list = [RQ('2026-11-16'), RQ('2026-11-17', { status: 'approved' }), RQ('2026-11-18', { type: 'timerecords' }), RQ('2026-11-16', { type: 'overtimes', requestKey: 'x' }),
    RQ('2026-11-16', { employeeKey: 'k002', requestKey: 'y' }), RQ('2026-11-20'), { _error: 403 }];
  assert.deepEqual([...X.SCH_pendingRequests(list, 'k001', ['2026-11-16', '2026-11-17', '2026-11-18'])].map((q) => q.requestKey), ['rq-2026-11-16']);
  assert.equal(X.SCH_requestKind(RQ('2026-11-16')), '休み（欠勤）');
  assert.equal(X.SCH_requestKind({ requested: { clockInSchedule: T('2026-11-16', '10:00'), clockOutSchedule: T('2026-11-16', '19:00') } }), '10:00-19:00 の出勤');
  assert.equal(X.SCH_requestKind({}), '（内容は TOT でご確認ください）');
  const lines = [...X.SCH_requestLines([X.SCH_pendingRequests([RQ('2026-11-16')], 'k001', ['2026-11-16'])[0]])];
  assert.deepEqual(lines, ['■ ご本人のスケジュール申請（申請中）', '11/16（月）：休み（欠勤）（申請日 11/12）', '　申請メッセージ：架空の申請メッセージ',
    '※申請の承認・棄却は元に戻せません（「元に戻す」は TOT のスケジュールを書き換えたときだけ使えます）。']);
});

test('13d 純粋関数：本人へのお知らせの文（1日・何日か・休みの変更・棄却したとき）', () => {
  const X = setup().g.ctx;
  const c = { label: '欠勤', from: '2026-11-20', until: '2026-11-20', changeTo: '' };
  assert.equal(X.SCH_selfMessage(c, ['2026-11-20'], []), 'お疲れ様です😊\n11/20（金）は欠勤としてスケジュールを変更しました。\nTouch On Timeでの申請は不要です。\nご確認のほどよろしくお願いいたします！');
  assert.match(X.SCH_selfMessage({ ...c, label: '有給休暇', until: '2026-11-21' }, ['2026-11-20', '2026-11-21'], []), /11\/20（金）、11\/21（土）は有給休暇として/);
  const sw = X.SCH_selfMessage({ label: '休みの変更', from: '2026-11-12', until: '2026-11-12', changeTo: '2026-11-15' }, null, []);
  assert.match(sw, /^お疲れ様です😊\n11\/12（木）の休みを11\/15（日）に変更しました。\nTouch On Timeでの申請は不要です。/);
  assert.match(X.SCH_selfMessage(c, ['2026-11-20'], ['2026-11-20']), /変更しました。\n11\/20（金）のスケジュール申請は、勤怠変更フォームの内容で反映したため取り下げとしました。\nTouch On Timeでの申請は不要です。/);
});

test('13d カード：同じ日に本人の申請があれば、申請の内容と3つのボタン（申請を承認する・棄却して反映・反映しない）。無ければ今までどおり2つ', () => {
  const { g, mf } = setup();
  withRequests(g, [RQ('2026-11-16'), RQ('2026-11-17', { type: 'timerecords', requestKey: 'tr' })]);
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16', '終了日（何日か続くとき）': '2026-11-17' });
  const card = cardOf(g), [c] = cases(g, mf);
  assert.deepEqual(card.contents.footer.contents.map((b) => b.action.label), ['申請を承認する', '申請を棄却してフォームの内容で反映', '反映しない']);
  assert.deepEqual(card.contents.footer.contents.map((b) => b.action.data.split('|')[2]), ['reqok', 'reqng', 'decline']);
  const text = JSON.stringify(card);
  assert.match(text, /11\/16（月）：休み（欠勤）（申請日 11\/12）/);
  assert.match(text, /申請の承認・棄却は元に戻せません/);
  assert.ok(!text.includes('rq-') && !text.includes('11/17（火）：休み'), '打刻申請は出さない・申請識別キーは出さない');
  assert.deepEqual([...c.requests].map((q) => q.requestKey), ['rq-2026-11-16']);
  assert.ok(pushes(g).filter((f) => f.body.messages[0].type === 'flex').every((f) => f.body.to === KANRI), 'カードは勤怠管理グループだけ');
  // 申請のあるカードに「承認してTOTに反映」（古い形のボタン）は使えない
  assert.match(press(g, btnData(card, 0).replace('|reqok|', '|approve|')), /このボタンは使えません/);
  const b = setup();
  submit(b.g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  assert.deepEqual(cardOf(b.g).contents.footer.contents.map((x) => x.action.label), ['承認してTOTに反映', '反映しない']);
  assert.match(press(b.g, btnData(cardOf(b.g), 0).replace('|approve|', '|reqok|')), /このボタンは使えません/);
});

test('13d 申請を承認する：受け渡しに method=approve と申請。結果で本人の申請の承認を知らせ、「元に戻す」は出さない。本人へ1通', () => {
  const { g, mf } = live();
  withRequests(g, [RQ('2026-11-16')]);
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  assert.match(press(g, btnData(cardOf(g), 0)), /ご本人の申請を承認します（承認 花子さん）/);
  let [c] = cases(g, mf);
  assert.deepEqual([c.state, c.method], ['反映待ち', '申請を承認']);
  const item = queue(g).items[0];
  assert.deepEqual([item.method, JSON.parse(JSON.stringify(item.requests))], ['approve', [{ requestKey: 'rq-2026-11-16', date: '2026-11-16' }]]);
  const n = g.fetches.length;
  post(g, { type: 'tot-write-result', secret: SECRET, id: c.id, op: 'apply', method: 'approve', status: 'done', written: [], requestResults: [{ date: '2026-11-16', action: 'approved', status: 'approved' }] });
  const ps = pushes(g, n);
  const grp = ps.find((f) => f.body.to === KANRI).body.messages[0];
  assert.equal(grp.type, 'text');
  assert.match(grp.text, /ご本人のスケジュール申請を承認しました[\s\S]*対象の日：11\/16（月）[\s\S]*申請の承認は元に戻せません/);
  const self = ps.find((f) => f.body.to === U(1));
  assert.ok(self, '本人へ1通');
  assert.equal(self.body.messages[0].text, 'お疲れ様です😊\n11/16（月）は欠勤としてスケジュールを変更しました。\nTouch On Timeでの申請は不要です。\nご確認のほどよろしくお願いいたします！');
  [c] = cases(g, mf);
  assert.equal(c.state, '反映済み');
  const v = sheet(mf).dump()[1];
  assert.match(v[24], /2026-11-16：承認（approved）/);
  assert.match(v[25], /^送信済み：お疲れ様です/);
});

test('13d 申請を承認する：承認フローの次の段階が残る（まだ申請中）なら、本人へは送らない', () => {
  const { g, mf } = live();
  withRequests(g, [RQ('2026-11-16')]);
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  press(g, btnData(cardOf(g), 0));
  const id = queue(g).items[0].id, n = g.fetches.length;
  post(g, { type: 'tot-write-result', secret: SECRET, id, op: 'apply', method: 'approve', status: 'done', requestResults: [{ date: '2026-11-16', action: 'approved', status: 'applying' }] });
  assert.match(pushes(g, n)[0].body.messages[0].text, /次の段階があるため、11\/16（月）の申請はまだ申請中です/);
  assert.equal(pushes(g, n).some((f) => f.body.to === U(1)), false);
  assert.equal(sheet(mf).dump()[1][25], '');
});

test('13d 申請を棄却して反映：結果に棄却したことと「元に戻す」、本人へは取り下げの一文つき。申請がもう無ければ何もしない（本人へのお願いも書かない）', () => {
  const { g, mf } = live();
  withRequests(g, [RQ('2026-11-16')]);
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  assert.match(press(g, btnData(cardOf(g), 1)), /ご本人の申請を棄却して TOT に反映します/);
  const item = queue(g).items[0];
  assert.equal(item.method, 'reject');
  const n = g.fetches.length;
  post(g, { type: 'tot-write-result', secret: SECRET, id: item.id, op: 'apply', method: 'reject', status: 'done', written: ['2026-11-16'],
    before: { '2026-11-16': { clockInSchedule: T('2026-11-16', '09:00'), workDayTypeName: '平日' } }, requestResults: [{ date: '2026-11-16', action: 'rejected', status: 'rejected' }] });
  const grp = pushes(g, n).find((f) => f.body.to === KANRI).body.messages[0];
  assert.equal(grp.type, 'flex');
  assert.match(JSON.stringify(grp), /スケジュール申請（11\/16（月））は棄却しました（棄却は元に戻せません）/);
  assert.equal(grp.contents.footer.contents[0].action.label, '元に戻す');
  assert.match(pushes(g, n).find((f) => f.body.to === U(1)).body.messages[0].text, /取り下げとしました/);
  assert.equal(cases(g, mf)[0].state, '反映済み');
  // 申請がもう無い
  const b = live();
  withRequests(b.g, [RQ('2026-11-16')]);
  submit(b.g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  press(b.g, btnData(cardOf(b.g), 1));
  const id = queue(b.g).items[0].id, m = b.g.fetches.length;
  post(b.g, { type: 'tot-write-result', secret: SECRET, id, op: 'apply', method: 'reject', status: 'failed', reason: 'requestGone' });
  const t = pushes(b.g, m)[0].body.messages[0].text;
  assert.match(t, /すでに承認・棄却・取り下げされていたため、何もしませんでした/);
  assert.ok(!/ご本人に、Touch On Time/.test(t));
  assert.equal(pushes(b.g, m).some((f) => f.body.to === U(1)), false);
});

test('13d 本人のボタンは受け付けない（どのボタンも）。ほかのメンバーなら受け付ける', () => {
  const { g, mf } = setup();
  g.line.members[KANRI][U(1)] = '試験 一郎';
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  const card = cardOf(g);
  for (const i of [0, 1]) assert.equal(press(g, btnData(card, i), { uid: U(1) }), 'ご自身の分は、ほかの方が承認してください。');
  assert.equal(cases(g, mf)[0].state, '承認待ち');
  assert.ok(mf.getSheetByName('TOT反映の記録').dump().some((r) => r[3] === '拒否（ご本人）'));
  assert.match(press(g, btnData(card, 0)), /承認しました/);
  assert.match(JSON.stringify(card), /ご自身の分は、ほかの方が承認してください。/);
});

test('13d 本人へのお知らせ：record は送らず記録だけ／DRY_RUN・お知らせ設定でOFF・お知らせ停止中は送らない', () => {
  const a = setup({ TOT_WRITE: 'record' });
  submit(a.g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  press(a.g, btnData(cardOf(a.g), 0));
  assert.match(sheet(a.mf).dump()[1][25], /^記録のみ（TOT_WRITE=record）：お疲れ様です😊\n11\/16（月）は欠勤として/);
  assert.equal(pushes(a.g).some((f) => f.body.to === U(1)), false);
  const done = (g) => {
    submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
    press(g, btnData(cardOf(g), 0));
    const id = queue(g).items[0].id;
    post(g, { type: 'tot-write-result', secret: SECRET, id, op: 'apply', status: 'done', written: ['2026-11-16'], before: {} });
  };
  const b = setup({ TOT_WRITE: 'on' });                                   // DRY_RUN 未設定
  done(b.g);
  assert.match(sheet(b.mf).dump()[1][25], /^記録のみ（DRY_RUN）：/);
  assert.equal(pushes(b.g).some((f) => f.body.to === U(1)), false);
  const c = live();                                                        // 手で入れたお知らせ停止（今日を含む）
  c.mf.getSheetByName('お知らせ停止').appendRow(["'90001", '試験 一郎', '2026-11-10', '2026-11-20', '休み', '全部']);
  done(c.g);
  assert.match(sheet(c.mf).dump()[1][25], /^送らない（お知らせ停止中）：/);
  const d = live({ NOTICE_SETTINGS: 'on' });                               // お知らせ設定で ATT-11 を OFF
  d.g.ctx.alcoholCheckSetupNoticeSettings();
  const ns = d.mf.getSheetByName('お知らせ設定'), col = ns.dump()[0].indexOf('ATT-11 スケジュール変更のお知らせ（TOT反映）');
  assert.ok(col > 0);
  ns.getRange(2, col + 1).setValue(false);
  d.g.ctx.AC_NS_CACHE = null;
  done(d.g);
  assert.match(sheet(d.mf).dump()[1][25], /^送らない（お知らせ設定でOFF）：/);
  // フォームから入ったお知らせ停止（欠勤の日）は数えない（live の最初のテストで送れていることで確認済み）
});

test('13d まとめ（INQ_remind）：承認待ちの一覧を足す（0件なら足さない）。前日の15時台に承認待ちのカードをもう一度（1枚1回）', () => {
  const { g, mf } = setup({ TOT_WRITE: 'on' }, '2026-11-15T09:00:00+09:00');
  g.drive.files['tot-latest.json'] = { ...g.drive.files['tot-latest.json'] };
  g.ctx.INQ_remind();
  assert.equal(pushes(g).length, 0, 'シートが無い・0件なら何も送らない');
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-16' });
  submit(g, { 区分: '有給休暇', '日付（開始日）': '2026-11-20' });
  let n = g.fetches.length;
  g.ctx.INQ_remind();                                                      // 9時台：一覧だけ（再通知はまだ）
  let ps = pushes(g, n);
  assert.equal(ps.length, 1, JSON.stringify(ps.map((f) => [f.body.to, f.body.messages[0].text || f.body.messages[0].altText])));
  assert.equal(ps[0].body.to, KANRI);
  assert.equal(ps[0].body.messages[0].text, '【承認待ちの勤怠の変更 2件】\n・試験 一郎さん 11/16（月） 欠勤\n・試験 一郎さん 11/20（金） 有給休暇\n勤怠管理グループの承認のカードから、承認または「反映しない」を押してください。');
  g.clock.now = new Date('2026-11-15T15:00:00+09:00').getTime();
  n = g.fetches.length;
  g.ctx.INQ_remind();                                                      // 15時台：11/16 のカードだけもう一度
  ps = pushes(g, n);
  const again = ps.map((f) => f.body.messages[0]).filter((m) => m.type === 'flex');
  assert.equal(again.length, 1);
  assert.match(again[0].altText, /明日が対象の日です/);
  assert.match(JSON.stringify(again[0]), /11\/16（月）：9:00-18:00 の出勤 → 欠勤/);
  n = g.fetches.length;
  g.ctx.INQ_remind();                                                      // 2回目は送らない
  assert.equal(pushes(g, n).filter((f) => f.body.messages[0].type === 'flex').length, 0);
  assert.ok(sheet(mf).dump()[1][26]);
  // 承認されたら一覧から消える
  press(g, btnData(cardOf(g), 0));
  n = g.fetches.length;
  g.ctx.INQ_remind();
  assert.match(pushes(g, n)[0].body.messages[0].text, /【承認待ちの勤怠の変更 1件】\n・試験 一郎さん 11\/20（金） 有給休暇/);
  // TOT_WRITE が未設定なら足さない
  g.scriptProps.deleteProperty('TOT_WRITE');
  n = g.fetches.length;
  g.ctx.INQ_remind();
  assert.equal(pushes(g, n).length, 0);
});

test('13d シート：13c で作った「TOT反映」（22列）に、足した列の見出しを足す（今の値は変えない）', () => {
  const { g, mf } = setup();
  const sh = mf.insertSheet('TOT反映');
  sh.appendRow(g.ctx.SCH_HEADER.slice(0, 22));
  const old = g.ctx.SCH_HEADER.map(() => '').slice(0, 22);
  Object.assign(old, { 0: 'S-20261113-001', 1: '承認待ち', 3: "'90001", 4: '試験 一郎', 5: '欠勤', 6: "'2026-11-16", 7: "'2026-11-16", 11: "'abcdef" });
  sh.appendRow(old);
  const before = JSON.stringify(sh.dump()[1].slice(0, 22));
  submit(g, { 区分: '欠勤', '日付（開始日）': '2026-11-17' });
  const v = sh.dump();
  assert.deepEqual(v[0].slice(22), ['やり方', '本人の申請', '申請の結果', '本人へのお知らせ', '再通知日時']);
  assert.equal(JSON.stringify(v[1].slice(0, 22)), before);
  assert.equal(cases(g, mf)[0].method, '反映');                          // 空のやり方は「反映」として読む
});

test('13d お知らせ設定：今のシート（ATT-11 の列が無い）に、見出しと所属の初期値（ON）のチェックボックスを末尾に足す', () => {
  const { g, mf } = setup({ TOT_WRITE: 'on', NOTICE_SETTINGS: 'on' });
  g.ctx.alcoholCheckSetupNoticeSettings();
  for (const n of ['お知らせ設定', '所属別お知らせ設定']) {
    const sh = mf.getSheetByName(n);
    sh.rows.forEach((r) => { r.length = Math.min(r.length, sh.rows[0].length - 3); });   // 13c までの本番のシート（ATT-11 の列なし。13f の ATT-12・13 も無い）
  }
  assert.ok(!mf.getSheetByName('お知らせ設定').dump()[0].some((h) => /^ATT-11/.test(h)));
  g.ctx.AC_noticeSync_(mf, mf.getSheetByName('従業員マスタ').dump());
  g.ctx.alcoholCheckSetupNoticeSettings();
  for (const n of ['お知らせ設定', '所属別お知らせ設定']) {
    const v = mf.getSheetByName(n).dump(), j = v[0].indexOf('ATT-11 スケジュール変更のお知らせ（TOT反映）');
    assert.equal(j, v[0].length - 3, n);   // 末尾に ATT-11・ATT-12・ATT-13 の順
    assert.ok(v.slice(1).every((r) => r[j] === true), n);
    assert.equal(v[0].filter((h) => /^ATT-11/.test(h)).length, 1, n + '：2回目でも増えない');
  }
  g.ctx.AC_NS_CACHE = null;
  assert.equal(g.ctx.AC_noticeCheck_('ATT-11', '90001', TODAY).send, true);
});
