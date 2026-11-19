/**
 * 交通費申請の受付・読み取り・照合・締切・給与反映シートへの反映（gas/TravelApply.gs・版 2026-11-20a・本番未導入）
 *
 * 流れ：
 *   1. 本人が紙の申請書の写真（複数枚可）を公式LINEに送る。
 *      コード.gs の AC_handleEvent_ で、免許証（LIC_onUserEvent_：「免許更新」から30分の受付中の写真だけ）のあとに TA_onUserEvent_ を呼ぶ。
 *      免許証の受付中でない画像のうち、送った人が在籍・LINE確認済みで、「通勤距離」の通勤区分が申請の対象（TA_APPLY_TYPES）のときだけ AI で読む。
 *      AI が「交通費の申請書ではない」と答えた画像は扱わず、今までどおり問い合わせ（Inquiry.gs）へ流す。
 *   2. 読み取り：License.gs の写真の取り出し（LIC_fetchPhoto_）・API の宛先・版・既定のモデル・ANTHROPIC_API_KEY を共用する。
 *      読めない文字・数字は推測で埋めず、その欄を空にして「要確認」にする。
 *      申請書（v2・版 2026-11-19f）：1行目に対象（年・月分）／社員番号／氏名。表の上の薄い文字の「記入例：」の行は読まない。
 *      表は No／日付／方法（車・バイク・電車・バスのどれか1つに○）／出発地／到着地／往復・片道（どちらかに○）／片道（km）／合計（km）／運賃（円）の30行。
 *      高速料金・備考の欄は無い（高速・駐車場は立替経費で別に申請する）。
 *      申請書 v3（版 2026-11-19g）：右上に「枚数：□枚目／全□枚」。表は1枚25行。下の合計欄は4つ（どれもその用紙の分）：
 *      ①合計kmの合計（車・バイク）・②車・バイクの金額（①×15円）・③運賃の合計（電車・バス）・④交通費の合計（②＋③）。
 *   3. 照合（受付のとき）：車・バイクは TRV_checkSegment（gas/Travel.gs・高速を使わない道と片道5km。片道（km）で照合）・行き先がわからない区間・
 *      往復は 合計km＝片道km×2・片道は 合計km＝片道km（合わなければ要確認。片方しか書いていなければもう片方を計算）・
 *      金額（合計km × TRAVEL_YEN_PER_KM 円）。電車・バスは書かれた運賃のまま（往復でも2倍にしない）。往復・片道の○が無い・両方は要確認。
 *      日付が対象月の中か・同じ日の同じ区間の重複・用紙ごとの合計欄（①〜④。書いていない欄は比べない）。
 *      2枚以上：同じ人・同じ対象月の写真は1つの申請にまとめる。全N枚のうち届いていない枚目があれば申請を要確認（届けば自動で確認済み）。
 *      同じ枚目が2回届いたら、あとの写真を使う（前の写真の明細は「差し替え」にして合計に入れない）。枚数が書いていなければ1枚として扱う（差し替えはしない）。
 *      届いていない枚目の本人への知らせ（版 2026-11-19h）：受付のときの返信には足さない（まとめて送った写真の途中で知らせないため）。
 *      15分ごと（travelApplyPagesRemind）に、最後の写真から1時間たっても届いていない申請だけ、本人へ個別 LINE（8時〜21時台だけ。同じ枚目は1回）。
 *      TOT の出勤の記録は、毎朝の処理（tot-latest.json の日別勤怠）で照合する。
 *   4. 毎朝7時台（travelApplyDaily）：TOT の照合 → 回答が入った行を照合し直して確定 → 要確認の行を「臨時の依頼」（業務一覧ファイル）へ1件1行で追加
 *      （8時の「今日の業務」に出る）。回答が空のまま［完了］になっていたら、確認事項を出し直す。6日は前月の締め（月のタブ・管理者へ一覧）。
 *   5. 締切（版 2026-11-19b）：提出期日は翌月3日。4日 10:00（travelApplyRemind・土日祝も日付どおり）に、前月分が届いていない対象者へ個別 LINE で催促。
 *      前月分として受け付けるのは4日 23:59 まで。5日 0時以降に届いた前月分は「来月反映」（本人にも返信で伝える）。5日は管理本部が要確認に回答する日（臨時の依頼の期限）。
 *   6. 6日の朝（締め）：確定額を給与反映シート（社労士共有用【リバースHD】）の前月のタブ「R{令和}.{M}月分{M+1}月支給」の「通勤手当」に書く
 *      （gas/PayrollSheet.gs の PAY_writeColumn_。タブが無ければ「テンプレ」から作る。すでに値がある欄は上書きせず管理者へ）。
 *      要確認が残る人は書かずに来月へ回し、未提出・要確認・書けなかった人の一覧を管理者へ。区間ごとの明細は従業員マスタのファイルに残す。
 *   7. 固定店舗（日額×出勤日数）（版 2026-11-20a）：通勤区分が「固定店舗（日額×出勤日数）」の人は申請書なし。6日の締めで
 *      「通勤距離」の日額 × 前月の出勤日数を「通勤手当」に書く（PAY_writeColumn_）。出勤日数は tot-latest.json の日別勤怠（workings）で
 *      総労働時間が0より多い日（半日の休暇＋出勤・休日出勤も1日。全日の休暇の日は数えない）。VPS の中継（src/tot-relay.js）は変えない。
 *      前月にエラー勤務の日がある・日額が空・出勤日数が0・前月の日別勤怠がそろっていないときは書かずに要確認にして、管理者への一覧に理由と出す
 *      （直したあと travelApplyCloseAgain）。4日の催促・未提出の一覧の対象外。写真が届いても読まない（ほかの対象外の区分と同じ）。
 *
 * タブ（従業員マスタのファイル。新しいタブだけを足す）：「交通費申請」（1申請1行）・「交通費明細」（1区間1行）・「交通費の送る予定」（record のとき）
 * スクリプトプロパティ：
 *   TRAVEL_APPLY_MODE           off（既定）／record（受け付けて記録するが、LINE・臨時の依頼には送らない。画像は今までどおり問い合わせへも流す）／on
 *   TRAVEL_APPLY_FOLDER_ID      申請書の写真を保存するドライブのフォルダ（閲覧を管理本部に限ったもの）
 *   PAYROLL_SHEET_ID            給与反映シート（社労士共有用【リバースHD】）のスプレッドシート ID（gas/PayrollSheet.gs と共用）
 *   TRAVEL_YEN_PER_KM           車・バイクの 1km あたりの円（既定 15）
 *   TRAVEL_AI_MODEL・TRAVEL_AI_DAILY_MAX  読み取りのモデル（既定は免許証と同じ）・1日の上限（既定 100枚）
 * ログには件数・社員番号・申請ID だけを書く（住所・金額・写真の中身・氏名は書かない）。
 */
var TA_VERSION = '2026-11-20a';
var TA_APPLY_SHEET = '交通費申請', TA_DETAIL_SHEET = '交通費明細', TA_PLAN_SHEET = '交通費の送る予定';
var TA_APPLY_HEADER = ['申請ID', '受付日時', '社員番号', '氏名', '対象月', '反映月', '状態', '合計（円）', '写真', '枚目', '備考'];
var TA_A = { id: 0, at: 1, code: 2, name: 3, target: 4, reflect: 5, status: 6, total: 7, photo: 8, pages: 9, note: 10 };
var TA_DETAIL_HEADER = ['申請ID', '社員番号', '日付', '出発', '到着', '手段', '往復・片道', '片道（km）', '合計（km）', '金額（円）', 'TOT の出勤', '照合結果', '確認事項',
  '回答（管理本部が入力）', '確認後の値（管理本部が入力）', '依頼の行', '枚目'];
var TA_D = { id: 0, code: 1, date: 2, from: 3, to: 4, means: 5, trip: 6, one: 7, km: 8, yen: 9, tot: 10, result: 11, issue: 12, answer: 13, value: 14, req: 15, page: 16 };
var TA_PLAN_HEADER = ['日時', '種類', '宛先', '内容'];
var TA_PAY_COLUMN = '通勤手当';   // 給与反映シートで交通費を書く列
var TA_APPLY_TYPES = ['交通費申請（車・バイク）', '公共交通機関'];   // 写真を受け付ける通勤区分
var TA_REMIND_TYPE = '交通費申請（車・バイク）';                     // 4日の催促・未提出の対象
var TA_FIXED_TYPE = '定期（固定額）';
var TA_DAILY_TYPE = '固定店舗（日額×出勤日数）';   // 版 2026-11-20a：日額 × 前月の出勤日数（申請書なし。gas/Travel.gs の TRV_DAILY_TYPE と同じ）
var TA_DAILY_ISSUE = { noData: 'TOT の前月の日別勤怠がそろっていない', noDaily: '日額が空', error: 'エラー勤務の日がある', zero: '出勤日数が0日' };
var TA_CAR = ['車', 'バイク'], TA_PUBLIC = ['電車', 'バス'], TA_WHOLE = '（申請書全体）';
var TA_MEANS = { car: '車', bike: 'バイク', train: '電車', bus: 'バス', unknown: '' };
var TA_TRIP = { round: '往復', oneway: '片道', unknown: '' };
var TA_KM_EPS = 0.05;   // 片道×2 と合計の比べ方（km の小数1桁まで同じなら同じ）
var TA_OK = 'OK', TA_CHECK = '要確認', TA_DONE = '確認済み', TA_REPLACED = '差し替え';
var TA_TOT_WAIT = '未確認', TA_TOT_YES = 'あり', TA_TOT_NO = 'なし', TA_TOT_UNKNOWN = '確認できない';
var TA_ST = { recv: '受付', check: '要確認', fixed: '確定', next: '来月反映' };
var TA_ACCEPT_DAY = 4, TA_ANSWER_DAY = 5, TA_REMIND_DAY = 4, TA_REMIND_HOUR = 10, TA_DAILY_HOUR = 7, TA_CLOSE_DAY = 6;
var TA_DEFAULT_YEN_PER_KM = 15, TA_AI_DEFAULT_MAX = 100;
var TA_PAGES_WAIT_MS = 3600000, TA_PAGES_EVERY_MIN = 15, TA_PAGES_FROM_HOUR = 8, TA_PAGES_TO_HOUR = 21;   // 枚目の知らせ：最後の写真から1時間・15分ごと・8時〜21時台
var TA_PAGES_WAIT_KEY = 'ta-pages-wait';   // 枚目の知らせを待つ申請（{ 申請ID: 最後の写真の時刻（ミリ秒） }。AC_state_ に置く）
var TA_TEXT = {
  ack: '交通費申請の写真を受け付けました（{month}分・{n}件）。\n内容を確認して、気になる点があれば管理本部からご連絡します。',
  ackNoMonth: '交通費申請の写真を受け付けました（{n}件）。\n対象の月が読み取れなかったため、管理本部で確認します。',
  ackNoRead: '交通費申請の写真を受け付けました。\n内容は管理本部が写真で確認します。',
  late: '\n受付の締切（{deadline}）を過ぎて届いたため、来月のお給料での反映になります。',
  fail: '写真をうまく受け取れませんでした。お手数ですが、もう一度送ってください。',
  pages: '{month}交通費申請書の{pages}枚目が届いていません。写真を送ってください。',
  remind: '先月分の交通費申請がまだ届いていません。本日中に申請書の写真をこちらへ送ってください。5日以降に届いた分は、来月のお給料での反映になります。',
};
/** 確認事項（detail：シートに書く。数字を含んでよい／memo：グループに出る「臨時の依頼」のメモ。金額・住所は書かない／fix：どう直すか） */
var TA_ISSUE = {
  unclear: { memo: '申請書の文字・数字の一部が読み取れませんでした', fix: '写真を見て、読めない欄（{field}）を正しい値に直す' },
  date: { memo: '日付が読み取れませんでした', fix: '写真を見て「日付」の欄を直す' },
  outside: { memo: '日付が対象の月の外です', fix: '写真と本人への確認で「日付」か「対象月」を直す' },
  means: { memo: '手段（車・バイク・電車・バスの○）が読み取れませんでした', fix: '「手段」の欄に 車・バイク・電車・バス のどれかを入れる' },
  trip: { memo: '往復・片道の○が無いか、両方に○が付いています', fix: '写真と本人への確認で、「往復・片道」の欄に 往復 か 片道 を入れる' },
  km: { memo: '距離（km）が読み取れませんでした', fix: '写真を見て「片道（km）」「合計（km）」を直すか、確認後の値に合計の km を入れる' },
  roundKm: { memo: '合計（km）が片道（km）と合いません（往復は片道の2倍・片道は同じ）', fix: '写真を見て「片道（km）」「合計（km）」を直すか、確認後の値に認める合計の km を入れる' },
  yen: { memo: '電車・バスの運賃が読み取れませんでした', fix: '写真を見て、確認後の値に運賃（円）を入れる' },
  place: { memo: '行き先の店舗名・略語がわかりませんでした', fix: '正しい店舗を確かめ、「出発」「到着」を店舗一覧の名前に直す（よく使う書き方なら店舗一覧の略語に足す）' },
  over: { memo: '申請の距離が、自動計算の距離より片道5kmを超えて長くなっています', fix: '本人に道順を確認し、確認後の値に認める km を入れる' },
  calc: { memo: '自動計算の距離がなく、距離を照合できませんでした', fix: '地図で距離を確かめ、確認後の値に認める km を入れる' },
  tot: { memo: 'その日の TOT の出勤の記録がありません', fix: '出勤した日か本人に確認し、回答に結果を書く' },
  totUnknown: { memo: 'その日の TOT の出勤の記録を確認できませんでした', fix: 'TOT で出勤の記録を確かめ、回答に結果を書く' },
  dup: { memo: '同じ日・同じ区間がもう1行あります', fix: '写真を見て二重でないか確かめ、二重なら確認後の値に 0 を入れる' },
  sumKm: { memo: '用紙の「①合計kmの合計」が、各行の合計（km）を足したものと違います', fix: '写真を見て各行の km と①を確かめ、回答に結果を書く' },
  sumCarYen: { memo: '用紙の「②車・バイクの金額」が、①×円/km（四捨五入）と違います', fix: '写真を見て①と②を確かめ、回答に結果を書く（金額は各行の合計km から計算します）' },
  sumFare: { memo: '用紙の「③運賃の合計」が、各行の運賃を足したものと違います', fix: '写真を見て各行の運賃と③を確かめ、回答に結果を書く' },
  sumTotal: { memo: '用紙の「④交通費の合計」が、②＋③と違います', fix: '写真を見て②・③・④を確かめ、回答に結果を書く' },
  pages: { memo: '届いていない枚目があります', fix: '本人に残りの枚目の写真を送ってもらう（届けば自動で確認済みになります）。送らない事情があれば回答に書く' },
  month: { memo: '対象の月が読み取れませんでした', fix: '「交通費申請」タブの「対象月」に 2026-11 のように入れる' },
  norows: { memo: '申請書の明細が読み取れませんでした', fix: '写真を見て「交通費明細」に行を足す（申請ID を同じにして、往復・片道と片道・合計の km か運賃を入れ、照合結果は空のまま）' },
  ai: { memo: 'AI で申請書を読み取れませんでした', fix: '写真を見て「交通費明細」に行を足し、「対象月」を入れる（申請ID を同じにして、往復・片道と片道・合計の km か運賃を入れ、照合結果は空のまま）' },
  value: { memo: '確認後の値が数字として読めませんでした', fix: '確認後の値に数字だけを入れる' },
  emptyDone: { memo: '回答が空のまま［完了］になっていました', fix: '回答と確認後の値を入れてから［完了］を押す' },
};

// ---------------- 純粋関数（日付・月・数） ----------------
function TA_pad(n) { return ('0' + n).slice(-2); }
function TA_ym(ymd) { return String(ymd || '').slice(0, 7); }
function TA_addMonth(ym, n) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + '-' + TA_pad(m + 1);
}
function TA_monthLabel(ym) { return ym ? Number(ym.slice(5, 7)) + '月' : ''; }
function TA_md(ymd) { return ymd ? Number(ymd.slice(5, 7)) + '/' + Number(ymd.slice(8, 10)) : ''; }
function TA_validYmd(y, m, d) { var t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; }

/** 純粋関数：前月分として受け付けられる月（4日までは前月、5日からは今月） */
function TA_openMonth(today) {
  return Number(today.slice(8, 10)) <= TA_ACCEPT_DAY ? TA_addMonth(TA_ym(today), -1) : TA_ym(today);
}
/** 純粋関数：反映月（対象月と、受け付けた日に開いている月の遅いほう）。対象月が無ければ '' */
function TA_reflectMonth(target, receivedYmd) {
  if (!target) return '';
  var open = TA_openMonth(receivedYmd);
  return target < open ? open : target;
}
/** 純粋関数：その月の分を受け付ける最後の日（翌月4日） */
function TA_acceptDeadline(ym) { return TA_addMonth(ym, 1) + '-' + TA_pad(TA_ACCEPT_DAY); }
/** 純粋関数：要確認に回答する日（翌月5日。臨時の依頼の期限） */
function TA_answerDay(ym) { return TA_addMonth(ym, 1) + '-' + TA_pad(TA_ANSWER_DAY); }

/** 純粋関数：「YYYY-MM」の形の月（日付・「2026/11」・「2026年11月」）。読めなければ '' */
function TA_ymOf(v) {
  if (v instanceof Date) return Utilities.formatDate(v, AC_TZ, 'yyyy-MM');
  var m = /^'?(\d{4})\D{1,2}(\d{1,2})(?:\D|$)/.exec(String(v == null ? '' : v).normalize('NFKC').trim());
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? m[1] + '-' + TA_pad(Number(m[2])) : '';
}

/**
 * 純粋関数：申請書の日付 → 'YYYY-MM-DD'。年が無いとき（「11/5」「11月5日」）は、受け付けた日より後の月なら前の年。
 * 日だけ（「5」「5日」）は、対象月がわかっているときだけ。読めなければ ''
 */
function TA_parseDate(s, receivedYmd, target) {
  var t = String(s == null ? '' : s).normalize('NFKC').replace(/\s/g, '').replace(/\(.\)|（.）/g, '');
  var y, m, d, x;
  if ((x = /^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?$/.exec(t))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = /^(\d{1,2})[\/.月](\d{1,2})日?$/.exec(t))) {
    m = +x[1]; d = +x[2];
    var ry = Number(receivedYmd.slice(0, 4)), rm = Number(receivedYmd.slice(5, 7));
    y = m > rm ? ry - 1 : ry;
  } else if ((x = /^(\d{1,2})日?$/.exec(t)) && target) { y = Number(target.slice(0, 4)); m = Number(target.slice(5, 7)); d = +x[1]; }
  else return '';
  return TA_validYmd(y, m, d) ? y + '-' + TA_pad(m) + '-' + TA_pad(d) : '';
}
/** 純粋関数：金額（円）。数でなければ null */
function TA_parseYen(v) {
  if (typeof v === 'number') return isFinite(v) && v >= 0 ? v : null;
  var t = String(v == null ? '' : v).normalize('NFKC').replace(/[,円¥\\\s]/g, '');
  return /^\d+$/.test(t) ? Number(t) : null;
}
function TA_isCar(means) { return TA_CAR.indexOf(means) !== -1; }
function TA_isPublic(means) { return TA_PUBLIC.indexOf(means) !== -1; }
/** 純粋関数：手段の欄（管理本部が直した文字も読む）→ 車／バイク／電車／バス／'' */
function TA_meansOf(v) {
  var t = String(v == null ? '' : v).normalize('NFKC').trim();
  if (/^(車|自動車|自家用車|car)$/i.test(t)) return '車';
  if (/^(バイク|原付|オートバイ|bike)$/i.test(t)) return 'バイク';
  if (/^(電車|鉄道|train)$/i.test(t)) return '電車';
  if (/^(バス|bus)$/i.test(t)) return 'バス';
  return '';
}
/** 純粋関数：往復・片道の欄（管理本部が直した文字も読む）→ 往復／片道／'' */
function TA_tripOf(v) {
  var t = String(v == null ? '' : v).normalize('NFKC').trim();
  if (/^(往復|round)$/i.test(t)) return '往復';
  if (/^(片道|oneway)$/i.test(t)) return '片道';
  return '';
}
/** 純粋関数：車・バイクの金額（km × 円/km。小数1桁まで） */
function TA_carYen(km, rate) { return Math.round(km * rate * 10) / 10; }
function TA_km2(x) { return Math.round(x * 100) / 100; }
/**
 * 純粋関数：車・バイクの片道と合計の km。trip＝往復／片道／''、one・total＝書かれた km（無ければ null）。
 * 返り値 { one, km（合計。金額のもと）, issue（null／'trip'／'km'／'roundKm'） }
 * 往復：合計＝片道×2 か確かめる（合わなければ roundKm・合計は書かれたまま）。片方だけならもう片方を計算。片道：合計＝片道。
 * 往復・片道がわからないときは計算しない（書かれたまま・trip）
 */
function TA_carKm(trip, one, total) {
  var f = trip === '往復' ? 2 : trip === '片道' ? 1 : 0;
  if (!f) return { one: one, km: total, issue: 'trip' };
  if (one === null && total === null) return { one: null, km: null, issue: 'km' };
  if (one === null) return { one: TA_km2(total / f), km: total, issue: null };
  if (total === null) return { one: one, km: TA_km2(one * f), issue: null };
  return { one: one, km: total, issue: Math.abs(total - one * f) > TA_KM_EPS ? 'roundKm' : null };
}

// ---------------- 純粋関数（AI） ----------------
var TA_AI_SYSTEM = [
  'あなたは、会社の管理本部が従業員の交通費申請書（紙・A4）の写真を読み取る係です。',
  '申請書の形：1行目に対象（年・月分）・社員番号・氏名。右上に「枚数：□枚目／全□枚」。',
  '表（1枚25行）の列は No／日付（月/日）／方法（車・バイク・電車・バスのどれか1つに○）／出発地／到着地／往復・片道（どちらかに○）／片道（km）／合計（km）／運賃（円）。',
  '表の上に薄い文字で「記入例：」と書かれた1行があります。これは書き方の見本で、申請ではありません。rows に入れないでください（もし入れるなら example を true に）。',
  '表の下に、本人が手書きした合計欄が4つあります（どれもその用紙の分）：①合計kmの合計（車・バイク）／②車・バイクの金額（①×15円）／③運賃の合計（電車・バス）／④交通費の合計（②＋③）。',
  '画像を見て、次の項目を JSON で答えてください。',
  '- is_travel_form：交通費（通勤・移動の交通費）の申請書が写っていれば true。それ以外（免許証・レシートだけ・風景など）は false。',
  '- month：申請書に書かれた対象の年月（例 "2026-11"）。書かれていない・読めないときは ""。',
  '- page：「□枚目」に書かれた数字（例 "1"）。pages：「全□枚」に書かれた数字（例 "2"）。書かれていないときは ""。',
  '- sum_km：①（例 "64"）、car_yen：②（例 "960"）、fare_total：③（例 "680"）、grand_total：④（例 "1,640"）。書かれたとおりの数字。書かれていないときは ""（計算して埋めない）。',
  '- unclear：表の外の欄で、確かに読めない文字・数字がある欄の名前（page・pages・sum_km・car_yen・fare_total・grand_total）。',
  '- rows：表の、何か書かれた行ごとに、書かれたとおりに：',
  '  example（「記入例」の行なら true。ふつうの行は false）、date（例 "11/5"）、',
  '  means（○が付いた方法：car＝車／bike＝バイク／train＝電車／bus＝バス。○が無い・2つ以上・読めないときは unknown）、',
  '  from（出発地）、to（到着地）、trip（○が付いたほう：round＝往復／oneway＝片道。○が無い・両方に○・読めないときは unknown）、',
  '  one_way_km（片道（km）。例 "8"）、total_km（合計（km）。例 "16"）、fare（運賃（円）。例 "340"）。',
  '  書かれていない欄は ""（計算して埋めない）。出発・到着は「自宅」や店舗名・略語を書かれたとおりに（言い換えない・補わない）。',
  '  unclear：その行で、確かに読めない文字・数字がある欄の名前（date・means・from・to・trip・one_way_km・total_km・fare）。',
  '大事なこと：読めない文字・数字を推測で埋めないでください。少しでも自信がない欄は "" にして unclear に入れてください。',
  '氏名・住所などの個人情報は答えに含めないでください。',
].join('\n');
var TA_AI_FIELDS = ['date', 'means', 'from', 'to', 'trip', 'one_way_km', 'total_km', 'fare'];
var TA_AI_HEAD_FIELDS = ['page', 'pages', 'sum_km', 'car_yen', 'fare_total', 'grand_total'];
var TA_AI_SCHEMA = {
  type: 'object',
  properties: {
    is_travel_form: { type: 'boolean' },
    month: { type: 'string' },
    page: { type: 'string' }, pages: { type: 'string' },
    sum_km: { type: 'string' }, car_yen: { type: 'string' }, fare_total: { type: 'string' }, grand_total: { type: 'string' },
    unclear: { type: 'array', items: { type: 'string', enum: TA_AI_HEAD_FIELDS } },
    rows: { type: 'array', items: { type: 'object', properties: {
      example: { type: 'boolean' },
      date: { type: 'string' },
      means: { type: 'string', enum: ['car', 'bike', 'train', 'bus', 'unknown'] },
      from: { type: 'string' }, to: { type: 'string' },
      trip: { type: 'string', enum: ['round', 'oneway', 'unknown'] },
      one_way_km: { type: 'string' }, total_km: { type: 'string' }, fare: { type: 'string' },
      unclear: { type: 'array', items: { type: 'string', enum: TA_AI_FIELDS } },
    }, required: ['example', 'date', 'means', 'from', 'to', 'trip', 'one_way_km', 'total_km', 'fare', 'unclear'], additionalProperties: false } },
  },
  required: ['is_travel_form', 'month', 'page', 'pages', 'sum_km', 'car_yen', 'fare_total', 'grand_total', 'unclear', 'rows'],
  additionalProperties: false,
};

/** 純粋関数：Messages API へ送る中身（写真と指示だけ。氏名・住所・LINE ID は入れない） */
function TA_aiRequest(model, mediaType, b64) {
  return {
    model: model || LIC_AI_DEFAULT_MODEL,
    max_tokens: 8192,
    system: TA_AI_SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
      { type: 'text', text: 'この交通費申請書の写真を読み取ってください。' },
    ] }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: TA_AI_SCHEMA } },
  };
}

/** 純粋関数：Messages API の応答 → { res: { isForm, month, page, pages, sums: { km, carYen, fare, total }, unclear, rows } } か { error }。「記入例」の行は除く */
function TA_aiParse(text) {
  var body;
  try { body = JSON.parse(text); } catch (e) { return { error: 'parse' }; }
  if (!body || body.stop_reason === 'refusal') return { error: 'refusal' };
  if (body.stop_reason === 'max_tokens') return { error: 'parse' };
  var block = (body.content || []).filter(function (b) { return b && b.type === 'text'; })[0], r;
  try { r = JSON.parse(block.text); } catch (e2) { return { error: 'parse' }; }
  if (!r || typeof r.is_travel_form !== 'boolean' || !Array.isArray(r.rows)) return { error: 'parse' };
  var str = function (v) { return typeof v === 'string' ? v.trim() : ''; };
  return { res: { isForm: r.is_travel_form, month: str(r.month), page: str(r.page), pages: str(r.pages),
    sums: { km: str(r.sum_km), carYen: str(r.car_yen), fare: str(r.fare_total), total: str(r.grand_total) },
    unclear: (Array.isArray(r.unclear) ? r.unclear : []).filter(function (f) { return TA_AI_HEAD_FIELDS.indexOf(f) !== -1; }),
    rows: r.rows.filter(function (x) { return x && typeof x === 'object' && !TA_isExample(x); }).map(function (x) {
      return { date: str(x.date), from: str(x.from), to: str(x.to), means: TA_MEANS[x.means] !== undefined ? x.means : 'unknown',
        trip: TA_TRIP[x.trip] !== undefined ? x.trip : 'unknown', one: str(x.one_way_km), km: str(x.total_km), yen: str(x.fare),
        unclear: (Array.isArray(x.unclear) ? x.unclear : []).filter(function (f) { return TA_AI_FIELDS.indexOf(f) !== -1; }) };
    }) } };
}

/** 純粋関数：「記入例」の行か（AI の印・どこかの欄に「記入例」） */
function TA_isExample(x) {
  if (x.example === true) return true;
  return ['date', 'from', 'to', 'one_way_km', 'total_km', 'fare'].some(function (k) { return /記入例/.test(String(x[k] == null ? '' : x[k]).normalize('NFKC')); });
}

/**
 * 純粋関数：AI の読み取り → 申請の形。{ target（対象月 or ''）, rows: [{ date, from, to, means, trip, one, km（合計）, yen（運賃）, issues: [{ code, field }] }], appIssues,
 *   sums: { km（①）, carYen（②）, fare（③）, total（④）。書いていない・読めない欄は null }, page: TA_pageOf の結果 }
 * 対象月：書かれた年月。無ければ、読めた日付がすべて同じ月ならその月。推測はしない（読めない欄は空のまま要確認）
 * 車・バイク：TA_carKm（往復は片道×2・片道は同じ。片方だけならもう片方を計算）。km の欄が読めないときは計算しない。
 * 電車・バス：運賃は書かれたまま（往復でも2倍にしない）
 */
function TA_fromAi(res, receivedYmd) {
  var target = TA_ymOf(res.month);
  var rows = res.rows.filter(function (x) { return x.date || x.from || x.to || x.one || x.km || x.yen; });
  if (!target) {
    var months = {};
    rows.forEach(function (x) { var d = TA_parseDate(x.date, receivedYmd, ''); if (d) months[TA_ym(d)] = true; });
    var ks = Object.keys(months);
    if (ks.length === 1) target = ks[0];
  }
  var out = rows.map(function (x) {
    var means = TA_MEANS[x.means] || '', trip = TA_TRIP[x.trip] || '', issues = [], has = function (f) { return x.unclear.indexOf(f) !== -1; };
    var unclear = x.unclear.filter(function (f) { return f === 'from' || f === 'to'; });
    if (unclear.length) issues.push({ code: 'unclear', field: unclear.map(function (f) { return { from: '出発', to: '到着' }[f]; }).join('・') });
    var date = !has('date') ? TA_parseDate(x.date, receivedYmd, target) : '';
    if (!date) issues.push({ code: 'date' });
    else if (target && TA_ym(date) !== target) issues.push({ code: 'outside' });
    if (has('means') || !means) { means = ''; issues.push({ code: 'means' }); }
    if (has('trip') || !trip) { trip = ''; issues.push({ code: 'trip' }); }
    var one = !has('one_way_km') ? TRV_km(x.one) : null, km = !has('total_km') ? TRV_km(x.km) : null;   // 読めた数字は手段がわからなくても残す
    var yen = !has('fare') ? TA_parseYen(x.yen) : null;
    if (!TA_isPublic(means)) {   // 車・バイク（手段がわからない行も、読めた km は計算しておく。管理本部が手段だけ直せばよい）
      if (has('one_way_km') || has('total_km')) { if (TA_isCar(means)) issues.push({ code: 'km' }); }   // 読めない欄があれば、もう片方から計算しない
      else if (trip) {
        var c = TA_carKm(trip, one, km);
        one = c.one; km = c.km;
        if (c.issue === 'roundKm' || (c.issue && TA_isCar(means))) issues.push({ code: c.issue });
      } else if (TA_isCar(means) && one === null && km === null) issues.push({ code: 'km' });
    }
    if (TA_isPublic(means) && yen === null) issues.push({ code: 'yen' });
    return { date: date, rawDate: x.date, from: !has('from') ? x.from : '', to: !has('to') ? x.to : '',
      means: means, trip: trip, one: one, km: km, yen: yen, issues: issues };
  });
  var appIssues = [], hu = res.unclear || [], s = res.sums || {};
  var page = TA_pageOf(hu.indexOf('page') === -1 ? res.page : null, hu.indexOf('pages') === -1 ? res.pages : null);
  if (!page.ok) appIssues.push({ code: 'unclear', field: '枚数' });
  if (!out.length) appIssues.push({ code: 'norows' });
  if (!target) appIssues.push({ code: 'month' });
  var sum = function (k, f, parse) { return hu.indexOf(f) === -1 && s[k] ? parse(s[k]) : null; };
  return { target: target, rows: out, appIssues: appIssues, page: page,
    sums: { km: sum('km', 'sum_km', TRV_km), carYen: sum('carYen', 'car_yen', TA_parseYen), fare: sum('fare', 'fare_total', TA_parseYen), total: sum('total', 'grand_total', TA_parseYen) } };
}

/**
 * 純粋関数：「□枚目／全□枚」→ { page（数 or null）, pages（数 or null）, explicit（枚目が書いてある）, ok（読めた・矛盾なし）,
 *   label（「交通費申請」の枚目の欄に書く形：'1/2'・'-'（枚数なし）・'?'（読めない）・'?/2'（枚目だけ無い）） }
 * どちらも書いていなければ1枚目（全1枚）として扱う（explicit＝false：差し替えはしない）。読めない（null）・枚目だけ無い・枚目が全枚数より大きいは ok＝false
 */
function TA_pageOf(page, pages) {
  var num = function (v) { var t = String(v == null ? '' : v).normalize('NFKC').replace(/[枚目全\s]/g, ''); return /^\d+$/.test(t) && Number(t) >= 1 ? Number(t) : null; };
  var blank = function (v) { return v !== null && String(v).trim() === ''; };
  if (page === null || pages === null) return { page: null, pages: null, explicit: false, ok: false, label: '?' };
  if (blank(page) && blank(pages)) return { page: 1, pages: 1, explicit: false, ok: true, label: '-' };
  var p = num(page), n = num(pages);
  if ((!blank(page) && p === null) || (!blank(pages) && n === null)) return { page: null, pages: null, explicit: false, ok: false, label: '?' };
  if (p === null) return n === 1 ? { page: 1, pages: 1, explicit: true, ok: true, label: '1/1' } : { page: null, pages: n, explicit: false, ok: false, label: '?/' + n };
  if (n !== null && p > n) return { page: p, pages: n, explicit: false, ok: false, label: '?/' + n };
  return { page: p, pages: n, explicit: true, ok: true, label: p + '/' + (n === null ? '' : n) };
}

/**
 * 純粋関数：届いていない枚目。labels＝「交通費申請」の枚目の欄（写真ごと。'1/2'・'-'（枚数なし＝1枚目）・'?'（読めない））。
 * 全枚数＝書かれた全枚数と枚目のいちばん大きいもの。返り値：届いていない枚目の配列（1から）
 */
function TA_missingPages(labels) {
  var got = {}, max = 0;
  labels.forEach(function (l) {
    var t = String(l == null ? '' : l).trim();
    if (t === '-') { got[1] = true; max = Math.max(max, 1); return; }
    var m = /^(\d+|\?)(?:\/(\d*))?$/.exec(t);
    if (!m) return;
    var p = m[1] === '?' ? null : Number(m[1]), n = m[2] ? Number(m[2]) : 0;
    if (p !== null) { got[p] = true; max = Math.max(max, p); }
    max = Math.max(max, n);
  });
  var out = [];
  for (var i = 1; i <= max; i++) if (!got[i]) out.push(i);
  return out;
}

/**
 * 純粋関数：用紙ごとの合計欄（①〜④）の照合。rows＝その用紙の行（TA_fromAi の rows）、sums＝TA_fromAi の sums、rate＝円/km。
 * ①＝車・バイクの行の合計（km）の合計・②＝①×円/km（四捨五入）・③＝電車・バスの行の運賃の合計・④＝②＋③。
 * 書いていない（読めない）欄は比べない。読めない行があればその合計は比べない。④は、②・③が書いていなくてもその種類の行が無ければ 0 として比べる。
 * 返り値：確認事項の配列（[{ code: 'sumKm' }, …]）
 */
function TA_sumIssues(rows, sums, rate) {
  var km = 0, kmOk = true, fare = 0, fareOk = true, cars = 0, pubs = 0, out = [];
  rows.forEach(function (d) {
    if (TA_isCar(d.means)) { cars++; if (d.km === null) kmOk = false; else km += d.km; }
    else if (TA_isPublic(d.means)) { pubs++; if (d.yen === null) fareOk = false; else fare += d.yen; }
    else { kmOk = false; fareOk = false; }
  });
  if (sums.km !== null && kmOk && Math.abs(km - sums.km) > TA_KM_EPS) out.push({ code: 'sumKm' });
  if (sums.km !== null && sums.carYen !== null && Math.round(sums.km * rate) !== sums.carYen) out.push({ code: 'sumCarYen' });
  if (sums.fare !== null && fareOk && fare !== sums.fare) out.push({ code: 'sumFare' });
  var c2 = sums.carYen !== null ? sums.carYen : cars ? null : 0, c3 = sums.fare !== null ? sums.fare : pubs ? null : 0;
  if (sums.total !== null && c2 !== null && c3 !== null && c2 + c3 !== sums.total) out.push({ code: 'sumTotal' });
  return out;
}

/** 純粋関数：TRV_checkSegment の結果 → 確認事項の種類（OK なら null） */
function TA_trvIssue(r) {
  if (!r || r.status === 'OK') return null;
  if (/行き先がわからない/.test(r.reason)) return { code: 'place', detail: r.reason };
  if (/km が読めない/.test(r.reason)) return { code: 'km' };
  if (/距離を計算できない/.test(r.reason)) return { code: 'calc' };
  return { code: 'over', detail: r.reason };
}

/** 純粋関数：確認事項の文（シートに書く） */
function TA_issueText(issues) {
  return issues.map(function (i) { return i.detail || (TA_ISSUE[i.code] ? TA_fillText(TA_ISSUE[i.code].memo, i) : i.code); }).join('／');
}
/** 純粋関数：届いていない枚目の確認事項（例「届いていない枚目があります（2枚目が届いていません）」） */
function TA_pagesIssue(missing) { return { code: 'pages', detail: TA_ISSUE.pages.memo + '（' + missing.join('・') + '枚目が届いていません）' }; }
function TA_fillText(t, v) { return String(t).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] !== undefined ? String(v[k]) : m; }); }

/** 純粋関数：場所の名前を「臨時の依頼」（グループに出る）に書いてよい形に（住所らしいもの・長いものは伏せる） */
function TA_placeLabel(s) {
  var t = String(s == null ? '' : s).trim();
  if (!t) return '？';
  if (/[都道府県市区町村郡].*[0-9０-９]|丁目|番地|[0-9０-９]+-[0-9０-９]+/.test(t)) return '（場所）';
  return t.length > 12 ? t.slice(0, 12) + '…' : t;
}
function TA_surname(name) { return String(name || '').trim().split(/[\s　]+/)[0] || ''; }

/** 純粋関数：「臨時の依頼」の1行（業務名・メモ）。金額・住所は書かない */
function TA_requestOf(d, app, issues, sheetRow) {
  var who = TA_surname(app.name) || app.code;
  var what = d.from === TA_WHOLE ? (app.target ? TA_monthLabel(app.target) + '分の申請書' : '申請書') : (TA_md(d.date) || '日付不明') + ' ' + TA_placeLabel(d.from) + '→' + TA_placeLabel(d.to);
  var seen = {}, list = issues.filter(function (i) { if (seen[i.code]) return false; seen[i.code] = true; return !!TA_ISSUE[i.code]; });
  var memo = ['何が：' + what + (d.means ? '（' + d.means + '）' : ''),
    'なぜ：' + list.map(function (i) { return TA_ISSUE[i.code].memo; }).join('。'),
    'どう直すか：従業員マスタのファイルの「' + TA_DETAIL_SHEET + '」' + sheetRow + '行目（申請ID ' + app.id + '）を開き、'
      + list.map(function (i) { return TA_fillText(TA_ISSUE[i.code].fix, i); }).join('。') + '。'
      + '「回答」に確認した内容（必要なら「確認後の値」）を入れてから［完了］を押してください。'].join('\n');
  return { name: '交通費の確認：' + who + 'さん（' + what + '）', memo: memo };
}

/** 純粋関数：申請の状態と合計（明細から）。rate＝円/km */
function TA_appState(app, rows, rate) {
  var carKm = 0, pub = 0, open = false, wait = false;
  rows.forEach(function (d) {
    if (d.result === TA_REPLACED) return;
    if (d.result === TA_CHECK || d.result === '') open = true;
    if (d.from === TA_WHOLE) return;
    if (d.tot === TA_TOT_WAIT && d.result !== TA_DONE) wait = true;
    if (TA_isCar(d.means) && typeof d.km === 'number') carKm += d.km;
    if (TA_isPublic(d.means) && typeof d.yen === 'number') pub += d.yen;
  });
  var car = Math.floor(carKm * rate + 1e-9), total = car + pub;
  var status = !app.target || open || !rows.length ? TA_ST.check : wait ? TA_ST.recv : app.reflect > app.target ? TA_ST.next : TA_ST.fixed;
  return { status: status, total: total, carKm: Math.round(carKm * 10) / 10, carYen: car, pub: pub };
}
function TA_settled(status) { return status === TA_ST.fixed || status === TA_ST.next; }

/**
 * 純粋関数：TOT の出勤の索引。R＝tot-latest.json。{ worked: { 'TOTコード:日付': true }, covered: { 日付: true }, first: いちばん古い日付 }
 * 出勤＝日別勤怠（workings）の総労働（totalWork）が 0 より多い・エラー勤務（打刻あり）・日別打刻（timerecord）に出勤の打刻がある
 */
function TA_totIndex(R) {
  var out = { worked: {}, covered: {}, first: '' };
  if (!R || typeof R !== 'object') return out;
  var codeByKey = AC_totCodeByKey_(R.employees || []);
  var mark = function (tot, date) { if (tot && date) out.worked[AC_totKey(tot) + ':' + String(date).slice(0, 10)] = true; };
  AC_totFlat_(R.workings || []).forEach(function (w) {
    if (!w || !w.date) return;
    var d = String(w.date).slice(0, 10);
    out.covered[d] = true;
    if (!out.first || d < out.first) out.first = d;
    if (Number(w.totalWork) > 0 || w.isError === true) mark(codeByKey[w.employeeKey], d);
  });
  AC_totFlat_(R.timerecord || []).forEach(function (t) {
    if (t && (t.timeRecord || []).some(function (r) { return String(r && r.code) === '1'; })) mark(codeByKey[t.employeeKey], t.date);
  });
  return out;
}
/** 純粋関数：1行の TOT の照合 → あり／なし／確認できない／未確認（まだ記録の期間に入っていない） */
function TA_totCheck(index, totCode, date) {
  if (!totCode || !date) return TA_TOT_UNKNOWN;
  if (index.worked[AC_totKey(totCode) + ':' + date]) return TA_TOT_YES;
  if (index.covered[date]) return TA_TOT_NO;
  return index.first && date < index.first ? TA_TOT_UNKNOWN : TA_TOT_WAIT;
}

/**
 * 純粋関数（版 2026-11-20a）：固定店舗（日額×出勤日数）の出勤日数。R＝tot-latest.json の results、month＝'YYYY-MM'。
 * 出勤日＝日別勤怠（workings）で総労働時間（totalWork）が0より多い日（半日の休暇＋出勤も1日・休日出勤も1日・全日の休暇の日は数えない）。
 * エラー勤務（isError）の日は errors に入れる。ok＝その月の全部の日の日別勤怠がある（読み取りエラーが無い）。
 * 返り値 { ok, byTot: { TOTコード（AC_totKey）: { days, errors: [日付] } } }
 */
function TA_dailyIndex(R, month) {
  var out = { ok: false, byTot: {} };
  if (!R || !Array.isArray(R.workings) || R.workings.some(function (d) { return !d || d._error; })) return out;
  var codeByKey = AC_totCodeByKey_(R.employees || []), dates = {}, seen = {};
  AC_totFlat_(R.workings).forEach(function (w) {
    var d = w && w.date ? String(w.date).slice(0, 10) : '';
    if (d.slice(0, 7) !== month) return;
    dates[d] = true;
    var tot = codeByKey[w.employeeKey];
    if (!tot) return;
    var t = AC_totKey(tot), e = out.byTot[t] || (out.byTot[t] = { days: 0, errors: [] });
    if (w.isError === true && e.errors.indexOf(d) === -1) e.errors.push(d);
    if (seen[t + ':' + d] || AC_isFullHoliday(w) || !(Number(w.totalWork) > 0)) return;
    seen[t + ':' + d] = true;
    e.days++;
  });
  var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  out.ok = Object.keys(dates).length === new Date(Date.UTC(y, m, 0)).getUTCDate();
  Object.keys(out.byTot).forEach(function (t) { out.byTot[t].errors.sort(); });
  return out;
}
/**
 * 純粋関数（版 2026-11-20a）：固定店舗（日額×出勤日数）の1人の結果。daily＝「通勤距離」の日額、index＝TA_dailyIndex、totCode＝TOT従業員コード。
 * 返り値 { amount（書かないときは 0）, days, issue（TA_DAILY_ISSUE のキー。問題が無ければ ''）, errors: [エラー勤務の日] }
 */
function TA_dailyAmount(daily, index, totCode) {
  var yen = TA_parseYen(daily), e = (index && index.ok && totCode && index.byTot[AC_totKey(totCode)]) || { days: 0, errors: [] };
  var issue = !index || !index.ok ? 'noData' : !yen ? 'noDaily' : e.errors.length ? 'error' : !e.days ? 'zero' : '';
  return { amount: issue ? 0 : yen * e.days, days: e.days, issue: issue, errors: e.errors.slice() };
}
/** 純粋関数（版 2026-11-20a）：管理者への一覧に出す、書かなかった理由（エラー勤務の日は M/D で） */
function TA_dailyReason(r) {
  return TA_DAILY_ISSUE[r.issue] + (r.issue === 'error' ? '（' + r.errors.map(TA_md).join('・') + '）' : '');
}

/**
 * 純粋関数：締めの月の1人ずつの結果。month＝'YYYY-MM'。people＝在籍者 [{ code, name }]、inputs＝「通勤距離」の入力、apps＝[{ ...app, state }]。
 * 返り値 [{ code, amount（通勤手当に書く確定額。書かないときは 0）, status（確定・要確認・未提出・来月反映・''）, pendingIds（来月へ回す申請ID） }]
 * 要確認が1つでもあれば、その人のその月の申請は全部来月へ（数字は書かない）。定期（固定額）の人は「通勤距離」の固定額。
 * 固定店舗（日額×出勤日数）の人（版 2026-11-20a）：daily＝{ index: TA_dailyIndex, totOf: { 社員番号: TOT従業員コード } }。日額 × 出勤日数。
 *   問題があれば書かずに要確認（dailyIssue に TA_dailyAmount の結果）
 */
function TA_monthRows(month, people, inputs, apps, rate, daily) {
  return people.map(function (p) {
    var inp = inputs[p.code] || {}, type = String(inp.type || '').trim();
    var mine = apps.filter(function (a) { return a.code === p.code; });
    var here = mine.filter(function (a) { return a.reflect === month; });
    var pend = here.filter(function (a) { return !TA_settled(a.state.status); });
    var ok = pend.length ? [] : here;
    var late = mine.filter(function (a) { return a.target === month && a.reflect > month; });
    var fixed = type === TA_FIXED_TYPE ? TA_parseYen(inp.fixed) : null, amount = 0, status = '';
    var dl = type === TA_DAILY_TYPE ? TA_dailyAmount(inp.daily, daily && daily.index, daily && daily.totOf && (daily.totOf[p.code] || p.code)) : null;
    if (dl && dl.issue) return { code: p.code, amount: 0, status: TA_ST.check, pendingIds: here.map(function (a) { return a.id; }), daily: dl, dailyIssue: dl };
    ok.forEach(function (a) { amount += a.state.pub + a.state.carYen; });
    if (!pend.length && fixed !== null) amount += fixed;
    if (!pend.length && dl) amount += dl.amount;
    if (pend.length) status = TA_ST.check;
    else if (ok.length || fixed !== null || dl) status = TA_ST.fixed;
    else if (late.length) status = TA_ST.next;
    else if (type === TA_REMIND_TYPE && !mine.some(function (a) { return a.target === month; })) status = '未提出';
    return { code: p.code, amount: pend.length ? 0 : amount, status: status, pendingIds: pend.length ? here.map(function (a) { return a.id; }) : [], daily: dl };
  });
}

// ---------------- シート ----------------
function TA_props_() { return PropertiesService.getScriptProperties(); }
function TA_mode_() { var m = String(TA_props_().getProperty('TRAVEL_APPLY_MODE') || '').trim(); return m === 'on' || m === 'record' ? m : 'off'; }
function TA_rate_() { return TRV_num_('TRAVEL_YEN_PER_KM', TA_DEFAULT_YEN_PER_KM); }
function TA_tab_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold'); sh.setFrozenRows(1); return sh; }
  var h = sh.getRange(1, 1, 1, header.length).getValues()[0].map(function (x) { return String(x).trim(); });
  if (h.join('|') !== header.join('|')) throw new Error('「' + name + '」タブの見出しが変わっています（列を足したり並べ替えたりしないでください）');
  return sh;
}
function TA_str(v) { return v instanceof Date ? Utilities.formatDate(v, AC_TZ, 'yyyy-MM-dd') : String(v == null ? '' : v).replace(/^'/, '').trim(); }

/** 申請と明細を読む。apps：[{ row, id, code, name, target, reflect, status, … }]、details：[{ row, id, … }] */
function TA_load_(ss) {
  var as = TA_tab_(ss, TA_APPLY_SHEET, TA_APPLY_HEADER), ds = TA_tab_(ss, TA_DETAIL_SHEET, TA_DETAIL_HEADER);
  var apps = as.getDataRange().getValues().slice(1).map(function (r, i) {
    return { row: i + 2, id: TA_str(r[TA_A.id]), at: r[TA_A.at], code: TA_str(r[TA_A.code]), name: TA_str(r[TA_A.name]), target: TA_ymOf(r[TA_A.target]),
      reflect: TA_ymOf(r[TA_A.reflect]), status: TA_str(r[TA_A.status]), photo: TA_str(r[TA_A.photo]), pages: TA_str(r[TA_A.pages]), note: TA_str(r[TA_A.note]) };
  }).filter(function (a) { return a.id; });
  var details = ds.getDataRange().getValues().slice(1).map(function (r, i) {
    var num = function (v) { return typeof v === 'number' ? v : v === '' || v == null ? null : TRV_km(v); };
    return { row: i + 2, id: TA_str(r[TA_D.id]), code: TA_str(r[TA_D.code]), date: TA_str(r[TA_D.date]), from: TA_str(r[TA_D.from]), to: TA_str(r[TA_D.to]),
      means: TA_str(r[TA_D.means]), trip: TA_str(r[TA_D.trip]), one: num(r[TA_D.one]), km: num(r[TA_D.km]), yen: num(r[TA_D.yen]), tot: TA_str(r[TA_D.tot]), result: /^確認済み/.test(TA_str(r[TA_D.result])) ? TA_DONE : /^差し替え/.test(TA_str(r[TA_D.result])) ? TA_REPLACED : TA_str(r[TA_D.result]), issue: TA_str(r[TA_D.issue]),
      answer: TA_str(r[TA_D.answer]), value: TA_str(r[TA_D.value]), req: TA_str(r[TA_D.req]), page: TA_str(r[TA_D.page]) };
  }).filter(function (d) { return d.id; });
  return { as: as, ds: ds, apps: apps, details: details };
}
function TA_rowsOf_(st, id) { return st.details.filter(function (d) { return d.id === id; }); }

/** 申請の状態・合計・反映月を書き直す（変わったときだけ）。返り値：その申請の state */
function TA_refreshApp_(st, app, today) {
  if (app.target && !app.reflect) {
    app.reflect = TA_reflectMonth(app.target, app.at instanceof Date ? Utilities.formatDate(app.at, AC_TZ, 'yyyy-MM-dd') : today);
    st.as.getRange(app.row, TA_A.reflect + 1).setValue("'" + app.reflect);
  }
  var s = TA_appState(app, TA_rowsOf_(st, app.id), TA_rate_());
  if (s.status !== app.status) { st.as.getRange(app.row, TA_A.status + 1).setValue(s.status); app.status = s.status; }
  st.as.getRange(app.row, TA_A.total + 1).setValue(s.total);
  app.state = s;
  return s;
}

/** 「交通費の送る予定」（record のとき、送る代わりに書く） */
function TA_plan_(kind, to, text) {
  TA_tab_(TRV_book_(), TA_PLAN_SHEET, TA_PLAN_HEADER).appendRow([new Date(), kind, to, text]);
}

// ---------------- LINE の受け口（コード.gs の AC_handleEvent_ から。免許証のあと） ----------------
/**
 * 1対1のトークの画像のうち、交通費申請のものだけを扱う。扱ったら true（on のとき。呼び出し元はそこで終わる）。
 * record のときは記録だけして false（今までどおり問い合わせへも流す）。off・対象外・申請書でない画像は false
 */
function TA_onUserEvent_(ev) {
  var mode = TA_mode_();
  if (mode === 'off' || !ev || ev.type !== 'message' || !ev.message || ev.message.type !== 'image') return false;
  var uid = ev.source && ev.source.userId;
  if (!AC_isUserId(uid)) return false;
  var consumed = mode === 'on', cache = CacheService.getScriptCache(), dupKey = 'ta:ev:' + (ev.webhookEventId || '');
  var person = null, t0 = Date.now();
  try {
    if (ev.webhookEventId && cache.get(dupKey)) return consumed;   // LINE の再送
    var master = AC_masterSheet_(), today = AC_today_(), ss = master.getParent();
    person = LIC_personByUid(master.getDataRange().getValues(), uid, today);
    if (!person) return false;
    var inputs = TRV_commuteInputs(TRV_sheetValues_(ss, TRV_COMMUTE_SHEET)), type = String((inputs[person.code] || {}).type || '').trim();
    if (TA_APPLY_TYPES.indexOf(type) === -1) return false;
    if (ev.webhookEventId) cache.put(dupKey, '1', 21600);
    var blob;
    try { blob = LIC_fetchPhoto_(ev.message); } catch (e) {
      TA_error_(person.code, '取り出し', LIC_errSummary(e));
      if (consumed) TA_send_(ev.replyToken, uid, TA_TEXT.fail, t0);
      return consumed;
    }
    if (consumed) LIC_loading_(uid);
    var ai = TA_aiRead_(blob, person.code);
    if (ai.res && !ai.res.isForm) { cache.remove(dupKey); return false; }   // 申請書ではない：今までどおり
    var out;
    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try { out = TA_receive_(ss, person, blob, ai, today, ev.message.imageSet); } finally { lock.releaseLock(); }
    Logger.log(TRV_fmt('交通費申請の受付（版 %s・%s）：社員番号 %s・申請ID %s・%s行（要確認 %s）', TA_VERSION, mode, person.code, out.id, out.added, out.issues));
    if (out.reply) {
      if (consumed) TA_send_(ev.replyToken, uid, out.reply, t0);
      else TA_plan_('受付の返信', person.code, out.reply);
    }
    return consumed;
  } catch (err) {
    TA_error_(person ? person.code : '-', '受付', LIC_errSummary(err));
    if (consumed) { try { TA_send_(ev.replyToken, uid, TA_TEXT.fail, t0); } catch (e2) { /* 返信できなくても続ける */ } }
    return consumed;
  }
}
function TA_send_(replyToken, uid, text, t0) { return LIC_send_(replyToken, uid, [{ type: 'text', text: AC_withAiNote(text) }], t0); }

/** 受付のエラー：ログ（社員番号と段階・要約だけ）と、管理者の個別 LINE へすぐ（同じ日・同じ人・同じ段階は1回。record では送らない） */
function TA_error_(code, stage, summary) {
  Logger.log(TRV_fmt('交通費申請のエラー：%s %s %s', code, stage, summary));
  try {
    var state = AC_state_(), key = 'sent:' + AC_today_() + ':ta-err:' + code + ':' + stage;
    if (state.getProperty(key)) return;
    var text = '【交通費申請・エラー】社員番号 ' + code + '：申請書の写真の受付でエラーがありました（段階：' + stage + '／' + summary + '）。';
    if (TA_mode_() === 'on') AC_pushAdminNow_(text); else TA_plan_('エラーの知らせ', '管理者', text);
    state.setProperty(key, new Date().toISOString());
  } catch (e) { Logger.log('交通費申請：エラーの知らせに失敗'); }
}

/** 写真を AI で読む → { res } か { error }（キー・写真の中身・応答本文はログに書かない） */
function TA_aiRead_(blob, code) {
  var props = TA_props_(), key = props.getProperty('ANTHROPIC_API_KEY');
  if (!key) return { error: 'key' };
  var bytes = blob.getBytes();
  if (bytes.length > LIC_AI_MAX_BYTES) return { error: 'size' };
  var state = AC_state_(), ck = 'stat:' + AC_today_() + ':ta-ai', used = parseInt(state.getProperty(ck) || '0', 10) || 0;
  var max = parseInt(String(props.getProperty('TRAVEL_AI_DAILY_MAX') || ''), 10);
  if (used >= (max >= 0 ? max : TA_AI_DEFAULT_MAX)) return { error: 'limit' };
  state.setProperty(ck, String(used + 1));
  try {
    var payload = TA_aiRequest(props.getProperty('TRAVEL_AI_MODEL') || props.getProperty('LICENSE_AI_MODEL'), blob.getContentType() || 'image/jpeg', Utilities.base64Encode(bytes));
    var res = UrlFetchApp.fetch(LIC_AI_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': LIC_AI_API_VERSION }, payload: JSON.stringify(payload) });
    var c = res.getResponseCode();
    var out = c === 200 ? TA_aiParse(res.getContentText()) : { error: 'http', status: c };
    if (out.error) TA_error_(code, 'AI', out.error + (out.status ? '・HTTP ' + out.status : ''));
    return out;
  } catch (e) { TA_error_(code, 'AI', '通信の失敗'); return { error: 'fail' }; }
}

/** 写真の保存（「社員番号_YYYYMMDD_HHmmss_n」） */
function TA_savePhoto_(blob, code, n) {
  var id = TA_props_().getProperty('TRAVEL_APPLY_FOLDER_ID');
  if (!id) throw AC_error_('TRAVEL_APPLY_FOLDER_ID が未設定です');
  var name = code + '_' + Utilities.formatDate(new Date(), AC_TZ, 'yyyyMMdd_HHmmss') + '_' + n;
  return DriveApp.getFolderById(id).createFile(blob.setName(name)).getId();
}

/**
 * 受け付けた写真を記録する（ロックの中）。同じ人・同じ対象月・同じ反映月の申請があれば、そこに足す（対象月がわからない写真は新しい申請）。
 * 返り値 { id, added, issues, reply（返す文。同じ組の最後の写真でなければ ''） }
 */
function TA_receive_(ss, person, blob, ai, today, imageSet) {
  var st = TA_load_(ss), rate = TA_rate_();
  var form = ai.res ? TA_fromAi(ai.res, today) : { target: '', rows: [], appIssues: [{ code: 'ai' }], sums: {}, page: { explicit: false, label: '?' } };
  var reflect = TA_reflectMonth(form.target, today);
  var app = form.target ? st.apps.filter(function (a) { return a.code === person.code && a.target === form.target && a.reflect === reflect; })[0] : null;
  if (!app) {
    app = { id: 'T' + today.replace(/-/g, '').slice(2) + '-' + Utilities.getUuid().slice(0, 6), at: new Date(), code: person.code, name: person.name,
      target: form.target, reflect: reflect, status: '', photo: '', note: '' };
    st.as.appendRow([app.id, app.at, "'" + app.code, app.name, app.target ? "'" + app.target : '', reflect ? "'" + reflect : '', TA_ST.recv, 0, '', '', '']);
    app.row = st.as.getLastRow();
    st.apps.push(app);
  }
  var photos = app.photo ? app.photo.split(',') : [];
  photos.push(TA_savePhoto_(blob, person.code, photos.length + 1));
  app.photo = photos.join(',');
  st.as.getRange(app.row, TA_A.photo + 1).setValue(app.photo);
  // 枚目（写真ごと）。同じ枚目が前に届いていれば、前の写真の明細を「差し替え」にする（枚目が書いてあるときだけ）
  var prev = photos.length - 1, labels = prev && app.pages ? app.pages.split(',').slice(0, prev) : [];
  while (labels.length < prev) labels.push('?');
  var pageTag = form.page.explicit ? String(form.page.page) : '';
  if (pageTag && labels.some(function (l) { return l.split('/')[0] === pageTag; })) TA_replacePage_(st, app.id, pageTag);
  labels.push(form.page.label);
  app.pages = labels.join(',');
  st.as.getRange(app.row, TA_A.pages + 1).setValue("'" + app.pages);
  // 照合（車・バイク：自動計算の距離と行き先。片道（km）で照合）
  var cars = form.rows.filter(function (d) { return TA_isCar(d.means) && d.one !== null; });
  var checks = cars.length ? travelCheckSegments(cars.map(function (d) { return { code: person.code, from: d.from, to: d.to, km: d.one }; })) : [];
  cars.forEach(function (d, k) { var i = TA_trvIssue(checks[k]); if (i) d.issues.push(i); });
  form.appIssues = form.appIssues.concat(TA_sumIssues(form.rows, form.sums, rate));
  var existing = TA_rowsOf_(st, app.id).filter(function (x) { return x.result !== TA_REPLACED; });
  var newRows = [], issueCount = 0;
  form.rows.forEach(function (d) {
    var key = [d.date, d.from, d.to, d.means].join('|');
    if (d.date && existing.concat(newRows).some(function (x) { return [x.date, x.from, x.to, x.means].join('|') === key; })) d.issues.push({ code: 'dup' });
    var yen = TA_isCar(d.means) ? (d.km === null || d.issues.some(function (i) { return i.code === 'trip'; }) ? null : TA_carYen(d.km, rate)) : d.yen;
    if (TA_isPublic(d.means)) { d.one = null; d.km = null; }
    newRows.push({ date: d.date, from: d.from, to: d.to, means: d.means, trip: d.trip, one: d.one, km: d.km, yen: yen, issues: d.issues });
  });
  if (form.appIssues.length) newRows.push({ date: '', from: TA_WHOLE, to: '', means: '', trip: '', one: null, km: null, yen: null, issues: form.appIssues, whole: true });
  var values = newRows.map(function (d) {
    if (d.issues.length) issueCount++;
    var n = function (v) { return v === null ? '' : v; };
    return [app.id, "'" + person.code, d.date ? "'" + d.date : '', d.from, d.to, d.means, d.trip, n(d.one), n(d.km), n(d.yen),
      d.whole ? '-' : TA_TOT_WAIT, d.issues.length ? TA_CHECK : TA_OK, TA_issueText(d.issues), '', '', '', pageTag];
  });
  if (values.length) st.ds.getRange(st.ds.getLastRow() + 1, 1, values.length, TA_DETAIL_HEADER.length).setValues(values);
  st = TA_load_(ss);
  app = st.apps.filter(function (a) { return a.id === app.id; })[0];
  if (TA_syncPages_(st, app)) st = TA_load_(ss), app = st.apps.filter(function (a) { return a.id === app.id; })[0];
  TA_pagesWait_(app.id, TA_missingPages(app.pages ? app.pages.split(',') : []).length ? Date.now() : null);
  TA_refreshApp_(st, app, today);
  // 同じ組（imageSet）の写真は、最後の1枚のときだけ返す
  var last = true;
  if (imageSet && imageSet.id && imageSet.total > 1) {
    var cache = CacheService.getScriptCache(), k = 'ta:set:' + imageSet.id, n = (parseInt(cache.get(k) || '0', 10) || 0) + 1;
    cache.put(k, String(n), 3600);
    last = n >= imageSet.total;
  }
  var count = TA_rowsOf_(st, app.id).filter(function (d) { return d.from !== TA_WHOLE && d.result !== TA_REPLACED; }).length, reply = '';
  if (last) {
    reply = !ai.res ? TA_TEXT.ackNoRead : app.target ? TA_fillText(TA_TEXT.ack, { month: TA_monthLabel(app.target), n: count }) : TA_fillText(TA_TEXT.ackNoMonth, { n: count });
    if (app.target && app.reflect > app.target) reply += TA_fillText(TA_TEXT.late, { deadline: TA_md(TA_acceptDeadline(app.target)) });
  }
  return { id: app.id, added: newRows.length, issues: issueCount, reply: reply };
}

/** 同じ枚目の前の明細を「差し替え」にする（合計に入れない）。開いている臨時の依頼は「取り消し」に（on のとき） */
function TA_replacePage_(st, id, pageTag) {
  var reqSheet = null;
  st.details.filter(function (d) { return d.id === id && d.page === pageTag && d.result !== TA_REPLACED; }).forEach(function (d) {
    st.ds.getRange(d.row, TA_D.result + 1).setValue(TA_REPLACED + '（' + pageTag + '枚目を送り直し）');
    d.result = TA_REPLACED;
    if (/^\d+$/.test(d.req) && d.req !== '' && TA_mode_() === 'on' && typeof OT_book_ === 'function') {
      reqSheet = reqSheet || OT_sheet_(OT_book_(), OT_REQUEST_SHEET, OT_REQUEST_HEADER);
      if (String(reqSheet.getRange(Number(d.req), 6).getValue() || '').trim() !== '完了') reqSheet.getRange(Number(d.req), 6).setValue('取り消し');
    }
  });
}

/**
 * 届いていない枚目の確認事項（申請書全体の行）をそろえる。足りなければ行を足す・変われば書き直す・全部届けば確認済みにする。
 * 管理本部が確認済みにした後は足さない。変えたら true
 */
function TA_syncPages_(st, app) {
  var missing = TA_missingPages(app.pages ? app.pages.split(',') : []);
  var rows = TA_rowsOf_(st, app.id).filter(function (d) { return d.from === TA_WHOLE && d.result !== TA_REPLACED && d.issue.indexOf(TA_ISSUE.pages.memo) !== -1; });
  var open = rows.filter(function (d) { return d.result === TA_CHECK; })[0];
  if (missing.length) {
    var text = TA_issueText([TA_pagesIssue(missing)]);
    if (open) { if (open.issue !== text) { st.ds.getRange(open.row, TA_D.issue + 1).setValue(text); return true; } return false; }
    if (rows.some(function (d) { return d.result === TA_DONE; })) return false;
    st.ds.getRange(st.ds.getLastRow() + 1, 1, 1, TA_DETAIL_HEADER.length).setValues([[app.id, "'" + app.code, '', TA_WHOLE, '', '', '', '', '', '', '-', TA_CHECK, text, '', '', '', '']]);
    return true;
  }
  if (!open) return false;
  st.ds.getRange(open.row, TA_D.result + 1).setValue(TA_DONE + '（全部の枚目が届いた）');
  if (/^\d+$/.test(open.req) && TA_mode_() === 'on' && typeof OT_book_ === 'function') OT_sheet_(OT_book_(), OT_REQUEST_SHEET, OT_REQUEST_HEADER).getRange(Number(open.req), 6).setValue('完了');
  return true;
}

// ---------------- 毎朝（7時台）：TOT の照合・回答の確認・臨時の依頼・6日の締め ----------------
/**
 * 管理本部が入れた回答・直した欄で、要確認の行を照合し直す。{ ok: true, date, means, trip, one, km, yen } か { ok: false, issue }
 * 確認後の値があれば、車・バイクは合計の km・電車・バスは運賃として使う（往復・片道がわからなくてもよい）。
 * 無ければ「往復・片道」「片道（km）」「合計（km）」で TA_carKm（合わなければ要確認のまま）
 */
function TA_recheck(d, rate, today, target) {
  if (d.from === TA_WHOLE) return { ok: true };
  var means = TA_meansOf(d.means), trip = TA_tripOf(d.trip), value = d.value, date = TA_parseDate(d.date, today, target);
  if (!date) return { ok: false, issue: 'date' };
  if (!means) return { ok: false, issue: 'means' };
  if (TA_isCar(means)) {
    if (value !== '') {
      var v = TRV_km(value);
      if (v === null) return { ok: false, issue: 'value' };
      return { ok: true, date: date, means: means, trip: trip, one: d.one === null ? '' : d.one, km: v, yen: TA_carYen(v, rate) };
    }
    var c = TA_carKm(trip, d.one, d.km);
    if (c.issue) return { ok: false, issue: c.issue };
    return { ok: true, date: date, means: means, trip: trip, one: c.one, km: c.km, yen: TA_carYen(c.km, rate) };
  }
  if (!trip && value === '') return { ok: false, issue: 'trip' };
  var yen = value !== '' ? TA_parseYen(value) : d.yen;
  if (yen === null) return { ok: false, issue: value !== '' ? 'value' : 'yen' };
  return { ok: true, date: date, means: means, trip: trip, one: '', km: '', yen: yen };
}
/** 照合し直した値を明細の行に書く */
function TA_writeRecheck_(st, d, r) {
  var set = function (col, v) { st.ds.getRange(d.row, col + 1).setValue(v); };
  set(TA_D.date, "'" + r.date); set(TA_D.means, r.means); set(TA_D.trip, r.trip); set(TA_D.one, r.one); set(TA_D.km, r.km); set(TA_D.yen, r.yen);
  d.date = r.date; d.means = r.means; d.trip = r.trip; d.one = r.one === '' ? null : r.one; d.km = r.km === '' ? null : r.km; d.yen = r.yen;
}

function travelApplyDaily() {
  var mode = TA_mode_();
  if (mode === 'off') return { mode: mode };
  var ss = TRV_book_(), today = AC_today_(), rate = TA_rate_(), res = { mode: mode, tot: 0, confirmed: 0, requests: 0, reissued: 0, closed: '' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var st = TA_load_(ss), master = AC_masterSheet_().getDataRange().getValues(), totOf = {};
    master.slice(1).forEach(function (r) { var c = AC_cellCode_(r[AC_COL.code]); if (c && !totOf[c]) totOf[c] = String(r[AC_COL.totCode] || '').trim() || c; });
    var appById = {};
    st.apps.forEach(function (a) { appById[a.id] = a; });
    var set = function (d, col, v) { st.ds.getRange(d.row, col + 1).setValue(v); };
    // 1. 管理本部が手で足した行（照合結果が空）を照合する
    st.details.filter(function (d) { return d.result === '' && appById[d.id]; }).forEach(function (d) {
      var a0 = appById[d.id], r = TA_recheck(d, rate, today, a0.target), issues = r.ok ? [] : [{ code: r.issue }];
      if (!d.code) { d.code = a0.code; set(d, TA_D.code, "'" + d.code); }
      if (r.ok && a0.target && TA_ym(r.date) !== a0.target) issues.push({ code: 'outside' });
      if (r.ok && TA_isCar(r.means)) { var c = travelCheckSegments([{ code: d.code, from: d.from, to: d.to, km: r.one === '' ? r.km : r.one }])[0], i = TA_trvIssue(c); if (i) issues.push(i); }   // 片道で照合
      if (r.ok) TA_writeRecheck_(st, d, r);
      if (d.tot === '') { set(d, TA_D.tot, TA_TOT_WAIT); d.tot = TA_TOT_WAIT; }
      set(d, TA_D.result, issues.length ? TA_CHECK : TA_OK); set(d, TA_D.issue, TA_issueText(issues));
      d.result = issues.length ? TA_CHECK : TA_OK; d.issue = TA_issueText(issues);
    });
    // 2. TOT の出勤
    var tl = AC_readTotLatest_(), idx = TA_totIndex(tl && tl.results);
    st.details.filter(function (d) { return d.tot === TA_TOT_WAIT && d.result !== TA_DONE && d.result !== TA_REPLACED && d.from !== TA_WHOLE; }).forEach(function (d) {
      var t = TA_totCheck(idx, totOf[d.code], /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : '');
      if (t === TA_TOT_WAIT) return;
      set(d, TA_D.tot, t); d.tot = t; res.tot++;
      if (t === TA_TOT_YES) return;
      var code = t === TA_TOT_NO ? 'tot' : 'totUnknown', txt = TA_ISSUE[code].memo;
      d.issue = d.issue ? d.issue + '／' + txt : txt; set(d, TA_D.issue, d.issue);
      if (d.result !== TA_CHECK) { d.result = TA_CHECK; set(d, TA_D.result, TA_CHECK); d.req = ''; set(d, TA_D.req, ''); }
    });
    // 3. 回答が入った行を照合し直して確定。回答が空のまま［完了］なら出し直す
    var reqBook = mode === 'on' && typeof OT_book_ === 'function' ? OT_book_() : null;
    var reqSheet = reqBook ? OT_sheet_(reqBook, OT_REQUEST_SHEET, OT_REQUEST_HEADER) : null;
    var reqDone = function (d) { return reqSheet && /^\d+$/.test(d.req) && String(reqSheet.getRange(Number(d.req), 6).getValue() || '').trim() === '完了'; };
    st.details.filter(function (d) { return d.result === TA_CHECK; }).forEach(function (d) {
      var app = appById[d.id];
      if (!app) return;
      if (d.answer !== '' || d.value !== '') {
        var r = TA_recheck(d, rate, today, app.target);
        if (r.ok && d.from === TA_WHOLE && /対象の月/.test(d.issue) && !app.target) r = { ok: false, issue: 'month' };
        if (r.ok) {
          if (d.from !== TA_WHOLE) TA_writeRecheck_(st, d, r);
          d.result = TA_DONE; set(d, TA_D.result, TA_DONE + '（' + TA_md(today) + '）');
          if (reqSheet && /^\d+$/.test(d.req)) reqSheet.getRange(Number(d.req), 6).setValue('完了');
          res.confirmed++;
          return;
        }
        if (reqDone(d) || d.req === '') { d.reissue = r.issue; res.reissued++; }
        return;
      }
      if (reqDone(d)) { d.reissue = 'emptyDone'; res.reissued++; }
    });
    // 4. 臨時の依頼（1件1行）。record は「交通費の送る予定」へ
    st.details.filter(function (d) { return d.result === TA_CHECK && appById[d.id] && (d.req === '' || d.reissue); }).forEach(function (d) {
      var app = appById[d.id], issues = [];
      if (d.reissue) issues.push({ code: d.reissue });
      Object.keys(TA_ISSUE).forEach(function (k) { if (d.issue.indexOf(TA_ISSUE[k].memo) !== -1 || (k === 'over' && /申請 [0-9.]+km・自動計算/.test(d.issue)) || (k === 'place' && /行き先がわからない/.test(d.issue))) issues.push({ code: k, field: '出発・到着' }); });
      if (!issues.length) issues.push({ code: 'unclear', field: '確認事項の欄' });
      var q = TA_requestOf(d, app, issues, d.row);
      var due = app.target && TA_answerDay(app.target) > today ? TA_answerDay(app.target) : today;
      if (reqSheet) {
        reqSheet.appendRow([new Date(), '', q.name, "'" + due, q.memo, '']);
        set(d, TA_D.req, String(reqSheet.getLastRow()));
      } else {
        TA_plan_('臨時の依頼', '業務一覧', q.name + '\n' + q.memo);
        set(d, TA_D.req, 'record');
      }
      if (d.reissue) { var add = TA_ISSUE[d.reissue].memo; d.issue = d.issue.indexOf(add) === -1 ? d.issue + '／' + add : d.issue; set(d, TA_D.issue, d.issue); }
      res.requests++;
    });
    // 5. 申請の状態
    st = TA_load_(ss);
    st.apps.forEach(function (a) { TA_refreshApp_(st, a, today); });
    // 6. 6日：前月の締め
    if (Number(today.slice(8, 10)) === TA_CLOSE_DAY) res.closed = TA_close_(ss, st, TA_addMonth(TA_ym(today), -1), mode, today);
  } finally { lock.releaseLock(); }
  Logger.log(TRV_fmt('交通費申請の毎朝の処理（版 %s・%s）：TOT の照合 %s行・確定 %s行・臨時の依頼 %s件（出し直し %s）%s', TA_VERSION, mode, res.tot, res.confirmed, res.requests, res.reissued, res.closed ? '・' + res.closed : ''));
  return res;
}

/** 在籍者（通勤距離と同じ判定）と、LINE で送れる人の LINE ID */
function TA_people_(today) {
  var mv = AC_masterSheet_().getDataRange().getValues(), lic = LIC_people(mv, today);
  return TRV_active(mv, today).map(function (p) { return { code: p.code, name: p.name, dept: p.dept, userId: (lic[p.code] || {}).userId || '' }; });
}

/**
 * 6日（締め）：前月の確定額を給与反映シートの「通勤手当」に書き（PAY_writeColumn_）、要確認の申請を来月へ回し、
 * 管理者へ未提出・要確認・書けなかった人の一覧を送る（同じ月は1回だけ。やり直しは travelApplyCloseAgain）
 */
function TA_close_(ss, st, month, mode, today) {
  var state = AC_state_(), key = 'ta-close:' + month;
  if (state.getProperty(key)) return month + ' は締め済み';
  var people = TA_people_(today), inputs = TRV_commuteInputs(TRV_sheetValues_(ss, TRV_COMMUTE_SHEET));
  var daily = null;   // 固定店舗（日額×出勤日数）の人がいるときだけ、TOT のデータと TOT従業員コードを読む
  if (people.some(function (p) { return String((inputs[p.code] || {}).type || '').trim() === TA_DAILY_TYPE; })) {
    var tl = AC_readTotLatest_(), totOf = {};
    AC_masterSheet_().getDataRange().getValues().slice(1).forEach(function (r) { var c = AC_cellCode_(r[AC_COL.code]); if (c && !totOf[c]) totOf[c] = String(r[AC_COL.totCode] || '').trim() || c; });
    daily = { index: TA_dailyIndex(tl && tl.results, month), totOf: totOf };
  }
  var rows = TA_monthRows(month, people, inputs, st.apps, TA_rate_(), daily);
  var amounts = rows.filter(function (r) { return r.amount > 0; }).map(function (r) { return { code: r.code, value: r.amount }; });
  var payMsg, pay = null;
  try {
    pay = PAY_writeColumn_(month, TA_PAY_COLUMN, amounts, { people: people, mode: mode });
    payMsg = mode === 'on'
      ? '\n給与反映シートの「' + pay.tab + '」' + (pay.created ? '（テンプレから作りました）' : '') + 'の「' + TA_PAY_COLUMN + '」に ' + pay.written.length + '人分を書きました。'
      : '\n（record のため給与反映シートには書いていません。「' + pay.tab + '」の「' + TA_PAY_COLUMN + '」に ' + pay.written.length + '人分を書く予定' + (pay.willCreate ? '・タブはテンプレから作る予定' : '') + '）';
    if (pay.added.length) payMsg += '\n・並んでいなかったため行を足した' + (mode === 'on' ? '' : '（予定）') + '：従業員番号 ' + pay.added.join('、');
    var dup = pay.dup || [], vals = pay.conflict.filter(function (c) { return dup.indexOf(c) === -1; });
    if (vals.length) payMsg += '\n・すでに値があるため書かなかった（上書きしていません）：従業員番号 ' + vals.join('、');
    if (dup.length) payMsg += '\n・同じ人の行が2行以上あるため書かなかった（要確認）：従業員番号 ' + dup.join('、');
    if (pay.missing.length) payMsg += '\n・在籍者に見つからないため書かなかった：従業員番号 ' + pay.missing.join('、');
  } catch (e) { payMsg = '\n※給与反映シートに書けませんでした（' + (e && e.message) + '）。直したあと travelApplyCloseAgain を実行してください。'; }
  if (mode !== 'on') TA_plan_('給与反映シート', TA_PAY_COLUMN, amounts.map(function (a) { return a.code + ' ' + a.value; }).join('\n'));
  // 要確認の申請は来月へ
  var next = TA_addMonth(month, 1), moved = 0;
  rows.forEach(function (r) { r.pendingIds.forEach(function (id) {
    var a = st.apps.filter(function (x) { return x.id === id; })[0];
    a.reflect = next;
    st.as.getRange(a.row, TA_A.reflect + 1).setValue("'" + next);
    st.as.getRange(a.row, TA_A.note + 1).setValue((a.note ? a.note + '・' : '') + TA_monthLabel(month) + 'の締めで要確認のため来月へ');
    moved++;
  }); });
  var name = {}; people.forEach(function (p) { name[p.code] = p.name; });
  var list = function (s2) { return rows.filter(function (r) { return r.status === s2; }).map(function (r) { return r.code + ' ' + name[r.code]; }); };
  var miss = list('未提出'), chk = rows.filter(function (r) { return r.status === TA_ST.check && !r.dailyIssue; }).map(function (r) { return r.code + ' ' + name[r.code]; });
  var dOk = rows.filter(function (r) { return r.daily && !r.dailyIssue; }).length;
  var dNg = rows.filter(function (r) { return r.dailyIssue; }).map(function (r) { return r.code + ' ' + name[r.code] + '（' + TA_dailyReason(r.dailyIssue) + '）'; });
  var text = '【交通費】' + TA_monthLabel(month) + '分を締めました（受付は' + TA_md(TA_acceptDeadline(month)) + 'まで・回答は' + TA_md(TA_answerDay(month)) + 'まで）。' + payMsg
    + '\n・未提出 ' + miss.length + '人' + (miss.length ? '\n' + miss.map(function (x) { return '　' + x; }).join('\n') : '')
    + '\n・要確認が残っている ' + chk.length + '人（来月に反映）' + (chk.length ? '\n' + chk.map(function (x) { return '　' + x; }).join('\n') : '')
    + (chk.length ? '\n「交通費明細」の回答をお願いします。' : '')
    + (daily ? '\n・固定店舗（日額×出勤日数）：書いた ' + dOk + '人・書かなかった（要確認） ' + dNg.length + '人'
      + (dNg.length ? '\n' + dNg.map(function (x) { return '　' + x; }).join('\n') + '\nTOT・「通勤距離」の日額を直したあと travelApplyCloseAgain を実行してください。' : '') : '');
  if (mode === 'on') AC_pushLine_(text); else TA_plan_('管理者のまとめ', '管理者', text);
  state.setProperty(key, new Date().toISOString());
  return month + ' を締め（書いた ' + (pay ? pay.written.length : 0) + '・上書きしなかった ' + (pay ? pay.conflict.length : 0) + '・未提出 ' + miss.length + '・要確認 ' + chk.length + '・来月へ ' + moved + '件' + (daily ? '・固定店舗 書いた ' + dOk + '・要確認 ' + dNg.length : '') + '）';
}

/** 手動実行：締めをやり直す（給与反映シートに書けなかったときなど）。month＝'YYYY-MM'（省略で前月）。すでに値がある欄は上書きしない */
function travelApplyCloseAgain(month) {
  var mode = TA_mode_(), today = AC_today_();
  if (mode === 'off') throw new Error('TRAVEL_APPLY_MODE が off です');
  month = month || TA_addMonth(TA_ym(today), -1);
  AC_state_().deleteProperty('ta-close:' + month);
  var ss = TRV_book_(), st = TA_load_(ss);
  st.apps.forEach(function (a) { TA_refreshApp_(st, a, today); });
  var r = TA_close_(ss, st, month, mode, today);
  Logger.log(TRV_fmt('交通費申請の締めのやり直し（版 %s・%s）：%s', TA_VERSION, mode, r));
  return r;
}

// ---------------- 届いていない枚目の知らせ（15分ごと） ----------------
/** 枚目の知らせを待つ申請の記録（at＝最後の写真の時刻。null で消す）。ロックの中で呼ぶ */
function TA_pagesWait_(id, at) {
  var state = AC_state_(), m = TA_pagesWaitMap_(state);
  if (at === null) { if (!(id in m)) return; delete m[id]; } else m[id] = at;
  if (Object.keys(m).length) state.setProperty(TA_PAGES_WAIT_KEY, JSON.stringify(m)); else state.deleteProperty(TA_PAGES_WAIT_KEY);
}
function TA_pagesWaitMap_(state) { try { return JSON.parse(state.getProperty(TA_PAGES_WAIT_KEY) || '{}') || {}; } catch (e) { return {}; } }

/** 純粋関数：知らせる時刻か（最後の写真から1時間・8時〜21時台）。hour＝日本時間の時 */
function TA_pagesDue(lastMs, nowMs, hour) { return nowMs - lastMs >= TA_PAGES_WAIT_MS && hour >= TA_PAGES_FROM_HOUR && hour <= TA_PAGES_TO_HOUR; }
/** 純粋関数：本人への枚目の知らせの文 */
function TA_pagesText(target, missing) { return TA_fillText(TA_TEXT.pages, { month: target ? TA_monthLabel(target) + '分の' : '', pages: missing.join('・') }); }

/**
 * 15分ごと（トリガー）：最後の写真から1時間たっても届いていない枚目がある申請の本人へ、個別 LINE で知らせる（record は「交通費の送る予定」へ）。
 * 待つ申請が無ければシートも開かない。全部届いた・管理本部が確認済みにした・申請が無いときは待つのをやめる。同じ申請の同じ枚目は1回
 */
function travelApplyPagesRemind() {
  var mode = TA_mode_();
  if (mode === 'off') return { mode: mode };
  var state = AC_state_(), now = Date.now(), hour = Number(Utilities.formatDate(new Date(now), AC_TZ, 'HH'));
  var m = TA_pagesWaitMap_(state), due = Object.keys(m).filter(function (id) { return TA_pagesDue(Number(m[id]), now, hour); });
  var res = { mode: mode, waiting: Object.keys(m).length, sent: 0, failed: 0, dropped: 0 };
  if (!due.length) return res;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var today = AC_today_(), st = TA_load_(TRV_book_()), uid = {};
    TA_people_(today).forEach(function (p) { uid[p.code] = p.userId; });
    m = TA_pagesWaitMap_(state);   // ロックの間に写真が届いていれば、その時刻で
    due.filter(function (id) { return id in m && TA_pagesDue(Number(m[id]), now, hour); }).forEach(function (id) {
      var app = st.apps.filter(function (a) { return a.id === id; })[0];
      var missing = app ? TA_missingPages(app.pages ? app.pages.split(',') : []) : [];
      var open = app && TA_rowsOf_(st, id).some(function (d) { return d.from === TA_WHOLE && d.result === TA_CHECK && d.issue.indexOf(TA_ISSUE.pages.memo) !== -1; });
      var key = 'sent:' + today + ':ta-pages:' + id + ':' + missing.join('-');
      if (!missing.length || !open || state.getProperty(key) || !uid[app.code]) { if (app && missing.length && open && !uid[app.code]) Logger.log(TRV_fmt('交通費申請の枚目の知らせ：社員番号 %s は LINE で送れない（申請ID %s）', app.code, id)); delete m[id]; res.dropped++; return; }
      var text = TA_pagesText(app.target, missing);
      try {
        if (mode === 'on') AC_pushSelf_(uid[app.code], text); else TA_plan_('枚目の知らせ', app.code, text);
        state.setProperty(key, new Date().toISOString());
        delete m[id]; res.sent++;
      } catch (e) { res.failed++; TA_error_(app.code, '枚目の知らせ', LIC_errSummary(e)); }
    });
    if (Object.keys(m).length) state.setProperty(TA_PAGES_WAIT_KEY, JSON.stringify(m)); else state.deleteProperty(TA_PAGES_WAIT_KEY);
  } finally { lock.releaseLock(); }
  Logger.log(TRV_fmt('交通費申請の枚目の知らせ（版 %s・%s）：送信 %s件・失敗 %s・やめた %s・待っている %s', TA_VERSION, mode, res.sent, res.failed, res.dropped, Object.keys(m).length));
  return res;
}

// ---------------- 4日の催促 ----------------
/** 純粋関数：催促する人（通勤区分が「交通費申請（車・バイク）」の在籍者で、前月分の申請が無く、LINE で送れる人） */
function TA_remindTargets(people, inputs, apps, month) {
  return people.filter(function (p) {
    return String((inputs[p.code] || {}).type || '').trim() === TA_REMIND_TYPE && p.userId && !apps.some(function (a) { return a.code === p.code && a.target === month; });
  });
}

/** 毎月4日 10:00（トリガー）：前月分が届いていない人へ個別 LINE（土日祝も日付どおり。同じ月・同じ人は1回） */
function travelApplyRemind() {
  var mode = TA_mode_(), today = AC_today_();
  if (mode === 'off') return { mode: mode };
  if (Number(today.slice(8, 10)) !== TA_REMIND_DAY) return { mode: mode, skipped: '4日ではない' };
  var ss = TRV_book_(), month = TA_addMonth(TA_ym(today), -1), st = TA_load_(ss), state = AC_state_();
  var targets = TA_remindTargets(TA_people_(today), TRV_commuteInputs(TRV_sheetValues_(ss, TRV_COMMUTE_SHEET)), st.apps, month);
  var res = { mode: mode, month: month, sent: 0, failed: 0, skipped: 0 };
  targets.forEach(function (p) {
    var key = 'sent:' + month + ':ta-remind:' + p.code;
    if (state.getProperty(key)) { res.skipped++; return; }
    try {
      if (mode === 'on') AC_pushSelf_(p.userId, TA_TEXT.remind); else TA_plan_('4日の催促', p.code, TA_TEXT.remind);
      state.setProperty(key, new Date().toISOString());
      res.sent++;
    } catch (e) { res.failed++; }
  });
  Logger.log(TRV_fmt('交通費申請の催促（版 %s・%s）：%s分・送信 %s人・失敗 %s・送信済み %s', TA_VERSION, mode, month, res.sent, res.failed, res.skipped));
  return res;
}

// ---------------- 準備・確認・トリガー（安藤さんが手で実行） ----------------
/** 給与反映シート（社労士共有用【リバースHD】）の構成を見る（読むだけ。gas/PayrollSheet.gs の PAY_inspect。氏名・金額は出さない） */
function travelApplyInspectSharoushi() { return PAY_inspect(); }
function travelApplySetupTriggers() {
  travelApplyRemoveTriggers();
  ScriptApp.newTrigger('travelApplyDaily').timeBased().everyDays(1).atHour(TA_DAILY_HOUR).inTimezone(AC_TZ).create();
  ScriptApp.newTrigger('travelApplyRemind').timeBased().onMonthDay(TA_REMIND_DAY).atHour(TA_REMIND_HOUR).inTimezone(AC_TZ).create();
  ScriptApp.newTrigger('travelApplyPagesRemind').timeBased().everyMinutes(TA_PAGES_EVERY_MIN).create();
}
function travelApplyRemoveTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['travelApplyDaily', 'travelApplyRemind', 'travelApplyPagesRemind'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
}

if (typeof module !== 'undefined') {
  module.exports = { TA_carKm: TA_carKm, TA_tripOf: TA_tripOf, TA_isExample: TA_isExample, TA_sumIssues: TA_sumIssues, TA_pageOf: TA_pageOf, TA_missingPages: TA_missingPages, TA_pagesDue: TA_pagesDue, TA_pagesText: TA_pagesText, TA_openMonth: TA_openMonth, TA_reflectMonth: TA_reflectMonth, TA_parseDate: TA_parseDate, TA_parseYen: TA_parseYen, TA_aiParse: TA_aiParse,
    TA_fromAi: TA_fromAi, TA_appState: TA_appState, TA_totCheck: TA_totCheck, TA_acceptDeadline: TA_acceptDeadline, TA_answerDay: TA_answerDay, TA_monthRows: TA_monthRows, TA_dailyIndex: TA_dailyIndex, TA_dailyAmount: TA_dailyAmount, TA_dailyReason: TA_dailyReason, TA_remindTargets: TA_remindTargets, TA_VERSION: TA_VERSION };
}
