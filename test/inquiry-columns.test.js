import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 「問い合わせ」タブの列を並べ替えても動くこと（gas/Inquiry.gs 版 2026-11-10e）。すべて架空データ・模擬環境（LINEへの送信なし）
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const GROUP = 'C' + 'a'.repeat(32);
const ADMIN = U(7), STAFF = U(8);
const MHEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const BASE = ['案件番号', '状態', '社員番号', '氏名', '所属', '紐付け', 'LINEユーザーID', 'LINE表示名', '受付日時',
  '内容（冒頭）', '機密あり', '最終受信日時', '追記の回数', '担当者', '担当者ID', '対応開始日時', '完了者', '完了者ID', '完了日時',
  '最後の追記通知', '合言葉', '作成時のイベント番号'];
// 管理本部が並べ替えた形（見せたい列を前に、非表示にしている列を後ろに。担当者と担当者ID・完了者と完了者IDも離す。
// 分類・要点は途中に、管理本部が足した「メモ」列もある）
const SHUFFLED = ['状態', '氏名', '所属', '分類', '要点', '受付日時', '内容（冒頭）', '担当者', 'メモ', '対応開始日時', '完了者', '完了日時',
  '最終受信日時', '追記の回数', '社員番号', '案件番号', '紐付け', 'LINEユーザーID', 'LINE表示名', '機密あり', '担当者ID', '完了者ID',
  '最後の追記通知', '合言葉', '作成時のイベント番号'];

function setup(header, props = { INQ_MODE: 'on' }, now = '2026-11-13T10:00:00+09:00') {
  const g = createGas({ files: ['AlcoholCheck.gs', 'Inquiry.gs'], now });
  const master = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = master.insertSheet('従業員マスタ');
  [MHEAD, ["'90001", '試験 一郎', '', '在籍', '部署A', U(1), '', '', true, true, '', '', '', '']].forEach((r) => m.appendRow(r));
  const gs = master.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [GROUP, '勤怠管理', '2026-10-15', '有効']].forEach((r) => gs.appendRow(r));
  const book = g.newSpreadsheet('【テスト】従業員問い合わせ管理（架空）');
  if (header) book.insertSheet('問い合わせ').appendRow(header);
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: master.getId(), INQ_SPREADSHEET_ID: book.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake',
    LINE_ADMIN_USER_ID: ADMIN, ...props });
  g.line.members[GROUP] = { [STAFF]: '担当A', [ADMIN]: '管理者' };
  g.line.profiles[U(1)] = 'いちろう'; g.line.profiles[ADMIN] = '管理者';
  return { g, book };
}
let seq = 0;
const userMsg = (userId, text) => ({ type: 'message', webhookEventId: 'evc' + ++seq, replyToken: 'rt-c' + seq, timestamp: 0,
  source: { type: 'user', userId }, message: { id: 'mc' + seq, type: 'text', text } });
const press = (data, userId = STAFF) => ({ type: 'postback', webhookEventId: 'evc' + ++seq, replyToken: 'rt-c' + seq,
  source: { type: 'group', groupId: GROUP, userId }, postback: { data } });
const post = (g, ...events) => g.ctx.doPost({ postData: { contents: JSON.stringify({ destination: 'x', events }) } });
// 1行目の見出しで、案件の行を「見出し → 値」にする
function rowsByName(book) {
  const v = book.getSheetByName('問い合わせ').dump();
  return v.slice(1).map((r) => Object.fromEntries(v[0].map((h, i) => [h, r[i]])));
}
const pushes = (g, n) => g.fetches.slice(n).filter((f) => f.url.endsWith('/push'));
const replies = (g, n) => g.fetches.slice(n).filter((f) => f.url.endsWith('/reply')).map((f) => f.body.messages[0].text);

test('INQ列: 見出しから列の位置（並べ替え・空白・同じ見出し・足りない見出し）', () => {
  const { g } = setup(null);
  const X = g.ctx;
  const ok = X.INQ_caseCols(SHUFFLED);
  assert.equal(ok.ok, true);
  assert.equal(ok.col.id, SHUFFLED.indexOf('案件番号'));
  assert.equal(ok.col.token, SHUFFLED.indexOf('合言葉'));
  assert.equal(ok.col.category, 3);
  assert.equal(X.INQ_caseCols(BASE).col.category, -1);                                         // 分類・要点は無くてもよい
  assert.equal(X.INQ_caseCols(BASE.map((h) => ' ' + h + ' ')).ok, true);                       // 前後の空白は無視
  const miss = X.INQ_caseCols(BASE.filter((h) => h !== '合言葉' && h !== '状態'));
  assert.equal(miss.ok, false);
  assert.deepEqual([...miss.missing], ['状態', '合言葉']);
  assert.match(X.INQ_colsMessage(miss), /見つからない見出し：状態、合言葉/);
  const dup = X.INQ_caseCols(BASE.concat(['担当者', 'メモ', 'メモ']));
  assert.equal(dup.ok, false);                                                                 // 必要な列の見出しが2つ → 決められない
  assert.deepEqual([...dup.dup], ['担当者']);                                                   // 管理本部の列（メモ）の重複は問題にしない
  const row = [...X.INQ_newCaseRow(ok.col, SHUFFLED.length, { id: 'Q-1', token: 'abc123' })];
  assert.equal(row.length, SHUFFLED.length);
  assert.equal(row[SHUFFLED.indexOf('案件番号')], 'Q-1');
  assert.equal(row[SHUFFLED.indexOf('合言葉')], 'abc123');
  assert.equal(row.filter((x) => x !== '').length, 2);
  assert.ok(g.ctx.INQ_VERSION >= '2026-11-10e');
});

test('INQ列: 並べ替えたシートで、受付・追記・ボタン・まとめ・分類の記入が正しい列に入る（メモの列は触らない）', () => {
  const { g, book } = setup(SHUFFLED);
  // 受付
  let n = g.fetches.length;
  post(g, userMsg(U(1), '11/8の退勤の打刻を忘れてしまいました'));
  let r = rowsByName(book);
  assert.equal(r.length, 1);
  assert.match(r[0]['案件番号'], /^Q-20261113-001$/);
  assert.equal(r[0]['状態'], '未対応');
  assert.equal(r[0]['社員番号'], '90001');
  assert.equal(r[0]['氏名'], '試験 一郎');
  assert.equal(r[0]['所属'], '部署A');
  assert.equal(r[0]['紐付け'], '登録済み');
  assert.equal(r[0]['LINEユーザーID'], U(1));
  assert.equal(r[0]['LINE表示名'], 'いちろう');
  assert.equal(r[0]['内容（冒頭）'], '11/8の退勤の打刻を忘れてしまいました');
  assert.equal(r[0]['機密あり'], false);
  assert.equal(r[0]['追記の回数'], 0);
  assert.match(r[0]['合言葉'], /^[a-f][0-9a-f]{5}$/);
  assert.equal(r[0]['作成時のイベント番号'], 'evc' + seq);
  assert.equal(r[0]['メモ'], '');
  let p = pushes(g, n);
  assert.equal(p.length, 1);
  const msg = p[0].body.messages[0];
  assert.deepEqual([...msg.contents.body.contents].map((x) => x.text).slice(1), ['試験 一郎（部署A）', '状況：未対応', '要約：勤怠・打刻／11/8／退勤／打刻', '内容：「11/8の退勤の打刻を忘れてしまいました」']);
  const data = msg.contents.footer.contents[0].action.data;
  assert.equal(data, `inq|1|take|${r[0]['案件番号']}|${r[0]['合言葉']}`);
  book.getSheetByName('問い合わせ').getRange(2, SHUFFLED.indexOf('メモ') + 1).setValue('管理本部のメモ');
  // 分類の記入（途中にある「分類」「要点」の列へ。末尾に列を足さない）
  g.ctx.alcoholCheckImportTot();
  r = rowsByName(book);
  assert.equal(r[0]['分類'], '勤怠・打刻');
  assert.equal(r[0]['要点'], '11/8／退勤／打刻');
  assert.equal(book.getSheetByName('問い合わせ').dump()[0].length, SHUFFLED.length);
  // ボタン：対応します（担当者・担当者ID・対応開始日時は離れた列）
  n = g.fetches.length;
  post(g, press(data));
  r = rowsByName(book);
  assert.equal(r[0]['状態'], '対応中');
  assert.equal(r[0]['担当者'], '担当A');
  assert.equal(r[0]['担当者ID'], STAFF);
  assert.ok(r[0]['対応開始日時'] instanceof Date || r[0]['対応開始日時']);
  assert.deepEqual(replies(g, n), ['試験 一郎（部署A）の問い合わせを、担当Aさんが対応中にしました。']);
  // 追記（対応中なので担当へ知らせる）
  g.clock.now += 5 * 60000;
  n = g.fetches.length;
  post(g, userMsg(U(1), '追加で質問です'));
  r = rowsByName(book);
  assert.equal(rowsByName(book).length, 1);
  assert.equal(r[0]['追記の回数'], 1);
  assert.ok(r[0]['最後の追記通知']);
  assert.ok(r[0]['最終受信日時']);
  assert.equal(pushes(g, n).length, 1);
  assert.match(pushes(g, n)[0].body.messages[0].text, /【問い合わせ・追記】試験 一郎（部署A）から追記があります。.*担当：担当A/);
  // まとめ
  g.clock.now = new Date('2026-11-13T15:00:00+09:00').getTime();
  n = g.fetches.length;
  g.ctx.INQ_remind();
  p = pushes(g, n);
  assert.equal(p.length, 1);
  assert.equal(p[0].body.messages[0].text, '【問い合わせ 未完了1件】11/13 15:00\n\n① 試験 一郎（部署A）\n状況：対応中（担当：担当A）\n要約：勤怠・打刻／11/8／退勤／打刻\n内容：「11/8の退勤の打刻を忘れてしまいました」');
  // ボタン：対応済みにする（完了者・完了者ID・完了日時）
  post(g, press(data.replace('|take|', '|done|'), ADMIN));
  r = rowsByName(book);
  assert.equal(r[0]['状態'], '対応済み');
  assert.equal(r[0]['完了者'], '管理者');
  assert.equal(r[0]['完了者ID'], ADMIN);
  assert.ok(r[0]['完了日時']);
  assert.equal(r[0]['担当者'], '担当A');                                                       // 担当者は変えない
  assert.equal(r[0]['メモ'], '管理本部のメモ');                                                 // 管理本部の列は触らない
  // 対応済みの後の新しい問い合わせは2件目の案件（見出しの位置に入る）
  post(g, userMsg(U(1), 'シフトの相談です'));
  r = rowsByName(book);
  assert.equal(r.length, 2);
  assert.equal(r[1]['状態'], '未対応');
  assert.equal(r[1]['案件番号'], 'Q-20261113-002');
  assert.equal(r[1]['LINEユーザーID'], U(1));
});

test('INQ列: 分類・要点の列が無いシートは、今までどおり末尾に足す（並べ替えたほかの列は動かさない）', () => {
  const head = SHUFFLED.filter((h) => h !== '分類' && h !== '要点');
  const { g, book } = setup(head, { INQ_MODE: 'record' });
  post(g, userMsg(U(1), '有給の残りを教えてください'));
  g.ctx.alcoholCheckImportTot();
  const v = book.getSheetByName('問い合わせ').dump();
  assert.deepEqual(v[0], head.concat(['分類', '要点']));
  const r = rowsByName(book);
  assert.equal(r[0]['分類'], '有給・休み');
  assert.equal(r[0]['案件番号'], 'Q-20261113-001');
});

test('INQ列: 見出しが足りないときは、その処理だけやめてエラーを記録する（doPost は止めない・本文は「やりとり」に残す）', () => {
  const head = SHUFFLED.filter((h) => h !== '合言葉');
  const { g, book } = setup(head);
  const before = book.getSheetByName('問い合わせ').dump();
  let n = g.fetches.length;
  const out = post(g, userMsg(U(1), '相談したいことがあります'), userMsg(U(1), '12345'));   // 2つ目（社員番号の登録）は今までどおり動く
  assert.equal(out.getContent(), 'OK');
  assert.deepEqual(book.getSheetByName('問い合わせ').dump(), before);                            // 案件の行は足さない
  const log = book.getSheetByName('やりとり').dump();
  assert.equal(log[1][2], '受付（保留：列の見出し）');
  assert.equal(log[1][3], '相談したいことがあります');
  const p = pushes(g, n);
  assert.equal(p.filter((x) => x.body.to === GROUP).length, 0);                                // グループへは送らない
  const admin = p.filter((x) => x.body.to === ADMIN).map((x) => x.body.messages[0].text);
  assert.ok(admin.some((t) => /【エラー】問い合わせの処理で問題がありました.*見つからない見出し：合言葉/s.test(t)), admin.join('\n'));
  assert.ok(!admin.join('\n').includes('相談したいこと'));                                       // エラーの知らせに本文を出さない
  assert.ok(replies(g, n).length >= 1);                                                        // 社員番号の登録の返信（既存の処理）は動いた
  // 同じ日の2件目：管理者へのエラーの知らせは1日1回
  n = g.fetches.length;
  post(g, userMsg(U(1), 'もう一度送ります'));
  assert.equal(pushes(g, n).filter((x) => x.body.to === ADMIN && /【エラー】問い合わせ/.test(x.body.messages[0].text)).length, 0);
  // まとめ・分類の記入も、送らず・書かずにやめる（エラーは記録）
  n = g.fetches.length;
  g.ctx.INQ_remind();
  assert.equal(pushes(g, n).filter((x) => x.body.to === GROUP).length, 0);
  assert.equal(g.ctx.INQ_classifyFill_(), 0);
  assert.ok(g.logs.some((l) => /列の見出しに問題があります（見つからない見出し：合言葉）/.test(l)));
  assert.equal(g.ctx.inqClassifyPreview().count, 0);
});

test('INQ列: ボタンを押したときに見出しが足りなければ、押した人へ知らせて何も変えない', () => {
  const { g, book } = setup(SHUFFLED);
  post(g, userMsg(U(1), '相談です'));
  const r = rowsByName(book)[0];
  const data = `inq|1|take|${r['案件番号']}|${r['合言葉']}`;
  book.getSheetByName('問い合わせ').getRange(1, SHUFFLED.indexOf('担当者ID') + 1).setValue('担当者のID（名前を変えた）');
  const n = g.fetches.length;
  post(g, press(data));
  assert.deepEqual(replies(g, n), ['シートの列の見出しに問題があるため、受け付けできませんでした。管理者へ知らせました。']);
  const v = book.getSheetByName('問い合わせ').dump();
  assert.equal(v[1][SHUFFLED.indexOf('状態')], '未対応');                                       // 状態は変えない
  assert.equal(v[1][SHUFFLED.indexOf('担当者')], '');
});

test('INQ列: INQ_setup は見出しを確かめて実行ログに出すだけ（直さない）', () => {
  const head = SHUFFLED.filter((h) => h !== '完了者ID');
  const { g, book } = setup(head, { INQ_MODE: 'record' });
  g.ctx.INQ_setup();
  assert.deepEqual(book.getSheetByName('問い合わせ').dump()[0], head);
  assert.ok(g.logs.some((l) => /列の見出し/.test(l) && /「問い合わせ」タブの列の見出しに問題があります（見つからない見出し：完了者ID）/.test(l)));   // 模擬環境のログは %s を埋めない
  const ok = setup(SHUFFLED, { INQ_MODE: 'record' });
  ok.g.ctx.INQ_setup();
  assert.ok(ok.g.logs.some((l) => /列の見出し/.test(l) && /OK（並べ替え・非表示でも動きます）/.test(l)));
});
