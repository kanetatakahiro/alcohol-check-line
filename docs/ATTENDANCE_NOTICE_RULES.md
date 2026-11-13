# 勤怠のお知らせの決まり（一覧）

- 作成：2026-11-13（安藤さんの指示。ミスを防ぐため、決めたルールを番号つきで1か所にまとめる）
- 対象のコード：コード.gs 版 2026-11-13f（gas/AlcoholCheck.gs）・gas/TotSync.gs 版 2026-11-13d・src/tot-write.js
- テスト：test/rules.test.js（1つのルールにつき1つ以上。テストの名前の先頭が「ルール{番号}」）。`npm test` で全部通ることを確かめる
- コードがルールどおりでないところは、テストに `todo` の印を付けて残し、下の「ルールどおりでないところ」に書く（直すかどうかは別に決める）
- 通知の番号（E-40 など）は docs/MESSAGES_INVENTORY.md のもの。E-40＝夜の勤怠のお知らせ、E-42＝管理本部の本人への打刻漏れのお知らせ、E-78＝毎週月曜の打刻漏れの催促、ATT-11＝スケジュール変更のお知らせ（E-79）

## ルールの一覧

| 番号 | ルール | 主なコード | テスト（test/rules.test.js） | 今のコード |
|---|---|---|---|---|
| 1 | 打刻申請・スケジュール申請が申請中・承認済みの日は、E-40・E-42・E-78 で送らない（却下などの日は送る） | AC_requestedDays、AC_nightSelfItems（E-40）、AC_unrequestedPunchErrors（E-42）、AC_weeklyPunchItems（E-78） | ルール1（4件） | **一部ちがう**（下の 1-a） |
| 2 | 打刻の種類は、判定の順に「休みの日の打刻（全日休暇の日に出勤か退勤の打刻が1回以上）」／退勤なし（出勤 ≥1・退勤 0）／出勤なし（出勤 0・退勤 ≥1）／出勤・退勤なし（両方 0）／二重打刻（両方 ≥1 で数が違う。多い方と回数）／それ以外（同じ数・timerecord の期間外・データ無し）は「打刻の内容をご確認ください」 | AC_punchKindIndex、AC_punchKindClass、AC_punchLine、AC_punchKindLabel | ルール2 | ルールどおり |
| 3 | フォームの連絡がある日：欠勤・有給休暇・休みの変更は TOT に自動反映し、反映待ち・反映済みの日は本人に何も送らない。休日出勤は本人にスケジュール申請を依頼する（【勤怠の変更】）。自動反映できなかった日（過ぎた日・打刻あり・承認されなかった・TOT_WRITE が on でない）も【勤怠の変更】で依頼する。書き出しは「{入力者}さんより、」、本人の入力なら「勤怠変更フォームより、」 | SCH_requestFromForm、SCH_syncedKeys_、SCH_markSynced、AC_formSplit、AC_formChangeLines | ルール3（4件） | **一部ちがう**（下の 3-a） |
| 4 | 締めは「ご確認のほどよろしくお願いいたします！」。当日の出勤打刻なしがあるときだけ「ご対応のほどよろしくお願いいたします！」 | AC_nightSelfMessage、テンプレート weeklyPunch | ルール4 | ルールどおり |
| 5 | 夜のお知らせ（E-40）と E-42 は、同じ日・同じ連絡について1回だけ。E-78（月曜）は未申請なら毎週出す（同じ週は1通） | AC_nightSelfRun_（att:日付:punch:TOTコード）、AC_punchSelfNotices_（sent:日付:punchself:社員番号）、AC_weeklyPunchRun_（att:週の月曜:weeklypunch:TOTコード） | ルール5（3件） | **一部ちがう**（下の 5-a） |
| 6 | ATT-02 が OFF・お知らせ停止中の人には送らない。ただしフォームから入った停止の日は打刻の項目だけ送る（【勤怠の変更】）。手で入れた停止の日は何も送らない | AC_isPausedForPunch、AC_isPaused、AC_noticeCheck_ | ルール6（2件） | ルールどおり |
| 7 | 承認カードに出すのはスケジュール申請（申請中）だけ。打刻申請・残業申請は出さない | SCH_pendingRequests、SCH_requestLines | ルール7 | ルールどおり |
| 8 | カードの対象者本人は承認できない。TOT への申請の承認・棄却は TOT_APPROVER_KEY の管理者で行う（無い・承認フローにいなければ承認しない） | SCH_isSelf_、SCH_button_、src/tot-write.js の checkRequests | ルール8 | ルールどおり |
| 9 | 9:00・15:00 のまとめに承認待ちを載せる。対象の日の前日15時台に承認待ちのカードを1回だけもう一度送る | SCH_remindText、SCH_isDueForResend、SCH_remindPart_ | ルール9 | ルールどおり |
| 10 | 反映できたら本人に ATT-11 を1通。TOT_WRITE=record のときは送らず記録だけ（「TOT反映」シートの「本人へのお知らせ」） | SCH_handleResult_、SCH_selfNotify_、SCH_button_ | ルール10 | ルールどおり |
| 11 | TOT_WRITE が未設定・record のとき、TOT には何も書かない（未設定はシートもカードも作らない。record は VPS に何も渡さない） | SCH_mode_、SCH_onForm_、SCH_handleQueue_ | ルール11 | ルールどおり |

## ルールどおりでないところ（直していません）

テストは `todo` の印つきで test/rules.test.js にあります（`npm test` の「todo 3」）。直すと、そのテストの `todo` を外します。

| 記号 | ルール | 今のコードの動き | 起きること | 直すときの場所 |
|---|---|---|---|---|
| 1-a | 1 | E-42 の打刻の日は、打刻申請（timerecords）だけを見て外す。スケジュール申請（schedules）が申請中・承認済みの日も送る（フォームの連絡の期間の日だけは両方を見る） | 管理本部の人が欠勤などのスケジュール申請を出した日（TOT ではエラー勤務のまま）に、E-42 で打刻の確認を求める | AC_unrequestedPunchErrors（`['timerecords']` → `AC_NIGHT_REQUEST_TYPES`） |
| 3-a | 3 | 【勤怠の変更】を送らない判定（SCH_syncedKeys_）は「TOT反映」シートの状態だけを見て、TOT_WRITE を見ない | TOT_WRITE を on から record・未設定に戻したとき、反映待ち・反映中のまま残った連絡は TOT に書かれないのに、本人へも【勤怠の変更】が送られない（今は record で運用中のため、反映待ちの行は無い） | SCH_syncedKeys_（TOT_WRITE が on でなければ、反映済み・元に戻す待ち・元に戻し中だけを数えるなど） |
| 5-a | 5 | 夜のお知らせ（E-40）は、自分の送信の記録（att:日付:punch:TOTコード）だけを見る。E-42 の送信の記録（sent:日付:punchself:社員番号）は見ない。E-42 は E-40 の記録を見る | 管理本部の人に、朝の E-42 で知らせた打刻漏れの日（昨日）を、その夜の E-40 でもう一度送る（逆の順は1回だけ） | AC_nightSelfRun_ の送信済みの確認、または E-42 が送ったときに att:日付:punch:TOTコード も記録する |

## 補足（ルールどおりだが、気をつけること）

- ルール3：「承認待ち」の連絡は、承認されるまで本人に【勤怠の変更】（スケジュール申請のお願い）が届く（ルールの「反映待ち・反映済み」に入らないため）。承認されて反映待ちになると、次からは送らない。
- ルール2：休みの日の打刻・二重打刻が分かるのは、timerecord（日別打刻）のある直近7日だけ。E-78 の8日より前の日は日付だけの行になる。
- ルール2：「全日休暇」は日別勤怠の holidaysObtained.fulltimeHoliday（公休・有休・欠勤など、休暇区分が付いている日）。半日休暇は数えない。
