// 一筆書き生成のコアアルゴリズム（ブラウザ / Web Worker / Node で共通）
//
// 画像 → 濃淡マップ → 描くべき点のサンプリング → 巡回セールスマン問題の近似解
// （最近傍法 + 2-opt）で全点を1本の線でつなぐ → 最も長い区間を切って開いた線にする。

/**
 * @typedef {{ width: number, height: number, data: Uint8ClampedArray }} RGBAImage
 * @typedef {{
 *   mode?: 'edges' | 'lines' | 'shade',
 *   maxPoints?: number,
 *   threshold?: number,   // 0..1 大きいほど弱い線を無視
 *   spacing?: number | 'auto', // 点同士の最小間隔（px）。auto なら点数が maxPoints に近づくよう調整
 *   invert?: 'auto' | boolean,
 *   optimizeMs?: number,  // 2-opt に使う時間
 *   noCross?: boolean,    // 線同士が交差しないように仕上げる
 *   seed?: number,
 *   onProgress?: (stage: string, ratio: number) => void,
 * }} Options
 */

export const DEFAULTS = {
  mode: 'edges',
  maxPoints: 2500,
  threshold: 0.25,
  spacing: 'auto',
  invert: 'auto',
  optimizeMs: 1500,
  noCross: true,
  seed: 1,
};

/**
 * @param {RGBAImage} img
 * @param {Options} options
 * @returns {{ points: Float32Array, count: number, width: number, height: number, length: number }}
 */
export function generateOneStroke(img, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const progress = opt.onProgress || (() => {});
  const { width, height } = img;

  progress('analyze', 0);
  const ink = toInk(img, opt.invert);
  const weight = weightMap(ink, width, height, opt.mode, opt.threshold);

  progress('sample', 0);
  const pts = opt.spacing === 'auto'
    ? sampleAuto(weight, width, height, opt)
    : samplePoints(weight, width, height, opt);
  const n = pts.length / 2;
  if (n < 2) {
    return { points: pts, count: n, width, height, length: 0 };
  }

  progress('route', 0);
  const knn = buildNeighbors(pts, 10);
  let tour = nearestNeighborTour(pts);
  progress('route', 0.2);
  twoOpt(pts, tour, knn, opt.optimizeMs, (r) => progress('route', 0.2 + 0.8 * r));
  tour = openAtLongestEdge(pts, tour);

  let ordered = reorder(pts, tour);
  if (opt.mode !== 'shade') relax(ordered, n);
  if (opt.noCross) {
    // 平滑化で点が動いた後の最終的な座標で交差を解消する
    progress('uncross', 0);
    const order = Int32Array.from({ length: n }, (_, i) => i);
    uncross(ordered, order);
    ordered = reorder(ordered, order);
  }
  let length = 0;
  for (let i = 1; i < n; i++) length += Math.hypot(ordered[i * 2] - ordered[i * 2 - 2], ordered[i * 2 + 1] - ordered[i * 2 - 1]);
  progress('done', 1);
  return { points: ordered, count: n, width, height, length };
}

function reorder(p, tour) {
  const out = new Float32Array(tour.length * 2);
  for (let i = 0; i < tour.length; i++) {
    out[i * 2] = p[tour[i] * 2];
    out[i * 2 + 1] = p[tour[i] * 2 + 1];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 画像解析

/** RGBA → 「インクの濃さ」(0=紙, 1=インク)。背景が暗ければ自動で反転する。 */
export function toInk(img, invert = 'auto') {
  const { width, height, data } = img;
  const ink = new Float32Array(width * height);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    // 透明部分は白い紙として扱う
    const lum = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
    ink[i] = 1 - (lum * a + (1 - a));
  }
  let doInvert = invert === true;
  if (invert === 'auto') {
    // 画像の外周が暗い＝暗い背景とみなす
    let sum = 0, cnt = 0;
    for (let x = 0; x < width; x++) { sum += ink[x] + ink[(height - 1) * width + x]; cnt += 2; }
    for (let y = 0; y < height; y++) { sum += ink[y * width] + ink[y * width + width - 1]; cnt += 2; }
    doInvert = sum / cnt > 0.5;
  }
  if (doInvert) for (let i = 0; i < ink.length; i++) ink[i] = 1 - ink[i];
  return ink;
}

function blur(src, w, h) {
  // 3x3 ガウシアン近似（[1 2 1] の分離フィルタ）
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = src[y * w + Math.max(0, x - 1)], c = src[y * w + x], r = src[y * w + Math.min(w - 1, x + 1)];
      tmp[y * w + x] = (l + 2 * c + r) / 4;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w, dn = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) out[y * w + x] = (tmp[up + x] + 2 * tmp[y * w + x] + tmp[dn + x]) / 4;
  }
  return out;
}

/** Sobel + 非最大値抑制で細い輪郭線の強度を得る（0..1）。 */
export function edgeMap(ink, w, h) {
  const g = blur(blur(ink, w, h), w, h);
  const mag = new Float32Array(w * h);
  const dir = new Uint8Array(w * h);
  let max = 1e-6;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
      const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      const m = Math.hypot(gx, gy);
      mag[i] = m;
      if (m > max) max = m;
      // 勾配方向を 0°,45°,90°,135° に量子化
      let a = Math.atan2(gy, gx) * 180 / Math.PI;
      if (a < 0) a += 180;
      dir[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, m = mag[i];
      let a, b;
      switch (dir[i]) {
        case 0: a = mag[i - 1]; b = mag[i + 1]; break;
        case 1: a = mag[i - w - 1]; b = mag[i + w + 1]; break;
        case 2: a = mag[i - w]; b = mag[i + w]; break;
        default: a = mag[i - w + 1]; b = mag[i + w - 1];
      }
      if (m >= a && m >= b) out[i] = m / max;
    }
  }
  return out;
}

/** モードごとに「その画素に点を置く確率」(0..1) を返す。 */
export function weightMap(ink, w, h, mode, threshold) {
  const out = new Float32Array(w * h);
  if (mode === 'edges') {
    const e = edgeMap(ink, w, h);
    // しきい値 0..1 をエッジ強度 0.02..0.5 に対応づける
    const t = 0.02 + threshold * 0.48;
    for (let i = 0; i < out.length; i++) out[i] = e[i] >= t ? 1 : 0;
  } else if (mode === 'lines') {
    const t = 0.1 + threshold * 0.8;
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) bin[i] = ink[i] >= t ? 1 : 0;
    // 太い線も中心線だけにして、線の幅の中でジグザグしないようにする
    thin(bin, w, h);
    for (let i = 0; i < out.length; i++) out[i] = bin[i];
  } else {
    // shade: 暗いほど点が密になる（点描）。画像内の濃淡の幅を 0..1 に引き伸ばす
    let lo = 1, hi = 0;
    for (let i = 0; i < ink.length; i++) { if (ink[i] < lo) lo = ink[i]; if (ink[i] > hi) hi = ink[i]; }
    const range = Math.max(1e-3, hi - lo);
    const t = threshold * 0.5;
    for (let i = 0; i < out.length; i++) {
      const v = ((ink[i] - lo) / range - t) / (1 - t);
      out[i] = v > 0 ? Math.pow(v, 1.6) : 0;
    }
  }
  return out;
}

/** Zhang–Suen 細線化（その場で書き換え）。 */
export function thin(img, w, h) {
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!img[i]) continue;
          const p2 = img[i - w], p3 = img[i - w + 1], p4 = img[i + 1], p5 = img[i + w + 1];
          const p6 = img[i + w], p7 = img[i + w - 1], p8 = img[i - 1], p9 = img[i - w - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) +
            (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (a !== 1) continue;
          if (step === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
      }
      for (const i of del) img[i] = 0;
      if (del.length) changed = true;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// 点のサンプリング

/** 点数が maxPoints 付近になる最小間隔を二分探索で求めてサンプリングする。 */
function sampleAuto(weight, w, h, opt) {
  if (opt.mode === 'shade') {
    // 陰影は間隔ではなく採用確率で点数を合わせる（間隔で合わせると濃淡が均されてしまう）
    let sum = 0;
    for (let i = 0; i < weight.length; i++) sum += weight[i];
    const f = sum > 0 ? opt.maxPoints / sum : 0;
    const scaled = new Float32Array(weight.length);
    for (let i = 0; i < weight.length; i++) scaled[i] = Math.min(0.999, weight[i] * f);
    const spacing = Math.max(1, Math.sqrt((w * h) / Math.max(1, opt.maxPoints)) * 0.35);
    return samplePoints(scaled, w, h, { ...opt, spacing, jitter: true });
  }
  let lo = 1, hi = Math.max(w, h) / 4;
  let best = samplePoints(weight, w, h, { ...opt, spacing: lo });
  if (best.length / 2 <= opt.maxPoints) return best;
  for (let it = 0; it < 12; it++) {
    const mid = (lo + hi) / 2;
    const pts = samplePoints(weight, w, h, { ...opt, spacing: mid, maxPoints: Infinity });
    if (pts.length / 2 > opt.maxPoints) lo = mid;
    else { hi = mid; best = pts; }
  }
  return best.length / 2 > opt.maxPoints ? best.subarray(0, opt.maxPoints * 2) : best;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 重み付きランダム順に候補を見て、最小間隔を満たすものだけ採用する（ポアソンディスク風）。 */
export function samplePoints(weight, w, h, opt) {
  const rand = mulberry32(opt.seed);
  const cand = [];
  for (let i = 0; i < weight.length; i++) if (weight[i] > 0) cand.push(i);
  // Fisher–Yates
  for (let i = cand.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = cand[i]; cand[i] = cand[j]; cand[j] = t;
  }

  const r = Math.max(1, opt.spacing);
  const r2 = r * r;
  const cell = r;
  const gw = Math.ceil(w / cell) + 1, gh = Math.ceil(h / cell) + 1;
  const grid = new Int32Array(gw * gh).fill(-1);
  const next = [];
  const xs = [], ys = [];

  // 陰影モードは候補が多いので、確率で間引きながら最大点数まで
  for (let k = 0; k < cand.length && xs.length < opt.maxPoints; k++) {
    const i = cand[k];
    if (weight[i] < 1 && rand() > weight[i]) continue;
    const j = opt.jitter ? rand() - 0.5 : 0, k2 = opt.jitter ? rand() - 0.5 : 0;
    const x = (i % w) + j, y = ((i / w) | 0) + k2;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    let ok = true;
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(gh - 1, cy + 1) && ok; gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(gw - 1, cx + 1) && ok; gx++) {
        for (let p = grid[gy * gw + gx]; p !== -1; p = next[p]) {
          const dx = xs[p] - x, dy = ys[p] - y;
          if (dx * dx + dy * dy < r2) { ok = false; break; }
        }
      }
    }
    if (!ok) continue;
    const id = xs.length;
    xs.push(x); ys.push(y);
    const g = Math.max(0, Math.min(gh - 1, cy)) * gw + Math.max(0, Math.min(gw - 1, cx));
    next.push(grid[g]);
    grid[g] = id;
  }

  const pts = new Float32Array(xs.length * 2);
  for (let i = 0; i < xs.length; i++) { pts[i * 2] = xs[i]; pts[i * 2 + 1] = ys[i]; }
  return pts;
}

// ---------------------------------------------------------------------------
// 経路最適化

function dist(p, a, b) {
  return Math.hypot(p[a * 2] - p[b * 2], p[a * 2 + 1] - p[b * 2 + 1]);
}

/** 一様グリッドの空間インデックス。 */
class Grid {
  constructor(p) {
    const n = p.length / 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, p[i * 2]); maxX = Math.max(maxX, p[i * 2]);
      minY = Math.min(minY, p[i * 2 + 1]); maxY = Math.max(maxY, p[i * 2 + 1]);
    }
    const area = Math.max(1, (maxX - minX) * (maxY - minY));
    this.cell = Math.max(1, Math.sqrt(area / n) * 1.5);
    this.minX = minX; this.minY = minY;
    this.gw = Math.floor((maxX - minX) / this.cell) + 1;
    this.gh = Math.floor((maxY - minY) / this.cell) + 1;
    this.cells = Array.from({ length: this.gw * this.gh }, () => []);
    this.p = p;
    for (let i = 0; i < n; i++) this.cells[this.key(i)].push(i);
  }
  cx(i) { return Math.floor((this.p[i * 2] - this.minX) / this.cell); }
  cy(i) { return Math.floor((this.p[i * 2 + 1] - this.minY) / this.cell); }
  key(i) { return this.cy(i) * this.gw + this.cx(i); }
  remove(i) {
    const c = this.cells[this.key(i)];
    const k = c.indexOf(i);
    c[k] = c[c.length - 1];
    c.pop();
  }
  /** i に最も近い点（i 自身と除外済みを除く）。見つからなければ -1。 */
  nearest(i) {
    const cx = this.cx(i), cy = this.cy(i);
    let best = -1, bestD = Infinity;
    const maxR = Math.max(this.gw, this.gh);
    for (let r = 0; r <= maxR; r++) {
      // 半径 r のリング上のセルを走査
      for (let y = cy - r; y <= cy + r; y++) {
        if (y < 0 || y >= this.gh) continue;
        const step = y === cy - r || y === cy + r ? 1 : 2 * r || 1;
        for (let x = cx - r; x <= cx + r; x += step) {
          if (x < 0 || x >= this.gw) continue;
          for (const j of this.cells[y * this.gw + x]) {
            if (j === i) continue;
            const d = dist(this.p, i, j);
            if (d < bestD) { bestD = d; best = j; }
          }
        }
      }
      // リング r まで見たら、それより外側の点は距離 r*cell 以上
      if (best !== -1 && bestD <= r * this.cell) break;
    }
    return best;
  }
}

/** 各点の近い順 k 個の近傍リスト。 */
export function buildNeighbors(p, k) {
  const n = p.length / 2;
  const g = new Grid(p);
  const out = new Int32Array(n * k).fill(-1);
  const cand = [];
  for (let i = 0; i < n; i++) {
    cand.length = 0;
    const cx = g.cx(i), cy = g.cy(i);
    for (let r = 1; r <= Math.max(g.gw, g.gh); r++) {
      cand.length = 0;
      for (let y = Math.max(0, cy - r); y <= Math.min(g.gh - 1, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x <= Math.min(g.gw - 1, cx + r); x++) {
          for (const j of g.cells[y * g.gw + x]) if (j !== i) cand.push(j);
        }
      }
      if (cand.length >= k * 2 || cand.length >= n - 1) break;
    }
    cand.sort((a, b) => dist(p, i, a) - dist(p, i, b));
    for (let m = 0; m < Math.min(k, cand.length); m++) out[i * k + m] = cand[m];
  }
  out.k = k;
  return out;
}

/** 最近傍法で初期巡回路を作る。 */
export function nearestNeighborTour(p) {
  const n = p.length / 2;
  const g = new Grid(p);
  const tour = new Int32Array(n);
  // 左上に最も近い点から開始
  let cur = 0, best = Infinity;
  for (let i = 0; i < n; i++) {
    const d = p[i * 2] + p[i * 2 + 1];
    if (d < best) { best = d; cur = i; }
  }
  for (let k = 0; k < n; k++) {
    tour[k] = cur;
    const nx = g.nearest(cur);
    g.remove(cur);
    cur = nx;
    if (cur === -1) break;
  }
  return tour;
}

/** 近傍リストを使った 2-opt 改善（閉路として扱う）。時間制限付き。 */
export function twoOpt(p, tour, knn, budgetMs, onProgress) {
  const n = tour.length;
  if (n < 4) return;
  const k = knn.k;
  const pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[tour[i]] = i;
  const start = Date.now();
  const at = (i) => tour[(i + n) % n];

  // 位置 i..j（循環）を反転。短い側を反転すれば同じ巡回路になる。
  const reverse = (i, j) => {
    let len = ((j - i + n) % n) + 1;
    if (len * 2 > n) { const t = i; i = (j + 1) % n; j = (t - 1 + n) % n; len = n - len; }
    for (let s = 0; s < len / 2 - 0.5; s++) {
      const a = (i + s) % n, b = (j - s + n) % n;
      const t = tour[a]; tour[a] = tour[b]; tour[b] = t;
      pos[tour[a]] = a; pos[tour[b]] = b;
    }
  };

  let improved = true;
  let rounds = 0;
  while (improved) {
    improved = false;
    rounds++;
    for (let i = 0; i < n; i++) {
      if ((i & 255) === 0 && Date.now() - start > budgetMs) { onProgress?.(1); return; }
      const a = tour[i];
      // 後ろ向き: (a, succ) を (a, c), (succ, succ(c)) に張り替え
      const b = at(i + 1);
      const dab = dist(p, a, b);
      for (let m = 0; m < k; m++) {
        const c = knn[a * k + m];
        if (c < 0) break;
        const dac = dist(p, a, c);
        if (dac >= dab) break;
        const j = pos[c];
        const d = at(j + 1);
        if (c === b || d === a) continue;
        const delta = dac + dist(p, b, d) - dab - dist(p, c, d);
        if (delta < -1e-6) { reverse(i + 1, j); improved = true; break; }
      }
      // 前向き: (pred, a) を (c, a), (pred(c), pred) に張り替え
      const ia = pos[a];
      const pa = at(ia - 1);
      const dpa = dist(p, pa, a);
      for (let m = 0; m < k; m++) {
        const c = knn[a * k + m];
        if (c < 0) break;
        const dac = dist(p, a, c);
        if (dac >= dpa) break;
        const j = pos[c];
        const pc = at(j - 1);
        if (c === pa || pc === a) continue;
        const delta = dac + dist(p, pa, pc) - dpa - dist(p, pc, c);
        if (delta < -1e-6) { reverse(j, (pos[a] - 1 + n) % n); improved = true; break; }
      }
    }
    onProgress?.(Math.min(1, (Date.now() - start) / budgetMs));
  }
  onProgress?.(1);
}

/**
 * 画素の階段状のガタつきを取るため、近い点同士だけ隣と平均する。
 * 長いジャンプの両端は動かさないので形は崩れない。
 */
export function relax(p, n, iterations = 2) {
  let sum = 0;
  for (let i = 1; i < n; i++) sum += Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  const limit = (sum / Math.max(1, n - 1)) * 2.5;
  const q = new Float32Array(p.length);
  for (let it = 0; it < iterations; it++) {
    q.set(p);
    for (let i = 1; i < n - 1; i++) {
      const a = (i - 1) * 2, b = i * 2, c = (i + 1) * 2;
      if (Math.hypot(q[a] - q[b], q[a + 1] - q[b + 1]) > limit) continue;
      if (Math.hypot(q[c] - q[b], q[c + 1] - q[b + 1]) > limit) continue;
      p[b] = (q[a] + 2 * q[b] + q[c]) / 4;
      p[b + 1] = (q[a + 1] + 2 * q[b + 1] + q[c + 1]) / 4;
    }
  }
}

/** 閉路の中で一番長い辺を切り、そこを始点・終点にする。 */
export function openAtLongestEdge(p, tour) {
  const n = tour.length;
  let cut = 0, longest = -1;
  for (let i = 0; i < n; i++) {
    const d = dist(p, tour[i], tour[(i + 1) % n]);
    if (d > longest) { longest = d; cut = i; }
  }
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = tour[(cut + 1 + i) % n];
  return out;
}

// ---------------------------------------------------------------------------
// 交差の解消

function orient(p, a, b, c) {
  return (p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) - (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2]);
}

function onSegment(p, a, b, c) {
  // c が線分 ab の範囲内（a,b,c が同一直線上である前提）
  return Math.min(p[a * 2], p[b * 2]) <= p[c * 2] && p[c * 2] <= Math.max(p[a * 2], p[b * 2]) &&
    Math.min(p[a * 2 + 1], p[b * 2 + 1]) <= p[c * 2 + 1] && p[c * 2 + 1] <= Math.max(p[a * 2 + 1], p[b * 2 + 1]);
}

/** 線分 ab と cd が交わる・接する・重なるか（端点を共有する組は呼び出し側で除く）。 */
export function segmentsIntersect(p, a, b, c, d) {
  const o1 = orient(p, a, b, c), o2 = orient(p, a, b, d);
  const o3 = orient(p, c, d, a), o4 = orient(p, c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (o1 === 0 && onSegment(p, a, b, c)) || (o2 === 0 && onSegment(p, a, b, d)) ||
    (o3 === 0 && onSegment(p, c, d, a)) || (o4 === 0 && onSegment(p, c, d, b));
}

/** 線分が通過するグリッドのセルを列挙する（Amanatides–Woo のボクセル走査）。 */
function traverseCells(x0, y0, x1, y1, g, out) {
  out.length = 0;
  let cx = Math.floor((x0 - g.minX) / g.cell), cy = Math.floor((y0 - g.minY) / g.cell);
  const ex = Math.floor((x1 - g.minX) / g.cell), ey = Math.floor((y1 - g.minY) / g.cell);
  const dx = x1 - x0, dy = y1 - y0;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const tdx = dx !== 0 ? Math.abs(g.cell / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(g.cell / dy) : Infinity;
  let tx = dx !== 0 ? ((sx > 0 ? cx + 1 : cx) * g.cell + g.minX - x0) / dx : Infinity;
  let ty = dy !== 0 ? ((sy > 0 ? cy + 1 : cy) * g.cell + g.minY - y0) / dy : Infinity;
  const steps = Math.abs(ex - cx) + Math.abs(ey - cy);
  out.push(cy * g.gw + cx);
  for (let s = 0; s < steps; s++) {
    if (tx < ty) { cx += sx; tx += tdx; } else { cy += sy; ty += tdy; }
    if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh) break;
    out.push(cy * g.gw + cx);
  }
  return out;
}

function segmentGrid(p, n) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, p[i * 2]); maxX = Math.max(maxX, p[i * 2]);
    minY = Math.min(minY, p[i * 2 + 1]); maxY = Math.max(maxY, p[i * 2 + 1]);
  }
  // セルの境界ちょうどの交点を取りこぼさないよう少し広げる
  minX -= 1; minY -= 1; maxX += 1; maxY += 1;
  const cell = Math.max(1, Math.sqrt(((maxX - minX) * (maxY - minY)) / n) * 2);
  const gw = Math.floor((maxX - minX) / cell) + 1, gh = Math.floor((maxY - minY) / cell) + 1;
  return { minX, minY, cell, gw, gh, cells: new Map() };
}

/**
 * 開いた経路 tour（p の点番号の並び）から交差・接触・重なりをなくす。
 * 交わる 2 辺 (A,B), (C,D) を (A,C), (B,D) につなぎ替えると経路は必ず短くなるので、
 * 交差がなくなるまで繰り返しても必ず終わる。tour をその場で書き換え、つなぎ替え回数を返す。
 */
export function uncross(p, tour) {
  const n = tour.length;
  if (n < 4) return 0;
  const N = n + 1;
  const pos = new Int32Array(p.length / 2);
  for (let i = 0; i < n; i++) pos[tour[i]] = i;
  const g = segmentGrid(p, p.length / 2);
  const segCells = new Map();
  const tmp = [];
  const keyOf = (a, b) => (a < b ? a * N + b : b * N + a);

  const add = (a, b) => {
    const key = keyOf(a, b);
    const cells = traverseCells(p[a * 2], p[a * 2 + 1], p[b * 2], p[b * 2 + 1], g, tmp).slice();
    segCells.set(key, cells);
    for (const c of cells) {
      let set = g.cells.get(c);
      if (!set) g.cells.set(c, (set = new Set()));
      set.add(key);
    }
    return key;
  };
  const remove = (a, b) => {
    const key = keyOf(a, b);
    for (const c of segCells.get(key)) g.cells.get(c).delete(key);
    segCells.delete(key);
  };

  const queue = [];
  for (let i = 0; i + 1 < n; i++) queue.push(add(tour[i], tour[i + 1]));

  let fixes = 0;
  const maxFixes = n * 50; // 数値誤差による無限ループ対策
  while (queue.length && fixes < maxFixes) {
    const key = queue.pop();
    const cells = segCells.get(key);
    if (!cells) continue; // すでにつなぎ替えで消えた辺
    const a = Math.floor(key / N), b = key % N;
    let fixed = false;
    for (const cell of cells) {
      for (const other of g.cells.get(cell)) {
        if (other === key) continue;
        const c = Math.floor(other / N), d = other % N;
        if (c === a || c === b || d === a || d === b) continue;
        if (!segmentsIntersect(p, a, b, c, d)) continue;
        let i = Math.min(pos[a], pos[b]), j = Math.min(pos[c], pos[d]);
        if (i > j) { const t = i; i = j; j = t; }
        const A = tour[i], B = tour[i + 1], C = tour[j], D = tour[j + 1];
        // 真の交差なら必ず短くなる。接触・重なりは短くなる場合だけ直す
        if (dist(p, A, C) + dist(p, B, D) - dist(p, A, B) - dist(p, C, D) > -1e-9) continue;
        remove(A, B);
        remove(C, D);
        for (let s = i + 1, e = j; s < e; s++, e--) {
          const t = tour[s]; tour[s] = tour[e]; tour[e] = t;
          pos[tour[s]] = s; pos[tour[e]] = e;
        }
        queue.push(add(A, C), add(B, D));
        fixes++;
        fixed = true;
        break;
      }
      if (fixed) break;
    }
  }
  return fixes;
}

/** 開いた折れ線 points[0..count) の中で交わっている辺の組 [i, j]（隣り合う辺は除く）。 */
export function crossingPairs(points, count) {
  const pairs = [];
  if (count < 4) return pairs;
  const order = Int32Array.from({ length: count }, (_, i) => i);
  const g = segmentGrid(points, count);
  const tmp = [];
  for (let i = 0; i + 1 < count; i++) {
    const cells = traverseCells(points[i * 2], points[i * 2 + 1], points[i * 2 + 2], points[i * 2 + 3], g, tmp);
    const seen = new Set();
    for (const c of cells) {
      for (const j of g.cells.get(c) || []) {
        if (seen.has(j) || j >= i - 1) continue;
        seen.add(j);
        if (segmentsIntersect(points, order[i], order[i + 1], order[j], order[j + 1])) pairs.push([j, i]);
      }
    }
    for (const c of cells) {
      let set = g.cells.get(c);
      if (!set) g.cells.set(c, (set = new Set()));
      set.add(i);
    }
  }
  return pairs;
}

export function countCrossings(points, count) {
  return crossingPairs(points, count).length;
}

export function tourLength(p, tour, closed = false) {
  let s = 0;
  for (let i = 0; i + 1 < tour.length; i++) s += dist(p, tour[i], tour[i + 1]);
  if (closed && tour.length > 1) s += dist(p, tour[tour.length - 1], tour[0]);
  return s;
}

// ---------------------------------------------------------------------------
// SVG 出力

const CURVE_STEPS = 16;
const round1 = (v) => Math.round(v * 10) / 10;

/**
 * SVG に書き出すのと同じ（丸め済みの）幾何を作る。
 * 区間 i は [x0, y0, c1x, c1y, c2x, c2y, x3, y3]。直線区間は制御点を両端に置く。
 */
function curveGeometry(points, count, scale, tension) {
  const X = (k) => round1(points[k * 2] * scale), Y = (k) => round1(points[k * 2 + 1] * scale);
  const g = new Float64Array(Math.max(0, count - 1) * 8);
  for (let i = 0; i < count - 1; i++) {
    const t = tension(i);
    const x0 = X(i), y0 = Y(i), x3 = X(i + 1), y3 = Y(i + 1);
    let c1x = x0, c1y = y0, c2x = x3, c2y = y3;
    if (t !== 0) {
      const i0 = Math.max(0, i - 1), i3 = Math.min(count - 1, i + 2);
      c1x = round1(x0 + (x3 - X(i0)) * t); c1y = round1(y0 + (y3 - Y(i0)) * t);
      c2x = round1(x3 - (X(i3) - x0) * t); c2y = round1(y3 - (Y(i3) - y0) * t);
    }
    g.set([x0, y0, c1x, c1y, c2x, c2y, x3, y3], i * 8);
  }
  return g;
}

/**
 * 曲線化しても交差しないよう、区間ごとの曲がり具合を決める。
 * 曲線にしたことで交わった区間は直線に戻す（全区間が直線なら元の折れ線と同じで交差はない）。
 * scale は書き出し時と同じ値を渡す（丸め誤差まで含めて同じ形で判定するため）。
 */
export function safeTensions(points, count, smooth, scale = 1) {
  const tension = new Float32Array(Math.max(0, count - 1)).fill(smooth / 6);
  if (smooth <= 0 || count < 3) return tension;
  for (let round = 0; round < 50; round++) {
    const geo = curveGeometry(points, count, scale, (i) => tension[i]);
    const flat = new Float32Array(((count - 1) * CURVE_STEPS + 1) * 2);
    flat[0] = geo[0]; flat[1] = geo[1];
    let k = 2;
    for (let i = 0; i < count - 1; i++) {
      const [x0, y0, c1x, c1y, c2x, c2y, x3, y3] = geo.subarray(i * 8, i * 8 + 8);
      for (let s = 1; s <= CURVE_STEPS; s++) {
        const u = s / CURVE_STEPS, v = 1 - u;
        flat[k++] = v * v * v * x0 + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * x3;
        flat[k++] = v * v * v * y0 + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * y3;
      }
    }
    const pairs = crossingPairs(flat, flat.length / 2);
    if (!pairs.length) break;
    let changed = false;
    for (const [a, b] of pairs) {
      for (const seg of [Math.floor(a / CURVE_STEPS), Math.floor(b / CURVE_STEPS)]) {
        if (tension[seg] !== 0) { tension[seg] = 0; changed = true; }
      }
    }
    if (!changed) break;
  }
  return tension;
}

/**
 * 並んだ点列を SVG の path データに変換する。
 * smooth=0 で折れ線、>0 で Catmull-Rom スプラインによる曲線。
 * tensions を渡すと区間ごとの曲がり具合をそれで決める（safeTensions の結果）。
 */
export function toPathData(points, count, scale = 1, smooth = 0.5, tensions = null) {
  if (count === 0) return '';
  const geo = curveGeometry(points, count, scale, (i) => (smooth <= 0 ? 0 : tensions ? tensions[i] : smooth / 6));
  let d = `M${round1(points[0] * scale)} ${round1(points[1] * scale)}`;
  for (let i = 0; i < count - 1; i++) {
    const [, , c1x, c1y, c2x, c2y, x3, y3] = geo.subarray(i * 8, i * 8 + 8);
    const straight = c1x === geo[i * 8] && c1y === geo[i * 8 + 1] && c2x === x3 && c2y === y3;
    d += straight ? `L${x3} ${y3}` : `C${c1x} ${c1y} ${c2x} ${c2y} ${x3} ${y3}`;
  }
  return d;
}

export function toSvg({ points, count, width, height }, style = {}) {
  const { scale = 1, smooth = 0.5, stroke = '#111111', strokeWidth = 1.5, background = '#ffffff', tensions = null } = style;
  const W = Math.round(width * scale), H = Math.round(height * scale);
  const bg = background && background !== 'transparent' ? `<rect width="100%" height="100%" fill="${background}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${bg}` +
    `<path d="${toPathData(points, count, scale, smooth, tensions)}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
