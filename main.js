'use strict';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'quixo.' で始める。
const STORE = 'quixo.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'quixo', text: '外周のキューブを押し込んで、縦横斜めに5つ揃えたら勝ち' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// ---- ここからアプリ本体 ----
//
// クイキシオ: 5×5・25 個のキューブ。無地 / ○ / × のどれか。
// 外周 16 マスから「無地か自分の印」を 1 個取り、相手の印に変えずに自分の印にして、
// その行・列の端（取った場所と反対側）から押し込み、間を 1 個ずつずらす。
// マスは 0〜24（row*5+col）。

const IDX = (r, c) => r * 5 + c;
const BORDER = [];
for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (r === 0 || r === 4 || c === 0 || c === 4) BORDER.push(IDX(r, c));

// 押し込める向き。entry（新しい印が入る端）は chain[0]、chain は entry → 取った場所の順。
// 取った場所自身の側からは入れられない（r!==0 のとき top が入る、など）。
const CODE = { top: 0, bottom: 1, left: 2, right: 3 };
const MOVES = {};
for (const pick of BORDER) {
  const r = Math.floor(pick / 5), c = pick % 5;
  const list = [];
  if (r !== 0) list.push({ code: CODE.top, chain: Array.from({ length: r + 1 }, (_, i) => IDX(i, c)) });
  if (r !== 4) list.push({ code: CODE.bottom, chain: Array.from({ length: 5 - r }, (_, i) => IDX(4 - i, c)) });
  if (c !== 0) list.push({ code: CODE.left, chain: Array.from({ length: c + 1 }, (_, j) => IDX(r, j)) });
  if (c !== 4) list.push({ code: CODE.right, chain: Array.from({ length: 5 - c }, (_, j) => IDX(r, 4 - j)) });
  MOVES[pick] = list;
}

const LINES = [];
for (let r = 0; r < 5; r++) LINES.push(Array.from({ length: 5 }, (_, c) => IDX(r, c)));
for (let c = 0; c < 5; c++) LINES.push(Array.from({ length: 5 }, (_, r) => IDX(r, c)));
LINES.push(Array.from({ length: 5 }, (_, i) => IDX(i, i)));
LINES.push(Array.from({ length: 5 }, (_, i) => IDX(i, 4 - i)));

function hasLine(cells, mark) { return LINES.some((line) => line.every((i) => cells[i] === mark)); }
function findLine(cells, mark) { return LINES.find((line) => line.every((i) => cells[i] === mark)) || null; }

// chain[0]（entry）に mark を入れ、残りは 1 つ前の古い値を引き継ぐ（＝ずらす）
function applyMove(cells, chain, mark) {
  const old = chain.map((i) => cells[i]);
  cells[chain[0]] = mark;
  for (let k = 1; k < chain.length; k++) cells[chain[k]] = old[k - 1];
}

let G = null; // 対局中の状態。null ならタイトル（モード選択）画面

function newGame(mode, cpuSide) {
  G = { mode, cpuSide, cells: Array(25).fill(0), turn: 1, selected: null, winner: null, winLine: null, history: new Map() };
  render();
  maybeCpuTurn();
}

function isCpuTurn() { return G.mode === 'cpu' && G.turn === G.cpuSide; }
function playerLabel(p) {
  if (p === 'draw') return '引き分け';
  if (G.mode === 'cpu') return p === G.cpuSide ? 'CPU' : 'あなた';
  return p === 1 ? '1人目' : '2人目';
}

function doMove(pick, mv) {
  applyMove(G.cells, mv.chain, G.turn);
  G.selected = null;
  const other = G.turn === 1 ? 2 : 1;
  if (hasLine(G.cells, other)) {
    // 自分の印と同時に揃っても、相手の印が揃った時点で手番側の負け
    G.winner = other; G.winLine = findLine(G.cells, other);
  } else if (hasLine(G.cells, G.turn)) {
    G.winner = G.turn; G.winLine = findLine(G.cells, G.turn);
  } else {
    const key = G.cells.join('') + ':' + other;
    const count = (G.history.get(key) || 0) + 1;
    G.history.set(key, count);
    if (count >= 3) G.winner = 'draw';
    else G.turn = other;
  }
  render();
  maybeCpuTurn();
}

function clickCell(i) {
  if (!G || G.winner || isCpuTurn()) return;
  if (G.selected == null) {
    if (!BORDER.includes(i) || (G.cells[i] !== 0 && G.cells[i] !== G.turn)) return;
    G.selected = i;
    render();
    return;
  }
  if (G.selected === i) { G.selected = null; render(); return; }
  const mv = MOVES[G.selected].find((m) => m.chain[0] === i);
  if (mv) { doMove(G.selected, mv); return; }
  if (BORDER.includes(i) && (G.cells[i] === 0 || G.cells[i] === G.turn)) { G.selected = i; render(); }
}

// ---- CPU（ai.js を Worker で動かす） ----
const cpu = new Worker('./ai.js', { type: 'module' });
let cpuAsk = 0; // 対局をやり直したあとに、前の局の答えが届いても使わない
function maybeCpuTurn() {
  if (!G || G.winner || !isCpuTurn()) return;
  const game = G;
  const id = ++cpuAsk;
  const started = performance.now();
  cpu.onmessage = (e) => {
    if (e.data.id !== cpuAsk || G !== game) return;
    const wait = Math.max(0, 500 - (performance.now() - started));
    setTimeout(() => {
      if (G !== game) return;
      const mv = MOVES[e.data.pick].find((m) => m.code === e.data.code);
      doMove(e.data.pick, mv);
    }, wait);
  };
  cpu.postMessage({ id, cells: G.cells, turn: G.turn, timeMs: 2500 });
}

// ---- 画面 ----
function render() {
  const stage = document.getElementById('stage');
  if (!G) { stage.innerHTML = titleHTML(); bindTitle(); return; }
  stage.innerHTML = gameHTML();
  bindGame();
}

function titleHTML() {
  return `
    <div class="title">
      <h2>クイキシオ</h2>
      <p class="hint">外周のキューブを押し込んで、縦横斜めに自分の印を5つ並べたら勝ち</p>
      <button class="pill pill--big" data-start="cpu" data-side="2">CPU と対戦（先手）</button>
      <button class="pill pill--big" data-start="cpu" data-side="1">CPU と対戦（後手）</button>
      <button class="pill pill--big" data-start="2p">2人で対戦（1台で交互）</button>
    </div>`;
}
function bindTitle() {
  document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => newGame(b.dataset.start, Number(b.dataset.side) || null)));
}

function gameHTML() {
  const interactive = !G.winner && !isCpuTurn();
  let status;
  if (G.winner) status = G.winner === 'draw' ? '引き分け' : `${playerLabel(G.winner)} の勝ち！`;
  else if (isCpuTurn()) status = 'CPU 考え中…';
  else if (G.selected == null) status = `${playerLabel(G.turn)} の番：外周のキューブを選ぶ`;
  else status = `${playerLabel(G.turn)} の番：押し込む端を選ぶ`;

  const candidates = G.selected != null ? new Set(MOVES[G.selected].map((m) => m.chain[0])) : null;
  const mark = (v) => (v === 1 ? '○' : v === 2 ? '×' : '');
  const cells = Array.from({ length: 25 }, (_, i) => {
    const classes = ['cell'];
    if (G.cells[i] === 0) classes.push('cell--empty');
    if (!BORDER.includes(i)) classes.push('cell--inner');
    if (G.selected === i) classes.push('cell--selected');
    if (candidates && candidates.has(i)) classes.push('cell--candidate');
    if (G.winLine && G.winLine.includes(i)) classes.push('cell--win');
    const preview = candidates && candidates.has(i) ? mark(G.turn) : '';
    return `<button class="${classes.join(' ')}" data-cell="${i}" ${interactive ? '' : 'disabled'}>${mark(G.cells[i]) || preview}</button>`;
  }).join('');

  const again = G.winner ? `
    <div class="result">
      <button class="pill pill--big" data-again>もう一度</button>
      <button class="pill" data-title>モードを選び直す</button>
    </div>` : '';

  return `
    <div class="game">
      <p class="status">${status}</p>
      <div class="board">${cells}</div>
      <p class="hint">外周をタップ → 押し込める端をタップ</p>
      ${again}
    </div>`;
}

function bindGame() {
  document.querySelectorAll('[data-cell]').forEach((b) => b.addEventListener('click', () => clickCell(Number(b.dataset.cell))));
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame(G.mode, G.cpuSide));
  const title = document.querySelector('[data-title]');
  if (title) title.addEventListener('click', () => { G = null; render(); });
}

render();
