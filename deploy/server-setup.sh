#!/usr/bin/env bash
# さくらのVPS（Rocky Linux / AlmaLinux / Debian）で1回だけ実行する初期設定。
# 使い方： curl -fsSL https://raw.githubusercontent.com/kanetatakahiro/alcohol-check-line/main/deploy/server-setup.sh | bash
# TOTの勤怠データを毎朝7:05（日本時間）に読み取り、Apps Scriptへ渡す。
# 秘密情報（トークン・合言葉）はこのスクリプトに含めない。最後に入力欄が出るので貼り付ける。
set -euo pipefail
sudo timedatectl set-timezone Asia/Tokyo
if command -v dnf >/dev/null; then
  sudo dnf install -y git cronie curl
  sudo systemctl enable --now crond
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
    sudo dnf install -y nodejs || true
    if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo dnf install -y nodejs
    fi
  fi
else
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl git cron
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi
APP="$HOME/alcohol-check-line"
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone https://github.com/kanetatakahiro/alcohol-check-line.git "$APP"; fi
# 毎朝7:05に実行（TOTの利用禁止時間帯 8:30〜10:00・17:30〜18:30 を避ける）。ログは件数と状態のみ。
LINE="5 7 * * * cd $APP && $(command -v node) --env-file=.env src/tot-relay.js >> $HOME/tot-relay.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'tot-relay.js' ; echo "$LINE" ) | crontab -
echo "== 準備完了（node $(node -v)） =="
echo "続けて： bash $APP/deploy/set-env.sh"
