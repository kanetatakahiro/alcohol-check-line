import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 勤怠連絡フォームの部署別の対象者選択（2026-10-22）。すべて架空データ。
const SRC = readFileSync(new URL('../gas/AlcoholCheck.gs', import.meta.url), 'utf8');
const pure = (() => { const c = { module: { exports: {} } }; vm.runInNewContext(SRC, c); return c.module.exports; })();

// 従業員マスタの1行：社員番号, 氏名, 別表記, 在籍状況, 所属・拠点, LINE ID, …（14列）
const row = (code, name, dept, status = '在籍') => { const r = Array(14).fill(''); r[0] = code; r[1] = name; r[3] = status; r[4] = dept; return r; };
const MASTER = [
  row('社員番号', '氏名', '所属・拠点', '在籍状況'),
  row('90010', '試験 一郎', '部署A'),
  row('90002', '試験 二郎', '部署B'),
  row('90003', '試験 三郎', '部署A'),
  row('90004', '試験 四郎', '部署A', '退職'),
  row('90005', '試験 五郎', ''),            // 所属が空 → 全員の一覧だけ
  row('90006', '試験 太郎', '部署B'),
  row('90007', '試験 太郎', '部署A'),        // 同姓同名 → 社員番号で区別
];

test('部署ごとの選択肢：在籍者のみ・社員番号順・他部署が混ざらない・同姓同名は社員番号で区別', () => {
  const r = JSON.parse(JSON.stringify(pure.AC_formChoicesByDept(MASTER)));
  assert.deepEqual(r.order, ['部署A', '部署B']);
  assert.deepEqual(r.byDept['部署A'], ['試験 三郎（90003）', '試験 太郎（90007）', '試験 一郎（90010）']);
  assert.deepEqual(r.byDept['部署B'], ['試験 二郎（90002）', '試験 太郎（90006）']);
  // 全員の一覧（従来）は所属が空の人も含む
  assert.ok([...pure.AC_formChoices(MASTER)].includes('試験 五郎（90005）'));
  assert.ok(![...r.byDept['部署A'], ...r.byDept['部署B']].includes('試験 五郎（90005）'));
});

test('対象者の設問の判定と、回答からの対象者の読み取り', () => {
  assert.equal(pure.AC_isWhoTitle('対象者'), true);
  assert.equal(pure.AC_isWhoTitle('対象者（法人カーケア）'), true);
  assert.equal(pure.AC_isWhoTitle('対象者の補足'), false);
  assert.equal(pure.AC_isWhoTitle('入力者（あなたのお名前）'), false);
  const p = (t, v) => ({ title: t, value: v });
  assert.equal(pure.AC_whoFromResponses([p('入力者（あなたのお名前）', 'X'), p('対象者（部署A）', '試験 一郎（90010）')]).who, '試験 一郎（90010）');
  assert.equal(pure.AC_whoFromResponses([p('対象者', '試験 五郎（90005）')]).who, '試験 五郎（90005）');   // 従来の全員の一覧
  const both = pure.AC_whoFromResponses([p('対象者（部署A）', '試験 一郎（90010）'), p('対象者', '試験 二郎（90002）')]);
  assert.equal(both.conflict, true);
  assert.equal(both.who, '');
  assert.equal(pure.AC_whoFromResponses([p('対象者（部署A）', '試験 一郎（90010）'), p('対象者', '試験 一郎（90010）')]).conflict, false);   // 同じ人なら1人
  assert.equal(pure.AC_whoFromResponses([]).who, '');
});

// ---------------- 送信時の処理を、Googleのサービスを偽物に置き換えて丸ごと動かす ----------------
function makeEnv({ today = '2026-11-05', liveFrom = '2026-10-20', groups = [] } = {}) {
  const sent = [], pausedRows = [], logs = [];
  const sheet = (values) => ({
    getDataRange: () => ({ getValues: () => values }),
    getLastRow: () => values.length, getLastColumn: () => (values[0] || []).length,
    getRange: () => ({ getValue: () => 'x', setValue() { return this; }, setValues() { return this; }, setFontWeight() { return this; } }),
    appendRow: (r) => { values.push(r); pausedRows.push(r); },
    setFrozenRows() {}, getParent: () => ss,
  });
  const master = sheet(MASTER.map(r => r.slice()));
  const sheets = {
    '従業員マスタ': master,
    'LINEグループ': sheet([['グループID', '部門（所属）', '登録日時', '状態'], ...groups]),
    'お知らせ停止': sheet([['社員番号', '氏名（参考）', '開始日', '終了日', 'メモ', '止めるお知らせ（全部／勤怠のみ）']]),
  };
  const ss = { getSheetByName: (n) => sheets[n] || null, getSheets: () => [master], insertSheet: (n) => (sheets[n] = sheet([[]])) };
  master.getParent = () => ss;
  const props = (init) => { const p = { ...init }; return { getProperty: k => (k in p ? p[k] : null), setProperty: (k, v) => { p[k] = v; }, getProperties: () => ({ ...p }), deleteProperty: k => { delete p[k]; }, setProperties: o => Object.assign(p, o) }; };
  const scriptProps = props({ LINE_CHANNEL_ACCESS_TOKEN: 'FAKE', LINE_ADMIN_USER_ID: 'ADMIN', EMPLOYEE_MASTER_ID: 'M', FORM_LIVE_FROM: liveFrom });
  const ctx = {
    module: { exports: {} },
    Logger: { log: (...a) => logs.push(a.join(' ')) },
    PropertiesService: { getScriptProperties: () => scriptProps, getUserProperties: () => props({}) },
    SpreadsheetApp: { openById: () => ss },
    Utilities: { formatDate: () => today, getUuid: () => 'u' },
    UrlFetchApp: { fetch: (url, o) => { const b = JSON.parse(o.payload); sent.push({ to: b.to, text: b.messages[0].text }); return { getResponseCode: () => 200 }; } },
  };
  vm.runInNewContext(SRC, ctx);
  const submit = (answers) => ctx.alcoholCheckOnAttendanceForm({ response: { getItemResponses: () =>
    answers.map(([t, v]) => ({ getItem: () => ({ getTitle: () => t }), getResponse: () => v })) } });
  return { submit, sent, pausedRows, logs };
}
const GROUPS = [['G-A', '部署A', '', '有効'], ['G-B', '部署B', '', '有効'], ['G-KANRI', '勤怠管理', '', '有効']];
const base = (whoTitle, who, kind = '遅刻') => [
  ['入力者（あなたのお名前）', '試験 上司'], ['所属（部署）', '部署A'], [whoTitle, who], ['区分', kind],
  ['日付（開始日）', '2026-11-05'], ['理由・連絡事項', '電車の遅延'],
];

test('送信時：部署別の設問で選んだ人の所属グループと勤怠管理グループへ、1通ずつ送る', () => {
  const env = makeEnv({ groups: GROUPS });
  env.submit(base('対象者（部署A）', '試験 一郎（90010）'));
  assert.deepEqual(env.sent.map(s => s.to), ['G-A', 'G-KANRI']);
  assert.match(env.sent[0].text, /^【勤怠変更の報告】\n・氏名：試験 一郎さん\n・区分：遅刻/);
  assert.match(env.sent[1].text, /部署Aのグループ LINEにもお知らせしました|部署AのグループLINEにもお知らせしました/);
});

test('送信時：所属の判定は従業員マスタで行う（フォームで違う部署のページから選んでも、本人の所属のグループへ）', () => {
  const env = makeEnv({ groups: GROUPS });
  env.submit(base('対象者（部署A）', '試験 二郎（90002）'));   // 部署Bの人
  assert.deepEqual(env.sent.map(s => s.to), ['G-B', 'G-KANRI']);
});

test('送信時：従来の「対象者」（全員の一覧）から選んでも、今までどおり送る', () => {
  const env = makeEnv({ groups: GROUPS });
  env.submit(base('対象者', '試験 三郎（90003）'));
  assert.deepEqual(env.sent.map(s => s.to), ['G-A', 'G-KANRI']);
});

test('送信時：同姓同名でも社員番号で正しい人・部署を判定する', () => {
  const env = makeEnv({ groups: GROUPS });
  env.submit(base('対象者（部署A）', '試験 太郎（90007）'));
  assert.deepEqual(env.sent.map(s => s.to), ['G-A', 'G-KANRI']);
  const env2 = makeEnv({ groups: GROUPS });
  env2.submit(base('対象者（部署B）', '試験 太郎（90006）'));
  assert.deepEqual(env2.sent.map(s => s.to), ['G-B', 'G-KANRI']);
});

test('送信時：対象者が2人入っていたら、グループへは送らず管理者へ確認だけ（誤通知・重複通知を防ぐ）', () => {
  const env = makeEnv({ groups: GROUPS });
  env.submit([...base('対象者（部署A）', '試験 一郎（90010）'), ['対象者', '試験 二郎（90002）']]);
  assert.deepEqual(env.sent.map(s => s.to), ['ADMIN']);
  assert.match(env.sent[0].text, /対象者が2人以上/);
  assert.equal(env.pausedRows.length, 0);
});

test('送信時：欠勤はお知らせ停止に1行だけ登録（従来どおり）', () => {
  const env = makeEnv({ groups: GROUPS });
  env.submit(base('対象者（部署B）', '試験 二郎（90002）', '欠勤'));
  assert.equal(env.pausedRows.length, 1);
  assert.equal(env.pausedRows[0][0], "'90002");
  assert.deepEqual(env.sent.map(s => s.to), ['G-B', 'G-KANRI']);
});

test('送信時：対象者が読めない（在籍者なしの案内を選んだ等）ときは管理者へ知らせるだけ（従来どおり）', () => {
  const env = makeEnv({ groups: GROUPS });
  env.submit(base('対象者（部署A）', '※現在この部署の在籍者はいません。前のページに戻って「一覧にいない・わからない」を選んでください'));
  assert.deepEqual(env.sent.map(s => s.to), ['ADMIN']);
  assert.match(env.sent[0].text, /対象者を読み取れませんでした/);
});

test('送信時：勤怠管理グループが未登録なら管理者の個別LINEへ（従来どおり）', () => {
  const env = makeEnv({ groups: [['G-A', '部署A', '', '有効']] });
  env.submit(base('対象者（部署A）', '試験 一郎（90010）'));
  assert.deepEqual(env.sent.map(s => s.to), ['G-A', 'ADMIN']);
});

test('在籍者なしの案内文は社員番号として読まれない', () => {
  const c = { module: { exports: {} } }; vm.runInNewContext(SRC + '\nmodule.exports.NOBODY = AC_FORM_NOBODY;', c);
  assert.equal(pure.AC_codeFromChoice(c.module.exports.NOBODY), '');
});
