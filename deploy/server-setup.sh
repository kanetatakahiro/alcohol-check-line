#!/usr/bin/env bash
# 固定IPの無料サーバー（Oracle Cloud Always Free・Ubuntu）で1回だけ実行する。
# TOTの勤務予定を毎朝7:05（日本時間）に読み取り、Apps Scriptへ渡すための準備。
# トークン等の秘密情報はこのスクリプトに書かない。最後に .env を自分で編集する。
set -euo pipefail

sudo timedatectl set-timezone Asia/Tokyo
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git

APP="$HOME/alcohol-check-line"
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone https://github.com/kanetatakahiro/alcohol-check-line.git "$APP"; fi

if [ ! -f "$APP/.env" ]; then
  cat > "$APP/.env" <<'ENV'
TOT_ACCESS_TOKEN=
GAS_WEBAPP_URL=
TOT_SYNC_SECRET=
TOT_SYNC_DAYS=7
ENV
fi
chmod 600 "$APP/.env"

# 毎朝7:05に実行（TOTの利用禁止時間帯 8:30〜10:00 を避ける）。ログは件数のみ。
LINE="5 7 * * * cd $APP && /usr/bin/node --env-file=.env src/tot-sync.js >> $HOME/tot-sync.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'tot-sync.js' ; echo "$LINE" ) | crontab -
echo "準備完了。次に nano $APP/.env で3つの値を入れ、'cd $APP && node --env-file=.env src/tot-sync.js' で試してください。"
echo "このサーバーの外部IP（TOTの許可IPに登録）: $(curl -fsS https://ifconfig.me || echo '取得できず')"
