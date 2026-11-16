/**
 * 運転免許証の有効期限の管理（版 2026-11-16b・仕様と運用は docs/LICENSE_MANAGEMENT.md）
 *
 * - 従業員マスタのファイルに「免許証管理」タブを作り、社員番号ごとに免許の有無・有効期限・状態を持つ（従業員マスタ本体の A〜N 列は変更しない）
 * - 毎朝（licenseDaily）：在籍者をタブに足す／免許の有無が空欄の人の一覧／登録のお願い・催促／期限の30日前・7日前・当日・期限切れのお知らせ
 * - LINE（doPost から LIC_onUserEvent_）：「免許更新」「免許登録」の言葉・免許のボタン・受付中（30分）の写真だけを扱う。それ以外は今までどおり
 * - 写真はスクリプトプロパティ LICENSE_FOLDER_ID のフォルダに「社員番号_YYYYMMDD」で保存し、その人の古い写真はゴミ箱へ（最新の1枚だけ残す）
 * - 動作モード LICENSE_MODE：未設定・off＝何もしない／record＝送る予定の文を「免許証お知らせ記録」に書くだけ（LINE は送らない・受け口も今までどおり。
 *   同じ人・同じ期限・同じ段階は1回だけ記録し、「記録済み」の列で管理）／
 *   on＝送る（DRY_RUN が false のときだけ。それ以外は record と同じ）
 * - お知らせ設定（SAF-01）の「受け取らない」は適用しない（安全に関わるため全員必須）
 * - 写真・有効期限・氏名はログ（Logger）に書かない
 */
var LIC_VERSION = '2026-11-16b';
var LIC_SHEET = '免許証管理';
// 「送信記録」は実際に送ったもの（on）、「記録済み」は送らずに記録したもの（record・DRY_RUN）。同じ人・同じ期限・同じ段階をそれぞれ1回だけにする
var LIC_HEADER = ['社員番号', '氏名', '免許の有無', '有効期限', '状態', '写真ファイルID', '最終報告日時', '送信記録', '記録済み', '備考'];
var LIC_KEYS = ['code', 'name', 'has', 'exp', 'state', 'file', 'reportAt', 'log', 'rec', 'note'];   // LIC_HEADER と同じ並び
var LIC_RECORD_SHEET = '免許証お知らせ記録';
var LIC_RECORD_HEADER = ['日時', 'モード', '種類', '送信先', '社員番号', '文面', '結果'];
var LIC_STATE = { wait: '登録待ち', ok: '登録済み', soon: '更新待ち', over: '期限切れ報告なし', check: '要確認',
  ask: '有無の確認待ち', none: '対象外（免許なし）', retired: '退職' };
var LIC_WAIT_MIN = 30;               // 写真を受け付ける時間（分）
var LIC_PENDING_SEC = 21600;         // 写真のあと、期限のボタンを受け付ける時間（秒・6時間）
var LIC_REMIND_DAYS = [3, 7];        // 登録のお願いから何日後に催促するか
var LIC_NOREG_GROUP_DAYS = 10;       // 登録のお願いから何日たっても登録がなければ、勤怠管理グループへ一覧
var LIC_WORDS = ['免許更新', '免許登録'];
var LIC_HOUR = 9;                    // 毎朝の処理の時刻（9時台）
var LIC_NOTICE_ID = 'SAF-01', LIC_NOTICE_NAME = '運転免許証の更新案内';
var LIC_STAGE_LABEL = { d30: '30日前', d7: '7日前', d0: '当日', over: '期限切れ' };

// ---------------- 純粋関数（日付） ----------------
/** 純粋関数：セルの値 → 'yyyy-mm-dd'。空なら ''、日付として読めなければ null */
function LIC_parseYmd(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return null;
    return new Date(v.getTime() + 9 * 3600000).toISOString().slice(0, 10);   // 日本時間の日付
  }
  var m = /^\s*(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?\s*$/.exec(String(v));
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3], t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}
function LIC_utc_(ymd) { var p = ymd.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
/** 純粋関数：a から b まで何日か（b が後なら正） */
function LIC_daysBetween(a, b) { return Math.round((LIC_utc_(b) - LIC_utc_(a)) / 86400000); }
function LIC_addDays(ymd, n) { return new Date(LIC_utc_(ymd) + n * 86400000).toISOString().slice(0, 10); }
/** 純粋関数：n 年後の同じ日（2/29 で翌年以降に無ければ 2/28） */
function LIC_addYears(ymd, n) {
  var p = ymd.split('-'), y = +p[0] + n, mo = +p[1], d = +p[2];
  var t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCMonth() !== mo - 1) t = new Date(Date.UTC(y, mo, 0));
  return t.toISOString().slice(0, 10);
}
/** 純粋関数：'2027-03-15' → '2027年3月15日' */
function LIC_jpDate(ymd) { var p = String(ymd).split('-'); return +p[0] + '年' + +p[1] + '月' + +p[2] + '日'; }

/** 純粋関数：期限までの日数からお知らせの段階。30日前（8〜30日）・7日前（1〜7日）・当日・期限切れ（翌日以降）。それ以外は null */
function LIC_stage(exp, today) {
  var days = LIC_daysBetween(today, exp);
  if (days < 0) return { stage: 'over', days: days };
  if (days === 0) return { stage: 'd0', days: 0 };
  if (days <= 7) return { stage: 'd7', days: days };
  if (days <= 30) return { stage: 'd30', days: days };
  return { stage: null, days: days };
}

/** 純粋関数：「免許の有無」の値 → 'あり'／'なし'／''（それ以外の書き方は空欄と同じ） */
function LIC_hasValue(v) {
  var s = String(v == null ? '' : v).replace(/[\s　]/g, '');
  if (/^(あり|有|有り|○|〇)$/.test(s)) return 'あり';
  if (/^(なし|無|無し|×)$/.test(s)) return 'なし';
  return '';
}

/** 純粋関数：LINE の言葉が「免許更新」「免許登録」だけか（前後の空白は無視。ほかの文を含めば対象外） */
function LIC_isWord(text) { return LIC_WORDS.indexOf(String(text == null ? '' : text).replace(/^[\s　]+|[\s　]+$/g, '')) !== -1; }

/** 純粋関数：写真のファイル名（社員番号_YYYYMMDD）がこの人のものか */
function LIC_isPhotoOf(name, code) { return new RegExp('^' + String(code) + '_\\d{8}').test(String(name || '')); }

// ---------------- 純粋関数（送信記録） ----------------
// 「送信記録」列：1行に1件「<種類> <期限 または -> <送った日>」。例「30日前 2027-03-15 2027-02-13」「登録のお願い - 2026-11-16」
function LIC_parseLog(s) {
  return String(s == null ? '' : s).split(/\n/).map(function (l) { return l.trim().split(/\s+/); })
    .filter(function (p) { return p.length >= 3; }).map(function (p) { return { label: p[0], key: p[1], at: p[2] }; });
}
function LIC_logHas(entries, label, key) { return entries.some(function (e) { return e.label === label && e.key === (key || '-'); }); }
function LIC_logGet(entries, label) { for (var i = 0; i < entries.length; i++) if (entries[i].label === label) return entries[i]; return null; }
function LIC_logAdd(s, label, key, at) { var t = String(s == null ? '' : s).replace(/\s+$/, ''); return (t ? t + '\n' : '') + label + ' ' + (key || '-') + ' ' + at; }

// ---------------- 純粋関数（タブ・従業員マスタ） ----------------
/** 純粋関数：見出しの行から列の位置。{ col: {code: 0, ...}, missing: ['備考', ...] } */
function LIC_cols(header) {
  var col = {}, missing = [];
  LIC_HEADER.forEach(function (h, k) {
    var j = (header || []).map(function (x) { return String(x == null ? '' : x).trim(); }).indexOf(h);
    if (j === -1) missing.push(h); else col[LIC_KEYS[k]] = j;
  });
  return { col: col, missing: missing };
}

/** 純粋関数：タブの値 → 行の一覧（i はシートの行番号－1） */
function LIC_rows(values, col) {
  var out = [];
  for (var i = 1; i < (values || []).length; i++) {
    var r = values[i], code = AC_cellCode_(r[col.code]);
    if (!code) continue;
    out.push({ i: i, code: code, name: String(r[col.name] || '').trim(), has: LIC_hasValue(r[col.has]), exp: LIC_parseYmd(r[col.exp]),
      state: String(r[col.state] || '').trim(), file: String(r[col.file] || '').trim(), log: String(r[col.log] == null ? '' : r[col.log]), rec: String(r[col.rec] == null ? '' : r[col.rec]) });
  }
  return out;
}

/**
 * 純粋関数：従業員マスタから、社員番号 → { code, name, userId }（在籍者だけ。退職・退職日を過ぎた人は入れない）。
 * userId は「LINE確認済み」で、同じ LINE ID の行がほかに無いときだけ（それ以外は ''＝LINE未登録として扱う）
 */
function LIC_people(masterValues, today) {
  var out = {}, uidCount = {};
  for (var i = 1; i < (masterValues || []).length; i++) {
    var u = String(masterValues[i][AC_COL.userId] || '').trim();
    if (u) uidCount[u] = (uidCount[u] || 0) + 1;
  }
  for (var j = 1; j < (masterValues || []).length; j++) {
    var r = masterValues[j], code = AC_cellCode_(r[AC_COL.code]);
    if (!code || out[code]) continue;
    if (String(r[AC_COL.status] || '').trim() === '退職' || AC_isRetired(r[AC_COL.retiredOn], today)) continue;
    var uid = String(r[AC_COL.userId] || '').trim();
    out[code] = { code: code, name: String(r[AC_COL.name] || '').trim(),
      userId: AC_isUserId(uid) && r[AC_COL.lineOk] === true && uidCount[uid] === 1 ? uid : '' };
  }
  return out;
}

/** 純粋関数：LINE ID からその人（在籍・LINE確認済み・1行だけ）。見つからなければ null */
function LIC_personByUid(masterValues, uid, today) {
  var people = LIC_people(masterValues, today);
  for (var k in people) if (people[k].userId && people[k].userId === uid) return people[k];
  return null;
}

/** 純粋関数：状態の列の値。「要確認」は管理本部が直すまで残す（退職・免許なしは除く） */
function LIC_statusFor(row, retired, today) {
  if (retired) return LIC_STATE.retired;
  if (row.has === 'なし') return LIC_STATE.none;
  if (row.has === '') return LIC_STATE.ask;
  if (row.state === LIC_STATE.check || row.exp === null) return LIC_STATE.check;
  if (row.exp === '') return LIC_STATE.wait;
  var s = LIC_stage(row.exp, today);
  return s.stage === 'over' ? LIC_STATE.over : s.stage ? LIC_STATE.soon : LIC_STATE.ok;
}

// ---------------- 文面 ----------------
var LIC_TEXT = {
  req: '{name}さん、お疲れさまです。管理本部です。\n運転免許証の有効期限を管理するため、免許証の登録をお願いいたします。\n下のボタンを押して、免許証の写真をお送りください。\nいつもご協力ありがとうございます。',
  rem: '{name}さん、お疲れさまです。管理本部です。\n先日お願いした運転免許証の登録が、まだ確認できていません。\nお手すきの際に、下のボタンから免許証の写真をお送りいただけますと助かります。\nご協力ありがとうございます。',
  d30: '{name}さん、お疲れさまです。管理本部です。\n運転免許証の有効期限（{date}）まで、あと{days}日になりました。\n更新がお済みになりましたら、「免許更新」と送るか下のボタンを押して、新しい免許証の写真をお送りください。\nいつもご協力ありがとうございます。',
  d7: '{name}さん、お疲れさまです。管理本部です。\n運転免許証の有効期限（{date}）まで、あと{days}日です。更新のご報告をまだ確認できていないため、ご案内いたしました。\nすでに更新がお済みでしたら、「免許更新」と送るか下のボタンを押して、新しい免許証の写真をお送りいただけますと助かります。\nご協力ありがとうございます。',
  d0: '{name}さん、お疲れさまです。管理本部です。\n運転免許証の有効期限は、本日（{date}）までです。\nすでに更新がお済みでしたら、「免許更新」と送るか下のボタンを押して、新しい免許証の写真をお送りいただけますと助かります。\nご協力ありがとうございます。',
  over: '{name}さん、お疲れさまです。管理本部です。\n運転免許証の有効期限（{date}）を過ぎましたが、更新のご報告をまだ確認できていません。\nすでに更新がお済みでしたら、「免許更新」と送って新しい免許証の写真をお送りいただけますと助かります。\nご協力ありがとうございます。',
  start: 'ありがとうございます。\n免許証の表面の写真を、このトークにお送りください（30分以内にお願いいたします）。\n有効期限の文字がはっきり写るように撮っていただけますと助かります。',
  photoReg: '写真を受け取りました。ありがとうございます。\n続けて、免許証に書かれている有効期限を、下のボタンから選んでください。',
  photoUpd: '写真を受け取りました。ありがとうございます。\n新しい免許証の有効期限を、下のボタンから選んでください。',
  thanksReg: '{name}さん、ご登録ありがとうございます。\n運転免許証の有効期限を{date}で記録しました。\n期限が近づきましたら、こちらから改めてご案内いたします。',
  thanksUpd: '{name}さん、更新のご報告ありがとうございます。\n新しい有効期限を{date}で記録しました。\n次の期限が近づきましたら、こちらから改めてご案内いたします。',
  again: '受付の時間が過ぎたため、記録できませんでした。お手数ですが、もう一度「免許更新」と送って、写真からお送りいただけますか。',
  already: 'ありがとうございます。有効期限はすでに{date}で記録しています。',
  badDate: '選ばれた日付（{date}）は今日より前のため、記録できませんでした。お手数ですが、もう一度下のボタンから選んでいただけますか。',
  photoFail: '申し訳ありません。写真をうまく受け取れませんでした。お手数ですが、少し時間をおいて、もう一度写真をお送りいただけますか。',
  notTarget: '申し訳ありません。このボタンは今は使えません。ご不明な点は、このトークで管理本部へお知らせください。',
};
function LIC_fill(t, v) { return String(t).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] !== undefined ? String(v[k]) : m; }); }

/** 純粋関数：本人あての文面（最後に AI の一文）とボタンのフレックスメッセージ */
function LIC_flex(text, actions) {
  var body = AC_withAiNote(text);
  var msg = { type: 'flex', altText: body.split('\n').slice(0, 2).join(' ').slice(0, 300),
    contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: body, wrap: true, size: 'sm' }] } } };
  if (actions && actions.length) {
    msg.contents.footer = { type: 'box', layout: 'vertical', spacing: 'sm',
      contents: actions.map(function (a, k) { return { type: 'button', style: k === 0 ? 'primary' : 'secondary', height: 'sm', action: a }; }) };
  }
  return msg;
}
function LIC_startAction(update) {
  return { type: 'postback', label: update ? '更新を報告する' : '免許証を登録する', data: 'lic|1|start',
    displayText: update ? '免許証の更新を報告します' : '免許証を登録します' };
}

/** 純粋関数：毎朝の本人あてのメッセージ（kind：req・rem・d30・d7・d0・over） */
function LIC_selfMessage(kind, name, exp, days) {
  var text = LIC_fill(LIC_TEXT[kind], { name: name, date: exp ? LIC_jpDate(exp) : '', days: days });
  return LIC_flex(text, [LIC_startAction(kind !== 'req' && kind !== 'rem')]);
}

/** 純粋関数：写真を受け取ったあとの、期限を選ぶメッセージ。base＝今の期限（無ければ登録＝カレンダーだけ） */
function LIC_dateMessage(nonce, base, today) {
  var min = LIC_addDays(today, 1), max = LIC_addYears(today, 15);
  if (!base) {
    return LIC_flex(LIC_TEXT.photoReg, [{ type: 'datetimepicker', label: '有効期限を選ぶ', data: 'lic|1|pick|' + nonce, mode: 'date',
      initial: LIC_addYears(today, 1), min: min, max: max }]);
  }
  var y3 = LIC_addYears(base, 3), y5 = LIC_addYears(base, 5);
  return LIC_flex(LIC_TEXT.photoUpd, [
    { type: 'postback', label: LIC_jpDate(y3) + '（3年後）', data: 'lic|1|y3|' + nonce, displayText: LIC_jpDate(y3) + '（3年後）' },
    { type: 'postback', label: LIC_jpDate(y5) + '（5年後）', data: 'lic|1|y5|' + nonce, displayText: LIC_jpDate(y5) + '（5年後）' },
    { type: 'datetimepicker', label: 'その他（カレンダーで選ぶ）', data: 'lic|1|other|' + nonce, mode: 'date',
      initial: y3 > min && y3 < max ? y3 : min, min: min, max: max },
  ]);
}

/** 純粋関数：勤怠管理グループ（・管理者）への一覧の文。list：[{code, name, exp}] */
function LIC_groupText(kind, list) {
  var head = {
    ask: '【免許証】「免許の有無」が未入力の方がいます（' + list.length + '名）',
    noline: '【免許証】LINE が未登録のため、免許証の案内を送れない方がいます（' + list.length + '名）',
    noreg: '【免許証】登録のお願いと催促（2回）を送りましたが、まだ免許証の登録がない方がいます（' + list.length + '名）',
    over: '【免許証】有効期限を過ぎても、更新の報告がない方がいます（' + list.length + '名）',
  }[kind];
  var foot = {
    ask: '従業員マスタのファイルの「免許証管理」タブで、「免許の有無」に「あり」か「なし」を入れてください。',
    noline: '社員番号の LINE 登録をご案内いただくか、免許証の確認を直接お願いします。',
    noreg: '本人へのお声がけをお願いします。',
    over: '本人へ更新の状況のご確認をお願いします（すでに更新済みのこともあります）。',
  }[kind];
  var lines = list.map(function (p) { return '・' + p.code + ' ' + (p.name || '（氏名なし）') + (kind === 'over' && p.exp ? '（期限 ' + LIC_jpDate(p.exp) + '）' : ''); });
  return [head].concat(lines).concat([foot]).join('\n');
}

/**
 * 純粋関数：毎朝の処理の計画。people：LIC_people、rows：LIC_rows、only：'reg' なら登録まわりだけ（licenseRegisterSend）、
 * recordOnly：送らずに記録するとき（record・DRY_RUN）は「記録済み」の列で、送るときは「送信記録」の列で、済んだものを判定する
 * 戻り値 { add: [person], states: [{i, state}], self: [{row, kind, mark:{label,key}, marks}], groups: {ask, noline, noreg, over: [{row, ...}]} }
 */
function LIC_plan(people, rows, today, only, recordOnly) {
  var plan = { add: [], states: [], self: [], groups: { ask: [], noline: [], noreg: [], over: [] } };
  var inTab = {};
  rows.forEach(function (r) { inTab[r.code] = true; });
  Object.keys(people).forEach(function (code) { if (!inTab[code]) plan.add.push(people[code]); });
  rows.forEach(function (r) {
    var p = people[r.code], retired = !p, st = LIC_statusFor(r, retired, today), log = LIC_parseLog(recordOnly ? r.rec : r.log);
    if (st !== r.state) plan.states.push({ i: r.i, state: st });
    if (retired || r.has === 'なし') return;
    var who = { row: r, code: r.code, name: (p && p.name) || r.name, exp: r.exp, userId: p.userId };
    if (r.has === '') { if (!LIC_logHas(log, '有無の確認')) plan.groups.ask.push(who); return; }
    if (r.exp === null) return;   // 有効期限が日付として読めない：状態「要確認」だけ（管理本部が直す）
    var noLine = function () { if (!LIC_logHas(log, 'LINE未登録')) plan.groups.noline.push(who); };
    if (r.exp === '') {
      if (!p.userId) { noLine(); return; }
      var req = LIC_logGet(log, '登録のお願い');
      if (!req) { plan.self.push({ who: who, kind: 'req', marks: [['登録のお願い', '-']] }); return; }
      var d = LIC_daysBetween(req.at, today), k = -1;
      LIC_REMIND_DAYS.forEach(function (n, j) { if (d >= n) k = j; });
      if (k >= 0 && !LIC_logHas(log, '催促' + (k + 1))) {
        var marks = [];
        for (var j = 0; j <= k; j++) if (!LIC_logHas(log, '催促' + (j + 1))) marks.push(['催促' + (j + 1), '-']);
        plan.self.push({ who: who, kind: 'rem', marks: marks });
      }
      if (d >= LIC_NOREG_GROUP_DAYS && !LIC_logHas(log, '登録なしの一覧')) plan.groups.noreg.push(who);
      return;
    }
    if (only === 'reg') return;
    var s = LIC_stage(r.exp, today);
    if (!s.stage) return;
    if (s.stage === 'over' && !LIC_logHas(log, '期限切れの一覧', r.exp)) plan.groups.over.push(who);
    if (LIC_logHas(log, LIC_STAGE_LABEL[s.stage], r.exp)) return;
    if (!p.userId) { noLine(); return; }
    plan.self.push({ who: who, kind: s.stage, days: s.days, marks: [[LIC_STAGE_LABEL[s.stage], r.exp]] });
  });
  return plan;
}
var LIC_GROUP_MARK = { ask: ['有無の確認', false], noline: ['LINE未登録', false], noreg: ['登録なしの一覧', false], over: ['期限切れの一覧', true] };

// ---------------- 設定・シート ----------------
function LIC_props_() { return PropertiesService.getScriptProperties(); }
function LIC_mode_() {
  var m = String(LIC_props_().getProperty('LICENSE_MODE') || '').trim();
  return m === 'on' || m === 'record' ? m : 'off';
}

/** 「免許証管理」タブ（無ければ作る）。見出しが足りなければ右端に足す（並べ替え・ほかの列はそのまま） */
function LIC_tab_(ss) {
  var sh = ss.getSheetByName(LIC_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LIC_SHEET);
    sh.getRange(1, 1, 1, LIC_HEADER.length).setValues([LIC_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
    try { sh.getRange('C2:C').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['あり', 'なし'], true).setAllowInvalid(true).build()); } catch (e) { /* 入力の候補は付かなくてもよい */ }
  }
  var header = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  var c = LIC_cols(header);
  if (c.missing.length) {
    sh.getRange(1, sh.getLastColumn() + 1, 1, c.missing.length).setValues([c.missing]).setFontWeight('bold');
    header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    c = LIC_cols(header);
  }
  return { sh: sh, col: c.col, width: header.length };
}

function LIC_cell_(t, rowIndex, key, value) { t.sh.getRange(rowIndex + 1, t.col[key] + 1).setValue(value); }

/** 送る予定・送った結果を「免許証お知らせ記録」に残す（このファイルは管理本部だけが見る従業員マスタのファイル） */
function LIC_record_(ss, rows) {
  if (!rows.length) return;
  var sh = ss.getSheetByName(LIC_RECORD_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LIC_RECORD_SHEET);
    sh.getRange(1, 1, 1, LIC_RECORD_HEADER.length).setValues([LIC_RECORD_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, LIC_RECORD_HEADER.length).setValues(rows);
}

// ---------------- LINE ----------------
function LIC_post_(path, payload) {
  var token = LIC_props_().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) return false;
  var headers = { Authorization: 'Bearer ' + token };
  if (path === 'push') headers['X-Line-Retry-Key'] = Utilities.getUuid();
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/' + path, {
    method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(payload), muteHttpExceptions: true });
  return res.getResponseCode() === 200;
}
function LIC_push_(to, messages) { return !!to && LIC_post_('push', { to: to, messages: messages }); }
function LIC_reply_(replyToken, messages) { return !!replyToken && LIC_post_('reply', { replyToken: replyToken, messages: messages }); }
function LIC_replyText_(replyToken, text) { return LIC_reply_(replyToken, [{ type: 'text', text: AC_withAiNote(text) }]); }

/** 勤怠管理グループへ（届かなければ管理者へ）。admin＝管理者の個別 LINE にも送る。届いたら true */
function LIC_sendGroup_(text, admin) {
  var groups = [], sent = 0;
  try { groups = AC_groupsByDept(AC_groupSheet_().getDataRange().getValues())[AC_ADMIN_GROUP] || []; } catch (e) { Logger.log('免許証：勤怠管理グループの読み込みに失敗'); }
  groups.forEach(function (g) { try { if (LIC_push_(g, [{ type: 'text', text: text }])) sent++; } catch (e) { Logger.log('免許証：グループへの送信に失敗'); } });
  if (admin || !sent) {
    try { AC_pushLine_(sent || admin ? text : text + '\n（勤怠管理グループへ送れなかったため、こちらへお知らせしました）'); sent++; } catch (e2) { Logger.log('免許証：管理者への送信に失敗'); }
  }
  return sent > 0;
}

// ---------------- 毎朝の処理 ----------------
/** 時間主導（毎朝 9時台）：タブの更新・有無の確認・登録のお願い・催促・期限のお知らせ */
function licenseDaily() { return LIC_run_(null); }
/** 手動実行：登録のお願いをすぐ送る（初回の一括入力のあと）。期限のお知らせは送らない */
function licenseRegisterSend() { return LIC_run_('reg'); }

function LIC_run_(only) {
  var mode = LIC_mode_();
  if (mode === 'off') { Logger.log('免許証：LICENSE_MODE が未設定・off のため何もしません'); return { mode: mode }; }
  var props = LIC_props_(), live = mode === 'on' && props.getProperty('DRY_RUN') === 'false';
  var today = AC_today_(), now = new Date();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var res = { mode: mode, live: live, added: 0, self: 0, failed: 0, groups: 0 };
  try {
    var master = AC_masterSheet_(), ss = master.getParent(), mv = master.getDataRange().getValues();
    var people = LIC_people(mv, today), t = LIC_tab_(ss);
    var rows = LIC_rows(t.sh.getDataRange().getValues(), t.col);
    var plan = LIC_plan(people, rows, today, only, !live);
    if (plan.add.length) {   // 在籍者でタブにいない人を足す（免許の有無は空欄）
      var add = plan.add.map(function (p) {
        var r = []; for (var k = 0; k < t.width; k++) r.push('');
        r[t.col.code] = "'" + p.code; r[t.col.name] = p.name; r[t.col.state] = LIC_STATE.ask;
        return r;
      });
      t.sh.getRange(t.sh.getLastRow() + 1, 1, add.length, t.width).setValues(add);
      res.added = add.length;
      rows = LIC_rows(t.sh.getDataRange().getValues(), t.col);
      plan = LIC_plan(people, rows, today, only, !live);
    }
    plan.states.forEach(function (s) { LIC_cell_(t, s.i, 'state', s.state); });
    var logs = {}, rec = [], nlog = [];
    var mark = function (row, label, key) { logs[row.i] = LIC_logAdd(logs[row.i] !== undefined ? logs[row.i] : live ? row.log : row.rec, label, key, today); };
    plan.self.forEach(function (s) {
      var msg = LIC_selfMessage(s.kind, s.who.name, s.who.exp, s.days), text = msg.contents.body.contents[0].text, ok = false;
      if (live) {
        try { ok = LIC_push_(s.who.userId, [msg]); } catch (e) { ok = false; }
        if (ok) { s.marks.forEach(function (m) { mark(s.who.row, m[0], m[1]); }); res.self++; } else res.failed++;
        nlog.push([now, LIC_NOTICE_ID, LIC_NOTICE_NAME, '本人', "'" + s.who.code, '', ok ? '送信済み（' + s.kind + '）' : '送信失敗（' + s.kind + '）', ok ? '' : 'LINEの送信に失敗']);
      }
      if (!live) s.marks.forEach(function (m) { mark(s.who.row, m[0], m[1]); });   // 記録だけ：「記録済み」に付ける
      rec.push([now, mode, s.kind, '本人', "'" + s.who.code, text, live ? (ok ? '送信済み' : '送信失敗') : '記録のみ（送信なし）']);
    });
    Object.keys(plan.groups).forEach(function (kind) {
      var list = plan.groups[kind];
      if (!list.length) return;
      var text = LIC_groupText(kind, list), admin = LIC_GROUP_MARK[kind][1], ok = false;
      if (live) {
        ok = LIC_sendGroup_(text, admin);
        if (ok) { list.forEach(function (w) { mark(w.row, LIC_GROUP_MARK[kind][0], kind === 'over' ? w.exp : '-'); }); res.groups++; }
        nlog.push([now, LIC_NOTICE_ID, LIC_NOTICE_NAME, admin ? '勤怠管理グループ・管理者' : '勤怠管理グループ', '', '', ok ? '送信済み（' + kind + '・' + list.length + '名）' : '送信失敗（' + kind + '）', ok ? '' : 'LINEの送信に失敗']);
      }
      if (!live) list.forEach(function (w) { mark(w.row, LIC_GROUP_MARK[kind][0], kind === 'over' ? w.exp : '-'); });
      rec.push([now, mode, kind, admin ? '勤怠管理グループ・管理者' : '勤怠管理グループ', '', text, live ? (ok ? '送信済み' : '送信失敗') : '記録のみ（送信なし）']);
    });
    Object.keys(logs).forEach(function (i) { LIC_cell_(t, +i, live ? 'log' : 'rec', logs[i]); });   // record では「送信記録」を付けない（on にしたとき送るため）。「記録済み」に付ける
    LIC_record_(ss, rec);
    if (nlog.length) AC_noticeLog_(nlog);
  } finally { lock.releaseLock(); }
  Logger.log('免許証（%s）：追加 %s人／本人へ %s件（失敗 %s件）／一覧 %s件', mode + (live ? '' : '・送信なし'), res.added, res.self, res.failed, res.groups);
  return res;
}

/** 手動実行：「免許証管理」タブを作り、在籍者の行を足すだけ（LINE は送らない・LICENSE_MODE に関係なく動く） */
function licenseSetup() {
  var master = AC_masterSheet_(), ss = master.getParent(), today = AC_today_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var people = LIC_people(master.getDataRange().getValues(), today), t = LIC_tab_(ss);
    var rows = LIC_rows(t.sh.getDataRange().getValues(), t.col), add = LIC_plan(people, rows, today, 'reg').add;
    if (add.length) {
      t.sh.getRange(t.sh.getLastRow() + 1, 1, add.length, t.width).setValues(add.map(function (p) {
        var r = []; for (var k = 0; k < t.width; k++) r.push('');
        r[t.col.code] = "'" + p.code; r[t.col.name] = p.name; r[t.col.state] = LIC_STATE.ask;
        return r;
      }));
    }
    Logger.log('免許証：「%s」タブ（版 %s）。追加 %s人', LIC_SHEET, LIC_VERSION, add.length);
    return add.length;
  } finally { lock.releaseLock(); }
}

/** 手動実行：毎朝の処理のトリガー（9時台）を作る。何度実行しても1本だけ。ほかのトリガーには触れない */
function licenseSetupTrigger() {
  licenseRemoveTrigger();
  ScriptApp.newTrigger('licenseDaily').timeBased().everyDays(1).atHour(LIC_HOUR).inTimezone(AC_TZ).create();
  Logger.log('免許証：毎朝の処理のトリガーを作りました（%s時台）', LIC_HOUR);
}
function licenseRemoveTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'licenseDaily') ScriptApp.deleteTrigger(t); });
}

// ---------------- LINE の受け口（doPost の AC_handleEvent_ から） ----------------
/**
 * 純粋関数：この出来事を免許証の処理で扱うか。'postback'（免許のボタン）／'word'（「免許更新」「免許登録」）／'photo'（受付中の写真）／null（今までどおり）
 * waiting：その人が写真の受付中か（画像のときだけ見る）
 */
function LIC_eventKind(ev, waiting) {
  if (!ev) return null;
  if (ev.type === 'postback') return /^lic\|1\|/.test(String(ev.postback && ev.postback.data || '')) ? 'postback' : null;
  if (ev.type !== 'message' || !ev.message) return null;
  if (ev.message.type === 'text') return LIC_isWord(ev.message.text) ? 'word' : null;
  if (ev.message.type === 'image') return waiting ? 'photo' : null;
  return null;
}

/** 純粋関数：免許のボタンの中身。{ action: 'start'|'y3'|'y5'|'pick'|'other', nonce } または null */
function LIC_parsePostback(data) {
  var m = /^lic\|1\|(start|y3|y5|pick|other)(?:\|([0-9a-f]{12}))?$/.exec(String(data || ''));
  if (!m || (m[1] !== 'start' && !m[2])) return null;
  return { action: m[1], nonce: m[2] || '' };
}

function LIC_cache_() { return CacheService.getScriptCache(); }
function LIC_cacheGet_(key) { try { var v = LIC_cache_().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function LIC_cachePut_(key, obj, sec) { LIC_cache_().put(key, JSON.stringify(obj), sec); }
function LIC_cacheDel_(key) { try { LIC_cache_().remove(key); } catch (e) { /* 消せなくても時間で消える */ } }

/** 写真の受付中か（30分以内）。過ぎていれば消して null */
function LIC_waiting_(uid) {
  var w = LIC_cacheGet_('lic:wait:' + uid);
  if (!w) return null;
  if (Date.now() - w.at > LIC_WAIT_MIN * 60000) { LIC_cacheDel_('lic:wait:' + uid); return null; }
  return w;
}

/**
 * 1対1のトークの出来事のうち、免許証のものだけを扱う。扱ったら true（呼び出し元はそこで終わる）、それ以外は false（今までどおりの処理へ）。
 * LICENSE_MODE が on でなければ、何も読まずに false。
 */
function LIC_onUserEvent_(ev) {
  if (LIC_mode_() !== 'on') return false;
  var uid = ev && ev.source && ev.source.userId;
  if (!AC_isUserId(uid)) return false;
  var isImage = ev.type === 'message' && ev.message && ev.message.type === 'image';
  var waiting = isImage ? LIC_waiting_(uid) : null;
  var kind = LIC_eventKind(ev, waiting);
  if (!kind) return false;
  try {
    var dupKey = 'lic:ev:' + (ev.webhookEventId || '');
    if (ev.webhookEventId && LIC_cacheGet_(dupKey)) return true;   // LINE の再送：処理済み
    var handled = kind === 'photo' ? LIC_onPhoto_(ev, uid, waiting) : kind === 'word' ? LIC_onStart_(ev, uid, false) : LIC_onPostback_(ev, uid);
    if (handled && ev.webhookEventId) LIC_cachePut_(dupKey, { at: Date.now() }, LIC_PENDING_SEC);
    return handled;
  } catch (err) {
    Logger.log('免許証の処理エラー：%s', err && err.message ? err.message : '');
    AC_adminNotice_('license', '【エラー】運転免許証の受付の処理で問題がありました🙇‍♀️\n（' + (err && err.message ? err.message : '不明なエラー') + '）');
    try { LIC_replyText_(ev.replyToken, LIC_TEXT.photoFail); } catch (e2) { /* 返信できなくても続ける */ }
    return true;
  }
}

/** その人のタブの行（在籍・LINE確認済み・免許あり）。無ければ null */
function LIC_target_(uid) {
  var master = AC_masterSheet_(), today = AC_today_(), p = LIC_personByUid(master.getDataRange().getValues(), uid, today);
  if (!p) return null;
  var t = LIC_tab_(master.getParent()), rows = LIC_rows(t.sh.getDataRange().getValues(), t.col);
  var r = rows.filter(function (x) { return x.code === p.code; })[0];
  if (!r || r.has !== 'あり') return null;
  return { person: p, row: r, tab: t, today: today };
}

/** 「免許更新」「免許登録」・登録のボタン：写真を受け付ける（30分） */
function LIC_onStart_(ev, uid, fromButton) {
  var x = LIC_target_(uid);
  if (!x) {
    if (!fromButton) return false;   // 言葉だけなら、今までどおり問い合わせへ
    LIC_replyText_(ev.replyToken, LIC_TEXT.notTarget);
    return true;
  }
  LIC_cachePut_('lic:wait:' + uid, { code: x.person.code, at: Date.now() }, LIC_WAIT_MIN * 60);
  LIC_cacheDel_('lic:date:' + uid);
  LIC_replyText_(ev.replyToken, LIC_TEXT.start);
  return true;
}

/** 受付中の写真：ドライブに保存 → 古い写真をゴミ箱へ → 期限を選んでもらう */
function LIC_onPhoto_(ev, uid, waiting) {
  var x = LIC_target_(uid);
  if (!x || x.person.code !== waiting.code) { LIC_cacheDel_('lic:wait:' + uid); return false; }
  var saved;
  try { saved = LIC_savePhoto_(ev.message.id, x.person.code, x.today); } catch (e) {
    Logger.log('免許証の写真の保存に失敗：%s', e && e.message ? e.message : '');
    AC_adminNotice_('license-photo', '【エラー】運転免許証の写真を保存できませんでした（社員番号 ' + x.person.code + '）🙇‍♀️\n（' + (e && e.message ? e.message : '不明なエラー') + '）');
    LIC_replyText_(ev.replyToken, LIC_TEXT.photoFail);   // 受付は続ける（30分以内なら送り直せる）
    return true;
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = LIC_rows(x.tab.sh.getDataRange().getValues(), x.tab.col), r = rows.filter(function (y) { return y.code === x.person.code; })[0];
    LIC_cell_(x.tab, r.i, 'file', saved.id);
    LIC_cell_(x.tab, r.i, 'reportAt', new Date());
  } finally { lock.releaseLock(); }
  var base = x.row.exp || '', nonce = Utilities.getUuid().replace(/-/g, '').slice(0, 12).toLowerCase();
  LIC_cacheDel_('lic:wait:' + uid);
  LIC_cachePut_('lic:date:' + uid, { code: x.person.code, nonce: nonce, base: base, at: Date.now(),
    y3: base ? LIC_addYears(base, 3) : '', y5: base ? LIC_addYears(base, 5) : '' }, LIC_PENDING_SEC);
  LIC_reply_(ev.replyToken, [LIC_dateMessage(nonce, base, x.today)]);
  return true;
}

/** 写真を取り出してドライブに保存し、その人の古い写真をゴミ箱へ。{ id, trashed } */
function LIC_savePhoto_(messageId, code, today) {
  var props = LIC_props_(), token = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN'), folderId = props.getProperty('LICENSE_FOLDER_ID');
  if (!folderId) throw AC_error_('LICENSE_FOLDER_ID が未設定です');
  if (!token || !messageId) throw AC_error_('LINEの設定がありません');
  var res = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/' + encodeURIComponent(messageId) + '/content', {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw AC_error_('写真を取り出せませんでした HTTP ' + res.getResponseCode());   // 応答本文は記録しない
  var folder = DriveApp.getFolderById(folderId);
  var file = folder.createFile(res.getBlob().setName(code + '_' + today.replace(/-/g, '')));
  var id = file.getId(), trashed = 0, it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getId() !== id && !f.isTrashed() && LIC_isPhotoOf(f.getName(), code)) { f.setTrashed(true); trashed++; }
  }
  return { id: id, trashed: trashed };
}

/** 免許のボタン：登録の開始、または期限（3年後・5年後・カレンダー） */
function LIC_onPostback_(ev, uid) {
  var p = LIC_parsePostback(ev.postback && ev.postback.data);
  if (!p) { LIC_replyText_(ev.replyToken, LIC_TEXT.notTarget); return true; }
  if (p.action === 'start') return LIC_onStart_(ev, uid, true);
  var pend = LIC_cacheGet_('lic:date:' + uid);
  if (!pend || pend.nonce !== p.nonce) { LIC_replyText_(ev.replyToken, LIC_TEXT.again); return true; }
  if (pend.done) { LIC_replyText_(ev.replyToken, LIC_fill(LIC_TEXT.already, { date: LIC_jpDate(pend.done) })); return true; }
  var x = LIC_target_(uid);
  if (!x || x.person.code !== pend.code) { LIC_replyText_(ev.replyToken, LIC_TEXT.notTarget); return true; }
  var date = p.action === 'y3' ? pend.y3 : p.action === 'y5' ? pend.y5 : LIC_parseYmd(ev.postback.params && ev.postback.params.date);
  if (!date) { LIC_replyText_(ev.replyToken, LIC_TEXT.again); return true; }
  if (date <= x.today) {
    LIC_reply_(ev.replyToken, [LIC_flex(LIC_fill(LIC_TEXT.badDate, { date: LIC_jpDate(date) }), LIC_dateMessage(pend.nonce, pend.base, x.today).contents.footer.contents.map(function (b) { return b.action; }))]);
    return true;
  }
  var other = p.action === 'other', update = !!pend.base;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = LIC_rows(x.tab.sh.getDataRange().getValues(), x.tab.col), r = rows.filter(function (y) { return y.code === x.person.code; })[0];
    LIC_cell_(x.tab, r.i, 'exp', date);
    LIC_cell_(x.tab, r.i, 'reportAt', new Date());
    var nr = { has: r.has, exp: date, state: other ? LIC_STATE.check : (r.state === LIC_STATE.check ? '' : r.state) };
    LIC_cell_(x.tab, r.i, 'state', LIC_statusFor(nr, false, x.today));
    if (other) LIC_cell_(x.tab, r.i, 'note', LIC_logAdd(x.tab.sh.getRange(r.i + 1, x.tab.col.note + 1).getValue(), '「その他」で期限を選択', date, x.today));
  } finally { lock.releaseLock(); }
  pend.done = date;
  LIC_cachePut_('lic:date:' + uid, pend, LIC_PENDING_SEC);
  LIC_replyText_(ev.replyToken, LIC_fill(update ? LIC_TEXT.thanksUpd : LIC_TEXT.thanksReg, { name: x.person.name, date: LIC_jpDate(date) }));
  if (other) {
    try {
      AC_pushLine_('【免許証・要確認】' + x.person.code + ' ' + x.person.name + 'さんが、新しい有効期限を「その他（カレンダー）」で選びました（' + LIC_jpDate(date)
        + (pend.base ? '・前の期限 ' + LIC_jpDate(pend.base) : '') + '）。\n「免許証管理」タブの写真と有効期限をご確認のうえ、状態を直してください。');
    } catch (e) { Logger.log('免許証：管理者への送信に失敗'); }
  }
  return true;
}

if (typeof module !== 'undefined') {
  module.exports = { LIC_parseYmd: LIC_parseYmd, LIC_daysBetween: LIC_daysBetween, LIC_addYears: LIC_addYears, LIC_stage: LIC_stage,
    LIC_statusFor: LIC_statusFor, LIC_plan: LIC_plan, LIC_eventKind: LIC_eventKind, LIC_parsePostback: LIC_parsePostback, LIC_VERSION: LIC_VERSION };
}
