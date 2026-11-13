/**
 * 確認用（読み取りだけ）：保存済みの tot-latest.json の日別スケジュール（schedules）と日別勤怠（workings）が、
 * 欠勤・有給・休日・出勤の日にどう表れているかを、項目名と件数だけで出す（Touch On Time のスケジュールへの自動反映の設計のため）。
 *
 * 使い方：本番の Apps Script の tmpSetup.gs に一時的に貼り、scheduleShapeCheck を実行する。終わったら tmpSetup.gs を元に戻す。
 *   コード.gs の AC_readTotLatest_・AC_totLatestFile_・AC_totFlat_ を使う。朝7:05 の後〜22:30 より前に実行する（朝のデータ）。
 *   schedules は「今日〜30日先」、workings は「前月1日〜昨日」（中継 src/tot-relay.js の取り方）。過去の欠勤・有給は workings に出る。
 *
 * ログに出すもの：項目名（キー）と、その項目がある件数／勤務日種別名・スケジュール種別名・休暇区分名と休暇区分コードの組ごとの件数／
 *   出勤予定時刻の有無と休暇の有無の組み合わせの件数。
 * ログに出さないもの：氏名・社員番号・TOTコード・従業員識別キー・時刻・備考。LINEの送信・シート・ファイル・設定への書き込みはしない。
 */
function scheduleShapeCheck() {
  var data = AC_readTotLatest_();
  if (!data) { Logger.log('スケジュールの形の確認：tot-latest.json が無い、または読めません'); return null; }
  var file = AC_totLatestFile_();
  var updated = file ? Utilities.formatDate(file.getLastUpdated(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : '不明';
  var R = data.results || {}, out = { today: String(data.today || ''), mode: String(data.mode || '') };
  var lines = ['スケジュールの形の確認：データ ' + out.today + '（' + (out.mode || '取り込みの種類が不明') + '）・ファイルの更新 ' + updated];
  var count = function (m, k) { k = k === undefined || k === null || k === '' ? '（空）' : String(k); m[k] = (m[k] || 0) + 1; };
  var show = function (m) { return Object.keys(m).sort().map(function (k) { return k + ' ' + m[k] + '件'; }).join('／') || 'なし'; };
  var hol = function (x) { var f = x && x.holidaysObtained && x.holidaysObtained.fulltimeHoliday; return f && (f.name || f.code) ? f : null; };
  var halfs = function (x) { return (x && x.holidaysObtained && x.holidaysObtained.halfdayHolidays) || []; };
  var hours = function (x) { return (x && x.holidaysObtained && x.holidaysObtained.hourHolidays) || []; };
  var summarize = function (label, raw, dayType, hasPlan) {
    if (!Array.isArray(raw) || raw.some(function (d) { return d && d._error; })) { lines.push('■ ' + label + '：データが無い、または読み取りエラー'); return null; }
    var rows = AC_totFlat_(raw), keys = {}, holKeys = {}, types = {}, stypes = {}, full = {}, half = {}, hour = {}, combo = {}, subst = 0;
    rows.forEach(function (x) {
      Object.keys(x || {}).forEach(function (k) { count(keys, k); });
      Object.keys((x && x.holidaysObtained) || {}).forEach(function (k) { count(holKeys, k); });
      count(types, x[dayType]);
      if ('scheduleTypeName' in (x || {})) count(stypes, x.scheduleTypeName);
      var f = hol(x);
      if (f) count(full, String(f.name || '') + '（code ' + String(f.code == null ? '' : f.code) + '）');
      halfs(x).forEach(function (h) { count(half, String(h.typeName || '') + '・' + String(h.name || '') + '（code ' + String(h.code == null ? '' : h.code) + '）'); });
      hours(x).forEach(function (h) { count(hour, String(h.name || '') + '（code ' + String(h.code == null ? '' : h.code) + '）'); });
      if (x && x.substitutionClockInName) subst++;
      count(combo, (hasPlan(x) ? '時刻あり' : '時刻なし') + '・' + (f ? '全日休暇あり' : '全日休暇なし') + '・' + String(x[dayType] || '（勤務日種別なし）'));
    });
    lines.push('■ ' + label + '：' + rows.length + '件',
      '項目名：' + show(keys), 'holidaysObtained の中の項目名：' + show(holKeys),
      '勤務日種別名（' + dayType + '）：' + show(types), 'スケジュール種別名（scheduleTypeName）：' + show(stypes),
      '全日休暇（休暇区分名とコード）：' + show(full), '半日休暇：' + show(half), '時間休暇：' + show(hour),
      '振替出勤（substitutionClockInName）がある件数：' + subst, '組み合わせ：' + show(combo));
    return { rows: rows.length, keys: keys, types: types, full: full, combo: combo };
  };
  out.schedules = summarize('日別スケジュール（schedules・今日〜30日先）', R.schedules, 'workDayTypeName', function (x) { return !!(x && x.clockInSchedule); });
  out.workings = summarize('日別勤怠（workings・前月1日〜昨日）', R.workings, 'workdayTypeName', function (x) { return !!(x && (Number(x.assigned) > 0 || Number(x.totalWork) > 0)); });
  lines.push('（workings の「時刻あり」は、所定時間 assigned か労働合計 totalWork が0より大きい日）');
  Logger.log(lines.join('\n'));
  return out;
}
