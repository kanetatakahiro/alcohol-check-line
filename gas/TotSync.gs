/**
 * 勤怠連絡フォームの承認 → Touch On Time（TOT）の日別スケジュールへの自動反映（版 2026-11-13c）
 * 設計：docs/TOT_SCHEDULE_SYNC_DESIGN.md
 *
 * 流れ：
 *  1. フォーム送信（区分が欠勤・有給休暇・休みの変更）→ 「TOT反映」シート（従業員マスタのファイル）に1行足し、
 *     勤怠管理グループへ承認のカード（ボタン「承認してTOTに反映」「反映しない」）を送る。
 *  2. ボタン → 押した人を確かめて（勤怠管理グループのメンバー・合言葉・同じイベントの2回目でない）、状態を進める。
 *  3. VPS（src/tot-write.js、10分ごと）が Webアプリへ type: 'tot-write-queue' で「反映待ち」を取りに来る → 「反映中」にして渡す。
 *     VPS は打刻とスケジュールを読み直してから TOT に書き込み、type: 'tot-write-result' で結果を返す。
 *  4. 結果を勤怠管理グループへ知らせる（反映済みには「元に戻す」ボタン）。仕組みのエラーは管理者へ（AC_adminNotice_）。
 *
 * 書き方（決まったこと）：欠勤＝全日休暇の休暇区分 3、有給休暇＝1。休みの変更＝公休（9）の日と出勤予定の日を入れ替える。
 * 過ぎた日・打刻がある日は書き込まない（本人のスケジュール申請に戻す。打刻のお知らせの【勤怠の変更】の文で依頼される）。
 *
 * スクリプトプロパティ TOT_WRITE：
 *   未設定（off）＝何もしない（シートもカードも作らない）
 *   record＝承認のカードまで出し、承認すると「承認済み（記録のみ）」にする。VPS へは渡さない（TOT に書き込まない）
 *   on＝承認すると「反映待ち」にし、VPS が書き込む（VPS の .env に TOT_WRITE_TOKEN が無ければ VPS は何もしない）
 *
 * 状態（一方向）：承認待ち → 反映待ち → 反映中 → 反映済み／失敗、承認待ち → 反映しない、承認待ち → 承認済み（記録のみ）、
 *   反映済み → 元に戻す待ち → 元に戻し中 → 元に戻し済み／元に戻し失敗。同じ人の日が重なる前の受付は「置き換え」。
 *   受付のときに自動反映できないもの（過ぎた日・入れ替えできない予定など）は「対象外」。
 * 打刻のお知らせの【勤怠の変更】：反映待ち・反映中・反映済み・元に戻す待ち・元に戻し中の連絡の分は送らない（管理本部が反映するため）。
 *   版 2026-11-13f から、これは TOT_WRITE=on のときだけ（record・未設定なら【勤怠の変更】で本人に依頼する）。
 *
 * ログ・GitHub に氏名・LINE ID・従業員識別キー・トークンを書かない。VPS へは従業員識別キーと日付だけを渡す（氏名は渡さない）。
 *
 * 版 2026-11-13d で足したこと：
 *  A. 同じ人・同じ日に本人のスケジュール申請（申請中）があれば、カードに申請の内容を出し、ボタンを
 *     ［申請を承認する］（承認だけ・スケジュールは書かない）［申請を棄却してフォームの内容で反映］（先に棄却してから書く）［反映しない］の3つにする。
 *     申請は朝・夜の中継のデータ（tot-latest.json の requests）から探す。VPS が承認・棄却の直前に申請の状態を読み直す。
 *     打刻申請・残業申請はカードに出さない。申請の承認・棄却は元に戻せない（「元に戻す」はスケジュールを書いたときだけ）。
 *  B1. カードの対象者本人が押したボタンは受け付けない（従業員マスタの LINEユーザーID と社員番号で判定）。
 *  B2. 9:00・15:00 の問い合わせのまとめ（INQ_remind）に「承認待ちの勤怠の変更」を足す。対象の日の前日の15時台に承認待ちのカードはもう一度送る（1枚1回）。
 *  B3. 反映できたら（スケジュールを書いた・申請を承認した）本人へ1通（通知ID ATT-11。お知らせ設定・お知らせ停止はほかの本人向けと同じ判定）。
 *      TOT_WRITE=on かつ DRY_RUN=false のときだけ送る。それ以外は送る予定の文を「TOT反映」シートの「本人へのお知らせ」に記録する。
 */
var SCH_VERSION = '2026-11-13g';
var SCH_SHEET = 'TOT反映';
var SCH_LOG_SHEET = 'TOT反映の記録';
var SCH_HEADER = ['受付番号', '状態', '受付日時', '社員番号', '氏名', '区分', '開始日', '終了日', '変更後の休みの日', '入力者',
  '反映する内容（予定）', '合言葉', '承認者', '承認者のLINE ID', '承認日時', '受け渡し日時', '反映日時', '反映前のスケジュール', '結果',
  '元に戻した人', '元に戻した人のLINE ID', '元に戻した日時',
  'やり方', '本人の申請', '申請の結果', '本人へのお知らせ', '再通知日時'];   // 版 2026-11-13d で末尾に足した列（今のシートには見出しを足す）
var SCH_C = { id: 0, state: 1, at: 2, code: 3, name: 4, label: 5, from: 6, until: 7, changeTo: 8, by: 9, plan: 10, token: 11,
  approver: 12, approverId: 13, approvedAt: 14, handedAt: 15, doneAt: 16, before: 17, result: 18, undoBy: 19, undoById: 20, undoAt: 21,
  method: 22, requests: 23, reqResult: 24, selfMsg: 25, renotifiedAt: 26 };
/** やり方（ボタン）：反映＝フォームの内容で書く／申請を承認＝本人の申請を承認するだけ／申請を棄却して反映＝棄却してから書く */
var SCH_METHOD = { apply: '反映', approveReq: '申請を承認', rejectApply: '申請を棄却して反映' };
var SCH_ACTION_METHOD = { approve: SCH_METHOD.apply, reqok: SCH_METHOD.approveReq, reqng: SCH_METHOD.rejectApply };
var SCH_SELF_NOTICE_ID = 'ATT-11';
var SCH_RESEND_HOUR = 15;
var SCH_SELF_TEXT = 'ご自身の分は、ほかの方が承認してください。';
var SCH_LOG_HEADER = ['日時', '受付番号', '操作', '結果', 'LINEユーザーID', 'イベント番号'];
var SCH_STATE = { wait: '承認待ち', queued: '反映待ち', sending: '反映中', done: '反映済み', failed: '失敗', declined: '反映しない',
  recorded: '承認済み（記録のみ）', replaced: '置き換え', skip: '対象外', undoQueued: '元に戻す待ち', undoSending: '元に戻し中',
  undone: '元に戻し済み', undoFailed: '元に戻し失敗' };
/** 【勤怠の変更】の文を送らない状態（管理本部が反映する・した） */
var SCH_ACTIVE = [SCH_STATE.queued, SCH_STATE.sending, SCH_STATE.done, SCH_STATE.undoQueued, SCH_STATE.undoSending];
/** 休暇区分コード（TOT の GET /holiday-types で確認済み：公休 9・有休 1・欠勤 3） */
var SCH_HOLIDAY = { off: '9', paid: '1', absent: '3' };
var SCH_HOLIDAY_NAME = { '9': '公休', '1': '有休', '3': '欠勤' };
var SCH_KINDS = [{ re: /欠勤/, label: '欠勤', holiday: SCH_HOLIDAY.absent }, { re: /有給/, label: '有給休暇', holiday: SCH_HOLIDAY.paid },
  { re: /休みの変更/, label: '休みの変更', swap: true }];
var SCH_DAY_TYPE = { '平日': '1', '法定休日': '2', '法定外休日': '3' };
var SCH_MAX_DAYS = 31;
var SCH_HANDOFF_MS = 30 * 60 * 1000;          // 受け渡してから30分たっても結果が来なければ、もう一度渡す
var SCH_STUCK_MS = 3 * 60 * 60 * 1000;        // 3時間以上「反映待ち」のままなら管理者へ
var SCH_DEDUPE_ROWS = 500;
var SCH_REASON = {
  past: '過ぎた日が含まれるため',
  punched: 'その日に打刻があるため（TOT は打刻のある日のスケジュールを変えられません）',
  cannotSwap: '入れ替えられる予定ではなかったため（もともとの休みの日が休み、変更後の休みの日が出勤の予定になっている必要があります）',
  noWork: '対象の日に出勤の予定がなかったため',
  dayType: '勤務日種別を読み替えられなかったため',
  employee: 'TOT の従業員が見つからないため',
  verify: '書き込んだあとの確認で、内容が一致しなかったため',
  api: 'TOT のエラーのため',
  tooLong: '期間が' + SCH_MAX_DAYS + '日を超えるため',
  sameDay: 'もともとの休みの日と変更後の休みの日が同じため',
  noTot: '従業員マスタに TOT従業員コードが無いため',
  noUndo: '反映前のスケジュールが保存されていないため',
  requestGone: 'ご本人のスケジュール申請が、すでに承認・棄却・取り下げされていたため',
  noApprover: 'VPS に承認に使う管理者（TOT_APPROVER_KEY）が設定されていないため',
  approverNotInFlow: '承認に使う管理者が、この申請の今の承認フローの段階にいないため',
};

// ======================================================================
// 純粋関数（Node.js のテストから使う）
// ======================================================================

/** 純粋関数：フォームの区分 → 対象の種類（欠勤・有給休暇・休みの変更）。対象外は null */
function SCH_kindOf(kindText) {
  var t = String(kindText || ''), hit = null;
  SCH_KINDS.forEach(function (k) { if (!hit && k.re.test(t)) hit = k; });
  return hit;
}

/** 純粋関数：日付に n 日足す（YYYY-MM-DD） */
function SCH_addDays(d, n) {
  var t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * 純粋関数：フォームの回答 → 反映の依頼。対象外の区分・変更後の日が無い休みの変更は null。
 * a：{ kind, from, until, changeTo }（YYYY-MM-DD）。戻り値：{ label, holiday, swap, from, until, changeTo, days, reason（自動反映できない理由のキー。できるなら ''） }
 */
function SCH_requestFromForm(a, today) {
  var k = SCH_kindOf(a && a.kind);
  if (!k || !a.from) return null;
  var from = a.from, until = a.until || a.from, changeTo = k.swap ? (a.changeTo || '') : '';
  if (k.swap && !changeTo) return null;
  if (until < from) { var t = from; from = until; until = t; }
  if (k.swap) until = from;
  var days = [], reason = '';
  if (k.swap) days = [from, changeTo];
  else { for (var d = from; d <= until && days.length <= SCH_MAX_DAYS; d = SCH_addDays(d, 1)) days.push(d); }
  if (days.length > SCH_MAX_DAYS) reason = 'tooLong';
  else if (k.swap && from === changeTo) reason = 'sameDay';
  else if (days.some(function (x) { return x < today; })) reason = 'past';
  return { label: k.label, holiday: k.holiday || '', swap: !!k.swap, from: from, until: until, changeTo: changeTo, days: days, reason: reason };
}

/** 純粋関数：次の受付番号 S-YYYYMMDD-NNN */
function SCH_nextId(ids, today) {
  var prefix = 'S-' + String(today).replace(/-/g, '') + '-', max = 0;
  (ids || []).forEach(function (id) {
    id = String(id || '');
    if (id.indexOf(prefix) === 0) max = Math.max(max, Number(id.slice(prefix.length)) || 0);
  });
  return prefix + ('00' + (max + 1)).slice(-3);
}

/** 純粋関数：postback の中身（sch|1|操作|受付番号|合言葉）。違えば null */
function SCH_parsePostback(data) {
  var m = /^sch\|1\|(approve|reqok|reqng|decline|undo)\|(S-\d{8}-\d{3})\|([0-9a-f]{6})$/.exec(String(data || ''));
  return m ? { action: m[1], id: m[2], token: m[3] } : null;
}
function SCH_postbackData(action, id, token) { return 'sch|1|' + action + '|' + id + '|' + token; }

/**
 * 純粋関数：ボタンを押したときの状態の移り方（一方向）。mode：'on'／'record'
 * 戻り値 { next, changed, reason }。reason：approved／recorded／declined／undo／already／undoOff
 */
function SCH_decide(state, action, mode) {
  var S = SCH_STATE, same = { next: state, changed: false, reason: 'already' };
  if (action === 'reqok' || action === 'reqng') action = 'approve';   // 申請を承認する・申請を棄却して反映も、状態の進み方は承認と同じ
  if (action === 'approve' || action === 'decline') {
    if (state !== S.wait) return same;
    if (action === 'decline') return { next: S.declined, changed: true, reason: 'declined' };
    return mode === 'on' ? { next: S.queued, changed: true, reason: 'approved' } : { next: S.recorded, changed: true, reason: 'recorded' };
  }
  if (action === 'undo') {
    if (state !== S.done) return same;
    return mode === 'on' ? { next: S.undoQueued, changed: true, reason: 'undo' } : { next: state, changed: false, reason: 'undoOff' };
  }
  return same;
}

/** 純粋関数：勤務日種別名 → コード（1 平日／2 法定休日／3 法定外休日）。分からなければ '' */
function SCH_dayTypeCode(name) { return SCH_DAY_TYPE[String(name || '').trim()] || ''; }

/** 純粋関数：予定の時刻 'HH:mm'（先頭の0は除く） */
function SCH_hm(iso) { var m = /T(\d{2}):(\d{2})/.exec(String(iso || '')); return m ? Number(m[1]) + ':' + m[2] : ''; }

/** 純粋関数：スケジュールの全日休暇のコード（無ければ ''） */
function SCH_holidayOf(s) {
  var f = s && s.holidaysObtained && s.holidaysObtained.fulltimeHoliday;
  return f && f.code !== undefined && f.code !== null && f.code !== '' ? String(f.code) : '';
}
function SCH_holidayName(s) {
  var f = s && s.holidaysObtained && s.holidaysObtained.fulltimeHoliday, c = SCH_holidayOf(s);
  return (f && f.name) || SCH_HOLIDAY_NAME[c] || ('休暇区分' + c);
}

/** 純粋関数：その日の予定の短い説明（例「9:00-18:00 の出勤」「休み（公休）」）。分からなければ null */
function SCH_describe(s) {
  if (!s) return null;
  if (SCH_holidayOf(s)) return '休み（' + SCH_holidayName(s) + '）';
  if (s.clockInSchedule) return SCH_hm(s.clockInSchedule) + '-' + SCH_hm(s.clockOutSchedule) + ' の出勤';
  return '予定なし';
}

/**
 * 純粋関数：承認のカードに出す「反映する内容（予定）」。byDate：{ 日付: その人の日別スケジュール }（tot-latest.json の schedules。読めない日は無い）
 * 戻り値 { ok, reason, lines }。予定が読めている日で反映できないと分かるときは ok=false（cannotSwap・noWork）
 */
function SCH_preview(req, byDate) {
  byDate = byDate || {};
  var lines = [], md = function (d) { return AC_mdw_(d); };
  if (req.swap) {
    var a = byDate[req.from], b = byDate[req.changeTo];
    if (a && b && !(SCH_holidayOf(a) && b.clockInSchedule && !SCH_holidayOf(b))) {
      return { ok: false, reason: 'cannotSwap', lines: [md(req.from) + '：' + SCH_describe(a), md(req.changeTo) + '：' + SCH_describe(b)] };
    }
    var work = b ? SCH_describe(b) : '出勤（' + md(req.changeTo) + ' の予定）';
    lines.push(md(req.from) + '：' + (a ? SCH_describe(a) : '休み') + ' → ' + work + '（' + md(req.changeTo) + ' の予定をそのまま）');
    lines.push(md(req.changeTo) + '：' + (b ? SCH_describe(b) : '出勤') + ' → 休み（' + (a ? SCH_holidayName(a) : '公休') + '）');
    if (!a || !b) lines.push('（TOT の予定がまだ読めていない日があります。反映のときに確かめます）');
    return { ok: true, reason: '', lines: lines };
  }
  var to = SCH_HOLIDAY_NAME[req.holiday] || req.label, work = 0;
  req.days.forEach(function (d) {
    var s = byDate[d];
    if (!s) { lines.push(md(d) + '：（予定がまだ読めていません）→ ' + to); work++; return; }
    var h = SCH_holidayOf(s);
    if (h === String(req.holiday)) lines.push(md(d) + '：すでに' + to);
    else if (h) lines.push(md(d) + '：' + SCH_describe(s) + 'のため変更しません');
    else if (s.clockInSchedule) { lines.push(md(d) + '：' + SCH_describe(s) + ' → ' + to); work++; }
    else lines.push(md(d) + '：予定なしのため変更しません');
  });
  if (!work && req.days.every(function (d) { return byDate[d] && SCH_holidayOf(byDate[d]) !== String(req.holiday); })) return { ok: false, reason: 'noWork', lines: lines };
  return { ok: true, reason: '', lines: lines };
}

/** 純粋関数：対象の日（休みの変更は2日、ほかは開始日〜終了日） */
function SCH_days(c) {
  if (c.changeTo) return [c.from, c.changeTo];
  var out = [];
  for (var d = c.from; d && d <= c.until && out.length <= SCH_MAX_DAYS; d = SCH_addDays(d, 1)) out.push(d);
  return out;
}

/** 純粋関数：【勤怠の変更】の連絡と「TOT反映」の行を結びつけるキー */
function SCH_entryKey(code, label, from, until, changeTo) {
  return [String(code || ''), label, from, changeTo ? 'to' + changeTo : until].join(':');
}

/** 純粋関数：フォームの連絡（AC_formEntriesFromValues の byCode）のうち、管理本部が反映する（した）ものに synced=true を付ける */
function SCH_markSynced(byCode, keys) {
  keys = keys || {};
  Object.keys(byCode || {}).forEach(function (code) {
    (byCode[code] || []).forEach(function (e) {
      if (keys[SCH_entryKey(code, e.label, e.from, e.until, e.change ? e.changeTo : '')]) e.synced = true;
    });
  });
  return byCode;
}

/** 純粋関数：VPS に渡す行を選ぶ（反映待ち・元に戻す待ち、または受け渡してから30分たっても結果の来ない反映中・元に戻し中） */
function SCH_pickQueue(cases, nowMs) {
  var S = SCH_STATE;
  return (cases || []).filter(function (c) {
    if (c.state === S.queued || c.state === S.undoQueued) return true;
    if (c.state !== S.sending && c.state !== S.undoSending) return false;
    var t = c.handedAt instanceof Date ? c.handedAt.getTime() : 0;
    return !t || nowMs - t >= SCH_HANDOFF_MS;
  });
}

/** 純粋関数：VPS に渡す1件（氏名は入れない）。key：従業員識別キー */
function SCH_queueItem(c, key) {
  var undo = c.state === SCH_STATE.undoQueued || c.state === SCH_STATE.undoSending;
  var item = { id: c.id, op: undo ? 'undo' : 'apply', employeeKey: key, note: 'LINE承認：' + c.id };
  if (undo) { item.before = c.beforeObj || {}; return item; }
  if (c.method === SCH_METHOD.approveReq || c.method === SCH_METHOD.rejectApply) {
    item.method = c.method === SCH_METHOD.approveReq ? 'approve' : 'reject';
    item.requests = (c.requests || []).map(function (q) { return { requestKey: q.requestKey, date: q.date }; });
  }
  var k = SCH_kindOf(c.label);
  if (k && k.swap) { item.kind = 'swap'; item.from = c.from; item.to = c.changeTo; }
  else { item.kind = 'leave'; item.holidayCode = k ? k.holiday : ''; item.dates = SCH_days(c); }
  return item;
}

/** 純粋関数：受付の短い名前（例「試験 一郎さんの欠勤（11/12（木））」） */
function SCH_dateText(c) {
  return c.changeTo ? AC_mdw_(c.from) + '→' + AC_mdw_(c.changeTo) : (c.from === c.until ? AC_mdw_(c.from) : AC_mdw_(c.from) + '〜' + AC_mdw_(c.until));
}
function SCH_what(c) { return (c.name || '対象者') + 'さんの' + c.label + '（' + SCH_dateText(c) + '）'; }

/**
 * 純粋関数（版 2026-11-13d）：その人の対象の日の、申請中のスケジュール申請（tot-latest.json の requests から）。
 * 打刻申請・残業申請は含めない。戻り値：[{ requestKey, date, requestedDate, message, requested }]（日付の順）
 */
function SCH_pendingRequests(requests, key, days) {
  if (!key || !Array.isArray(requests)) return [];
  return requests.filter(function (r) {
    return r && !r._error && r.type === 'schedules' && r.employeeKey === key && r.status === 'applying' && r.requestKey && (days || []).indexOf(r.date) !== -1;
  }).map(function (r) {
    return { requestKey: String(r.requestKey), date: r.date, requestedDate: String(r.requestedDate || '').slice(0, 10), message: String(r.message || ''), requested: r.requested || null };
  }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}

/** 純粋関数：申請の内容の短い説明（例「休み（欠勤）」「9:00-18:00 の出勤」）。分からなければ「内容は TOT でご確認ください」 */
function SCH_requestKind(q) {
  var r = (q && q.requested) || {};
  if (r.holidayName || r.holidayCode) return '休み（' + (r.holidayName || SCH_HOLIDAY_NAME[r.holidayCode] || '休暇区分' + r.holidayCode) + '）';
  if (r.clockInSchedule) return SCH_hm(r.clockInSchedule) + '-' + SCH_hm(r.clockOutSchedule) + ' の出勤';
  return r.scheduleTypeName ? String(r.scheduleTypeName) : '（内容は TOT でご確認ください）';
}

/** 純粋関数：カードに出す本人の申請の行 */
function SCH_requestLines(reqs) {
  if (!reqs || !reqs.length) return [];
  var md = function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) ? Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)) : '不明'; };
  var out = ['■ ご本人のスケジュール申請（申請中）'];
  reqs.forEach(function (q) {
    out.push(AC_mdw_(q.date) + '：' + SCH_requestKind(q) + '（申請日 ' + md(q.requestedDate) + '）');
    if (q.message) out.push('　申請メッセージ：' + String(q.message).replace(/\s+/g, ' ').slice(0, 100));
  });
  out.push('※申請の承認・棄却は元に戻せません（「元に戻す」は TOT のスケジュールを書き換えたときだけ使えます）。');
  return out;
}

/**
 * 純粋関数：本人へのお知らせの文。days：スケジュールを変えた日（休みの変更は使わない）。rejected：棄却した申請の日
 * 版 2026-11-13g：誰からの連絡かを入れる。入力者（c.by）が本人以外なら「{入力者}さんよりご連絡をいただき、」、
 * 本人（または入力者が空）なら「勤怠変更フォームにてご入力いただいた内容で、」（本人かどうかは打刻のお知らせの【勤怠の変更】と同じ比べ方）
 */
function SCH_selfMessage(c, days, rejected) {
  var head = c.changeTo ? AC_mdw_(c.from) + 'の休みを' + AC_mdw_(c.changeTo) + 'に変更しました。'
    : (days && days.length ? days : SCH_days(c)).map(AC_mdw_).join('、') + 'は' + c.label + 'としてスケジュールを変更しました。';
  var by = String(c.by || '').trim().replace(/[\s　]*さん$/, '');
  var self = !by || AC_nameKey_(by) === AC_nameKey_(c.name || '');
  var lines = ['お疲れ様です😊', (self ? '勤怠変更フォームにてご入力いただいた内容で、' : by + 'さんよりご連絡をいただき、') + head];
  if (rejected && rejected.length) lines.push(rejected.map(AC_mdw_).join('、') + 'のスケジュール申請は、勤怠変更フォームの内容で反映したため取り下げとしました。');
  return lines.concat(['Touch On Timeでの申請は不要です。', 'ご確認のほどよろしくお願いいたします！']).join('\n');
}

/** 純粋関数：まとめのお知らせ（INQ_remind）に足す「承認待ちの勤怠の変更」（0件なら null） */
function SCH_remindText(cases) {
  var list = (cases || []).filter(function (c) { return c.state === SCH_STATE.wait; });
  if (!list.length) return null;
  return ['【承認待ちの勤怠の変更 ' + list.length + '件】'].concat(list.map(function (c) {
    return '・' + (c.name || '対象者') + 'さん ' + SCH_dateText(c) + ' ' + c.label;
  })).concat(['勤怠管理グループの承認のカードから、承認または「反映しない」を押してください。']).join('\n');
}

/** 純粋関数：前日の15時台にもう一度送るカードか（承認待ち・まだ再通知していない・いちばん早い対象の日が明日） */
function SCH_isDueForResend(c, today, hour) {
  if (c.state !== SCH_STATE.wait || !(hour >= SCH_RESEND_HOUR) || (c.renotifiedAt instanceof Date) || String(c.renotifiedAt || '')) return false;
  var first = SCH_days(c).slice().sort()[0];
  return first === SCH_addDays(today, 1);
}

/** 純粋関数：結果の理由の文（TOT のエラーは code と message だけ） */
function SCH_reasonText(r) {
  var base = SCH_REASON[r && r.reason] || '不明な理由のため';
  var errs = (r && r.errors || []).map(function (e) { return (e.code !== undefined ? 'code ' + e.code + '：' : '') + String(e.message || ''); }).filter(Boolean);
  return base + (errs.length ? '（' + errs.join('／').slice(0, 300) + '）' : '');
}

/**
 * 純粋関数：VPS から届いた結果 → 次の状態と、勤怠管理グループへの文。
 * r：{ op, method: ''|'approve'|'reject', status: 'done'|'already'|'failed', reason, errors, written: [日付], skipped: [日付],
 *      requestResults: [{ date, action: 'approved'|'rejected', status（TOT の応答の申請ステータス） }] }
 * 戻り値：{ next, text, undo（「元に戻す」ボタンを付けるか）, self（本人へ知らせるか）, selfDays, rejected }
 */
function SCH_resultPlan(c, r) {
  var S = SCH_STATE, what = SCH_what(c), ok = r.status === 'done' || r.status === 'already';
  var written = (r.written || []).map(AC_mdw_), skipped = (r.skipped || []).map(AC_mdw_), rr = r.requestResults || [];
  var rejected = rr.filter(function (x) { return x.action === 'rejected'; }).map(function (x) { return x.date; });
  if (r.op === 'undo') {
    return ok ? { next: S.undone, text: '↩️ TOT のスケジュールを元に戻しました\n' + what + (c.undoBy ? '\n操作：' + c.undoBy + 'さん' : '') }
      : { next: S.undoFailed, text: '⚠️ TOT のスケジュールを元に戻せませんでした\n' + what + '\n理由：' + SCH_reasonText(r)
        + '\nお手数ですが、TOT の管理画面で直してください。' };
  }
  if (!ok && r.reason === 'requestGone') {
    return { next: S.failed, text: 'ℹ️ ' + SCH_REASON.requestGone + '、何もしませんでした\n' + what + '\nTOT の申請の状態をご確認ください。' };
  }
  if (ok && r.method === 'approve') {
    var approved = rr.filter(function (x) { return x.action === 'approved'; });
    var still = approved.filter(function (x) { return x.status !== 'approved'; }).map(function (x) { return AC_mdw_(x.date); });
    var dates = approved.map(function (x) { return x.date; });
    var t0 = '✅ ご本人のスケジュール申請を承認しました\n' + what + (c.approver ? '\n承認：' + c.approver + 'さん' : '')
      + (dates.length ? '\n対象の日：' + dates.map(AC_mdw_).join('、') : '')
      + (still.length ? '\n（TOT の承認フローに次の段階があるため、' + still.join('、') + 'の申請はまだ申請中です）' : '')
      + '\n（スケジュールの書き換えはしていません。申請の承認は元に戻せません）';
    return { next: S.done, text: t0, undo: false, self: dates.length > 0 && !still.length, selfDays: dates, rejected: [] };
  }
  if (ok) {
    var t = '✅ TOT のスケジュールに反映しました\n' + what + (c.approver ? '\n承認：' + c.approver + 'さん' : '');
    if (r.status === 'already' && !written.length) t += '\n（すでに同じ内容だったため、書き込みはしていません）';
    else if (written.length) t += '\n反映した日：' + written.join('、');
    if (skipped.length) t += '\n変更しなかった日：' + skipped.join('、') + '（休み・予定なし）';
    if (rejected.length) t += '\nご本人のスケジュール申請（' + rejected.map(AC_mdw_).join('、') + '）は棄却しました（棄却は元に戻せません）';
    return { next: S.done, text: t, undo: written.length > 0, self: written.length > 0, selfDays: r.written || [], rejected: rejected };
  }
  var f = '⚠️ TOT のスケジュールに反映できませんでした\n' + what + '\n理由：' + SCH_reasonText(r);
  if (rejected.length) f += '\nご本人のスケジュール申請（' + rejected.map(AC_mdw_).join('、') + '）は棄却済みです。';
  if (written.length) f += '\n一部の日（' + written.join('、') + '）は書き込み済みです。TOT の管理画面でご確認ください。';
  else f += '\nご本人に、Touch On Time からのスケジュール申請をお願いします（打刻のお知らせでもご本人へお願いします）。';
  return { next: S.failed, text: f };
}

function SCH_parseJson_(t, dflt) { try { var v = t ? JSON.parse(t) : dflt; return v == null ? dflt : v; } catch (e) { return dflt; } }

/** 純粋関数：シートの1行 → 受付（列の位置は SCH_C） */
function SCH_rowToCase(r, i) {
  var C = SCH_C, s = function (k) { return String(r[C[k]] == null ? '' : r[C[k]]).trim(); }, before = null;
  try { before = s('before') ? JSON.parse(s('before')) : null; } catch (e) { before = null; }
  return { row: i + 1, id: s('id'), state: s('state'), at: r[C.at], code: AC_cellCode_(r[C.code]), name: s('name'), label: s('label'),
    from: AC_formDate_(r[C.from]), until: AC_formDate_(r[C.until]) || AC_formDate_(r[C.from]), changeTo: AC_formDate_(r[C.changeTo]),
    by: s('by'), token: s('token'), approver: s('approver'), approvedAt: r[C.approvedAt], handedAt: r[C.handedAt],
    beforeObj: before, undoBy: s('undoBy'), undoAt: r[C.undoAt],
    method: s('method') || SCH_METHOD.apply, requests: SCH_parseJson_(s('requests'), []), renotifiedAt: r[C.renotifiedAt] };
}

/** 純粋関数：承認のカード（Flex） */
function SCH_cardMessage(c, previewLines, mode, opts) {
  opts = opts || {};
  var reqs = opts.requests || c.requests || [];
  var btn = function (label, action, style) {
    return { type: 'button', style: style, height: 'sm', action: { type: 'postback', label: label, data: SCH_postbackData(action, c.id, c.token), displayText: label } };
  };
  var lines = ['対象者：' + c.name + 'さん', '区分：' + c.label,
    '日付：' + (c.changeTo ? AC_mdw_(c.from) + '（もともとの休み）→ ' + AC_mdw_(c.changeTo) + '（変更後の休み）' : (c.from === c.until ? AC_mdw_(c.from) : AC_mdw_(c.from) + '〜' + AC_mdw_(c.until))),
    '入力者：' + (c.by ? c.by + 'さん' : '（未記入）'), '', '■ TOT に反映する内容（予定）'].concat(previewLines || [])
    .concat(reqs.length ? [''].concat(SCH_requestLines(reqs)) : [])
    .concat(['', mode === 'on' ? (reqs.length ? '［申請を承認する］は申請の承認だけです（スケジュールは書き換えません）。［申請を棄却してフォームの内容で反映］は、申請を棄却してから反映します。10分ほどで TOT で処理し、結果をこのグループにお知らせします。'
        : '承認すると、10分ほどで TOT のスケジュールに反映し、結果をこのグループにお知らせします。')
      : '（試験中：承認しても TOT には書き込みません' + (reqs.length ? '。申請の承認・棄却もしません' : '') + '。反映する内容をシートに記録します）'])
    .concat(['ご自身の分は、ほかの方が承認してください。']);
  var title = opts.title || '【TOT反映の承認】';
  var buttons = reqs.length ? [btn('申請を承認する', 'reqok', 'primary'), btn('申請を棄却してフォームの内容で反映', 'reqng', 'secondary'), btn('反映しない', 'decline', 'secondary')]
    : [btn('承認してTOTに反映', 'approve', 'primary'), btn('反映しない', 'decline', 'secondary')];
  return {
    type: 'flex', altText: (title + c.name + 'さん ' + c.label).slice(0, 400),
    contents: { type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [{ type: 'text', text: title, weight: 'bold', wrap: true }]
        .concat(lines.map(function (l) { return l ? { type: 'text', text: l, wrap: true, size: 'sm' } : { type: 'separator' }; })) },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons } },
  };
}

/** 純粋関数：反映済みのお知らせ（「元に戻す」ボタン付き） */
function SCH_doneMessage(c, text) {
  return {
    type: 'flex', altText: text.split('\n').slice(0, 2).join(' ').slice(0, 400),
    contents: { type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: text.split('\n').map(function (l, i) { return { type: 'text', text: l, wrap: true, size: i ? 'sm' : 'md', weight: i ? 'regular' : 'bold' }; }) },
      footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'secondary', height: 'sm',
        action: { type: 'postback', label: '元に戻す', data: SCH_postbackData('undo', c.id, c.token), displayText: '元に戻す' } }] } },
  };
}

// ======================================================================
// シート・LINE・Webアプリとのやり取り（Apps Script 上でのみ動く）
// ======================================================================

function SCH_mode_() {
  var m = String(PropertiesService.getScriptProperties().getProperty('TOT_WRITE') || '').trim();
  return m === 'on' || m === 'record' ? m : 'off';
}

function SCH_book_() { return AC_masterSheet_().getParent(); }

function SCH_sheetOf_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  // 版 2026-11-13d：末尾に足した列の見出しが無ければ足す（今ある列・値は変えない）
  var lc = Math.max(sh.getLastColumn(), 1), have = sh.getRange(1, 1, 1, lc).getValues()[0];
  if (lc < header.length && String(have[0] || '').trim() === header[0]) {
    sh.getRange(1, lc + 1, 1, header.length - lc).setValues([header.slice(lc)]).setFontWeight('bold');
  }
  return sh;
}

function SCH_cases_(sh) {
  var v = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < v.length; i++) if (String(v[i][SCH_C.id] || '').trim()) out.push(SCH_rowToCase(v[i], i));
  return out;
}

function SCH_set_(sh, row, key, value) { sh.getRange(row, SCH_C[key] + 1).setValue(value); }

function SCH_token_() {
  var h = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  return 'abcdef'.charAt(parseInt(h.charAt(0), 16) % 6) + h.slice(1, 6);
}

function SCH_log_(ss, id, op, result, uid, eventId) {
  SCH_sheetOf_(ss, SCH_LOG_SHEET, SCH_LOG_HEADER).appendRow([new Date(), id || '', op, result, uid || '', eventId || '']);
}

/** 同じイベントの2回目なら true（一時記憶 → 記録シートの直近の行） */
function SCH_isDuplicate_(ss, ev) {
  var id = ev && ev.webhookEventId;
  if (!id) return false;
  if (CacheService.getScriptCache().get('sch:ev:' + id)) return true;
  var sh = ss.getSheetByName(SCH_LOG_SHEET);
  if (!sh) return false;
  var last = sh.getLastRow();
  if (last < 2) return false;
  var n = Math.min(SCH_DEDUPE_ROWS, last - 1), v = sh.getRange(last - n + 1, 6, n, 1).getValues();
  for (var i = 0; i < v.length; i++) if (String(v[i][0]) === id) return true;
  return false;
}
function SCH_markSeen_(ev) { if (ev && ev.webhookEventId) CacheService.getScriptCache().put('sch:ev:' + ev.webhookEventId, '1', 21600); }

/** 勤怠管理グループへ送る（届いた数）。1つも届かなければ、管理者の個別LINEへ文字だけで送る */
function SCH_send_(messages, fallbackText) {
  var groups = [], sent = 0;
  try { groups = AC_groupsByDept(AC_groupSheet_().getDataRange().getValues())[AC_ADMIN_GROUP] || []; } catch (e) { Logger.log('勤怠管理グループの読み込みに失敗'); }
  groups.forEach(function (g) { try { if (INQ_pushMessages_(g, messages)) sent++; } catch (e) { Logger.log('TOT反映のお知らせの送信に失敗'); } });
  if (!sent) {
    try { AC_pushLine_(fallbackText + '\n（勤怠管理グループへ送れなかったため、こちらへお知らせしました。ボタンは使えません）'); } catch (e2) { Logger.log('管理者への送信にも失敗'); }
  }
  return sent;
}

/** 従業員マスタの社員番号 → TOT従業員コード → 従業員識別キー（tot-latest.json の employees）。{ tot, key, data（tot-latest.json があるか） } */
function SCH_employee_(code) {
  var mv = AC_masterSheet_().getDataRange().getValues(), tot = '';
  for (var i = 1; i < mv.length; i++) if (AC_cellCode_(mv[i][AC_COL.code]) === code) tot = AC_totKey(mv[i][AC_COL.totCode]);
  var data = AC_readTotLatest_(), key = '', sched = {};
  var emps = data && data.results && Array.isArray(data.results.employees) ? data.results.employees : [];
  emps.forEach(function (e) { if (tot && AC_totKey(e.code) === tot) key = String(e.key || ''); });
  if (key && data.results.schedules && Array.isArray(data.results.schedules) && !data.results.schedules.some(function (d) { return d && d._error; })) {
    AC_totFlat_(data.results.schedules).forEach(function (s) { if (s && s.employeeKey === key) sched[s.date] = s; });
  }
  var reqs = key && data.results.requests && Array.isArray(data.results.requests) ? data.results.requests : [];
  return { tot: tot, key: key, data: !!data && emps.length > 0, schedules: sched, requests: reqs };
}

/** 従業員マスタのその社員番号の行（無ければ null） */
function SCH_masterRow_(code) {
  var mv = AC_masterSheet_().getDataRange().getValues();
  for (var i = 1; i < mv.length; i++) if (AC_cellCode_(mv[i][AC_COL.code]) === code) return mv[i];
  return null;
}

/** 押した人がカードの対象者本人か（従業員マスタの LINEユーザーID と社員番号） */
function SCH_isSelf_(code, uid) {
  var r = SCH_masterRow_(code);
  return !!r && AC_isUserId(uid) && String(r[AC_COL.userId] || '').trim() === uid;
}

/**
 * 本人へのお知らせ（版 2026-11-13d・通知ID ATT-11）。シートの「本人へのお知らせ」に書く文を返す。
 * 送るのは TOT_WRITE=on かつ DRY_RUN=false のときだけ。LINE確認済み・退職でない人だけ。お知らせ設定（AC_noticeCheck_）でOFF・
 * 手で入れたお知らせ停止（今日を含むもの。フォームから入った停止は数えない）の人には送らない。
 */
function SCH_selfNotify_(c, text) {
  try {
    var today = AC_today_(), r = SCH_masterRow_(c.code);
    var uid = r ? String(r[AC_COL.userId] || '').trim() : '';
    if (!r || !AC_isUserId(uid) || r[AC_COL.lineOk] !== true) return '送らない（LINE未登録・未確認）：' + text;
    if (String(r[AC_COL.status] || '').trim() === '退職' || AC_isRetired(r[AC_COL.retiredOn], today)) return '送らない（退職）：' + text;
    if (typeof AC_noticeCheck_ === 'function' && !AC_noticeCheck_(SCH_SELF_NOTICE_ID, c.code, today).send) return '送らない（お知らせ設定でOFF）：' + text;
    if (AC_isPausedForPunch(AC_pauseIndex_(), c.code, today, true)) return '送らない（お知らせ停止中）：' + text;
    var live = SCH_mode_() === 'on' && PropertiesService.getScriptProperties().getProperty('DRY_RUN') === 'false';
    if (!live) return '記録のみ（DRY_RUN）：' + text;
    AC_pushTo_(uid, text);
    if (typeof AC_noticeLog_ === 'function') AC_noticeLog_([[new Date(), SCH_SELF_NOTICE_ID, 'スケジュール変更のお知らせ', '本人', "'" + c.code, c.id, '送信', '']]);
    return '送信済み：' + text;
  } catch (e) { Logger.log('TOT反映の本人へのお知らせに失敗'); return '送信失敗：' + text; }
}

// ---- 入口1：勤怠連絡フォームの送信（alcoholCheckOnAttendanceForm の最後から呼ぶ） ----
function SCH_onForm_(ans, plan, isTest) {
  var mode = SCH_mode_();
  if (mode === 'off' || isTest || !plan || !plan.code) return null;
  var req = SCH_requestFromForm({ kind: ans.kind, from: ans.from, until: ans.until, changeTo: ans.changeTo }, AC_today_());
  if (!req) return null;
  var emp = SCH_employee_(plan.code), reason = req.reason, pv = { ok: true, lines: [] };
  if (!reason && !emp.tot) reason = 'noTot';
  if (!reason) { pv = SCH_preview(req, emp.schedules); if (!pv.ok) reason = pv.reason; }
  var reqs = reason ? [] : SCH_pendingRequests(emp.requests, emp.key, req.days);   // 版 2026-11-13d：同じ日の本人のスケジュール申請（申請中）
  var ss = SCH_book_(), c, lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = SCH_sheetOf_(ss, SCH_SHEET, SCH_HEADER), cases = SCH_cases_(sh);
    c = { id: SCH_nextId(cases.map(function (x) { return x.id; }), AC_today_()), state: reason ? SCH_STATE.skip : SCH_STATE.wait,
      code: plan.code, name: plan.name, label: req.label, from: req.from, until: req.until, changeTo: req.changeTo, by: ans.by || '', token: SCH_token_(), requests: reqs };
    var r = SCH_HEADER.map(function () { return ''; });
    r[SCH_C.id] = c.id; r[SCH_C.state] = c.state; r[SCH_C.at] = new Date(); r[SCH_C.code] = "'" + c.code; r[SCH_C.name] = c.name;
    r[SCH_C.label] = c.label; r[SCH_C.from] = "'" + c.from; r[SCH_C.until] = "'" + c.until; r[SCH_C.changeTo] = c.changeTo ? "'" + c.changeTo : '';
    r[SCH_C.by] = c.by; r[SCH_C.plan] = pv.lines.join('\n'); r[SCH_C.token] = "'" + c.token; r[SCH_C.result] = reason ? '対象外：' + SCH_REASON[reason] : '';
    r[SCH_C.requests] = reqs.length ? JSON.stringify(reqs) : '';
    sh.appendRow(r);
    SCH_log_(ss, c.id, '受付', c.state, '', '');
  } finally { lock.releaseLock(); }
  if (reason) {
    var t = '（TOT への自動反映の対象外：' + SCH_what(c) + '・' + SCH_REASON[reason] + '）\nご本人の Touch On Time からのスケジュール申請で対応してください。';
    SCH_send_([{ type: 'text', text: t }], t);
  } else {
    SCH_send_([SCH_cardMessage(c, pv.lines, mode)], '【TOT反映の承認】' + SCH_what(c) + '\n' + pv.lines.concat(SCH_requestLines(reqs)).join('\n'));
  }
  return c;
}

// ---- 入口2：勤怠管理グループのボタン（AC_handleGroupEvent_ の postback から） ----
function SCH_onGroupPostback_(ev) {
  try {
    var mode = SCH_mode_();
    if (mode === 'off' || !ev || ev.type !== 'postback') return;
    var p = SCH_parsePostback(ev.postback && ev.postback.data);
    if (!p) return;
    var gid = ev.source && ev.source.groupId;
    var groups = AC_groupsByDept(AC_groupSheet_().getDataRange().getValues())[AC_ADMIN_GROUP] || [];
    if (!gid || groups.indexOf(gid) === -1) return;     // 勤怠管理グループ以外では何もしない
    var uid = ev.source.userId;
    if (!AC_isUserId(uid)) { AC_reply_(ev.replyToken, '押した方を確認できないため受け付けできませんでした。スマートフォンのLINEから押してください。'); return; }
    var name = INQ_memberName_(gid, uid);
    if (name === null) { AC_reply_(ev.replyToken, 'このグループのメンバーであることを確認できなかったため、受け付けできませんでした。'); return; }
    SCH_button_(ev, p, uid, name || 'メンバー', mode);
  } catch (err) {
    Logger.log('TOT反映のボタンの処理エラー：%s', err && err.message ? err.message : '');
    AC_adminNotice_('totwritebutton', '【エラー】TOT反映のボタンの処理で問題がありました🙇‍♀️ 「TOT反映」シートをご確認ください。\n（' + (err && err.message ? err.message : '不明なエラー') + '）');
  }
}

function SCH_button_(ev, p, uid, name, mode) {
  var ss = SCH_book_(), reply = null, now = new Date(), lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (SCH_isDuplicate_(ss, ev)) return;
    var sh = SCH_sheetOf_(ss, SCH_SHEET, SCH_HEADER), cases = SCH_cases_(sh);
    var c = cases.filter(function (x) { return x.id === p.id; })[0];
    if (!c || !c.token || c.token !== p.token) {
      SCH_log_(ss, p.id, p.action, '拒否（合言葉の不一致）', uid, ev.webhookEventId);
      reply = 'このボタンは使えません。新しいお知らせのボタンを押してください。';
    } else if (SCH_isSelf_(c.code, uid)) {
      // 版 2026-11-13d：カードの対象者本人のボタンは受け付けない
      SCH_log_(ss, c.id, p.action, '拒否（ご本人）', uid, ev.webhookEventId);
      reply = SCH_SELF_TEXT;
    } else if ((p.action === 'reqok' || p.action === 'reqng') !== ((c.requests || []).length > 0) && p.action !== 'decline' && p.action !== 'undo') {
      SCH_log_(ss, c.id, p.action, '拒否（ボタンの種類が違う）', uid, ev.webhookEventId);
      reply = 'このボタンは使えません。新しいお知らせのボタンを押してください。';
    } else {
      var d = SCH_decide(c.state, p.action, mode), what = SCH_what(c);
      if (d.changed) {
        SCH_set_(sh, c.row, 'state', d.next);
        if (p.action === 'undo') { SCH_set_(sh, c.row, 'undoBy', name); SCH_set_(sh, c.row, 'undoById', uid); SCH_set_(sh, c.row, 'undoAt', now); }
        else { SCH_set_(sh, c.row, 'approver', name); SCH_set_(sh, c.row, 'approverId', uid); SCH_set_(sh, c.row, 'approvedAt', now); }
        if (SCH_ACTION_METHOD[p.action]) SCH_set_(sh, c.row, 'method', SCH_ACTION_METHOD[p.action]);
        if (d.reason === 'recorded') {
          // TOT_WRITE=record：本人へは送らず、送る予定の文を記録する
          var rq = (c.requests || []).map(function (q) { return q.date; });
          var preview = SCH_selfMessage(c, p.action === 'reqok' ? rq : null, p.action === 'reqng' ? rq : []);
          SCH_set_(sh, c.row, 'selfMsg', '記録のみ（TOT_WRITE=record）：' + preview);
        }
        if (d.reason === 'approved' || d.reason === 'recorded') {
          // 同じ人の日が重なる前の受付（承認待ち・反映待ち）は「置き換え」（あとの受付だけを反映する）
          var mine = SCH_days(c);
          cases.forEach(function (o) {
            if (o.id === c.id || o.code !== c.code || o.id > c.id || (o.state !== SCH_STATE.wait && o.state !== SCH_STATE.queued)) return;
            if (!SCH_days(o).some(function (x) { return mine.indexOf(x) !== -1; })) return;
            SCH_set_(sh, o.row, 'state', SCH_STATE.replaced);
            SCH_set_(sh, o.row, 'result', '置き換え：' + c.id);
            SCH_log_(ss, o.id, '置き換え', c.id, uid, ev.webhookEventId);
          });
        }
      }
      SCH_log_(ss, c.id, p.action, d.reason + '（' + (d.changed ? d.next : c.state) + '）', uid, ev.webhookEventId);
      var how = { reqok: 'ご本人の申請を承認します', reqng: 'ご本人の申請を棄却して TOT に反映します' }[p.action];
      reply = {
        approved: how ? what + 'について、' + how + '（' + name + 'さん）。10分ほどで TOT で処理し、結果をお知らせします。'
          : what + 'を承認しました（' + name + 'さん）。10分ほどで TOT に反映し、結果をお知らせします。',
        recorded: what + 'を承認しました（' + name + 'さん）。試験中のため TOT には書き込まず' + (how ? '（申請の承認・棄却もしません）' : '') + '、反映する内容を「TOT反映」シートに記録しました。',
        declined: what + 'は TOT に反映しないことにしました（' + name + 'さん）。ご本人の Touch On Time からのスケジュール申請で対応してください。',
        undo: what + 'を元に戻します（' + name + 'さん）。10分ほどで TOT に反映し、結果をお知らせします。',
        undoOff: '今は TOT への書き込みを止めているため、元に戻せません。TOT の管理画面で直してください。',
        already: what + 'は「' + c.state + '」です' + (c.approver ? '（' + c.approver + 'さん）' : '') + '。',
      }[d.reason];
    }
    SCH_markSeen_(ev);
  } finally { lock.releaseLock(); }
  if (reply) AC_reply_(ev.replyToken, reply);
}

// ---- 入口3：VPS からの受け渡し（doPost の type: 'tot-write-queue'） ----
// 合言葉（TOT_SYNC_SECRET）が合うときだけ。TOT_WRITE=on のときだけ渡す。peek=true なら状態を変えずに中身だけ返す（VPS の試し実行用）
function SCH_handleQueue_(body) {
  try {
    var secret = PropertiesService.getScriptProperties().getProperty('TOT_SYNC_SECRET');
    if (!secret || !body || body.secret !== secret) return 'NG';
    var mode = SCH_mode_();
    if (mode !== 'on') return JSON.stringify({ ok: true, mode: mode, items: [] });
    var ss = SCH_book_(), items = [], failed = [], waiting = 0, now = new Date(), lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var sh = ss.getSheetByName(SCH_SHEET);
      if (!sh) return JSON.stringify({ ok: true, mode: mode, items: [] });
      SCH_pickQueue(SCH_cases_(sh), now.getTime()).slice(0, 10).forEach(function (c) {
        var emp = SCH_employee_(c.code), undo = c.state === SCH_STATE.undoQueued || c.state === SCH_STATE.undoSending;
        if (!emp.data) { waiting++; return; }        // tot-latest.json が無い・読めない：次の回にする
        if (!emp.key || (undo && !Object.keys(c.beforeObj || {}).length)) {
          if (body.peek) return;
          var r = { op: undo ? 'undo' : 'apply', status: 'failed', reason: !emp.tot ? 'noTot' : !emp.key ? 'employee' : 'noUndo' };
          var pl = SCH_resultPlan(c, r);
          SCH_set_(sh, c.row, 'state', pl.next); SCH_set_(sh, c.row, 'result', '失敗：' + SCH_reasonText(r)); SCH_set_(sh, c.row, 'doneAt', now);
          SCH_log_(ss, c.id, '受け渡し', pl.next, '', '');
          failed.push(pl.text);
          return;
        }
        items.push(SCH_queueItem(c, emp.key));
        if (body.peek) return;
        SCH_set_(sh, c.row, 'state', undo ? SCH_STATE.undoSending : SCH_STATE.sending);
        SCH_set_(sh, c.row, 'handedAt', now);
        SCH_log_(ss, c.id, '受け渡し', undo ? SCH_STATE.undoSending : SCH_STATE.sending, '', '');
      });
    } finally { lock.releaseLock(); }
    failed.forEach(function (t) { SCH_send_([{ type: 'text', text: t }], t); });
    if (waiting) AC_adminNotice_('totwritedata', '【エラー】TOT の取り込みデータ（tot-latest.json）が読めないため、TOT への反映を' + waiting + '件待たせています🙇‍♀️\n朝7:05の中継が動いているか確認してください。');
    return JSON.stringify({ ok: true, mode: mode, items: items });
  } catch (err) {
    Logger.log('TOT反映の受け渡しエラー：%s', err && err.message ? err.message : '');
    AC_adminNotice_('totwritequeue', '【エラー】TOT への反映の受け渡しで問題がありました🙇‍♀️\n（' + (err && err.message ? err.message : '不明なエラー') + '）');
    return 'NG error';
  }
}

// ---- 入口4：VPS からの結果（doPost の type: 'tot-write-result'） ----
// body：{ secret, id, op, status, reason, errors, written, skipped, before }。受付番号ごとに1回だけ受け付ける（反映中・元に戻し中のときだけ）
function SCH_handleResult_(body) {
  try {
    var secret = PropertiesService.getScriptProperties().getProperty('TOT_SYNC_SECRET');
    if (!secret || !body || body.secret !== secret) return 'NG';
    var ss = SCH_book_(), now = new Date(), msg = null, lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var sh = ss.getSheetByName(SCH_SHEET);
      var c = sh ? SCH_cases_(sh).filter(function (x) { return x.id === String(body.id || ''); })[0] : null;
      var expect = body.op === 'undo' ? SCH_STATE.undoSending : SCH_STATE.sending;
      if (!c || c.state !== expect) { SCH_log_(ss, body.id, '結果', '受け付けなし（状態：' + (c ? c.state : '受付なし') + '）', '', ''); return 'NG state'; }
      var r = { op: body.op === 'undo' ? 'undo' : 'apply', method: body.method === 'approve' || body.method === 'reject' ? body.method : '',
        requestResults: Array.isArray(body.requestResults) ? body.requestResults.slice(0, 31) : [], status: String(body.status || ''), reason: String(body.reason || ''),
        errors: Array.isArray(body.errors) ? body.errors.slice(0, 5) : [], written: Array.isArray(body.written) ? body.written : [], skipped: Array.isArray(body.skipped) ? body.skipped : [] };
      var pl = SCH_resultPlan(c, r);
      SCH_set_(sh, c.row, 'state', pl.next);
      SCH_set_(sh, c.row, 'doneAt', now);
      SCH_set_(sh, c.row, 'result', (pl.next === SCH_STATE.done || pl.next === SCH_STATE.undone ? '成功' : '失敗：' + SCH_reasonText(r))
        + (r.written.length ? '（書き込んだ日：' + r.written.join('、') + '）' : ''));
      if (r.op === 'apply' && body.before && typeof body.before === 'object' && !c.beforeObj) SCH_set_(sh, c.row, 'before', JSON.stringify(body.before));
      if (r.requestResults.length) SCH_set_(sh, c.row, 'reqResult', r.requestResults.map(function (x) {
        return x.date + '：' + (x.action === 'rejected' ? '棄却' : '承認') + '（' + String(x.status || '') + '）';
      }).join('\n'));
      SCH_log_(ss, c.id, '結果', pl.next, '', '');
      msg = pl.undo ? SCH_doneMessage(c, pl.text) : { type: 'text', text: pl.text };
      c.text = pl.text;
      if (pl.self) SCH_set_(sh, c.row, 'selfMsg', SCH_selfNotify_(c, SCH_selfMessage(c, pl.selfDays, pl.rejected)));   // 版 2026-11-13d：本人へ
    } finally { lock.releaseLock(); }
    SCH_send_([msg], c.text);
    return 'OK';
  } catch (err) {
    Logger.log('TOT反映の結果の処理エラー：%s', err && err.message ? err.message : '');
    AC_adminNotice_('totwriteresult', '【エラー】TOT への反映の結果の処理で問題がありました🙇‍♀️ 「TOT反映」シートをご確認ください。\n（' + (err && err.message ? err.message : '不明なエラー') + '）');
    return 'NG error';
  }
}

// ---- 見守り：中継（朝・夜の tot-raw）を受け取ったときに呼ぶ。反映待ちが3時間以上止まっていたら管理者へ（1日1回） ----
function SCH_watch_() {
  try {
    if (SCH_mode_() !== 'on') return 0;
    var sh = SCH_book_().getSheetByName(SCH_SHEET);
    if (!sh) return 0;
    var now = Date.now(), S = SCH_STATE;
    var stuck = SCH_cases_(sh).filter(function (c) {
      var t = c.state === S.queued ? c.approvedAt : c.state === S.undoQueued ? c.undoAt : c.state === S.sending || c.state === S.undoSending ? c.handedAt : null;
      return t instanceof Date && now - t.getTime() >= SCH_STUCK_MS;
    }).length;
    if (stuck) AC_adminNotice_('totwritestuck', '【エラー】TOT への反映が' + stuck + '件、3時間以上止まっています🙇‍♀️\n'
      + 'VPS の cron（src/tot-write.js）と、.env の TOT_WRITE_TOKEN を確認してください。「TOT反映」シートで状態を確認できます。');
    return stuck;
  } catch (e) { Logger.log('TOT反映の見守りに失敗'); return 0; }
}

/**
 * まとめのお知らせ（INQ_remind・9:00・15:00）から呼ぶ（版 2026-11-13d）。TOT_WRITE が未設定・シートが無ければ null。
 * 戻り値 { text（承認待ちの一覧。0件なら null）, after（前日の15時台に、承認待ちのカードをもう一度送る。1枚1回） }
 */
function SCH_remindPart_(now) {
  var mode = SCH_mode_();
  if (mode === 'off') return null;
  var ss = SCH_book_(), sh = ss.getSheetByName(SCH_SHEET);
  if (!sh) return null;
  var cases = SCH_cases_(sh), today = Utilities.formatDate(now, AC_TZ, 'yyyy-MM-dd'), hour = Number(Utilities.formatDate(now, AC_TZ, 'HH'));
  var due = cases.filter(function (c) { return SCH_isDueForResend(c, today, hour); });
  return { text: SCH_remindText(cases), after: function () {
    due.forEach(function (c) {
      SCH_set_(sh, c.row, 'renotifiedAt', new Date());
      var lines = String(sh.getRange(c.row, SCH_C.plan + 1).getValue() || '').split('\n').filter(Boolean);
      SCH_send_([SCH_cardMessage(c, lines, mode, { title: '【TOT反映の承認・明日が対象の日です】' })], '【TOT反映の承認・明日が対象の日です】' + SCH_what(c));
      SCH_log_(ss, c.id, '再通知', '前日の15時台', '', '');
    });
  } };
}

/**
 * 【勤怠の変更】の文を送らない連絡のキー（SCH_entryKey）。シートが無ければ空。
 * 版 2026-11-13f：TOT_WRITE=on のときだけ効かせる（record・未設定のときは TOT に書かないため、反映待ち・反映中のまま残った連絡も【勤怠の変更】で本人に依頼する。
 * docs/ATTENDANCE_NOTICE_RULES.md のルール3）
 */
function SCH_syncedKeys_() {
  var out = {};
  if (SCH_mode_() !== 'on') return out;
  try {
    var sh = SCH_book_().getSheetByName(SCH_SHEET);
    if (!sh) return out;
    SCH_cases_(sh).forEach(function (c) {
      if (SCH_ACTIVE.indexOf(c.state) !== -1) out[SCH_entryKey(c.code, c.label, c.from, c.until, c.changeTo)] = true;
    });
  } catch (e) { Logger.log('「TOT反映」シートを読めませんでした'); }
  return out;
}

/** 手動実行：シートを作り、今の設定と状態ごとの件数をログに出す（氏名などは出さない） */
function SCH_setup() {
  var ss = SCH_book_(), sh = SCH_sheetOf_(ss, SCH_SHEET, SCH_HEADER);
  SCH_sheetOf_(ss, SCH_LOG_SHEET, SCH_LOG_HEADER);
  var count = {};
  SCH_cases_(sh).forEach(function (c) { count[c.state] = (count[c.state] || 0) + 1; });
  Logger.log('TOT反映（版 ' + SCH_VERSION + '）：TOT_WRITE=' + SCH_mode_() + '／状態ごとの件数 ' + JSON.stringify(count));
  return count;
}
