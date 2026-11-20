import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 交通費申請（gas/TravelApply.gs・版 2026-11-20a）・給与反映シート（gas/PayrollSheet.gs）。すべて架空の社員番号・氏名・住所・店舗・LINE ID。AI・LINE・Maps は模擬（実際には呼ばない）
const FILES = ['AlcoholCheck.gs', 'Inquiry.gs', 'Notices.gs', 'License.gs', 'OfficeTask.gs', 'Travel.gs', 'TravelApply.gs', 'PayrollSheet.gs'];
// 給与反映シート（社労士共有用【リバースHD】）の本番の形（2026-11-19 に確認した見出しと形。値は架空）：
// 1行目 B「2026年」・C「11月支給」／2行目 B〜I の見出し／3行目から人の行（I 列 =SUM(D:H)）／すぐ下に合計の行（D〜I =SUM(D3:D…)）／
// その下に固定立て替えの表（D〜J）と L 列のチェックボックス・M 列のメモ
const PAY_HEAD = ['', '従業員番号', '氏名', '立替経費', '通勤手当', '固定立て替え', '家賃補助', 'インセンティブ', '合計'];
const FIXED_HEAD = ['', '', '', '内容', '', '合計金額', '支払い回数', '期間（開始）', '期間（終了）', '当月徴収金額', '', false, '修正箇所'];
const FIXED_ROW = ['', '', '', 'テスト備品', '', 30000, 6, "'2026-10", "'2027-03", 5000, '', true, 'テストのメモ'];
/** 月のタブ（テンプレも同じ形）。people＝[[従業員番号（空なら書かない）, 氏名, {列: 値}]]（空の行は null）。total＝合計の行の B 列（本番は B〜C 結合で「合計」） */
function payTab(sr, name, head1, people, total, noTotal = []) {   // noTotal＝合計の列を空にする人の行（0 から）
  const sh = sr.insertSheet(name);
  sh.appendRow(['', ...head1]); sh.appendRow(PAY_HEAD);
  const cols = { 立替経費: 4, 通勤手当: 5, 固定立て替え: 6, 家賃補助: 7, インセンティブ: 8 };
  people.forEach((p, i) => {
    const r = 3 + i;
    if (p) { if (p[0]) sh.getRange(r, 2).setValue("'" + p[0]); sh.getRange(r, 3).setValue(p[1]); Object.entries(p[2] || {}).forEach(([k, v]) => sh.getRange(r, cols[k]).setValue(v)); }
    if (!noTotal.includes(i)) sh.getRange(r, 9).setFormula((i === 1 ? '=sum' : '=SUM') + `(D${r}:H${r})`);   // 小文字の =sum の行もある
  });
  const sumRow = 3 + people.length;
  if (total) sh.getRange(sumRow, 2).setValue(total);
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
// 申請書 v2（版 2026-11-19f）の AI の答え。km（片道）・yen（運賃）は前の書き方のまま渡せる（片道・km を合計に。trip の既定は片道）
const V2 = { km: 'one_way_km', yen: 'fare' };
const row = ({ km, yen, unclear = [], ...o }) => ({ example: false, date: '', means: 'car', from: '', to: '', trip: 'oneway', one_way_km: km ?? '', total_km: '', fare: yen ?? '',
  ...o, unclear: unclear.map((f) => V2[f] || f) });
// 申請書 v3（版 2026-11-19g）：枚数と合計欄①〜④。head＝{ page, pages, sum_km, car_yen, fare_total, grand_total, unclear }
const form = (rows, month = '2026-11', fare = '', head = {}) => ({ json: { is_travel_form: true, month, page: '', pages: '', sum_km: '', car_yen: '', fare_total: fare, grand_total: '',
  unclear: [], ...head, rows: rows.map(row) } });
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
  assert.deepEqual(d.map((r) => [String(r[2]), r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11]]),
    [['2026-11-05', '自宅', '甲町', '車', '片道', 10, 10, 150, '未確認', 'OK'], ['2026-11-05', '甲町店', '自宅', '車', '片道', 12, 12, 180, '未確認', 'OK']]);
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
  g.ai.queue.push({ json: { is_travel_form: false, month: '', page: '', pages: '', sum_km: '', car_yen: '', fare_total: '', grand_total: '', unclear: [], rows: [] } });
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
  assert.deepEqual(d.map((r) => [r[8], r[11]]), [['', '要確認'], [30, '要確認'], [10, '要確認'], [10, '要確認'], [10, '要確認']]);
  assert.match(d[0][12], /距離（km）が読み取れませんでした/);
  assert.match(d[1][12], /日付が読み取れませんでした/);
  assert.equal(String(d[1][2]), '');
  assert.match(d[2][12], /手段/);
  assert.equal(d[2][5], '');
  assert.match(d[3][12], /読み取れませんでした/);
  assert.equal(d[3][3], '');
  assert.match(d[4][12], /対象の月の外/);
  assert.equal(apps(master)[0][6], '要確認');
  // AI が使えない（HTTP 500）：写真は保存し、申請書全体を要確認。返信は「管理本部が写真で確認」
  g.ai.queue.push({ status: 500 });
  const n = g.fetches.length;
  photo(g, U(2));
  const a2 = apps(master).find((r) => String(r[2]) === '90002');
  assert.deepEqual([String(a2[4]), a2[6]], ['', '要確認']);
  assert.ok(details(master).some((r) => String(r[1]) === '90002' && r[3] === '（申請書全体）' && /AI で申請書を読み取れませんでした/.test(r[12])));
  assert.match(replies(g, n)[0], /内容は管理本部が写真で確認します/);
  assert.ok(pushes(g, n).some((p) => p.to === ADMIN && /交通費申請・エラー/.test(p.text)));
  // 対象月が書かれておらず、日付の月もばらばら
  g.ai.queue.push(form([{ date: '10/30', from: '自宅', to: '甲町', km: '10' }, { date: '11/2', from: '自宅', to: '甲町', km: '10' }], ''));
  photo(g, U(1));
  const a3 = apps(master).filter((r) => String(r[2]) === '90001' && String(r[4]) === '');
  assert.equal(a3.length, 1);
  assert.ok(details(master).some((r) => r[0] === a3[0][0] && r[3] === '（申請書全体）' && /対象の月が読み取れませんでした/.test(r[12])));
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
  assert.deepEqual(d.map((r) => r[11]), ['OK', '要確認', '要確認', 'OK', 'OK', '要確認', '要確認']);
  assert.equal(d[1][12], '要確認（申請 15.1km・自動計算 10km（高速を使わない道。高速を使う道は 13km））');
  assert.equal(d[2][12], '要確認（行き先がわからない：大宮）');
  assert.deepEqual([d[4][5], d[4][8], d[4][9]], ['電車', '', 420]);
  assert.match(d[5][12], /同じ日・同じ区間/);
  assert.equal(d[6][3], '（申請書全体）');
  assert.match(d[6][12], /③運賃の合計」が、各行の運賃を足したものと違います/);
  // 車・バイクの金額：km × 15円（合計は円未満切り捨て）
  assert.deepEqual([d[0][9], d[3][9]], [225, 135]);
});

test('交通費申請（v2 の申請書・19f）: 往復は片道×2（合わなければ要確認・片方だけなら計算）・片道は同じ・電車は運賃のまま・○が無ければ要確認・記入例は読まない・距離の照合は片道・手書きの合計', () => {
  const { g, master } = setup();
  g.ai.queue.push(form([
    { example: true, date: '4/1', from: '自宅', to: '本社', trip: 'round', one_way_km: '8', total_km: '16' },   // 記入例（AI の印）
    { date: '記入例：4/1', from: '自宅', to: '本社', trip: 'round', one_way_km: '8', total_km: '16' },          // 記入例（印が無くても）
    { date: '11/2', from: '自宅', to: '甲町', trip: 'round', one_way_km: '8', total_km: '16' },
    { date: '11/3', from: '自宅', to: '甲町', trip: 'round', one_way_km: '8', total_km: '15' },
    { date: '11/4', from: '自宅', to: '甲町', trip: 'round', one_way_km: '10' },
    { date: '11/5', from: '自宅', to: '甲町', means: 'bike', trip: 'round', total_km: '20' },
    { date: '11/6', from: '自宅', to: '甲町', trip: 'oneway', one_way_km: '9' },
    { date: '11/9', from: '大宮駅', to: '浦和駅', means: 'train', trip: 'round', fare: '340' },
    { date: '11/10', from: '自宅', to: '甲町', trip: 'unknown', one_way_km: '8', total_km: '16' },
    { date: '11/11', from: '大宮駅', to: '浦和駅', means: 'bus', trip: 'unknown', fare: '220' },
  ]));
  photo(g, U(1));
  const call = g.ai.calls[0].body;
  assert.match(call.system, /記入例/);
  assert.deepEqual(Object.keys(call.output_config.format.schema.properties.rows.items.properties),
    ['example', 'date', 'means', 'from', 'to', 'trip', 'one_way_km', 'total_km', 'fare', 'unclear']);
  assert.ok(!/高速/.test(JSON.stringify(call.output_config)));   // 高速料金は読まない
  const d = details(master);
  assert.equal(d.length, 8);                                       // 記入例の2行は記録しない
  assert.ok(!d.some((r) => /記入例/.test(r.join('|'))));
  // [日付, 手段, 往復・片道, 片道, 合計, 金額, 照合結果]
  assert.deepEqual(d.map((r) => [String(r[2]).slice(5), r[5], r[6], r[7], r[8], r[9], r[11]]), [
    ['11-02', '車', '往復', 8, 16, 240, 'OK'],                     // 往復で片道8・合計16
    ['11-03', '車', '往復', 8, 15, 225, '要確認'],                 // 合計が片道×2 と違う
    ['11-04', '車', '往復', 10, 20, 300, 'OK'],                    // 片道だけ → 合計を計算（距離の照合は片道 10km）
    ['11-05', 'バイク', '往復', 10, 20, 300, 'OK'],                // 合計だけ → 片道を計算
    ['11-06', '車', '片道', 9, 9, 135, 'OK'],                      // 片道：合計＝片道
    ['11-09', '電車', '往復', '', '', 340, 'OK'],                  // 電車の往復の運賃は2倍にしない
    ['11-10', '車', '', 8, 16, '', '要確認'],                      // ○が無い：計算しない・金額も出さない
    ['11-11', 'バス', '', '', '', 220, '要確認'],
  ]);
  assert.match(d[1][12], /合計（km）が片道（km）と合いません/);
  assert.match(d[6][12], /往復・片道の○が無いか、両方に○が付いています/);
  assert.match(d[7][12], /往復・片道の○/);
  // 距離の照合は片道で：片道16km（自動計算 10km）は 5km 超で要確認、往復の合計 20km（片道 10km）は OK（上の 11/4）
  g.ai.queue.push(form([{ date: '11/12', from: '自宅', to: '甲町', trip: 'round', one_way_km: '16', total_km: '32' }]));
  photo(g, U(1));
  assert.equal(details(master).at(-1)[12], '要確認（申請 16km・自動計算 10km（高速を使わない道。高速を使う道は 13km））');
  // 合計欄（19g では①・③）：各行と同じなら OK、違えば申請書全体を要確認
  g.ai.queue.push(form([{ date: '11/2', from: '自宅', to: '乙山', trip: 'round', one_way_km: '5', total_km: '10' },
    { date: '11/3', from: '大宮駅', to: '浦和駅', means: 'train', trip: 'round', fare: '340' }], '2026-11', '340', { sum_km: '10' }));
  photo(g, U(2));
  const d2 = () => details(master).filter((r) => String(r[1]) === '90002');
  assert.deepEqual(d2().map((r) => [r[3], r[11]]), [['自宅', 'OK'], ['大宮駅', 'OK']]);
  g.ai.queue.push(form([{ date: '11/4', from: '自宅', to: '乙山', trip: 'round', one_way_km: '5', total_km: '10' }], '2026-11', '', { sum_km: '12' }));
  photo(g, U(2));
  assert.equal(d2().at(-1)[3], '（申請書全体）');
  assert.match(d2().at(-1)[12], /①合計kmの合計」が、各行の合計（km）を足したものと違います/);
  // 毎朝：管理本部が「往復・片道」に 往復 と入れて回答 → 合計＝片道×2 で確定。合わない行は確認後の値で確定
  setD(master, 6, 7, '往復'); setD(master, 6, 14, '本人に確認。往復');
  setD(master, 1, 14, '写真で確認。合計は16'); setD(master, 1, 15, '16');
  at(g, '2026-12-03T07:00:00+09:00');
  g.ctx.travelApplyDaily();
  const d3 = details(master);
  assert.deepEqual([d3[6][6], d3[6][7], d3[6][8], d3[6][9]], ['往復', 8, 16, 240]);
  assert.match(String(d3[6][11]), /^確認済み/);
  assert.deepEqual([d3[1][8], d3[1][9]], [16, 240]);
  assert.match(String(d3[1][11]), /^確認済み/);
  noPersonalLogs(g);
});

test('交通費申請（v3 の申請書・19g）: 合計欄①〜④を用紙ごとに照合（書いていない欄は比べない）・2枚は1つの申請に・届いていない枚目は要確認（届けば確認済み）・同じ枚目はあとの写真・枚数が空欄は1枚', () => {
  const { g, master } = setup();
  const app = (code, month) => apps(master).filter((r) => String(r[2]) === code && String(r[4]) === month);
  const rowsOf = (id) => details(master).filter((r) => r[0] === id);
  // 1枚・①〜④が正しい → OK（②＝①×15・④＝②＋③）
  g.ai.queue.push(form([{ date: '11/2', from: '自宅', to: '甲町', trip: 'round', one_way_km: '8', total_km: '16' },
    { date: '11/3', from: '大宮駅', to: '浦和駅', means: 'train', trip: 'round', fare: '340' }], '2026-11', '340',
  { page: '1', pages: '1', sum_km: '16', car_yen: '240', grand_total: '580' }));
  photo(g, U(1));
  const call = g.ai.calls[0].body;
  assert.match(call.system, /□枚目／全□枚/);
  assert.match(call.system, /④交通費の合計/);
  const a1 = app('90001', '2026-11');
  assert.equal(a1.length, 1);
  assert.equal(String(a1[0][9]), '1/1');
  assert.deepEqual(rowsOf(a1[0][0]).map((r) => [r[3], r[11]]), [['自宅', 'OK'], ['大宮駅', 'OK']]);   // 申請書全体の行は無い
  assert.equal(a1[0][6], '受付');
  // ④だけ違う → 申請書全体を要確認（ほかの欄は合っている）
  g.ai.queue.push(form([{ date: '11/2', from: '自宅', to: '乙山', trip: 'round', one_way_km: '5', total_km: '10' }], '2026-11', '',
    { page: '1', pages: '1', sum_km: '10', car_yen: '150', grand_total: '160' }));
  photo(g, U(2));
  const r2 = rowsOf(app('90002', '2026-11')[0][0]);
  assert.deepEqual(r2.map((r) => [r[3], r[11]]), [['自宅', 'OK'], ['（申請書全体）', '要確認']]);
  assert.equal(r2[1][12], '用紙の「④交通費の合計」が、②＋③と違います');
  assert.equal(app('90002', '2026-11')[0][6], '要確認');
  // 2枚：1/2 だけ届いた → 「2枚目が届いていません」で要確認
  const n = g.fetches.length;
  g.ai.queue.push(form([{ date: '10/5', from: '自宅', to: '甲町', one_way_km: '10' }], '2026-10', '', { page: '1', pages: '2', sum_km: '10', car_yen: '150', grand_total: '150' }));
  photo(g, U(1));
  let a3 = app('90001', '2026-10');
  assert.equal(a3.length, 1);
  assert.equal(a3[0][6], '要確認');
  let w = rowsOf(a3[0][0]).filter((r) => r[3] === '（申請書全体）');
  assert.deepEqual(w.map((r) => [r[11], r[12]]), [['要確認', '届いていない枚目があります（2枚目が届いていません）']]);
  assert.match(replies(g, n)[0], /^交通費申請の写真を受け付けました（10月分・1件）。/);   // 受付の文は今までどおり
  // 2/2 が届く → 1つの申請にまとまり、届いていない枚目の行は確認済みに
  g.ai.queue.push(form([{ date: '10/6', from: '自宅', to: '甲町', one_way_km: '10' }], '2026-10', '', { page: '2', pages: '2', sum_km: '10', car_yen: '150', grand_total: '150' }));
  photo(g, U(1));
  a3 = app('90001', '2026-10');
  assert.equal(a3.length, 1);
  assert.deepEqual([String(a3[0][8]).split(',').length, String(a3[0][9])], [2, '1/2,2/2']);
  w = rowsOf(a3[0][0]).filter((r) => r[3] === '（申請書全体）');
  assert.match(String(w[0][11]), /^確認済み（全部の枚目が届いた）$/);
  assert.deepEqual([a3[0][6], a3[0][7]], ['受付', 300]);
  // 同じ枚目（2/2）がもう一度 → あとの写真を使う。前の 2枚目の明細は「差し替え」・要確認にはしない
  g.ai.queue.push(form([{ date: '10/6', from: '自宅', to: '甲町', one_way_km: '9' }], '2026-10', '', { page: '2', pages: '2', sum_km: '9', car_yen: '135', grand_total: '135' }));
  photo(g, U(1));
  a3 = app('90001', '2026-10');
  assert.equal(a3.length, 1);
  const r3 = rowsOf(a3[0][0]);
  assert.deepEqual(r3.filter((r) => r[3] !== '（申請書全体）').map((r) => [String(r[2]), r[8], String(r[11]), String(r[16])]), [
    ['2026-10-05', 10, 'OK', '1'], ['2026-10-06', 10, '差し替え（2枚目を送り直し）', '2'], ['2026-10-06', 9, 'OK', '2']]);   // 重複にもしない
  assert.ok(!r3.some((r) => r[11] === '要確認'));
  assert.deepEqual([a3[0][6], a3[0][7], String(a3[0][9])], ['受付', 285, '1/2,2/2,2/2']);
  // 枚数が空欄 → 1枚として扱う（届いていない枚目にしない）。もう1枚空欄が来ても差し替えずに足す
  g.ai.queue.push(form([{ date: '11/4', from: '大宮駅', to: '浦和駅', means: 'train', trip: 'oneway', fare: '170' }], '2026-11', '170'));
  photo(g, U(3));
  g.ai.queue.push(form([{ date: '11/5', from: '大宮駅', to: '浦和駅', means: 'train', trip: 'oneway', fare: '170' }], '2026-11', '170'));
  photo(g, U(3));
  const a4 = app('90003', '2026-11');
  assert.equal(a4.length, 1);
  assert.equal(String(a4[0][9]), '-,-');
  assert.deepEqual(rowsOf(a4[0][0]).map((r) => [r[3], r[9], r[11]]), [['大宮駅', 170, 'OK'], ['大宮駅', 170, 'OK']]);
  assert.deepEqual([a4[0][6], a4[0][7]], ['受付', 340]);
  // 毎朝：差し替えの行は TOT の照合もしない
  totLatest(g, { '2026-11-02': ['k1', 'k2'], '2026-11-03': ['k1'], '2026-11-04': ['k3'], '2026-11-05': ['k3'] });
  at(g, '2026-12-03T07:00:00+09:00');
  g.ctx.travelApplyDaily();
  assert.ok(details(master).filter((r) => /^差し替え/.test(String(r[11]))).every((r) => r[10] === '未確認'));
  noPersonalLogs(g);
});

test('交通費申請（枚目の知らせ・19h）: 届いていない枚目は受付の返信には足さず、最後の写真から1時間たっても届かないときだけ本人へ個別 LINE（まとめて送る途中は知らせない・届けば知らせない・8時〜21時台・1回だけ）', () => {
  const { g, master } = setup();
  const pg = (rows, month, page, pages) => form(rows, month, '', { page, pages });
  const car = (date) => ({ date, from: '自宅', to: '甲町', one_way_km: '10' });
  const toMe = (n, uid) => pushes(g, n).filter((p) => p.to === uid).map((p) => p.text);
  const remind = (iso) => { at(g, iso); return g.ctx.travelApplyPagesRemind(); };
  // 1/2 だけ（9:00）→ 受付の返信は今までどおり。30分では知らせない・1時間で知らせる・2回目は送らない
  const n = g.fetches.length;
  g.ai.queue.push(pg([car('10/5')], '2026-10', '1', '2'));
  photo(g, U(1));
  assert.ok(!replies(g, n).some((x) => /届いていません/.test(x)));
  assert.equal(remind('2026-12-02T09:30:00+09:00').sent, 0);
  const r1 = remind('2026-12-02T10:00:00+09:00');
  assert.deepEqual([r1.sent, toMe(n, U(1)).length], [1, 1]);
  assert.match(toMe(n, U(1))[0], /^10月分の交通費申請書の2枚目が届いていません。写真を送ってください。/);
  assert.ok(!/円|km|甲町|試験/.test(toMe(n, U(1))[0]));
  assert.equal(remind('2026-12-02T10:15:00+09:00').sent, 0);
  assert.equal(toMe(n, U(1)).length, 1);
  // まとめて送る途中（1/3 が 10:20・2/3 が 11:00）：最初の写真から1時間でも、最後の写真から1時間たつまでは知らせない
  const n2 = g.fetches.length;
  at(g, '2026-12-02T10:20:00+09:00');
  g.ai.queue.push(pg([car('11/5')], '2026-11', '1', '3'));
  photo(g, U(2), { imageSet: { id: 'set9', index: 1, total: 3 } });
  at(g, '2026-12-02T11:00:00+09:00');
  g.ai.queue.push(pg([car('11/6')], '2026-11', '2', '3'));
  photo(g, U(2), { imageSet: { id: 'set9', index: 2, total: 3 } });
  assert.equal(remind('2026-12-02T11:30:00+09:00').sent, 0);
  assert.deepEqual(toMe(n2, U(2)), []);
  remind('2026-12-02T12:00:00+09:00');
  assert.equal(toMe(n2, U(2)).length, 1);
  assert.match(toMe(n2, U(2))[0], /^11月分の交通費申請書の3枚目が届いていません。/);
  // 1時間の間に全部届けば知らせない（待つのもやめる）
  const n3 = g.fetches.length;
  at(g, '2026-12-02T12:10:00+09:00');
  g.ai.queue.push(pg([{ date: '11/4', from: '大宮駅', to: '浦和駅', means: 'train', fare: '170' }], '2026-11', '1', '2'));
  photo(g, U(3));
  at(g, '2026-12-02T12:40:00+09:00');
  g.ai.queue.push(pg([{ date: '11/5', from: '大宮駅', to: '浦和駅', means: 'train', fare: '170' }], '2026-11', '2', '2'));
  photo(g, U(3));
  const r3 = remind('2026-12-02T13:45:00+09:00');
  assert.deepEqual([r3.sent, r3.waiting, toMe(n3, U(3)).length], [0, 0, 0]);
  // 夜（22:30 の写真）：21時台を過ぎたら朝8時台まで待つ
  const n4 = g.fetches.length;
  at(g, '2026-12-02T22:30:00+09:00');
  g.ai.queue.push(pg([car('11/9')], '2026-11', '1', '2'));
  photo(g, U(1));
  assert.equal(remind('2026-12-02T23:45:00+09:00').sent, 0);
  assert.equal(remind('2026-12-03T07:45:00+09:00').sent, 0);
  assert.equal(remind('2026-12-03T08:00:00+09:00').sent, 1);
  assert.match(toMe(n4, U(1))[0], /^11月分の交通費申請書の2枚目が届いていません。/);
  // record：送らずに「交通費の送る予定」へ
  g.scriptProps.setProperty('TRAVEL_APPLY_MODE', 'record');
  at(g, '2026-12-03T09:00:00+09:00');
  g.ai.queue.push(pg([car('10/10')], '2026-10', '1', '2'));
  photo(g, U(2));   // 90002 の 10月分（新しい申請）
  const n5 = g.fetches.length;
  remind('2026-12-03T10:00:00+09:00');
  assert.equal(pushes(g, n5).length, 0);
  assert.deepEqual(tab(master, '交通費の送る予定').dump().at(-1).slice(1, 4).map(String), ['枚目の知らせ', '90002', '10月分の交通費申請書の2枚目が届いていません。写真を送ってください。']);
  // トリガー：15分ごと
  g.ctx.travelApplySetupTriggers();
  assert.deepEqual(g.triggers.map((x) => x.fn).sort(), ['travelApplyDaily', 'travelApplyPagesRemind', 'travelApplyRemind']);
  noPersonalLogs(g);
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
  assert.deepEqual(d.map((x) => [x[10], x[11]]), [['あり', 'OK'], ['なし', '要確認'], ['あり', '要確認']]);
  const q = requests(ot);
  assert.deepEqual(q.map((x) => x[2]), ['交通費の確認：試験さん（11/6 自宅→甲町（車））'.replace('（車））', '）'), '交通費の確認：試験さん（11/9 自宅→乙山）']);
  assert.match(q[0][4], /^何が：11\/6 自宅→甲町（車）\nなぜ：その日の TOT の出勤の記録がありません\nどう直すか：従業員マスタのファイルの「交通費明細」3行目/);
  assert.match(q[1][4], /片道5kmを超えて/);
  q.forEach((x) => assert.ok(!/円|架空県|(?<!片道)\d+(\.\d+)?km/.test(x[4]), x[4]));
  assert.equal(String(q[0][3]), '2026-12-07');   // 期限：回答の日（12/5 は土曜なので次の平日）
  assert.deepEqual(d.map((x) => String(x[15])), ['', '2', '3']);
  assert.equal(apps(master)[0][6], '要確認');
  // 同じ日にもう1回：同じ依頼は重ねない
  assert.equal(g.ctx.travelApplyDaily().requests, 0);
  // 回答：11/6 は出勤を確認・11/9 は回答なしで［完了］
  setD(master, 1, 14, '本人に確認。11/6 は出勤（打刻漏れ）');
  tab(ot, '臨時の依頼').getRange(3, 6).setValue('完了');
  at(g, '2026-12-04T07:00:00+09:00');
  const r2 = g.ctx.travelApplyDaily();
  assert.deepEqual({ confirmed: r2.confirmed, reissued: r2.reissued, requests: r2.requests }, { confirmed: 1, reissued: 1, requests: 1 });
  const d2 = details(master);
  assert.match(String(d2[1][11]), /^確認済み（12\/4）$/);
  assert.equal(requests(ot)[0][5], '完了');
  assert.equal(String(d2[2][15]), '4');                         // 出し直した依頼の行
  assert.match(d2[2][12], /回答が空のまま［完了］になっていました/);
  assert.match(requests(ot)[2][4], /なぜ：回答が空のまま/);
  // 確認後の値（km）を入れて確定 → 申請は確定、合計は直した km で
  setD(master, 2, 14, '道順を確認。迂回あり'); setD(master, 2, 15, '33');
  at(g, '2026-12-05T07:00:00+09:00');
  g.ctx.travelApplyDaily();
  const d3 = details(master);
  assert.deepEqual([d3[2][8], d3[2][9]], [33, 495]);
  assert.deepEqual([apps(master)[0][6], apps(master)[0][7]], ['確定', 795]);   // (10 + 10 + 33) × 15
  noPersonalLogs(g);
});

test('交通費申請（締切・20h）: 3日 10:00 の催促（月末の締めが動いていないときだけ）は対象者だけ・提出済みには送らない・土日でも送る・同じ月は1回。前月分は3日 23:59 まで・4日 0時以降は来月反映（本人にも返信で伝える）。回答の日は5日（土日なら次の平日）', () => {
  const { g, master } = setup({ TRAVEL_APPLY_MODE: 'on' }, '2026-07-02T09:00:00+09:00');
  at(g, '2026-10-02T09:00:00+09:00');
  g.ai.queue.push(form([{ date: '9/5', from: '自宅', to: '甲町', km: '15' }], '2026-09'));
  photo(g, U(2));   // 90002 は9月分を提出済み
  at(g, '2026-10-03T10:00:00+09:00');   // 土曜
  const n = g.fetches.length;
  const r = g.ctx.travelApplyRemind();
  assert.deepEqual({ sent: r.sent, month: r.month }, { sent: 1, month: '2026-09' });
  const p = pushes(g, n);
  assert.deepEqual(p.map((x) => x.to), [U(1)]);   // 公共交通機関・ガソリンカード・固定額・退職者・提出済みには送らない
  assert.match(p[0].text, /^先月分の交通費申請がまだ届いていません。本日中に申請書の写真をこちらへ送ってください。4日以降に届いた分は、来月のお給料での反映になります。/);
  assert.equal(g.ctx.travelApplyRemind().sent, 0);   // 2回目は送らない
  at(g, '2026-10-04T10:00:00+09:00');
  assert.equal(g.ctx.travelApplyRemind().skipped, '3日ではない');
  g.scriptProps.setProperty('MONTH_CLOSE_NOTIFY', 'on');
  at(g, '2026-11-03T10:00:00+09:00');
  assert.match(g.ctx.travelApplyRemind().skipped, /月末の締め/);   // 月末の締めが3日の朝にまとめて送る
  g.scriptProps.deleteProperty('MONTH_CLOSE_NOTIFY');
  // 3日までは前月の反映・4日からは来月反映
  const X = g.ctx;
  assert.deepEqual(['2026-12-03', '2026-12-04', '2026-11-30'].map((t) => X.TA_reflectMonth('2026-11', t)), ['2026-11', '2026-12', '2026-11']);
  assert.equal(X.TA_reflectMonth('2026-10', '2026-12-03'), '2026-11');
  assert.deepEqual([X.TA_acceptDeadline('2026-11'), X.TA_answerDay('2026-11'), X.TA_answerDay('2026-09')], ['2026-12-03', '2026-12-07', '2026-10-05']);
  at(g, '2026-07-03T23:59:00+09:00');   // 3日 23:59 は前月分として受け付ける
  g.ai.queue.push(form([{ date: '6/9', from: '自宅', to: '甲町', km: '10' }], '2026-06'));
  photo(g, U(2));
  assert.equal(String(apps(master).filter((x) => String(x[2]) === '90002').at(-1)[5]), '2026-06');
  at(g, '2026-07-04T00:00:00+09:00');
  g.ai.queue.push(form([{ date: '6/8', from: '自宅', to: '甲町', km: '10' }], '2026-06'));
  const n2 = g.fetches.length;
  photo(g, U(1));
  const a = apps(master).find((x) => String(x[2]) === '90001');
  assert.deepEqual([String(a[4]), String(a[5])], ['2026-06', '2026-07']);
  assert.match(replies(g, n2)[0], /（6月分・1件）。[\s\S]*受付の締切（7\/3）を過ぎて届いたため、来月のお給料での反映になります。/);
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
  assert.match(adm[0].text, /^【交通費】11月分を締めました（受付は12\/3まで・回答は12\/7まで）。\n給与反映シートの「R8.11月分12月支給」（テンプレから作りました）の「通勤手当」に 3人分を書きました。\n・未提出 0人\n・要確認が残っている 1人（来月に反映）\n　90002 試験 二郎/);
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
  assert.deepEqual([ex.formulas['5,9'], ex.formulas['6,4'], ex.formulas['6,9']], ['=SUM(D5:H5)', '=SUM(D3:D5)', '=SUM(I3:I5)']);
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

test('交通費申請（給与反映シート）: 本番の形（合計の行の B が「合計」・番号なしで氏名だけの行・氏名の空白の違い・#N/A・同じ氏名が2行）。氏名で照合して書き、番号は書き足さない。同名2行は書かずに要確認。新しい人だけ足す', () => {
  const { g, sr } = setup();
  totLatest(g, { '2026-11-05': ['k1'], '2026-11-06': ['k1'], '2026-11-12': ['k3'] });
  g.ai.queue.push(form([{ date: '11/5', from: '自宅', to: '甲町', km: '10' }, { date: '11/6', from: '甲町', to: '乙山', km: '20' }]));
  photo(g, U(1));
  g.ai.queue.push(form([{ date: '11/12', from: '大宮駅', to: '浦和駅', means: 'train', yen: '420' }]));
  photo(g, U(3));
  // 90001 は番号なし・空白なしの「試験一郎」、#N/A の行、90005（固定額）は「試験 五郎」と全角空白の「試験　五郎」の2行、90003 は並んでいない
  const ex = payTab(sr, '★R8.11月分12月支給', ['2026年', '12月支給'],
    [['', '試験一郎'], ['', '#N/A'], ['', '試験 五郎'], ['', '試験　五郎', { インセンティブ: 100 }]], '合計');
  const n0 = g.fetches.length;
  at(g, '2026-12-06T07:00:00+09:00');
  g.ctx.travelApplyDaily();
  const v = ex.dump();
  assert.deepEqual(v.slice(2, 8).map((x) => [String(x[1]), x[2], x[4]]), [
    ['', '試験一郎', 450], ['', '#N/A', ''], ['', '試験 五郎', ''], ['', '試験　五郎', ''], ['90003', '試験 三郎', 420], ['合計', '', '']]);   // 番号は書き足さない・同名2行には書かない・90003 だけ合計の行の上に足す
  assert.deepEqual([4, 5, 9].map((c) => ex.formulas[`8,${c}`]), ['=SUM(D3:D7)', '=SUM(E3:E7)', '=SUM(I3:I7)']);
  assert.equal(v[10][3], '内容');
  const adm = pushes(g, n0).filter((p) => p.to === ADMIN)[0].text;
  assert.match(adm, /「★R8.11月分12月支給」の「通勤手当」に 2人分を書きました。\n・並んでいなかったため行を足した：従業員番号 90003\n・同じ人の行が2行以上あるため書かなかった（要確認）：従業員番号 90005\n/);
  assert.doesNotMatch(adm, /すでに値がある/);
  assert.ok(g.logs.some((l) => /同じ人の行が2行以上あり書かなかった 1人/.test(l)));
  noPersonalLogs(g);
  // 純粋関数
  const X = g.ctx;
  assert.equal(X.PAY_normPerson('試験　一郎 '), X.PAY_normPerson('試験一郎'));
  assert.equal(X.PAY_normPerson('ｼｹﾝ'), X.PAY_normPerson('シケン'));
  assert.equal(X.PAY_normPerson('#N/A'), '');
  const rows = [{ row: 3, code: '', name: '試験一郎' }, { row: 4, code: '90002', name: '別の表記' }, { row: 5, code: '', name: '試験二郎' }];
  assert.deepEqual([...X.PAY_match(rows, { code: '90001', name: '試験 一郎' })].map((r) => r.row), [3]);
  assert.deepEqual([...X.PAY_match(rows, { code: '90002', name: '試験 二郎' })].map((r) => r.row), [4]);   // 番号が先
  assert.equal(X.PAY_match(rows, { code: '90009', name: '' }).length, 0);
});

test('給与反映シート（19e）: 足した行の合計の列。3行目の合計が空なら式のある行から同じ形で写す・どの行にも無ければ =SUM(D{行}:H{行})。既存の行の空いた合計の欄には書かない', () => {
  const { g, sr } = setup();
  const people = [{ code: '90001', name: '試験 一郎' }, { code: '90002', name: '試験 二郎' }, { code: '90003', name: '試験 三郎' }];
  // 3行目（90001）の合計が空・4行目（90002）は小文字の =sum
  const a = payTab(sr, 'R8.12月分1月支給', ['2027年', '1月支給'], [['90001', '試験 一郎'], ['90002', '試験 二郎']], '合計', [0]);
  g.ctx.PAY_writeColumn_('2026-12', '通勤手当', [{ code: '90003', value: 420 }], { people, mode: 'on' });
  assert.deepEqual([3, 4, 5].map((r) => a.formulas[`${r},9`] || ''), ['', '=sum(D4:H4)', '=sum(D5:H5)']);
  assert.deepEqual([String(a.dump()[4][1]), a.dump()[4][4]], ['90003', 420]);
  assert.equal(a.formulas['6,9'], '=SUM(I3:I5)');
  // どの行にも合計の式が無い
  const b = payTab(sr, 'R9.1月分2月支給', ['2027年', '2月支給'], [['90001', '試験 一郎'], ['90002', '試験 二郎']], '合計', [0, 1]);
  g.ctx.PAY_writeColumn_('2027-01', '通勤手当', [{ code: '90001', value: 100 }, { code: '90003', value: 420 }], { people, mode: 'on' });
  assert.deepEqual([3, 4, 5].map((r) => b.formulas[`${r},9`] || ''), ['', '', '=SUM(D5:H5)']);
  assert.equal(b.dump()[2][4], 100);
  // 純粋関数
  const X = g.ctx;
  assert.deepEqual([X.PAY_isRowSum('=SUM(D5:H5)', 5), X.PAY_isRowSum('=sum(D5:H5)', 5), X.PAY_isRowSum('=SUM(D3:D25)', 3), X.PAY_isRowSum('=SUM(D5:H5)+1', 5), X.PAY_isRowSum('', 5)], [true, true, false, false, false]);
});

// 固定店舗（日額×出勤日数）（版 2026-11-20a）：日別勤怠（11/1〜12/1。k9 はどの日にもいる架空の人）。days＝{ key: { 日付: 日別勤怠の項目 } }
const totDaily = (g, days, skip = []) => {
  const dates = []; for (let d = new Date(Date.UTC(2026, 10, 1)); d < new Date(Date.UTC(2026, 11, 2)); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
  const results = { employees: [{ key: 'k1', code: '0001' }, { key: 'k2', code: '0002' }, { key: 'k3', code: '0003' }, { key: 'k4', code: '0004' }, { key: 'k9', code: '0099' }],
    workings: dates.filter((d) => !skip.includes(d)).map((d) => ({ date: d, dailyWorkings: [{ date: d, employeeKey: 'k9', totalWork: 480, isError: false },
      ...Object.entries(days).filter(([, v]) => v[d]).map(([k, v]) => ({ date: d, employeeKey: k, totalWork: 0, isError: false, ...v[d] }))] })) };
  g.drive.files['tot-latest.json'] = { content: JSON.stringify({ today: '2026-12-02', results }), updated: g.clock.now };
};
const PAID = { totalWork: 0, holidaysObtained: { fulltimeHoliday: { code: 1, name: '有休' } } };
const HALF = { totalWork: 240, holidaysObtained: { halfdayHolidays: [{ code: 1, name: '有休' }] } };
/** 90002・90003・90004 を固定店舗（日額×出勤日数）に。日額は 90002＝700・90003＝空・90004＝800（架空） */
const dailySetup = (props) => {
  const o = setup(props);
  const c = tab(o.master, '通勤距離'), set = (code, col, v) => c.getRange(c.dump().findIndex((r) => String(r[0]) === code) + 1, col).setValue(v);
  ['90002', '90003', '90004'].forEach((code) => set(code, 6, '固定店舗（日額×出勤日数）'));
  set('90002', 8, 700); set('90004', 8, 800);
  totDaily(o.g, {
    k4: { '2026-11-02': { totalWork: 480 }, '2026-11-03': { totalWork: 480 }, '2026-11-04': PAID, '2026-11-05': HALF,
      '2026-11-08': { totalWork: 300, workdayTypeName: '法定休日' }, '2026-11-09': { totalWork: 0, holidaysObtained: { fulltimeHoliday: { code: 9, name: '欠勤' } } } },
    k2: { '2026-11-02': { totalWork: 480 }, '2026-11-03': { totalWork: 0, isError: true } },
    k3: { '2026-11-02': { totalWork: 480 } },
  });
  return o;
};

test('交通費申請（固定店舗・20a）: 6日の締めで日額×前月の出勤日数を「通勤手当」へ（有給・欠勤の日は数えない・半日有給＋出勤と休日出勤は1日）。エラー勤務の日・日額が空は書かずに要確認で管理者の一覧へ。4日の催促と写真の読み取りの対象外', () => {
  const { g, master, inq, sr } = dailySetup();
  // 写真が届いても読まない（ほかの対象外の区分と同じく問い合わせへ）
  const c0 = cases(inq).length;
  photo(g, U(4));
  assert.equal(g.ai.calls.length, 0);
  assert.equal(cases(inq).length, c0 + 1);
  assert.equal(apps(master).length, 0);
  // 3日の催促は「交通費申請（車・バイク）」の 90001 だけ
  at(g, '2026-12-03T10:00:00+09:00');
  const n0 = g.fetches.length;
  g.ctx.travelApplyRemind();
  assert.deepEqual(pushes(g, n0).map((x) => x.to), [U(1)]);
  // 6日の締め
  at(g, '2026-12-06T07:00:00+09:00');
  const n = g.fetches.length;
  const r = g.ctx.travelApplyDaily();
  assert.match(r.closed, /2026-11 を締め（書いた 2・上書きしなかった 0・未提出 1・要確認 0・来月へ 0件・固定店舗 書いた 1・要確認 2）/);
  const v = tab(sr, 'R8.11月分12月支給').dump(), yen = (code) => v.find((x) => String(x[1]) === code)[4];
  assert.equal(yen('90004'), 3200);   // 800円 × 4日（11/2・11/3・11/5 半日有給＋出勤・11/8 休日出勤。11/4 有休・11/9 欠勤は数えない）
  assert.equal(yen('90002'), '');      // エラー勤務の日がある
  assert.equal(yen('90003'), '');      // 日額が空
  assert.equal(yen('90005'), 12000);   // 定期（固定額）は今までどおり
  const adm = pushes(g, n).filter((x) => x.to === ADMIN);
  assert.equal(adm.length, 1);
  assert.match(adm[0].text, /・未提出 1人\n　90001 試験 一郎\n・要確認が残っている 0人（来月に反映）\n・固定店舗（日額×出勤日数）：書いた 1人・書かなかった（要確認） 2人\n　90002 試験 二郎（エラー勤務の日がある（11\/3））\n　90003 試験 三郎（日額が空）\nTOT・「通勤距離」の日額を直したあと travelApplyCloseAgain を実行してください。$/);
  assert.ok(!/3200|800/.test(adm[0].text));   // 管理者への一覧にも金額は出さない
  // 直してやり直すと、書いていなかった人だけ書く（書いた欄は上書きしない）
  const c = tab(master, '通勤距離');
  c.getRange(c.dump().findIndex((x) => String(x[0]) === '90003') + 1, 8).setValue('1,000');
  g.ctx.travelApplyCloseAgain('2026-11');
  const v2 = tab(sr, 'R8.11月分12月支給').dump();
  assert.deepEqual(['90002', '90003', '90004'].map((code) => v2.find((x) => String(x[1]) === code)[4]), ['', 1000, 3200]);
  noPersonalLogs(g);
});

test('交通費申請（固定店舗・20a・record）: 書かずに「交通費の送る予定」へ。給与反映シートのタブも作らない', () => {
  const { g, master, sr } = dailySetup({ TRAVEL_APPLY_MODE: 'record' });
  at(g, '2026-12-06T07:00:00+09:00');
  const n = g.fetches.length;
  const r = g.ctx.travelApplyDaily();
  assert.match(r.closed, /固定店舗 書いた 1・要確認 2/);
  assert.equal(pushes(g, n).length, 0);
  assert.equal(tab(sr, 'R8.11月分12月支給'), null);
  const plan = tab(master, '交通費の送る予定').dump().slice(1);
  const pay = plan.find((x) => x[1] === '給与反映シート');
  assert.ok(pay[3].split('\n').includes('90004 3200'));
  assert.ok(!pay[3].split('\n').some((l) => /^9000[23] /.test(l)));
  assert.match(plan.find((x) => x[1] === '管理者のまとめ')[3], /固定店舗（日額×出勤日数）：書いた 1人・書かなかった（要確認） 2人/);
  noPersonalLogs(g);
});

test('交通費申請（固定店舗・20a・純粋関数）: 出勤日数・エラー勤務・日額が空・0日・日別勤怠がそろっていない', () => {
  const { g } = setup({});
  const X = g.ctx;
  const R = (rows, days = 30) => ({ employees: [{ key: 'a', code: '0001' }, { key: 'z', code: '0099' }], workings: Array.from({ length: days }, (_, i) => {
    const d = `2026-11-${String(i + 1).padStart(2, '0')}`;
    return { date: d, dailyWorkings: [{ date: d, employeeKey: 'z', totalWork: 0 }, ...rows.filter((x) => x.date === d).map((x) => ({ employeeKey: 'a', ...x }))] };
  }) });
  const idx = X.TA_dailyIndex(R([{ date: '2026-11-02', totalWork: 480 }, { date: '2026-11-02', totalWork: 60 }, { date: '2026-11-03', ...PAID }, { date: '2026-11-04', ...HALF },
    { date: '2026-11-05', totalWork: 480, holidaysObtained: { fulltimeHoliday: { code: 1, name: '有休' } } }]), '2026-11');
  assert.equal(idx.ok, true);
  assert.equal(idx.byTot[X.AC_totKey('0001')].days, 2);   // 11/2（2行でも1日）・11/4 半日有休＋出勤。11/3・11/5 の全日の有休は数えない
  assert.deepEqual({ ...X.TA_dailyAmount(500, idx, '0001'), errors: [] }, { amount: 1000, days: 2, issue: '', errors: [] });
  assert.equal(X.TA_dailyAmount('', idx, '0001').issue, 'noDaily');
  assert.equal(X.TA_dailyAmount(0, idx, '0001').issue, 'noDaily');
  assert.equal(X.TA_dailyAmount(500, idx, '0099').issue, 'zero');      // 出勤日数が0
  assert.equal(X.TA_dailyAmount(500, idx, '0777').issue, 'zero');      // TOT にいない人
  const err = X.TA_dailyIndex(R([{ date: '2026-11-02', totalWork: 480 }, { date: '2026-11-12', isError: true, totalWork: 0 }, { date: '2026-11-07', isError: true, totalWork: 200 }]), '2026-11');
  const e = X.TA_dailyAmount(500, err, '0001');
  assert.deepEqual([e.amount, e.days, e.issue, [...e.errors]], [0, 2, 'error', ['2026-11-07', '2026-11-12']]);
  assert.equal(X.TA_dailyReason(e), 'エラー勤務の日がある（11/7・11/12）');
  assert.equal(X.TA_dailyIndex(R([], 29), '2026-11').ok, false);      // 11/30 が無い（月末より前のデータ）
  assert.equal(X.TA_dailyAmount(500, X.TA_dailyIndex(R([], 29), '2026-11'), '0001').issue, 'noData');
  assert.equal(X.TA_dailyIndex({ employees: [], workings: { _error: 500 } }, '2026-11').ok, false);
  assert.equal(X.TA_dailyIndex(null, '2026-11').ok, false);
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
  at(g, '2026-12-03T10:00:00+09:00');
  const n2 = g.fetches.length;
  g.ctx.travelApplyRemind();
  assert.equal(pushes(g, n2).length, 0);
  assert.deepEqual(plan().slice(-1), ['3日の催促']);
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
  // 19f：往復・片道の km
  assert.deepEqual({ ...X.TA_carKm('往復', 8, 16) }, { one: 8, km: 16, issue: null });
  assert.deepEqual({ ...X.TA_carKm('往復', 8, 15) }, { one: 8, km: 15, issue: 'roundKm' });
  assert.deepEqual({ ...X.TA_carKm('往復', 8.25, null) }, { one: 8.25, km: 16.5, issue: null });
  assert.deepEqual({ ...X.TA_carKm('往復', null, 15) }, { one: 7.5, km: 15, issue: null });
  assert.deepEqual({ ...X.TA_carKm('片道', 9, null) }, { one: 9, km: 9, issue: null });
  assert.deepEqual({ ...X.TA_carKm('片道', 9, 18) }, { one: 9, km: 18, issue: 'roundKm' });
  assert.deepEqual({ ...X.TA_carKm('', 8, 16) }, { one: 8, km: 16, issue: 'trip' });
  assert.deepEqual({ ...X.TA_carKm('往復', null, null) }, { one: null, km: null, issue: 'km' });
  assert.deepEqual(['往復', '片道', 'round', '', '往'].map((t) => X.TA_tripOf(t)), ['往復', '片道', '往復', '', '']);
  assert.equal(X.TA_isExample({ example: false, date: '記入例：4/1' }), true);
  assert.equal(X.TA_isExample({ example: false, date: '4/1', from: '自宅' }), false);
  // 19g：合計欄①〜④（書いていない欄は比べない）
  const R = [{ means: '車', km: 16, yen: 240 }, { means: '電車', km: null, yen: 340 }];
  const S = (km, carYen, fare, total) => ({ km, carYen, fare, total });
  const codes = (rows, s) => [...X.TA_sumIssues(rows, s, 15)].map((i) => i.code).join(',');
  assert.equal(codes(R, S(16, 240, 340, 580)), '');
  assert.equal(codes(R, S(null, null, null, null)), '');                       // 空欄だけでは要確認にしない
  assert.equal(codes(R, S(17, 255, 340, 595)), 'sumKm');                       // ①が行と違う（②＝①×15 は合う）
  assert.equal(codes(R, S(16, 250, 340, 590)), 'sumCarYen');
  assert.equal(codes(R, S(16, 240, 300, 540)), 'sumFare');
  assert.equal(codes(R, S(16, 240, 340, 600)), 'sumTotal');                    // ④だけ違う
  assert.equal(codes(R, S(null, 240, 340, 580)), '');                          // ①が無ければ②は比べない
  assert.equal(codes([{ means: '車', km: 10.3, yen: 154.5 }], S(10.3, 155, null, 155)), '');   // 四捨五入・電車が無ければ③は 0
  assert.equal(codes([{ means: '車', km: 10, yen: 150 }], S(null, null, null, 150)), '');      // ②が書いていなければ④は比べない
  assert.equal(codes([{ means: '車', km: null, yen: null }], S(16, null, null, null)), '');    // 読めない行があれば①は比べない
  // 19g：枚数
  const pg = (a, b) => { const r = X.TA_pageOf(a, b); return [r.page, r.pages, r.explicit, r.ok, r.label]; };
  assert.deepEqual(pg('', ''), [1, 1, false, true, '-']);
  assert.deepEqual(pg('1', '2'), [1, 2, true, true, '1/2']);
  assert.deepEqual(pg('２', '２'), [2, 2, true, true, '2/2']);
  assert.deepEqual(pg('2', ''), [2, null, true, true, '2/']);
  assert.deepEqual(pg('', '1'), [1, 1, true, true, '1/1']);
  assert.deepEqual(pg('', '2'), [null, 2, false, false, '?/2']);
  assert.deepEqual(pg('3', '2'), [3, 2, false, false, '?/2']);
  assert.deepEqual(pg(null, '2'), [null, null, false, false, '?']);
  const miss = (l) => [...X.TA_missingPages(l)];
  assert.deepEqual(miss(['1/2']), [2]);
  assert.deepEqual(miss(['1/2', '2/2']), []);
  assert.deepEqual(miss(['2/3']), [1, 3]);
  assert.deepEqual(miss(['-']), []);
  assert.deepEqual(miss(['-', '-']), []);
  assert.deepEqual(miss(['-', '2/2']), []);
  assert.deepEqual(miss(['2/']), [1]);
  assert.deepEqual(miss(['?']), []);
  // 19h：枚目の知らせ
  const H = 3600000;
  assert.deepEqual([[0, H - 1, 10], [0, H, 10], [0, H, 7], [0, H, 8], [0, H, 21], [0, H, 22]].map(([a, b, h]) => X.TA_pagesDue(a, b, h)), [false, true, false, true, true, false]);
  assert.equal(X.TA_pagesText('2026-10', [2, 3]), '10月分の交通費申請書の2・3枚目が届いていません。写真を送ってください。');
  assert.equal(X.TA_pagesText('', [2]), '交通費申請書の2枚目が届いていません。写真を送ってください。');
  const idx = { worked: { '1:2026-11-05': true }, covered: { '2026-11-05': true, '2026-11-06': true }, first: '2026-11-01' };
  assert.deepEqual(['2026-11-05', '2026-11-06', '2026-10-30', '2026-12-09'].map((d) => X.TA_totCheck(idx, '0001', d)), ['あり', 'なし', '確認できない', '未確認']);
  assert.equal(X.TA_totCheck(idx, '', '2026-11-05'), '確認できない');
  assert.equal(X.TA_placeLabel('架空県甲市1-1'), '（場所）');
  assert.equal(X.TA_placeLabel('甲町'), '甲町');
});
