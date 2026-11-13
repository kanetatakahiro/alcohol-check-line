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
