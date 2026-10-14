#!/usr/bin/env bash
# さくらのVPS（Debian 12）で1回だけ実行する初期設定。
# TOTの勤怠データを毎朝7:05（日本時間）に読み取り、Apps Scriptへ渡す。
# 秘密情報はこのスクリプトに書かない。最後に .env を自分で編集する。
set -euo pipefail
sudo timedatectl set-timezone Asia/Tokyo
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
APP="$HOME/alcohol-check-line"
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone https://github.com/kanetatakahiro/alcohol-check-line.git "$APP"; fi
if [ ! -f "$APP/.env" ]; then
  printf 'TOT_ACCESS_TOKEN=\nGAS_WEBAPP_URL=\nTOT_SYNC_SECRET=\n' > "$APP/.env"
fi
chmod 600 "$APP/.env"
# 毎朝7:05に実行（TOTの利用禁止時間帯 8:30〜10:00・17:30〜18:30 を避ける）。ログは件数と状態のみ。
LINE="5 7 * * * cd $APP && /usr/bin/node --env-file=.env src/tot-relay.js >> $HOME/tot-relay.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'tot-relay.js' ; echo "$LINE" ) | crontab -
echo "== 準備完了 =="
echo "このサーバーの外部IP: $(curl -fsS https://ifconfig.me || echo '取得できず')"
