import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

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
let animating = false; // 押し込みアニメーション中は操作を受け付けない

function newGame(mode, cpuSide) {
  animating = false;
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

// 押し込みを決めたら、まず 3D アニメーションで見せてから盤面を確定する
function doMove(pick, mv) {
  animating = true;
  G.selected = null;
  render();
  const prevCells = G.cells.slice();
  const mark = G.turn;
  animatePush(mv.chain, prevCells, mark, () => {
    applyMove(G.cells, mv.chain, mark);
    animating = false;
    const other = mark === 1 ? 2 : 1;
    if (hasLine(G.cells, other)) {
      // 自分の印と同時に揃っても、相手の印が揃った時点で手番側の負け
      G.winner = other; G.winLine = findLine(G.cells, other);
    } else if (hasLine(G.cells, mark)) {
      G.winner = mark; G.winLine = findLine(G.cells, mark);
    } else {
      const key = G.cells.join('') + ':' + other;
      const count = (G.history.get(key) || 0) + 1;
      G.history.set(key, count);
      if (count >= 3) G.winner = 'draw';
      else G.turn = other;
    }
    render();
    maybeCpuTurn();
  });
}

function clickCell(i) {
  if (!G || G.winner || isCpuTurn() || animating) return;
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

// ---- 3D の盤（three.js）。ドラッグで回す、ピンチで寄る ----
const canvas = document.createElement('canvas');
canvas.className = 'board3d__canvas';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0, 7.2, 6.7);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.minDistance = 5;
controls.maxDistance = 16;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // 盤の下にはもぐらない
controls.target.set(0, 0.3, 0);
controls.update();
controls.addEventListener('change', draw);

// 影は付けない。環境光（RoomEnvironment）と弱い向きの光で質感を出す
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a2e24, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 8, 4);
scene.add(sun);

// 木目（灰色の濃淡）。色はマテリアルの color で付ける。上下・左右につながるように周期を整数にする
function woodCanvas() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = (y + 9 * Math.sin((2 * Math.PI * x) / S * 2) + 3 * Math.sin((2 * Math.PI * x) / S * 7)) / S;
      const ring = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * t * 14), 6);
      const v = 255 * (0.9 - 0.16 * ring + (Math.random() - 0.5) * 0.05);
      const p = (y * S + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
function texFrom(c) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
const GRAIN_CANVAS = woodCanvas();
const GRAIN = texFrom(GRAIN_CANVAS);
const wood = (color, o = {}) => new THREE.MeshPhysicalMaterial({
  color, map: GRAIN, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.7, side: THREE.DoubleSide, ...o,
});

const board = new THREE.Mesh(new RoundedBoxGeometry(5.8, 0.36, 5.8, 4, 0.14), wood(0x6a4329, { clearcoat: 0.5 }));
board.position.y = -0.18;
scene.add(board);

// 25 マスの位置（spacing=1、中心が原点）
const cellPos = Array.from({ length: 25 }, (_, i) => new THREE.Vector3((i % 5) - 2, 0, Math.floor(i / 5) - 2));

// 角を丸めた四角（groove の外枠・穴あきの輪・ソケットに使う）
function roundRect(half, r) {
  const s = new THREE.Shape();
  s.moveTo(-half + r, -half);
  s.lineTo(half - r, -half); s.quadraticCurveTo(half, -half, half, -half + r);
  s.lineTo(half, half - r); s.quadraticCurveTo(half, half, half - r, half);
  s.lineTo(-half + r, half); s.quadraticCurveTo(-half, half, -half, half - r);
  s.lineTo(-half, -half + r); s.quadraticCurveTo(-half, -half, -half + r, -half);
  return s;
}
const SOCKET_HALF = 0.42, RING_HALF = 0.49;
const socketGeo = new THREE.ShapeGeometry(roundRect(SOCKET_HALF, 0.08), 4);
socketGeo.rotateX(-Math.PI / 2);
const ringShape = roundRect(RING_HALF, 0.1);
ringShape.holes.push(roundRect(SOCKET_HALF, 0.08));
const ringGeo = new THREE.ShapeGeometry(ringShape, 4);
ringGeo.rotateX(-Math.PI / 2);
const GROOVE = new THREE.MeshStandardMaterial({ color: 0x24160d, roughness: 0.9 });

const CELL_COLOR = { inner: 0x3a2518, border: 0x4a2e1c, selected: 0xffd35c, candidate: 0xb08a3a, win: 0xffd35c };
const socketMeshes = cellPos.map((p, i) => {
  const s = new THREE.Mesh(socketGeo, wood(CELL_COLOR.border, { roughness: 0.7, clearcoat: 0 }));
  s.position.set(p.x, 0.004, p.z);
  s.userData.cell = i;
  const ring = new THREE.Mesh(ringGeo, GROOVE);
  ring.position.set(p.x, 0.003, p.z);
  scene.add(s, ring);
  return s;
});

// キューブの上面に印を描いた板目テクスチャ（無地 / ○ / ×）
function markCanvas(mark) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.drawImage(GRAIN_CANVAS, 0, 0);
  if (mark) {
    g.lineWidth = 26;
    g.lineCap = 'round';
    g.strokeStyle = mark === 1 ? '#f3e6c8' : '#2a1c12'; // ○=明るい彫り、×=暗い彫り
    if (mark === 1) { g.beginPath(); g.arc(128, 128, 72, 0, Math.PI * 2); g.stroke(); }
    else { g.beginPath(); g.moveTo(70, 70); g.lineTo(186, 186); g.moveTo(186, 70); g.lineTo(70, 186); g.stroke(); }
  }
  return c;
}
const TOP_MAT = [0, 1, 2].map((m) => wood(0xd8b887, { map: texFrom(markCanvas(m)), clearcoat: 0.5 }));
const SIDE_MAT = wood(0xb08a52, { clearcoat: 0.3 });
const CUBE_MATS = [0, 1, 2].map((m) => [SIDE_MAT, SIDE_MAT, TOP_MAT[m], SIDE_MAT, SIDE_MAT, SIDE_MAT]); // BoxGeometry の面順: +x -x +y -y +z -z

const CUBE_GEO = new RoundedBoxGeometry(0.72, 0.5, 0.72, 3, 0.06);
const cubeMeshes = cellPos.map((p, i) => {
  const m = new THREE.Mesh(CUBE_GEO, CUBE_MATS[0]);
  m.position.set(p.x, 0.25, p.z);
  m.userData.cell = i;
  scene.add(m);
  return m;
});

// 押し込みアニメーション: 鎖に沿ってキューブを 1 つずつずらし、新しいキューブを外から入れる
function animatePush(chain, prevCells, mark, done) {
  const L = chain.length;
  const movers = [];
  for (let k = 1; k < L; k++) {
    movers.push({ mesh: new THREE.Mesh(CUBE_GEO, CUBE_MATS[prevCells[chain[k - 1]]]), from: cellPos[chain[k - 1]], to: cellPos[chain[k]] });
  }
  const dir = cellPos[chain[0]].clone().sub(cellPos[chain[1]]).normalize(); // chain は常に長さ 2 以上
  const entryFrom = cellPos[chain[0]].clone().addScaledVector(dir, 1);
  movers.push({ mesh: new THREE.Mesh(CUBE_GEO, CUBE_MATS[mark]), from: entryFrom, to: cellPos[chain[0]] });
  movers.forEach((mv) => { mv.mesh.position.copy(mv.from); mv.mesh.position.y = 0.25; scene.add(mv.mesh); });
  chain.forEach((i) => { cubeMeshes[i].visible = false; });

  const DUR = 260;
  const t0 = performance.now();
  function step() {
    const t = Math.min(1, (performance.now() - t0) / DUR);
    const e = 1 - Math.pow(1 - t, 3); // ease out
    movers.forEach((mv) => { mv.mesh.position.lerpVectors(mv.from, mv.to, e); mv.mesh.position.y = 0.25; });
    draw();
    if (t < 1) { requestAnimationFrame(step); return; }
    movers.forEach((mv) => scene.remove(mv.mesh));
    chain.forEach((i) => { cubeMeshes[i].visible = true; });
    done();
  }
  requestAnimationFrame(step);
}

function syncScene() {
  const candidates = G.selected != null ? new Set(MOVES[G.selected].map((m) => m.chain[0])) : null;
  cubeMeshes.forEach((m, i) => { m.material = CUBE_MATS[G.cells[i]]; });
  socketMeshes.forEach((s, i) => {
    let color = BORDER.includes(i) ? CELL_COLOR.border : CELL_COLOR.inner;
    if (G.winLine && G.winLine.includes(i)) color = CELL_COLOR.win;
    else if (G.selected === i) color = CELL_COLOR.selected;
    else if (candidates && candidates.has(i)) color = CELL_COLOR.candidate;
    s.material.color.setHex(color);
  });
  draw();
}

function draw() { renderer.render(scene, camera); }
new ResizeObserver(() => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // 縦長の画面でも盤の横が切れないように、縦の画角を広げる
  camera.fov = w < h ? (2 * Math.atan(Math.tan((19 * Math.PI) / 180) * (h / w)) * 180) / Math.PI : 38;
  camera.updateProjectionMatrix();
  draw();
}).observe(canvas);

// 動かさずに離したらタップ（ドラッグは回転）
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  downAt = null;
  if (!G || G.winner || isCpuTurn() || animating) return;
  const r = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects([...cubeMeshes, ...socketMeshes], true)[0];
  if (hit) clickCell(hit.object.userData.cell);
});

// ---- 画面 ----
function render() {
  const stage = document.getElementById('stage');
  if (!G) { stage.innerHTML = titleHTML(); bindTitle(); return; }
  stage.innerHTML = gameHTML();
  document.getElementById('board3d').appendChild(canvas);
  syncScene();
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
  let status;
  if (G.winner) status = G.winner === 'draw' ? '引き分け' : `${playerLabel(G.winner)} の勝ち！`;
  else if (animating) status = '押し込み中…';
  else if (isCpuTurn()) status = 'CPU 考え中…';
  else if (G.selected == null) status = `${playerLabel(G.turn)} の番：外周のキューブを選ぶ`;
  else status = `${playerLabel(G.turn)} の番：押し込む端を選ぶ`;

  const again = G.winner ? `
    <div class="result">
      <button class="pill pill--big" data-again>もう一度</button>
      <button class="pill" data-title>モードを選び直す</button>
    </div>` : '';

  return `
    <div class="game">
      <p class="status">${status}</p>
      <div class="board3d" id="board3d"></div>
      <p class="hint">外周をタップ → 押し込める端をタップ・ドラッグで回す・ピンチで寄る</p>
      ${again}
    </div>`;
}

function bindGame() {
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame(G.mode, G.cpuSide));
  const title = document.querySelector('[data-title]');
  if (title) title.addEventListener('click', () => { G = null; render(); });
}

render();
