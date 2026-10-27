/**
 * 社員管理AI（第1段階：入社・退社・取消）
 *
 * 流れ：勤怠管理グループ（管理本部用のLINEグループ）に申請 → 形式チェック・従業員マスタと照合 → グループ内の誰かが承認（承認コード・72時間有効）
 *       → 予約 → 反映日（入社＝入社日、退社＝退職日の翌日）の朝に従業員マスタへ反映 → グループへ完了報告。反映前なら取消できる。
 *
 * 置き場所：既存の「勤怠・アルコールチェック管理」とは別の、社員管理AI専用の Apps Script プロジェクト（EmployeeAdminHost.gs と一緒に入れる）。
 * 受信：既存の公式アカウント「REBIRTH 管理本部」の Webhook を Cloudflare Workers（workers/line-webhook）で受け、LINE署名を確認したうえで
 *       既存の Apps Script には本文をそのまま、勤怠管理グループのイベントだけこのプロジェクトの doPost（type 'line-verified'）へ転送する。
 *       既存の Apps Script のコードは変更しない。
 *
 * 安全のしくみ
 *  - 受け口が LINE の署名（X-Line-Signature）をチャネルシークレットで確かめたものだけが届く。
 *    受け口→Apps Script の転送は、合言葉の署名（HMAC-SHA256・LINEの本文そのものに対して）・5分以内・使い捨て番号（nonce）で確かめる。
 *    署名の無い・合わない・古い・使い回しの受信は、何も処理しない（改ざんされた本文も署名が合わず拒否）。
 *  - 申請・承認・取消は、勤怠管理グループ（EA_ADMIN_GROUP_ID）のメッセージで、送信者が今もグループのメンバーである場合だけ（毎回 LINE に問い合わせ）。
 *  - 同じLINEイベント（webhookEventId）は一度だけ処理する。承認コードは1回限り。
 *
 * 切り替え（スクリプトプロパティ）
 *  - EA_MODE：未設定・off＝何もしない／record＝記録のみ（返信・承認・反映なし）／on＝利用開始
 *  - EA_AUTO_APPLY：'true' のときだけ、従業員マスタへ反映する
 *  - EA_FORWARD_SECRET：受け口と同じ合言葉／EA_LINE_CHANNEL_TOKEN：社員管理AI用LINEのアクセストークン
 *  - EA_ADMIN_GROUP_ID：勤怠管理グループのID（社員管理AI用LINEから見たID。参加時に操作ログへ記録される）
 *  - EMPLOYEE_MASTER_ID：従業員マスタのファイルID
 *
 * 日付はすべて日本時間の 'YYYY-MM-DD'。従業員マスタのO列（入社日）・N列（退職日）へは「文字」で書く
 * （日付型で入ると既存の AC_isRetired が退職扱いにしてしまうため）。
 * 別表記：第1段階ではC列（既存の読み取り先）に書き、あわせて「別表記」シート（社員番号をキーに複数管理する将来の正本）にも記録する。
 * 既存プロジェクトと同じシートに書くため、行の追加は appendRow（同時に追加しても上書きしない）で行う。
 */

var EA_VERSION = '2026-10-27c';
var EA_APPROVAL_HOURS = 72;          // 承認の有効期限
var EA_PAST_DAYS_LIMIT = 7;          // 過去日付は7日前まで（警告つき）
var EA_FORWARD_WINDOW_SEC = 300;     // 受け口からの転送の有効時間（5分）
var EA_PAUSE_SOURCE = '社員管理AI';  // お知らせ停止シートG列「作成元」

/** マスタ列（AC_COL と同じ並び＋O列 入社日） */
var EA_COL = { code: 0, name: 1, alias: 2, status: 3, dept: 4, userId: 5, lineName: 6, lineAt: 7, lineOk: 8,
  alcohol: 9, note: 10, category: 11, totCode: 12, retiredOn: 13, hiredOn: 14 };
var EA_MASTER_WIDTH = 15;
var EA_MASTER_COL_NAMES = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時',
  'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日', '入社日'];

var EA_CATEGORY_ALIAS = { '社員': '正社員', '正社員': '正社員', 'アルバイト': 'パート', 'パート': 'パート',
  '契約': '契約社員', '契約社員': '契約社員', '嘱託': '嘱託' };

var EA_TEMPLATES = {
  '入社': '【入社】\n社員番号：\n氏名：\n入社日：YYYY-MM-DD\n所属・拠点：\n社員区分：正社員／パート／契約社員／嘱託\nTOTコード：（わかれば）\nシフト表の書き方：（氏名と違う場合のみ）\nアルコールチェック：対象／対象外',
  '退社': '【退社】\n社員番号：\n氏名：\n退職日：YYYY-MM-DD\n最終出社日：YYYY-MM-DD（退職日と同じなら空欄）',
  '取消': '【取消】\n申請番号：',
};

// ======================================================================
// 純粋関数（Node.js のテスト対象。シート・LINE・外部通信には触れない）
// ======================================================================

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
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)).toISOString().slice(0, 10);
}

function EA_daysBetween(a, b) {   // b - a（日数）
  var pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}

function EA_cellCode(v) { return EA_z2h_(v).replace(/^'/, '').trim(); }
/** TOTコードの比較用（「0083」と「83」を同じに扱う。AC_totKey と同じ） */
function EA_totKey(v) { var t = EA_cellCode(v); return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : t; }

var EA_FIELD_KEYS = {
  '社員番号': 'code', '氏名': 'name', '入社日': 'hiredOn', '所属・拠点': 'dept', '所属': 'dept', '拠点': 'dept',
  '社員区分': 'category', '雇用区分': 'category', 'TOTコード': 'totCode', 'ToTコード': 'totCode',
  'シフト表の書き方': 'alias', '別表記': 'alias', 'アルコールチェック': 'alcohol', '退職日': 'retiredOn',
  '最終出社日': 'lastDay', '申請番号': 'id',
};

/**
 * グループのメッセージを読み取る。
 *  - 「入社」「退社」「取消」だけ → { type:'template', kind, text }
 *  - 【入社】【退社】【取消】で始まる → { type:'request', kind, fields, errors }
 *  - 「承認 EA-… 123456」「却下 EA-…」 → { type:'decision', action, id, code }
 *  - それ以外 → null（社員管理では扱わない。既存の部門登録などはそのまま）
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
  var f = {}, errors = [];
  t.slice(h[0].length).split('\n').forEach(function (line) {
    var m = /^\s*([^：:]+?)\s*[：:]\s*(.*)$/.exec(line);
    if (!m) return;
    var key = EA_norm(m[1]).replace(/（.*?）|\(.*?\)/g, '');
    var val = m[2].replace(/（わかれば）|（氏名と違う場合のみ）|（退職日と同じなら空欄）/g, '').trim();
    f[EA_FIELD_KEYS[key] || key] = val;
  });
  var fields;
  if (kind === '入社') {
    fields = {
      code: EA_cellCode(f.code), name: String(f.name || '').trim().replace(/[\s　]+/g, ' '),
      hiredOn: EA_isoDate(f.hiredOn), dept: String(f.dept || '').trim(),
      category: EA_CATEGORY_ALIAS[EA_norm(f.category)] || '', totCode: EA_cellCode(f.totCode),
      alias: String(f.alias || '').trim(),
      alcohol: { '対象': true, 'はい': true, '対象外': false, 'いいえ': false }[EA_norm(f.alcohol)],
    };
    if (!fields.code) errors.push('社員番号がありません');
    if (!fields.name) errors.push('氏名がありません');
    if (!fields.hiredOn) errors.push('入社日が読めません（例：2026-11-05）');
    if (!fields.dept) errors.push('所属・拠点がありません');
    if (!fields.category) errors.push('社員区分が読めません（正社員／パート／契約社員／嘱託）');
    if (fields.alcohol === undefined) errors.push('アルコールチェックは「対象」か「対象外」で入力してください');
  } else if (kind === '退社') {
    var ret = EA_isoDate(f.retiredOn), last = f.lastDay ? EA_isoDate(f.lastDay) : '';
    fields = { code: EA_cellCode(f.code), name: String(f.name || '').trim(), retiredOn: ret, lastDay: last || ret };
    if (!fields.code) errors.push('社員番号がありません');
    if (!fields.name) errors.push('氏名（確認用）がありません');
    if (!ret) errors.push('退職日が読めません（例：2026-11-30）');
    if (f.lastDay && !last) errors.push('最終出社日が読めません');
  } else {
    fields = { id: EA_z2h_(f.id || '').trim() };
    if (!/^EA-\d{8}-\d{3}$/.test(fields.id)) errors.push('申請番号が読めません（例：EA-20261105-001）');
  }
  if (fields.code && !/^\d{4,6}$/.test(fields.code)) errors.push('社員番号は4〜6桁の数字で入力してください');
  if (fields.totCode && !/^\d{1,10}$/.test(fields.totCode)) errors.push('TOTコードは数字で入力してください');
  return { type: 'request', kind: kind, fields: fields, errors: errors };
}

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
 * baseDate：日付の新しさを判定する基準日（申請時は今日、承認時は申請日）。
 * pending：審査中・予約中の申請（[{id, kind, fields, state}]）— 同じ社員の二重申請を見つける。
 */
function EA_validate(parsed, master, baseDate, pending) {
  var errors = (parsed.errors || []).slice(), warnings = [];
  var f = parsed.fields || {};
  var depts = {};
  (master || []).slice(1).forEach(function (r) { if (r[EA_COL.status] !== '退職' && r[EA_COL.dept]) depts[String(r[EA_COL.dept]).trim()] = 1; });

  function checkDate(iso, label) {
    if (!iso) return;
    var diff = EA_daysBetween(baseDate, iso);
    if (diff < -EA_PAST_DAYS_LIMIT) errors.push(label + 'が' + EA_PAST_DAYS_LIMIT + '日より前です（管理本部で直接修正してください）');
    else if (diff < 0) warnings.push(label + 'が過去の日付です（' + iso + '）。承認後、次の反映処理で反映します');
  }

  if (parsed.kind === '入社') {
    var i = f.code ? EA_findByCode_(master, f.code) : -1;
    if (i > 0 && !EA_isLinePlaceholder_(master[i])) errors.push('社員番号 ' + f.code + ' はすでにマスタにあります（社員番号は再利用しません）');
    if (i > 0 && EA_isLinePlaceholder_(master[i])) warnings.push('この社員番号は先にLINE登録済みです。入社日にその行へ氏名などを書き込みます');
    checkDate(f.hiredOn, '入社日');
    if (f.dept && !depts[f.dept]) warnings.push('所属・拠点「' + f.dept + '」は今のマスタにない名前です（新しい拠点なら問題ありません）');
    if (f.totCode) {
      var hit = (master || []).slice(1).some(function (r) {
        return EA_totKey(r[EA_COL.totCode]) === EA_totKey(f.totCode) && r[EA_COL.status] !== '退職';
      });
      if (hit) errors.push('TOTコード ' + f.totCode + ' は在籍中の別の人に登録されています');
    } else warnings.push('TOTコードが空です。打刻のお知らせはTOTコード登録後に始まります');
    var sameName = (master || []).slice(1).some(function (r) { return f.name && EA_norm(r[EA_COL.name]) === EA_norm(f.name) && r[EA_COL.status] !== '退職'; });
    if (sameName) warnings.push('同じ氏名の在籍者がいます（社員番号で区別します）');
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

/** 申請番号：EA-YYYYMMDD-連番3桁（その日の既存番号から次を決める） */
function EA_newRequestId(today, existingIds) {
  var prefix = 'EA-' + today.replace(/-/g, '') + '-', max = 0;
  (existingIds || []).forEach(function (id) { if (String(id).indexOf(prefix) === 0) max = Math.max(max, +String(id).slice(prefix.length)); });
  return prefix + ('00' + (max + 1)).slice(-3);
}

/** 承認コード（6桁）。乱数は呼び出し側から渡す */
function EA_approvalCode(randomInt) { return ('00000' + (Math.abs(Math.floor(randomInt)) % 1000000)).slice(-6); }

function EA_isExpired(createdAtMs, nowMs) { return nowMs - createdAtMs > EA_APPROVAL_HOURS * 3600 * 1000; }

/**
 * 状態遷移。申請中 →(承認)→ 予約 →(反映)→ 反映済
 *          申請中 →(却下／期限切れ／取消)→ 却下・期限切れ・取消
 *          予約   →(取消)→ 取消、(反映できない)→ エラー
 * 反映済の取消は第1段階では受け付けない（訂正は第2段階）。
 */
var EA_TRANSITIONS = {
  '申請中': { approve: '予約', reject: '却下', expire: '期限切れ', cancel: '取消' },
  '予約': { apply: '反映済', cancel: '取消', fail: 'エラー' },
};

function EA_transition(state, action) {
  var next = (EA_TRANSITIONS[state] || {})[action];
  if (next) return { ok: true, state: next };
  var why = state === '反映済' && action === 'cancel' ? '反映済みの申請は取消できません（管理本部で従業員マスタを直接修正してください）'
    : '「' + state + '」の申請には、その操作はできません';
  return { ok: false, state: state, error: why };
}

/**
 * 承認・却下の判定。署名未確認・グループ外・期限切れ・コード違い・使用済みを弾く（本人の承認は可）。
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
 * 戻り値 { ok, append?: 15列の行, textCols?: [列番号], updates?: [{row, col, value, text?}], error? }（行・列は1始まり）
 * text:true の値は、書き込み側でセルを「書式なしテキスト」にしてから入れる。
 */
function EA_planMasterChange(parsed, master) {
  var f = parsed.fields;
  var i = EA_findByCode_(master, f.code);
  if (parsed.kind === '入社') {
    if (i > 0 && !EA_isLinePlaceholder_(master[i])) return { ok: false, error: '社員番号 ' + f.code + ' がすでにあります' };
    var dup = (master || []).slice(1).some(function (r, k) {
      return k + 1 !== i && f.totCode && EA_totKey(r[EA_COL.totCode]) === EA_totKey(f.totCode) && r[EA_COL.status] !== '退職';
    });
    if (dup) return { ok: false, error: 'TOTコード ' + f.totCode + ' が在籍中の別の人に登録されています' };
    var vals = {};
    vals[EA_COL.name] = f.name; vals[EA_COL.alias] = f.alias || ''; vals[EA_COL.status] = '在籍'; vals[EA_COL.dept] = f.dept;
    vals[EA_COL.alcohol] = !!f.alcohol; vals[EA_COL.category] = f.category; vals[EA_COL.totCode] = f.totCode || '';
    vals[EA_COL.hiredOn] = f.hiredOn;
    var isText = function (c) { return c === EA_COL.hiredOn || c === EA_COL.totCode; };
    if (i > 0) {   // 先にLINE登録された行へ書き込む（LINE ID等はそのまま）
      var ups = Object.keys(vals).map(function (c) { return { row: i + 1, col: +c + 1, value: vals[c], text: isText(+c) }; });
      ups.push({ row: i + 1, col: EA_COL.note + 1, value: '' });
      return { ok: true, updates: ups };
    }
    var row = []; for (var k = 0; k < EA_MASTER_WIDTH; k++) row.push('');
    row[EA_COL.code] = f.code; Object.keys(vals).forEach(function (c) { row[+c] = vals[c]; });
    row[EA_COL.lineOk] = false;
    return { ok: true, append: row, textCols: [EA_COL.code + 1, EA_COL.totCode + 1, EA_COL.hiredOn + 1] };
  }
  if (parsed.kind === '退社') {
    if (i < 0) return { ok: false, error: '社員番号 ' + f.code + ' がマスタにありません' };
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
 * 開始日・終了日は日付型で書く必要がある（AC_toDateFn_ は日付型だけを変換する）ため {date:'YYYY-MM-DD'} で返す。
 */
function EA_planPauseRow(parsed, master, requestId) {
  var f = parsed.fields;
  if (parsed.kind !== '退社' || !f.lastDay || f.lastDay >= f.retiredOn) return null;
  var i = EA_findByCode_(master, f.code);
  return [f.code, i > 0 ? String(master[i][EA_COL.name]) : f.name, { date: EA_addDays(f.lastDay, 1) }, { date: f.retiredOn },
    '退職前の休み（最終出社日 ' + f.lastDay + '）', '全部', EA_PAUSE_SOURCE, requestId];
}

/** 取消時に消すお知らせ停止の行番号（G列=社員管理AI かつ H列=申請番号 のものだけ。手入力の行には触れない） */
function EA_pauseRowsToRemove(pauseValues, requestId) {
  var out = [];
  for (var i = 1; i < (pauseValues || []).length; i++) {
    if (pauseValues[i][6] === EA_PAUSE_SOURCE && String(pauseValues[i][7]) === requestId) out.push(i + 1);
  }
  return out;
}

/**
 * VPSの署名確認済み中継から届いた転送を確かめる。
 * body: { type:'line-verified', ts:秒, nonce, payload:'LINEから届いた本文そのまま', sig }
 * sig = HMAC-SHA256(secret, ts + '.' + nonce + '.' + payload) の16進
 * hmacHex(secret, text) は呼び出し側が渡す（GAS：Utilities.computeHmacSha256Signature、Node：crypto）。
 * nonceSeen(nonce)：使用済みなら true。
 */
function EA_verifyForward(body, secret, nowSec, nonceSeen, hmacHex) {
  if (!body || body.type !== 'line-verified') return { ok: false, error: 'type' };
  if (!secret) return { ok: false, error: '合言葉が未設定' };
  if (typeof body.ts !== 'number' || Math.abs(nowSec - body.ts) > EA_FORWARD_WINDOW_SEC) return { ok: false, error: '時刻ずれ' };
  if (typeof body.payload !== 'string' || !/^[0-9a-f-]{16,64}$/i.test(String(body.nonce || ''))) return { ok: false, error: '形式' };
  if (nonceSeen(body.nonce)) return { ok: false, error: '再送・重複' };
  var expect = hmacHex(secret, body.ts + '.' + body.nonce + '.' + body.payload);
  if (!EA_safeEqual_(expect, String(body.sig || '').toLowerCase())) return { ok: false, error: '署名不一致' };
  return { ok: true };
}

function EA_safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var x = 0; for (var i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** LINEの webhookEventId で、同じイベントを二度処理しない。未処理のものだけ返す（isSeen/markSeen は呼び出し側の記録） */
function EA_dedupeEvents(events, isSeen, markSeen) {
  var local = {};
  return (events || []).filter(function (ev) {
    var id = ev && ev.webhookEventId;
    if (!id) return true;
    if (local[id] || isSeen(id)) return false;
    local[id] = true; markSeen(id);
    return true;
  });
}

/** 申請の内容を、グループへの返信用の文にする */
function EA_describe(kind, f, masterName) {
  if (kind === '入社') {
    return ['社員番号：' + f.code, '氏名：' + f.name, '入社日：' + f.hiredOn, '所属・拠点：' + f.dept + '／' + f.category,
      'TOTコード：' + (f.totCode || '（未登録）'), f.alias ? 'シフト表の書き方：' + f.alias : '',
      'アルコールチェック：' + (f.alcohol ? '対象' : '対象外')].filter(Boolean).join('\n');
  }
  var lines = ['社員番号：' + f.code, '氏名：' + (masterName || f.name), '退職日：' + f.retiredOn];
  lines.push(f.lastDay && f.lastDay < f.retiredOn
    ? '最終出社日：' + f.lastDay + '（' + EA_addDays(f.lastDay, 1) + '〜' + f.retiredOn + ' はお知らせを止めます）'
    : '最終出社日：' + f.retiredOn);
  return lines.join('\n');
}

// ======================================================================
// シート・LINEとのやり取り（Apps Script 上でのみ動く）
// ======================================================================

var EA_SHEET_REQ = '社員管理_申請';
var EA_REQ_HEADER = ['申請番号', '状態', '種類', '社員番号', '氏名', '効力日', '申請内容', '申請者ID', '申請者名', '申請日時',
  '承認コード', '承認・処理者ID', '承認・処理者名', '承認・処理日時', '反映日時', '警告・エラー', '更新日時'];
var EA_R = { id: 0, state: 1, kind: 2, code: 3, name: 4, effective: 5, fields: 6, byId: 7, byName: 8, at: 9,
  approvalCode: 10, actId: 11, actName: 12, actAt: 13, appliedAt: 14, note: 15, updatedAt: 16 };
var EA_SHEET_HIST = '社員管理_変更履歴';
var EA_HIST_HEADER = ['日時', '申請番号', '種類', '社員番号', 'シート', '行', '項目', '変更前', '変更後'];
var EA_SHEET_LOG = '社員管理_操作ログ';
var EA_LOG_HEADER = ['日時', '操作', '申請番号', '社員番号', 'LINEユーザーID', '表示名', '結果', '詳細'];
var EA_SHEET_ALIAS = '別表記';
var EA_ALIAS_HEADER = ['社員番号', '別表記', '登録日', '作成元', '申請番号'];
var EA_PAUSE_EXTRA_HEADER = ['作成元', '管理ID'];

function EA_props_() { return PropertiesService.getScriptProperties(); }
function EA_mode_() { var m = String(EA_props_().getProperty('EA_MODE') || 'off').trim(); return m === 'on' || m === 'record' ? m : 'off'; }
function EA_ss_() { return AC_masterSheet_().getParent(); }

function EA_sheet_(name, header) {
  var ss = EA_ss_(), sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function EA_appendRow_(sh, row) { sh.appendRow(row); }   // 既存プロジェクトと同時に書いても上書きしない

function EA_log_(op, id, code, uid, name, result, detail) {
  try { EA_appendRow_(EA_sheet_(EA_SHEET_LOG, EA_LOG_HEADER), [new Date(), op, id || '', code ? "'" + code : '', uid || '', name || '', result || '', detail || '']); }
  catch (e) { Logger.log('社員管理の操作ログを書けませんでした'); }
}

function EA_hmacHex_(secret, text) {
  return Utilities.computeHmacSha256Signature(text, secret, Utilities.Charset.UTF_8).map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

function EA_rand_() { return parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16); }

function EA_ms_(v) { return Object.prototype.toString.call(v) === '[object Date]' ? v.getTime() : (Date.parse(v) || 0); }

function EA_dateObj_(iso) { return Utilities.parseDate(iso, AC_TZ, 'yyyy-MM-dd'); }

/** 勤怠管理グループのグループID（社員管理AI用LINEから見たID。スクリプトプロパティ EA_ADMIN_GROUP_ID、複数ならカンマ区切り） */
function EA_adminGroups_() {
  return String(EA_props_().getProperty('EA_ADMIN_GROUP_ID') || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}

// ---- LINE（テスト時は EA_lineClient_ に模擬を入れる。本物はトークンが無ければ何もしない） ----
var EA_lineClient_ = null;
function EA_line_() { return EA_lineClient_ || EA_REAL_LINE_; }
var EA_REAL_LINE_ = {
  reply: function (replyToken, messages) {
    var t = EA_props_().getProperty('EA_LINE_CHANNEL_TOKEN');
    if (!t || !replyToken) return false;
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + t },
      payload: JSON.stringify({ replyToken: replyToken, messages: messages }), muteHttpExceptions: true,
    });
    return res.getResponseCode() === 200;
  },
  push: function (to, messages) {
    var t = EA_props_().getProperty('EA_LINE_CHANNEL_TOKEN');
    if (!t || !to) return false;
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + t, 'X-Line-Retry-Key': Utilities.getUuid() },
      payload: JSON.stringify({ to: to, messages: messages }), muteHttpExceptions: true,
    });
    return res.getResponseCode() === 200;
  },
  /** 送信者が今もグループのメンバーなら {displayName}、確認できなければ null（安全側） */
  memberProfile: function (groupId, userId) {
    var t = EA_props_().getProperty('EA_LINE_CHANNEL_TOKEN');
    if (!t || !groupId || !userId) return null;
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/group/' + encodeURIComponent(groupId) + '/member/' + encodeURIComponent(userId), {
      headers: { Authorization: 'Bearer ' + t }, muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) return null;
    try { return { displayName: String(JSON.parse(res.getContentText()).displayName || '') }; } catch (e) { return { displayName: '' }; }
  },
};

function EA_text_(text, quick) {
  var m = { type: 'text', text: String(text).slice(0, 4900) };
  if (quick && quick.length) {
    m.quickReply = { items: quick.map(function (q) { return { type: 'action', action: { type: 'message', label: q.label, text: q.text } }; }) };
  }
  return m;
}

function EA_reply_(ev, text, quick) {
  try { return EA_line_().reply(ev.replyToken, [EA_text_(text, quick)]); } catch (e) { Logger.log('社員管理の返信に失敗'); return false; }
}

/** 記録してから返信する（受信は署名確認済みのものだけなので、記録の前に本物かを確かめ終えている） */
function EA_respond_(ev, ctx, text, quick, commit) {
  if (commit) commit();
  EA_reply_(ev, text, quick);
  return true;
}

// ---- 入口：署名確認の受け口（Cloudflare Workers／VPS中継）からの転送（doPost の type 'line-verified'） ----
function EA_handleForward_(body) {
  var cache = CacheService.getScriptCache();
  var v = EA_verifyForward(body, EA_props_().getProperty('EA_FORWARD_SECRET'), Math.floor(Date.now() / 1000),
    function (n) { return !!cache.get('ea:nonce:' + n); }, EA_hmacHex_);
  if (!v.ok) { Logger.log('受け口からの転送を受け付けませんでした：%s', v.error); return 'NG'; }
  cache.put('ea:nonce:' + body.nonce, '1', 900);
  var payload;
  try { payload = JSON.parse(body.payload); } catch (e) { return 'NG'; }
  var events = EA_dedupeEvents(payload.events || [],
    function (id) { return !!cache.get('ea:ev:' + id); },
    function (id) { cache.put('ea:ev:' + id, '1', 21600); });
  events.forEach(function (ev) {
    try {
      if (!EA_handleEvent_(ev, { verified: true })) EA_onOtherEvent_(ev);
    } catch (err) {
      var msg = err && err.message ? err.message : '不明なエラー';
      Logger.log('社員管理の処理エラー：%s', msg);
      EA_log_('エラー', '', '', '', '', 'NG', msg);
    }
  });
  return 'OK';
}

/** 社員管理以外のイベント：グループへの参加・退出だけ記録する（グループIDの確認用）。それ以外は何もしない */
function EA_onOtherEvent_(ev) {
  var src = ev && ev.source;
  if (!src || src.type !== 'group') return;
  if (ev.type === 'join') {
    EA_log_('グループ参加', '', '', '', '', 'OK', 'グループID ' + src.groupId + (EA_adminGroups_().indexOf(src.groupId) !== -1 ? '（勤怠管理グループとして設定済み）' : '（未設定）'));   // 返信は既存の処理が行う
  } else if (ev.type === 'leave') {
    EA_log_('グループ退出', '', '', '', '', 'OK', 'グループID ' + src.groupId);
  }
}

/** グループのテキストで、社員管理の形式に当てはまるものか */
function EA_isCandidate_(ev) {
  var src = ev && ev.source;
  return !!(src && src.type === 'group' && ev.type === 'message' && ev.message && ev.message.type === 'text' && EA_parseMessage(ev.message.text));
}

/** 社員管理で扱ったら true（既存の処理には渡さない）。扱わないものは false。 */
function EA_handleEvent_(ev, ctx) {
  var mode = EA_mode_();
  if (mode === 'off' || !ctx || !ctx.verified) return false;
  if (!EA_isCandidate_(ev)) return false;
  var src = ev.source, parsed = EA_parseMessage(ev.message.text);
  var uid = src.userId || '';
  var groups = EA_adminGroups_();
  if (!groups.length) {   // 勤怠管理グループが未設定：最初の接続確認用に、グループID・送信者確認の結果だけ記録する（返信・申請はしない）
    var mem0 = uid ? EA_line_().memberProfile(src.groupId, uid) : null;
    EA_log_('未設定グループ', '', '', uid, mem0 ? mem0.displayName : '', '記録', 'グループID ' + src.groupId + '／署名確認済み／送信者：'
      + (!uid ? '不明（ID無し）' : mem0 ? 'メンバー確認OK' : 'メンバー確認できず') + '／イベント ' + (ev.webhookEventId || '-'));
    return true;
  }
  if (groups.indexOf(src.groupId) === -1) return false;   // 勤怠管理グループ以外では反応しない
  if (mode === 'record') {   // 記録のみ：返信・申請・承認・反映はしない。署名確認・送信者確認・重複防止の結果だけを残す
    var info = parsed.type === 'request' ? parsed.kind + '／形式エラー' + (parsed.errors || []).length + '件' : parsed.type + '／' + (parsed.kind || parsed.action);
    var member = uid ? EA_line_().memberProfile(src.groupId, uid) : null;
    EA_log_('記録のみ', parsed.id || '', parsed.fields && parsed.fields.code, uid, member ? member.displayName : '', '記録',
      info + '／署名確認済み／送信者：' + (!uid ? '不明（ID無し）' : member ? 'メンバー確認OK' : 'メンバー確認できず') + '／イベント ' + (ev.webhookEventId || '-'));
    return true;
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { EA_dispatch_(ev, parsed, uid, src.groupId, ctx); } finally { lock.releaseLock(); }
  return true;
}

function EA_dispatch_(ev, p, uid, gid, ctx) {
  if (p.type === 'template') {
    var t = p.text;
    if (p.kind === '取消') {
      var open = EA_loadRequests_().list.filter(function (r) { return r.state === '申請中' || r.state === '予約'; });
      t += '\n\n取消できる申請：' + (open.length ? '\n' + open.map(function (r) {
        return r.id + '（' + r.kind + '・' + r.fields.code + '・' + r.state + '）';
      }).join('\n') : 'ありません');
    }
    EA_respond_(ev, ctx, '下の形式で送ってください。\n\n' + t, null, null);
    return;
  }
  if (!uid) {   // パソコン版LINEなどでは送信者が分からない
    EA_respond_(ev, ctx, '【社員管理】送信した方を確認できないため受け付けできませんでした。スマートフォンのLINEから送ってください。', null,
      function () { EA_log_('拒否', p.id || '', p.fields && p.fields.code, '', '', 'NG', '送信者不明'); });
    return;
  }
  var member = EA_line_().memberProfile(gid, uid);
  if (!member) {
    EA_respond_(ev, ctx, '【社員管理】このグループのメンバーであることを確認できなかったため、受け付けできませんでした。', null,
      function () { EA_log_('拒否', p.id || '', p.fields && p.fields.code, uid, '', 'NG', 'グループメンバー確認不可'); });
    return;
  }
  var who = { uid: uid, name: member.displayName };
  if (p.type === 'decision') return EA_decide_(ev, p, who, ctx);
  if (p.kind === '取消') return EA_cancel_(ev, p, who, ctx);
  return EA_submit_(ev, p, who, ctx);
}

function EA_loadRequests_() {
  var sh = EA_sheet_(EA_SHEET_REQ, EA_REQ_HEADER), v = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < v.length; i++) {
    var r = v[i];
    if (!String(r[EA_R.id]).trim()) continue;
    var f = {};
    try { f = JSON.parse(r[EA_R.fields] || '{}'); } catch (e) { f = {}; }
    var ac = String(r[EA_R.approvalCode] == null ? '' : r[EA_R.approvalCode]).trim();
    out.push({ row: i + 1, id: String(r[EA_R.id]).trim(), state: String(r[EA_R.state]).trim(), kind: String(r[EA_R.kind]).trim(),
      fields: f, createdAtMs: EA_ms_(r[EA_R.at]), approvalCode: ac ? ('000000' + ac).slice(-6) : '' });
  }
  return { sheet: sh, list: out };
}

function EA_setReq_(sh, row, ch) {
  var now = new Date();
  if (ch.state) sh.getRange(row, EA_R.state + 1).setValue(ch.state);
  if (ch.actor) sh.getRange(row, EA_R.actId + 1, 1, 3).setValues([[ch.actor.uid, ch.actor.name, now]]);
  if (ch.applied) sh.getRange(row, EA_R.appliedAt + 1).setValue(now);
  if (ch.note != null) sh.getRange(row, EA_R.note + 1).setValue(ch.note);
  sh.getRange(row, EA_R.updatedAt + 1).setValue(now);
}

function EA_pendingOf_(list, exceptId) {
  return list.filter(function (r) { return r.id !== exceptId && (r.state === '申請中' || r.state === '予約'); });
}

function EA_masterValues_() {
  var ms = AC_masterSheet_();
  var last = Math.max(ms.getLastRow(), 1);
  return ms.getRange(1, 1, last, Math.max(ms.getLastColumn(), EA_MASTER_WIDTH)).getValues();
}

function EA_submit_(ev, p, who, ctx) {
  var today = AC_today_();
  var mv = EA_masterValues_(), R = EA_loadRequests_();
  var v = EA_validate(p, mv, today, EA_pendingOf_(R.list, ''));
  if (!v.ok) {
    EA_respond_(ev, ctx, '【社員管理】' + p.kind + 'の申請を受け付けできませんでした。\n・' + v.errors.join('\n・') + '\n\n直して、もう一度送ってください。', null,
      function () { EA_log_('申請エラー', '', p.fields.code, who.uid, who.name, 'NG', v.errors.join('／')); });
    return;
  }
  var id = EA_newRequestId(today, R.list.map(function (r) { return r.id; }));
  var code = EA_approvalCode(EA_rand_());
  var i = EA_findByCode_(mv, p.fields.code), masterName = i > 0 ? String(mv[i][EA_COL.name]) : '';
  var eff = EA_effectiveDate(p);
  var msg = '【社員管理】' + p.kind + 'の申請を受け付けました（' + id + '）\n' + EA_describe(p.kind, p.fields, masterName)
    + '\n従業員マスタへの反映：' + eff + (p.kind === '退社' ? '（退職日の翌日）' : '')
    + (v.warnings.length ? '\n\n⚠ 確認してください\n・' + v.warnings.join('\n・') : '')
    + '\n\n内容が正しければ、このグループのどなたかが下の「承認」を押してください（' + EA_APPROVAL_HOURS + '時間以内）。'
    + '\n（ボタンが出ないときは「承認 ' + id + ' ' + code + '」と送ってください）';
  EA_respond_(ev, ctx, msg, [{ label: '承認', text: '承認 ' + id + ' ' + code }, { label: '却下', text: '却下 ' + id }], function () {
    EA_appendRow_(R.sheet, [id, '申請中', p.kind, "'" + p.fields.code, p.kind === '入社' ? p.fields.name : masterName, "'" + eff,
      JSON.stringify(p.fields), who.uid, who.name, new Date(), "'" + code, '', '', '', '', v.warnings.join('／'), new Date()]);
    EA_log_('申請', id, p.fields.code, who.uid, who.name, 'OK', v.warnings.length ? '警告' + v.warnings.length + '件' : '');
  });
}

function EA_decide_(ev, p, who, ctx) {
  var R = EA_loadRequests_(), now = new Date();
  var req = R.list.filter(function (r) { return r.id === p.id; })[0];
  var j = EA_judgeDecision(req, p, { verified: !!ctx.verified, isGroupMember: true, nowMs: now.getTime() });
  var act = p.action === 'approve' ? '承認' : '却下';
  if (!j.ok) {
    EA_respond_(ev, ctx, '【社員管理】' + p.id + '：' + j.error, null, function () {
      if (j.expire) EA_setReq_(R.sheet, req.row, { state: '期限切れ', note: '承認期限切れ' });
      EA_log_(act, p.id, req && req.fields.code, who.uid, who.name, 'NG', j.error);
    });
    return;
  }
  if (p.action === 'reject') {
    EA_respond_(ev, ctx, '【社員管理】' + p.id + '（' + req.kind + '・' + req.fields.code + '）を却下しました。従業員マスタは変わりません。', null, function () {
      EA_setReq_(R.sheet, req.row, { state: '却下', actor: who });
      EA_log_('却下', p.id, req.fields.code, who.uid, who.name, 'OK', '');
    });
    return;
  }
  // 承認：申請後にマスタが変わっていないか、申請日を基準に確かめ直す
  var mv = EA_masterValues_();
  var submitted = Utilities.formatDate(new Date(req.createdAtMs), AC_TZ, 'yyyy-MM-dd');
  var v = EA_validate({ kind: req.kind, fields: req.fields, errors: [] }, mv, submitted, []);
  if (!v.ok) {
    EA_respond_(ev, ctx, '【社員管理】' + p.id + 'は承認できませんでした（申請後に従業員マスタが変わっています）。\n・' + v.errors.join('\n・')
      + '\n\n必要なら「取消」してから申請し直してください。', null,
      function () { EA_log_('承認', p.id, req.fields.code, who.uid, who.name, 'NG', v.errors.join('／')); });
    return;
  }
  var pause = EA_planPauseRow({ kind: req.kind, fields: req.fields }, mv, req.id);
  var eff = EA_effectiveDate(req), today = AC_today_();
  var applyNow = eff <= today && EA_props_().getProperty('EA_AUTO_APPLY') === 'true';   // 反映日が今日以前なら、承認と同時に反映
  EA_respond_(ev, ctx, '【社員管理】' + p.id + '（' + req.kind + '・' + req.fields.code + '）を承認しました。\n'
    + (applyNow ? '反映日（' + eff + '）になっているため、このあとすぐ従業員マスタに反映します（結果はこのグループにお知らせします）。'
      : eff <= today ? '次の反映処理（毎朝5時台）で従業員マスタに反映します。' : eff + ' の朝（5時台）に従業員マスタへ反映します。')
    + (pause ? '\n' + pause[2].date + '〜' + pause[3].date + ' はお知らせを止めます。' : '')
    + (req.kind === '退社' ? '\nToT（Touch On Time）の退職登録もお願いします。' : '')
    + '\n反映前なら「【取消】申請番号：' + p.id + '」で取り消せます。', null, function () {
    if (pause) EA_writePause_(pause);
    EA_setReq_(R.sheet, req.row, { state: '予約', actor: who });
    EA_log_('承認', p.id, req.fields.code, who.uid, who.name, 'OK', pause ? 'お知らせ停止を追加' : '');
    if (applyNow) {
      var res = EA_applyOne_(req, R.sheet);
      var text = res.ok ? '【社員管理】✅ ' + req.id + '（' + req.kind + '・' + req.fields.code + '）を従業員マスタに反映しました'
        : '【社員管理】⚠ ' + req.id + '（' + req.kind + '・' + req.fields.code + '）は反映できませんでした：' + res.error;
      EA_adminGroups_().forEach(function (g) { try { EA_line_().push(g, [EA_text_(text)]); } catch (e) { Logger.log('社員管理の報告に失敗'); } });
    }
  });
}

function EA_cancel_(ev, p, who, ctx) {
  var R = EA_loadRequests_();
  var req = R.list.filter(function (r) { return r.id === p.fields.id; })[0];
  if (!req) { EA_respond_(ev, ctx, '【社員管理】' + p.fields.id + 'の申請は見つかりません。', null, null); return; }
  var t = EA_transition(req.state, 'cancel');
  if (!t.ok) {
    EA_respond_(ev, ctx, '【社員管理】' + req.id + '：' + t.error, null,
      function () { EA_log_('取消', req.id, req.fields.code, who.uid, who.name, 'NG', t.error); });
    return;
  }
  var hasPause = EA_pauseCount_(req.id) > 0;
  EA_respond_(ev, ctx, '【社員管理】' + req.id + '（' + req.kind + '・' + req.fields.code + '）を取り消しました。従業員マスタは変わりません。'
    + (hasPause ? '\nこの申請で止めていたお知らせも元に戻しました。' : ''), null, function () {
    var removed = EA_removePause_(req.id);
    EA_setReq_(R.sheet, req.row, { state: '取消', actor: who });
    EA_log_('取消', req.id, req.fields.code, who.uid, who.name, 'OK', removed ? 'お知らせ停止' + removed + '行を削除' : '');
  });
}

function EA_pauseCount_(requestId) {
  var sh = EA_ss_().getSheetByName(AC_PAUSE_SHEET);
  return sh ? EA_pauseRowsToRemove(sh.getDataRange().getValues(), requestId).length : 0;
}

// ---- お知らせ停止シート（G列 作成元・H列 管理ID） ----
function EA_pauseSheet_() {
  AC_pauseRows_();   // 無ければ既存と同じ形で作る
  var sh = EA_ss_().getSheetByName(AC_PAUSE_SHEET);
  var head = sh.getRange(1, 7, 1, 2).getValues()[0];
  if (String(head[0]) === EA_PAUSE_EXTRA_HEADER[0] && String(head[1]) === EA_PAUSE_EXTRA_HEADER[1]) return sh;
  if (String(head[0]).trim() || String(head[1]).trim()) throw new Error('お知らせ停止シートのG・H列が別の用途で使われています');
  sh.getRange(1, 7, 1, 2).setValues([EA_PAUSE_EXTRA_HEADER]).setFontWeight('bold');
  return sh;
}

function EA_writePause_(row) {
  var sh = EA_pauseSheet_();
  var vals = row.map(function (x) { return x && x.date ? EA_dateObj_(x.date) : x; });
  vals[0] = "'" + vals[0];
  EA_appendRow_(sh, vals);
}

function EA_removePause_(requestId) {
  var sh = EA_ss_().getSheetByName(AC_PAUSE_SHEET);
  if (!sh) return 0;
  var rows = EA_pauseRowsToRemove(sh.getDataRange().getValues(), requestId);
  rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
  return rows.length;
}

// ---- 導入時に1回だけ実行（本番は承認後） ----
/**
 * 社員管理AIのシートを用意する：社員管理_申請／社員管理_変更履歴／社員管理_操作ログ／別表記 を作成し、
 * 従業員マスタ O1 に「入社日」、お知らせ停止 G1・H1 に「作成元」「管理ID」の見出しを入れる（既存のデータ・列には触れない。
 * O列・G/H列が別の用途で使われていれば中止）。何度実行しても同じ結果。
 */
function employeeAdminSetup() {
  var ms = AC_masterSheet_();
  EA_ensureHiredHeader_(ms);
  EA_pauseSheet_();
  [[EA_SHEET_REQ, EA_REQ_HEADER], [EA_SHEET_HIST, EA_HIST_HEADER], [EA_SHEET_LOG, EA_LOG_HEADER], [EA_SHEET_ALIAS, EA_ALIAS_HEADER]]
    .forEach(function (x) { EA_sheet_(x[0], x[1]); });
  Logger.log('社員管理AIの準備：完了（版 %s）。EA_MODE=%s／EA_AUTO_APPLY=%s', EA_VERSION,
    EA_props_().getProperty('EA_MODE') || '未設定', EA_props_().getProperty('EA_AUTO_APPLY') || '未設定');
}

/** 毎朝の処理のトリガー（5時台）を作る。本番では自動反映の承認後に実行 */
function employeeAdminSetupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'employeeAdminDaily') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('employeeAdminDaily').timeBased().atHour(5).everyDays(1).inTimezone(AC_TZ).create();
  Logger.log('社員管理AIの毎朝のトリガーを作成しました（5時台）');
}

/** 緊急停止：社員管理AIのすべての動きを止める（既存の勤怠・アルコールチェックには影響なし） */
function employeeAdminStop() {
  ['EA_MODE', 'EA_AUTO_APPLY'].forEach(function (k) { EA_props_().deleteProperty(k); });
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'employeeAdminDaily') ScriptApp.deleteTrigger(t); });
  Logger.log('社員管理AIを停止しました（設定とトリガーを削除。シートの記録は残しています）');
}

// ---- 毎朝の処理（期限切れ・反映・完了報告） ----

/** 毎朝5時台のトリガー用（トリガーの作成は本番承認後）。EA_MODE=on のときだけ動き、反映は EA_AUTO_APPLY=true のときだけ */
function employeeAdminDaily() {
  if (EA_mode_() !== 'on') return;
  EA_runDaily_(EA_props_().getProperty('EA_AUTO_APPLY') === 'true');
}

function EA_runDaily_(apply) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var lines = [];
  try {
    var today = AC_today_(), nowMs = Date.now(), R = EA_loadRequests_();
    R.list.forEach(function (r) {
      if (r.state === '申請中' && EA_isExpired(r.createdAtMs, nowMs)) {
        EA_setReq_(R.sheet, r.row, { state: '期限切れ', note: '承認期限切れ' });
        EA_log_('期限切れ', r.id, r.fields.code, '', '', 'OK', '');
        lines.push('⌛ ' + r.id + '（' + r.kind + '・' + r.fields.code + '）は承認されないまま期限切れになりました');
      }
    });
    if (apply) {
      EA_dueRequests(R.list, today).forEach(function (r) {
        var res = EA_applyOne_(r, R.sheet);
        lines.push(res.ok ? '✅ ' + r.id + '（' + r.kind + '・' + r.fields.code + '）を従業員マスタに反映しました'
          : '⚠ ' + r.id + '（' + r.kind + '・' + r.fields.code + '）は反映できませんでした：' + res.error);
      });
    }
  } finally { lock.releaseLock(); }
  if (lines.length) {
    var text = '【社員管理】' + AC_today_() + ' の処理結果\n' + lines.join('\n');
    EA_adminGroups_().forEach(function (g) { try { EA_line_().push(g, [EA_text_(text)]); } catch (e) { Logger.log('社員管理の報告に失敗'); } });
  }
  return lines;
}

function EA_ensureHiredHeader_(ms) {
  var h = ms.getRange(1, EA_COL.hiredOn + 1).getValue();
  if (String(h) === EA_MASTER_COL_NAMES[EA_COL.hiredOn]) return;
  if (String(h).trim()) throw new Error('従業員マスタのO列が別の用途で使われています');
  ms.getRange(1, EA_COL.hiredOn + 1).setValue(EA_MASTER_COL_NAMES[EA_COL.hiredOn]).setFontWeight('bold');
}

function EA_hist_(id, kind, code, sheet, row, col, before, after) {
  EA_appendRow_(EA_sheet_(EA_SHEET_HIST, EA_HIST_HEADER), [new Date(), id, kind, "'" + code, sheet, row,
    EA_MASTER_COL_NAMES[col - 1] || String(col), before === '' || before == null ? '' : "'" + String(before), after === '' || after == null ? '' : "'" + String(after)]);
}

/** その社員番号の最後の行（1始まり）。無ければ -1 */
function EA_lastRowOfCode_(ms, code) {
  var v = ms.getRange(1, 1, Math.max(ms.getLastRow(), 1), 1).getValues();
  for (var i = v.length - 1; i >= 1; i--) if (EA_cellCode(v[i][0]) === code) return i + 1;
  return -1;
}

function EA_applyOne_(req, reqSheet) {
  try {
    var ms = AC_masterSheet_();
    EA_ensureHiredHeader_(ms);
    var mv = EA_masterValues_();
    var plan = EA_planMasterChange({ kind: req.kind, fields: req.fields }, mv);
    if (!plan.ok) throw new Error(plan.error);
    var sheetName = ms.getName();
    (plan.updates || []).forEach(function (u) {
      var before = mv[u.row - 1][u.col - 1];
      ms.getRange(u.row, u.col).setValue(u.text && u.value !== '' ? "'" + String(u.value) : u.value);   // ' つき＝文字として書く
      EA_hist_(req.id, req.kind, req.fields.code, sheetName, u.row, u.col, before, u.value);
    });
    if (plan.append) {
      ms.appendRow(plan.append.map(function (v, k) { return plan.textCols.indexOf(k + 1) !== -1 && v !== '' ? "'" + v : v; }));
      var r = EA_lastRowOfCode_(ms, req.fields.code);
      if (r > 0) AC_checkboxes_(ms, r, 1);
      EA_hist_(req.id, req.kind, req.fields.code, sheetName, r, 1, '', '（行を追加）');
    }
    if (req.kind === '入社' && req.fields.alias) {
      EA_appendRow_(EA_sheet_(EA_SHEET_ALIAS, EA_ALIAS_HEADER), ["'" + req.fields.code, req.fields.alias, new Date(), EA_PAUSE_SOURCE, req.id]);
    }
    EA_setReq_(reqSheet, req.row, { state: '反映済', applied: true });
    EA_log_('反映', req.id, req.fields.code, '', '', 'OK', '');
    return { ok: true };
  } catch (e) {
    var msg = e && e.message ? e.message : '不明なエラー';
    EA_setReq_(reqSheet, req.row, { state: 'エラー', note: msg });
    EA_log_('反映', req.id, req.fields.code, '', '', 'NG', msg);
    return { ok: false, error: msg };
  }
}

if (typeof module !== 'undefined') {
  module.exports = { EA_parseMessage: EA_parseMessage, EA_validate: EA_validate, EA_isoDate: EA_isoDate, EA_addDays: EA_addDays,
    EA_newRequestId: EA_newRequestId, EA_approvalCode: EA_approvalCode, EA_isExpired: EA_isExpired,
    EA_transition: EA_transition, EA_judgeDecision: EA_judgeDecision, EA_effectiveDate: EA_effectiveDate,
    EA_dueRequests: EA_dueRequests, EA_planMasterChange: EA_planMasterChange, EA_planPauseRow: EA_planPauseRow,
    EA_pauseRowsToRemove: EA_pauseRowsToRemove, EA_verifyForward: EA_verifyForward, EA_dedupeEvents: EA_dedupeEvents,
    EA_describe: EA_describe, EA_TEMPLATES: EA_TEMPLATES, EA_COL: EA_COL, EA_VERSION: EA_VERSION };
}
