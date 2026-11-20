/**
 * 従業員問い合わせ管理（第1段階）  版 INQ_VERSION
 *
 * 従業員が公式LINEに1対1で送った「社員番号以外」のメッセージを、問い合わせとして受け付け、
 * 問い合わせ専用のスプレッドシートに記録し、従業員連絡グループ（未登録なら勤怠管理グループ）へ知らせる（ボタン：対応します／対応済みにする）。
 * 9:00・12:00（2026-11-20 から。前は 9:00・15:00）に未対応・対応中の案件をまとめて知らせる（INQ_remind・時刻指定のトリガー。INQ_setupRemindTriggers で登録）。
 * 勤怠管理グループへのお知らせには案件番号を出さない（名前・所属・状況・要約・内容）。ボタンの中身には案件番号と合言葉が入る（表示されない）。
 *
 * 既存の「コード.gs」からの呼び出しは3か所だけ：
 *  - AC_handleEvent_：文字以外のメッセージ・postback、社員番号ではない文字 → INQ_onUserEvent_
 *  - AC_handleGroupEvent_：postback → INQ_onGroupPostback_
 * 入口の関数はエラーを外へ出さない（既存の処理・doPost を止めない）。
 *
 * 設定（スクリプトのプロパティ）
 *  INQ_MODE           未設定・off＝何もしない／record＝記録だけ（送信・返信なし）／on＝利用開始
 *  INQ_SPREADSHEET_ID 記録先のスプレッドシート（INQ_setup で作成）
 *  INQ_NOTIFY_TO      未設定＝「従業員連絡」グループへ（未登録・退出なら勤怠管理グループ）／admin＝管理者の個別LINEへ（試験用）
 *  INQ_REMIND_DAYS    未設定・all＝毎日／weekdays＝土日・祝日は送らない（版 2026-11-17e で祝日も。受付の速報はいつも送る）
 *  INQ_ROUTINE_WORDS・INQ_SECRET_WORDS  定型連絡・機密の言葉の追加（「、」区切り・任意）
 *  INQ_CLASSIFY       未設定＝分類・要点を埋める／off＝埋めない（問い合わせの記録・通知はそのまま）
 *
 * 分類・要点（INQ_classifyFill_）：「問い合わせ」タブの末尾の「分類」「要点」の列を、キーワードで埋める（外部のAIは使わない）。
 *  1時間ごとの alcoholCheckImportTot から呼ぶ（Webアプリの版は変えない）。「分類」が空の行だけを埋め、入っている行は上書きしない。
 *
 * 要注意の分類（⚠の付いた分類：ハラスメント・人間関係／給与・明細／口座・マイナンバー／健康・体調）は、受付時のお知らせ・まとめの
 *  どちらでも分類名だけを出し、要点と内容は出さない（「（内容はチャットで確認してください）」）。版 2026-11-10c
 *
 * FAQ回答マスター（INQ_setupFaq・版 2026-11-10d）：問い合わせ管理シートに「FAQ回答マスター」タブを作る準備用の関数（手動で1回）。
 *  回答文は仕様書（docs/REBIRTH_support_spec.md）の【文面案】。タブがあれば何もしない。今は読まれるだけで、受付・返信の動きは変えない。
 *
 * 列の位置（版 2026-11-10e）：「問い合わせ」タブは、毎回1行目の見出しの名前から列の位置を求める（INQ_C は「見出しの名前」の対応表）。
 *  管理本部が列を並べ替え・非表示にしても動く。見出しが見つからない・同じ見出しが2つある列があれば、その処理だけをやめてエラーを記録する
 *  （受付は本文を「やりとり」に「受付（保留：列の見出し）」で残し、管理者へ1日1回知らせる。doPost は止めない）。
 *
 * 返信が要らないLINE（版 2026-11-16a）：本文が「承知しました」「了解です」「ありがとうございます」「よろしくお願いします」とその言い換えだけ（スタンプだけも）のとき、
 *  案件を「対応済み」（完了者「AI（自動）」）にし、勤怠管理グループへのお知らせ（ボタン付き）・追記の通知を送らない。受信記録に「自動で対応済み」と残す。
 *  新しい受付と、対応中の案件への追記が対象。未対応の案件への追記（質問のあとの「よろしくお願いします」など）と、要注意（⚠）の分類は閉じない。
 *  案件の無い人のスタンプは今までどおり定型連絡（案件にしない）。
 *
 * 送り先（版 2026-11-20b）：受付のお知らせ・追記のお知らせ・9:00／12:00 のまとめは「従業員連絡」グループ（「LINEグループ」タブで部門「従業員連絡」・状態「有効」。
 *  グループで「部門登録 従業員連絡」）へ。未登録・退出・送信失敗なら勤怠管理グループ、それも無理なら管理者の個別LINE。
 *  TOT反映の承認待ち・管理者へのお知らせ（朝のまとめ）は今までどおり勤怠管理グループ。ボタン・「1.3対応済み」はどちらのグループでも使える。
 *
 * 内容の表示（版 2026-11-20b）：受付のお知らせは200文字まで（超えたら「…（続きはチャットで）」）、まとめは1件50文字まで。
 *  写真・動画・スタンプ・ファイルは「［写真1枚］」「［スタンプ］」「［ファイル（名前）］」の形。30分以内に続けて届いた分は「／」でつないで「内容（冒頭）」へ（200文字まで）。
 *
 * まとめのカード（版 2026-11-20d）：9:00／12:00 のまとめは、未完了の案件を1件1枚のカード（番号・名前（所属）・受付日時と何日前・状況・要約・内容200文字・
 *  ［対応します］［対応済みにする］）にしたカルーセル（1通10枚・1回の送信で5通＝50件まで。入りきらない分は最後のカードに「ほか○件は…」）。
 *  ボタンは受付のお知らせと同じ postback（INQ_button_）。カルーセルを送れなければ、今までの文字のまとめ（INQ_remindText）を送る。
 *  TOT反映の承認待ち・管理者へのお知らせ（朝のまとめ）は、いつも別の送信で、文字のまま勤怠管理グループへ。
 *
 * 書かないもの：トークン・合言葉は実行ログ・通知に出さない。実行ログに問い合わせの本文は出さない。
 * 返信はスタッフがLINE公式アカウントのチャット画面から行う（システムは返信の内容を読めない）。
 */

var INQ_VERSION = '2026-11-20e';   // 版 2026-11-20e：まとめは 9:00／12:00（本番 11/20 14:39 から）。管理者へのお知らせを付けるのは 10:30 より前の回（9時の回）だけ
var INQ_VERSION_20D = '2026-11-20d';   // 版 2026-11-20d：9:00／12:00 のまとめを、1件1枚のカード（ボタン付き）のカルーセルで送る（送れなければ今までの文字のまとめ）
var INQ_VERSION_20B = '2026-11-20b';   // 版 2026-11-20b：通知の内容を200文字（まとめは50文字）・写真・スタンプ・ファイルの表示・30分以内の続きの内容をつなぐ・送り先を「従業員連絡」グループへ
var INQ_VERSION_17E = '2026-11-17e';   // 版 2026-11-17e：まとめの番号で「1.3対応済み」、土日祝はまとめを送らない（INQ_REMIND_DAYS=weekdays）、管理者へのお知らせを朝のまとめに
var INQ_VERSION_16A = '2026-11-16a';   // 版 2026-11-16a：まとめの「何日前から」、返信が要らないLINEの自動の対応済み、本人への案内の最後のAIの一文

var INQ_STATE = { open: '未対応', doing: '対応中', done: '対応済み' };
var INQ_SHEET_CASE = '問い合わせ';
var INQ_CASE_HEADER = ['案件番号', '状態', '社員番号', '氏名', '所属', '紐付け', 'LINEユーザーID', 'LINE表示名', '受付日時',
  '内容（冒頭）', '機密あり', '最終受信日時', '追記の回数', '担当者', '担当者ID', '対応開始日時', '完了者', '完了者ID', '完了日時',
  '最後の追記通知', '合言葉', '作成時のイベント番号'];
// 「問い合わせ」タブの列：名前 → 見出し（列の位置は毎回 1行目の見出しから求める：INQ_caseCols。並べ替え・非表示でも動く）
var INQ_C = { id: '案件番号', state: '状態', code: '社員番号', name: '氏名', dept: '所属', link: '紐付け', userId: 'LINEユーザーID',
  lineName: 'LINE表示名', at: '受付日時', head: '内容（冒頭）', secret: '機密あり', lastAt: '最終受信日時', appends: '追記の回数',
  staff: '担当者', staffId: '担当者ID', takenAt: '対応開始日時', doneBy: '完了者', doneById: '完了者ID', doneAt: '完了日時',
  appendNoticeAt: '最後の追記通知', token: '合言葉', eventId: '作成時のイベント番号' };
// 無くてもよい列（分類・要点。無ければ INQ_classifyFill_ が末尾に足す）。位置は -1
var INQ_C_OPTIONAL = { category: '分類', point: '要点' };
var INQ_SHEET_LOG = 'やりとり';
var INQ_LOG_HEADER = ['日時', '案件番号', '種類', '内容', 'LINEユーザーID', 'イベント番号', 'メッセージ番号'];
var INQ_SHEET_ROUTINE = '定型連絡';
var INQ_ROUTINE_HEADER = ['日時', '社員番号', '氏名', 'LINEユーザーID', '内容', 'イベント番号'];
var INQ_SHEET_RECEIVED = '受信記録';
var INQ_RECEIVED_HEADER = ['日時', 'イベント番号', '結果'];
var INQ_SHEET_GUIDED = '案内済み';
var INQ_GUIDED_HEADER = ['LINEユーザーID', '案内日時'];

var INQ_ROUTINE_WORDS = ['出勤', '退勤', '遅刻', '早退', '休憩', '休憩入り', '休憩終わり', '休憩終了', '戻り',
  'お疲れさま', 'お疲れ様', 'おつかれさま', 'お疲れさまでした', 'お疲れ様でした'];
var INQ_SECRET_WORDS = ['パスワード', 'パスコード', '暗証番号', '口座', 'カード番号', 'クレジット', 'セキュリティコード',
  'マイナンバー', '個人番号', 'pin', 'password'];
var INQ_HEAD_LEN = 200;          // 版 2026-11-20b：20 → 200（「内容（冒頭）」の列と受付のお知らせ）
var INQ_REMIND_HEAD_LEN = 50;    // 版 2026-11-20b：まとめは1件50文字まで
var INQ_MORE_LABEL = '…（続きはチャットで）';
var INQ_JOIN = '／';              // 30分以内に続けて届いた分のつなぎ
var INQ_FILE_NAME_LEN = 40;
// 版 2026-11-20b：受付のお知らせ・まとめの送り先の部門（「LINEグループ」タブ）。未登録・退出なら勤怠管理グループ（AC_ADMIN_GROUP）
var INQ_NOTICE_DEPT = '従業員連絡';
var INQ_APPEND_NOTICE_MS = 30 * 60 * 1000;
var INQ_DEDUPE_ROWS = 2000;     // 受信記録の直近の行数（重複の確認に使う。Workersの再送は最長24時間）
var INQ_SECRET_LABEL = '機密を含むため、チャットで確認してください';
var INQ_SENSITIVE_LABEL = '（内容はチャットで確認してください）';   // 要注意の分類のとき、内容の代わりに出す
var INQ_REMIND_HOURS = [9, 12];   // 2026-11-20：15時はみんな帰っているため 9時・12時に（安藤さん）
var INQ_LAST_REMIND_KEY = 'inq:lastRemind';   // 版 2026-11-17e：いちばん新しいまとめの番号の並び（ユーザーのプロパティ）
var INQ_TEXT_MAX = 4900;

// 分類と、そのキーワード（上から順に優先。後から足すときは words に足すだけ）。
// sensitive：ハラスメント・給与・口座・マイナンバー・健康。分類の先頭に「⚠」を付け、ほかの分類より優先する（取り扱いに注意が要るため）。
//  お知らせには分類名だけを出し、要点・内容は出さない。当たりの数が同じなら上にあるもの（ハラスメントが先）
// ハラスメント・人間関係（仕様書14章）：迷う言葉（怒られた・きつい・辞めたい など）は入れない。取りこぼしは手で分類を直す
var INQ_CLASS_COLS = ['分類', '要点'];
var INQ_CATEGORIES = [
  { name: 'ハラスメント・人間関係', sensitive: true, words: ['ハラスメント', 'パワハラ', 'セクハラ', 'モラハラ', 'マタハラ', 'いじめ', 'イジメ', '嫌がらせ', '人間関係'] },
  { name: '給与・明細', sensitive: true, words: ['給与', '給料', '明細', '賞与', 'ボーナス', '振込', '振り込み', '支給', '手当', '源泉', '年末調整', '時給', '残業代', '交通費'] },
  { name: '口座・マイナンバー', sensitive: true, words: ['口座', 'マイナンバー', '個人番号', '銀行', '通帳', 'キャッシュカード'] },
  { name: '健康・体調', sensitive: true, words: ['体調', '発熱', '熱が', '病院', '通院', '診断', '怪我', 'ケガ', 'けが', '痛い', '痛み', '入院', '健康', 'コロナ', 'インフル', '感染', '具合'] },
  { name: 'アルコールチェック', words: ['アルコール', 'チェッカー', '飲酒', '検知', '呼気'] },
  { name: '車両・免許', words: ['車両', '社用車', '免許', '事故', '給油', 'ガソリン', '駐車', 'タイヤ', '運転'] },
  { name: '勤怠・打刻', words: ['打刻', '打ち忘れ', '押し忘れ', '勤怠', 'タイムカード', 'touch on time', 'tot', '遅刻', '早退', '残業', '休憩', '出勤', '退勤'] },
  { name: 'シフト・希望休', words: ['シフト', '希望休', '公休', '勤務日', '出勤日'] },
  { name: '有給・休み', words: ['有給', '有休', '休暇', '欠勤', '休み', '休む', '休ませ', '忌引'] },
  { name: '書類・手続き', words: ['書類', '手続', '証明', '申請書', '提出', '住所', '扶養', '保険証', '年金', '雇用保険', '社会保険', '契約'] },
];
var INQ_OTHER = 'その他';
var INQ_POINT_LEN = 30, INQ_FIRST_LEN = 20;

// ======================================================================
// 純粋関数（Node.js のテストから使う）
// ======================================================================

/**
 * 純粋関数：本文から分類と要点。{ category, point }
 *  分類：当てはまったキーワードの多い分類（同じ数なら INQ_CATEGORIES の順）。⚠の分類が1つでも当てはまればそちらを優先。無ければ「その他」
 *  要点：日付（11/8・11月8日 → 11/8）と、当てはまったキーワード（本文に出てくる順に最大3つ）を「／」でつなぐ（30文字以内）。
 *        キーワードが無ければ、本文の最初の一文を20文字に切る
 */
function INQ_classify(text, categories) {
  var cats = categories || INQ_CATEGORIES;
  var t = INQ_nfkc(text).replace(/\s+/g, ' ').trim(), low = t.toLowerCase();
  var best = null, bestSens = null, found = [];
  cats.forEach(function (c, ci) {
    var hits = 0;
    c.words.forEach(function (w) {
      var i = low.indexOf(INQ_nfkc(w).toLowerCase());
      if (i === -1) return;
      if (/^[a-z]+$/.test(w) && /[a-z0-9]/.test(low.charAt(i - 1) + low.charAt(i + w.length))) return;   // 英字は単語のときだけ
      hits++;
      if (!found.some(function (f) { return f.w === w || (f.i <= i && i < f.i + f.w.length) || (i <= f.i && f.i < i + w.length); })) found.push({ w: w, i: i });
    });
    if (!hits) return;
    var cand = { name: (c.sensitive ? '⚠' : '') + c.name, hits: hits, order: ci };
    if (!best || hits > best.hits) best = cand;
    if (c.sensitive && (!bestSens || hits > bestSens.hits)) bestSens = cand;
  });
  var cat = bestSens || best;
  if (!cat) return { category: INQ_OTHER, point: INQ_firstSentence(t, INQ_FIRST_LEN) };
  var dates = [];
  var re = /(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})\s*日?/g, m;
  while ((m = re.exec(t)) && dates.length < 2) {
    var mo = Number(m[1]), d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    var ds = mo + '/' + d;
    if (dates.indexOf(ds) === -1) dates.push(ds);
  }
  var words = found.sort(function (a, b) { return a.i - b.i; }).slice(0, 3).map(function (f) { return f.w; });
  return { category: cat.name, point: Array.from(dates.concat(words).join('／')).slice(0, INQ_POINT_LEN).join('') };
}

/** 純粋関数：最初の一文（。！？!? 改行まで）を n 文字に切る */
function INQ_firstSentence(text, n) {
  var t = String(text == null ? '' : text).trim();
  var first = t.split(/[。．！？!?\n]/).map(function (x) { return x.trim(); }).filter(Boolean)[0] || t;
  return Array.from(first.replace(/^「|」$/g, '')).slice(0, n || INQ_FIRST_LEN).join('');
}

/**
 * 純粋関数：問い合わせタブ・やりとりタブの値から、埋める行。
 * 戻り値 { cols: { category, point }（0始まりの列。無ければ末尾に足す位置）, addHeader, fills: [{ row（0始まり）, category, point }] }
 * 「分類」が空の行だけ。要点が手で入っていれば要点はそのまま（point: null）
 */
function INQ_classifyPlan(caseValues, logValues, categories) {
  var head = (caseValues && caseValues[0]) || [];
  var cols = INQ_caseCols(head);
  if (!cols.ok) return { error: INQ_colsMessage(cols), cols: { category: -1, point: -1 }, addHeader: [], fills: [] };   // 列の見出しに問題：何も書かない
  var C = cols.col, width = head.length;
  var ci = C.category, pi = C.point, addHeader = [];
  if (ci === -1) { ci = width; addHeader.push({ col: ci, name: INQ_CLASS_COLS[0] }); width++; }
  if (pi === -1) { pi = Math.max(width, ci + 1); addHeader.push({ col: pi, name: INQ_CLASS_COLS[1] }); }
  var firstBody = {};
  (logValues || []).forEach(function (r, i) {
    if (i === 0 || !r[1] || r[2] !== '受付' || firstBody[r[1]] != null) return;
    firstBody[r[1]] = String(r[3] == null ? '' : r[3]);
  });
  var fills = [];
  for (var i = 1; i < (caseValues || []).length; i++) {
    var r = caseValues[i], id = r[C.id];
    if (!id || String(r[ci] == null ? '' : r[ci]).trim()) continue;
    var body = firstBody[id] != null ? firstBody[id] : String(r[C.head] || '').replace(/^「|」$/g, '');
    var res = INQ_classify(body, categories);
    fills.push({ row: i, category: res.category, point: String(r[pi] == null ? '' : r[pi]).trim() ? null : res.point });
  }
  return { cols: { category: ci, point: pi }, addHeader: addHeader, fills: fills };
}

/** 全角英数字・記号を半角に（NFKC）。null は空文字 */
function INQ_nfkc(text) {
  var t = String(text == null ? '' : text);
  return t.normalize ? t.normalize('NFKC') : t;
}

function INQ_words_(base, extra) {
  return base.concat(String(extra || '').split(/[、,，\n]+/).map(function (x) { return x.trim(); }).filter(Boolean));
}

/**
 * 純粋関数：定型連絡（出勤・退勤・遅刻など）だけのメッセージか。
 * 空白・句読点・記号・絵文字と、語尾（です・します・しました・ます・ました）を除いて、一覧の言葉と完全に一致するときだけ true。
 * 相談や理由を含む文は false（取りこぼさない側）。
 */
function INQ_isRoutine(text, extraWords) {
  var t = INQ_nfkc(text)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[\s。、．，.,!?！？・~〜ー―…:：;；"'“”‘’()（）「」『』\[\]【】w笑]+/g, '');
  if (!t || t.length > 15) return false;
  for (var i = 0; i < 3; i++) t = t.replace(/(しました|します|でした|です|ました|ます)$/, '');
  var list = INQ_words_(INQ_ROUTINE_WORDS, extraWords).map(function (w) { return INQ_nfkc(w).replace(/[\s　]+/g, ''); });
  return list.indexOf(t) !== -1;
}

/**
 * 版 2026-11-16a：返信が要らない言葉（承知・了解・お礼・よろしく、とその言い換え）。前後の挨拶（お疲れ様です など）は付いていてもよい
 */
var INQ_ACK_WORDS = ['承知いたしました', '承知致しました', '承知しました', '承知です', '了解いたしました', '了解致しました', '了解しました', '了解です', '了解',
  'りょうかいです', 'りょうかいしました', 'りょうかい', 'かしこまりました', 'わかりました', '分かりました', '解りました',
  'ありがとうございました', 'ありがとうございます', '有難うございました', '有難うございます', '有り難うございました', '有り難うございます', 'ありがとうです', 'ありがとう',
  'よろしくお願いいたします', 'よろしくお願い致します', 'よろしくお願いします', 'よろしくおねがいします', 'よろしくおねがいいたします',
  '宜しくお願いいたします', '宜しくお願い致します', '宜しくお願いします'];
var INQ_ACK_GREETINGS = ['お疲れ様です', 'お疲れさまです', 'おつかれさまです', 'お疲れ様でした', 'お疲れさまでした', 'おつかれさまでした', 'お疲れ様', 'お疲れさま', 'おつかれさま'];
var INQ_AUTO_DONE_BY = 'AI（自動）';

/**
 * 純粋関数（版 2026-11-16a）：本文が返信の要らない言葉だけでできているか。
 * 空白・句読点・記号（。！!など）・絵文字と、挨拶（お疲れ様です など）を除き、残りが INQ_ACK_WORDS の言葉だけ（1つ以上）なら true。
 * ほかの文が少しでも残れば false（人が確認する側に倒す）
 */
function INQ_isAckOnly(text) {
  var t = INQ_nfkc(text)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[\s。、．，.,!?！？・~〜…:：;；"'“”‘’()（）「」『』\[\]【】♪☆★]+/g, '');
  if (!t) return false;
  var norm = function (w) { return INQ_nfkc(w); };
  var words = INQ_ACK_WORDS.map(norm), greet = INQ_ACK_GREETINGS.map(norm), all = words.concat(greet);
  all.sort(function (a, b) { return b.length - a.length; });
  var hits = 0;
  while (t) {
    var m = null;
    for (var i = 0; i < all.length; i++) if (t.indexOf(all[i]) === 0) { m = all[i]; break; }
    if (!m) return false;
    if (words.indexOf(m) !== -1) hits++;
    t = t.slice(m.length);
  }
  return hits > 0;
}

/** 純粋関数（版 2026-11-16a）：LINEのメッセージが返信の要らないものか（スタンプだけ、または INQ_isAckOnly の文。LINE絵文字は除いて判定） */
function INQ_isAckMessage(message) {
  var m = message || {};
  if (m.type === 'sticker') return true;
  if (m.type !== 'text') return false;
  var t = String(m.text || '');
  (Array.isArray(m.emojis) ? m.emojis.slice() : []).sort(function (a, b) { return (b.index || 0) - (a.index || 0); }).forEach(function (e) {
    var i = Number(e && e.index), n = Number(e && e.length) || 0;
    if (i >= 0 && n > 0) t = t.slice(0, i) + t.slice(i + n);
  });
  return INQ_isAckOnly(t);
}

/**
 * 純粋関数（版 2026-11-16a）：自動で「対応済み」にするか。
 * isNew：新しい受付（state は未使用）／追記なら、その案件が対応中のときだけ（未対応への追記は質問の続きのことがあるため閉じない）。要注意（⚠）の分類は閉じない
 */
function INQ_shouldAutoClose(isAck, isNew, state, category) {
  if (!isAck || INQ_isSensitiveCategory(category)) return false;
  return isNew ? true : state === INQ_STATE.doing;
}

/** 数字の間の空白・ハイフン類を詰める（カード番号・電話番号の区切り） */
function INQ_joinDigits_(t) {
  return t.replace(/(\d)[\s\-‐‑‒–—−ｰー－]+(?=\d)/g, '$1');
}

/** 純粋関数：機密（パスワード・口座・カード番号・マイナンバー等の言葉、または7桁以上の数字）を含むか */
function INQ_hasSecret(text, extraWords) {
  var t = INQ_nfkc(text).toLowerCase();
  if (/\d{7,}/.test(INQ_joinDigits_(t))) return true;
  return INQ_words_(INQ_SECRET_WORDS, extraWords).some(function (w) { return t.indexOf(INQ_nfkc(w).toLowerCase()) !== -1; });
}

/**
 * 純粋関数：保存用に機密の部分を伏せる。7桁以上の数字（区切りを含む）は「＊＊＊」、
 * 機密の言葉がある行は、その言葉より後ろを「＊＊＊」にする。
 */
function INQ_maskSecret(text, extraWords) {
  var words = INQ_words_(INQ_SECRET_WORDS, extraWords).map(function (w) { return INQ_nfkc(w).toLowerCase(); });
  return INQ_nfkc(text).split('\n').map(function (line) {
    var l = line.replace(/\d(?:[\s\-‐‑‒–—−ｰー－]*\d){6,}/g, '＊＊＊');
    var low = l.toLowerCase(), cut = -1;
    words.forEach(function (w) {
      var i = low.indexOf(w);
      if (i !== -1 && (cut === -1 || i + w.length < cut)) cut = i + w.length;
    });
    return cut === -1 ? l : l.slice(0, cut) + '＊＊＊';
  }).join('\n');
}

/** 純粋関数：冒頭 n 文字（改行は空白に。絵文字も1文字）。超えたら「…」 */
function INQ_head(text, n) {
  n = n || INQ_HEAD_LEN;
  var chars = Array.from(String(text == null ? '' : text).replace(/\s*[\r\n]+\s*/g, ' ').trim());
  return chars.length > n ? chars.slice(0, n).join('') + '…' : chars.join('');
}

/**
 * 純粋関数：文字以外のメッセージの内容の表示。スタンプは null（記録だけにする。保存するときは INQ_STICKER_LABEL）。
 * 版 2026-11-20b：「［写真1枚］」「［動画］」「［ファイル（名前）］」の形（ファイル名は40文字まで）
 */
var INQ_STICKER_LABEL = '［スタンプ］';
function INQ_messageSummary(message) {
  var m = message || {};
  var labels = { image: '［写真1枚］', video: '［動画］', audio: '［音声］', location: '［位置情報］' };
  if (m.type === 'text') return String(m.text || '');
  if (m.type === 'sticker') return null;
  if (m.type === 'file') {
    var fn = Array.from(String(m.fileName || '').replace(/[\s\r\n]+/g, ' ').trim());
    return fn.length ? '［ファイル（' + fn.slice(0, INQ_FILE_NAME_LEN).join('') + (fn.length > INQ_FILE_NAME_LEN ? '…' : '') + '）］' : '［ファイル］';
  }
  return labels[m.type] || '［' + String(m.type || '不明') + '］';
}

/**
 * 純粋関数（版 2026-11-20b）：「内容（冒頭）」に、30分以内に続けて届いた分をつなぐ（INQ_HEAD_LEN 文字まで。超えたら末尾に「…」）。
 * すでに切れている（末尾が「…」）ならそのまま。写真が続いたら「［写真2枚］」のように数える
 */
function INQ_joinHead(head, more) {
  var h = String(head == null ? '' : head), add = INQ_head(more, INQ_HEAD_LEN);
  if (!add) return h;
  if (!h) return add;
  if (Array.from(h).length > INQ_HEAD_LEN) return h;   // すでに切れている（200文字＋「…」）
  var pm = /［写真(\d+)枚］$/.exec(h), am = /^［写真(\d+)枚］$/.exec(add);
  if (pm && am) return h.slice(0, pm.index) + '［写真' + (Number(pm[1]) + Number(am[1])) + '枚］';
  return INQ_head(h + INQ_JOIN + add, INQ_HEAD_LEN);
}

/** 純粋関数（版 2026-11-20b）：続けて届いた分か（最後に受け取ってから30分以内） */
function INQ_isContinuation(lastAtMs, nowMs) {
  return lastAtMs > 0 && nowMs - lastAtMs >= 0 && nowMs - lastAtMs <= INQ_APPEND_NOTICE_MS;
}

/**
 * 純粋関数：LINEユーザーIDから従業員マスタの行を探す（氏名・表示名からは推測しない）。
 * 戻り値 { link: 'registered'|'pending'|'unregistered'|'duplicate', code, name, dept, retired }
 *  registered：IDが一致し「LINE確認済み」あり（1行だけ）／pending：IDは一致するが未確認／
 *  unregistered：一致する行なし／duplicate：一致する行が2つ以上
 */
function INQ_matchEmployee(masterValues, userId, today) {
  var rows = [];
  for (var i = 1; i < (masterValues || []).length; i++) {
    if (userId && String(masterValues[i][AC_COL.userId] || '').trim() === userId) rows.push(masterValues[i]);
  }
  if (!rows.length) return { link: 'unregistered' };
  if (rows.length > 1) return { link: 'duplicate' };
  var r = rows[0];
  if (r[AC_COL.lineOk] !== true) return { link: 'pending' };
  return { link: 'registered', code: AC_cellCode_(r[AC_COL.code]), name: String(r[AC_COL.name] || '').trim(),
    dept: String(r[AC_COL.dept] || '').trim(),
    retired: String(r[AC_COL.status] || '').trim() === '退職' || (!!today && AC_isRetired(r[AC_COL.retiredOn], today)) };
}

/** 純粋関数：通知に出す従業員の表示（氏名（所属）／確認待ち・未登録・要確認（LINE表示名）） */
function INQ_whoLabel(match, displayName) {
  var dn = String(displayName || '表示名なし');
  if (match.link === 'registered') {
    return (match.name || '氏名未入力') + (match.retired ? '（退職）' : '') + '（' + (match.dept || '所属未設定') + '）';
  }
  return { pending: '確認待ち', unregistered: '未登録', duplicate: '要確認' }[match.link] + '（' + dn + '）';
}

/** 純粋関数：postback の中身を読む。問い合わせのもの（inq|1|操作|案件番号|合言葉）でなければ null */
function INQ_parsePostback(data) {
  var m = /^inq\|1\|(take|done)\|(Q-\d{8}-\d{3})\|([0-9a-f]{6})$/.exec(String(data || ''));
  return m ? { action: m[1], id: m[2], token: m[3] } : null;
}

function INQ_postbackData(action, id, token) { return 'inq|1|' + action + '|' + id + '|' + token; }

/**
 * 純粋関数：ボタンを押したときの状態の移り方（一方向：未対応 → 対応中 → 対応済み）。
 * 戻り値 { next, changed, reason }。reason：'taken'|'done'|'alreadyDoing'|'alreadyDone'
 */
function INQ_decide(state, action) {
  if (state === INQ_STATE.done) return { next: state, changed: false, reason: 'alreadyDone' };
  if (action === 'take') {
    return state === INQ_STATE.open ? { next: INQ_STATE.doing, changed: true, reason: 'taken' }
      : { next: state, changed: false, reason: 'alreadyDoing' };
  }
  return { next: INQ_STATE.done, changed: true, reason: 'done' };
}

/** 純粋関数：次の案件番号 Q-YYYYMMDD-NNN（その日の既存の番号の続き） */
function INQ_nextId(ids, today) {
  var prefix = 'Q-' + String(today).replace(/-/g, '') + '-', max = 0;
  (ids || []).forEach(function (id) {
    id = String(id || '');
    if (id.indexOf(prefix) === 0) max = Math.max(max, Number(id.slice(prefix.length)) || 0);
  });
  return prefix + ('00' + (max + 1)).slice(-3);
}

/** 純粋関数：対応中の案件への追記を知らせるか（同じ案件で30分に1回まで） */
function INQ_shouldNotifyAppend(state, lastNoticeMs, nowMs) {
  if (state !== INQ_STATE.doing) return false;
  return !(lastNoticeMs > 0) || nowMs - lastNoticeMs >= INQ_APPEND_NOTICE_MS;
}

function INQ_hm_(d) { return Utilities.formatDate(d, AC_TZ, 'HH:mm'); }
function INQ_ymd_(d) { return Utilities.formatDate(d, AC_TZ, 'yyyy-MM-dd'); }
/** 日本時間の曜日（0=日 … 6=土） */
function INQ_dow_(d) { return new Date(INQ_ymd_(d) + 'T12:00:00+09:00').getUTCDay(); }
function INQ_md_(d) {
  var p = INQ_ymd_(d).split('-');
  return Number(p[1]) + '/' + Number(p[2]) + '（' + '日月火水木金土'.charAt(INQ_dow_(d)) + '）';
}

/**
 * 純粋関数：一覧・通知に出す内容（機密ありならチャットで確認。要注意の分類なら「（内容はチャットで確認してください）」）。
 * 版 2026-11-20b：forRemind が無い（受付のお知らせ）なら200文字まで・切れていれば「…（続きはチャットで）」。
 * forRemind（まとめ）なら50文字まで（超えたら「…」）
 */
function INQ_shownHead(c, sensitive, forRemind) {
  if (c.secret) return INQ_SECRET_LABEL;
  if (sensitive) return INQ_SENSITIVE_LABEL;
  var h = String(c.head || ''), chars = Array.from(h);
  var cut = chars.length > INQ_HEAD_LEN;   // 保存のときに切れた（200文字＋「…」）。本人が打った「…」は切れた印にしない
  var body = cut ? chars.slice(0, INQ_HEAD_LEN).join('') : h;
  if (forRemind) {
    var b = Array.from(body);
    return '「' + (b.length > INQ_REMIND_HEAD_LEN ? b.slice(0, INQ_REMIND_HEAD_LEN).join('') + '…' : body) + '」';
  }
  return '「' + body + (cut ? INQ_MORE_LABEL : '') + '」';
}

/**
 * 純粋関数：要注意の分類か（先頭が「⚠」、または ⚠ を外した名前が INQ_CATEGORIES の sensitive の分類）。
 * シートで手で直した分類（⚠ を付け忘れたもの）も要注意として扱う
 */
function INQ_isSensitiveCategory(category, categories) {
  var cat = String(category == null ? '' : category).trim();
  if (!cat) return false;
  if (cat.charAt(0) === '⚠') return true;
  return (categories || INQ_CATEGORIES).some(function (x) { return x.sensitive && x.name === cat; });
}

/** 「11/13 9:00」（曜日なし・時は0を付けない） */
function INQ_mdhm_(d) {
  var p = INQ_ymd_(d).split('-');
  return Number(p[1]) + '/' + Number(p[2]) + ' ' + Number(Utilities.formatDate(d, AC_TZ, 'HH')) + ':' + Utilities.formatDate(d, AC_TZ, 'mm');
}

/** 純粋関数：お知らせに出す名前。登録済みなら「氏名（所属）」、それ以外は「氏名不明（LINE表示名）」。c はシートの値の形（link は「登録済み」など） */
function INQ_whoShort(c) {
  if (c.link === '登録済み') return (c.name || '氏名未入力') + '（' + (c.dept || '所属未設定') + '）';
  return '氏名不明（' + (c.lineName || '表示名なし') + '）';
}

/**
 * 純粋関数：要約（分類／要点）。シートの「分類」「要点」が空なら、内容（冒頭）から同じ分類の関数で作る。
 * 機密ありは分類だけ（要点は出さない）。内容が無ければ「－」
 */
function INQ_summary(c) {
  var s = INQ_summaryParts_(c);
  if (!s.category) return '－';
  return c.secret || INQ_isSensitiveCategory(s.category) || !s.point ? s.category : s.category + '／' + s.point;
}

/** 純粋関数：分類と要点（シートの値。分類が空なら内容（冒頭）から作る）。内容も無ければ category は空 */
function INQ_summaryParts_(c) {
  var cat = String(c.category || '').trim(), pt = String(c.point || '').trim();
  if (!cat) {
    var src = String(c.head || '').replace(/…$/, '').trim();
    if (!src) return { category: '', point: '' };
    var r = INQ_classify(src);
    cat = r.category; pt = pt || r.point;
  }
  return { category: cat, point: pt };
}

/**
 * 純粋関数：状況（対応中なら担当）。now があれば、受付からの日数（日本時間の日付の差）と受付日を付ける（版 2026-11-16a）。
 * 例：「未対応（今日から）」「未対応（1日前から・11/15受付）」「対応中（担当：○○）（3日前から・11/12受付）」。
 * now が無いとき（受付時のお知らせ）は付けない
 */
function INQ_stateLabel(c, now) {
  var st = c.state === INQ_STATE.doing ? INQ_STATE.doing + '（担当：' + (c.staff || '未設定') + '）' : c.state;
  if (!now || !c.at) return st;
  var days = INQ_daysBetween(INQ_ymd_(c.at), INQ_ymd_(now));
  if (days <= 0) return st + '（今日から）';
  var p = INQ_ymd_(c.at).split('-');
  return st + '（' + days + '日前から・' + Number(p[1]) + '/' + Number(p[2]) + '受付）';
}
/** 純粋関数：日付（YYYY-MM-DD）の差の日数 */
function INQ_daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / 86400000);
}

/** 純粋関数：1件分の行（名前・状況・要約・内容） */
/**
 * 純粋関数：内容を出さない要注意の案件か。版 2026-11-20b：シートの分類が要注意でなくても、
 * 出す内容そのものが要注意の分類に当たるときは内容を出さない（続けて届いた分をつないだため）
 */
function INQ_caseSensitive(c) {
  return INQ_isSensitiveCategory(INQ_summaryParts_(c).category)
    || (!!String(c.head || '').trim() && INQ_isSensitiveCategory(INQ_classify(String(c.head).replace(/…$/, '')).category));
}
function INQ_caseLines(c, now) {
  var sensitive = INQ_caseSensitive(c);
  return [INQ_whoShort(c), '状況：' + INQ_stateLabel(c, now), '要約：' + INQ_summary(c), '内容：' + INQ_shownHead(c, sensitive, !!now)];
}

/**
 * 純粋関数：新しい問い合わせの通知（Flex Message：本文＋ボタン2つ）。案件番号は本文に出さない（ボタンの中身にだけ入る）。
 * c：{ id, at(Date), head, secret, state, token, name, dept, link, lineName, category, point }
 */
function INQ_newCaseMessage(c) {
  var title = '【問い合わせ】' + INQ_mdhm_(c.at), who = INQ_whoShort(c);
  var btn = function (label, action, shown) {
    return { type: 'button', style: action === 'take' ? 'primary' : 'secondary', height: 'sm',
      action: { type: 'postback', label: label, data: INQ_postbackData(action, c.id, c.token), displayText: (shown + '（' + who + '）').slice(0, 300) } };
  };
  return {
    type: 'flex', altText: (title + ' ' + who).slice(0, 400),
    contents: { type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [{ type: 'text', text: title, weight: 'bold', wrap: true }]
        .concat(INQ_caseLines(c, null).map(function (l) { return { type: 'text', text: l, wrap: true, size: 'sm' }; })) },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [btn('対応します', 'take', '対応します'), btn('対応済みにする', 'done', '対応済みにします')] } },
  };
}

/** 純粋関数：新しい問い合わせの通知の文字だけの版（ボタンを送れないときの管理者向け） */
function INQ_newCaseText(c) {
  return ['【問い合わせ】' + INQ_mdhm_(c.at)].concat(INQ_caseLines(c, null)).join('\n');
}

/** 純粋関数：対応中の案件への追記の短い通知 */
function INQ_appendText(c) {
  return '【問い合わせ・追記】' + INQ_whoShort(c) + 'から追記があります。チャットをご確認ください（担当：' + (c.staff || '未設定') + '）';
}

/**
 * 純粋関数：まとめのお知らせの文（0件なら null）。cases：シートの案件（INQ_cases_）
 * 未対応 → 対応中、それぞれ受付の古い順。案件番号は出さない。4,900文字を超えたら途中で切り「ほか○件はシートで確認」
 */
function INQ_remindList(cases) {
  var list = (cases || []).filter(function (c) { return c.state === INQ_STATE.open || c.state === INQ_STATE.doing; });
  list.sort(function (a, b) {
    if (a.state !== b.state) return a.state === INQ_STATE.open ? -1 : 1;
    return a.at.getTime() - b.at.getTime();
  });
  return list;
}
/** 純粋関数：まとめの番号の印（①〜⑳、21件目からは (21)） */
function INQ_mark(i) { return i < 20 ? String.fromCharCode(0x2460 + i) : '(' + (i + 1) + ')'; }

// ---- 版 2026-11-20d：まとめのカルーセル ----
var INQ_CAROUSEL_CARDS = 10;      // 1通のカルーセルのカードの数（LINE の上限）
var INQ_CAROUSEL_MESSAGES = 5;    // 1回の送信の通数（LINE の上限）
var INQ_MORE_CASES_TEXT = 'ほか{n}件は問い合わせ管理のシートで確認してください';

/** 純粋関数：受付からの日数の表示（「今日」「1日前」…。日本時間の日付の差） */
function INQ_daysAgoLabel(at, now) {
  var days = INQ_daysBetween(INQ_ymd_(at), INQ_ymd_(now));
  return days <= 0 ? '今日' : days + '日前';
}

/**
 * 純粋関数：まとめの1件のカード（bubble）。i は0始まりの番号、more は入りきらなかった件数（最後のカードにだけ渡す）。
 * 本文：番号 名前（所属）／受付：月/日 時:分（何日前）／状況（未対応・対応中（担当：○○））／要約／内容（200文字。機密・要注意は出さない）
 * ボタン：受付のお知らせと同じ postback（合言葉が無い行はボタンなし）
 */
function INQ_remindBubble(c, i, now, more) {
  var who = INQ_whoShort(c);
  var state = c.state === INQ_STATE.doing ? INQ_STATE.doing + '（担当：' + (c.staff || '未設定') + '）' : c.state;
  var body = [
    { type: 'text', text: INQ_mark(i) + ' ' + who, weight: 'bold', wrap: true },
    { type: 'text', text: '受付：' + (c.at ? INQ_mdhm_(c.at) + '（' + INQ_daysAgoLabel(c.at, now) + '）' : '不明'), size: 'xs', color: '#888888', wrap: true },
    { type: 'text', text: '状況：' + state, size: 'sm', color: c.state === INQ_STATE.doing ? '#1a73e8' : '#cc0000', wrap: true },
    { type: 'text', text: '要約：' + INQ_summary(c), size: 'sm', wrap: true },
    { type: 'separator' },
    { type: 'text', text: '内容：' + INQ_shownHead(c, INQ_caseSensitive(c), false), size: 'sm', wrap: true },
  ];
  if (more > 0) body.push({ type: 'separator' }, { type: 'text', text: INQ_MORE_CASES_TEXT.replace('{n}', more), size: 'xs', color: '#cc0000', wrap: true });
  var bubble = { type: 'bubble', size: 'mega', body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body } };
  if (c.id && c.token) {
    var btn = function (label, action, shown, style) {
      return { type: 'button', style: style, height: 'sm',
        action: { type: 'postback', label: label, data: INQ_postbackData(action, c.id, c.token), displayText: (shown + '（' + who + '）').slice(0, 300) } };
    };
    bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: [btn('対応します', 'take', '対応します', 'primary'), btn('対応済みにする', 'done', '対応済みにします', 'secondary')] };
  }
  return bubble;
}

/**
 * 純粋関数：まとめのカルーセル。0件なら null。
 * 戻り値 { messages（Flex のカルーセル。最大5通）, ids（カードにした案件番号。カードの番号の順）, total, shown, more }
 * 並びは文字のまとめと同じ（INQ_remindList）。1通10枚・5通＝50件まで。入りきらない分は最後のカードに「ほか○件は…」
 */
function INQ_remindCarousels(cases, now) {
  var list = INQ_remindList(cases);
  if (!list.length) return null;
  var max = INQ_CAROUSEL_CARDS * INQ_CAROUSEL_MESSAGES, shown = list.slice(0, max), more = list.length - shown.length;
  var alt = '【問い合わせ 未完了' + list.length + '件】' + INQ_mdhm_(now);
  var bubbles = shown.map(function (c, i) { return INQ_remindBubble(c, i, now, i === shown.length - 1 ? more : 0); });
  var messages = [];
  for (var k = 0; k < bubbles.length; k += INQ_CAROUSEL_CARDS) {
    messages.push({ type: 'flex', altText: alt, contents: { type: 'carousel', contents: bubbles.slice(k, k + INQ_CAROUSEL_CARDS) } });
  }
  return { messages: messages, ids: shown.map(function (c) { return c.id; }), total: list.length, shown: shown.length, more: more };
}

var INQ_DONE_HINT = '※対応済みのときは、公式LINEをメンションして「1.3対応済み」のように番号を送ってください。';
function INQ_remindText(cases, now) {
  var list = INQ_remindList(cases);
  if (!list.length) return null;
  var mark = INQ_mark;
  var head = '【問い合わせ 未完了' + list.length + '件】' + INQ_mdhm_(now);
  var body = list.map(function (c, i) { var l = INQ_caseLines(c, now); l[0] = mark(i) + ' ' + l[0]; return l.join('\n'); });
  var text = [head].concat(body).concat([INQ_DONE_HINT]).join('\n\n');
  if (text.length <= INQ_TEXT_MAX) return text;
  var kept = [], len = head.length + INQ_DONE_HINT.length + 2;
  for (var i = 0; i < body.length; i++) {
    if (len + 2 + body[i].length + 40 > INQ_TEXT_MAX) break;
    kept.push(body[i]); len += 2 + body[i].length;
  }
  return [head].concat(kept).concat(['…ほか' + (body.length - kept.length) + '件はシートで確認', INQ_DONE_HINT]).join('\n\n');
}

/**
 * 純粋関数（版 2026-11-17e）：グループの文が「①③対応済み」「1.3対応済み」「1、2、4 対応済みです」などか。
 * mention の部分は呼び出し側で除く。番号の配列（重ならない・小さい順）を返す。当てはまらなければ null。
 * 区切りのない「124」は1つの番号（124番）として返す（呼び出し側で件数を超えていれば区切って送るよう案内する）
 */
function INQ_parseDoneNumbers(text) {
  var t = String(text || '').replace(/[\s　]+/g, '');
  var m = /^(.+?)(?:は|を|の件は?)?(?:対応済み|対応済|対応完了|対応しました|済み|済|完了)(?:です|にしました|しました|にしてください|にして|でお願いします|お願いします)?[。.．!！]*$/.exec(t);
  if (!m) return null;
  var body = m[1].replace(/[①-⑳]/g, function (c) { return ',' + (c.charCodeAt(0) - 0x2460 + 1) + ','; })
    .replace(/[㉑-㉟]/g, function (c) { return ',' + (c.charCodeAt(0) - 0x3251 + 21) + ','; })
    .replace(/[㊱-㊿]/g, function (c) { return ',' + (c.charCodeAt(0) - 0x32B1 + 36) + ','; });
  body = INQ_nfkc(body).replace(/[()（）番]/g, ',').replace(/,*([〜~～])，*,*/g, '$1');
  if (!/^[0-9,.、・と&\/〜~～\-]+$/.test(body) || !/[0-9]/.test(body)) return null;
  body = body.replace(/(\d+)[〜~～\-](\d+)/g, function (all, a, b) {
    a = Number(a); b = Number(b);
    if (b < a || b - a > 50) return all;
    var r = []; for (var i = a; i <= b; i++) r.push(i); return r.join(',');
  });
  if (/[〜~～\-]/.test(body)) return null;
  var nums = body.split(/[,.、・と&\/]+/).filter(String).map(Number).filter(function (n) { return n >= 1 && n <= 999; });
  if (!nums.length || nums.length > 50) return null;
  return nums.filter(function (n, i) { return nums.indexOf(n) === i; }).sort(function (a, b) { return a - b; });
}

/** 純粋関数：mention の部分（index・length）を文から除く */
function INQ_stripMentions(text, mention) {
  var t = String(text || ''), list = (mention && mention.mentionees) || [];
  list.slice().sort(function (a, b) { return b.index - a.index; }).forEach(function (x) {
    if (typeof x.index === 'number' && typeof x.length === 'number') t = t.slice(0, x.index) + ' ' + t.slice(x.index + x.length);
  });
  return t;
}

/**
 * 純粋関数：1行目の見出しから列の位置（0始まり）。{ ok, col: { 名前: 位置 }, missing: [見出し], dup: [見出し], width }
 * 見出しの前後の空白は無視。必要な列（INQ_C）が無い、または必要な列・分類・要点の見出しが2つ以上あれば ok=false。
 * 分類・要点（INQ_C_OPTIONAL）は無くてもよい（位置は -1）。ほかの見出しの列（管理本部が足した列など）は読まない・書かない
 */
function INQ_caseCols(head) {
  var pos = {}, seen = {}, dup = [], col = {}, missing = [];
  (head || []).forEach(function (h, i) {
    var n = String(h == null ? '' : h).trim();
    if (!n) return;
    if (Object.prototype.hasOwnProperty.call(seen, n)) { if (dup.indexOf(n) === -1) dup.push(n); return; }
    seen[n] = true; pos[n] = i;
  });
  var has = function (n) { return Object.prototype.hasOwnProperty.call(pos, n); };
  Object.keys(INQ_C).forEach(function (k) { if (has(INQ_C[k])) col[k] = pos[INQ_C[k]]; else missing.push(INQ_C[k]); });
  Object.keys(INQ_C_OPTIONAL).forEach(function (k) { col[k] = has(INQ_C_OPTIONAL[k]) ? pos[INQ_C_OPTIONAL[k]] : -1; });
  var known = Object.keys(INQ_C).map(function (k) { return INQ_C[k]; }).concat(Object.keys(INQ_C_OPTIONAL).map(function (k) { return INQ_C_OPTIONAL[k]; }));
  dup = dup.filter(function (n) { return known.indexOf(n) !== -1; });
  return { ok: !missing.length && !dup.length, col: col, missing: missing, dup: dup, width: (head || []).length };
}

/** 純粋関数：列の見出しの問題の説明（見出しの名前だけ。シートの中身は出さない） */
function INQ_colsMessage(cols) {
  var parts = [];
  if (cols.missing.length) parts.push('見つからない見出し：' + cols.missing.join('、'));
  if (cols.dup.length) parts.push('2つ以上ある見出し：' + cols.dup.join('、'));
  return '「' + INQ_SHEET_CASE + '」タブの列の見出しに問題があります（' + parts.join('／') + '）';
}

/** 今までの並び（INQ_CASE_HEADER の順）の列の位置。テストや、列の位置を渡さない呼び出し用 */
var INQ_DEFAULT_COLS = INQ_caseCols(INQ_CASE_HEADER).col;

/** 純粋関数：新しい行（見出しの位置に値を入れる。ほかの列は空）。values：{ 名前: 値 } */
function INQ_newCaseRow(col, width, values) {
  var w = width || 0;
  Object.keys(values).forEach(function (k) { if (col[k] >= 0) w = Math.max(w, col[k] + 1); });
  var row = [];
  for (var i = 0; i < w; i++) row.push('');
  Object.keys(values).forEach(function (k) { if (col[k] >= 0) row[col[k]] = values[k]; });
  return row;
}

/** 純粋関数：シートの1行 → 案件。col：列の位置（INQ_caseCols の col。省略時は今までの並び） */
function INQ_rowToCase(r, i, col) {
  var C = col || INQ_DEFAULT_COLS;
  var d = function (v) { return v instanceof Date ? v : (v ? new Date(v) : null); };
  var cell = function (k) { return C[k] >= 0 ? r[C[k]] : ''; };
  return { row: i + 1, id: String(cell('id') || ''), state: String(cell('state') || ''), code: AC_cellCode_(cell('code')),
    name: String(cell('name') || ''), dept: String(cell('dept') || ''), link: String(cell('link') || ''),
    userId: String(cell('userId') || ''), lineName: String(cell('lineName') || ''), at: d(cell('at')), head: String(cell('head') || ''),
    secret: cell('secret') === true, appends: Number(cell('appends')) || 0, staff: String(cell('staff') || ''),
    appendNoticeAt: d(cell('appendNoticeAt')), lastAt: d(cell('lastAt')), token: String(cell('token') || ''), who: '',
    doneBy: String(cell('doneBy') || ''), doneAt: d(cell('doneAt')),
    category: C.category >= 0 ? String(r[C.category] == null ? '' : r[C.category]).trim() : '',
    point: C.point >= 0 ? String(r[C.point] == null ? '' : r[C.point]).trim() : '' };
}

/** 純粋関数：案件の表示名（シートの値から） */
function INQ_caseWho(c) {
  if (c.link === '登録済み') return (c.name || '氏名未入力') + '（' + (c.dept || '所属未設定') + '）';
  return (c.link || '未登録') + '（' + (c.lineName || '表示名なし') + '）';
}

/** 純粋関数：その人の未完了の案件（いちばん新しいもの）。無ければ null */
function INQ_openCaseOf(cases, userId) {
  var hit = null;
  (cases || []).forEach(function (c) {
    if (c.userId === userId && (c.state === INQ_STATE.open || c.state === INQ_STATE.doing)) hit = c;
  });
  return hit;
}

var INQ_LINK_LABEL = { registered: '登録済み', pending: '確認待ち', unregistered: '未登録', duplicate: '要確認' };

// ======================================================================
// シート・LINEとのやり取り（Apps Script 上でのみ動く）
// ======================================================================

function INQ_props_() { return PropertiesService.getScriptProperties(); }
function INQ_mode_() {
  var m = String(INQ_props_().getProperty('INQ_MODE') || 'off').trim();
  return m === 'on' || m === 'record' ? m : 'off';
}

function INQ_book_() {
  var id = INQ_props_().getProperty('INQ_SPREADSHEET_ID');
  if (!id) throw AC_error_('問い合わせの記録先（INQ_SPREADSHEET_ID）が未設定です');
  return SpreadsheetApp.openById(id);
}

function INQ_sheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * 「問い合わせ」タブを読む：{ cols（INQ_caseCols）, cases }。列の位置は1行目の見出しから（非表示の列も読む）。
 * 見出しに問題があれば、エラー（inqCols=true）を出す（呼び出し側でその処理だけをやめる）
 */
function INQ_caseSheet_(sh) {
  var v = sh.getDataRange().getValues(), cols = INQ_caseCols(v[0] || []), out = [];
  if (!cols.ok) { var e = AC_error_(INQ_colsMessage(cols)); e.inqCols = true; throw e; }
  for (var i = 1; i < v.length; i++) {
    if (!v[i][cols.col.id]) continue;
    out.push(INQ_rowToCase(v[i], i, cols.col));
  }
  return { cols: cols, cases: out };
}

function INQ_cases_(sh) { return INQ_caseSheet_(sh).cases; }

/** 1つのセルに書く（列の位置は見出しから求めたもの） */
function INQ_setCell_(sh, row, col, key, value) { sh.getRange(row, col[key] + 1).setValue(value); }

/** 受信記録の直近の行に、このイベント番号があるか */
function INQ_seenInSheet_(sh, eventId) {
  var last = sh.getLastRow();
  if (last < 2) return false;
  var n = Math.min(INQ_DEDUPE_ROWS, last - 1);
  var v = sh.getRange(last - n + 1, 2, n, 1).getValues();
  for (var i = 0; i < v.length; i++) if (String(v[i][0]) === eventId) return true;
  return false;
}

function INQ_cacheKey_(id) { return 'inq:ev:' + id; }

/** 重複受信なら true（一時記憶 → 受信記録の順に確かめる） */
function INQ_isDuplicate_(ev, received) {
  var id = ev && ev.webhookEventId;
  if (!id) return false;
  if (CacheService.getScriptCache().get(INQ_cacheKey_(id))) return true;
  return INQ_seenInSheet_(received, id);
}

function INQ_markSeen_(ev, received, result) {
  var id = ev && ev.webhookEventId;
  received.appendRow([new Date(), id || '（番号なし）', result]);
  if (id) CacheService.getScriptCache().put(INQ_cacheKey_(id), '1', 21600);
}

// 先頭を必ず英字（a〜f）にする：数字だけの合言葉（例 012345）はスプレッドシートが数値に変えて先頭の0が消え、ボタンが使えなくなるため
function INQ_token_() {
  var h = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  return 'abcdef'.charAt(parseInt(h.charAt(0), 16) % 6) + h.slice(1, 6);
}

/**
 * 純粋関数（版 2026-11-20b）：送り先のグループを、送る順に [{ dept, list }]。byDept は AC_groupsByDept の結果（状態「有効」だけ）。
 * kind 'inquiry'（受付・追記・まとめ）：従業員連絡 → 勤怠管理。kind 'admin'（TOT反映の承認待ち・管理者へのお知らせ）：勤怠管理だけ。
 * 登録の無い部門は入れない（空の配列なら、呼び出し側で管理者の個別LINEへ）
 */
function INQ_targetPlan(byDept, kind) {
  var b = byDept || {}, tiers = [];
  [kind === 'admin' ? null : INQ_NOTICE_DEPT, AC_ADMIN_GROUP].forEach(function (d) {
    if (d && b[d] && b[d].length) tiers.push({ dept: d, list: b[d].slice() });
  });
  return tiers;
}

/** 純粋関数（版 2026-11-20b）：問い合わせのボタン・「1.3対応済み」を受け付けるグループ（勤怠管理・従業員連絡） */
function INQ_staffGroups(byDept) {
  var b = byDept || {}, out = [];
  [AC_ADMIN_GROUP, INQ_NOTICE_DEPT].forEach(function (d) { (b[d] || []).forEach(function (g) { if (out.indexOf(g) === -1) out.push(g); }); });
  return out;
}

/** 「部門登録」で登録できる部門の名前（コード.gs の部門登録から呼ぶ） */
function INQ_groupDept_() { return INQ_NOTICE_DEPT; }

function INQ_groupsByDept_() {
  try { return AC_groupsByDept(AC_groupSheet_().getDataRange().getValues()); } catch (e) { Logger.log('「LINEグループ」タブの読み込みに失敗'); return {}; }
}

/**
 * 送り先：INQ_NOTIFY_TO=admin なら管理者の個別LINE（tiers は空・admin=true）。
 * それ以外は INQ_targetPlan の順（グループが1つも無ければ管理者の個別LINE）
 */
function INQ_targets_(kind) {
  var admin = INQ_props_().getProperty('LINE_ADMIN_USER_ID');
  if (String(INQ_props_().getProperty('INQ_NOTIFY_TO') || '').trim() === 'admin') return { tiers: [], adminList: admin ? [admin] : [], admin: true };
  var tiers = INQ_targetPlan(INQ_groupsByDept_(), kind);
  return tiers.length ? { tiers: tiers, adminList: [], admin: false } : { tiers: [], adminList: admin ? [admin] : [], admin: true };
}

function INQ_pushMessages_(to, messages) {
  var token = INQ_props_().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !to) return false;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, 'X-Line-Retry-Key': Utilities.getUuid() },
    payload: JSON.stringify({ to: to, messages: messages }), muteHttpExceptions: true,
  });
  return res.getResponseCode() === 200;
}

/**
 * 送り先へ送る。kind は INQ_targetPlan（省略時 'inquiry'）。従業員連絡グループに1つも届かなければ勤怠管理グループへ、
 * それも届かなければ、管理者の個別LINEへ文字だけで送る（予備の文は「勤怠管理グループへ送れなかった」を含むので朝のまとめに回らない）。届いた数を返す
 */
function INQ_send_(messages, fallbackText, kind, noAdminFallback) {
  var t = INQ_targets_(kind || 'inquiry'), sent = 0;
  var push = function (to) { try { if (INQ_pushMessages_(to, messages)) sent++; } catch (e) { Logger.log('問い合わせの通知の送信に失敗'); } };
  if (t.admin) { t.adminList.forEach(push); return sent; }
  for (var i = 0; i < t.tiers.length && !sent; i++) {
    if (i > 0) Logger.log('問い合わせの通知：%sグループへ送れなかったため、%sグループへ送ります', t.tiers[i - 1].dept, t.tiers[i].dept);
    t.tiers[i].list.forEach(push);
  }
  if (!sent && !noAdminFallback) {   // 版 2026-11-20d：noAdminFallback（まとめのカルーセル）は、管理者へ送らず呼び出し側で文字の版を送る
    try { AC_pushLine_(fallbackText + '\n（' + (t.tiers.some(function (x) { return x.dept === INQ_NOTICE_DEPT; }) ? INQ_NOTICE_DEPT + 'グループ・' : '') + '勤怠管理グループへ送れなかったため、こちらへお知らせしました）'); sent++; } catch (e2) { Logger.log('管理者への送信にも失敗'); }
  }
  return sent;
}

/** 送信者のLINE表示名。取れなければ null（友だちでない・偽のデータなど） */
function INQ_profileName_(userId) {
  var token = INQ_props_().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !AC_isUserId(userId)) return null;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId), {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  try { return String(JSON.parse(res.getContentText()).displayName || ''); } catch (e) { return ''; }
}

/** グループのメンバーなら表示名、確かめられなければ null */
function INQ_memberName_(groupId, userId) {
  var token = INQ_props_().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token || !groupId || !AC_isUserId(userId)) return null;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/group/' + encodeURIComponent(groupId) + '/member/' + encodeURIComponent(userId), {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  try { return String(JSON.parse(res.getContentText()).displayName || ''); } catch (e) { return ''; }
}

function INQ_fail_(where, err) {
  Logger.log('問い合わせの処理エラー（%s）：%s', where, err && err.message ? err.message : '');
  try { AC_adminNotice_('inquiry', '【エラー】問い合わせの処理で問題がありました🙇‍♀️ LINEのチャット画面で新しいメッセージをご確認ください。\n（' + (err && err.message ? err.message : '不明なエラー') + '）'); } catch (e) { /* 何もしない */ }
}

// ---- 入口：1対1のトーク（社員番号以外のメッセージ・postback） ----
function INQ_onUserEvent_(ev) {
  try {
    var mode = INQ_mode_();
    if (mode === 'off' || !ev) return;
    if (ev.type === 'postback') { if (mode === 'on') INQ_onAdminPostback_(ev); return; }
    if (ev.type !== 'message' || !ev.message) return;
    INQ_receive_(ev, mode);
  } catch (err) { INQ_fail_('受付', err); }
}

function INQ_receive_(ev, mode) {
  var uid = ev.source && ev.source.userId;
  if (!AC_isUserId(uid)) return;
  var ss = INQ_book_(), received = INQ_sheet_(ss, INQ_SHEET_RECEIVED, INQ_RECEIVED_HEADER);
  if (INQ_isDuplicate_(ev, received)) { Logger.log('問い合わせ：重複の受信のため処理しません'); return; }
  var displayName = INQ_profileName_(uid);
  if (displayName === null) {   // 実在確認できない（友だちでない・偽のデータ）：案件にしない
    var lk = LockService.getScriptLock(); lk.waitLock(20000);
    try { if (!INQ_isDuplicate_(ev, received)) INQ_markSeen_(ev, received, '実在確認できず'); } finally { lk.releaseLock(); }
    return;
  }
  var props = INQ_props_(), now = new Date(), today = INQ_ymd_(now);
  var raw = INQ_messageSummary(ev.message);
  var mv = AC_masterSheet_().getDataRange().getValues();
  var match = INQ_matchEmployee(mv, uid, today);
  var who = INQ_whoLabel(match, displayName);
  var secretWords = props.getProperty('INQ_SECRET_WORDS');
  var secret = raw !== null && INQ_hasSecret(raw, secretWords);
  var stored = raw === null ? INQ_STICKER_LABEL : secret ? INQ_maskSecret(raw, secretWords) : raw;
  var routine = raw !== null && INQ_isRoutine(raw, props.getProperty('INQ_ROUTINE_WORDS'));
  var ack = INQ_isAckMessage(ev.message);   // 版 2026-11-16a：返信が要らないLINE（スタンプだけを含む）
  var after = null;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (INQ_isDuplicate_(ev, received)) return;
    var mid = (ev.message && ev.message.id) || '';
    var toRoutine = function () {
      INQ_sheet_(ss, INQ_SHEET_ROUTINE, INQ_ROUTINE_HEADER).appendRow([now, match.code ? "'" + match.code : '', match.name || who, uid, stored, ev.webhookEventId || '']);
      INQ_markSeen_(ev, received, '定型連絡');
    };
    if (routine) { toRoutine(); return; }
    var sh = INQ_sheet_(ss, INQ_SHEET_CASE, INQ_CASE_HEADER), log = INQ_sheet_(ss, INQ_SHEET_LOG, INQ_LOG_HEADER);
    var cs;
    try { cs = INQ_caseSheet_(sh); } catch (ce) {
      if (raw === null) { toRoutine(); return; }   // スタンプは今までどおり定型連絡（案件の列が読めなくても止めない）
      if (ce && ce.inqCols) {   // 列の見出しに問題：案件にはせず、本文を「やりとり」に残してから、エラーとして管理者へ（INQ_fail_）
        log.appendRow([now, '', '受付（保留：列の見出し）', stored, uid, ev.webhookEventId || '', "'" + mid]);
        INQ_markSeen_(ev, received, '保留（列の見出し）');
      }
      throw ce;
    }
    var C = cs.cols.col, cases = cs.cases, open = INQ_openCaseOf(cases, uid);
    var autoDone = function (c, row) {   // 版 2026-11-16a：自動で対応済み（完了者「AI（自動）」・完了日時）
      INQ_setCell_(sh, row, C, 'state', INQ_STATE.done);
      INQ_setCell_(sh, row, C, 'doneBy', INQ_AUTO_DONE_BY);
      INQ_setCell_(sh, row, C, 'doneAt', now);
      log.appendRow([now, c.id, '対応済み（自動：返信不要）', '', uid, ev.webhookEventId || '', '']);
    };
    if (raw === null && !(open && INQ_shouldAutoClose(ack, false, open.state, INQ_summaryParts_(open).category))) { toRoutine(); return; }   // 案件の無い人・未対応の案件のスタンプは今までどおり
    if (open) {
      var closeIt = INQ_shouldAutoClose(ack, false, open.state, INQ_summaryParts_(open).category);
      var notify = !closeIt && INQ_shouldNotifyAppend(open.state, open.appendNoticeAt ? open.appendNoticeAt.getTime() : 0, now.getTime());
      INQ_setCell_(sh, open.row, C, 'lastAt', now);
      INQ_setCell_(sh, open.row, C, 'appends', open.appends + 1);
      if (secret && !open.secret) INQ_setCell_(sh, open.row, C, 'secret', true);
      // 版 2026-11-20b：30分以内に続けて届いた分は「内容（冒頭）」につなぐ（200文字まで）。要注意の言葉が入ったら分類を要注意にする（内容を出さない側へ）
      if (!closeIt && INQ_isContinuation(open.lastAt ? open.lastAt.getTime() : 0, now.getTime())) {
        var joined = INQ_joinHead(open.head, stored);
        if (joined !== open.head) { INQ_setCell_(sh, open.row, C, 'head', joined); open.head = joined; }
        var addCls = INQ_classify(stored);
        if (INQ_isSensitiveCategory(addCls.category) && C.category >= 0 && open.category && !INQ_isSensitiveCategory(open.category)) {
          INQ_setCell_(sh, open.row, C, 'category', addCls.category); open.category = addCls.category;
          if (C.point >= 0) { INQ_setCell_(sh, open.row, C, 'point', addCls.point); open.point = addCls.point; }
        }
      }
      if (notify && mode === 'on') INQ_setCell_(sh, open.row, C, 'appendNoticeAt', now);
      log.appendRow([now, open.id, '追記', stored, uid, ev.webhookEventId || '', "'" + mid]);
      if (closeIt) autoDone(open, open.row);
      INQ_markSeen_(ev, received, '追記 ' + open.id + (closeIt ? '（自動で対応済み：返信不要）' : ''));
      open.who = INQ_caseWho(open);
      after = { kind: 'append', c: open, notify: notify, auto: closeIt };
    } else {
      var cls = INQ_classify(stored);
      var closeNew = INQ_shouldAutoClose(ack, true, '', cls.category);
      var c = { id: INQ_nextId(cases.map(function (x) { return x.id; }), today), state: INQ_STATE.open, who: who, at: now,
        head: INQ_head(stored), secret: secret, token: INQ_token_(),
        name: match.name ? match.name + (match.retired ? '（退職）' : '') : '', dept: match.dept || '', link: INQ_LINK_LABEL[match.link],
        lineName: displayName, category: cls.category, point: cls.point };
      var row = INQ_newCaseRow(C, cs.cols.width, { id: c.id, state: c.state, code: match.code ? "'" + match.code : '',
        name: match.name ? match.name + (match.retired ? '（退職）' : '') : '', dept: match.dept || '', link: INQ_LINK_LABEL[match.link],
        userId: uid, lineName: displayName, at: now, head: c.head, secret: secret, lastAt: now, appends: 0,
        token: c.token, eventId: ev.webhookEventId || '' });
      sh.appendRow(row);
      log.appendRow([now, c.id, '受付', stored, uid, ev.webhookEventId || '', "'" + mid]);
      if (closeNew) autoDone(c, sh.getLastRow());
      INQ_markSeen_(ev, received, '受付 ' + c.id + (closeNew ? '（自動で対応済み：返信不要）' : ''));
      after = { kind: 'new', c: c, auto: closeNew };
    }
  } finally { lock.releaseLock(); }
  if (mode !== 'on' || !after || after.auto) return;   // 自動で対応済みにしたときは、勤怠管理グループへのお知らせ・未登録の人への案内を送らない
  if (after.kind === 'new') INQ_send_([INQ_newCaseMessage(after.c)], INQ_newCaseText(after.c));
  else if (after.notify) INQ_send_([{ type: 'text', text: INQ_appendText(after.c) }], INQ_appendText(after.c));
  if (match.link === 'unregistered') INQ_guideOnce_(ss, uid, ev.replyToken);
}

/** 未登録の人へ、社員番号の登録を1回だけ案内する（返信なので送信数に数えない） */
var INQ_GUIDE_TEXT = 'お問い合わせありがとうございます。担当者から順にご連絡いたします。\n'
  + '社員の方は、お手数ですが社員番号（数字のみ）をこのトークに送ってください。LINEの登録が完了します。';
function INQ_guideOnce_(ss, uid, replyToken) {
  if (!replyToken) return;
  var sh = INQ_sheet_(ss, INQ_SHEET_GUIDED, INQ_GUIDED_HEADER), lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var v = sh.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) if (String(v[i][0]) === uid) return;
    sh.appendRow([uid, new Date()]);
  } finally { lock.releaseLock(); }
  AC_replySelf_(replyToken, INQ_GUIDE_TEXT);
}

// ---- 入口：勤怠管理グループのボタン（postback） ----
function INQ_onGroupPostback_(ev) {
  try {
    if (INQ_mode_() !== 'on' || !ev || ev.type !== 'postback') return;
    var p = INQ_parsePostback(ev.postback && ev.postback.data);
    if (!p) return;                                    // 問い合わせのボタンではない（ほかの機能のもの）
    var gid = ev.source && ev.source.groupId;
    var groups = INQ_staffGroups(AC_groupsByDept(AC_groupSheet_().getDataRange().getValues()));
    if (!gid || groups.indexOf(gid) === -1) return;    // 勤怠管理・従業員連絡グループ以外では何もしない（版 2026-11-20b で従業員連絡を追加）
    var uid = ev.source.userId;
    if (!AC_isUserId(uid)) { AC_reply_(ev.replyToken, '押した方を確認できないため受け付けできませんでした。スマートフォンのLINEから押してください。'); return; }
    var name = INQ_memberName_(gid, uid);
    if (name === null) { AC_reply_(ev.replyToken, 'このグループのメンバーであることを確認できなかったため、受け付けできませんでした。'); return; }
    INQ_button_(ev, p, uid, name);
  } catch (err) { INQ_fail_('ボタン', err); }
}

/**
 * 勤怠管理グループの文（版 2026-11-17e）：「①③対応済み」「1.3対応済み」などを、いちばん新しいまとめの番号で対応済みにする。扱ったら true。
 * まとめを送っていない・番号が無いときは返信で知らせる（返信なので通数にかからない）
 */
function INQ_onGroupMessage_(ev) {
  try {
    if (INQ_mode_() !== 'on' || !ev || ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return false;
    var gid = ev.source && ev.source.groupId;
    if (!gid) return false;
    var nums = INQ_parseDoneNumbers(INQ_stripMentions(ev.message.text, ev.message.mention));
    if (!nums) return false;
    var groups = INQ_staffGroups(AC_groupsByDept(AC_groupSheet_().getDataRange().getValues()));   // 勤怠管理・従業員連絡（版 2026-11-20b）
    if (groups.indexOf(gid) === -1) return false;
    var uid = ev.source.userId;
    if (!AC_isUserId(uid)) { AC_reply_(ev.replyToken, '送った方を確認できないため受け付けできませんでした。スマートフォンのLINEから送ってください。'); return true; }
    var name = INQ_memberName_(gid, uid);
    if (name === null) { AC_reply_(ev.replyToken, 'このグループのメンバーであることを確認できなかったため、受け付けできませんでした。'); return true; }
    var last = null;
    try { last = JSON.parse(PropertiesService.getUserProperties().getProperty(INQ_LAST_REMIND_KEY) || 'null'); } catch (e0) { last = null; }
    if (!last || !last.ids || !last.ids.length) { AC_reply_(ev.replyToken, '番号つきの「問い合わせ 未完了」のお知らせがまだないため、番号では受け付けできませんでした。お知らせのボタンから対応済みにしてください。'); return true; }
    var label = last.label || '';
    var big = nums.filter(function (n) { return n > last.ids.length; });
    if (big.length && nums.length === 1 && String(big[0]).length > 1) {
      AC_reply_(ev.replyToken, '「' + big[0] + '」番はありません（' + label + 'のお知らせは' + last.ids.length + '件）。いくつか送るときは「1.2.4対応済み」のように区切ってください。');
      return true;
    }
    var mark = function (n) { return n <= 20 ? String.fromCharCode(0x2460 + n - 1) : '(' + n + ')'; };
    var ss = INQ_book_(), received = INQ_sheet_(ss, INQ_SHEET_RECEIVED, INQ_RECEIVED_HEADER), done = [], already = [], missing = [], now = new Date();
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (INQ_isDuplicate_(ev, received)) return true;
      var sh = INQ_sheet_(ss, INQ_SHEET_CASE, INQ_CASE_HEADER), log = INQ_sheet_(ss, INQ_SHEET_LOG, INQ_LOG_HEADER);
      var cs = INQ_caseSheet_(sh), C = cs.cols.col;
      nums.forEach(function (n) {
        var id = last.ids[n - 1], c = id ? cs.cases.filter(function (x) { return x.id === id; })[0] : null;
        if (!c) { missing.push(mark(n)); return; }
        var who = mark(n) + ' ' + INQ_whoShort(c);
        var d = INQ_decide(c.state, 'done');
        if (!d.changed) { already.push(who + '（' + (c.doneBy === INQ_AUTO_DONE_BY ? c.doneBy : (c.doneBy || '担当者') + 'さん') + '）'); return; }
        INQ_setCell_(sh, c.row, C, 'state', d.next);
        var set3 = function (keys) { keys.forEach(function (k, j) { INQ_setCell_(sh, c.row, C, k, [name, uid, now][j]); }); };
        if (!c.staff) set3(['staff', 'staffId', 'takenAt']);
        set3(['doneBy', 'doneById', 'doneAt']);
        log.appendRow([now, c.id, '対応済み', '番号で（' + mark(n) + '）', uid, ev.webhookEventId || '', '']);
        done.push(who);
      });
      INQ_markSeen_(ev, received, '番号で対応済み ' + nums.join('.') + '（済 ' + done.length + '・前から済 ' + already.length + '・無し ' + missing.length + '）');
    } finally { lock.releaseLock(); }
    var lines = [];
    if (done.length) lines.push('対応済みにしました（' + name + 'さん）\n' + done.join('\n'));
    if (already.length) lines.push('すでに対応済みでした\n' + already.join('\n'));
    if (missing.length) lines.push(missing.join('') + 'は見つかりませんでした（' + label + 'のお知らせは' + last.ids.length + '件）');
    lines.push('（' + label + 'のお知らせの番号で受け付けました）');
    AC_reply_(ev.replyToken, lines.join('\n\n'));
    return true;
  } catch (err) { INQ_fail_('番号で対応済み', err); return false; }
}

/** 試験用（INQ_NOTIFY_TO=admin）：管理者の個別LINEで押されたボタン */
function INQ_onAdminPostback_(ev) {
  var p = INQ_parsePostback(ev.postback && ev.postback.data);
  if (!p) return;
  var uid = ev.source && ev.source.userId;
  if (!uid || uid !== INQ_props_().getProperty('LINE_ADMIN_USER_ID')) return;
  INQ_button_(ev, p, uid, INQ_profileName_(uid) || '管理者');
}

function INQ_button_(ev, p, uid, name) {
  var ss = INQ_book_(), received = INQ_sheet_(ss, INQ_SHEET_RECEIVED, INQ_RECEIVED_HEADER);
  var reply = null, now = new Date(), colsErr = null;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (INQ_isDuplicate_(ev, received)) return;
    var sh = INQ_sheet_(ss, INQ_SHEET_CASE, INQ_CASE_HEADER), log = INQ_sheet_(ss, INQ_SHEET_LOG, INQ_LOG_HEADER);
    var cs;
    try { cs = INQ_caseSheet_(sh); } catch (ce) {
      if (ce && ce.inqCols) colsErr = ce;   // 列の見出しに問題：押した人へ返信してから、エラーとして管理者へ
      throw ce;
    }
    var C = cs.cols.col, c = cs.cases.filter(function (x) { return x.id === p.id; })[0];
    if (!c || !c.token || c.token !== p.token) {
      INQ_markSeen_(ev, received, 'ボタン拒否（合言葉の不一致）');
      reply = 'このボタンは使えません。新しい通知のボタンを押してください。';
    } else {
      var d = INQ_decide(c.state, p.action);
      if (d.changed) {
        INQ_setCell_(sh, c.row, C, 'state', d.next);
        var who3 = function (keys) { keys.forEach(function (k, j) { INQ_setCell_(sh, c.row, C, k, [name, uid, now][j]); }); };   // 列が離れていてもよい
        if (d.reason === 'taken') {
          who3(['staff', 'staffId', 'takenAt']);
        } else {
          if (!c.staff) who3(['staff', 'staffId', 'takenAt']);
          who3(['doneBy', 'doneById', 'doneAt']);
        }
        log.appendRow([now, c.id, d.reason === 'taken' ? '対応開始' : '対応済み', '', uid, ev.webhookEventId || '', '']);
      }
      INQ_markSeen_(ev, received, 'ボタン ' + p.action + ' ' + c.id + ' ' + d.reason);
      var when = function (dt) { return dt ? INQ_md_(dt) + ' ' + INQ_hm_(dt) : ''; };
      var what = INQ_whoShort(c) + 'の問い合わせ';   // 案件番号は出さない
      reply = {
        taken: what + 'を、' + name + 'さんが対応中にしました。',
        done: what + 'を対応済みにしました（' + name + 'さん）。',
        alreadyDoing: what + 'は、' + (c.staff || '担当者') + 'さんが対応中です。',
        alreadyDone: what + 'は対応済みです（' + when(c.doneAt) + '・' + (c.doneBy === INQ_AUTO_DONE_BY ? c.doneBy : (c.doneBy || '担当者') + 'さん') + '）。',
      }[d.reason];
    }
  } catch (err) {
    if (colsErr) AC_reply_(ev.replyToken, 'シートの列の見出しに問題があるため、受け付けできませんでした。管理者へ知らせました。');
    throw err;
  } finally { lock.releaseLock(); }
  if (reply) AC_reply_(ev.replyToken, reply);
}

// ---- 時刻指定：まとめのお知らせ（9:00・12:00・土日も。INQ_REMIND_DAYS=weekdays なら土日・祝日は送らない） ----
// 版 2026-11-17e：平日の朝の回に、管理者へのお知らせ（ADMIN_NOTIFY=digest でためた分）をまとめて送る。
// 版 2026-11-20e：まとめが 9時・12時になったため、朝の回の判定を「12時より前」→「10:30 より前」に（INQ_isDigestRun）。
//  トリガーの nearMinute(0) は前後15分ずれる（9時の回は 8:45〜9:15、12時の回は 11:45〜12:15）ので、どちらにもかからないまん中で分ける
var INQ_DIGEST_BEFORE = '10:30';
/** 純粋関数（版 2026-11-20e）：管理者へのお知らせ（朝のまとめ）を付ける回か（日本時間の「時:分」が 10:30 より前） */
function INQ_isDigestRun(hm) { return String(hm || '') < INQ_DIGEST_BEFORE; }
function INQ_isRemindDay_(now) {
  if (String(INQ_props_().getProperty('INQ_REMIND_DAYS') || 'all').trim() !== 'weekdays') return true;
  var ymd = INQ_ymd_(now);
  if (typeof OT_isBusinessDay === 'function') return OT_isBusinessDay(ymd, typeof OT_offDates_ === 'function' ? OT_offDates_() : []);
  var dow = INQ_dow_(now);
  return dow !== 0 && dow !== 6;
}
function INQ_remind() {
  var now = new Date(), sch = null;
  var remindDay = INQ_isRemindDay_(now);
  if (!remindDay) { Logger.log('問い合わせのまとめ：土日・祝日のため送らない（受付の速報はそのまま）'); return; }
  // 版 2026-11-13d：TOT反映の承認待ち（gas/TotSync.gs）。問い合わせとは別に、TOT_WRITE が record・on のときだけ
  try { if (typeof SCH_remindPart_ === 'function') sch = SCH_remindPart_(now); } catch (es) { INQ_fail_('リマインド（TOT反映）', es); }
  var text = null, ids = null, car = null;
  try {
    var mode = INQ_mode_();
    if (mode !== 'off') {
      INQ_classifyFill_();   // まだ分類が空の行を、本文の全体から先に埋める（要注意の分類を内容（冒頭）だけで判定しないため。エラーは外へ出さない）
      var cases = INQ_cases_(INQ_sheet_(INQ_book_(), INQ_SHEET_CASE, INQ_CASE_HEADER))
        .map(function (c) { c.who = INQ_caseWho(c); return c; });
      text = INQ_remindText(cases, now);
      ids = INQ_remindList(cases).map(function (c) { return c.id; });
      car = INQ_remindCarousels(cases, now);   // 版 2026-11-20d
      if (text && mode !== 'on') { Logger.log('問い合わせのまとめ（記録のみのため送らない）：%s件・カード %s枚・%s通', ids.length, car ? car.shown : 0, car ? car.messages.length : 0); text = null; car = null; }
    }
  } catch (err) { INQ_fail_('リマインド', err); }
  try {
    // 版 2026-11-20d：問い合わせのまとめはカルーセルで従業員連絡グループ（無ければ勤怠管理グループ）へ。送れなければ文字のまとめ。
    // TOT反映の承認待ち・管理者へのお知らせ（朝のまとめ）は、いつも別の送信で、文字のまま勤怠管理グループへ（版 2026-11-20b の分け方を、従業員連絡が無いときにも使う）
    var admText = sch && sch.text ? sch.text : null;
    var digest = { texts: [], used: [] };
    if (INQ_isDigestRun(INQ_hm_(now)) && typeof AC_digestItems_ === 'function') {
      var items = AC_digestItems_().map(function (x) { x.label = INQ_mdhm_(x.at); return x; });
      if (items.length) digest = AC_digestText(items, INQ_mdhm_(now), admText ? 4 : 5);
    }
    var toMsgs = function (list) { return list.filter(Boolean).map(function (t) { return { type: 'text', text: t }; }); };
    var join = function (ms) { return ms.map(function (m) { return m.text; }).join('\n\n').slice(0, 4800); };
    var inqSent = 0, savedIds = null;
    if (car && car.messages.length) {
      inqSent = INQ_send_(car.messages, '', 'inquiry', true);
      if (inqSent) savedIds = car.ids;
      else Logger.log('問い合わせのまとめ：カードを送れなかったため、文字のまとめを送ります（%s件）', car.total);
      if (car.more) Logger.log('問い合わせのまとめ：%s件のうち %s件をカードにしました（ほか %s件はシートで確認）', car.total, car.shown, car.more);
    }
    if (!inqSent && text) { inqSent = INQ_send_([{ type: 'text', text: text }], text, 'inquiry'); if (inqSent) savedIds = ids; }
    var admMsgs = toMsgs([admText].concat(digest.texts));
    var admSent = admMsgs.length ? INQ_send_(admMsgs, join(admMsgs), 'admin') : 0;
    if (digest.used.length && (!digest.texts.length || admSent)) AC_digestRemove_(digest.used);
    if (inqSent && savedIds && savedIds.length) PropertiesService.getUserProperties().setProperty(INQ_LAST_REMIND_KEY, JSON.stringify({ at: now.toISOString(), label: INQ_mdhm_(now), ids: savedIds }));
    if (sch && sch.after) sch.after();
  } catch (err2) { INQ_fail_('リマインド', err2); }
}

// ---- 1時間ごと（alcoholCheckImportTot から）：分類・要点を埋める ----
/** 「分類」が空の行だけを埋める（入っている行は上書きしない）。INQ_MODE が off・記録先が未設定なら何もしない。エラーは外へ出さない */
function INQ_classifyFill_() {
  try {
    if (INQ_mode_() === 'off' || !INQ_props_().getProperty('INQ_SPREADSHEET_ID')) return 0;
    if (String(INQ_props_().getProperty('INQ_CLASSIFY') || '').trim() === 'off') return 0;   // 分類・要点だけを止める
    var ss = INQ_book_(), sh = ss.getSheetByName(INQ_SHEET_CASE);
    if (!sh || sh.getLastRow() < 2) return 0;
    var log = ss.getSheetByName(INQ_SHEET_LOG);
    var plan = INQ_classifyPlan(sh.getDataRange().getValues(), log ? log.getDataRange().getValues() : []);
    if (plan.error) { Logger.log('問い合わせの分類・要点：%s（書き込みをやめました。次の回にやり直します）', plan.error); return 0; }
    plan.addHeader.forEach(function (h) { sh.getRange(1, h.col + 1).setValue(h.name).setFontWeight('bold'); });
    plan.fills.forEach(function (f) {
      sh.getRange(f.row + 1, plan.cols.category + 1).setValue(f.category);
      if (f.point !== null) sh.getRange(f.row + 1, plan.cols.point + 1).setValue(f.point);
    });
    if (plan.fills.length) Logger.log('問い合わせの分類・要点：%s件を埋めました', plan.fills.length);
    return plan.fills.length;
  } catch (err) { Logger.log('問い合わせの分類・要点の処理に失敗（次の回にやり直します）：%s', err && err.message ? err.message : ''); return 0; }   // 管理者へは知らせない（受信の処理ではないため）
}

/** 手動確認用：分類・要点を埋めるとしたら何件・どの分類か（シートに書かない。本文・氏名・要点はログに出さない） */
function inqClassifyPreview() {
  var ss = INQ_book_(), sh = ss.getSheetByName(INQ_SHEET_CASE);
  if (!sh) { Logger.log('「問い合わせ」タブがありません'); return null; }
  var log = ss.getSheetByName(INQ_SHEET_LOG);
  var plan = INQ_classifyPlan(sh.getDataRange().getValues(), log ? log.getDataRange().getValues() : []);
  if (plan.error) { Logger.log('問い合わせの分類・要点（確認だけ）：%s', plan.error); return { count: 0, byCategory: {}, error: plan.error }; }
  var by = {};
  plan.fills.forEach(function (f) { by[f.category] = (by[f.category] || 0) + 1; });
  var lines = ['問い合わせの分類・要点（確認だけ・書き込みなし。版 ' + INQ_VERSION + '）',
    '埋める行：' + plan.fills.length + '件' + (plan.addHeader.length ? '（列の見出し「' + plan.addHeader.map(function (h) { return h.name; }).join('」「') + '」を末尾に足します）' : ''),
    '内訳：' + (Object.keys(by).map(function (k) { return k + ' ' + by[k] + '件'; }).join('／') || 'なし')];
  Logger.log(lines.join('\n'));
  return { count: plan.fills.length, byCategory: by };
}

// ---- 将来のAI自動返信用：その人に未対応・対応中の案件があるか ----
function INQ_activeCaseFor(userId) {
  if (!INQ_props_().getProperty('INQ_SPREADSHEET_ID')) return null;
  var c = INQ_openCaseOf(INQ_cases_(INQ_sheet_(INQ_book_(), INQ_SHEET_CASE, INQ_CASE_HEADER)), userId);
  return c ? { id: c.id, state: c.state } : null;
}

// ---- 導入・停止用（エディタから手動で実行） ----
/** 記録先のスプレッドシートとタブを用意する（INQ_SPREADSHEET_ID が無ければ新しく作る）。送信はしない */
function INQ_setup() {
  var props = INQ_props_(), id = props.getProperty('INQ_SPREADSHEET_ID'), ss;
  if (id) ss = SpreadsheetApp.openById(id);
  else { ss = SpreadsheetApp.create('従業員問い合わせ管理'); props.setProperty('INQ_SPREADSHEET_ID', ss.getId()); }
  [[INQ_SHEET_CASE, INQ_CASE_HEADER], [INQ_SHEET_LOG, INQ_LOG_HEADER], [INQ_SHEET_ROUTINE, INQ_ROUTINE_HEADER],
    [INQ_SHEET_RECEIVED, INQ_RECEIVED_HEADER], [INQ_SHEET_GUIDED, INQ_GUIDED_HEADER]].forEach(function (s) { INQ_sheet_(ss, s[0], s[1]); });
  var cols = INQ_caseCols(ss.getSheetByName(INQ_SHEET_CASE).getRange(1, 1, 1, Math.max(1, ss.getSheetByName(INQ_SHEET_CASE).getLastColumn())).getValues()[0]);
  Logger.log('「%s」タブの列の見出し：%s', INQ_SHEET_CASE, cols.ok ? 'OK（並べ替え・非表示でも動きます）' : INQ_colsMessage(cols));   // 見出しは直さない（管理本部が確認）
  var first = ss.getSheetByName('シート1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  Logger.log('問い合わせの準備：完了（版 %s）。INQ_MODE=%s。記録先：%s', INQ_VERSION, props.getProperty('INQ_MODE') || '未設定', ss.getUrl());
}

// ---- FAQ回答マスター（版 2026-11-10d。計画書 docs/REBIRTH_support_PLAN.md 5-2） ----
// 今は「タブを作るだけ」。問い合わせの受付・返信・お知らせはこのタブを読まない（返信は計画書の手順4・5で作る）。
// 回答文は仕様書 docs/REBIRTH_support_spec.md の【文面案】そのまま（11/10 会社の確認済み）。段落の間は空行。
// 会社の決定（11/10）で直した行：TOT-03（承認は翌月3日まで）、PL-04（取消はToTのスケジュール申請から・記事8301）。
// 仕様書に文面案の無い行は、回答文を空にして「有効」をオフにする（管理本部が文面を入れてからオンにする）。
// spec：文面案の場所（仕様書の節番号／見出し）。テストで仕様書の原文と同じかを確かめる
var INQ_SHEET_FAQ = 'FAQ回答マスター';
var INQ_FAQ_HEADER = ['FAQ番号', '有効', '分類', 'キーワード', '除外キーワード', '回答文', 'ボタン', '必ず引き継ぐ', '緊急', '最終更新日', '更新者'];
var INQ_FAQ_CHECK_COLS = [2, 8, 9];   // チェックボックスの列（有効・必ず引き継ぐ・緊急。1始まり）
var INQ_FAQ_ROWS = [
  // ToTにログインできない（追加の質問：画面・ログイン・エラー）4-1・2-5（仕様書に文面案なし：回答文は空・有効はオフ）
  { id: "TOT-01", category: "勤怠・打刻", words: "ログインできない、ログイン、パスワード、入れない", exclude: "打刻申請、打刻忘れ", button: "解決確認", handoff: false, urgent: false, spec: "",
    text: "" },
  // 打刻忘れ・打刻間違い 4-2
  { id: "TOT-02", category: "勤怠・打刻", words: "打刻忘れ、打ち忘れ、押し忘れ、打刻間違い、打刻ミス、打刻申請、打刻の修正", exclude: "承認、申請中", button: "解決確認", handoff: false, urgent: false, spec: "4-2/LINE回答例",
    text: "お問い合わせありがとうございます！😊\n\n打刻忘れや打刻間違いは、Touch On Timeから修正申請をお願いいたします。\n\n操作方法はこちらをご確認ください。\n\nhttps://help.touchontime.com/totfaq/s/article/8301\n\n操作がわからない場合は、お気軽にお知らせください！" },
  // 打刻修正が承認されない 4-3（承認は翌月3日まで：会社の決定）
  { id: "TOT-03", category: "勤怠・打刻", words: "承認されない、承認されてない、申請中、承認", exclude: "", button: "解決確認", handoff: false, urgent: false, spec: "4-3/LINE回答例",
    text: "お問い合わせありがとうございます！😊\n\n打刻修正の申請は、翌月3日までに承認処理を行っています。\n\nそれまでは「申請中」の状態になっていれば問題ございませんので、そのままお待ちください。\n\n申請ができていない場合や、操作方法がわからない場合はお知らせください！" },
  // 遅刻・欠勤 4-4
  { id: "TOT-04", category: "勤怠・打刻", words: "遅刻、欠勤、遅れます、休みます", exclude: "有給", button: "", handoff: false, urgent: false, spec: "4-4/LINE回答例",
    text: "遅刻・欠勤のご連絡は、以下の勤怠連絡フォームからお願いいたします。\n\nhttps://docs.google.com/forms/d/e/1FAIpQLSfMc6SWJkjnJfqPfobUJt1NDvzQTuSjir97IMW_YTOctLJvFw/viewform\n\n体調不良による欠勤の場合は、事前に直属の上長の了承を得てからご入力ください。" },
  // 希望休 4-5（月4日まで・土日は原則不可：会社の決定）（仕様書に文面案なし：回答文は空・有効はオフ）
  { id: "TOT-05", category: "シフト・希望休", words: "希望休", exclude: "", button: "解決確認", handoff: false, urgent: false, spec: "",
    text: "" },
  // シフト変更 4-5（仕様書に文面案なし：回答文は空・有効はオフ）
  { id: "TOT-06", category: "シフト・希望休", words: "シフト変更、シフトを変え、シフトの変更", exclude: "", button: "解決確認", handoff: false, urgent: false, spec: "",
    text: "" },
  // スケジュール申請 4-6（仕様書に文面案なし：回答文は空・有効はオフ）
  { id: "TOT-07", category: "シフト・希望休", words: "スケジュール申請、スケジュール", exclude: "有給", button: "解決確認", handoff: false, urgent: false, spec: "",
    text: "" },
  // 残業申請 4-7
  { id: "TOT-08", category: "勤怠・打刻", words: "残業、時間外、残業申請", exclude: "残業代", button: "解決確認", handoff: false, urgent: false, spec: "4-7/LINE回答例",
    text: "お問い合わせありがとうございます！😊\n\n残業・時間外勤務の申請は、Touch On Timeからお願いいたします。\n\n操作方法はこちらをご確認ください。\n\nhttps://help.touchontime.com/totfaq/s/article/5201\n\n操作がわからない場合は、お気軽にお知らせください！" },
  // Myレコーダーで打刻できない 4-8（仕様書に文面案なし：回答文は空・有効はオフ）
  { id: "TOT-09", category: "勤怠・打刻", words: "Myレコーダー、マイレコーダー、打刻できない", exclude: "", button: "解決確認", handoff: false, urgent: false, spec: "",
    text: "" },
  // 有給の申請 5
  { id: "PL-01", category: "有給・休み", words: "有給、有休、有給申請、有給休暇", exclude: "取消、取り消、期限、過ぎ、承認、残り、残日数", button: "解決確認", handoff: false, urgent: false, spec: "5-2/有給申請",
    text: "お問い合わせありがとうございます！😊\n\n有給休暇はTouch On Timeから申請をお願いいたします。\n\n申請期限は、取得希望月の前月15日までとなっています。\n\n操作方法はこちらをご確認ください。\n\nhttps://help.touchontime.com/totfaq/s/article/6301" },
  // 有給の期限超過 5
  { id: "PL-02", category: "有給・休み", words: "期限を過ぎ、期限が過ぎ、期限切れ、間に合わ", exclude: "", button: "", handoff: true, urgent: false, spec: "5-2/申請期限を過ぎた場合",
    text: "有給休暇の申請期限は前月15日までとなっています。\n\n期限を過ぎている場合は、管理本部で個別に確認いたします。\n\nご希望の取得日をお知らせください。" },
  // 有給が承認されない 5
  { id: "PL-03", category: "有給・休み", words: "承認されない、未承認、承認されてない", exclude: "打刻", button: "解決確認", handoff: false, urgent: false, spec: "5-2/未承認の場合",
    text: "有給休暇の申請は、申請期限後に順次確認しています。\n\nシフト確定前の場合は、承認処理をお待ちください。\n\nシフト確定後も未承認の場合は、管理本部へ確認を引き継ぎます。" },
  // 有給の取消 5（スケジュール申請・記事8301：会社の決定）
  { id: "PL-04", category: "有給・休み", words: "取消、取り消し、取り消、キャンセル", exclude: "", button: "解決確認", handoff: false, urgent: false, spec: "5-2/取消できない場合",
    text: "有給休暇の申請取消についてですね。\n\n有給休暇の取消は、Touch On Timeの「スケジュール申請」から行えます。\n\n操作方法はこちらをご確認ください。\n\nhttps://help.touchontime.com/totfaq/s/article/8301\n\n操作できない場合は、どの画面で進めなくなったかお知らせください。\n\n解決しない場合は管理本部へ引き継ぎます。" },
  // 有給の残日数（給与明細で確認）5（仕様書に文面案なし：回答文は空・有効はオフ）
  { id: "PL-05", category: "有給・休み", words: "残り、残日数、何日残", exclude: "", button: "解決確認", handoff: false, urgent: false, spec: "",
    text: "" },
  // 給与明細 6
  { id: "PAY-01", category: "給与・明細", words: "給与明細、明細、ネットde顧問", exclude: "金額、違う、控除、ログイン、表示されない、入っていない、振り込まれていない", button: "解決確認", handoff: false, urgent: false, spec: "6-3/給与明細",
    text: "お問い合わせありがとうございます！😊\n\n給与明細は「ネットde顧問」からご確認いただけます。\n\nhttps://www1.shalom-house.jp/komon/login.aspx\n\nログインできない場合や明細が表示されない場合は、お知らせください。" },
  // 給与の支給日 6
  { id: "PAY-02", category: "給与・明細", words: "支給日、給料日、給与日、いつ振り込", exclude: "", button: "解決確認", handoff: false, urgent: false, spec: "6-3/給与支給日",
    text: "給与のお支払いは翌月末となっています。\n\n月末が土日祝日の場合は、その前の営業日が支給日となります。" },
  // 明細のログイン・表示・金額・控除 6（仕様書に文面案なし：回答文は空・有効はオフ）
  { id: "PAY-03", category: "給与・明細", words: "金額が違う、金額、控除、ログインできない、表示されない", exclude: "", button: "", handoff: true, urgent: false, spec: "",
    text: "" },
  // 給与未入金 6
  { id: "PAY-04", category: "給与・明細", words: "入っていない、入金されていない、振り込まれていない、未入金、届いていない", exclude: "", button: "", handoff: true, urgent: true, spec: "6-3/給与未入金",
    text: "給与のお振込みが確認できないとのこと、承知いたしました。\n\n管理本部へ確認を引き継ぎます。\n\n確認対象の給与月をお知らせください。" },
  // 住所変更 7
  { id: "DOC-001", category: "書類・手続き", words: "住所変更、引っ越し、住所が変わ", exclude: "", button: "", handoff: true, urgent: false, spec: "7-2/住所変更",
    text: "お問い合わせありがとうございます！😊\n\n住所が変更になった場合は、管理本部へLINEでご連絡ください。\n\n必要なお手続きについて担当者からご案内いたします。" },
  // 扶養家族の変更 7
  { id: "DOC-002", category: "書類・手続き", words: "扶養", exclude: "", button: "", handoff: true, urgent: false, spec: "7-2/扶養家族の変更",
    text: "扶養家族の追加・変更については、管理本部で確認いたします。\n\n担当者へ引き継ぎますので、必要なお手続きについては管理本部からの案内をお待ちください。" },
  // 在職・就労証明書 7
  { id: "DOC-003", category: "書類・手続き", words: "在職証明、就労証明、証明書", exclude: "", button: "", handoff: true, urgent: false, spec: "7-2/在職・就労証明書",
    text: "在職証明書・就労証明書の発行についてですね。\n\n管理本部で対応いたします。\n\n必要な書類の種類と提出先、希望期限がわかればお知らせください。" },
  // 退職希望（まず上長へ）7
  { id: "DOC-004", category: "書類・手続き", words: "退職、辞めたい、やめたい", exclude: "", button: "", handoff: false, urgent: false, spec: "7-2/退職希望",
    text: "退職についてのご相談ですね。\n\nまずは直属の上長へご相談をお願いいたします。\n\n退職が決まった後のお手続きについては、別途ご案内いたします。" },
  // 氏名・銀行口座等の変更 7
  { id: "DOC-005", category: "口座・マイナンバー", words: "口座変更、口座、氏名変更、名字が変わ、苗字が変わ", exclude: "", button: "", handoff: true, urgent: false, spec: "7-2/氏名・口座変更",
    text: "氏名や給与振込口座の変更については、管理本部へ直接ご連絡ください。\n\n口座番号などの詳細情報は、このチャットには送信せず、管理本部からの案内に従ってください。" },
  // アルコールチェック忘れ 8
  { id: "ALC-01", category: "アルコールチェック", words: "チェック忘れ、忘れ、し忘れ、実施漏れ", exclude: "故障、壊れ", button: "", handoff: false, urgent: false, spec: "8-3/アルコールチェック忘れ",
    text: "アルコールチェックの実施漏れについてですね。\n\n必要な確認を行い、所定の方法で報告してください。\n\n運転前のチェックができていない場合は、必要な確認が完了するまで運転しないでください。" },
  // チェッカーの故障 8
  { id: "ALC-02", category: "アルコールチェック", words: "故障、壊れ、動かない、反応しない、不具合", exclude: "", button: "", handoff: true, urgent: false, spec: "8-3/チェッカー故障",
    text: "アルコールチェッカーの不具合について、管理本部へ確認を引き継ぎます。\n\n機器の状態を確認するため、どのような不具合が発生しているかお知らせください。" },
  // 免許証の紛失・運転資格の問題 9-1（仕様書に文面案なし：回答文は空・有効はオフ）
  { id: "LIC-01", category: "車両・免許", words: "免許証をなくし、免許証を紛失、免許の紛失、免許停止、免停", exclude: "", button: "", handoff: true, urgent: false, spec: "",
    text: "" },
  // 社用車の事故・故障 10
  { id: "CAR-01", category: "車両・免許", words: "事故、故障、ぶつけ、追突、パンク", exclude: "保険会社", button: "", handoff: true, urgent: true, spec: "10-3/事故・故障",
    text: "社用車の事故・故障が発生した場合は、まず直属の上長へ速やかに報告してください。\n\n事故の場合は、安全確保・負傷者の救護・警察への連絡など、必要な対応を優先してください。\n\n保険に関する対応は管理本部が担当します。\n\n保険会社への事故状況の説明や交渉、補償に関する約束などを、自己判断で進めないでください。\n\n管理本部または上長の指示に従って対応をお願いいたします。" },
  // 上長に連絡がつかない 10
  { id: "CAR-02", category: "車両・免許", words: "上長に連絡がつかない、連絡がつかない、つながらない", exclude: "", button: "", handoff: true, urgent: false, spec: "10-3/上長に連絡がつかない",
    text: "直属の上長に連絡がつかない場合は、別の責任者へ速やかに連絡してください。\n\n事故現場では、安全確保・負傷者の救護・警察への連絡など、必要な対応を優先してください。\n\n保険に関する対応は、管理本部の指示に従ってください。" },
  // 保険会社から連絡があった 10
  { id: "CAR-03", category: "車両・免許", words: "保険会社", exclude: "", button: "", handoff: true, urgent: false, spec: "10-3/保険会社から連絡があった",
    text: "保険会社から直接連絡があった場合は、まず管理本部へ報告してください。\n\n管理本部から指示があった場合に限り、ご本人で対応をお願いいたします。\n\n自己判断で事故状況の説明や補償に関する交渉・約束を進めないようお願いいたします。" },
  // 入社時の初期設定（LINE・ToT）11（仕様書に文面案なし：回答文は空・有効はオフ）
  { id: "NEW-01", category: "その他", words: "初期設定、入社、ログインのやり方、登録のやり方", exclude: "", button: "解決確認", handoff: false, urgent: false, spec: "",
    text: "" },
  // 制服・備品の追加・交換 12-3（仕様書に文面案なし：回答文は空・有効はオフ）
  { id: "UNI-01", category: "その他", words: "制服、備品、交換、追加でほしい", exclude: "", button: "", handoff: true, urgent: false, spec: "",
    text: "" },
  // 勤務中のケガ 13
  { id: "INJ-01", category: "健康・体調", words: "ケガ、けが、怪我、負傷、骨折", exclude: "", button: "", handoff: true, urgent: true, spec: "13-2",
    text: "勤務中のおケガについてですね。\n\nまずは安全を確保し、必要に応じて医療機関を受診してください。\n\n直属の上長へ速やかに報告し、管理本部にもご連絡をお願いいたします。" },
  // 人間関係・ハラスメント 14（「管理本部」を選んだときだけ引き継ぐ）
  { id: "HAR-01", category: "ハラスメント・人間関係", words: "ハラスメント、パワハラ、セクハラ、モラハラ、いじめ、嫌がらせ、人間関係", exclude: "", button: "相談先", handoff: false, urgent: false, spec: "14-2",
    text: "ご相談ありがとうございます。\n\n職場の人間関係やハラスメントに関するご相談は、ご本人が相談先を選ぶことができます。\n\n管理本部、直属の上長、別の責任者への相談のほか、以下のフォームからもご相談いただけます。\n\nhttps://docs.google.com/forms/d/e/1FAIpQLSejk11Faxz3B_eMB8KCBnO9ppWQerQxdKjd7j7_ILLnQk0R7Q/viewform?usp=header\n\nご希望の相談方法をお知らせください。" },
  // 要望・改善提案 15
  { id: "REQ-01", category: "その他", words: "要望、改善、提案、意見", exclude: "", button: "", handoff: false, urgent: false, spec: "15-2",
    text: "会社へのご意見や改善提案については、専用フォームから受け付けています！😊\n\nこちらからご入力をお願いいたします。\n\nhttps://docs.google.com/forms/d/e/1FAIpQLSejk11Faxz3B_eMB8KCBnO9ppWQerQxdKjd7j7_ILLnQk0R7Q/viewform?usp=header" },
];

/** 純粋関数：FAQ回答マスターの初期の行（見出しを除く）。有効は回答文があるときだけ */
function INQ_faqSheetRows(today) {
  return INQ_FAQ_ROWS.map(function (f) {
    return [f.id, !!f.text, f.category, f.words, f.exclude, f.text, f.button, f.handoff, f.urgent, today, 'INQ_setupFaq（初期値）'];
  });
}

/**
 * 準備用（エディタから手動で実行）：問い合わせ管理シートに「FAQ回答マスター」タブを作り、初期の行を入れる。
 * タブがすでにあれば何もしない（上書き・行の追加をしない。何度実行しても同じ）。送信・返信はしない
 */
function INQ_setupFaq() {
  var ss = INQ_book_(), lock = LockService.getScriptLock(), made = null;
  lock.waitLock(20000);
  try {
    if (!ss.getSheetByName(INQ_SHEET_FAQ)) {
      var rows = INQ_faqSheetRows(INQ_ymd_(new Date())), w = INQ_FAQ_HEADER.length;
      var sh = ss.insertSheet(INQ_SHEET_FAQ);
      sh.getRange(1, 1, 1, w).setValues([INQ_FAQ_HEADER]).setFontWeight('bold');
      sh.setFrozenRows(1);
      INQ_FAQ_CHECK_COLS.forEach(function (c) { sh.getRange(2, c, rows.length, 1).insertCheckboxes(); });
      sh.getRange(2, 1, rows.length, w).setValues(rows);
      made = { rows: rows.length, active: rows.filter(function (r) { return r[1] === true; }).length };
    }
  } finally { lock.releaseLock(); }
  if (!made) { Logger.log('「%s」タブはすでにあるため、何もしませんでした（版 %s）', INQ_SHEET_FAQ, INQ_VERSION); return { created: false, rows: 0, active: 0 }; }
  Logger.log('「%s」タブを作りました（版 %s）：%s行（有効 %s行・回答文が空で有効オフ %s行）', INQ_SHEET_FAQ, INQ_VERSION, made.rows, made.active, made.rows - made.active);
  return { created: true, rows: made.rows, active: made.active };
}

/** まとめのお知らせのトリガーを 9時台・12時台の2本だけにする（既存のほかのトリガーには触れない。何度実行しても増えない） */
function INQ_setupRemindTriggers() {
  INQ_removeRemindTriggers();
  INQ_REMIND_HOURS.forEach(function (h) { ScriptApp.newTrigger('INQ_remind').timeBased().atHour(h).nearMinute(0).everyDays(1).inTimezone(AC_TZ).create(); });
  Logger.log('問い合わせのまとめのお知らせのトリガーを作りました（%s時台）', INQ_REMIND_HOURS.join('時台・'));
}
/** INQ_remind のトリガーだけを消す */
function INQ_removeRemindTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'INQ_remind') ScriptApp.deleteTrigger(t); });
}
/** 以前の名前（同じ動き） */
function INQ_setupTriggers() { INQ_setupRemindTriggers(); }
function INQ_removeTriggers() { INQ_removeRemindTriggers(); }

/** 手動確認用：今のシートで、まとめのお知らせの件数と文字数だけを実行ログに出す（送らない。氏名・本文は出さない） */
function INQ_remindPreview() {
  var cases = INQ_cases_(INQ_sheet_(INQ_book_(), INQ_SHEET_CASE, INQ_CASE_HEADER));
  var open = cases.filter(function (c) { return c.state === INQ_STATE.open; }).length;
  var doing = cases.filter(function (c) { return c.state === INQ_STATE.doing; }).length;
  var text = INQ_remindText(cases, new Date()), car = INQ_remindCarousels(cases, new Date());
  Logger.log('問い合わせのまとめ（確認だけ・送信なし。版 ' + INQ_VERSION + '・INQ_MODE=' + INQ_mode_() + '）：未完了 ' + (open + doing) + '件（未対応 ' + open
    + '件・対応中 ' + doing + '件）／カード ' + (car ? car.shown : 0) + '枚・' + (car ? car.messages.length : 0) + '通' + (car && car.more ? '（ほか ' + car.more + '件はシートで確認）' : '')
    + '／文字の版（送れないとき）の文字数 ' + (text ? text.length : 0) + '（上限 ' + INQ_TEXT_MAX + '）' + (text && /…ほか\d+件はシートで確認$/.test(text) ? '／途中で切ります' : ''));
  return { count: open + doing, length: text ? text.length : 0 };
}

/** すぐに止める（記録・送信・返信をすべてしない）。トリガーは残るが何もしない */
function INQ_stop() {
  INQ_props_().setProperty('INQ_MODE', 'off');
  Logger.log('問い合わせ管理を止めました（INQ_MODE=off）');
}

/** 手動確認用：未完了の案件の一覧を実行ログに表示する（送信・書き込みなし。本文の冒頭は出さない） */
function INQ_preview() {
  var cases = INQ_cases_(INQ_sheet_(INQ_book_(), INQ_SHEET_CASE, INQ_CASE_HEADER))
    .filter(function (c) { return c.state === INQ_STATE.open || c.state === INQ_STATE.doing; });
  Logger.log('問い合わせ（版 %s・INQ_MODE=%s）：未完了 %s件', INQ_VERSION, INQ_mode_(), cases.length);
  cases.forEach(function (c) { Logger.log('%s %s %s', c.id, c.state, c.link); });
}

// Node.jsのテストから純粋関数を読み込むため（コード.gs の書き出しに追加する）
if (typeof module !== 'undefined') {
  module.exports = Object.assign(module.exports || {}, { INQ_VERSION: INQ_VERSION, INQ_parseDoneNumbers: INQ_parseDoneNumbers, INQ_stripMentions: INQ_stripMentions, INQ_remindList: INQ_remindList, INQ_STATE: INQ_STATE, INQ_nfkc: INQ_nfkc,
    INQ_isRoutine: INQ_isRoutine, INQ_isAckOnly: INQ_isAckOnly, INQ_isAckMessage: INQ_isAckMessage, INQ_shouldAutoClose: INQ_shouldAutoClose, INQ_daysBetween: INQ_daysBetween, INQ_AUTO_DONE_BY: INQ_AUTO_DONE_BY, INQ_hasSecret: INQ_hasSecret, INQ_maskSecret: INQ_maskSecret, INQ_head: INQ_head,
    INQ_messageSummary: INQ_messageSummary, INQ_matchEmployee: INQ_matchEmployee, INQ_whoLabel: INQ_whoLabel,
    INQ_parsePostback: INQ_parsePostback, INQ_postbackData: INQ_postbackData, INQ_decide: INQ_decide, INQ_nextId: INQ_nextId,
    INQ_shouldNotifyAppend: INQ_shouldNotifyAppend, INQ_newCaseMessage: INQ_newCaseMessage, INQ_newCaseText: INQ_newCaseText,
    INQ_appendText: INQ_appendText, INQ_remindText: INQ_remindText, INQ_classify: INQ_classify, INQ_classifyPlan: INQ_classifyPlan, INQ_firstSentence: INQ_firstSentence, INQ_whoShort: INQ_whoShort, INQ_summary: INQ_summary, INQ_isSensitiveCategory: INQ_isSensitiveCategory, INQ_shownHead: INQ_shownHead, INQ_stateLabel: INQ_stateLabel, INQ_caseLines: INQ_caseLines, INQ_openCaseOf: INQ_openCaseOf, INQ_caseWho: INQ_caseWho,
    INQ_C: INQ_C, INQ_caseCols: INQ_caseCols, INQ_colsMessage: INQ_colsMessage, INQ_newCaseRow: INQ_newCaseRow, INQ_rowToCase: INQ_rowToCase,
    INQ_SHEET_FAQ: INQ_SHEET_FAQ, INQ_FAQ_HEADER: INQ_FAQ_HEADER, INQ_FAQ_ROWS: INQ_FAQ_ROWS, INQ_faqSheetRows: INQ_faqSheetRows,
    INQ_joinHead: INQ_joinHead, INQ_isContinuation: INQ_isContinuation, INQ_targetPlan: INQ_targetPlan, INQ_isDigestRun: INQ_isDigestRun, INQ_REMIND_HOURS: INQ_REMIND_HOURS, INQ_remindCarousels: INQ_remindCarousels, INQ_remindBubble: INQ_remindBubble, INQ_daysAgoLabel: INQ_daysAgoLabel, INQ_mark: INQ_mark, INQ_caseSensitive: INQ_caseSensitive, INQ_staffGroups: INQ_staffGroups, INQ_NOTICE_DEPT: INQ_NOTICE_DEPT });
}
