import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 問い合わせの分類・要点（gas/Inquiry.gs）。すべて架空の本文・模擬環境（LINEへの送信なし・外部のAIは使わない）
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const row = (code, name, userId) => ["'" + code, name, '', '在籍', '部署A', userId, '', '', true, true, '', '', '', ''];

function setup(props = { INQ_MODE: 'record' }) {
  const g = createGas({ files: ['AlcoholCheck.gs', 'Inquiry.gs'], now: '2026-11-10T10:00:00+09:00' });
  const master = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = master.insertSheet('従業員マスタ');
  [HEAD, row('90001', '試験 一郎', U(1)), row('90002', '試験 二郎', U(2)), row('90003', '試験 三郎', U(3)), row('90004', '試験 四郎', U(4))].forEach((r) => m.appendRow(r));
  master.insertSheet('LINEグループ').appendRow(['グループID', '部門（所属）', '登録日時', '状態']);
  const book = g.newSpreadsheet('【テスト】従業員問い合わせ管理（架空）');
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: master.getId(), INQ_SPREADSHEET_ID: book.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake',
    LINE_ADMIN_USER_ID: U(7), ...props });
  [1, 2, 3, 4].forEach((n) => { g.line.profiles[U(n)] = 'ひょうじ' + n; });
  return { g, book };
}
let seq = 0;
const msg = (userId, text) => ({ type: 'message', webhookEventId: 'ev' + ++seq, replyToken: 'rt' + seq, timestamp: 0,
  source: { type: 'user', userId }, message: { id: 'm' + seq, type: 'text', text } });
const post = (g, ...events) => g.ctx.doPost({ postData: { contents: JSON.stringify({ destination: 'x', events }) } });
const caseRows = (book) => book.getSheetByName('問い合わせ').dump();

test('INQ分類: キーワードで分類と要点（純粋関数）', () => {
  const { g } = setup();
  const c = (t) => ({ ...g.ctx.INQ_classify(t) });
  assert.deepEqual(c('今月の給与明細はいつ見られますか？'), { category: '⚠給与・明細', point: '給与／明細' });
  assert.deepEqual(c('11/8の退勤の打刻を忘れてしまいました。どうすればいいですか'), { category: '勤怠・打刻', point: '11/8／退勤／打刻' });
  assert.equal(c('11月８日の出勤打刻が抜けています').point, '11/8／出勤／打刻');                 // 全角数字・「月日」も
  assert.deepEqual(c('先日の件ですが、ご都合のよいときにお電話ださい。よろしくお願いします'), { category: 'その他', point: '先日の件ですが、ご都合のよいときにお電話' });
  assert.equal(c('体調が悪いので明日休みます').category, '⚠健康・体調');                          // ⚠の分類を優先
  assert.equal(c('口座を変えたいです').category, '⚠口座・マイナンバー');
  assert.equal(c('来月のシフトの希望休について').category, 'シフト・希望休');
  assert.equal(c('アルコールチェッカーが壊れました').category, 'アルコールチェック');
  assert.equal(c('住所が変わったので書類を出したい').category, '書類・手続き');
  assert.equal(c('有給はあと何日ありますか').category, '有給・休み');
  assert.equal(c('免許の更新をしました').category, '車両・免許');
  assert.ok(Array.from(c('11/8と11/9と11/10の打刻と退勤と休憩と遅刻の件で長い長い文章です').point).length <= 30);
  assert.equal(c('（画像）').category, 'その他');
  // キーワードは定数の一覧を差し替えて足せる
  assert.equal(g.ctx.INQ_classify('制服のサイズ', [{ name: '制服', words: ['制服'] }]).category, '制服');
});

test('INQ分類: 1時間ごとの処理で「分類」が空の行だけ埋める。既存の列は動かさず、手で直した値は上書きしない', () => {
  const { g, book } = setup();
  post(g, msg(U(1), '今月の給与明細はいつ見られますか？'));
  post(g, msg(U(2), '11/8の退勤の打刻を忘れてしまいました。どうすればいいですか'));
  post(g, msg(U(3), '先日の件ですが、ご都合のよいときにお電話ださい'));
  const before = caseRows(book);
  assert.equal(before[0].length, 22);
  const n = g.fetches.length;
  g.ctx.alcoholCheckImportTot();
  assert.equal(g.fetches.filter((f, i) => i >= n && f.url.endsWith('/push')).length, 0);   // LINEは送らない
  const after = caseRows(book);
  assert.deepEqual(after[0].slice(0, 22), before[0]);                                         // 既存の列の順番はそのまま
  assert.deepEqual(after[0].slice(22), ['分類', '要点']);
  assert.deepEqual(after.slice(1).map((r) => r.slice(0, 22)), before.slice(1));               // 既存の値もそのまま
  assert.deepEqual(after.slice(1).map((r) => [r[22], r[23]]), [['⚠給与・明細', '給与／明細'], ['勤怠・打刻', '11/8／退勤／打刻'], ['その他', '先日の件ですが、ご都合のよいときにお電話']]);
  // 手で直す → 次の回でも上書きしない。新しい行だけ埋める
  const sh = book.getSheetByName('問い合わせ');
  sh.getRange(2, 23).setValue('給与（手で修正）');
  sh.getRange(4, 24).setValue('折り返しの電話');
  sh.getRange(4, 23).setValue('');                                                            // 分類だけ空 → 分類は埋め、要点は残す
  post(g, msg(U(4), 'アルコールチェッカーが壊れました'));
  g.ctx.alcoholCheckImportTot();
  const again = caseRows(book).slice(1).map((r) => [r[22], r[23]]);
  assert.deepEqual(again, [['給与（手で修正）', '給与／明細'], ['勤怠・打刻', '11/8／退勤／打刻'], ['その他', '折り返しの電話'], ['アルコールチェック', 'アルコール／チェッカー']]);
});

test('INQ分類: 本文は「やりとり」の最初の受信（追記ではなく）から。機密の言葉は伏せた本文で判定', () => {
  const { g, book } = setup();
  post(g, msg(U(1), '11/3の打刻が漏れていました'));
  post(g, msg(U(1), '給料の件も追加で'));                                                     // 同じ案件への追記
  post(g, msg(U(2), 'マイナンバーは 1234 5678 9012 です'));
  g.ctx.alcoholCheckImportTot();
  const r = caseRows(book).slice(1);
  assert.deepEqual([r[0][22], r[0][23]], ['勤怠・打刻', '11/3／打刻']);
  assert.equal(r[1][22], '⚠口座・マイナンバー');
  assert.ok(!/1234|5678|9012/.test(r[1][23]));
});

test('INQ分類: INQ_MODE が off なら何もしない。確認用の関数は書かずに件数と内訳だけ（本文・氏名は出さない）', () => {
  const { g, book } = setup();
  post(g, msg(U(1), '今月の給与明細はいつ見られますか？'));
  post(g, msg(U(2), '11/8の退勤の打刻を忘れてしまいました'));
  g.scriptProps.setProperty('INQ_MODE', 'off');
  g.ctx.alcoholCheckImportTot();
  assert.equal(caseRows(book)[0].length, 22);
  g.scriptProps.setProperties({ INQ_MODE: 'record', INQ_CLASSIFY: 'off' });
  g.ctx.alcoholCheckImportTot();
  assert.equal(caseRows(book)[0].length, 22);                                                // INQ_CLASSIFY=off でも埋めない
  const l = g.logs.length;
  const res = g.ctx.inqClassifyPreview();
  assert.equal(caseRows(book)[0].length, 22);                                                // 書かない
  assert.equal(res.count, 2);
  assert.deepEqual({ ...res.byCategory }, { '⚠給与・明細': 1, '勤怠・打刻': 1 });
  const log = g.logs.slice(l).join('\n');
  assert.match(log, /埋める行：2件/); assert.match(log, /⚠給与・明細 1件／勤怠・打刻 1件/);
  assert.ok(!/明細はいつ|忘れて|試験|ひょうじ|11\/8/.test(log));
});

test('INQ分類: Inquiry.gs が無くても1時間ごとの処理はエラーにならない', () => {
  const g = createGas({ files: ['AlcoholCheck.gs'], now: '2026-11-10T10:00:00+09:00' });
  g.ctx.alcoholCheckImportTot();
  assert.ok(true);
});

test('INQ分類: まとめのお知らせはシートの「分類」「要点」を使う。確認用の関数は件数と文字数だけ（氏名・本文は出さない）', () => {
  const { g, book } = setup({ INQ_MODE: 'record' });
  post(g, msg(U(1), '今月の給与明細はいつ見られますか？'));
  post(g, msg(U(2), '11/8の退勤の打刻を忘れてしまいました'));
  g.ctx.alcoholCheckImportTot();
  book.getSheetByName('問い合わせ').getRange(3, 23).setValue('勤怠（手で修正）');
  const text = g.ctx.INQ_remindText(g.ctx.INQ_cases_(book.getSheetByName('問い合わせ')), new Date('2026-11-10T15:00:00+09:00'));
  assert.match(text, /^【問い合わせ 未完了2件】11\/10 15:00/);
  assert.match(text, /要約：⚠給与・明細\n内容：（内容はチャットで確認してください）/);   // 要注意の分類：分類名だけ（2026-11-10c）
  assert.ok(!text.includes('給与明細はいつ'));
  assert.match(text, /要約：勤怠（手で修正）／11\/8／退勤／打刻/);
  const n = g.fetches.length, l = g.logs.length;
  const res = g.ctx.INQ_remindPreview();
  g.ctx.INQ_remind();                                                                         // record の間は送らない
  assert.equal(g.fetches.length, n);
  assert.equal(res.count, 2);
  const log = g.logs.slice(l).join('\n');
  assert.match(log, /未完了 2件（未対応 2件・対応中 0件）／文字数 \d+/);
  assert.ok(!/試験|給与|打刻|ひょうじ/.test(log));
});

test('INQ分類: ハラスメント・人間関係（⚠・ほかの⚠と同数なら優先）と、要注意の分類の判定', () => {
  const { g } = setup();
  const c = (t) => g.ctx.INQ_classify(t).category;
  for (const t of ['パワハラについて相談したいです', 'セクハラを受けました', 'モラハラかもしれません', '職場の人間関係で悩んでいます',
    'いじめのような嫌がらせがあります', 'ハラスメントの相談窓口はどこですか', 'マタハラの相談']) {
    assert.equal(c(t), '⚠ハラスメント・人間関係', t);
  }
  assert.equal(c('パワハラで体調が悪いです'), '⚠ハラスメント・人間関係');                       // 同数なら上の分類（ハラスメント）
  for (const t of ['上司に怒られました', '仕事がきついです', '来月のシフトの希望休について', '体調が悪いので明日休みます']) {
    assert.notEqual(c(t), '⚠ハラスメント・人間関係', t);                                        // 迷う言葉は入れていない
  }
  const s = g.ctx.INQ_isSensitiveCategory;
  for (const k of ['⚠給与・明細', '⚠口座・マイナンバー', '⚠健康・体調', '⚠ハラスメント・人間関係', '健康・体調', 'ハラスメント・人間関係', '⚠手で付けた分類']) assert.equal(s(k), true, k);
  for (const k of ['', null, 'その他', '勤怠・打刻', 'シフト・希望休', '車両・免許']) assert.equal(s(k), false, String(k));
  assert.equal(g.ctx.INQ_summary({ category: '健康・体調', point: '体調' }), '健康・体調');          // 手で⚠を外しても要点は出さない
  assert.equal(g.ctx.INQ_shownHead({ head: 'あいう' }, true), '（内容はチャットで確認してください）');
  assert.equal(g.ctx.INQ_shownHead({ head: 'あいう', secret: true }, true), '機密を含むため、チャットで確認してください');   // 機密の表示が優先
  assert.equal(g.ctx.INQ_shownHead({ head: 'あいう' }, false), '「あいう」');
  assert.ok(g.ctx.INQ_VERSION >= '2026-11-10c');   // 10c 以降の版に含まれる
});
