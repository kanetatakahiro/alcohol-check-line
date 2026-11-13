# VPS の SSH を「鍵だけのログイン」にする手順書

- 作成：2026-11-13。対象：さくらのVPS（固定IP 133.167.110.249・Rocky Linux 10・ユーザー rocky）
- 実行する人：安藤さん。VPS 側の操作は、さくらのコントロールパネルの**シリアルコンソール**で行う前提です。
- この手順でできること：パスワードでの SSH ログインを止め、登録した鍵を持っている端末だけがログインできるようにします。root での SSH ログインも止めます。
- 変えないもの：中継（cron の tot-relay・tot-write）、.env、ファイアウォール、rocky のパスワード。シリアルコンソールのログインは SSH の設定と関係ないので、**締め出されてもシリアルコンソールから戻せます**。

> 秘密鍵（`~/.ssh/sakura_vps_ed25519`。`.pub` の付かない方）は、チャット・GitHub・メールに貼らないでください。VPS に置くのは公開鍵（`.pub`）だけです。

## 0. 始める前に

1. シリアルコンソールに rocky でログインでき、`sudo -v` が通ることを確かめます（rocky のパスワードが要ります）。
2. 作業のあいだ、**シリアルコンソールの画面は閉じないでください**（最後の確認が終わるまで）。
3. 8:30〜10:00・17:30〜18:30 は TOT の API の利用禁止の時間帯で、中継も動きません。手順は中継の動く時刻（7:03〜22:53 の10分ごと・7:05・22:30）と重なっても問題ありません（SSH の設定だけを変えるため）。

## 1. 鍵を作る（安藤さんの Mac のターミナル）

```sh
ssh-keygen -t ed25519 -C "sakura-vps-rocky" -f ~/.ssh/sakura_vps_ed25519
cat ~/.ssh/sakura_vps_ed25519.pub
```

- パスフレーズは付けることをおすすめします（Mac のキーチェーンに覚えさせられます）。
- 2行目で出た `ssh-ed25519 AAAA… sakura-vps-rocky` の1行が公開鍵です。

## 2. 公開鍵を VPS に登録する

### 方法A：今パスワードで SSH ログインできるなら（Mac から）

```sh
ssh-copy-id -i ~/.ssh/sakura_vps_ed25519.pub rocky@133.167.110.249
```

### 方法B：シリアルコンソールで登録する

公開鍵の1行を、コントロールパネルの貼り付け機能で入力します（1行のまま、途中で改行しないこと）。

```sh
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'ここに公開鍵の1行（ssh-ed25519 AAAA… sakura-vps-rocky）' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
restorecon -Rv ~/.ssh          # SELinux のラベルを直す（Rocky Linux ではこれが無いと鍵が読まれないことがある）
tail -n 1 ~/.ssh/authorized_keys | cut -c1-30   # 先頭が「ssh-ed25519 AAAA」なら登録できている
```

## 3. 鍵でログインできることを先に確かめる（Mac・**新しいターミナル**で）

```sh
ssh -i ~/.ssh/sakura_vps_ed25519 -o IdentitiesOnly=yes rocky@133.167.110.249 'echo key-login-ok; hostname'
```

- `key-login-ok` と出れば OK です。**出ないときは 4 に進まないでください**（2 をやり直す。`ls -laZ ~/.ssh` で権限とラベルを確認）。
- 毎回 `-i` を付けなくて済むよう、Mac の `~/.ssh/config` に足しておくと便利です：

```
Host sakura-vps
  HostName 133.167.110.249
  User rocky
  IdentityFile ~/.ssh/sakura_vps_ed25519
  IdentitiesOnly yes
```

（以後は `ssh sakura-vps` でログインできます）

## 4. パスワードでのログインを止める（シリアルコンソール）

Rocky Linux 10 の `/etc/ssh/sshd_config` は、先頭で `/etc/ssh/sshd_config.d/*.conf` を読み込み、**同じ項目は先に読んだ値が使われます**。そこで、ほかのファイル（`50-redhat.conf`、さくらの初期設定の `50-cloud-init.conf` など）より先に読まれる `01-` の名前で作ります。元の `sshd_config` は書き換えません。

```sh
sudo tee /etc/ssh/sshd_config.d/01-key-only.conf >/dev/null <<'EOF'
# 鍵だけのログイン（2026-11 安藤さん。戻すときはこのファイルを消して sshd を reload）
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AuthenticationMethods publickey
EOF
sudo chmod 600 /etc/ssh/sshd_config.d/01-key-only.conf
sudo sshd -t && echo config-ok        # 設定の書き間違いがないか（config-ok と出なければ 6 で戻す）
sudo systemctl reload sshd
```

- `reload` は今つながっている SSH を切りません。
- 反映された値の確認：

```sh
sudo sshd -T | grep -Ei '^(pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|authenticationmethods) '
```

→ `pubkeyauthentication yes`／`passwordauthentication no`／`kbdinteractiveauthentication no`／`permitrootlogin no`／`authenticationmethods publickey` の5行になれば OK。

## 5. 確かめる（Mac・新しいターミナル）

```sh
# 鍵でログインできる
ssh sakura-vps 'echo key-login-ok'
# パスワードではログインできない（「Permission denied (publickey).」と出れば OK）
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive rocky@133.167.110.249
```

両方が期待どおりなら完了です。シリアルコンソールからログアウトしてかまいません。

- 中継の確認（任意）：次の回のあとに `tail -n 3 ~/tot-relay.log`（SSH の設定とは関係ないので、変わらず動いているはず）。

## 6. 締め出されたときの戻し方（シリアルコンソール）

鍵でログインできなくなった・設定を間違えたときは、シリアルコンソールに rocky（パスワード）でログインして：

```sh
sudo rm -f /etc/ssh/sshd_config.d/01-key-only.conf
sudo sshd -t && sudo systemctl reload sshd
sudo sshd -T | grep -Ei '^passwordauthentication '   # yes に戻っていれば、パスワードで SSH ログインできる
```

- `sudo sshd -t` でエラーが出るときは、エラーに出たファイル名と行を確かめて直してから reload してください（エラーのまま `restart` すると sshd が起動しなくなります。その場合もシリアルコンソールからは入れます）。
- 鍵の登録を間違えたとき：`nano ~/.ssh/authorized_keys`（または `vi`）で1行を直し、`chmod 600 ~/.ssh/authorized_keys; restorecon -Rv ~/.ssh`。
- Mac を替えた・秘密鍵をなくしたとき：新しい Mac で 1〜3 をやり直し、`~/.ssh/authorized_keys` から古い鍵の行を消します。

## 7. やってはいけないこと

- rocky のパスワードを消す・ロックする（`passwd -l` など）：シリアルコンソールに入れなくなります。
- `sshd_config` 本体の `Include` の行を消す・`01-key-only.conf` 以外の既存のファイルを消す。
- 3 の確認の前に 4 を行う。
- 秘密鍵を VPS・GitHub・チャットに置く。

## 8. Claude（この Mac）からの接続について

この手順のあとも、Claude が作業している Mac には鍵がないため、Claude は VPS に接続できません（今と同じ）。VPS の作業は引き続き安藤さんがシリアルコンソール（または鍵を登録した Mac）で行います。Claude 用に接続を許す場合は、別の鍵を作って `authorized_keys` に1行足すかを、改めて決めてください。
