/**
 * 社員管理AI専用プロジェクトの入口（EmployeeAdmin.gs と一緒に入れる。既存の「勤怠・アルコールチェック管理」には入れない）
 *
 * このプロジェクトは、署名確認の受け口（Cloudflare Workers／VPS中継）から届く type 'line-verified' だけを受け付ける。
 * それ以外の受信は何もせず 'NG' を返す（従業員マスタに触れない）。
 * 下の「既存と同じ定義」は gas/AlcoholCheck.gs と一字一句同じであることを自動テストで確認している。
 */

function doPost(e) {
  var out = 'NG';
  try {
    var body = JSON.parse(e && e.postData ? e.postData.contents : '{}');
    if (body && body.type === 'line-verified') out = EA_handleForward_(body);
  } catch (err) { Logger.log('社員管理AI：受信の処理エラー'); }
  return ContentService.createTextOutput(out);
}

/** 従業員マスタ（既存のファイルを開くだけ。無ければ作らずに止める） */
function AC_masterSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('EMPLOYEE_MASTER_ID');
  if (!id) throw new Error('EMPLOYEE_MASTER_ID が未設定です');
  var ss = SpreadsheetApp.openById(id);
  var sheet = ss.getSheetByName('従業員マスタ');
  if (!sheet) throw new Error('「従業員マスタ」シートがありません');
  return sheet;
}

/** 設定とトリガーの確認（秘密の値は表示しない） */
function employeeAdminShowSettings() {
  var p = PropertiesService.getScriptProperties().getProperties();
  var shown = ['EA_MODE', 'EA_AUTO_APPLY', 'EA_ADMIN_GROUP_ID', 'EA_WEBAPP_URL'], presence = ['EA_FORWARD_SECRET', 'EA_LINE_CHANNEL_TOKEN', 'EMPLOYEE_MASTER_ID'];
  var out = ['社員管理AI 版 ' + EA_VERSION];
  shown.forEach(function (k) { out.push(k + '：' + (p[k] || '未設定')); });
  presence.forEach(function (k) { out.push(k + '：' + (p[k] ? '設定あり' : '未設定')); });
  out.push('トリガー：' + (ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).join('、') || 'なし'));
  Logger.log(out.join('\n'));
  return out;
}

/** 受け口（Cloudflare Workers）と共有する合言葉を作る。すでにあれば何もしない。値は表示しない */
function employeeAdminCreateSecret() {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('EA_FORWARD_SECRET')) { Logger.log('合言葉はすでにあります（表示しません）'); return; }
  p.setProperty('EA_FORWARD_SECRET', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  Logger.log('合言葉を作成しました（表示しません）。Cloudflare に登録するときだけ employeeAdminShowSecret を実行してください');
}

/** 【安藤さんが実行】合言葉を実行ログに表示する（Cloudflare の EA_FORWARD_SECRET に貼り付ける。チャット等には貼らない） */
function employeeAdminShowSecret() {
  Logger.log(PropertiesService.getScriptProperties().getProperty('EA_FORWARD_SECRET') || '未作成です（employeeAdminCreateSecret を実行）');
}

/**
 * 実環境の自己点検：このウェブアプリへ実際に HTTP で送り、転送の確認が働くかを見る（シートには書かない。合言葉は表示しない）
 *  正しい署名＝OK／同じ転送の再送＝NG／本文の差し替え＝NG／5分より古い＝NG／署名なし＝NG
 */
function employeeAdminSelfTest() {
  var url = PropertiesService.getScriptProperties().getProperty('EA_WEBAPP_URL');   // デプロイしたウェブアプリのURL（…/exec）
  var secret = PropertiesService.getScriptProperties().getProperty('EA_FORWARD_SECRET');
  if (!url || !secret) throw new Error('ウェブアプリのURLまたは合言葉がありません');
  var payload = JSON.stringify({ destination: 'selftest', events: [] });
  var make = function (tsShift, p) {
    var ts = Math.floor(Date.now() / 1000) + (tsShift || 0), nonce = Utilities.getUuid(), body = p || payload;
    return { type: 'line-verified', ts: ts, nonce: nonce, payload: body, sig: EA_hmacHex_(secret, ts + '.' + nonce + '.' + body) };
  };
  var post = function (obj) {
    return UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(obj), muteHttpExceptions: true, followRedirects: true })
      .getContentText().trim();
  };
  var ok = make(0), tampered = make(0);
  tampered.payload = JSON.stringify({ destination: 'selftest2', events: [] });
  var res = [
    ['正しい署名', post(ok), 'OK'],
    ['同じ転送の再送', post(ok), 'NG'],
    ['本文の差し替え', post(tampered), 'NG'],
    ['5分より古い', post(make(-301)), 'NG'],
    ['署名なし（LINEの本文そのまま）', post({ destination: 'selftest', events: [] }), 'NG'],
  ];
  res.forEach(function (r) { Logger.log('%s：%s（期待 %s）%s', r[0], r[1], r[2], r[1] === r[2] ? '✅' : '❌'); });
  return res.every(function (r) { return r[1] === r[2]; });
}

/** 社員管理AI用LINEのアクセストークンが有効かを確かめる（トークンは表示しない。公式アカウント名だけ表示） */
function employeeAdminCheckLine() {
  var t = PropertiesService.getScriptProperties().getProperty('EA_LINE_CHANNEL_TOKEN');
  if (!t) { Logger.log('EA_LINE_CHANNEL_TOKEN が未設定です'); return false; }
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: 'Bearer ' + t }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { Logger.log('LINEのトークンが使えません（HTTP %s）', String(res.getResponseCode())); return false; }
  var info = JSON.parse(res.getContentText());
  Logger.log('LINEのトークンは有効です：%s（%s）', info.displayName || '', info.basicId || '');
  return true;
}

// ---- 既存と同じ定義（gas/AlcoholCheck.gs から複製。変更しないこと） ----
var AC_TZ = 'Asia/Tokyo';

var AC_COL = { code: 0, name: 1, alias: 2, status: 3, dept: 4, userId: 5, lineName: 6, lineAt: 7,
  lineOk: 8, alcohol: 9, note: 10, category: 11, totCode: 12, retiredOn: 13 };

var AC_PAUSE_SHEET = 'お知らせ停止';

var AC_PAUSE_HEADER = ['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）'];

function AC_today_() {
  return Utilities.formatDate(new Date(), AC_TZ, 'yyyy-MM-dd');
}

function AC_checkboxes_(sheet, startRow, numRows) {
  if (numRows > 0) sheet.getRange(startRow, AC_COL.lineOk + 1, numRows, 2).insertCheckboxes();
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
