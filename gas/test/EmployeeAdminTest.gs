/**
 * 【テスト用プロジェクト専用・本番には絶対に入れない】社員管理AI（第1段階）の結合テスト
 *
 * 使い方：テスト用のApps Scriptプロジェクトに gas/EmployeeAdmin.gs・gas/EmployeeAdminHost.gs・このファイルを入れ、
 *   1. eatSetup を実行（架空データのテスト用スプレッドシートを作り、テスト用の設定を入れる）
 *   2. eatRun を実行（署名つき転送の模擬イベントで、申請→承認→反映→取消→期限切れ→安全対策を確かめる）
 *   結果は実行ログと、テスト用スプレッドシートの「テスト結果」シートに出る。
 *   ウェブアプリとしての確認：eatWebappOn → ウェブアプリにデプロイ → 外から署名つき転送を送る → eatWebappReport → eatWebappOff
 *
 * 安全策：
 *  - LINEへは一切送らない（送信を模擬に置き換える。LINEのトークンが設定されていれば中止）
 *  - 従業員マスタはテスト用スプレッドシート（名前が【テスト】で始まる・架空データ）だけ。本番の従業員マスタのIDなら中止
 *  - トリガーは作らない
 */
var EAT_PROD_MASTER_ID = '1a8gBGm-adBHybREOOSLEjL9j4OHVwA0X_EdylHIZODU';
var EAT_ADMIN_G = 'C' + 'e'.repeat(32), EAT_DEPT_G = 'C' + 'b'.repeat(32);
var EAT_ADMIN1 = 'U' + '1'.repeat(32), EAT_ADMIN2 = 'U' + '2'.repeat(32), EAT_OUT = 'U' + '9'.repeat(32), EAT_EMP1 = 'U' + '3'.repeat(32);
var EAT_HEAD14 = ['社員番号', '氏名', '別表記（シフト表の書き方が違う場合）', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時',
  'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
var EAT_SENT = [];

function EAT_fakeLine_(toSheet) {
  var members = {}; members[EAT_ADMIN_G] = {}; members[EAT_ADMIN_G][EAT_ADMIN1] = '管理A'; members[EAT_ADMIN_G][EAT_ADMIN2] = '管理B';
  var rec = function (x) {
    EAT_SENT.push(x);
    if (toSheet) { try { EA_appendRow_(EA_sheet_('テスト送信記録', ['日時', '種類', '宛先', '本文']), [new Date(), x.type, x.to || '', x.text]); } catch (e) {} }
  };
  return {
    reply: function (rt, msgs) { rec({ type: 'reply', text: msgs[0].text, quick: msgs[0].quickReply }); return true; },
    push: function (to, msgs) { rec({ type: 'push', to: to, text: msgs[0].text }); return true; },
    memberProfile: function (g, u) { return members[g] && members[g][u] ? { displayName: members[g][u] } : null; },
  };
}
// ウェブアプリとしての確認中だけ、受信のたびに模擬LINEを使う（送信内容は「テスト送信記録」シートへ）
if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties().getProperty('EAT_WEBAPP_TEST') === 'true') {
  EA_lineClient_ = EAT_fakeLine_(true);
}

function EAT_guard_() {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('EA_LINE_CHANNEL_TOKEN') || p.getProperty('LINE_CHANNEL_ACCESS_TOKEN')) throw new Error('LINEのトークンが設定されています。テスト用プロジェクトではありません（中止）');
  var id = p.getProperty('EMPLOYEE_MASTER_ID');
  if (id === EAT_PROD_MASTER_ID) throw new Error('本番の従業員マスタが設定されています（中止）');
  if (id && SpreadsheetApp.openById(id).getName().indexOf('【テスト】') !== 0) throw new Error('テスト用スプレッドシートではありません（中止）');
  return p;
}

/** 1. テスト用スプレッドシート（架空データ）と設定を用意する */
function eatSetup() {
  var p = EAT_guard_();
  if (!p.getProperty('EMPLOYEE_MASTER_ID')) p.setProperty('EMPLOYEE_MASTER_ID', SpreadsheetApp.create('【テスト】社員管理AI（架空データ）').getId());
  if (!p.getProperty('EA_FORWARD_SECRET')) p.setProperty('EA_FORWARD_SECRET', Utilities.getUuid() + Utilities.getUuid());
  p.setProperties({ EA_MODE: 'on', EA_ADMIN_GROUP_ID: EAT_ADMIN_G });
  p.deleteProperty('EA_AUTO_APPLY');
  EAT_reset_();
  Logger.log('テスト用スプレッドシート：%s', SpreadsheetApp.openById(p.getProperty('EMPLOYEE_MASTER_ID')).getUrl());
}

/** シートを架空データの初期状態に戻す */
function EAT_reset_() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('EMPLOYEE_MASTER_ID'));
  var keep = ss.getSheets()[0];
  keep.clear(); keep.setName('従業員マスタ');
  ss.getSheets().forEach(function (s) { if (s.getSheetId() !== keep.getSheetId()) ss.deleteSheet(s); });   // 同じシートでも別の物として返るためIDで比べる
  keep.getRange(1, 1, 4, 14).setValues([EAT_HEAD14,
    ["'90001", '試験 一郎', '', '在籍', '部署A', EAT_EMP1, '一郎', '', true, true, '', '正社員', 501, ''],
    ["'90002", '試験 二郎', 'しけん二郎', '在籍', '部署B', '', '', '', false, true, '', 'パート', 502, ''],
    ["'90003", '試験 三郎', '', '退職', '部署A', '', '', '', false, false, '', '正社員', 503, "'2026-09-30"]]);
  keep.getRange(2, 9, 3, 2).insertCheckboxes();
  var pz = ss.insertSheet('お知らせ停止');
  pz.getRange(1, 1, 2, 6).setValues([['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）'],
    ["'90002", '試験 二郎', new Date(), new Date(), '手入力の休み', '全部']]);
  employeeAdminSetup();
}

/** 2. 結合テストを実行する */
function eatRun() {
  EAT_guard_();
  EAT_reset_();
  EAT_SENT = [];
  EA_lineClient_ = EAT_fakeLine_(false);
  var props = PropertiesService.getScriptProperties();
  props.setProperties({ EA_MODE: 'on', EA_ADMIN_GROUP_ID: EAT_ADMIN_G });
  props.deleteProperty('EA_AUTO_APPLY');
  var secret = props.getProperty('EA_FORWARD_SECRET');
  var ss = SpreadsheetApp.openById(props.getProperty('EMPLOYEE_MASTER_ID'));
  var results = [], seq = 0;
  var ok = function (name, cond, info) { results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : String(info == null ? '' : info).slice(0, 300)]); };
  var today = AC_today_(), add = EA_addDays;

  function ev(text, userId, groupId, id) {
    seq++;
    var src = groupId === null ? { type: 'user', userId: userId } : { type: 'group', groupId: groupId || EAT_ADMIN_G };
    if (groupId !== null && userId !== null) src.userId = userId || EAT_ADMIN1;
    return { type: 'message', webhookEventId: id || ('EAT' + Date.now() + '-' + seq), replyToken: 'rt' + seq, timestamp: Date.now(),
      source: src, message: { type: 'text', id: 'm' + seq, text: text } };
  }
  function forward(events, secretToUse, tsShift) {
    var payload = JSON.stringify({ destination: 'Utest', events: events });
    var ts = Math.floor(Date.now() / 1000) + (tsShift || 0), nonce = Utilities.getUuid();
    return { type: 'line-verified', ts: ts, nonce: nonce, payload: payload, sig: EA_hmacHex_(secretToUse || secret, ts + '.' + nonce + '.' + payload) };
  }
  function post(body) { return doPost({ postData: { contents: JSON.stringify(body) } }).getContent(); }
  function send(text, userId, groupId, id) {
    var n = EAT_SENT.length;
    var out = post(forward([ev(text, userId, groupId, id)]));
    var sent = EAT_SENT.slice(n);
    return { out: out, sent: sent, text: sent.map(function (s) { return s.text; }).join('\n---\n'), quick: sent[0] && sent[0].quick };
  }
  function reqs() { return ss.getSheetByName('社員管理_申請').getDataRange().getValues().slice(1); }
  function master() { return ss.getSheetByName('従業員マスタ').getDataRange().getValues(); }
  function approveText(r) { return r.quick.items[0].action.text; }
  function idOf(r) { var m = /（(EA-\d{8}-\d{3})）/.exec(r.text); return m ? m[1] : ''; }

  try {
    // --- 入社：申請 → 承認 → 反映（入社日＝今日） ---
    var hire = '【入社】\n社員番号：90100\n氏名：試験 花子\n入社日：' + today + '\n所属・拠点：部署A\n社員区分：社員\nTOTコード：600\nシフト表の書き方：はなこ\nアルコールチェック：対象';
    ok('一言で雛形', /【入社】/.test(send('入社').text));
    var a = send(hire), id1 = idOf(a);
    ok('入社の申請を受付', /受け付けました/.test(a.text) && a.quick && a.quick.items.length === 2, a.text);
    ok('グループ外は承認不可', /確認できなかった/.test(send(approveText(a), EAT_OUT).text));
    ok('承認コード違いは不可', /承認コードが違います/.test(send('承認 ' + id1 + ' 000000').text));
    var b = send(approveText(a), EAT_ADMIN2);
    ok('別のメンバーが承認→予約', /承認しました/.test(b.text) && reqs()[0][1] === '予約', b.text);
    ok('承認の使い回し不可', /その操作はできません/.test(send(approveText(a)).text));
    var lines = EA_runDaily_(true);
    ok('反映処理', lines.length === 1 && /反映しました/.test(lines[0]), lines.join(' / '));
    var mv = master(), row = mv[mv.length - 1];
    ok('O列見出し', mv[0][14] === '入社日', mv[0][14]);
    ok('新しい行：社員番号は文字', row[0] === '90100', typeof row[0] + ':' + row[0]);
    ok('新しい行：入社日は文字', row[14] === today, Object.prototype.toString.call(row[14]) + ':' + row[14]);
    ok('新しい行：退職日は空', row[13] === '', row[13]);
    ok('新しい行：TOTコード・区分・チェック', String(row[12]) === '600' && row[11] === '正社員' && row[8] === false && row[9] === true, row.join('|'));
    ok('完了報告は勤怠管理グループへ', EAT_SENT.some(function (s) { return s.type === 'push' && s.to === EAT_ADMIN_G && /反映しました/.test(s.text); }));
    ok('別表記シート', ss.getSheetByName('別表記').getDataRange().getValues()[1][1] === 'はなこ');
    ok('変更履歴', ss.getSheetByName('社員管理_変更履歴').getLastRow() >= 2);
    ok('反映済みは取消不可', /取消できません/.test(send('【取消】\n申請番号：' + id1).text));

    // --- 退社：承認でお知らせ停止 → 取消で戻す → 再申請 → 反映（退職日＝昨日） ---
    var ret = add(today, -1), last = add(today, -4);
    var retire = '【退社】\n社員番号：90001\n氏名：試験 一郎\n退職日：' + ret + '\n最終出社日：' + last;
    var c = send(retire), id2 = idOf(c);
    ok('退社の申請（過去日付は警告）', /受け付けました/.test(c.text) && /過去の日付/.test(c.text), c.text);
    send(approveText(c));
    var pz = ss.getSheetByName('お知らせ停止').getDataRange().getValues();
    ok('お知らせ停止にAIの行', pz.length === 3 && pz[0][6] === '作成元' && pz[2][6] === '社員管理AI' && pz[2][7] === id2, JSON.stringify(pz[2]));
    ok('お知らせ停止の日付は日付型', Object.prototype.toString.call(pz[2][2]) === '[object Date]'
      && Utilities.formatDate(pz[2][2], AC_TZ, 'yyyy-MM-dd') === add(last, 1) && Utilities.formatDate(pz[2][3], AC_TZ, 'yyyy-MM-dd') === ret);
    ok('取消の一覧', send('取消').text.indexOf(id2) !== -1);
    ok('取消', /取り消しました/.test(send('【取消】\n申請番号：' + id2).text));
    var pz2 = ss.getSheetByName('お知らせ停止').getDataRange().getValues();
    ok('取消でAIの行だけ削除', pz2.length === 2 && pz2[1][4] === '手入力の休み', pz2.length);
    var d = send(retire);
    send(approveText(d));
    EA_runDaily_(true);
    var r1 = master()[1];
    ok('退職の反映（退職日は文字）', r1[3] === '退職' && r1[13] === ret, r1[3] + ':' + Object.prototype.toString.call(r1[13]) + ':' + r1[13]);

    // --- 承認と同時の反映（自動反映が有効・反映日が今日以前） ---
    props.setProperty('EA_AUTO_APPLY', 'true');
    var g2 = send('【退社】\n社員番号：90002\n氏名：試験 二郎\n退職日：' + add(today, -1));
    var g3 = send(approveText(g2));
    ok('承認と同時に反映', /このあとすぐ/.test(g3.text) && master()[2][3] === '退職' && master()[2][13] === add(today, -1), master()[2][3] + ':' + master()[2][13]);
    props.deleteProperty('EA_AUTO_APPLY');

    // --- 入力ミス・期限切れ・二重申請・パソコン版LINE ---
    ok('入力ミスは受け付けない', /受け付けできませんでした/.test(send('【入社】\n社員番号：90001\n氏名：\n入社日：2026-02-30').text));
    var hire2 = hire.replace('90100', '90200').replace('TOTコード：600', 'TOTコード：').replace(today, add(today, 10));
    var e = send(hire2);
    ok('二重申請は警告', /同じ社員番号の申請/.test(send(hire2).text));
    var rs = ss.getSheetByName('社員管理_申請'), rv = rs.getDataRange().getValues(), er = -1;
    for (var i = 1; i < rv.length; i++) if (rv[i][0] === idOf(e)) er = i + 1;
    rs.getRange(er, EA_R.at + 1).setValue(new Date(Date.now() - 73 * 3600 * 1000));   // 73時間前の申請にする
    ok('期限切れは承認不可', /過ぎています/.test(send(approveText(e)).text));
    ok('送信者不明（パソコン版LINE）は不可', /スマートフォン/.test(send(retire, null).text));

    // --- 安全対策 ---
    var n0 = reqs().length;
    var hire3 = hire.replace('90100', '90400').replace('TOTコード：600', 'TOTコード：').replace(today, add(today, 10));
    ok('合言葉違いは拒否', post(forward([ev(hire3)], 'wrong-secret')) === 'NG');
    ok('5分より古い転送は拒否', post(forward([ev(hire3)], null, -301)) === 'NG');
    var f0 = forward([ev(hire3)]);
    f0.payload = f0.payload.replace('90400', '90999');
    ok('本文の差し替えは拒否', post(f0) === 'NG');
    ok('署名の無いLINEの本文は拒否', post({ destination: 'U', events: [ev(hire3)] }) === 'NG');
    ok('ここまで何も記録しない', reqs().length === n0, reqs().length - n0);
    var f1 = forward([ev(hire3, undefined, undefined, 'EAT-SAME-' + Date.now())]);
    post(f1);
    ok('同じ転送の使い回しは拒否', post(f1) === 'NG');
    post(forward(JSON.parse(f1.payload).events));
    ok('同じLINEイベントは1回だけ', reqs().length === n0 + 1, reqs().length - n0);
    ok('勤怠管理以外のグループでは反応しない', send(hire3, undefined, EAT_DEPT_G).sent.length === 0);
    var jn = EAT_SENT.length;
    post(forward([{ type: 'join', webhookEventId: 'EATJ' + Date.now(), replyToken: 'rj', source: { type: 'group', groupId: EAT_ADMIN_G } }]));
    var lg = ss.getSheetByName('社員管理_操作ログ').getDataRange().getValues();
    ok('グループ参加でグループIDを記録', /設定済み/.test(lg[lg.length - 1][7]) && EAT_SENT.length === jn + 1);
    props.setProperty('EA_MODE', 'off');
    ok('EA_MODE=off なら何もしない', send('入社').sent.length === 0);
    props.setProperty('EA_MODE', 'record');
    var nr = reqs().length;
    ok('記録のみモード', send(hire3.replace('90400', '90500')).sent.length === 0 && reqs().length === nr);
  } catch (err) {
    ok('実行中のエラー', false, err && err.stack ? err.stack : err);
  } finally {
    props.setProperty('EA_MODE', 'on');
    props.deleteProperty('EA_AUTO_APPLY');
    EA_lineClient_ = null;
  }
  var sh = ss.insertSheet('テスト結果');
  sh.getRange(1, 1, 1, 3).setValues([['結果', '確認内容', '詳細（失敗時）']]);
  sh.getRange(2, 1, results.length, 3).setValues(results);
  var fail = results.filter(function (r) { return r[0] !== 'PASS'; });
  Logger.log('社員管理AI 結合テスト（%s）：%s件中 %s件成功／失敗 %s件', EA_VERSION, String(results.length), String(results.length - fail.length), String(fail.length));
  fail.forEach(function (r) { Logger.log('FAIL %s：%s', r[1], r[2]); });
  return { total: results.length, fail: fail.length };
}

// ---- ウェブアプリとしての確認（外から実際に POST する） ----
function eatWebappOn() {
  var p = EAT_guard_();
  EAT_reset_();
  p.setProperties({ EAT_WEBAPP_TEST: 'true', EA_MODE: 'on', EA_ADMIN_GROUP_ID: EAT_ADMIN_G });
  p.deleteProperty('EA_AUTO_APPLY');
  Logger.log('ウェブアプリ確認を開始しました（模擬LINE）');
}
/** 確認用の合言葉を一時的に表示する（テスト用プロジェクト専用。確認後は eatWebappOff で作り直す） */
function eatWebappSecret() { EAT_guard_(); Logger.log(PropertiesService.getScriptProperties().getProperty('EA_FORWARD_SECRET')); }
function eatWebappReport() {
  var ss = SpreadsheetApp.openById(EAT_guard_().getProperty('EMPLOYEE_MASTER_ID'));
  var req = ss.getSheetByName('社員管理_申請').getDataRange().getValues().slice(1).map(function (r) { return r[0] + '／' + r[1] + '／' + r[2] + '／' + r[3]; });
  var sent = ss.getSheetByName('テスト送信記録');
  Logger.log('申請：%s件 %s', String(req.length), req.join('　'));
  Logger.log('送信記録：%s件', String(sent ? sent.getLastRow() - 1 : 0));
  return { requests: req, sent: sent ? sent.getLastRow() - 1 : 0 };
}
function eatWebappOff() {
  var p = EAT_guard_();
  p.deleteProperty('EAT_WEBAPP_TEST');
  p.setProperty('EA_FORWARD_SECRET', Utilities.getUuid() + Utilities.getUuid());   // 表示した合言葉は使えなくする
  Logger.log('ウェブアプリ確認を終了しました（合言葉を作り直しました）');
}
