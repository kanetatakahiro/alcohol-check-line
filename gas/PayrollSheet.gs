/**
 * 給与反映シート（社労士共有用【リバースHD】）への書き込みの共通部分（gas/PayrollSheet.gs・版 2026-11-19b・本番未導入）
 *
 * 交通費（通勤手当）と、今後の AI の経費申請（立替経費）で使い回す。列の名前を渡せば、その列だけに書く。
 *   PAY_writeColumn_(month, '通勤手当', [{ code, value }], { people, mode })
 *
 * 今の運用の形（安藤さんの説明。本番で travelApplyInspectSharoushi を実行して確かめる）：
 *   - 月のタブの名前は「R{令和}.{M}月分{M+1}月支給」（例「R8.11月分12月支給」）。★・☆・空白が付いていても同じ月として扱う
 *   - 1行目B列に「2026年 12月支給」、2行目が見出し（従業員番号｜氏名｜立替経費｜通勤手当｜固定立て替え｜家族補助｜インセンティブ｜合計）、3行目から1人1行
 *   - 「テンプレ」タブがある
 * 書き込みの決まり：
 *   - その月のタブが無ければ「テンプレ」をコピーして作り、1行目B列に支給月、在籍者全員の従業員番号・氏名を3行目から並べる。
 *     テンプレの3行目にある式（合計など）は、足りない行に同じ形（相対参照）で入れる。金額のない行は灰色・ある行は白の条件付き書式を足す（作ったタブだけ）
 *   - 既存のタブ（作ったもの以外）の行・列・数式・書式は変えない。書くのは、渡した列の、従業員番号が一致する行の空いている欄だけ
 *   - すでに値がある欄は上書きしない（同じ値なら何もしない・違う値は conflict として返す。呼び出し元が管理者へ知らせる）
 *   - タブにいない従業員番号は書かずに missing として返す（既存のタブに行を足さない）
 *   - 見出しに従業員番号・渡した列が無ければ、何も書かずに止める
 * スクリプトプロパティ：PAYROLL_SHEET_ID（社労士共有用【リバースHD】のスプレッドシート ID）
 * ログには件数・タブ名・見出しだけを書く（氏名・金額は書かない）。
 */
var PAY_VERSION = '2026-11-19b';
var PAY_TEMPLATE = 'テンプレ', PAY_HEADER_ROW = 2, PAY_FIRST_ROW = 3;
var PAY_CODE = '従業員番号', PAY_NAME = '氏名', PAY_TOTAL = '合計';
var PAY_GREY = '#efefef', PAY_WHITE = '#ffffff';

/** 純粋関数：月（'YYYY-MM'。働いた月）→ タブの名前「R8.11月分12月支給」 */
function PAY_tabName(month) {
  var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)), pm = m === 12 ? 1 : m + 1;
  return 'R' + (y - 2018) + '.' + m + '月分' + pm + '月支給';
}
/** 純粋関数：1行目B列の文字「2026年 12月支給」（支給の年月） */
function PAY_payLabel(month) {
  var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return (m === 12 ? y + 1 : y) + '年 ' + (m === 12 ? 1 : m + 1) + '月支給';
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
  (header || []).forEach(function (h, i) { var k = String(h == null ? '' : h).normalize('NFKC').trim(); if (k && !out[k]) out[k] = i + 1; });
  return out;
}
/** 純粋関数：金額の列（従業員番号・氏名・合計以外の見出しのある列）の範囲 → { from, to }（列の番号） */
function PAY_amountSpan(cols) {
  var nums = Object.keys(cols).filter(function (k) { return k !== PAY_CODE && k !== PAY_NAME && k !== PAY_TOTAL; }).map(function (k) { return cols[k]; });
  return nums.length ? { from: Math.min.apply(null, nums), to: Math.max.apply(null, nums) } : null;
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
function PAY_header_(sh) {
  var w = Math.max(sh.getLastColumn(), 1);
  return PAY_cols(sh.getRange(PAY_HEADER_ROW, 1, 1, w).getValues()[0]);
}

/**
 * その月のタブが無ければ「テンプレ」をコピーして作る。people＝在籍者 [{ code, name }]（従業員番号の順）。
 * 返り値 { sh, created }
 */
function PAY_ensureTab_(ss, month, people) {
  var sh = PAY_findTab_(ss, month);
  if (sh) return { sh: sh, created: false };
  var tpl = ss.getSheetByName(PAY_TEMPLATE);
  if (!tpl) throw new Error('「' + PAY_TEMPLATE + '」タブがありません');
  sh = tpl.copyTo(ss);
  sh.setName(PAY_tabName(month));
  sh.getRange(1, 2).setValue(PAY_payLabel(month));
  var cols = PAY_header_(sh), w = Math.max(sh.getLastColumn(), 1);
  if (!cols[PAY_CODE]) throw new Error('「' + PAY_TEMPLATE + '」の2行目に「' + PAY_CODE + '」がありません');
  var n = people.length;
  // テンプレに残っている見本の行（従業員番号・氏名）は、並べる人数より下を空にする
  var last = sh.getLastRow();
  if (last >= PAY_FIRST_ROW + n) {
    [cols[PAY_CODE], cols[PAY_NAME]].filter(Boolean).forEach(function (c) { sh.getRange(PAY_FIRST_ROW + n, c, last - PAY_FIRST_ROW - n + 1, 1).clearContent(); });
  }
  if (n) {
    sh.getRange(PAY_FIRST_ROW, cols[PAY_CODE], n, 1).setValues(people.map(function (p) { return ["'" + p.code]; }));
    if (cols[PAY_NAME]) sh.getRange(PAY_FIRST_ROW, cols[PAY_NAME], n, 1).setValues(people.map(function (p) { return [p.name]; }));
    // テンプレの3行目の式（合計など）を、足りない行に同じ形で
    var f = sh.getRange(PAY_FIRST_ROW, 1, 1, w).getFormulasR1C1()[0];
    f.forEach(function (formula, j) {
      if (!formula) return;
      var cur = sh.getRange(PAY_FIRST_ROW, j + 1, n, 1).getFormulasR1C1();
      cur.forEach(function (x, i) { if (!x[0]) sh.getRange(PAY_FIRST_ROW + i, j + 1).setFormulaR1C1(formula); });
    });
    // 条件付き書式：金額のない行は灰色・ある行は白（作ったタブだけ。テンプレの書式はそのまま残る）
    var span = PAY_amountSpan(cols);
    if (span) {
      var code = '$' + PAY_colLetter(cols[PAY_CODE]) + PAY_FIRST_ROW, sum = 'SUM($' + PAY_colLetter(span.from) + PAY_FIRST_ROW + ':$' + PAY_colLetter(span.to) + PAY_FIRST_ROW + ')';
      var range = sh.getRange(PAY_FIRST_ROW, 1, n, w);
      var rule = function (f2, color) { return SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f2).setBackground(color).setRanges([range]).build(); };
      sh.setConditionalFormatRules(sh.getConditionalFormatRules().concat([
        rule('=AND(' + code + '<>"",' + sum + '=0)', PAY_GREY), rule('=AND(' + code + '<>"",' + sum + '<>0)', PAY_WHITE)]));
    }
  }
  return { sh: sh, created: true };
}

/**
 * 渡した列に金額を書く（共通）。month＝'YYYY-MM'（働いた月）、column＝見出しの名前（'通勤手当'・'立替経費' など）、
 * amounts＝[{ code, value }]、opts＝{ people（タブを作るときに並べる在籍者）, mode（'on'＝書く／'record'＝書かずに結果だけ） }。
 * 返り値 { tab, created, written: [code], same: [code], conflict: [code], missing: [code], willCreate }
 */
function PAY_writeColumn_(month, column, amounts, opts) {
  opts = opts || {};
  var ss = PAY_book_(), write = opts.mode === 'on', out = { tab: PAY_tabName(month), created: false, willCreate: false, written: [], same: [], conflict: [], missing: [] };
  var sh = PAY_findTab_(ss, month);
  if (!sh && !write) {   // record：作らずに、作る予定だけ返す
    out.willCreate = true;
    var set = {};
    (opts.people || []).forEach(function (p) { set[PAY_code(p.code)] = true; });
    amounts.forEach(function (a) { (set[PAY_code(a.code)] ? out.written : out.missing).push(a.code); });
    return out;
  }
  if (!sh) { var t = PAY_ensureTab_(ss, month, opts.people || []); sh = t.sh; out.created = t.created; }
  out.tab = sh.getName();
  var cols = PAY_header_(sh);
  if (!cols[PAY_CODE] || !cols[column]) throw new Error('「' + sh.getName() + '」の2行目に「' + (!cols[PAY_CODE] ? PAY_CODE : column) + '」がありません（何も書いていません）');
  var last = sh.getLastRow(), rowOf = {};
  if (last >= PAY_FIRST_ROW) {
    sh.getRange(PAY_FIRST_ROW, cols[PAY_CODE], last - PAY_FIRST_ROW + 1, 1).getValues().forEach(function (r, i) {
      var c = PAY_code(r[0]);
      if (c && !rowOf[c]) rowOf[c] = PAY_FIRST_ROW + i;
    });
  }
  amounts.forEach(function (a) {
    var r = rowOf[PAY_code(a.code)];
    if (!r) { out.missing.push(a.code); return; }
    var cell = sh.getRange(r, cols[column]), cur = cell.getValue();
    if (cur === '' || cur === null) { if (write) cell.setValue(a.value); out.written.push(a.code); }
    else if (Number(cur) === Number(a.value)) out.same.push(a.code);
    else out.conflict.push(a.code);
  });
  return out;
}

/**
 * 手動実行（読むだけ）：給与反映シートの構成をログに出す。タブごとに名前・行数・列数・1行目・2行目（見出し）・固定した行・条件付き書式の数・
 * 3行目の式（R1C1）・従業員番号の入った行の数。氏名・金額は出さない。今月・前月のタブがどれに当たるかも出す
 */
function PAY_inspect() {
  var ss = PAY_book_(), today = AC_today_(), out = [];
  ss.getSheets().forEach(function (sh) {
    var w = Math.max(sh.getLastColumn(), 1), lastRow = sh.getLastRow();
    var row1 = sh.getRange(1, 1, 1, w).getValues()[0].map(function (v) { return v instanceof Date ? '（日付）' : String(v).slice(0, 30); });
    var head = sh.getRange(PAY_HEADER_ROW, 1, 1, w).getValues()[0].map(function (v) { return String(v).trim(); });
    var cols = PAY_cols(head), codes = 0;
    if (cols[PAY_CODE] && lastRow >= PAY_FIRST_ROW) codes = sh.getRange(PAY_FIRST_ROW, cols[PAY_CODE], lastRow - PAY_FIRST_ROW + 1, 1).getValues().filter(function (r) { return PAY_code(r[0]); }).length;
    var f3 = lastRow >= PAY_FIRST_ROW ? sh.getRange(PAY_FIRST_ROW, 1, 1, w).getFormulasR1C1()[0] : [];
    var t = { name: sh.getName(), rows: lastRow, cols: sh.getLastColumn(), row1: row1, header: head, frozen: sh.getFrozenRows(),
      cf: sh.getConditionalFormatRules().length, formulas: f3.map(function (f, j) { return f ? PAY_colLetter(j + 1) + '：' + f : ''; }).filter(Boolean), codes: codes };
    out.push(t);
    Logger.log('給与反映シート：「' + t.name + '」' + t.rows + '行×' + t.cols + '列・固定 ' + t.frozen + '行・条件付き書式 ' + t.cf + '／1行目：' + t.row1.join('｜')
      + '／2行目：' + t.header.join('｜') + '／3行目の式：' + (t.formulas.join('、') || 'なし') + '／従業員番号のある行 ' + t.codes);
  });
  [TA_addMonth(TA_ym(today), -1), TA_ym(today)].forEach(function (m) {
    var sh = PAY_findTab_(ss, m);
    Logger.log('給与反映シート：' + m + ' のタブ「' + PAY_tabName(m) + '」→ ' + (sh ? '「' + sh.getName() + '」' : 'なし（締めのときにテンプレから作る）'));
  });
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { PAY_tabName: PAY_tabName, PAY_payLabel: PAY_payLabel, PAY_normName: PAY_normName, PAY_code: PAY_code, PAY_colLetter: PAY_colLetter, PAY_cols: PAY_cols, PAY_VERSION: PAY_VERSION };
}
