#!/usr/bin/env bash
# 秘密情報を .env に保存する（画面には表示しない）。貼り付けてEnterを押す。
set -euo pipefail
APP="$HOME/alcohol-check-line"
URL="https://script.google.com/macros/s/AKfycbyoN1IRoiNXEpIMCOWiHCgRflH0XgxmVGUdVj0c6B9cYnT-IKtqxBiHTeP8uuDALkSt/exec"
read -rsp "TOTのアクセストークンを貼り付けてEnter: " TOT; echo
read -rsp "Apps Scriptの TOT_SYNC_SECRET を貼り付けてEnter: " SEC; echo
umask 077
printf 'TOT_ACCESS_TOKEN=%s\nGAS_WEBAPP_URL=%s\nTOT_SYNC_SECRET=%s\n' "$TOT" "$URL" "$SEC" > "$APP/.env"
echo "保存しました（トークン ${#TOT}文字／合言葉 ${#SEC}文字）。試しに実行： cd $APP && node --env-file=.env src/tot-relay.js"
