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

// タイトル画面に飾る、対局中の盤面（○ の番で、右上のキューブを持ち上げたところ）
const DEMO = {
  cells: [1, 0, 2, 0, 1, 0, 1, 2, 0, 0, 2, 0, 1, 0, 2, 0, 0, 2, 1, 0, 1, 2, 0, 0, 0],
  selected: 4, winLine: null,
};
const view = () => G || DEMO;

function goTitle() {
  G = null;
  animating = false;
  animGen++; // 途中の押し込みアニメーションを止める
  render();
}

function newGame(mode, cpuSide) {
  animating = false;
  animGen++;
  camera.position.set(0, 7.2, 6.7); // タイトルで回った視点を戻す
  controls.update();
  G = { mode, cpuSide, cells: Array(25).fill(0), turn: 1, selected: null, winner: null, winLine: null, history: new Map() };
  render();
  maybeCpuTurn();
}

function isCpuTurn() { return G.mode === 'watch' || (G.mode === 'cpu' && G.turn === G.cpuSide); }
function playerLabel(p) {
  if (p === 'draw') return '引き分け';
  if (G.mode === 'watch') return p === 1 ? 'CPU ○' : 'CPU ×';
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
  const game = G;
  animatePush(mv.chain, prevCells, mark, () => {
    if (G !== game) return;
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
  cpu.postMessage({ id, cells: G.cells, turn: G.turn, timeMs: G.mode === 'watch' ? 1000 : 2500 });
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
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
camera.position.set(0, 7.2, 6.7);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.minDistance = 5;
controls.maxDistance = 16;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // 盤の下にはもぐらない
controls.target.set(0, 0.3, 0);
controls.autoRotateSpeed = 0.8;
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

// ---- 机の天板。盤の下に木の板を敷き、地平線まで続ける ----
{
  const box = new THREE.Box3().setFromObject(board);
  const w = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const S = 1024, PLANK = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  ['#4b3121', '#432b1c', '#503524', '#472f1f'].forEach((col, i) => {
    for (let y = i * PLANK; y < S; y += PLANK * 4) {
      g.save();
      g.beginPath(); g.rect(0, y, S, PLANK); g.clip();
      g.fillStyle = col; g.fillRect(0, y, S, PLANK);
      for (let k = 0; k < 36; k++) { // 木目の線
        const y0 = y + Math.random() * PLANK, a = 2 + Math.random() * 4, f = 60 + Math.random() * 120;
        g.strokeStyle = `rgba(24, 12, 4, ${0.06 + Math.random() * 0.14})`;
        g.lineWidth = 0.5 + Math.random() * 2;
        g.beginPath();
        for (let x = 0; x <= S; x += 16) g.lineTo(x, y0 + a * Math.sin(x / f + k));
        g.stroke();
      }
      g.restore();
      g.fillStyle = 'rgba(0, 0, 0, 0.45)'; g.fillRect(0, y, S, 2); // 板のすき間
    }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const FAR = 1500; // 地平線まで続いて見える広さ
  tex.repeat.set(FAR / (w * 3.2), FAR / (w * 3.2));
  const table = new THREE.Mesh(new THREE.PlaneGeometry(FAR, FAR),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, envMapIntensity: 0.4 }));
  table.rotation.x = -Math.PI / 2;
  table.position.y = box.min.y - 0.01;
  table.renderOrder = -1;
  scene.add(table);
  // 盤の落とす影
  const sc = document.createElement('canvas');
  sc.width = sc.height = 256;
  const sg = sc.getContext('2d');
  const shade = sg.createRadialGradient(128, 128, 0, 128, 128, 128 * 0.48);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.55)'); shade.addColorStop(0.55, 'rgba(0, 0, 0, 0.4)'); shade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  sg.fillStyle = shade; sg.fillRect(0, 0, 256, 256);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(w * 3.2, w * 3.2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = box.min.y - 0.005;
  scene.add(shadow);
}

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

// キューブの面に印を描いた板目テクスチャ（無地 / ○ / ×）
function markCanvas(mark) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.drawImage(GRAIN_CANVAS, 0, 0);
  if (mark) {
    g.lineWidth = 26;
    g.lineCap = 'round';
    g.strokeStyle = mark === 1 ? '#b3261e' : '#2a1c12'; // ○=朱、×=焦げ茶（どちらも明るい木目の上で目立つ色）
    if (mark === 1) { g.beginPath(); g.arc(128, 128, 72, 0, Math.PI * 2); g.stroke(); }
    else { g.beginPath(); g.moveTo(70, 70); g.lineTo(186, 186); g.moveTo(186, 70); g.lineTo(70, 186); g.stroke(); }
  }
  return c;
}
// 実物と同じく、1 個のキューブに ○ と × が向かい合わせに 1 面ずつ、残り 4 面は無地
const FACE_MAT = [0, 1, 2].map((m) => wood(0xd8b887, { map: texFrom(markCanvas(m)), clearcoat: 0.5 }));
const CUBE_MAT = [FACE_MAT[0], FACE_MAT[0], FACE_MAT[1], FACE_MAT[2], FACE_MAT[0], FACE_MAT[0]]; // BoxGeometry の面順: +x -x +y -y +z -z
// どの面を上に向けるか（x 軸まわりの回転）: 無地＝横に倒す / ○＝そのまま / ×＝逆さ
const TILT = [Math.PI / 2, 0, Math.PI];

const CUBE_SIZE = 1; // マスの間隔（1）と同じにして、隣どうしをすき間なく並べる
const CUBE_GEO = new RoundedBoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE, 3, 0.06);
const cubeMeshes = cellPos.map((p, i) => {
  const m = new THREE.Mesh(CUBE_GEO, CUBE_MAT);
  m.rotation.x = TILT[0];
  m.position.set(p.x, CUBE_SIZE / 2, p.z);
  m.userData.cell = i;
  scene.add(m);
  return m;
});

// 選んだキューブは浮かせてゆらす。勝った並びは波のように跳ねる。動いている間だけ毎フレーム描く
const BASE_Y = CUBE_SIZE / 2;
let liftCell = null;
let winAt = 0;
let raf = 0;
function cubeTargetY(i, t) {
  const V = view();
  if (V.winLine && V.winLine.includes(i)) {
    const k = V.winLine.indexOf(i);
    return BASE_Y + 0.35 * Math.max(0, Math.sin((t - winAt) / 160 - k * 0.6));
  }
  if (i === liftCell) return BASE_Y + 0.5 + 0.05 * Math.sin(t / 220);
  return BASE_Y;
}
function loop() {
  raf = 0;
  const V = view();
  const t = performance.now();
  if (!G) controls.update(); // タイトルではゆっくり回し続ける
  let moving = !G || liftCell != null || !!V.winLine;
  cubeMeshes.forEach((m, i) => {
    const y = cubeTargetY(i, t);
    m.position.y += (y - m.position.y) * (V.winLine ? 1 : 0.22);
    m.rotation.z = i === liftCell ? 0.06 * Math.sin(t / 300) : 0;
    if (Math.abs(y - m.position.y) > 0.002) moving = true;
  });
  draw();
  if (moving) raf = requestAnimationFrame(loop);
}
function kick() { if (!raf) raf = requestAnimationFrame(loop); }

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

// 押し込みアニメーション:
// 1) 取ったキューブを持ち上げ、入れる端の外まで運ぶ。無地なら 90° 倒して自分の印を上に向ける
// 2) 鎖に沿って全部を 1 マスずつずらす（少し行き過ぎて戻る）
// 途中で animGen が変わったら（ホームに戻った・やり直した）、片付けて done を呼ばずに止める
let animGen = 0;
function animatePush(chain, prevCells, mark, done) {
  const gen = animGen;
  const L = chain.length;
  const pick = chain[L - 1];
  const dir = cellPos[chain[0]].clone().sub(cellPos[chain[1]]).normalize(); // chain は常に長さ 2 以上
  const entryFrom = cellPos[chain[0]].clone().addScaledVector(dir, 1);
  entryFrom.y = BASE_Y;

  const flyer = new THREE.Mesh(CUBE_GEO, CUBE_MAT);
  const tiltFrom = TILT[prevCells[pick]], tiltTo = TILT[mark];
  flyer.rotation.x = tiltFrom;
  const start = cubeMeshes[pick].position.clone();
  flyer.position.copy(start);
  scene.add(flyer);
  cubeMeshes[pick].visible = false;

  const movers = [];
  for (let k = 1; k < L; k++) {
    const mesh = new THREE.Mesh(CUBE_GEO, CUBE_MAT);
    mesh.rotation.x = TILT[prevCells[chain[k - 1]]];
    movers.push({ mesh, from: cellPos[chain[k - 1]], to: cellPos[chain[k]] });
  }

  const FLY = 560, PUSH = 320;
  const t0 = performance.now();
  let pushing = false;
  function cleanup() {
    scene.remove(flyer);
    movers.forEach((mv) => scene.remove(mv.mesh));
    chain.forEach((i) => { cubeMeshes[i].visible = true; cubeMeshes[i].position.y = BASE_Y; cubeMeshes[i].rotation.z = 0; });
  }
  function step() {
    if (gen !== animGen) { cleanup(); draw(); return; }
    const el = performance.now() - t0;
    if (el < FLY) {
      const t = el / FLY, e = easeInOut(t);
      flyer.position.lerpVectors(start, entryFrom, e);
      flyer.position.y = start.y + (BASE_Y - start.y) * e + 1.3 * Math.sin(Math.PI * e);
      flyer.rotation.x = tiltFrom + (tiltTo - tiltFrom) * e;
      draw();
      requestAnimationFrame(step);
      return;
    }
    if (!pushing) {
      pushing = true;
      flyer.rotation.x = tiltTo;
      movers.push({ mesh: flyer, from: entryFrom, to: cellPos[chain[0]] });
      movers.forEach((mv) => { if (mv.mesh !== flyer) scene.add(mv.mesh); });
      chain.forEach((i) => { cubeMeshes[i].visible = false; });
    }
    const t = Math.min(1, (el - FLY) / PUSH), e = easeOutBack(t);
    movers.forEach((mv) => { mv.mesh.position.lerpVectors(mv.from, mv.to, e); mv.mesh.position.y = BASE_Y; });
    draw();
    if (t < 1) { requestAnimationFrame(step); return; }
    cleanup();
    done();
  }
  requestAnimationFrame(step);
}

function syncScene() {
  const V = view();
  controls.autoRotate = !G;
  const candidates = V.selected != null ? new Set(MOVES[V.selected].map((m) => m.chain[0])) : null;
  cubeMeshes.forEach((m, i) => { m.rotation.x = TILT[V.cells[i]]; });
  liftCell = animating ? null : V.selected;
  if (V.winLine && !winAt) winAt = performance.now();
  if (!V.winLine) winAt = 0;
  socketMeshes.forEach((s, i) => {
    let color = BORDER.includes(i) ? CELL_COLOR.border : CELL_COLOR.inner;
    if (V.winLine && V.winLine.includes(i)) color = CELL_COLOR.win;
    else if (V.selected === i) color = CELL_COLOR.selected;
    else if (candidates && candidates.has(i)) color = CELL_COLOR.candidate;
    s.material.color.setHex(color);
  });
  draw();
  kick();
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
  stage.innerHTML = G ? gameHTML() : titleHTML();
  document.getElementById('board3d').appendChild(canvas);
  syncScene();
  if (G) bindGame(); else bindTitle();
}

// ---- ルール欄の図（インライン SVG。ゲーム本体と同じ色: ○=朱 #b3261e、×=焦げ茶 #2a1c12） ----
const DIAG_CELL = 34, DIAG_GAP = 2, DIAG_PAD = 4;
const DIAG_FILL = '#d8b887', DIAG_FILL_HI = '#f0d9ab';
function diagXY(i) { const r = Math.floor(i / 5), c = i % 5; return [DIAG_PAD + c * (DIAG_CELL + DIAG_GAP), DIAG_PAD + r * (DIAG_CELL + DIAG_GAP)]; }
function diagMark(cx, cy, v) {
  if (v === 1) return `<circle cx="${cx}" cy="${cy}" r="10" fill="none" stroke="#b3261e" stroke-width="3.5"/>`;
  if (v === 2) { const d = 7; return `<path d="M${cx - d} ${cy - d} L${cx + d} ${cy + d} M${cx + d} ${cy - d} L${cx - d} ${cy + d}" stroke="#2a1c12" stroke-width="3.5" stroke-linecap="round"/>`; }
  return '';
}
// cells: 長さ25の配列（0=無地 1=○ 2=×）。opts.hi: 薄く強調するマスの番号。opts.badge: {i, ok} で ✓/✕ の小さな印。opts.line: 強調する並び（番号の配列）
function diagBoard(cells, opts = {}) {
  const side = DIAG_PAD * 2 + 5 * DIAG_CELL + 4 * DIAG_GAP;
  let rects = '', marks = '', badges = '';
  for (let i = 0; i < 25; i++) {
    const [x, y] = diagXY(i);
    rects += `<rect x="${x}" y="${y}" width="${DIAG_CELL}" height="${DIAG_CELL}" rx="4" fill="${(opts.hi || []).includes(i) ? DIAG_FILL_HI : DIAG_FILL}"/>`;
    marks += diagMark(x + DIAG_CELL / 2, y + DIAG_CELL / 2, cells[i]);
  }
  (opts.badge || []).forEach(({ i, ok }) => {
    const [x, y] = diagXY(i);
    const bx = x + DIAG_CELL - 3, by = y + 3;
    badges += `<circle cx="${bx}" cy="${by}" r="7" fill="${ok ? '#3a8f4a' : '#8a2f22'}"/>`;
    badges += ok
      ? `<path d="M${bx - 3.2} ${by} l2.2 2.4 l4.2 -5" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M${bx - 2.6} ${by - 2.6} L${bx + 2.6} ${by + 2.6} M${bx + 2.6} ${by - 2.6} L${bx - 2.6} ${by + 2.6}" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`;
  });
  let line = '';
  if (opts.line) {
    const pts = opts.line.map((i) => { const [x, y] = diagXY(i); return `${x + DIAG_CELL / 2},${y + DIAG_CELL / 2}`; }).join(' ');
    line = `<polyline points="${pts}" fill="none" stroke="${opts.lineColor || 'var(--accent)'}" stroke-width="3" stroke-linecap="round" opacity="0.85"/>`;
  }
  return `<svg class="diagram" viewBox="0 0 ${side} ${side}" width="${side}" height="${side}">${rects}${line}${marks}${badges}</svg>`;
}
// 1 行だけの図（押し込みの前後に使う。幅は盤と揃える）
function diagRow(vals) {
  const side = DIAG_PAD * 2 + 5 * DIAG_CELL + 4 * DIAG_GAP;
  let rects = '', marks = '';
  vals.forEach((v, c) => {
    const x = DIAG_PAD + c * (DIAG_CELL + DIAG_GAP), y = DIAG_PAD;
    rects += `<rect x="${x}" y="${y}" width="${DIAG_CELL}" height="${DIAG_CELL}" rx="4" fill="${DIAG_FILL}"/>`;
    marks += diagMark(x + DIAG_CELL / 2, y + DIAG_CELL / 2, v);
  });
  const h = DIAG_PAD * 2 + DIAG_CELL;
  return `<svg class="diagram diagram--row" viewBox="0 0 ${side} ${h}" width="${side}" height="${h}">${rects}${marks}</svg>`;
}
function emptyCells() { return new Array(25).fill(0); }

const DIAG_INIT = diagBoard(emptyCells(), { hi: BORDER });
const DIAG_TAKE = diagBoard(
  (() => { const c = emptyCells(); c[0] = 1; c[4] = 2; c[2] = 2; return c; })(),
  { badge: [{ i: 0, ok: true }, { i: 1, ok: true }, { i: 2, ok: false }, { i: 4, ok: false }] },
);
const DIAG_PUSH_BEFORE = diagRow([1, 0, 2, 0, 0]);
const DIAG_PUSH_AFTER = diagRow([0, 2, 0, 0, 1]);
const DIAG_WIN = diagBoard(
  (() => { const c = emptyCells(); [0, 6, 12, 18, 24].forEach((i) => { c[i] = 1; }); return c; })(),
  { line: [0, 6, 12, 18, 24] },
);
const DIAG_LOSE = diagBoard(
  (() => { const c = emptyCells(); [20, 21, 22, 23, 24].forEach((i) => { c[i] = 2; }); c[0] = 1; c[6] = 1; c[12] = 1; return c; })(),
  { line: [20, 21, 22, 23, 24], lineColor: '#e05a3a' },
);

function titleHTML() {
  return `
    <div class="title">
      <h2>クイキシオ</h2>
      <p class="hint">外周のキューブを押し込んで、縦横斜めに自分の印を5つ並べたら勝ち</p>
      <div class="board3d board3d--title" id="board3d"></div>
      <button class="pill pill--big" data-start="cpu" data-side="2">CPU と対戦（先手）</button>
      <button class="pill pill--big" data-start="cpu" data-side="1">CPU と対戦（後手）</button>
      <button class="pill pill--big" data-start="2p">2人で対戦（1台で交互）</button>
      <button class="pill pill--big" data-start="watch">CPU 同士の対戦を見る</button>
      <details class="rules">
        <summary>ルール</summary>
        <ol>
          <li>5×5 の盤に 25 個のキューブ。はじめは全部無地。先手が ○、後手が ×。${DIAG_INIT}</li>
          <li>自分の番に、外周のキューブを 1 個取る。取れるのは無地か自分の印のものだけ（相手の印は取れない）。${DIAG_TAKE}</li>
          <li>取ったキューブを自分の印にして、同じ行か列の端から押し込む。間のキューブが 1 個ずつずれる。取った場所と同じ端からは入れられない。${DIAG_PUSH_BEFORE}<div class="diagram-arrow">↓</div>${DIAG_PUSH_AFTER}</li>
          <li>縦・横・斜めのどれかに自分の印が 5 つ並んだら勝ち。${DIAG_WIN}</li>
          <li>押し込んで相手の印が 5 つ並んだら、自分の印も同時に並んでいても負け。${DIAG_LOSE}</li>
          <li>同じ盤面が 3 回出たら引き分け。</li>
        </ol>
      </details>
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
    </div>` : '';

  return `
    <div class="game">
      <div class="game__top">
        <button class="pill" data-title>← ホーム</button>
        <p class="status">${status}</p>
      </div>
      <div class="board3d" id="board3d"></div>
      <p class="hint">${G.mode === 'watch' ? 'ドラッグで回す・ピンチで寄る' : '外周をタップ → 押し込める端をタップ・ドラッグで回す・ピンチで寄る'}</p>
      ${again}
    </div>`;
}

function bindGame() {
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame(G.mode, G.cpuSide));
  document.querySelector('[data-title]').addEventListener('click', goTitle);
}

render();
