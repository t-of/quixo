// チュートリアルの決め打ち盤面が正しく機能するかの確認（node tutorial.check.mjs で実行）。
// main.js は three.js を読み込むのでここには import せず、同じ純粋な盤面ロジックだけ複製して検証する。
// main.js のこの部分を変えたら、ここも合わせて直す。
import assert from 'node:assert';

const IDX = (r, c) => r * 5 + c;
const BORDER = [];
for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (r === 0 || r === 4 || c === 0 || c === 4) BORDER.push(IDX(r, c));
const MOVES = {};
for (const pick of BORDER) {
  const r = Math.floor(pick / 5), c = pick % 5;
  const list = [];
  if (r !== 0) list.push({ code: 'top', chain: Array.from({ length: r + 1 }, (_, i) => IDX(i, c)) });
  if (r !== 4) list.push({ code: 'bottom', chain: Array.from({ length: 5 - r }, (_, i) => IDX(4 - i, c)) });
  if (c !== 0) list.push({ code: 'left', chain: Array.from({ length: c + 1 }, (_, j) => IDX(r, j)) });
  if (c !== 4) list.push({ code: 'right', chain: Array.from({ length: 5 - c }, (_, j) => IDX(r, 4 - j)) });
  MOVES[pick] = list;
}
const LINES = [];
for (let r = 0; r < 5; r++) LINES.push(Array.from({ length: 5 }, (_, c) => IDX(r, c)));
for (let c = 0; c < 5; c++) LINES.push(Array.from({ length: 5 }, (_, r) => IDX(r, c)));
LINES.push(Array.from({ length: 5 }, (_, i) => IDX(i, i)));
LINES.push(Array.from({ length: 5 }, (_, i) => IDX(i, 4 - i)));
function hasLine(cells, mark) { return LINES.some((line) => line.every((i) => cells[i] === mark)); }
function applyMove(cells, chain, mark) {
  const old = chain.map((i) => cells[i]);
  cells[chain[0]] = mark;
  for (let k = 1; k < chain.length; k++) cells[chain[k]] = old[k - 1];
}
function emptyCells() { return new Array(25).fill(0); }
function tCells(marks) { const c = emptyCells(); marks.forEach(([i, m]) => { c[i] = m; }); return c; }

// 段階4: 勝つ手。pick=IDX(4,1)、push=top → ○が5つ並ぶ
{
  const base = tCells([[IDX(0, 1), 1], [IDX(1, 1), 1], [IDX(2, 1), 1], [IDX(3, 1), 1]]);
  const pick = IDX(4, 1);
  const correct = MOVES[pick].find((m) => m.code === 'top');
  const cells = base.slice();
  applyMove(cells, correct.chain, 1);
  assert.ok(hasLine(cells, 1), '正解の手で○が5つ並ぶはず');

  // 不正解（左右に押す）では並ばない
  for (const code of ['left', 'right']) {
    const wrong = MOVES[pick].find((m) => m.code === code);
    const c2 = base.slice();
    applyMove(c2, wrong.chain, 1);
    assert.ok(!hasLine(c2, 1), `${code} 押しでは5つ並ばないはず`);
  }
}

// 段階5: 押し込みで×が5つ並ぶ手を避ける。pick=IDX(0,2)
{
  const base = tCells([[IDX(1, 0), 2], [IDX(1, 1), 2], [IDX(1, 3), 2], [IDX(1, 4), 2], [IDX(2, 2), 2]]);
  const pick = IDX(0, 2);
  const trap = MOVES[pick].find((m) => m.code === 'bottom');
  const cells = base.slice();
  applyMove(cells, trap.chain, 1);
  assert.ok(hasLine(cells, 2), '下から押すと×が5つ並んで負けになるはず');

  for (const code of ['left', 'right']) {
    const safe = MOVES[pick].find((m) => m.code === code);
    const c2 = base.slice();
    applyMove(c2, safe.chain, 1);
    assert.ok(!hasLine(c2, 2), `${code} 押しは安全なはず`);
  }
}

console.log('OK: tutorial boards behave as scripted');
