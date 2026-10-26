/**
 * 【テスト用プロジェクト専用・本番には絶対に入れない】社員管理AI（第1段階）の結合テスト
 *
 * 使い方：テスト用のApps Scriptプロジェクトに gas/AlcoholCheck.gs・gas/EmployeeAdmin.gs・このファイルを入れ、
 *   1. eatSetup を実行（架空データのテスト用スプレッドシートを作り、テスト用の設定を入れる）
 *   2. eatRun を実行（模擬Webhookイベントで、申請→承認→反映→取消→期限切れ→安全対策を確かめる）
 *   結果は実行ログと、テスト用スプレッドシートの「テスト結果」シートに出る。
 *
 * 安全策：
 *  - LINEへは一切送らない（社員管理の送信は模擬に置き換え、既存の送信関数も記録だけにする。LINEのトークンがあれば中止）
 *  - 従業員マスタはテスト用スプレッドシート（名前が【テスト】で始まる・架空データ）だけ。本番の従業員マスタのIDなら中止
 *  - トリガーは作らない
 */
var EAT_PROD_MASTER_ID = '1a8gBGm-adBHybREOOSLEjL9j4OHVwA0X_EdylHIZODU';
var EAT_ADMIN_G = 'C' + 'a'.repeat(32), EAT_DEPT_G = 'C' + 'b'.repeat(32);
var EAT_ADMIN1 = 'U' + '1'.repeat(32), EAT_ADMIN2 = 'U' + '2'.repeat(32), EAT_OUT = 'U' + '9'.repeat(32), EAT_EMP1 = 'U' + '3'.repeat(32);
var EAT_HEAD14 = ['社員番号', '氏名', '別表記（シフト表の書き方が違う場合）', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時',
  'LINE確認済み', 'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];

// 既存の送信関数も記録だけにする（念のため）
var EAT_SENT = [];
AC_pushTo_ = function (to, text) { EAT_SENT.push({ type: 'push', to: to, text: text }); };
AC_reply_ = function (token, text) { EAT_SENT.push({ type: 'reply', text: text }); };

function EAT_fakeLine_() {
  var members = {}; members[EAT_ADMIN_G] = {}; members[EAT_ADMIN_G][EAT_ADMIN1] = '管理A'; members[EAT_ADMIN_G][EAT_ADMIN2] = '管理B';
  return {
    reply: function (rt, msgs) { EAT_SENT.push({ type: 'reply', text: msgs[0].text, quick: msgs[0].quickReply }); return true; },
    push: function (to, msgs) { EAT_SENT.push({ type: 'push', to: to, text: msgs[0].text }); return true; },
    memberProfile: function (g, u) { return members[g] && members[g][u] ? { displayName: members[g][u] } : null; },
  };
}

function EAT_guard_() {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('LINE_CHANNEL_ACCESS_TOKEN')) throw new Error('LINEのトークンが設定されています。テスト用プロジェクトではありません（中止）');
  var id = p.getProperty('EMPLOYEE_MASTER_ID');
  if (id === EAT_PROD_MASTER_ID) throw new Error('本番の従業員マスタが設定されています（中止）');
  if (id && SpreadsheetApp.openById(id).getName().indexOf('【テスト】') !== 0) throw new Error('テスト用スプレッドシートではありません（中止）');
  return p;
}

/** 1. テスト用スプレッドシート（架空データ）と設定を用意する */
function eatSetup() {
  var p = EAT_guard_();
  if (!p.getProperty('EMPLOYEE_MASTER_ID')) {
    var ss = SpreadsheetApp.create('【テスト】社員管理AI（架空データ）');
    p.setProperty('EMPLOYEE_MASTER_ID', ss.getId());
  }
  p.setProperties({ EA_MODE: 'on', EA_FORWARD_SECRET: Utilities.getUuid() + Utilities.getUuid() });
  p.deleteProperty('EA_AUTO_APPLY');
  EAT_reset_();
  Logger.log('テスト用スプレッドシート：%s', SpreadsheetApp.openById(p.getProperty('EMPLOYEE_MASTER_ID')).getUrl());
}

/** シートを架空データの初期状態に戻す */
function EAT_reset_() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('EMPLOYEE_MASTER_ID'));
  ['従業員マスタ', 'LINEグループ', 'お知らせ停止', '社員管理_申請', '社員管理_変更履歴', '社員管理_操作ログ', '別表記', 'テスト結果', 'LINE登録の要確認'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh) { if (ss.getSheets().length === 1) sh.setName('_tmp'); else ss.deleteSheet(sh); }
  });
  var m = ss.getSheetByName('_tmp') || ss.getSheets()[0];
  m.clear(); m.setName('従業員マスタ');
  m.getRange('A:A').setNumberFormat('@');
  m.getRange(1, 1, 4, 14).setValues([EAT_HEAD14,
    ['90001', '試験 一郎', '', '在籍', '部署A', EAT_EMP1, '一郎', '', true, true, '', '正社員', 501, ''],
    ['90002', '試験 二郎', 'しけん二郎', '在籍', '部署B', '', '', '', false, true, '', 'パート', 502, ''],
    ['90003', '試験 三郎', '', '退職', '部署A', '', '', '', false, false, '', '正社員', 503, "'2026-09-30"]]);
  m.getRange(2, 9, 3, 2).insertCheckboxes();
  ss.getSheets().filter(function (s) { return s.getName() !== '従業員マスタ'; }).forEach(function (s) { ss.deleteSheet(s); });
  var g = ss.insertSheet('LINEグループ');
  g.getRange(1, 1, 3, 4).setValues([['グループID', '部門（所属）', '登録日時', '状態'], [EAT_ADMIN_G, '勤怠管理', new Date(), '有効'], [EAT_DEPT_G, '部署A', new Date(), '有効']]);
  var pz = ss.insertSheet('お知らせ停止');
  pz.getRange(1, 1, 2, 6).setValues([['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）'],
    ["'90002", '試験 二郎', new Date(), new Date(), '手入力の休み', '全部']]);
}

/** 2. 結合テストを実行する */
function eatRun() {
  EAT_guard_();
  EAT_reset_();
  EAT_SENT = [];
  EA_lineClient_ = EAT_fakeLine_();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('EA_MODE', 'on');
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
  function reqs() { var s = ss.getSheetByName('社員管理_申請'); return s ? s.getDataRange().getValues().slice(1) : []; }
  function master() { return ss.getSheetByName('従業員マスタ').getDataRange().getValues(); }
  function approveText(r) { return r.quick.items[0].action.text; }
  function idOf(r) { var m = /（(EA-\d{8}-\d{3})）/.exec(r.text); return m ? m[1] : ''; }

  try {
    // --- 入社：申請 → 承認 → 反映（入社日＝今日） ---
    var hire = '【入社】\n社員番号：90100\n氏名：試験 花子\n入社日：' + today + '\n所属・拠点：部署A\n社員区分：社員\nTOTコード：600\nシフト表の書き方：はなこ\nアルコールチェック：対象';
    ok('一言で雛形', /【入社】/.test(send('入社').text));
    var a = send(hire);
    var id1 = idOf(a);
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
    ok('（回帰）フォームの選択肢に出る', AC_formChoices(master()).indexOf('試験 花子（90100）') !== -1);
    send('90100', 'U' + '5'.repeat(32), null);   // 本人のLINE登録（既存の1対1の処理）
    ok('（回帰）本人のLINE登録が新しい行に入る', master()[mv.length - 1][5] === 'U' + '5'.repeat(32), master()[mv.length - 1][5]);
    ok('反映済みは取消不可', /取消できません/.test(send('【取消】\n申請番号：' + id1).text));

    // --- 退社：承認でお知らせ停止 → 取消で戻す → 再申請 → 反映（退職日＝昨日） ---
    var ret = add(today, -1), last = add(today, -4);
    var retire = '【退社】\n社員番号：90001\n氏名：試験 一郎\n退職日：' + ret + '\n最終出社日：' + last;
    var c = send(retire);
    var id2 = idOf(c);
    ok('退社の申請（過去日付は警告）', /受け付けました/.test(c.text) && /過去の日付/.test(c.text), c.text);
    send(approveText(c));
    var pz = ss.getSheetByName('お知らせ停止').getDataRange().getValues();
    ok('お知らせ停止にAIの行', pz.length === 3 && pz[0][6] === '作成元' && pz[2][6] === '社員管理AI' && pz[2][7] === id2, JSON.stringify(pz[2]));
    var idx = AC_pauseIndex(pz, AC_toDateFn_());
    ok('（回帰）既存の停止判定が読める', AC_isPaused(idx, '90001', add(last, 1), 'alcohol') && !AC_isPaused(idx, '90001', last, 'alcohol'));
    ok('取消の一覧', send('取消').text.indexOf(id2) !== -1);
    ok('取消', /取り消しました/.test(send('【取消】\n申請番号：' + id2).text));
    var pz2 = ss.getSheetByName('お知らせ停止').getDataRange().getValues();
    ok('取消でAIの行だけ削除', pz2.length === 2 && pz2[1][4] === '手入力の休み', pz2.length);
    var d = send(retire);
    send(approveText(d));
    lines = EA_runDaily_(true);
    var r1 = master()[1];
    ok('退職の反映', r1[3] === '退職' && r1[13] === ret, r1[3] + ':' + Object.prototype.toString.call(r1[13]) + ':' + r1[13]);
    ok('（回帰）打刻のお知らせの対象から外れる', !AC_lineByTotCode(master(), today)['501']);
    ok('（回帰）退職扱い（退職日の翌日以降）', AC_isRetired(r1[13], today) === true);

    // --- 入力ミス・期限切れ・二重申請・パソコン版LINE ---
    ok('入力ミスは受け付けない', /受け付けできませんでした/.test(send('【入社】\n社員番号：90002\n氏名：\n入社日：2026-02-30').text));
    var e = send('【退社】\n社員番号：90002\n氏名：試験 二郎\n退職日：' + add(today, 20));
    ok('二重申請は警告', /同じ社員番号の申請/.test(send('【退社】\n社員番号：90002\n氏名：試験 二郎\n退職日：' + add(today, 21)).text));
    var rs = ss.getSheetByName('社員管理_申請'), rv = rs.getDataRange().getValues(), er = -1;
    for (var i = 1; i < rv.length; i++) if (rv[i][0] === idOf(e)) er = i + 1;
    rs.getRange(er, EA_R.at + 1).setValue(new Date(Date.now() - 73 * 3600 * 1000));   // 73時間前の申請にする
    ok('期限切れは承認不可', /過ぎています/.test(send(approveText(e)).text));
    ok('送信者不明（パソコン版LINE）は不可', /スマートフォン/.test(send(retire, null).text));

    // --- 安全対策 ---
    var n0 = reqs().length;
    ok('署名違いは拒否', post(forward([ev(hire)], 'wrong-secret')) === 'NG');
    ok('5分より古い転送は拒否', post(forward([ev(hire)], null, -301)) === 'NG');
    var f1 = forward([ev('【退社】\n社員番号：90002\n氏名：試験 二郎\n退職日：' + add(today, 30), undefined, undefined, 'EAT-SAME-' + Date.now())]);
    post(f1);
    ok('同じ転送の再送は拒否', post(f1) === 'NG');
    var same = JSON.parse(f1.payload).events;
    post(forward(same));
    ok('同じLINEイベントは1回だけ', reqs().length === n0 + 1, reqs().length - n0);
    var n1 = EAT_SENT.length;
    post({ destination: 'U', events: [ev(hire)] });
    ok('署名なしの直結経路では社員管理は動かない', reqs().length === n0 + 1 && EAT_SENT.length === n1);
    ok('勤怠管理以外のグループでは反応しない', send(hire, null, EAT_DEPT_G).sent.length === 0);
    props.setProperty('EA_MODE', 'off');
    ok('EA_MODE=off なら何もしない', send('入社').sent.length === 0);
    props.setProperty('EA_MODE', 'record');
    var nr = reqs().length;
    ok('記録のみモード', send(hire).sent.length === 0 && reqs().length === nr);
  } catch (err) {
    ok('実行中のエラー', false, err && err.stack ? err.stack : err);
  } finally {
    props.setProperty('EA_MODE', 'on');
    EA_lineClient_ = null;
  }
  var sh = ss.insertSheet('テスト結果');
  sh.getRange(1, 1, 1, 3).setValues([['結果', '確認内容', '詳細（失敗時）']]);
  sh.getRange(2, 1, results.length, 3).setValues(results);
  var fail = results.filter(function (r) { return r[0] !== 'PASS'; });
  Logger.log('社員管理AI 結合テスト（%s）：%s件中 %s件成功／失敗 %s件', EA_VERSION, results.length, results.length - fail.length, fail.length);
  fail.forEach(function (r) { Logger.log('FAIL %s：%s', r[1], r[2]); });
  return { total: results.length, fail: fail.length };
}
