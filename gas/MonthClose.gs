/**
 * 月末の勤怠の締め（gas/MonthClose.gs・版 2026-11-20h）。業務マニュアル M02「月末の勤怠締めの確認」の AI 化。
 * 本人の申請の締め日は翌月3日（勤怠・経費・交通費とも。作業員はシフト制なので土日祝でも日付どおり）。
 *
 * 本人へ（トリガー monthClosePersonal・毎朝9時台。LINE の通数を抑えるため、送るのは「やることが残っている人」だけ）：
 *   - 毎月1日：前月分で申請していない打刻漏れがある本人へ、締めの案内（業務一覧ファイルの「毎月1日の案内」タブの文）＋その人の申請していない日
 *     （打刻漏れの無い人は、管理本部が全体LINE（個人LINEのグループ）に貼る案内で知る。貼る文は同じタブにAIが毎朝作る）
 *   - 毎月3日：前月分の「申請していない打刻漏れ」「交通費申請が届いていない（TRAVEL_APPLY_MODE=on のとき）」がある本人へ、最終のお願い（1人1通にまとめる）
 *   毎週月曜の催促と同じ作り（AC_weeklyPunchRun_）。同じ月・同じお願いは1人1通。お知らせ設定・停止中・LINE 未登録は今までどおり外す
 * 勤怠管理グループへ（トリガー monthCloseDaily・毎朝8時台）：
 *   - 毎月4日（土日祝・OFFICE_TASK_OFF_DATES なら次の平日・10日まで）に「勤怠の締め確定」を単独で送る＝締め日を過ぎて残っている人
 *     （①申請していない打刻漏れ ②承認待ちの申請 ③交通費申請が届いていない人）。0件なら「締めが完了しました」。ほかの日は送らない
 *   - 毎朝、「毎月1日の案内」タブの「全体LINEに貼る文」を作り直す（次の1日の分。1〜3日は今月1日の分）
 *
 * スクリプトプロパティ：MONTH_CLOSE_NOTIFY  未設定・off＝何もしない／record＝本人へは送らず記録だけ（グループへは送る）／on＝送る
 * データ：朝の tot-latest.json（今朝のデータでなければ何もしない）
 */
var MC_VERSION = '2026-11-20h';
var MC_TAB = '毎月1日の案内';
var MC_ROW = { notice: '今月のお知らせ', closeDay: '本人の締め日（翌月◯日）', receiptDay: '領収書の必着日（翌月◯日）', template: '案内の文（ひな形）',
  groupText: '全体LINEに貼る文（自動）', groupFor: 'いつの案内か（自動）' };

/** 純粋関数：今日することと対象の月。{ kind: 'notice'|'deadline'|'final'|null, month: 'YYYY-MM' } */
function MC_phase(today) {
  var d = Number(today.slice(8, 10)), prev = AC_addMonths(today.slice(0, 7), -1);
  if (d === 1) return { kind: 'notice', month: prev };
  if (d === 3) return { kind: 'deadline', month: prev };
  if (d >= 4 && d <= 10) return { kind: 'final', month: prev };
  return { kind: null, month: '' };
}

/** 純粋関数：ymd が平日でなければ次の平日（OT_isBusinessDay が無ければそのまま） */
function MC_nextBusinessDay(ymd, offDates) {
  if (typeof OT_isBusinessDay !== 'function') return ymd;
  for (var i = 0; i < 14 && !OT_isBusinessDay(ymd, offDates || []); i++) ymd = AC_addDays_(ymd, 1);
  return ymd;
}
function MC_mdw(ymd) { return Number(ymd.slice(5, 7)) + '月' + Number(ymd.slice(8, 10)) + '日（' + '日月火水木金土'.charAt(new Date(ymd + 'T00:00:00+09:00').getDay()) + '）'; }
function MC_pad(n) { return ('0' + n).slice(-2); }

/**
 * 純粋関数：案内の日付。month＝対象の月（前月）。cfg＝{ closeDay, receiptDay }。
 * 締め日は日付どおり（本人の締め）、領収書の必着日は管理本部が受け取る日なので土日祝なら次の平日
 */
function MC_dates(month, cfg, offDates) {
  var next = AC_addMonths(month, 1), close = next + '-' + MC_pad(Number(cfg.closeDay) || 3);
  var receipt = MC_nextBusinessDay(next + '-' + MC_pad(Number(cfg.receiptDay) || 5), offDates);
  return { close: close, receipt: receipt };
}

/** 純粋関数：申請していない打刻の段落（日が無ければ ''） */
function MC_punchBlock(month, dates, kinds) {
  if (!dates || !dates.length) return '';
  var md = function (d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)) + '（' + '日月火水木金土'.charAt(new Date(d + 'T00:00:00+09:00').getDay()) + '）'; };
  return '【申請が確認できていない打刻（' + Number(month.slice(5, 7)) + '月分）】\n'
    + dates.map(function (d) { var k = kinds && kinds[d]; return '・' + md(d) + (k ? AC_punchKindLabel(k) : ''); }).join('\n')
    + '\n' + AC_weeklyPunchGuides(dates, kinds).join('\n');
}

/** 純粋関数：ひな形に入れる。{前月}{締め日}{必着日}{お知らせ}{打刻}。空の段落は詰める */
function MC_render(template, month, d, notice, punch) {
  var t = String(template || '').replace(/\r\n?/g, '\n')
    .split('{前月}').join(Number(month.slice(5, 7)) + '月')
    .split('{締め日}').join(MC_mdw(d.close))
    .split('{必着日}').join(MC_mdw(d.receipt))
    .split('{お知らせ}').join(String(notice || '').trim())
    .split('{打刻}').join(punch || '');
  return t.replace(/[ \t　]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4900);
}

/** 純粋関数：3日の最終のお願い（打刻漏れ・交通費をまとめて1通） */
function MC_deadlineMessage(month, d, punch, travel, changes, name) {
  var m = Number(month.slice(5, 7)) + '月', parts = ['お疲れ様です😊\n【本日' + MC_mdw(d.close) + 'は、' + m + '分の締め日です】'];
  if (punch) parts.push(punch);
  if (changes && changes.length) parts.push(AC_formChangeBlock(changes, name));
  if (travel) parts.push('【交通費の申請】\n' + m + '分の交通費申請がまだ届いていません。\n本日中に、申請書の写真をこちらのLINEへ送ってください。');
  parts.push('本日中のご対応をお願いいたします🙏\n期日を過ぎたものは、翌月以降の扱いになりますのでご注意ください。\n\nよろしくお願いいたします！');
  return parts.join('\n\n').slice(0, 4900);
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

/** 純粋関数：4日の「勤怠の締め確定」の文。nameOf(TOTコード) → 氏名。travel＝交通費申請が届いていない人の氏名の配列（交通費を見ないときは null） */
function MC_finalText(month, d, items, nameOf, travel) {
  var c = MC_counts(items), m = Number(month.slice(5, 7)) + '月', nt = travel ? travel.length : 0;
  var md = function (x) { return Number(x.slice(5, 7)) + '/' + Number(x.slice(8, 10)); };
  if (c.punch + c.pend + nt === 0) return '【勤怠の締め確定】' + m + '分の締めが完了しました✨\n（申請していない打刻漏れ・承認待ちの申請' + (travel ? '・未提出の交通費申請' : '') + 'は0件です）';
  var lines = ['【勤怠の締め確定】' + m + '分（本人の締め日 ' + md(d.close) + ' を過ぎて残っている分）'];
  var tots = Object.keys(items.punch).sort(function (a, b) { return items.punch[a][0] < items.punch[b][0] ? -1 : 1; });
  lines.push('', '① 申請していない打刻漏れ：' + c.punch + '件（' + tots.length + '人）');
  tots.forEach(function (t) { lines.push('・' + (nameOf(t) || 'TOT ' + t) + '：' + items.punch[t].map(md).join('、')); });
  if (!tots.length) lines.push('・なし');
  var byPerson = {};
  items.pend.forEach(function (p) { var t = AC_totKey(p.tot); (byPerson[t] = byPerson[t] || []).push(p); });
  lines.push('', '② 承認待ちの申請：' + c.pend + '件（Touch On Time で承認をお願いします）');
  Object.keys(byPerson).forEach(function (t) {
    var kinds = {};
    byPerson[t].forEach(function (p) { kinds[p.type] = (kinds[p.type] || 0) + 1; });
    lines.push('・' + (nameOf(t) || 'TOT ' + t) + '：' + Object.keys(kinds).map(function (k) { return k + ' ' + kinds[k] + '件'; }).join('、'));
  });
  if (!items.pend.length) lines.push('・なし');
  if (travel) {
    lines.push('', '③ 交通費申請が届いていない人：' + nt + '人');
    travel.forEach(function (n) { lines.push('・' + n); });
    if (!nt) lines.push('・なし');
  }
  if (tots.length || nt) lines.push('', '残っている方の上長へ、ご連絡をお願いします🙏');
  return lines.join('\n');
}

// ---------------- 「毎月1日の案内」タブ（業務一覧ファイル） ----------------
/** タブを読む → { ok, reason, sheet, rows: { 項目名: 行番号 }, cfg: { notice, closeDay, receiptDay, template } } */
function MC_config_() {
  var sh;
  try { sh = OT_book_().getSheetByName(MC_TAB); } catch (e) { return { ok: false, reason: '業務一覧ファイルを開けない' }; }
  if (!sh) return { ok: false, reason: '業務一覧ファイルに「' + MC_TAB + '」タブが無い' };
  var v = sh.getDataRange().getValues(), rows = {}, val = {};
  for (var i = 0; i < v.length; i++) { var k = String(v[i][0] || '').trim(); if (k) { rows[k] = i + 1; val[k] = v[i][1]; } }
  var cfg = { notice: String(val[MC_ROW.notice] || ''), closeDay: Number(val[MC_ROW.closeDay]) || 3, receiptDay: Number(val[MC_ROW.receiptDay]) || 5,
    template: String(val[MC_ROW.template] || '') };
  if (cfg.template.indexOf('{打刻}') === -1) return { ok: false, reason: '「' + MC_TAB + '」タブの「' + MC_ROW.template + '」が空か、{打刻} が無い' };
  return { ok: true, reason: '', sheet: sh, rows: rows, cfg: cfg };
}

/** 毎朝：全体LINEに貼る文を作り直す（次の1日の分。1〜3日は今月1日の分） */
function MC_refreshGroupText_(today, conf) {
  if (!conf.ok || !conf.rows[MC_ROW.groupText]) return;
  var first = Number(today.slice(8, 10)) <= 3 ? today.slice(0, 7) + '-01' : AC_addMonths(today.slice(0, 7), 1) + '-01';
  var month = AC_addMonths(first.slice(0, 7), -1), d = MC_dates(month, conf.cfg, MC_offDates_());
  conf.sheet.getRange(conf.rows[MC_ROW.groupText], 2).setValue(MC_render(conf.cfg.template, month, d, conf.cfg.notice, ''));
  if (conf.rows[MC_ROW.groupFor]) conf.sheet.getRange(conf.rows[MC_ROW.groupFor], 2).setValue(MC_mdw(first) + 'の案内（' + Number(month.slice(5, 7)) + '月分）');
}
function MC_offDates_() { return typeof OT_offDates_ === 'function' ? OT_offDates_() : []; }

/** 交通費申請が届いていない人（TRAVEL_APPLY_MODE=on のときだけ。それ以外・読めないときは null）→ [{ code, name, userId }] */
function MC_travelMissing_(today, month) {
  try {
    if (typeof TA_mode_ !== 'function' || TA_mode_() !== 'on') return null;
    var ss = TRV_book_(), st = TA_load_(ss);
    return TA_remindTargets(TA_people_(today), TRV_commuteInputs(TRV_sheetValues_(ss, TRV_COMMUTE_SHEET)), st.apps, month);
  } catch (e) { Logger.log('月末の締め：交通費申請の状況を読めませんでした'); return null; }
}

// ---------------- トリガー ----------------
/** 本人へ（トリガー・毎朝9時台）。1日と3日だけ送る。手動で実行してもよい（同じ月の2回目は送らない） */
function monthClosePersonal() {
  var props = PropertiesService.getScriptProperties(), mode = String(props.getProperty('MONTH_CLOSE_NOTIFY') || '').trim();
  if (mode !== 'record' && mode !== 'on') return null;
  var today = AC_today_(), ph = MC_phase(today);
  if (ph.kind !== 'notice' && ph.kind !== 'deadline') return null;
  var label = ph.kind === 'notice' ? '1日の締めの案内' : '3日の締め日のお願い';
  try {
    var d = AC_weeklyPunchData_(today);
    if (!d.R) { AC_adminNotice_('monthclose', '【エラー】' + label + 'を送れませんでした🙇‍♀️\n（' + d.reason + '）'); return null; }
    var mv = AC_masterSheet_().getDataRange().getValues(), live = mode === 'on' && props.getProperty('DRY_RUN') === 'false';
    var dates = MC_dates(ph.month, { closeDay: 3, receiptDay: 5 }, MC_offDates_()), conf = null, travel = null, travelBy = {}, covered = {};
    if (ph.kind === 'notice') {
      conf = MC_config_();
      if (!conf.ok) { AC_adminNotice_('monthclose', '【エラー】' + label + 'を送れませんでした🙇‍♀️\n（' + conf.reason + '）'); return null; }
      dates = MC_dates(ph.month, conf.cfg, MC_offDates_());
    } else {
      travel = MC_travelMissing_(today, ph.month);
      (travel || []).forEach(function (p) { travelBy[p.code] = p; });
    }
    var o = { mode: mode, live: live, period: ph.month, tag: ph.kind === 'notice' ? 'monthnotice' : 'monthclose3', label: '（' + label + '）',
      range: { from: ph.month + '-01', to: AC_addMonths(ph.month, 1) + '-01' },
      message: function (ds, kinds, changes, name, code) {
        var punch = MC_punchBlock(ph.month, ds, kinds);
        if (ph.kind === 'notice') return MC_render(conf.cfg.template, ph.month, dates, conf.cfg.notice, punch + (changes && changes.length ? (punch ? '\n\n' : '') + AC_formChangeBlock(changes, name) : ''));
        if (travelBy[code]) covered[code] = 1;
        return MC_deadlineMessage(ph.month, dates, punch, !!travelBy[code], changes, name);
      } };
    var res = AC_weeklyPunchRun_(d.R, mv, today, o);
    if (!res.ok) { AC_adminNotice_('monthclose', '【エラー】' + label + 'を送れませんでした🙇‍♀️\n（' + res.reason + '）'); return null; }
    var tSent = 0, tRec = 0;
    if (travel) {   // 3日：交通費だけが残っている人へ（打刻漏れの文に入れた人は、同じ1通で知らせ済み）
      var state = AC_state_();
      travel.forEach(function (p) {
        var key = 'sent:' + ph.month + ':ta-remind:' + p.code;   // 交通費申請AI（travelApplyRemind）と同じ印。同じ月・同じ人は1回
        if (covered[p.code]) { if (live) state.setProperty(key, new Date().toISOString()); return; }
        if (state.getProperty(key)) return;
        if (!live) { tRec++; return; }
        try { AC_pushSelf_(p.userId, MC_deadlineMessage(ph.month, dates, '', true, null, '')); state.setProperty(key, new Date().toISOString()); tSent++; }
        catch (e) { Logger.log('交通費だけのお願いの送信に失敗'); }
      });
    }
    Logger.log('月末の締め（本人・' + ph.kind + '・' + mode + '）：打刻 送る人 ' + res.counts.people + '人・送信 ' + res.counts.sent + '人・記録 ' + res.counts.recorded + '人'
      + (travel ? '／交通費だけ 送信 ' + tSent + '人・記録 ' + tRec + '人' : ''));
    return { punch: res.counts, travelSent: tSent, travelRecorded: tRec };
  } catch (e) {
    Logger.log('月末の締め（本人）の処理エラー：%s', e && e.message);
    AC_adminNotice_('monthclose', '【エラー】' + label + 'で問題がありました🙇‍♀️\n（' + (e && e.message ? e.message : '不明なエラー') + '）');
    return null;
  }
}

/** 勤怠管理グループ（トリガー・毎朝8時台）：4日（平日でなければ次の平日）に「勤怠の締め確定」を単独で送る。毎朝、全体LINEに貼る文も作り直す */
function monthCloseDaily() {
  var props = PropertiesService.getScriptProperties(), mode = String(props.getProperty('MONTH_CLOSE_NOTIFY') || '').trim();
  if (mode !== 'record' && mode !== 'on') return null;
  var today = AC_today_(), ph = MC_phase(today);
  try { MC_refreshGroupText_(today, MC_config_()); } catch (e0) { Logger.log('「' + MC_TAB + '」タブの更新に失敗'); }
  if (ph.kind !== 'final') return null;
  var state = AC_state_(), finalKey = 'mclose:final:' + ph.month;
  if (state.getProperty(finalKey)) return null;   // 締め確定は1回だけ
  if (typeof OT_isBusinessDay === 'function' && !OT_isBusinessDay(today, MC_offDates_())) { Logger.log('月末の締め：土日祝のため、締め確定は次の平日'); return null; }
  try {
    var d = AC_weeklyPunchData_(today);
    if (!d.R) { AC_adminNotice_('monthclose', '【エラー】勤怠の締め確定を作れませんでした🙇‍♀️\n（' + d.reason + '）'); return null; }
    var items = MC_items(d.R, today, ph.month);
    if (!items.ok) { AC_adminNotice_('monthclose', '【エラー】勤怠の締め確定を作れませんでした🙇‍♀️\n（' + items.reason + '）'); return null; }
    var mv = AC_masterSheet_().getDataRange().getValues(), codeOfTot = AC_codeByTot(mv), names = AC_nameByCode_(mv);
    var nameOf = function (t) { var c = codeOfTot[t]; return c ? names[c] || '' : ''; };
    var travel = MC_travelMissing_(today, ph.month);
    var text = MC_finalText(ph.month, MC_dates(ph.month, { closeDay: 3, receiptDay: 5 }, MC_offDates_()), items, nameOf,
      travel ? travel.map(function (p) { return p.name || names[p.code] || p.code; }) : null);
    state.setProperty(finalKey, new Date().toISOString());
    if (typeof INQ_send_ === 'function') INQ_send_([{ type: 'text', text: text }], text, 'admin');   // 朝のまとめを待たず、勤怠管理グループへ単独で
    else AC_pushLine_(text);
    Logger.log('月末の締め（締め確定・' + ph.month + '）：' + JSON.stringify(MC_counts(items)) + (travel ? '・交通費 ' + travel.length + '人' : ''));
    return text;
  } catch (e) {
    Logger.log('月末の締めの処理エラー：%s', e && e.message);
    AC_adminNotice_('monthclose', '【エラー】勤怠の締め確定の処理で問題がありました🙇‍♀️\n（' + (e && e.message ? e.message : '不明なエラー') + '）');
    return null;
  }
}

/** 確認用（送らない・記録しない）：今日の日付として day（YYYY-MM-DD）を指定すると、その日の対象の月の件数をログに出す。タブの文も作り直す */
function monthClosePreview(day) {
  var data = AC_readTotLatest_();
  if (!data) { Logger.log('tot-latest.json が無い'); return null; }
  var today = day || String(data.today), ph = MC_phase(today), month = ph.month || AC_addMonths(today.slice(0, 7), Number(today.slice(8, 10)) > 10 ? 0 : -1);
  try { var conf = MC_config_(); MC_refreshGroupText_(today, conf); Logger.log('「' + MC_TAB + '」タブ：' + (conf.ok ? '読めた' : conf.reason)); } catch (e) { Logger.log('タブの更新に失敗'); }
  var items = MC_items(data.results || {}, today, month);
  if (!items.ok) { Logger.log(items.reason); return null; }
  var travel = MC_travelMissing_(today, month);
  Logger.log('（' + today + '・' + (ph.kind || '対象外の日') + '・' + month + '）件数：' + JSON.stringify(MC_counts(items)) + '・交通費 ' + (travel ? travel.length + '人' : '見ない'));
  return MC_counts(items);
}

/** トリガー：毎朝8時台（monthCloseDaily・グループ）と9時台（monthClosePersonal・本人へ）。同じ関数のトリガーがあれば作らない */
function monthCloseSetupTrigger() {
  var has = function (f) { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === f; }); };
  if (!has('monthCloseDaily')) ScriptApp.newTrigger('monthCloseDaily').timeBased().everyDays(1).atHour(8).inTimezone(AC_TZ).create();
  if (!has('monthClosePersonal')) ScriptApp.newTrigger('monthClosePersonal').timeBased().everyDays(1).atHour(9).inTimezone(AC_TZ).create();
}
function monthCloseRemoveTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { var f = t.getHandlerFunction(); if (f === 'monthCloseDaily' || f === 'monthClosePersonal') ScriptApp.deleteTrigger(t); });
}

if (typeof module !== 'undefined') module.exports = Object.assign(module.exports || {}, { MC_phase: MC_phase, MC_items: MC_items, MC_counts: MC_counts,
  MC_dates: MC_dates, MC_render: MC_render, MC_punchBlock: MC_punchBlock, MC_deadlineMessage: MC_deadlineMessage, MC_finalText: MC_finalText, MC_nextBusinessDay: MC_nextBusinessDay });
