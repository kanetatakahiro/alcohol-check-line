// 版 2026-11-20d：問い合わせのまとめのカルーセル（Flex）から、カードごとの文字を取り出す（テスト用）
// cards(pushes)：送信（push の記録）の配列 → [[1枚目の文字…], [2枚目の文字…], …]（区切り線は除く）
export function cards(pushes) {
  const out = [];
  for (const p of pushes) for (const m of p.body.messages) {
    if (m.type !== 'flex' || !m.contents || m.contents.type !== 'carousel') continue;
    for (const b of m.contents.contents) out.push(b.body.contents.filter((x) => x.type === 'text').map((x) => x.text));
  }
  return out;
}
// carousels(pushes)：カルーセルのメッセージだけ
export function carousels(pushes) {
  return pushes.flatMap((p) => p.body.messages).filter((m) => m.type === 'flex' && m.contents && m.contents.type === 'carousel');
}
