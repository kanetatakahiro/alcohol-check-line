/**
 * REBIRTH全社通知管理 Ver.1（設計：docs/notifications/DESIGN-v1.md）
 *
 * Phase 1：安全上の問題の修正
 *   9-1 飲酒検知・異常値：勤怠管理グループと管理者（安全運転管理者・LINE_ADMIN_USER_ID）の2か所へ。送信先ごとに記録し、片方の失敗で止めない
 *       （送信の処理は gas/AlcoholCheck.gs の AC_checkAlerts_ から AC_alertSend_ を呼ぶ）
 *   9-2 アルコールチェック未実施：本人への催促（10:00・20:00）は今のまま。管理者・グループへの一覧は追加しない（変更なし）
 *   9-3 夜の勤怠の取り込み（22:30）：22:45 以降に、届いていない・明確なエラーがあれば勤怠管理グループへ（alcoholCheckNightRelayWatch）
 *
 * Phase 2：お知らせ設定の共通化（34項目）
 *   従業員マスタと同じファイルに「お知らせ設定」「所属別お知らせ設定」「お知らせ種類」「お知らせ設定履歴」「通知送信履歴」を作る
 *   （alcoholCheckSetupNoticeSettings）。従業員マスタの A〜O 列と既存のシートは変更しない
 *   NOTICE_SETTINGS：未設定＝使わない（今と同じ）／record＝OFFの人を記録するだけ（送信は今までどおり）／on＝チェックに従う
 *   重要な通知（飲酒検知・取り込みの失敗・システムのエラー）は、この設定では止まらない
 */

// ---------------- お知らせ34項目（設計用ID・2026-11-09 確定） ----------------
// status：'送信中'（本番で送っている）／'停止中'（コードはあるが本番で止まっている・記録だけ）／'未実装'／'作らない'
// def：所属の初期値（決定済み、または今の動きを引き継ぐ値）。restyle：所属名に「リスタイル」を含むときの初期値
// impl：true のものだけ、実際の送信に連動する（未実装・作らないものは ON でも送らない）
var AC_NOTICES = [
  { id: 'ATT-01', name: '希望休の案内', cat: '勤怠・シフト', status: '送信中', impl: true, def: true, restyle: false, link: '希望休の申請期限の案内（毎月10日 12時台）' },
  { id: 'ATT-02', name: '打刻漏れの連絡', cat: '勤怠・シフト', status: '停止中', impl: true, def: true, restyle: true, link: '打刻漏れ・当日の打刻なし（夜22:30。ATTENDANCE_NOTIFY 未設定で本人へは止まっている）、管理本部の本人への未申請の打刻漏れ（記録のみ）' },
  { id: 'ATT-03', name: '出勤前アルコールチェックの案内', cat: '勤怠・シフト', status: '送信中', impl: true, def: true, link: '朝の案内（8:30）。NOTICE_ALCOHOL_SCOPE により出勤前の入力確認（10:00）も' },
  { id: 'ATT-04', name: '退勤後アルコールチェックの案内', cat: '勤怠・シフト', status: '送信中', impl: true, def: true, link: '退勤前の案内（18:30）。NOTICE_ALCOHOL_SCOPE により退勤前の入力確認（20:00）・お礼も。※今の通知とフォームは「退勤前」（名前は未決）' },
  { id: 'ATT-05', name: 'シフト確定のお知らせ', cat: '勤怠・シフト', status: '未実装', def: false },
  { id: 'ATT-06', name: 'シフト変更のお知らせ', cat: '勤怠・シフト', status: '未実装', def: false },
  { id: 'ATT-07', name: '有給休暇の取得案内', cat: '勤怠・シフト', status: '作らない', def: false, note: '2026-11-06 の決定（会社から有給の取得を促さない）。ON にしても送らない' },
  { id: 'ATT-08', name: '有給休暇の残日数のお知らせ', cat: '勤怠・シフト', status: '作らない', def: false, note: '2026-11-06 の決定（残数は給与明細で確認）。ON にしても送らない' },
  { id: 'ATT-09', name: '勤怠修正の依頼', cat: '勤怠・シフト', status: '未実装', def: false },
  { id: 'ATT-10', name: '欠勤・遅刻の連絡確認', cat: '勤怠・シフト', status: '未実装', def: false },
  { id: 'HR-01', name: '申請の確認', cat: '申請・労務', status: '停止中', impl: true, def: true, restyle: true, link: '管理本部の本人への承認待ちのお知らせ（記録のみ）' },
  { id: 'HR-02', name: '残業の警告', cat: '申請・労務', status: '停止中', impl: true, def: true, restyle: true, link: '残業30時間（夜22:30。ATTENDANCE_NOTIFY 未設定で本人へは止まっている）' },
  { id: 'HR-03', name: '最大残業時間の警告（45時間）', cat: '申請・労務', status: '未実装', def: false, note: '45時間の手前の警告（時間は未決。案：40時間）' },
  { id: 'HR-04', name: '最大残業時間の超過（45時間）', cat: '申請・労務', status: '停止中', impl: true, def: true, link: '残業45時間（今月45時間以上で1回。夜22:30。本人へは止まっている）' },
  { id: 'HR-05', name: '申請の承認・却下結果', cat: '申請・労務', status: '未実装', def: false },
  { id: 'HR-06', name: '申請の差戻し・不備連絡', cat: '申請・労務', status: '未実装', def: false },
  { id: 'HR-07', name: '未提出書類の案内', cat: '申請・労務', status: '未実装', def: false },
  { id: 'HR-08', name: '雇用契約更新のお知らせ', cat: '申請・労務', status: '未実装', def: false },
  { id: 'HR-09', name: '健康診断の案内', cat: '申請・労務', status: '未実装', def: false },
  { id: 'HR-10', name: '健康診断の未受診案内', cat: '申請・労務', status: '未実装', def: false },
  { id: 'HR-11', name: '給与明細公開のお知らせ', cat: '申請・労務', status: '未実装', def: false },
  { id: 'SAF-01', name: '運転免許証の更新案内', cat: '車両・資格・安全', status: '未実装', def: false },
  { id: 'SAF-02', name: '資格・講習の更新案内', cat: '車両・資格・安全', status: '未実装', def: false },
  { id: 'SAF-03', name: '車検・点検期限のお知らせ', cat: '車両・資格・安全', status: '未実装', def: false },
  { id: 'SAF-04', name: '社用車の点検・報告依頼', cat: '車両・資格・安全', status: '未実装', def: false },
  { id: 'SAF-05', name: '事故・トラブル報告の確認', cat: '車両・資格・安全', status: '未実装', def: false },
  { id: 'GEN-01', name: '社内のお知らせ', cat: '社内連絡・その他', status: '未実装', def: false },
  { id: 'GEN-02', name: '重要なお知らせの確認依頼', cat: '社内連絡・その他', status: '未実装', def: false },
  { id: 'GEN-03', name: '研修・会議の案内', cat: '社内連絡・その他', status: '未実装', def: false },
  { id: 'GEN-04', name: '研修・会議の前日リマインド', cat: '社内連絡・その他', status: '未実装', def: false },
  { id: 'GEN-05', name: '業務報告・日報の提出案内', cat: '社内連絡・その他', status: '未実装', def: false },
  { id: 'GEN-06', name: 'アンケート回答依頼', cat: '社内連絡・その他', status: '未実装', def: false },
  { id: 'GEN-07', name: '社内イベントの案内', cat: '社内連絡・その他', status: '未実装', def: false },
  { id: 'GEN-08', name: '誕生日・記念日のお知らせ', cat: '社内連絡・その他', status: '未実装', def: false },
];
// 重要な通知（「お知らせ設定」の列にしない＝一般の設定では止められない。止める・送信先を変えるには両名の承認）
var AC_CRITICAL_NOTICES = [
  { id: 'CRIT-01', name: '飲酒検知・異常値', to: '勤怠管理グループ＋管理者（安全運転管理者）', when: '検知したらすぐ（10分ごとの確認・各案内の回）' },
  { id: 'CRIT-02', name: '夜の勤怠の取り込みの失敗（22:45）', to: '勤怠管理グループ（未登録・失敗のときは管理者）', when: '毎日 22:45 以降に1回' },
  { id: 'CRIT-03', name: '朝の勤怠の取り込みが届かない', to: '管理者', when: '毎朝 8:30ごろ（今のまま）' },
  { id: 'CRIT-04', name: 'システムのエラー（受け口・フォーム・取り込み・問い合わせなど）', to: '管理者', when: '起きたとき（今のまま・1日1回）' },
];
var AC_NOTICE_BY_ID = {};
AC_NOTICES.forEach(function (n) { AC_NOTICE_BY_ID[n.id] = n; });

var AC_NS_SHEET = 'お知らせ設定';
var AC_NS_DEPT_SHEET = '所属別お知らせ設定';
var AC_NS_TYPE_SHEET = 'お知らせ種類';
var AC_NS_HIST_SHEET = 'お知らせ設定履歴';
var AC_NS_LOG_SHEET = '通知送信履歴';
var AC_NS_OTHER_DEPT = '（その他の所属）';
var AC_NS_FIXED = ['社員番号', '氏名', '所属', '状態'];
var AC_NS_LOG_HEADER = ['日時', '通知ID', '通知名', '送信先', '社員番号', 'イベントID', '結果', 'エラー内容'];
var AC_NS_HIST_HEADER = ['日時', '社員番号', '氏名', '内容', '変更前', '変更後'];

/** 純粋関数：列の見出し（例「ATT-01 希望休の案内」）。読むときは先頭のIDだけを見る */
function AC_noticeHeader(n) { return n.id + ' ' + n.name; }
function AC_noticeIdOf(h) { var m = /^([A-Z]+-\d{2})(?:\s|$)/.exec(String(h == null ? '' : h).trim()); return m && AC_NOTICE_BY_ID[m[1]] ? m[1] : null; }

/** 純粋関数：所属の初期値（決定済みの方針・今の動きを引き継ぐ値）。リスタイルは所属名に「リスタイル」を含むもの */
function AC_noticeDeptDefault(id, dept) {
  var n = AC_NOTICE_BY_ID[id];
  if (!n) return false;
  if (n.restyle !== undefined && /リスタイル/.test(String(dept || ''))) return n.restyle;
  return !!n.def;
}

/** 純粋関数：シートの値から判定用の索引を作る。settingValues：「お知らせ設定」、deptValues：「所属別お知らせ設定」、masterValues：従業員マスタ */
function AC_noticeIndex(settingValues, deptValues, masterValues) {
  var idx = { person: {}, dept: {}, deptOf: {} };
  var cols = function (header) { var m = {}; (header || []).forEach(function (h, j) { var id = AC_noticeIdOf(h); if (id) m[id] = j; }); return m; };
  var read = function (row, m) { var o = {}; Object.keys(m).forEach(function (id) { var v = row[m[id]]; if (v === true || v === false) o[id] = v; }); return o; };
  (masterValues || []).forEach(function (r, i) {
    if (i === 0) return;
    var code = AC_cellCode_(r[AC_COL.code]);
    if (code && !(code in idx.deptOf)) idx.deptOf[code] = String(r[AC_COL.dept] || '').trim();
  });
  if (settingValues && settingValues.length) {
    var hm = cols(settingValues[0]);
    settingValues.slice(1).forEach(function (r) { var code = AC_cellCode_(r[0]); if (code && !idx.person[code]) idx.person[code] = read(r, hm); });
  }
  if (deptValues && deptValues.length) {
    var dm = cols(deptValues[0]);
    deptValues.slice(1).forEach(function (r) { var d = String(r[0] || '').trim(); if (d) idx.dept[d] = read(r, dm); });
  }
  return idx;
}

/** 純粋関数：その人の最終的な設定（個人の行 → 所属別 → （その他の所属）→ 初期値の順） */
function AC_noticeEffective(idx, id, code) {
  var p = idx.person[AC_cellCode_(code)];
  if (p && typeof p[id] === 'boolean') return p[id];
  var dept = idx.deptOf[AC_cellCode_(code)] || '';
  var d = idx.dept[dept];
  if (d && typeof d[id] === 'boolean') return d[id];
  var o = idx.dept[AC_NS_OTHER_DEPT];
  if (!idx.dept[dept] && o && typeof o[id] === 'boolean' && !/リスタイル/.test(dept)) return o[id];
  return AC_noticeDeptDefault(id, dept);
}

/** 純粋関数：アルコールチェックの本人向け通知が、どの設定に従うか。scope：guide（案内だけ・推奨）／guideAndFollow（案内＋催促）／all（＋お礼） */
function AC_alcoholNoticeId(tag, scope) {
  scope = scope === 'guideAndFollow' || scope === 'all' ? scope : 'guide';
  if (tag === 'morning') return 'ATT-03';
  if (tag === 'evening') return 'ATT-04';
  if (scope === 'guide') return null;
  if (tag === 'followBefore') return 'ATT-03';
  if (tag === 'followAfter') return 'ATT-04';
  if (tag === 'thanks' && scope === 'all') return 'ATT-04';
  return null;
}

/**
 * 純粋関数：「お知らせ設定」の行の追加・更新の計画（従業員マスタから）。
 * opts：{ exclude: { 社員番号: true }（希望休の除外の引き継ぎ）, deptChange: 'keep'|'reset', deptDefault: fn(id, dept) }
 * 戻り値：{ header, add: [行], updates: [{ index, cells: { 列番号: 値 } }], history: [行] }
 */
function AC_noticeSyncPlan(masterValues, settingValues, today, opts) {
  opts = opts || {};
  var header = AC_NS_FIXED.concat(AC_NOTICES.map(AC_noticeHeader));
  var dd = opts.deptDefault || AC_noticeDeptDefault, ex = opts.exclude || {}, reset = opts.deptChange === 'reset';
  var have = {}, out = { header: header, add: [], updates: [], history: [] };
  (settingValues || []).forEach(function (r, i) { if (i > 0) { var c = AC_cellCode_(r[0]); if (c && !(c in have)) have[c] = i; } });
  var seen = {};
  (masterValues || []).forEach(function (r, i) {
    if (i === 0) return;
    var code = AC_cellCode_(r[AC_COL.code]);
    if (!code || seen[code]) return;
    seen[code] = true;
    var name = String(r[AC_COL.name] || '').trim(), dept = String(r[AC_COL.dept] || '').trim();
    var state = String(r[AC_COL.status] || '').trim() === '退職' || AC_isRetired(r[AC_COL.retiredOn], today) ? '退職' : '在籍';
    if (!(code in have)) {
      if (state === '退職') return;   // 退職した人の行は新しく作らない
      out.add.push(["'" + code, name, dept, state].concat(AC_NOTICES.map(function (n) { return n.id === 'ATT-01' && ex[code] ? false : dd(n.id, dept); })));
      out.history.push(["'" + code, name, '追加（所属の初期値）' + (ex[code] ? '・希望休はOFF（除外の社員番号から引き継ぎ）' : ''), '', dept]);
      return;
    }
    var row = settingValues[have[code]], cells = {};
    if (String(row[1] || '').trim() !== name) cells[1] = name;
    if (String(row[3] || '').trim() !== state) { cells[3] = state; out.history.push(["'" + code, name, state === '退職' ? '退職' : '在籍に戻る', row[3], state]); }
    var oldDept = String(row[2] || '').trim();
    if (oldDept !== dept) {
      cells[2] = dept;
      out.history.push(["'" + code, name, reset ? '所属変更（新しい所属の初期値に戻した）' : '所属変更（個人の設定を引き継いだ）', oldDept, dept]);
      if (reset) AC_NOTICES.forEach(function (n, j) { cells[AC_NS_FIXED.length + j] = dd(n.id, dept); });
    }
    if (Object.keys(cells).length) out.updates.push({ index: have[code], cells: cells });
  });
  return out;
}

/** 純粋関数：所属別の初期値の表（従業員マスタの所属＋（その他の所属）） */
function AC_noticeDeptRows(masterValues) {
  var depts = [];
  (masterValues || []).forEach(function (r, i) { var d = i > 0 ? String(r[AC_COL.dept] || '').trim() : ''; if (d && depts.indexOf(d) === -1) depts.push(d); });
  depts.push(AC_NS_OTHER_DEPT);
  return depts.map(function (d) { return [d].concat(AC_NOTICES.map(function (n) { return AC_noticeDeptDefault(n.id, d === AC_NS_OTHER_DEPT ? '' : d); })); });
}

// ---------------- 判定（既存の通知から呼ぶ） ----------------
var AC_NS_CACHE = null;
function AC_noticeMode_() {
  var m = String(PropertiesService.getScriptProperties().getProperty('NOTICE_SETTINGS') || '').trim();
  return m === 'on' || m === 'record' ? m : 'off';
}

function AC_noticeIndex_() {
  if (AC_NS_CACHE) return AC_NS_CACHE;
  var ss = AC_masterSheet_().getParent(), mv = AC_masterSheet_().getDataRange().getValues();
  try { AC_noticeSyncDaily_(ss, mv); } catch (e) { Logger.log('お知らせ設定の行の更新に失敗（判定は続けます）'); }
  var get = function (n) { var sh = ss.getSheetByName(n); return sh ? sh.getDataRange().getValues() : null; };
  AC_NS_CACHE = AC_noticeIndex(get(AC_NS_SHEET), get(AC_NS_DEPT_SHEET), mv);
  return AC_NS_CACHE;
}

/**
 * 既存の通知から呼ぶ：この人にこの通知を送ってよいか。{ send: true|false }
 * 未設定（off）なら必ず送る（今と同じ）。record は OFF の人を記録するだけで送る。on は OFF なら送らない。
 * 設定が読めないときは送る（今の動きを守る）。未実装・作らない通知は常に送らない
 */
function AC_noticeCheck_(id, code, today) {
  var n = AC_NOTICE_BY_ID[id];
  if (!n || !n.impl) return { send: false, reason: '未実装' };
  var mode = AC_noticeMode_();
  if (mode === 'off' || !AC_cellCode_(code)) return { send: true };
  var on;
  try { on = AC_noticeEffective(AC_noticeIndex_(), id, code); } catch (e) { Logger.log('お知らせ設定を読めませんでした（今までどおり送ります）'); return { send: true }; }
  if (on) return { send: true };
  var key = 'sent:' + (today || AC_today_()) + ':nsoff:' + id + ':' + AC_cellCode_(code);
  try {
    var state = AC_state_();
    if (!state.getProperty(key)) {
      state.setProperty(key, new Date().toISOString());
      AC_noticeLog_([[new Date(), id, n.name, '本人', "'" + AC_cellCode_(code), '', mode === 'on' ? 'お知らせ設定でOFFのため送らない' : 'お知らせ設定でOFF（記録のみ・送信は今までどおり）', '']]);
    }
  } catch (e2) { Logger.log('お知らせ設定の記録に失敗'); }
  return mode === 'on' ? { send: false, reason: 'お知らせ設定でOFF' } : { send: true };
}

/** 「通知送信履歴」に行を足す（失敗しても通知は止めない） */
function AC_noticeLog_(rows) {
  try {
    if (!rows || !rows.length) return;
    var sh = AC_nsSheet_(AC_masterSheet_().getParent(), AC_NS_LOG_SHEET, AC_NS_LOG_HEADER);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, AC_NS_LOG_HEADER.length).setValues(rows);
  } catch (e) { Logger.log('通知送信履歴の記録に失敗'); }
}

function AC_nsSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ---------------- 「お知らせ設定」の作成と行の同期 ----------------
/** 手動実行：お知らせ設定のシート一式を作る（無いものだけ）。既存のシート・従業員マスタの列は変更しない。何度実行してもよい */
function alcoholCheckSetupNoticeSettings() {
  var master = AC_masterSheet_(), ss = master.getParent(), mv = master.getDataRange().getValues();
  // お知らせ種類（毎回書き直す。参考の表）
  var types = ss.getSheetByName(AC_NS_TYPE_SHEET) || ss.insertSheet(AC_NS_TYPE_SHEET);
  var th = ['通知ID', '正式名称', '分類', '実装状況', '重要度', '「お知らせ設定」で止められるか', '今の通知との対応・備考'];
  var tr = AC_NOTICES.map(function (n) {
    return [n.id, n.name, n.cat, n.status + (n.impl ? '' : '（ONでも送らない）'), '通常', '止められる', [n.link || '', n.note || ''].filter(Boolean).join('／')];
  }).concat(AC_CRITICAL_NOTICES.map(function (c) { return [c.id, c.name, '重要な通知', '送信中', '重要', '止められない（両名の承認が必要）', '送信先：' + c.to + '／' + c.when]; }));
  types.clearContents();
  types.getRange(1, 1, 1, th.length).setValues([th]).setFontWeight('bold');
  types.getRange(2, 1, tr.length, th.length).setValues(tr);
  types.setFrozenRows(1);
  // 所属別お知らせ設定（無いときだけ作る。管理本部が直した値は上書きしない。新しい所属だけ行を足す）
  var dh = ['所属'].concat(AC_NOTICES.map(AC_noticeHeader));
  var dept = ss.getSheetByName(AC_NS_DEPT_SHEET);
  var rows = AC_noticeDeptRows(mv);
  if (!dept) {
    dept = ss.insertSheet(AC_NS_DEPT_SHEET);
    dept.getRange(1, 1, 1, dh.length).setValues([dh]).setFontWeight('bold');
    dept.setFrozenRows(1);
    dept.getRange(2, 1, rows.length, dh.length).setValues(rows);
    dept.getRange(2, 2, rows.length, AC_NOTICES.length).insertCheckboxes();
  } else {
    var have = {};
    dept.getDataRange().getValues().slice(1).forEach(function (r) { have[String(r[0]).trim()] = true; });
    var add = rows.filter(function (r) { return !have[r[0]]; });
    if (add.length) {
      var at = dept.getLastRow() + 1;
      dept.getRange(at, 1, add.length, dh.length).setValues(add);
      dept.getRange(at, 2, add.length, AC_NOTICES.length).insertCheckboxes();
    }
  }
  AC_nsSheet_(ss, AC_NS_HIST_SHEET, AC_NS_HIST_HEADER);
  AC_nsSheet_(ss, AC_NS_LOG_SHEET, AC_NS_LOG_HEADER);
  var r = AC_noticeSync_(ss, mv);
  AC_NS_CACHE = null;
  Logger.log('お知らせ設定を準備しました（行の追加 %s人・更新 %s人）。NOTICE_SETTINGS が未設定の間は、通知の動きは変わりません', r.added, r.updated);
}

/** 1日1回（record／on のとき、最初の判定の前に）：新しい人の行を足し、所属・在籍の変化を反映する */
function AC_noticeSyncDaily_(ss, mv) {
  var state = AC_state_(), key = 'sent:' + AC_today_() + ':nssync';
  if (state.getProperty(key) || !ss.getSheetByName(AC_NS_SHEET)) return;
  state.setProperty(key, new Date().toISOString());
  AC_noticeSync_(ss, mv);
}

function AC_noticeSync_(ss, mv) {
  var props = PropertiesService.getScriptProperties();
  var sh = ss.getSheetByName(AC_NS_SHEET), created = false;
  var header = AC_NS_FIXED.concat(AC_NOTICES.map(AC_noticeHeader));
  if (!sh) {
    sh = ss.insertSheet(AC_NS_SHEET);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    created = true;
  }
  var values = sh.getDataRange().getValues();
  var ex = {};
  if (created) AC_parseCodeList(props.getProperty('LEAVE_REQUEST_EXCLUDE_CODES')).forEach(function (c) { ex[c] = true; });   // 初回だけ引き継ぐ
  var dv = ss.getSheetByName(AC_NS_DEPT_SHEET) ? ss.getSheetByName(AC_NS_DEPT_SHEET).getDataRange().getValues() : null;
  var didx = AC_noticeIndex(null, dv, null);
  var deptDefault = function (id, dept) {
    var d = didx.dept[dept];
    if (d && typeof d[id] === 'boolean') return d[id];
    var o = didx.dept[AC_NS_OTHER_DEPT];
    if (!d && o && typeof o[id] === 'boolean' && !/リスタイル/.test(dept)) return o[id];
    return AC_noticeDeptDefault(id, dept);
  };
  var plan = AC_noticeSyncPlan(mv, values, AC_today_(), { exclude: ex, deptChange: props.getProperty('NOTICE_DEPT_CHANGE') === 'reset' ? 'reset' : 'keep', deptDefault: deptDefault });
  plan.updates.forEach(function (u) { Object.keys(u.cells).forEach(function (c) { sh.getRange(u.index + 1, Number(c) + 1).setValue(u.cells[c]); }); });
  if (plan.add.length) {
    var at = sh.getLastRow() + 1;
    sh.getRange(at, 1, plan.add.length, header.length).setValues(plan.add);
    sh.getRange(at, AC_NS_FIXED.length + 1, plan.add.length, AC_NOTICES.length).insertCheckboxes();
  }
  if (plan.history.length) {
    var hs = AC_nsSheet_(ss, AC_NS_HIST_SHEET, AC_NS_HIST_HEADER), now = new Date();
    hs.getRange(hs.getLastRow() + 1, 1, plan.history.length, AC_NS_HIST_HEADER.length).setValues(plan.history.map(function (h) { return [now].concat(h); }));
  }
  return { added: plan.add.length, updated: plan.updates.length };
}

/** 手動確認用：通知ごとの ON の人数だけを表示する（送らない・書かない。氏名・社員番号は出さない） */
function alcoholCheckNoticeSettingsPreview() {
  var ss = AC_masterSheet_().getParent(), mv = AC_masterSheet_().getDataRange().getValues();
  var get = function (n) { var sh = ss.getSheetByName(n); return sh ? sh.getDataRange().getValues() : null; };
  var idx = AC_noticeIndex(get(AC_NS_SHEET), get(AC_NS_DEPT_SHEET), mv);
  var today = AC_today_(), codes = [];
  mv.forEach(function (r, i) {   // 在籍・退職日の前の人だけを数える
    var c = i > 0 ? AC_cellCode_(r[AC_COL.code]) : '';
    if (c && codes.indexOf(c) === -1 && String(r[AC_COL.status] || '').trim() !== '退職' && !AC_isRetired(r[AC_COL.retiredOn], today)) codes.push(c);
  });
  var lines = ['お知らせ設定（NOTICE_SETTINGS：' + AC_noticeMode_() + '）：在籍の従業員 ' + codes.length + '人'];
  AC_NOTICES.forEach(function (n) {
    var on = codes.filter(function (c) { return AC_noticeEffective(idx, n.id, c); }).length;
    lines.push(n.id + ' ' + n.name + '：ON ' + on + '人' + (n.impl ? '' : '（' + n.status + '・送らない）'));
  });
  Logger.log(lines.join('\n'));
}

// ---------------- 9-1 飲酒検知・異常値（2か所へ） ----------------
var AC_ALERT_MAX_TRY = 3;   // 送れなかった送信先は、次の確認（10分後）でやり直す。3回まで

/** 送信先：管理者（安全運転管理者）と勤怠管理グループ。ALERT_TO_GROUP=false でグループには送らない（戻すとき用） */
function AC_alertDestinations_(props) {
  var out = [], admin = props.getProperty('LINE_ADMIN_USER_ID');
  if (admin) out.push({ key: 'admin', to: admin, label: '管理者（安全運転管理者）' });
  if (props.getProperty('ALERT_TO_GROUP') !== 'false') {
    var groups = [];
    try { groups = AC_groupsByDept(AC_groupSheet_().getDataRange().getValues())[AC_ADMIN_GROUP] || []; } catch (e) { Logger.log('勤怠管理グループの読み込みに失敗'); }
    if (!groups.length) out.push({ key: 'group', to: null, label: '勤怠管理グループ' });
    groups.forEach(function (g, i) { out.push({ key: 'group' + (i ? i + 1 : ''), to: g, label: '勤怠管理グループ' }); });
  }
  return out;
}

/**
 * 1件の検知を、送信先ごとに送る。送れた送信先は記録して二度と送らない。送れなかった送信先は3回までやり直す。
 * 片方の失敗で、もう片方を止めない。全部の送信先が終わったら「sent:日付:alert:行」を記録する
 */
function AC_alertSend_(props, state, today, hit, text) {
  var base = 'sent:' + today + ':alert:' + hit.row, logs = [], now = new Date(), done = true;
  AC_alertDestinations_(props).forEach(function (d) {
    var k = base + ':' + d.key, tk = 'sent:' + today + ':alerttry:' + hit.row + ':' + d.key;
    if (state.getProperty(k)) return;
    if (!d.to) { state.setProperty(k, 'none'); logs.push([now, 'CRIT-01', '飲酒検知・異常値', d.label, '', 'row' + hit.row, '送れず', '勤怠管理グループが「LINEグループ」シートに登録されていません']); return; }
    var tries = Number(state.getProperty(tk) || 0) + 1;
    state.setProperty(tk, String(tries));
    try {
      AC_pushTo_(d.to, text);
      state.setProperty(k, now.toISOString());
      logs.push([now, 'CRIT-01', '飲酒検知・異常値', d.label, '', 'row' + hit.row, '送信', '']);
    } catch (e) {
      var last = tries >= AC_ALERT_MAX_TRY;
      if (last) state.setProperty(k, 'failed');
      else done = false;
      logs.push([now, 'CRIT-01', '飲酒検知・異常値', d.label, '', 'row' + hit.row, last ? '送信失敗（やり直しの上限）' : '送信失敗（次の確認でやり直す）', String(e && e.message || '不明')]);
    }
  });
  if (done) state.setProperty(base, now.toISOString());
  AC_noticeLog_(logs);
  return logs;
}

// ---------------- 9-3 夜の勤怠の取り込み（22:30）の見守り ----------------
var AC_NIGHT_WATCH_FROM = '22:45';

/**
 * 純粋関数：今夜の取り込みの状態。
 * file：{ ymd, hm, content }（tot-latest.json の最終更新の日・時刻（日本時間）と中身）または null
 * notices：{ totfetch: 'HH:mm'|null, totprocess: 'HH:mm'|null }（今日の管理者へのエラーの知らせの時刻）
 * 戻り値：{ ok, reason }
 */
function AC_nightRelayStatus(today, file, notices) {
  notices = notices || {};
  if (!file) return { ok: false, reason: '取り込みのファイル（tot-latest.json）が見つかりません' };
  if (file.ymd !== today || file.hm < '22:00') return { ok: false, reason: '今夜の取り込みが届いていません（最後に届いたのは ' + Number(file.ymd.slice(5, 7)) + '/' + Number(file.ymd.slice(8, 10)) + ' ' + file.hm + '）' };
  var data;
  try { data = JSON.parse(file.content); } catch (e) { return { ok: false, reason: '届いたデータを読めません' }; }
  if (!data || data.today !== today || !data.results) return { ok: false, reason: '届いたデータの日付が今日ではありません' };
  var failed = Object.keys(data.results).filter(function (k) {
    var v = data.results[k];
    return v && (v._error || (Array.isArray(v) && v.some(function (x) { return x && x._error; })));
  });
  if (failed.length) return { ok: false, reason: 'ToTから一部のデータを読み取れませんでした（' + failed.join('、') + '）' };
  if (notices.totprocess && notices.totprocess >= '22:00') return { ok: false, reason: '取り込みの処理の途中でエラーがありました' };
  return { ok: true, reason: '' };
}

function AC_nightRelayMessage(today, reason) {
  return '【勤怠の取り込みの確認】今夜22:30のToTの取り込みを確認できませんでした🙇‍♀️\n（' + reason + '）\n\n'
    + '今夜の打刻漏れ・残業の確認ができていない可能性があります。\n'
    + 'さくらのVPSがコントロールパネルで「稼働中」になっているか、Apps Script の実行ログに doPost のエラーがないかをご確認ください。';
}

/** 15分ごとのトリガーから：22:45〜24:00 の間に1回だけ判定する（それ以外の時刻は何もしない） */
function alcoholCheckNightRelayWatch() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('NIGHT_WATCH') === 'false') return;
  var now = new Date(), hm = Utilities.formatDate(now, AC_TZ, 'HH:mm');
  if (hm < AC_NIGHT_WATCH_FROM) return;
  var today = AC_today_(), state = AC_state_(), key = 'sent:' + today + ':nightwatch';
  if (state.getProperty(key)) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    if (state.getProperty(key)) return;
    var f = null, file = AC_totLatestFile_();
    if (file) f = { ymd: Utilities.formatDate(file.getLastUpdated(), AC_TZ, 'yyyy-MM-dd'), hm: Utilities.formatDate(file.getLastUpdated(), AC_TZ, 'HH:mm'), content: file.getBlob().getDataAsString('UTF-8') };
    var t = function (kind) { var v = state.getProperty('sent:' + today + ':notice:' + kind); return v && !isNaN(Date.parse(v)) ? Utilities.formatDate(new Date(v), AC_TZ, 'HH:mm') : null; };
    var st = AC_nightRelayStatus(today, f, { totfetch: t('totfetch'), totprocess: t('totprocess') });
    if (st.ok) {
      state.setProperty(key, 'ok');
      AC_noticeLog_([[now, 'CRIT-02', '夜の勤怠の取り込みの失敗（22:45）', '－', '', 'night:' + today, '取り込みを確認（通知なし）', '']]);
      return;
    }
    var text = AC_nightRelayMessage(today, st.reason), logs = [], sent = 0, groups = [];
    try { groups = AC_groupsByDept(AC_groupSheet_().getDataRange().getValues())[AC_ADMIN_GROUP] || []; } catch (e) { Logger.log('勤怠管理グループの読み込みに失敗'); }
    groups.forEach(function (g) {
      try { AC_pushTo_(g, text); sent++; logs.push([now, 'CRIT-02', '夜の勤怠の取り込みの失敗（22:45）', '勤怠管理グループ', '', 'night:' + today, '送信', st.reason]); }
      catch (e) { logs.push([now, 'CRIT-02', '夜の勤怠の取り込みの失敗（22:45）', '勤怠管理グループ', '', 'night:' + today, '送信失敗', String(e && e.message || '不明') + '／' + st.reason]); }
    });
    if (!sent) {   // グループが未登録・送れないときは管理者の個別LINEへ
      try { AC_pushLine_(text + '\n（勤怠管理グループへ送れなかったため、こちらへお知らせしました）'); sent++; logs.push([now, 'CRIT-02', '夜の勤怠の取り込みの失敗（22:45）', '管理者', '', 'night:' + today, '送信', st.reason]); }
      catch (e2) { logs.push([now, 'CRIT-02', '夜の勤怠の取り込みの失敗（22:45）', '管理者', '', 'night:' + today, '送信失敗', String(e2 && e2.message || '不明') + '／' + st.reason]); }
    }
    var tk = 'sent:' + today + ':nightwatchtry', tries = Number(state.getProperty(tk) || 0) + 1;
    state.setProperty(tk, String(tries));
    if (sent || tries >= 3) state.setProperty(key, sent ? now.toISOString() : 'failed');   // 送れなかったときは15分後にやり直す（3回まで）
    AC_noticeLog_(logs);
  } finally { lock.releaseLock(); }
}

/** トリガーを作る（15分ごと。判定は 22:45〜24:00 の1回だけ）。このトリガーだけを消してから作る */
function alcoholCheckSetupNightWatchTrigger() {
  alcoholCheckRemoveNightWatchTrigger();
  ScriptApp.newTrigger('alcoholCheckNightRelayWatch').timeBased().everyMinutes(15).create();
  Logger.log('夜の取り込みの見守りのトリガーを作りました（15分ごと。判定は 22:45 以降に1回）');
}
function alcoholCheckRemoveNightWatchTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'alcoholCheckNightRelayWatch') ScriptApp.deleteTrigger(t); });
}

if (typeof module !== 'undefined') {
  module.exports = Object.assign(module.exports || {}, {
    AC_NOTICES: AC_NOTICES, AC_CRITICAL_NOTICES: AC_CRITICAL_NOTICES, AC_noticeHeader: AC_noticeHeader, AC_noticeIdOf: AC_noticeIdOf,
    AC_noticeDeptDefault: AC_noticeDeptDefault, AC_noticeIndex: AC_noticeIndex, AC_noticeEffective: AC_noticeEffective,
    AC_alcoholNoticeId: AC_alcoholNoticeId, AC_noticeSyncPlan: AC_noticeSyncPlan, AC_noticeDeptRows: AC_noticeDeptRows,
    AC_nightRelayStatus: AC_nightRelayStatus, AC_nightRelayMessage: AC_nightRelayMessage,
  });
}
