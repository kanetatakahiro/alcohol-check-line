import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';

// 社員管理AI 第1段階（入社・退社・取消）の純粋関数テスト。すべて架空データ。
const SRC = readFileSync(new URL('../gas/EmployeeAdmin.gs', import.meta.url), 'utf8');
const ea = (() => { const c = { module: { exports: {} } }; vm.runInNewContext(SRC, c); return c.module.exports; })();
const plain = (x) => JSON.parse(JSON.stringify(x));

const row = (code, name, dept, status = '在籍', extra = {}) => {
  const r = Array(15).fill(''); r[0] = code; r[1] = name; r[3] = status; r[4] = dept;
  Object.entries(extra).forEach(([k, v]) => { r[+k] = v; }); return r;
};
const MASTER = [
  row('社員番号', '氏名', '所属・拠点', '在籍状況'),
  row('90001', '試験 一郎', '部署A', '在籍', { 12: '501' }),
  row('90002', '試験 二郎', '部署B', '在籍', { 12: '502' }),
  row('90003', '試験 三郎', '部署A', '退職', { 12: '503', 13: '2026-09-30' }),
  row('90009', '', '', '在籍', { 5: 'Uxxxxxxxx', 10: 'LINE登録で追加。氏名を入力してください' }),  // 入社前にLINE登録
];
const TODAY = '2026-11-10';

const HIRE = `【入社】
社員番号：９０１００
氏名：試験　花子
入社日：2026/11/15
所属・拠点：部署A
社員区分：社員
TOTコード：600
シフト表の書き方：
アルコールチェック：対象`;

test('一言だけなら雛形を返す（入社・退社・取消）', () => {
  for (const k of ['入社', '退社', '取消', ' 入社 ']) {
    const r = ea.EA_parseMessage(k);
    assert.equal(r.type, 'template');
    assert.match(r.text, /^【/);
  }
  assert.equal(ea.EA_parseMessage('部門登録 部署A'), null);   // 既存のグループ命令には干渉しない
  assert.equal(ea.EA_parseMessage('おはようございます'), null);
});

test('入社の申請を読み取る：全角数字・スラッシュ日付・区分の言い換え', () => {
  const r = plain(ea.EA_parseMessage(HIRE));
  assert.equal(r.kind, '入社');
  assert.deepEqual(r.errors, []);
  assert.equal(r.fields.code, '90100');
  assert.equal(r.fields.hiredOn, '2026-11-15');
  assert.equal(r.fields.category, '正社員');
  assert.equal(r.fields.alcohol, true);
  assert.equal(r.fields.totCode, '600');
});

test('雛形のまま送ると項目ごとにエラー', () => {
  const r = ea.EA_parseMessage(ea.EA_TEMPLATES['入社']);
  assert.ok(r.errors.length >= 4);
  assert.ok(r.errors.some((e) => /アルコールチェック/.test(e)));
});

test('入社の照合：新しい社員番号はOK、既存・退職者の番号は再利用不可', () => {
  const ok = ea.EA_validate(ea.EA_parseMessage(HIRE), MASTER, TODAY, []);
  assert.equal(ok.ok, true, ok.errors.join());
  const dup = ea.EA_validate(ea.EA_parseMessage(HIRE.replace('９０１００', '90003').replace('TOTコード：600', 'TOTコード：')), MASTER, TODAY, []);
  assert.equal(dup.ok, false);
  assert.match(dup.errors[0], /再利用しません/);
  assert.ok(dup.warnings.some((w) => /TOTコードが空/.test(w)));
});

test('入社の照合：在籍者と同じTOTコードはエラー、退職者のTOTコードは可', () => {
  assert.equal(ea.EA_validate(ea.EA_parseMessage(HIRE.replace('600', '501')), MASTER, TODAY, []).ok, false);
  assert.equal(ea.EA_validate(ea.EA_parseMessage(HIRE.replace('600', '503')), MASTER, TODAY, []).ok, true);
});

test('日付：7日前までは警告、8日以上前はエラー', () => {
  const p = (d) => ea.EA_validate(ea.EA_parseMessage(HIRE.replace('2026/11/15', d)), MASTER, TODAY, []);
  assert.equal(p('2026-11-03').ok, true);
  assert.ok(p('2026-11-03').warnings.some((w) => /過去/.test(w)));
  assert.equal(p('2026-11-02').ok, false);
  assert.equal(ea.EA_parseMessage(HIRE.replace('2026/11/15', '2026-02-30')).errors.length, 1);   // 存在しない日
});

test('入社前にLINE登録した行があれば、その行へ書き込む（新しい行は作らない）', () => {
  const parsed = ea.EA_parseMessage(HIRE.replace('９０１００', '90009'));
  const v = ea.EA_validate(parsed, MASTER, TODAY, []);
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => /先にLINE登録/.test(w)));
  const plan = plain(ea.EA_planMasterChange(parsed, MASTER));
  assert.equal(plan.append, undefined);
  assert.ok(plan.updates.every((u) => u.row === 5));
  assert.ok(!plan.updates.some((u) => u.col === 6));   // LINEユーザーIDには触れない
  assert.deepEqual(plan.updates.find((u) => u.col === 15), { row: 5, col: 15, value: '2026-11-15', text: true });
});

test('入社の反映：15列の新しい行、O列入社日は文字で', () => {
  const plan = plain(ea.EA_planMasterChange(ea.EA_parseMessage(HIRE), MASTER));
  assert.equal(plan.append.length, 15);
  assert.equal(plan.append[0], '90100');
  assert.equal(plan.append[3], '在籍');
  assert.equal(plan.append[8], false);           // LINE確認済みは本人登録後
  assert.equal(plan.append[13], '');             // 退職日は空
  assert.equal(plan.append[14], '2026-11-15');
  assert.ok(plan.textCols.includes(15));
});

const RETIRE = `【退社】
社員番号：90001
氏名：試験一郎
退職日：2026-11-30
最終出社日：2026-11-20`;

test('退社：氏名の空白違いは同一人物、氏名違いはエラー', () => {
  assert.equal(ea.EA_validate(ea.EA_parseMessage(RETIRE), MASTER, TODAY, []).ok, true);
  const bad = ea.EA_validate(ea.EA_parseMessage(RETIRE.replace('試験一郎', '試験二郎')), MASTER, TODAY, []);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /一致しません/);
});

test('退社：退職済み・マスタに無い・最終出社日が後ろはエラー', () => {
  assert.equal(ea.EA_validate(ea.EA_parseMessage(RETIRE.replace('90001', '90003').replace('試験一郎', '試験 三郎')), MASTER, TODAY, []).ok, false);
  assert.equal(ea.EA_validate(ea.EA_parseMessage(RETIRE.replace('90001', '99999')), MASTER, TODAY, []).ok, false);
  assert.equal(ea.EA_validate(ea.EA_parseMessage(RETIRE.replace('2026-11-20', '2026-12-05')), MASTER, TODAY, []).ok, false);
});

test('退社の反映は退職日の翌日：在籍状況＝退職、退職日は文字', () => {
  const p = ea.EA_parseMessage(RETIRE);
  assert.equal(ea.EA_effectiveDate(p), '2026-12-01');
  const plan = plain(ea.EA_planMasterChange(p, MASTER));
  assert.deepEqual(plan.updates, [
    { row: 2, col: 4, value: '退職' },
    { row: 2, col: 14, value: '2026-11-30', text: true },
  ]);
});

test('最終出社日の翌日〜退職日はお知らせ停止（作成元・管理IDつき）。同日なら停止行なし', () => {
  const p = ea.EA_parseMessage(RETIRE);
  const r = plain(ea.EA_planPauseRow(p, MASTER, 'EA-20261110-001'));
  assert.deepEqual(r, ['90001', '試験 一郎', { date: '2026-11-21' }, { date: '2026-11-30' }, '退職前の休み（最終出社日 2026-11-20）', '全部', '社員管理AI', 'EA-20261110-001']);
  assert.equal(ea.EA_planPauseRow(ea.EA_parseMessage(RETIRE.replace(/最終出社日.*/, '最終出社日：')), MASTER, 'x'), null);
});

test('取消で消すのは、社員管理AIが作った同じ申請番号の停止行だけ', () => {
  const pause = [['社員番号', '氏名', '開始日', '終了日', 'メモ', '範囲', '作成元', '管理ID'],
    ['90001', 'a', '', '', '手入力', '全部', '', ''],
    ['90001', 'a', '', '', '', '全部', '社員管理AI', 'EA-20261110-001'],
    ['90002', 'b', '', '', '', '全部', '社員管理AI', 'EA-20261110-002']];
  assert.deepEqual(plain(ea.EA_pauseRowsToRemove(pause, 'EA-20261110-001')), [3]);
});

test('申請番号は日ごとの連番、承認コードは6桁', () => {
  assert.equal(ea.EA_newRequestId('2026-11-10', []), 'EA-20261110-001');
  assert.equal(ea.EA_newRequestId('2026-11-10', ['EA-20261110-001', 'EA-20261110-007', 'EA-20261109-020']), 'EA-20261110-008');
  assert.equal(ea.EA_approvalCode(42), '000042');
  assert.equal(ea.EA_approvalCode(123456789), '456789');
});

test('状態遷移：反映前は取消可、反映済みは取消不可', () => {
  assert.equal(ea.EA_transition('申請中', 'approve').state, '予約');
  assert.equal(ea.EA_transition('予約', 'apply').state, '反映済');
  assert.equal(ea.EA_transition('予約', 'cancel').state, '取消');
  assert.equal(ea.EA_transition('反映済', 'cancel').ok, false);
  assert.equal(ea.EA_transition('却下', 'approve').ok, false);
});

test('承認の判定：署名未確認・グループ外・期限切れ・コード違いは弾く。本人承認は可', () => {
  const now = Date.UTC(2026, 10, 10);
  const req = { state: '申請中', createdAtMs: now - 3600e3, approvalCode: '123456' };
  const d = { action: 'approve', code: '123456' };
  const ctx = { verified: true, isGroupMember: true, nowMs: now };
  assert.equal(ea.EA_judgeDecision(req, d, ctx).state, '予約');
  assert.equal(ea.EA_judgeDecision(req, d, { ...ctx, verified: false }).ok, false);
  assert.equal(ea.EA_judgeDecision(req, d, { ...ctx, isGroupMember: false }).ok, false);
  assert.equal(ea.EA_judgeDecision(req, { ...d, code: '000000' }, ctx).ok, false);
  assert.equal(ea.EA_judgeDecision({ ...req, createdAtMs: now - 73 * 3600e3 }, d, ctx).expire, true);
  assert.equal(ea.EA_judgeDecision({ ...req, state: '予約' }, d, ctx).ok, false);   // 使い回し不可
});

test('承認・却下メッセージの読み取り', () => {
  assert.deepEqual(plain(ea.EA_parseMessage('承認 EA-20261110-001 123456')), { type: 'decision', action: 'approve', id: 'EA-20261110-001', code: '123456' });
  assert.equal(ea.EA_parseMessage('却下　EA-20261110-001').action, 'reject');
});

test('予約のうち効力日が来たものだけ反映対象', () => {
  const reqs = [
    { state: '予約', kind: '入社', fields: { hiredOn: '2026-11-10' } },
    { state: '予約', kind: '入社', fields: { hiredOn: '2026-11-11' } },
    { state: '予約', kind: '退社', fields: { retiredOn: '2026-11-09' } },
    { state: '予約', kind: '退社', fields: { retiredOn: '2026-11-10' } },
    { state: '申請中', kind: '入社', fields: { hiredOn: '2026-11-01' } },
  ];
  assert.equal(ea.EA_dueRequests(reqs, TODAY).length, 2);
});

test('同じ社員番号の申請が審査中・予約中なら警告', () => {
  const v = ea.EA_validate(ea.EA_parseMessage(RETIRE), MASTER, TODAY, [{ id: 'EA-20261109-001', kind: '退社', state: '予約', fields: { code: '90001' } }]);
  assert.ok(v.warnings.some((w) => /EA-20261109-001/.test(w)));
});

test('VPS中継からの転送：正しい署名だけ通す（時刻ずれ・再送・改ざんは拒否）', () => {
  const secret = 'test-secret-not-real';
  const hmac = (s, t) => createHmac('sha256', s).update(t).digest('hex');
  const events = [{ type: 'message', webhookEventId: 'E1' }];
  const now = 1_800_000_000;
  const body = { type: 'line-verified', ts: now, nonce: 'n1', events, sig: hmac(secret, `${now}.n1.${JSON.stringify(events)}`) };
  assert.equal(ea.EA_verifyForward(body, secret, now + 10, {}, hmac).ok, true);
  assert.equal(ea.EA_verifyForward(body, secret, now + 301, {}, hmac).ok, false);
  assert.equal(ea.EA_verifyForward(body, secret, now, { n1: true }, hmac).ok, false);
  assert.equal(ea.EA_verifyForward({ ...body, events: [{ type: 'message', webhookEventId: 'E2' }] }, secret, now, {}, hmac).ok, false);
  assert.equal(ea.EA_verifyForward(body, '', now, {}, hmac).ok, false);
  assert.equal(ea.EA_verifyForward({ ...body, type: 'tot-raw' }, secret, now, {}, hmac).ok, false);
});

test('webhookEventId の重複は1回だけ処理', () => {
  const seen = {};
  assert.equal(ea.EA_dedupeEvents([{ webhookEventId: 'A' }, { webhookEventId: 'A' }, { webhookEventId: 'B' }], seen).length, 2);
  assert.equal(ea.EA_dedupeEvents([{ webhookEventId: 'B' }], seen).length, 0);
});
