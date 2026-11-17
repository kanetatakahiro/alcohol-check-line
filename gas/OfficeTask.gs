/**
 * 事務の業務一覧LINE（AI上司）（gas/OfficeTask.gs・版 2026-11-17b）
 *
 * 毎朝8時台、事務業務のグループ（「部門登録 事務業務」で登録したグループ）に、事務員さんの「今日のお仕事」をボタン付きで送る。
 * - 仕事の中身は「【事務業務】業務一覧・マニュアル」の「業務マニュアル」タブ（任せる＝○、AI化の状況が「AI化済み」でない行）と「臨時の依頼」タブ
 * - その日の勤務時間は朝7:05の TOT データ（tot-latest.json の schedules）から読む
 * - 勤務時間の8割を目安に、期限の近い順に並べる。入りきらない仕事は［手が空きました］で1件ずつ渡す
 * - 事務員さんがお休みの日は、期限が今日まで（過ぎている）のお仕事だけを送る（無ければ送らない）
 * - ボタン：［完了］［対応します］［わからない］［今日はできない］［手が空きました］。グループのメンバーなら誰でも押せて、押した人（従業員マスタの姓）を担当・完了者として記録する
 *   ［完了］のあとに［取り消す］（完了にした人と管理者だけ）
 * - グループで「残りの業務」「未完了の業務を教えて」などと送ると、まだ終わっていないお仕事（担当つき）を返信する
 * - 終業30分前に、残っている仕事と報告のお願いを送る。月曜の朝は先週のまとめも送る
 *
 * スクリプトプロパティ：
 *   OFFICE_TASK_MODE      未設定・off＝何もしない／record＝送らずに「送る予定の内容」タブへ記録／on＝送信
 *   OFFICE_TASK_BOOK_ID   業務一覧・マニュアルのスプレッドシートID
 *   OFFICE_TASK_STAFF     事務員さんの社員番号（従業員マスタの TOT従業員コードで勤務時間を読む）
 *   OFFICE_TASK_GROUP     送り先のグループの部門名（未設定＝「事務業務」）
 * 受け口（ボタン・グループの文）はコード.gs の AC_handleGroupEvent_ から呼ぶ（Webアプリの再公開が必要）。
 * 毎朝・30分ごとの処理は OT_setupTriggers で作るトリガー（OT_morning・OT_tick）で動く。
 */
var OT_VERSION = '2026-11-17b';
var OT_GROUP_DEPT = '事務業務';   // 「部門登録 事務業務」で登録したグループへ送る
var OT_AI_HEADER = 'AI化の状況';    // 人の手／一部AI／AI化済み（AI化済みは指示しない）
var OT_MANUAL_SHEET = '業務マニュアル';
var OT_REQUEST_SHEET = '臨時の依頼';
var OT_LOG_SHEET = '今日の仕事の記録';
var OT_PLAN_SHEET = '送る予定の内容';
var OT_REQUEST_HEADER = ['依頼日', '業務ID（業務マニュアル）', '業務名（自由に書いてよい）', '期限', 'メモ（AIが本人に伝えること）', '状態'];
var OT_LOG_HEADER = ['日時', '日付', '期間', '業務ID', '業務名', '操作', '押した人', 'メモ', 'LINEユーザーID'];
var OT_PLAN_HEADER = ['日時', '日付', '勤務時間', '件数', '合計（分）', '内容'];
var OT_RULE_HEADER = 'AI用の予定ルール';
var OT_DEFAULT_RULES = { M01: 'daily', M02: 'daily', M03: 'weekly:5', M04: 'monthly:1~3', M05: 'monthly:-2~3', M06: 'monthly:10~15',
  M07: 'monthly:13~20', M08: 'monthly:-2~5', M09: 'monthly:23~25', M10: 'daily', M11: 'monthly:1~5', M12: 'request', M13: 'request',
  M14: 'request', M15: 'request', M16: 'request', M17: 'request', M18: 'yearly:11/1~12/20', M19: 'request', M20: 'request',
  M21: 'reserve', M22: 'spare' };
var OT_FILL_RATE = 0.8;            // 勤務時間のうち、仕事を入れる割合（残りは電話・来客などの予備）
var OT_DEFAULT_MINUTES = 360;      // 勤務時間が読めなかったときの目安
var OT_EARLY_DAYS = 7;             // 期間の始まる何日前から前倒しの候補にするか
var OT_OVERDUE_DAYS = 7;           // 期限を過ぎて何日まで残りとして出すか
var OT_MAX_BUBBLES = 11;           // カルーセルは12枚まで（1枚目はまとめ）
var OT_ACTIONS = { done: '完了', claim: '対応します', ask: 'わからない', skip: '今日はできない', free: '手が空きました', undo: '取り消し' };

// ======================================================================
// 純粋関数（テストで確かめる）
// ======================================================================

function OT_ymd(d) { return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
function OT_date(s) { var p = String(s).split('-'); return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))); }
function OT_addDays(s, n) { var d = OT_date(s); d.setUTCDate(d.getUTCDate() + n); return OT_ymd(d); }
function OT_diff(a, b) { return Math.round((OT_date(b) - OT_date(a)) / 86400000); }   // b − a（日）
function OT_lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }       // m は 1〜12
function OT_md(s) { var w = '日月火水木金土'.charAt(OT_date(s).getUTCDay()); return Number(s.slice(5, 7)) + '/' + Number(s.slice(8, 10)) + '（' + w + '）'; }

/** 純粋関数：予定ルールの解釈。daily／weekly:曜日(0=日〜6=土)／monthly:開始~終了（負は前月末からの日数、例 -2＝月末の2日前）／yearly:月/日~月/日／request／reserve／spare */
function OT_parseRule(rule) {
  var r = String(rule || '').trim(), m;
  if (r === 'daily' || r === 'request' || r === 'reserve' || r === 'spare') return { type: r };
  if ((m = /^weekly:([0-6])$/.exec(r))) return { type: 'weekly', dow: Number(m[1]) };
  if ((m = /^monthly:(-?\d+)~(\d+)$/.exec(r))) return { type: 'monthly', from: Number(m[1]), to: Number(m[2]) };
  if ((m = /^yearly:(\d+)\/(\d+)~(\d+)\/(\d+)$/.exec(r))) return { type: 'yearly', fm: Number(m[1]), fd: Number(m[2]), tm: Number(m[3]), td: Number(m[4]) };
  return null;
}

/** 純粋関数：today に関係する期間 [{ key, start, end }]（今の期間と、すぐ前・すぐ後の期間） */
function OT_periods(rule, today) {
  var y = Number(today.slice(0, 4)), mo = Number(today.slice(5, 7)), out = [];
  var fmt = function (yy, mm, dd) { return yy + '-' + ('0' + mm).slice(-2) + '-' + ('0' + dd).slice(-2); };
  if (rule.type === 'daily') return [{ key: 'D' + today, start: today, end: today }];   // 期間の名前は文字（シートで日付に変わらないように）
  if (rule.type === 'weekly') {
    var dow = OT_date(today).getUTCDay(), monday = OT_addDays(today, -((dow + 6) % 7));
    [-7, 0, 7].forEach(function (off) {
      var mon = OT_addDays(monday, off), d = OT_addDays(mon, (rule.dow + 6) % 7);
      out.push({ key: 'W' + mon, start: d, end: d });
    });
    return out;
  }
  if (rule.type === 'monthly') {
    [-1, 0, 1].forEach(function (off) {
      var yy = y, mm = mo + off;
      if (mm < 1) { mm += 12; yy--; } if (mm > 12) { mm -= 12; yy++; }
      // 期間は「mm 月の from 日〜to 日」。from が負なら前月末から（例：-2 → 前月の末日の2日前）
      var start;
      if (rule.from <= 0) { var py = mm === 1 ? yy - 1 : yy, pm = mm === 1 ? 12 : mm - 1; start = fmt(py, pm, OT_lastDay(py, pm) + rule.from); }
      else start = fmt(yy, mm, Math.min(rule.from, OT_lastDay(yy, mm)));
      out.push({ key: 'M' + fmt(yy, mm, 1).slice(0, 7), start: start, end: fmt(yy, mm, Math.min(rule.to, OT_lastDay(yy, mm))) });
    });
    return out;
  }
  if (rule.type === 'yearly') {
    [y - 1, y, y + 1].forEach(function (yy) {
      var ey = rule.tm < rule.fm ? yy + 1 : yy;
      out.push({ key: 'Y' + yy, start: fmt(yy, rule.fm, rule.fd), end: fmt(ey, rule.tm, rule.td) });
    });
    return out;
  }
  return out;
}

/**
 * 純粋関数：今日の予定を作る。
 * tasks：[{ id, name, minutes, early（前倒しできる）, rule, ... }]（任せる＝○ の行だけ）
 * done：{ '業務ID|期間': true }（完了の記録）／requests：[{ row, id, name, due, memo }]（臨時の依頼・未完了）
 * minutes：今日の勤務時間（分）
 * 戻り値：{ today:[item], extra:[item], reserve, budget, total }。item は task に { period, deadline, overdue, early, req } を足したもの
 */
function OT_plan(tasks, today, minutes, done, requests) {
  done = done || {};
  var due = [], early = [], reserve = 0, byId = {};
  (tasks || []).forEach(function (t) { byId[t.id] = t; });
  (tasks || []).forEach(function (t) {
    var rule = OT_parseRule(t.rule);
    if (!rule) return;
    if (rule.type === 'reserve') { reserve += Number(t.minutes) || 0; return; }
    if (rule.type === 'request' || rule.type === 'spare') return;
    OT_periods(rule, today).forEach(function (p) {
      if (done[t.id + '|' + p.key]) return;
      var item = Object.assign({}, t, { period: p.key, deadline: p.end, start: p.start });
      if (p.start <= today && today <= p.end) due.push(item);
      else if (p.end < today && OT_diff(p.end, today) <= OT_OVERDUE_DAYS && rule.type !== 'daily') due.push(Object.assign(item, { overdue: true }));
      else if (p.start > today && OT_diff(today, p.start) <= OT_EARLY_DAYS && t.early) early.push(Object.assign(item, { early: true }));
    });
  });
  (requests || []).forEach(function (q) {
    var base = byId[q.id] || { id: q.id || ('R' + q.row), name: q.name || '臨時の依頼', minutes: 30, early: false };
    var key = 'R' + q.row;
    if (done[base.id + '|' + key]) return;
    var item = Object.assign({}, base, { name: q.name || base.name, period: key, deadline: q.due || today, req: true, memo: q.memo || '' });
    if (q.due && q.due < today) item.overdue = true;
    due.push(item);
  });
  var order = function (a, b) {
    if (a.id === 'M01' || b.id === 'M01') return a.id === 'M01' ? -1 : 1;     // 朝の確認はいつも最初
    if (!!a.overdue !== !!b.overdue) return a.overdue ? -1 : 1;
    if (a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
  };
  due.sort(order); early.sort(order);
  var budget = Math.max(0, Math.round((Number(minutes) || OT_DEFAULT_MINUTES) * OT_FILL_RATE) - reserve), used = 0, out = [], rest = [];
  // 期限が今日・過ぎている・臨時の依頼は、時間を超えても必ず入れる
  due.forEach(function (it) {
    var m = Number(it.minutes) || 0;
    if (used + m <= budget || it.deadline <= today || it.overdue || it.req) { out.push(it); used += m; } else rest.push(it);
  });
  return { today: out, extra: rest.concat(early), reserve: reserve, budget: budget, total: used };
}

/** 純粋関数：TOT の予定（clockInSchedule・clockOutSchedule）から勤務時間（分）と「8:00〜14:00」の表示。休み・予定なしは null */
function OT_shift(s) {
  var hm = function (iso) { var m = /T(\d{2}):(\d{2})/.exec(String(iso || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  if (!s || !s.clockInSchedule || !s.clockOutSchedule) return null;
  var a = hm(s.clockInSchedule), b = hm(s.clockOutSchedule);
  if (a == null || b == null) return null;
  if (b <= a) b += 24 * 60;
  var span = b - a, rest = span > 480 ? 60 : span > 360 ? 45 : 0;   // 休憩（6時間を超えると45分・8時間を超えると60分）
  var t = function (x) { x = x % (24 * 60); return Math.floor(x / 60) + ':' + ('0' + (x % 60)).slice(-2); };
  return { minutes: span - rest, start: a, end: b, label: t(a) + '〜' + t(b) };
}

/** 純粋関数：手順の文字（改行区切り）を行の配列に */
function OT_lines(text) { return String(text || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(String); }

/** 純粋関数：1件の仕事の吹き出し（ボタン付き） */
function OT_bubble(it, no, date, token, owner) {
  var data = function (a) { return ['ot', '1', a, date, it.id, it.period, token].join('|'); };
  var btn = function (label, a, style) { return { type: 'button', style: style, height: 'sm', action: { type: 'postback', label: label, data: data(a), displayText: label + '：' + it.name } }; };
  var deadline = it.req ? (it.deadline ? '期限 ' + OT_md(it.deadline) : '') : (it.overdue ? '期限 ' + OT_md(it.deadline) + '（過ぎています）'
    : it.deadline === date ? '期限 今日' : '期限 ' + OT_md(it.deadline));
  var body = [{ type: 'text', text: (no ? no + '. ' : '') + it.name, weight: 'bold', wrap: true },
    { type: 'text', text: [deadline, it.minutes ? '目安' + it.minutes + '分' : '', it.early ? '前倒し' : ''].filter(String).join('・'), size: 'xs', color: it.overdue ? '#cc0000' : '#888888', wrap: true }];
  if (owner) body.push({ type: 'text', text: '担当：' + owner + 'さん', size: 'xs', color: '#1a73e8', wrap: true });
  if (it.memo) body.push({ type: 'text', text: '📝 ' + it.memo, size: 'sm', wrap: true });
  body.push({ type: 'separator' });
  OT_lines(it.steps).forEach(function (l) { body.push({ type: 'text', text: l, size: 'sm', wrap: true }); });
  if (it.items) body.push({ type: 'text', text: '持ち物・使うもの：' + it.items, size: 'xs', wrap: true, color: '#555555' });
  if (it.tips) body.push({ type: 'text', text: '💡 ' + it.tips, size: 'xs', wrap: true, color: '#555555' });
  if (it.help) body.push({ type: 'text', text: '困ったら：' + it.help, size: 'xs', wrap: true, color: '#555555' });
  if (it.report) body.push({ type: 'text', text: '終わったら：' + it.report, size: 'xs', wrap: true, color: '#555555' });
  return { type: 'bubble', size: 'mega',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [btn('完了', 'done', 'primary'), btn('対応します', 'claim', 'secondary'),
      btn('わからない', 'ask', 'secondary'), btn('今日はできない', 'skip', 'secondary')] } };
}

/** 純粋関数：朝のメッセージ（まとめ＋1件ずつの吹き出し）。opts.offDay＝担当の方がお休みの日（期限が近いものだけ） */
function OT_morningMessages(plan, opts) {
  var date = opts.date, name = opts.name || '担当の方', token = opts.token, owners = opts.owners || {};
  var freeBtn = { type: 'button', style: 'primary', color: '#e69138', height: 'sm',
    action: { type: 'postback', label: '手が空きました', data: ['ot', '1', 'free', date, '-', '-', token].join('|'), displayText: '手が空きました' } };
  var head = opts.offDay
    ? ['今日は' + name + 'さんがお休みです。', '期限が今日まで（または過ぎている）のお仕事だけお送りします。対応できる方は［対応します］を押してから進めてください。']
    : ['おはようございます☀️ ' + name + 'さんの今日のお仕事です。',
      '勤務：' + (opts.shiftLabel || '（勤務時間を確認できなかったため' + Math.round(OT_DEFAULT_MINUTES / 60) + '時間で組みました）'),
      '件数：' + plan.today.length + '件（目安 合計' + plan.total + '分）',
      plan.reserve ? '電話・来客などのために' + plan.reserve + '分あけています。' : '',
      '上から順に進めて、終わったら［完了］を押してください。ほかの方が代わりに進めるときは、先に［対応します］を押してください（担当が分かるようになります）。',
      '分からないときは［わからない］、今日できないときは［今日はできない］。',
      plan.extra.length ? '早く終わったら［手が空きました］を押すと、次のお仕事をお送りします（あと' + plan.extra.length + '件あります）。' : '早く終わったら［手が空きました］を押してください。',
      '「残りの業務」と送ると、まだ終わっていないお仕事をお知らせします。'];
  var list = plan.today.map(function (it, i) { return (i + 1) + '. ' + it.name + (it.overdue ? '（期限を過ぎています）' : it.deadline === date && !it.req ? '（今日まで）' : ''); });
  if (plan.today.length > OT_MAX_BUBBLES) list.push('（' + (OT_MAX_BUBBLES + 1) + '件目からは「残りの業務」と送ると表示されます）');
  var summary = { type: 'bubble', size: 'mega',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [{ type: 'text', text: '【今日のお仕事】' + OT_md(date), weight: 'bold', wrap: true }]
      .concat(head.filter(String).map(function (l) { return { type: 'text', text: l, size: 'sm', wrap: true }; }))
      .concat([{ type: 'separator' }]).concat(list.map(function (l) { return { type: 'text', text: l, size: 'sm', wrap: true }; })) },
    footer: { type: 'box', layout: 'vertical', contents: [freeBtn] } };
  var bubbles = [summary].concat(plan.today.slice(0, OT_MAX_BUBBLES).map(function (it, i) { return OT_bubble(it, i + 1, date, token, owners[it.id + '|' + it.period]); }));
  var alt = ('【今日のお仕事】' + (opts.offDay ? '（' + name + 'さんお休み）' : name + 'さん ') + plan.today.length + '件：' + plan.today.map(function (it) { return it.name; }).join('、')).slice(0, 400);
  return [{ type: 'flex', altText: alt, contents: { type: 'carousel', contents: bubbles } }];
}

/** 純粋関数：postback の読み取り */
function OT_parsePostback(data) {
  var p = String(data || '').split('|');
  if (p.length !== 7 || p[0] !== 'ot' || p[1] !== '1' || !OT_ACTIONS[p[2]]) return null;
  return { action: p[2], date: p[3], id: p[4], period: p[5], token: p[6] };
}

/**
 * 純粋関数：記録の行（上から順）→ { done：{key: true}, doneBy：{key: {name, uid}}, owner：{key: 担当の名前}, byDay：{date: {key: 最後の操作}} }
 * key は「業務ID|期間」。［取り消し］で完了を外す。担当は［対応します］か［完了］を押した人
 */
function OT_doneFromLog(rows) {
  var done = {}, doneBy = {}, owner = {}, byDay = {};
  (rows || []).forEach(function (r, i) {
    if (i === 0) return;
    var date = OT_cell(r[1]), key = OT_cell(r[3]) + '|' + OT_cell(r[2]), op = OT_cell(r[5]), who = OT_cell(r[6]), uid = OT_cell(r[8]);
    if (op === OT_ACTIONS.done) { done[key] = true; doneBy[key] = { name: who, uid: uid }; owner[key] = who; }
    if (op === OT_ACTIONS.undo) { delete done[key]; delete doneBy[key]; }
    if (op === OT_ACTIONS.claim) owner[key] = who;
    (byDay[date] = byDay[date] || {})[key] = op;
  });
  return { done: done, doneBy: doneBy, owner: owner, byDay: byDay };
}

/** 純粋関数：シートの値を文字に（先頭の「'」を外す。日付になっていたら日本時間の YYYY-MM-DD） */
function OT_cell(v) {
  if (v instanceof Date || (v && typeof v.getTime === 'function' && typeof v.toISOString === 'function')) return new Date(v.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  return String(v == null ? '' : v).replace(/^'/, '').trim();
}

/** 純粋関数：未完了の一覧の文 */
function OT_remainingText(items, owner, date) {
  if (!items.length) return '【まだ終わっていないお仕事】' + OT_md(date) + '\n今日のお仕事はすべて完了しています✨';
  return '【まだ終わっていないお仕事】' + OT_md(date) + '（' + items.length + '件）\n'
    + items.map(function (it, i) { var o = owner[it.id + '|' + it.period]; return (i + 1) + '. ' + it.name + (it.overdue ? '（期限を過ぎています）' : '') + '　担当：' + (o ? o + 'さん' : '未定'); }).join('\n');
}

/** 純粋関数：先週（月曜〜日曜）のまとめの文 */
function OT_weeklyText(rows, monday, name) {
  var from = OT_addDays(monday, -7), to = OT_addDays(monday, -1), c = { done: 0, ask: 0, skip: 0 }, asks = [], skips = [], people = {};
  (rows || []).forEach(function (r, i) {
    if (i === 0) return;
    var d = OT_cell(r[1]);
    if (d < from || d > to) return;
    if (r[5] === OT_ACTIONS.done) { c.done++; people[r[6]] = (people[r[6]] || 0) + 1; }
    if (r[5] === OT_ACTIONS.ask) { c.ask++; asks.push(String(r[4])); }
    if (r[5] === OT_ACTIONS.skip) { c.skip++; skips.push(String(r[4])); }
  });
  var uniq = function (a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); };
  var who = Object.keys(people).map(function (k) { return k + 'さん ' + people[k] + '件'; }).join('、');
  return ['【先週のお仕事のまとめ】' + OT_md(from) + '〜' + OT_md(to),
    '完了：' + c.done + '件／わからない：' + c.ask + '件／できなかった：' + c.skip + '件',
    who ? '完了した人：' + who : '',
    asks.length ? '「わからない」が押された仕事：' + uniq(asks).join('、') + '（手順の書き足しを検討してください）' : '',
    skips.length ? '「今日はできない」になった仕事：' + uniq(skips).join('、') : ''].filter(String).join('\n');
}

/** 純粋関数：グループの文が「残りの業務を教えて」の意味か */
function OT_isRemainingQuery(text) {
  var t = String(text || '').replace(/[\s　]/g, '');
  if (t.length > 40) return false;
  return /(未完了|完了してない|完了していない|終わってない|終わっていない|残り|残って|残ってる|まだ)/.test(t) && /(業務|仕事|タスク|作業)/.test(t)
    || /^(今日の(業務|仕事|お仕事|タスク)|残りの(業務|仕事|お仕事|タスク))(を?教えて|は\?|は？)?$/.test(t);
}

// ======================================================================
// シート・LINE とのやり取り（Apps Script 上でのみ動く）
// ======================================================================

function OT_props_() { return PropertiesService.getScriptProperties(); }
function OT_mode_() { var m = String(OT_props_().getProperty('OFFICE_TASK_MODE') || '').trim(); return m === 'on' || m === 'record' ? m : 'off'; }
function OT_groupDept_() { return String(OT_props_().getProperty('OFFICE_TASK_GROUP') || '').trim() || OT_GROUP_DEPT; }
function OT_book_() { var id = OT_props_().getProperty('OFFICE_TASK_BOOK_ID'); if (!id) throw new Error('OFFICE_TASK_BOOK_ID がありません'); return SpreadsheetApp.openById(id); }
function OT_sheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold'); sh.setFrozenRows(1); }
  return sh;
}

/** 業務マニュアルの行（任せる＝○、予定ルールあり、AI化済みでない）→ task */
function OT_tasks_(ss) {
  var sh = ss.getSheetByName(OT_MANUAL_SHEET);
  if (!sh) throw new Error('「' + OT_MANUAL_SHEET + '」タブがありません');
  var v = sh.getDataRange().getValues(), h = v[0].map(function (x) { return String(x).trim(); });
  var c = function (name) { return h.indexOf(name); };
  var col = { id: c('ID'), name: c('業務名'), minutes: c('目安（分）'), early: c('前倒しできる'), steps: c('やり方（手順）'), items: c('必要な物・リンク'),
    tips: c('コツ・注意'), help: c('困ったとき・判断が必要なとき'), report: c('完了の報告'), ok: c('任せる（○／×）'), rule: c(OT_RULE_HEADER), ai: c(OT_AI_HEADER) };
  var out = [];
  for (var i = 1; i < v.length; i++) {
    var r = v[i], id = String(r[col.id] || '').trim();
    if (!id || String(r[col.ok] || '').trim() !== '○') continue;
    if (col.ai >= 0 && String(r[col.ai] || '').indexOf('AI化済み') !== -1) continue;   // AIだけで終わるようになった仕事は指示しない
    var s = function (k) { return col[k] >= 0 ? String(r[col[k]] || '') : ''; };
    out.push({ id: id, name: s('name'), minutes: Number(r[col.minutes]) || 0, early: s('early').indexOf('○') !== -1, steps: s('steps'), items: s('items'),
      tips: s('tips'), help: s('help'), report: s('report'), rule: s('rule').trim() || (OT_DEFAULT_RULES[id] || '') });
  }
  return out;
}

/** 臨時の依頼（状態が「完了」「取り消し」以外） */
function OT_requests_(ss) {
  var sh = OT_sheet_(ss, OT_REQUEST_SHEET, OT_REQUEST_HEADER), v = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < v.length; i++) {
    var r = v[i], st = String(r[5] || '').trim();
    if (st === '完了' || st === '取り消し' || (!r[1] && !r[2])) continue;
    var due = r[3] instanceof Date ? Utilities.formatDate(r[3], AC_TZ, 'yyyy-MM-dd') : String(r[3] || '').replace(/\//g, '-').slice(0, 10);
    out.push({ row: i + 1, id: String(r[1] || '').trim(), name: String(r[2] || '').trim(), due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : '', memo: String(r[4] || '') });
  }
  return out;
}

/** 従業員マスタ：社員番号 → { code, name（姓）, userId, tot }、LINE ID → 姓 */
function OT_master_() {
  var mv = AC_masterSheet_().getDataRange().getValues(), byCode = {}, byUid = {};
  for (var i = 1; i < mv.length; i++) {
    var code = AC_cellCode_(mv[i][AC_COL.code]), full = String(mv[i][AC_COL.name] || '').trim(), uid = String(mv[i][AC_COL.userId] || '');
    var p = { code: code, name: full.split(/[\s　]+/)[0] || full, userId: uid, tot: AC_totKey(mv[i][AC_COL.totCode]) };
    if (code) byCode[code] = p;
    if (AC_isUserId(uid)) byUid[uid] = p;
  }
  return { byCode: byCode, byUid: byUid };
}
function OT_staff_(master) {
  var code = String(OT_props_().getProperty('OFFICE_TASK_STAFF') || '').trim();
  if (!code) throw new Error('OFFICE_TASK_STAFF がありません');
  var s = (master || OT_master_()).byCode[code];
  if (!s) throw new Error('従業員マスタに社員番号 ' + code + ' がありません');
  return s;
}

/** 今日の予定（TOT）。{ found（今日のデータがある）, shift（null＝休み・予定なし） } */
function OT_todayShift_(staff, today) {
  var data = AC_readTotLatest_();
  if (!data || data.today !== today || !data.results) return { found: false, shift: null };
  var R = data.results, key = '';
  (R.employees || []).forEach(function (e) { if (staff.tot && AC_totKey(e.code) === staff.tot) key = String(e.key || ''); });
  if (!key || !Array.isArray(R.schedules) || R.schedules.some(function (d) { return d && d._error; })) return { found: false, shift: null };
  var s = null;
  AC_totFlat_(R.schedules).forEach(function (x) { if (x && x.employeeKey === key && x.date === today) s = x; });
  return { found: true, shift: OT_shift(s) };
}

function OT_groups_() {
  try { return AC_groupsByDept(AC_groupSheet_().getDataRange().getValues())[OT_groupDept_()] || []; } catch (e) { return []; }
}
function OT_api_(path, payload) {
  var token = OT_props_().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) return false;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/' + path, { method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, 'X-Line-Retry-Key': Utilities.getUuid() }, payload: JSON.stringify(payload), muteHttpExceptions: true });
  return res.getResponseCode() === 200;
}
function OT_pushGroup_(messages) {
  var sent = 0;
  OT_groups_().forEach(function (g) { try { if (OT_api_('push', { to: g, messages: messages })) sent++; } catch (e) { Logger.log('事務の業務一覧の送信に失敗'); } });
  return sent;
}
function OT_reply_(token, messages) { try { OT_api_('reply', { replyToken: token, messages: messages }); } catch (e) { Logger.log('事務の業務一覧の返信に失敗'); } }
function OT_text_(t) { return { type: 'text', text: String(t).slice(0, 4900) }; }

function OT_dayToken_(date, create) {
  var p = OT_props_(), k = 'OT_TOKEN_' + date, t = p.getProperty(k);
  if (!t && create) { t = Utilities.getUuid().replace(/-/g, '').slice(0, 10); p.setProperty(k, t); }
  return t || '';
}
function OT_planOf_(date) { var raw = OT_props_().getProperty('OT_PLAN_' + date); return raw ? JSON.parse(raw) : null; }
function OT_savePlan_(date, plan) { OT_props_().setProperty('OT_PLAN_' + date, JSON.stringify(plan)); }

/** 今日の一覧（朝に送った分＋［手が空きました］で渡した分）のうち、まだ完了していないもの。item の配列 */
function OT_remaining_(ss, date, info) {
  var plan = OT_planOf_(date);
  if (!plan) return null;
  var tasks = OT_tasks_(ss), reqs = OT_requests_(ss), out = [];
  (plan.ids || []).forEach(function (k) {
    if (info.done[k]) return;
    var id = k.split('|')[0], per = k.split('|')[1], t = tasks.filter(function (x) { return x.id === id; })[0];
    var q = /^R\d+$/.test(per) ? reqs.filter(function (x) { return 'R' + x.row === per; })[0] : null;
    if (/^R\d+$/.test(per) && !q) return;                                  // 臨時の依頼が完了・取り消しになった
    var base = t || { id: id, name: (q && q.name) || id, minutes: 30 };
    var rule = OT_parseRule(base.rule), pr = rule ? OT_periods(rule, date).filter(function (x) { return x.key === per; })[0] : null;
    out.push(Object.assign({}, base, { name: (q && q.name) || base.name, period: per, deadline: q ? q.due || date : pr ? pr.end : date,
      overdue: q ? !!(q.due && q.due < date) : !!(pr && pr.end < date), req: !!q, memo: q ? q.memo : '' }));
  });
  return out;
}

/** 毎朝8時（トリガー） */
function OT_morning() {
  var mode = OT_mode_();
  if (mode === 'off') return;
  try {
    var today = AC_today_(), ss = OT_book_(), staff = OT_staff_(), st = OT_todayShift_(staff, today);
    var log = OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER).getDataRange().getValues(), info = OT_doneFromLog(log);
    var offDay = st.found && !st.shift;
    var plan = OT_plan(OT_tasks_(ss), today, st.shift ? st.shift.minutes : OT_DEFAULT_MINUTES, info.done, OT_requests_(ss));
    if (offDay) {   // お休みの日：期限が今日まで・過ぎている・臨時の依頼（期限が今日まで）だけ。無ければ送らない
      plan.today = plan.today.filter(function (it) { return it.overdue || it.deadline <= today; }).filter(function (it) { return it.id !== 'M01' && it.id !== 'M10' && it.id !== 'M02'; });
      plan.extra = []; plan.total = plan.today.reduce(function (a, it) { return a + (Number(it.minutes) || 0); }, 0);
      if (!plan.today.length) { Logger.log('事務の業務一覧：担当の方がお休みで、期限が今日までのお仕事なし（送らない）'); return; }
    }
    var token = OT_dayToken_(today, true);
    var msgs = OT_morningMessages(plan, { date: today, name: staff.name, token: token, shiftLabel: st.shift ? st.shift.label : '', offDay: offDay, owners: info.owner });
    var weekly = OT_date(today).getUTCDay() === 1 ? OT_weeklyText(log, today, staff.name) : '';
    OT_savePlan_(today, { ids: plan.today.map(function (it) { return it.id + '|' + it.period; }), extra: plan.extra.map(function (it) { return it.id + '|' + it.period; }),
      end: st.shift ? st.shift.end : null, reminded: false, offDay: offDay });
    var summary = plan.today.map(function (it, i) { return (i + 1) + '. ' + it.name + '（' + it.minutes + '分）'; }).join('\n')
      + (plan.extra.length ? '\n［手が空いたとき］' + plan.extra.map(function (it) { return it.name; }).join('、') : '') + (weekly ? '\n\n' + weekly : '');
    OT_sheet_(ss, OT_PLAN_SHEET, OT_PLAN_HEADER).appendRow([new Date(), today, offDay ? 'お休み' : st.shift ? st.shift.label : '（不明・6時間で計算）', plan.today.length, plan.total,
      (mode === 'on' ? '' : '【記録のみ】') + summary]);
    if (mode !== 'on') return;
    var sent = OT_pushGroup_(msgs);
    if (weekly && sent) OT_pushGroup_([OT_text_(weekly)]);
    if (!sent) AC_adminNotice_('officetask', '【エラー】事務の業務一覧をグループ（' + OT_groupDept_() + '）に送れませんでした🙇‍♀️ 「LINEグループ」シートの登録を確認してください。');
  } catch (e) {
    Logger.log('事務の業務一覧の処理エラー：%s', e && e.message);
    AC_adminNotice_('officetask', '【エラー】事務の業務一覧の作成で問題がありました🙇‍♀️\n（' + (e && e.message ? e.message : '不明なエラー') + '）');
  }
}

/** 30分ごと（トリガー）：終業30分前に、残っている仕事と報告のお願い */
function OT_tick() {
  if (OT_mode_() !== 'on') return;
  try {
    var today = AC_today_(), plan = OT_planOf_(today);
    if (!plan || plan.reminded || plan.end == null) return;
    var hhmm = Utilities.formatDate(new Date(), AC_TZ, 'HH:mm').split(':'), hm = Number(hhmm[0]) * 60 + Number(hhmm[1]);
    if (hm < plan.end - 30) return;
    var ss = OT_book_(), info = OT_doneFromLog(OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER).getDataRange().getValues());
    var left = OT_remaining_(ss, today, info) || [];
    plan.reminded = true; OT_savePlan_(today, plan);
    OT_pushGroup_([OT_text_(left.length
      ? OT_remainingText(left, info.owner, today) + '\n\nあと30分ほどで終業です。終わったものは［完了］、今日できないものは［今日はできない］を押してください。残ったものは明日に回します。本日もお疲れさまでした😊'
      : '【今日のお仕事】すべて完了しています。ありがとうございました！本日もお疲れさまでした😊')]);
  } catch (e) { Logger.log('事務の業務一覧（終業前）の処理エラー：%s', e && e.message); }
}

/** グループの押した人：従業員マスタの姓（無ければ LINE の表示名）。グループのメンバーでなければ null */
function OT_who_(gid, uid, master) {
  if (!AC_isUserId(uid)) return null;
  var display = typeof INQ_memberName_ === 'function' ? INQ_memberName_(gid, uid) : '';
  if (display === null) return null;
  var m = master.byUid[uid];
  return m ? m.name : (display || 'メンバー');
}

/** グループの文（事務業務のグループだけ）：「残りの業務」などに未完了の一覧を返す。扱ったら true */
function OT_onGroupMessage_(ev) {
  try {
    if (OT_mode_() !== 'on' || !ev || ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return false;
    var gid = ev.source && ev.source.groupId;
    if (!gid || OT_groups_().indexOf(gid) === -1 || !OT_isRemainingQuery(ev.message.text)) return false;
    var today = AC_today_(), ss = OT_book_(), info = OT_doneFromLog(OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER).getDataRange().getValues());
    var left = OT_remaining_(ss, today, info);
    if (left === null) { OT_reply_(ev.replyToken, [OT_text_('今日のお仕事の一覧はまだありません（お休みの日、または朝のお知らせの前です）。')]); return true; }
    var msgs = [OT_text_(OT_remainingText(left, info.owner, today))];
    if (left.length) {
      var token = OT_dayToken_(today, false);
      msgs.push({ type: 'flex', altText: 'まだ終わっていないお仕事 ' + left.length + '件',
        contents: { type: 'carousel', contents: left.slice(0, 12).map(function (it, i) { return OT_bubble(it, i + 1, today, token, info.owner[it.id + '|' + it.period]); }) } });
    }
    OT_reply_(ev.replyToken, msgs);
    return true;
  } catch (e) { Logger.log('事務の業務一覧（残りの業務）の処理エラー：%s', e && e.message); return false; }
}

/** ボタン（事務業務のグループ）。コード.gs の AC_handleGroupEvent_ から呼ぶ */
function OT_onGroupPostback_(ev) {
  try {
    if (OT_mode_() !== 'on' || !ev || ev.type !== 'postback') return;
    var p = OT_parsePostback(ev.postback && ev.postback.data);
    if (!p) return;
    var gid = ev.source && ev.source.groupId, uid = ev.source && ev.source.userId;
    if (!gid || OT_groups_().indexOf(gid) === -1) return;
    var cache = CacheService.getScriptCache();
    if (ev.webhookEventId) { if (cache.get('ot:ev:' + ev.webhookEventId)) return; cache.put('ot:ev:' + ev.webhookEventId, '1', 21600); }
    var master = OT_master_(), who = OT_who_(gid, uid, master), admin = OT_props_().getProperty('LINE_ADMIN_USER_ID');
    if (!who) { OT_reply_(ev.replyToken, [OT_text_('押した方を確認できなかったため、受け付けできませんでした。スマートフォンのLINEから押してください。')]); return; }
    if (!p.token || p.token !== OT_dayToken_(p.date, false)) { OT_reply_(ev.replyToken, [OT_text_('このボタンは使えません。今日のお知らせのボタン（または「残りの業務」と送って出るボタン）を押してください。')]); return; }
    if (p.date !== AC_today_() && p.action !== 'undo') { OT_reply_(ev.replyToken, [OT_text_('このボタンは前の日のものです。「残りの業務」と送って、今日のボタンから押してください。')]); return; }
    var ss = OT_book_(), tasks = OT_tasks_(ss), task = tasks.filter(function (t) { return t.id === p.id; })[0];
    var reqs = OT_requests_(ss), req = /^R\d+$/.test(p.period) ? reqs.filter(function (q) { return 'R' + q.row === p.period; })[0] : null;
    var name = req && req.name ? req.name : task ? task.name : p.id;
    var logSh = OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER), now = new Date(), key = p.id + '|' + p.period;
    var log = function (op, memo) { logSh.appendRow([now, "'" + p.date, "'" + p.period, "'" + p.id, name, op, who, memo || '', uid]); };
    var plan = OT_planOf_(p.date) || { ids: [], extra: [] }, info = OT_doneFromLog(logSh.getDataRange().getValues());
    var undoBtn = { type: 'flex', altText: '取り消す', contents: { type: 'bubble', size: 'micro', body: { type: 'box', layout: 'vertical', contents: [
      { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '間違えたので取り消す', data: ['ot', '1', 'undo', p.date, p.id, p.period, p.token].join('|'), displayText: '取り消す：' + name } }] } } };
    if (p.action === 'free') {
      var next = (plan.extra || []).filter(function (k) { return !info.done[k] && (plan.offered || []).indexOf(k) === -1; })[0];
      if (!next) { log(OT_ACTIONS.free, '追加の仕事なし'); OT_reply_(ev.replyToken, [OT_text_(who + 'さん、ありがとうございます！今日予定していたお仕事は以上です😊\n手が空いている間は「業務マニュアル」を読んで、わかりにくい所をメモしておいてください。安藤さん、ほかにお願いしたいことがあれば「臨時の依頼」に追加をお願いします。')]); return; }
      plan.offered = (plan.offered || []).concat([next]); plan.ids = (plan.ids || []).concat([next]); OT_savePlan_(p.date, plan);
      var nid = next.split('|')[0], nper = next.split('|')[1], nt = tasks.filter(function (t) { return t.id === nid; })[0] || { id: nid, name: nid, minutes: 0 };
      var pr = OT_periods(OT_parseRule(nt.rule) || { type: 'daily' }, p.date).filter(function (x) { return x.key === nper; })[0];
      log(OT_ACTIONS.free, '次：' + nt.name);
      OT_reply_(ev.replyToken, [OT_text_(who + 'さん、ありがとうございます！次はこちらをお願いします👇'),
        { type: 'flex', altText: '次のお仕事：' + nt.name, contents: OT_bubble(Object.assign({}, nt, { period: nper, deadline: pr ? pr.end : p.date, early: pr ? pr.start > p.date : false }), 0, p.date, p.token, who) }]);
      log(OT_ACTIONS.claim, '［手が空きました］で受け取り');
      return;
    }
    if (p.action === 'done') {
      if (info.done[key]) { OT_reply_(ev.replyToken, [OT_text_('「' + name + '」は' + info.doneBy[key].name + 'さんが完了にしています。')]); return; }
      log(OT_ACTIONS.done);
      if (req) OT_sheet_(ss, OT_REQUEST_SHEET, OT_REQUEST_HEADER).getRange(req.row, 6).setValue('完了');
      info.done[key] = true;
      var rest = (OT_remaining_(ss, p.date, info) || []).filter(function (it) { var o = info.owner[it.id + '|' + it.period]; return !o || o === who; });
      OT_reply_(ev.replyToken, [OT_text_(who + 'さん、ありがとうございます！「' + name + '」を完了にしました✨'
        + (rest.length ? '\n次は「' + rest[0].name + '」をお願いします。' : '\n今日のお仕事はすべて完了です。手が空いたら［手が空きました］を押してください。')), undoBtn]);
      return;
    }
    if (p.action === 'undo') {
      if (!info.done[key]) { OT_reply_(ev.replyToken, [OT_text_('「' + name + '」は完了になっていません。')]); return; }
      if (info.doneBy[key].uid !== uid && uid !== admin) { OT_reply_(ev.replyToken, [OT_text_('取り消せるのは、完了にした' + info.doneBy[key].name + 'さんと管理者だけです。')]); return; }
      if (req) OT_sheet_(ss, OT_REQUEST_SHEET, OT_REQUEST_HEADER).getRange(req.row, 6).setValue('');
      log(OT_ACTIONS.undo);
      OT_reply_(ev.replyToken, [OT_text_('「' + name + '」の完了を取り消しました。まだ終わっていないお仕事に戻しています。')]);
      return;
    }
    if (info.done[key]) { OT_reply_(ev.replyToken, [OT_text_('「' + name + '」は' + info.doneBy[key].name + 'さんが完了にしています。')]); return; }
    if (p.action === 'claim') {
      var cur = info.owner[key];
      log(OT_ACTIONS.claim, cur && cur !== who ? '担当の変更（前：' + cur + 'さん）' : '');
      OT_reply_(ev.replyToken, [OT_text_('「' + name + '」は' + who + 'さんの担当にしました👍' + (cur && cur !== who ? '（' + cur + 'さんから変更しました）' : '') + '\n終わったら［完了］を押してください。')]);
      return;
    }
    if (p.action === 'ask') {
      log(OT_ACTIONS.ask, 'マニュアル改善の候補');
      OT_reply_(ev.replyToken, [OT_text_(who + 'さん、「' + name + '」ですね。まずはこちらを確認してください。\n'
        + (task && task.help ? '・困ったとき：' + task.help + '\n' : '') + (task && task.tips ? '・コツ：' + task.tips + '\n' : '')
        + '\nそれでも分からないときは、手を止めて大丈夫です。安藤さん、確認をお願いします🙏（このお仕事は残したままにしておきます）')]);
      return;
    }
    if (p.action === 'skip') {
      log(OT_ACTIONS.skip);
      var pr2 = task && !req ? OT_periods(OT_parseRule(task.rule) || { type: 'daily' }, p.date).filter(function (x) { return x.key === p.period; })[0] : null;
      var urgent = req ? !!(req.due && req.due <= p.date) : !!(pr2 && pr2.end <= p.date);
      OT_reply_(ev.replyToken, [OT_text_('了解しました。「' + name + '」は明日に回します。' + (urgent ? '\n⚠️ 期限が今日までです。ほかに対応できる方は［対応します］を押してください。安藤さんもご確認ください。' : ''))]);
    }
  } catch (e) {
    Logger.log('事務の業務一覧のボタンの処理エラー：%s', e && e.message);
    AC_adminNotice_('officetaskbutton', '【エラー】事務の業務一覧のボタンの処理で問題がありました🙇‍♀️\n（' + (e && e.message ? e.message : '不明なエラー') + '）');
  }
}

/** 準備（手動で1回）：タブを作り、業務マニュアルに「AI用の予定ルール」「AI化の状況」の列を足す（空欄だけ既定値を入れる） */
function OT_setup() {
  var ss = OT_book_(), sh = ss.getSheetByName(OT_MANUAL_SHEET);
  [[OT_RULE_HEADER, function (id) { return OT_DEFAULT_RULES[id] || ''; }], [OT_AI_HEADER, function () { return '人の手'; }]].forEach(function (pair) {
    var v = sh.getDataRange().getValues(), h = v[0].map(String), c = h.indexOf(pair[0]);
    if (c < 0) { c = h.length; sh.getRange(1, c + 1).setValue(pair[0]).setFontWeight('bold'); }
    for (var i = 1; i < v.length; i++) {
      var id = String(v[i][0] || '').trim(), dflt = pair[1](id);
      if (id && !String(v[i][c] || '').trim() && dflt) sh.getRange(i + 1, c + 1).setValue(dflt);
    }
  });
  OT_sheet_(ss, OT_REQUEST_SHEET, OT_REQUEST_HEADER); OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER); OT_sheet_(ss, OT_PLAN_SHEET, OT_PLAN_HEADER);
  Logger.log('事務の業務一覧：準備しました（版 %s）', OT_VERSION);
}

/** トリガー：毎朝8時台（OT_morning）・30分ごと（OT_tick）。同じ関数のトリガーがあれば作らない */
function OT_setupTriggers() {
  var have = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (have.indexOf('OT_morning') === -1) ScriptApp.newTrigger('OT_morning').timeBased().everyDays(1).atHour(8).nearMinute(0).inTimezone(AC_TZ).create();
  if (have.indexOf('OT_tick') === -1) ScriptApp.newTrigger('OT_tick').timeBased().everyMinutes(30).create();
}
function OT_removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { var f = t.getHandlerFunction(); if (f === 'OT_morning' || f === 'OT_tick') ScriptApp.deleteTrigger(t); });
}

/** 確認用（送らない・記録しない）：今日の予定をログに出す */
function OT_preview() {
  var today = AC_today_(), ss = OT_book_(), staff = OT_staff_(), st = OT_todayShift_(staff, today);
  var info = OT_doneFromLog(OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER).getDataRange().getValues());
  var plan = OT_plan(OT_tasks_(ss), today, st.shift ? st.shift.minutes : OT_DEFAULT_MINUTES, info.done, OT_requests_(ss));
  Logger.log('送り先：%s（%s件）', OT_groupDept_(), OT_groups_().length);
  Logger.log('勤務：%s／件数 %s／合計 %s分（予算 %s分・予備 %s分）', st.found ? (st.shift ? st.shift.label : '休み') : '不明', plan.today.length, plan.total, plan.budget, plan.reserve);
  plan.today.forEach(function (it, i) { Logger.log('%s. %s（%s分・期限 %s%s）', i + 1, it.name, it.minutes, it.deadline, it.overdue ? '・過ぎている' : ''); });
  Logger.log('手が空いたとき：%s', plan.extra.map(function (it) { return it.name; }).join('、') || 'なし');
}
