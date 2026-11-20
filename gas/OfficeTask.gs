/**
 * 事務の業務一覧LINE（AI上司）（gas/OfficeTask.gs・版 2026-11-20a：ボタンは完了・対応します・詳細を確認・今日はできない／完了のあとは残りの一覧／取り消しは文で）
 *
 * 平日（土日祝・休みの日を除く）の毎朝8時台、事務業務のグループ（「部門登録 事務業務」で登録したグループ）に、
 * 管理本部みんなの「今日のお仕事」をボタン付きで送る。特定の人に固定しない（だれが担当してもよい）。
 * - 仕事の中身は「【事務業務】業務一覧・マニュアル」の「業務マニュアル」タブ（任せる＝○、AI化の状況が「AI化済み」でない行）と「臨時の依頼」タブ
 * - 期限が近い順に、期間に入っているお仕事をすべて並べる。前倒しできるお仕事は［手が空きました］で1件ずつ渡す
 * - ボタン：［完了］［対応します］［わからない］［今日はできない］［手が空きました］。グループのメンバーなら誰でも押せて、押した人（従業員マスタの姓）を担当・完了者として記録する
 *   ［完了］のあとに［取り消す］（完了にした人と管理者だけ）
 * - グループで「残りの業務」「今日の業務を教えて」などと送ると、まだ終わっていないお仕事（担当つき）を返信する。
 *   土日祝など朝のお知らせが無い日は、その時に今日のお仕事の一覧を作って返信する（返信なので通数にかからない）
 * - 12時（OT_REMIND_MIN）に、残っているお仕事をお知らせする（朝に送った日だけ）。週の最初の平日の朝は先週のまとめも送る
 *
 * スクリプトプロパティ：
 *   OFFICE_TASK_MODE       未設定・off＝何もしない／record＝送らずに「送る予定の内容」タブへ記録／on＝送信
 *   OFFICE_TASK_BOOK_ID    業務一覧・マニュアルのスプレッドシートID
 *   OFFICE_TASK_GROUP      送り先のグループの部門名（未設定＝「事務業務」）
 *   OFFICE_TASK_OFF_DATES  土日祝のほかに送らない日（任意。例「12/29,12/30,12/31,1/2,1/3」や「2026-12-28」）
 * 受け口（ボタン・グループの文）はコード.gs の AC_handleGroupEvent_ から呼ぶ（Webアプリの再公開が必要）。
 * 毎朝・10分ごとの処理は OT_setupTriggers で作るトリガー（OT_morning・OT_tick）で動く。
 */
var OT_VERSION = '2026-11-20a';
var OT_GROUP_DEPT = '事務業務';   // 「部門登録 事務業務」で登録したグループへ送る
var OT_AI_HEADER = 'AI化の状況';    // 人の手／一部AI／AI化済み（AI化済みは指示しない）。列名は「AI化の状況」で始まればよい
var OT_ORDER_SHEET = 'AI化の順番（まゆさん用）';   // 状況（まゆさん）と稼働の確認（設定・結果）。業務マニュアルの「AI化の状況」はこのタブから式で決まる
var OT_MANUAL_SHEET = '業務マニュアル';
var OT_REQUEST_SHEET = '臨時の依頼';
var OT_LOG_SHEET = '今日の仕事の記録';
var OT_PLAN_SHEET = '送る予定の内容';
var OT_REQUEST_HEADER = ['依頼日', '業務ID（業務マニュアル）', '業務名（自由に書いてよい）', '期限', 'メモ（AIが本人に伝えること）', '状態'];
var OT_LOG_HEADER = ['日時', '日付', '期間', '業務ID', '業務名', '操作', '押した人', 'メモ', 'LINEユーザーID'];
var OT_PLAN_HEADER = ['日時', '日付', '種類', '件数', '合計（分）', '内容'];
var OT_RULE_HEADER = 'AI用の予定ルール';
var OT_DEFAULT_RULES = { M01: 'daily', M02: 'daily', M03: 'weekly:5', M04: 'monthly:1~3', M05: 'monthly:-2~3', M06: 'monthly:5~10',
  M07: 'monthly:13~20', M08: 'monthly:-2~5', M09: 'monthly:23~25', M10: 'daily', M11: 'monthly:1~5', M12: 'request', M13: 'request',
  M14: 'request', M15: 'request', M16: 'request', M17: 'request', M18: 'yearly:11/1~12/20', M19: 'request', M20: 'request',
  M21: 'reserve', M22: 'spare', M23: 'yearly:6/1~6/20', M24: 'yearly:11/1~11/20' };
var OT_FILL_RATE = 0.8;            // 勤務時間のうち、仕事を入れる割合（残りは電話・来客などの予備）
var OT_DEFAULT_MINUTES = 360;      // 勤務時間が読めなかったときの目安
var OT_EARLY_DAYS = 7;             // 期間の始まる何日前から前倒しの候補にするか
var OT_OVERDUE_DAYS = 7;           // 期限を過ぎて何日まで残りとして出すか
var OT_REMIND_MIN = 12 * 60;        // 残りのお仕事のお知らせ（12:00）
var OT_MAX_BUBBLES = 11;           // カルーセルは12枚まで（1枚目はまとめ）
var OT_ACTIONS = { done: '完了', claim: '対応します', ask: 'わからない', skip: '今日はできない', free: '手が空きました', undo: '取り消し', detail: '詳細を確認' };

// ======================================================================
// 純粋関数（テストで確かめる）
// ======================================================================

function OT_ymd(d) { return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
function OT_date(s) { var p = String(s).split('-'); return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))); }
function OT_addDays(s, n) { var d = OT_date(s); d.setUTCDate(d.getUTCDate() + n); return OT_ymd(d); }
function OT_diff(a, b) { return Math.round((OT_date(b) - OT_date(a)) / 86400000); }   // b − a（日）
function OT_lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }       // m は 1〜12
function OT_md(s) { var w = '日月火水木金土'.charAt(OT_date(s).getUTCDay()); return Number(s.slice(5, 7)) + '/' + Number(s.slice(8, 10)) + '（' + w + '）'; }

/** 純粋関数：その年の日本の祝日（振替休日・国民の休日を含む）→ { 'YYYY-MM-DD': true }（2020年以降の決まり） */
function OT_holidays(y) {
  var f = function (m, d) { return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2); };
  var mon = function (m, n) { var dow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return f(m, 1 + (8 - dow) % 7 + 7 * (n - 1)); };   // m月の第n月曜
  var k = y - 1980, shun = Math.floor(20.8431 + 0.242194 * k - Math.floor(k / 4)), shu = Math.floor(23.2488 + 0.242194 * k - Math.floor(k / 4));
  var list = [f(1, 1), mon(1, 2), f(2, 11), f(2, 23), f(3, shun), f(4, 29), f(5, 3), f(5, 4), f(5, 5), mon(7, 3), f(8, 11), mon(9, 3), f(9, shu), mon(10, 2), f(11, 3), f(11, 23)];
  var set = {};
  list.forEach(function (d) { set[d] = true; });
  list.forEach(function (d) {   // 国民の休日（祝日にはさまれた平日）
    var mid = OT_addDays(d, 1);
    if (set[OT_addDays(d, 2)] && !set[mid] && OT_date(mid).getUTCDay() !== 0) set[mid] = true;
  });
  list.filter(function (d) { return OT_date(d).getUTCDay() === 0; }).forEach(function (d) {   // 振替休日（日曜の祝日のあとの最初の平日）
    var n = OT_addDays(d, 1);
    while (set[n]) n = OT_addDays(n, 1);
    set[n] = true;
  });
  return set;
}

/** 純粋関数：お知らせを送る日か（土日・祝日・offDates（「12/29」や「2026-12-28」）でない） */
function OT_isBusinessDay(ymd, offDates) {
  var dow = OT_date(ymd).getUTCDay();
  if (dow === 0 || dow === 6 || OT_holidays(Number(ymd.slice(0, 4)))[ymd]) return false;
  var md = Number(ymd.slice(5, 7)) + '/' + Number(ymd.slice(8, 10));
  return !(offDates || []).some(function (x) { x = String(x).trim(); return x === ymd || x === md; });
}

/** 純粋関数：その週（月〜日）の最初のお知らせの日か（先週のまとめを送る日） */
function OT_isFirstBusinessDayOfWeek(ymd, offDates) {
  var monday = OT_addDays(ymd, -((OT_date(ymd).getUTCDay() + 6) % 7));
  for (var d = monday; d < ymd; d = OT_addDays(d, 1)) if (OT_isBusinessDay(d, offDates)) return false;
  return OT_isBusinessDay(ymd, offDates);
}

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

/**
 * 純粋関数（版 2026-11-18a）：文を吹き出しの部品にする。URL がある行は「名前 🔗タップで開く」の青い文字にして、押すとそのページを開く
 * （LINE の吹き出しの文字は、URL を書いても押せないため）。1行に URL が2つ以上あれば、URL ごとに1行にする
 */
function OT_textParts(prefix, text, size, color) {
  var out = [];
  OT_lines(text).forEach(function (line, i) {
    var head = i === 0 ? prefix : '';
    var urls = line.match(/https?:\/\/[^\s\u3000）)」』、，,]+/g);
    if (!urls) { out.push({ type: 'text', text: head + line, size: size, wrap: true, color: color }); return; }
    var rest = line;
    urls.forEach(function (u, k) {
      var at = rest.indexOf(u), label = rest.slice(0, at).replace(/[：:\s\u3000]+$/, '').trim();
      rest = rest.slice(at + u.length);
      if (k === urls.length - 1 && rest.trim()) label = (label ? label + ' ' : '') + rest.trim();
      out.push({ type: 'text', text: (k === 0 ? head : '') + (label || 'リンク') + ' 🔗タップで開く', size: size, wrap: true, color: '#1a73e8',
        decoration: 'underline', action: { type: 'uri', label: '開く', uri: u.slice(0, 1000) } });
    });
  });
  return out;
}

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
  body = body.concat(OT_textParts('', it.steps, 'sm'))
    .concat(OT_textParts('持ち物・使うもの：', it.items, 'xs', '#555555'));   // 版 2026-11-20a：コツ・困ったとき・終わったらは［詳細を確認］で返す（縦に長くなりすぎるため）
  return { type: 'bubble', size: 'mega',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [btn('完了', 'done', 'primary'), btn('対応します', 'claim', 'secondary'),
      btn('詳細を確認', 'detail', 'secondary'), btn('今日はできない', 'skip', 'secondary')] } };
}

/**
 * 純粋関数（版 2026-11-19a）：［手が空きました］で渡すお仕事。
 * today＝今日の一覧でまだ完了していない・担当がいないもの（期限が近い順のまま）、early＝前倒しできるお仕事（plan.extra のうち、まだ完了・一覧にないもの）
 */
function OT_freeItems(left, owners, plan, done, tasks, date) {
  owners = owners || {}; done = done || {};
  var today = (left || []).filter(function (it) { return !owners[it.id + '|' + it.period]; });
  var ids = (plan && plan.ids) || [], early = [];
  ((plan && plan.extra) || []).forEach(function (k) {
    if (done[k] || ids.indexOf(k) !== -1 || owners[k]) return;
    var id = k.split('|')[0], per = k.split('|')[1], t = (tasks || []).filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var pr = OT_periods(OT_parseRule(t.rule) || { type: 'daily' }, date).filter(function (x) { return x.key === per; })[0];
    early.push(Object.assign({}, t, { period: per, deadline: pr ? pr.end : date, early: pr ? pr.start > date : true }));
  });
  return { today: today, early: early };
}

/** 純粋関数：［手が空きました］の返信（まとめの文＋お仕事の吹き出し。今日の残りを先に、最大10件） */
function OT_freeMessages(free, who, date, token) {
  var list = free.today.concat(free.early).slice(0, 10);
  var lines = [who + 'さん、ありがとうございます！手伝えるお仕事はこちらです👇'];
  if (free.today.length) {
    lines.push('', '【今日のお仕事で、まだ担当がいないもの】' + free.today.length + '件');
    free.today.forEach(function (it) { lines.push('・' + it.name + (it.overdue ? '（期限を過ぎています）' : it.deadline === date ? '（今日まで）' : '')); });
  }
  if (free.early.length) {
    lines.push('', '【前倒しできるお仕事】' + free.early.length + '件');
    free.early.forEach(function (it) { lines.push('・' + it.name + '（期限 ' + OT_md(it.deadline) + '）'); });
  }
  var more = free.today.length + free.early.length - list.length;
  lines.push('', (free.today.length && free.early.length ? '今日のお仕事を先にお願いします。' : '') + 'やるものの［対応します］を押してから始めてください（ほかの人と重ならないように）。'
    + (more > 0 ? '\n（ほかに' + more + '件あります。今の分が終わったら、もう一度［手が空きました］を押してください）' : ''));
  var bubbles = list.map(function (it, i) { return OT_bubble(it, i + 1, date, token, null); });
  return [OT_text_(lines.join('\n')), { type: 'flex', altText: '手伝えるお仕事：' + list.map(function (it) { return it.name; }).join('、').slice(0, 380), contents: { type: 'carousel', contents: bubbles } }];
}

/** 純粋関数：朝のメッセージ（まとめ＋1件ずつの吹き出し）。だれか1人あてにしない。opts.requested＝土日祝などに「今日の業務」と頼まれて作った一覧 */
function OT_morningMessages(plan, opts) {
  var date = opts.date, token = opts.token, owners = opts.owners || {};
  var freeBtn = { type: 'button', style: 'primary', color: '#e69138', height: 'sm',
    action: { type: 'postback', label: '手が空きました', data: ['ot', '1', 'free', date, '-', '-', token].join('|'), displayText: '手が空きました' } };
  var head = [opts.requested ? 'お休みの日ですが、ご依頼があったので今日のお仕事をお送りします。' : 'おはようございます☀️ 管理本部のみなさん、今日のお仕事です。',
    '件数：' + plan.today.length + '件（目安 合計' + plan.total + '分）',
    'お仕事を始めるときは［対応します］を押してください（担当が分かり、同じお仕事が重なるのを防げます）。終わったら［完了］を押してください。',
    '分からないときは［わからない］、今日できないときは［今日はできない］。',
    plan.extra.length ? '手が空いた方は［手が空きました］を押すと、前倒しできるお仕事をお送りします（あと' + plan.extra.length + '件あります）。' : '手が空いた方は［手が空きました］を押してください。',
    '「残りの業務」と送ると、まだ終わっていないお仕事をお知らせします' + (opts.requested ? '。' : '（12時にもお知らせします）。')];
  var list = plan.today.map(function (it, i) { return (i + 1) + '. ' + it.name + (it.overdue ? '（期限を過ぎています）' : it.deadline === date && !it.req ? '（今日まで）' : ''); });
  if (plan.today.length > OT_MAX_BUBBLES) list.push('（' + (OT_MAX_BUBBLES + 1) + '件目からは「残りの業務」と送ると表示されます）');
  var summary = { type: 'bubble', size: 'mega',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [{ type: 'text', text: '【今日のお仕事】' + OT_md(date), weight: 'bold', wrap: true }]
      .concat(head.filter(String).map(function (l) { return { type: 'text', text: l, size: 'sm', wrap: true }; }))
      .concat([{ type: 'separator' }]).concat(list.map(function (l) { return { type: 'text', text: l, size: 'sm', wrap: true }; })) },
    footer: { type: 'box', layout: 'vertical', contents: [freeBtn] } };
  var bubbles = [summary].concat(plan.today.slice(0, OT_MAX_BUBBLES).map(function (it, i) { return OT_bubble(it, i + 1, date, token, owners[it.id + '|' + it.period]); }));
  var alt = ('【今日のお仕事】' + plan.today.length + '件：' + plan.today.map(function (it) { return it.name; }).join('、')).slice(0, 400);
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

/** 純粋関数：稼働の確認の設定（例「WEEKLY_PUNCH_NOTIFY=on」「A=on&B=record」）を、スクリプトプロパティ props（{名前: 値}）で確かめる。設定なし＝null */
function OT_checkSetting(setting, props) {
  var t = String(setting || '').trim();
  if (!t) return null;
  return t.split(/[&＆]/).every(function (part) {
    var m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(part);
    return !!m && String(props[m[1]] == null ? '' : props[m[1]]).trim() === m[2];
  });
}

/** 純粋関数：シートの値を文字に（先頭の「'」を外す。日付になっていたら日本時間の YYYY-MM-DD） */
function OT_cell(v) {
  if (v instanceof Date || (v && typeof v.getTime === 'function' && typeof v.toISOString === 'function')) return new Date(v.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  return String(v == null ? '' : v).replace(/^'/, '').trim();
}

/** 純粋関数（版 2026-11-20a）：［詳細を確認］の返信の文（コツ・困ったとき・終わったら・メモ） */
function OT_detailText(name, t, memo) {
  t = t || {};
  var parts = ['【' + name + '】の詳細'];
  if (memo) parts.push('📝 メモ\n' + memo);
  if (t.tips) parts.push('💡 コツ・注意\n' + t.tips);
  if (t.help) parts.push('🙋 困ったとき・判断が必要なとき\n' + t.help);
  if (t.report) parts.push('✅ 終わったら\n' + t.report);
  if (parts.length === 1) parts.push('このお仕事には、コツ・困ったときの書き込みがまだありません。');
  parts.push('それでも分からないときは、手を止めてこのグループで聞いてください。');
  return parts.join('\n\n');
}

/** 純粋関数（版 2026-11-20a）：「取り消し 領収書」のような文か。探す言葉（空＝一覧を返す）か、当てはまらなければ null */
function OT_parseUndo(text) {
  var t = String(text || '').trim();
  if (t.length > 40) return null;
  var m = /^(?:完了の)?取り?消し(?:て|たい|します|お願いします)?[\s　:：]*(.*)$/.exec(t);
  return m ? m[1].replace(/^[「『]|[」』]$/g, '').replace(/(を|の完了を?)?(取り?消し.*)?$/, '').trim() : null;
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
    tips: c('コツ・注意'), help: c('困ったとき・判断が必要なとき'), report: c('完了の報告'), ok: c('任せる（○／×）'), rule: c(OT_RULE_HEADER),
    ai: h.findIndex(function (x) { return x.indexOf(OT_AI_HEADER) === 0; }) };
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
function OT_offDates_() { return String(OT_props_().getProperty('OFFICE_TASK_OFF_DATES') || '').split(/[,、\s]+/).filter(String); }

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

/** AI化の順番のタブの「稼働の確認（結果）」を、スクリプトプロパティで確かめて書き直す（毎朝）。業務マニュアルの「AI化の状況」は式でこれを見る */
function OT_syncAiStatus_(ss, today) {
  var sh = ss.getSheetByName(OT_ORDER_SHEET);
  if (!sh) return 0;
  var v = sh.getDataRange().getValues(), h = v[0].map(String);
  var cs = h.findIndex(function (x) { return x.indexOf('稼働の確認（設定') === 0; }), cr = h.findIndex(function (x) { return x.indexOf('稼働の確認（結果') === 0; });
  if (cs < 0 || cr < 0) return 0;
  var props = OT_props_().getProperties(), n = 0;
  for (var i = 1; i < v.length; i++) {
    var ok = OT_checkSetting(v[i][cs], props);
    var text = ok === null ? '（設定なし）' : ok ? '確認済み（' + OT_md(today) + '）' : '未確認（' + OT_md(today) + '：設定が違います）';
    if (String(v[i][cr]) !== text) { sh.getRange(i + 1, cr + 1).setValue(text); n++; }
  }
  return n;
}

/** 毎朝8時（トリガー） */
/** 今日の一覧を作って保存する（朝・土日祝の「今日の業務」）。{ plan, msgs, log, info } */
function OT_buildToday_(ss, today, requested) {
  var log = OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER).getDataRange().getValues(), info = OT_doneFromLog(log);
  var plan = OT_plan(OT_tasks_(ss), today, Infinity, info.done, OT_requests_(ss));   // 1人の勤務時間で区切らない（期間に入っているものはすべて）
  var token = OT_dayToken_(today, true);
  var msgs = OT_morningMessages(plan, { date: today, token: token, owners: info.owner, requested: !!requested });
  OT_savePlan_(today, { ids: plan.today.map(function (it) { return it.id + '|' + it.period; }), extra: plan.extra.map(function (it) { return it.id + '|' + it.period; }),
    reminded: !!requested, requested: !!requested });
  return { plan: plan, msgs: msgs, log: log, info: info };
}

function OT_morning() {
  var mode = OT_mode_();
  if (mode === 'off') return;
  try {
    var today = AC_today_(), off = OT_offDates_();
    if (!OT_isBusinessDay(today, off)) { Logger.log('事務の業務一覧：土日祝・休みの日のため送らない（%s）', today); return; }
    var ss = OT_book_();
    try { if (OT_syncAiStatus_(ss, today)) SpreadsheetApp.flush(); } catch (e0) { Logger.log('AI化の状況の確認に失敗（人への指示はそのまま続けます）'); }
    var b = OT_buildToday_(ss, today, false), plan = b.plan;
    var weekly = OT_isFirstBusinessDayOfWeek(today, off) ? OT_weeklyText(b.log, OT_addDays(today, -((OT_date(today).getUTCDay() + 6) % 7))) : '';
    var summary = plan.today.map(function (it, i) { return (i + 1) + '. ' + it.name + '（' + it.minutes + '分）'; }).join('\n')
      + (plan.extra.length ? '\n［手が空いたとき］' + plan.extra.map(function (it) { return it.name; }).join('、') : '') + (weekly ? '\n\n' + weekly : '');
    OT_sheet_(ss, OT_PLAN_SHEET, OT_PLAN_HEADER).appendRow([new Date(), today, '毎朝（全員あて）', plan.today.length, plan.total,
      (mode === 'on' ? '' : '【記録のみ】') + summary]);
    if (mode !== 'on') return;
    var sent = OT_pushGroup_(b.msgs);
    if (weekly && sent) OT_pushGroup_([OT_text_(weekly)]);
    if (!sent) AC_adminNotice_('officetask', '【エラー】事務の業務一覧をグループ（' + OT_groupDept_() + '）に送れませんでした🙇‍♀️ 「LINEグループ」シートの登録を確認してください。');
  } catch (e) {
    Logger.log('事務の業務一覧の処理エラー：%s', e && e.message);
    AC_adminNotice_('officetask', '【エラー】事務の業務一覧の作成で問題がありました🙇‍♀️\n（' + (e && e.message ? e.message : '不明なエラー') + '）');
  }
}

/** 10分ごと（トリガー）：12時に、残っているお仕事をお知らせ（朝に送った日だけ・1日1回） */
function OT_tick() {
  if (OT_mode_() !== 'on') return;
  try {
    var today = AC_today_(), plan = OT_planOf_(today);
    if (!plan || plan.reminded || plan.requested) return;
    var hhmm = Utilities.formatDate(new Date(), AC_TZ, 'HH:mm').split(':'), hm = Number(hhmm[0]) * 60 + Number(hhmm[1]);
    if (hm < OT_REMIND_MIN) return;
    var ss = OT_book_(), info = OT_doneFromLog(OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER).getDataRange().getValues());
    var left = OT_remaining_(ss, today, info) || [];
    plan.reminded = true; OT_savePlan_(today, plan);
    OT_pushGroup_([OT_text_(left.length
      ? OT_remainingText(left, info.owner, today) + '\n\n12時のお知らせです。担当が「未定」のお仕事は、手の空いている方が［対応します］を押して進めてください。終わったものは［完了］、今日できないものは［今日はできない］を押してください。'
      : '【今日のお仕事】12時の時点ですべて完了しています。ありがとうございます😊')]);
  } catch (e) { Logger.log('事務の業務一覧（12時）の処理エラー：%s', e && e.message); }
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
    if (!gid || OT_groups_().indexOf(gid) === -1) return false;
    var undoWord = OT_parseUndo(ev.message.text);
    if (undoWord !== null) { OT_undoByText_(ev, gid, undoWord); return true; }
    if (!OT_isRemainingQuery(ev.message.text)) return false;
    var today = AC_today_(), ss = OT_book_(), info = OT_doneFromLog(OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER).getDataRange().getValues());
    var left = OT_remaining_(ss, today, info);
    if (left === null) {   // 土日祝・朝のお知らせの前：今日の一覧をその場で作って返信する
      var b = OT_buildToday_(ss, today, true);
      OT_reply_(ev.replyToken, b.plan.today.length ? b.msgs : [OT_text_('今日のお仕事はありません😊')]);
      return true;
    }
    OT_reply_(ev.replyToken, OT_remainingMessages_(left, info, today));
    return true;
  } catch (e) { Logger.log('事務の業務一覧（残りの業務）の処理エラー：%s', e && e.message); return false; }
}

/** 未完了の一覧の返信（文＋ボタン付きの吹き出し）。「残りの業務」と［完了］のあとで同じ形 */
function OT_remainingMessages_(left, info, today) {
  var msgs = [OT_text_(OT_remainingText(left, info.owner, today))];
  if (left.length) {
    var token = OT_dayToken_(today, false);
    msgs.push({ type: 'flex', altText: 'まだ終わっていないお仕事 ' + left.length + '件',
      contents: { type: 'carousel', contents: left.slice(0, 12).map(function (it, i) { return OT_bubble(it, i + 1, today, token, info.owner[it.id + '|' + it.period]); }) } });
  }
  return msgs;
}

/** 版 2026-11-20a：「取り消し 領収書」で今日の完了を取り消す（ボタンをやめた代わり。完了にした人と管理者だけ） */
function OT_undoByText_(ev, gid, word) {
  var uid = ev.source && ev.source.userId, who = OT_who_(gid, uid, OT_master_()), admin = OT_props_().getProperty('LINE_ADMIN_USER_ID');
  if (!who) { OT_reply_(ev.replyToken, [OT_text_('送った方を確認できなかったため、受け付けできませんでした。')]); return; }
  var today = AC_today_(), ss = OT_book_(), logSh = OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER), rows = logSh.getDataRange().getValues(), info = OT_doneFromLog(rows);
  var seen = {}, list = [];
  rows.slice(1).forEach(function (r) {
    var key = OT_cell(r[3]) + '|' + OT_cell(r[2]);
    if (OT_cell(r[1]) === today && OT_cell(r[5]) === OT_ACTIONS.done && info.done[key] && !seen[key]) { seen[key] = true; list.push({ key: key, id: OT_cell(r[3]), period: OT_cell(r[2]), name: OT_cell(r[4]) }); }
  });
  var hit = word ? list.filter(function (x) { return x.name.indexOf(word) !== -1 || x.id === word; }) : [];
  var usage = '取り消すときは「取り消し 領収書」のように、お仕事の名前（一部でよい）をつけて送ってください。';
  if (!word || hit.length !== 1) {
    var names = list.map(function (x) { return '・' + x.name + '（' + info.doneBy[x.key].name + 'さん）'; }).join('\n');
    OT_reply_(ev.replyToken, [OT_text_((word ? (hit.length ? '「' + word + '」に当てはまるお仕事が' + hit.length + '件あります。もう少しくわしく書いてください。' : '「' + word + '」に当てはまる今日の完了は見つかりませんでした。') + '\n\n' : '')
      + (list.length ? '今日完了にしたお仕事：\n' + names + '\n\n' + usage : '今日完了にしたお仕事はありません。'))]);
    return;
  }
  var x = hit[0], by = info.doneBy[x.key];
  if (by.uid !== uid && uid !== admin) { OT_reply_(ev.replyToken, [OT_text_('取り消せるのは、完了にした' + by.name + 'さんと管理者だけです。')]); return; }
  logSh.appendRow([new Date(), "'" + today, "'" + x.period, "'" + x.id, x.name, OT_ACTIONS.undo, who, '文で取り消し', uid]);
  var req = /^R\d+$/.test(x.period) ? Number(x.period.slice(1)) : 0;
  if (req) OT_sheet_(ss, OT_REQUEST_SHEET, OT_REQUEST_HEADER).getRange(req, 6).setValue('');
  OT_reply_(ev.replyToken, [OT_text_('「' + x.name + '」の完了を取り消しました。まだ終わっていないお仕事に戻しています。')]);
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
    if (p.date !== AC_today_() && p.action !== 'undo' && p.action !== 'detail') { OT_reply_(ev.replyToken, [OT_text_('このボタンは前の日のものです。「残りの業務」と送って、今日のボタンから押してください。')]); return; }
    var ss = OT_book_(), tasks = OT_tasks_(ss), task = tasks.filter(function (t) { return t.id === p.id; })[0];
    var reqs = OT_requests_(ss), req = /^R\d+$/.test(p.period) ? reqs.filter(function (q) { return 'R' + q.row === p.period; })[0] : null;
    var name = req && req.name ? req.name : task ? task.name : p.id;
    var logSh = OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER), now = new Date(), key = p.id + '|' + p.period;
    var log = function (op, memo) { logSh.appendRow([now, "'" + p.date, "'" + p.period, "'" + p.id, name, op, who, memo || '', uid]); };
    var plan = OT_planOf_(p.date) || { ids: [], extra: [] }, info = OT_doneFromLog(logSh.getDataRange().getValues());
    if (p.action === 'free') {   // 版 2026-11-19a：今日まだ担当がいないお仕事と、前倒しできるお仕事をまとめて送る（押した人を担当にはしない。やるものの［対応します］を押してもらう）
      var free = OT_freeItems(OT_remaining_(ss, p.date, info) || [], info.owner, plan, info.done, tasks, p.date);
      log(OT_ACTIONS.free, '今日の残り ' + free.today.length + '件・前倒し ' + free.early.length + '件');
      if (!free.today.length && !free.early.length) {
        OT_reply_(ev.replyToken, [OT_text_(who + 'さん、ありがとうございます！今日のお仕事は、すべて担当が決まっているか完了しています😊\n前倒しできるお仕事もいまはありません。手が空いている間は「業務マニュアル」を読んで、わかりにくい所をメモしておいてください。')]);
        return;
      }
      OT_reply_(ev.replyToken, OT_freeMessages(free, who, p.date, p.token));
      return;
    }
    if (p.action === 'detail') {   // 版 2026-11-20a：コツ・困ったとき・終わったらを返す（記録はしない）
      OT_reply_(ev.replyToken, [OT_text_(OT_detailText(name, task, req ? req.memo : ''))]);
      return;
    }
    if (p.action === 'done') {
      if (info.done[key]) { OT_reply_(ev.replyToken, [OT_text_('「' + name + '」は' + info.doneBy[key].name + 'さんが完了にしています。')]); return; }
      log(OT_ACTIONS.done);
      if (req) OT_sheet_(ss, OT_REQUEST_SHEET, OT_REQUEST_HEADER).getRange(req.row, 6).setValue('完了');
      info.done[key] = true;
      info.doneBy[key] = { name: who, uid: uid };
      var rest = OT_remaining_(ss, p.date, info) || [];   // 版 2026-11-20a：「次は〜」はやめ、「残りの業務」と同じ一覧を返す。取り消しのボタンもやめた（文で取り消す）
      OT_reply_(ev.replyToken, [OT_text_(who + 'さん、ありがとうございます！「' + name + '」を完了にしました✨'
        + (rest.length ? '' : '\n今日のお仕事はすべて完了です。手が空いたら［手が空きました］を押してください。')
        + '\n（間違えて押したときは「取り消し ' + name.slice(0, 10) + '」と送ってください）')].concat(rest.length ? OT_remainingMessages_(rest, info, p.date) : []));
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
      if ((plan.ids || []).indexOf(key) === -1) { plan.ids = (plan.ids || []).concat([key]); OT_savePlan_(p.date, plan); }   // 前倒しのお仕事も「残りの業務」に出す
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
    var v = sh.getDataRange().getValues(), h = v[0].map(String), c = h.findIndex(function (x) { return x.indexOf(pair[0]) === 0; });
    if (c < 0) { c = h.length; sh.getRange(1, c + 1).setValue(pair[0]).setFontWeight('bold'); }
    for (var i = 1; i < v.length; i++) {
      var id = String(v[i][0] || '').trim(), dflt = pair[1](id);
      if (id && !String(v[i][c] || '').trim() && dflt) sh.getRange(i + 1, c + 1).setValue(dflt);
    }
  });
  OT_sheet_(ss, OT_REQUEST_SHEET, OT_REQUEST_HEADER); OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER); OT_sheet_(ss, OT_PLAN_SHEET, OT_PLAN_HEADER);
  Logger.log('事務の業務一覧：準備しました（版 %s）', OT_VERSION);
}

/** トリガー：毎朝8時台（OT_morning）・10分ごと（OT_tick：12時のお知らせ）。同じ関数のトリガーがあれば作らない */
function OT_setupTriggers() {
  var have = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (have.indexOf('OT_morning') === -1) ScriptApp.newTrigger('OT_morning').timeBased().everyDays(1).atHour(8).nearMinute(0).inTimezone(AC_TZ).create();
  if (have.indexOf('OT_tick') === -1) ScriptApp.newTrigger('OT_tick').timeBased().everyMinutes(10).create();
}
function OT_removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { var f = t.getHandlerFunction(); if (f === 'OT_morning' || f === 'OT_tick') ScriptApp.deleteTrigger(t); });
}

/** 確認用（送らない・記録しない）：今日と次のお知らせの日の予定をログに出す */
function OT_preview() {
  var ss = OT_book_(), off = OT_offDates_(), today = AC_today_(), next = OT_addDays(today, 1);
  while (!OT_isBusinessDay(next, off)) next = OT_addDays(next, 1);
  var info = OT_doneFromLog(OT_sheet_(ss, OT_LOG_SHEET, OT_LOG_HEADER).getDataRange().getValues()), tasks = OT_tasks_(ss), reqs = OT_requests_(ss);
  Logger.log('送り先：%s（%s件）', OT_groupDept_(), OT_groups_().length);
  [today, next].forEach(function (d) {
    var plan = OT_plan(tasks, d, Infinity, info.done, reqs);
    Logger.log('【%s】%s／件数 %s／合計 %s分', OT_md(d), OT_isBusinessDay(d, off) ? '朝に送る日' : '送らない日（「今日の業務」で返信）', plan.today.length, plan.total);
    plan.today.forEach(function (it, i) { Logger.log('%s. %s（%s分・期限 %s%s）', i + 1, it.name, it.minutes, it.deadline, it.overdue ? '・過ぎている' : ''); });
    Logger.log('手が空いたとき：%s', plan.extra.map(function (it) { return it.name; }).join('、') || 'なし');
  });
}
