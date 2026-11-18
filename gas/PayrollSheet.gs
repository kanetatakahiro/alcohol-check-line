/**
 * 給与反映シート（社労士共有用【リバースHD】）への書き込みの共通部分（gas/PayrollSheet.gs・版 2026-11-19d・本番未導入）
 *
 * 交通費（通勤手当）と、今後の AI の経費申請（立替経費）で使い回す。列の名前を渡せば、その列だけに書く。
 *   PAY_writeColumn_(month, '通勤手当', [{ code, value }], { people, mode })
 *
 * 本番で確かめた形（2026-11-19。見出しと形だけ）：
 *   - 月のタブ「R8.10月分11月支給」（今月分は先頭に★）。「テンプレ」タブ。ほかのタブ（隠しタブ・「固定精算の開始・内容について」「固定立替詳細」
 *     「交通費計算シート」「従業員コード」など）は触らない
 *   - 1行目：B＝「2026年」・C＝「11月支給」（2つのセル）
 *   - 2行目の見出し：B 従業員番号／C 氏名／D 立替経費／E 通勤手当／F 固定立て替え／G 家賃補助／H インセンティブ／I 合計（各行 =SUM(D:H)）。
 *     列は見出しの名前で探す（位置を決め打ちしない）
 *   - 3行目から1人1行。従業員番号が空で氏名だけの行が多い（氏名の空白の有無はばらばら）。#N/A の行・同じ氏名が2行ある月もある
 *   - 人の並びのすぐ下に「合計の行」（B〜C 列が結合で B に「合計」・D〜I が =SUM(D3:D36) など。月で位置が変わる）。
 *     合計の行は「従業員番号か氏名の欄が『合計』、または両方が空」で、最初の金額の列が =SUM の行として見つける
 *   - 合計の行の下に固定立て替えの表、L 列にチェックボックス、M 列にメモ
 * 書き込みの決まり：
 *   - その月のタブが無ければ「テンプレ」をコピーして作り、1行目 B・C に支給の年と月を入れる。テンプレに入っている人の行は消さずに使い、
 *     いない在籍者だけを足す。作ったタブだけ、人の行に「金額の無い行は灰色・ある行は白」の条件付き書式を足す
 *   - 人を足すとき：人の並びの空いている行を先に使い、足りなければ合計の行の上に行を挿入する（行ごと挿入するので、下の表と L・M 列は
 *     中身を変えずにそのまま下へずれる）。挿入した行には上の人の行の式（合計の列など）を同じ形で入れ、合計の行の =SUM の範囲を広げる
 *   - 既存の月のタブ：書く金額がある人が並んでいなければ、同じやり方で足す。そのほかの行・列・数式・書式は変えない
 *   - 人の照合（版 2026-11-19d）：まず従業員番号。その番号の行が無ければ、従業員番号が空の行を氏名で（全角半角・空白をそろえて。氏名は従業員マスタ）。
 *     同じ人に当たる行が2行以上あれば書かずに conflict（dup にも入れる）。#N/A・氏名が空の行（番号も無いもの）は対象外。
 *     既存の行の従業員番号が空でも、番号を書き足さない（既存のセルは変えない）。人を足すのは、番号でも氏名でも見つからない人だけ
 *   - 書くのは、渡した列の、照合できた行の空いている欄だけ。値か式がある欄は上書きしない（同じ値なら何もしない・違えば conflict）
 *   - 合計の行より下と、合計の列より右（L・M 列など）には書かない
 *   - 見出しが足りない・合計の行が見つからないときは、何も書かずに止める
 * スクリプトプロパティ：PAYROLL_SHEET_ID（社労士共有用【リバースHD】のスプレッドシート ID）
 * ログには件数・タブ名・見出し・行の位置だけを書く（氏名・金額は書かない）。
 */
var PAY_VERSION = '2026-11-19d';
var PAY_TEMPLATE = 'テンプレ', PAY_HEADER_ROW = 2, PAY_FIRST_ROW = 3;
var PAY_CODE = '従業員番号', PAY_NAME = '氏名', PAY_TOTAL = '合計';
var PAY_AMOUNTS = ['立替経費', '通勤手当', '固定立て替え', '家賃補助', 'インセンティブ'];   // 金額の列（見出しの名前）
var PAY_GREY = '#efefef', PAY_WHITE = '#ffffff';

/** 純粋関数：月（'YYYY-MM'。働いた月）→ タブの名前「R8.11月分12月支給」 */
function PAY_tabName(month) {
  var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)), pm = m === 12 ? 1 : m + 1;
  return 'R' + (y - 2018) + '.' + m + '月分' + pm + '月支給';
}
/** 純粋関数：1行目の B・C（支給の年と月）→ ['2026年', '12月支給'] */
function PAY_payCells(month) {
  var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return [(m === 12 ? y + 1 : y) + '年', (m === 12 ? 1 : m + 1) + '月支給'];
}
/** 純粋関数：タブの名前を比べる形（★・☆・空白を除く・全角半角をそろえる） */
function PAY_normName(s) { return String(s == null ? '' : s).normalize('NFKC').replace(/[★☆\s]/g, ''); }
/** 純粋関数：従業員番号を比べる形（' と空白・前の 0 を除く） */
function PAY_code(v) {
  var t = String(v == null ? '' : v).replace(/^'/, '').normalize('NFKC').trim();
  return /^\d+$/.test(t) ? String(Number(t)) : t;
}
/** 純粋関数：列の番号（1〜）→ 列の文字（A・B…・AA） */
function PAY_colLetter(n) { var s = ''; while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
/** 純粋関数：見出しの行 → { 見出し: 列の番号（1〜） } */
function PAY_cols(header) {
  var out = {};
  (header || []).forEach(function (h, i) { var k = String(h == null ? '' : h).normalize('NFKC').replace(/\s/g, ''); if (k && !out[k]) out[k] = i + 1; });
  return out;
}
/** 純粋関数：氏名を比べる形（全角半角をそろえ、空白を除く）。#N/A・空は '' */
function PAY_normPerson(v) {
  var t = String(v == null ? '' : v).normalize('NFKC').replace(/\s/g, '');
  return /^#(N\/A|REF!|VALUE!|NAME\?|ERROR!|DIV\/0!)/i.test(t) ? '' : t;
}
/** 純粋関数：その行が人の行のどれに当たるか。rows＝[{ row, code, name（比べる形） }]、p＝{ code, name }。返り値：行の配列（0・1・2以上） */
function PAY_match(rows, p) {
  var c = PAY_code(p.code), n = PAY_normPerson(p.name);
  var byCode = rows.filter(function (r) { return c && r.code === c; });
  if (byCode.length) return byCode;
  return n ? rows.filter(function (r) { return !r.code && r.name === n; }) : [];
}
/** 純粋関数：=SUM の式か（小文字の =sum も） */
function PAY_isSum(f) { return /^=\s*sum\s*\(/i.test(String(f || '')); }
/**
 * 純粋関数：合計の行の式の範囲を、人の並びの終わり（oldEnd 行）から newEnd 行へ広げる。
 * 例 =SUM(D3:D25) → =SUM(D3:D27)。終わりが oldEnd でない範囲（シートが自動で広げたもの・ほかの式）は変えない
 */
function PAY_extendSum(formula, oldEnd, newEnd) {
  return String(formula).replace(/(\$?[A-Z]+\$?)(\d+):(\$?[A-Z]+\$?)(\d+)/g, function (m, c1, r1, c2, r2) {
    return Number(r2) === oldEnd && Number(r1) <= oldEnd ? c1 + r1 + ':' + c2 + newEnd : m;
  });
}

function PAY_book_() {
  var id = PropertiesService.getScriptProperties().getProperty('PAYROLL_SHEET_ID');
  if (!id) throw new Error('PAYROLL_SHEET_ID（社労士共有用【リバースHD】の ID）が未設定です');
  return SpreadsheetApp.openById(id);
}
/** その月のタブ（★ などが付いていても同じ月）。無ければ null */
function PAY_findTab_(ss, month) {
  var want = PAY_normName(PAY_tabName(month));
  return ss.getSheets().filter(function (sh) { return PAY_normName(sh.getName()) === want; })[0] || null;
}

/**
 * タブの形を読む。{ cols, code, name, total（合計の列）, amounts（金額の列の番号）, sumRow（合計の行）, rows: [{ row, code }]（人の行）, blanks: [行] }
 * 見出しが足りない・合計の行が無ければ例外（何も書かない）
 */
function PAY_layout_(sh) {
  var w = Math.max(sh.getLastColumn(), 1), cols = PAY_cols(sh.getRange(PAY_HEADER_ROW, 1, 1, w).getValues()[0]);
  var need = [PAY_CODE, PAY_NAME, PAY_TOTAL].filter(function (k) { return !cols[k]; });
  var amounts = PAY_AMOUNTS.filter(function (k) { return cols[k]; }).map(function (k) { return cols[k]; });
  if (need.length || !amounts.length) throw new Error('「' + sh.getName() + '」の2行目に「' + (need[0] || PAY_AMOUNTS[0]) + '」がありません（何も書いていません）');
  var first = Math.min.apply(null, amounts), last = sh.getLastRow(), lay = { cols: cols, code: cols[PAY_CODE], name: cols[PAY_NAME], total: cols[PAY_TOTAL],
    amounts: amounts, first: first, lastAmount: Math.max.apply(null, amounts), sumRow: 0, rows: [], blanks: [] };
  if (last >= PAY_FIRST_ROW) {
    var n = last - PAY_FIRST_ROW + 1;
    var codes = sh.getRange(PAY_FIRST_ROW, lay.code, n, 1).getValues(), names = sh.getRange(PAY_FIRST_ROW, lay.name, n, 1).getValues();
    var fs = sh.getRange(PAY_FIRST_ROW, first, n, 1).getFormulas();
    for (var i = 0; i < n; i++) {
      var rawCode = String(codes[i][0] == null ? '' : codes[i][0]).trim(), rawName = String(names[i][0] == null ? '' : names[i][0]).trim();
      var isTotal = PAY_normPerson(rawCode) === PAY_TOTAL || PAY_normPerson(rawName) === PAY_TOTAL || (!rawCode && !rawName);
      if (isTotal && PAY_isSum(fs[i][0])) { lay.sumRow = PAY_FIRST_ROW + i; break; }
      var c = PAY_normPerson(rawCode) ? PAY_code(rawCode) : '', nm = PAY_normPerson(rawName);
      if (c || nm) lay.rows.push({ row: PAY_FIRST_ROW + i, code: c, name: nm });
      else if (!rawCode && !rawName) lay.blanks.push(PAY_FIRST_ROW + i);
      else lay.skipped = (lay.skipped || 0) + 1;   // #N/A などの行は対象外（空いている行としても使わない）
    }
  }
  if (!lay.sumRow) throw new Error('「' + sh.getName() + '」に合計の行（' + PAY_CODE + '・' + PAY_NAME + 'が空で、' + PAY_colLetter(first) + '列が =SUM の行）が見つかりません（何も書いていません）');
  return lay;
}

/**
 * 人を足す（空いている行を先に使い、足りなければ合計の行の上に挿入して =SUM の範囲を広げる）。people＝[{ code, name }]。返り値：新しい形
 */
function PAY_addPeople_(sh, lay, people) {
  if (!people.length) return lay;
  var put = function (row, p) {
    sh.getRange(row, lay.code).setValue("'" + p.code);
    sh.getRange(row, lay.name).setValue(p.name || '');
  };
  var rest = people.slice();
  lay.blanks.forEach(function (row) { if (rest.length) put(row, rest.shift()); });
  if (rest.length) {
    var at = lay.sumRow, k = rest.length, w = Math.max(sh.getLastColumn(), lay.total), src = at - 1;
    var tmpl = src >= PAY_FIRST_ROW ? sh.getRange(src, 1, 1, lay.total).getFormulasR1C1()[0] : [];   // 上の人の行の式（合計の列まで）
    sh.insertRowsBefore(at, k);
    tmpl.forEach(function (f, j) { if (f) for (var i = 0; i < k; i++) sh.getRange(at + i, j + 1).setFormulaR1C1(f); });
    var sumRow = at + k, fs = sh.getRange(sumRow, 1, 1, w).getFormulas()[0];
    fs.forEach(function (f, j) {
      if (!f || j + 1 > lay.total) return;   // 合計の列より右（L・M 列など）は変えない
      var g = PAY_extendSum(f, at - 1, at - 1 + k);
      if (g !== f) sh.getRange(sumRow, j + 1).setFormula(g);
    });
    rest.forEach(function (p, i) { put(at + i, p); });
  }
  return PAY_layout_(sh);
}

/** その月のタブが無ければ「テンプレ」をコピーして作る（1行目 B・C・在籍者全員・条件付き書式）。返り値 { sh, created } */
function PAY_ensureTab_(ss, month, people) {
  var sh = PAY_findTab_(ss, month);
  if (sh) return { sh: sh, created: false };
  var tpl = ss.getSheetByName(PAY_TEMPLATE);
  if (!tpl) throw new Error('「' + PAY_TEMPLATE + '」タブがありません');
  PAY_layout_(tpl);   // テンプレの形を先に確かめる（違えば作らない）
  sh = tpl.copyTo(ss);
  sh.setName(PAY_tabName(month));
  var pc = PAY_payCells(month);
  sh.getRange(1, 2, 1, 2).setValues([pc]);
  var lay = PAY_layout_(sh);
  lay = PAY_addPeople_(sh, lay, people.filter(function (p) { return !PAY_match(lay.rows, p).length; }));   // 番号でも氏名でも見つからない人だけ
  // 条件付き書式（作ったタブだけ）：人の行で、金額の列の合計が0なら灰色・0でなければ白
  var from = PAY_FIRST_ROW, n = lay.sumRow - from;
  if (n > 0) {
    var code = '$' + PAY_colLetter(lay.code) + from, sum = 'SUM($' + PAY_colLetter(lay.first) + from + ':$' + PAY_colLetter(lay.lastAmount) + from + ')';
    var range = sh.getRange(from, lay.code, n, lay.total - lay.code + 1);
    var rule = function (f, color) { return SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f).setBackground(color).setRanges([range]).build(); };
    sh.setConditionalFormatRules(sh.getConditionalFormatRules().concat([
      rule('=AND(' + code + '<>"",' + sum + '=0)', PAY_GREY), rule('=AND(' + code + '<>"",' + sum + '<>0)', PAY_WHITE)]));
  }
  return { sh: sh, created: true };
}

/**
 * 渡した列に金額を書く（共通）。month＝'YYYY-MM'（働いた月）、column＝見出しの名前（'通勤手当'・'立替経費' など）、
 * amounts＝[{ code, value }]、opts＝{ people（在籍者 [{ code, name }]。タブを作るとき・人を足すときに使う）, mode（'on'＝書く／'record'＝書かずに結果だけ） }。
 * 返り値 { tab, created, willCreate, added: [code], written: [code], same: [code], conflict: [code], missing: [code（在籍者にいない）] }
 */
function PAY_writeColumn_(month, column, amounts, opts) {
  opts = opts || {};
  var ss = PAY_book_(), write = opts.mode === 'on', people = opts.people || [];
  var out = { tab: PAY_tabName(month), created: false, willCreate: false, added: [], written: [], same: [], conflict: [], dup: [], missing: [] };
  var byCode = {};
  people.forEach(function (p) { byCode[PAY_code(p.code)] = p; });
  var sh = PAY_findTab_(ss, month);
  if (!sh && !write) {   // record：作らずに、作る予定だけ返す
    out.willCreate = true;
    amounts.forEach(function (a) { (byCode[PAY_code(a.code)] ? out.written : out.missing).push(a.code); });
    return out;
  }
  if (!sh) { sh = PAY_ensureTab_(ss, month, people).sh; out.created = true; }
  out.tab = sh.getName();
  var lay = PAY_layout_(sh);
  if (!lay.cols[column] || lay.amounts.indexOf(lay.cols[column]) === -1) throw new Error('「' + sh.getName() + '」の2行目に「' + column + '」がありません（何も書いていません）');
  // その人の行（従業員番号 → 無ければ番号の空いた行を氏名で）。在籍者にいない番号は番号だけで探す
  var find = function (a) { return PAY_match(lay.rows, byCode[PAY_code(a.code)] || { code: a.code, name: '' }); };
  // 書く金額がある人が、番号でも氏名でも並んでいなければ足す
  var add = [];
  amounts.forEach(function (a) {
    var p = byCode[PAY_code(a.code)];
    if (find(a).length) return;
    if (!p) { out.missing.push(a.code); return; }
    if (add.indexOf(p) === -1) add.push(p);
  });
  if (add.length) {
    out.added = add.map(function (p) { return p.code; });
    if (write) lay = PAY_addPeople_(sh, lay, add);
  }
  var col = lay.cols[column];
  amounts.forEach(function (a) {
    var hit = find(a);
    if (hit.length > 1) { out.conflict.push(a.code); out.dup.push(a.code); return; }   // 同じ人の行が2行以上：書かない
    if (!hit.length) { if (!write && out.added.indexOf(a.code) !== -1) out.written.push(a.code); return; }
    var cell = sh.getRange(hit[0].row, col), cur = cell.getValue(), f = cell.getFormula();
    if (f || (cur !== '' && cur !== null)) { (!f && Number(cur) === Number(a.value) ? out.same : out.conflict).push(a.code); return; }
    if (write) cell.setValue(a.value);
    out.written.push(a.code);
  });
  if (out.dup.length) Logger.log('給与反映シート：「' + out.tab + '」の「' + column + '」で同じ人の行が2行以上あり書かなかった ' + out.dup.length + '人');
  return out;
}

/**
 * 手動実行（読むだけ）：給与反映シートの構成をログに出す。タブごとに名前・行数・列数・1行目・2行目（見出し）・固定した行・条件付き書式の数・
 * 合計の行の位置と式・人の行の数・空いている行の数・見出しの足りないもの。氏名・金額は出さない。今月・前月のタブがどれに当たるかも出す
 */
function PAY_inspect() {
  var ss = PAY_book_(), today = AC_today_(), out = [];
  ss.getSheets().forEach(function (sh) {
    var w = Math.max(sh.getLastColumn(), 1);
    var row1 = sh.getRange(1, 1, 1, Math.min(w, 4)).getValues()[0].map(function (v) { return v instanceof Date ? '（日付）' : String(v).slice(0, 20); });
    var head = sh.getRange(PAY_HEADER_ROW, 1, 1, w).getValues()[0].map(function (v) { return String(v).trim(); });
    var t = { name: sh.getName(), rows: sh.getLastRow(), cols: sh.getLastColumn(), row1: row1, header: head, frozen: sh.getFrozenRows(), cf: sh.getConditionalFormatRules().length };
    try {
      var lay = PAY_layout_(sh);
      t.sumRow = lay.sumRow; t.people = lay.rows.length; t.blanks = lay.blanks.length; t.skipped = lay.skipped || 0;
      t.noCode = lay.rows.filter(function (r) { return !r.code; }).length;
      var seen = {}; t.dupNames = 0;
      lay.rows.forEach(function (r) { if (!r.code) { if (seen[r.name] === 1) t.dupNames++; seen[r.name] = (seen[r.name] || 0) + 1; } });
      t.sumFormulas = sh.getRange(lay.sumRow, 1, 1, lay.total).getFormulas()[0].map(function (f, j) { return f ? PAY_colLetter(j + 1) + '：' + f : ''; }).filter(Boolean);
      t.rowFormula = lay.rows.length ? sh.getRange(lay.rows[0].row, lay.total).getFormula() : '';
      t.missing = PAY_AMOUNTS.filter(function (k) { return !lay.cols[k]; });
    } catch (e) { t.error = e.message; }
    out.push(t);
    Logger.log('給与反映シート：「' + t.name + '」' + t.rows + '行×' + t.cols + '列・固定 ' + t.frozen + '行・条件付き書式 ' + t.cf + '／1行目：' + t.row1.join('｜')
      + '／2行目：' + t.header.join('｜') + (t.error ? '／形：' + t.error : '／人の行 ' + t.people + '（番号なし ' + t.noCode + '・同じ氏名が2行以上 ' + t.dupNames + '・空き ' + t.blanks + '・#N/A など対象外 ' + t.skipped + '）・合計の行 ' + t.sumRow + '行目（' + t.sumFormulas.join('、')
      + '）・人の行の合計の式 ' + (t.rowFormula || 'なし') + (t.missing.length ? '・見出しに無い金額の列：' + t.missing.join('、') : '')));
  });
  [TA_addMonth(TA_ym(today), -1), TA_ym(today)].forEach(function (m) {
    var sh = PAY_findTab_(ss, m);
    Logger.log('給与反映シート：' + m + ' のタブ「' + PAY_tabName(m) + '」→ ' + (sh ? '「' + sh.getName() + '」' : 'なし（締めのときにテンプレから作る）'));
  });
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { PAY_tabName: PAY_tabName, PAY_payCells: PAY_payCells, PAY_normName: PAY_normName, PAY_code: PAY_code, PAY_colLetter: PAY_colLetter,
    PAY_cols: PAY_cols, PAY_isSum: PAY_isSum, PAY_normPerson: PAY_normPerson, PAY_match: PAY_match, PAY_extendSum: PAY_extendSum, PAY_VERSION: PAY_VERSION };
}
