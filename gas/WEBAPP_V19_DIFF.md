# Webアプリ（バージョン19）と最新コードの差分と、本人へのお知らせの反映方法（2026-10-27）

## 現状
- LINEのWebhookとVPSのTOT受信（朝7:05・夜22:30）は doPost で動き、Webアプリのバージョン19（2026/10/16 12:03）のコードを使う
- 時間で動く処理（アルコールチェックの各通知、10分ごとの確認、1時間ごとの処理、フォーム送信時）は「コード.gs」の最新（保存済みの内容）で動く
- 10/16以降の本番反映は「コード.gs」の置き換えだけで、Webアプリの新しい版は発行していない

## 新しい版を発行すると doPost に入る変更（関数単位。10/16〜10/23に main へ入ったもの）
- 文面：AC_TEMPLATES、AC_composeMessage、AC_messageFor、AC_careLine、AC_CARE、AC_templateOverrides_、AC_overtimeMessage（LINE文面の改訂版、気遣い文）
- LINEの返信：AC_reply_
- 月末の翌月シフト反映：AC_applyNextMonthShift_
- 天気・気象警報：AC_fetchWeather_、AC_weatherFromJma
- アルコールチェック関連：AC_dispatch_、AC_ALCOHOL_KINDS、AC_CHECK_LABELS
- 勤怠連絡フォーム（部署別）：AC_codeFromChoice、AC_refreshFormChoices_ ほか追加分
- その他：alcoholCheckUsage、AC_infection_、設定の確認、手動シフト反映など（追加）
- 影響する主な場面：夜22:30の勤怠テスト通知の文面、LINEでの登録・返信、10/31朝の翌月シフト反映の処理

## 本人へのお知らせ（承認待ち・打刻漏れ）の反映方法：デプロイしない
- 本人へのお知らせは doPost の中では動かさず、既存の1時間ごとのトリガー（alcoholCheckImportTot）から実行する
- 朝のTOT受信で保存される tot-latest.json（バージョン19でも保存される）を読み、1日1回（7〜12時）行う
- 本番反映に必要な作業：「コード.gs」の置き換え（版 2026-10-27b）＋スクリプトプロパティ（PUNCH_SELF_NOTIFY=record）だけ
- 変更しないもの：Webアプリのデプロイ（バージョン19のまま）、Webhook、トリガー、VPS、従業員マスタ
- 時間で動く処理への影響：1時間ごとの処理の最後に、エラーを外へ出さない形で1つ呼び出しを足すだけ（設定が未設定なら何もしない）
- 戻し方：「コード.gs」を main（edd2e57）に戻す、または REQUEST_SELF_NOTIFY・PUNCH_SELF_NOTIFY を削除する

## Webアプリの新しい版の発行（別途）
- 上記の doPost への変更は、内容を確認してから別に判断する
- 発行した後に戻す場合は「デプロイを管理」でバージョン19を選び直す（URLは変わらない）
