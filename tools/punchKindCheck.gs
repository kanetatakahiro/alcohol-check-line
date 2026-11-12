/**
 * 確認用（読み取りだけ）：打刻漏れの日に、出勤・退勤のどちらが無いかを打刻の数で見分けられるかを確かめる。
 *
 * 使い方：本番の Apps Script の tmpSetup.gs に一時的に貼り、punchKindCheck を実行する。終わったら tmpSetup.gs を元に戻す。
 *   コード.gs（版 2026-11-12a 以降）の AC_readTotLatest_・AC_totLatestFile_・AC_totFlat_・AC_totCodeByKey_・AC_addDays_ を使う。
 *
 * 中身：保存済みの tot-latest.json（朝7:05のデータ）の日別勤怠で、TOTのエラー勤務（isError）の日を、
 *   同じ人・同じ日の日別打刻（timerecord）の数で次の5つに分け、件数だけを実行ログに出す。
 *     出勤 > 退勤（code 1 の数が code 2 の数より多い）／退勤 > 出勤／打刻なし（出勤・退勤とも0）／同じ数（1以上で同じ）／timerecord の期間外
 *   打刻の種類は King of Time の API の資料のとおり（code 1：出勤、2：退勤。3・4 の休憩などは数えない）。
 *   timerecord の期間は、中継（src/tot-relay.js）の取り方どおり、朝は7日前〜昨日、夜は7日前〜今日。
 *   「直近7日」は夜のお知らせ（E-40）・管理本部の本人へのお知らせ（E-42）の対象と同じ（昨日から7日前まで）。
 *
 * 氏名・社員番号・TOTコード・時刻はログに出さない。LINEの送信・シート・ファイル・設定への書き込みはしない。
 */
function punchKindCheck() {
  var data = AC_readTotLatest_();
  if (!data) { Logger.log('打刻の種類の確認：tot-latest.json が無い、または読めません'); return null; }
  var R = data.results || {}, today = String(data.today || ''), mode = String(data.mode || '');
  var file = AC_totLatestFile_();
  var updated = file ? Utilities.formatDate(file.getLastUpdated(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : '不明';
  Logger.log('打刻の種類の確認：データ ' + today + '（' + (mode === 'morning' ? '朝の取り込み' : mode === 'night' ? '夜の取り込み' : '取り込みの種類が不明')
    + '）・ファイルの更新 ' + updated);
  if (mode !== 'morning') Logger.log('注意：朝のデータではありません（22:30 より後は夜のデータ）。朝7:05 の後〜22:30 より前に実行してください');
  var bad = function (a) { return !Array.isArray(a) || a.some(function (x) { return x && x._error; }); };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || bad(R.workings) || bad(R.timerecord) || !Array.isArray(R.employees)) {
    Logger.log('打刻の種類の確認：日別勤怠・日別打刻・従業員のデータが無い、または読み取りエラーがあるため、数えません');
    return null;
  }
  var from = AC_addDays_(today, -7), to = mode === 'night' ? today : AC_addDays_(today, -1);
  var codeByKey = AC_totCodeByKey_(R.employees);
  var punches = {};
  AC_totFlat_(R.timerecord).forEach(function (t) {
    if (!t || !t.employeeKey || !t.date) return;
    var k = t.employeeKey + ':' + t.date, p = punches[k] = punches[k] || { in: 0, out: 0 };
    (t.timeRecord || []).forEach(function (r) { if (String(r && r.code) === '1') p.in++; if (String(r && r.code) === '2') p.out++; });
  });
  var blank = function () { return { total: 0, inMore: 0, outMore: 0, none: 0, same: 0, outOfRange: 0 }; };
  var all = blank(), recent = blank(), seen = {};
  AC_totFlat_(R.workings).forEach(function (w) {
    if (!w || w.isError !== true || !w.date || w.date >= today || !codeByKey[w.employeeKey]) return;
    var k = w.employeeKey + ':' + w.date;
    if (seen[k]) return;
    seen[k] = 1;
    var kind;
    if (w.date < from || w.date > to) kind = 'outOfRange';
    else {
      var p = punches[k] || { in: 0, out: 0 };
      kind = p.in > p.out ? 'inMore' : p.out > p.in ? 'outMore' : p.in === 0 ? 'none' : 'same';
    }
    all.total++; all[kind]++;
    if (w.date >= from) { recent.total++; recent[kind]++; }
  });
  var line = function (label, c) {
    return label + '：' + c.total + '件（出勤 > 退勤 ' + c.inMore + '件／退勤 > 出勤 ' + c.outMore + '件／打刻なし ' + c.none
      + '件／同じ数 ' + c.same + '件／timerecord の期間外 ' + c.outOfRange + '件）';
  };
  Logger.log('timerecord の期間：' + from + '〜' + to);
  Logger.log(line('エラー勤務の日・直近7日（' + from + '〜' + AC_addDays_(today, -1) + '。E-40・E-42 の対象）', recent));
  Logger.log(line('エラー勤務の日・データ全体（前月1日〜昨日）', all));
  return { today: today, mode: mode, from: from, to: to, recent: recent, all: all };
}
