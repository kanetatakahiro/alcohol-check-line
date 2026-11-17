import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createGas } from './helpers/gas-mock.js';

// 運転免許証の有効期限の管理（gas/License.gs・版 2026-11-18b）。すべて架空の社員番号・LINE ID・模擬環境（LINE には送らない・写真の中身は持たない）
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const ADMIN = U(7), GROUP = 'C' + 'a'.repeat(32), FOLDER = 'folder-license';
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const row = (code, name, userId, { status = '在籍', lineOk = true, retiredOn = '', dept = '部署A' } = {}) =>
  ["'" + code, name, '', status, dept, userId, '', '', lineOk, true, '', '', '', retiredOn];
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

test('免許証: record はタブを作って在籍者を足し、送る予定を記録するだけ（LINE は送らない・送信記録は付けず「記録済み」に付ける）', () => {
  const { g, master } = setup({ LICENSE_MODE: 'record' });
  const n = g.fetches.length;
  g.ctx.licenseDaily();
  const t = tab(master).dump();
  assert.deepEqual([...t[0]], ['社員番号', '氏名', '免許の有無', '有効期限', '状態', '写真ファイルID', '最終報告日時', '送信記録', '記録済み', '備考', 'AI確認']);
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
  assert.ok(tab(master).dump().slice(1).every((r) => r[7] === '' && r[8] === '有無の確認 - 2026-11-16'));
  assert.equal(master.getSheetByName('免許証お知らせ記録').dump().length, 2);   // 同じ人の記録は1回だけ
});

test('免許証: record でも、同じ人・同じ期限・同じ段階の記録は1回だけ（「記録済み」で管理）。on にすると送信記録で改めて送る', () => {
  const { g, master } = setup({ LICENSE_MODE: 'record' });
  g.ctx.licenseSetup();
  set(master, '90001', '免許の有無', 'あり');
  set(master, '90002', '免許の有無', 'あり'); set(master, '90002', '有効期限', '2026-12-16');
  set(master, '90003', '免許の有無', 'あり');
  set(master, '90005', '免許の有無', 'なし');
  const recs = () => (master.getSheetByName('免許証お知らせ記録') ? master.getSheetByName('免許証お知らせ記録').dump() : [[]]).slice(1).map((r) => r[2] + ':' + String(r[4] || ''));
  const n = g.fetches.length;
  const run = (iso) => { day(g, iso); const k = recs().length; g.ctx.licenseDaily(); return recs().slice(k); };
  assert.deepEqual(run('2026-11-16'), ['req:90001', 'd30:90002', 'noline:']);
  assert.deepEqual(run('2026-11-16'), []);   // 同じ日にもう一度：記録しない
  assert.deepEqual(run('2026-11-17'), []);   // 次の朝：記録しない
  assert.deepEqual(run('2026-11-19'), ['rem:90001']);   // 3日後の催促は記録済みの日から数える
  assert.deepEqual(run('2026-11-23'), ['rem:90001']);
  assert.deepEqual(run('2026-11-26'), ['noreg:']);
  assert.deepEqual(run('2026-12-09'), ['d7:90002']);
  assert.deepEqual(run('2026-12-16'), ['d0:90002']);
  assert.deepEqual(run('2026-12-17'), ['over:90002', 'over:']);
  assert.deepEqual(run('2026-12-18'), []);
  assert.equal(g.fetches.length, n);   // LINE は送っていない
  assert.equal(String(val(master, '90002', '送信記録')), '');
  assert.equal(String(val(master, '90002', '記録済み')),
    '30日前 2026-12-16 2026-11-16\n7日前 2026-12-16 2026-12-09\n当日 2026-12-16 2026-12-16\n期限切れ 2026-12-16 2026-12-17\n期限切れの一覧 2026-12-16 2026-12-17');
  // on にすると「送信記録」で判定するので、今の段階を改めて送る（記録済みは使わない）
  g.scriptProps.setProperty('LICENSE_MODE', 'on');
  day(g, '2026-12-18');
  const k = g.fetches.length;
  g.ctx.licenseDaily();
  const to = g.fetches.slice(k).filter((x) => x.url.endsWith('/push')).map((x) => x.body.to).sort();
  assert.deepEqual(to, [U(1), U(2), GROUP, GROUP, ADMIN].sort());   // 一郎：登録のお願い／二郎：期限切れ（本人・グループ・管理者）／三郎：LINE 未登録の一覧（グループ）
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
  assert.equal(textOf(req), 'お疲れさまです。管理本部です。\n運転免許証の有効期限を管理するため、免許証の登録をお願いいたします。\n'
    + '下のボタンを押して、免許証の写真をお送りください。\n※ボタンを押してから画像送付までは30分の有効期限があります。\n'
    + 'ご対応のほどよろしくお願いいたします。\n\n※このメッセージはAIによる自動送信です。');   // 版 2026-11-17a：宛名なし
  assert.deepEqual({ ...req.contents.footer.contents[0].action }, { type: 'postback', label: '免許証を登録する', data: 'lic|1|start', displayText: '免許証を登録します' });
  const grp = push.find((p) => p.body.to === GROUP).body.messages[0].text;
  assert.match(grp, /^【免許証】LINE が未登録のため、免許証の案内を送れない方がいます（1名）\n・90003 試験 三郎\n/);
  assert.equal(val(master, '90001', '状態'), '登録待ち');
  assert.equal(val(master, '90005', '状態'), '対象外（免許なし）');
  const self = (iso) => { day(g, iso); const k = g.fetches.length; g.ctx.licenseDaily(); return since(g, k).push; };
  assert.equal(self('2026-11-17').length, 0);
  push = self('2026-11-19');
  assert.deepEqual(push.map((p) => p.body.to).sort(), [U(1), U(2)].sort());
  assert.equal(textOf(push[0].body.messages[0]), 'お疲れさまです。管理本部です。\n先日お願いした運転免許証の登録が、まだ確認できていません。\n'
    + '下のボタンを押して、免許証の写真をお送りください。\n※ボタンを押してから画像送付までは30分の有効期限があります。\n'
    + 'ご対応のほどよろしくお願いいたします。\n\n※このメッセージはAIによる自動送信です。');   // 版 2026-11-17b：宛名なし
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
  assert.equal(textOf(push[0].body.messages[0]), 'お疲れさまです。管理本部です。\n運転免許証の有効期限（2026年12月16日）まで、あと30日になりました。\n'
    + '更新がお済みになりましたら、「免許更新」と送るか下のボタンを押して、新しい免許証の写真をお送りください。\nいつもご協力ありがとうございます。\n\n※このメッセージはAIによる自動送信です。');
  assert.equal(push[0].body.messages[0].contents.footer.contents[0].action.label, '更新を報告する');
  assert.equal(val(master, '90001', '状態'), '更新待ち');
  assert.equal(run('2026-11-16').length, 0);   // 同じ日にもう一度：送らない
  assert.equal(run('2026-12-08').length, 0);   // 8日前：30日前の段階で送り済み
  push = run('2026-12-09');
  assert.equal(push.length, 1);
  assert.match(textOf(push[0].body.messages[0]), /^お疲れさまです。管理本部です。\n運転免許証の有効期限（2026年12月16日）まで、あと7日です。更新のご報告をまだ確認できていないため/);
  assert.equal(run('2026-12-15').length, 0);
  push = run('2026-12-16');
  assert.equal(push.length, 1);
  assert.match(textOf(push[0].body.messages[0]), /^お疲れさまです。管理本部です。\n運転免許証の有効期限は、本日（2026年12月16日）までです/);
  push = run('2026-12-17');
  assert.deepEqual(push.map((p) => p.body.to).sort(), [U(1), GROUP, ADMIN].sort());
  assert.equal(textOf(push.find((p) => p.body.to === U(1)).body.messages[0]),
    'お疲れさまです。管理本部です。\n運転免許証の有効期限（2026年12月16日）を過ぎましたが、更新のご報告をまだ確認できていません。\n'
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

test('免許証: 更新の報告（ボタン → 写真 → 3年後）。写真は「社員番号_YYYYMMDD_1」で保存し古い写真だけゴミ箱へ。前の期限の催促は止まる', () => {
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
  assert.equal(reply[0].body.messages[0].text, 'お疲れさまです。管理本部です。\n免許証をお手元にご用意ください。\n準備ができましたら、まず表面の写真をお送りください。\n'
    + '有効期限の文字がはっきり写るように撮っていただけますと助かります（30分以内にお願いいたします）。\n\n※このメッセージはAIによる自動送信です。');
  n = g.fetches.length;
  photo(g, U(1));
  ({ reply, push } = since(g, n));
  assert.equal(since(g, n).content.length, 1);
  assert.equal(push.length, 0);   // 問い合わせのお知らせは出ない
  const saved = folder.files.filter((f) => !f.trashed).map((f) => f.name).sort();
  assert.deepEqual(saved, ['90001_20261116_1', '90002_20240101']);
  assert.equal(folder.files.find((f) => f.id === 'old-1').trashed, true);
  assert.equal(val(master, '90001', '写真ファイルID'), folder.files.find((f) => f.name === '90001_20261116_1').id);
  const msg = reply[0].body.messages[0], btns = msg.contents.footer.contents.map((b) => b.action);
  assert.deepEqual(btns.map((b) => b.label), ['2029年12月16日（3年後）', '2031年12月16日（5年後）', 'その他（カレンダーで選ぶ）']);
  assert.equal(btns[2].type, 'datetimepicker');
  assert.equal(btns[2].mode, 'date');
  assert.equal(book.getSheetByName('問い合わせ'), null);   // 写真は問い合わせに入らない
  n = g.fetches.length;
  post(g, pb(U(1), btns[0].data));
  ({ reply, push } = since(g, n));
  assert.equal(push.length, 0);   // 3年後・5年後は管理者へ知らせない
  assert.equal(reply[0].body.messages[0].text, 'お疲れさまです。管理本部です。\n更新のご報告ありがとうございます。\n新しい有効期限を2029年12月16日で記録しました。\n'
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
  assert.equal(since(g, n).reply[0].body.messages[0].text, 'お疲れさまです。管理本部です。\nご登録ありがとうございます。\n運転免許証の有効期限を2029年4月30日で記録しました。\n'
    + '期限が近づきましたら、こちらから改めてご案内いたします。\n\n※このメッセージはAIによる自動送信です。');   // 版 2026-11-17c：宛名なし
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

test('免許証: お知らせ設定の SAF-01 列は残し、「お知らせ種類」に全員必須・この列では止まらないと出す（CRIT には入れない）', () => {
  const { g, master } = setup({}, { files: [...FILES, 'LeaveRequest.gs'] });
  g.ctx.alcoholCheckSetupNoticeSettings();
  const head = master.getSheetByName('お知らせ設定').dump()[0];
  assert.ok(head.includes('SAF-01 運転免許証の更新案内'));
  const saf = master.getSheetByName('お知らせ種類').dump().find((r) => r[0] === 'SAF-01');
  assert.deepEqual([...saf].slice(3, 6), ['お知らせ設定の対象外（別の仕組みで送る）', '全員必須', '止められない（この列のチェックでは止まらない）']);
  assert.match(saf[6], /^全員必須（安全に関わるため）。この列のチェックでは止まらない/);
  assert.ok(!g.ctx.AC_CRITICAL_NOTICES.some((c) => /免許/.test(c.name)));
  assert.equal(master.getSheetByName('お知らせ種類').dump().find((r) => r[0] === 'SAF-02')[5], '止められる');   // ほかは今までどおり
});

// ---------------- 送る範囲 LICENSE_SCOPE（版 2026-11-16c） ----------------
/** 90001・90003 を管理本部に（90003 は LINE 未登録）。90002・90005 は部署A のまま */
function scoped(props) {
  const s = setup({ LICENSE_MODE: 'on', ...props });
  const m = s.master.getSheetByName('従業員マスタ');
  const h = m.dump()[0], i = m.dump().findIndex((r) => r[0] === "'90001" || String(r[0]) === '90001');
  ['90001', '90003'].forEach((c) => { const k = m.dump().findIndex((r) => String(r[0]).replace(/^'/, '') === c); m.getRange(k + 1, h.indexOf('所属・拠点') + 1).setValue(c === '90001' ? '管理本部' : ' 管理本部 '); });
  assert.ok(i > 0);
  s.g.ctx.licenseSetup();
  ['90001', '90002', '90003', '90005'].forEach((c) => set(s.master, c, '免許の有無', 'あり'));
  set(s.master, '90005', '有効期限', '2026-12-16');   // 30日前
  return s;
}
const recRows = (master) => master.getSheetByName('免許証お知らせ記録').dump().slice(1).map((r) => [r[2], String(r[4] || ''), r[6]].join(':'));

test('免許証（範囲）: LICENSE_SCOPE=管理本部 なら、範囲内だけ送り、範囲外は記録のみ（送信記録にも記録済みにも付けない）。一覧も範囲内の人だけ', () => {
  const { g, master } = scoped({ LICENSE_SCOPE: '管理本部' });
  let n = g.fetches.length;
  const r = g.ctx.licenseDaily();
  assert.equal(r.scope, '管理本部');
  assert.equal(r.outScope, 2);
  let { push } = since(g, n);
  assert.deepEqual(push.map((p) => p.body.to).sort(), [U(1), GROUP].sort());   // 一郎：登録のお願い／三郎（管理本部・LINE 未登録）：グループへ一覧
  const grp = push.find((p) => p.body.to === GROUP).body.messages[0].text;
  assert.match(grp, /（1名）\n・90003 試験 三郎\n/);
  assert.deepEqual(recRows(master), ['req:90001:送信済み', 'req:90002:記録のみ（範囲外・送信なし）', 'd30:90005:記録のみ（範囲外・送信なし）', 'noline::送信済み']);
  assert.equal(String(val(master, '90001', '送信記録')), '登録のお願い - 2026-11-16');
  for (const c of ['90002', '90005']) { assert.equal(String(val(master, c, '送信記録')), ''); assert.equal(String(val(master, c, '記録済み')), ''); }
  assert.ok(!g.logs.some((l) => /試験/.test(l)));   // 氏名はログに出さない
  // 次の朝：範囲内は1回だけ。範囲外は印が無いので毎朝「記録のみ」の行が増える（送らない）
  day(g, '2026-11-17');
  n = g.fetches.length;
  const k = recRows(master).length;
  g.ctx.licenseDaily();
  assert.equal(since(g, n).push.length, 0);
  assert.deepEqual(recRows(master).slice(k), ['req:90002:記録のみ（範囲外・送信なし）', 'd30:90005:記録のみ（範囲外・送信なし）']);
  // 3日後の催促も範囲内だけ。10日後のグループへの一覧も範囲内の人だけ
  day(g, '2026-11-19'); n = g.fetches.length; g.ctx.licenseDaily();
  assert.deepEqual(since(g, n).push.map((p) => p.body.to), [U(1)]);
  day(g, '2026-11-23'); n = g.fetches.length; g.ctx.licenseDaily();
  assert.deepEqual(since(g, n).push.map((p) => p.body.to), [U(1)]);
  day(g, '2026-11-26'); n = g.fetches.length; g.ctx.licenseDaily();
  push = since(g, n).push;
  assert.equal(push.length, 1);
  assert.equal(push[0].body.to, GROUP);
  assert.match(push[0].body.messages[0].text, /（1名）\n・90001 試験 一郎\n/);
});

test('免許証（範囲）: 範囲を外す（空にする）と、範囲外だった人にお願い・期限の案内が送られる。範囲内の人には二重に送らない', () => {
  const { g, master } = scoped({ LICENSE_SCOPE: '管理本部' });
  g.ctx.licenseDaily();
  day(g, '2026-11-17');
  g.ctx.licenseDaily();
  g.scriptProps.setProperty('LICENSE_SCOPE', '');
  day(g, '2026-11-18');
  const n = g.fetches.length;
  const r = g.ctx.licenseDaily();
  assert.equal(r.scope, '');
  assert.equal(r.outScope, 0);
  const push = since(g, n).push;
  assert.deepEqual(push.map((p) => p.body.to).sort(), [U(2), U(5)].sort());
  assert.match(textOf(push.find((p) => p.body.to === U(2)).body.messages[0]), /免許証の登録をお願いいたします/);
  assert.match(textOf(push.find((p) => p.body.to === U(5)).body.messages[0]), /あと28日になりました/);
  assert.equal(String(val(master, '90002', '送信記録')), '登録のお願い - 2026-11-18');
  assert.equal(String(val(master, '90001', '送信記録')), '登録のお願い - 2026-11-16');
});

test('免許証（範囲）: licenseRegisterSend も範囲内だけ。record のときも範囲外は記録済みにしない', () => {
  const { g, master } = scoped({ LICENSE_SCOPE: '管理本部' });
  const n = g.fetches.length;
  g.ctx.licenseRegisterSend();
  assert.deepEqual(since(g, n).push.map((p) => p.body.to).sort(), [U(1), GROUP].sort());
  assert.ok(!recRows(master).some((x) => /^d30/.test(x)));   // 期限のお知らせは扱わない
  const b = scoped({ LICENSE_SCOPE: '管理本部', LICENSE_MODE: 'record' });
  const m = b.g.fetches.length;
  b.g.ctx.licenseDaily();
  assert.equal(b.g.fetches.length, m);
  assert.equal(String(val(b.master, '90001', '記録済み')), '登録のお願い - 2026-11-16');
  assert.equal(String(val(b.master, '90002', '記録済み')), '');
  assert.equal(String(val(b.master, '90005', '記録済み')), '');
});

test('免許証（範囲）: licenseScopePreview は送信せず、シートも変えず、範囲・人数・社員番号だけをログに出す（氏名・LINE ID は出さない）', () => {
  const { g, master } = scoped({ LICENSE_SCOPE: ' 管理本部　' });
  const before = JSON.stringify(master.getSheets().map((s) => s.dump()));
  const n = g.fetches.length, l = g.logs.length;
  const r = g.ctx.licenseScopePreview();
  assert.equal(g.fetches.length, n);
  assert.equal(JSON.stringify(master.getSheets().map((s) => s.dump())), before);
  assert.equal(r.scope, '管理本部');
  assert.equal(r.known, true);
  assert.deepEqual([...r.inScope], ['90001', '90003']);
  assert.deepEqual([...r.noLine], ['90003']);
  assert.deepEqual([...r.req], ['90001']);
  assert.equal(r.outScope, 2);
  const out = g.logs.slice(l).join('\n');
  assert.match(out, /範囲内の在籍者 %s人：%s 2 90001, 90003/);   // 模擬の Logger は %s を置き換えずに後ろへ並べる
  assert.ok(!/試験|U1{10}/.test(out));
  // 綴りが違うときは 0人で、注意を出す
  g.scriptProps.setProperty('LICENSE_SCOPE', '管理部');
  const w = g.ctx.licenseScopePreview();
  assert.equal(w.known, false);
  assert.equal(w.inScope.length, 0);
  assert.match(g.logs.slice(-5).join('\n'), /この所属がありません/);
  // 未設定なら全員
  g.scriptProps.setProperty('LICENSE_SCOPE', '');
  assert.equal(g.ctx.licenseScopePreview().inScope.length, 4);
});

// ---------------- 複数枚の写真（版 2026-11-17a） ----------------
function multi() {
  const s = setup();
  s.g.ctx.licenseSetup();
  set(s.master, '90001', '免許の有無', 'あり');
  ['90002', '90003', '90005'].forEach((c) => set(s.master, c, '免許の有無', 'なし'));
  s.folder = s.g.drive.folders[FOLDER];
  s.folder.files.push({ id: 'other', name: '90002_20240101', type: 'image/jpeg', trashed: false });
  return s;
}
const alive = (folder) => folder.files.filter((f) => !f.trashed).map((f) => f.name).sort();

test('免許証（複数枚）: 表 → 裏の2枚がどちらも残り、IDが両方タブに入る。2枚目は短いお礼だけ（期限のボタンは重ねない）', () => {
  const { g, master, folder } = multi();
  post(g, pb(U(1), 'lic|1|start'));
  let n = g.fetches.length;
  photo(g, U(1));
  const first = since(g, n).reply[0].body.messages[0];
  assert.equal(first.type, 'flex');   // 1枚目：期限のボタン
  n = g.fetches.length;
  photo(g, U(1));
  const r = since(g, n);
  assert.equal(r.content.length, 1);
  assert.equal(r.reply.length, 1);
  assert.deepEqual(r.reply[0].body.messages.map((m) => m.type), ['text']);
  assert.equal(r.reply[0].body.messages[0].text, '2枚目の写真も保存しました。ありがとうございます。\n\n※このメッセージはAIによる自動送信です。');
  assert.deepEqual(alive(folder), ['90001_20261116_1', '90001_20261116_2', '90002_20240101']);
  const ids = ['90001_20261116_1', '90001_20261116_2'].map((nm) => folder.files.find((f) => f.name === nm).id);
  assert.equal(val(master, '90001', '写真ファイルID'), ids.join(','));
  // 1枚目のボタンで期限を選べる
  n = g.fetches.length;
  post(g, pb(U(1), first.contents.footer.contents[0].action.data, { date: '2029-04-30' }));
  assert.match(since(g, n).reply[0].body.messages[0].text, /ご登録ありがとうございます/);
  assert.equal(ymd(val(master, '90001', '有効期限')), '2029-04-30');
  assert.ok(!g.logs.some((l) => /試験|90001_2026/.test(l)));
});

test('免許証（複数枚）: 期限を選んだあと10分以内の写真は同じ回として残り、10分を過ぎたら受け付けない（問い合わせ）', () => {
  const { g, master, book, folder } = multi();
  post(g, pb(U(1), 'lic|1|start'));
  let n = g.fetches.length;
  photo(g, U(1));
  const btn = since(g, n).reply[0].body.messages[0].contents.footer.contents[0].action;
  g.clock.now += 25 * 60000;   // 始めてから25分で期限を選ぶ → そこから10分（35分まで）受け付ける
  post(g, pb(U(1), btn.data, { date: '2029-04-30' }));
  g.clock.now += 9 * 60000;    // 選んでから9分（始めてから34分）
  n = g.fetches.length;
  photo(g, U(1));
  assert.equal(since(g, n).content.length, 1);
  assert.match(since(g, n).reply[0].body.messages[0].text, /^2枚目の写真も保存しました/);
  assert.deepEqual(alive(folder), ['90001_20261116_1', '90001_20261116_2', '90002_20240101']);
  assert.equal(String(val(master, '90001', '写真ファイルID')).split(',').length, 2);
  g.clock.now += 2 * 60000;    // 選んでから11分
  n = g.fetches.length;
  photo(g, U(1));
  assert.equal(since(g, n).content.length, 0);
  assert.equal(book.getSheetByName('問い合わせ').dump().slice(1).length, 1);   // 今までどおり問い合わせ
  assert.equal(alive(folder).length, 3);
  // 早く選んだとき：選んでから10分を過ぎれば、始めてから30分以内でも受け付けない
  const b = multi();
  post(b.g, pb(U(1), 'lic|1|start'));
  let m = b.g.fetches.length;
  photo(b.g, U(1));
  post(b.g, pb(U(1), since(b.g, m).reply[0].body.messages[0].contents.footer.contents[0].action.data, { date: '2029-04-30' }));
  b.g.clock.now += 11 * 60000;
  m = b.g.fetches.length;
  photo(b.g, U(1));
  assert.equal(since(b.g, m).content.length, 0);
});

test('免許証（複数枚）: 次の回の写真が来たら、前の回の写真がすべてゴミ箱へ（ほかの人の写真は残す）', () => {
  const { g, master, folder } = multi();
  set(master, '90001', '有効期限', '2026-12-16');
  post(g, ev(U(1), '免許更新'));
  let n = g.fetches.length;
  photo(g, U(1)); photo(g, U(1));
  const btn = since(g, n).reply[0].body.messages[0].contents.footer.contents[0].action;
  post(g, pb(U(1), btn.data));
  assert.deepEqual(alive(folder), ['90001_20261116_1', '90001_20261116_2', '90002_20240101']);
  day(g, '2029-11-20');
  post(g, ev(U(1), '免許更新'));   // 次の回
  assert.equal(alive(folder).length, 3);   // 写真が来るまでは消さない
  n = g.fetches.length;
  photo(g, U(1));
  assert.equal(since(g, n).reply[0].body.messages[0].type, 'flex');   // 新しい回の1枚目：期限のボタン
  assert.deepEqual(alive(folder), ['90001_20291120_1', '90002_20240101']);
  photo(g, U(1));
  assert.deepEqual(alive(folder), ['90001_20291120_1', '90001_20291120_2', '90002_20240101']);
  assert.equal(folder.files.filter((f) => f.trashed).length, 2);
  assert.equal(String(val(master, '90001', '写真ファイルID')).split(',').length, 2);
});

test('免許証（複数枚）: 純粋関数（受付の時間・ファイル名）', () => {
  const X = setup().g.ctx;
  const t0 = 1e12, min = 60000;
  assert.equal(X.LIC_isWaiting(null, t0), false);
  assert.equal(X.LIC_isWaiting({ at: t0 }, t0 + 30 * min), true);
  assert.equal(X.LIC_isWaiting({ at: t0 }, t0 + 30 * min + 1), false);
  assert.equal(X.LIC_isWaiting({ at: t0, doneAt: t0 + 28 * min }, t0 + 38 * min), true);
  assert.equal(X.LIC_isWaiting({ at: t0, doneAt: t0 + 2 * min }, t0 + 13 * min), false);
  assert.equal(X.LIC_photoName('90001', '2026-11-17', 2), '90001_20261117_2');
  assert.equal(X.LIC_isPhotoOf('90001_20261117_2', '90001'), true);
});

// ---------------- AI による写真の確認（版 2026-11-18a・Claude API は模擬。実際には呼ばない） ----------------
const KEY = 'fake-key-for-test';
const FRONT = (exp) => ({ json: { is_license: true, side: 'front', readable: true, problems: [], expiry: exp } });
const BACK = { json: { is_license: true, side: 'back', readable: true, problems: [], expiry: null } };
const BAD = (p) => ({ json: { is_license: true, side: 'unknown', readable: false, problems: [p], expiry: null } });
const NOTLIC = { json: { is_license: false, side: 'unknown', readable: true, problems: ['not_license'], expiry: null } };
const NOTE = '\n\n※このメッセージはAIによる自動送信です。';
function aiSetup(mode = 'on', extra = {}) {
  const s = setup({ LICENSE_MODE: 'on', LICENSE_AI_CHECK: mode, ANTHROPIC_API_KEY: KEY, ...extra });
  s.g.ctx.licenseSetup();
  set(s.master, '90001', '免許の有無', 'あり');
  set(s.master, '90002', '免許の有無', 'あり');
  ['90003', '90005'].forEach((c) => set(s.master, c, '免許の有無', 'なし'));
  s.folder = s.g.drive.folders[FOLDER];
  return s;
}
/** 写真を送り、そのとき本人へ返した（またはプッシュした）文と、管理者へのプッシュを返す */
const shot = (g, uid, ...ai) => {
  g.ai.queue.push(...ai);
  const n = g.fetches.length;
  photo(g, uid);
  const r = since(g, n);
  const toUser = r.reply.concat(r.push.filter((p) => p.body.to === uid)).map((x) => x.body.messages[0]);
  return { msgs: toUser, admin: r.push.filter((p) => p.body.to === ADMIN).map((p) => p.body.messages[0].text), content: r.content.length };
};
const mine = (folder, code = '90001') => folder.files.filter((f) => !f.trashed && f.name.startsWith(code + '_')).map((f) => f.name).sort();

const THANKS_REG = (d) => 'お疲れさまです。管理本部です。\nご登録ありがとうございます。\n運転免許証の有効期限を' + d + 'で記録しました。\n'
  + '日付が違う場合は、このトークでお知らせください。\n期限が近づきましたら、こちらから改めてご案内いたします。' + NOTE;
const FRONT_OK = '表面の写真を確認しました。\n続けて、裏面の写真をお送りください。' + NOTE;
const NEED_FRONT = '裏面の写真を受け取りました。\n続けて、表面の写真をお送りください。' + NOTE;
/** 1回の Webhook に、いくつかの写真をまとめて送る（imageSet：一緒に選んで送ったとき） */
const shots = (g, uid, ais, { imageSet = true } = {}) => {
  g.ai.queue.push(...ais);
  const evs = ais.map((_, k) => { const e = ev(uid, { type: 'image', ...(imageSet ? { imageSet: { id: 'set-' + seq, index: k + 1, total: ais.length } } : {}) }); g.line.contents[e.message.id] = { type: 'image/jpeg' }; return e; });
  const n = g.fetches.length;
  post(g, ...evs);
  const r = since(g, n);
  return { msgs: r.reply.concat(r.push.filter((p) => p.body.to === uid)).map((x) => x.body.messages[0]), admin: r.push.filter((p) => p.body.to === ADMIN).map((p) => p.body.messages[0].text) };
};
const START = 'お疲れさまです。管理本部です。\n免許証をお手元にご用意ください。\n準備ができましたら、まず表面の写真をお送りください。\n'
  + '有効期限の文字がはっきり写るように撮っていただけますと助かります（30分以内にお願いいたします）。' + NOTE;

test('免許証（AI）: on・受付の文 → 表面（期限を記録・お礼はまだ）→ 裏面（お礼を1回）。2枚目の写真の文は使わない。AI へは写真だけ', () => {
  const { g, master, folder } = aiSetup();
  let n = g.fetches.length;
  post(g, pb(U(1), 'lic|1|start'));
  assert.equal(since(g, n).reply[0].body.messages[0].text, START);
  const f = shot(g, U(1), FRONT('2029-04-30'));
  assert.deepEqual(f.msgs.map((m) => m.text), [FRONT_OK]);
  assert.deepEqual(f.admin, []);
  assert.equal(ymd(val(master, '90001', '有効期限')), '2029-04-30');   // この時点で記録
  assert.equal(val(master, '90001', '状態'), '登録済み');
  assert.equal(val(master, '90001', 'AI確認'), 'OK');
  assert.deepEqual(mine(folder), ['90001_20261116_1']);
  const call = g.ai.calls[0];
  assert.equal(call.opt.headers['x-api-key'], KEY);
  assert.equal(call.body.model, 'claude-sonnet-5-5');
  assert.equal(call.body.output_config.format.type, 'json_schema');
  const sent = JSON.stringify(call.body);
  assert.ok(!sent.includes('試験') && !sent.includes(U(1)) && !sent.includes('90001'));
  assert.ok(g.fetches.some((x) => x.url.endsWith('/chat/loading/start')));
  const b = shot(g, U(1), BACK);
  assert.deepEqual(b.msgs.map((m) => m.text), [THANKS_REG('2029年4月30日')]);
  assert.deepEqual(b.admin, []);
  assert.deepEqual(mine(folder), ['90001_20261116_1', '90001_20261116_2']);
  assert.equal(String(val(master, '90001', '写真ファイルID')).split(',').length, 2);
  // 済んだあとの写真：保存だけで返信しない（「2枚目の写真も保存しました」は使わない）
  const c = shot(g, U(1), BACK);
  assert.deepEqual(c.msgs, []);
  assert.ok(!g.fetches.some((x) => /枚目の写真も保存しました/.test(JSON.stringify(x.body || ''))));
  assert.ok(!g.logs.some((l) => l.includes(KEY) || /試験|2029/.test(l)));
  // 翌朝：裏面は届いているので、裏面のお願いは送らない
  day(g, '2026-11-17'); n = g.fetches.length;
  g.ctx.licenseDaily();
  assert.equal(since(g, n).push.filter((p) => p.body.to === U(1)).length, 0);
});

test('免許証（AI）: on・裏面が先 → 「表面をお送りください」→ 表面でお礼（更新）。前と同じ期限の再登録は要確認にしない', () => {
  const { g, master } = aiSetup();
  set(master, '90001', '有効期限', '2028-11-30');
  post(g, ev(U(1), '免許更新'));
  const b = shot(g, U(1), BACK);
  assert.deepEqual(b.msgs.map((m) => m.text), [NEED_FRONT]);
  assert.equal(val(master, '90001', 'AI確認'), 'OK（裏面）');
  const f = shot(g, U(1), FRONT('2028-11-30'));   // 前と同じ期限
  assert.equal(f.msgs.length, 1);
  assert.match(f.msgs[0].text, /^お疲れさまです。管理本部です。\n更新のご報告ありがとうございます。\n新しい有効期限を2028年11月30日で記録しました。/);
  assert.ok(!f.msgs[0].text.includes('裏面'));
  assert.deepEqual(f.admin, []);
  assert.notEqual(val(master, '90001', '状態'), '要確認');
  assert.equal(val(master, '90001', 'AI確認'), 'OK');
});

test('免許証（AI）: on・表と裏を一緒に送ったら（同時に届いても）返すのは1通だけ。順番が裏 → 表でも、まとめて届いた別々の写真でも重ならない', () => {
  for (const order of [[FRONT('2029-04-30'), BACK], [BACK, FRONT('2029-04-30')]]) {
    const { g, master, folder } = aiSetup();
    post(g, pb(U(1), 'lic|1|start'));
    const r = shots(g, U(1), order);
    assert.deepEqual(r.msgs.map((m) => m.text), [THANKS_REG('2029年4月30日')]);
    assert.deepEqual(r.admin, []);
    assert.equal(ymd(val(master, '90001', '有効期限')), '2029-04-30');
    assert.deepEqual(mine(folder), ['90001_20261116_1', '90001_20261116_2']);
  }
  // 1枚ずつ送ったものが1回の Webhook にまとまって届いた（imageSet なし）：上の順で各1通
  const { g } = aiSetup();
  post(g, pb(U(1), 'lic|1|start'));
  const r = shots(g, U(1), [FRONT('2029-04-30'), BACK], { imageSet: false });
  assert.deepEqual(r.msgs.map((m) => m.text), [FRONT_OK, THANKS_REG('2029年4月30日')]);
  // 一緒に送った片方が読めない：その面の再送のお願いだけ（表面の案内は重ねない）
  const s = aiSetup();
  post(s.g, pb(U(1), 'lic|1|start'));
  const x = shots(s.g, U(1), [FRONT('2029-04-30'), BAD('blur')]);
  assert.equal(x.msgs.length, 1);
  assert.match(x.msgs[0].text, /写真は、ぼやけているため、.*\n.*\nお手数ですが、もう一度裏面の写真をお送りいただけますでしょうか。/s);
  assert.deepEqual(shot(s.g, U(1), BACK).msgs.map((m) => m.text), [THANKS_REG('2029年4月30日')]);
});

test('免許証（AI）: on・表面だけで裏面が30分以内に届かなければ、期限は記録したまま翌朝に1回だけお願い。「免許更新」で裏面だけを受け付ける', () => {
  const { g, master, folder } = aiSetup();
  post(g, pb(U(1), 'lic|1|start'));
  shot(g, U(1), FRONT('2029-04-30'));
  g.clock.now += 31 * 60000;   // 表面から31分：受付は終わり
  assert.equal(shot(g, U(1)).content, 0);
  // 同じ日の朝の処理（まだ翌朝ではない）では送らない
  let n = g.fetches.length;
  g.ctx.licenseDaily();
  assert.equal(since(g, n).push.filter((p) => p.body.to === U(1)).length, 0);
  day(g, '2026-11-17'); n = g.fetches.length;
  g.ctx.licenseDaily();
  const p = since(g, n).push.filter((x) => x.body.to === U(1));
  assert.equal(p.length, 1);
  assert.equal(textOf(p[0].body.messages[0]), '裏面の写真がまだ届いていません。お手すきの際に『免許更新』と送り、裏面の写真をお送りください。' + NOTE);
  assert.equal(p[0].body.messages[0].contents.footer, undefined);   // ボタンなし
  assert.equal(ymd(val(master, '90001', '有効期限')), '2029-04-30');
  day(g, '2026-11-18'); n = g.fetches.length;
  g.ctx.licenseDaily();
  assert.equal(since(g, n).push.filter((x) => x.body.to === U(1)).length, 0);   // 1回だけ
  // 「免許更新」→ 裏面だけの受付 → 裏面でお礼。前の写真（表面）は消さない
  n = g.fetches.length;
  post(g, ev(U(1), '免許更新'));
  assert.equal(since(g, n).reply[0].body.messages[0].text, 'お疲れさまです。管理本部です。\n免許証の裏面の写真を、このトークにお送りください（30分以内にお願いいたします）。' + NOTE);
  const b = shot(g, U(1), BACK);
  assert.deepEqual(b.msgs.map((m) => m.text), ['お疲れさまです。管理本部です。\n裏面の写真を受け取りました。ありがとうございます。\n有効期限は2029年4月30日で記録しています。' + NOTE]);
  assert.deepEqual(mine(folder), ['90001_20261116_1', '90001_20261118_2']);
  assert.equal(String(val(master, '90001', '写真ファイルID')).split(',').length, 2);
  // 裏面が届いたので、次の「免許更新」はふつうの受付
  n = g.fetches.length;
  post(g, ev(U(1), '免許更新'));
  assert.equal(since(g, n).reply[0].body.messages[0].text, START);
  // 純粋関数
  const X = g.ctx;
  assert.equal(X.LIC_backPending('裏面待ち 2029-04-30 2026-11-16', '2029-04-30', '2026-11-17'), true);
  assert.equal(X.LIC_backPending('裏面待ち 2029-04-30 2026-11-17', '2029-04-30', '2026-11-17'), false);
  assert.equal(X.LIC_backPending('裏面待ち 2029-04-30 2026-11-16\n裏面受領 2029-04-30 2026-11-16', '2029-04-30', '2026-11-17'), false);
  assert.equal(X.LIC_backPending('裏面待ち 2026-12-16 2026-11-16', '2029-04-30', '2026-11-17'), false);
  assert.equal(X.LIC_backPending('裏面待ち 2029-04-30 2026-11-01', '2029-04-30', '2026-11-16', 14), false);
  assert.equal(X.LIC_backPending('裏面待ち 2029-04-30 2026-11-02', '2029-04-30', '2026-11-16', 14), true);
});

test('免許証（AI）: on・ぼやけた写真は保存せず理由を添えてその面の再送をお願いし（前の回の写真も消さない）、受付を30分延ばす', () => {
  const { g, master, folder } = aiSetup();
  folder.files.push({ id: 'old', name: '90001_20231201_1', type: 'image/jpeg', trashed: false });
  post(g, pb(U(1), 'lic|1|start'));
  g.clock.now += 25 * 60000;
  const r = shot(g, U(1), BAD('blur'));
  assert.equal(r.msgs[0].text, 'お疲れさまです。管理本部です。\nお送りいただいた写真は、ぼやけているため、文字を読み取れませんでした。\n'
    + '免許証を机などに置き、ピントが合ってから撮ってください。\nお手数ですが、もう一度表面の写真をお送りいただけますでしょうか。' + NOTE);
  assert.deepEqual(mine(folder), ['90001_20231201_1']);   // 保存しない・前の回の写真も残る
  assert.match(String(val(master, '90001', 'AI確認')), /^再送依頼（ぼやけている）/);
  g.clock.now += 25 * 60000;   // 始めてから50分（再送のお願いから25分）でも受け付ける
  const ok = shot(g, U(1), FRONT('2029-04-30'));
  assert.deepEqual(ok.msgs.map((m) => m.text), [FRONT_OK]);
  assert.deepEqual(mine(folder), ['90001_20261116_1']);   // 新しい回の1枚目で、前の回の写真はゴミ箱へ
  // 裏面が読めない → 裏面の再送のお願い。2回続けば、表面は記録済みなのでお礼で終える
  assert.match(shot(g, U(1), BAD('dark')).msgs[0].text, /写真は、暗いため、.*\n明るい場所で撮ってください。\nお手数ですが、もう一度裏面の写真をお送りいただけますでしょうか。/s);
  const last = shot(g, U(1), BAD('glare'));
  assert.deepEqual(last.msgs.map((m) => m.text), [THANKS_REG('2029年4月30日')]);
  assert.deepEqual(mine(folder), ['90001_20261116_1', '90001_20261116_2']);
});

test('免許証（AI）: on・暗い → 免許証以外と2回続けて読み取れなければ、期限のボタン・要確認・安藤さんへ社員番号だけ', () => {
  const { g, master, folder } = aiSetup();
  post(g, pb(U(1), 'lic|1|start'));
  const a = shot(g, U(1), BAD('dark'));
  assert.match(a.msgs[0].text, /写真は、暗いため、文字を読み取れませんでした。\n明るい場所で撮ってください。/);
  const b = shot(g, U(1), NOTLIC);
  assert.equal(b.msgs[0].type, 'flex');
  assert.equal(textOf(b.msgs[0]), '写真から有効期限を読み取れませんでした。\nお手数ですが、免許証に書かれている有効期限を、下のボタンから選んでください。' + NOTE);
  assert.equal(b.msgs[0].contents.footer.contents[0].action.type, 'datetimepicker');
  assert.deepEqual(mine(folder), []);   // 免許証以外の写真は保存しない
  assert.equal(val(master, '90001', '状態'), '要確認');
  assert.equal(val(master, '90001', 'AI確認'), '要確認（読み取れず）');
  assert.equal(b.admin.length, 1);
  assert.match(b.admin[0], /^【免許証・要確認】社員番号 90001：写真から有効期限を2回続けて読み取れなかったため/);
  assert.ok(!b.admin[0].includes('試験'));
  // ボタンで選んでも要確認のまま
  const n = g.fetches.length;
  post(g, pb(U(1), b.msgs[0].contents.footer.contents[0].action.data, { date: '2029-04-30' }));
  assert.match(since(g, n).reply[0].body.messages[0].text, /ご登録ありがとうございます/);
  assert.equal(ymd(val(master, '90001', '有効期限')), '2029-04-30');
  assert.equal(val(master, '90001', '状態'), '要確認');
});

test('免許証（AI）: on・はみ出し・反射・免許証以外の文面（免許証以外は、待っている面を撮ってもらう）', () => {
  const { g } = aiSetup();
  post(g, pb(U(1), 'lic|1|start'));
  assert.match(shot(g, U(1), BAD('cutoff')).msgs[0].text, /写真は、免許証の一部が写っていないため、.*\n免許証の四隅がすべて入るように撮ってください。/);
  assert.deepEqual(shot(g, U(1), BACK).msgs.map((m) => m.text), [NEED_FRONT]);
  const gl = shot(g, U(1), BAD('glare'));   // 失敗が続いたのではない（裏面で数え直し）
  assert.match(gl.msgs[0].text, /写真は、光が反射しているため、.*\nお手数ですが、もう一度表面の写真を/s);
  const s = aiSetup();
  post(s.g, pb(U(1), 'lic|1|start'));
  shot(s.g, U(1), FRONT('2029-04-30'));
  assert.match(shot(s.g, U(1), NOTLIC).msgs[0].text, /運転免許証ではないように見えるため、.*\n運転免許証の裏面を撮ってお送りください。\nお手数ですが、もう一度裏面の写真を/s);
});

test('免許証（AI）: on・読み取った日付の確かめ（1年以上前・10年以上先・更新で前の期限より前）は記録して要確認・安藤さんへ社員番号と日付。前と同じ日付は要確認にしない', () => {
  const cases = [['2036-11-16', '', '日付の範囲外'], ['2025-11-16', '', '日付の範囲外'], ['2036-11-15', '', ''], ['2025-11-17', '', ''],
    ['2026-12-15', '2026-12-16', '前の期限より前'], ['2026-12-16', '2026-12-16', ''], ['2029-12-16', '2026-12-16', '']];
  for (const [exp, base, label] of cases) {
    const { g, master } = aiSetup();
    if (base) set(master, '90001', '有効期限', base);
    post(g, ev(U(1), '免許更新'));
    const r = shot(g, U(1), FRONT(exp));
    assert.deepEqual(r.msgs.map((m) => m.text), [FRONT_OK], exp);
    assert.equal(ymd(val(master, '90001', '有効期限')), exp);
    if (label) {
      assert.equal(val(master, '90001', '状態'), '要確認', exp);
      assert.equal(val(master, '90001', 'AI確認'), '要確認（' + label + '）');
      assert.equal(r.admin.length, 1);
      assert.match(r.admin[0], new RegExp('^【免許証・要確認】社員番号 90001：写真から読み取った有効期限 ' + exp));
      assert.ok(!r.admin[0].includes('試験'));
    } else {
      assert.notEqual(val(master, '90001', '状態'), '要確認', exp);
      assert.deepEqual(r.admin, [], exp);
    }
    // 裏面のお礼は、更新なら更新のお礼（表面のあとに期限が書き換わっても、始めたときの期限で決める）
    assert.match(shot(g, U(1), BACK).msgs[0].text, base ? /更新のご報告ありがとうございます/ : /ご登録ありがとうございます/, exp);
  }
});

test('免許証（AI）: on・AI のエラー・キー未設定・上限超え・断られた・応答が読めないときは、保存して期限のボタン・要確認（安藤さんへは理由ごとに1日1回＋社員番号）', () => {
  const { g, master, folder } = aiSetup('on', { LICENSE_AI_DAILY_MAX: '3' });
  post(g, pb(U(1), 'lic|1|start'));
  const r = shot(g, U(1), { status: 529 });
  assert.equal(r.msgs[0].type, 'flex');
  assert.match(textOf(r.msgs[0]), /^写真を受け取りました。ありがとうございます。\n続けて、免許証に書かれている有効期限を/);
  assert.deepEqual(mine(folder), ['90001_20261116_1']);
  assert.equal(val(master, '90001', '状態'), '要確認');
  assert.equal(val(master, '90001', 'AI確認'), '未確認（AIのエラー）');
  assert.equal(r.admin.length, 2);
  assert.match(r.admin[0], /^【免許証】AI による写真の確認ができませんでした（AIのエラー・HTTP 529）/);
  assert.match(r.admin[1], /^【免許証・要確認】社員番号 90001：写真を AI で確認できなかったため（AIのエラー）/);
  // 同じ日の2人目：エラーの知らせは重ねない
  post(g, pb(U(2), 'lic|1|start'));
  const r2 = shot(g, U(2), { status: 500 });
  assert.equal(r2.admin.length, 1);
  assert.match(r2.admin[0], /社員番号 90002/);
  // 断られた・応答が読めない → ボタン（エラーの知らせは出さない）
  for (const resp of [{ refusal: true }, { text: 'not json' }, { throw: true }]) {
    const s = aiSetup();
    post(s.g, pb(U(1), 'lic|1|start'));
    const x = shot(s.g, U(1), resp);
    assert.equal(x.msgs[0].type, 'flex');
    assert.equal(val(s.master, '90001', '状態'), '要確認');
  }
  // 上限（この日 3枚）：3枚目の表面は AI へ。4枚目（裏面）は AI へ送らず、表面は記録済みなのでお礼で終える
  const before = g.ai.calls.length;
  post(g, ev(U(1), '免許更新'));
  shot(g, U(1), FRONT('2029-04-30'));
  assert.equal(g.ai.calls.length, before + 1);
  const lim = shot(g, U(1));
  assert.equal(g.ai.calls.length, before + 1);
  assert.match(lim.msgs[0].text, /有効期限を2029年4月30日で記録しました/);
  assert.equal(lim.admin.length, 1);
  assert.match(lim.admin[0], /^【免許証】AI による写真の確認ができませんでした（1日の上限）/);
  // 次の人（表面より前）：ボタン・要確認
  post(g, ev(U(2), '免許更新'));
  const lim2 = shot(g, U(2));
  assert.equal(lim2.msgs[0].type, 'flex');
  assert.equal(val(master, '90002', 'AI確認'), '未確認（1日の上限）');
  assert.equal(lim2.admin.length, 1);   // 上限の知らせは重ねない
  assert.match(lim2.admin[0], /^【免許証・要確認】社員番号 90002：写真を AI で確認できなかったため（1日の上限）/);
  // キー未設定
  const k = aiSetup('on', { ANTHROPIC_API_KEY: '' });
  post(k.g, pb(U(1), 'lic|1|start'));
  const kr = shot(k.g, U(1));
  assert.equal(k.g.ai.calls.length, 0);
  assert.equal(kr.msgs[0].type, 'flex');
  assert.equal(val(k.master, '90001', 'AI確認'), '未確認（キー未設定）');
});

test('免許証（AI）: on・ボタンで選んだ期限が、同じ回の写真から読み取った期限と違えば要確認・安藤さんへ（社員番号と2つの日付）', () => {
  const { g, master } = aiSetup();
  post(g, pb(U(1), 'lic|1|start'));
  const r = shot(g, U(1), { status: 529 });   // AI が使えずボタン
  shot(g, U(1), FRONT('2029-04-30'));        // 2枚目は読めた
  const n = g.fetches.length;
  post(g, pb(U(1), r.msgs[0].contents.footer.contents[0].action.data, { date: '2029-05-30' }));
  const adm = since(g, n).push.filter((p) => p.body.to === ADMIN).map((p) => p.body.messages[0].text);
  assert.equal(adm.length, 1);
  assert.match(adm[0], /^【免許証・要確認】社員番号 90001：ボタンで選んだ有効期限 2029-05-30 と、写真から読み取った 2029-04-30 が違うため/);
  assert.equal(val(master, '90001', '状態'), '要確認');
  assert.equal(val(master, '90001', 'AI確認'), '要確認（日付違い・写真 2029-04-30）');
});

test('免許証（AI）: record・AI の判定を「AI確認」に書くだけ（本人へはボタン・再送のお願いなし・要確認にしない・安藤さんへ送らない）', () => {
  const { g, master, folder } = aiSetup('record');
  post(g, pb(U(1), 'lic|1|start'));
  const r = shot(g, U(1), FRONT('2029-04-30'));
  assert.equal(g.ai.calls.length, 1);
  assert.equal(r.msgs[0].type, 'flex');   // 今までどおり期限のボタン
  assert.equal(val(master, '90001', 'AI確認'), '記録：OK（表面・期限 2029-04-30）');
  assert.equal(String(val(master, '90001', '有効期限')), '');
  const d = shot(g, U(1), BAD('dark'));
  assert.match(d.msgs[0].text, /^2枚目の写真も保存しました/);   // 再送のお願いはしない・保存する
  assert.deepEqual(mine(folder), ['90001_20261116_1', '90001_20261116_2']);
  assert.equal(val(master, '90001', 'AI確認'), '記録：再送依頼相当（暗い）');
  const n = g.fetches.length;
  post(g, pb(U(1), r.msgs[0].contents.footer.contents[0].action.data, { date: '2029-05-30' }));
  assert.equal(since(g, n).push.length, 0);
  assert.equal(val(master, '90001', '状態'), '登録済み');
  assert.equal(val(master, '90001', 'AI確認'), '記録：要確認（日付違い・写真 2029-04-30）');
});

test('免許証（AI）: off（未設定）なら AI を呼ばず、「…」も出さず、今までどおり', () => {
  const { g, master } = aiSetup('');
  post(g, pb(U(1), 'lic|1|start'));
  const r = shot(g, U(1));
  assert.equal(g.ai.calls.length, 0);
  assert.ok(!g.fetches.some((f) => f.url.endsWith('/chat/loading/start')));
  assert.equal(r.msgs[0].type, 'flex');
  assert.equal(String(val(master, '90001', 'AI確認')), '');
  assert.notEqual(val(master, '90001', '状態'), '要確認');
});

test('免許証（AI）: licenseAiRecheck は保存済みの写真から読み取った期限とタブの期限を比べて「AI確認」に書く（本人へ送らない・状態は変えない・ログは社員番号だけ）', () => {
  const { g, master, folder } = aiSetup('');
  folder.files.push({ id: 'p1', name: '90001_20261101_1', type: 'image/jpeg', trashed: false, bytes: { length: 1000, tag: 'p1' } },
    { id: 'p2b', name: '90002_20261101_1', type: 'image/jpeg', trashed: false }, { id: 'p2f', name: '90002_20261101_2', type: 'image/jpeg', trashed: false });
  set(master, '90001', '有効期限', '2029-04-30'); set(master, '90001', '写真ファイルID', 'p1');
  set(master, '90002', '有効期限', '2028-01-10'); set(master, '90002', '写真ファイルID', 'p2b,p2f');
  const st = [val(master, '90001', '状態'), val(master, '90002', '状態')];
  g.ai.queue.push(FRONT('2029-04-30'), BACK, FRONT('2028-02-10'));
  const n = g.fetches.length;
  const res = g.ctx.licenseAiRecheck();
  assert.deepEqual({ checked: res.checked, ok: res.ok, diff: res.diff }, { checked: 2, ok: 1, diff: 1 });
  assert.equal(since(g, n).push.length + since(g, n).reply.length, 0);
  assert.equal(val(master, '90001', 'AI確認'), 'OK（再確認 2026-11-16）');
  assert.equal(val(master, '90002', 'AI確認'), '要確認（日付違い・写真 2028-02-10・再確認 2026-11-16）');
  assert.deepEqual([val(master, '90001', '状態'), val(master, '90002', '状態')], st);
  assert.ok(g.logs.some((l) => /90002 日付違い/.test(l)));
  assert.ok(!g.logs.some((l) => /試験|2028|2029/.test(l)));
});

test('免許証（AI）: 純粋関数（応答の読み取り・判定・日付の確かめ・写真の扱い）', () => {
  const X = setup().g.ctx;
  const body = (o) => JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(o) }] });
  assert.equal(X.LIC_aiParse(JSON.stringify({ stop_reason: 'refusal', content: [] })).error, 'refusal');
  assert.equal(X.LIC_aiParse('<html>').error, 'parse');
  assert.equal(X.LIC_aiParse(body({ is_license: true })).error, 'parse');
  const ok = X.LIC_aiParse(body({ is_license: true, side: 'front', readable: true, problems: ['blur', 'xxx'], expiry: '2029-02-30' })).res;
  assert.deepEqual([...ok.problems], ['blur']);
  assert.equal(ok.expiry, '');   // 日付として読めない → 期限なし（再送のお願い）
  const j = (res, base = '') => X.LIC_aiJudge({ isLicense: true, side: 'front', readable: true, problems: [], expiry: '', ...res }, '2026-11-16', base);
  assert.deepEqual({ ...j({ readable: false, problems: ['blur', 'glare'] }) }, { kind: 'retry', reason: 'glare', side: 'front' });
  assert.equal(j({ isLicense: false }).reason, 'not_license');
  assert.equal(j({}).reason, 'noexp');
  assert.equal(j({ side: 'back' }).kind, 'back');
  assert.equal(j({ expiry: '2029-01-01' }).kind, 'front');
  assert.equal(X.LIC_aiDateCheck('2025-11-17', '2026-11-16', ''), '');
  assert.equal(X.LIC_aiDateCheck('2025-11-16', '2026-11-16', ''), 'range');
  assert.equal(X.LIC_aiDateCheck('2036-11-15', '2026-11-16', ''), '');
  assert.equal(X.LIC_aiDateCheck('2036-11-16', '2026-11-16', ''), 'range');
  assert.equal(X.LIC_aiDateCheck('2029-12-16', '2026-12-16', '2026-12-16'), '');
  assert.equal(X.LIC_aiDateCheck('2026-12-16', '2026-11-16', '2026-12-16'), '');        // 前と同じ日付は要確認にしない（版 2026-11-18b）
  assert.equal(X.LIC_aiDateCheck('2026-12-15', '2026-11-16', '2026-12-16'), 'before');
  const req = X.LIC_aiRequest('', 'image/jpeg', 'AAAA');
  assert.equal(req.model, 'claude-sonnet-5-5');
  assert.equal(req.messages[0].content[0].source.data, 'AAAA');
  assert.equal(X.LIC_aiRequest('claude-haiku-5-5', 'image/jpeg', 'A').model, 'claude-haiku-5-5');
});

test('免許証（AI）: AI の確認に時間がかかったら返信ではなくプッシュで送る。大きすぎる写真は AI へ送らずボタン・要確認', () => {
  const { g, master } = aiSetup();
  post(g, pb(U(1), 'lic|1|start'));
  const n = g.fetches.length;
  g.ai.queue.push({ ...FRONT('2029-04-30'), delayMs: 50000 });
  photo(g, U(1));
  const r = since(g, n);
  assert.equal(r.reply.length, 0);
  assert.equal(r.push.length, 1);
  assert.equal(r.push[0].body.to, U(1));
  assert.equal(r.push[0].body.messages[0].text, '表面の写真を確認しました。\n続けて、裏面の写真をお送りください。' + NOTE);
  // 大きすぎる写真
  const b = aiSetup();
  post(b.g, pb(U(2), 'lic|1|start'));
  const e = ev(U(2), { type: 'image' });
  b.g.line.contents[e.message.id] = { type: 'image/jpeg', size: 8 * 1024 * 1024 };
  const m = b.g.fetches.length;
  post(b.g, e);
  assert.equal(b.g.ai.calls.length, 0);
  assert.equal(since(b.g, m).reply[0].body.messages[0].type, 'flex');
  assert.equal(val(b.master, '90002', 'AI確認'), '未確認（写真が大きすぎる）');
  assert.equal(val(b.master, '90002', '状態'), '要確認');
  assert.equal(val(master, '90001', 'AI確認'), 'OK');
});
