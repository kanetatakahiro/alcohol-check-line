/**
 * 従業員問い合わせ管理（第1段階）  版 INQ_VERSION
 *
 * 従業員が公式LINEに1対1で送った「社員番号以外」のメッセージを、問い合わせとして受け付け、
 * 問い合わせ専用のスプレッドシートに記録し、勤怠管理グループへ知らせる（ボタン：対応します／対応済みにする）。
 * 9:00・17:00 に未対応・対応中の案件をまとめて知らせる（INQ_remind・時刻指定のトリガー）。
 *
 * 既存の「コード.gs」からの呼び出しは3か所だけ：
 *  - AC_handleEvent_：文字以外のメッセージ・postback、社員番号ではない文字 → INQ_onUserEvent_
 *  - AC_handleGroupEvent_：postback → INQ_onGroupPostback_
 * 入口の関数はエラーを外へ出さない（既存の処理・doPost を止めない）。
 *
 * 設定（スクリプトのプロパティ）
 *  INQ_MODE           未設定・off＝何もしない／record＝記録だけ（送信・返信なし）／on＝利用開始
 *  INQ_SPREADSHEET_ID 記録先のスプレッドシート（INQ_setup で作成）
 *  INQ_NOTIFY_TO      未設定＝勤怠管理グループへ／admin＝管理者の個別LINEへ（試験用）
 *  INQ_REMIND_DAYS    未設定・all＝毎日／weekdays＝土日は送らない
 *  INQ_ROUTINE_WORDS・INQ_SECRET_WORDS  定型連絡・機密の言葉の追加（「、」区切り・任意）
 *
 * 書かないもの：トークン・合言葉は実行ログ・通知に出さない。実行ログに問い合わせの本文は出さない。
 * 返信はスタッフがLINE公式アカウントのチャット画面から行う（システムは返信の内容を読めない）。
 */

var INQ_VERSION = '2026-11-05a';

var INQ_STATE = { open: '未対応', doing: '対応中', done: '対応済み' };
var INQ_SHEET_CASE = '問い合わせ';
var INQ_CASE_HEADER = ['案件番号', '状態', '社員番号', '氏名', '所属', '紐付け', 'LINEユーザーID', 'LINE表示名', '受付日時',
  '内容（冒頭）', '機密あり', '最終受信日時', '追記の回数', '担当者', '担当者ID', '対応開始日時', '完了者', '完了者ID', '完了日時',
  '最後の追記通知', '合言葉', '作成時のイベント番号'];
var INQ_C = { id: 0, state: 1, code: 2, name: 3, dept: 4, link: 5, userId: 6, lineName: 7, at: 8, head: 9, secret: 10,
  lastAt: 11, appends: 12, staff: 13, staffId: 14, takenAt: 15, doneBy: 16, doneById: 17, doneAt: 18, appendNoticeAt: 19,
  token: 20, eventId: 21 };
var INQ_SHEET_LOG = 'やりとり';
var INQ_LOG_HEADER = ['日時', '案件番号', '種類', '内容', 'LINEユーザーID', 'イベント番号', 'メッセージ番号'];
var INQ_SHEET_ROUTINE = '定型連絡';
var INQ_ROUTINE_HEADER = ['日時', '社員番号', '氏名', 'LINEユーザーID', '内容', 'イベント番号'];
var INQ_SHEET_RECEIVED = '受信記録';
var INQ_RECEIVED_HEADER = ['日時', 'イベント番号', '結果'];
var INQ_SHEET_GUIDED = '案内済み';
var INQ_GUIDED_HEADER = ['LINEユーザーID', '案内日時'];

var INQ_ROUTINE_WORDS = ['出勤', '退勤', '遅刻', '早退', '休憩', '休憩入り', '休憩終わり', '休憩終了', '戻り',
  'お疲れさま', 'お疲れ様', 'おつかれさま', 'お疲れさまでした', 'お疲れ様でした'];
var INQ_SECRET_WORDS = ['パスワード', 'パスコード', '暗証番号', '口座', 'カード番号', 'クレジット', 'セキュリティコード',
  'マイナンバー', '個人番号', 'pin', 'password'];
var INQ_HEAD_LEN = 20;
var INQ_APPEND_NOTICE_MS = 30 * 60 * 1000;
var INQ_DEDUPE_ROWS = 2000;     // 受信記録の直近の行数（重複の確認に使う。Workersの再送は最長24時間）
var INQ_SECRET_LABEL = '（内容はチャットで確認）';

// ======================================================================
// 純粋関数（Node.js のテストから使う）
// ======================================================================

/** 全角英数字・記号を半角に（NFKC）。null は空文字 */
function INQ_nfkc(text) {
  var t = String(text == null ? '' : text);
  return t.normalize ? t.normalize('NFKC') : t;
}

function INQ_words_(base, extra) {
  return base.concat(String(extra || '').split(/[、,，\n]+/).map(function (x) { return x.trim(); }).filter(Boolean));
}

/**
 * 純粋関数：定型連絡（出勤・退勤・遅刻など）だけのメッセージか。
 * 空白・句読点・記号・絵文字と、語尾（です・します・しました・ます・ました）を除いて、一覧の言葉と完全に一致するときだけ true。
 * 相談や理由を含む文は false（取りこぼさない側）。
 */
function INQ_isRoutine(text, extraWords) {
  var t = INQ_nfkc(text)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[\s。、．，.,!?！？・~〜ー―…:：;；"'“”‘’()（）「」『』\[\]【】w笑]+/g, '');
  if (!t || t.length > 15) return false;
  for (var i = 0; i < 3; i++) t = t.replace(/(しました|します|でした|です|ました|ます)$/, '');
  var list = INQ_words_(INQ_ROUTINE_WORDS, extraWords).map(function (w) { return INQ_nfkc(w).replace(/[\s　]+/g, ''); });
  return list.indexOf(t) !== -1;
}

/** 数字の間の空白・ハイフン類を詰める（カード番号・電話番号の区切り） */
function INQ_joinDigits_(t) {
  return t.replace(/(\d)[\s\-‐‑‒–—−ｰー－]+(?=\d)/g, '$1');
}

/** 純粋関数：機密（パスワード・口座・カード番号・マイナンバー等の言葉、または7桁以上の数字）を含むか */
function INQ_hasSecret(text, extraWords) {
  var t = INQ_nfkc(text).toLowerCase();
  if (/\d{7,}/.test(INQ_joinDigits_(t))) return true;
  return INQ_words_(INQ_SECRET_WORDS, extraWords).some(function (w) { return t.indexOf(INQ_nfkc(w).toLowerCase()) !== -1; });
}

/**
 * 純粋関数：保存用に機密の部分を伏せる。7桁以上の数字（区切りを含む）は「＊＊＊」、
 * 機密の言葉がある行は、その言葉より後ろを「＊＊＊」にする。
 */
function INQ_maskSecret(text, extraWords) {
  var words = INQ_words_(INQ_SECRET_WORDS, extraWords).map(function (w) { return INQ_nfkc(w).toLowerCase(); });
  return INQ_nfkc(text).split('\n').map(function (line) {
    var l = line.replace(/\d(?:[\s\-‐‑‒–—−ｰー－]*\d){6,}/g, '＊＊＊');
    var low = l.toLowerCase(), cut = -1;
    words.forEach(function (w) {
      var i = low.indexOf(w);
      if (i !== -1 && (cut === -1 || i + w.length < cut)) cut = i + w.length;
    });
    return cut === -1 ? l : l.slice(0, cut) + '＊＊＊';
  }).join('\n');
}

/** 純粋関数：冒頭 n 文字（改行は空白に。絵文字も1文字）。超えたら「…」 */
function INQ_head(text, n) {
  n = n || INQ_HEAD_LEN;
  var chars = Array.from(String(text == null ? '' : text).replace(/\s*[\r\n]+\s*/g, ' ').trim());
  return chars.length > n ? chars.slice(0, n).join('') + '…' : chars.join('');
}

/** 純粋関数：文字以外のメッセージの内容の表示。スタンプは null（記録だけにする） */
function INQ_messageSummary(message) {
  var m = message || {};
  var labels = { image: '（画像）', video: '（動画）', audio: '（音声）', file: '（ファイル）', location: '（位置情報）' };
  if (m.type === 'text') return String(m.text || '');
  if (m.type === 'sticker') return null;
  return labels[m.type] || '（' + String(m.type || '不明') + '）';
}

/**
 * 純粋関数：LINEユーザーIDから従業員マスタの行を探す（氏名・表示名からは推測しない）。
 * 戻り値 { link: 'registered'|'pending'|'unregistered'|'duplicate', code, name, dept, retired }
 *  registered：IDが一致し「LINE確認済み」あり（1行だけ）／pending：IDは一致するが未確認／
 *  unregistered：一致する行なし／duplicate：一致する行が2つ以上
 */
function INQ_matchEmployee(masterValues, userId, today) {
  var rows = [];
  for (var i = 1; i < (masterValues || []).length; i++) {
    if (userId && String(masterValues[i][AC_COL.userId] || '').trim() === userId) rows.push(masterValues[i]);
  }
  if (!rows.length) return { link: 'unregistered' };
  if (rows.length > 1) return { link: 'duplicate' };
  var r = rows[0];
  if (r[AC_COL.lineOk] !== true) return { link: 'pending' };
  return { link: 'registered', code: AC_cellCode_(r[AC_COL.code]), name: String(r[AC_COL.name] || '').trim(),
    dept: String(r[AC_COL.dept] || '').trim(),
    retired: String(r[AC_COL.status] || '').trim() === '退職' || (!!today && AC_isRetired(r[AC_COL.retiredOn], today)) };
}

/** 純粋関数：通知に出す従業員の表示（氏名（所属）／確認待ち・未登録・要確認（LINE表示名）） */
function INQ_whoLabel(match, displayName) {
  var dn = String(displayName || '表示名なし');
  if (match.link === 'registered') {
    return (match.name || '氏名未入力') + (match.retired ? '（退職）' : '') + '（' + (match.dept || '所属未設定') + '）';
  }
  return { pending: '確認待ち', unregistered: '未登録', duplicate: '要確認' }[match.link] + '（' + dn + '）';
}

/** 純粋関数：postback の中身を読む。問い合わせのもの（inq|1|操作|案件番号|合言葉）でなければ null */
function INQ_parsePostback(data) {
  var m = /^inq\|1\|(take|done)\|(Q-\d{8}-\d{3})\|([0-9a-f]{6})$/.exec(String(data || ''));
  return m ? { action: m[1], id: m[2], token: m[3] } : null;
}

function INQ_postbackData(action, id, token) { return 'inq|1|' + action + '|' + id + '|' + token; }

/**
 * 純粋関数：ボタンを押したときの状態の移り方（一方向：未対応 → 対応中 → 対応済み）。
 * 戻り値 { next, changed, reason }。reason：'taken'|'done'|'alreadyDoing'|'alreadyDone'
 */
function INQ_decide(state, action) {
  if (state === INQ_STATE.done) return { next: state, changed: false, reason: 'alreadyDone' };
  if (action === 'take') {
    return state === INQ_STATE.open ? { next: INQ_STATE.doing, changed: true, reason: 'taken' }
      : { next: state, changed: false, reason: 'alreadyDoing' };
  }
  return { next: INQ_STATE.done, changed: true, reason: 'done' };
}

/** 純粋関数：次の案件番号 Q-YYYYMMDD-NNN（その日の既存の番号の続き） */
function INQ_nextId(ids, today) {
  var prefix = 'Q-' + String(today).replace(/-/g, '') + '-', max = 0;
  (ids || []).forEach(function (id) {
    id = String(id || '');
    if (id.indexOf(prefix) === 0) max = Math.max(max, Number(id.slice(prefix.length)) || 0);
  });
  return prefix + ('00' + (max + 1)).slice(-3);
}

/** 純粋関数：対応中の案件への追記を知らせるか（同じ案件で30分に1回まで） */
function INQ_shouldNotifyAppend(state, lastNoticeMs, nowMs) {
  if (state !== INQ_STATE.doing) return false;
  return !(lastNoticeMs > 0) || nowMs - lastNoticeMs >= INQ_APPEND_NOTICE_MS;
}

function INQ_hm_(d) { return Utilities.formatDate(d, AC_TZ, 'HH:mm'); }
function INQ_ymd_(d) { return Utilities.formatDate(d, AC_TZ, 'yyyy-MM-dd'); }
/** 日本時間の曜日（0=日 … 6=土） */
function INQ_dow_(d) { return new Date(INQ_ymd_(d) + 'T12:00:00+09:00').getUTCDay(); }
function INQ_md_(d) {
  var p = INQ_ymd_(d).split('-');
  return Number(p[1]) + '/' + Number(p[2]) + '（' + '日月火水木金土'.charAt(INQ_dow_(d)) + '）';
}

/** 純粋関数：一覧・通知に出す内容（機密ありならチャットで確認） */
function INQ_shownHead(c) { return c.secret ? INQ_SECRET_LABEL : '「' + (c.head || '') + '」'; }

/**
 * 純粋関数：新しい問い合わせの通知（Flex Message：本文＋ボタン2つ）。
 * c：{ id, who, at(Date), head, secret, state, token }
 */
function INQ_newCaseMessage(c) {
  var lines = ['従業員：' + c.who, '受付：' + INQ_md_(c.at) + ' ' + INQ_hm_(c.at), '内容：' + INQ_shownHead(c), '状況：' + c.state];
  var title = '【問い合わせ】' + c.id;
  var btn = function (label, action, shown) {
    return { type: 'button', style: action === 'take' ? 'primary' : 'secondary', height: 'sm',
      action: { type: 'postback', label: label, data: INQ_postbackData(action, c.id, c.token), displayText: shown + '（' + c.id + '）' } };
  };
  return {
    type: 'flex', altText: (title + ' ' + c.who).slice(0, 400),
    contents: { type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [{ type: 'text', text: title, weight: 'bold', wrap: true }]
        .concat(lines.map(function (l) { return { type: 'text', text: l, wrap: true, size: 'sm' }; })) },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [btn('対応します', 'take', '対応します'), btn('対応済みにする', 'done', '対応済みにします')] } },
  };
}

/** 純粋関数：新しい問い合わせの通知の文字だけの版（ボタンを送れないときの管理者向け） */
function INQ_newCaseText(c) {
  return ['【問い合わせ】' + c.id, '従業員：' + c.who, '受付：' + INQ_md_(c.at) + ' ' + INQ_hm_(c.at),
    '内容：' + INQ_shownHead(c), '状況：' + c.state].join('\n');
}

/** 純粋関数：対応中の案件への追記の短い通知 */
function INQ_appendText(c) {
  return '【問い合わせ・追記】' + c.id + ' ' + c.who + 'から追記があります。チャットをご確認ください（担当：' + (c.staff || '未設定') + '）';
}

/**
 * 純粋関数：リマインドの文（0件なら null）。cases：[{ id, state, who, at(Date), head, secret, staff }]
 * 未対応 → 対応中、それぞれ受付の古い順。受付日が今日より前なら「前日から継続」。
 */
function INQ_remindText(cases, now) {
  var list = (cases || []).filter(function (c) { return c.state === INQ_STATE.open || c.state === INQ_STATE.doing; });
  if (!list.length) return null;
  var today = INQ_ymd_(now);
  list.sort(function (a, b) {
    if (a.state !== b.state) return a.state === INQ_STATE.open ? -1 : 1;
    return a.at.getTime() - b.at.getTime();
  });
  var out = ['【問い合わせ・未完了 ' + list.length + '件】' + INQ_md_(now) + ' ' + INQ_hm_(now)];
  var body = [];
  list.forEach(function (c) {
    body.push('・' + c.id + ' ' + c.who + ' ' + c.state + (c.state === INQ_STATE.doing ? '：' + (c.staff || '担当未設定') : '')
      + (INQ_ymd_(c.at) < today ? '【前日から継続】' : '') + '\n  ' + INQ_shownHead(c));
  });
  var text = out.concat(body).join('\n');
  if (text.length <= 4900) return text;
  var kept = [], len = out[0].length;
  for (var i = 0; i < body.length; i++) {
    if (len + body[i].length + 30 > 4900) break;
    kept.push(body[i]); len += body[i].length + 1;
  }
  return out.concat(kept).concat(['…ほか' + (body.length - kept.length) + '件（「問い合わせ」シートをご覧ください）']).join('\n');
}

/** 純粋関数：シートの1行 → 案件 */
function INQ_rowToCase(r, i) {
  var d = function (v) { return v instanceof Date ? v : (v ? new Date(v) : null); };
  return { row: i + 1, id: String(r[INQ_C.id] || ''), state: String(r[INQ_C.state] || ''), code: AC_cellCode_(r[INQ_C.code]),
    name: String(r[INQ_C.name] || ''), dept: String(r[INQ_C.dept] || ''), link: String(r[INQ_C.link] || ''),
    userId: String(r[INQ_C.userId] || ''), lineName: String(r[INQ_C.lineName] || ''), at: d(r[INQ_C.at]), head: String(r[INQ_C.head] || ''),
    secret: r[INQ_C.secret] === true, appends: Number(r[INQ_C.appends]) || 0, staff: String(r[INQ_C.staff] || ''),
    appendNoticeAt: d(r[INQ_C.appendNoticeAt]), token: String(r[INQ_C.token] || ''), who: '',
    doneBy: String(r[INQ_C.doneBy] || ''), doneAt: d(r[INQ_C.doneAt]) };
}

/** 純粋関数：案件の表示名（シートの値から） */
function INQ_caseWho(c) {
  if (c.link === '登録済み') return (c.name || '氏名未入力') + '（' + (c.dept || '所属未設定') + '）';
  return (c.link || '未登録') + '（' + (c.lineName || '表示名なし') + '）';
}

/** 純粋関数：その人の未完了の案件（いちばん新しいもの）。無ければ null */
function INQ_openCaseOf(cases, userId) {
  var hit = null;
  (cases || []).forEach(function (c) {
    if (c.userId === userId && (c.state === INQ_STATE.open || c.state === INQ_STATE.doing)) hit = c;
  });
  return hit;
}

var INQ_LINK_LABEL = { registered: '登録済み', pending: '確認待ち', unregistered: '未登録', duplicate: '要確認' };

// ======================================================================
// シート・LINEとのやり取り（Apps Script 上でのみ動く）
// ======================================================================

function INQ_props_() { return PropertiesService.getScriptProperties(); }
function INQ_mode_() {
  var m = String(INQ_props_().getProperty('INQ_MODE') || 'off').trim();
  return m === 'on' || m === 'record' ? m : 'off';
}

function INQ_book_() {
  var id = INQ_props_().getProperty('INQ_SPREADSHEET_ID');
  if (!id) throw AC_error_('問い合わせの記録先（INQ_SPREADSHEET_ID）が未設定です');
  return SpreadsheetApp.openById(id);
}

function INQ_sheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function INQ_cases_(sh) {
  var v = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < v.length; i++) if (v[i][INQ_C.id]) out.push(INQ_rowToCase(v[i], i));
  return out;
}

/** 受信記録の直近の行に、このイベント番号があるか */
function INQ_seenInSheet_(sh, eventId) {
  var last = sh.getLastRow();
  if (last < 2) return false;
  var n = Math.min(INQ_DEDUPE_ROWS, last - 1);
  var v = sh.getRange(last - n + 1, 2, n, 1).getValues();
  for (var i = 0; i < v.length; i++) if (String(v[i][0]) === eventId) return true;
  return false;
}

function INQ_cacheKey_(id) { return 'inq:ev:' + id; }

/** 重複受信なら true（一時記憶 → 受信記録の順に確かめる） */
function INQ_isDuplicate_(ev, received) {
  var id = ev && ev.webhookEventId;
  if (!id) return false;
  if (CacheService.getScriptCache().get(INQ_cacheKey_(id))) return true;
  return INQ_seenInSheet_(received, id);
}

function INQ_markSeen_(ev, received, result) {
  var id = ev && ev.webhookEventId;
  received.appendRow([new Date(), id || '（番号なし）', result]);
  if (id) CacheService.getScriptCache().put(INQ_cacheKey_(id), '1', 21600);
}

function INQ_token_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 6).toLowerCase(); }

/** 送り先：INQ_NOTIFY_TO=admin なら管理者の個別LINE、それ以外は勤怠管理グループ（無ければ管理者） */
function INQ_targets_() {
  var admin = INQ_props_().getProperty('LINE_ADMIN_USER_ID');
  if (String(INQ_props_().getProperty('INQ_NOTIFY_TO') || '').trim() === 'admin') return { list: admin ? [admin] : [], admin: true };
  var groups = [];
  try { groups = AC_groupsByDept(AC_groupSheet_().getDataRange().getValues())[AC_ADMIN_GROUP] || []; } catch (e) { Logger.log('勤怠管理グループの読み込みに失敗'); }
  return groups.length ? { list: groups, admin: false } : { list: admin ? [admin] : [], admin: true };
}

function INQ_pushMessages_(to, messages) {
  var token = INQ_props_().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !to) return false;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, 'X-Line-Retry-Key': Utilities.getUuid() },
    payload: JSON.stringify({ to: to, messages: messages }), muteHttpExceptions: true,
  });
  return res.getResponseCode() === 200;
}

/** 送り先すべてへ送る。1つも届かなければ、管理者の個別LINEへ文字だけで送る。届いた数を返す */
function INQ_send_(messages, fallbackText) {
  var t = INQ_targets_(), sent = 0;
  t.list.forEach(function (to) { try { if (INQ_pushMessages_(to, messages)) sent++; } catch (e) { Logger.log('問い合わせの通知の送信に失敗'); } });
  if (!sent && !t.admin) {
    try { AC_pushLine_(fallbackText + '\n（勤怠管理グループへ送れなかったため、こちらへお知らせしました）'); sent++; } catch (e2) { Logger.log('管理者への送信にも失敗'); }
  }
  return sent;
}

/** 送信者のLINE表示名。取れなければ null（友だちでない・偽のデータなど） */
function INQ_profileName_(userId) {
  var token = INQ_props_().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !AC_isUserId(userId)) return null;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId), {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  try { return String(JSON.parse(res.getContentText()).displayName || ''); } catch (e) { return ''; }
}

/** グループのメンバーなら表示名、確かめられなければ null */
function INQ_memberName_(groupId, userId) {
  var token = INQ_props_().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !groupId || !AC_isUserId(userId)) return null;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/group/' + encodeURIComponent(groupId) + '/member/' + encodeURIComponent(userId), {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  try { return String(JSON.parse(res.getContentText()).displayName || ''); } catch (e) { return ''; }
}

function INQ_fail_(where, err) {
  Logger.log('問い合わせの処理エラー（%s）：%s', where, err && err.message ? err.message : '');
  try { AC_adminNotice_('inquiry', '【エラー】問い合わせの処理で問題がありました🙇‍♀️ LINEのチャット画面で新しいメッセージをご確認ください。\n（' + (err && err.message ? err.message : '不明なエラー') + '）'); } catch (e) { /* 何もしない */ }
}

// ---- 入口：1対1のトーク（社員番号以外のメッセージ・postback） ----
function INQ_onUserEvent_(ev) {
  try {
    var mode = INQ_mode_();
    if (mode === 'off' || !ev) return;
    if (ev.type === 'postback') { if (mode === 'on') INQ_onAdminPostback_(ev); return; }
    if (ev.type !== 'message' || !ev.message) return;
    INQ_receive_(ev, mode);
  } catch (err) { INQ_fail_('受付', err); }
}

function INQ_receive_(ev, mode) {
  var uid = ev.source && ev.source.userId;
  if (!AC_isUserId(uid)) return;
  var ss = INQ_book_(), received = INQ_sheet_(ss, INQ_SHEET_RECEIVED, INQ_RECEIVED_HEADER);
  if (INQ_isDuplicate_(ev, received)) { Logger.log('問い合わせ：重複の受信のため処理しません'); return; }
  var displayName = INQ_profileName_(uid);
  if (displayName === null) {   // 実在確認できない（友だちでない・偽のデータ）：案件にしない
    var lk = LockService.getScriptLock(); lk.waitLock(20000);
    try { if (!INQ_isDuplicate_(ev, received)) INQ_markSeen_(ev, received, '実在確認できず'); } finally { lk.releaseLock(); }
    return;
  }
  var props = INQ_props_(), now = new Date(), today = INQ_ymd_(now);
  var raw = INQ_messageSummary(ev.message);
  var mv = AC_masterSheet_().getDataRange().getValues();
  var match = INQ_matchEmployee(mv, uid, today);
  var who = INQ_whoLabel(match, displayName);
  var secretWords = props.getProperty('INQ_SECRET_WORDS');
  var secret = raw !== null && INQ_hasSecret(raw, secretWords);
  var stored = raw === null ? '（スタンプ）' : secret ? INQ_maskSecret(raw, secretWords) : raw;
  var routine = raw === null || INQ_isRoutine(raw, props.getProperty('INQ_ROUTINE_WORDS'));
  var after = null;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (INQ_isDuplicate_(ev, received)) return;
    var mid = (ev.message && ev.message.id) || '';
    if (routine) {
      INQ_sheet_(ss, INQ_SHEET_ROUTINE, INQ_ROUTINE_HEADER).appendRow([now, match.code ? "'" + match.code : '', match.name || who, uid, stored, ev.webhookEventId || '']);
      INQ_markSeen_(ev, received, '定型連絡');
      return;
    }
    var sh = INQ_sheet_(ss, INQ_SHEET_CASE, INQ_CASE_HEADER), log = INQ_sheet_(ss, INQ_SHEET_LOG, INQ_LOG_HEADER);
    var cases = INQ_cases_(sh), open = INQ_openCaseOf(cases, uid);
    if (open) {
      var notify = INQ_shouldNotifyAppend(open.state, open.appendNoticeAt ? open.appendNoticeAt.getTime() : 0, now.getTime());
      sh.getRange(open.row, INQ_C.lastAt + 1).setValue(now);
      sh.getRange(open.row, INQ_C.appends + 1).setValue(open.appends + 1);
      if (secret && !open.secret) sh.getRange(open.row, INQ_C.secret + 1).setValue(true);
      if (notify && mode === 'on') sh.getRange(open.row, INQ_C.appendNoticeAt + 1).setValue(now);
      log.appendRow([now, open.id, '追記', stored, uid, ev.webhookEventId || '', "'" + mid]);
      INQ_markSeen_(ev, received, '追記 ' + open.id);
      open.who = INQ_caseWho(open);
      after = { kind: 'append', c: open, notify: notify };
    } else {
      var c = { id: INQ_nextId(cases.map(function (x) { return x.id; }), today), state: INQ_STATE.open, who: who, at: now,
        head: INQ_head(stored), secret: secret, token: INQ_token_() };
      var row = INQ_CASE_HEADER.map(function () { return ''; });
      row[INQ_C.id] = c.id; row[INQ_C.state] = c.state; row[INQ_C.code] = match.code ? "'" + match.code : '';
      row[INQ_C.name] = match.name ? match.name + (match.retired ? '（退職）' : '') : ''; row[INQ_C.dept] = match.dept || '';
      row[INQ_C.link] = INQ_LINK_LABEL[match.link]; row[INQ_C.userId] = uid; row[INQ_C.lineName] = displayName;
      row[INQ_C.at] = now; row[INQ_C.head] = c.head; row[INQ_C.secret] = secret; row[INQ_C.lastAt] = now; row[INQ_C.appends] = 0;
      row[INQ_C.token] = c.token; row[INQ_C.eventId] = ev.webhookEventId || '';
      sh.appendRow(row);
      log.appendRow([now, c.id, '受付', stored, uid, ev.webhookEventId || '', "'" + mid]);
      INQ_markSeen_(ev, received, '受付 ' + c.id);
      after = { kind: 'new', c: c };
    }
  } finally { lock.releaseLock(); }
  if (mode !== 'on' || !after) return;
  if (after.kind === 'new') INQ_send_([INQ_newCaseMessage(after.c)], INQ_newCaseText(after.c));
  else if (after.notify) INQ_send_([{ type: 'text', text: INQ_appendText(after.c) }], INQ_appendText(after.c));
  if (match.link === 'unregistered') INQ_guideOnce_(ss, uid, ev.replyToken);
}

/** 未登録の人へ、社員番号の登録を1回だけ案内する（返信なので送信数に数えない） */
var INQ_GUIDE_TEXT = 'お問い合わせありがとうございます。担当者から順にご連絡いたします。\n'
  + '社員の方は、お手数ですが社員番号（数字のみ）をこのトークに送ってください。LINEの登録が完了します。';
function INQ_guideOnce_(ss, uid, replyToken) {
  if (!replyToken) return;
  var sh = INQ_sheet_(ss, INQ_SHEET_GUIDED, INQ_GUIDED_HEADER), lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) if (String(v[i][0]) === uid) return;
    sh.appendRow([uid, new Date()]);
  } finally { lock.releaseLock(); }
  AC_reply_(replyToken, INQ_GUIDE_TEXT);
}

// ---- 入口：勤怠管理グループのボタン（postback） ----
function INQ_onGroupPostback_(ev) {
  try {
    if (INQ_mode_() !== 'on' || !ev || ev.type !== 'postback') return;
    var p = INQ_parsePostback(ev.postback && ev.postback.data);
    if (!p) return;                                    // 問い合わせのボタンではない（ほかの機能のもの）
    var gid = ev.source && ev.source.groupId;
    var groups = AC_groupsByDept(AC_groupSheet_().getDataRange().getValues())[AC_ADMIN_GROUP] || [];
    if (!gid || groups.indexOf(gid) === -1) return;    // 勤怠管理グループ以外では何もしない
    var uid = ev.source.userId;
    if (!AC_isUserId(uid)) { AC_reply_(ev.replyToken, '押した方を確認できないため受け付けできませんでした。スマートフォンのLINEから押してください。'); return; }
    var name = INQ_memberName_(gid, uid);
    if (name === null) { AC_reply_(ev.replyToken, 'このグループのメンバーであることを確認できなかったため、受け付けできませんでした。'); return; }
    INQ_button_(ev, p, uid, name);
  } catch (err) { INQ_fail_('ボタン', err); }
}

/** 試験用（INQ_NOTIFY_TO=admin）：管理者の個別LINEで押されたボタン */
function INQ_onAdminPostback_(ev) {
  var p = INQ_parsePostback(ev.postback && ev.postback.data);
  if (!p) return;
  var uid = ev.source && ev.source.userId;
  if (!uid || uid !== INQ_props_().getProperty('LINE_ADMIN_USER_ID')) return;
  INQ_button_(ev, p, uid, INQ_profileName_(uid) || '管理者');
}

function INQ_button_(ev, p, uid, name) {
  var ss = INQ_book_(), received = INQ_sheet_(ss, INQ_SHEET_RECEIVED, INQ_RECEIVED_HEADER);
  var reply = null, now = new Date();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (INQ_isDuplicate_(ev, received)) return;
    var sh = INQ_sheet_(ss, INQ_SHEET_CASE, INQ_CASE_HEADER), log = INQ_sheet_(ss, INQ_SHEET_LOG, INQ_LOG_HEADER);
    var c = INQ_cases_(sh).filter(function (x) { return x.id === p.id; })[0];
    if (!c || !c.token || c.token !== p.token) {
      INQ_markSeen_(ev, received, 'ボタン拒否（合言葉の不一致）');
      reply = 'このボタンは使えません（' + p.id + '）。新しい通知のボタンを押してください。';
    } else {
      var d = INQ_decide(c.state, p.action);
      if (d.changed) {
        sh.getRange(c.row, INQ_C.state + 1).setValue(d.next);
        if (d.reason === 'taken') {
          sh.getRange(c.row, INQ_C.staff + 1, 1, 3).setValues([[name, uid, now]]);
        } else {
          if (!c.staff) sh.getRange(c.row, INQ_C.staff + 1, 1, 3).setValues([[name, uid, now]]);
          sh.getRange(c.row, INQ_C.doneBy + 1, 1, 3).setValues([[name, uid, now]]);
        }
        log.appendRow([now, c.id, d.reason === 'taken' ? '対応開始' : '対応済み', '', uid, ev.webhookEventId || '', '']);
      }
      INQ_markSeen_(ev, received, 'ボタン ' + p.action + ' ' + c.id + ' ' + d.reason);
      var when = function (dt) { return dt ? INQ_md_(dt) + ' ' + INQ_hm_(dt) : ''; };
      reply = {
        taken: c.id + ' を ' + name + 'さんが対応中にしました。',
        done: c.id + ' を対応済みにしました（' + name + 'さん）。',
        alreadyDoing: c.id + ' は ' + (c.staff || '担当者') + 'さんが対応中です。',
        alreadyDone: c.id + ' は対応済みです（' + when(c.doneAt) + '・' + (c.doneBy || '担当者') + 'さん）。',
      }[d.reason];
    }
  } finally { lock.releaseLock(); }
  if (reply) AC_reply_(ev.replyToken, reply);
}

// ---- 時刻指定：リマインド（9:00・17:00） ----
function INQ_remind() {
  try {
    var mode = INQ_mode_();
    if (mode === 'off') return;
    var now = new Date();
    if (String(INQ_props_().getProperty('INQ_REMIND_DAYS') || 'all').trim() === 'weekdays') {
      var dow = INQ_dow_(now);
      if (dow === 0 || dow === 6) return;
    }
    var cases = INQ_cases_(INQ_sheet_(INQ_book_(), INQ_SHEET_CASE, INQ_CASE_HEADER))
      .map(function (c) { c.who = INQ_caseWho(c); return c; });
    var text = INQ_remindText(cases, now);
    if (!text) return;
    if (mode !== 'on') { Logger.log('問い合わせのリマインド（記録のみのため送らない）：未完了 %s件', text.split('\n・').length - 1); return; }
    INQ_send_([{ type: 'text', text: text }], text);
  } catch (err) { INQ_fail_('リマインド', err); }
}

// ---- 将来のAI自動返信用：その人に未対応・対応中の案件があるか ----
function INQ_activeCaseFor(userId) {
  if (!INQ_props_().getProperty('INQ_SPREADSHEET_ID')) return null;
  var c = INQ_openCaseOf(INQ_cases_(INQ_sheet_(INQ_book_(), INQ_SHEET_CASE, INQ_CASE_HEADER)), userId);
  return c ? { id: c.id, state: c.state } : null;
}

// ---- 導入・停止用（エディタから手動で実行） ----
/** 記録先のスプレッドシートとタブを用意する（INQ_SPREADSHEET_ID が無ければ新しく作る）。送信はしない */
function INQ_setup() {
  var props = INQ_props_(), id = props.getProperty('INQ_SPREADSHEET_ID'), ss;
  if (id) ss = SpreadsheetApp.openById(id);
  else { ss = SpreadsheetApp.create('従業員問い合わせ管理'); props.setProperty('INQ_SPREADSHEET_ID', ss.getId()); }
  [[INQ_SHEET_CASE, INQ_CASE_HEADER], [INQ_SHEET_LOG, INQ_LOG_HEADER], [INQ_SHEET_ROUTINE, INQ_ROUTINE_HEADER],
    [INQ_SHEET_RECEIVED, INQ_RECEIVED_HEADER], [INQ_SHEET_GUIDED, INQ_GUIDED_HEADER]].forEach(function (s) { INQ_sheet_(ss, s[0], s[1]); });
  var first = ss.getSheetByName('シート1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  Logger.log('問い合わせの準備：完了（版 %s）。INQ_MODE=%s。記録先：%s', INQ_VERSION, props.getProperty('INQ_MODE') || '未設定', ss.getUrl());
}

/** 9:00・17:00 のリマインドのトリガーを作る（既存のトリガーには触れない。2回実行しても増えない） */
function INQ_setupTriggers() {
  INQ_removeTriggers();
  [9, 17].forEach(function (h) { ScriptApp.newTrigger('INQ_remind').timeBased().atHour(h).nearMinute(0).everyDays(1).inTimezone(AC_TZ).create(); });
  Logger.log('問い合わせのリマインドのトリガーを作りました（9:00・17:00）');
}

/** INQ_remind のトリガーだけを消す */
function INQ_removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'INQ_remind') ScriptApp.deleteTrigger(t); });
}

/** すぐに止める（記録・送信・返信をすべてしない）。トリガーは残るが何もしない */
function INQ_stop() {
  INQ_props_().setProperty('INQ_MODE', 'off');
  Logger.log('問い合わせ管理を止めました（INQ_MODE=off）');
}

/** 手動確認用：未完了の案件の一覧を実行ログに表示する（送信・書き込みなし。本文の冒頭は出さない） */
function INQ_preview() {
  var cases = INQ_cases_(INQ_sheet_(INQ_book_(), INQ_SHEET_CASE, INQ_CASE_HEADER))
    .filter(function (c) { return c.state === INQ_STATE.open || c.state === INQ_STATE.doing; });
  Logger.log('問い合わせ（版 %s・INQ_MODE=%s）：未完了 %s件', INQ_VERSION, INQ_mode_(), cases.length);
  cases.forEach(function (c) { Logger.log('%s %s %s', c.id, c.state, c.link); });
}

// Node.jsのテストから純粋関数を読み込むため（コード.gs の書き出しに追加する）
if (typeof module !== 'undefined') {
  module.exports = Object.assign(module.exports || {}, { INQ_VERSION: INQ_VERSION, INQ_STATE: INQ_STATE, INQ_nfkc: INQ_nfkc,
    INQ_isRoutine: INQ_isRoutine, INQ_hasSecret: INQ_hasSecret, INQ_maskSecret: INQ_maskSecret, INQ_head: INQ_head,
    INQ_messageSummary: INQ_messageSummary, INQ_matchEmployee: INQ_matchEmployee, INQ_whoLabel: INQ_whoLabel,
    INQ_parsePostback: INQ_parsePostback, INQ_postbackData: INQ_postbackData, INQ_decide: INQ_decide, INQ_nextId: INQ_nextId,
    INQ_shouldNotifyAppend: INQ_shouldNotifyAppend, INQ_newCaseMessage: INQ_newCaseMessage, INQ_newCaseText: INQ_newCaseText,
    INQ_appendText: INQ_appendText, INQ_remindText: INQ_remindText, INQ_openCaseOf: INQ_openCaseOf, INQ_caseWho: INQ_caseWho });
}
