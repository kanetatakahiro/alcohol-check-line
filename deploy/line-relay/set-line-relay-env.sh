#!/usr/bin/env bash
# 【本番導入時に実行・承認後】LINE署名確認つき中継の秘密情報を line-relay.env に保存する（既存の .env には触れない・画面に表示しない）。
set -euo pipefail
APP="$HOME/alcohol-check-line"
read -rp  "Apps Script のウェブアプリURL（既存のTOT中継と同じ）: " URL
read -rsp "LINE Developers のチャネルシークレットを貼り付けてEnter: " CH; echo
read -rsp "Apps Script の EA_FORWARD_SECRET を貼り付けてEnter: " FWD; echo
umask 077
printf 'LINE_CHANNEL_SECRET=%s\nGAS_WEBAPP_URL=%s\nEA_FORWARD_SECRET=%s\nLINE_RELAY_PORT=8787\nLINE_RELAY_SPOOL=%s/line-relay-spool\n' \
  "$CH" "$URL" "$FWD" "$APP" > "$APP/line-relay.env"
echo "保存しました（チャネルシークレット ${#CH}文字／合言葉 ${#FWD}文字）"
