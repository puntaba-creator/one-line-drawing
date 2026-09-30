// 線をたどる経路づくり（輪郭・線画モード用）
//
// 点をばらまいて巡回路を解く方式だと、1 本の輪郭を何度にも分けて訪れてしまい、
// そのたびに長いつなぎ線が絵を横切る。そこで:
//   1. 細線化した画素から「ひと続きの線（チェーン）」を取り出す
//   2. チェーンを描く順番と向き（閉じた線なら描き始める位置）を、つなぎ線が短くなるよう最適化
//   3. 順番どおりにつないで 1 本の折れ線にする
// こうすると輪郭の形はそのまま保たれ、つなぎ線はチェーンの数 − 1 本だけになる。

const OFFS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

/**
 * 8 近傍のうち「実際につながっている」隣を返す。
 * 斜めの隣は、間の縦横どちらかの画素が埋まっていれば経由できるので省く（m-連結）。
 * これで階段状の線に偽の分岐点ができない。
 */
function neighbors(bin, w, h, x, y, out) {
  out.length = 0;
  for (let k = 0; k < 8; k++) {
    const [dx, dy] = OFFS[k];
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h || !bin[ny * w + nx]) continue;
    if (k >= 4 && (bin[y * w + nx] || bin[ny * w + x])) continue;
    out.push(ny * w + nx);
  }
  return out;
}

/**
 * 1 画素幅の線画像から、分岐点・端点で区切ったチェーン（画素番号の列）と閉じた輪を取り出す。
 * @returns {{ open: number[][], loops: number[][] }}
 */
export function traceChains(bin, w, h) {
  const deg = new Uint8Array(w * h);
  const nb = [];
  for (let i = 0; i < bin.length; i++) {
    if (bin[i]) deg[i] = neighbors(bin, w, h, i % w, (i / w) | 0, nb).length;
  }
  const used = new Set(); // 通った辺（画素の組）
  const key = (a, b) => (a < b ? a * bin.length + b : b * bin.length + a);
  const visited = new Uint8Array(w * h);
  const open = [], loops = [];

  const walk = (start, next) => {
    const chain = [start, next];
    used.add(key(start, next));
    visited[start] = visited[next] = 1;
    let prev = start, cur = next;
    while (deg[cur] === 2) {
      neighbors(bin, w, h, cur % w, (cur / w) | 0, nb);
      const nxt = nb[0] === prev ? nb[1] : nb[0];
      if (used.has(key(cur, nxt))) break;
      used.add(key(cur, nxt));
      chain.push(nxt);
      visited[nxt] = 1;
      prev = cur; cur = nxt;
      if (cur === start) break;
    }
    return chain;
  };

  // 端点・分岐点から出る線
  for (let i = 0; i < bin.length; i++) {
    if (!bin[i] || deg[i] === 2) continue;
    if (deg[i] === 0) { open.push([i]); visited[i] = 1; continue; }
    for (const j of [...neighbors(bin, w, h, i % w, (i / w) | 0, nb)]) {
      if (!used.has(key(i, j))) open.push(walk(i, j));
    }
  }
  // 分岐点は最初に通るチェーンだけが持つ（同じ点を二度通ると線が触れ合ってしまう）
  const claimed = new Uint8Array(w * h);
  for (const c of open) {
    if (c.length < 2) continue;
    for (const end of [0, c.length - 1]) {
      const p = c[end];
      if (deg[p] < 3) continue;
      if (!claimed[p]) { claimed[p] = 1; continue; }
      if (c.length > 2) { if (end === 0) c.shift(); else c.pop(); }
    }
  }
  // 残りは分岐のない閉じた輪
  for (let i = 0; i < bin.length; i++) {
    if (!bin[i] || visited[i]) continue;
    neighbors(bin, w, h, i % w, (i / w) | 0, nb);
    const chain = walk(i, nb[0]);
    if (chain[chain.length - 1] === i) chain.pop();
    loops.push(chain);
  }
  return { open, loops };
}

/** 画素番号の列を座標列にし、軽くならして間隔 step で打ち直す。 */
function toPolyline(pixels, w, step, closed) {
  const n = pixels.length;
  const xs = pixels.map((i) => i % w), ys = pixels.map((i) => (i / w) | 0);
  // 画素の階段を取る移動平均（端点は動かさない）
  const sx = xs.slice(), sy = ys.slice();
  for (let it = 0; it < 2; it++) {
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) continue;
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      sx[i] = (xs[a] + 2 * xs[i] + xs[b]) / 4;
      sy[i] = (ys[a] + 2 * ys[i] + ys[b]) / 4;
    }
    for (let i = 0; i < n; i++) { xs[i] = sx[i]; ys[i] = sy[i]; }
  }
  if (closed) { xs.push(xs[0]); ys.push(ys[0]); }
  // 弧長に沿って step ごとに打ち直す
  const out = [xs[0], ys[0]];
  let carry = 0;
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i] - xs[i - 1], dy = ys[i] - ys[i - 1];
    const len = Math.hypot(dx, dy);
    let t = step - carry;
    while (t <= len) {
      out.push(xs[i - 1] + (dx * t) / len, ys[i - 1] + (dy * t) / len);
      t += step;
    }
    carry = len - (t - step);
  }
  const lx = xs[xs.length - 1], ly = ys[ys.length - 1];
  if (closed) {
    // 閉じた輪は始点に戻る直前で止める（始点と重複させない）
    if (Math.hypot(out[out.length - 2] - lx, out[out.length - 1] - ly) < step * 0.5) out.length -= 2;
  } else if (Math.hypot(out[out.length - 2] - lx, out[out.length - 1] - ly) > 1e-6) {
    out.push(lx, ly);
  }
  return out;
}

function pathLength(poly, closed) {
  let s = 0;
  const n = poly.length / 2;
  for (let i = 1; i < n; i++) s += Math.hypot(poly[i * 2] - poly[i * 2 - 2], poly[i * 2 + 1] - poly[i * 2 - 1]);
  if (closed && n > 1) s += Math.hypot(poly[0] - poly[n * 2 - 2], poly[1] - poly[n * 2 - 1]);
  return s;
}

/**
 * チェーンを描く順番・向き・（輪なら）描き始めの位置を決める。
 * 最寄りのチェーンを貪欲に選んだあと、並びの部分反転（2-opt）でつなぎ線の合計を縮める。
 */
export function orderChains(items, budgetMs = 800) {
  const k = items.length;
  if (k === 0) return [];
  // 輪の入口候補（全点だと多いので間引く）
  const entries = (it) => {
    const n = it.pts.length / 2;
    if (!it.closed) return [0];
    const stride = Math.max(1, Math.floor(n / 64));
    const out = [];
    for (let i = 0; i < n; i += stride) out.push(i);
    return out;
  };
  const px = (it, i) => it.pts[i * 2], py = (it, i) => it.pts[i * 2 + 1];
  // 入口/出口の座標。開いた線は rev で向きが反転、輪は start で開始点
  const head = (s) => (s.it.closed ? s.start : s.rev ? s.it.pts.length / 2 - 1 : 0);
  const tail = (s) => (s.it.closed ? s.start : s.rev ? 0 : s.it.pts.length / 2 - 1);
  const d = (a, ia, b, ib) => Math.hypot(px(a, ia) - px(b, ib), py(a, ia) - py(b, ib));

  // 貪欲法: 左上に近いところから始め、いまの位置から最寄りの入口へ
  const left = new Set(items.map((_, i) => i));
  const seq = [];
  let cx = 0, cy = 0;
  while (left.size) {
    let best = null, bestD = Infinity;
    for (const idx of left) {
      const it = items[idx];
      const n = it.pts.length / 2;
      const cand = it.closed ? entries(it).map((e) => [e, false]) : [[0, false], [n - 1, true]];
      for (const [e, rev] of cand) {
        const dd = Math.hypot(px(it, e) - cx, py(it, e) - cy);
        if (dd < bestD) { bestD = dd; best = { it, start: e, rev }; best.idx = idx; }
      }
    }
    left.delete(best.idx);
    seq.push(best);
    const t = tail(best);
    cx = px(best.it, t); cy = py(best.it, t);
  }

  // 2-opt: seq[i+1..j] を逆順にし、それぞれの向きも反転する
  const gap = (a, b) => d(a.it, tail(a), b.it, head(b));
  const start = Date.now();
  let improved = true;
  while (improved && Date.now() - start < budgetMs) {
    improved = false;
    for (let i = 0; i < k - 1; i++) {
      for (let j = i + 1; j < k; j++) {
        const a = seq[i], b = seq[i + 1], c = seq[j], e = seq[j + 1];
        // 反転後: a → c(反転) … b(反転) → e
        const before = gap(a, b) + (e ? gap(c, e) : 0);
        const cr = { ...c, rev: !c.rev }, br = { ...b, rev: !b.rev };
        const after = gap(a, cr) + (e ? gap(br, e) : 0);
        if (after < before - 1e-6) {
          const mid = seq.slice(i + 1, j + 1).reverse().map((s) => ({ ...s, rev: !s.rev }));
          seq.splice(i + 1, mid.length, ...mid);
          improved = true;
        }
      }
      if (Date.now() - start > budgetMs) break;
    }
  }

  // 輪の描き始めを、前後のつなぎ線が最短になる位置に取り直す
  for (let s = 0; s < k; s++) {
    const cur = seq[s];
    if (!cur.it.closed) continue;
    const prev = seq[s - 1], next = seq[s + 1];
    let best = cur.start, bestCost = Infinity;
    for (const e of entries(cur.it)) {
      const cost = (prev ? d(prev.it, tail(prev), cur.it, e) : 0) + (next ? d(cur.it, e, next.it, head(next)) : 0);
      if (cost < bestCost) { bestCost = cost; best = e; }
    }
    cur.start = best;
  }
  return seq;
}

/** 並べたチェーンを 1 本の折れ線にする。輪は一周して入口に戻る。 */
export function joinChains(seq) {
  const out = [];
  for (const s of seq) {
    const p = s.it.pts, n = p.length / 2;
    if (s.it.closed) {
      for (let k = 0; k <= n; k++) {
        const i = (s.start + k) % n;
        out.push(p[i * 2], p[i * 2 + 1]);
      }
    } else if (s.rev) {
      for (let i = n - 1; i >= 0; i--) out.push(p[i * 2], p[i * 2 + 1]);
    } else {
      for (let i = 0; i < n; i++) out.push(p[i * 2], p[i * 2 + 1]);
    }
  }
  // 同じ座標を二度通らないようにする（チェーンの継ぎ目や分岐点で重なる点を除く）。
  // 二度目以降の点を抜くだけなので、形は 1 画素ほどしか変わらない
  const res = [];
  const seen = new Set();
  for (let i = 0; i < out.length; i += 2) {
    const k = `${Math.round(out[i] * 1000)},${Math.round(out[i + 1] * 1000)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    res.push(out[i], out[i + 1]);
  }
  return new Float32Array(res);
}

/**
 * 線の画素（weight > 0）から 1 本の折れ線を作る。
 * maxPoints: 点の数の目安（線を打ち直す間隔を決める）、minLength: これより短い孤立した線は捨てる。
 */
export function chainRoute(weight, w, h, { maxPoints = 2500, minLength = 6, budgetMs = 800 } = {}) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = weight[i] > 0 ? 1 : 0;
  const { open, loops } = traceChains(bin, w, h);
  // 孤立した短い線（両端とも端点）はノイズとして捨てる
  const deg = (i) => {
    const x = i % w, y = (i / w) | 0;
    return neighbors(bin, w, h, x, y, []).length;
  };
  const keepOpen = open.filter((c) => c.length >= minLength || deg(c[0]) > 1 || deg(c[c.length - 1]) > 1);
  const keepLoops = loops.filter((c) => c.length >= minLength);
  let total = 0;
  for (const c of keepOpen) total += c.length;
  for (const c of keepLoops) total += c.length;
  const step = Math.max(1.2, total / Math.max(1, maxPoints));
  const items = [
    ...keepOpen.map((c) => ({ pts: toPolyline(c, w, step, false), closed: false })),
    ...keepLoops.map((c) => ({ pts: toPolyline(c, w, step, true), closed: true })),
  ].filter((it) => it.pts.length >= 2);
  for (const it of items) if (it.closed && it.pts.length < 6) it.closed = false;
  const seq = orderChains(items, budgetMs);
  return { points: joinChains(seq), chains: items.length, step, drawn: items.reduce((s, it) => s + pathLength(it.pts, it.closed), 0) };
}
