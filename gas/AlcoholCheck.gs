/**
 * アルコールチェック未実施者へのLINE通知（Google Apps Script）
 *
 * 動作（毎日。Apps Scriptの時刻指定は前後15分程度ずれる）：
 *  -  8:30 出勤者全員へ：あいさつ＋天気（気象庁・埼玉県南部）＋運転前のチェック案内
 *  - 10:00 出勤前の入力が確認できない人へ：入力のお願い（未実施と決めつけない）
 *  - 18:30 出勤者全員へ：退勤前のチェック案内
 *  - 20:00 退勤前の入力が確認できない人へ：入力のお願い／連続記録の節目（5・10・20…日）の人へ感謝
 *  - 出勤者：シート「2026-2028」のシフト行が当日「出勤」の人。入力確認：「フォームの回答 1」の当日・区分の回答
 *  - 宛先：従業員マスタでLINE登録・確認済みの本人（1対1）。従業員は公式LINEに社員番号を送って登録する（doPost）
 *  - 測定結果が 0.14mg/L 以下と読めない回答は、管理者へ至急の確認依頼を送る（10分ごとに確認）
 *
 * 安全策：
 *  - 管理シートへの書き込みは一切しない（読み取りのみ）
 *  - DRY_RUN が "false" 以外なら送信せず、件数だけをログに出す
 *  - 当日の日付列が見つからない等、データ不備があれば照合をやめ、管理者へ失敗だけを知らせる
 *  - 同じ日・同じ人・同じ種類の送信は1回まで
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）：
 *  LINE_CHANNEL_ACCESS_TOKEN  Messaging APIのチャネルアクセストークン（長期）
 *  LINE_ADMIN_USER_ID         通知先の管理者のユーザーID（U から始まる）
 *  DRY_RUN                    "false" のときだけ実際に送信する（未設定なら送信しない）
 *  NOTIFY_EMPLOYEES           "true" のときだけ本人へ通知する（未設定なら管理者一覧のみ）
 *  NOTIFY_ADMIN               "false" にすると管理者一覧を送らない
 *  EMPLOYEE_MASTER_ID         従業員マスタのID（alcoholCheckSetupMaster で自動設定）
 *  TEST_CODES / TEST_UNTIL     テストモード：指定した社員番号の本人宛て通知を管理者へ送る（期限まで）
 *  ALERT_THRESHOLD            これを超える測定結果（mg/L）を管理者へ至急知らせる（既定 0.14。10分ごとに確認）
 *  NORMAL_RESULTS             上記に加えて「正常」とみなす測定結果（カンマ区切り、任意）
 *  REQUIRE_DEVICE             "true" のとき、「アルコールチェッカー在庫」の機器所持にチェックがある人だけに本人通知する
 *
 * 会社アカウント（シート編集者）が所有する独立プロジェクト「アルコールチェック通知（暫定版）」で動かす。
 * 既存のApps Scriptとの衝突を避けるため、関数名・定数名には AC_ / alcoholCheck を付けている。
 */

// 独立型プロジェクトでも動くよう、シートはIDで開く（IDは秘密情報ではない）
var AC_SPREADSHEET_ID = '1YeYjc_-O2B1JlVtUpVFWGlM3ahW8dED1JFuQ4ttym5Q';
var AC_SHEET_SCHEDULE = '2026-2028';
var AC_SHEET_FORM = 'フォームの回答 1';
var AC_SHEET_DEVICES = 'アルコールチェッカー在庫';
var AC_TZ = 'Asia/Tokyo';
var AC_CHECK_LABELS = { beforeWork: '出勤前', afterWork: '退勤前' };

/** 手動確認用：送信も記録もせず、当日の結果をログに表示する（実行ログは所有者のみ閲覧可） */
function alcoholCheckPreview() {
  var today = AC_today_();
  ['beforeWork', 'afterWork'].forEach(function (type) {
    var r = AC_reconcileFromSheets_(today, type);
    Logger.log('%s %s：対象 %s人／未実施 %s人 %s', today, AC_CHECK_LABELS[type],
      r.targets.length, r.missing.length, JSON.stringify(r.missing));
  });
}

/** 手動確認用：当日のフォーム回答件数と、シフト表の氏名と一致しない回答の件数を出す（氏名は出さない） */
function alcoholCheckDiagnose() {
  var today = AC_today_();
  var ss = SpreadsheetApp.openById(AC_SPREADSHEET_ID);
  var sv = ss.getSheetByName(AC_SHEET_SCHEDULE).getDataRange().getValues();
  var fv = ss.getSheetByName(AC_SHEET_FORM).getDataRange().getValues();
  var roster = {};
  for (var r = 2; r < sv.length; r++) {
    if (String(sv[r][1]).trim()) roster[AC_normalizeName(sv[r][1])] = true;
  }
  var counts = {}, unmatched = 0, nonDate = 0;
  for (var i = 1; i < fv.length; i++) {
    var v = fv[i][0];
    if (Object.prototype.toString.call(v) !== '[object Date]') { if (String(v).trim()) nonDate++; continue; }
    if (Utilities.formatDate(v, AC_TZ, 'yyyy-MM-dd') !== today) continue;
    var label = String(fv[i][2]).trim();
    counts[label] = (counts[label] || 0) + 1;
    if (!roster[AC_normalizeName(fv[i][1])]) unmatched++;
  }
  Logger.log('%s 当日の回答件数（区分別）%s／シフト表に無い氏名の回答 %s件／日時でないタイムスタンプ %s件',
    today, JSON.stringify(counts), unmatched, nonDate);
}

// ---------------- 1日の通知（仕様：朝の案内・未入力フォロー・退勤前案内・感謝） ----------------
// 種類と時刻（Apps Scriptの時刻指定は前後15分程度ずれる）
//  morning      8:30  出勤者全員へ：あいさつ＋天気＋運転前のチェック案内
//  followBefore 10:00 出勤前の入力が確認できない人へ：入力のお願い（未実施と決めつけない）
//  evening      18:30 出勤者全員へ：退勤前のチェック案内
//  followAfter  20:00 退勤前の入力が確認できない人へ：入力のお願い。あわせて連続記録の感謝を送る
var AC_SCHEDULE = [
  { fn: 'alcoholCheckMorning', hour: 8, minute: 30 },
  { fn: 'alcoholCheckBeforeWork', hour: 10, minute: 0 },
  { fn: 'alcoholCheckEvening', hour: 18, minute: 30 },
  { fn: 'alcoholCheckAfterWork', hour: 20, minute: 0 },
];

function alcoholCheckMorning() { AC_dispatch_('morning'); }
function alcoholCheckBeforeWork() { AC_dispatch_('followBefore'); }
function alcoholCheckEvening() { AC_dispatch_('evening'); }
function alcoholCheckAfterWork() { AC_dispatch_('followAfter'); }

/** 定期実行の登録（このプロジェクトの通知用トリガーを消してから登録し直す） */
function alcoholCheckSetupTriggers() {
  var names = AC_SCHEDULE.map(function (s) { return s.fn; }).concat(['alcoholCheckAlerts', 'alcoholCheckImportTot']);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (names.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  AC_SCHEDULE.forEach(function (s) {
    ScriptApp.newTrigger(s.fn).timeBased().everyDays(1).atHour(s.hour).nearMinute(s.minute)
      .inTimezone(AC_TZ).create();
  });
  // 飲酒検知の確認は10分ごと（回答から最大10分程度で管理者へ届く）
  ScriptApp.newTrigger('alcoholCheckAlerts').timeBased().everyMinutes(10).create();
  // TOTのCSV（ドライブの「TOT取り込み」フォルダ）の確認は1時間ごと
  ScriptApp.newTrigger('alcoholCheckImportTot').timeBased().everyHours(1).create();
}

/** 手動確認用：今日、本人へ送れる人数（登録・確認済み、機器所持の絞り込み後）をログに出す（氏名は出さない） */
function alcoholCheckRegistryStatus() {
  var props = PropertiesService.getScriptProperties();
  var all = AC_buildRegistry(AC_masterSheet_().getDataRange().getValues(), AC_today_());
  var codes = function (r) { var s = {}; Object.keys(r).forEach(function (k) { s[r[k].code] = true; }); return Object.keys(s); };
  var sh = AC_deviceSheet_();
  var dev = sh ? AC_deviceCodes(sh.getDataRange().getValues()) : null;
  var d = AC_loadDay_(AC_today_());
  var reg = AC_loadRegistry_();
  var working = d.before.targets.filter(function (n) { return reg[AC_normalizeName(n)]; }).length;
  Logger.log('登録・確認済み %s人／機器所持 %s人／送信対象（絞り込み後）%s人 %s／本日出勤の送信対象 %s人／REQUIRE_DEVICE=%s',
    codes(all).length, dev ? Object.keys(dev).length : '読めず', codes(reg).length, JSON.stringify(codes(reg)),
    working, props.getProperty('REQUIRE_DEVICE'));
}

/** LINE送信の確認用：管理者へテストメッセージを1通送る（DRY_RUNに関係なく送る） */
function alcoholCheckSendTestMessage() {
  AC_pushLine_('【テスト】アルコールチェック通知の接続確認です。');
}

/** 手動確認用：今日の各通知の対象人数と、全員がLINE登録済みだった場合の見込み通数をログに出す（送信しない） */
function alcoholCheckEstimate() {
  var today = AC_today_();
  var d = AC_loadDay_(today);
  var counts = {};
  ['morning', 'followBefore', 'evening', 'followAfter'].forEach(function (k) {
    counts[k] = AC_recipientsFor(k, d).length;
  });
  counts.thanks = AC_thanksTargets(d).length;
  Logger.log('%s 見込み通数 %s（合計 %s通）', today, JSON.stringify(counts),
    Object.keys(counts).reduce(function (a, k) { return a + counts[k]; }, 0));
}

// ---------------- TOT（勤怠）のシフトの取り込み（CSV） ----------------
// TOTのAPIは許可IPが必須でApps Scriptからは使えないため、CSVで取り込む。
// 管理者がTOTの「日別データ[CSV]（給与計算用）」をGoogleドライブのフォルダ「TOT取り込み」に置くと、
// 1時間ごとに読み込み、従業員マスタのファイルの「TOT取り込み」シートにシフト表（2026-2028）との比較を出す。
// TOT_APPLY が "true" のときだけ、今日以降で食い違うシフト行のセルをTOTの値に書き換える（シフト行以外は触らない）。
// 対応：パターン名が「10:00-19:00」等の時刻 → 出勤、公休・希望休・有給 → そのまま、空欄 → 反映しない、その他 → 要確認。
var AC_TOT_SHEET = 'TOT取り込み';
var AC_TOT_FOLDER = 'TOT取り込み';
var AC_TOT_HEADER = ['日付', '社員番号', '氏名', 'TOTのパターン名', 'TOTからの区分', 'シフト表の値', '比較'];

/** 1時間ごと：フォルダの新しいCSVを読み込む（同じファイル・同じ更新日時は1回だけ） */
function alcoholCheckImportTot() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var state = AC_state_();
    var folder = AC_totFolder_();
    var files = folder.getFiles(), done = 0;
    while (files.hasNext()) {
      var f = files.next();
      if (!/\.csv$/i.test(f.getName())) continue;
      var key = 'totcsv:' + f.getId() + ':' + f.getLastUpdated().getTime();
      if (state.getProperty(key)) continue;
      var result = AC_importTotFile_(f);
      state.setProperty(key, new Date().toISOString());
      state.setProperty('tot:lastImport', AC_today_());
      Logger.log('TOT取り込み：%s', JSON.stringify(result));
      done++;
    }
    if (!done) Logger.log('新しいCSVはありません');
  } finally { lock.releaseLock(); }
}

/** フォルダ「TOT取り込み」（従業員マスタと同じ場所。無ければマイドライブに作る） */
function AC_totFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('TOT_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var it = DriveApp.getFoldersByName(AC_TOT_FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(AC_TOT_FOLDER);
  props.setProperty('TOT_FOLDER_ID', folder.getId());
  return folder;
}

function AC_importTotFile_(file) {
  var blob = file.getBlob();
  var text = blob.getDataAsString('Shift_JIS');
  if (text.indexOf('従業員コード') === -1) text = blob.getDataAsString('UTF-8').replace(/^﻿/, '');
  var items = AC_parseTotCsv(Utilities.parseCsv(text));
  var master = AC_masterSheet_();
  var schedule = SpreadsheetApp.openById(AC_SPREADSHEET_ID).getSheetByName(AC_SHEET_SCHEDULE);
  var sv = schedule.getDataRange().getValues();
  var cmp = AC_buildTotCompare(items, master.getDataRange().getValues(), sv, AC_toDateFn_());
  var ss = master.getParent();
  var sh = ss.getSheetByName(AC_TOT_SHEET) || ss.insertSheet(AC_TOT_SHEET);
  sh.clearContents();
  sh.getRange(1, 1, 1, AC_TOT_HEADER.length).setValues([AC_TOT_HEADER]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (cmp.rows.length) sh.getRange(2, 1, cmp.rows.length, AC_TOT_HEADER.length).setValues(cmp.rows);
  var applied = 0;
  if (PropertiesService.getScriptProperties().getProperty('TOT_APPLY') === 'true') {
    var today = AC_today_();
    cmp.updates.filter(function (u) { return u.date >= today; }).forEach(function (u) {
      schedule.getRange(u.row + 1, u.col + 1).setValue(u.value);   // シフト行の該当日セルだけ
      applied++;
    });
  }
  return { file: file.getName(), counts: cmp.counts, applied: applied };
}

/** 純粋関数：TOTの従業員コードの比較用キー（「0083」と「83」を同じに扱う） */
function AC_totKey(v) {
  var t = String(v == null ? '' : v).replace(/^'/, '').trim();
  return /^\d+$/.test(t) ? String(t.replace(/^0+(?=\d)/, '')) : t;
}

function AC_isRestDay_(v) { return v === '公休' || v === '希望休'; }

/** 純粋関数：TOTのパターン名をシフト表の区分へ。null は反映しない（未設定） */
function AC_totPatternToShift(pattern) {
  var p = String(pattern == null ? '' : pattern).trim();
  if (!p) return null;
  if (/^\d{1,2}:\d{2}\s*[-〜~]\s*\d{1,2}:\d{2}$/.test(p)) return '出勤';
  if (p === '公休' || p === '希望休' || p === '有給') return p;
  return '要確認';
}

/** 純粋関数：CSV（1行目が見出し）から {tot, date, pattern} の一覧。必要な列が無ければ例外 */
function AC_parseTotCsv(rows) {
  if (!rows || !rows.length) throw AC_error_('CSVが空です');
  var h = rows[0].map(function (c) { return String(c).replace(/^﻿/, '').trim(); });
  var ci = h.indexOf('従業員コード'), di = h.indexOf('日時（曜日なし）'), pi = h.indexOf('パターン名'), ni = h.indexOf('名前');
  if (di === -1) di = h.indexOf('日時');
  if (ci === -1 || di === -1 || pi === -1) throw AC_error_('CSVの列（従業員コード・日時・パターン名）が見つかりません');
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var m = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(String(r[di] || ''));
    var tot = String(r[ci] == null ? '' : r[ci]).trim();
    if (!m || !tot) continue;
    var date = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    out.push({ tot: tot, date: date, pattern: String(r[pi] == null ? '' : r[pi]).trim(),
      name: ni === -1 ? '' : String(r[ni] == null ? '' : r[ni]).trim() });
  }
  return out;
}

/** シフト表の位置：日付→列、氏名→シフト行 */
function AC_shiftIndex_(sv, toDate) {
  var cols = {}, rows = {}, dup = {}, current = '';
  for (var c = 3; c < (sv[1] || []).length; c++) { var d = toDate(sv[1][c]); if (d && cols[d] == null) cols[d] = c; }
  for (var r = 2; r < sv.length; r++) {
    if (String(sv[r][1]).trim()) current = String(sv[r][1]).trim();
    if (String(sv[r][2]).trim() !== 'シフト' || !current) continue;
    var k = AC_normalizeName(current);
    if (rows[k] != null) dup[k] = true;
    rows[k] = r;
  }
  Object.keys(dup).forEach(function (k) { delete rows[k]; });   // 同名は書き換え対象にしない
  return { cols: cols, rows: rows };
}

/**
 * 純粋関数：比較表と、書き換え候補（シフト行・日付列・新しい値）。
 * 書き換えるのは、TOTの区分が出勤・公休・希望休・有給のいずれかで、シフト表の値と違うセルだけ。
 */
function AC_buildTotCompare(items, masterValues, sv, toDate) {
  var byTot = {};
  for (var i = 1; i < (masterValues || []).length; i++) {
    var m = masterValues[i], tot = AC_totKey(m[AC_COL.totCode]);
    if (tot && String(m[AC_COL.status]).trim() !== '退職') byTot[tot] = { code: AC_cellCode_(m[AC_COL.code]), name: String(m[AC_COL.name]).trim(), alias: String(m[AC_COL.alias] || '').trim() };
  }
  var idx = AC_shiftIndex_(sv, toDate);
  var rows = [], updates = [], counts = { 一致: 0, 違い: 0, 未設定: 0, 要確認: 0, シフト表に無い: 0, マスタに無い: 0 };
  (items || []).forEach(function (it) {
    var who = byTot[AC_totKey(it.tot)];
    var shift = AC_totPatternToShift(it.pattern);
    if (!who) { counts['マスタに無い']++; rows.push([it.date, '', (it.name || '（氏名なし）') + '（TOTコード ' + it.tot + '）', it.pattern, shift || '', '', 'マスタに無い']); return; }
    var r = idx.rows[AC_normalizeName(who.name)];
    if (r == null && who.alias) r = idx.rows[AC_normalizeName(who.alias)];
    var c = idx.cols[it.date];
    var current = r != null && c != null ? String(sv[r][c] == null ? '' : sv[r][c]).trim() : null;
    var result;
    if (current === null) result = 'シフト表に無い';
    else if (shift === null || (current === '' && AC_isRestDay_(shift))) result = '未設定';   // 未入力の日をTOTの既定の「公休」で埋めない
    else if (shift === '要確認') result = '要確認';
    else if (shift === current || (AC_isRestDay_(shift) && AC_isRestDay_(current))) result = '一致';   // 公休と希望休は同じ「休み」として扱う
    else { result = '違い'; updates.push({ row: r, col: c, date: it.date, value: shift, code: who.code }); }
    counts[result]++;
    if (result === 'シフト表に無い') return;   // シフト表（運転する人）に載っていない人は件数だけ数える
    rows.push([it.date, who.code, who.name, it.pattern, shift || '', current === null ? '' : current, result]);
  });
  var order = { 違い: 0, 要確認: 1, マスタに無い: 2, 未設定: 3, 一致: 4 };
  rows.sort(function (a, b) { return (order[a[6]] - order[b[6]]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); });
  return { rows: rows, updates: updates, counts: counts };
}

// ---------------- TOT（API・さくらのVPS経由）の受け取り ----------------
// VPS（src/tot-relay.js）が毎朝、TOTの従業員・日別スケジュール・日別勤務・打刻を送ってくる。
// 合言葉（TOT_SYNC_SECRET）が一致したときだけ、ドライブの「TOT取り込み」フォルダに tot-latest.json として保存する。
function AC_handleTotRaw_(body) {
  var secret = PropertiesService.getScriptProperties().getProperty('TOT_SYNC_SECRET');
  if (!secret || body.secret !== secret || !body.results) return 'NG';
  var folder = AC_totFolder_();
  var json = JSON.stringify({ today: body.today, fetchedAt: body.fetchedAt, results: body.results });
  var it = folder.getFilesByName('tot-latest.json');
  if (it.hasNext()) it.next().setContent(json); else folder.createFile('tot-latest.json', json, MimeType.PLAIN_TEXT);
  var state = AC_state_();
  state.setProperty('tot:lastRelay', AC_today_());
  var summary = AC_totShape(body.results);
  Logger.log('TOT受信 %s', JSON.stringify(summary));
  var failed = Object.keys(body.results).filter(function (k) {
    var v = body.results[k];
    return v && (v._error || (Array.isArray(v) && v.some(function (x) { return x && x._error; })));
  });
  if (failed.length) AC_adminNotice_('totfetch', '【エラー】TOTから一部のデータを読み取れませんでした🙇‍♀️\n対象：' + failed.join('、')
    + '\nTOTのトークンの権限・許可IP（133.167.110.249）が変わっていないか確認してください。');
  try { AC_processTotRaw_(body); } catch (e) {
    Logger.log('TOT処理の失敗：%s', e && e.message);
    AC_adminNotice_('totprocess', '【エラー】TOTの勤怠データの処理中に問題がありました🙇‍♀️\n（' + (e && e.message ? e.message : '不明なエラー') + '）');
  }
  return 'OK ' + JSON.stringify(summary).slice(0, 300);
}

/** 純粋関数：受け取ったデータの形（件数・項目名）だけをまとめる。値は含めない */
function AC_totShape(results) {
  var out = {};
  Object.keys(results || {}).forEach(function (k) {
    var v = results[k];
    if (v && v._error) { out[k] = { error: v._error, errors: v.errors }; return; }
    var arr = Array.isArray(v) ? v : null, inner = null;
    if (!arr && v && typeof v === 'object') {
      Object.keys(v).forEach(function (kk) { if (Array.isArray(v[kk]) && !arr) { arr = v[kk]; inner = kk; } });
    }
    out[k] = { count: arr ? arr.length : null, inner: inner, top: Array.isArray(v) ? 'array' : Object.keys(v || {}).slice(0, 10),
      keys: arr && arr[0] && typeof arr[0] === 'object' ? Object.keys(arr[0]).slice(0, 40) : null };
  });
  return out;
}

/**
 * 受け取ったデータの処理：
 *  1. 勤務予定をシフト表（2026-2028）と比べる（TOT_APPLY=true なら今日以降の食い違うシフト欄を書き換え）
 *  2. 打刻漏れ等（TOTのエラー勤務）と今月の残業を本人へLINE（ATTENDANCE_NOTIFY=true のときだけ）
 *  3. 従業員マスタのファイルに「勤怠チェック」シート（前月・今月の集計）を作る
 */
function AC_processTotRaw_(body) {
  var props = PropertiesService.getScriptProperties();
  var today = body.today || AC_today_();
  var R = body.results || {};
  var master = AC_masterSheet_();
  var mv = master.getDataRange().getValues();
  var ss = master.getParent();
  // 1. シフト
  if (Array.isArray(R.employees) && Array.isArray(R.schedules)) {
    var schedule = SpreadsheetApp.openById(AC_SPREADSHEET_ID).getSheetByName(AC_SHEET_SCHEDULE);
    var sv = schedule.getDataRange().getValues();
    var cmp = AC_buildTotCompare(AC_totScheduleItems(R), mv, sv, AC_toDateFn_());
    var sh = ss.getSheetByName(AC_TOT_SHEET) || ss.insertSheet(AC_TOT_SHEET);
    sh.clearContents();
    sh.getRange(1, 1, 1, AC_TOT_HEADER.length).setValues([AC_TOT_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (cmp.rows.length) sh.getRange(2, 1, cmp.rows.length, AC_TOT_HEADER.length).setValues(cmp.rows);
    var applied = 0;
    if (props.getProperty('TOT_APPLY') === 'true') {
      cmp.updates.filter(function (u) { return u.date >= today; }).forEach(function (u) {
        schedule.getRange(u.row + 1, u.col + 1).setValue(u.value);
        applied++;
      });
    }
    Logger.log('シフト比較 %s／書き換え %s件', JSON.stringify(cmp.counts), applied);
  }
  // 1b. 翌月のシフトを管理シートへ反映（毎月28日以降の朝に届く。月1回だけ）
  if (Array.isArray(R.employees) && Array.isArray(R.nextSchedules) && props.getProperty('TOT_MONTHLY_APPLY') !== 'false') {
    AC_applyNextMonthShift_(R, mv, ss, today);
  }
  // 2. 打刻漏れ・残業・当日の勤怠状況（お知らせは夜22:30の取り込みのときだけ送る）
  var night = body.mode === 'night';
  if (Array.isArray(R.employees) && Array.isArray(R.workings)) {
    var f = AC_attendanceFindings(R, today);
    var line = AC_lineByTotCode(mv, today);
    var live = props.getProperty('DRY_RUN') === 'false';
    var notify = props.getProperty('ATTENDANCE_NOTIFY') === 'true' && live;
    var test = !notify && props.getProperty('ATTENDANCE_TEST') === 'true' && live;   // テスト：本人ではなく管理者へまとめて1通
    var names = AC_namesByTot_(mv, R.employees);
    var state = AC_state_(), sent = 0, unreg = 0, month = today.slice(0, 7), testLines = [];
    var pauseIdx = AC_pauseIndex_(), codeOfTot = AC_codeByTot(mv);
    var send = function (tot, key, text, date) {
      if (!night) return;
      var c0 = codeOfTot[AC_totKey(tot)];
      if (c0 && (AC_isPaused(pauseIdx, c0, today) || (date && AC_isPaused(pauseIdx, c0, date)))) return;   // お知らせ停止中・停止期間中の日
      var build = function () { return typeof text === 'function' ? text(careCtx(tot)) : text; };   // 送るときだけ気遣いを決める
      if (test) {
        if (state.getProperty(key + ':test')) return;
        text = build();
        state.setProperty(key + ':test', new Date().toISOString());
        testLines.push('■' + (names[AC_totKey(tot)] || 'TOTコード' + tot) + 'さん宛て' + (line[AC_totKey(tot)] ? '' : '（LINE未登録のため本番では届きません）')
          + '\n' + text);
        return;
      }
      if (state.getProperty(key)) return;
      var to = line[AC_totKey(tot)];
      if (!to) { unreg++; return; }
      if (!notify) return;
      try { AC_pushTo_(to.userId, build()); state.setProperty(key, new Date().toISOString()); sent++; } catch (e) { Logger.log('勤怠通知の失敗'); }
    };
    var overrides = AC_templateOverrides_(), infection = AC_infection_(today);
    var careCtx = function (tot) {   // 天気以外の気遣い。1日の最初のLINEだけ／感染症の注意は1人7日に1回
      var to = line[AC_totKey(tot)];
      var ck = 'att:' + today + ':care:' + (to ? to.code : 'tot' + AC_totKey(tot));
      var careUsed = !!state.getProperty(ck) || !!careGiven[ck];
      careGiven[ck] = true;
      if (notify && to) state.setProperty(ck, '1');   // 本番で送るときだけ記録（テストは本人に届かないため記録しない）
      var k = 'infLast:tot' + AC_totKey(tot), last = state.getProperty(k), used = !!last && last > AC_addDays_(today, -7);
      if (infection && !used && !careUsed && notify) state.setProperty(k, today);
      return { infection: infection, infectionUsed: used, careUsed: careUsed };
    };
    var careGiven = {};
    if (night && Array.isArray(R.timerecord)) {
      AC_todayStatus(R, today).forEach(function (t) {
        send(t.tot, 'att:' + today + ':today:' + t.kind + ':' + AC_totKey(t.tot), function (c) { return AC_todayStatusMessage(t.kind, today, c, overrides); });
      });
    }
    f.punchErrors.forEach(function (p) { send(p.tot, 'att:' + p.date + ':punch:' + AC_totKey(p.tot), function (c) { return AC_punchMessage(p.date, c, overrides, today); }, p.date); });
    Object.keys(f.overtime).forEach(function (tot) {
      var min = f.overtime[tot];
      if (min >= 45 * 60) {
        send(tot, 'att:' + month + ':ot45:' + AC_totKey(tot), function (c) { return AC_overtimeMessage(min, 45, today, overrides, c); });
        // 36協定の管理のため、管理者にも必ず知らせる（本人への通知だけで終わらせない）
        var akey = 'att:' + month + ':ot45admin:' + AC_totKey(tot);
        if (night && (notify || test) && !state.getProperty(akey)) {
          var to = line[AC_totKey(tot)] || {};
          try {
            AC_pushLine_(AC_render('ot45Admin', today, { name: names[AC_totKey(tot)] || 'TOTコード' + tot, code: to.code || '－',
              hours: (Math.floor(min / 6) / 10).toFixed(1) }, overrides));
            state.setProperty(akey, new Date().toISOString());
          } catch (e) { Logger.log('45時間の管理者通知に失敗'); }
        }
      }
      else if (min >= 30 * 60) send(tot, 'att:' + month + ':ot30:' + AC_totKey(tot), function (c) { return AC_overtimeMessage(min, 30, today, overrides, c); });
    });
    if (test && testLines.length) {
      var head = '【勤怠テスト】本番で本人へ送る予定の通知（' + testLines.length + '件）\n\n';
      var body2 = testLines.join('\n\n');
      AC_pushLine_((head + body2).slice(0, 4900));
      sent = 1;
    }
    Logger.log('勤怠：エラー勤務 %s件／残業30h超 %s人／45h超 %s人／送信 %s通／LINE未登録 %s件（通知%s）',
      f.punchErrors.length, Object.keys(f.overtime).filter(function (k) { return f.overtime[k] >= 1800 && f.overtime[k] < 2700; }).length,
      Object.keys(f.overtime).filter(function (k) { return f.overtime[k] >= 2700; }).length, sent, unreg, notify ? 'オン' : test ? 'テスト（管理者へ）' : 'オフ');
    // 3. 勤怠チェック表
    var rows = AC_attendanceReport(R, mv, today);
    var rs = ss.getSheetByName('勤怠チェック') || ss.insertSheet('勤怠チェック');
    rs.clearContents();
    rs.getRange(1, 1, 1, AC_ATT_HEADER.length).setValues([AC_ATT_HEADER]).setFontWeight('bold');
    rs.setFrozenRows(1);
    if (rows.length) rs.getRange(2, 1, rows.length, AC_ATT_HEADER.length).setValues(rows);
  }
  // 4. 管理者向けの見守り（朝の取り込みのとき）：36協定・未承認の申請・有給の年5日（月曜）
  if (Array.isArray(R.employees) && body.mode !== 'night') {
    try { AC_adminAttendanceChecks_(R, mv, ss, today, props); } catch (e) { Logger.log('見守りの処理に失敗：%s', e && e.message); }
  }
}

/** 管理者向け：36協定の見守り、承認待ちの申請、有給の年5日。結果は従業員マスタのシートと管理者のLINEへ */
function AC_adminAttendanceChecks_(R, mv, ss, today, props) {
  var names = AC_namesByTot_(mv, R.employees);
  var nm = function (tot) { return names[AC_totKey(tot)] || 'TOTコード' + tot; };
  var state = AC_state_(), month = today.slice(0, 7);
  var writeSheet = function (name, header, rows) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.clearContents();
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  };
  // 36協定
  if (Array.isArray(R.monthlies) && R.monthlies.some(function (w) { return w && !w._error; })) {
    var startMonth = Number(props.getProperty('AGREEMENT_START_MONTH')) || 4;
    var byTot = AC_monthlyByTot(R.employees, R.monthlies), rows = [], fresh = [];
    Object.keys(byTot).forEach(function (tot) {
      var f = AC_agreementFigures(byTot[tot], startMonth, month);
      var issues = AC_agreementCheck(byTot[tot], startMonth, month);
      rows.push([tot, nm(tot), f.monthOt, f.monthTotal, f.avg + '（' + f.avgN + 'か月）', f.yearOt, f.over45,
        issues.map(function (x) { return (x.level === 'over' ? '【超過】' : '【注意】') + x.text; }).join('\n')]);
      issues.forEach(function (x) {
        var k = 'agr:' + month + ':' + AC_totKey(tot) + ':' + x.kind + ':' + x.level;
        if (state.getProperty(k)) return;
        state.setProperty(k, today);
        fresh.push((x.level === 'over' ? '🔴' : '🟡') + nm(tot) + 'さん：' + x.text);
      });
    });
    rows.sort(function (a, b) { return b[3] - a[3]; });
    writeSheet('36協定', ['TOTコード', '氏名', '今月の時間外(h)', '今月の時間外＋休日(h)', '2〜6か月平均の最大(h)', '協定年度の時間外(h)', '45h超の月数', '注意・超過'], rows);
    if (fresh.length) AC_pushLine_(('【36協定の見守り】上限に近づいている方がいます。業務量の調整をご検討ください🙇‍♀️\n（協定年度は' + startMonth + '月始まりで計算）\n\n'
      + fresh.join('\n') + '\n\n詳しくは従業員マスタの「36協定」シートをご覧ください。いつもありがとうございます！').slice(0, 4900));
  }
  // 承認待ちの申請
  if (Array.isArray(R.requests)) {
    var pend = AC_pendingRequests(R.employees, R.requests);
    if (pend.length) {
      AC_adminNotice_('requests', ('【承認待ちの申請】TOTで承認待ちの申請が' + pend.length + '件あります。お手すきの際にご確認をお願いします😊\n\n'
        + pend.slice(0, 20).map(function (p) { return '・' + nm(p.tot) + 'さん　' + p.type + '（' + p.date + '分／申請日 ' + p.requestedDate + '）'; }).join('\n')
        + (pend.length > 20 ? '\n…ほか' + (pend.length - 20) + '件' : '') + '\n\nいつもありがとうございます！').slice(0, 4900));
    }
  }
  // 有給の年5日（月曜の朝だけデータが届く）
  if (Array.isArray(R.paidLeaves) && !R.paidLeaves.some(function (l) { return l && l._error; })) {
    var st = AC_paidLeaveStatus(R.employees, R.paidLeaves, today), prow = [], alert = [];
    st.forEach(function (x) {
      var c = x.check;
      prow.push([x.tot, nm(x.tot), x.period.start, x.period.end, x.used, Math.max(0, 5 - x.used),
        c ? (c.level === 'over' ? '【急ぎ】' : '【注意】') + '残り' + c.daysLeft + '日であと' + c.need + '日' : (x.used >= 5 ? '達成' : '')]);
      if (c) alert.push((c.level === 'over' ? '🔴' : '🟡') + nm(x.tot) + 'さん：あと' + c.need + '日（期限 ' + x.period.end + '、残り' + c.daysLeft + '日）');
    });
    prow.sort(function (a, b) { return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0; });
    writeSheet('有給5日', ['TOTコード', '氏名', '基準期間の開始', '期限', '取得日数', 'あと何日', '状況'], prow);
    if (alert.length) AC_adminNotice_('paidleave', ('【有給の年5日】期限までに5日の取得が必要な方がいます。取得日の調整をお願いします🙇‍♀️\n\n'
      + alert.join('\n') + '\n\n詳しくは従業員マスタの「有給5日」シートをご覧ください。いつもありがとうございます！').slice(0, 4900));
  }
}

// ---------------- お知らせ停止（お休み中の人） ----------------
// 従業員マスタの「お知らせ停止」シート：社員番号・氏名（参考）・開始日・終了日・メモ。
// 期間中は、その人へのアルコールチェックと勤怠のお知らせを送らない（期間中の日付の打刻漏れも送らない）。
var AC_PAUSE_SHEET = 'お知らせ停止';
var AC_PAUSE_HEADER = ['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）'];

/** 純粋関数：シートの行から { 社員番号: [{from, until}] }。終了日が空なら開始日以降ずっと */
function AC_pauseIndex(rows, toDate) {
  var out = {};
  (rows || []).forEach(function (r, i) {
    if (i === 0) return;
    var code = AC_cellCode_(r[0]), from = toDate(r[2]), until = String(r[3] || '').trim() ? toDate(r[3]) : '9999-12-31';
    if (!code || !from || !until) return;
    (out[code] = out[code] || []).push({ from: from, until: until, attendanceOnly: /勤怠のみ/.test(String(r[5] || '')) });
  });
  return out;
}
/** scope が 'alcohol' のときは「勤怠のみ」の行を数えない（打刻の修正などはアルコールチェックを止めない） */
function AC_isPaused(index, code, date, scope) {
  return (index[AC_cellCode_(code)] || []).some(function (p) {
    return date >= p.from && date <= p.until && !(scope === 'alcohol' && p.attendanceOnly);
  });
}
function AC_pauseRows_() {
  var ss = AC_masterSheet_().getParent(), sh = ss.getSheetByName(AC_PAUSE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(AC_PAUSE_SHEET);
    sh.getRange(1, 1, 1, AC_PAUSE_HEADER.length).setValues([AC_PAUSE_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  if (sh.getRange(1, 6).getValue() === '') sh.getRange(1, 6).setValue(AC_PAUSE_HEADER[5]).setFontWeight('bold');
  return sh.getDataRange().getValues();
}
function AC_pauseIndex_() { try { return AC_pauseIndex(AC_pauseRows_(), AC_toDateFn_()); } catch (e) { Logger.log('お知らせ停止シートを読めませんでした'); return {}; } }

/** 純粋関数：お知らせ停止中の人の、名前（正規化）→ true（アルコールチェックの宛先から外すため） */
function AC_pausedNames(masterValues, index, date) {
  var out = {};
  for (var i = 1; i < (masterValues || []).length; i++) {
    var m = masterValues[i];
    if (!AC_isPaused(index, m[AC_COL.code], date, 'alcohol')) continue;
    if (String(m[AC_COL.name]).trim()) out[AC_normalizeName(m[AC_COL.name])] = true;
    if (String(m[AC_COL.alias] || '').trim()) out[AC_normalizeName(m[AC_COL.alias])] = true;
  }
  return out;
}
/** 純粋関数：TOTコード → 社員番号 */
function AC_codeByTot(masterValues) {
  var out = {};
  for (var i = 1; i < (masterValues || []).length; i++) {
    var t = AC_totKey(masterValues[i][AC_COL.totCode]);
    if (t) out[t] = AC_cellCode_(masterValues[i][AC_COL.code]);
  }
  return out;
}

/** 手動実行用：氏名（完全一致）で従業員マスタから社員番号を探し、「お知らせ停止」に1行追加する */
function AC_addPause_(name, from, until, memo) {
  var mv = AC_masterSheet_().getDataRange().getValues(), key = AC_normalizeName(name), hit = [];
  for (var i = 1; i < mv.length; i++) {
    if (AC_normalizeName(mv[i][AC_COL.name]) === key && String(mv[i][AC_COL.status]).trim() !== '退職') hit.push(AC_cellCode_(mv[i][AC_COL.code]));
  }
  if (hit.length !== 1) { Logger.log('該当 %s 件のため追加しませんでした（1件のときだけ追加）', hit.length); return false; }
  AC_pauseRows_();
  var sh = AC_masterSheet_().getParent().getSheetByName(AC_PAUSE_SHEET);
  sh.appendRow(["'" + hit[0], String(mv.filter(function (r) { return AC_cellCode_(r[AC_COL.code]) === hit[0]; })[0][AC_COL.name]), from, until || '', memo || '']);
  Logger.log('お知らせ停止に追加しました（%s〜%s）', from, until || '終了日なし');
  return true;
}

// ---------------- 勤怠連絡フォーム ----------------
// 欠勤・休み・遅刻などを、本人や上司がフォームで連絡する。送信されると：
//  ・欠勤／有給休暇／休みの変更 → 「お知らせ停止」に追加（アルコールチェックも勤怠も止める）
//  ・打刻の修正 → 「お知らせ停止」に「勤怠のみ」で追加（その日の打刻漏れのお知らせを止める）
//  ・遅刻／早退／その他 → 記録と管理者への連絡のみ
//  ・いずれも管理者のLINEへ内容を知らせる。回答は従業員マスタの回答シートにも残る
// TOTを修正できるのは本人（打刻の申請）と管理本部だけ。上司は閲覧のみ。休み・欠勤など当月の変更はこのフォームで連絡してもらう
var AC_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSfMc6SWJkjnJfqPfobUJt1NDvzQTuSjir97IMW_YTOctLJvFw/viewform';
var AC_FORM_KINDS = ['欠勤', '有給休暇', '休みの変更（シフト交換など）', '打刻の修正', '遅刻', '早退', 'その他'];
var AC_FORM_Q = { by: '入力者（あなたのお名前）', approver: '承認者（ご本人が入力するとき）', who: '対象者', kind: '区分', from: '日付（開始日）', until: '終了日（何日か続くとき）',
  changeTo: '変更後の休みの日（休みの変更のときだけ）', reason: '理由・連絡事項' };
var AC_FORM_HELP = { from: '休みの変更のときは、もともと休みだった日を入れてください',
  changeTo: '休みの変更のときだけ入力してください。新しく休む日です（例：20日の休みを22日に変更 → 上の日付に20日、ここに22日）',
  approver: 'ご本人が入力するときは、確認・承認してくれた上司のお名前を入れてください（上司の方が入力するときは空欄でOKです）' };
/** 純粋関数：氏名の比較用（空白・「さん」を除く） */
function AC_nameKey_(s) { return String(s || '').replace(/[\s　]/g, '').replace(/さん$/, ''); }

/** 純粋関数：対象者の選択肢「氏名（社員番号）」（在籍者のみ、社員番号順） */
function AC_formChoices(masterValues) {
  var out = [];
  for (var i = 1; i < (masterValues || []).length; i++) {
    var m = masterValues[i], code = AC_cellCode_(m[AC_COL.code]), name = String(m[AC_COL.name] || '').trim();
    if (!code || !name || String(m[AC_COL.status]).trim() === '退職') continue;
    out.push({ code: code, label: name + '（' + code + '）' });
  }
  out.sort(function (a, b) { return (Number(a.code) || 0) - (Number(b.code) || 0) || (a.code < b.code ? -1 : 1); });
  return out.map(function (x) { return x.label; });
}
/** 純粋関数：選択肢から社員番号を取り出す */
function AC_codeFromChoice(label) { var m = /（([^（）]+)）\s*$/.exec(String(label || '')); return m ? m[1].trim() : ''; }

/**
 * 純粋関数：フォームの回答から、やること（お知らせ停止の行・管理者への文面）。
 * 終了日が空なら1日だけ。終了日が開始日より前なら入れ替える。
 */
function AC_formPlan(ans, opts) {
  var test = !!(opts && opts.test);   // テスト期間：文面の先頭に【テスト】、お知らせは止めない
  var code = AC_codeFromChoice(ans.who), from = ans.from, until = ans.until || ans.from;
  if (until < from) { var t = from; from = until; until = t; }
  var kind = ans.kind || 'その他', pause = null, change = /休みの変更/.test(kind), changeTo = ans.changeTo || '';
  if (/欠勤|有給/.test(kind)) pause = { scope: '全部' };
  else if (change && changeTo) { pause = { scope: '全部' }; }
  else if (/打刻の修正/.test(kind)) pause = { scope: '勤怠のみ' };
  var name = String(ans.who || '').replace(/（[^（）]+）\s*$/, '');
  var isSelf = !!ans.by && AC_nameKey_(ans.by) === AC_nameKey_(name);   // ご本人が入力した
  var period = from === until ? from : from + '〜' + until;
  if (change) {
    period = from + '（もともとの休み）→ ' + (changeTo || '（変更後の日が未記入）');
    if (changeTo) { from = changeTo; until = changeTo; }   // 新しく休む日だけお知らせを止める
  }
  // 報告の文面（グループと管理者で共通）。業務連絡なので感謝の言葉は付けない
  var report = '【勤怠変更の報告】\n・氏名：' + name + 'さん\n・区分：' + kind + '\n・日付：' + period
    + '\n・理由：' + (ans.reason || '') + '\n・報告者：' + (ans.by ? ans.by + 'さん' : '（未記入）')
    + (ans.approver ? '\n・承認者：' + ans.approver + 'さん' : (isSelf ? '\n・承認者：（未記入）' : ''))
    + '\n\n上記の勤怠変更について報告がありました。\n内容をご確認いただきますようお願いいたします。';
  var notes = [];
  var thisMonth = opts && opts.today ? String(opts.today).slice(0, 7) : '';
  if (thisMonth && String(ans.from || '').slice(0, 7) > thisMonth)
    notes.push('翌月以降の日付です。翌月以降のシフトの修正は、ご本人から管理本部へ直接連絡する運用です。');
  if (isSelf && !ans.approver) notes.push('ご本人からの入力で、承認者が書かれていません。上司の方への確認をお願いします。');
  if (change && !changeTo) notes.push('変更後の休みの日が書かれていなかったため、お知らせは止めていません。ご本人への確認をお願いします。');
  if (test && pause) { notes.push('テスト期間のため、お知らせは止めていません。'); pause = null; }
  else if (pause) {
    notes.push(pause.scope === '全部' ? (change ? changeTo + 'は' : 'この期間、') + name + 'さんへのアルコールチェックと勤怠のお知らせを止めました。'
      : 'この期間の打刻漏れのお知らせを止めました。');
    notes.push('TOTへの登録（欠勤・有休・打刻修正など）もお願いします。');
  } else if (!change && !test) notes.push('記録のみです（お知らせは止めていません）。');
  if (change) notes.push('管理シートのシフトとTOTの変更もお願いします。');
  if (test) report = '【テスト】\n' + report;
  var text = report + '\n\n' + notes.join('\n');
  var groupText = report;
  return { code: code, name: name, from: from, until: until, kind: kind, pause: pause, self: isSelf, text: text, groupText: groupText };
}

/** 手動実行：勤怠連絡フォームを作る（設問がまだ無いときだけ追加）。回答先と送信時のトリガーも設定する */
function alcoholCheckSetupAttendanceForm() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('ATTENDANCE_FORM_ID');
  if (!id) throw new Error('スクリプトプロパティ ATTENDANCE_FORM_ID を設定してください');
  var form = FormApp.openById(id);
  form.setTitle('勤怠の連絡（欠勤・休み・遅刻・打刻の修正など）');
  form.setDescription('欠勤や休みの変更、打刻の修正など、当月分の勤怠の変更はこちらから連絡してください。本人でも上司の方でも入力できます。\n'
    + '※翌月以降のシフトの修正は、このフォームではなく、ご本人から管理本部へ直接ご連絡ください。\n'
    + '何日か続くときは「終了日」に最終日を入れてください（1日だけのときは空欄でOKです）。\n'
    + '期間が延びたり短くなったりしたときは、もう一度送ってください。\nいつもご協力ありがとうございます！');
  if (form.getItems().length === 0) {
    form.addTextItem().setTitle(AC_FORM_Q.by).setRequired(true);
    form.addListItem().setTitle(AC_FORM_Q.who).setHelpText('連絡する人（お休みする人など）を選んでください').setChoiceValues(['（読み込み中）']).setRequired(true);
    form.addMultipleChoiceItem().setTitle(AC_FORM_Q.kind).setChoiceValues(AC_FORM_KINDS).setRequired(true);
    form.addDateItem().setTitle(AC_FORM_Q.from).setHelpText(AC_FORM_HELP.from).setRequired(true);
    form.addDateItem().setTitle(AC_FORM_Q.until).setHelpText('1日だけのときは空欄でOKです。終わりがまだわからないときは見込みの日付を入れてください').setRequired(false);
    form.addParagraphTextItem().setTitle(AC_FORM_Q.reason).setHelpText('例：体調不良のため、家庭の事情のため、など（病名などくわしい内容は書かなくて大丈夫です）').setRequired(true);
  }
  // 後から追加した設問（無ければ「終了日」の次に入れる）
  var items = form.getItems();
  var titles = items.map(function (it) { return it.getTitle(); });
  if (titles.indexOf(AC_FORM_Q.changeTo) === -1) {
    var added = form.addDateItem().setTitle(AC_FORM_Q.changeTo).setHelpText(AC_FORM_HELP.changeTo).setRequired(false);
    var at = titles.indexOf(AC_FORM_Q.until);
    if (at !== -1) form.moveItem(added.getIndex(), at + 1);
  }
  if (titles.indexOf(AC_FORM_Q.approver) === -1) {
    var ap = form.addTextItem().setTitle(AC_FORM_Q.approver).setHelpText(AC_FORM_HELP.approver).setRequired(false);
    var bi = form.getItems().map(function (it) { return it.getTitle(); }).indexOf(AC_FORM_Q.by);
    if (bi !== -1) form.moveItem(ap.getIndex(), bi + 1);
  }
  items.forEach(function (it) { if (it.getTitle() === AC_FORM_Q.from) it.setHelpText(AC_FORM_HELP.from); });
  AC_refreshFormChoices_(form);
  try {
    var dest = props.getProperty('ATTENDANCE_RESPONSE_ID') || props.getProperty('EMPLOYEE_MASTER_ID'), cur = null;   // 回答の置き場所（専用のスプレッドシートがあればそちら）
    try { cur = form.getDestinationId(); } catch (e2) { cur = null; }
    if (cur !== dest) form.setDestination(FormApp.DestinationType.SPREADSHEET, dest);   // 2回目以降は回答シートを増やさない
  } catch (e) { Logger.log('回答先の設定に失敗：%s', e.message); }
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'alcoholCheckOnAttendanceForm') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('alcoholCheckOnAttendanceForm').forForm(form).onFormSubmit().create();
  Logger.log('フォームを準備しました：%s', form.getPublishedUrl());
}

/** 対象者の選択肢を従業員マスタから更新する（入社・退職の反映。毎朝の案内のときにも実行） */
function AC_refreshFormChoices_(form) {
  if (!form) {
    var id = PropertiesService.getScriptProperties().getProperty('ATTENDANCE_FORM_ID');
    if (!id) return;
    form = FormApp.openById(id);
  }
  var item = form.getItems(FormApp.ItemType.LIST).filter(function (it) { return it.getTitle() === AC_FORM_Q.who; })[0];
  if (!item) return;
  var choices = AC_formChoices(AC_masterSheet_().getDataRange().getValues());
  if (choices.length) item.asListItem().setChoiceValues(choices);
}

/** フォーム送信時（インストール型トリガー） */
function alcoholCheckOnAttendanceForm(e) {
  try {
    var ans = {}, tz = AC_TZ;
    e.response.getItemResponses().forEach(function (r) {
      var t = r.getItem().getTitle(), v = r.getResponse();
      Object.keys(AC_FORM_Q).forEach(function (k) { if (AC_FORM_Q[k] === t) ans[k] = String(v || '').trim(); });
    });
    // 本運用の開始日（スクリプトプロパティ FORM_LIVE_FROM、既定 2026-10-20）より前はテスト扱い
    var liveFrom = PropertiesService.getScriptProperties().getProperty('FORM_LIVE_FROM') || '2026-10-20';
    var isTest = AC_today_() < liveFrom;
    var plan = AC_formPlan(ans, { test: isTest, today: AC_today_() });
    if (!plan.code) { AC_pushLine_('【勤怠連絡フォーム】対象者を読み取れませんでした🙇‍♀️ フォームの回答をご確認ください。'); return; }
    if (plan.pause) {
      AC_pauseRows_();
      AC_masterSheet_().getParent().getSheetByName(AC_PAUSE_SHEET)
        .appendRow(["'" + plan.code, plan.name, plan.from, plan.until, 'フォーム：' + plan.kind + '（入力：' + (ans.by || '') + '）', plan.pause.scope]);
    }
    var g = { dept: '', sent: 0 };
    try { g = AC_pushFormToGroups_(plan.code, plan.groupText.slice(0, 4900)); } catch (eg) { Logger.log('グループ送信の失敗'); }
    var adminText = (plan.text + '\n' + (g.sent ? '（' + g.dept + 'のグループLINEにもお知らせしました）'
      : '（' + (g.dept || '所属未設定') + 'のグループLINEが未登録のため、グループには送っていません）')).slice(0, 4900);
    // 本運用後は勤怠管理グループへ（未登録・送信失敗なら管理者の個別LINEへ）。テスト期間は管理者の個別LINEへ
    var adminSent = 0;
    if (!isTest) {
      try {
        (AC_groupsByDept(AC_groupSheet_().getDataRange().getValues())[AC_ADMIN_GROUP] || []).forEach(function (gid) {
          try { AC_pushTo_(gid, adminText); adminSent++; } catch (e1) { Logger.log('勤怠管理グループへの送信に失敗'); }
        });
      } catch (e2) { Logger.log('勤怠管理グループの読み込みに失敗'); }
    }
    if (!adminSent) AC_pushLine_(adminText);
  } catch (err) {
    Logger.log('フォーム処理の失敗：%s', err && err.message);
    AC_adminNotice_('form', '【エラー】勤怠連絡フォームの処理中に問題がありました🙇‍♀️ フォームの回答をご確認ください。');
  }
}

// ---------------- 部門のグループLINE ----------------
// 公式LINEを部門のグループに招待し、グループで「部門登録 ○○」と送ると、そのグループを部門（従業員マスタの所属）に結びつける。
// 勤怠連絡フォームの送信があると、対象者の所属のグループへすぐに知らせる。
var AC_GROUP_SHEET = 'LINEグループ';
// 勤怠管理専用グループ（管理者向けの内容をすべて受け取る）。「部門登録 勤怠管理」で登録する。本運用の開始日から使う
var AC_ADMIN_GROUP = '勤怠管理';
var AC_GROUP_HEADER = ['グループID', '部門（所属）', '登録日時', '状態'];

/** 純粋関数：「部門登録 ○○」なら部門名の一覧（「、」「,」で複数可）。それ以外は null */
function AC_parseDeptRegistration(text) {
  var m = /^\s*部門登録[\s　:：]*(.+?)\s*$/.exec(String(text || ''));
  if (!m) return null;
  var list = m[1].split(/[、,，\s　]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  return list.length ? list : null;
}
/** 純粋関数：従業員マスタにある所属名（在籍者のみ、重複なし） */
function AC_deptNames(masterValues) {
  var seen = {}, out = [];
  for (var i = 1; i < (masterValues || []).length; i++) {
    var d = String(masterValues[i][AC_COL.dept] || '').trim();
    if (d && String(masterValues[i][AC_COL.status]).trim() !== '退職' && !seen[d]) { seen[d] = 1; out.push(d); }
  }
  return out;
}
/** 純粋関数：シートの行から、部門 → グループIDの一覧（状態が「有効」のものだけ） */
function AC_groupsByDept(rows) {
  var out = {};
  (rows || []).forEach(function (r, i) {
    if (i === 0 || String(r[3] || '').trim() !== '有効') return;
    var id = String(r[0] || '').trim();
    String(r[1] || '').split(/[、,，]+/).forEach(function (d) {
      d = d.trim();
      if (d && id) { out[d] = out[d] || []; if (out[d].indexOf(id) === -1) out[d].push(id); }
    });
  });
  return out;
}
function AC_groupSheet_() {
  var ss = AC_masterSheet_().getParent(), sh = ss.getSheetByName(AC_GROUP_SHEET);
  if (!sh) {
    sh = ss.insertSheet(AC_GROUP_SHEET);
    sh.getRange(1, 1, 1, AC_GROUP_HEADER.length).setValues([AC_GROUP_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function AC_handleGroupEvent_(ev) {
  var gid = ev.source.groupId || ev.source.roomId;
  if (!gid) return;
  if (ev.type === 'join') {
    AC_reply_(ev.replyToken, 'グループに招待していただき、ありがとうございます！REBIRTH 管理本部です😊\n'
      + '勤怠の連絡をこのグループにお知らせするため、「部門登録 ○○」と送ってください（○○は部門名です）。');
    AC_pushLine_('【グループLINE】公式LINEが新しいグループに招待されました。グループで「部門登録 ○○」が送られると登録されます。');
    return;
  }
  if (ev.type === 'leave') {
    var sh0 = AC_groupSheet_(), v0 = sh0.getDataRange().getValues();
    for (var j = 1; j < v0.length; j++) if (String(v0[j][0]) === gid) sh0.getRange(j + 1, 4).setValue('退出');
    AC_pushLine_('【グループLINE】公式LINEがグループから退出しました（「LINEグループ」シートを「退出」にしました）。');
    return;
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  var depts = AC_parseDeptRegistration(ev.message.text);
  if (!depts) return;   // グループの普段の会話には反応しない
  var known = AC_deptNames(AC_masterSheet_().getDataRange().getValues()).concat([AC_ADMIN_GROUP]);
  var ok = depts.filter(function (d) { return known.indexOf(d) !== -1; });
  var ng = depts.filter(function (d) { return known.indexOf(d) === -1; });
  if (!ok.length) {
    AC_reply_(ev.replyToken, '「' + ng.join('、') + '」という部門が見つかりませんでした🙇‍♀️\n登録できる部門：' + known.join('、')
      + '\nもう一度「部門登録 ○○」と送ってください。');
    return;
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = AC_groupSheet_(), v = sh.getDataRange().getValues(), row = -1;
    for (var i = 1; i < v.length; i++) if (String(v[i][0]) === gid) row = i + 1;
    var vals = [gid, ok.join('、'), new Date(), '有効'];
    if (row > 0) sh.getRange(row, 1, 1, 4).setValues([vals]); else sh.appendRow(vals);
  } finally { lock.releaseLock(); }
  AC_reply_(ev.replyToken, 'このグループを「' + ok.join('、') + '」のグループとして登録しました！ありがとうございます😊\n'
    + (ok.indexOf(AC_ADMIN_GROUP) !== -1 ? '本運用の開始後は、勤怠連絡フォームのすべての報告（管理者向けの内容）をこちらへお知らせします。'
      : 'これから、勤怠連絡フォームで' + ok.join('・') + 'の方の連絡があったときに、こちらへお知らせします。')
    + (ng.length ? '\n（「' + ng.join('、') + '」は見つからなかったため登録していません）' : ''));
  AC_pushLine_('【グループLINE】グループを「' + ok.join('、') + '」として登録しました。');
}

/** 勤怠連絡を対象者の部門のグループへ送る。送った数を返す */
function AC_pushFormToGroups_(code, text) {
  var mv = AC_masterSheet_().getDataRange().getValues(), dept = '';
  for (var i = 1; i < mv.length; i++) if (AC_cellCode_(mv[i][AC_COL.code]) === code) dept = String(mv[i][AC_COL.dept] || '').trim();
  if (!dept) return { dept: '', sent: 0 };
  var groups = AC_groupsByDept(AC_groupSheet_().getDataRange().getValues())[dept] || [], sent = 0;
  groups.forEach(function (g) { try { AC_pushTo_(g, text); sent++; } catch (e) { Logger.log('グループへの送信に失敗'); } });
  return { dept: dept, sent: sent };
}

/** 純粋関数：TOTコード → 氏名（マスタ優先、無ければTOTの氏名） */
function AC_namesByTot_(masterValues, employees) {
  var out = {};
  (employees || []).forEach(function (e) { out[AC_totKey(e.code)] = (String(e.lastName || '') + ' ' + String(e.firstName || '')).trim(); });
  for (var i = 1; i < (masterValues || []).length; i++) {
    var t = AC_totKey(masterValues[i][AC_COL.totCode]);
    if (t && String(masterValues[i][AC_COL.name]).trim()) out[t] = String(masterValues[i][AC_COL.name]).trim();
  }
  return out;
}

/** 純粋関数：YYYY-MM に n か月足す */
function AC_addMonths(ym, n) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + '-' + (m < 9 ? '0' : '') + (m + 1);
}

/**
 * 純粋関数：36協定（特別条項あり）の見守り。
 * months：{ 'YYYY-MM': { overtime: 分（時間外）, holiday: 分（法定休日労働） } }（1人分）
 * startMonth：協定の起算月（1〜12）。month：今月（YYYY-MM）。
 * 返り値：引っかかった項目の一覧 [{ kind, level: 'warn'|'over', value, limit, text }]
 *  ・月の時間外＋休日労働：100時間未満（80時間で注意）
 *  ・2〜6か月平均（時間外＋休日労働）：80時間以内（70時間で注意）
 *  ・協定年度の時間外：720時間以内（600時間で注意）
 *  ・月45時間を超えた月の回数：年6回まで（5回で注意、今月が7回目なら超過）
 */
function AC_agreementFigures(months, startMonth, month) {
  var h = function (min) { return Math.floor((min || 0) / 6) / 10; };
  var get = function (ym) { var v = months[ym] || {}; return { ot: Number(v.overtime) || 0, hol: Number(v.holiday) || 0 }; };
  var cur = get(month);
  var worst = null;
  for (var n = 2; n <= 6; n++) {
    var sum = 0;
    for (var i = 0; i < n; i++) { var v = get(AC_addMonths(month, -i)); sum += v.ot + v.hol; }
    var avg = Math.floor(h(sum) / n * 10) / 10;
    if (!worst || avg > worst.avg) worst = { n: n, avg: avg };
  }
  var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  var start = (m >= startMonth ? y : y - 1) + '-' + (startMonth < 10 ? '0' : '') + startMonth;
  var yearOt = 0, over45 = 0;
  for (var ym = start; ym <= month; ym = AC_addMonths(ym, 1)) { var g = get(ym); yearOt += g.ot; if (g.ot > 45 * 60) over45++; }
  return { monthOt: h(cur.ot), monthTotal: h(cur.ot + cur.hol), avg: worst.avg, avgN: worst.n, start: start, yearOt: h(yearOt), over45: over45 };
}

function AC_agreementCheck(months, startMonth, month) {
  var f = AC_agreementFigures(months, startMonth, month), out = [];
  var push = function (kind, value, warn, limit, overIf, text) {
    var level = overIf ? 'over' : value >= warn ? 'warn' : null;
    if (level) out.push({ kind: kind, level: level, value: value, limit: limit, text: text });
  };
  push('month100', f.monthTotal, 80, 100, f.monthTotal >= 100, '今月の時間外＋休日労働 ' + f.monthTotal + '時間（上限100時間未満）');
  push('avg80', f.avg, 70, 80, f.avg > 80, '直近' + f.avgN + 'か月平均の時間外＋休日労働 ' + f.avg + '時間（上限80時間）');
  push('year720', f.yearOt, 600, 720, f.yearOt > 720, '協定年度（' + f.start + '〜）の時間外 ' + f.yearOt + '時間（上限720時間）');
  push('over45', f.over45, 5, 6, f.over45 > 6, '月45時間を超えた月 ' + f.over45 + '回（上限 年6回）');
  return out;
}

/** 純粋関数：TOTの月別勤怠を「TOTコード → { 'YYYY-MM': {overtime, holiday} }」に（分）。時間外＝残業＋深夜残業、休日労働＝法定休日の全時間 */
function AC_monthlyByTot(employees, monthlies) {
  var codeByKey = AC_totCodeByKey_(employees), out = {};
  (monthlies || []).forEach(function (w) {
    if (!w || w._error) return;
    var tot = codeByKey[w.employeeKey];
    if (!tot || !w.year || !w.month) return;
    var ym = w.year + '-' + (w.month < 10 ? '0' : '') + w.month;
    var lh = w.legalHolidayWork || {};
    (out[tot] = out[tot] || {})[ym] = {
      overtime: (Number(w.overtime) || 0) + (Number(w.nightOvertime) || 0),
      holiday: (Number(lh.normal) || 0) + (Number(lh.night) || 0) + (Number(lh.overtime) || 0) + (Number(lh.nightOvertime) || 0),
    };
  });
  return out;
}

/** 純粋関数：承認待ちの申請（applying）。古い順 */
function AC_pendingRequests(employees, requests) {
  var codeByKey = AC_totCodeByKey_(employees);
  var label = { timerecords: '打刻申請', schedules: 'スケジュール（休暇など）申請', overtimes: '残業申請' };
  var seen = {}, out = [];
  (requests || []).forEach(function (r) {
    if (!r || r._error || r.status !== 'applying') return;
    var k = r.type + ':' + (r.requestKey || r.employeeKey + r.date);
    if (seen[k]) return; seen[k] = 1;
    out.push({ tot: codeByKey[r.employeeKey] || '', type: label[r.type] || r.type, date: r.date, requestedDate: String(r.requestedDate || '').slice(0, 10) });
  });
  out.sort(function (a, b) { return a.requestedDate < b.requestedDate ? -1 : a.requestedDate > b.requestedDate ? 1 : 0; });
  return out;
}

/** 純粋関数：有給の年5日（入社日・取得した有休の日から、一人ずつ） */
function AC_paidLeaveStatus(employees, leaves, today) {
  var byKey = {};
  (leaves || []).forEach(function (l) { if (l && !l._error) (byKey[l.employeeKey] = byKey[l.employeeKey] || []).push(l); });
  var out = [];
  (employees || []).forEach(function (e) {
    var period = AC_paidLeavePeriod(e.hiredDate, today);
    if (!period) return;
    var used = 0, seen = {};
    (byKey[e.key] || []).forEach(function (l) {
      if (l.date >= period.start && l.date <= today && !seen[l.date]) { seen[l.date] = 1; used += Number(l.days) || 0; }
    });
    out.push({ tot: String(e.code || ''), period: period, used: used, check: AC_paidLeaveCheck(period, used, today) });
  });
  return out;
}

/** 純粋関数：入社日から、いまの有給の基準期間（6か月後の日から1年ごと）。まだ付与前なら null */
function AC_paidLeavePeriod(hiredDate, today) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(hiredDate || ''))) return null;
  var addM = function (d, n) {
    var y = Number(d.slice(0, 4)), mo = Number(d.slice(5, 7)) - 1 + n, day = Number(d.slice(8, 10));
    y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12;
    var last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    return y + '-' + (mo < 9 ? '0' : '') + (mo + 1) + '-' + (Math.min(day, last) < 10 ? '0' : '') + Math.min(day, last);
  };
  var first = addM(String(hiredDate).slice(0, 10), 6);
  if (first > today) return null;
  var start = first;
  while (addM(start, 12) <= today) start = addM(start, 12);
  return { start: start, end: AC_addDays_(addM(start, 12), -1) };
}

/**
 * 純粋関数：有給の年5日。used は期間内に取った日数（半休は0.5）。
 * 残りの日数に対して、取らないといけない日数が多いほど早めに知らせる。
 * 返り値：null（問題なし）か { level: 'warn'|'over', need, daysLeft }
 */
function AC_paidLeaveCheck(period, used, today) {
  if (!period) return null;
  var need = Math.max(0, 5 - (Number(used) || 0));
  if (!need) return null;
  var daysLeft = Math.round((Date.parse(period.end) - Date.parse(today)) / 86400000) + 1;
  if (daysLeft <= 0) return null;
  if (daysLeft <= 60) return { level: 'over', need: need, daysLeft: daysLeft };
  if (daysLeft <= 120) return { level: 'warn', need: need, daysLeft: daysLeft };
  return null;
}

/** 純粋関数：翌月（YYYY-MM） */
function AC_nextMonth(today) {
  var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  return m === 12 ? (y + 1) + '-01' : y + '-' + (m < 9 ? '0' : '') + (m + 1);
}

/**
 * 純粋関数：翌月分の書き換え候補のうち、実際に書き換えるもの。
 * 対象の月の日付だけ・数式が入っているセルは書き換えない（数式を守る）。
 */
function AC_monthlyApplyPlan(updates, formulas, month) {
  var apply = [], skipped = [];
  (updates || []).forEach(function (u) {
    if (String(u.date).slice(0, 7) !== month) return;
    if (formulas && formulas[u.row] && formulas[u.row][u.col]) skipped.push(u); else apply.push(u);
  });
  return { apply: apply, skipped: skipped };
}

var AC_TOT_MONTH_SHEET = 'TOT翌月シフト反映';

/** 翌月のシフトをTOTの値で管理シート（2026-2028）へ書き換える。結果は「TOT翌月シフト反映」シートと管理者のLINEへ */
function AC_applyNextMonthShift_(R, mv, ss, today) {
  var month = AC_nextMonth(today), state = AC_state_(), doneKey = 'totmonth:' + month;
  if (state.getProperty(doneKey)) return;
  var label = Number(month.slice(5, 7)) + '月';
  var schedule = SpreadsheetApp.openById(AC_SPREADSHEET_ID).getSheetByName(AC_SHEET_SCHEDULE);
  var range = schedule.getDataRange(), sv = range.getValues(), formulas = range.getFormulas();
  var toDate = AC_toDateFn_();
  var hasCols = Object.keys(AC_shiftIndex_(sv, toDate).cols).some(function (d) { return d.slice(0, 7) === month; });
  if (!hasCols) {
    AC_adminNotice_('totmonth', '【確認のお願い】' + label + 'のシフトをTOTから反映しようとしましたが、管理シート「' + AC_SHEET_SCHEDULE + '」に' + label + 'の日付の列が見つかりませんでした🙇‍♀️\n'
      + '日付の列をご用意いただければ、翌朝もう一度反映します。');
    return;
  }
  var cmp = AC_buildTotCompare(AC_totScheduleItems({ employees: R.employees, schedules: R.nextSchedules }), mv, sv, toDate);
  var plan = AC_monthlyApplyPlan(cmp.updates, formulas, month);
  plan.apply.forEach(function (u) { schedule.getRange(u.row + 1, u.col + 1).setValue(u.value); });
  // 結果（元の値も残すので、必要なら手で戻せる）
  var sh = ss.getSheetByName(AC_TOT_MONTH_SHEET) || ss.insertSheet(AC_TOT_MONTH_SHEET);
  sh.clearContents();
  var head = AC_TOT_HEADER.concat(['反映']);
  var skippedKey = {};
  plan.skipped.forEach(function (u) { skippedKey[u.date + ':' + u.code] = 1; });
  var rows = cmp.rows.filter(function (r) { return String(r[0]).slice(0, 7) === month; }).map(function (r) {
    if (r[6] !== '違い') return r.concat(['']);
    return r.concat([skippedKey[r[0] + ':' + r[1]] ? '数式のセルのため書き換えなし' : 'TOTの値に書き換え（元の値：' + (r[5] || '空欄') + '）']);
  });
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  state.setProperty(doneKey, new Date().toISOString());
  var c = cmp.counts;
  AC_pushLine_('【' + label + 'のシフト反映】TOTの' + label + 'のシフトを管理シートに反映しました！いつもシフト作成ありがとうございます😊\n'
    + '・書き換え：' + plan.apply.length + '件\n・一致（変更なし）：' + c['一致'] + '件\n'
    + (c['未設定'] ? '・未設定（TOTに予定がなく空欄のまま）：' + c['未設定'] + '件\n' : '')
    + (c['要確認'] ? '・要確認（区分を判断できず書き換えなし）：' + c['要確認'] + '件\n' : '')
    + (plan.skipped.length ? '・数式のセルのため書き換えなし：' + plan.skipped.length + '件\n' : '')
    + (c['マスタに無い'] ? '・従業員マスタに無い人：' + c['マスタに無い'] + '件\n' : '')
    + '詳しくは従業員マスタの「' + AC_TOT_MONTH_SHEET + '」シートをご覧ください（元の値も残しています）。');
}

/** 純粋関数：TOTの勤務予定を {tot, date, pattern} に（pattern は「10:00-19:00」か休暇名。有休→有給） */
function AC_totScheduleItems(R) {
  var codeByKey = AC_totCodeByKey_(R.employees);
  var out = [];
  AC_totFlat_(R.schedules).forEach(function (s) {
    var tot = codeByKey[s.employeeKey];
    if (!tot || !s.date) return;
    var pattern = '';
    if (s.clockInSchedule && s.clockOutSchedule) {
      pattern = AC_hm_(s.clockInSchedule) + '-' + AC_hm_(s.clockOutSchedule);
    } else if (s.holidaysObtained && s.holidaysObtained.fulltimeHoliday && s.holidaysObtained.fulltimeHoliday.name) {
      pattern = s.holidaysObtained.fulltimeHoliday.name === '有休' ? '有給' : String(s.holidaysObtained.fulltimeHoliday.name);
    }
    out.push({ tot: tot, date: s.date, pattern: pattern });
  });
  return out;
}

function AC_hm_(iso) { var m = /T(\d{2}):(\d{2})/.exec(String(iso || '')); return m ? String(Number(m[1])) + ':' + m[2] : ''; }
function AC_totFlat_(days) {
  var out = [];
  (days || []).forEach(function (d) { (d.dailySchedules || d.dailyWorkings || []).forEach(function (x) { out.push(x); }); });
  return out;
}
function AC_totCodeByKey_(employees) {
  var m = {};
  (employees || []).forEach(function (e) { if (e && e.key) m[e.key] = String(e.code || ''); });
  return m;
}

/**
 * 純粋関数：打刻漏れ等（TOTのエラー勤務。昨日から7日前まで）と、今月の残業（分）。
 * 残業 = TOTの「残業」＋「深夜残業」（日別の合計）。
 */
function AC_attendanceFindings(R, today) {
  var codeByKey = AC_totCodeByKey_(R.employees);
  var from = AC_addDays_(today, -7), month = today.slice(0, 7);
  var punchErrors = [], overtime = {};
  AC_totFlat_(R.workings).forEach(function (w) {
    var tot = codeByKey[w.employeeKey];
    if (!tot || !w.date) return;
    if (w.isError === true && w.date >= from && w.date < today) punchErrors.push({ tot: tot, date: w.date });
    if (w.date.slice(0, 7) === month) overtime[tot] = (overtime[tot] || 0) + (Number(w.overtime) || 0) + (Number(w.lateNightOvertime) || 0);
  });
  return { punchErrors: punchErrors, overtime: overtime };
}

function AC_addDays_(date, n) {
  var t = new Date(date + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * 純粋関数：当日の勤怠状況（夜22:30に確認）。
 *  noClockOut：出勤の打刻はあるが、退勤の打刻がまだ無い（勤務中、または退勤の打刻漏れ）
 *  noClockIn：今日が出勤予定（時刻あり）なのに、打刻が1つも無い
 */
function AC_todayStatus(R, today) {
  var codeByKey = AC_totCodeByKey_(R.employees);
  var punches = {};
  AC_totFlat_(R.timerecord).forEach(function (t) {
    if (t.date !== today) return;
    var p = punches[t.employeeKey] = punches[t.employeeKey] || { in: 0, out: 0 };
    (t.timeRecord || []).forEach(function (r) { if (String(r.code) === '1') p.in++; if (String(r.code) === '2') p.out++; });
  });
  var out = [], seen = {};
  Object.keys(punches).forEach(function (k) {
    var p = punches[k], tot = codeByKey[k];
    if (tot && p.in > p.out) { out.push({ tot: tot, kind: 'noClockOut' }); seen[k] = 1; }
  });
  AC_totFlat_(R.schedules).forEach(function (s) {
    if (s.date !== today || seen[s.employeeKey] || !s.clockInSchedule) return;
    var tot = codeByKey[s.employeeKey];
    if (tot && !punches[s.employeeKey]) { out.push({ tot: tot, kind: 'noClockIn' }); seen[s.employeeKey] = 1; }
  });
  return out;
}

function AC_todayStatusMessage(kind, today, ctx, overrides) {
  var key = kind === 'noClockIn' ? 'todayNoClockIn' : 'todayNoClockOut';
  return AC_render(key, today, { care: AC_careLine(key, today, ctx, overrides).text }, overrides);
}

/** 純粋関数：従業員マスタから「TOTコード → {code, userId}」（LINE確認済み・退職でない人。アルコール対象かは問わない） */
function AC_lineByTotCode(masterValues, today) {
  var out = {};
  for (var i = 1; i < (masterValues || []).length; i++) {
    var r = masterValues[i];
    if (r[AC_COL.lineOk] !== true || !AC_isUserId(r[AC_COL.userId])) continue;
    if (String(r[AC_COL.status]).trim() === '退職' || (today && AC_isRetired(r[AC_COL.retiredOn], today))) continue;
    var tot = AC_totKey(r[AC_COL.totCode]);
    if (tot) out[tot] = { code: AC_cellCode_(r[AC_COL.code]), userId: r[AC_COL.userId] };
  }
  return out;
}

var AC_ATT_HEADER = ['月', '社員番号', '氏名', 'TOTコード', '出勤日数', '残業（時間）', '遅刻（回）', '早退（回）', '有休（日）', '欠勤（日）', 'エラー勤務（日）', '未締め（日）', 'LINE登録'];

/** 純粋関数：前月と今月（昨日まで）の勤怠チェック表。エラー勤務・欠勤・残業が多い順 */
function AC_attendanceReport(R, masterValues, today) {
  var codeByKey = AC_totCodeByKey_(R.employees);
  var who = {};
  for (var i = 1; i < (masterValues || []).length; i++) {
    var t = AC_totKey(masterValues[i][AC_COL.totCode]);
    if (t) who[t] = { code: AC_cellCode_(masterValues[i][AC_COL.code]), name: String(masterValues[i][AC_COL.name]).trim(), line: masterValues[i][AC_COL.lineOk] === true };
  }
  var nameByTot = {};
  (R.employees || []).forEach(function (e) { nameByTot[AC_totKey(e.code)] = String(e.lastName || '') + ' ' + String(e.firstName || ''); });
  var agg = {};
  AC_totFlat_(R.workings).forEach(function (w) {
    var tot = codeByKey[w.employeeKey];
    if (!tot || !w.date || w.date >= today) return;
    var k = w.date.slice(0, 7) + '|' + AC_totKey(tot);
    var a = agg[k] = agg[k] || { work: 0, ot: 0, late: 0, early: 0, paid: 0, absent: 0, err: 0, open: 0 };
    var hol = (w.holidaysObtained && w.holidaysObtained.fulltimeHoliday && w.holidaysObtained.fulltimeHoliday.name) || '';
    if (Number(w.totalWork) > 0) a.work++;
    a.ot += (Number(w.overtime) || 0) + (Number(w.lateNightOvertime) || 0);
    if (Number(w.late) > 0) a.late++;
    if (Number(w.earlyLeave) > 0) a.early++;
    if (hol === '有休') a.paid++;
    if (hol === '欠勤') a.absent++;
    if (w.isError === true) a.err++;
    if (w.isClosing === false) a.open++;
  });
  var rows = Object.keys(agg).map(function (k) {
    var p = k.split('|'), a = agg[k], m = who[p[1]] || {};
    return [p[0], m.code || '', m.name || (nameByTot[p[1]] || '').trim() + '（マスタに無い）', p[1], a.work, Math.round(a.ot / 6) / 10,
      a.late, a.early, a.paid, a.absent, a.err, a.open, m.line ? '済' : ''];
  });
  rows.sort(function (x, y) { return (x[0] < y[0] ? 1 : x[0] > y[0] ? -1 : 0) || (y[10] - x[10]) || (y[9] - x[9]) || (y[5] - x[5]); });
  return rows;
}

/** 朝の案内のとき：今朝のTOT取り込み（さくらのVPS 7:05）が届いていなければ管理者へ知らせる */
function AC_checkTotSync_(props, today) {
  if (props.getProperty('TOT_RELAY_CHECK') === 'false') return;
  var last = AC_state_().getProperty('tot:lastRelay');
  if (!last || last === today) return;   // まだ一度も動いていない場合は知らせない
  AC_adminNotice_('totrelay', '【エラー】今朝のTOTの取り込みが届いていません🙇‍♀️（最後に届いた日：' + last + '）\n'
    + 'さくらのVPSが止まっていないか、コントロールパネルで「稼働中」になっているか確認してください。');
}

/**
 * 純粋関数：LINEの今月の送信数が上限のどこまで来たか（80・95・100％の段階、まだなら0）。
 * 上限なし（limit が無い）のときは0。
 */
function AC_quotaLevel(limit, used) {
  if (!(limit > 0)) return 0;
  var r = used / limit;
  return r >= 1 ? 100 : r >= 0.95 ? 95 : r >= 0.8 ? 80 : 0;
}

/** 朝の案内のとき：LINEの今月の送信数を確認し、80・95・100％に達したら管理者へ1回ずつ知らせる（読み取りのみ・無料） */
function AC_checkLineQuota_(today) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) return;
  var get = function (path) {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/' + path, {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw AC_error_('LINE送信数の確認失敗 HTTP ' + res.getResponseCode());
    return JSON.parse(res.getContentText());
  };
  var q = get('quota'), c = get('quota/consumption');
  var limit = q.type === 'limited' ? Number(q.value) : 0, used = Number(c.totalUsage) || 0;
  var level = AC_quotaLevel(limit, used);
  Logger.log('LINE送信数 %s / %s', used, limit || '上限なし');
  if (!level) return;
  var state = AC_state_(), key = 'quota:' + today.slice(0, 7) + ':' + level;
  if (state.getProperty(key)) return;
  var msg = level >= 100
    ? '【LINE送信数のお知らせ】今月のLINEの送信数が上限（' + limit + '通）に達しました🙇‍♀️\n今月はこれ以上お知らせが送れない状態です。LINE公式アカウントの管理画面で、プランの見直しをご検討ください。'
    : '【LINE送信数のお知らせ】今月のLINEの送信数が上限の' + level + '％に達しました（' + used + '／' + limit + '通）。\n'
      + '上限に達するとその月はお知らせが送れなくなりますので、必要に応じてプランの見直しをご検討ください。いつもありがとうございます！';
  AC_pushLine_(msg);
  state.setProperty(key, new Date().toISOString());
}

// ---------------- 内部処理 ----------------

/** 1回分の通知を実行する。同じ日・同じ種類は1回だけ。データ不備のときは誰にも送らず管理者へ知らせる。 */
function AC_dispatch_(kind) {
  var props = PropertiesService.getScriptProperties();
  var state = AC_state_();
  var dryRun = props.getProperty('DRY_RUN') !== 'false';
  var notifyPeople = props.getProperty('NOTIFY_EMPLOYEES') === 'true';
  var notifyAdmin = props.getProperty('NOTIFY_ADMIN') !== 'false';
  var today = AC_today_();
  var runKey = 'sent:' + today + ':' + kind;
  if (state.getProperty(runKey)) { Logger.log('実行済みのため中止'); return; }
  AC_cleanupSentKeys_(state, today);

  var d;
  try {
    d = AC_loadDay_(today);
  } catch (e) {
    Logger.log('照合失敗：%s %s', e && e.code ? e.code : 'unknown', e && e.message ? e.message : '');
    if (!dryRun) {
      AC_pushLine_('【エラー】' + today + ' のアルコールチェックの確認がうまくできませんでした🙇‍♀️\nシフト表（2026-2028）やフォームの回答シートに変わったところがないか、見ていただけますか？（'
        + (e && e.code ? e.code : '不明なエラー') + '）');
      state.setProperty(runKey, new Date().toISOString());
    }
    return;
  }
  var weather = (kind === 'morning' || kind === 'followBefore' || kind === 'evening') ? AC_weatherToday_(today) : null;
  var infection = AC_infection_(today);   // 継続記録の感謝など天気以外の通知で使う
  var overrides = AC_templateOverrides_();
  if (kind === 'morning' && !dryRun) { try { AC_checkTotSync_(props, today); } catch (e) { Logger.log('TOT確認の失敗'); } }
  if (kind === 'morning' && !dryRun) { try { AC_checkLineQuota_(today); } catch (e) { Logger.log('LINE送信数の確認に失敗'); } }
  if (kind === 'morning') { try { AC_refreshFormChoices_(); } catch (e) { Logger.log('フォームの選択肢の更新に失敗'); } }
  var paused = AC_pausedNames(AC_masterSheet_().getDataRange().getValues(), AC_pauseIndex_(), today);   // お休み中の人には送らない
  var people = AC_recipientsFor(kind, d).filter(function (n) { return !paused[AC_normalizeName(n)]; });
  var thanks = (kind === 'followAfter' ? AC_thanksTargets(d) : []).filter(function (t) { return !paused[AC_normalizeName(t.name)]; });
  state.setProperty('stat:' + today + ':' + kind, String(people.length + thanks.length));
  Logger.log('%s %s：対象 %s人／感謝 %s人（全員登録済みなら %s通）', today, kind, people.length, thanks.length,
    people.length + thanks.length);
  AC_checkAlerts_(props, d, dryRun);
  if (dryRun) { Logger.log('DRY_RUNのため送信しません'); return; }

  var registry = notifyPeople ? AC_loadRegistry_() : {};
  var tests = AC_testNames_(props, today);
  var sent = 0, unregistered = [], failed = [];
  var deliver = function (name, text, tag) {
    var key = AC_normalizeName(name);
    var test = tests[key], reg = registry[key];
    var who = test ? 'test:' + test.code : reg ? reg.code : key;
    var dedupe = 'sent:' + today + ':' + tag + ':' + who;
    if (state.getProperty(dedupe)) return;
    var careKey = 'att:' + today + ':care:' + (test ? test.code : reg ? reg.code : key);
    if (typeof text === 'function') text = text(!!state.getProperty(careKey)).text;
    try {
      if (test) AC_pushLine_('【テスト／' + test.name + 'さん宛て】\n' + text);
      else if (reg) AC_pushTo_(reg.userId, text);
      else { unregistered.push(name); return; }
      state.setProperty(dedupe, new Date().toISOString());
      state.setProperty(careKey, '1');   // この人への今日の最初のLINEを送った
      sent++;
    } catch (e) { failed.push(name); }
  };
  people.forEach(function (name) {
    deliver(name, function (careUsed) { return AC_composeMessage(kind, today, { weather: weather, careUsed: careUsed }, overrides); }, kind);
  });
  thanks.forEach(function (t) {
    var reg = registry[AC_normalizeName(t.name)], infKey = 'infLast:' + (reg ? reg.code : AC_normalizeName(t.name));
    var last = state.getProperty(infKey), used = !!last && last > AC_addDays_(today, -7);
    deliver(t.name, function (careUsed) {
      var c = { infection: infection, infectionUsed: used, careUsed: careUsed };
      if (infection && !used && !careUsed) state.setProperty(infKey, today);
      return { text: AC_thanksMessage(t.streak, today, overrides, c) };
    }, 'thanks');
  });
  // テスト対象が今日の対象外（休み・実施済み）でも、動作確認のため状況を管理者へ知らせる
  Object.keys(tests).forEach(function (k) {
    var t = tests[k];
    if (people.some(function (n) { return AC_normalizeName(n) === k; })) return;
    var key = 'sent:' + today + ':' + kind + ':testinfo:' + t.code;
    if (state.getProperty(key)) return;
    AC_pushLine_('【テスト／' + t.name + 'さん】' + AC_kindLabel(kind) + '：' + AC_notTargetReason(kind, d, t.name));
    state.setProperty(key, new Date().toISOString());
  });
  if (notifyAdmin && (kind === 'followBefore' || kind === 'followAfter')) {
    var r = kind === 'followBefore' ? d.before : d.after;
    var plan = AC_planNotifications(r.missing, registry);
    var adminMsg = AC_buildMessage(today, kind === 'followBefore' ? '出勤前' : '退勤前', r, plan, failed);
    if (adminMsg) AC_pushLine_(adminMsg);
  }
  Logger.log('送信 %s通／LINE未登録 %s人／失敗 %s人', sent, unregistered.length, failed.length);
  state.setProperty(runKey, new Date().toISOString());
}

/** 今日のシフト・回答を読み、出勤前・退勤前の照合結果と連続記録の計算に必要なデータをまとめる */
function AC_loadDay_(today) {
  var ss = SpreadsheetApp.openById(AC_SPREADSHEET_ID);
  var schedule = ss.getSheetByName(AC_SHEET_SCHEDULE);
  var form = ss.getSheetByName(AC_SHEET_FORM);
  if (!schedule || !form) throw AC_error_('シートが見つかりません');
  var sv = schedule.getDataRange().getValues();
  var fv = form.getDataRange().getValues();
  var toDate = AC_toDateFn_();
  return AC_buildDay({ today: today, sv: sv, fv: fv, toDate: toDate });
}

function AC_toDateFn_() {
  return function (v) {
    return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)
      ? Utilities.formatDate(v, AC_TZ, 'yyyy-MM-dd') : null;
  };
}

/** 純粋関数：1日分の照合データ */
function AC_buildDay(input) {
  var base = { today: input.today, scheduleValues: input.sv, formValues: input.fv, toDate: input.toDate };
  var before = AC_reconcile(AC_assign_(base, { checkLabel: '出勤前' }));
  var after = AC_reconcile(AC_assign_(base, { checkLabel: '退勤前' }));
  return { today: input.today, sv: input.sv, fv: input.fv, toDate: input.toDate, before: before, after: after };
}

function AC_assign_(a, b) { var o = {}; [a, b].forEach(function (x) { for (var k in x) o[k] = x[k]; }); return o; }

/** 純粋関数：通知の種類ごとの宛先（氏名） */
function AC_recipientsFor(kind, d) {
  if (kind === 'morning' || kind === 'evening') return d.before.targets.slice();
  if (kind === 'followBefore') return d.before.missing.slice();
  if (kind === 'followAfter') return d.after.missing.slice();
  return [];
}

function AC_kindLabel(kind) {
  return { morning: '朝の案内', followBefore: '出勤前の入力確認', evening: '退勤前の案内',
    followAfter: '退勤前の入力確認' }[kind] || kind;
}

/** 純粋関数：テスト対象に今日送らなかった理由 */
function AC_notTargetReason(kind, d, name) {
  var k = AC_normalizeName(name);
  var working = d.before.targets.some(function (n) { return AC_normalizeName(n) === k; });
  if (!working) return '本日はシフトが「出勤」ではないため、送信なし';
  return '入力が確認できたため、送信なし';
}

/**
 * 純粋関数：連続記録（パーフェクト）。今日から過去へ、シフトが「出勤」の日をさかのぼり、
 * 出勤前・退勤前の両方の回答がある日を数える。1日でも欠けたらそこで止める（必ずリセット）。
 * 出勤でない日は数えず、飛ばす。今日の両方がそろっていなければ0。
 */
function AC_streak(d, name) {
  var sv = d.sv, toDate = d.toDate, key = AC_normalizeName(name);
  var row = -1, current = '';
  for (var r = 2; r < sv.length; r++) {
    if (String(sv[r][1]).trim()) current = String(sv[r][1]).trim();
    if (String(sv[r][2]).trim() === 'シフト' && AC_normalizeName(current) === key) { row = r; break; }
  }
  if (row === -1) return 0;
  var done = {};
  for (var i = 1; i < d.fv.length; i++) {
    var day = toDate(d.fv[i][0]);
    if (!day || AC_normalizeName(d.fv[i][1]) !== key) continue;
    var label = String(d.fv[i][2]).trim();
    done[day] = done[day] || {};
    done[day][label] = true;
  }
  var cols = [];
  for (var c = 3; c < sv[1].length; c++) {
    var day2 = toDate(sv[1][c]);
    if (day2 && day2 <= d.today) cols.push({ c: c, day: day2 });
  }
  cols.sort(function (a, b) { return a.day < b.day ? 1 : -1; });
  var n = 0;
  for (var j = 0; j < cols.length; j++) {
    if (String(sv[row][cols[j].c]).trim() !== '出勤') continue;
    var x = done[cols[j].day] || {};
    if (x['出勤前'] && x['退勤前']) n++; else break;
  }
  return n;
}

/** 純粋関数：感謝を伝える節目（5・10・20・30・40・50日、以降10日ごと） */
function AC_isMilestone(n) {
  return n === 5 || (n >= 10 && n % 10 === 0);
}

/** 純粋関数：今日の感謝メッセージの対象（今日の出勤前・退勤前がそろい、連続日数が節目の人） */
function AC_thanksTargets(d) {
  var doneAfter = {};
  d.after.targets.forEach(function (n) { doneAfter[AC_normalizeName(n)] = true; });
  d.after.missing.forEach(function (n) { delete doneAfter[AC_normalizeName(n)]; });
  return d.before.targets.filter(function (n) {
    var k = AC_normalizeName(n);
    return doneAfter[k] && d.before.missing.every(function (m) { return AC_normalizeName(m) !== k; });
  }).map(function (n) { return { name: n, streak: AC_streak(d, n) }; })
    .filter(function (t) { return AC_isMilestone(t.streak); });
}

/** テストモード：TEST_CODES の人の「氏名 → {code, name}」（期限 TEST_UNTIL まで） */
function AC_testNames_(props, today) {
  var codes = String(props.getProperty('TEST_CODES') || '').split(',')
    .map(function (c) { return c.trim(); }).filter(function (c) { return /^\d{4,6}$/.test(c); });
  var until = props.getProperty('TEST_UNTIL');
  var out = {};
  if (!codes.length || (until && today > until)) return out;
  var master = AC_masterSheet_().getDataRange().getValues();
  codes.forEach(function (code) {
    var names = AC_namesForCode(master, code);
    names.forEach(function (n) { out[AC_normalizeName(n)] = { code: code, name: names[0] }; });
  });
  return out;
}

/** 純粋関数：従業員マスタから社員番号の氏名と別表記を返す */
function AC_namesForCode(masterValues, code) {
  for (var i = 1; i < (masterValues || []).length; i++) {
    var row = masterValues[i];
    if (AC_cellCode_(row[AC_COL.code]) === code) {
      return [row[AC_COL.name], row[AC_COL.alias]].filter(function (n) { return String(n || '').trim(); });
    }
  }
  return [];
}

/** 10分ごと：当日の回答に要確認の測定結果がないかを見て、管理者へ知らせる */
function alcoholCheckAlerts() {
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    AC_checkAlerts_(props, AC_loadDay_(AC_today_()), props.getProperty('DRY_RUN') !== 'false');
  } catch (e) {
    Logger.log('検知確認の失敗：%s', e && e.message ? e.message : e);
    AC_adminNotice_('alerts', '【エラー】飲酒検知の確認がうまくできませんでした🙇‍♀️\n管理シートが開けるか、見出しが変わっていないかを確認してください。\n（' + (e && e.message ? e.message : '不明なエラー') + '）');
  } finally { lock.releaseLock(); }
}

/**
 * アルコール検知の可能性がある回答を管理者へ知らせる（本人通知とは別）。
 * 測定結果が ALERT_THRESHOLD（mg/L、既定 0.14）以下と読めない当日の回答を、1件につき1回だけ知らせる。
 * NORMAL_RESULTS（カンマ区切り）に書いた値は、そのまま正常として扱う。
 */
function AC_checkAlerts_(props, d, dryRun) {
  var normal = String(props.getProperty('NORMAL_RESULTS') || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);
  var state = AC_state_();
  var th = parseFloat(props.getProperty('ALERT_THRESHOLD') || '0.14');
  if (isNaN(th)) th = 0.14;
  var hits = AC_findAlerts(d, normal, th);
  hits.forEach(function (h) {
    var key = 'sent:' + d.today + ':alert:' + h.row;
    if (state.getProperty(key)) return;
    Logger.log('要確認の測定結果：%s行目', h.row);
    if (dryRun) return;
    var time = Utilities.formatDate(h.at, AC_TZ, 'HH:mm');
    AC_pushLine_(AC_render('alcoholAlert', d.today, { time: time, name: h.name, label: h.label, result: h.result }, AC_templateOverrides_()));
    state.setProperty(key, new Date().toISOString());
  });
}

/**
 * 純粋関数：測定結果が正常（しきい値以下）と読めるか。
 * 「0.14mg/L以下」「0.00」「0.05mg/L」などは正常。「0.15mg/L以上」、しきい値を超える数値、
 * 数値が読めない回答は正常としない（管理者が確認する）。
 */
function AC_isNormalResult(result, threshold) {
  var s = String(result == null ? '' : result).replace(/[０-９．]/g, function (c) {
    return c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }).replace(/\s/g, '');
  var m = /(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return false;
  var n = parseFloat(m[1]);
  if (/以上|超/.test(s)) return false;
  return n <= threshold + 1e-9;
}

/** 純粋関数：当日の回答のうち、測定結果が正常と読めないもの */
function AC_findAlerts(d, normal, threshold) {
  var out = [];
  if (threshold == null) threshold = 0.14;
  for (var i = 1; i < d.fv.length; i++) {
    var row = d.fv[i];
    if (d.toDate(row[0]) !== d.today) continue;
    var result = String(row[3] == null ? '' : row[3]).trim();
    if (!result || (normal || []).indexOf(result) !== -1 || AC_isNormalResult(result, threshold)) continue;
    out.push({ row: i + 1, name: String(row[1]).trim(), label: String(row[2]).trim(), result: result, at: row[0] });
  }
  return out;
}

/**
 * 送信記録（sent:）・通数記録（stat:）の保存先。設定（スクリプトプロパティ）とは分け、
 * 所有者のユーザープロパティに置く（設定画面は50件までしか表示・追加できないため）。
 * 以前スクリプトプロパティに保存した記録は、初回に移して消す。
 */
function AC_state_() {
  var state = PropertiesService.getUserProperties();
  var sp = PropertiesService.getScriptProperties();
  var all = sp.getProperties(), moved = {};
  Object.keys(all).forEach(function (k) { if (/^(sent|stat):/.test(k)) moved[k] = all[k]; });
  var keys = Object.keys(moved);
  if (keys.length) {
    state.setProperties(moved);
    keys.forEach(function (k) { sp.deleteProperty(k); });
  }
  return state;
}

/** 8日より前の送信記録・40日より前の通数記録を消す */
function AC_cleanupSentKeys_(props, today) {
  var day = function (n) { return Utilities.formatDate(new Date(Date.now() - n * 86400000), AC_TZ, 'yyyy-MM-dd'); };
  var sentLimit = day(8), statLimit = day(40);
  Object.keys(props.getProperties()).forEach(function (k) {
    var m = /^(sent|stat|att):(\d{4}-\d{2}(?:-\d{2})?):/.exec(k);
    if (m && m[2] < (m[1] === 'sent' ? sentLimit : statLimit)) props.deleteProperty(k);
  });
}

/** 手動確認用：直近の日ごとの見込み通数（全員がLINE登録済みだった場合） */
function alcoholCheckUsage() {
  var all = AC_state_().getProperties();
  var byDay = {};
  Object.keys(all).forEach(function (k) {
    var m = /^stat:(\d{4}-\d{2}-\d{2}):(\w+)$/.exec(k);
    if (m) byDay[m[1]] = (byDay[m[1]] || 0) + Number(all[k] || 0);
  });
  var days = Object.keys(byDay).sort();
  var total = days.reduce(function (a, k) { return a + byDay[k]; }, 0);
  Logger.log('日ごとの見込み通数 %s／平均 %s通/日（30日換算 約%s通）', JSON.stringify(byDay),
    days.length ? Math.round(total / days.length) : 0, days.length ? Math.round(total / days.length * 30) : 0);
}

// ---------------- 文面 ----------------

/** 気象庁の予報（埼玉県南部・さいたま）から今日の天気区分を返す。取得できなければnull。 */
function AC_fetchWeather_(today) {
  try {
    var res = UrlFetchApp.fetch('https://www.jma.go.jp/bosai/forecast/data/forecast/110000.json',
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    return AC_weatherFromJma(JSON.parse(res.getContentText()), today);
  } catch (e) {
    Logger.log('天気の取得に失敗：%s', e && e.message ? e.message : '');
    return null;
  }
}

/**
 * 純粋関数：気象庁JSONから今日の { kind, text, max, min } を作る。
 * kind：rain（雨・雪）／hot（最高30℃以上）／cold（最低5℃以下または最高12℃以下）／sunny（晴れ）／cloudy（その他）
 */
function AC_weatherFromJma(json, today) {
  var f = json && json[0];
  if (!f || !f.timeSeries) return null;
  var area = function (ts, code) {
    return ts && (ts.areas || []).filter(function (a) { return a.area && a.area.code === code; })[0];
  };
  var w = f.timeSeries[0], wa = area(w, '110010');
  if (!wa) return null;
  var idx = -1;
  (w.timeDefines || []).forEach(function (t, i) { if (idx === -1 && String(t).slice(0, 10) === today) idx = i; });
  if (idx === -1) idx = 0;
  var code = String((wa.weatherCodes || [])[idx] || '');
  var text = String((wa.weathers || [])[idx] || '').replace(/\s+/g, ' ');
  var pops = [], p = f.timeSeries[1], pa = area(p, '110010');
  if (pa) (p.timeDefines || []).forEach(function (t, i) {
    if (String(t).slice(0, 10) === today && pa.pops[i] !== '') pops.push(Number(pa.pops[i]));
  });
  var temps = [], tt = f.timeSeries[2], ta = area(tt, '43241');
  if (ta) (tt.timeDefines || []).forEach(function (t, i) {
    if (String(t).slice(0, 10) === today && ta.temps[i] !== '') temps.push(Number(ta.temps[i]));
  });
  var max = temps.length ? Math.max.apply(null, temps) : null;
  var min = temps.length > 1 ? Math.min.apply(null, temps) : null;
  var pop = pops.length ? Math.max.apply(null, pops) : 0;
  var kind = 'cloudy';
  if (/^[34]/.test(code) || /雨|雪/.test(text.split(' ')[0]) || pop >= 50) kind = 'rain';
  else if (max !== null && max >= 30) kind = 'hot';
  else if ((min !== null && min <= 5) || (max !== null && max <= 12)) kind = 'cold';
  else if (/^1/.test(code)) kind = 'sunny';
  var winds = String((wa.winds || [])[idx] || '');
  return { kind: kind, text: text, max: max, min: min,
    snow: /^4/.test(code) || /雪/.test(text.split(' ')[0]),
    wind: /強く|非常に強く/.test(winds) || /強風/.test(text),
    freeze: min !== null && min <= 0,
    swing: max !== null && min !== null && max - min >= 10 };
}

/** 純粋関数：日付から文面の言い回しを選ぶ（毎日同じ文にならないように） */
function AC_pick(list, today) {
  var n = Number(String(today).replace(/-/g, '')) || 0;
  return list[n % list.length];
}

// ---------------- LINE文面（REBIRTH管理本部の標準ルール） ----------------
// 「丁寧で親しみやすく、相手への気遣いが自然に伝わる文章」。事務的すぎず、馴れ馴れしすぎず。
// 文面は「固定テンプレート＋気遣いの一文（{care}）」で作る。AIは使わない（費用ゼロ）。
// 管理本部が従業員マスタのファイルの「LINE文面」シートで文面を直せる（空欄なら下の既定文）。
// 1つの欄に「||」で区切って複数書くと、日替わりで使い分ける。
// 差し込み：{care} 気遣いの一文／{date} 日付／{hours} 時間／{n} 日数／{code} 社員番号／{name} 氏名
var AC_TEMPLATES = {
  morning: ['おはようございます！{icon}\n\n{care}\n\n本日も運転前のアルコールチェックと、フォームへの入力をお願いいたします！\nいつもご協力いただき、本当にありがとうございます。今日も一日、よろしくお願いします😊',
    'おはようございます！{icon}\n\n{care}\n\n運転前のアルコールチェックと、フォームへの入力を本日もよろしくお願いいたします！\n毎日のご協力、とても助かっています。ありがとうございます😊'],
  followBefore: ['おはようございます！\n\n{care}\n\n本日の出勤前アルコールチェックについて、フォームへの入力が確認できておりませんでした。\n\n'
    + 'すでに実施済みの場合は、お手数ですが入力をお願いいたします。\n'
    + 'まだ実施していない場合は、これから運転する前に必ず実施をお願いいたします🚗 次回以降も、運転前の実施をよろしくお願いいたします。\n\n'
    + 'いつもご協力ありがとうございます！引き続きよろしくお願いいたします。'],
  evening: ['お疲れ様です！\n本日も一日、本当にありがとうございました😊\n\n退勤前のアルコールチェックと、フォームへの入力をお願いいたします。\n\n{care}'],
  followAfter: ['お疲れ様です！\n\n本日の退勤前アルコールチェックについて、フォームへの入力が確認できておりませんでした。\n\n'
    + 'すでに実施済みの場合は、お手数ですが入力をお願いいたします。\n'
    + 'まだ実施していない場合は、運転する前に必ず実施をお願いいたします🚗 次回以降も、運転前の実施をよろしくお願いいたします。\n\n'
    + '{care}\n本日もお仕事お疲れ様でした！いつも本当にありがとうございます。'],
  punch: ['お疲れ様です！\n{care}\n\n勤怠を確認したところ、{date}の打刻が確認できませんでした。\nお手数ですが、TOTでご確認のうえ、必要な修正の申請をお願いいたします。\n\nいつもご協力いただき、ありがとうございます😊',
    'お疲れ様です！\n{care}\n\n勤怠を確認したところ、{date}の打刻が確認できませんでした。\nお忙しいところ恐れ入りますが、TOTでご確認のうえ、必要な修正の申請をお願いいたします。\n\nいつも丁寧にご対応いただき、ありがとうございます😊'],
  todayNoClockOut: ['お疲れ様です！\n{care}\n\n本日の退勤の打刻が、まだ確認できていませんでした。\n\n'
    + '現在も勤務中の場合は、退勤の打刻を忘れずにお願いいたします。遅くまでお疲れ様です！本当にありがとうございます！\n\n'
    + 'すでに退勤されている場合は、お手数ですがTOTから退勤時刻の修正の申請をお願いいたします。\n\n今日も一日ありがとうございました😊'],
  todayNoClockIn: ['お疲れ様です！\n{care}\n\n本日は出勤の予定でしたが、出勤の打刻が確認できませんでした。\n\n'
    + '出勤されていた場合は、お手数ですがTOTから打刻の修正の申請をお願いいたします。\n'
    + 'お休みに変わっていた場合は、上長にご確認のうえ、勤怠連絡フォームでのご連絡をお願いいたします。\n' + AC_FORM_URL + '\n\nいつもご協力いただき、ありがとうございます😊'],
  ot30: ['お疲れ様です！\nいつも業務へのご協力、本当にありがとうございます。とても助かっています。\n\n今月の残業時間が30時間に達しましたので、ご連絡いたしました（現在 {hours}時間）。\n'
    + 'お忙しい時期かと思いますが、勤務時間や体調にもお気をつけいただければと思います。\n{care}\n\nいつもありがとうございます。引き続きよろしくお願いいたします。'],
  ot45: ['お疲れ様です！\nいつも業務にご対応いただき、本当にありがとうございます。\n\n今月の残業時間が45時間に達しましたので、ご連絡いたしました（現在 {hours}時間）。\n'
    + '勤務時間が長くなっておりますので、今後の業務量や勤務時間について、上長とご相談をお願いいたします。\n{care}\n\nお忙しいところ恐れ入りますが、よろしくお願いいたします。いつもありがとうございます。'],
  ot45Admin: ['【残業45時間到達のお知らせ】\n{name}さん（社員番号 {code}）の今月の残業時間が45時間に達しました（現在 {hours}時間）。\n'
    + '36協定の管理のため、勤務状況の確認と、上長による業務量の調整をお願いいたします。\n（ご本人にも、上長へ相談するようご案内しています）'],
  thanks5: ['お疲れ様です！\n\nアルコールチェックについて、5勤務日連続でのご対応ありがとうございます！😊\n毎日忘れずに入力していただけて、とても助かっています。本当にありがとうございます。\n{care}\n\n引き続きご協力よろしくお願いいたします！'],
  thanks10: ['お疲れ様です！\n\nアルコールチェック、10勤務日連続でのご対応ありがとうございます！✨\n日々の業務でお忙しい中、継続してご対応いただき、本当にありがとうございます。いつも頼りにしています。\n{care}\n\n引き続きよろしくお願いいたします！'],
  thanksN: ['お疲れ様です！\n\nアルコールチェック、{n}勤務日連続でのご対応ありがとうございます！✨\n毎日の積み重ねに、心から感謝しています。いつも本当にありがとうございます。\n{care}\n\n引き続きよろしくお願いいたします！'],
  follow: ['友だち追加ありがとうございます！\nREBIRTH 管理本部です😊\n\nお知らせをお届けするため、社員番号（数字のみ）を送っていただけますでしょうか。\nご協力ありがとうございます。'],
  registered: ['社員番号 {code} で受け付けました。ご対応いただき、ありがとうございます😊\n管理本部で確認が済み次第、お知らせが届くようになります。'],
  registeredSame: ['社員番号 {code} は登録済みです。ご丁寧にありがとうございます😊'],
  registeredCheck: ['社員番号 {code} で受け付けました。ご対応いただき、ありがとうございます😊\n念のため管理本部で確認いたしますので、確認が済み次第、お知らせが届くようになります。'],
  alcoholAlert: ['【アルコール検知のお知らせ】\nアルコールチェックにて、アルコールが検知されました。\n\n{time} {name}さん（{label}）\n測定結果：{result}\n\n'
    + '該当従業員の運転を開始・継続させず、測定結果および状況の確認をお願いいたします。\n速やかなご対応をお願いいたします。'],
};

/**
 * 気遣いの一文。
 *  ・アルコールチェックの通知：天気を優先（安全に関わる天候 → 気温 → ふだんの天気）。天気が取れない日は天気に触れない。
 *  ・それ以外の通知（打刻漏れ・残業・継続記録など）：天気には触れず、感染症の流行 → 季節（暦）→ 日頃の感謝。
 */
var AC_CARE = {
  // 朝の案内
  snow: ['路面が滑りやすくなる可能性がありますので、運転の際は十分お気をつけください。', '雪や路面の凍結が心配な予報です。運転の際は十分お気をつけください。'],
  rain: ['今日は雨の予報です☔\n路面が滑りやすくなりますので、車両移動の際はお気をつけください。', '今日は雨が降りそうです☔\n視界や路面に注意して、移動の際はお気をつけください。'],
  wind: ['風が強い予報ですので、車のドアの開閉などにもお気をつけください。'],
  hot: ['今日は気温が高くなる予報です。こまめな水分補給をお願いいたします。', '今日は暑くなりそうです。こまめな水分補給と休憩をお願いいたします。'],
  cold: ['今日は朝から冷え込んでいますね。\n寒い中、いつもお仕事ありがとうございます！暖かくしてお過ごしください。', '今日は冷え込む予報です。\n寒い中、いつもお仕事ありがとうございます！暖かくしてお過ごしください。'],
  swing: ['朝晩と日中で気温差があるようです。体調管理にお気をつけください。'],
  sunny: ['今日は天気が良さそうですね！', '今日は晴れの予報です。気持ちよく過ごせそうですね！'],
  cloudy: ['今日はくもりの予報です。', '今日は雲の多い一日になりそうです。'],
  // 出勤前の入力確認（短く）
  beforeSnow: ['雪や凍結で路面が滑りやすくなっていますので、運転の際は十分お気をつけください。'],
  beforeRain: ['雨で路面が滑りやすくなっていますので、移動の際はお気をつけください。'],
  beforeWind: ['風が強い予報ですので、車のドアの開閉などにもお気をつけください。'],
  beforeHot: ['気温が上がる予報ですので、こまめな水分補給をお願いいたします。'],
  beforeCold: ['冷え込む中、いつもお仕事ありがとうございます。'],
  beforeSwing: ['気温差が大きい一日のようです。体調にお気をつけください。'],
  // 退勤前（案内・入力確認）
  eveningSnow: ['帰り道は路面が凍結するおそれがありますので、運転には十分お気をつけください。'],
  eveningRain: ['雨で路面が滑りやすくなっていますので、帰り道もお気をつけください。'],
  eveningWind: ['夕方も風が強い予報ですので、お気をつけください。'],
  eveningHot: ['暑い中、本日も一日ありがとうございました。水分補給もお忘れなく。'],
  eveningCold: ['夜は冷え込みますので、暖かくしてお帰りください。'],
  eveningSwing: ['朝晩は冷えますので、体調にお気をつけください。'],
  eveningDefault: ['お帰りの際も、安全運転でお気をつけください！'],
  // 天気以外（打刻漏れ・残業・継続記録など）
  infection: ['{infection}が流行しているようですので、体調管理にもお気をつけください。'],
  season12: ['年末に向けてお忙しい中、いつもありがとうございます。'],
  season1: ['本年もどうぞよろしくお願いいたします。'],
  season3: ['年度末でお忙しい時期かと思いますが、いつもありがとうございます。'],
  season4: ['新年度もどうぞよろしくお願いいたします。'],
  seasonChange: ['季節の変わり目ですので、体調を崩されませんようお気をつけください。'],
  thanks: ['いつもお仕事ありがとうございます。', 'いつも業務へのご協力ありがとうございます。', '毎日のお仕事、本当にありがとうございます。', 'いつも頼りにしています。ありがとうございます。'],
};

var AC_ALCOHOL_KINDS = { morning: 1, followBefore: 1, evening: 1, followAfter: 1 };

/**
 * 純粋関数：その日の気遣いの一文を選ぶ。
 * purpose：morning / followBefore / evening / followAfter（天気）、punch / ot30 / ot45 / thanks（天気以外）
 * ctx：{ weather, infection（感染症名）, infectionUsed（7日以内に案内済みか） }
 * 戻り値：{ text, usedWeather, usedInfection }
 */
function AC_careLine(purpose, today, ctx, overrides) {
  ctx = ctx || {};
  var w = ctx.weather, pick = function (k, vars) { return AC_pickTpl_(k, today, overrides, AC_CARE, vars); };
  var res = function (text, uw, ui) { return { text: text, usedWeather: !!uw, usedInfection: !!ui }; };
  if (ctx.careUsed) return res(purpose === 'evening' ? pick('eveningDefault') : '');   // 気遣いは1日の最初のLINEだけ
  if (AC_ALCOHOL_KINDS[purpose]) {
    var pre = purpose === 'morning' ? '' : purpose === 'followBefore' ? 'before' : 'evening';
    var key = function (k) { return pre ? pre + k.charAt(0).toUpperCase() + k.slice(1) : k; };
    if (w) {
      if (w.snow || w.freeze) return res(pick(key('snow')), true);
      if (w.kind === 'rain') return res(pick(key('rain')), true);
      if (w.wind) return res(pick(key('wind')), true);
      if (w.kind === 'hot') return res(pick(key('hot')), true);
      if (w.kind === 'cold') return res(pick(key('cold')), true);
      if (w.swing) return res(pick(key('swing')), true);
      if (purpose === 'morning' && w.kind === 'sunny') return res(pick('sunny'), true);
      if (purpose === 'morning' && w.kind === 'cloudy') return res(pick('cloudy') + '\n' + pick('thanks'), true);
    }
    if (purpose === 'evening') return res(pick('eveningDefault'));
    return res(purpose === 'morning' ? pick('thanks') : '');
  }
  // 天気以外の気遣い
  if (ctx.infection && !ctx.infectionUsed) return res(pick('infection', { infection: ctx.infection }), false, true);
  if (purpose === 'ot45') return res('');   // 重要な通知は用件をはっきり。追加の一文は感染症のときだけ
  var m = Number(String(today).slice(5, 7)), d = Number(String(today).slice(8, 10));
  if (m === 12) return res(pick('season12'));
  if (m === 1 && d <= 15) return res(pick('season1'));
  if (m === 3) return res(pick('season3'));
  if (m === 4 && d <= 15) return res(pick('season4'));
  if (m === 10 || m === 11 || m === 5) return res(pick('seasonChange'));
  return res(/^(punch|todayNoClockOut|todayNoClockIn)$/.test(purpose) ? pick('thanks') : '');
}

/** 純粋関数：テンプレートを選んで差し込む（{care} が空なら、その行ごと詰める） */
function AC_render(key, today, vars, overrides) {
  var text = AC_pickTpl_(key, today, overrides, AC_TEMPLATES, vars);
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function AC_pickTpl_(key, today, overrides, base, vars) {
  var list = (overrides && overrides[key] && overrides[key].length) ? overrides[key] : base[key] || [''];
  var t = AC_pick(list, today);
  vars = vars || {};
  return String(t).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] == null ? '' : String(vars[k]); });
}

/** 純粋関数：通知の種類ごとの本人向け文面（従来の呼び出し口） */
function AC_messageFor(kind, today, weather, ctx, overrides) {
  return AC_composeMessage(kind, today, AC_assign_(ctx || {}, { weather: weather }), overrides).text;
}

/** 純粋関数：文面と、天気・感染症の話をしたか */
function AC_composeMessage(kind, today, ctx, overrides) {
  ctx = ctx || {};
  var care = AC_careLine(kind, today, ctx, overrides);
  var icon = '';
  if (kind === 'morning' && care.usedWeather && ctx.weather) {
    icon = { rain: '☔', hot: '☀️', cold: '❄️', sunny: '☀️', cloudy: '🌤' }[ctx.weather.kind] || '';
    if (ctx.weather.snow) icon = '❄️';
  }
  var temp = kind === 'morning' && care.usedWeather && ctx.weather && ctx.weather.max !== null && ctx.weather.max !== undefined
    ? '（さいたま 最高' + ctx.weather.max + '℃' + (ctx.weather.min !== null && ctx.weather.min !== undefined ? '／最低' + ctx.weather.min + '℃' : '') + '）' : '';
  var careText = care.text;
  if (temp) { var cl = careText.split('\n'); cl[0] = cl[0] + temp; careText = cl.join('\n'); }   // 気温は1行目の後ろに
  var text = AC_render(kind, today, { care: careText, icon: icon }, overrides);
  return { text: text, usedWeather: care.usedWeather, usedInfection: care.usedInfection };
}

/** 朝の案内（天気に合わせた一言。天気が取れないときは天気に触れない） */
function AC_morningMessage(today, weather, overrides) { return AC_messageFor('morning', today, weather, {}, overrides); }

/** 連続記録の感謝（評価ではなく感謝を伝える。天気以外の気遣い） */
function AC_thanksMessage(n, today, overrides, ctx) {
  var key = n === 5 ? 'thanks5' : n === 10 ? 'thanks10' : 'thanksN';
  return AC_render(key, today || '', { n: n, care: AC_careLine('thanks', today || '', ctx, overrides).text }, overrides);
}

/** 打刻漏れ（天気以外の気遣い）。today は送る日（省略時は対象日） */
function AC_punchMessage(date, ctx, overrides, today) {
  var w = '日月火水木金土'.charAt(new Date(date + 'T00:00:00+09:00').getDay());
  var care = AC_careLine('punch', today || date, ctx, overrides).text;
  return AC_render('punch', today || date, { care: care, date: Number(date.slice(5, 7)) + '/' + Number(date.slice(8, 10)) + '（' + w + '）' }, overrides);
}

function AC_overtimeMessage(min, level, today, overrides, ctx) {
  var h = (Math.floor(min / 6) / 10).toFixed(1);
  var key = level >= 45 ? 'ot45' : 'ot30';
  return AC_render(key, today || '', { hours: h, care: AC_careLine(key, today || '', ctx, overrides).text }, overrides);
}

/** 「LINE文面」シートの上書き（空欄は既定文）。無ければ既定文でシートを作る */
var AC_TPL_CACHE = null;
function AC_templateOverrides_() {
  if (AC_TPL_CACHE) return AC_TPL_CACHE;
  var out = {};
  try {
    var ss = AC_masterSheet_().getParent();
    var sh = ss.getSheetByName('LINE文面');
    if (!sh) {
      sh = ss.insertSheet('LINE文面');
      var rows = [['キー', '種類', '文面（||で区切ると日替わり。{care}などは自動で差し込み）']];
      Object.keys(AC_TEMPLATES).forEach(function (k) { rows.push([k, 'テンプレート', '']); });
      Object.keys(AC_CARE).forEach(function (k) { rows.push([k, '気遣いの一文', '']); });
      sh.getRange(1, 1, rows.length, 3).setValues(rows);
      sh.getRange(1, 1, 1, 3).setFontWeight('bold');
      sh.setFrozenRows(1);
      sh.getRange(2, 4, rows.length - 1, 1).setValues(rows.slice(1).map(function (r) {
        return [(AC_TEMPLATES[r[0]] || AC_CARE[r[0]] || []).join('||')];
      }));
      sh.getRange(1, 4).setValue('既定の文面（参考・変更しても反映されません）').setFontWeight('bold');
    }
    var have = {};
    sh.getDataRange().getValues().slice(1).forEach(function (r) { have[String(r[0]).trim()] = true; });
    var add = [];   // 後から増えたキーを追記（文面は空欄＝既定）
    Object.keys(AC_TEMPLATES).forEach(function (k) { if (!have[k]) add.push([k, 'テンプレート', '', AC_TEMPLATES[k].join('||')]); });
    Object.keys(AC_CARE).forEach(function (k) { if (!have[k]) add.push([k, '気遣いの一文', '', AC_CARE[k].join('||')]); });
    if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 4).setValues(add);
    sh.getDataRange().getValues().slice(1).forEach(function (r) {
      var v = String(r[2] || '').trim();
      if (r[0] && v) out[String(r[0]).trim()] = v.split('||').map(function (x) { return x.trim(); }).filter(Boolean);
    });
  } catch (e) { Logger.log('LINE文面シートの読み込みに失敗（既定文を使用）'); }
  AC_TPL_CACHE = out;
  return out;
}

/** 感染症の流行（管理本部が公的機関の発表を確認して設定：INFECTION_NAME と INFECTION_UNTIL）。期限切れ・未設定なら無し */
function AC_infection_(today) {
  var p = PropertiesService.getScriptProperties();
  var name = String(p.getProperty('INFECTION_NAME') || '').trim(), until = p.getProperty('INFECTION_UNTIL');
  if (!name || !until || today > until) return '';
  return name;
}

/** 今日の天気（1日1回だけ気象庁から取得して共通利用） */
function AC_weatherToday_(today) {
  var state = AC_state_(), key = 'att:' + today + ':weather';
  var cached = state.getProperty(key);
  if (cached) { try { return JSON.parse(cached); } catch (e) { /* 取り直す */ } }
  var w = AC_fetchWeather_(today);
  if (w) state.setProperty(key, JSON.stringify(w));
  return w;
}

function AC_today_() {
  return Utilities.formatDate(new Date(), AC_TZ, 'yyyy-MM-dd');
}

function AC_reconcileFromSheets_(today, type) {
  var ss = SpreadsheetApp.openById(AC_SPREADSHEET_ID);
  var schedule = ss.getSheetByName(AC_SHEET_SCHEDULE);
  var form = ss.getSheetByName(AC_SHEET_FORM);
  if (!schedule || !form) throw AC_error_('シートが見つかりません');
  var toDate = function (v) {
    return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)
      ? Utilities.formatDate(v, AC_TZ, 'yyyy-MM-dd') : null;
  };
  return AC_reconcile({
    today: today,
    checkLabel: AC_CHECK_LABELS[type],
    scheduleValues: schedule.getDataRange().getValues(),
    formValues: form.getDataRange().getValues(),
    toDate: toDate,
  });
}

function AC_error_(code) { var e = new Error(code); e.code = code; return e; }

/** 氏名の空白（半角・全角）の違いだけを吸収する。それ以上の推測はしない。 */
function AC_normalizeName(name) {
  return String(name == null ? '' : name).replace(/[\s　]+/g, '');
}

/**
 * 純粋関数（テスト対象）
 * scheduleValues: 「2026-2028」の全値。2行目(添字1)に日付、B列氏名、C列行区分、D列以降が各日。
 * formValues: 「フォームの回答 1」の全値。A列タイムスタンプ、B列氏名、C列チェック区分。
 */
function AC_reconcile(input) {
  var today = input.today, label = input.checkLabel, toDate = input.toDate;
  var sv = input.scheduleValues, fv = input.formValues;
  if (!sv || sv.length < 3) throw AC_error_('シフト表の行が不足しています');

  var col = -1;
  for (var c = 3; c < sv[1].length; c++) {
    if (toDate(sv[1][c]) === today) {
      if (col !== -1) throw AC_error_('当日の日付列が重複しています');
      col = c;
    }
  }
  if (col === -1) throw AC_error_('当日の日付列が見つかりません');

  var targets = [], seen = {}, currentName = '';
  for (var r = 2; r < sv.length; r++) {
    if (String(sv[r][1]).trim()) currentName = String(sv[r][1]).trim();
    if (String(sv[r][2]).trim() !== 'シフト') continue;
    if (String(sv[r][col]).trim() !== '出勤') continue;
    if (!currentName) throw AC_error_('氏名のない出勤行があります');
    var key = AC_normalizeName(currentName);
    if (seen[key]) throw AC_error_('同じ氏名が複数あります');
    seen[key] = true;
    targets.push(currentName);
  }

  var done = {};
  for (var i = 1; i < fv.length; i++) {
    if (toDate(fv[i][0]) !== today) continue;              // 前日などの回答は数えない
    if (String(fv[i][2]).trim() !== label) continue;      // 別区分の回答は数えない
    done[AC_normalizeName(fv[i][1])] = true;
  }
  var missing = targets.filter(function (n) { return !done[AC_normalizeName(n)]; });
  return { targets: targets, missing: missing };
}

/** 管理者向け一覧。plan・failed は省略可（本人通知を使わない場合）。 */
function AC_buildMessage(today, label, r, plan, failed) {
  if (r.targets.length === 0) {
    return '【アルコールチェック】' + today + ' ' + label
      + '：シフト表に本日の「出勤」がありません。入力漏れでないか確認してください。';
  }
  if (r.missing.length === 0) return null; // 全員実施済みなら送らない
  var mark = {};
  if (plan) {
    plan.send.forEach(function (p) { mark[p.name] = '（本人に通知）'; });
    if (plan.registryUsed) plan.unregistered.forEach(function (n) { mark[n] = '（LINE未登録）'; });
  }
  (failed || []).forEach(function (n) { mark[n] = '（本人通知に失敗）'; });
  return '【アルコールチェック】' + today + ' ' + label + ' 未実施（' + r.missing.length + '/'
    + r.targets.length + '人）\n' + r.missing.map(function (n) { return '・' + n + (mark[n] || ''); }).join('\n')
    + '\n※シフト表の「出勤」とフォーム回答を氏名で照合した結果です。';
}

/**
 * 純粋関数：未実施者の氏名一覧と登録表（氏名→{code,userId}）から、本人通知の対象と未登録者を分ける。
 * 登録表は管理者が「確認済み」にした行だけを使う（AC_buildRegistryで作る）。
 */
function AC_planNotifications(missingNames, registry) {
  var send = [], unregistered = [];
  missingNames.forEach(function (n) {
    var hit = registry[AC_normalizeName(n)];
    if (hit) send.push({ name: n, code: hit.code, userId: hit.userId });
    else unregistered.push(n);
  });
  return { send: send, unregistered: unregistered, registryUsed: Object.keys(registry).length > 0 };
}

/** 管理者へのお知らせ（エラーや確認のお願い）。同じ種類は1日1回まで */
function AC_adminNotice_(kind, text) {
  try {
    var state = AC_state_(), key = 'sent:' + AC_today_() + ':notice:' + kind;
    if (state.getProperty(key)) return;
    AC_pushLine_(text);
    state.setProperty(key, new Date().toISOString());
  } catch (e) { Logger.log('管理者へのお知らせに失敗'); }
}

function AC_pushLine_(text) {
  AC_pushTo_(PropertiesService.getScriptProperties().getProperty('LINE_ADMIN_USER_ID'), text);
}

function AC_pushTo_(to, text) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !to) throw AC_error_('LINEの設定がありません');
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, 'X-Line-Retry-Key': Utilities.getUuid() },
    payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    // 応答本文は記録しない（秘密情報を含む可能性があるため）
    throw AC_error_('LINE送信失敗 HTTP ' + res.getResponseCode());
  }
}

// ---------------- 従業員マスタとLINE登録（Webhook） ----------------
// 従業員マスタ：社員番号をキーに、氏名・在籍・所属・LINE ID・業務ごとの対象を1行で管理する（管理シートとは別ファイル）。
// 今後の他業務の自動化でも、このマスタを社員番号で参照する。
// 従業員が公式LINEに社員番号を送ると、マスタの該当行にLINE IDを記録する（返信はreplyで通数に数えない）。
// 社員番号以外の発言には反応しない（手動チャットを邪魔しない）。
// Apps ScriptのdoPostは署名検証ができないため、管理者が「LINE確認済み」にするまで通知に使わない。

var AC_MASTER_HEADER = ['社員番号', '氏名', '別表記（シフト表の書き方が違う場合）', '在籍状況', '所属・拠点',
  'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考',
  '社員区分', 'TOT従業員コード', '退職日'];
var AC_COL = { code: 0, name: 1, alias: 2, status: 3, dept: 4, userId: 5, lineName: 6, lineAt: 7,
  lineOk: 8, alcohol: 9, note: 10, category: 11, totCode: 12, retiredOn: 13 };

function doPost(e) {
  try {
    var body = JSON.parse(e && e.postData ? e.postData.contents : '{}');
    if (body.type === 'tot-raw') return ContentService.createTextOutput(AC_handleTotRaw_(body));
    (body.events || []).forEach(AC_handleEvent_);
  } catch (err) {
    Logger.log('Webhook処理エラー：%s', err && err.message ? err.message : '');
    AC_adminNotice_('webhook', '【エラー】公式LINEに届いたメッセージの処理で問題がありました🙇‍♀️\n（' + (err && err.message ? err.message : '不明なエラー') + '）');
  }
  return ContentService.createTextOutput('OK');
}

function AC_handleEvent_(ev) {
  var src = ev && ev.source;
  if (src && (src.type === 'group' || src.type === 'room')) { AC_handleGroupEvent_(ev); return; }
  if (!src || src.type !== 'user' || !AC_isUserId(src.userId)) return;   // 1対1のトークだけを扱う
  if (ev.type === 'follow') {
    AC_reply_(ev.replyToken, AC_render('follow', AC_today_(), {}, AC_templateOverrides_()));
    return;
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  var code = AC_parseEmployeeCode(ev.message.text);
  if (!code) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var result;
  try {
    var sheet = AC_masterSheet_();
    var values = sheet.getDataRange().getValues();
    var action = AC_planRegistration(values, code, src.userId);
    var displayName = AC_fetchDisplayName_(src.userId) || '（取得できませんでした）';
    var now = new Date();
    if (action.type === 'fill') {
      var row = action.row + 1;
      sheet.getRange(row, AC_COL.userId + 1, 1, 3).setValues([[src.userId, displayName, now]]);
      sheet.getRange(row, AC_COL.lineOk + 1).setValue(false);
    } else if (action.type === 'new') {
      var r = AC_MASTER_HEADER.map(function () { return ''; });
      r[AC_COL.code] = "'" + code; r[AC_COL.status] = '在籍';
      r[AC_COL.userId] = src.userId; r[AC_COL.lineName] = displayName; r[AC_COL.lineAt] = now;
      r[AC_COL.lineOk] = false; r[AC_COL.alcohol] = false;
      r[AC_COL.note] = 'LINE登録で追加。氏名を入力してください';
      sheet.appendRow(r);
      AC_checkboxes_(sheet, sheet.getLastRow(), 1);
    } else if (action.type === 'conflict') {
      // 既に別のLINE IDが登録されている社員番号：上書きせず、管理者確認用のシートに残す
      AC_reviewSheet_(sheet.getParent()).appendRow([now, "'" + code, src.userId, displayName, '既存のLINE IDと異なる']);
    }
    result = action.type;
  } finally {
    lock.releaseLock();
  }
  var ov = AC_templateOverrides_(), td = AC_today_();
  var replies = {
    fill: AC_render('registered', td, { code: code }, ov),
    new: AC_render('registered', td, { code: code }, ov),
    same: AC_render('registeredSame', td, { code: code }, ov),
    conflict: AC_render('registeredCheck', td, { code: code }, ov),
  };

  // 管理者へ：確認のお願い（本人確認して「LINE確認済み」にチェック）
  if (result === 'fill' || result === 'new' || result === 'conflict') {
    try {
      AC_pushLine_('【確認のお願い】LINE登録がありました\n社員番号：' + code + '（LINE表示名：' + displayName + '）\n'
        + (result === 'conflict' ? 'この社員番号には別のLINEがすでに登録されています。「LINE登録の要確認」シートを見てください。'
          : result === 'new' ? '従業員マスタに無い社員番号です。新しい行に氏名を入れ、本人確認のうえ「LINE確認済み」にチェックをお願いします。'
          : '本人確認のうえ、従業員マスタの「LINE確認済み」にチェックをお願いします。'));
    } catch (e) { Logger.log('管理者への登録連絡に失敗'); }
  }
  AC_reply_(ev.replyToken, replies[result]);
}

function AC_isUserId(v) { return typeof v === 'string' && /^U[0-9a-f]{32}$/.test(v); }

/** 純粋関数：メッセージが社員番号だけ（全角数字可、4〜6桁）ならその番号を返す。それ以外はnull。 */
function AC_parseEmployeeCode(text) {
  var t = String(text == null ? '' : text).replace(/[０-９]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }).trim();
  return /^\d{4,6}$/.test(t) ? t : null;
}

function AC_cellCode_(v) { return String(v == null ? '' : v).replace(/^'/, '').trim(); }

/**
 * 純粋関数：LINE登録の処理方法を決める。
 *  fill：マスタに社員番号があり、LINE ID未登録 → その行に記録
 *  same：同じLINE IDで登録済み
 *  conflict：別のLINE IDで登録済み → 上書きしない
 *  new：マスタに社員番号が無い → 新しい行を追加（管理者が氏名を入力）
 * 同じ社員番号の行が複数ある場合は conflict とする。
 */
function AC_planRegistration(values, code, userId) {
  var rows = [];
  for (var i = 1; i < (values || []).length; i++) {
    if (AC_cellCode_(values[i][AC_COL.code]) === code) rows.push(i);
  }
  if (rows.length === 0) return { type: 'new' };
  if (rows.length > 1) return { type: 'conflict' };
  var current = values[rows[0]][AC_COL.userId];
  if (!current) return { type: 'fill', row: rows[0] };
  return { type: current === userId ? 'same' : 'conflict', row: rows[0] };
}

/**
 * 純粋関数：従業員マスタから、アルコールチェックの本人通知に使える「氏名 → {code, userId}」を作る。
 * 条件：LINE確認済み・アルコールチェック対象・退職でない・社員番号とLINE IDが正しい形式。
 * 氏名と別表記の両方で引けるようにする。同じ氏名が別の人に当たる場合は、その氏名は使わない。
 */
function AC_buildRegistry(values, today) {
  var map = {}, dup = {};
  for (var i = 1; i < (values || []).length; i++) {
    var row = values[i];
    if (row[AC_COL.lineOk] !== true || row[AC_COL.alcohol] !== true) continue;
    if (String(row[AC_COL.status]).trim() === '退職') continue;
    if (today && AC_isRetired(row[AC_COL.retiredOn], today)) continue;  // 退職日を過ぎた人（在籍のまま残っていても）
    var code = AC_cellCode_(row[AC_COL.code]);
    if (!AC_isUserId(row[AC_COL.userId]) || !/^\d{4,6}$/.test(code)) continue;
    [row[AC_COL.name], row[AC_COL.alias]].forEach(function (n) {
      var key = AC_normalizeName(n);
      if (!key) return;
      if (map[key] && map[key].code !== code) dup[key] = true;
      map[key] = { code: code, userId: row[AC_COL.userId] };
    });
  }
  Object.keys(dup).forEach(function (n) { delete map[n]; });
  return map;
}

function AC_loadRegistry_() {
  var reg = AC_buildRegistry(AC_masterSheet_().getDataRange().getValues(), AC_today_());
  if (PropertiesService.getScriptProperties().getProperty('REQUIRE_DEVICE') !== 'true') return reg;
  // 機器所持にチェックがある人だけに絞る。在庫シートが読めないときは誰にも送らない（安全側）
  var devices;
  try {
    var sh = AC_deviceSheet_();
    devices = sh ? AC_deviceCodes(sh.getDataRange().getValues()) : null;
  } catch (e) { devices = null; }
  if (!devices) { Logger.log('機器所持の確認ができないため、本人通知を止めました'); return {}; }
  return AC_filterRegistryByCodes(reg, devices);
}

/** 「アルコールチェッカー在庫」シート。表記ゆれ（例：チャッカー）に備え、「在庫」を含む唯一のシートも許す */
function AC_deviceSheet_() {
  var ss = SpreadsheetApp.openById(AC_SPREADSHEET_ID);
  var sh = ss.getSheetByName(AC_SHEET_DEVICES);
  if (sh) return sh;
  var c = ss.getSheets().filter(function (x) { return /アルコール.*在庫/.test(x.getName()); });
  return c.length === 1 ? c[0] : null;
}

/**
 * 純粋関数：「アルコールチェッカー在庫」から、機器所持にチェックがある社員番号の集合を返す。
 * 見出し行（「従業員コード」と「機器所持」を含む行）を探す。見つからなければ null。
 */
function AC_deviceCodes(values) {
  for (var r = 0; r < (values || []).length; r++) {
    var row = values[r].map(function (v) { return String(v == null ? '' : v).trim(); });
    var cc = row.indexOf('従業員コード'), dc = row.indexOf('機器所持');
    if (cc === -1 || dc === -1) continue;
    var out = {};
    for (var i = r + 1; i < values.length; i++) {
      var code = AC_cellCode_(values[i][cc]);
      if (values[i][dc] === true && /^\d{4,6}$/.test(code)) out[code] = true;
    }
    return out;
  }
  return null;
}

/** 純粋関数：登録簿のうち、社員番号が codes に含まれる人だけを残す */
function AC_filterRegistryByCodes(reg, codes) {
  var out = {};
  Object.keys(reg).forEach(function (k) { if (codes[reg[k].code]) out[k] = reg[k]; });
  return out;
}

/** 従業員マスタ（管理シートとは別ファイル）。無ければ作成する。 */
function AC_masterSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('EMPLOYEE_MASTER_ID');
  var ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('従業員マスタ');
    props.setProperty('EMPLOYEE_MASTER_ID', ss.getId());
  }
  var sheet = ss.getSheetByName('従業員マスタ') || ss.getSheets()[0];
  if (sheet.getLastRow() > 0 && sheet.getLastColumn() < AC_MASTER_HEADER.length) {   // 列を後から追加した場合
    sheet.getRange(1, 1, 1, AC_MASTER_HEADER.length).setValues([AC_MASTER_HEADER]).setFontWeight('bold');
  }
  if (sheet.getLastRow() === 0) {
    sheet.setName('従業員マスタ');
    sheet.appendRow(AC_MASTER_HEADER);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, AC_MASTER_HEADER.length).setFontWeight('bold');
    sheet.getRange('A:A').setNumberFormat('@');                       // 社員番号の先頭ゼロを保つ
    sheet.getRange('D2:D').setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['在籍', '休職', '退職'], true).build());
  }
  return sheet;
}

/** 行にチェックボックス（LINE確認済み・アルコールチェック対象）を付ける。空行に先回りして付けない（最終行がずれるため）。 */
function AC_checkboxes_(sheet, startRow, numRows) {
  if (numRows > 0) sheet.getRange(startRow, AC_COL.lineOk + 1, numRows, 2).insertCheckboxes();
}

/** 社員番号・氏名・LINE IDのどれかが入っている行が1つでもあるか（チェックボックスだけの行は数えない） */
function AC_masterHasData_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  return sheet.getRange(2, 1, last - 1, AC_COL.userId + 1).getValues().some(function (r) {
    return String(r[AC_COL.code]).trim() || String(r[AC_COL.name]).trim() || String(r[AC_COL.userId]).trim();
  });
}

function AC_reviewSheet_(ss) {
  var sheet = ss.getSheetByName('LINE登録の要確認');
  if (!sheet) {
    sheet = ss.insertSheet('LINE登録の要確認');
    sheet.appendRow(['日時', '社員番号', 'LINEユーザーID', 'LINE表示名', '理由']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 手動実行用：従業員マスタを作成し、URLを実行ログに出す。
 * マスタが空なら、シフト表の氏名を「氏名」列に入れる（社員番号は管理者が入力）。
 */
function alcoholCheckSetupMaster() {
  var sheet = AC_masterSheet_();
  if (!AC_masterHasData_(sheet)) {
    if (sheet.getLastRow() > 1) {                                      // 中身の無い行（チェックボックスだけ等）を片付ける
      sheet.getRange(2, 1, sheet.getLastRow() - 1, AC_MASTER_HEADER.length).clearContent().clearDataValidations();
      sheet.getRange('D2:D').setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(['在籍', '休職', '退職'], true).build());
    }
    var sv = SpreadsheetApp.openById(AC_SPREADSHEET_ID).getSheetByName(AC_SHEET_SCHEDULE).getDataRange().getValues();
    var names = AC_rosterNames(sv);
    if (names.length) {
      sheet.getRange(2, 1, names.length, AC_MASTER_HEADER.length).setValues(names.map(function (n) {
        var r = AC_MASTER_HEADER.map(function () { return ''; });
        r[AC_COL.name] = n; r[AC_COL.status] = '在籍'; r[AC_COL.lineOk] = false; r[AC_COL.alcohol] = true;
        return r;
      }));
      AC_checkboxes_(sheet, 2, names.length);
    }
    Logger.log('シフト表から %s人の氏名を入れました', names.length);
  }
  Logger.log('従業員マスタ：%s', sheet.getParent().getUrl());
}

/** 名簿照合用の氏名キー：空白と、括弧書き（旧姓など）を除く */
function AC_nameKey(name) {
  return AC_normalizeName(name).replace(/[（(][^）)]*[）)]/g, '');
}

/**
 * 純粋関数：従業員名簿をマスタに取り込む計画を作る（書き込みはしない）。
 * roster: [{ code, totCode, name, dept, category, retiredOn }]（retiredOn：退職日の文字列、在籍中は空）
 * today: YYYY-MM-DD。退職日が今日より後の人は「在籍」のまま（備考に退職予定）とし、番号の割り当てでも在籍者として扱う。
 * 社員番号の割り当て：
 *  - 名簿で1人だけが持つ番号 → その人
 *  - 複数人が持つ番号 → 在籍者が1人だけならその人（退職者の番号を付け直した場合）。在籍者が2人以上なら誰にも使わない
 *  - 番号を割り当てられなかった退職者 → 番号を空けて「退職」で追加（同じ氏名の空番号の退職行が既にあれば追加しない）
 * マスタ行の更新：
 *  - 同じ社員番号の行 → 所属・社員区分・TOTコードの空欄を埋め、在籍状況・退職日を名簿に合わせる
 *  - 社員番号が空の行 → 名簿で氏名キーが1人だけ一致すれば番号等を入れ、備考に「要確認」を付ける
 * 氏名が名簿で複数人に当たる・見つからないマスタ行は変更せず、件数を返す。
 */
function AC_mergeRoster(masterValues, roster, today) {
  var C = AC_COL, width = AC_MASTER_HEADER.length;
  var rows = (masterValues || []).slice(1).map(function (r) {
    var x = r.slice(0, width); while (x.length < width) x.push(''); return x;
  });
  var total = {}, active = {};
  roster.forEach(function (p) {
    p.code = AC_cellCode_(p.code);
    p.retiredOn = String(p.retiredOn == null ? '' : p.retiredOn).trim();
    p.gone = AC_isRetired(p.retiredOn, today);
    if (!/^\d{4,6}$/.test(p.code)) return;
    total[p.code] = (total[p.code] || 0) + 1;
    if (!p.gone) active[p.code] = (active[p.code] || 0) + 1;
  });
  var byCode = {}, byKey = {}, homeless = [], dupActive = {};
  roster.forEach(function (p) {
    if (!total[p.code]) return;                                        // 不正な社員番号
    var usable = p.gone ? total[p.code] === 1 : active[p.code] === 1;
    if (!p.gone && active[p.code] > 1) dupActive[p.code] = true;
    var k = AC_nameKey(p.name);
    if (usable) { byCode[p.code] = p; if (k) (byKey[k] = byKey[k] || []).push(p); }
    else { if (k) (byKey[k] = byKey[k] || []).push(null); if (p.gone) homeless.push(p); }
  });
  var apply = function (nr, p) {
    if (!nr[C.dept]) nr[C.dept] = p.dept || '';
    if (!nr[C.category]) nr[C.category] = p.category || '';
    if (!nr[C.totCode] && p.totCode !== '' && p.totCode != null) nr[C.totCode] = "'" + p.totCode;
    if (p.retiredOn) nr[C.retiredOn] = p.retiredOn;
    if (p.gone) nr[C.status] = '退職';
    else if (!String(nr[C.status]).trim()) nr[C.status] = '在籍';
    if (p.retiredOn && !p.gone) AC_addNote_(nr, '退職予定');
    if (p.retiredOn && !AC_isValidDate(p.retiredOn)) AC_addNote_(nr, '退職日の日付を確認してください');
  };
  var used = {}, updates = [], ambiguous = 0, notFound = 0;
  rows.forEach(function (r, i) {
    var code = AC_cellCode_(r[C.code]), p = null, nameMatch = false;
    if (code) {
      p = byCode[code];
    } else if (!(String(r[C.status]).trim() === '退職' && String(r[C.retiredOn]).trim())) {
      var hits = byKey[AC_nameKey(r[C.name])] || [];
      if (hits.length === 1 && hits[0]) { p = hits[0]; nameMatch = true; }
      else if (hits.length > 1) ambiguous++;
      else notFound++;
    }
    if (!p || used[p.code]) return;
    used[p.code] = true;
    var nr = r.slice();
    if (!code) nr[C.code] = "'" + p.code;
    apply(nr, p);
    if (nameMatch) AC_addNote_(nr, '名簿と氏名で照合（要確認）');
    if (nr.join('\u0001') !== r.join('\u0001')) updates.push({ index: i, values: nr });
  });
  rows.forEach(function (r) { var c = AC_cellCode_(r[C.code]); if (c) used[c] = true; });
  var blank = function (p) {
    var nr = AC_MASTER_HEADER.map(function () { return ''; });
    nr[C.name] = p.name; nr[C.lineOk] = false; nr[C.alcohol] = false;
    return nr;
  };
  var appends = Object.keys(byCode).filter(function (c) { return !used[c]; }).map(function (c) {
    var p = byCode[c], nr = blank(p);
    nr[C.code] = "'" + p.code;
    apply(nr, p);
    return nr;
  });
  var existingRetired = {};
  rows.forEach(function (r) {
    if (!AC_cellCode_(r[C.code]) && String(r[C.status]).trim() === '退職') existingRetired[AC_nameKey(r[C.name])] = true;
  });
  homeless.forEach(function (p) {
    if (existingRetired[AC_nameKey(p.name)]) return;
    var nr = blank(p);
    apply(nr, p);
    AC_addNote_(nr, '社員番号' + p.code + 'は他の人と重複のため空欄（退職者）');
    appends.push(nr);
  });
  return { updates: updates, appends: appends, ambiguous: ambiguous, notFound: notFound,
    dupCodes: Object.keys(dupActive).length };
}

function AC_addNote_(row, text) {
  var cur = String(row[AC_COL.note] || '');
  if (cur.indexOf(text) === -1) row[AC_COL.note] = cur ? cur + '／' + text : text;
}

/**
 * 純粋関数：退職済みか。退職日が空なら在籍。日付として読めない値（実在しない日付など）は退職済みとみなす。
 * 退職日当日は勤務している可能性があるため、翌日から退職済みとする。
 */
function AC_isRetired(retiredOn, today) {
  var s = String(retiredOn == null ? '' : retiredOn).trim();
  if (!s) return false;
  if (!AC_isValidDate(s) || !today) return true;
  var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(s);
  var iso = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  return iso < today;
}

/** 純粋関数：YYYY-MM-DD または YYYY/M/D が実在する日付か */
function AC_isValidDate(s) {
  var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(String(s).trim());
  if (!m) return false;
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * 手動実行用：従業員マスタに「在籍者一覧」タブを作る（マスタで在籍状況が「在籍」の人を数式で自動表示）。
 * 一覧は表示専用。修正は「従業員マスタ」タブで行う。
 */
function alcoholCheckSetupActiveList() {
  var ss = AC_masterSheet_().getParent();
  var sheet = ss.getSheetByName('在籍者一覧') || ss.insertSheet('在籍者一覧');
  sheet.clear();
  sheet.getRange(1, 1, 1, 7).setValues([['社員番号', '氏名', '所属・拠点', '社員区分', 'LINE確認済み',
    'アルコールチェック対象', '退職日（予定）']]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  var m = "'従業員マスタ'!";
  sheet.getRange('A2').setFormula('=IFERROR(SORT(FILTER({' + [m + 'A2:A', m + 'B2:B', m + 'E2:E', m + 'L2:L',
    m + 'I2:I', m + 'J2:J', m + 'N2:N'].join(',') + '},' + m + 'D2:D="在籍"),3,TRUE,1,TRUE),"")');
  Logger.log('在籍者一覧：%s人', ss.getSheetByName('従業員マスタ').getRange('D2:D').getValues()
    .filter(function (r) { return r[0] === '在籍'; }).length);
}

/** 社員番号を指定して「退職」にする（退職日が不明な場合は備考に記録） */
function AC_markRetired_(codes, note) {
  var sheet = AC_masterSheet_();
  var values = sheet.getDataRange().getValues();
  var want = {}, done = 0;
  codes.forEach(function (c) { want[String(c)] = true; });
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!want[AC_cellCode_(row[AC_COL.code])]) continue;
    row[AC_COL.status] = '退職';
    if (note) AC_addNote_(row, note);
    sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
    delete want[AC_cellCode_(row[AC_COL.code])];
    done++;
  }
  Logger.log('退職に変更：%s人／見つからない社員番号：%s', done, Object.keys(want).join(',') || 'なし');
}

/** 名簿データを従業員マスタへ取り込む（一時的な取り込み用ファイルから呼ぶ） */
function AC_importRoster_(roster) {
  var sheet = AC_masterSheet_();
  var width = AC_MASTER_HEADER.length;
  var values = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), width).getValues();
  var plan = AC_mergeRoster(values, roster, AC_today_());
  plan.updates.forEach(function (u) { sheet.getRange(u.index + 2, 1, 1, width).setValues([u.values]); });
  if (plan.appends.length) {
    var start = sheet.getLastRow() + 1;
    sheet.getRange(start, 1, plan.appends.length, width).setValues(plan.appends);
    AC_checkboxes_(sheet, start, plan.appends.length);
  }
  Logger.log('名簿取り込み：更新 %s行／追加 %s人／氏名が複数一致・番号重複 %s行／名簿に無い %s行／在籍者どうしの重複番号 %s件（取り込まず）',
    plan.updates.length, plan.appends.length, plan.ambiguous, plan.notFound, plan.dupCodes);
}

/** 純粋関数：シフト表（2026-2028）のB列から、「シフト」行の氏名を重複なしで返す（数字だけの空き枠は除く）。 */
function AC_rosterNames(sv) {
  var out = [], seen = {}, current = '';
  for (var r = 2; r < (sv || []).length; r++) {
    if (String(sv[r][1]).trim()) current = String(sv[r][1]).trim();
    if (String(sv[r][2]).trim() !== 'シフト' || !current) continue;
    if (/^[0-9０-９]+$/.test(AC_normalizeName(current))) continue;   // 数字だけの行はシフト表の空き枠
    var k = AC_normalizeName(current);
    if (!seen[k]) { seen[k] = true; out.push(current); }
  }
  return out;
}

function AC_fetchDisplayName_(userId) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) return null;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + userId, {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
  });
  return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()).displayName : null;
}

function AC_reply_(replyToken, text) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !replyToken) return;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true,
  });
}

// Node.jsのテストから純粋関数だけを読み込むため
if (typeof module !== 'undefined') {
  module.exports = { AC_reconcile: AC_reconcile, AC_buildMessage: AC_buildMessage, AC_normalizeName: AC_normalizeName,
    AC_parseEmployeeCode: AC_parseEmployeeCode, AC_buildRegistry: AC_buildRegistry, AC_planRegistration: AC_planRegistration, AC_rosterNames: AC_rosterNames, AC_mergeRoster: AC_mergeRoster, AC_nameKey: AC_nameKey, AC_isValidDate: AC_isValidDate, AC_isRetired: AC_isRetired, AC_namesForCode: AC_namesForCode,
    AC_planNotifications: AC_planNotifications, AC_messageFor: AC_messageFor, AC_morningMessage: AC_morningMessage,
    AC_thanksMessage: AC_thanksMessage, AC_streak: AC_streak, AC_isMilestone: AC_isMilestone, AC_thanksTargets: AC_thanksTargets,
    AC_buildDay: AC_buildDay, AC_recipientsFor: AC_recipientsFor, AC_weatherFromJma: AC_weatherFromJma, AC_findAlerts: AC_findAlerts,
    AC_notTargetReason: AC_notTargetReason, AC_isNormalResult: AC_isNormalResult, AC_deviceCodes: AC_deviceCodes,
    AC_filterRegistryByCodes: AC_filterRegistryByCodes, AC_parseTotCsv: AC_parseTotCsv, AC_totPatternToShift: AC_totPatternToShift, AC_buildTotCompare: AC_buildTotCompare, AC_totScheduleItems: AC_totScheduleItems, AC_attendanceFindings: AC_attendanceFindings, AC_lineByTotCode: AC_lineByTotCode, AC_attendanceReport: AC_attendanceReport, AC_punchMessage: AC_punchMessage, AC_overtimeMessage: AC_overtimeMessage, AC_careLine: AC_careLine, AC_composeMessage: AC_composeMessage, AC_render: AC_render, AC_todayStatus: AC_todayStatus, AC_quotaLevel: AC_quotaLevel, AC_nextMonth: AC_nextMonth, AC_addMonths: AC_addMonths, AC_agreementCheck: AC_agreementCheck, AC_agreementFigures: AC_agreementFigures, AC_monthlyByTot: AC_monthlyByTot, AC_pendingRequests: AC_pendingRequests, AC_paidLeaveStatus: AC_paidLeaveStatus, AC_pauseIndex: AC_pauseIndex, AC_isPaused: AC_isPaused, AC_pausedNames: AC_pausedNames, AC_formChoices: AC_formChoices, AC_codeFromChoice: AC_codeFromChoice, AC_formPlan: AC_formPlan, AC_parseDeptRegistration: AC_parseDeptRegistration, AC_deptNames: AC_deptNames, AC_groupsByDept: AC_groupsByDept, AC_paidLeavePeriod: AC_paidLeavePeriod, AC_paidLeaveCheck: AC_paidLeaveCheck, AC_monthlyApplyPlan: AC_monthlyApplyPlan, AC_todayStatusMessage: AC_todayStatusMessage };
}
