import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGas } from './helpers/gas-mock.js';

// FAQ回答マスター（gas/Inquiry.gs の INQ_setupFaq・版 2026-11-10d）。すべて架空データ・模擬環境（LINEへの送信なし）
const U = (n) => 'U' + String(n).repeat(32).slice(0, 32);
const GROUP = 'C' + 'a'.repeat(32);
const HEAD = ['社員番号', '氏名', '別表記', '在籍状況', '所属・拠点', 'LINEユーザーID', 'LINE表示名', 'LINE登録日時', 'LINE確認済み',
  'アルコールチェック対象', '備考', '社員区分', 'TOT従業員コード', '退職日'];

function setup(props = { INQ_MODE: 'record' }) {
  const g = createGas({ files: ['AlcoholCheck.gs', 'Inquiry.gs'], now: '2026-11-10T16:00:00+09:00' });
  const master = g.newSpreadsheet('【テスト】従業員マスタ（架空）');
  const m = master.insertSheet('従業員マスタ');
  [HEAD, ["'90001", '試験 一郎', '', '在籍', '部署A', U(1), '', '', true, true, '', '', '', '']].forEach((r) => m.appendRow(r));
  const gs = master.insertSheet('LINEグループ');
  [['グループID', '部門（所属）', '登録日時', '状態'], [GROUP, '勤怠管理', '2026-10-15', '有効']].forEach((r) => gs.appendRow(r));
  const book = g.newSpreadsheet('【テスト】従業員問い合わせ管理（架空）');
  g.scriptProps.setProperties({ EMPLOYEE_MASTER_ID: master.getId(), INQ_SPREADSHEET_ID: book.getId(), LINE_CHANNEL_ACCESS_TOKEN: 'fake',
    LINE_ADMIN_USER_ID: U(7), ...props });
  g.line.profiles[U(1)] = 'いちろう';
  return { g, book };
}

// 仕様書の【文面案】を節ごとに読む（「4-2/LINE回答例」「13-2」の形。段落の間は空行）
function specTexts() {
  const lines = readFileSync(new URL('../docs/REBIRTH_support_spec.md', import.meta.url), 'utf8').split('\n');
  const out = {};
  let sec = null, cur = null;
  const flush = () => { if (cur) out[cur.key] = cur.lines.map((l) => l.trim()).filter(Boolean).join('\n\n'); cur = null; };
  for (const l of lines) {
    if (l.startsWith('#') || l.trim() === '---' || l.startsWith('【要確認】')) flush();
    const m2 = /^## (\d+-\d+)\. (.*)$/.exec(l), m3 = /^### (.*)$/.exec(l);
    if (m2) { sec = m2[1]; if (m2[2].includes('【文面案】')) cur = { key: sec, lines: [] }; continue; }
    if (m3) { if (m3[1].includes('【文面案】')) cur = { key: sec + '/' + m3[1].replace('【文面案】', '').trim(), lines: [] }; continue; }
    if (cur) cur.lines.push(l);
  }
  flush();
  return out;
}

const IDS = ['TOT-01', 'TOT-02', 'TOT-03', 'TOT-04', 'TOT-05', 'TOT-06', 'TOT-07', 'TOT-08', 'TOT-09', 'PL-01', 'PL-02', 'PL-03', 'PL-04', 'PL-05',
  'PAY-01', 'PAY-02', 'PAY-03', 'PAY-04', 'DOC-001', 'DOC-002', 'DOC-003', 'DOC-004', 'DOC-005', 'ALC-01', 'ALC-02', 'LIC-01',
  'CAR-01', 'CAR-02', 'CAR-03', 'NEW-01', 'UNI-01', 'INJ-01', 'HAR-01', 'REQ-01'];
const EMPTY = ['TOT-01', 'TOT-05', 'TOT-06', 'TOT-07', 'TOT-09', 'PL-05', 'PAY-03', 'LIC-01', 'NEW-01', 'UNI-01'];

test('INQ FAQ: 行は計画書 5-2 の34行（番号の重複なし）・列は11・分類は今の分類の名前', () => {
  const { g } = setup();
  const X = g.ctx;
  assert.deepEqual([...X.INQ_FAQ_HEADER], ['FAQ番号', '有効', '分類', 'キーワード', '除外キーワード', '回答文', 'ボタン', '必ず引き継ぐ', '緊急', '最終更新日', '更新者']);
  const rows = [...X.INQ_FAQ_ROWS].map((r) => ({ ...r }));
  assert.deepEqual(rows.map((r) => r.id), IDS);
  const cats = new Set([...X.INQ_CATEGORIES].map((c) => c.name).concat(['その他']));
  for (const r of rows) {
    assert.ok(cats.has(r.category), r.id + ' ' + r.category);
    assert.ok(r.words.trim(), r.id + ' キーワード');
    assert.ok(['', '解決確認', '相談先'].includes(r.button), r.id);
  }
  // 必ず引き継ぐ・緊急（計画書 5-2。条件つきの引継ぎはチェックにしない）
  assert.deepEqual(rows.filter((r) => r.urgent).map((r) => r.id), ['PAY-04', 'CAR-01', 'INJ-01']);
  assert.deepEqual(rows.filter((r) => r.handoff).map((r) => r.id), ['PL-02', 'PAY-03', 'PAY-04', 'DOC-001', 'DOC-002', 'DOC-003', 'DOC-005',
    'ALC-02', 'LIC-01', 'CAR-01', 'CAR-02', 'CAR-03', 'UNI-01', 'INJ-01']);
  assert.equal(rows.find((r) => r.id === 'HAR-01').button, '相談先');
  assert.equal(rows.find((r) => r.id === 'HAR-01').handoff, false);   // 「管理本部」を選んだときだけ引き継ぐ（チェックでは決めない）
});

test('INQ FAQ: 回答文は仕様書の【文面案】そのまま（会社の決定で直した2行を除く）。文面案の無い行は空・有効オフ', () => {
  const { g } = setup();
  const spec = specTexts();
  const rows = [...g.ctx.INQ_FAQ_ROWS].map((r) => ({ ...r }));
  for (const r of rows) {
    if (!r.spec) { assert.equal(r.text, '', r.id); continue; }
    assert.ok(spec[r.spec], r.id + ' の文面案が仕様書に見つからない：' + r.spec);
    if (r.id === 'TOT-03' || r.id === 'PL-04') continue;
    assert.equal(r.text, spec[r.spec], r.id);
  }
  assert.deepEqual(rows.filter((r) => !r.text).map((r) => r.id), EMPTY);
  const sheetRows = [...g.ctx.INQ_faqSheetRows('2026-11-10')].map((r) => [...r]);
  assert.equal(sheetRows.length, 34);
  for (const r of sheetRows) {
    assert.equal(r.length, 11);
    assert.equal(r[1], r[5] !== '', r[0] + ' 有効は回答文があるときだけ');
    assert.deepEqual(r.slice(9), ['2026-11-10', 'INQ_setupFaq（初期値）']);
  }
  assert.equal(sheetRows.filter((r) => r[1] === true).length, 24);
});

test('INQ FAQ: 会社の決定を優先（承認は翌月3日まで・有給の取消はスケジュール申請・締め日の言い方を残さない）', () => {
  const { g } = setup();
  const spec = specTexts();
  const by = Object.fromEntries([...g.ctx.INQ_FAQ_ROWS].map((r) => [r.id, { ...r }]));
  const tot03 = by['TOT-03'].text;
  assert.match(tot03, /打刻修正の申請は、翌月3日までに承認処理を行っています。/);
  assert.equal(tot03, spec['4-3/LINE回答例'].replace('打刻修正の申請は、翌月のTouch On Timeの締め日以降に承認処理を行っています。', '打刻修正の申請は、翌月3日までに承認処理を行っています。'));
  const pl04 = by['PL-04'].text;
  assert.match(pl04, /Touch On Timeの「スケジュール申請」から行えます。/);
  assert.match(pl04, /https:\/\/help\.touchontime\.com\/totfaq\/s\/article\/8301/);
  assert.ok(!pl04.includes('まずはTouch On Timeから取消操作をご確認ください。'));
  assert.ok(pl04.startsWith('有給休暇の申請取消についてですね。') && pl04.endsWith('解決しない場合は管理本部へ引き継ぎます。'));
  for (const r of Object.values(by)) {
    assert.ok(!r.text.includes('締め日'), r.id);                                              // 未確定の締め日の言い方は使わない
    assert.ok(!/希望休.*(上限|何日でも)/.test(r.text), r.id);                                // 希望休のルールと食い違う文を入れない
    assert.ok(!/パスワード(を|は).*(教えて|送って)/.test(r.text), r.id);                       // 17章：パスワードを聞かない
  }
  assert.equal(by['TOT-05'].text, '');   // 希望休は仕様書に文面案が無いため空（文面は会社が入れる）
});

test('INQ FAQ: INQ_setupFaq でタブを作る（チェックボックス3列）。2回目以降・手で直した後は何もしない。送信はしない', () => {
  const { g, book } = setup();
  const n = g.fetches.length;
  const res = { ...g.ctx.INQ_setupFaq() };
  assert.deepEqual(res, { created: true, rows: 34, active: 24 });
  const v = book.getSheetByName('FAQ回答マスター').dump();
  assert.equal(v.length, 35);
  assert.deepEqual(v[0], [...g.ctx.INQ_FAQ_HEADER]);
  assert.deepEqual(v.slice(1).map((r) => r[0]), IDS);
  assert.ok(g.ctx.INQ_VERSION >= '2026-11-10d');   // 10d 以降の版に含まれる
  for (const r of v.slice(1)) for (const c of [1, 7, 8]) assert.equal(typeof r[c], 'boolean', r[0] + ' 列' + (c + 1));
  assert.equal(v.find((r) => r[0] === 'TOT-05')[1], false);
  assert.equal(v.find((r) => r[0] === 'TOT-02')[1], true);
  // 管理本部が手で直す → もう一度実行しても上書きしない・行が増えない
  book.getSheetByName('FAQ回答マスター').getRange(2, 6).setValue('（手で直した回答文）');
  const again = { ...g.ctx.INQ_setupFaq() };
  assert.deepEqual(again, { created: false, rows: 0, active: 0 });
  const v2 = book.getSheetByName('FAQ回答マスター').dump();
  assert.equal(v2.length, 35);
  assert.equal(v2[1][5], '（手で直した回答文）');
  assert.equal(g.fetches.length, n);                                                         // LINEへの送信・返信なし
  assert.ok(!g.logs.join('\n').includes('お問い合わせありがとうございます'));                   // 実行ログに回答文を出さない
});

test('INQ FAQ: タブがあっても問い合わせの受付・お知らせは今までどおり（FAQを読まない・返信しない）。INQ_setup はFAQのタブを作らない', () => {
  const { g, book } = setup({ INQ_MODE: 'on' });
  g.ctx.INQ_setup();
  assert.equal(book.getSheetByName('FAQ回答マスター'), null);
  g.ctx.INQ_setupFaq();
  const n = g.fetches.length;
  g.ctx.doPost({ postData: { contents: JSON.stringify({ destination: 'x', events: [{ type: 'message', webhookEventId: 'evf1', replyToken: 'rt-f1', timestamp: 0,
    source: { type: 'user', userId: U(1) }, message: { id: 'mf1', type: 'text', text: '打刻忘れをしてしまいました' } }] }) } });
  const f = g.fetches.slice(n);
  assert.equal(f.filter((x) => x.url.endsWith('/reply')).length, 0);                         // 自動の返信はしない
  const push = f.filter((x) => x.url.endsWith('/push'));
  assert.equal(push.length, 1);
  assert.equal(push[0].body.to, GROUP);                                                       // グループへの受付時のお知らせは今までどおり
  assert.equal(push[0].body.messages[0].type, 'flex');
  assert.equal(book.getSheetByName('問い合わせ').dump().length, 2);
});
