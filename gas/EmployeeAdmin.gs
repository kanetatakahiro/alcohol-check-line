/**
 * 社員管理AI（第1段階：入社・退社・取消）— 純粋関数のみ（開発ブランチ feature/employee-admin）
 *
 * ここにあるのは「判定・計算」だけで、スプレッドシート・LINE・外部通信には一切触れない。
 * 本番のApps Scriptには未導入（導入は別途承認後）。テストは test/employee-admin.test.js（すべて架空データ）。
 *
 * 流れ：勤怠管理グループに申請 → 形式チェック・マスタ照合 → グループ内の誰かが承認（承認コード・72時間有効）
 *       → 予約 → 効力日に従業員マスタへ反映 → 完了報告。反映前なら取消できる。
 *
 * 日付はすべて日本時間の 'YYYY-MM-DD' 文字列で扱う。従業員マスタのO列（入社日）・N列（退職日）へは
 * 必ず「文字」で書く（日付型で入ると AC_isRetired が退職扱いにしてしまうため）。
 */

var EA_VERSION = '2026-10-26-dev1';
var EA_APPROVAL_HOURS = 72;          // 承認の有効期限
var EA_PAST_DAYS_LIMIT = 7;          // 過去日付は7日前まで（警告つき）
var EA_FORWARD_WINDOW_SEC = 300;     // VPS中継からの転送の有効時間（5分）
var EA_PAUSE_SOURCE = '社員管理AI';  // お知らせ停止シートG列「作成元」

/** マスタ列（AC_COL と同じ並び＋O列 入社日） */
var EA_COL = { code: 0, name: 1, alias: 2, status: 3, dept: 4, userId: 5, lineName: 6, lineAt: 7, lineOk: 8,
  alcohol: 9, note: 10, category: 11, totCode: 12, retiredOn: 13, hiredOn: 14 };

var EA_CATEGORY_ALIAS = { '社員': '正社員', '正社員': '正社員', 'アルバイト': 'パート', 'パート': 'パート',
  '契約': '契約社員', '契約社員': '契約社員', '嘱託': '嘱託' };

var EA_TEMPLATES = {
  '入社': '【入社】\n社員番号：\n氏名：\n入社日：YYYY-MM-DD\n所属・拠点：\n社員区分：正社員／パート／契約社員／嘱託\nTOTコード：（わかれば）\nシフト表の書き方：（氏名と違う場合のみ）\nアルコールチェック：対象／対象外',
  '退社': '【退社】\n社員番号：\n氏名：\n退職日：YYYY-MM-DD\n最終出社日：YYYY-MM-DD（退職日と同じなら空欄）',
  '取消': '【取消】\n申請番号：',
};

// ---------- 共通の小物 ----------

function EA_z2h_(s) {
  return String(s == null ? '' : s).replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }).replace(/[／]/g, '/').replace(/[－ー―‐]/g, function (c, i, all) {
    return /\d/.test(all.charAt(i - 1)) && /\d/.test(all.charAt(i + 1)) ? '-' : c;   // 日付中の全角ハイフンのみ
  });
}

function EA_norm(s) { return String(s == null ? '' : s).replace(/[\s　]+/g, ''); }

/** 'YYYY-MM-DD' / 'YYYY/M/D' → 'YYYY-MM-DD'。読めなければ ''。 */
function EA_isoDate(s) {
  var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(EA_z2h_(s).trim());
  if (!m) return '';
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

function EA_addDays(iso, n) {
  var p = iso.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.toISOString().slice(0, 10);
}

function EA_daysBetween(a, b) {   // b - a（日数）
  var pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}

function EA_cellCode(v) { return EA_z2h_(v).replace(/^'/, '').trim(); }

// ---------- ① 申請文の読み取り ----------

/**
 * グループのメッセージを読み取る。
 *  - 「入社」「退社」「取消」だけ → { type:'template', kind, text }（雛形を返信用に返す）
 *  - 【入社】【退社】【取消】で始まる → { type:'request', kind, fields, errors }
 *  - 「承認 EA-… 123456」「却下 EA-…」 → { type:'decision', … }
 *  - それ以外 → null（何もしない。既存の部門登録などに渡す）
 */
function EA_parseMessage(text) {
  var t = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (!t) return null;
  var one = EA_norm(t);
  if (EA_TEMPLATES[one]) return { type: 'template', kind: one, text: EA_TEMPLATES[one] };

  var d = /^(承認|却下)\s*(EA-\d{8}-\d{3})(?:\s+(\d{6}))?$/.exec(EA_z2h_(t).replace(/[　]/g, ' ').trim());
  if (d) return { type: 'decision', action: d[1] === '承認' ? 'approve' : 'reject', id: d[2], code: d[3] || '' };

  var h = /^【\s*(入社|退社|退職|取消)\s*】/.exec(t);
  if (!h) return null;
  var kind = h[1] === '退職' ? '退社' : h[1];
  var fields = {}, errors = [];
  t.slice(h[0].length).split('\n').forEach(function (line) {
    var m = /^\s*([^：:]+?)\s*[：:]\s*(.*)$/.exec(line);
    if (!m) return;
    var key = EA_norm(m[1]).replace(/（.*?）|\(.*?\)/g, '');
    var val = m[2].replace(/（わかれば）|（氏名と違う場合のみ）|（退職日と同じなら空欄）/g, '').trim();
    fields[EA_FIELD_KEYS[key] || key] = val;
  });
  var req = { kind: kind, fields: {} };
  var f = fields;
  if (kind === '入社') {
    req.fields = {
      code: EA_cellCode(f.code), name: String(f.name || '').trim().replace(/\s+/g, ' '),
      hiredOn: EA_isoDate(f.hiredOn), hiredOnRaw: f.hiredOn || '',
      dept: String(f.dept || '').trim(), category: EA_CATEGORY_ALIAS[EA_norm(f.category)] || '',
      categoryRaw: f.category || '', totCode: EA_cellCode(f.totCode), alias: String(f.alias || '').trim(),
      alcohol: { '対象': true, 'はい': true, '対象外': false, 'いいえ': false }[EA_norm(f.alcohol)],
    };
    if (req.fields.alcohol === undefined) errors.push('アルコールチェックは「対象」か「対象外」で入力してください');
    if (!req.fields.code) errors.push('社員番号がありません');
    if (!req.fields.name) errors.push('氏名がありません');
    if (!req.fields.hiredOn) errors.push('入社日が読めません（例：2026-11-05）');
    if (!req.fields.dept) errors.push('所属・拠点がありません');
    if (!req.fields.category) errors.push('社員区分が読めません（正社員／パート／契約社員／嘱託）');
  } else if (kind === '退社') {
    var ret = EA_isoDate(f.retiredOn), last = f.lastDay ? EA_isoDate(f.lastDay) : '';
    req.fields = { code: EA_cellCode(f.code), name: String(f.name || '').trim(), retiredOn: ret, lastDay: last || ret };
    if (!req.fields.code) errors.push('社員番号がありません');
    if (!req.fields.name) errors.push('氏名（確認用）がありません');
    if (!ret) errors.push('退職日が読めません（例：2026-11-30）');
    if (f.lastDay && !last) errors.push('最終出社日が読めません');
  } else {
    req.fields = { id: EA_z2h_(f.id || '').trim() };
    if (!/^EA-\d{8}-\d{3}$/.test(req.fields.id)) errors.push('申請番号が読めません（例：EA-20261105-001）');
  }
  if (req.fields.code && !/^\d{3,8}$/.test(req.fields.code)) errors.push('社員番号は数字で入力してください');
  if (req.fields.totCode && !/^\d{1,10}$/.test(req.fields.totCode)) errors.push('TOTコードは数字で入力してください');
  return { type: 'request', kind: kind, fields: req.fields, errors: errors };
}

var EA_FIELD_KEYS = {
  '社員番号': 'code', '氏名': 'name', '入社日': 'hiredOn', '所属・拠点': 'dept', '所属': 'dept', '拠点': 'dept',
  '社員区分': 'category', '雇用区分': 'category', 'TOTコード': 'totCode', 'ToTコード': 'totCode',
  'シフト表の書き方': 'alias', '別表記': 'alias', 'アルコールチェック': 'alcohol', '退職日': 'retiredOn',
  '最終出社日': 'lastDay', '申請番号': 'id',
};

// ---------- ② マスタとの照合 ----------

function EA_findByCode_(master, code) {
  for (var i = 1; i < (master || []).length; i++) if (EA_cellCode(master[i][EA_COL.code]) === code) return i;
  return -1;
}

/** LINEの社員番号登録で先にできた行（氏名なし・備考「LINE登録で追加」）か */
function EA_isLinePlaceholder_(r) {
  return !EA_norm(r[EA_COL.name]) && /^LINE登録で追加/.test(String(r[EA_COL.note] || ''));
}

/**
 * 申請内容をマスタと照らし合わせる。errors があれば受け付けない。warnings は確認のうえ承認できる。
 * pending：審査中・予約中の申請（[{id, kind, fields, state}]）— 同じ社員の二重申請を見つける。
 */
function EA_validate(parsed, master, today, pending) {
  var errors = (parsed.errors || []).slice(), warnings = [];
  var f = parsed.fields || {};
  var depts = {};
  (master || []).slice(1).forEach(function (r) { if (r[EA_COL.status] !== '退職' && r[EA_COL.dept]) depts[String(r[EA_COL.dept]).trim()] = 1; });

  function checkDate(iso, label) {
    if (!iso) return;
    var diff = EA_daysBetween(today, iso);
    if (diff < -EA_PAST_DAYS_LIMIT) errors.push(label + 'が' + EA_PAST_DAYS_LIMIT + '日より前です（管理本部で直接修正してください）');
    else if (diff < 0) warnings.push(label + 'が過去の日付です（' + iso + '）。承認すると次の反映時刻に反映します');
  }

  if (parsed.kind === '入社') {
    var i = f.code ? EA_findByCode_(master, f.code) : -1;
    if (i > 0 && !EA_isLinePlaceholder_(master[i])) errors.push('社員番号 ' + f.code + ' はすでにマスタにあります（社員番号は再利用しません）');
    if (i > 0 && EA_isLinePlaceholder_(master[i])) warnings.push('この社員番号は先にLINE登録済みです。入社日にその行へ氏名などを書き込みます');
    checkDate(f.hiredOn, '入社日');
    if (f.dept && !depts[f.dept]) warnings.push('所属・拠点「' + f.dept + '」は今のマスタにない名前です（新しい拠点なら問題ありません）');
    if (f.totCode) {
      (master || []).slice(1).forEach(function (r) {
        if (EA_cellCode(r[EA_COL.totCode]) === f.totCode && r[EA_COL.status] !== '退職') errors.push('TOTコード ' + f.totCode + ' は在籍中の別の人に登録されています');
      });
    } else warnings.push('TOTコードが空です。打刻のお知らせはTOTコード登録後に始まります');
    var sameName = (master || []).slice(1).filter(function (r) { return f.name && EA_norm(r[EA_COL.name]) === EA_norm(f.name) && r[EA_COL.status] !== '退職'; });
    if (sameName.length) warnings.push('同じ氏名の在籍者がいます（社員番号で区別します）');
  } else if (parsed.kind === '退社') {
    var j = f.code ? EA_findByCode_(master, f.code) : -1;
    if (f.code && j < 0) errors.push('社員番号 ' + f.code + ' はマスタにありません');
    if (j > 0) {
      var r = master[j];
      if (r[EA_COL.status] === '退職') errors.push('社員番号 ' + f.code + ' はすでに退職になっています');
      if (f.name && EA_norm(r[EA_COL.name]) !== EA_norm(f.name)) errors.push('社員番号と氏名が一致しません（マスタの氏名を確認してください）');
      if (String(r[EA_COL.retiredOn] || '').trim()) warnings.push('マスタにすでに退職日が入っています。今回の内容で上書きします');
    }
    checkDate(f.retiredOn, '退職日');
    if (f.retiredOn && f.lastDay && f.lastDay > f.retiredOn) errors.push('最終出社日が退職日より後になっています');
  }
  (pending || []).forEach(function (p) {
    if (p.fields && f.code && p.fields.code === f.code && (p.state === '申請中' || p.state === '予約')) {
      warnings.push('同じ社員番号の申請（' + p.id + '・' + p.kind + '・' + p.state + '）があります。必要なら先に取消してください');
    }
  });
  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

// ---------- ③ 申請番号・承認コード・状態 ----------

/** 申請番号：EA-YYYYMMDD-連番3桁（その日の既存番号から次を決める） */
function EA_newRequestId(today, existingIds) {
  var prefix = 'EA-' + today.replace(/-/g, '') + '-', max = 0;
  (existingIds || []).forEach(function (id) { if (String(id).indexOf(prefix) === 0) max = Math.max(max, +String(id).slice(prefix.length)); });
  return prefix + ('00' + (max + 1)).slice(-3);
}

/** 承認コード（6桁）。乱数は呼び出し側（GASは Utilities.getUuid 等）から渡す */
function EA_approvalCode(randomInt) { return ('00000' + (Math.abs(Math.floor(randomInt)) % 1000000)).slice(-6); }

function EA_isExpired(createdAtMs, nowMs) { return nowMs - createdAtMs > EA_APPROVAL_HOURS * 3600 * 1000; }

/**
 * 状態遷移。申請中 →(承認)→ 予約 →(反映)→ 反映済
 *          申請中 →(却下／期限切れ／取消)→ 却下・期限切れ・取消
 *          予約   →(取消)→ 取消（反映前なら元の状態に何も残らない）
 * 反映済の取消は第1段階では受け付けない（訂正は第2段階）。
 */
var EA_TRANSITIONS = {
  '申請中': { approve: '予約', reject: '却下', expire: '期限切れ', cancel: '取消' },
  '予約': { apply: '反映済', cancel: '取消' },
};

function EA_transition(state, action) {
  var next = (EA_TRANSITIONS[state] || {})[action];
  if (next) return { ok: true, state: next };
  var why = state === '反映済' && action === 'cancel' ? '反映済みの申請は取消できません（管理本部で直接修正するか、第2段階の「訂正」を使います）'
    : '「' + state + '」の申請には、その操作はできません';
  return { ok: false, state: state, error: why };
}

/**
 * 承認の判定。グループ外の人・期限切れ・コード違い・使用済みを弾く。
 * req: {state, createdAtMs, approvalCode}, decision: {action, code}, ctx: {isGroupMember, nowMs, verified}
 */
function EA_judgeDecision(req, decision, ctx) {
  if (!ctx.verified) return { ok: false, error: '署名確認済みのメッセージではないため受け付けません' };
  if (!ctx.isGroupMember) return { ok: false, error: '勤怠管理グループのメンバーだけが承認できます' };
  if (!req) return { ok: false, error: 'その申請番号は見つかりません' };
  if (req.state === '申請中' && EA_isExpired(req.createdAtMs, ctx.nowMs)) return { ok: false, error: '承認期限（72時間）を過ぎています。もう一度申請してください', expire: true };
  if (decision.action === 'approve' && decision.code !== req.approvalCode) return { ok: false, error: '承認コードが違います' };
  var t = EA_transition(req.state, decision.action);
  return t.ok ? { ok: true, state: t.state } : { ok: false, error: t.error };
}

// ---------- ④ 反映内容の計算 ----------

/** その申請がマスタへ反映される日（入社＝入社日、退社＝退職日の翌日） */
function EA_effectiveDate(parsed) {
  return parsed.kind === '入社' ? parsed.fields.hiredOn : EA_addDays(parsed.fields.retiredOn, 1);
}

/** 予約中のうち、今日反映すべきもの（効力日が今日以前） */
function EA_dueRequests(requests, today) {
  return (requests || []).filter(function (r) { return r.state === '予約' && EA_effectiveDate(r) <= today; });
}

/**
 * マスタへの書き込み内容を計算する（書き込みはしない）。
 * 戻り値 { ok, append?: 15列の行, updates?: [{row(1始まり), col(1始まり), value, text?}], error? }
 * text:true の値は、書き込み側でセルを「書式なしテキスト」にしてから入れる。
 */
function EA_planMasterChange(parsed, master) {
  var f = parsed.fields;
  var i = EA_findByCode_(master, f.code);
  if (parsed.kind === '入社') {
    if (i > 0 && !EA_isLinePlaceholder_(master[i])) return { ok: false, error: '社員番号がすでにあります' };
    var vals = {};
    vals[EA_COL.name] = f.name; vals[EA_COL.alias] = f.alias || ''; vals[EA_COL.status] = '在籍'; vals[EA_COL.dept] = f.dept;
    vals[EA_COL.alcohol] = !!f.alcohol; vals[EA_COL.category] = f.category; vals[EA_COL.totCode] = f.totCode || '';
    vals[EA_COL.hiredOn] = f.hiredOn;
    if (i > 0) {   // 先にLINE登録された行へ書き込む（LINE ID等はそのまま）
      var ups = Object.keys(vals).map(function (c) {
        return { row: i + 1, col: +c + 1, value: vals[c], text: +c === EA_COL.hiredOn || +c === EA_COL.totCode };
      });
      ups.push({ row: i + 1, col: EA_COL.note + 1, value: '' });
      return { ok: true, updates: ups };
    }
    var row = []; for (var k = 0; k <= EA_COL.hiredOn; k++) row.push('');
    row[EA_COL.code] = f.code; Object.keys(vals).forEach(function (c) { row[+c] = vals[c]; });
    row[EA_COL.lineOk] = false;
    return { ok: true, append: row, textCols: [EA_COL.code + 1, EA_COL.totCode + 1, EA_COL.hiredOn + 1] };
  }
  if (parsed.kind === '退社') {
    if (i < 0) return { ok: false, error: '社員番号がマスタにありません' };
    if (master[i][EA_COL.status] === '退職') return { ok: false, error: 'すでに退職になっています' };
    return { ok: true, updates: [
      { row: i + 1, col: EA_COL.status + 1, value: '退職' },
      { row: i + 1, col: EA_COL.retiredOn + 1, value: f.retiredOn, text: true },
    ] };
  }
  return { ok: false, error: '反映できない申請です' };
}

/**
 * 最終出社日の翌日〜退職日まで、お知らせを止める行（お知らせ停止シート 8列）。
 * 退職日＝最終出社日なら不要（退職日の翌日にマスタで退職になる）。
 * 開始日・終了日は日付型で書く必要がある（AC_toDateFn_ は日付型だけを変換する）ため、{date:'YYYY-MM-DD'} で返す。
 */
function EA_planPauseRow(parsed, master, requestId) {
  var f = parsed.fields;
  if (parsed.kind !== '退社' || !f.lastDay || f.lastDay >= f.retiredOn) return null;
  var i = EA_findByCode_(master, f.code);
  return [f.code, i > 0 ? String(master[i][EA_COL.name]) : f.name, { date: EA_addDays(f.lastDay, 1) }, { date: f.retiredOn },
    '退職前の休み（最終出社日 ' + f.lastDay + '）', '全部', EA_PAUSE_SOURCE, requestId];
}

/** 取消時に消すお知らせ停止の行（G列=社員管理AI かつ H列=申請番号 のものだけ。手入力の行には触れない） */
function EA_pauseRowsToRemove(pauseValues, requestId) {
  var out = [];
  for (var i = 1; i < (pauseValues || []).length; i++) {
    if (pauseValues[i][6] === EA_PAUSE_SOURCE && pauseValues[i][7] === requestId) out.push(i + 1);
  }
  return out;
}

// ---------- ⑤ 安全対策（VPS中継からの転送の確認・重複防止） ----------

/**
 * VPSの署名確認済み中継から届いた転送を確かめる。
 * body: { type:'line-verified', ts:秒, nonce, events:[…], sig }。sig = HMAC-SHA256(secret, ts + '.' + nonce + '.' + JSON.stringify(events)) の16進
 * hmacHex(secret, text) は呼び出し側が渡す（GAS：Utilities.computeHmacSha256Signature、Node：crypto）。
 * seenNonces：使用済みnonceの集合（CacheService等）。
 */
function EA_verifyForward(body, secret, nowSec, seenNonces, hmacHex) {
  if (!body || body.type !== 'line-verified') return { ok: false, error: 'type' };
  if (!secret) return { ok: false, error: 'secret未設定' };
  if (typeof body.ts !== 'number' || Math.abs(nowSec - body.ts) > EA_FORWARD_WINDOW_SEC) return { ok: false, error: '時刻ずれ' };
  if (!body.nonce || seenNonces[body.nonce]) return { ok: false, error: '再送・重複' };
  var expect = hmacHex(secret, body.ts + '.' + body.nonce + '.' + JSON.stringify(body.events || []));
  if (!EA_safeEqual_(expect, String(body.sig || ''))) return { ok: false, error: '署名不一致' };
  return { ok: true };
}

function EA_safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var x = 0; for (var i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** LINEの webhookEventId で、同じイベントを二度処理しない。未処理のものだけ返す */
function EA_dedupeEvents(events, seenIds) {
  return (events || []).filter(function (ev) {
    var id = ev && ev.webhookEventId;
    if (!id) return true;
    if (seenIds[id]) return false;
    seenIds[id] = true;
    return true;
  });
}

if (typeof module !== 'undefined') {
  module.exports = { EA_parseMessage: EA_parseMessage, EA_validate: EA_validate, EA_isoDate: EA_isoDate, EA_addDays: EA_addDays,
    EA_newRequestId: EA_newRequestId, EA_approvalCode: EA_approvalCode, EA_isExpired: EA_isExpired,
    EA_transition: EA_transition, EA_judgeDecision: EA_judgeDecision, EA_effectiveDate: EA_effectiveDate,
    EA_dueRequests: EA_dueRequests, EA_planMasterChange: EA_planMasterChange, EA_planPauseRow: EA_planPauseRow,
    EA_pauseRowsToRemove: EA_pauseRowsToRemove, EA_verifyForward: EA_verifyForward, EA_dedupeEvents: EA_dedupeEvents,
    EA_TEMPLATES: EA_TEMPLATES, EA_COL: EA_COL };
}
