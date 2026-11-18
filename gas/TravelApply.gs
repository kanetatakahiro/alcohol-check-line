/**
 * 交通費申請の受付・読み取り・照合・締切・社労士共有用の月のタブ（gas/TravelApply.gs・版 2026-11-19a・本番未導入）
 *
 * 流れ：
 *   1. 本人が紙の申請書の写真（複数枚可）を公式LINEに送る。
 *      コード.gs の AC_handleEvent_ で、免許証（LIC_onUserEvent_：「免許更新」から30分の受付中の写真だけ）のあとに TA_onUserEvent_ を呼ぶ。
 *      免許証の受付中でない画像のうち、送った人が在籍・LINE確認済みで、「通勤距離」の通勤区分が申請の対象（TA_APPLY_TYPES）のときだけ AI で読む。
 *      AI が「交通費の申請書ではない」と答えた画像は扱わず、今までどおり問い合わせ（Inquiry.gs）へ流す。
 *   2. 読み取り：License.gs の写真の取り出し（LIC_fetchPhoto_）・API の宛先・版・既定のモデル・ANTHROPIC_API_KEY を共用する。
 *      読めない文字・数字は推測で埋めず、その欄を空にして「要確認」にする。
 *   3. 照合（受付のとき）：車・バイクは TRV_checkSegment（gas/Travel.gs・高速を使わない道と片道5km）・行き先がわからない区間・
 *      金額（TRAVEL_YEN_PER_KM 円/km・合計）・日付が対象月の中か・同じ日の同じ区間の重複・申請書の合計と計算の違い。
 *      TOT の出勤の記録は、毎朝の処理（tot-latest.json の日別勤怠）で照合する。
 *   4. 毎朝7時台（travelApplyDaily）：TOT の照合 → 回答が入った行を照合し直して確定 → 要確認の行を「臨時の依頼」（業務一覧ファイル）へ1件1行で追加
 *      （8時の「今日の業務」に出る）。回答が空のまま［完了］になっていたら、確認事項を出し直す。6日は前月の締め（月のタブ・管理者へ一覧）。
 *   5. 締切：毎月4日 10:00（travelApplyRemind・土日祝も日付どおり）に、前月分が届いていない対象者へ個別 LINE で催促。
 *      5日の終わりで締切。6日以降に届いた前月分は「来月反映」（本人にも返信で伝える）。
 *   6. 6日の朝：社労士共有用【リバースHD】の「雛形」タブをコピーして前月の月のタブを作る（同じ名前のタブがあれば作らない・既存の月のタブは書き換えない）。
 *      在籍者を全員並べ、交通費がある行は白、それ以外は薄い灰色。確定した数字だけを入れる。要確認が残る人は状態に出し、数字は入れずに来月へ回す。
 *
 * タブ（従業員マスタのファイル。新しいタブだけを足す）：「交通費申請」（1申請1行）・「交通費明細」（1区間1行）・「交通費の送る予定」（record のとき）
 * スクリプトプロパティ：
 *   TRAVEL_APPLY_MODE           off（既定）／record（受け付けて記録するが、LINE・臨時の依頼には送らない。画像は今までどおり問い合わせへも流す）／on
 *   TRAVEL_APPLY_FOLDER_ID      申請書の写真を保存するドライブのフォルダ（閲覧を管理本部に限ったもの）
 *   TRAVEL_SHAROUSHI_SHEET_ID   社労士共有用【リバースHD】のスプレッドシート ID
 *   TRAVEL_SHAROUSHI_TAB_FORMAT 月のタブの名前（既定「{y}年{m}月」）
 *   TRAVEL_YEN_PER_KM           車・バイクの 1km あたりの円（既定 15）
 *   TRAVEL_AI_MODEL・TRAVEL_AI_DAILY_MAX  読み取りのモデル（既定は免許証と同じ）・1日の上限（既定 100枚）
 * ログには件数・社員番号・申請ID だけを書く（住所・金額・写真の中身・氏名は書かない）。
 */
var TA_VERSION = '2026-11-19a';
var TA_APPLY_SHEET = '交通費申請', TA_DETAIL_SHEET = '交通費明細', TA_PLAN_SHEET = '交通費の送る予定';
var TA_APPLY_HEADER = ['申請ID', '受付日時', '社員番号', '氏名', '対象月', '反映月', '状態', '合計（円）', '写真', '備考'];
var TA_A = { id: 0, at: 1, code: 2, name: 3, target: 4, reflect: 5, status: 6, total: 7, photo: 8, note: 9 };
var TA_DETAIL_HEADER = ['申請ID', '社員番号', '日付', '出発', '到着', '手段', 'km', '金額（円）', 'TOT の出勤', '照合結果', '確認事項',
  '回答（管理本部が入力）', '確認後の値（管理本部が入力）', '依頼の行'];
var TA_D = { id: 0, code: 1, date: 2, from: 3, to: 4, means: 5, km: 6, yen: 7, tot: 8, result: 9, issue: 10, answer: 11, value: 12, req: 13 };
var TA_PLAN_HEADER = ['日時', '種類', '宛先', '内容'];
var TA_TEMPLATE_SHEET = '雛形';
var TA_TEMPLATE_HEADER = ['社員番号', '氏名', '所属', '通勤区分', '電車・バス（円）', '車・バイク（km）', '車・バイク（円）', '固定額', '合計', '状態', '備考'];
var TA_APPLY_TYPES = ['交通費申請（車・バイク）', '公共交通機関'];   // 写真を受け付ける通勤区分
var TA_REMIND_TYPE = '交通費申請（車・バイク）';                     // 4日の催促・未提出の対象
var TA_FIXED_TYPE = '定期（固定額）';
var TA_CAR = ['車', 'バイク'], TA_PUBLIC = ['電車', 'バス'], TA_WHOLE = '（申請書全体）';
var TA_MEANS = { car: '車', bike: 'バイク', train: '電車', bus: 'バス', other: '', unknown: '' };
var TA_OK = 'OK', TA_CHECK = '要確認', TA_DONE = '確認済み';
var TA_TOT_WAIT = '未確認', TA_TOT_YES = 'あり', TA_TOT_NO = 'なし', TA_TOT_UNKNOWN = '確認できない';
var TA_ST = { recv: '受付', check: '要確認', fixed: '確定', next: '来月反映' };
var TA_DEADLINE_DAY = 5, TA_REMIND_DAY = 4, TA_REMIND_HOUR = 10, TA_DAILY_HOUR = 7, TA_CLOSE_DAY = 6;
var TA_DEFAULT_YEN_PER_KM = 15, TA_AI_DEFAULT_MAX = 100;
var TA_WHITE = '#ffffff', TA_GREY = '#efefef';
var TA_TEXT = {
  ack: '交通費申請の写真を受け付けました（{month}分・{n}件）。\n内容を確認して、気になる点があれば管理本部からご連絡します。',
  ackNoMonth: '交通費申請の写真を受け付けました（{n}件）。\n対象の月が読み取れなかったため、管理本部で確認します。',
  ackNoRead: '交通費申請の写真を受け付けました。\n内容は管理本部が写真で確認します。',
  late: '\n締切（{deadline}）を過ぎて届いたため、来月のお給料での反映になります。',
  fail: '写真をうまく受け取れませんでした。お手数ですが、もう一度送ってください。',
  remind: '先月分の交通費申請がまだ届いていません。本日中に申請書の写真をこちらへ送ってください。5日を過ぎると、来月のお給料での反映になります。',
};
/** 確認事項（detail：シートに書く。数字を含んでよい／memo：グループに出る「臨時の依頼」のメモ。金額・住所は書かない／fix：どう直すか） */
var TA_ISSUE = {
  unclear: { memo: '申請書の文字・数字の一部が読み取れませんでした', fix: '写真を見て、読めない欄（{field}）を正しい値に直す' },
  date: { memo: '日付が読み取れませんでした', fix: '写真を見て「日付」の欄を直す' },
  outside: { memo: '日付が対象の月の外です', fix: '写真と本人への確認で「日付」か「対象月」を直す' },
  means: { memo: '手段（車・バイク・電車・バス）が読み取れませんでした', fix: '「手段」の欄に 車・バイク・電車・バス のどれかを入れる' },
  km: { memo: '距離（km）が読み取れませんでした', fix: '写真を見て、確認後の値に km を入れる' },
  yen: { memo: '電車・バスの金額が読み取れませんでした', fix: '写真を見て、確認後の値に金額（円）を入れる' },
  place: { memo: '行き先の店舗名・略語がわかりませんでした', fix: '正しい店舗を確かめ、「出発」「到着」を店舗一覧の名前に直す（よく使う書き方なら店舗一覧の略語に足す）' },
  over: { memo: '申請の距離が、自動計算の距離より片道5kmを超えて長くなっています', fix: '本人に道順を確認し、確認後の値に認める km を入れる' },
  calc: { memo: '自動計算の距離がなく、距離を照合できませんでした', fix: '地図で距離を確かめ、確認後の値に認める km を入れる' },
  tot: { memo: 'その日の TOT の出勤の記録がありません', fix: '出勤した日か本人に確認し、回答に結果を書く' },
  totUnknown: { memo: 'その日の TOT の出勤の記録を確認できませんでした', fix: 'TOT で出勤の記録を確かめ、回答に結果を書く' },
  dup: { memo: '同じ日・同じ区間がもう1行あります', fix: '写真を見て二重でないか確かめ、二重なら確認後の値に 0 を入れる' },
  total: { memo: '申請書に書かれた合計と、計算した合計が違います', fix: '写真を見て各行の数字を確かめ、回答に結果を書く' },
  month: { memo: '対象の月が読み取れませんでした', fix: '「交通費申請」タブの「対象月」に 2026-11 のように入れる' },
  norows: { memo: '申請書の明細が読み取れませんでした', fix: '写真を見て「交通費明細」に行を足す（申請ID を同じにして、照合結果は空のまま）' },
  ai: { memo: 'AI で申請書を読み取れませんでした', fix: '写真を見て「交通費明細」に行を足し、「対象月」を入れる（申請ID を同じにして、照合結果は空のまま）' },
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

/** 純粋関数：締切までに受け付けられる月（5日までは前月、6日からは今月） */
function TA_openMonth(today) {
  return Number(today.slice(8, 10)) <= TA_DEADLINE_DAY ? TA_addMonth(TA_ym(today), -1) : TA_ym(today);
}
/** 純粋関数：反映月（対象月と、受け付けた日に開いている月の遅いほう）。対象月が無ければ '' */
function TA_reflectMonth(target, receivedYmd) {
  if (!target) return '';
  var open = TA_openMonth(receivedYmd);
  return target < open ? open : target;
}
/** 純粋関数：その月の締切の日（翌月5日） */
function TA_deadlineOf(ym) { return TA_addMonth(ym, 1) + '-' + TA_pad(TA_DEADLINE_DAY); }

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
/** 純粋関数：車・バイクの金額（km × 円/km。小数1桁まで） */
function TA_carYen(km, rate) { return Math.round(km * rate * 10) / 10; }

// ---------------- 純粋関数（AI） ----------------
var TA_AI_SYSTEM = [
  'あなたは、会社の管理本部が従業員の交通費申請書（紙）の写真を読み取る係です。',
  '画像を見て、次の項目を JSON で答えてください。',
  '- is_travel_form：交通費（通勤・移動の交通費）の申請書が写っていれば true。それ以外（免許証・レシートだけ・風景など）は false。',
  '- month：申請書に書かれた対象の年月（例 "2026-11"）。書かれていない・読めないときは ""。',
  '- total_yen：申請書に書かれた合計金額（書かれたとおりの数字。例 "4,500"）。無い・読めないときは ""。',
  '- rows：明細の1行ごとに、書かれたとおりに：date（例 "11/5"）、from（出発）、to（到着）、means（car＝自家用車／bike＝バイク・原付／train＝電車／bus＝バス／other＝その他／unknown＝読めない）、km（距離。例 "12.5"）、yen（金額。例 "420"）。',
  '  書かれていない欄は ""。出発・到着は「自宅」や店舗名・略語を書かれたとおりに（言い換えない・補わない）。',
  '- unclear：その行で、確かに読めない文字・数字がある欄の名前（date・from・to・means・km・yen）。',
  '大事なこと：読めない文字・数字を推測で埋めないでください。少しでも自信がない欄は "" にして unclear に入れてください。',
  '氏名・住所などの個人情報は答えに含めないでください。',
].join('\n');
var TA_AI_FIELDS = ['date', 'from', 'to', 'means', 'km', 'yen'];
var TA_AI_SCHEMA = {
  type: 'object',
  properties: {
    is_travel_form: { type: 'boolean' },
    month: { type: 'string' },
    total_yen: { type: 'string' },
    rows: { type: 'array', items: { type: 'object', properties: {
      date: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      means: { type: 'string', enum: ['car', 'bike', 'train', 'bus', 'other', 'unknown'] },
      km: { type: 'string' }, yen: { type: 'string' },
      unclear: { type: 'array', items: { type: 'string', enum: TA_AI_FIELDS } },
    }, required: ['date', 'from', 'to', 'means', 'km', 'yen', 'unclear'], additionalProperties: false } },
  },
  required: ['is_travel_form', 'month', 'total_yen', 'rows'],
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

/** 純粋関数：Messages API の応答 → { res: { isForm, month, total, rows } } か { error } */
function TA_aiParse(text) {
  var body;
  try { body = JSON.parse(text); } catch (e) { return { error: 'parse' }; }
  if (!body || body.stop_reason === 'refusal') return { error: 'refusal' };
  if (body.stop_reason === 'max_tokens') return { error: 'parse' };
  var block = (body.content || []).filter(function (b) { return b && b.type === 'text'; })[0], r;
  try { r = JSON.parse(block.text); } catch (e2) { return { error: 'parse' }; }
  if (!r || typeof r.is_travel_form !== 'boolean' || !Array.isArray(r.rows)) return { error: 'parse' };
  var str = function (v) { return typeof v === 'string' ? v.trim() : ''; };
  return { res: { isForm: r.is_travel_form, month: str(r.month), total: str(r.total_yen),
    rows: r.rows.filter(function (x) { return x && typeof x === 'object'; }).map(function (x) {
      return { date: str(x.date), from: str(x.from), to: str(x.to), means: TA_MEANS[x.means] !== undefined ? x.means : 'unknown',
        km: str(x.km), yen: str(x.yen), unclear: (Array.isArray(x.unclear) ? x.unclear : []).filter(function (f) { return TA_AI_FIELDS.indexOf(f) !== -1; }) };
    }) } };
}

/**
 * 純粋関数：AI の読み取り → 申請の形。{ target（対象月 or ''）, rows: [{ date, from, to, means, km, yen, issues: [{ code, field }] }], appIssues, total }
 * 対象月：書かれた年月。無ければ、読めた日付がすべて同じ月ならその月。推測はしない（読めない欄は空のまま要確認）
 */
function TA_fromAi(res, receivedYmd) {
  var target = TA_ymOf(res.month);
  var rows = res.rows.filter(function (x) { return x.date || x.from || x.to || x.km || x.yen; });
  if (!target) {
    var months = {};
    rows.forEach(function (x) { var d = TA_parseDate(x.date, receivedYmd, ''); if (d) months[TA_ym(d)] = true; });
    var ks = Object.keys(months);
    if (ks.length === 1) target = ks[0];
  }
  var out = rows.map(function (x) {
    var means = TA_MEANS[x.means] || '', issues = [];
    var unclear = x.unclear.filter(function (f) { return f !== 'km' && f !== 'yen' && f !== 'means' && f !== 'date'; });
    if (unclear.length) issues.push({ code: 'unclear', field: unclear.map(function (f) { return { from: '出発', to: '到着' }[f]; }).join('・') });
    var date = x.unclear.indexOf('date') === -1 ? TA_parseDate(x.date, receivedYmd, target) : '';
    if (!date) issues.push({ code: 'date' });
    else if (target && TA_ym(date) !== target) issues.push({ code: 'outside' });
    if (x.unclear.indexOf('means') !== -1 || !means) { means = ''; issues.push({ code: 'means' }); }
    var km = x.unclear.indexOf('km') === -1 ? TRV_km(x.km) : null;          // 読めた数字は手段がわからなくても残す（管理本部が手段だけ直せばよい）
    var yen = x.unclear.indexOf('yen') === -1 ? TA_parseYen(x.yen) : null;
    if (TA_isCar(means) && km === null) issues.push({ code: 'km' });
    if (TA_isPublic(means) && yen === null) issues.push({ code: 'yen' });
    return { date: date, rawDate: x.date, from: x.unclear.indexOf('from') === -1 ? x.from : '', to: x.unclear.indexOf('to') === -1 ? x.to : '',
      means: means, km: km, yen: yen, issues: issues };
  });
  var appIssues = [];
  if (!out.length) appIssues.push({ code: 'norows' });
  if (!target) appIssues.push({ code: 'month' });
  return { target: target, rows: out, appIssues: appIssues, total: TA_parseYen(res.total) };
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
 * 純粋関数：月のタブの行。month＝'YYYY-MM'。people＝在籍者 [{ code, name, dept }]、inputs＝「通勤距離」の入力、apps＝[{ ...app, state }]。
 * 返り値 [{ code, values: { 見出し: 値 }, white, pendingIds（来月へ回す申請ID） }]
 */
function TA_monthRows(month, people, inputs, apps, rate) {
  return people.map(function (p) {
    var inp = inputs[p.code] || {}, type = String(inp.type || '').trim();
    var mine = apps.filter(function (a) { return a.code === p.code; });
    var here = mine.filter(function (a) { return a.reflect === month; });
    var pend = here.filter(function (a) { return !TA_settled(a.state.status); });
    var ok = pend.length ? [] : here.filter(function (a) { return TA_settled(a.state.status); });
    var late = mine.filter(function (a) { return a.target === month && a.reflect > month; });
    var v = { pub: 0, km: 0, car: 0 }, fixed = type === TA_FIXED_TYPE ? TA_parseYen(inp.fixed) : null;
    ok.forEach(function (a) { v.pub += a.state.pub; v.km += a.state.carKm; v.car += a.state.carYen; });
    v.km = Math.round(v.km * 10) / 10;
    var total = v.pub + v.car + (fixed || 0), status = '', note = [];
    if (pend.length) { status = TA_ST.check; note.push('要確認のため来月に反映'); }
    else if (ok.length) { status = TA_ST.fixed; if (ok.some(function (a) { return a.target < month; })) note.push('前月以前の分を含む'); if (late.length) note.push('一部は来月反映'); }
    else if (late.length) status = TA_ST.next;
    else if (type === TA_REMIND_TYPE && !mine.some(function (a) { return a.target === month; })) status = '未提出';
    else if (fixed !== null) { status = TA_ST.fixed; note.push(TA_FIXED_TYPE); }
    else if (type && TA_APPLY_TYPES.indexOf(type) === -1) note.push(type);
    var hasNums = !pend.length && (ok.length || fixed !== null);
    var values = { '社員番号': "'" + p.code, '氏名': p.name, '所属': p.dept, '通勤区分': type,
      '電車・バス（円）': hasNums && v.pub ? v.pub : '', '車・バイク（km）': hasNums && v.km ? v.km : '', '車・バイク（円）': hasNums && v.car ? v.car : '',
      '固定額': fixed !== null && !pend.length ? fixed : '', '合計': hasNums && total ? total : '', '状態': status, '備考': note.join('・') };
    return { code: p.code, values: values, white: !!(pend.length || (hasNums && total > 0)), pendingIds: pend.length ? here.map(function (a) { return a.id; }) : [] };
  });
}
/** 純粋関数：月のタブの名前（format の {y}・{m}・{mm}） */
function TA_tabName(format, month) {
  return String(format || '{y}年{m}月').replace(/\{y\}/g, month.slice(0, 4)).replace(/\{mm\}/g, month.slice(5, 7)).replace(/\{m\}/g, String(Number(month.slice(5, 7))));
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
      reflect: TA_ymOf(r[TA_A.reflect]), status: TA_str(r[TA_A.status]), photo: TA_str(r[TA_A.photo]), note: TA_str(r[TA_A.note]) };
  }).filter(function (a) { return a.id; });
  var details = ds.getDataRange().getValues().slice(1).map(function (r, i) {
    var num = function (v) { return typeof v === 'number' ? v : v === '' || v == null ? null : TRV_km(v); };
    return { row: i + 2, id: TA_str(r[TA_D.id]), code: TA_str(r[TA_D.code]), date: TA_str(r[TA_D.date]), from: TA_str(r[TA_D.from]), to: TA_str(r[TA_D.to]),
      means: TA_str(r[TA_D.means]), km: num(r[TA_D.km]), yen: num(r[TA_D.yen]), tot: TA_str(r[TA_D.tot]), result: /^確認済み/.test(TA_str(r[TA_D.result])) ? TA_DONE : TA_str(r[TA_D.result]), issue: TA_str(r[TA_D.issue]),
      answer: TA_str(r[TA_D.answer]), value: TA_str(r[TA_D.value]), req: TA_str(r[TA_D.req]) };
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
  var form = ai.res ? TA_fromAi(ai.res, today) : { target: '', rows: [], appIssues: [{ code: 'ai' }], total: null };
  var reflect = TA_reflectMonth(form.target, today);
  var app = form.target ? st.apps.filter(function (a) { return a.code === person.code && a.target === form.target && a.reflect === reflect; })[0] : null;
  if (!app) {
    app = { id: 'T' + today.replace(/-/g, '').slice(2) + '-' + Utilities.getUuid().slice(0, 6), at: new Date(), code: person.code, name: person.name,
      target: form.target, reflect: reflect, status: '', photo: '', note: '' };
    st.as.appendRow([app.id, app.at, "'" + app.code, app.name, app.target ? "'" + app.target : '', reflect ? "'" + reflect : '', TA_ST.recv, 0, '', '']);
    app.row = st.as.getLastRow();
    st.apps.push(app);
  }
  var photos = app.photo ? app.photo.split(',') : [];
  photos.push(TA_savePhoto_(blob, person.code, photos.length + 1));
  app.photo = photos.join(',');
  st.as.getRange(app.row, TA_A.photo + 1).setValue(app.photo);
  // 照合（車・バイク：自動計算の距離と行き先）
  var cars = form.rows.filter(function (d) { return TA_isCar(d.means) && d.km !== null; });
  var checks = cars.length ? travelCheckSegments(cars.map(function (d) { return { code: person.code, from: d.from, to: d.to, km: d.km }; })) : [];
  cars.forEach(function (d, k) { var i = TA_trvIssue(checks[k]); if (i) d.issues.push(i); });
  var existing = TA_rowsOf_(st, app.id), sum = 0, sumOk = true;
  var newRows = [], issueCount = 0;
  form.rows.forEach(function (d) {
    var key = [d.date, d.from, d.to, d.means].join('|');
    if (d.date && existing.concat(newRows).some(function (x) { return [x.date, x.from, x.to, x.means].join('|') === key; })) d.issues.push({ code: 'dup' });
    var yen = TA_isCar(d.means) ? (d.km === null ? null : TA_carYen(d.km, rate)) : d.yen;
    if (TA_isPublic(d.means)) d.km = null;
    if (yen === null) sumOk = false; else sum += yen;
    newRows.push({ date: d.date, from: d.from, to: d.to, means: d.means, km: d.km, yen: yen, issues: d.issues });
  });
  if (form.total !== null && sumOk && form.rows.length && Math.abs(Math.floor(sum) - form.total) > 1) form.appIssues.push({ code: 'total' });
  if (form.appIssues.length) newRows.push({ date: '', from: TA_WHOLE, to: '', means: '', km: null, yen: null, issues: form.appIssues, whole: true });
  var values = newRows.map(function (d) {
    if (d.issues.length) issueCount++;
    return [app.id, "'" + person.code, d.date ? "'" + d.date : '', d.from, d.to, d.means, d.km === null ? '' : d.km, d.yen === null ? '' : d.yen,
      d.whole ? '-' : TA_TOT_WAIT, d.issues.length ? TA_CHECK : TA_OK, TA_issueText(d.issues), '', '', ''];
  });
  if (values.length) st.ds.getRange(st.ds.getLastRow() + 1, 1, values.length, TA_DETAIL_HEADER.length).setValues(values);
  st = TA_load_(ss);
  app = st.apps.filter(function (a) { return a.id === app.id; })[0];
  TA_refreshApp_(st, app, today);
  // 同じ組（imageSet）の写真は、最後の1枚のときだけ返す
  var last = true;
  if (imageSet && imageSet.id && imageSet.total > 1) {
    var cache = CacheService.getScriptCache(), k = 'ta:set:' + imageSet.id, n = (parseInt(cache.get(k) || '0', 10) || 0) + 1;
    cache.put(k, String(n), 3600);
    last = n >= imageSet.total;
  }
  var count = TA_rowsOf_(st, app.id).filter(function (d) { return d.from !== TA_WHOLE; }).length, reply = '';
  if (last) {
    reply = !ai.res ? TA_TEXT.ackNoRead : app.target ? TA_fillText(TA_TEXT.ack, { month: TA_monthLabel(app.target), n: count }) : TA_fillText(TA_TEXT.ackNoMonth, { n: count });
    if (app.target && app.reflect > app.target) reply += TA_fillText(TA_TEXT.late, { deadline: TA_md(TA_deadlineOf(app.target)) });
  }
  return { id: app.id, added: newRows.length, issues: issueCount, reply: reply };
}

// ---------------- 毎朝（7時台）：TOT の照合・回答の確認・臨時の依頼・6日の締め ----------------
/** 管理本部が入れた回答・直した欄で、要確認の行を照合し直す。{ ok: true, km, yen } か { ok: false, issue } */
function TA_recheck(d, rate, today, target) {
  if (d.from === TA_WHOLE) return { ok: true };
  var means = TA_meansOf(d.means), value = d.value, date = TA_parseDate(d.date, today, target);
  if (!date) return { ok: false, issue: 'date' };
  if (!means) return { ok: false, issue: 'means' };
  if (TA_isCar(means)) {
    var km = value !== '' ? TRV_km(value) : d.km;
    if (km === null) return { ok: false, issue: value !== '' ? 'value' : 'km' };
    return { ok: true, date: date, means: means, km: km, yen: TA_carYen(km, rate) };
  }
  var yen = value !== '' ? TA_parseYen(value) : d.yen;
  if (yen === null) return { ok: false, issue: value !== '' ? 'value' : 'yen' };
  return { ok: true, date: date, means: means, km: '', yen: yen };
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
      if (r.ok && TA_isCar(r.means)) { var c = travelCheckSegments([{ code: d.code, from: d.from, to: d.to, km: r.km }])[0], i = TA_trvIssue(c); if (i) issues.push(i); }
      if (r.ok) { set(d, TA_D.date, "'" + r.date); set(d, TA_D.means, r.means); set(d, TA_D.km, r.km); set(d, TA_D.yen, r.yen); d.means = r.means; d.date = r.date; }
      if (d.tot === '') { set(d, TA_D.tot, TA_TOT_WAIT); d.tot = TA_TOT_WAIT; }
      set(d, TA_D.result, issues.length ? TA_CHECK : TA_OK); set(d, TA_D.issue, TA_issueText(issues));
      d.result = issues.length ? TA_CHECK : TA_OK; d.issue = TA_issueText(issues);
    });
    // 2. TOT の出勤
    var tl = AC_readTotLatest_(), idx = TA_totIndex(tl && tl.results);
    st.details.filter(function (d) { return d.tot === TA_TOT_WAIT && d.result !== TA_DONE && d.from !== TA_WHOLE; }).forEach(function (d) {
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
          if (d.from !== TA_WHOLE) { set(d, TA_D.date, "'" + r.date); set(d, TA_D.means, r.means); set(d, TA_D.km, r.km); set(d, TA_D.yen, r.yen); d.km = r.km === '' ? null : r.km; d.yen = r.yen; d.means = r.means; }
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
      var due = app.target && TA_deadlineOf(app.target) > today ? TA_deadlineOf(app.target) : today;
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

/** 6日：前月の月のタブを作り、要確認の申請を来月へ回し、管理者へ未提出・要確認の一覧を送る（同じ月は1回だけ） */
function TA_close_(ss, st, month, mode, today) {
  var state = AC_state_(), key = 'ta-close:' + month;
  if (state.getProperty(key)) return month + ' は締め済み';
  var people = TA_people_(today), inputs = TRV_commuteInputs(TRV_sheetValues_(ss, TRV_COMMUTE_SHEET));
  var rows = TA_monthRows(month, people, inputs, st.apps, TA_rate_());
  var tabMsg = TA_writeMonthTab_(month, rows, mode);
  // 要確認の申請は来月へ
  var next = TA_addMonth(month, 1), moved = 0;
  rows.forEach(function (r) { r.pendingIds.forEach(function (id) {
    var a = st.apps.filter(function (x) { return x.id === id; })[0];
    st.as.getRange(a.row, TA_A.reflect + 1).setValue("'" + next);
    st.as.getRange(a.row, TA_A.note + 1).setValue((a.note ? a.note + '・' : '') + TA_monthLabel(month) + 'の締めで要確認のため来月へ');
    moved++;
  }); });
  var name = {}; people.forEach(function (p) { name[p.code] = p.name; });
  var list = function (s) { return rows.filter(function (r) { return r.values['状態'] === s; }).map(function (r) { return r.code + ' ' + name[r.code]; }); };
  var miss = list('未提出'), chk = list(TA_ST.check);
  var text = '【交通費】' + TA_monthLabel(month) + '分の申請の締切（' + TA_md(TA_deadlineOf(month)) + '）を過ぎました。' + tabMsg
    + '\n・未提出 ' + miss.length + '人' + (miss.length ? '\n' + miss.map(function (s) { return '　' + s; }).join('\n') : '')
    + '\n・要確認が残っている ' + chk.length + '人（来月に反映）' + (chk.length ? '\n' + chk.map(function (s) { return '　' + s; }).join('\n') : '')
    + (chk.length ? '\n「交通費明細」の回答をお願いします。' : '');
  if (mode === 'on') AC_pushLine_(text); else TA_plan_('管理者のまとめ', '管理者', text);
  state.setProperty(key, new Date().toISOString());
  return month + ' を締め（未提出 ' + miss.length + '・要確認 ' + chk.length + '・来月へ ' + moved + '件）';
}

/** 月のタブを作る（on：社労士共有用の「雛形」をコピー。record：従業員マスタのファイルに「（試し）」で）。同じ名前のタブがあれば作らない */
function TA_writeMonthTab_(month, rows, mode) {
  var id = TA_props_().getProperty('TRAVEL_SHAROUSHI_SHEET_ID'), sr = id ? SpreadsheetApp.openById(id) : null;
  if (mode === 'on' && !sr) return '\n※社労士共有用のシートの ID（TRAVEL_SHAROUSHI_SHEET_ID）が未設定のため、月のタブは作っていません。';
  var dest = mode === 'on' ? sr : TRV_book_();
  var name = (mode === 'on' ? '' : '交通費（試し）') + TA_tabName(TA_props_().getProperty('TRAVEL_SHAROUSHI_TAB_FORMAT'), month);
  if (dest.getSheetByName(name)) return '\n※「' + name + '」タブがすでにあるため、月のタブは作っていません（書き換えていません）。';
  var tpl = sr ? sr.getSheetByName(TA_TEMPLATE_SHEET) : null;
  if (!tpl && sr && mode === 'on') tpl = TA_template_(sr);
  var sh;
  if (tpl) { sh = tpl.copyTo(dest); sh.setName(name); }
  else { sh = dest.insertSheet(name); sh.getRange(1, 1, 1, TA_TEMPLATE_HEADER.length).setValues([TA_TEMPLATE_HEADER]).setFontWeight('bold'); sh.setFrozenRows(1); }
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(function (h) { return String(h).trim(); });
  if (rows.length) {
    sh.getRange(2, 1, rows.length, head.length).setValues(rows.map(function (r) { return head.map(function (h) { return r.values[h] !== undefined ? r.values[h] : ''; }); }));
    rows.forEach(function (r, i) { sh.getRange(i + 2, 1, 1, head.length).setBackground(r.white ? TA_WHITE : TA_GREY); });
  }
  return '\n「' + name + '」タブを作りました（' + rows.length + '人）。';
}

/** 社労士共有用に「雛形」タブを作る（無いときだけ。既存のタブは変えない） */
function TA_template_(sr) {
  var sh = sr.getSheetByName(TA_TEMPLATE_SHEET);
  if (sh) return sh;
  sh = sr.insertSheet(TA_TEMPLATE_SHEET);
  sh.getRange(1, 1, 1, TA_TEMPLATE_HEADER.length).setValues([TA_TEMPLATE_HEADER]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
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
/** 社労士共有用のシートの構成を見る（読むだけ。タブの名前・行数・1行目の見出しだけをログに出す） */
function travelApplyInspectSharoushi() {
  var id = TA_props_().getProperty('TRAVEL_SHAROUSHI_SHEET_ID');
  if (!id) throw new Error('TRAVEL_SHAROUSHI_SHEET_ID が未設定です');
  var out = SpreadsheetApp.openById(id).getSheets().map(function (sh) {
    var w = Math.max(sh.getLastColumn(), 1);
    return { name: sh.getName(), rows: sh.getLastRow(), header: sh.getRange(1, 1, 1, w).getValues()[0].map(function (h) { return String(h).trim(); }) };
  });
  out.forEach(function (t) { Logger.log(TRV_fmt('社労士共有用：「%s」%s行／見出し：%s', t.name, t.rows, t.header.join('｜'))); });
  return out;
}
/** 社労士共有用のシートに「雛形」タブを作る（無いときだけ） */
function travelApplySetupTemplate() {
  var id = TA_props_().getProperty('TRAVEL_SHAROUSHI_SHEET_ID');
  if (!id) throw new Error('TRAVEL_SHAROUSHI_SHEET_ID が未設定です');
  return TA_template_(SpreadsheetApp.openById(id)).getName();
}
function travelApplySetupTriggers() {
  travelApplyRemoveTriggers();
  ScriptApp.newTrigger('travelApplyDaily').timeBased().everyDays(1).atHour(TA_DAILY_HOUR).inTimezone(AC_TZ).create();
  ScriptApp.newTrigger('travelApplyRemind').timeBased().onMonthDay(TA_REMIND_DAY).atHour(TA_REMIND_HOUR).inTimezone(AC_TZ).create();
}
function travelApplyRemoveTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['travelApplyDaily', 'travelApplyRemind'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
}

if (typeof module !== 'undefined') {
  module.exports = { TA_openMonth: TA_openMonth, TA_reflectMonth: TA_reflectMonth, TA_parseDate: TA_parseDate, TA_parseYen: TA_parseYen, TA_aiParse: TA_aiParse,
    TA_fromAi: TA_fromAi, TA_appState: TA_appState, TA_totCheck: TA_totCheck, TA_monthRows: TA_monthRows, TA_remindTargets: TA_remindTargets, TA_VERSION: TA_VERSION };
}
