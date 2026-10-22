/**
 * 【テスト用プロジェクト専用・本番には絶対に入れない】勤怠連絡フォームの部署別選択の確認
 *
 * 使い方：テスト用のApps Scriptプロジェクトに「コード.gs」（gas/AlcoholCheck.gs）とこのファイルを入れ、
 * ACT_COPY_FORM_ID にフォームのコピーのIDを入れてから、actPrepare → actSetupDepts → actDescribe →
 * actInstallTrigger の順に実行。フォームのコピーに回答した後、actShowSends で送信内容（の記録）を見る。
 *
 * 安全策：
 *  - LINEへは送らない（送信を記録に置き換える。さらにLINEのトークンを設定しないので、元の送信処理も動かない）
 *  - 本番のフォーム（公開URLの番号）なら中止
 *  - 本運用開始日を未来にしてテスト扱いにする（お知らせ停止シートへの登録をしない）
 *  - 従業員マスタ・LINEグループは読むだけ
 */
var ACT_COPY_FORM_ID = '';   // フォームのコピーのID（編集URLの /d/ と /edit の間）
var ACT_MASTER_ID = '1a8gBGm-adBHybREOOSLEjL9j4OHVwA0X_EdylHIZODU';   // 従業員マスタ（読み取りのみ）
var ACT_PROD_FORM_KEY = '1FAIpQLSfMc6SWJkjnJfqPfobUJt1NDvzQTuSjir97IMW_YTOctLJvFw';   // 本番フォームの公開URLの番号

// LINEへは送らず、記録だけする（宛先はIDを残さず「どのグループか」に置き換える）
AC_pushTo_ = function (to, text) { ACT_record_(to, text); };

function ACT_label_(to) {
  if (!to) return '管理者の個別LINE';
  try {
    var rows = SpreadsheetApp.openById(ACT_MASTER_ID).getSheetByName('LINEグループ').getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) if (String(rows[i][0]).trim() === to) return 'グループ「' + rows[i][1] + '」（' + rows[i][3] + '）';
  } catch (e) {}
  return '不明な宛先';
}
function ACT_record_(to, text) {
  var p = PropertiesService.getScriptProperties();
  var list = JSON.parse(p.getProperty('act:sends') || '[]');
  list.push({ at: new Date().toISOString(), to: ACT_label_(to), text: String(text).slice(0, 600) });
  p.setProperty('act:sends', JSON.stringify(list.slice(-30)));
}
function ACT_form_() {
  if (!ACT_COPY_FORM_ID) throw new Error('ACT_COPY_FORM_ID が空です');
  var form = FormApp.openById(ACT_COPY_FORM_ID);
  if (form.getPublishedUrl().indexOf(ACT_PROD_FORM_KEY) !== -1) throw new Error('本番のフォームです。中止しました');
  return form;
}

/** 1. 準備：安全確認と設定（本番のフォーム・LINEのトークンがあれば中止） */
function actPrepare() {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('LINE_CHANNEL_ACCESS_TOKEN')) throw new Error('LINEのトークンが設定されています。テスト用プロジェクトでは設定しないでください。中止しました');
  var form = ACT_form_();
  var dest = null; try { dest = form.getDestinationId(); } catch (e) { dest = null; }
  if (dest) { form.removeDestination(); Logger.log('コピーの回答先のつながりを外しました（コピーだけ。本番は変更なし）'); }
  p.setProperties({ EMPLOYEE_MASTER_ID: ACT_MASTER_ID, ATTENDANCE_FORM_ID: ACT_COPY_FORM_ID, FORM_LIVE_FROM: '2099-01-01' });
  p.deleteProperty('act:sends');
  AC_pushTo_('確認', '送信の置き換えの確認');
  var ok = JSON.parse(p.getProperty('act:sends') || '[]').length === 1;
  p.deleteProperty('act:sends');
  if (!ok) throw new Error('送信の置き換えが効いていません。中止しました');
  Logger.log('準備OK：フォーム「%s」（コピー）／LINEへは送らず記録のみ', form.getTitle());
}

/** 2. 部署別の設定（コピーに対して2回実行し、同じ形になることも確認） */
function actSetupDepts() {
  ACT_form_();
  alcoholCheckSetupFormDepts();
  var first = ACT_shape_();
  alcoholCheckSetupFormDepts();
  AC_refreshFormChoices_();   // 毎朝の更新
  Logger.log('2回目・毎朝の更新の後も同じ形：%s', JSON.stringify(first) === JSON.stringify(ACT_shape_()) ? 'はい' : 'いいえ（要確認）');
}

function ACT_shape_() {
  return ACT_form_().getItems().map(function (it) {
    var o = { type: String(it.getType()), title: it.getTitle() };
    if (it.getType() === FormApp.ItemType.LIST) {
      var ch = it.asListItem().getChoices();
      o.n = ch.length;
      o.go = ch.map(function (c) { var pg = c.getGotoPage(); return pg ? pg.getTitle() : (c.getPageNavigationType() ? String(c.getPageNavigationType()) : ''); }).filter(Boolean);
    }
    if (it.getType() === FormApp.ItemType.PAGE_BREAK) {
      var pb = it.asPageBreakItem(), g = pb.getGoToPage();
      o.afterPrev = g ? g.getTitle() : String(pb.getPageNavigationType());
    }
    return o;
  });
}

/** 3. フォームの形を表示（氏名は件数だけ） */
function actDescribe() {
  ACT_shape_().forEach(function (o, i) {
    Logger.log('%s. [%s] %s%s%s%s', i + 1, o.type, o.title, o.n != null ? '（選択肢 ' + o.n + '件）' : '',
      o.go && o.go.length ? ' → 移動先：' + o.go.join('／') : '', o.afterPrev ? ' ／前のページの後：' + o.afterPrev : '');
  });
}

/** 4. コピーのフォームの送信時トリガー（このテスト用プロジェクトだけ） */
function actInstallTrigger() {
  var form = ACT_form_();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'alcoholCheckOnAttendanceForm') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('alcoholCheckOnAttendanceForm').forForm(form).onFormSubmit().create();
  Logger.log('送信時トリガーを設定しました（テスト用プロジェクト・コピーのフォームのみ）：%s', form.getPublishedUrl());
}

/** 5. 送信内容（の記録）を表示 */
function actShowSends() {
  var list = JSON.parse(PropertiesService.getScriptProperties().getProperty('act:sends') || '[]');
  if (!list.length) Logger.log('記録なし');
  list.forEach(function (s, i) { Logger.log('%s. %s → %s\n%s', i + 1, s.at, s.to, s.text); });
}

/** 後片付け：トリガーを消す */
function actCleanup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('テスト用プロジェクトのトリガーを削除しました');
}
