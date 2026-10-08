/**
 * アルコールチェック未実施者の管理者向けLINE通知（暫定版・Google Apps Script）
 *
 * 動作：
 *  - シート「2026-2028」のシフト行で、当日（日本時間）が「出勤」の人を対象者とする
 *  - シート「フォームの回答 1」の当日・該当チェック区分の回答と氏名で照合する
 *  - 回答がない人の一覧を、管理者1人のLINEへ送る（従業員本人へは送らない）
 *
 * 安全策：
 *  - シートへの書き込みは一切しない（読み取りのみ）
 *  - DRY_RUN が "false" 以外なら送信せず、件数だけをログに出す
 *  - 当日の日付列が見つからない等、データ不備があれば照合をやめ、管理者へ失敗だけを知らせる
 *  - 同じ日・同じチェック区分の送信は1回まで
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）：
 *  LINE_CHANNEL_ACCESS_TOKEN  Messaging APIのチャネルアクセストークン（長期）
 *  LINE_ADMIN_USER_ID         通知先の管理者のユーザーID（U から始まる）
 *  DRY_RUN                    "false" のときだけ実際に送信する（未設定なら送信しない）
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

// ---------------- 従業員のLINE登録（Webhook） ----------------
// 従業員が公式アカウントを友だち追加し、社員番号を送ると、登録表（別スプレッドシート）に1行追加する。
// 返信は応答メッセージ（reply）で行い、通数に数えられない。社員番号以外の発言には反応しない（手動チャットを邪魔しない）。
// Apps ScriptのdoPostはヘッダーを読めず署名検証ができないため、登録は管理者が「確認済み」にするまで通知に使わない。

var AC_REG_HEADER = ['登録日時', '社員番号', 'LINE表示名', 'LINEユーザーID', 'シフト表の氏名（管理者が入力）', '確認済み（管理者がチェック）'];

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
    AC_reply_(ev.replyToken, '友だち追加ありがとうございます。\nアルコールチェックの通知を受け取るため、社員番号（数字のみ）を送ってください。');
    return;
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  var code = AC_parseEmployeeCode(ev.message.text);
  if (!code) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = AC_registrySheet_();
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][3] === src.userId && String(rows[i][1]) === code) {
        AC_reply_(ev.replyToken, '社員番号 ' + code + ' は登録済みです。');
        return;
      }
    }
    var name = AC_fetchDisplayName_(src.userId) || '（取得できませんでした）';
    sheet.appendRow([new Date(), "'" + code, name, src.userId, '', false]);
    sheet.getRange(sheet.getLastRow(), 6).insertCheckboxes();
  } finally {
    lock.releaseLock();
  }
  AC_reply_(ev.replyToken, '社員番号 ' + code + ' で受け付けました。\n管理者の確認後、アルコールチェックの通知が届くようになります。');
}

function AC_isUserId(v) { return typeof v === 'string' && /^U[0-9a-f]{32}$/.test(v); }

/** 純粋関数：メッセージが社員番号だけ（全角数字可、4〜6桁）ならその番号を返す。それ以外はnull。 */
function AC_parseEmployeeCode(text) {
  var t = String(text == null ? '' : text).replace(/[０-９]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }).trim();
  return /^\d{4,6}$/.test(t) ? t : null;
}

/**
 * 純粋関数：登録表の全値から、確認済みの行だけで「シフト表の氏名 → {code, userId}」を作る。
 * 同じ氏名に別の登録が複数あるときは、その氏名は使わない（誤送信防止）。
 */
function AC_buildRegistry(values) {
  var map = {}, dup = {};
  for (var i = 1; i < (values || []).length; i++) {
    var row = values[i];
    if (row[5] !== true) continue;
    var name = AC_normalizeName(row[4]);
    var code = String(row[1]).replace(/^'/, '').trim();
    if (!name || !AC_isUserId(row[3]) || !/^\d{4,6}$/.test(code)) continue;
    if (map[name] && (map[name].userId !== row[3] || map[name].code !== code)) dup[name] = true;
    map[name] = { code: code, userId: row[3] };
  }
  Object.keys(dup).forEach(function (n) { delete map[n]; });
  return map;
}

function AC_loadRegistry_() {
  return AC_buildRegistry(AC_registrySheet_().getDataRange().getValues());
}

/** 登録表のスプレッドシート（管理シートとは別ファイル）。無ければ作成する。 */
function AC_registrySheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('REGISTRY_SPREADSHEET_ID');
  var ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('アルコールチェック LINE登録表');
    props.setProperty('REGISTRY_SPREADSHEET_ID', ss.getId());
  }
  var sheet = ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.setName('LINE登録');
    sheet.appendRow(AC_REG_HEADER);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, AC_REG_HEADER.length).setFontWeight('bold');
  }
  return sheet;
}

/** 手動実行用：登録表を作成し、URLを実行ログに出す */
function alcoholCheckSetupRegistry() {
  var sheet = AC_registrySheet_();
  Logger.log('登録表：%s', sheet.getParent().getUrl());
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
    AC_parseEmployeeCode: AC_parseEmployeeCode, AC_buildRegistry: AC_buildRegistry,
    AC_planNotifications: AC_planNotifications, AC_buildPersonalMessage: AC_buildPersonalMessage };
}
