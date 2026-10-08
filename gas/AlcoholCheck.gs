/**
 * アルコールチェック未実施者へのLINE通知（Google Apps Script）
 *
 * 動作：
 *  - シート「2026-2028」のシフト行で、当日（日本時間）が「出勤」の人を対象者とする
 *  - シート「フォームの回答 1」の当日・該当チェック区分の回答と氏名で照合する
 *  - 未実施者のうちLINE登録済み（管理者が確認済み）の人へ本人通知し、管理者へ一覧を送る
 *  - 従業員は公式LINEに社員番号を送って登録する（doPost）。従業員マスタは管理シートとは別のスプレッドシート
 *
 * 安全策：
 *  - 管理シートへの書き込みは一切しない（読み取りのみ）
 *  - DRY_RUN が "false" 以外なら送信せず、件数だけをログに出す
 *  - 当日の日付列が見つからない等、データ不備があれば照合をやめ、管理者へ失敗だけを知らせる
 *  - 同じ日・同じ人・同じチェック区分の送信は1回まで
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）：
 *  LINE_CHANNEL_ACCESS_TOKEN  Messaging APIのチャネルアクセストークン（長期）
 *  LINE_ADMIN_USER_ID         通知先の管理者のユーザーID（U から始まる）
 *  DRY_RUN                    "false" のときだけ実際に送信する（未設定なら送信しない）
 *  NOTIFY_EMPLOYEES           "true" のときだけ本人へ通知する（未設定なら管理者一覧のみ）
 *  NOTIFY_ADMIN               "false" にすると管理者一覧を送らない
 *  EMPLOYEE_MASTER_ID         従業員マスタのID（alcoholCheckSetupMaster で自動設定）
 *
 * 会社アカウント（シート編集者）が所有する独立プロジェクト「アルコールチェック通知（暫定版）」で動かす。
 * 既存のApps Scriptとの衝突を避けるため、関数名・定数名には AC_ / alcoholCheck を付けている。
 */

// 独立型プロジェクトでも動くよう、シートはIDで開く（IDは秘密情報ではない）
var AC_SPREADSHEET_ID = '1YeYjc_-O2B1JlVtUpVFWGlM3ahW8dED1JFuQ4ttym5Q';
var AC_SHEET_SCHEDULE = '2026-2028';
var AC_SHEET_FORM = 'フォームの回答 1';
var AC_TZ = 'Asia/Tokyo';
var AC_CHECK_LABELS = { beforeWork: '出勤前', afterWork: '退勤前' };

/** 定期実行：出勤前チェック */
function alcoholCheckBeforeWork() { AC_run_('beforeWork'); }
/** 定期実行：退勤前チェック */
function alcoholCheckAfterWork() { AC_run_('afterWork'); }

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

/** 定期実行の登録（既存の同名トリガーは消してから登録する） */
function alcoholCheckSetupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'alcoholCheckBeforeWork' || f === 'alcoholCheckAfterWork') ScriptApp.deleteTrigger(t);
  });
  // Apps Scriptの時刻指定は「その1時間のどこか」で実行される。
  ScriptApp.newTrigger('alcoholCheckBeforeWork').timeBased().everyDays(1).atHour(9).inTimezone(AC_TZ).create();
  ScriptApp.newTrigger('alcoholCheckAfterWork').timeBased().everyDays(1).atHour(19).inTimezone(AC_TZ).create();
}

/** LINE送信の確認用：管理者へテストメッセージを1通送る（DRY_RUNに関係なく送る） */
function alcoholCheckSendTestMessage() {
  AC_pushLine_('【テスト】アルコールチェック通知の接続確認です。');
}

// ---------------- 内部処理 ----------------

function AC_run_(type) {
  var props = PropertiesService.getScriptProperties();
  var dryRun = props.getProperty('DRY_RUN') !== 'false';
  var notifyPeople = props.getProperty('NOTIFY_EMPLOYEES') === 'true';   // 本人通知は明示的に有効化したときだけ
  var notifyAdmin = props.getProperty('NOTIFY_ADMIN') !== 'false';
  var today = AC_today_();
  var label = AC_CHECK_LABELS[type];
  var runKey = 'sent:' + today + ':' + type;
  if (props.getProperty(runKey)) { Logger.log('実行済みのため中止'); return; }
  AC_cleanupSentKeys_(props, today);

  var r, plan;
  try {
    r = AC_reconcileFromSheets_(today, type);
    plan = AC_planNotifications(r.missing, notifyPeople ? AC_loadRegistry_() : {});
  } catch (e) {
    // 照合できない場合は誰にも個別通知せず、管理者へ失敗だけを知らせる（氏名や生データは含めない）
    Logger.log('照合失敗：%s %s', e && e.code ? e.code : 'unknown', e && e.message ? e.message : '');
    var fail = '【アルコールチェック】' + today + ' ' + label
      + 'の確認ができませんでした。シートを確認してください。（' + (e && e.code ? e.code : '不明なエラー') + '）';
    if (!dryRun) { AC_pushLine_(fail); props.setProperty(runKey, new Date().toISOString()); }
    return;
  }
  Logger.log('%s %s：対象 %s人／未実施 %s人／本人通知 %s人／LINE未登録 %s人', today, label,
    r.targets.length, r.missing.length, plan.send.length, plan.unregistered.length);
  if (dryRun) { Logger.log('DRY_RUNのため送信しません'); return; }

  var failed = [];
  plan.send.forEach(function (p) {
    var personKey = 'sent:' + today + ':' + type + ':' + p.code;      // 同じ日・同じ人・同じ区分は1回
    if (props.getProperty(personKey)) return;
    try {
      AC_pushTo_(p.userId, AC_buildPersonalMessage(today, label));
      props.setProperty(personKey, new Date().toISOString());
    } catch (e) { failed.push(p.name); }
  });
  if (notifyAdmin) {
    var adminMsg = AC_buildMessage(today, label, r, plan, failed);
    if (adminMsg) AC_pushLine_(adminMsg);
  }
  props.setProperty(runKey, new Date().toISOString());
}

/** 8日より前の送信記録を消す（スクリプトプロパティの容量対策） */
function AC_cleanupSentKeys_(props, today) {
  var limit = Utilities.formatDate(new Date(Date.now() - 8 * 86400000), AC_TZ, 'yyyy-MM-dd');
  Object.keys(props.getProperties()).forEach(function (k) {
    var m = /^sent:(\d{4}-\d{2}-\d{2}):/.exec(k);
    if (m && m[1] < limit) props.deleteProperty(k);
  });
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

/** 本人向けの文面（氏名や他人の情報は含めない） */
function AC_buildPersonalMessage(today, label) {
  var md = today.slice(5).replace('-', '/').replace(/^0/, '').replace('/0', '/');
  return '【アルコールチェック】本日（' + md + '）の' + label + 'のアルコールチェックの記録がまだありません。'
    + '\n未実施の場合は、すぐに実施してフォームから記録してください。'
    + '\n実施済みの場合は、管理者へお知らせください。';
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
  'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み', 'アルコールチェック対象', '備考'];
var AC_COL = { code: 0, name: 1, alias: 2, status: 3, dept: 4, userId: 5, lineName: 6, lineAt: 7,
  lineOk: 8, alcohol: 9, note: 10 };

function doPost(e) {
  try {
    var body = JSON.parse(e && e.postData ? e.postData.contents : '{}');
    (body.events || []).forEach(AC_handleEvent_);
  } catch (err) {
    Logger.log('Webhook処理エラー：%s', err && err.message ? err.message : '');
  }
  return ContentService.createTextOutput('OK');
}

function AC_handleEvent_(ev) {
  var src = ev && ev.source;
  if (!src || src.type !== 'user' || !AC_isUserId(src.userId)) return;   // 1対1のトークだけを扱う
  if (ev.type === 'follow') {
    AC_reply_(ev.replyToken, '友だち追加ありがとうございます。\n通知を受け取るため、社員番号（数字のみ）を送ってください。');
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
  var replies = {
    fill: '社員番号 ' + code + ' で受け付けました。\n管理者の確認後、通知が届くようになります。',
    new: '社員番号 ' + code + ' で受け付けました。\n管理者の確認後、通知が届くようになります。',
    same: '社員番号 ' + code + ' は登録済みです。',
    conflict: '社員番号 ' + code + ' で受け付けました。管理者が確認します。',
  };
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
function AC_buildRegistry(values) {
  var map = {}, dup = {};
  for (var i = 1; i < (values || []).length; i++) {
    var row = values[i];
    if (row[AC_COL.lineOk] !== true || row[AC_COL.alcohol] !== true) continue;
    if (String(row[AC_COL.status]).trim() === '退職') continue;
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
  return AC_buildRegistry(AC_masterSheet_().getDataRange().getValues());
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

/** 純粋関数：シフト表（2026-2028）のB列から、「シフト」行の氏名を重複なしで返す。 */
function AC_rosterNames(sv) {
  var out = [], seen = {}, current = '';
  for (var r = 2; r < (sv || []).length; r++) {
    if (String(sv[r][1]).trim()) current = String(sv[r][1]).trim();
    if (String(sv[r][2]).trim() !== 'シフト' || !current) continue;
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
    AC_parseEmployeeCode: AC_parseEmployeeCode, AC_buildRegistry: AC_buildRegistry, AC_planRegistration: AC_planRegistration, AC_rosterNames: AC_rosterNames,
    AC_planNotifications: AC_planNotifications, AC_buildPersonalMessage: AC_buildPersonalMessage };
}
