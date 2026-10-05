// クイキシオの CPU（Web Worker）。盤をビットボード（own/opp の 25 ビット整数）で持ち、
// ネガマックス＋αβ＋反復深化＋置換表で、時間いっぱい深く読む。
//
// own/opp は「次に手を指す側」から見た盤（own=自分の印、opp=相手の印）。
// 1 手ごとに own と opp を入れ替えて再帰するので、評価値はつねに「次に指す側」から見た値。

const IDX = (r, c) => r * 5 + c;
const BORDER = [];
for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (r === 0 || r === 4 || c === 0 || c === 4) BORDER.push(IDX(r, c));

const CODE = { top: 0, bottom: 1, left: 2, right: 3 };
const MOVES = {}; // pick → [{code, chain}]。chain[0] が entry（新しい印の入る端）、以降は取った場所までの道のり
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
for (let r = 0; r < 5; r++) { let m = 0; for (let c = 0; c < 5; c++) m |= 1 << IDX(r, c); LINES.push(m); }
for (let c = 0; c < 5; c++) { let m = 0; for (let r = 0; r < 5; r++) m |= 1 << IDX(r, c); LINES.push(m); }
{ let m = 0; for (let i = 0; i < 5; i++) m |= 1 << IDX(i, i); LINES.push(m); }
{ let m = 0; for (let i = 0; i < 5; i++) m |= 1 << IDX(i, 4 - i); LINES.push(m); }

function hasLine(bb) { return LINES.some((m) => (bb & m) === m); }

// own/opp はどちらも「取った場所に opp の印があってはいけない」の制約だけで列挙する
function generateMoves(own, opp) {
  const moves = [];
  for (const pick of BORDER) {
    if (opp & (1 << pick)) continue;
    for (const mv of MOVES[pick]) moves.push({ pick, code: mv.code, chain: mv.chain });
  }
  return moves;
}

// chain[0]（entry）に自分の印を入れ、残りは 1 つ前の古い値を引き継ぐ（＝ずらす）。own/opp は読み取りのみ。
function applyMove(own, opp, chain) {
  let newOwn = own, newOpp = opp;
  for (const i of chain) { const bit = 1 << i; newOwn &= ~bit; newOpp &= ~bit; }
  for (let k = chain.length - 1; k >= 1; k--) {
    const dst = 1 << chain[k], src = 1 << chain[k - 1];
    if (own & src) newOwn |= dst;
    else if (opp & src) newOpp |= dst;
  }
  newOwn |= 1 << chain[0];
  return [newOwn, newOpp];
}

function popcount(x) {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

// 中央ほど高い重み（中心=2、中段=1、外周=0）
const CENTER_W = Array.from({ length: 25 }, (_, i) => {
  const r = Math.floor(i / 5), c = i % 5;
  return 2 - Math.max(Math.abs(r - 2), Math.abs(c - 2));
});
const LINE_W = [0, 1, 4, 12, 40]; // そのラインに own/opp だけが何個あるか（相手の印が混ざっていれば 0）

// own 視点の評価値（5 個揃いはここに来る前に検出済みなので、ラインは最大 4 個まで）
function evaluate(own, opp) {
  let score = 0;
  for (const m of LINES) {
    const o = own & m, e = opp & m;
    if (o && e) continue;
    if (o) score += LINE_W[popcount(o)];
    else if (e) score -= LINE_W[popcount(e)];
  }
  for (let i = 0; i < 25; i++) {
    const bit = 1 << i;
    if (own & bit) score += CENTER_W[i];
    else if (opp & bit) score -= CENTER_W[i];
  }
  return score;
}

const WIN = 100000;
const TIMEOUT = {};

export function bestMove(cells, turn, timeMs = 2500) {
  let own = 0, opp = 0;
  for (let i = 0; i < 25; i++) {
    if (cells[i] === turn) own |= 1 << i;
    else if (cells[i]) opp |= 1 << i;
  }

  const tt = new Map(); // key(own,opp) → { depth, value, flag(0 正確/1 下限/2 上限), pick, code }
  const history = new Map(); // pick*4+code → ヒストリー値（βカットで加点、手の並べ替えに使う）
  const deadline = performance.now() + timeMs;
  let nodes = 0;
  const key = (o, e) => o * 33554432 + e; // own/opp はどちらも 25 ビット未満なので衝突しない完全なキー

  function order(moves, ttPick, ttCode) {
    moves.sort((a, b) => {
      const at = a.pick === ttPick && a.code === ttCode ? 1 : 0;
      const bt = b.pick === ttPick && b.code === ttCode ? 1 : 0;
      if (at !== bt) return bt - at;
      const ah = history.get(a.pick * 4 + a.code) || 0, bh = history.get(b.pick * 4 + b.code) || 0;
      return bh - ah;
    });
    return moves;
  }

  function search(own, opp, depth, alpha, beta, ply) {
    if ((++nodes & 1023) === 0 && performance.now() > deadline) throw TIMEOUT;
    if (depth === 0) return evaluate(own, opp);

    const k = key(own, opp);
    const e = tt.get(k);
    let ttPick = -1, ttCode = -1;
    if (e) {
      if (e.depth >= depth) {
        if (e.flag === 0) return e.value;
        if (e.flag === 1 && e.value >= beta) return e.value;
        if (e.flag === 2 && e.value <= alpha) return e.value;
      }
      ttPick = e.pick; ttCode = e.code;
    }

    const moves = order(generateMoves(own, opp), ttPick, ttCode);
    if (!moves.length) return -WIN + ply; // 取れるキューブがない（規約上まず起きないが、起きたら負け扱い）

    const a0 = alpha;
    let best = -Infinity, bp = -1, bc = -1;
    for (const mv of moves) {
      const [newOwn, newOpp] = applyMove(own, opp, mv.chain);
      let v;
      if (hasLine(newOpp)) v = -(WIN - ply - 1); // 相手の列ができた → 同時に自分の列ができていても手番側の負け
      else if (hasLine(newOwn)) v = WIN - ply - 1;
      else v = -search(newOpp, newOwn, depth - 1, -beta, -alpha, ply + 1);
      if (v > best) { best = v; bp = mv.pick; bc = mv.code; }
      if (v > alpha) alpha = v;
      if (alpha >= beta) {
        const hk = mv.pick * 4 + mv.code;
        history.set(hk, (history.get(hk) || 0) + depth * depth);
        break;
      }
    }
    tt.set(k, { depth, value: best, flag: best <= a0 ? 2 : best >= beta ? 1 : 0, pick: bp, code: bc });
    return best;
  }

  const rootMoves = generateMoves(own, opp);
  if (!rootMoves.length) return null; // 打つ手がない（規約上ほぼ起きない）

  let move = { pick: rootMoves[0].pick, code: rootMoves[0].code, depth: 0, value: 0 };
  for (let depth = 1; depth <= 40; depth++) {
    try {
      const v = search(own, opp, depth, -Infinity, Infinity, 0);
      const e = tt.get(key(own, opp));
      move = { pick: e.pick, code: e.code, value: v, depth };
      if (Math.abs(v) >= WIN - 50) break; // 勝ち負けが読み切れた
    } catch (err) {
      if (err !== TIMEOUT) throw err;
      break;
    }
  }
  return move;
}

if (typeof WorkerGlobalScope !== 'undefined') {
  self.onmessage = (e) => self.postMessage({ id: e.data.id, ...bestMove(e.data.cells, e.data.turn, e.data.timeMs) });
}
