import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 月末の勤怠の締め（gas/MonthClose.gs・版 2026-11-20i）。すべて架空データ・模擬環境（LINEには送らない）
const U = (c) => 'U' + String(c).repeat(32).slice(0, 32);
const ADMIN = 'U' + 'a'.repeat(32);
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'LeaveRequest.gs', 'Notices.gs', 'OfficeTask.gs', 'MonthClose.gs'];
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日', '入社日'];
const row = (code, name, dept, { userId = U(code.slice(-1)) } = {}) =>
  ["'" + code, name, '', '在籍', dept, userId, '', '', true, true, '', '正社員', code.slice(-3), '', ''];
const MASTER = [HEAD, row('90001', '試験 一郎', '法人カーケア'), row('90002', '試験 二郎', '法人カーケア'),
  row('90003', '試験 三郎', '法人カーケア'), row('90004', '試験 四郎', '管理本部'), row('90005', '試験 五郎', '法人カーケア', { userId: '' })];
const EMP = ['001', '002', '003', '004', '005', '006'].map((c) => ({ key: 'k' + c, code: c, lastName: '試験', firstName: c }));
const E = (k, date) => ({ employeeKey: k, date, isError: true, overtime: 0, lateNightOvertime: 0 });
const Q = (k, date, type, status) => ({ type, date, employeeKey: k, requestKey: k + date + type, status, requestedDate: date });
const MON = '2026-11-16';   // 月曜
const GROUP = 'C' + 'g'.repeat(32);
const TEMPLATE = '【管理本部からご連絡】\nお疲れ様です！\n{前月}分の勤怠・経費の締めのご案内です。\n\n■ {締め日}までにご対応ください\n・Touch On Timeの修正\n\n{打刻}\n\n■ 領収書は{必着日}必着\n【送付先】（架空）\n\n{お知らせ}\n\nご確認宜しくお願いいたします。';

// 一郎：11/2・11/9（却下）・11/10 が未申請。11/5（打刻申請・申請中）・11/6（スケジュール申請・承認済み）は外す。前月・当日は入らない
// 二郎：全部申請済み／三郎：ATT-02 OFF／四郎：お知らせ停止中／五郎：LINE未登録／006：従業員マスタに無い
function results(extra = {}) {
  return {
    employees: EMP,
    workings: [{ dailyWorkings: [
      E('k001', '2026-10-30'), E('k001', '2026-11-02'), E('k001', '2026-11-05'), E('k001', '2026-11-06'), E('k001', '2026-11-09'),
      E('k001', '2026-11-10'), E('k001', MON), { ...E('k001', '2026-11-11'), isError: false },
      E('k002', '2026-11-03'), E('k002', '2026-11-04'),
      E('k003', '2026-11-11'), E('k004', '2026-11-12'), E('k005', '2026-11-12'), E('k006', '2026-11-12'),
    ] }],
    requests: [
      Q('k001', '2026-11-05', 'timerecords', 'applying'), Q('k001', '2026-11-06', 'schedules', 'approved'),
      Q('k001', '2026-11-09', 'timerecords', 'rejected'), Q('k001', '2026-11-10', 'overtimes', 'approved'),   // 却下・残業申請は外さない
      Q('k002', '2026-11-03', 'timerecords', 'approved'), Q('k002', '2026-11-04', 'schedules', 'applying'),
    ],
    ...extra,
  };
}

function setup(props = {}, now = MON + 'T10:00:00+09:00') {
  const g = createGas({ files: FILES, now });
  const mf = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = mf.insertSheet('従業員マスタ');
  MASTER.forEach((r) => m.appendRow(r));
  mf.insertSheet('お知らせ停止').appendRow(['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']);
  mf.getSheetByName('お知らせ停止').appendRow(["'90004", '試験 四郎', '2026-11-14', '2026-11-20', '休み', '全部']);
  mf.insertSheet('LINEグループ').appendRow(['グループID', '部門（所属）', '登録日時', '状態']);
  mf.getSheetByName('LINEグループ').appendRow([GROUP, '勤怠管理', '', '有効']);
  const book = g.newSpreadsheet('【テスト】業務一覧（架空）');
  const tab = book.insertSheet('毎月1日の案内');
  [['項目', '内容', '説明'], ['今月のお知らせ', '年末調整の書類は11月中旬までです。', ''], ['本人の締め日（翌月◯日）', 3, ''], ['領収書の必着日（翌月◯日）', 5, ''],
    ['案内の文（ひな形）', TEMPLATE, ''], ['打刻漏れが無い人に届く文（見本・自動）', '', ''], ['いつの案内か（自動）', '', '']].forEach((r) => tab.appendRow(r));
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: mf.getId(), OFFICE_TASK_BOOK_ID: book.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN,
    DRY_RUN: 'false', NOTICE_SETTINGS: 'on', ...props });
  g.ctx.alcoholCheckSetupNoticeSettings();
  const sh = mf.getSheetByName('お知らせ設定');
  const v = sh.getDataRange().getValues();
  const col = v[0].findIndex((h) => String(h).startsWith('ATT-02 ')), r = v.findIndex((x) => String(x[0]) === '90003');
  sh.getRange(r + 1, col + 1).setValue(false);
  g.ctx.AC_NS_CACHE = null;
  return { g, mf, tab };
}
const save = (g, today = MON, res = results()) => {
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ type: 'tot-raw', mode: 'morning', today, fetchedAt: today + 'T07:05:05+09:00', results: res }),
    updated: new Date(today + 'T07:05:10+09:00').getTime() };
};
const run = (g) => {
  const n = g.fetches.length;
  const c = g.ctx.alcoholCheckWeeklyPunchReminder();
  return { c, push: g.fetches.slice(n).filter((f) => f.url.endsWith('/push')) };
};
const toSelf = (list) => list.filter((f) => f.body.to !== ADMIN);
const NOTE = '\n\n※このメッセージはAIによる自動送信です。';   // 版 2026-11-16a：本人へ送る文の最後（記録の文面には入らない）
const text = (f) => f.body.messages[0].text;

test('月末の締め: 日にちの判定（1日＝案内・3日＝締め日・4〜10日＝締め確定）と日付（領収書の必着日は土日なら次の平日）', () => {
  const { g } = setup();
  const X = g.ctx, P = (d) => { const p = X.MC_phase(d); return [p.kind, p.month]; };
  assert.deepEqual(P('2026-12-01'), ['notice', '2026-11']);
  assert.deepEqual(P('2026-12-02'), [null, '']);
  assert.deepEqual(P('2026-12-03'), ['deadline', '2026-11']);
  assert.deepEqual(P('2026-12-04'), ['final', '2026-11']);
  assert.deepEqual(P('2026-12-10'), ['final', '2026-11']);
  assert.deepEqual(P('2026-11-30'), [null, '']);
  assert.deepEqual(P('2027-01-01'), ['notice', '2026-12']);
  const d = X.MC_dates('2026-11', { closeDay: 3, receiptDay: 5 }, []);
  assert.deepEqual({ ...d }, { close: '2026-12-03', receipt: '2026-12-07' });          // 12/5 は土曜 → 12/7（月）
  assert.equal(X.MC_dates('2026-12', { closeDay: 3, receiptDay: 5 }, []).receipt, '2027-01-05');
  const t = X.MC_render(TEMPLATE, '2026-11', d, '', '');
  assert.match(t, /^【管理本部からご連絡】\nお疲れ様です！\n11月分の勤怠・経費の締めのご案内です。\n\n■ 12月3日（木）までにご対応ください\n・Touch On Timeの修正\n\n■ 領収書は12月7日（月）必着\n【送付先】（架空）\n\nご確認宜しくお願いいたします。$/);   // 空の段落は詰める
});

test('月末の締め: 毎朝、打刻漏れが無い人に届く文（見本）を作り直す（次の1日の分・1〜3日は今月1日の分）', () => {
  const { g, tab } = setup({ MONTH_CLOSE_NOTIFY: 'on' }, '2026-11-20T08:10:00+09:00');
  g.ctx.monthCloseDaily();
  const v = tab.dump();
  assert.match(String(v[5][1]), /^【管理本部からご連絡】[\s\S]*11月分の[\s\S]*12月3日（木）までに[\s\S]*12月7日（月）必着[\s\S]*年末調整の書類は11月中旬までです。[\s\S]*ご確認宜しく/);
  assert.ok(!/申請が確認できていない/.test(String(v[5][1])));                              // 見本には打刻の段落は入らない
  assert.equal(v[6][1], '12月1日（火）の案内（11月分）');
  g.clock.now = new Date('2026-12-02T08:10:00+09:00').getTime();
  g.ctx.monthCloseDaily();
  assert.equal(tab.dump()[6][1], '12月1日（火）の案内（11月分）');
  g.clock.now = new Date('2026-12-04T08:10:00+09:00').getTime();
  g.ctx.monthCloseDaily();
  assert.equal(tab.dump()[6][1], '1月1日（金）の案内（12月分）');
});

test('月末の締め: 1日は全員へ案内（打刻漏れのある人は申請していない日を入れる・無い人は打刻の段落を除く・1人1通・同じ月は1回）。タブが無ければ送らず管理者へ', () => {
  const { g } = setup({ MONTH_CLOSE_NOTIFY: 'on' }, '2026-12-01T09:10:00+09:00');
  save(g, '2026-12-01');
  let n = g.fetches.length;
  assert.equal(g.ctx.monthCloseDaily(), null);                                                   // 1日はグループへ送らない
  g.ctx.monthClosePersonal();
  const p = toSelf(g.fetches.slice(n).filter((f) => f.url.endsWith('/push')));
  assert.deepEqual(p.map((f) => f.body.to).sort(), [U(1), U(2), U(3), U(4)]);              // 全員（五郎はLINE未登録）。1人1通
  const m1 = text(p.find((f) => f.body.to === U(1)));
  const m2 = text(p.find((f) => f.body.to === U(2)));                                          // 二郎は全部申請済み → 打刻の段落なし
  assert.match(m2, /^【管理本部からご連絡】[\s\S]*12月3日（木）までに[\s\S]*12月7日（月）必着[\s\S]*年末調整/);
  assert.ok(!/申請が確認できていない/.test(m2));
  assert.ok(!/申請が確認できていない/.test(text(p.find((f) => f.body.to === U(3)))));             // 三郎は打刻のお知らせが OFF → 案内だけ
  assert.match(m1, /^【管理本部からご連絡】[\s\S]*12月3日（木）までに[\s\S]*【申請が確認できていない打刻（11月分）】\n・11\/2（月）\n・11\/9（月）[\s\S]*・11\/16（月）\n→ [\s\S]*12月7日（月）必着[\s\S]*年末調整の書類は11月中旬までです。/);
  assert.ok(!/10\/30|11\/5（|11\/6（/.test(m1));                                       // 前の月・申請済みの日は入らない
  assert.equal(g.fetches.slice(n).filter((f) => f.body && f.body.to === GROUP).length, 0);
  n = g.fetches.length;
  g.ctx.monthClosePersonal();
  assert.equal(toSelf(g.fetches.slice(n).filter((f) => f.url.endsWith('/push'))).length, 0);   // 2回目は送らない
  const s2 = setup({ MONTH_CLOSE_NOTIFY: 'on' }, '2026-12-01T09:10:00+09:00');
  s2.tab.getRange(5, 2).setValue('');                                                           // ひな形が空
  save(s2.g, '2026-12-01');
  n = s2.g.fetches.length;
  s2.g.ctx.monthClosePersonal();
  const after = s2.g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
  assert.ok(after.every((f) => f.body.to === ADMIN || f.body.to === GROUP));
  assert.match(after.map(text).join('\n'), /1日の締めの案内を送れませんでした[\s\S]*ひな形/);
});

test('月末の締め: 3日の朝は、まだ申請していない本人へ締め日のお願い（申請していない日を書く・今月の日は入らない）', () => {
  const { g } = setup({ MONTH_CLOSE_NOTIFY: 'on' }, '2026-12-03T09:10:00+09:00');
  const r = results(); r.requests.push(Q('k001', '2026-11-02', 'timerecords', 'applying')); r.workings[0].dailyWorkings.push(E('k001', '2026-12-01'));
  save(g, '2026-12-03', r);
  const n = g.fetches.length;
  g.ctx.monthClosePersonal();
  const p = toSelf(g.fetches.slice(n).filter((f) => f.url.endsWith('/push')));
  assert.deepEqual(p.map((f) => f.body.to).sort(), [U(1), U(4)]);
  const m1 = text(p.find((f) => f.body.to === U(1)));
  assert.match(m1, /^お疲れ様です😊\n【本日12月3日（木）は、11月分の締め日です】\n\n【申請が確認できていない打刻（11月分）】\n・11\/9（月）[\s\S]*本日中のご対応をお願いいたします🙏/);
  assert.ok(!/11\/2（|12\/1（|交通費/.test(m1));
  const X = g.ctx, d = X.MC_dates('2026-11', { closeDay: 3, receiptDay: 5 }, []);
  assert.match(X.MC_deadlineMessage('2026-11', d, '', true, null, ''), /【交通費の申請】\n11月分の交通費申請がまだ届いていません。\n本日中に、申請書の写真をこちらのLINEへ送ってください。/);
});

test('月末の締め: 4日8時に勤怠管理グループへ「勤怠の締め確定」を単独で（1回だけ・土日祝なら次の平日）。0件なら完了', () => {
  const { g } = setup({ MONTH_CLOSE_NOTIFY: 'on', ADMIN_NOTIFY: 'digest' }, '2026-12-04T08:10:00+09:00');
  const r = results(); r.workings[0].dailyWorkings.push(E('k001', '2026-12-01'));
  save(g, '2026-12-04', r);
  let n = g.fetches.length;
  const t = g.ctx.monthCloseDaily();
  assert.match(t, /^【勤怠の締め確定】11月分（本人の締め日 12\/3 を過ぎて残っている分）\n\n① 申請していない打刻漏れ：\d+件[\s\S]*試験 一郎：11\/2、11\/9、11\/10、11\/16[\s\S]*② 承認待ちの申請：2件[\s\S]*残っている方の上長へ、ご連絡をお願いします🙏$/);
  assert.ok(!/12\/1|③/.test(t));
  const gp = g.fetches.slice(n).filter((f) => f.body && f.body.to === GROUP);
  assert.equal(gp.length, 1); assert.equal(gp[0].body.messages[0].text, t);                  // 朝のまとめを待たずに単独で
  assert.equal(g.ctx.AC_digestItems_().length, 0);
  g.clock.now = new Date('2026-12-07T08:10:00+09:00').getTime();
  save(g, '2026-12-07', r);
  assert.equal(g.ctx.monthCloseDaily(), null);                                                   // 1回だけ
  const w = setup({ MONTH_CLOSE_NOTIFY: 'on' }, '2027-09-04T08:10:00+09:00');                   // 2027/9/4 は土曜
  save(w.g, '2027-09-04', { employees: EMP, workings: [{ dailyWorkings: [E('k002', '2027-08-10')] }], requests: [] });
  assert.equal(w.g.ctx.monthCloseDaily(), null);
  w.g.clock.now = new Date('2027-09-06T08:10:00+09:00').getTime();
  save(w.g, '2027-09-06', { employees: EMP, workings: [{ dailyWorkings: [E('k002', '2027-08-10')] }], requests: [] });
  assert.match(w.g.ctx.monthCloseDaily(), /8月分[\s\S]*試験 二郎：8\/10/);
  const X = g.ctx, d = X.MC_dates('2026-11', { closeDay: 3, receiptDay: 5 }, []), empty = { ok: true, punch: {}, pend: [] };
  assert.match(X.MC_finalText('2026-11', d, empty, () => '', []), /^【勤怠の締め確定】11月分の締めが完了しました✨/);
  assert.match(X.MC_finalText('2026-11', d, empty, () => '', ['試験 一郎']), /③ 交通費申請が届いていない人：1人\n・試験 一郎[\s\S]*上長へ/);
});

test('月末の締め: 未設定は何もしない・今朝のデータが無ければ管理者へ', () => {
  const off = setup({}, '2026-12-01T09:10:00+09:00'); save(off.g, '2026-12-01');
  const n = off.g.fetches.length;
  assert.equal(off.g.ctx.monthClosePersonal(), null);
  assert.equal(off.g.ctx.monthCloseDaily(), null);
  assert.equal(off.g.fetches.length, n);
  const s = setup({ MONTH_CLOSE_NOTIFY: 'on' }, '2026-12-04T08:10:00+09:00');
  assert.equal(s.g.ctx.monthCloseDaily(), null);
});
