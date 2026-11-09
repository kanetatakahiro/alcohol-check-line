/**
 * 希望休の申請期限の案内（毎月10日 12:00・本人へ）。設計：docs/line-ai/INVESTIGATION.md 4章（feature/line-ai-research cbab2d1）
 *
 * - 翌月分の希望休の申請期限（毎月15日まで・ToTから申請）だけを案内する。「有給」という言葉・残りの日数は送らない
 * - 時刻指定のトリガー（毎月10日・12時台）から動く。受信処理（doPost）は使わない・変えない
 * - 有給の年5日の見守り（管理者向け・AC_paidLeaveStatus）は変えない
 *
 * 設定（スクリプトプロパティ）
 *   LEAVE_REQUEST_NOTIFY：未設定＝何もしない／record＝送らずに「希望休案内」シートへ記録／on＝送る（DRY_RUN=false のときだけ。10日だけ）
 *   LEAVE_REQUEST_EXCLUDE_CODES：送らない社員番号（出勤予定のない人など）。「、」「,」・空白の区切り
 *
 * 対象：従業員マスタで 在籍・退職日の前・「LINE確認済み」・LINEユーザーIDが正しい形・社員番号あり（雇用形態・所属は問わない）
 * 除く：その日に「お知らせ停止」中（全部・勤怠のみのどちらも）／除外の社員番号／同じLINEユーザーIDの2行目以降
 * 二重送信の防止：送った人ごとに「leavereq:対象月:LINEユーザーID」を記録（実行したアカウントの記録）。
 *   既存の「sent:」の記録は8日で自動で消えるため、別の名前にしている。3か月より前の記録はこの処理が消す
 */

var LR_SHEET = '希望休案内';
var LR_HEADER = ['日時', '対象月', '社員番号', '氏名', '結果', '本文'];
var LR_DAY = 10;       // 送る日
var LR_HOUR = 12;      // 送る時刻（時）
var LR_DEADLINE = 15;  // 申請期限（今月の日）

/** 純粋関数：社員番号の一覧（「、」「,」・空白区切り。全角数字も読む） */
function AC_parseCodeList(text) {
  var s = String(text == null ? '' : text).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  var out = [];
  s.split(/[、,，\s]+/).forEach(function (x) { var c = AC_cellCode_(x); if (c && out.indexOf(c) === -1) out.push(c); });
  return out;
}

/** 純粋関数：今日（YYYY-MM-DD）から、対象月（YYYY-MM）・{月}・{期限} を決める */
function AC_leaveRequestVars(today) {
  var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  var wd = '日月火水木金土'.charAt(new Date(Date.UTC(y, m - 1, LR_DEADLINE)).getUTCDay());
  var target = AC_nextMonth(today);
  return { target: target, month: String(Number(target.slice(5, 7))), deadline: m + '月' + LR_DEADLINE + '日（' + wd + '）' };
}

/** 純粋関数：文面（「LINE文面」シートの leaveRequest で上書きできる。{月}・{期限} を入れる） */
function AC_leaveRequestMessage(today, overrides) {
  var v = AC_leaveRequestVars(today);
  return AC_render('leaveRequest', today, { month: v.month, deadline: v.deadline }, overrides)
    .replace(/\{月\}/g, v.month).replace(/\{期限\}/g, v.deadline);
}

/**
 * 純粋関数：送る人と、除いた人。
 * pauseIndex：AC_pauseIndex の結果、exclude：社員番号の配列
 * 戻り値 { targets: [{ code, name, userId }], skipped: [{ code, name, reason }] }（skipped は「お知らせ停止中」「除外の社員番号」「同じLINEの重複」だけ）
 */
function AC_leaveRequestTargets(masterValues, today, pauseIndex, exclude) {
  var targets = [], skipped = [], seen = {}, ex = {};
  (exclude || []).forEach(function (c) { ex[AC_cellCode_(c)] = true; });
  for (var i = 1; i < (masterValues || []).length; i++) {
    var r = masterValues[i];
    if (String(r[AC_COL.status]).trim() !== '在籍') continue;
    if (AC_isRetired(r[AC_COL.retiredOn], today)) continue;
    if (r[AC_COL.lineOk] !== true || !AC_isUserId(r[AC_COL.userId])) continue;
    var code = AC_cellCode_(r[AC_COL.code]);
    if (!code) continue;
    var p = { code: code, name: String(r[AC_COL.name] || '').trim(), userId: r[AC_COL.userId] };
    if (ex[code]) { skipped.push({ code: code, name: p.name, reason: '除外の社員番号' }); continue; }
    if (AC_isPaused(pauseIndex || {}, code, today)) { skipped.push({ code: code, name: p.name, reason: 'お知らせ停止中' }); continue; }
    if (seen[p.userId]) { skipped.push({ code: code, name: p.name, reason: '同じLINEの重複（社員番号 ' + seen[p.userId] + ' に送る）' }); continue; }
    seen[p.userId] = code;
    targets.push(p);
  }
  return { targets: targets, skipped: skipped };
}

/** 純粋関数：管理者への件数の報告（氏名・社員番号は入れない） */
function AC_leaveRequestReport(month, live, counts) {
  var c = counts || {};
  var head = '【希望休の案内】' + month + '月分の申請期限の案内' + (live ? '' : '（記録のみ・送信していません）');
  var lines = [head,
    (live ? '送信：' : '対象：') + (c.sent || 0) + '人',
    live ? '送れなかった人：' + (c.failed || 0) + '人' + (c.failed ? '（もう一度 alcoholCheckLeaveRequestNotice を実行すると、送っていない人にだけ送ります）' : '') : null,
    c.already ? '今月すでに送った人：' + c.already + '人' : null,
    '除いた人：お知らせ停止 ' + (c.paused || 0) + '人／除外の社員番号 ' + (c.excluded || 0) + '人／同じLINEの重複 ' + (c.dup || 0) + '人'
      + (c.setting ? '／お知らせ設定でOFF ' + c.setting + '人' : ''),
    '詳しくは従業員マスタの「' + LR_SHEET + '」シートをご覧ください。'];
  return lines.filter(function (x) { return x !== null; }).join('\n');
}

/** トリガーから（毎月10日・12時台）。手動で実行してもよい（on は10日だけ送る。record はいつでも記録だけ） */
function alcoholCheckLeaveRequestNotice() {
  var props = PropertiesService.getScriptProperties();
  var mode = String(props.getProperty('LEAVE_REQUEST_NOTIFY') || '').trim();
  if (mode !== 'record' && mode !== 'on') { Logger.log('希望休の案内：LEAVE_REQUEST_NOTIFY が未設定のため何もしません'); return; }
  var today = AC_today_();
  if (mode === 'on' && Number(today.slice(8, 10)) !== LR_DAY) { Logger.log('希望休の案内：送るのは毎月' + LR_DAY + '日だけです（今日は送りません）'); return; }
  var live = mode === 'on' && props.getProperty('DRY_RUN') === 'false';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('希望休の案内：ほかの実行中のため、今回は行いません'); return; }
  try {
    var v = AC_leaveRequestVars(today), state = AC_state_(), now = new Date();
    LR_cleanup_(state, v.target);
    var master = AC_masterSheet_(), mv = master.getDataRange().getValues(), ss = master.getParent();
    var plan = AC_leaveRequestTargets(mv, today, AC_pauseIndex_(), AC_parseCodeList(props.getProperty('LEAVE_REQUEST_EXCLUDE_CODES')));
    if (typeof AC_noticeCheck_ === 'function') {   // お知らせ設定（ATT-01 希望休の案内。gas/Notices.gs）
      plan.targets = plan.targets.filter(function (p) {
        if (AC_noticeCheck_('ATT-01', p.code, today).send) return true;
        plan.skipped.push({ code: p.code, name: p.name, reason: 'お知らせ設定でOFF' });
        return false;
      });
    }
    var text = AC_leaveRequestMessage(today, AC_templateOverrides_());
    var rows = [], counts = { sent: 0, failed: 0, already: 0, paused: 0, excluded: 0, dup: 0, setting: 0 };
    var sh = LR_sheet_(ss);
    plan.targets.forEach(function (p) {
      var key = 'leavereq:' + v.target + ':' + p.userId, result;
      if (state.getProperty(key)) { counts.already++; return; }   // 同じ月はもう送った（シートにも書かない）
      if (!live) { result = '記録のみ（送信しない）'; counts.sent++; }
      else {
        try { AC_pushTo_(p.userId, text); state.setProperty(key, now.toISOString()); result = '送信'; counts.sent++; }
        catch (e) { result = '送信失敗'; counts.failed++; }
      }
      rows.push([now, v.target, "'" + p.code, p.name, result, text]);
    });
    plan.skipped.forEach(function (s) {
      if (s.reason === 'お知らせ停止中') counts.paused++; else if (s.reason === '除外の社員番号') counts.excluded++;
      else if (s.reason === 'お知らせ設定でOFF') counts.setting++; else counts.dup++;
      rows.push([now, v.target, "'" + s.code, s.name, '送らない（' + s.reason + '）', '']);
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, LR_HEADER.length).setValues(rows);
    Logger.log('希望休の案内（%s）：対象 %s人・送信 %s人・失敗 %s人・送信済み %s人・除外 %s人', live ? '送信' : '記録のみ',
      plan.targets.length, live ? counts.sent : 0, counts.failed, counts.already, plan.skipped.length);
    if (counts.sent || counts.failed) AC_adminNotice_('leavereq:' + v.target + (counts.already ? ':again' : '') + (live ? '' : ':rec'),
      AC_leaveRequestReport(v.month, live, counts));
  } finally { lock.releaseLock(); }
}

/** 手動確認用：送らず・書かずに、今日実行したときの人数と本文をログに出す（氏名・社員番号は出さない） */
function alcoholCheckLeaveRequestPreview() {
  var props = PropertiesService.getScriptProperties(), today = AC_today_();
  var plan = AC_leaveRequestTargets(AC_masterSheet_().getDataRange().getValues(), today, AC_pauseIndex_(),
    AC_parseCodeList(props.getProperty('LEAVE_REQUEST_EXCLUDE_CODES')));
  Logger.log('希望休の案内（確認のみ）：送る人 ' + plan.targets.length + '人・除く人 ' + plan.skipped.length + '人\n\n'
    + AC_leaveRequestMessage(today, AC_templateOverrides_()));
}

/** トリガーを作る（毎月10日・12時台。同じトリガーは消してから作る） */
function alcoholCheckSetupLeaveRequestTrigger() {
  alcoholCheckRemoveLeaveRequestTrigger();
  var b = function () { return ScriptApp.newTrigger('alcoholCheckLeaveRequestNotice').timeBased().onMonthDay(LR_DAY).atHour(LR_HOUR).inTimezone(AC_TZ); };
  try { b().nearMinute(0).create(); }
  catch (e) { b().create(); }   // 分の指定ができない場合は12時台のどこか
  Logger.log('希望休の案内のトリガーを作りました（毎月%s日 %s時台）', LR_DAY, LR_HOUR);
}

/** このトリガーだけを消す（ほかのトリガーは消さない） */
function alcoholCheckRemoveLeaveRequestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'alcoholCheckLeaveRequestNotice') ScriptApp.deleteTrigger(t);
  });
}

function LR_sheet_(ss) {
  var sh = ss.getSheetByName(LR_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LR_SHEET);
    sh.getRange(1, 1, 1, LR_HEADER.length).setValues([LR_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 3か月より前の対象月の送信記録を消す */
function LR_cleanup_(state, target) {
  var limit = AC_addMonths(target, -3);
  Object.keys(state.getProperties()).forEach(function (k) {
    var m = /^leavereq:(\d{4}-\d{2}):/.exec(k);
    if (m && m[1] < limit) state.deleteProperty(k);
  });
}

if (typeof module !== 'undefined') {
  module.exports = Object.assign(module.exports || {}, {
    AC_parseCodeList: AC_parseCodeList, AC_leaveRequestVars: AC_leaveRequestVars, AC_leaveRequestMessage: AC_leaveRequestMessage,
    AC_leaveRequestTargets: AC_leaveRequestTargets, AC_leaveRequestReport: AC_leaveRequestReport,
  });
}
