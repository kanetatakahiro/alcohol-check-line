/**
 * 交通費（車・バイク）の通勤距離の自動計算と、申請の照合（gas/Travel.gs・版 2026-11-18b・本番未導入）
 *
 * 従業員マスタのファイルの中に、新しいタブだけを足して使う（従業員マスタ本体の列 A〜N・行と、既存のタブは変えない）。
 *   読むだけ：
 *     「従業員マスタ」：在籍者（在籍状況が「退職」でなく、退職日を過ぎていない人）の社員番号・氏名・所属
 *     「店舗一覧」（管理本部が貼る）：A 企業・店舗名／B 住所（郵便番号と住所。改行を含む）／C 電話番号／D 備考／E 略語（読点区切り）
 *     「住所取り込み」（管理本部が一度だけ貼る。A 社員番号／B 自宅住所）：travelImportAddresses だけが読む。スクリプトでは消さない
 *   このファイルが作って、毎朝そろえる：
 *     「通勤距離」：社員番号／氏名／所属／自宅住所／住所の更新日／通勤区分／固定額／（店舗一覧の各店舗までの距離：車・片道・km・高速を使わない道）／計算日。
 *                  在籍者と同期する（新しい人は行を足し、退職者・対象外の人は行を消す。社員番号の順）。氏名・所属は従業員マスタから。
 *                  管理本部が入力するのは「自宅住所」「通勤区分」「固定額」だけ（その列に色を付ける）
 *     「店舗間距離」：店舗一覧の店舗 × 店舗（車・片道・km・高速を使わない道）。店舗一覧が増減したら行と列も合わせる
 *     「通勤区分の選択肢」：通勤区分のプルダウンの選択肢（ここを直すとプルダウンが変わる。最初の1回だけ作り、あとは変えない）
 *     「距離（内部）」（隠す）：計算の結果（高速あり・なし・状態・計算日・住所の指紋）
 *
 * 距離の計算：Apps Script の Maps（DirectionFinder・車）。高速を使う道と使わない道（avoid HIGHWAYS）の2通りを持ち、表には使わない道を出す。
 *   住所が入った・変わった人と店舗の組だけを計算する（住所の指紋で判断）。自宅住所は番地なし（町名まで）でよい（おおよその距離）。
 *   1日に Maps を呼ぶ回数は TRAVEL_MAPS_DAILY_MAX（既定 800）まで。残りは次の日へ。TRAVEL_DISTANCE_MODE=on のときだけ計算する（表の同期は毎朝する）。
 *
 * 申請の照合（travelCheckSegments）：申請の1行（片道1区間）ごとに、自動計算の距離（高速を使わない道）と申請の km を比べ、
 *   TRAVEL_TOLERANCE_KM（既定5km）を超えて多ければ「要確認」。行き先がわからない・距離を計算できない区間も「要確認」（推測しない）。ETC（高速）の判定は入れていない。
 *
 * 住所は Google の Maps にだけ送る（Claude API には送らない）。ログには件数と社員番号だけを書く（住所・氏名・個人ごとの距離は書かない）。
 * 毎朝の処理は3時台（ほかの毎朝の処理と重ならない時刻）。スクリプトのロックは使わない（ほかの処理を待たせない）。
 */
var TRV_VERSION = '2026-11-18b';
var TRV_STORE_SHEET = '店舗一覧', TRV_IMPORT_SHEET = '住所取り込み';
var TRV_COMMUTE_SHEET = '通勤距離', TRV_MATRIX_SHEET = '店舗間距離', TRV_CHOICE_SHEET = '通勤区分の選択肢', TRV_AUTO_SHEET = '距離（内部）';
var TRV_FIXED_HEADER = ['社員番号', '氏名', '所属', '自宅住所', '住所の更新日', '通勤区分', '固定額'];
var TRV_COL = { code: 0, name: 1, dept: 2, addr: 3, addrAt: 4, type: 5, fixed: 6 };   // 「通勤距離」の左の7列
var TRV_INPUT_COLS = [TRV_COL.addr, TRV_COL.type, TRV_COL.fixed];                     // 管理本部が入力する列（色を付ける）
var TRV_INPUT_COLOR = '#fff2cc';
var TRV_COMMUTE_TYPES = ['ガソリンカード', '交通費申請（車・バイク）', '公共交通機関', '定期（固定額）', '会社バイク（立替経費）'];   // 最初に「通勤区分の選択肢」へ入れる
var TRV_AUTO_HEADER = ['種類', '起点', '終点', '高速あり（km）', '高速なし（km）', '状態', '計算日', '指紋'];
var TRV_KIND_HOME = '自宅→店舗', TRV_KIND_STORE = '店舗⇄店舗', TRV_KIND_ADDR = '自宅住所';
var TRV_DONE = '計算済み', TRV_WAIT = '計算待ち';
var TRV_DEFAULT_TOLERANCE_KM = 5, TRV_DEFAULT_MAPS_MAX = 800;
var TRV_HOUR = 3;                 // 毎朝の処理の時刻（3時台。ほかの毎日の処理は 8時台〜20時台。10分ごと・1時間ごとの処理とはロックを使わないので待たせない）
var TRV_RUN_MS = 4.5 * 60000;     // 1回の実行で計算に使う時間（Apps Script の上限6分に余裕を持たせる）

// ---------------- 純粋関数（文字・行き先） ----------------
/** 純粋関数：名前の揺れを吸収した比べるための形（全角・半角・空白・「店」・会社の種類） */
function TRV_norm(s) {
  var t = String(s == null ? '' : s).normalize('NFKC').toLowerCase();
  t = t.replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)/g, '');
  t = t.replace(/[\s　・･\-ー－‐]/g, '');
  return t.replace(/店$/, '');
}
/** 純粋関数：住所を Maps へ送る形（改行・〒を除き、空白を1つに） */
function TRV_addr(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/〒/g, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** 純粋関数：住所の指紋（変わったかを見るだけ。住所そのものは残さない） */
function TRV_fp(s) {
  var t = TRV_addr(s).replace(/\s/g, ''), h = 0x811c9dc5;
  for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return t ? ('00000000' + h.toString(16)).slice(-8) : '';
}
/** 純粋関数：社員番号（' と空白を除いた文字） */
function TRV_code(v) { return String(v == null ? '' : v).replace(/^'/, '').trim(); }

/** 純粋関数：店舗一覧の値 → [{ i, name, addr, fp, own, keys }]。1行目が見出し（B 列が「住所」を含む）なら飛ばす。同じ正式名の2行目からは使わない */
function TRV_stores(values) {
  var out = [], seen = {};
  (values || []).forEach(function (r, k) {
    var name = String(r[0] == null ? '' : r[0]).replace(/[\r\n]+/g, ' ').trim();
    if (!name || (k === 0 && /住所/.test(String(r[1] || ''))) || seen[name]) return;
    seen[name] = true;
    var keys = [TRV_norm(name)];
    String(r[4] == null ? '' : r[4]).split(/[、,，､]/).forEach(function (a) { var n = TRV_norm(a); if (n) keys.push(n); });
    out.push({ i: out.length, name: name, addr: TRV_addr(r[1]), fp: TRV_fp(r[1]), own: /リ・バースホールディングス/.test(String(r[3] || '')), keys: keys });
  });
  return out;
}

/** 純粋関数：比べる形 → 店舗の番号。2つ以上の店舗に当たる形は使わない（推測しない） */
function TRV_resolver(stores) {
  var map = {}, dup = {};
  stores.forEach(function (st) {
    st.keys.forEach(function (k) {
      if (map[k] !== undefined && map[k] !== st.i) dup[k] = true;
      else map[k] = st.i;
    });
  });
  Object.keys(dup).forEach(function (k) { delete map[k]; });
  return { map: map, dup: dup };
}

/** 純粋関数：行き先の名前 → { type: 'home' } ／ { type: 'store', i } ／ { type: 'unknown', name } ／ { type: 'ambiguous', name } */
function TRV_resolve(resolver, name) {
  var n = TRV_norm(name);
  if (n === '自宅') return { type: 'home' };
  if (!n) return { type: 'unknown', name: String(name == null ? '' : name).trim() };
  if (resolver.map[n] !== undefined) return { type: 'store', i: resolver.map[n] };
  return { type: resolver.dup[n] ? 'ambiguous' : 'unknown', name: String(name).trim() };
}

/** 純粋関数：「大宮→自宅」のような区間の文字 → ['大宮', '自宅']（区切りは → ⇒ -> ➡ ～ 〜） */
function TRV_parseRoute(s) {
  return String(s == null ? '' : s).split(/→|⇒|->|➡|～|〜/).map(function (x) { return x.trim(); }).filter(Boolean);
}
/** 純粋関数：km の値（数でなければ null） */
function TRV_km(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var t = String(v == null ? '' : v).normalize('NFKC').replace(/km|,/gi, '').trim();
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}
/** %s を順に埋めた文字（ログ用） */
function TRV_fmt(t) { var a = Array.prototype.slice.call(arguments, 1), i = 0; return String(t).replace(/%s/g, function () { return String(a[i++]); }); }
function TRV_round(n) { return Math.round(n * 10) / 10; }
function TRV_ymd(v) { return v instanceof Date ? Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd') : String(v == null ? '' : v).replace(/^'/, ''); }

// ---------------- 純粋関数（在籍者・表の同期） ----------------
/** 純粋関数：従業員マスタの値 → 在籍者 [{ code, name, dept }]（社員番号の順）。「退職」と退職日を過ぎた人は除く（免許証の管理と同じ判定） */
function TRV_active(masterValues, today) {
  var out = [], seen = {};
  for (var i = 1; i < (masterValues || []).length; i++) {
    var r = masterValues[i], code = AC_cellCode_(r[AC_COL.code]);
    if (!code || seen[code]) continue;
    if (String(r[AC_COL.status] || '').trim() === '退職' || AC_isRetired(r[AC_COL.retiredOn], today)) continue;
    seen[code] = true;
    out.push({ code: code, name: String(r[AC_COL.name] || '').trim(), dept: String(r[AC_COL.dept] || '').trim() });
  }
  return out.sort(TRV_byCode);
}
/** 社員番号の順（数字だけなら数の順、それ以外は文字の順） */
function TRV_byCode(a, b) {
  var x = a.code, y = b.code;
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y) || (x < y ? -1 : x > y ? 1 : 0);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 純粋関数：今の「通勤距離」の値 → { 社員番号: { addr, addrAt, type, fixed } }（見出しの名前で列を探す） */
function TRV_commuteInputs(values) {
  var out = {}, head = (values && values[0] || []).map(function (h) { return String(h || '').trim(); });
  var col = function (name, def) { var j = head.indexOf(name); return j === -1 ? def : j; };
  var c = { code: col('社員番号', 0), addr: col('自宅住所', 3), addrAt: col('住所の更新日', 4), type: col('通勤区分', -1), fixed: col('固定額', -1) };
  (values || []).slice(1).forEach(function (r) {
    var code = TRV_code(r[c.code]);
    if (!code) return;
    out[code] = { addr: String(r[c.addr] == null ? '' : r[c.addr]).trim(), addrAt: TRV_ymd(r[c.addrAt]), type: c.type === -1 ? '' : r[c.type], fixed: c.fixed === -1 ? '' : r[c.fixed] };
  });
  return out;
}

/**
 * 純粋関数：「通勤距離」に並べる人。active＝在籍者、inputs＝今の入力、addrFp＝前回の住所の指紋（{ 社員番号: fp }）。
 * 住所の指紋が前回と違えば、住所の更新日を今日にする。返り値 { people: [{ code, name, dept, addr, fp, addrAt, type, fixed, changed }], added, removed }
 */
function TRV_syncPeople(active, inputs, addrFp, today) {
  var people = active.map(function (a) {
    var cur = inputs[a.code] || { addr: '', addrAt: '', type: '', fixed: '' }, fp = TRV_fp(cur.addr);
    var changed = fp !== (addrFp[a.code] || '');
    return { code: a.code, name: a.name, dept: a.dept, addr: TRV_addr(cur.addr), rawAddr: cur.addr, fp: fp,
      addrAt: changed && (fp || addrFp[a.code]) ? today : cur.addrAt, type: cur.type, fixed: cur.fixed, changed: changed };
  });
  var activeSet = {};
  active.forEach(function (a) { activeSet[a.code] = true; });
  return { people: people, added: active.filter(function (a) { return !inputs[a.code]; }).length,
    removed: Object.keys(inputs).filter(function (c) { return !activeSet[c]; }).length };
}

// ---------------- 純粋関数（計算する組と、計算し直す条件） ----------------
function TRV_key(kind, from, to) { return kind + '|' + from + '|' + to; }

/**
 * 純粋関数：計算する組（自宅→店舗一覧のすべて、店舗⇄店舗は一覧の順で前→後の1通り）。
 * [{ key, kind, from, to, fromAddr, toAddr, fp（両方の住所の指紋） }]。住所が空の組は入れない
 */
function TRV_pairs(people, stores) {
  var out = [];
  people.forEach(function (p) {
    if (!p.addr) return;
    stores.forEach(function (st) {
      if (!st.addr) return;
      out.push({ key: TRV_key(TRV_KIND_HOME, p.code, st.name), kind: TRV_KIND_HOME, from: p.code, to: st.name, fromAddr: p.addr, toAddr: st.addr, fp: p.fp + st.fp });
    });
  });
  for (var a = 0; a < stores.length; a++) {
    for (var b = a + 1; b < stores.length; b++) {
      if (!stores[a].addr || !stores[b].addr) continue;
      out.push({ key: TRV_key(TRV_KIND_STORE, stores[a].name, stores[b].name), kind: TRV_KIND_STORE, from: stores[a].name, to: stores[b].name,
        fromAddr: stores[a].addr, toAddr: stores[b].addr, fp: stores[a].fp + stores[b].fp });
    }
  }
  return out;
}

/** 純粋関数：計算するか。'new'（まだ無い）／'changed'（住所が入った・変わった）／'retry'（前回のエラーのやり直し）／''（不要） */
function TRV_needs(row, pair) {
  if (!row) return 'new';
  if (row.fp !== pair.fp) return 'changed';
  if (row.status === TRV_WAIT) return 'retry';
  return '';
}

/** 純粋関数：「距離（内部）」の値 → { auto: { 鍵: { hw, noHw, status, at, fp } }, addrFp: { 社員番号: fp } } */
function TRV_autoRows(values) {
  var auto = {}, addrFp = {};
  (values || []).slice(1).forEach(function (r) {
    if (!r[0]) return;
    var from = TRV_code(r[1]);
    if (String(r[0]) === TRV_KIND_ADDR) { addrFp[from] = String(r[7] || ''); return; }
    auto[TRV_key(String(r[0]), from, String(r[2]))] = { hw: TRV_km(r[3]), noHw: TRV_km(r[4]), status: String(r[5] || ''), at: TRV_ymd(r[6]), fp: String(r[7] || '') };
  });
  return { auto: auto, addrFp: addrFp };
}

/** 純粋関数：「距離（内部）」に書く行（今の組と、今の在籍者の住所の指紋だけ） */
function TRV_autoValues(pairs, auto, people) {
  var rows = pairs.map(function (p) {
    var a = auto[p.key] || { hw: null, noHw: null, status: TRV_WAIT, at: '', fp: '' };
    return [p.kind, p.kind === TRV_KIND_HOME ? "'" + p.from : p.from, p.to, a.hw === null ? '' : a.hw, a.noHw === null ? '' : a.noHw, a.status, a.at ? "'" + a.at : '', a.fp];
  });
  people.forEach(function (p) { rows.push([TRV_KIND_ADDR, "'" + p.code, '', '', '', '', p.addrAt ? "'" + p.addrAt : '', p.fp]); });
  return rows;
}

/** 純粋関数：表に出す距離（高速を使わない道）。計算済みで住所が今と同じなら km、計算できなければ「計算できない」、まだなら空 */
function TRV_cell(a, fp) {
  if (!a || a.fp !== fp) return '';
  if (a.status === TRV_DONE) return a.noHw === null ? '' : a.noHw;
  return a.status === TRV_WAIT ? '' : '計算できない';
}

/** 純粋関数：「通勤距離」の値（見出し＋1人1行） */
function TRV_commuteValues(people, stores, auto) {
  var head = TRV_FIXED_HEADER.concat(stores.map(function (s) { return s.name; })).concat(['計算日']);
  var rows = people.map(function (p) {
    var last = '', all = !!p.addr;
    var cells = stores.map(function (st) {
      var a = auto[TRV_key(TRV_KIND_HOME, p.code, st.name)], ok = a && a.fp === p.fp + st.fp && a.status !== TRV_WAIT;
      if (!st.addr || !p.addr || !ok) all = false;
      if (ok && a.at > last) last = a.at;
      return p.addr ? TRV_cell(a, p.fp + st.fp) : '';
    });
    return ["'" + p.code, p.name, p.dept, p.rawAddr, p.addrAt ? "'" + p.addrAt : '', p.type, p.fixed].concat(cells).concat([all && last ? "'" + last : '']);
  });
  return [head].concat(rows);
}

/** 純粋関数：「店舗間距離」の値（店舗 × 店舗。同じ店舗は 0） */
function TRV_matrixValues(stores, auto) {
  var head = ['店舗'].concat(stores.map(function (s) { return s.name; }));
  return [head].concat(stores.map(function (a) {
    return [a.name].concat(stores.map(function (b) {
      if (a.i === b.i) return 0;
      var s1 = a.i < b.i ? a : b, s2 = a.i < b.i ? b : a;
      return TRV_cell(auto[TRV_key(TRV_KIND_STORE, s1.name, s2.name)], s1.fp + s2.fp);
    }));
  }));
}

// ---------------- 純粋関数（申請の照合） ----------------
/**
 * 純粋関数：申請の1行（片道1区間）を照合する。ctx＝TRV_buildContext の結果。seg＝{ code, from, to, km }（from・to は行き先の名前）。
 * 基準は高速を使わない道の距離（ETC・高速の判定は入れていない）。
 * 返り値 { status: 'OK'|'要確認', reason, km, base, hw, noHw, candidates（略語として追加する候補の名前） }
 */
function TRV_checkSegment(ctx, seg) {
  var out = { status: '要確認', reason: '', km: TRV_km(seg && seg.km), base: null, hw: null, noHw: null, candidates: [] };
  var a = TRV_resolve(ctx.resolver, seg && seg.from), b = TRV_resolve(ctx.resolver, seg && seg.to);
  [a, b].forEach(function (r) { if (r.type === 'unknown' || r.type === 'ambiguous') out.candidates.push(r.name); });
  if (out.candidates.length) { out.reason = '要確認（行き先がわからない：' + out.candidates.join('、') + '）'; return out; }
  if (out.km === null) { out.reason = '要確認（申請の km が読めない）'; return out; }
  var p = ctx.people[TRV_code(seg.code)];
  var cannot = function () { out.reason = '要確認（距離を計算できない）'; return out; };
  var row;
  if (a.type === 'home' && b.type === 'home') return cannot();
  if (a.type === 'store' && b.type === 'store' && a.i === b.i) row = { hw: 0, noHw: 0, status: TRV_DONE };
  else if (a.type === 'home' || b.type === 'home') {
    var st = ctx.stores[a.type === 'store' ? a.i : b.i];
    if (!p || !p.addr || !st.addr) return cannot();
    row = ctx.auto[TRV_key(TRV_KIND_HOME, p.code, st.name)];
    if (row && row.fp !== p.fp + st.fp) row = null;   // 住所が変わって計算し直す前は、前の距離で照合しない（推測しない）
  } else {
    var s1 = ctx.stores[Math.min(a.i, b.i)], s2 = ctx.stores[Math.max(a.i, b.i)];
    row = ctx.auto[TRV_key(TRV_KIND_STORE, s1.name, s2.name)];
    if (row && row.fp !== s1.fp + s2.fp) row = null;
  }
  if (!row || row.status !== TRV_DONE || row.noHw === null) return cannot();
  out.hw = row.hw; out.noHw = row.noHw; out.base = row.noHw;
  if (out.km > out.base + ctx.toleranceKm) {
    out.reason = '要確認（申請 ' + out.km + 'km・自動計算 ' + out.base + 'km（高速を使わない道' + (row.hw !== null && row.hw !== row.noHw ? '。高速を使う道は ' + row.hw + 'km' : '') + '））';
    return out;
  }
  out.status = 'OK';
  return out;
}

/** 純粋関数：照合に使う形にまとめる。commuteValues＝「通勤距離」の値 */
function TRV_buildContext(storeValues, commuteValues, autoValues, toleranceKm) {
  var stores = TRV_stores(storeValues), people = {}, inputs = TRV_commuteInputs(commuteValues);
  Object.keys(inputs).forEach(function (c) { people[c] = { code: c, addr: TRV_addr(inputs[c].addr), fp: TRV_fp(inputs[c].addr) }; });
  return { stores: stores, resolver: TRV_resolver(stores), people: people, auto: TRV_autoRows(autoValues).auto, toleranceKm: toleranceKm };
}

// ---------------- シート・設定 ----------------
function TRV_props_() { return PropertiesService.getScriptProperties(); }
function TRV_num_(key, def) {
  var s = String(TRV_props_().getProperty(key) || '').trim(), n = Number(s);
  return s !== '' && isFinite(n) && n >= 0 ? n : def;
}
function TRV_book_() { return AC_masterSheet_().getParent(); }   // 従業員マスタのファイル
function TRV_sheetValues_(ss, name) { var sh = ss.getSheetByName(name); return sh ? sh.getDataRange().getValues() : []; }
/** 新しいタブを作る（あれば、そのまま使う） */
function TRV_tab_(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }
/** タブを値で書き直す（見出しは太字・1行目を固定）。前より行・列が減ったときは、残りを消す */
function TRV_write_(sh, values) {
  var w = values[0].length;
  sh.clearContents();   // 値だけを消す（色・プルダウンは残る）
  sh.getRange(1, 1, values.length, w).setValues(values);
  sh.getRange(1, 1, 1, w).setFontWeight('bold');
  sh.setFrozenRows(1);
}
/** 「通勤区分の選択肢」タブ（無ければ作って既定の選択肢を入れる。あれば変えない） */
function TRV_choices_(ss) {
  var sh = ss.getSheetByName(TRV_CHOICE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(TRV_CHOICE_SHEET);
    sh.getRange(1, 1, TRV_COMMUTE_TYPES.length + 1, 1).setValues([['通勤区分（ここを直すと「通勤距離」のプルダウンが変わります）']].concat(TRV_COMMUTE_TYPES.map(function (t) { return [t]; })));
    sh.getRange(1, 1).setFontWeight('bold');
  }
  return sh;
}
/** 「通勤距離」の入力の列に色を付け、通勤区分にプルダウンを付ける */
function TRV_decorate_(sh, choices, rows) {
  var n = Math.max(rows, 1);
  TRV_INPUT_COLS.forEach(function (c) { try { sh.getRange(1, c + 1, n + 1, 1).setBackground(TRV_INPUT_COLOR); } catch (e) { /* 色は付かなくてもよい */ } });
  try {
    var rule = SpreadsheetApp.newDataValidation().requireValueInRange(choices.getRange(2, 1, 100, 1), true).setAllowInvalid(true).build();
    sh.getRange(2, TRV_COL.type + 1, n, 1).setDataValidation(rule);
  } catch (e) { Logger.log('交通費の距離：通勤区分のプルダウンを付けられませんでした'); }
}

/** 今の状態をまとめて読む（シートは変えない） */
function TRV_load_(ss, today) {
  var active = TRV_active(AC_masterSheet_().getDataRange().getValues(), today);
  var stores = TRV_stores(TRV_sheetValues_(ss, TRV_STORE_SHEET));
  var ar = TRV_autoRows(TRV_sheetValues_(ss, TRV_AUTO_SHEET));
  var inputs = TRV_commuteInputs(TRV_sheetValues_(ss, TRV_COMMUTE_SHEET));
  var sync = TRV_syncPeople(active, inputs, ar.addrFp, today);
  return { active: active, stores: stores, auto: ar.auto, addrFp: ar.addrFp, inputs: inputs, sync: sync, pairs: TRV_pairs(sync.people, stores) };
}

/** タブを書く（通勤距離・店舗間距離・距離（内部）・通勤区分の選択肢） */
function TRV_save_(ss, st) {
  var commute = TRV_tab_(ss, TRV_COMMUTE_SHEET);
  TRV_write_(commute, TRV_commuteValues(st.sync.people, st.stores, st.auto));
  TRV_decorate_(commute, TRV_choices_(ss), st.sync.people.length);
  TRV_write_(TRV_tab_(ss, TRV_MATRIX_SHEET), TRV_matrixValues(st.stores, st.auto));
  var auto = ss.getSheetByName(TRV_AUTO_SHEET);
  if (!auto) { auto = ss.insertSheet(TRV_AUTO_SHEET); try { auto.hideSheet(); } catch (e) { /* 隠せなくてもよい */ } }
  TRV_write_(auto, [TRV_AUTO_HEADER].concat(TRV_autoValues(st.pairs, st.auto, st.sync.people)));
}

// ---------------- 地図（Maps） ----------------
/** 1区間の距離（km）。{ km } ／ { error: 'NOT_FOUND' など } ／ { stop: true（無料枠などで止める） } ／ { retry: true（次の日にやり直す） } */
function TRV_route_(fromAddr, toAddr, avoidHighways) {
  try {
    var f = Maps.newDirectionFinder().setOrigin(fromAddr).setDestination(toAddr).setMode(Maps.DirectionFinder.Mode.DRIVING).setLanguage('ja').setRegion('jp');
    if (avoidHighways) f.setAvoid(Maps.DirectionFinder.Avoid.HIGHWAYS);
    var r = f.getDirections() || {};
    if (r.status === 'OVER_QUERY_LIMIT' || r.status === 'OVER_DAILY_LIMIT') return { stop: true };
    if (r.status !== 'OK') return { error: r.status || 'エラー' };
    var leg = r.routes && r.routes[0] && r.routes[0].legs && r.routes[0].legs[0];
    if (!leg || !leg.distance || typeof leg.distance.value !== 'number') return { error: 'ZERO_RESULTS' };
    return { km: TRV_round(leg.distance.value / 1000) };
  } catch (e) {
    return /too many times|quota|上限/i.test(String(e && e.message)) ? { stop: true } : { retry: true };
  }
}
var TRV_ERROR_LABEL = { NOT_FOUND: '計算できない（住所が見つからない）', ZERO_RESULTS: '計算できない（道が見つからない）' };

/** 計算が要る組を、1日の上限と実行時間まで計算する（st.auto を書き換える） */
function TRV_compute_(st, dailyMax, today) {
  var state = AC_state_(), ck = 'stat:' + today + ':trv-maps', used = parseInt(state.getProperty(ck) || '0', 10) || 0, started = Date.now();
  var todo = st.pairs.filter(function (p) { return TRV_needs(st.auto[p.key], p); });
  var res = { todo: todo.length, done: 0, failed: 0, left: 0, calls: 0, stopped: '' };
  for (var i = 0; i < todo.length; i++) {
    if (used + 2 > dailyMax) { res.stopped = '1日の上限'; break; }
    if (Date.now() - started > TRV_RUN_MS) { res.stopped = '実行時間'; break; }
    var p = todo[i], hw = TRV_route_(p.fromAddr, p.toAddr, false);
    used++; res.calls++;
    var no = hw.stop || hw.retry ? hw : TRV_route_(p.fromAddr, p.toAddr, true);
    if (!(hw.stop || hw.retry)) { used++; res.calls++; }
    if (hw.stop || no.stop) { res.stopped = 'Maps の無料枠'; used = dailyMax; break; }
    if (hw.retry || no.retry) { st.auto[p.key] = { hw: null, noHw: null, status: TRV_WAIT, at: today, fp: p.fp }; res.failed++; continue; }
    var err = hw.error || no.error;
    st.auto[p.key] = err ? { hw: null, noHw: null, status: TRV_ERROR_LABEL[err] || '計算できない（' + err + '）', at: today, fp: p.fp }
      : { hw: hw.km, noHw: no.km, status: TRV_DONE, at: today, fp: p.fp };
    if (err) res.failed++; else res.done++;
  }
  state.setProperty(ck, String(used));
  res.used = used;
  res.left = todo.length - res.done - res.failed;
  return res;
}

// ---------------- 実行する関数 ----------------
/**
 * 毎朝（3時台のトリガー）：「通勤距離」を在籍者と同期し、店舗一覧に合わせて「店舗間距離」を作り直す。
 * TRAVEL_DISTANCE_MODE=on のときだけ、住所が入った・変わった組を1日の上限まで計算する。
 */
function travelDistanceDaily() {
  var cache = CacheService.getScriptCache();
  if (cache.get('trv:running')) { Logger.log('交通費の距離：前の実行が終わっていないため、今回は何もしません'); return { busy: true }; }
  cache.put('trv:running', '1', 360);   // 同じ処理が重ならないように（スクリプトのロックは使わない：ほかの処理を待たせない）
  try {
    var ss = TRV_book_(), today = AC_today_(), st = TRV_load_(ss, today);
    if (!st.active.length) throw new Error('従業員マスタの在籍者が0人です（読み取りを確認してください。表は変えていません）');
    var on = String(TRV_props_().getProperty('TRAVEL_DISTANCE_MODE') || '').trim() === 'on';
    var res = on ? TRV_compute_(st, TRV_num_('TRAVEL_MAPS_DAILY_MAX', TRV_DEFAULT_MAPS_MAX), today) : { todo: st.pairs.filter(function (p) { return TRV_needs(st.auto[p.key], p); }).length, done: 0, failed: 0, left: 0, calls: 0, stopped: 'TRAVEL_DISTANCE_MODE が on ではない' };
    if (!on) res.left = res.todo;
    TRV_save_(ss, st);
    res.mode = on ? 'on' : 'off'; res.people = st.sync.people.length; res.added = st.sync.added; res.removed = st.sync.removed; res.stores = st.stores.length;
    Logger.log(TRV_fmt('交通費の距離（版 %s・%s）：在籍者 %s人（追加 %s／削除 %s）・店舗 %s／計算が要る %s組・計算 %s・計算できない %s・残り %s・Maps %s回（今日 %s回）%s',
      TRV_VERSION, res.mode, res.people, res.added, res.removed, res.stores, res.todo, res.done, res.failed, res.left, res.calls, res.used || 0, res.stopped ? '・' + res.stopped : ''));
    return res;
  } finally { cache.remove('trv:running'); }
}

/**
 * 手動で1回：「住所取り込み」タブ（A 社員番号／B 自宅住所）から、在籍者の分だけを「通勤距離」の自宅住所に写す。Maps は呼ばない。
 * 写した件数・見つからなかった（在籍者でない）件数を、社員番号だけでログに出す。「住所取り込み」タブは消さない（管理本部が消す）
 */
function travelImportAddresses() {
  var ss = TRV_book_(), today = AC_today_(), sh = ss.getSheetByName(TRV_IMPORT_SHEET);
  if (!sh) throw new Error('「' + TRV_IMPORT_SHEET + '」タブがありません');
  var st = TRV_load_(ss, today);
  if (!st.active.length) throw new Error('従業員マスタの在籍者が0人です（読み取りを確認してください）');
  var byCode = {};
  st.active.forEach(function (a) { byCode[a.code] = true; });
  var res = { copied: 0, changed: 0, notFound: [], empty: 0 };
  sh.getDataRange().getValues().forEach(function (r, k) {
    var code = TRV_code(r[0]), addr = String(r[1] == null ? '' : r[1]).trim();
    if (!code || (k === 0 && !/^\w+$/.test(code)) || code === '社員番号') return;   // 見出し
    if (!byCode[code]) { res.notFound.push(code); return; }
    if (!addr) { res.empty++; return; }
    var cur = st.inputs[code] || (st.inputs[code] = { addr: '', addrAt: '', type: '', fixed: '' });
    if (cur.addr && cur.addr !== addr) res.changed++;
    cur.addr = addr;
    res.copied++;
  });
  st.sync = TRV_syncPeople(st.active, st.inputs, st.addrFp, today);
  st.pairs = TRV_pairs(st.sync.people, st.stores);
  TRV_save_(ss, st);
  Logger.log(TRV_fmt('交通費の住所の取り込み（版 %s）：写した %s件（前の住所から変わった %s件）／住所が空 %s件／在籍者に見つからない %s件%s', TRV_VERSION, res.copied, res.changed, res.empty,
    res.notFound.length, res.notFound.length ? '（社員番号：' + res.notFound.join('、') + '）' : ''));
  return res;
}

/** 手動実行（確認用）：Maps を呼ばずに、在籍者・計算が要る組・Maps の回数・何日かかるかだけをログに出す。タブも変えない */
function travelDistancePreview() {
  var st = TRV_load_(TRV_book_(), AC_today_()), max = TRV_num_('TRAVEL_MAPS_DAILY_MAX', TRV_DEFAULT_MAPS_MAX);
  var todo = st.pairs.filter(function (p) { return TRV_needs(st.auto[p.key], p); }).length;
  var res = { people: st.sync.people.length, withAddr: st.sync.people.filter(function (p) { return p.addr; }).length, stores: st.stores.length,
    pairs: st.pairs.length, todo: todo, calls: todo * 2, days: max >= 2 ? Math.ceil(todo * 2 / max) : null, added: st.sync.added, removed: st.sync.removed };
  Logger.log(TRV_fmt('交通費の距離（版 %s・確認）：在籍者 %s人（住所あり %s人・これから追加 %s／削除 %s）・店舗 %s／組 %s（計算が要る %s）／Maps %s回・1日 %s回までで約 %s日',
    TRV_VERSION, res.people, res.withAddr, res.added, res.removed, res.stores, res.pairs, res.todo, res.calls, max, res.days === null ? '-' : res.days));
  return res;
}

function travelDistanceSetupTrigger() {
  travelDistanceRemoveTrigger();
  ScriptApp.newTrigger('travelDistanceDaily').timeBased().everyDays(1).atHour(TRV_HOUR).inTimezone(AC_TZ).create();
}
function travelDistanceRemoveTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'travelDistanceDaily') ScriptApp.deleteTrigger(t); });
}

// ---------------- 申請の照合（申請の処理から呼ぶ） ----------------
/**
 * 申請の行をまとめて照合する。segments：[{ code（社員番号）, from, to, km }]（「大宮→自宅」の1つの文字なら from に入れて to を空に）。
 * 返り値：同じ順で TRV_checkSegment の結果
 */
function travelCheckSegments(segments) {
  var ss = TRV_book_();
  var ctx = TRV_buildContext(TRV_sheetValues_(ss, TRV_STORE_SHEET), TRV_sheetValues_(ss, TRV_COMMUTE_SHEET), TRV_sheetValues_(ss, TRV_AUTO_SHEET),
    TRV_num_('TRAVEL_TOLERANCE_KM', TRV_DEFAULT_TOLERANCE_KM));
  return (segments || []).map(function (s) {
    var seg = s || {};
    if (seg.from && !seg.to) { var pts = TRV_parseRoute(seg.from); if (pts.length === 2) seg = { code: seg.code, from: pts[0], to: pts[1], km: seg.km }; }
    return TRV_checkSegment(ctx, seg);
  });
}

if (typeof module !== 'undefined') {
  module.exports = { TRV_norm: TRV_norm, TRV_addr: TRV_addr, TRV_fp: TRV_fp, TRV_stores: TRV_stores, TRV_resolver: TRV_resolver, TRV_resolve: TRV_resolve,
    TRV_parseRoute: TRV_parseRoute, TRV_km: TRV_km, TRV_active: TRV_active, TRV_syncPeople: TRV_syncPeople, TRV_pairs: TRV_pairs, TRV_needs: TRV_needs,
    TRV_commuteValues: TRV_commuteValues, TRV_matrixValues: TRV_matrixValues, TRV_checkSegment: TRV_checkSegment, TRV_VERSION: TRV_VERSION };
}
