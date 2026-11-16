import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createGas } from './helpers/gas-mock.js';

// 運転免許証の有効期限の管理（gas/License.gs・版 2026-11-16b）。すべて架空の社員番号・LINE ID・模擬環境（LINE には送らない・写真の中身は持たない）
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const ADMIN = U(7), GROUP = 'C' + 'a'.repeat(32), FOLDER = 'folder-license';
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const row = (code, name, userId, { status = '在籍', lineOk = true, retiredOn = '' } = {}) =>
  ["'" + code, name, '', status, '部署A', userId, '', '', lineOk, true, '', '', '', retiredOn];
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'Notices.gs', 'License.gs'];

function setup(props = { LICENSE_MODE: 'on' }, { now = '2026-11-16T09:10:00+09:00', files = FILES } = {}) {
  const g = createGas({ files, now });
  const master = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = master.insertSheet('従業員マスタ');
  [HEAD, row('90001', '試験 一郎', U(1)), row('90002', '試験 二郎', U(2)), row('90003', '試験 三郎', ''),
    row('90004', '試験 四郎', U(4), { status: '退職' }), row('90005', '試験 五郎', U(5)), row('90006', '試験 六郎', U(6), { retiredOn: '2026-11-01' })]
    .forEach((r) => m.appendRow(r));
  master.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [GROUP, '勤怠管理', '2026-10-15', '有効']].forEach((r) => master.getSheetByName('LINEグループ').appendRow(r));
  const book = g.newSpreadsheet('【テスト】従業員問い合わせ管理（架空）');
  g.drive.newFolder(FOLDER);
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: master.getId(), INQ_SPREADSHEET_ID: book.getId(), INQ_MODE: 'on', LINE_CHANNEL_ACCESS_TOKEN: 'fake',
    LINE_ADMIN_USER_ID: ADMIN, DRY_RUN: 'false', LICENSE_FOLDER_ID: FOLDER, ...props });
  [1, 2, 5].forEach((n) => { g.line.profiles[U(n)] = '表示名' + n; });
  return { g, master, book };
}

const tab = (master) => master.getSheetByName('免許証管理');
const rowOf = (master, code) => tab(master).dump().findIndex((r, i) => i > 0 && String(r[0]) === code) + 1;
const val = (master, code, header) => { const t = tab(master), h = t.dump()[0]; return t.getRange(rowOf(master, code), h.indexOf(header) + 1).getValue(); };
const set = (master, code, header, v) => { const t = tab(master), h = t.dump()[0]; t.getRange(rowOf(master, code), h.indexOf(header) + 1).setValue(v); };
const ymd = (d) => (d instanceof Date ? new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10) : d);
const since = (g, n) => {
  const f = g.fetches.slice(n);
  return { push: f.filter((x) => x.url.endsWith('/push')), reply: f.filter((x) => x.url.endsWith('/reply')), content: f.filter((x) => /api-data/.test(x.url)) };
};
const textOf = (m) => (m.type === 'flex' ? m.contents.body.contents[0].text : m.text);
const day = (g, iso) => { g.clock.now = new Date(iso + 'T09:10:00+09:00').getTime(); };
let seq = 0;
const ev = (userId, message, id = 'ev' + ++seq) => ({ type: 'message', webhookEventId: id, replyToken: 'rt-' + id, timestamp: 0,
  source: { type: 'user', userId }, message: { id: 'm' + id, ...(typeof message === 'string' ? { type: 'text', text: message } : message) } });
const pb = (userId, data, params, id = 'ev' + ++seq) => ({ type: 'postback', webhookEventId: id, replyToken: 'rt-' + id,
  source: { type: 'user', userId }, postback: { data, ...(params ? { params } : {}) } });
const post = (g, ...events) => g.ctx.doPost({ postData: { contents: JSON.stringify({ destination: 'x', events }) } });
/** 写真を送る（模擬の LINE に画像の取り出しの応答を用意してから） */
const photo = (g, userId) => { const e = ev(userId, { type: 'image' }); g.line.contents[e.message.id] = { type: 'image/jpeg' }; post(g, e); return e; };

test('免許証: 純粋関数（日付・段階・状態）', () => {
  const { g } = setup();
  const X = g.ctx;
  assert.equal(X.LIC_parseYmd('2027/3/5'), '2027-03-05');
  assert.equal(X.LIC_parseYmd('2027年3月5日'), '2027-03-05');
  assert.equal(X.LIC_parseYmd(''), '');
  assert.equal(X.LIC_parseYmd('2027-02-30'), null);
  assert.equal(X.LIC_parseYmd('来年'), null);
  assert.equal(X.LIC_addYears('2028-02-29', 3), '2031-02-28');
  assert.equal(X.LIC_addYears('2026-12-16', 5), '2031-12-16');
  const st = (exp) => X.LIC_stage(exp, '2026-11-16').stage;
  assert.deepEqual(['2026-12-17', '2026-12-16', '2026-11-24', '2026-11-23', '2026-11-17', '2026-11-16', '2026-11-15'].map(st),
    [null, 'd30', 'd30', 'd7', 'd7', 'd0', 'over']);
  const s = (o, retired = false) => X.LIC_statusFor({ has: 'あり', exp: '', state: '', ...o }, retired, '2026-11-16');
  assert.equal(s({}, true), '退職');
  assert.equal(s({ has: 'なし' }), '対象外（免許なし）');
  assert.equal(s({ has: '' }), '有無の確認待ち');
  assert.equal(s({}), '登録待ち');
  assert.equal(s({ exp: null }), '要確認');
  assert.equal(s({ exp: '2027-01-01', state: '要確認' }), '要確認');   // 管理本部が直すまで残す
  assert.equal(s({ exp: '2027-01-01' }), '登録済み');
  assert.equal(s({ exp: '2026-12-01' }), '更新待ち');
  assert.equal(s({ exp: '2026-11-15' }), '期限切れ報告なし');
  assert.equal(X.LIC_hasValue(' 有 '), 'あり');
  assert.equal(X.LIC_isWord(' 免許更新　'), true);
  assert.equal(X.LIC_isWord('免許更新しました'), false);
  assert.equal(X.LIC_isPhotoOf('90001_20261116', '90001'), true);
  assert.equal(X.LIC_isPhotoOf('900011_20261116', '90001'), false);
  assert.equal(X.LIC_parsePostback('lic|1|y3|0123456789ab').action, 'y3');
  assert.equal(X.LIC_parsePostback('lic|1|y3'), null);
  assert.equal(X.LIC_parsePostback('inq|1|take|Q-20261116-001|abcdef'), null);
});

test('免許証: off（未設定）なら毎朝の処理は何もせず、「免許更新」は今までどおり問い合わせになる', () => {
  const { g, master, book } = setup({});
  const n = g.fetches.length;
  g.ctx.licenseDaily();
  assert.equal(tab(master), null);
  post(g, ev(U(1), '免許更新'));
  const c = book.getSheetByName('問い合わせ').dump().slice(1);
  assert.equal(c.length, 1);
  assert.equal(since(g, n).push.length, 1);   // 勤怠管理グループへの問い合わせのお知らせ（今までどおり）
});

test('免許証: record はタブを作って在籍者を足し、送る予定を記録するだけ（LINE は送らない・送信記録は付けない）', () => {
  const { g, master } = setup({ LICENSE_MODE: 'record' });
  const n = g.fetches.length;
  g.ctx.licenseDaily();
  const t = tab(master).dump();
  assert.deepEqual([...t[0]], ['社員番号', '氏名', '免許の有無', '有効期限', '状態', '写真ファイルID', '最終報告日時', '送信記録', '備考']);
  assert.deepEqual(t.slice(1).map((r) => String(r[0])), ['90001', '90002', '90003', '90005']);   // 退職・退職日を過ぎた人は足さない
  assert.ok(t.slice(1).every((r) => r[2] === '' && r[4] === '有無の確認待ち'));
  assert.equal(g.fetches.length, n);
  const rec = master.getSheetByName('免許証お知らせ記録').dump();
  assert.equal(rec.length, 2);
  assert.equal(rec[1][2], 'ask');
  assert.match(rec[1][5], /^【免許証】「免許の有無」が未入力の方がいます（4名）\n・90001 試験 一郎\n/);
  assert.equal(rec[1][6], '記録のみ（送信なし）');
  g.ctx.licenseDaily();
  assert.equal(tab(master).dump().length, 5);   // 2回目も行は増えない
  assert.ok(tab(master).dump().slice(1).every((r) => r[7] === ''));
});

test('免許証: on でも DRY_RUN が false でなければ送らない', () => {
  const { g } = setup({ LICENSE_MODE: 'on', DRY_RUN: 'true' });
  const n = g.fetches.length;
  const r = g.ctx.licenseDaily();
  assert.equal(r.live, false);
  assert.equal(g.fetches.length, n);
});

test('免許証: 免許の有無が空欄の人の一覧は勤怠管理グループへ1回だけ（AIの一文なし）', () => {
  const { g, master } = setup();
  let n = g.fetches.length;
  g.ctx.licenseDaily();
  let { push } = since(g, n);
  assert.equal(push.length, 1);
  assert.equal(push[0].body.to, GROUP);
  const text = push[0].body.messages[0].text;
  assert.ok(text.includes('・90003 試験 三郎'));
  assert.ok(!text.includes('AIによる自動送信'));
  assert.match(String(val(master, '90001', '送信記録')), /^有無の確認 - 2026-11-16$/);
  n = g.fetches.length;
  g.ctx.licenseDaily();
  assert.equal(since(g, n).push.length, 0);
  // 新しく入った人だけ、次の朝に一覧へ
  master.getSheetByName('従業員マスタ').appendRow(row('90007', '試験 七郎', U(8)));
  n = g.fetches.length;
  g.ctx.licenseDaily();
  push = since(g, n).push;
  assert.equal(push.length, 1);
  assert.match(push[0].body.messages[0].text, /（1名）\n・90007 試験 七郎\n/);
});

test('免許証: 登録のお願い → 3日後・7日後の催促 → 10日後に勤怠管理グループへ一覧。LINE 未登録の人は一覧で1回', () => {
  const { g, master } = setup();
  g.ctx.licenseSetup();
  ['90001', '90002', '90003', '90005'].forEach((c) => set(master, c, '免許の有無', c === '90005' ? 'なし' : 'あり'));
  let n = g.fetches.length;
  g.ctx.licenseDaily();
  let { push } = since(g, n);
  const to = push.map((p) => p.body.to);
  assert.deepEqual(to.sort(), [U(1), U(2), GROUP].sort());   // なしの人（90005）には送らない
  const req = push.find((p) => p.body.to === U(1)).body.messages[0];
  assert.equal(req.type, 'flex');
  assert.equal(textOf(req), '試験 一郎さん、お疲れさまです。管理本部です。\n運転免許証の有効期限を管理するため、免許証の登録をお願いいたします。\n'
    + '下のボタンを押して、免許証の写真をお送りください。\nいつもご協力ありがとうございます。\n\n※このメッセージはAIによる自動送信です。');
  assert.deepEqual({ ...req.contents.footer.contents[0].action }, { type: 'postback', label: '免許証を登録する', data: 'lic|1|start', displayText: '免許証を登録します' });
  const grp = push.find((p) => p.body.to === GROUP).body.messages[0].text;
  assert.match(grp, /^【免許証】LINE が未登録のため、免許証の案内を送れない方がいます（1名）\n・90003 試験 三郎\n/);
  assert.equal(val(master, '90001', '状態'), '登録待ち');
  assert.equal(val(master, '90005', '状態'), '対象外（免許なし）');
  const self = (iso) => { day(g, iso); const k = g.fetches.length; g.ctx.licenseDaily(); return since(g, k).push; };
  assert.equal(self('2026-11-17').length, 0);
  push = self('2026-11-19');
  assert.deepEqual(push.map((p) => p.body.to).sort(), [U(1), U(2)].sort());
  assert.match(textOf(push[0].body.messages[0]), /先日お願いした運転免許証の登録が、まだ確認できていません/);
  assert.equal(self('2026-11-20').length, 0);
  assert.equal(self('2026-11-23').length, 2);   // 7日後
  assert.equal(self('2026-11-24').length, 0);
  push = self('2026-11-26');   // 10日後
  assert.equal(push.length, 1);
  assert.equal(push[0].body.to, GROUP);
  assert.match(push[0].body.messages[0].text, /^【免許証】登録のお願いと催促（2回）を送りましたが、まだ免許証の登録がない方がいます（2名）/);
  assert.equal(self('2026-11-27').length, 0);
  assert.equal(String(val(master, '90001', '送信記録')), '登録のお願い - 2026-11-16\n催促1 - 2026-11-19\n催促2 - 2026-11-23\n登録なしの一覧 - 2026-11-26');
  for (const p of g.fetches.filter((x) => x.body && x.body.messages)) assert.ok(!JSON.stringify(p.body).includes('くださいね'));
});

test('免許証: licenseRegisterSend は登録のお願いだけを送り、期限のお知らせは送らない', () => {
  const { g, master } = setup();
  g.ctx.licenseSetup();
  set(master, '90001', '免許の有無', 'あり');
  set(master, '90002', '免許の有無', 'あり'); set(master, '90002', '有効期限', '2026-11-20');
  set(master, '90003', '免許の有無', 'なし'); set(master, '90005', '免許の有無', 'なし');
  const n = g.fetches.length;
  g.ctx.licenseRegisterSend();
  const { push } = since(g, n);
  assert.deepEqual(push.map((p) => p.body.to), [U(1)]);
  assert.equal(String(val(master, '90002', '送信記録')), '');
});

test('免許証: 30日前・7日前・当日・期限切れ（翌朝に本人・勤怠管理グループ・管理者）を1回ずつ。退職者と「なし」の人は除く。お知らせ設定は適用しない', () => {
  const { g, master } = setup({ LICENSE_MODE: 'on', NOTICE_SETTINGS: 'on' });
  const ns = master.insertSheet('お知らせ設定');
  ns.appendRow(['社員番号', '氏名', '所属', '状態', 'SAF-01 運転免許証の更新案内']);
  ns.appendRow(["'90001", '試験 一郎', '部署A', '在籍', false]);   // 「受け取らない」でも送る（安全に関わるため全員必須）
  g.ctx.licenseSetup();
  set(master, '90001', '免許の有無', 'あり'); set(master, '90001', '有効期限', '2026-12-16');
  set(master, '90002', '免許の有無', 'なし'); set(master, '90002', '有効期限', '2026-11-01');
  set(master, '90003', '免許の有無', 'なし'); set(master, '90005', '免許の有無', 'なし');
  tab(master).appendRow(["'90004", '試験 四郎', 'あり', '2026-11-16', '', '', '', '', '']);   // 退職者の行（消さない）
  const run = (iso) => { day(g, iso); const k = g.fetches.length; g.ctx.licenseDaily(); return since(g, k).push; };
  let push = run('2026-11-15');   // 31日前：まだ
  assert.equal(push.length, 0);
  assert.equal(val(master, '90001', '状態'), '登録済み');
  assert.equal(val(master, '90004', '状態'), '退職');
  push = run('2026-11-16');
  assert.equal(push.length, 1);
  assert.equal(push[0].body.to, U(1));
  assert.match(textOf(push[0].body.messages[0]), /有効期限（2026年12月16日）まで、あと30日になりました/);
  assert.equal(push[0].body.messages[0].contents.footer.contents[0].action.label, '更新を報告する');
  assert.equal(val(master, '90001', '状態'), '更新待ち');
  assert.equal(run('2026-11-16').length, 0);   // 同じ日にもう一度：送らない
  assert.equal(run('2026-12-08').length, 0);   // 8日前：30日前の段階で送り済み
  push = run('2026-12-09');
  assert.equal(push.length, 1);
  assert.match(textOf(push[0].body.messages[0]), /あと7日です。更新のご報告をまだ確認できていないため/);
  assert.equal(run('2026-12-15').length, 0);
  push = run('2026-12-16');
  assert.equal(push.length, 1);
  assert.match(textOf(push[0].body.messages[0]), /有効期限は、本日（2026年12月16日）までです/);
  push = run('2026-12-17');
  assert.deepEqual(push.map((p) => p.body.to).sort(), [U(1), GROUP, ADMIN].sort());
  assert.equal(textOf(push.find((p) => p.body.to === U(1)).body.messages[0]),
    '試験 一郎さん、お疲れさまです。管理本部です。\n運転免許証の有効期限（2026年12月16日）を過ぎましたが、更新のご報告をまだ確認できていません。\n'
    + 'すでに更新がお済みでしたら、「免許更新」と送って新しい免許証の写真をお送りいただけますと助かります。\nご協力ありがとうございます。\n\n※このメッセージはAIによる自動送信です。');
  const grp = push.find((p) => p.body.to === GROUP).body.messages[0].text;
  assert.equal(grp, '【免許証】有効期限を過ぎても、更新の報告がない方がいます（1名）\n・90001 試験 一郎（期限 2026年12月16日）\n本人へ更新の状況のご確認をお願いします（すでに更新済みのこともあります）。');
  assert.equal(push.find((p) => p.body.to === ADMIN).body.messages[0].text, grp);
  assert.equal(val(master, '90001', '状態'), '期限切れ報告なし');
  assert.equal(run('2026-12-18').length, 0);
  assert.equal(rowOf(master, '90004') > 0, true);   // 退職者の行は残る
  const log = master.getSheetByName('通知送信履歴').dump().slice(1);
  assert.ok(log.length >= 5 && log.every((r) => r[1] === 'SAF-01'));
});

test('免許証: 更新の報告（ボタン → 写真 → 3年後）。写真は「社員番号_YYYYMMDD」で保存し古い写真だけゴミ箱へ。前の期限の催促は止まる', () => {
  const { g, master, book } = setup();
  g.ctx.licenseSetup();
  set(master, '90001', '免許の有無', 'あり'); set(master, '90001', '有効期限', '2026-12-16');
  ['90002', '90003', '90005'].forEach((c) => set(master, c, '免許の有無', 'なし'));
  const folder = g.drive.folders[FOLDER];
  folder.files.push({ id: 'old-1', name: '90001_20231201', type: 'image/jpeg', trashed: false }, { id: 'other', name: '90002_20240101', type: 'image/jpeg', trashed: false });
  let n = g.fetches.length;
  post(g, pb(U(1), 'lic|1|start'));
  let { reply, push } = since(g, n);
  assert.equal(push.length, 0);
  assert.equal(reply[0].body.messages[0].text, 'ありがとうございます。\n免許証の表面の写真を、このトークにお送りください（30分以内にお願いいたします）。\n'
    + '有効期限の文字がはっきり写るように撮っていただけますと助かります。\n\n※このメッセージはAIによる自動送信です。');
  n = g.fetches.length;
  photo(g, U(1));
  ({ reply, push } = since(g, n));
  assert.equal(since(g, n).content.length, 1);
  assert.equal(push.length, 0);   // 問い合わせのお知らせは出ない
  const saved = folder.files.filter((f) => !f.trashed).map((f) => f.name).sort();
  assert.deepEqual(saved, ['90001_20261116', '90002_20240101']);
  assert.equal(folder.files.find((f) => f.id === 'old-1').trashed, true);
  assert.equal(val(master, '90001', '写真ファイルID'), folder.files.find((f) => f.name === '90001_20261116').id);
  const msg = reply[0].body.messages[0], btns = msg.contents.footer.contents.map((b) => b.action);
  assert.deepEqual(btns.map((b) => b.label), ['2029年12月16日（3年後）', '2031年12月16日（5年後）', 'その他（カレンダーで選ぶ）']);
  assert.equal(btns[2].type, 'datetimepicker');
  assert.equal(btns[2].mode, 'date');
  assert.equal(book.getSheetByName('問い合わせ'), null);   // 写真は問い合わせに入らない
  n = g.fetches.length;
  post(g, pb(U(1), btns[0].data));
  ({ reply, push } = since(g, n));
  assert.equal(push.length, 0);   // 3年後・5年後は管理者へ知らせない
  assert.equal(reply[0].body.messages[0].text, '試験 一郎さん、更新のご報告ありがとうございます。\n新しい有効期限を2029年12月16日で記録しました。\n'
    + '次の期限が近づきましたら、こちらから改めてご案内いたします。\n\n※このメッセージはAIによる自動送信です。');
  assert.equal(ymd(val(master, '90001', '有効期限')), '2029-12-16');
  assert.equal(val(master, '90001', '状態'), '登録済み');
  n = g.fetches.length;
  post(g, pb(U(1), btns[1].data));   // 続けて5年後を押しても上書きしない
  assert.match(since(g, n).reply[0].body.messages[0].text, /^ありがとうございます。有効期限はすでに2029年12月16日で記録しています。/);
  n = g.fetches.length;
  g.ctx.licenseDaily();   // 前の期限（30日前）の案内は送らない
  assert.equal(since(g, n).push.length, 0);
});

test('免許証: 「免許更新」→ 写真 → その他（カレンダー）は記録して管理者の個別 LINE へ（状態は要確認のまま）', () => {
  const { g, master } = setup();
  g.ctx.licenseSetup();
  set(master, '90001', '免許の有無', 'あり'); set(master, '90001', '有効期限', '2026-12-16');
  ['90002', '90003', '90005'].forEach((c) => set(master, c, '免許の有無', 'なし'));
  post(g, ev(U(1), '免許更新'));
  let n = g.fetches.length;
  photo(g, U(1));
  const other = since(g, n).reply[0].body.messages[0].contents.footer.contents[2].action;
  n = g.fetches.length;
  post(g, pb(U(1), other.data, { date: '2030-01-10' }));
  const { reply, push } = since(g, n);
  assert.match(reply[0].body.messages[0].text, /新しい有効期限を2030年1月10日で記録しました/);
  assert.equal(push.length, 1);
  assert.equal(push[0].body.to, ADMIN);
  assert.equal(push[0].body.messages[0].text, '【免許証・要確認】90001 試験 一郎さんが、新しい有効期限を「その他（カレンダー）」で選びました（2030年1月10日・前の期限 2026年12月16日）。\n'
    + '「免許証管理」タブの写真と有効期限をご確認のうえ、状態を直してください。');
  assert.equal(val(master, '90001', '状態'), '要確認');
  assert.match(String(val(master, '90001', '備考')), /^「その他」で期限を選択 2030-01-10 2026-11-16$/);
  g.ctx.licenseDaily();
  assert.equal(val(master, '90001', '状態'), '要確認');   // 管理本部が直すまで残す
});

test('免許証: 新規の登録は写真のあとカレンダーだけ。今日より前の日付は記録しない', () => {
  const { g, master } = setup();
  g.ctx.licenseSetup();
  set(master, '90002', '免許の有無', 'あり');
  post(g, pb(U(2), 'lic|1|start'));
  let n = g.fetches.length;
  photo(g, U(2));
  const btns = since(g, n).reply[0].body.messages[0].contents.footer.contents.map((b) => b.action);
  assert.equal(btns.length, 1);
  assert.deepEqual([btns[0].type, btns[0].label, btns[0].mode, btns[0].min], ['datetimepicker', '有効期限を選ぶ', 'date', '2026-11-17']);
  n = g.fetches.length;
  post(g, pb(U(2), btns[0].data, { date: '2026-11-01' }));
  assert.match(textOf(since(g, n).reply[0].body.messages[0]), /^選ばれた日付（2026年11月1日）は今日より前のため、記録できませんでした/);
  assert.equal(val(master, '90002', '有効期限'), '');
  n = g.fetches.length;
  post(g, pb(U(2), btns[0].data, { date: '2029-04-30' }));
  assert.match(since(g, n).reply[0].body.messages[0].text, /^試験 二郎さん、ご登録ありがとうございます。\n運転免許証の有効期限を2029年4月30日で記録しました。/);
  assert.equal(ymd(val(master, '90002', '有効期限')), '2029-04-30');
  assert.equal(val(master, '90002', '状態'), '登録済み');
});

test('免許証: 受付は30分で解除（その後の写真は今までどおり問い合わせ）。LINE の再送は1回だけ処理。写真を取り出せなければ謝って管理者へ', () => {
  const { g, master, book } = setup();
  g.ctx.licenseSetup();
  set(master, '90001', '免許の有無', 'あり');
  post(g, pb(U(1), 'lic|1|start'));
  g.clock.now += 31 * 60000;
  let n = g.fetches.length;
  photo(g, U(1));
  assert.equal(since(g, n).content.length, 0);
  assert.equal(book.getSheetByName('問い合わせ').dump().slice(1).length, 1);   // 問い合わせ（（画像））になる
  post(g, pb(U(1), 'lic|1|start'));
  const e = ev(U(1), { type: 'image' });
  g.line.contents[e.message.id] = { type: 'image/jpeg' };
  n = g.fetches.length;
  post(g, e, e);   // 同じ出来事が2回届く
  assert.equal(since(g, n).content.length, 1);
  assert.equal(g.drive.folders[FOLDER].files.length, 1);
  // 写真を取り出せない（LINE の応答が 404）
  post(g, pb(U(1), 'lic|1|start'));
  n = g.fetches.length;
  post(g, ev(U(1), { type: 'image' }));
  const r = since(g, n);
  assert.match(r.reply[0].body.messages[0].text, /^申し訳ありません。写真をうまく受け取れませんでした/);
  assert.equal(r.push.length, 1);
  assert.equal(r.push[0].body.to, ADMIN);
  assert.match(r.push[0].body.messages[0].text, /^【エラー】運転免許証の写真を保存できませんでした（社員番号 90001）/);
  assert.ok(!g.logs.some((l) => /試験 一郎|20261116|image/.test(l)));   // ログに氏名・写真の情報を書かない
});

test('免許証: 対象でない人の「免許更新」・受付中でない画像・ほかのボタン・社員番号は今までどおり', () => {
  const { g, master, book } = setup();
  g.ctx.licenseSetup();
  set(master, '90002', '免許の有無', 'なし');
  post(g, ev(U(2), '免許更新'));          // 免許なしの人 → 問い合わせ
  post(g, ev(U(5), '免許更新'));          // 免許の有無が空欄の人 → 問い合わせ
  post(g, ev(U(9), '免許更新'));          // 従業員マスタにいない人 → 問い合わせ
  let n = g.fetches.length;
  photo(g, U(1));                          // 受付中でない画像 → 問い合わせ
  assert.equal(since(g, n).content.length, 0);
  assert.equal(book.getSheetByName('問い合わせ').dump().slice(1).length, 4);
  n = g.fetches.length;
  post(g, pb(U(1), 'lic|1|y3|0123456789ab'));   // 受付していない期限のボタン
  assert.match(since(g, n).reply[0].body.messages[0].text, /^受付の時間が過ぎたため、記録できませんでした/);
  n = g.fetches.length;
  post(g, ev(U(2), '90002'));             // 社員番号の登録（今までどおり）
  assert.match(since(g, n).reply[0].body.messages[0].text, /90002/);
});

test('免許証: 受け口の回帰：License.gs と LICENSE_MODE=on を足しても、免許以外の出来事の送信・記録は同じ', () => {
  const run = (withLicense) => {
    const { g, book, master } = setup(withLicense ? { LICENSE_MODE: 'on' } : {}, { files: withLicense ? FILES : FILES.filter((f) => f !== 'License.gs') });
    let k = 0;
    const id = () => 'r' + ++k;
    const img = ev(U(1), { type: 'image' }, id()); g.line.contents[img.message.id] = { type: 'image/jpeg' };
    post(g, ev(U(1), '明日のシフトについて相談です', id()), img, ev(U(5), { type: 'sticker', packageId: '1', stickerId: '1' }, id()),
      ev(U(2), '承知しました', id()), ev(U(9), '免許の写真です', id()), ev(U(3).replace(/3/g, 'd'), '90003', id()),
      pb(U(1), 'inq|1|take|Q-20261116-001|abcdef', null, id()),
      { type: 'postback', webhookEventId: id(), replyToken: 'rt', source: { type: 'group', groupId: GROUP, userId: U(1) }, postback: { data: 'sch|1|ok|x' } },
      { type: 'message', webhookEventId: id(), replyToken: 'rt2', source: { type: 'group', groupId: GROUP, userId: U(1) }, message: { id: 'g1', type: 'text', text: 'おはようございます' } });
    const norm = (x) => JSON.stringify(x).replace(/\|[a-f][0-9a-f]{5}"/g, '|TOKEN"');
    return { fetches: g.fetches.map((f) => f.url + ' ' + norm(f.body)), sheets: book.sheets.map((s) => s.name + norm(s.dump().map((r) => r.filter((v) => !(v instanceof Date))))),
      master: norm(master.getSheetByName('従業員マスタ').dump().map((r) => r.filter((v) => !(v instanceof Date)))) };
  };
  const a = run(false), b = run(true);
  const strip = (s) => s.replace(/"[a-f][0-9a-f]{5}"/g, '"TOKEN"');
  assert.deepEqual(b.fetches.map(strip), a.fetches.map(strip));
  assert.deepEqual(b.sheets.map(strip), a.sheets.map(strip));
  assert.equal(b.master, a.master);
});

test('免許証: 既存のテスト一式（問い合わせ・勤怠変更・アルコールチェック・従業員登録など）が、License.gs と LICENSE_MODE=on を足しても通る', () => {
  const files = readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.test.js') && f !== 'license.test.js').map((f) => 'test/' + f);
  const runAll = (reg) => {
    const env = { ...process.env, LIC_REGRESSION: reg ? '1' : '' };
    delete env.NODE_TEST_CONTEXT;   // テストの中から別のテストを動かすため（結果を文字で受け取る）
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
    const num = (k) => { const m = new RegExp('^# ' + k + ' (\\d+)$', 'm').exec(r.stdout); return m ? +m[1] : -1; };
    return { pass: num('pass'), fail: num('fail'), failed: r.stdout.split('\n').filter((l) => /^not ok/.test(l)).join('\n') };
  };
  const base = runAll(false), withLic = runAll(true);
  assert.equal(withLic.fail, 0, withLic.failed);
  assert.ok(base.pass > 300);
  assert.equal(withLic.pass, base.pass);
});
