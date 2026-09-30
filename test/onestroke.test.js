import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateOneStroke, samplePoints, buildNeighbors, nearestNeighborTour, twoOpt, tourLength, toSvg,
  uncross, countCrossings, segmentsIntersect, safeTensions,
} from '../public/lib/onestroke.js';

/** 白地に黒い円を描いたテスト画像 */
function circleImage(w = 160, h = 120, r = 40, thickness = 3) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - w / 2, y - h / 2);
      if (Math.abs(d - r) < thickness) {
        const p = (y * w + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = 0;
      }
    }
  }
  return { width: w, height: h, data };
}

test('線画モード: 円周上に点を置き、一本の線でつなぐ', () => {
  const img = circleImage(160, 120, 40, 1); // 細い線
  const res = generateOneStroke(img, { mode: 'lines', spacing: 3, optimizeMs: 200 });
  assert.ok(res.count > 40, `点が少なすぎる: ${res.count}`);
  for (let i = 0; i < res.count; i++) {
    const d = Math.hypot(res.points[i * 2] - 80, res.points[i * 2 + 1] - 60);
    assert.ok(Math.abs(d - 40) < 5, '点が円の上にない');
  }
  // 円周 ≈ 251px。一筆書きの長さは円周に近いはず（大きく遠回りしない）
  assert.ok(res.length < 251 * 1.3, `経路が長すぎる: ${res.length}`);
});

test('輪郭モードと陰影モードも点を生成する', () => {
  const img = circleImage();
  for (const mode of ['edges', 'shade']) {
    const res = generateOneStroke(img, { mode, optimizeMs: 100 });
    assert.ok(res.count > 20, `${mode}: ${res.count}`);
  }
});

test('暗い背景は自動で反転される', () => {
  const img = circleImage();
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255 - img.data[i];
  }
  const res = generateOneStroke(img, { mode: 'lines', optimizeMs: 100 });
  assert.ok(res.count > 40 && res.count < 500, `反転されていない: ${res.count}`);
});

test('2-opt は巡回路を短くし、全点を1回ずつ通る', () => {
  const w = 200, h = 200;
  const weight = new Float32Array(w * h).fill(1);
  const pts = samplePoints(weight, w, h, { seed: 7, spacing: 8, maxPoints: 600 });
  const n = pts.length / 2;
  const tour = nearestNeighborTour(pts);
  const before = tourLength(pts, tour, true);
  twoOpt(pts, tour, buildNeighbors(pts, 10), 2000);
  const after = tourLength(pts, tour, true);
  assert.ok(after < before, `${after} >= ${before}`);
  assert.equal(new Set(tour).size, n);
});

test('SVG は単一の path を持つ', () => {
  const res = generateOneStroke(circleImage(), { mode: 'lines', optimizeMs: 50 });
  const svg = toSvg(res, { scale: 2 });
  assert.equal((svg.match(/<path /g) || []).length, 1);
  assert.match(svg, /viewBox="0 0 320 240"/);
});

test('線画モードは太い線を中心線にしてから点を置く', () => {
  const img = circleImage(160, 120, 40, 4); // 幅 8px の太い輪
  const res = generateOneStroke(img, { mode: 'lines', spacing: 3, optimizeMs: 200 });
  assert.ok(res.length < 251 * 1.3, `ジグザグしている: ${res.length}`);
});

test('spacing: auto は点数を maxPoints 付近に合わせる', () => {
  const img = circleImage(300, 300, 120, 1);
  for (const maxPoints of [80, 200]) {
    const res = generateOneStroke(img, { mode: 'lines', maxPoints, optimizeMs: 50 });
    assert.ok(res.count <= maxPoints && res.count > maxPoints * 0.8, `${maxPoints}: ${res.count}`);
  }
});

/** 総当たりで交差（接触・重なり含む）している辺の組を数える */
function bruteCrossings(pts, count) {
  const idx = Int32Array.from({ length: count }, (_, i) => i);
  let c = 0;
  for (let i = 0; i + 1 < count; i++) {
    for (let j = i + 2; j + 1 < count; j++) {
      if (segmentsIntersect(pts, idx[i], idx[i + 1], idx[j], idx[j + 1])) c++;
    }
  }
  return c;
}

test('uncross はランダムな経路の交差をすべてなくし、全点を保つ', () => {
  const rand = (() => { let s = 3; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const n = 400;
  const pts = new Float32Array(n * 2).map(() => rand() * 300);
  const tour = Int32Array.from({ length: n }, (_, i) => i); // ランダム順＝交差だらけ
  assert.ok(bruteCrossings(reorderForTest(pts, tour), n) > 1000);
  uncross(pts, tour);
  const out = reorderForTest(pts, tour);
  assert.equal(bruteCrossings(out, n), 0);
  assert.equal(countCrossings(out, n), 0);
  assert.equal(new Set(tour).size, n);
});

function reorderForTest(pts, tour) {
  const out = new Float32Array(tour.length * 2);
  tour.forEach((t, i) => { out[i * 2] = pts[t * 2]; out[i * 2 + 1] = pts[t * 2 + 1]; });
  return out;
}

test('countCrossings は総当たりと一致する', () => {
  const rand = (() => { let s = 11; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const n = 300;
  const pts = new Float32Array(n * 2).map(() => rand() * 200);
  assert.equal(countCrossings(pts, n), bruteCrossings(pts, n));
});

test('全モードで生成結果に交差がない', () => {
  // 円と十字を重ねた画像（交差しやすい形）
  const img = circleImage(200, 200, 70, 2);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    if (Math.abs(x - 100) < 2 || Math.abs(y - 100) < 2 || Math.abs(x - y) < 2) {
      const p = (y * 200 + x) * 4; img.data[p] = img.data[p + 1] = img.data[p + 2] = 0;
    }
  }
  for (const mode of ['edges', 'lines', 'shade']) {
    const res = generateOneStroke(img, { mode, maxPoints: 1500, optimizeMs: 100 });
    assert.equal(bruteCrossings(res.points, res.count), 0, mode);
  }
});

test('曲線化して書き出した SVG も交差しない', () => {
  const img = circleImage(200, 200, 70, 2);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    if (Math.abs(x - y) < 2 || Math.abs(x + y - 200) < 2) {
      const p = (y * 200 + x) * 4; img.data[p] = img.data[p + 1] = img.data[p + 2] = 0;
    }
  }
  for (const mode of ['edges', 'lines', 'shade']) {
    const res = generateOneStroke(img, { mode, maxPoints: 1500, optimizeMs: 100 });
    for (const smooth of [0.6, 1]) {
      const svg = toSvg(res, { scale: 2, smooth, tensions: safeTensions(res.points, res.count, smooth, 2) });
      const flat = flattenPath(svg.match(/ d="([^"]+)"/)[1], 48);
      assert.equal(countCrossings(flat, flat.length / 2), 0, `${mode} smooth=${smooth}`);
    }
  }
});

/** SVG の path（M/L/C のみ）を細かい折れ線にする */
function flattenPath(d, steps) {
  const tok = d.match(/[MLC]|-?[\d.]+/g);
  const out = [];
  let x = 0, y = 0;
  for (let i = 0; i < tok.length;) {
    const c = tok[i++];
    if (c !== 'C') { x = +tok[i++]; y = +tok[i++]; out.push(x, y); continue; }
    const [a, b, e, f, g, h] = tok.slice(i, i + 6).map(Number);
    i += 6;
    for (let s = 1; s <= steps; s++) {
      const u = s / steps, v = 1 - u;
      out.push(v * v * v * x + 3 * v * v * u * a + 3 * v * u * u * e + u * u * u * g,
        v * v * v * y + 3 * v * v * u * b + 3 * v * u * u * f + u * u * u * h);
    }
    x = g; y = h;
  }
  return new Float32Array(out);
}
