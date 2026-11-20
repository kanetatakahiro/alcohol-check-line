/**
 * 月末の勤怠の締め（gas/MonthClose.gs・版 2026-11-20f）。業務マニュアル M02「月末の勤怠締めの確認」の AI 化。
 *
 * 毎朝 8時台（トリガー monthCloseDaily）に、日にちで次のことをする：
 *   - 月末の前日：今月1日〜前日の「申請していない打刻漏れ」がある本人へ、個別 LINE で「締め前の最後のお願い」
 *       （毎週月曜の催促と同じ作り AC_weeklyPunchRun_ を使う。同じ月は1人1通。お知らせ設定・停止中・LINE 未登録は今までどおり外す）
 *   - 月末・翌月1日・2日：【月末の締め】のまとめ（①申請していない打刻漏れ（人ごと・日付）②承認待ちの申請（人ごと）③前日からの減り具合）
 *   - 翌月3日：最終の一覧（残っている人＝上長へ連絡が必要な人）
 *   - 翌月4日：残りが 0 件なら「締め完了」
 *   まとめは AC_pushLine_（ADMIN_NOTIFY=digest のとき、平日 9時の勤怠管理グループのまとめに入る）。土日祝はまとめを作らない
 *   対象の月：月末の前日・月末は今月、翌月1〜4日は前月
 *
 * スクリプトプロパティ：MONTH_CLOSE_NOTIFY  未設定・off＝何もしない／record＝まとめは作るが本人へは送らず記録だけ／on＝送る
 * データ：朝の tot-latest.json（今朝のデータでなければ何もしない）
 */
var MC_VERSION = '2026-11-20f';

/** 純粋関数：今日することと対象の月。{ kind: 'eve'|'daily'|'final'|'done'|null, month: 'YYYY-MM' } */
function MC_phase(today) {
  var d = Number(today.slice(8, 10)), ym = today.slice(0, 7), prev = AC_addMonths(ym, -1);
  if (AC_isMonthEnd(AC_addDays_(today, 1))) return { kind: 'eve', month: ym };
  if (AC_isMonthEnd(today)) return { kind: 'daily', month: ym };
  if (d === 1 || d === 2) return { kind: 'daily', month: prev };
  if (d === 3) return { kind: 'final', month: prev };
  if (d === 4) return { kind: 'done', month: prev };
  return { kind: null, month: '' };
}

/**
 * 純粋関数：その月の「申請していない打刻漏れ」と「承認待ちの申請」。
 * 打刻漏れ：TOT のエラー勤務のうち、同じ人・同じ日の打刻申請・スケジュール申請が承認待ち・承認済みでない日（月の1日〜 min(月末, 昨日)）
 * 戻り値 { ok, reason, punch: { TOTコード: [日付…] }, pend: [{ tot, type, date }] }
 */
function MC_items(R, today, month) {
  R = R || {};
  var bad = function (a) { return !Array.isArray(a) || a.some(function (x) { return x && x._error; }); };
  if (!Array.isArray(R.employees) || bad(R.workings)) return { ok: false, reason: '勤務のデータが無い、または読み取りエラー' };
  var req = AC_requestedDays(R, AC_WEEKLY_PUNCH_REQUEST_TYPES);
  if (!req.ok) return { ok: false, reason: '申請のデータが無い、または読み取りエラー' };
  var from = month + '-01', next = AC_addMonths(month, 1) + '-01', to = today < next ? today : next;   // to は含まない
  var codeByKey = AC_totCodeByKey_(R.employees), punch = {}, seen = {};
  AC_totFlat_(R.workings).forEach(function (w) {
    var tot = codeByKey[w && w.employeeKey];
    if (!tot || w.isError !== true || !w.date || w.date < from || w.date >= to) return;
    var t = AC_totKey(tot), k = t + ':' + w.date;
    if (seen[k] || req.days[k]) return;
    seen[k] = 1;
    (punch[t] = punch[t] || []).push(w.date);
  });
  Object.keys(punch).forEach(function (t) { punch[t].sort(); });
  var pend = AC_pendingRequests(R.employees, R.requests).filter(function (p) { return p.date && p.date < next; });
  return { ok: true, reason: '', punch: punch, pend: pend };
}

/** 純粋関数：件数 { people, punch, pend } */
function MC_counts(items) {
  var people = {}, punch = 0;
  Object.keys(items.punch).forEach(function (t) { people[t] = 1; punch += items.punch[t].length; });
  items.pend.forEach(function (p) { people[AC_totKey(p.tot)] = 1; });
  return { people: Object.keys(people).length, punch: punch, pend: items.pend.length };
}

/** 純粋関数：まとめの文。nameOf(TOTコード) → 氏名。prev＝前日の件数（なければ null） */
function MC_text(kind, month, items, nameOf, prev) {
  var c = MC_counts(items), m = Number(month.slice(5, 7)) + '月', md = function (d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)); };
  if (kind === 'done') return c.punch + c.pend === 0 ? '【月末の締め】' + m + '分の締めが完了しました✨（申請していない打刻漏れ・承認待ちの申請は0件です）' : '';
  var head = '【月末の締め】' + m + '分' + (kind === 'final' ? '・最終の確認（今日が締めの日です）' : '');
  if (c.punch + c.pend === 0) return head + '\n申請していない打刻漏れ・承認待ちの申請はありません✨';
  var lines = [head];
  var tots = Object.keys(items.punch).sort(function (a, b) { return items.punch[a][0] < items.punch[b][0] ? -1 : 1; });
  lines.push('', '① 申請していない打刻漏れ：' + c.punch + '件（' + tots.length + '人）');
  tots.forEach(function (t) { lines.push('・' + (nameOf(t) || 'TOT ' + t) + '：' + items.punch[t].map(md).join('、')); });
  if (!tots.length) lines.push('・なし');
  var byPerson = {};
  items.pend.forEach(function (p) { var t = AC_totKey(p.tot); (byPerson[t] = byPerson[t] || []).push(p); });
  lines.push('', '② 承認待ちの申請：' + c.pend + '件（Touch On Time で承認をお願いします）');
  Object.keys(byPerson).forEach(function (t) {
    var ps = byPerson[t], kinds = {};
    ps.forEach(function (p) { kinds[p.type] = (kinds[p.type] || 0) + 1; });
    lines.push('・' + (nameOf(t) || 'TOT ' + t) + '：' + Object.keys(kinds).map(function (k) { return k + ' ' + kinds[k] + '件'; }).join('、'));
  });
  if (!items.pend.length) lines.push('・なし');
  if (prev) lines.push('', '③ 前日から：打刻漏れ ' + MC_diff(prev.punch, c.punch) + '／承認待ち ' + MC_diff(prev.pend, c.pend));
  if (kind === 'final' && tots.length) lines.push('', '①の方は、上長から本人へ申請するよう連絡をお願いします🙏（今日中に申請がなければ、来月の扱いになります）');
  return lines.join('\n');
}
function MC_diff(a, b) { return a === b ? '変わらず（' + b + '件）' : a + '件 → ' + b + '件'; }

/** トリガー（毎朝8時台）。手動で実行してもよい（同じ日の2回目は何もしない） */
function monthCloseDaily() {
  var props = PropertiesService.getScriptProperties(), mode = String(props.getProperty('MONTH_CLOSE_NOTIFY') || '').trim();
  if (mode !== 'record' && mode !== 'on') return null;
  var today = AC_today_(), ph = MC_phase(today);
  if (!ph.kind) return null;
  var state = AC_state_(), doneKey = 'mclose:' + today;
  if (state.getProperty(doneKey)) { Logger.log('月末の締め：今日はもう実行済み'); return null; }
  try {
    var d = AC_weeklyPunchData_(today);
    if (!d.R) { AC_adminNotice_('monthclose', '【エラー】月末の締めの確認ができませんでした🙇‍♀️\n（' + d.reason + '）'); return null; }
    var mv = AC_masterSheet_().getDataRange().getValues();
    if (ph.kind === 'eve') {   // 本人へ「締め前の最後のお願い」
      var res = AC_weeklyPunchRun_(d.R, mv, today, { mode: mode, live: mode === 'on' && props.getProperty('DRY_RUN') === 'false',
        period: ph.month, tag: 'monthclose', label: '（月末の締め前のお願い）', head: '【今月の締め前の最後のお願いです】\n' });
      state.setProperty(doneKey, new Date().toISOString());
      Logger.log('月末の締め（前日・' + mode + '）：' + (res.ok ? '送る人 ' + res.counts.people + '人・送信 ' + res.counts.sent + '人・記録 ' + res.counts.recorded + '人' : res.reason));
      return res;
    }
    if (typeof OT_isBusinessDay === 'function' && !OT_isBusinessDay(today, typeof OT_offDates_ === 'function' ? OT_offDates_() : [])) { Logger.log('月末の締め：土日祝のためまとめは作らない'); return null; }
    var items = MC_items(d.R, today, ph.month);
    if (!items.ok) { AC_adminNotice_('monthclose', '【エラー】月末の締めの確認ができませんでした🙇‍♀️\n（' + items.reason + '）'); return null; }
    var codeOfTot = AC_codeByTot(mv), names = AC_nameByCode_(mv), nameOf = function (t) { var c = codeOfTot[t]; return c ? names[c] || '' : ''; };
    var prevRaw = state.getProperty('mclose:last:' + ph.month), prev = prevRaw ? JSON.parse(prevRaw) : null;
    var text = MC_text(ph.kind, ph.month, items, nameOf, prev);
    state.setProperty('mclose:last:' + ph.month, JSON.stringify(MC_counts(items)));
    state.setProperty(doneKey, new Date().toISOString());
    if (text) AC_pushLine_(text);
    Logger.log('月末の締め（' + ph.kind + '・' + ph.month + '）：' + JSON.stringify(MC_counts(items)));
    return text;
  } catch (e) {
    Logger.log('月末の締めの処理エラー：%s', e && e.message);
    AC_adminNotice_('monthclose', '【エラー】月末の締めの処理で問題がありました🙇‍♀️\n（' + (e && e.message ? e.message : '不明なエラー') + '）');
    return null;
  }
}

/** 確認用（送らない・記録しない）：今日の日付として day（YYYY-MM-DD）を指定すると、その日のまとめの文をログに出す */
function monthClosePreview(day) {
  var data = AC_readTotLatest_();
  if (!data) { Logger.log('tot-latest.json が無い'); return null; }
  var today = day || String(data.today), ph = MC_phase(today);
  var mv = AC_masterSheet_().getDataRange().getValues(), codeOfTot = AC_codeByTot(mv), names = AC_nameByCode_(mv);
  var items = MC_items(data.results || {}, today, ph.month || today.slice(0, 7));
  if (!items.ok) { Logger.log(items.reason); return null; }
  Logger.log('（' + today + '・' + (ph.kind || '対象外の日') + '）件数：' + JSON.stringify(MC_counts(items)));
  return MC_counts(items);
}

/** トリガー：毎朝8時台（monthCloseDaily）。同じ関数のトリガーがあれば作らない */
function monthCloseSetupTrigger() {
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'monthCloseDaily'; });
  if (!has) ScriptApp.newTrigger('monthCloseDaily').timeBased().everyDays(1).atHour(8).inTimezone(AC_TZ).create();
}
function monthCloseRemoveTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'monthCloseDaily') ScriptApp.deleteTrigger(t); });
}

if (typeof module !== 'undefined') module.exports = Object.assign(module.exports || {}, { MC_phase: MC_phase, MC_items: MC_items, MC_text: MC_text, MC_counts: MC_counts });
