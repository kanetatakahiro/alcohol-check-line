import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 交通費申請（gas/TravelApply.gs・版 2026-11-19b）・給与反映シート（gas/PayrollSheet.gs）。すべて架空の社員番号・氏名・住所・店舗・LINE ID。AI・LINE・Maps は模擬（実際には呼ばない）
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'Notices.gs', 'License.gs', 'OfficeTask.gs', 'Travel.gs', 'TravelApply.gs', 'PayrollSheet.gs'];
// 給与反映シート（社労士共有用【リバースHD】）の本番の形（2026-11-19 に確認した見出しと形。値は架空）：
// 1行目 B「2026年」・C「11月支給」／2行目 B〜I の見出し／3行目から人の行（I 列 =SUM(D:H)）／すぐ下に合計の行（D〜I =SUM(D3:D…)）／
// その下に固定立て替えの表（D〜J）と L 列のチェックボックス・M 列のメモ
const PAY_HEAD = ['', '従業員番号', '氏名', '立替経費', '通勤手当', '固定立て替え', '家賃補助', 'インセンティブ', '合計'];
const FIXED_HEAD = ['', '', '', '内容', '', '合計金額', '支払い回数', '期間（開始）', '期間（終了）', '当月徴収金額', '', false, '修正箇所'];
const FIXED_ROW = ['', '', '', 'テスト備品', '', 30000, 6, "'2026-10", "'2027-03", 5000, '', true, 'テストのメモ'];
/** 月のタブ（テンプレも同じ形）。people＝[[従業員番号, 氏名, {列: 値}]]（空の行は null） */
function payTab(sr, name, head1, people) {
  const sh = sr.insertSheet(name);
  sh.appendRow(['', ...head1]); sh.appendRow(PAY_HEAD);
  const cols = { 立替経費: 4, 通勤手当: 5, 固定立て替え: 6, 家賃補助: 7, インセンティブ: 8 };
  people.forEach((p, i) => {
    const r = 3 + i;
    if (p) { sh.getRange(r, 2).setValue("'" + p[0]); sh.getRange(r, 3).setValue(p[1]); Object.entries(p[2] || {}).forEach(([k, v]) => sh.getRange(r, cols[k]).setValue(v)); }
    sh.getRange(r, 9).setFormula((i === 1 ? '=sum' : '=SUM') + `(D${r}:H${r})`);   // 小文字の =sum の行もある
  });
  const sumRow = 3 + people.length;
  ['D', 'E', 'F', 'G', 'H', 'I'].forEach((c, j) => sh.getRange(sumRow, 4 + j).setFormula(`=SUM(${c}3:${c}${sumRow - 1})`));
  [FIXED_HEAD, FIXED_ROW].forEach((row, i) => row.forEach((v, j) => { if (v !== '') sh.getRange(sumRow + 3 + i, j + 1).setValue(v); }));
  sh.setFrozenRows(2);
  return sh;
}
const snap = (sh) => JSON.stringify([sh.dump(), sh.formulas, sh.cf]);
function payBook(g) {
  const sr = g.newSpreadsheet('【テスト】社労士共有用（架空）');
  sr.insertSheet('従業員コード').appendRow(['触らないタブ']);
  payTab(sr, 'テンプレ', ['2026年', '月支給'], [['90001', '試験 一郎', { 固定立て替え: 5000 }], ['90009', '試験 九郎（テンプレにいる人）'], null]);
  payTab(sr, 'R8.10月分11月支給', ['2026年', '11月支給'], [['90001', '試験 一郎', { 通勤手当: 1234 }]]);
  return sr;
}
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const ADMIN = U(7), GROUP = 'C' + 'a'.repeat(32);
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const emp = (code, name, dept, uid, tot, status = '在籍') => ["'" + code, name, '', status, dept, uid, '', '', true, true, '', '', "'" + tot, ''];
const STORES = [
  ['企業・店舗名', '住所', '電話番号', '備考', '略語'],
  ['テスト自動車 甲町店', '〒100-0001\n架空県甲市1-1', '000-0000-0001', '取引先', '甲町'],
  ['テスト自動車 乙山店', '〒100-0002\n架空県乙市2-2', '000-0000-0002', '取引先', '乙山'],
];
// 架空の道のり（高速を使わない道）：90001 の自宅→甲町 10km・→乙山 30km、90002 の自宅→甲町 15km・→乙山 5km、店舗どうし 20km
const route = (o, d) => (/北町/.test(o) ? (/甲市/.test(d) ? 10 : 30) : /南町/.test(o) ? (/甲市/.test(d) ? 15 : 5) : 20);
let seq = 0;
const ev = (uid, message, id = 'ta' + ++seq) => ({ type: 'message', webhookEventId: id, replyToken: 'rt-' + id, timestamp: 0,
  source: { type: 'user', userId: uid }, message: { id: 'm' + id, ...(typeof message === 'string' ? { type: 'text', text: message } : message) } });
const post = (g, ...events) => g.ctx.doPost({ postData: { contents: JSON.stringify({ destination: 'x', events }) } });
const photo = (g, uid, extra = {}) => { const e = ev(uid, { type: 'image', ...extra }); g.line.contents[e.message.id] = { type: 'image/jpeg' }; post(g, e); return e; };
const row = (o) => ({ date: '', from: '', to: '', means: 'car', km: '', yen: '', unclear: [], ...o });
const form = (rows, month = '2026-11', total = '') => ({ json: { is_travel_form: true, month, total_yen: total, rows: rows.map(row) } });
const at = (g, iso) => { g.clock.now = new Date(iso).getTime(); };

function setup(props = { TRAVEL_APPLY_MODE: 'on' }, now = '2026-12-02T09:00:00+09:00') {
  const g = createGas({ files: FILES, now });
  const master = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = master.insertSheet('従業員マスタ');
  [HEAD, emp('90001', '試験 一郎', '部署A', U(1), '0001'), emp('90002', '試験 二郎', '部署A', U(2), '0002'), emp('90003', '試験 三郎', '部署B', U(3), '0003'),
    emp('90004', '試験 四郎', '部署B', U(4), '0004'), emp('90005', '試験 五郎', '部署C', U(5), '0005'), emp('90006', '試験 六郎', '部署C', U(6), '0006', '退職')]
    .forEach((r) => m.appendRow(r));
  master.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [GROUP, '勤怠管理', '2026-10-15', '有効']].forEach((r) => master.getSheetByName('LINEグループ').appendRow(r));
  STORES.forEach((r, i) => (i ? master.getSheetByName('店舗一覧') : master.insertSheet('店舗一覧')).appendRow(r));
  const inq = g.newSpreadsheet('【テスト】問い合わせ（架空）'), ot = g.newSpreadsheet('【テスト】業務一覧（架空）'), sr = payBook(g);
  g.drive.newFolder('folder-license'); g.drive.newFolder('folder-travel');
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: master.getId(), INQ_SPREADSHEET_ID: inq.getId(), INQ_MODE: 'on', LINE_CHANNEL_ACCESS_TOKEN: 'fake',
    LINE_ADMIN_USER_ID: ADMIN, DRY_RUN: 'false', LICENSE_FOLDER_ID: 'folder-license', TRAVEL_APPLY_FOLDER_ID: 'folder-travel', ANTHROPIC_API_KEY: 'fake-key',
    OFFICE_TASK_BOOK_ID: ot.getId(), PAYROLL_SHEET_ID: sr.getId(), TRAVEL_DISTANCE_MODE: 'on', ...props });
  for (let n = 1; n <= 7; n++) g.line.profiles[U(n)] = '表示名' + n;
  g.maps.route = (o, d, avoid) => route(o, d) + (avoid ? 0 : 3);
  g.ctx.travelDistanceDaily();
  const commute = master.getSheetByName('通勤距離');
  const setC = (code, col, v) => { const i = commute.dump().findIndex((r) => String(r[0]) === code); commute.getRange(i + 1, col).setValue(v); };
  setC('90001', 4, '架空県甲市北町'); setC('90002', 4, '架空県乙市南町');
  setC('90001', 6, '交通費申請（車・バイク）'); setC('90002', 6, '交通費申請（車・バイク）'); setC('90003', 6, '公共交通機関');
  setC('90004', 6, 'ガソリンカード'); setC('90005', 6, '定期（固定額）'); setC('90005', 7, 12000);
  g.ctx.travelDistanceDaily();
  return { g, master, inq, ot, sr };
}
const tab = (book, n) => book.getSheetByName(n);
const apps = (master) => (tab(master, '交通費申請') ? tab(master, '交通費申請').dump().slice(1) : []);
const details = (master) => (tab(master, '交通費明細') ? tab(master, '交通費明細').dump().slice(1) : []);
const replies = (g, n = 0) => g.fetches.slice(n).filter((f) => /\/reply$/.test(f.url)).map((f) => f.body.messages[0].text);
const pushes = (g, n = 0) => g.fetches.slice(n).filter((f) => /\/push$/.test(f.url)).map((f) => ({ to: f.body.to, text: f.body.messages[0].text }));
const cases = (inq) => (tab(inq, '問い合わせ') ? tab(inq, '問い合わせ').dump().slice(1) : []);
const requests = (ot) => (tab(ot, '臨時の依頼') ? tab(ot, '臨時の依頼').dump().slice(1) : []);
const setD = (master, i, col, v) => tab(master, '交通費明細').getRange(i + 2, col).setValue(v);
const totLatest = (g, worked) => {
  const dates = []; for (let d = new Date(Date.UTC(2026, 10, 1)); d < new Date(Date.UTC(2026, 11, 2)); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
  const results = { employees: [{ key: 'k1', code: '0001' }, { key: 'k2', code: '0002' }, { key: 'k3', code: '0003' }, { key: 'k9', code: '0099' }],
    workings: dates.map((d) => ({ date: d, dailyWorkings: [{ date: d, employeeKey: 'k9', totalWork: 480 }, ...(worked[d] || []).map((k) => ({ date: d, employeeKey: k, totalWork: 480 }))] })) };
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today: '2026-12-02', results }), updated: g.clock.now };
};
const noPersonalLogs = (g) => assert.ok(!g.logs.some((l) => /試験|架空県|円|甲町|乙山/.test(l)), g.logs.join('\n'));

test('交通費申請（受付）: 写真を AI で読み、申請と明細を記録・写真を保存・本人へは受付の知らせ（対象月・件数）だけ。同じ月の2枚目は同じ申請に足す', () => {
  const { g, master, inq } = setup();
  g.ai.queue.push(form([{ date: '11/5', from: '自宅', to: '甲町', km: '10' }, { date: '11/5', from: '甲町店', to: '自宅', km: '12' }]));
  const n = g.fetches.length;
  photo(g, U(1));
  const a = apps(master);
  assert.equal(a.length, 1);
  assert.deepEqual([String(a[0][2]), a[0][3], String(a[0][4]), String(a[0][5]), a[0][6], a[0][7]], ['90001', '試験 一郎', '2026-11', '2026-11', '受付', 330]);   // 22km × 15円
  assert.match(String(a[0][8]), /^photo-\d+$/);
  assert.match(g.drive.folders['folder-travel'].files[0].name, /^90001_20261202_\d{6}_1$/);
  const d = details(master);
  assert.deepEqual(d.map((r) => [String(r[2]), r[3], r[4], r[5], r[6], r[7], r[8], r[9]]),
    [['2026-11-05', '自宅', '甲町', '車', 10, 150, '未確認', 'OK'], ['2026-11-05', '甲町店', '自宅', '車', 12, 180, '未確認', 'OK']]);
  assert.deepEqual(replies(g, n).map((t) => t.split('\n')[0]), ['交通費申請の写真を受け付けました（11月分・2件）。']);
  assert.equal(cases(inq).length, 0);   // 問い合わせにはしない
  // AI へは写真と指示だけ（住所・氏名・LINE ID は送らない）。License.gs と同じ宛先・版・既定のモデル
  const call = g.ai.calls[0];
  assert.equal(call.opt.headers['anthropic-version'], g.ctx.LIC_AI_API_VERSION);
  assert.equal(call.body.model, g.ctx.LIC_AI_DEFAULT_MODEL);
  assert.ok(!/架空県|試験|U1111/.test(JSON.stringify(call.body)));
  // 2枚目（同じ月）は同じ申請に足す。LINE の imageSet は最後の1枚だけ返す
  g.ai.queue.push(form([{ date: '11/6', from: '自宅', to: '乙山', km: '30' }]), form([{ date: '11/7', from: '乙山', to: '自宅', km: '31' }]));
  const n2 = g.fetches.length;
  photo(g, U(1), { imageSet: { id: 'set1', index: 1, total: 2 } });
  photo(g, U(1), { imageSet: { id: 'set1', index: 2, total: 2 } });
  assert.equal(apps(master).length, 1);
  assert.equal(details(master).length, 4);
  assert.equal(String(apps(master)[0][8]).split(',').length, 3);
  assert.deepEqual(replies(g, n2).map((t) => t.split('\n')[0]), ['交通費申請の写真を受け付けました（11月分・4件）。']);
  noPersonalLogs(g);
});

test('交通費申請（見分け）: 免許証の受付中の写真は免許証へ。申請の対象でない人・申請書でない画像・off は今までどおり問い合わせへ（AI も呼ばない人がいる）', () => {
  const { g, master, inq } = setup({ TRAVEL_APPLY_MODE: 'on', LICENSE_MODE: 'on' });
  g.ctx.licenseDaily();
  const lt = tab(master, '免許証管理'), li = lt.dump().findIndex((r) => String(r[0]) === '90001');
  lt.getRange(li + 1, 3).setValue('あり');
  post(g, ev(U(1), '免許更新'));
  photo(g, U(1));
  assert.match(String(lt.getRange(li + 1, 6).getValue()), /^photo-/);   // 免許証の写真として保存
  assert.equal(apps(master).length, 0);
  assert.equal(g.ai.calls.length, 0);                                     // LICENSE_AI_CHECK は off・交通費は呼ばない
  // ガソリンカードの人：AI を呼ばずに問い合わせへ
  const c0 = cases(inq).length;
  photo(g, U(4));
  assert.equal(g.ai.calls.length, 0);
  assert.equal(cases(inq).length, c0 + 1);
  // 申請の対象の人でも、AI が「申請書ではない」と答えた画像は問い合わせへ（保存しない）
  g.ai.queue.push({ json: { is_travel_form: false, month: '', total_yen: '', rows: [] } });
  const files = g.drive.folders['folder-travel'].files.length;
  g.clock.now += 31 * 60000;   // 免許証の受付（30分）が終わってから
  photo(g, U(2));
  assert.equal(g.ai.calls.length, 1);
  assert.equal(cases(inq).length, c0 + 2);
  assert.equal(g.drive.folders['folder-travel'].files.length, files);
  assert.equal(apps(master).length, 0);
  // off：何もしない
  g.scriptProps.setProperty('TRAVEL_APPLY_MODE', 'off');
  photo(g, U(1));   // 免許証の受付は終わっている
  assert.equal(g.ai.calls.length, 1);
  assert.equal(cases(inq).length, c0 + 3);
});

test('交通費申請（読み取り）: 読めない欄は推測で埋めずに空のまま要確認。AI が使えないときも写真は保存して要確認。対象月が決まらなければ要確認', () => {
  const { g, master } = setup();
  g.ai.queue.push(form([
    { date: '11/8', from: '自宅', to: '甲町', km: '', unclear: ['km'] },
    { date: '', from: '自宅', to: '乙山', km: '30', unclear: ['date'] },
    { date: '11/9', from: '自宅', to: '甲町', means: 'unknown', km: '10' },
    { date: '11/10', from: '', to: '甲町', km: '10', unclear: ['from'] },
    { date: '12/1', from: '自宅', to: '甲町', km: '10' },
  ]));
  photo(g, U(1));
  const d = details(master);
  assert.deepEqual(d.map((r) => [r[6], r[9]]), [['', '要確認'], [30, '要確認'], [10, '要確認'], [10, '要確認'], [10, '要確認']]);
  assert.match(d[0][10], /距離（km）が読み取れませんでした/);
  assert.match(d[1][10], /日付が読み取れませんでした/);
  assert.equal(String(d[1][2]), '');
  assert.match(d[2][10], /手段/);
  assert.equal(d[2][5], '');
  assert.match(d[3][10], /読み取れませんでした/);
  assert.equal(d[3][3], '');
  assert.match(d[4][10], /対象の月の外/);
  assert.equal(apps(master)[0][6], '要確認');
  // AI が使えない（HTTP 500）：写真は保存し、申請書全体を要確認。返信は「管理本部が写真で確認」
  g.ai.queue.push({ status: 500 });
  const n = g.fetches.length;
  photo(g, U(2));
  const a2 = apps(master).find((r) => String(r[2]) === '90002');
  assert.deepEqual([String(a2[4]), a2[6]], ['', '要確認']);
  assert.ok(details(master).some((r) => String(r[1]) === '90002' && r[3] === '（申請書全体）' && /AI で申請書を読み取れませんでした/.test(r[10])));
  assert.match(replies(g, n)[0], /内容は管理本部が写真で確認します/);
  assert.ok(pushes(g, n).some((p) => p.to === ADMIN && /交通費申請・エラー/.test(p.text)));
  // 対象月が書かれておらず、日付の月もばらばら
  g.ai.queue.push(form([{ date: '10/30', from: '自宅', to: '甲町', km: '10' }, { date: '11/2', from: '自宅', to: '甲町', km: '10' }], ''));
  photo(g, U(1));
  const a3 = apps(master).filter((r) => String(r[2]) === '90001' && String(r[4]) === '');
  assert.equal(a3.length, 1);
  assert.ok(details(master).some((r) => r[0] === a3[0][0] && r[3] === '（申請書全体）' && /対象の月が読み取れませんでした/.test(r[10])));
  noPersonalLogs(g);
});

test('交通費申請（照合）: 車・バイクは自動計算の距離と片道5km で照合（理由に両方の km）・行き先がわからない区間は要確認・電車・バスは金額だけ・申請書の合計の違い・重複', () => {
  const { g, master } = setup();
  g.ai.queue.push(form([
    { date: '11/5', from: '自宅', to: '甲町', km: '15' },
    { date: '11/6', from: '自宅', to: '甲町', km: '15.1' },
    { date: '11/7', from: '大宮', to: '自宅', km: '8' },
    { date: '11/9', from: '自宅', to: '甲町', means: 'bike', km: '9' },
    { date: '11/10', from: '大宮駅', to: '浦和駅', means: 'train', yen: '420円' },
    { date: '11/10', from: '大宮駅', to: '浦和駅', means: 'train', yen: '420' },
  ], '2026-11', '9,999'));
  photo(g, U(1));
  const d = details(master);
  assert.deepEqual(d.map((r) => r[9]), ['OK', '要確認', '要確認', 'OK', 'OK', '要確認', '要確認']);
  assert.equal(d[1][10], '要確認（申請 15.1km・自動計算 10km（高速を使わない道。高速を使う道は 13km））');
  assert.equal(d[2][10], '要確認（行き先がわからない：大宮）');
  assert.deepEqual([d[4][5], d[4][6], d[4][7]], ['電車', '', 420]);
  assert.match(d[5][10], /同じ日・同じ区間/);
  assert.equal(d[6][3], '（申請書全体）');
  assert.match(d[6][10], /合計と、計算した合計が違います/);
  // 車・バイクの金額：km × 15円（合計は円未満切り捨て）
  assert.deepEqual([d[0][7], d[3][7]], [225, 135]);
});

test('交通費申請（毎朝）: TOT の出勤の記録で照合し、要確認は「臨時の依頼」に1件1行（メモに住所・金額を書かない）。回答で確定・回答が空の［完了］は出し直す', () => {
  const { g, master, ot } = setup();
  g.ai.queue.push(form([
    { date: '11/5', from: '自宅', to: '甲町', km: '10' },
    { date: '11/6', from: '自宅', to: '甲町', km: '10' },
    { date: '11/9', from: '自宅', to: '乙山', km: '40' },
  ]));
  photo(g, U(1));
  totLatest(g, { '2026-11-05': ['k1'], '2026-11-09': ['k1'] });
  at(g, '2026-12-03T07:00:00+09:00');
  const r = g.ctx.travelApplyDaily();
  assert.deepEqual({ tot: r.tot, requests: r.requests }, { tot: 3, requests: 2 });
  const d = details(master);
  assert.deepEqual(d.map((x) => [x[8], x[9]]), [['あり', 'OK'], ['なし', '要確認'], ['あり', '要確認']]);
  const q = requests(ot);
  assert.deepEqual(q.map((x) => x[2]), ['交通費の確認：試験さん（11/6 自宅→甲町（車））'.replace('（車））', '）'), '交通費の確認：試験さん（11/9 自宅→乙山）']);
  assert.match(q[0][4], /^何が：11\/6 自宅→甲町（車）\nなぜ：その日の TOT の出勤の記録がありません\nどう直すか：従業員マスタのファイルの「交通費明細」3行目/);
  assert.match(q[1][4], /片道5kmを超えて/);
  q.forEach((x) => assert.ok(!/円|架空県|(?<!片道)\d+(\.\d+)?km/.test(x[4]), x[4]));
  assert.equal(String(q[0][3]), '2026-12-05');   // 期限：締切の日
  assert.deepEqual(d.map((x) => String(x[13])), ['', '2', '3']);
  assert.equal(apps(master)[0][6], '要確認');
  // 同じ日にもう1回：同じ依頼は重ねない
  assert.equal(g.ctx.travelApplyDaily().requests, 0);
  // 回答：11/6 は出勤を確認・11/9 は回答なしで［完了］
  setD(master, 1, 12, '本人に確認。11/6 は出勤（打刻漏れ）');
  tab(ot, '臨時の依頼').getRange(3, 6).setValue('完了');
  at(g, '2026-12-04T07:00:00+09:00');
  const r2 = g.ctx.travelApplyDaily();
  assert.deepEqual({ confirmed: r2.confirmed, reissued: r2.reissued, requests: r2.requests }, { confirmed: 1, reissued: 1, requests: 1 });
  const d2 = details(master);
  assert.match(String(d2[1][9]), /^確認済み（12\/4）$/);
  assert.equal(requests(ot)[0][5], '完了');
  assert.equal(String(d2[2][13]), '4');                         // 出し直した依頼の行
  assert.match(d2[2][10], /回答が空のまま［完了］になっていました/);
  assert.match(requests(ot)[2][4], /なぜ：回答が空のまま/);
  // 確認後の値（km）を入れて確定 → 申請は確定、合計は直した km で
  setD(master, 2, 12, '道順を確認。迂回あり'); setD(master, 2, 13, '33');
  at(g, '2026-12-05T07:00:00+09:00');
  g.ctx.travelApplyDaily();
  const d3 = details(master);
  assert.deepEqual([d3[2][6], d3[2][7]], [33, 495]);
  assert.deepEqual([apps(master)[0][6], apps(master)[0][7]], ['確定', 795]);   // (10 + 10 + 33) × 15
  noPersonalLogs(g);
});

test('交通費申請（締切）: 4日 10:00 の催促は対象者だけ・提出済みには送らない・土日でも送る・同じ月は1回。前月分は4日 23:59 まで・5日 0時以降は来月反映（本人にも返信で伝える）', () => {
  const { g, master } = setup({ TRAVEL_APPLY_MODE: 'on' }, '2026-07-02T09:00:00+09:00');
  g.ai.queue.push(form([{ date: '6/5', from: '自宅', to: '甲町', km: '15' }], '2026-06'));
  photo(g, U(2));   // 90002 は6月分を提出済み
  at(g, '2026-07-04T10:00:00+09:00');   // 土曜
  const n = g.fetches.length;
  const r = g.ctx.travelApplyRemind();
  assert.deepEqual({ sent: r.sent, month: r.month }, { sent: 1, month: '2026-06' });
  const p = pushes(g, n);
  assert.deepEqual(p.map((x) => x.to), [U(1)]);   // 公共交通機関・ガソリンカード・固定額・退職者・提出済みには送らない
  assert.match(p[0].text, /^先月分の交通費申請がまだ届いていません。本日中に申請書の写真をこちらへ送ってください。5日以降に届いた分は、来月のお給料での反映になります。/);
  assert.equal(g.ctx.travelApplyRemind().sent, 0);   // 2回目は送らない
  at(g, '2026-07-03T10:00:00+09:00');
  assert.equal(g.ctx.travelApplyRemind().skipped, '4日ではない');
  // 4日までは前月の反映・5日からは来月反映
  const X = g.ctx;
  assert.deepEqual(['2026-12-04', '2026-12-05', '2026-11-30'].map((t) => X.TA_reflectMonth('2026-11', t)), ['2026-11', '2026-12', '2026-11']);
  assert.equal(X.TA_reflectMonth('2026-10', '2026-12-03'), '2026-11');
  assert.deepEqual([X.TA_acceptDeadline('2026-11'), X.TA_answerDay('2026-11')], ['2026-12-04', '2026-12-05']);
  at(g, '2026-07-04T23:59:00+09:00');   // 4日 23:59 は前月分として受け付ける
  g.ai.queue.push(form([{ date: '6/9', from: '自宅', to: '甲町', km: '10' }], '2026-06'));
  photo(g, U(2));
  assert.equal(String(apps(master).filter((x) => String(x[2]) === '90002').at(-1)[5]), '2026-06');
  at(g, '2026-07-05T00:00:00+09:00');
  g.ai.queue.push(form([{ date: '6/8', from: '自宅', to: '甲町', km: '10' }], '2026-06'));
  const n2 = g.fetches.length;
  photo(g, U(1));
  const a = apps(master).find((x) => String(x[2]) === '90001');
  assert.deepEqual([String(a[4]), String(a[5])], ['2026-06', '2026-07']);
  assert.match(replies(g, n2)[0], /（6月分・1件）。[\s\S]*受付の締切（7\/4）を過ぎて届いたため、来月のお給料での反映になります。/);
});

test('交通費申請（給与反映シート）: 6日の締めでタブが無ければ「テンプレ」から作る（1行目 B・C・テンプレの人は残し、足りない在籍者だけ足す・合計の行の上に挿入して =SUM を広げる・下の表と L・M 列はそのまま）。確定額は「通勤手当」へ', () => {
  const { g, master, sr } = setup();
  totLatest(g, { '2026-11-05': ['k1'], '2026-11-06': ['k1'], '2026-11-12': ['k2', 'k3'] });
  g.ai.queue.push(form([{ date: '11/5', from: '自宅', to: '甲町', km: '10' }, { date: '11/6', from: '甲町', to: '乙山', km: '20' }]));
  photo(g, U(1));
  g.ai.queue.push(form([{ date: '11/12', from: '自宅', to: '甲町', km: '25' }]));   // 90002：5km 超で要確認のまま
  photo(g, U(2));
  g.ai.queue.push(form([{ date: '11/12', from: '大宮駅', to: '浦和駅', means: 'train', yen: '420' }]));
  photo(g, U(3));   // 90003（公共交通機関）
  const before = sr.getSheets().filter((x) => !/R8\.11/.test(x.getName())).map((x) => [x.getName(), snap(x)]);
  at(g, '2026-12-05T07:00:00+09:00');
  assert.equal(g.ctx.travelApplyDaily().closed, '');   // 5日は締めない（回答の日）
  at(g, '2026-12-06T07:00:00+09:00');
  const n = g.fetches.length;
  const r = g.ctx.travelApplyDaily();
  assert.match(r.closed, /2026-11 を締め（書いた 3・上書きしなかった 0・未提出 0・要確認 1・来月へ 1件）/);
  const t = tab(sr, 'R8.11月分12月支給');
  assert.equal(t.copiedFrom, 'テンプレ');
  const v = t.dump();
  assert.deepEqual(v[0].slice(1, 3), ['2026年', '12月支給']);
  assert.deepEqual(v[1].slice(0, 9), PAY_HEAD);
  // テンプレの人（90001・90009）は残し、空いていた5行目に 90002、足りない 90003〜90005 は合計の行の上に挿入
  assert.deepEqual(v.slice(2, 8).map((x) => [String(x[1]), x[2], x[4], x[5]]), [
    ['90001', '試験 一郎', 450, 5000], ['90009', '試験 九郎（テンプレにいる人）', '', ''], ['90002', '試験 二郎', '', ''],
    ['90003', '試験 三郎', 420, ''], ['90004', '試験 四郎', '', ''], ['90005', '試験 五郎', 12000, '']]);
  assert.deepEqual([3, 4, 5, 6, 7, 8].map((i) => t.formulas[`${i},9`]), ['=SUM(D3:H3)', '=sum(D4:H4)', '=SUM(D5:H5)', '=SUM(D6:H6)', '=SUM(D7:H7)', '=SUM(D8:H8)']);
  assert.deepEqual([4, 5, 6, 7, 8, 9].map((c) => t.formulas[`9,${c}`]), ['=SUM(D3:D8)', '=SUM(E3:E8)', '=SUM(F3:F8)', '=SUM(G3:G8)', '=SUM(H3:H8)', '=SUM(I3:I8)']);
  assert.deepEqual(v[11], FIXED_HEAD.map((x) => (x === "'2026-10" ? '2026-10' : x)));   // 固定立て替えの表と L・M 列は3行下へずれただけ
  assert.deepEqual(v[12].slice(3, 13), [FIXED_ROW[3], '', 30000, 6, '2026-10', '2027-03', 5000, '', true, 'テストのメモ']);
  assert.deepEqual(t.cf.map((c) => [c.formula, c.bg, c.ranges[0].r, c.ranges[0].nr, c.ranges[0].c, c.ranges[0].nc]), [
    ['=AND($B3<>"",SUM($D3:$H3)=0)', '#efefef', 3, 6, 2, 8], ['=AND($B3<>"",SUM($D3:$H3)<>0)', '#ffffff', 3, 6, 2, 8]]);
  sr.getSheets().filter((x) => !/R8\.11/.test(x.getName())).forEach((x) => assert.equal(snap(x), before.find((b) => b[0] === x.getName())[1], x.getName()));   // テンプレ・既存のタブは変えない
  assert.equal(String(apps(master).find((x) => String(x[2]) === '90002')[5]), '2026-12');   // 要確認は来月へ
  const adm = pushes(g, n).filter((p) => p.to === ADMIN);
  assert.equal(adm.length, 1);
  assert.match(adm[0].text, /^【交通費】11月分を締めました（受付は12\/4まで・回答は12\/5まで）。\n給与反映シートの「R8.11月分12月支給」（テンプレから作りました）の「通勤手当」に 3人分を書きました。\n・未提出 0人\n・要確認が残っている 1人（来月に反映）\n　90002 試験 二郎/);
  at(g, '2026-12-06T08:00:00+09:00');
  assert.match(g.ctx.travelApplyDaily().closed, /締め済み/);
  noPersonalLogs(g);
});

test('交通費申請（給与反映シート）: ★付きの既存のタブに書く。値がある欄は上書きせず管理者へ・並んでいない人は合計の行の上に足して =SUM を広げる。共通の関数で立替経費にも書ける・形が違えば止める', () => {
  const { g, sr } = setup();
  totLatest(g, { '2026-11-05': ['k1'], '2026-11-12': ['k3'] });
  g.ai.queue.push(form([{ date: '11/5', from: '自宅', to: '甲町', km: '10' }]));
  photo(g, U(1));
  g.ai.queue.push(form([{ date: '11/12', from: '大宮駅', to: '浦和駅', means: 'train', yen: '420' }]));
  photo(g, U(3));
  const ex = payTab(sr, '★R8.11月分12月支給', ['2026年', '12月支給'], [['90001', '試験 一郎', { 通勤手当: 999 }], ['90003', '試験 三郎', { 立替経費: 500 }]]);
  at(g, '2026-12-06T07:00:00+09:00');
  const n = g.fetches.length;
  g.ctx.travelApplyDaily();
  assert.equal(tab(sr, 'R8.11月分12月支給'), null);   // 新しく作らない
  const v = ex.dump();
  assert.deepEqual(v.slice(2, 5).map((x) => [String(x[1]), x[3], x[4]]), [['90001', '', 999], ['90003', 500, 420], ['90005', '', 12000]]);
  assert.deepEqual([ex.formulas['5,9'], ex.formulas['6,4'], ex.formulas['6,9']], ['=sum(D5:H5)', '=SUM(D3:D5)', '=SUM(I3:I5)']);
  assert.equal(v[8][3], '内容');   // 下の表は1行ずれただけ
  assert.equal(ex.cf.length, 0);   // 既存のタブには条件付き書式を足さない
  const adm = pushes(g, n).filter((p) => p.to === ADMIN)[0].text;
  assert.match(adm, /「★R8.11月分12月支給」の「通勤手当」に 2人分を書きました。\n・並んでいなかったため行を足した：従業員番号 90005\n・すでに値があるため書かなかった（上書きしていません）：従業員番号 90001\n・未提出 1人\n　90002 試験 二郎/);
  // 共通の関数：列の名前を渡せば立替経費にも（空いている欄だけ）。見出しに無い列・合計の行が無いタブは何も書かずに止める
  const people = [{ code: '90001', name: '試験 一郎' }, { code: '90003', name: '試験 三郎' }];
  const w = g.ctx.PAY_writeColumn_('2026-11', '立替経費', [{ code: '90001', value: 3000 }, { code: '90003', value: 500 }], { people, mode: 'on' });
  assert.deepEqual({ written: [...w.written], same: [...w.same], conflict: [...w.conflict] }, { written: ['90001'], same: ['90003'], conflict: [] });
  assert.equal(ex.dump()[2][3], 3000);
  const s1 = snap(ex);
  assert.throws(() => g.ctx.PAY_writeColumn_('2026-11', '家族補助', [{ code: '90001', value: 1 }], { people, mode: 'on' }), /「家族補助」がありません/);
  assert.equal(snap(ex), s1);
  const bad = sr.insertSheet('R8.12月分1月支給');
  [['', '2026年', '1月支給'], PAY_HEAD, ['', "'90001", '試験 一郎']].forEach((x) => bad.appendRow(x));
  assert.throws(() => g.ctx.PAY_writeColumn_('2026-12', '通勤手当', [{ code: '90001', value: 1 }], { people, mode: 'on' }), /合計の行.*見つかりません/);
  assert.equal(bad.dump()[2][4], '');
  // 純粋関数
  const X = g.ctx;
  assert.deepEqual(['2026-11', '2026-12', '2027-01'].map(X.PAY_tabName), ['R8.11月分12月支給', 'R8.12月分1月支給', 'R9.1月分2月支給']);
  assert.deepEqual(['2026-11', '2026-12'].map((m) => [...X.PAY_payCells(m)]), [['2026年', '12月支給'], ['2027年', '1月支給']]);
  assert.equal(X.PAY_normName(' ★R8.11月分12月支給☆'), X.PAY_normName('R8.11月分12月支給'));
  assert.equal(X.PAY_code("'090001"), X.PAY_code(90001));
  assert.equal(X.PAY_colLetter(28), 'AB');
  assert.equal(X.PAY_isSum('=sum(D3:D25)'), true);
  assert.equal(X.PAY_extendSum('=SUM(D3:D25)', 25, 28), '=SUM(D3:D28)');
  assert.equal(X.PAY_extendSum('=SUM(D3:D28)', 25, 28), '=SUM(D3:D28)');   // シートが自動で広げていればそのまま
});

test('交通費申請（record）: 受け付けて記録するが LINE・臨時の依頼・給与反映シートには送らず「交通費の送る予定」へ。画像は今までどおり問い合わせへも流す', () => {
  const { g, master, inq, ot, sr } = setup({ TRAVEL_APPLY_MODE: 'record' });
  g.ai.queue.push(form([{ date: '11/6', from: '自宅', to: '甲町', km: '25' }]));
  const n = g.fetches.length;
  photo(g, U(1));
  assert.equal(apps(master).length, 1);
  assert.equal(cases(inq).length, 1);   // 今までどおり問い合わせにもなる
  assert.ok(!replies(g, n).some((t) => /交通費申請/.test(t)));
  const plan = () => tab(master, '交通費の送る予定').dump().slice(1).map((x) => x[1]);
  assert.deepEqual(plan(), ['受付の返信']);
  at(g, '2026-12-03T07:00:00+09:00');
  g.ctx.travelApplyDaily();
  assert.equal(requests(ot).length, 0);
  assert.deepEqual(plan(), ['受付の返信', '臨時の依頼']);
  at(g, '2026-12-04T10:00:00+09:00');
  const n2 = g.fetches.length;
  g.ctx.travelApplyRemind();
  assert.equal(pushes(g, n2).length, 0);
  assert.deepEqual(plan().slice(-1), ['4日の催促']);
  at(g, '2026-12-06T07:00:00+09:00');
  const n3 = g.fetches.length;
  g.ctx.travelApplyDaily();
  assert.equal(pushes(g, n3).length, 0);
  assert.deepEqual(plan().slice(-2), ['給与反映シート', '管理者のまとめ']);
  assert.equal(tab(sr, 'R8.11月分12月支給'), null);
  assert.equal(sr.getSheets().length, 4);   // シート1・従業員コード・テンプレ・既存の月のタブだけ
  assert.match(tab(master, '交通費の送る予定').dump().at(-1)[3], /record のため給与反映シートには書いていません。「R8.11月分12月支給」の「通勤手当」に 1人分を書く予定・タブはテンプレから作る予定/);
  noPersonalLogs(g);
});

test('交通費申請（純粋関数）: 日付・金額・AI の応答・TOT の照合・タブの名前', () => {
  const { g } = setup({});
  const X = g.ctx;
  assert.equal(X.TA_parseDate('11/5', '2026-12-02', ''), '2026-11-05');
  assert.equal(X.TA_parseDate('12/31', '2027-01-03', ''), '2026-12-31');
  assert.equal(X.TA_parseDate('５日', '2026-12-02', '2026-11'), '2026-11-05');
  assert.equal(X.TA_parseDate('5', '2026-12-02', ''), '');
  assert.equal(X.TA_parseDate('2/30', '2026-12-02', ''), '');
  assert.equal(X.TA_parseYen('1,240円'), 1240);
  assert.equal(X.TA_parseYen('12?'), null);
  assert.equal(X.TA_aiParse('{"stop_reason":"refusal","content":[]}').error, 'refusal');
  assert.equal(X.TA_aiParse('x').error, 'parse');
  const idx = { worked: { '1:2026-11-05': true }, covered: { '2026-11-05': true, '2026-11-06': true }, first: '2026-11-01' };
  assert.deepEqual(['2026-11-05', '2026-11-06', '2026-10-30', '2026-12-09'].map((d) => X.TA_totCheck(idx, '0001', d)), ['あり', 'なし', '確認できない', '未確認']);
  assert.equal(X.TA_totCheck(idx, '', '2026-11-05'), '確認できない');
  assert.equal(X.TA_placeLabel('架空県甲市1-1'), '（場所）');
  assert.equal(X.TA_placeLabel('甲町'), '甲町');
});
