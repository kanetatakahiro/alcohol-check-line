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
 *  - 測定結果が「通常」（NORMAL_RESULTS）以外の回答は、管理者へ至急の確認依頼を送る
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
 *  NORMAL_RESULTS             「通常」とみなす測定結果（カンマ区切り）。未設定なら検知通知は動かない
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
  var names = AC_SCHEDULE.map(function (s) { return s.fn; });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (names.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  AC_SCHEDULE.forEach(function (s) {
    ScriptApp.newTrigger(s.fn).timeBased().everyDays(1).atHour(s.hour).nearMinute(s.minute)
      .inTimezone(AC_TZ).create();
  });
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

// ---------------- 内部処理 ----------------

/** 1回分の通知を実行する。同じ日・同じ種類は1回だけ。データ不備のときは誰にも送らず管理者へ知らせる。 */
function AC_dispatch_(kind) {
  var props = PropertiesService.getScriptProperties();
  var dryRun = props.getProperty('DRY_RUN') !== 'false';
  var notifyPeople = props.getProperty('NOTIFY_EMPLOYEES') === 'true';
  var notifyAdmin = props.getProperty('NOTIFY_ADMIN') !== 'false';
  var today = AC_today_();
  var runKey = 'sent:' + today + ':' + kind;
  if (props.getProperty(runKey)) { Logger.log('実行済みのため中止'); return; }
  AC_cleanupSentKeys_(props, today);

  var d;
  try {
    d = AC_loadDay_(today);
  } catch (e) {
    Logger.log('照合失敗：%s %s', e && e.code ? e.code : 'unknown', e && e.message ? e.message : '');
    if (!dryRun) {
      AC_pushLine_('【アルコールチェック】' + today + ' の確認ができませんでした。シートを確認してください。（'
        + (e && e.code ? e.code : '不明なエラー') + '）');
      props.setProperty(runKey, new Date().toISOString());
    }
    return;
  }
  var weather = kind === 'morning' ? AC_fetchWeather_(today) : null;
  var people = AC_recipientsFor(kind, d);
  var thanks = kind === 'followAfter' ? AC_thanksTargets(d) : [];
  props.setProperty('stat:' + today + ':' + kind, String(people.length + thanks.length));
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
    var dedupe = 'sent:' + today + ':' + tag + ':' + (test ? 'test:' + test.code : reg ? reg.code : key);
    if (props.getProperty(dedupe)) return;
    try {
      if (test) AC_pushLine_('【テスト／' + test.name + 'さん宛て】\n' + text);
      else if (reg) AC_pushTo_(reg.userId, text);
      else { unregistered.push(name); return; }
      props.setProperty(dedupe, new Date().toISOString());
      sent++;
    } catch (e) { failed.push(name); }
  };
  people.forEach(function (name) { deliver(name, AC_messageFor(kind, today, weather), kind); });
  thanks.forEach(function (t) { deliver(t.name, AC_thanksMessage(t.streak), 'thanks'); });
  // テスト対象が今日の対象外（休み・実施済み）でも、動作確認のため状況を管理者へ知らせる
  Object.keys(tests).forEach(function (k) {
    var t = tests[k];
    if (people.some(function (n) { return AC_normalizeName(n) === k; })) return;
    var key = 'sent:' + today + ':' + kind + ':testinfo:' + t.code;
    if (props.getProperty(key)) return;
    AC_pushLine_('【テスト／' + t.name + 'さん】' + AC_kindLabel(kind) + '：' + AC_notTargetReason(kind, d, t.name));
    props.setProperty(key, new Date().toISOString());
  });
  if (notifyAdmin && (kind === 'followBefore' || kind === 'followAfter')) {
    var r = kind === 'followBefore' ? d.before : d.after;
    var plan = AC_planNotifications(r.missing, registry);
    var adminMsg = AC_buildMessage(today, kind === 'followBefore' ? '出勤前' : '退勤前', r, plan, failed);
    if (adminMsg) AC_pushLine_(adminMsg);
  }
  Logger.log('送信 %s通／LINE未登録 %s人／失敗 %s人', sent, unregistered.length, failed.length);
  props.setProperty(runKey, new Date().toISOString());
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

/**
 * アルコール検知の可能性がある回答を管理者へ知らせる（本人通知とは別）。
 * NORMAL_RESULTS（「通常」とみなす測定結果の値、カンマ区切り）が設定されている場合だけ動く。
 * それ以外の測定結果の当日の回答を、1件につき1回だけ知らせる。
 */
function AC_checkAlerts_(props, d, dryRun) {
  var normal = String(props.getProperty('NORMAL_RESULTS') || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);
  if (!normal.length) return;
  var hits = AC_findAlerts(d, normal);
  hits.forEach(function (h) {
    var key = 'sent:' + d.today + ':alert:' + h.row;
    if (props.getProperty(key)) return;
    Logger.log('要確認の測定結果：%s行目', h.row);
    if (dryRun) return;
    var time = Utilities.formatDate(h.at, AC_TZ, 'HH:mm');
    AC_pushLine_('【至急・要確認】アルコールチェックの測定結果\n' + time + ' ' + h.name + '（' + h.label + '）\n測定結果：'
      + h.result + '\n本人の運転可否を確認してください。');
    props.setProperty(key, new Date().toISOString());
  });
}

/** 純粋関数：当日の回答のうち、測定結果が「通常」の値以外のもの */
function AC_findAlerts(d, normal) {
  var out = [];
  for (var i = 1; i < d.fv.length; i++) {
    var row = d.fv[i];
    if (d.toDate(row[0]) !== d.today) continue;
    var result = String(row[3] == null ? '' : row[3]).trim();
    if (!result || normal.indexOf(result) !== -1) continue;
    out.push({ row: i + 1, name: String(row[1]).trim(), label: String(row[2]).trim(), result: result, at: row[0] });
  }
  return out;
}

/** 8日より前の送信記録・40日より前の通数記録を消す（スクリプトプロパティの容量対策） */
function AC_cleanupSentKeys_(props, today) {
  var day = function (n) { return Utilities.formatDate(new Date(Date.now() - n * 86400000), AC_TZ, 'yyyy-MM-dd'); };
  var sentLimit = day(8), statLimit = day(40);
  Object.keys(props.getProperties()).forEach(function (k) {
    var m = /^(sent|stat):(\d{4}-\d{2}-\d{2}):/.exec(k);
    if (m && m[2] < (m[1] === 'sent' ? sentLimit : statLimit)) props.deleteProperty(k);
  });
}

/** 手動確認用：直近の日ごとの見込み通数（全員がLINE登録済みだった場合） */
function alcoholCheckUsage() {
  var all = PropertiesService.getScriptProperties().getProperties();
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
  return { kind: kind, text: text, max: max, min: min };
}

/** 純粋関数：日付から文面の言い回しを選ぶ（毎日同じ文にならないように） */
function AC_pick(list, today) {
  var n = Number(String(today).replace(/-/g, '')) || 0;
  return list[n % list.length];
}

/** 純粋関数：通知の種類ごとの本人向け文面（氏名や他人の情報は含めない） */
function AC_messageFor(kind, today, weather) {
  if (kind === 'morning') return AC_morningMessage(today, weather);
  if (kind === 'followBefore') {
    return 'おはようございます！\n\n本日の出勤前アルコールチェックについて、フォームへの入力が確認できておりませんでした。\n\n'
      + 'すでにアルコールチェックを実施済みの場合は、お手数ですがフォームへの入力をお願いいたします😊\n\n'
      + 'もし忘れてしまっていた場合は、次回から忘れずに対応いただけると助かります！\n\n'
      + '本日これから運転する予定がある場合は、必ず運転前にアルコールチェックをお願いいたします🚗\n\nよろしくお願いします！';
  }
  if (kind === 'evening') {
    return 'お疲れ様です！😊\n\n本日もお仕事ありがとうございます！\n\n退勤前のアルコールチェックと、フォームへの入力をお願いいたします🚗\n\n'
      + 'お帰りの際も、安全運転でお気をつけてください✨';
  }
  if (kind === 'followAfter') {
    return 'お疲れ様です！\n\n本日の退勤前アルコールチェックについて、フォームへの入力が確認できておりませんでした。\n\n'
      + 'すでに実施済みの場合は、お手数ですがフォームへの入力をお願いいたします😊\n\n'
      + 'もし忘れてしまっていた場合は、次回から忘れずに対応いただけると助かります！\n\n'
      + 'お忙しい中お手数をおかけしますが、引き続きご協力よろしくお願いいたします🙇‍♀️';
  }
  return '';
}

/** 純粋関数：朝の案内（天気に合わせた一言。天気が取れないときは天気に触れない） */
function AC_morningMessage(today, weather) {
  var ask = AC_pick(['本日も運転前のアルコールチェックと、フォームへの入力をお願いいたします！🚗',
    '運転前のアルコールチェックと、フォームへの入力を本日もよろしくお願いいたします🚗'], today);
  var close = AC_pick(['今日も一日、安全運転でよろしくお願いします✨', '今日も一日、よろしくお願いします😊',
    '本日もよろしくお願いいたします✨'], today);
  var kind = weather ? weather.kind : 'none';
  var lines = {
    sunny: ['☀️ おはようございます！', AC_pick(['今日は晴れて気持ちの良い一日になりそうですね😊',
      '今日は晴れの予報です。気持ちよく一日を始められそうですね😊'], today)],
    cloudy: ['🌤 おはようございます！', AC_pick(['今日はくもりの予報です。', '今日は雲の多い一日になりそうです。'], today)],
    rain: ['☔ おはようございます！', '今日は雨の予報です。\n路面が滑りやすくなりますので、運転の際はお気をつけください😊'],
    hot: ['☀️ おはようございます！', '今日は気温が高くなる予報です🥵\n屋外での作業もあると思いますので、こまめな水分補給をお願いします！'],
    cold: ['❄️ おはようございます！', '今日は冷え込む予報です。\n屋外での作業もあると思いますので、暖かくしてお過ごしください😊'],
    none: ['おはようございます！✨', ''],
  }[kind];
  var temp = weather && weather.max !== null && kind !== 'none'
    ? '（さいたま 最高' + weather.max + '℃' + (weather.min !== null ? '／最低' + weather.min + '℃' : '') + '）' : '';
  return [lines[0], lines[1] ? lines[1] + temp : '', ask, close].filter(Boolean).join('\n\n');
}

/** 純粋関数：連続記録の感謝（評価ではなく感謝を伝える） */
function AC_thanksMessage(n) {
  if (n === 5) {
    return '🎉 アルコールチェック開始から、5勤務日連続で入力ありがとうございます！！\n\n'
      + '出勤前・退勤前ともに忘れず対応していただけて、本当に助かっています😊\n\n毎日のことでお手数をおかけしますが、いつもありがとうございます✨';
  }
  if (n === 10) {
    return '✨ アルコールチェック、10勤務日連続でのご対応ありがとうございます！！\n\n'
      + '毎日欠かさず入力していただけて、とても助かっています😊\n\nいつもご協力いただき、本当にありがとうございます！';
  }
  if (n === 50) {
    return '✨ いつもありがとうございます！！\n\nアルコールチェックの入力が、50勤務日連続となりました🎉\n\n'
      + '日々の業務でお忙しい中、継続してご対応いただき、本当にありがとうございます！\n\n引き続きよろしくお願いします😊';
  }
  return '🎉 いつもアルコールチェックへのご協力ありがとうございます！\n\n出勤前・退勤前ともに、' + n
    + '勤務日連続で入力いただいています👏\n\n毎日の積み重ね、本当にありがとうございます😊';
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
  return AC_buildRegistry(AC_masterSheet_().getDataRange().getValues(), AC_today_());
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
    AC_notTargetReason: AC_notTargetReason };
}
