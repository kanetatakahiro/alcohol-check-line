import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 事務の業務一覧LINE（gas/OfficeTask.gs・版 2026-11-17d：全員あて・平日のみ・12時のお知らせ）。すべて架空の社員番号・LINE ID・模擬環境（LINE には送らない）
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const ADMIN = U(7), STAFF = U(1), OTHER = U(2), STRANGER = U(3), KINTAI = 'C' + 'a'.repeat(32), OFFICE = 'C' + 'b'.repeat(32);
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
    ["'90002", '見本 二郎', '', '在籍', '法人カーケア', OTHER, '', '', true, false, '', '', '0902', '']].forEach((r) => m.appendRow(r));
  master.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [KINTAI, '勤怠管理', '2026-10-15', '有効'], [OFFICE, '事務業務', '2026-11-17', '有効']]
    .forEach((r) => master.getSheetByName('LINEグループ').appendRow(r));
  g.line.members[OFFICE] = { [STAFF]: 'はなこ', [OTHER]: 'じろう', [ADMIN]: 'まゆ' };
  const book = g.newSpreadsheet('【テスト】業務一覧（架空）');
  const s = book.insertSheet('業務マニュアル');
  [MH, task('D01', '朝の確認', 15, false), task('D03', 'スキャン', 20, true), task('W01', '領収書', 30, true), task('M01', '交通費の確認', 60, false),
    task('M02', '勤怠締め', 60, false), task('M03', '社労士へ送る', 30, false), task('M07', '在庫確認', 30, true), task('E01', '印鑑証明書', 120, false),
    task('D05', '電話・来客', 20, false), task('A01', '前倒し', 30, true), task('M06', '支払予定', 40, false, '×')].forEach((r) => s.appendRow(r));
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: master.getId(), INQ_MODE: 'off', LINE_CHANNEL_ACCESS_TOKEN: 'fake', LINE_ADMIN_USER_ID: ADMIN, DRY_RUN: 'false',
    OFFICE_TASK_BOOK_ID: book.getId(), ...props });
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
const pb = (userId, data, id, group = OFFICE) => ({ type: 'postback', webhookEventId: id, replyToken: 'rt-' + id, source: { type: 'group', groupId: group, userId }, postback: { data } });
const msg = (userId, text, id, group = OFFICE) => ({ type: 'message', webhookEventId: id, replyToken: 'rt-' + id, source: { type: 'group', groupId: group, userId }, message: { id: 'm' + id, type: 'text', text } });
const post = (g, ...events) => g.ctx.doPost({ postData: { contents: JSON.stringify({ destination: 'x', events }) } });
const btnData = (bubble, label) => bubble.footer.contents.find((b) => b.action.label === label).action.data;
const logOps = (book) => book.getSheetByName('今日の仕事の記録').dump().slice(1).map((r) => [r[5], r[6]]);

test('事務の業務一覧: 予定ルールと期間（月末から翌月にまたがる期間・週・年）・勤務時間・問い合わせの言葉', () => {
  const { g } = setup();
  const X = g.ctx;
  const ms = X.OT_periods(X.OT_parseRule('monthly:-2~3'), '2026-11-30');
  assert.deepEqual(JSON.parse(JSON.stringify(ms.map((p) => [p.key, p.start, p.end]))), [['M2026-10', '2026-09-28', '2026-10-03'], ['M2026-11', '2026-10-29', '2026-11-03'], ['M2026-12', '2026-11-28', '2026-12-03']]);
  assert.equal(X.OT_periods(X.OT_parseRule('weekly:5'), '2026-11-17')[1].start, '2026-11-20');
  const ys = X.OT_periods(X.OT_parseRule('yearly:11/1~12/20'), '2026-11-17');
  assert.deepEqual([ys[1].start, ys[1].end], ['2026-11-01', '2026-12-20']);
  assert.equal(X.OT_parseRule('なにか'), null);
  const sh = X.OT_shift({ clockInSchedule: '2026-11-17T09:00:00+09:00', clockOutSchedule: '2026-11-17T15:00:00+09:00' });
  assert.deepEqual([sh.minutes, sh.label], [360, '9:00〜15:00']);
  assert.equal(X.OT_shift({ clockInSchedule: '2026-11-17T08:00:00+09:00', clockOutSchedule: '2026-11-17T17:00:00+09:00' }).minutes, 480);
  assert.equal(X.OT_shift({}), null);
  ['残りの業務', '未完了の業務を教えて', 'まだ終わってない仕事は？', '今日の業務', '残っているタスク教えて'].forEach((t) => assert.ok(X.OT_isRemainingQuery(t), t));
  ['お疲れさまです', '残り時間わずか', '業務連絡です。明日の会議は10時からです。よろしくお願いします。皆さんの出席をお願いします'].forEach((t) => assert.ok(!X.OT_isRemainingQuery(t), t));
});

test('事務の業務一覧: 予定づくり（任せる○だけ・AI化済みは出さない・期限順・勤務時間の8割・入りきらない分は手が空いたとき）', () => {
  const { g, book } = setup();
  const X = g.ctx;
  // M07 を AI化済みにすると出ない
  const ms = book.getSheetByName('業務マニュアル'), h = ms.dump()[0], r11 = ms.dump().findIndex((r) => r[0] === 'M07') + 1;
  const tasks0 = X.OT_tasks_(X.OT_book_());
  assert.ok(!tasks0.some((t) => t.id === 'M06'));                                      // 任せる×は出さない
  const p = X.OT_plan(tasks0, '2026-12-01', 360, {}, []);
  assert.equal(p.reserve, 20);
  assert.equal(p.today[0].id, 'D01');                                                   // 朝の確認が最初
  assert.deepEqual(JSON.parse(JSON.stringify(p.today.map((t) => t.id).sort())), ['D01', 'D03', 'M01', 'M02', 'M07', 'W01']);   // W01 は先週金曜の分（記録なし＝過ぎた扱い）
  assert.ok(p.total <= p.budget);
  assert.ok(p.extra.some((t) => t.id === 'W01' && t.early));
  ms.getRange(r11, h.indexOf('AI化の状況') + 1).setValue('AI化済み');
  assert.ok(!X.OT_tasks_(X.OT_book_()).some((t) => t.id === 'M07'));
  const tasks = X.OT_tasks_(X.OT_book_());
  const short = X.OT_plan(tasks, '2026-12-03', 120, {}, []);
  assert.ok(short.today.some((t) => t.id === 'M01') && short.today.some((t) => t.id === 'M02'));
  const late = X.OT_plan(tasks, '2026-12-07', 360, { 'M01|M2026-12': true }, []);
  assert.ok(!late.today.some((t) => t.id === 'M01'));
  assert.deepEqual([late.today[0].id, late.today[1].id], ['D01', 'D03']);                // 毎日の仕事（D）が先・番号順
  assert.equal(late.today[2].id, 'M02'); assert.ok(late.today[2].overdue);              // その次に期限を過ぎたもの
  const r = X.OT_plan(tasks, '2026-12-07', 360, {}, [{ row: 2, id: 'E01', name: '', due: '2026-12-08', memo: '2通' }]);
  const it = r.today.find((t) => t.id === 'E01');
  assert.equal(it.period, 'R2'); assert.equal(it.memo, '2通');                         // 臨時の依頼は必ず入る
});

test('事務の業務一覧: 毎朝の送信（事務業務のグループ・ボタン付き）、勤怠管理グループには送らない、record・未設定', () => {
  const { g, book } = setup();
  let n = g.fetches.length;
  g.ctx.OT_morning();
  const p = pushes(g, n);
  assert.deepEqual(p.map((x) => x.body.to), [OFFICE]);
  const car = p[0].body.messages[0].contents;
  assert.match(car.contents[0].body.contents.map((c) => c.text || '').join('\n'), /管理本部のみなさん、今日のお仕事です[\s\S]*対応します[\s\S]*残りの業務[\s\S]*12時/);
  assert.equal(car.contents[1].body.contents[0].text, '1. 朝の確認');
  assert.deepEqual(car.contents[1].footer.contents.map((b) => b.action.label), ['完了', '対応します', '詳細を確認', '今日はできない']);
  assert.match(book.getSheetByName('送る予定の内容').dump()[1][5], /朝の確認/);
  const r = setup({ OFFICE_TASK_MODE: 'record' });
  n = r.g.fetches.length; r.g.ctx.OT_morning();
  assert.equal(pushes(r.g, n).length, 0);
  assert.match(r.book.getSheetByName('送る予定の内容').dump()[1][5], /^【記録のみ】/);
  const o = setup({ OFFICE_TASK_MODE: '' });
  n = o.g.fetches.length; o.g.ctx.OT_morning();
  assert.equal(pushes(o.g, n).length, 0);
});

test('事務の業務一覧: 土日祝は朝に送らない・「今日の業務を教えて」で一覧を返信（だれか1人あてにしない）・祝日の計算', () => {
  const X = setup().g.ctx;
  ['2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-06', '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23',
    '2026-10-12', '2026-11-03', '2026-11-23', '2027-03-21', '2027-03-22'].forEach((d) => assert.ok(!X.OT_isBusinessDay(d, []), d));   // 5/6・3/22 は振替休日、9/22 は国民の休日
  ['2026-11-17', '2026-11-24', '2026-05-07', '2026-12-28'].forEach((d) => assert.ok(X.OT_isBusinessDay(d, []), d));
  assert.ok(!X.OT_isBusinessDay('2026-12-28', ['12/28'])); assert.ok(!X.OT_isBusinessDay('2026-12-29', ['2026-12-29']));
  assert.ok(X.OT_isFirstBusinessDayOfWeek('2026-11-24', []));                         // 11/23（月）が祝日 → 火曜にまとめ
  assert.ok(!X.OT_isFirstBusinessDayOfWeek('2026-11-25', []));
  const w = setup({ OFFICE_TASK_MODE: 'on' }, '2026-11-21T08:00:00+09:00');            // 土曜
  let n = w.g.fetches.length; w.g.ctx.OT_morning();
  assert.equal(pushes(w.g, n).length, 0);
  n = w.g.fetches.length;
  post(w.g, msg(OTHER, '今日の業務を教えて', 's1'));
  const r = replies(w.g, n)[0].body.messages[0];
  assert.equal(r.type, 'flex');
  assert.match(r.contents.contents[0].body.contents.map((c) => c.text || '').join('\n'), /お休みの日ですが/);
  assert.ok(!/試験さん|見本さん/.test(JSON.stringify(r.contents.contents[0])));
  n = w.g.fetches.length;
  post(w.g, pb(OTHER, btnData(r.contents.contents[1], '完了'), 's2'));                    // そのボタンも使える
  assert.match(replies(w.g, n)[0].body.messages[0].text, /完了にしました/);
  n = w.g.fetches.length;
  w.g.clock.now = new Date('2026-11-21T12:05:00+09:00').getTime(); w.g.ctx.OT_tick();   // 頼まれて作った日は12時に送らない
  assert.equal(pushes(w.g, n).length, 0);
  const h = setup({ OFFICE_TASK_MODE: 'on' }, '2026-11-23T08:00:00+09:00');            // 祝日（勤労感謝の日）
  n = h.g.fetches.length; h.g.ctx.OT_morning();
  assert.equal(pushes(h.g, n).length, 0);
});

test('事務の業務一覧: ボタン（誰でも押せる・押した人を記録・対応します・完了の取り消し）', () => {
  const { g, book } = setup();
  g.ctx.OT_morning();
  const car = pushes(g, 0)[0].body.messages[0].contents.contents;
  const byName = (n) => car.find((b) => b.body && b.body.contents[0].text.includes(n));
  const first = byName('朝の確認'), second = byName('社労士へ送る');
  let n = g.fetches.length;
  post(g, pb(STRANGER, btnData(first, '完了'), 'e1'));                                   // グループのメンバーでない
  assert.match(replies(g, n)[0].body.messages[0].text, /押した方を確認できなかった/);
  n = g.fetches.length;
  post(g, pb(OTHER, btnData(second, '対応します'), 'e2'));                               // ほかの従業員が担当に
  assert.match(replies(g, n)[0].body.messages[0].text, /「社労士へ送る」は見本さんの担当にしました/);
  n = g.fetches.length;
  post(g, pb(STAFF, btnData(first, '完了'), 'e3'));
  const rp = replies(g, n)[0].body.messages;
  assert.match(rp[0].text, /試験さん、ありがとうございます！「朝の確認」を完了にしました[\s\S]*「取り消し 朝の確認」と送って/);
  assert.ok(!/次は/.test(rp[0].text));                                                     // 版 20a：次の仕事は勧めない
  assert.match(rp[1].text, /【まだ終わっていないお仕事】/); assert.equal(rp[2].type, 'flex');   // 「残りの業務」と同じ一覧
  assert.ok(!JSON.stringify(rp).includes('取り消す'));                                       // 取り消しのボタンは出さない
  post(g, pb(STAFF, btnData(first, '完了'), 'e3'));                                      // 同じイベントは1回だけ
  n = g.fetches.length;
  post(g, pb(OTHER, btnData(first, '完了'), 'e4'));                                      // 2回目の完了
  assert.match(replies(g, n)[0].body.messages[0].text, /試験さんが完了にしています/);
  n = g.fetches.length;
  post(g, msg(OTHER, '取り消し', 'e5a'));                                                  // 言葉なし → 今日の完了の一覧と使い方
  assert.match(replies(g, n)[0].body.messages[0].text, /今日完了にしたお仕事：\n・朝の確認（試験さん）[\s\S]*「取り消し 領収書」のように/);
  n = g.fetches.length;
  post(g, msg(OTHER, '取り消し 朝の確認', 'e5'));                                          // 取り消しは完了にした人か管理者だけ
  assert.match(replies(g, n)[0].body.messages[0].text, /取り消せるのは、完了にした試験さんと管理者だけ/);
  n = g.fetches.length;
  post(g, msg(STAFF, '取り消し 社労士', 'e5b'));                                          // 完了していないもの
  assert.match(replies(g, n)[0].body.messages[0].text, /見つかりませんでした/);
  n = g.fetches.length;
  post(g, msg(ADMIN, '取り消し「朝の確認」', 'e6'));
  assert.match(replies(g, n)[0].body.messages[0].text, /「朝の確認」の完了を取り消しました/);
  n = g.fetches.length;
  post(g, pb(STAFF, btnData(car[3], '詳細を確認'), 'e7'));
  assert.match(replies(g, n)[0].body.messages[0].text, /の詳細[\s\S]*困ったとき・判断が必要なとき\n安藤さんへ/);
  assert.ok(!JSON.stringify(car[3].body).includes('困ったら：'));                            // 吹き出しには出さない
  post(g, pb(STAFF, btnData(car[3], '詳細を確認').replace('|detail|', '|ask|'), 'e7b'));   // 前のボタン（わからない）も動く
  n = g.fetches.length;
  post(g, pb(STAFF, btnData(car[3], '今日はできない'), 'e8'));
  assert.match(replies(g, n)[0].body.messages[0].text, /明日に回します/);
  n = g.fetches.length;
  post(g, pb(STAFF, car[0].footer.contents[0].action.data, 'e9'));                       // 手が空きました
  const r1 = replies(g, n)[0].body.messages;
  assert.match(r1[0].text, /手伝えるお仕事はこちら[\s\S]*【今日のお仕事で、まだ担当がいないもの】[\s\S]*【前倒しできるお仕事】[\s\S]*［対応します］を押してから/);
  assert.ok(!/社労士へ送る/.test(r1[0].text));                                              // 見本さんが担当の仕事は出さない
  assert.equal(r1[1].type, 'flex');
  const fb = r1[1].contents.contents, early = fb.find((b) => /前倒し/.test(b.body.contents[1].text));
  assert.ok(fb.length >= 2 && early);
  assert.ok(!logOps(book).some((x) => x[0] === '対応します' && x[1] === '試験'));            // 押しただけでは担当にしない
  n = g.fetches.length;
  post(g, pb(STAFF, btnData(early, '対応します'), 'e9b'));                                // 前倒しを受け取る → 残りの業務に出る
  assert.match(replies(g, n)[0].body.messages[0].text, /試験さんの担当にしました/);
  n = g.fetches.length;
  post(g, msg(STAFF, '残りの業務', 'e9c'));
  assert.match(replies(g, n)[0].body.messages[0].text, new RegExp(early.body.contents[0].text.replace(/^\d+\. /, '') + '[^\n]*担当：試験さん'));
  n = g.fetches.length;
  post(g, pb(STAFF, btnData(first, '完了').replace(/\|[^|]+$/, '|zzz'), 'e10'));
  assert.match(replies(g, n)[0].body.messages[0].text, /このボタンは使えません/);
  n = g.fetches.length;
  post(g, pb(STAFF, btnData(first, '完了'), 'e11', KINTAI));                             // 勤怠管理グループでは反応しない
  assert.equal(replies(g, n).length, 0);
  assert.deepEqual(logOps(book).slice(0, 4), [['対応します', '見本'], ['完了', '試験'], ['取り消し', 'まゆ'], ['わからない', '試験']]);   // マスタにいない人は LINE の表示名
});

test('事務の業務一覧: 「残りの業務」で未完了の一覧（担当つき）・事務業務のグループだけ・12時のお知らせ・まとめ', () => {
  const { g } = setup();
  let n = g.fetches.length;
  g.ctx.OT_morning();
  const car = pushes(g, 0)[0].body.messages[0].contents.contents;
  const byName = (n) => car.find((b) => b.body && b.body.contents[0].text.includes(n));
  post(g, pb(OTHER, btnData(byName('社労士へ送る'), '対応します'), 'q1'));
  post(g, pb(STAFF, btnData(byName('朝の確認'), '完了'), 'q2'));
  n = g.fetches.length;
  post(g, msg(OTHER, '未完了の業務を教えて', 'q3'));
  const r = replies(g, n)[0].body.messages;
  assert.match(r[0].text, /【まだ終わっていないお仕事】/);
  assert.ok(!/朝の確認/.test(r[0].text));
  assert.match(r[0].text, /社労士へ送る（期限を過ぎています）　担当：見本さん/);
  assert.match(r[0].text, /担当：未定/);
  assert.equal(r[1].type, 'flex');
  n = g.fetches.length;
  post(g, msg(OTHER, '残りの業務', 'q4', KINTAI));                                       // 勤怠管理グループでは反応しない
  assert.equal(replies(g, n).length, 0);
  n = g.fetches.length;
  g.clock.now = new Date('2026-11-17T11:55:00+09:00').getTime(); g.ctx.OT_tick();
  assert.equal(pushes(g, n).length, 0);
  g.clock.now = new Date('2026-11-17T12:01:00+09:00').getTime(); g.ctx.OT_tick();
  const p = pushes(g, n);
  assert.equal(p.length, 1); assert.equal(p[0].body.to, OFFICE);
  assert.match(p[0].body.messages[0].text, /【まだ終わっていないお仕事】[\s\S]*12時のお知らせです/);
  n = g.fetches.length; g.ctx.OT_tick();
  assert.equal(pushes(g, n).length, 0);
  const text = g.ctx.OT_weeklyText([['h'], [new Date(), '2026-11-17', '2026-11-17', 'D01', '朝の確認', '完了', '試験', ''],
    [new Date(), '2026-11-18', 'x', 'M01', '交通費の確認', 'わからない', '試験', '']], '2026-11-23');
  assert.match(text, /完了：1件／わからない：1件／できなかった：0件[\s\S]*完了した人：試験さん 1件[\s\S]*交通費の確認/);
});

test('事務の業務一覧: 「部門登録 事務業務」でグループを登録できる', () => {
  const { g, master } = setup();
  const NEW = 'C' + 'c'.repeat(32);
  const n = g.fetches.length;
  post(g, msg(ADMIN, '部門登録 事務業務', 'r1', NEW));
  assert.match(replies(g, n)[0].body.messages[0].text, /「事務業務」のグループとして登録しました[\s\S]*今日のお仕事/);
  assert.ok(master.getSheetByName('LINEグループ').dump().some((r) => r[0] === NEW && r[1] === '事務業務'));
});

test('事務の業務一覧: AI化の順番の「稼働の確認」を毎朝スクリプトの設定で確かめる（設定が違えば未確認＝人への指示を続ける）', () => {
  const { g, book } = setup({ OFFICE_TASK_MODE: 'record', WEEKLY_PUNCH_NOTIFY: 'on', X_MODE: 'record' });
  const X = g.ctx;
  assert.equal(X.OT_checkSetting('', {}), null);
  assert.equal(X.OT_checkSetting('WEEKLY_PUNCH_NOTIFY=on', { WEEKLY_PUNCH_NOTIFY: 'on' }), true);
  assert.equal(X.OT_checkSetting('A=on&B=record', { A: 'on', B: 'on' }), false);
  assert.equal(X.OT_checkSetting('こわれた設定', {}), false);
  const o = book.insertSheet('AI化の順番（まゆさん用）');
  [['順番（入れ替えOK）', 'ID', '業務名', '状況', '稼働の確認（設定・Claudeが入れる）', '稼働の確認（結果・毎朝自動）'],
    [2, 'M02', '勤怠締め', '一部AI', 'WEEKLY_PUNCH_NOTIFY=on', ''], [1, 'M01', '交通費の確認', 'AI化済み', 'X_MODE=on', ''], [3, 'D01', '朝の確認', 'やらない（人の手）', '', '']].forEach((r) => o.appendRow(r));
  g.ctx.OT_morning();
  const v = o.dump();
  assert.match(String(v[1][5]), /^確認済み/);
  assert.match(String(v[2][5]), /^未確認.*設定が違います/);
  assert.equal(v[3][5], '（設定なし）');
});

test('事務の業務一覧 18a: 手順・持ち物の URL は「タップで開く」の押せる文字にする（2つ並んでも別々に）', () => {
  const X = setup().g.ctx;
  const parts = [...X.OT_textParts('持ち物・使うもの：', '送付リスト https://docs.google.com/spreadsheets/d/abc/edit\nショップ：https://shop.example.com/a?b=1 と https://example.com/x\n手袋', 'xs', '#555555')];
  assert.deepEqual(parts.map((p) => p.text), ['持ち物・使うもの：送付リスト 🔗タップで開く', 'ショップ 🔗タップで開く', 'と 🔗タップで開く', '手袋']);
  assert.deepEqual(parts.filter((p) => p.action).map((p) => p.action.uri), ['https://docs.google.com/spreadsheets/d/abc/edit', 'https://shop.example.com/a?b=1', 'https://example.com/x']);
  assert.equal(parts[0].action.type, 'uri'); assert.equal(parts[3].action, undefined);
  const b = X.OT_bubble({ id: 'M24', period: 'Y2026', name: 'お歳暮', steps: '1. 開く https://example.com/list', items: '', minutes: 10, deadline: '2026-11-18' }, 1, '2026-11-18', 'tok');
  assert.ok(b.body.contents.some((c) => c.action && c.action.uri === 'https://example.com/list'));
});

test('事務の業務一覧 20b: グループの「依頼 …」で臨時の依頼に登録（担当・期限・自分あて・メンション）・開始日の前は出さない・担当は吹き出しに出る', () => {
  const { g, book } = setup();
  const X = g.ctx;
  const P = (t) => { const r = X.OT_parseRequest(t, '2026-11-20'); return r && JSON.parse(JSON.stringify(r)); };
  assert.deepEqual(P('依頼 11/25 宮部さん ○○社へ請求書を郵送'), { name: '○○社へ請求書を郵送', due: '2026-11-25', who: '宮部' });
  assert.deepEqual(P('依頼　自分　明日まで 名刺の発注'), { name: '名刺の発注', due: '2026-11-21', who: '@self' });
  assert.deepEqual(P('依頼 1/10 年賀状の整理'), { name: '年賀状の整理', due: '2027-01-10', who: '' });
  assert.deepEqual(P('依頼'), { help: true });
  assert.equal(P('依頼します、よろしく'), null); assert.equal(P('ありがとうございます'), null);
  g.ctx.OT_morning();
  let n = g.fetches.length;
  post(g, msg(OTHER, '依頼 11/25 試験さん ○○社へ請求書を郵送', 'r1'));
  const r = replies(g, n)[0].body.messages;
  assert.match(r[0].text, /臨時の依頼に登録しました[\s\S]*担当：試験さん[\s\S]*期限：11\/25[\s\S]*依頼：見本さん[\s\S]*今日のお仕事に入れました/);
  assert.equal(r[1].type, 'flex'); assert.ok(JSON.stringify(r[1]).includes('担当：試験さん'));
  const rq = book.getSheetByName('臨時の依頼').dump().at(-1);
  assert.deepEqual([rq[2], String(rq[3]).replace(/^'/, ''), rq[6], rq[8]], ['○○社へ請求書を郵送', '2026-11-25', '試験', '見本']);
  n = g.fetches.length;
  post(g, msg(STAFF, '残りの業務', 'r2'));
  assert.match(replies(g, n)[0].body.messages[0].text, /○○社へ請求書を郵送　担当：試験さん/);
  n = g.fetches.length;
  post(g, { ...msg(STAFF, '@見本 依頼 名刺の発注', 'r3'), message: { id: 'mr3', type: 'text', text: '依頼 @見本 名刺の発注', mention: { mentionees: [{ index: 3, length: 3, userId: OTHER, type: 'user' }] } } });
  assert.match(replies(g, n)[0].body.messages[0].text, /内容：名刺の発注\n・担当：見本さん/);
  n = g.fetches.length;
  post(g, msg(STAFF, '依頼', 'r4'));
  assert.match(replies(g, n)[0].body.messages[0].text, /「依頼 11\/25 宮部さん ○○社へ請求書を郵送」/);
  // 開始日：その日までは出さない
  book.getSheetByName('臨時の依頼').appendRow(['2026-11-17', '', '通勤区分の入力', '2026-11-25', '', '', '緒方', '2026-11-25', 'まゆ']);
  const reqs = X.OT_requests_(X.OT_book_());
  assert.ok(!X.OT_plan([], '2026-11-24', 360, {}, reqs).today.some((t) => t.name === '通勤区分の入力'));
  const p25 = X.OT_plan([], '2026-11-25', 360, {}, reqs).today.find((t) => t.name === '通勤区分の入力');
  assert.equal(p25.assignee, '緒方');
  assert.ok(JSON.stringify(X.OT_bubble(p25, 1, '2026-11-25', 'tok', null)).includes('担当：緒方さん'));
});

test('事務の業務一覧 20b: 業務マニュアルに足した業務は、毎朝 AI化の順番の下にも足す', () => {
  const { g, book } = setup({ OFFICE_TASK_MODE: 'record' });
  const o = book.insertSheet('AI化の順番（まゆさん用）');
  [['順番', 'ID', '業務名', '状況', '稼働の確認（設定・Claudeが入れる）', '稼働の確認（結果・毎朝自動）'], [1, 'D01', '朝の確認', '人の手', '', '']].forEach((r) => o.appendRow(r));
  g.ctx.OT_morning();
  const v = o.dump();
  assert.ok(v.length > 3);
  assert.deepEqual(v.slice(1).map((r) => r[1]).filter((x) => x === 'D01').length, 1);
  const added = v.find((r) => r[1] === 'M01');
  assert.deepEqual([added[0] > 1, added[2], added[3]], [true, '交通費の確認', '人の手']);
  const before = o.dump().length; g.ctx.OT_morning(); assert.equal(o.dump().length, before);   // 2回目は足さない
});
