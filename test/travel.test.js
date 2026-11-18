import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 交通費の通勤距離の自動計算と照合（gas/Travel.gs・版 2026-11-18b）。すべて架空の住所・店舗・社員番号・氏名。Maps は模擬（実際には呼ばない）
const FILES = ['AlcoholCheck.gs', 'Notices.gs', 'Travel.gs'];
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const emp = (code, name, dept, { status = '在籍', retiredOn = '' } = {}) => ["'" + code, name, '', status, dept, '', '', '', false, true, '', '', '', retiredOn];
const STORES = [
  ['企業・店舗名', '住所', '電話番号', '備考', '略語'],
  ['テスト自動車 甲町店', '〒100-0001\n架空県甲市1-1', '000-0000-0001', '取引先', '甲町、甲'],
  ['テスト自動車 乙山店', '〒100-0002\n架空県乙市2-2', '000-0000-0002', '取引先', '乙山'],
  ['株式会社リ・バースホールディングス 本社', '〒100-0003\n架空県丙市3-3', '000-0000-0003', '株式会社リ・バースホールディングス', '本社、事務所'],
];
/** 架空の道のり：住所の文字から決まる km（高速あり＝なし＋3） */
const kmOf = (o, d) => { let h = 0; for (const ch of o + '>' + d) h = (h * 31 + ch.charCodeAt(0)) % 997; return 5 + (h % 40); };
const norm = (a) => a.replace('〒', '').replace('\n', ' ');

function setup(props = { TRAVEL_DISTANCE_MODE: 'on' }) {
  const g = createGas({ files: FILES, now: '2026-11-18T03:00:00+09:00' });
  const book = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = book.insertSheet('従業員マスタ');
  [HEAD, emp('90010', '試験 十郎', '部署B'), emp('90002', '試験 二郎', '部署A'), emp('90003', '試験 三郎', '部署A', { status: '退職' }),
    emp('90004', '試験 四郎', '部署C', { retiredOn: '2026-11-01' }), emp('7', '試験 七郎', '部署A')].forEach((r) => m.appendRow(r));
  const st = book.insertSheet('店舗一覧');
  STORES.forEach((r) => st.appendRow(r));
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: book.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake', ...props });
  g.maps.route = (o, d, avoid) => (/不明/.test(o + d) ? 'NOT_FOUND' : kmOf(o, d) + (avoid ? 0 : 3));
  const snap = () => JSON.stringify([m.dump(), st.dump(), m.bg, st.bg]);
  return { g, book, m, st, snap };
}
const tab = (book, n) => book.getSheetByName(n);
const rowOf = (book, code) => tab(book, '通勤距離').dump().find((r) => String(r[0]) === code);
const setAddr = (book, code, addr) => { const t = tab(book, '通勤距離'), i = t.dump().findIndex((r) => String(r[0]) === code); t.getRange(i + 1, 4).setValue(addr); };
const noPersonalLogs = (g) => assert.ok(!g.logs.some((l) => /架空県|試験|\d+(\.\d+)?km/.test(l)), g.logs.join('\n'));

test('交通費（通勤距離）: 毎朝、在籍者と同期（追加・退職者の削除・社員番号の順）。氏名・所属は従業員マスタから。入力の列に色・通勤区分のプルダウン。従業員マスタと店舗一覧は変えない', () => {
  const { g, book, m, snap } = setup({});   // off：表の同期だけ（Maps は呼ばない）
  const before = snap();
  const r = g.ctx.travelDistanceDaily();
  assert.equal(r.mode, 'off');
  assert.equal(g.maps.calls.length, 0);
  const t = tab(book, '通勤距離').dump();
  assert.deepEqual(t[0], ['社員番号', '氏名', '所属', '自宅住所', '住所の更新日', '通勤区分', '固定額', 'テスト自動車 甲町店', 'テスト自動車 乙山店', '株式会社リ・バースホールディングス 本社', '計算日']);
  assert.deepEqual(t.slice(1).map((x) => [String(x[0]), x[1], x[2], x[3]]), [['7', '試験 七郎', '部署A', ''], ['90002', '試験 二郎', '部署A', ''], ['90010', '試験 十郎', '部署B', '']]);
  assert.equal(snap(), before);   // 従業員マスタ・店舗一覧は変えない
  // 入力の列（自宅住所・通勤区分・固定額）に色、通勤区分にプルダウン（選択肢は「通勤区分の選択肢」タブ）
  const sh = tab(book, '通勤距離');
  assert.equal(sh.bg['2,4'], '#fff2cc'); assert.equal(sh.bg['2,6'], '#fff2cc'); assert.equal(sh.bg['2,7'], '#fff2cc'); assert.equal(sh.bg['2,8'], undefined);
  const dv = sh.dv.at(-1);
  assert.deepEqual([dv.c, dv.r], [6, 2]);
  assert.equal(dv.rule.range.sheet.getName(), '通勤区分の選択肢');
  assert.deepEqual(tab(book, '通勤区分の選択肢').dump().slice(1).map((x) => x[0]), ['ガソリンカード', '交通費申請（車・バイク）', '公共交通機関', '定期（固定額）', '会社バイク（立替経費）']);
  assert.equal(tab(book, '距離（内部）').hidden, true);
  // 管理本部の入力（住所・通勤区分・固定額）は残る。選択肢のタブを直しても上書きしない
  const t2 = tab(book, '通勤距離'), i = t2.dump().findIndex((x) => String(x[0]) === '90002') + 1;
  t2.getRange(i, 6).setValue('定期（固定額）'); t2.getRange(i, 7).setValue(12000);
  tab(book, '通勤区分の選択肢').getRange(7, 1).setValue('徒歩');
  // 新しい在籍者・退職者
  m.appendRow(emp('90001', '試験 一郎', '部署A'));
  m.getRange(6, 4).setValue('退職');   // 7 番が退職
  const r2 = g.ctx.travelDistanceDaily();
  assert.deepEqual({ added: r2.added, removed: r2.removed, people: r2.people }, { added: 1, removed: 1, people: 3 });
  assert.deepEqual(tab(book, '通勤距離').dump().slice(1).map((x) => String(x[0])), ['90001', '90002', '90010']);
  assert.deepEqual(rowOf(book, '90002').slice(5, 7), ['定期（固定額）', 12000]);
  assert.equal(tab(book, '通勤区分の選択肢').dump()[6][0], '徒歩');
  // 氏名・所属の変更も反映
  m.getRange(3, 2).setValue('試験 二郎（新）'); m.getRange(3, 5).setValue('部署Z');
  g.ctx.travelDistanceDaily();
  assert.deepEqual(rowOf(book, '90002').slice(1, 3), ['試験 二郎（新）', '部署Z']);
  noPersonalLogs(g);
});

test('交通費（住所の取り込み）: 「住所取り込み」タブから在籍者の分だけを写す（退職者・見つからない番号は写さない・ログは社員番号だけ）。取り込みのタブは消さない・Maps は呼ばない', () => {
  const { g, book } = setup();
  const imp = book.insertSheet('住所取り込み');
  [['社員番号', '自宅住所（番地なし）', '', 'このタブは住所の取り込み用です。'], [90002, '架空県甲市北町'], [7, '架空県乙市南町'], [90003, '架空県丙市東町'],
    [99999, '架空県丁市西町'], [90010, '']].forEach((r) => imp.appendRow(r));
  const before = JSON.stringify(imp.dump());
  const res = g.ctx.travelImportAddresses();
  assert.deepEqual({ copied: res.copied, empty: res.empty, notFound: [...res.notFound] }, { copied: 2, empty: 1, notFound: ['90003', '99999'] });
  assert.equal(g.maps.calls.length, 0);
  assert.equal(rowOf(book, '90002')[3], '架空県甲市北町');
  assert.equal(rowOf(book, '7')[3], '架空県乙市南町');
  assert.equal(rowOf(book, '90010')[3], '');
  assert.equal(String(rowOf(book, '90002')[4]), '2026-11-18');   // 住所の更新日
  assert.equal(JSON.stringify(imp.dump()), before);
  assert.ok(book.getSheetByName('住所取り込み'));
  assert.ok(g.logs.some((l) => /写した 2件.*見つからない 2件（社員番号：90003、99999）/.test(l)));
  assert.ok(!g.logs.some((l) => /架空県|試験/.test(l)));
});

test('交通費（距離）: 住所が入った人と店舗の組だけを計算し、表には高速を使わない道。住所の変更・店舗の追加と削除で、必要な組だけ計算し直し、店舗間の表も合わせる', () => {
  const { g, book, st } = setup();
  g.ctx.travelDistanceDaily();   // 住所なし：店舗どうしの3組だけ
  assert.equal(g.maps.calls.length, 6);
  setAddr(book, '90002', '架空県甲市北町');
  const r = g.ctx.travelDistanceDaily();
  assert.deepEqual({ todo: r.todo, done: r.done, calls: r.calls }, { todo: 3, done: 3, calls: 6 });
  const row = rowOf(book, '90002'), a1 = norm(STORES[1][1]);
  assert.equal(row[7], kmOf('架空県甲市北町', a1));   // 高速を使わない道
  assert.equal(String(row[10]), '2026-11-18');           // 計算日（全店舗がそろった）
  assert.equal(rowOf(book, '7')[7], '');                  // 住所なし
  assert.ok(g.maps.calls.slice(-6).every((c) => c.mode === 'driving' && c.origin === '架空県甲市北町'));
  assert.equal(g.maps.calls.slice(-6).filter((c) => c.avoid === 'highways').length, 3);
  // 店舗間の表（同じ店舗は 0、対称）
  const mx = tab(book, '店舗間距離').dump(), a2 = norm(STORES[2][1]);
  assert.deepEqual(mx[0], ['店舗', 'テスト自動車 甲町店', 'テスト自動車 乙山店', '株式会社リ・バースホールディングス 本社']);
  assert.equal(mx[1][1], 0);
  assert.equal(mx[1][2], kmOf(a1, a2));
  assert.equal(mx[2][1], kmOf(a1, a2));
  // 同じ日にもう1回：変わっていなければ呼ばない
  assert.equal(g.ctx.travelDistanceDaily().calls, 0);
  // 住所の変更：その人の組だけ・住所の更新日が変わる・前の距離は表から消える
  g.clock.now += 24 * 3600000;
  setAddr(book, '90002', '架空県甲市南町');
  g.maps.route = () => ({ throw: 'Service invoked too many times for one day: route.' });   // 計算できない日
  g.ctx.travelDistanceDaily();
  assert.equal(String(rowOf(book, '90002')[4]), '2026-11-19');
  assert.equal(rowOf(book, '90002')[7], '');   // 前の住所の距離は出さない
  g.maps.route = (o, d, avoid) => (/不明/.test(o + d) ? 'NOT_FOUND' : kmOf(o, d) + (avoid ? 0 : 3));
  g.clock.now += 24 * 3600000;
  const r3 = g.ctx.travelDistanceDaily();
  assert.equal(r3.todo, 3);
  assert.equal(rowOf(book, '90002')[7], kmOf('架空県甲市南町', a1));
  // 店舗の追加：列・店舗間の行と列が増え、新しい店舗の組だけ計算
  st.appendRow(['架空商事', '〒100-0004\n架空県丁市4-4', '', '取引先', '']);
  const r4 = g.ctx.travelDistanceDaily();
  assert.equal(r4.todo, 4);   // 自宅1 ＋ 店舗どうし3
  assert.equal(tab(book, '通勤距離').dump()[0][10], '架空商事');
  assert.equal(tab(book, '店舗間距離').dump().length, 5);
  // 店舗の削除：列と行が減る（前より短い表になっても、余りは残らない）
  st.deleteRow(3);   // 乙山店
  const r5 = g.ctx.travelDistanceDaily();
  assert.equal(r5.calls, 0);
  const head = tab(book, '通勤距離').dump()[0];
  assert.deepEqual(head.slice(7), ['テスト自動車 甲町店', '株式会社リ・バースホールディングス 本社', '架空商事', '計算日']);
  assert.equal(tab(book, '店舗間距離').dump().length, 4);
  assert.equal(tab(book, '店舗間距離').dump()[0].length, 4);
  // 見つからない住所は「計算できない」
  setAddr(book, '7', '不明な町');
  g.ctx.travelDistanceDaily();
  assert.equal(rowOf(book, '7')[7], '計算できない');
  noPersonalLogs(g);
});

test('交通費（距離）: 1日の上限（TRAVEL_MAPS_DAILY_MAX）を超えないよう数日に分ける。無料枠のエラーで止める。off は計算しない', () => {
  const { g, book } = setup({ TRAVEL_DISTANCE_MODE: 'on', TRAVEL_MAPS_DAILY_MAX: '8' });
  g.ctx.travelDistanceDaily();
  ['7', '90002', '90010'].forEach((c, k) => setAddr(book, c, '架空県甲市' + k + '丁目'));
  // 店舗どうし3組（6回）は1日目の 6回で済み、残り 2回で自宅の1組
  g.clock.now += 24 * 3600000;
  const d2 = g.ctx.travelDistanceDaily();
  assert.deepEqual({ todo: d2.todo, done: d2.done, calls: d2.calls, left: d2.left, stopped: d2.stopped }, { todo: 9, done: 4, calls: 8, left: 5, stopped: '1日の上限' });
  assert.equal(g.ctx.travelDistanceDaily().calls, 0);   // 同じ日は上限に達している
  g.clock.now += 24 * 3600000;
  assert.equal(g.ctx.travelDistanceDaily().done, 4);
  g.clock.now += 24 * 3600000;
  const d4 = g.ctx.travelDistanceDaily();
  assert.deepEqual({ done: d4.done, left: d4.left }, { done: 1, left: 0 });
  assert.equal(g.maps.calls.length, 6 + 18);
  // 無料枠のエラー：そこで止め、次の日に続き
  const s = setup();
  s.g.ctx.travelDistanceDaily();
  setAddr(s.book, '90002', '架空県甲市北町');
  let k = 0;
  s.g.maps.route = (o, d, avoid) => (++k > 2 ? { throw: 'Service invoked too many times for one day: route.' } : kmOf(o, d) + (avoid ? 0 : 3));
  const q = s.g.ctx.travelDistanceDaily();
  assert.deepEqual({ stopped: q.stopped, done: q.done, left: q.left }, { stopped: 'Maps の無料枠', done: 1, left: 2 });
  // off：表は同期するが Maps は呼ばない
  const o = setup({});
  o.g.ctx.travelDistanceDaily();
  setAddr(o.book, '90002', '架空県甲市北町');
  const off = o.g.ctx.travelDistanceDaily();
  assert.deepEqual({ mode: off.mode, calls: off.calls, left: off.left }, { mode: 'off', calls: 0, left: 6 });
  assert.equal(o.g.maps.calls.length, 0);
  assert.equal(rowOf(o.book, '90002')[7], '');
});

test('交通費（照合）: 新しい表で、片道5km 以内は OK・5km 超は要確認（理由に両方の km）。行き先がわからない・計算できない区間は要確認。許容の km は変えられる', () => {
  const { g, book } = setup();
  g.ctx.travelDistanceDaily();
  setAddr(book, '90002', '架空県甲市北町');
  g.ctx.travelDistanceDaily();
  const a1 = norm(STORES[1][1]), a2 = norm(STORES[2][1]);
  const base = kmOf('架空県甲市北町', a1), sb = kmOf(a1, a2);
  const chk = (code, from, to, km) => g.ctx.travelCheckSegments([{ code, from, to, km }])[0];
  assert.equal(chk('90002', '自宅', '甲町', base + 5).status, 'OK');
  const x = chk('90002', '甲町店', '自宅', base + 5.1);
  assert.equal(x.status, '要確認');
  assert.equal(x.reason, '要確認（申請 ' + (base + 5.1) + 'km・自動計算 ' + base + 'km（高速を使わない道。高速を使う道は ' + (base + 3) + 'km））');
  assert.equal(chk('90002', '自宅', '甲町', 1).status, 'OK');                 // 少ない申請は問題なし
  assert.equal(chk('7', '乙山', '甲町', sb + 5).status, 'OK');                  // 店舗⇄店舗（逆向きも同じ距離）
  assert.equal(chk('7', '乙山', '甲町', sb + 6).status, '要確認');
  assert.equal(chk('7', '甲町', '甲町', 3).status, 'OK');
  assert.equal(g.ctx.travelCheckSegments([{ code: '90002', from: '甲町→自宅', km: base }])[0].status, 'OK');
  const u = g.ctx.travelCheckSegments([{ code: '90002', from: '大宮→自宅', km: 3 }])[0];
  assert.equal(u.reason, '要確認（行き先がわからない：大宮）');
  assert.deepEqual([...u.candidates], ['大宮']);
  assert.equal(chk('7', '自宅', '甲町', 3).reason, '要確認（距離を計算できない）');       // 住所なし
  assert.equal(chk('99999', '自宅', '甲町', 3).reason, '要確認（距離を計算できない）');   // 表にいない
  assert.equal(chk('90002', '自宅', '自宅', 3).reason, '要確認（距離を計算できない）');
  assert.equal(chk('90002', '自宅', '甲町', 'たくさん').reason, '要確認（申請の km が読めない）');
  // 住所が変わって計算し直す前は、前の距離で照合しない
  setAddr(book, '90002', '架空県甲市南町');
  assert.equal(chk('90002', '自宅', '甲町', base).reason, '要確認（距離を計算できない）');
  setAddr(book, '90002', '架空県甲市北町');
  g.scriptProps.setProperty('TRAVEL_TOLERANCE_KM', '10');
  assert.equal(chk('90002', '自宅', '甲町', base + 10).status, 'OK');
  assert.equal(chk('90002', '自宅', '甲町', base + 10.1).status, '要確認');
});

test('交通費（行き先）: 正式名・略語・全角半角・空白・「店」の揺れを吸収し、自宅と組み合わせる。見つからない・2つに当たる名前は推測しない', () => {
  const X = setup().g.ctx;
  const stores = X.TRV_stores(STORES), r = X.TRV_resolver(stores);
  const name = (s) => { const x = X.TRV_resolve(r, s); return x.type === 'store' ? stores[x.i].name : x.type; };
  assert.equal(name('テスト自動車　甲町'), 'テスト自動車 甲町店');
  assert.equal(name('甲町店'), 'テスト自動車 甲町店');
  assert.equal(name('乙山'), 'テスト自動車 乙山店');
  assert.equal(name('ｵﾂﾔﾏ'), 'unknown');
  assert.equal(name('リ・バースホールディングス本社'), '株式会社リ・バースホールディングス 本社');
  assert.equal(name('事務所'), '株式会社リ・バースホールディングス 本社');
  assert.equal(name(' 自宅 '), 'home');
  assert.equal(name('大宮'), 'unknown');
  const dup = X.TRV_stores([...STORES, ['テスト自動車 甲町第二店', '架空県甲市5-5', '', '取引先', '甲']]);
  assert.equal(X.TRV_resolve(X.TRV_resolver(dup), '甲').type, 'ambiguous');
  assert.deepEqual([...X.TRV_parseRoute('自宅 ⇒ 乙山')], ['自宅', '乙山']);
});

test('交通費（確認・安全）: travelDistancePreview は Maps を呼ばずタブも変えない。在籍者が0人に見えたら表を消さずに止める', () => {
  const { g, book, m } = setup();
  const p = g.ctx.travelDistancePreview();
  assert.deepEqual({ people: p.people, stores: p.stores, pairs: p.pairs, todo: p.todo, calls: p.calls, days: p.days, added: p.added }, { people: 3, stores: 3, pairs: 3, todo: 3, calls: 6, days: 1, added: 3 });
  assert.equal(g.maps.calls.length, 0);
  assert.equal(tab(book, '通勤距離'), null);
  g.ctx.travelDistanceDaily();
  setAddr(book, '90002', '架空県甲市北町');
  const before = JSON.stringify(tab(book, '通勤距離').dump());
  m.clearContents();   // 従業員マスタが読めない（0人）
  assert.throws(() => g.ctx.travelDistanceDaily(), /在籍者が0人/);
  assert.equal(JSON.stringify(tab(book, '通勤距離').dump()), before);
  // 実行中の印があれば重ねて動かない（Maps も表も触らない）
  g.cache['trv:running'] = '1';
  const n = g.maps.calls.length;
  assert.equal(g.ctx.travelDistanceDaily().busy, true);
  assert.equal(g.maps.calls.length, n);
});
