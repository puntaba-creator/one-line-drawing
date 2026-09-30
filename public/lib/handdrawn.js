// 一筆書きの線を「手で描いたような」線に仕上げる後処理
//
// 1. 等間隔に打ち直す（長い直線にも途中の点ができ、しなやかに曲がれるように）
// 2. ゆらぎ: 弧長に沿ったなめらかなノイズで、線をわずかに左右へ揺らす
// 3. すき間: 経路上で離れた部分どうしが近づきすぎたら、目標の間隔まで押し広げる
//    （押すのは足りない分だけ。元の位置へ弱く引き戻すので離れすぎない）
// 4. 筆圧: 曲がるところは太く、速く引く直線は細く、描き始めと終わりは細く
//
// どの段階でも、交差が生じた点は直前の位置に戻すので「交差しない」は保たれる。

import { crossingPairs } from './onestroke.js';

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

/** 1 次元のなめらかなノイズ（-1..1）。 */
function noise1d(seed, size = 4096) {
  const rand = mulberry32(seed);
  const table = Float32Array.from({ length: size }, () => rand() * 2 - 1);
  return (x) => {
    const i = Math.floor(x), f = x - i;
    const a = table[((i % size) + size) % size], b = table[(((i + 1) % size) + size) % size];
    const u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
  };
}

/**
 * 折れ線を間隔 step で打ち直す。元の頂点は必ず残すので形（交差のなさ）は変わらない。
 * mobility（各点の動かしやすさ 0..1）も返す: 長いつなぎ線の途中は 1、形をなす線の上は低い。
 */
export function resample(points, count, step, { stiffness = 0.15 } = {}) {
  // 元の区間の長さの中央値 ＝ 形をなす線での点の間隔。その数倍より長い区間は「つなぎ線」
  const lens = [];
  for (let i = 0; i + 1 < count; i++) lens.push(Math.hypot(points[i * 2 + 2] - points[i * 2], points[i * 2 + 3] - points[i * 2 + 1]));
  const sorted = lens.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || step;
  const connector = Math.max(median * 3, step * 3);
  const out = [points[0], points[1]];
  const mob = [stiffness];
  for (let i = 0; i + 1 < count; i++) {
    const x0 = points[i * 2], y0 = points[i * 2 + 1], x1 = points[i * 2 + 2], y1 = points[i * 2 + 3];
    const k = Math.max(1, Math.round(lens[i] / step));
    const isConnector = lens[i] > connector;
    for (let s = 1; s <= k; s++) {
      out.push(x0 + ((x1 - x0) * s) / k, y0 + ((y1 - y0) * s) / k);
      // つなぎ線の両端（形の上の点）は固く、途中ほど動きやすく
      const edge = Math.min(s, k - s) * step;
      mob.push(isConnector && s < k ? stiffness + (1 - stiffness) * Math.min(1, edge / (step * 4)) : stiffness);
    }
  }
  const res = new Float32Array(out);
  res.mobility = Float32Array.from(mob);
  return res;
}

/** 各点の法線（前後の点から求める単位ベクトル）。 */
function normals(p, n) {
  const nx = new Float32Array(n), ny = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const tx = p[b * 2] - p[a * 2], ty = p[b * 2 + 1] - p[a * 2 + 1];
    const l = Math.hypot(tx, ty) || 1;
    nx[i] = -ty / l; ny[i] = tx / l;
  }
  return { nx, ny };
}

/**
 * next へ動かす。交差が生じたら、関わった点とその前後を prev 側へなめらかに戻す
 * （1 点だけ戻すと折れ曲がりが残るため、戻す量を前後 FALLOFF 点かけて減らしていく）。
 * prev が交差なしなら結果も必ず交差なし（最悪すべて prev に戻る）。
 */
const FALLOFF = 8;
function applyWithoutCrossing(p, next, n, guard) {
  if (!guard) { p.set(next); return; }
  const prev = p.slice();
  // 動かす前からあった交わり（入力由来）は対象外。動かしたことで新たに生じたものだけ戻す
  const baseline = new Set(crossingPairs(prev, n).map(([a, b]) => a * n + b));
  p.set(next);
  const keep = new Float32Array(n).fill(1); // 1: next のまま、0: prev に戻す
  for (let round = 0; round < 60; round++) {
    const pairs = crossingPairs(p, n).filter(([a, b]) => !baseline.has(a * n + b));
    if (!pairs.length) return;
    for (const [a, b] of pairs) {
      for (const c of [a, b]) {
        for (let k = Math.max(0, c - FALLOFF); k <= Math.min(n - 1, c + 1 + FALLOFF); k++) {
          const d = k < c ? c - k : k > c + 1 ? k - c - 1 : 0;
          keep[k] = Math.min(keep[k], round >= 4 ? 0 : d / (FALLOFF + 1));
        }
      }
    }
    for (let k = 0; k < n; k++) {
      p[k * 2] = prev[k * 2] + (next[k * 2] - prev[k * 2]) * keep[k];
      p[k * 2 + 1] = prev[k * 2 + 1] + (next[k * 2 + 1] - prev[k * 2 + 1]) * keep[k];
    }
  }
  p.set(prev);
}

/** 弧長に沿ったゆらぎを加える。amp: 振れ幅(px)、wavelength: 波の長さ(px)。 */
export function wobble(p, n, amp, wavelength, seed, guard) {
  if (amp <= 0) return;
  const slow = noise1d(seed), fast = noise1d(seed + 101);
  const { nx, ny } = normals(p, n);
  const next = p.slice();
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) s += Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
    // ゆっくりした手のぶれ + 細かい震え
    const d = amp * (slow(s / wavelength) + 0.12 * fast(s / (wavelength * 0.15)));
    next[i * 2] += nx[i] * d;
    next[i * 2 + 1] += ny[i] * d;
  }
  applyWithoutCrossing(p, next, n, guard);
}

/**
 * 経路上で離れた部分どうしの間隔を target 以上に保つ。
 * 足りない分だけ押し広げ、押す量は前後になめらかに広げて線を自然に曲げる。
 * 元の位置から maxShift より遠くへは動かさない（離しすぎない）。
 */
export function keepClearance(p, n, target, { step, iterations = 60, guard = true, maxShift = target * 2, rate = 7, mobility = null } = {}) {
  if (target <= 0 || n < 4) return;
  // 動かしやすさ: 近すぎる 2 点は、動きやすい側が多く動く。形をなす線はあまり動かさない
  const mob = mobility || new Float32Array(n).fill(1);
  const orig = p.slice();
  const hits = new Float32Array(n);
  let best = p.slice(), bestViolations = Infinity;
  // 経路上でこれより近い点どうしは「同じ線の続き」なので押し合わない
  const window = Math.ceil((target * 2.2) / step) + 1;
  const cell = target;
  const t2 = target * target;
  let disp = new Float32Array(n * 2), tmp = new Float32Array(n * 2);

  for (let it = 0; it < iterations; it++) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, p[i * 2]); maxX = Math.max(maxX, p[i * 2]);
      minY = Math.min(minY, p[i * 2 + 1]); maxY = Math.max(maxY, p[i * 2 + 1]);
    }
    const gw = Math.floor((maxX - minX) / cell) + 1, gh = Math.floor((maxY - minY) / cell) + 1;
    const head = new Int32Array(gw * gh).fill(-1), link = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const c = Math.floor((p[i * 2 + 1] - minY) / cell) * gw + Math.floor((p[i * 2] - minX) / cell);
      link[i] = head[c]; head[c] = i;
    }

    disp.fill(0);
    hits.fill(0);
    let violations = 0;
    for (let i = 0; i < n; i++) {
      const x = p[i * 2], y = p[i * 2 + 1];
      const cx = Math.floor((x - minX) / cell), cy = Math.floor((y - minY) / cell);
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(gh - 1, cy + 1); gy++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(gw - 1, cx + 1); gx++) {
          for (let j = head[gy * gw + gx]; j !== -1; j = link[j]) {
            if (j <= i + window) continue; // 各組を 1 回だけ、近所は除く
            const dx = x - p[j * 2], dy = y - p[j * 2 + 1];
            const d2 = dx * dx + dy * dy;
            if (d2 >= t2) continue;
            violations++;
            const d = Math.sqrt(d2) || 1e-3;
            const need = target - d;
            const ux = d2 > 0 ? dx / d : 1, uy = d2 > 0 ? dy / d : 0;
            const share = mob[i] / (mob[i] + mob[j]);
            disp[i * 2] += ux * need * share; disp[i * 2 + 1] += uy * need * share;
            disp[j * 2] -= ux * need * (1 - share); disp[j * 2 + 1] -= uy * need * (1 - share);
            hits[i]++; hits[j]++;
          }
        }
      }
    }

    if (violations < bestViolations) { bestViolations = violations; best = p.slice(); }
    if (violations === 0) break;
    // 複数の相手から押されても行き過ぎないよう平均をとる
    for (let i = 0; i < n; i++) if (hits[i] > 1) { disp[i * 2] /= hits[i]; disp[i * 2 + 1] /= hits[i]; }
    // 押す量を前後へなめらかに広げる（1 点だけ尖らないように）
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        tmp[i * 2] = (disp[a * 2] + 2 * disp[i * 2] + disp[b * 2]) / 4;
        tmp[i * 2 + 1] = (disp[a * 2 + 1] + 2 * disp[i * 2 + 1] + disp[b * 2 + 1]) / 4;
      }
      [disp, tmp] = [tmp, disp];
    }

    const next = p.slice();
    for (let i = 0; i < n; i++) {
      // なめらかに広げた押し量も、形をなす線の上では小さく
      const m = mob[i];
      const damp = 0.35 + 0.65 * m;
      let x = p[i * 2] + disp[i * 2] * rate * damp, y = p[i * 2 + 1] + disp[i * 2 + 1] * rate * damp;
      // 押されていないところは少しずつ元の位置へ戻す
      // 押されていないところは元の位置へ戻す（形をなす線ほど強く）
      const back = 0.03 + 0.12 * (1 - m);
      x += (orig[i * 2] - x) * back;
      y += (orig[i * 2 + 1] - y) * back;
      // 動ける範囲: 形をなす線は目標間隔の半分ほど、つなぎ線は maxShift まで
      const lim = maxShift * (0.25 + 0.75 * m);
      const ox = x - orig[i * 2], oy = y - orig[i * 2 + 1], o = Math.hypot(ox, oy);
      if (o > lim) { x = orig[i * 2] + (ox / o) * lim; y = orig[i * 2 + 1] + (oy / o) * lim; }
      next[i * 2] = x; next[i * 2 + 1] = y;
    }
    applyWithoutCrossing(p, next, n, guard);
  }
  // 最後の状態がいちばん良いとは限らない（best も交差なしの状態のひとつ）
  if (bestViolations < Infinity && countClose(p, n, target, window, cell) > bestViolations) p.set(best);
}

function countClose(p, n, target, window, cell) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, p[i * 2]); maxX = Math.max(maxX, p[i * 2]);
    minY = Math.min(minY, p[i * 2 + 1]); maxY = Math.max(maxY, p[i * 2 + 1]);
  }
  const gw = Math.floor((maxX - minX) / cell) + 1, gh = Math.floor((maxY - minY) / cell) + 1;
  const head = new Int32Array(gw * gh).fill(-1), link = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.floor((p[i * 2 + 1] - minY) / cell) * gw + Math.floor((p[i * 2] - minX) / cell);
    link[i] = head[c]; head[c] = i;
  }
  let c = 0;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor((p[i * 2] - minX) / cell), cy = Math.floor((p[i * 2 + 1] - minY) / cell);
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(gh - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(gw - 1, cx + 1); gx++) {
        for (let j = head[gy * gw + gx]; j !== -1; j = link[j]) {
          if (j <= i + window) continue;
          const dx = p[i * 2] - p[j * 2], dy = p[i * 2 + 1] - p[j * 2 + 1];
          if (dx * dx + dy * dy < target * target) c++;
        }
      }
    }
  }
  return c;
}

/**
 * 角を丸める。Taubin 平滑化（縮める一歩と膨らませる一歩を交互に）なので、
 * 小さな輪（目・鼻など）が平滑化で縮んでしまわない。strength 0..1。
 */
export function smoothPath(p, n, strength, guard) {
  const rounds = Math.round(strength * 24);
  for (let r = 0; r < rounds; r++) {
    for (const f of [0.5, -0.53]) {
      const next = p.slice();
      for (let i = 1; i < n - 1; i++) {
        next[i * 2] = p[i * 2] + f * ((p[i * 2 - 2] + p[i * 2 + 2]) / 2 - p[i * 2]);
        next[i * 2 + 1] = p[i * 2 + 1] + f * ((p[i * 2 - 1] + p[i * 2 + 3]) / 2 - p[i * 2 + 1]);
      }
      applyWithoutCrossing(p, next, n, guard);
    }
  }
}

/** 近すぎる（経路上で離れた）点の組の数。テスト・表示用。 */
export function clearanceViolations(p, n, target, step) {
  return countClose(p, n, target, Math.ceil((target * 2.2) / step) + 1, target);
}

/**
 * 筆圧を模した各点の太さの倍率（おおよそ 0.35〜1.3）。
 * 曲がるところは太く、直線は細く、始点・終点は細くすぼめる。
 */
export function pressure(p, n, amount, seed) {
  const w = new Float32Array(n).fill(1);
  if (n < 3) return w;
  const wave = noise1d(seed + 7);
  const turn = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) {
    const ax = p[i * 2] - p[i * 2 - 2], ay = p[i * 2 + 1] - p[i * 2 - 1];
    const bx = p[i * 2 + 2] - p[i * 2], by = p[i * 2 + 3] - p[i * 2 + 1];
    turn[i] = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
  }
  // 曲がり具合を前後 6 点で平均
  const R = 6;
  let s = 0, total = 0;
  const len = new Float32Array(n);
  for (let i = 1; i < n; i++) len[i] = len[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  total = len[n - 1];
  const taper = Math.min(40, total * 0.15);
  for (let i = 0; i < n; i++) {
    s = 0;
    for (let k = Math.max(0, i - R); k <= Math.min(n - 1, i + R); k++) s += turn[k];
    const curv = Math.min(1, s / 1.2);
    const ends = Math.min(1, len[i] / taper, (total - len[i]) / taper);
    const ease = ends * ends * (3 - 2 * ends);
    const f = (0.6 + 0.75 * curv + 0.2 * wave(len[i] / 60)) * (0.25 + 0.75 * ease);
    w[i] = 1 + amount * (f - 1);
  }
  return w;
}

/** 太さの変わる線を塗りつぶしの輪郭（SVG path データ）にする。 */
export function ribbonPath(p, n, widths, baseWidth, scale) {
  const { nx, ny } = normals(p, n);
  const f = (v) => Math.round(v * scale * 10) / 10;
  let left = '', right = '';
  for (let i = 0; i < n; i++) {
    const h = (baseWidth * widths[i]) / 2;
    left += `${i ? 'L' : 'M'}${f(p[i * 2] + nx[i] * h)} ${f(p[i * 2 + 1] + ny[i] * h)}`;
  }
  for (let i = n - 1; i >= 0; i--) {
    const h = (baseWidth * widths[i]) / 2;
    right += `L${f(p[i * 2] - nx[i] * h)} ${f(p[i * 2 + 1] - ny[i] * h)}`;
  }
  return `${left}${right}Z`;
}

/**
 * 生成結果を手描き風に仕上げる。
 * hand: 0..1 手書き感、gap: 線と線のあいだに空けたいすき間(px)、strokeWidth: 線の太さ(px)。
 */
export function stylize(result, { hand = 0.5, gap = 2, strokeWidth = 1.6, smooth = 0.6, noCross = true, seed = 1 } = {}) {
  const { points, count } = result;
  if (count < 2) return { ...result, dense: false };
  // 線の中心どうしの目標間隔 = すき間 + 太さ（筆圧で太くなる分も見込む）
  const target = gap > 0 ? gap + strokeWidth * (1 + 0.35 * hand) : 0;
  const step = Math.max(0.8, Math.min(2, target > 0 ? target / 2.5 : 2));
  const p = resample(points, count, step);
  const n = p.length / 2;
  smoothPath(p, n, smooth, noCross);
  wobble(p, n, hand * 4, 110, seed, noCross);
  keepClearance(p, n, target, { step, guard: noCross, mobility: p.mobility });
  // 押し広げでできた小さな折れを軽くならす
  if (target > 0) smoothPath(p, n, 0.1, noCross);
  let length = 0;
  for (let i = 1; i < n; i++) length += Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  return { ...result, points: p, count: n, length, dense: true, sourceCount: count, target, step };
}

/**
 * 仕上げた線を SVG にする。
 * pressure > 0 なら太さの変わる塗りつぶしの線、0 なら一定の太さの線。
 * animated: 表示用。描く様子を再生できるよう、筆圧の線は中心線のマスクで少しずつ見せる。
 */
export function toHandSvg(result, { scale = 1, stroke = '#111', strokeWidth = 1.6, background = '#fff', pressure: amount = 0, seed = 1, animated = false } = {}) {
  const { points: p, count: n, width, height } = result;
  const W = Math.round(width * scale), H = Math.round(height * scale);
  const f = (v) => Math.round(v * scale * 10) / 10;
  let center = '';
  for (let i = 0; i < n; i++) center += `${i ? 'L' : 'M'}${f(p[i * 2])} ${f(p[i * 2 + 1])}`;
  const bg = background && background !== 'transparent' ? `<rect width="100%" height="100%" fill="${background}"/>` : '';
  let body;
  if (amount > 0) {
    const widths = pressure(p, n, amount, seed);
    const ribbon = `<path d="${ribbonPath(p, n, widths, strokeWidth, scale)}" fill="${stroke}"`;
    body = animated
      ? `<defs><mask id="reveal" maskUnits="userSpaceOnUse"><path class="draw" d="${center}" fill="none" stroke="#fff" stroke-width="${strokeWidth * scale * 2}" stroke-linecap="round" stroke-linejoin="round"/></mask></defs>${ribbon} mask="url(#reveal)"/>`
      : `${ribbon}/>`;
  } else {
    body = `<path class="draw" d="${center}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth * scale}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${bg}${body}</svg>`;
}
