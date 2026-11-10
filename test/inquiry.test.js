import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './helpers/gas-mock.js';

// 従業員問い合わせ管理：純粋関数のテスト（すべて架空データ）
const g = createGas({ files: ['AlcoholCheck.gs', 'Inquiry.gs'], now: '2026-11-05T14:00:00+09:00' });
const X = g.ctx;
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const jst = (s) => new Date(s + '+09:00');

test('INQ: 定型連絡（言葉だけ・語尾や記号・絵文字は無視）', () => {
  for (const t of ['退勤', '退勤しました。', '出勤します！', '遅刻します🙏', '　早退します ', '休憩入ります', '休憩終わりました',
    '戻りました', 'お疲れ様です', 'お疲れさまでした！', '退勤（笑）']) {
    assert.equal(X.INQ_isRoutine(t), true, t);
  }
  for (const t of ['遅刻します、電車が止まっていて30分遅れます', '遅刻の扱いについて教えてください', '退勤の打刻を忘れました',
    '出勤日を変えたい', '有給の残りを教えてください', '', null, '1234']) {
    assert.equal(X.INQ_isRoutine(t), false, String(t));
  }
  assert.equal(X.INQ_isRoutine('直行'), false);
  assert.equal(X.INQ_isRoutine('直行します', '直行、直帰'), true);   // 言葉の追加
});

test('INQ: 機密の判定（言葉・7桁以上の数字・全角・区切り）', () => {
  for (const t of ['パスワードを忘れました', '暗証番号の変更', '口座を変えたい', 'カード番号は', 'マイナンバーの提出', 'PINコード', 'Password?',
    '1234567', '１２３４５６７', '1234-5678-9012-3456', '090-1234-5678', '12 34 56 78']) {
    assert.equal(X.INQ_hasSecret(t), true, t);
  }
  for (const t of ['明日のシフトについて', '123456', '10/5の14:00から', '社員番号は90001です', '']) {
    assert.equal(X.INQ_hasSecret(t), false, t);
  }
  assert.equal(X.INQ_hasSecret('保険証の件', '保険証'), true);
});

test('INQ: 機密の部分を伏せて保存する', () => {
  assert.equal(X.INQ_maskSecret('口座番号は1234567です'), '口座＊＊＊');
  assert.equal(X.INQ_maskSecret('カード 1234-5678-9012-3456 を登録'), 'カード ＊＊＊ を登録');
  assert.equal(X.INQ_maskSecret('連絡先は090-1234-5678です\n明日の件'), '連絡先は＊＊＊です\n明日の件');
  assert.equal(X.INQ_maskSecret('パスワードはabc123\n2行目は残る'), 'パスワード＊＊＊\n2行目は残る');
  assert.equal(X.INQ_maskSecret('普通の相談です'), '普通の相談です');
  assert.ok(!/\d{7}/.test(X.INQ_maskSecret('１２３４５６７８')));
});

test('INQ: 冒頭20文字（改行は空白・絵文字は1文字・超えたら…）', () => {
  assert.equal(X.INQ_head('短い'), '短い');
  assert.equal(X.INQ_head('あ'.repeat(20)), 'あ'.repeat(20));
  assert.equal(X.INQ_head('あ'.repeat(21)), 'あ'.repeat(20) + '…');
  assert.equal(X.INQ_head('1行目\n\n2行目'), '1行目 2行目');
  assert.equal(X.INQ_head('😀'.repeat(25)), '😀'.repeat(20) + '…');
});

test('INQ: 文字以外のメッセージの表示（スタンプは記録だけ）', () => {
  assert.equal(X.INQ_messageSummary({ type: 'image' }), '（画像）');
  assert.equal(X.INQ_messageSummary({ type: 'file', fileName: '個人の書類.pdf' }), '（ファイル）');   // ファイル名は残さない
  assert.equal(X.INQ_messageSummary({ type: 'location' }), '（位置情報）');
  assert.equal(X.INQ_messageSummary({ type: 'sticker' }), null);
  assert.equal(X.INQ_messageSummary({ type: 'text', text: 'こんにちは' }), 'こんにちは');
});

const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];
const row = (code, name, dept, userId, { lineOk = true, status = '在籍', retiredOn = '' } = {}) =>
  [code, name, '', status, dept, userId, '', '', lineOk, true, '', '', '', retiredOn];

test('INQ: 従業員との紐付けは LINEユーザーID＋LINE確認済みだけ（推測しない）', () => {
  const mv = [HEAD, row('90001', '試験 一郎', '部署A', U(1)), row('90002', '試験 二郎', '部署B', U(2), { lineOk: false }),
    row('90003', '試験 三郎', '部署A', U(3)), row('90004', '試験 四郎', '部署A', U(3)),
    row('90005', '試験 五郎', '部署C', U(5), { retiredOn: '2026-10-31' })];
  assert.deepEqual({ ...X.INQ_matchEmployee(mv, U(1), '2026-11-05') }, { link: 'registered', code: '90001', name: '試験 一郎', dept: '部署A', retired: false });
  assert.equal(X.INQ_matchEmployee(mv, U(2), '2026-11-05').link, 'pending');
  assert.equal(X.INQ_matchEmployee(mv, U(3), '2026-11-05').link, 'duplicate');
  assert.equal(X.INQ_matchEmployee(mv, U(9), '2026-11-05').link, 'unregistered');
  assert.equal(X.INQ_matchEmployee(mv, U(5), '2026-11-05').retired, true);
  assert.equal(X.INQ_whoLabel(X.INQ_matchEmployee(mv, U(1), '2026-11-05'), '表示'), '試験 一郎（部署A）');
  assert.equal(X.INQ_whoLabel(X.INQ_matchEmployee(mv, U(5), '2026-11-05'), '表示'), '試験 五郎（退職）（部署C）');
  assert.equal(X.INQ_whoLabel({ link: 'unregistered' }, 'たろう'), '未登録（たろう）');
  assert.equal(X.INQ_whoLabel({ link: 'pending' }, 'じろう'), '確認待ち（じろう）');
  assert.equal(X.INQ_whoLabel({ link: 'duplicate' }, ''), '要確認（表示名なし）');
});

test('INQ: postback の読み取り（inq| 以外・形の違うものは無視）', () => {
  assert.deepEqual({ ...X.INQ_parsePostback('inq|1|take|Q-20261105-003|a1b2c3') }, { action: 'take', id: 'Q-20261105-003', token: 'a1b2c3' });
  assert.equal(X.INQ_parsePostback(X.INQ_postbackData('done', 'Q-20261105-001', '00ff00')).action, 'done');
  for (const d of ['ea|1|approve|EA-20261105-001', 'inq|2|take|Q-20261105-003|a1b2c3', 'inq|1|delete|Q-20261105-003|a1b2c3',
    'inq|1|take|EA-20261105-003|a1b2c3', 'inq|1|take|Q-20261105-003|', 'inq|1|take|Q-20261105-003|a1b2c3|x', '', null]) {
    assert.equal(X.INQ_parsePostback(d), null, String(d));
  }
  assert.ok(X.INQ_postbackData('take', 'Q-20261105-003', 'a1b2c3').length <= 300);
});

test('INQ: 状態は一方向（未対応 → 対応中 → 対応済み）・二重押しは変えない', () => {
  const S = X.INQ_STATE;
  assert.deepEqual({ ...X.INQ_decide(S.open, 'take') }, { next: S.doing, changed: true, reason: 'taken' });
  assert.deepEqual({ ...X.INQ_decide(S.open, 'done') }, { next: S.done, changed: true, reason: 'done' });
  assert.deepEqual({ ...X.INQ_decide(S.doing, 'take') }, { next: S.doing, changed: false, reason: 'alreadyDoing' });
  assert.deepEqual({ ...X.INQ_decide(S.doing, 'done') }, { next: S.done, changed: true, reason: 'done' });
  assert.deepEqual({ ...X.INQ_decide(S.done, 'take') }, { next: S.done, changed: false, reason: 'alreadyDone' });
  assert.deepEqual({ ...X.INQ_decide(S.done, 'done') }, { next: S.done, changed: false, reason: 'alreadyDone' });
});

test('INQ: 案件番号は日ごとの連番', () => {
  assert.equal(X.INQ_nextId([], '2026-11-05'), 'Q-20261105-001');
  assert.equal(X.INQ_nextId(['Q-20261104-009', 'Q-20261105-001', 'Q-20261105-002'], '2026-11-05'), 'Q-20261105-003');
  assert.equal(X.INQ_nextId(['Q-20261104-009'], '2026-11-05'), 'Q-20261105-001');
});

test('INQ: 対応中への追記の通知は30分に1回まで（未対応・対応済みは通知しない）', () => {
  const S = X.INQ_STATE, t0 = jst('2026-11-05T10:00:00').getTime(), min = 60000;
  assert.equal(X.INQ_shouldNotifyAppend(S.doing, 0, t0), true);
  assert.equal(X.INQ_shouldNotifyAppend(S.doing, t0, t0 + 29 * min), false);
  assert.equal(X.INQ_shouldNotifyAppend(S.doing, t0, t0 + 30 * min), true);
  assert.equal(X.INQ_shouldNotifyAppend(S.open, 0, t0), false);
  assert.equal(X.INQ_shouldNotifyAppend(S.done, 0, t0), false);
});

test('INQ: 新しい問い合わせの通知（名前・状況・要約・内容・ボタン2つ。案件番号は本文に出さない）', () => {
  const c = { id: 'Q-20261105-003', at: jst('2026-11-05T14:12:00'), head: '明日のシフトの件で確認したいことがあり…', secret: false, state: '未対応', token: 'a1b2c3',
    name: '試験 一郎', dept: '部署A', link: '登録済み', lineName: 'いちろう', category: 'シフト・希望休', point: 'シフト' };
  const m = X.INQ_newCaseMessage(c);
  assert.equal(m.type, 'flex');
  const texts = [...m.contents.body.contents].map((x) => x.text);
  assert.deepEqual(texts, ['【問い合わせ】11/5 14:12', '試験 一郎（部署A）', '状況：未対応', '要約：シフト・希望休／シフト', '内容：「明日のシフトの件で確認したいことがあり…」']);
  assert.ok(!m.altText.includes('Q-'));
  const acts = [...m.contents.footer.contents].map((b) => b.action);
  assert.deepEqual(acts.map((a) => [a.type, a.label, a.data]), [['postback', '対応します', 'inq|1|take|Q-20261105-003|a1b2c3'],
    ['postback', '対応済みにする', 'inq|1|done|Q-20261105-003|a1b2c3']]);   // ボタンの中身は今までどおり
  for (const a of acts) assert.ok(!/^(入社|退社|取消|部門登録|承認|却下)/.test(a.displayText));   // ほかの機能が反応する形にしない
  const s = X.INQ_newCaseMessage({ ...c, secret: true });
  assert.equal(s.contents.body.contents[3].text, '要約：シフト・希望休');
  assert.equal(s.contents.body.contents[4].text, '内容：機密を含むため、チャットで確認してください');
  assert.equal(X.INQ_newCaseText({ ...c, secret: true }), ['【問い合わせ】11/5 14:12', '試験 一郎（部署A）', '状況：未対応', '要約：シフト・希望休', '内容：機密を含むため、チャットで確認してください'].join('\n'));
});

test('INQ: まとめのお知らせ（並び順・前日から・対応中の担当・機密・未登録・要約が空・0件はなし・案件番号なし）', () => {
  const now = jst('2026-11-06T09:00:00');
  assert.equal(X.INQ_remindText([], now), null);
  assert.equal(X.INQ_remindText([{ id: 'Q-20261105-001', state: '対応済み', link: '登録済み', name: 'a', at: now, head: 'x' }], now), null);
  const reg = (name, dept) => ({ link: '登録済み', name, dept });
  const t = X.INQ_remindText([
    { id: 'Q-20261105-001', state: '対応中', ...reg('試験 二郎', '部署B'), at: jst('2026-11-05T09:00:00'), head: '有給の残りを教えてください', staff: '担当A', category: '有給・休み', point: '有給' },
    { id: 'Q-20261106-001', state: '未対応', link: '未登録', lineName: 'たろう', at: jst('2026-11-06T08:10:00'), head: '口座＊＊＊', secret: true, category: '⚠口座・マイナンバー', point: '口座' },
    { id: 'Q-20261105-003', state: '未対応', ...reg('試験 一郎', '部署A'), at: jst('2026-11-05T14:12:00'), head: '11月8日の退勤の打刻を押し忘れて…', category: '', point: '' },
    { id: 'Q-20261106-002', state: '未対応', link: '確認待ち', lineName: '', at: jst('2026-11-06T08:30:00'), head: '' },
    { id: 'Q-20261104-001', state: '対応済み', ...reg('x', 'y'), at: jst('2026-11-04T09:00:00'), head: 'x' },
  ], now);
  assert.equal(t, ['【問い合わせ 未完了4件】11/6 9:00',
    '① 試験 一郎（部署A）\n状況：未対応（前日から）\n要約：勤怠・打刻／11/8／退勤／打刻／押し忘れ\n内容：「11月8日の退勤の打刻を押し忘れて…」',   // 要約が空 → その場で作る
    '② 氏名不明（たろう）\n状況：未対応\n要約：⚠口座・マイナンバー\n内容：機密を含むため、チャットで確認してください',             // 機密：分類だけ
    '③ 氏名不明（表示名なし）\n状況：未対応\n要約：－\n内容：「」',
    '④ 試験 二郎（部署B）\n状況：対応中（担当：担当A）（前日から）\n要約：有給・休み／有給\n内容：「有給の残りを教えてください」'].join('\n\n'));
  assert.ok(!t.includes('Q-'));
  const many = Array.from({ length: 300 }, (_, i) => ({ id: 'Q-20261105-' + String(i).padStart(3, '0'), state: '未対応', ...reg('試験 太郎', '部署A'), at: now, head: 'あ'.repeat(20) + '…', category: 'その他', point: 'あ'.repeat(20) }));
  const long = X.INQ_remindText(many, now);
  assert.ok(long.length <= 4900);
  assert.match(long, /…ほか\d+件はシートで確認$/);
  assert.match(long, /⑳ 試験 太郎/); assert.match(long, /\(21\) 試験 太郎/);
});
