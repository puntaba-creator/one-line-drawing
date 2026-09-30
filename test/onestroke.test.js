import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateOneStroke, samplePoints, buildNeighbors, nearestNeighborTour, twoOpt, tourLength, toSvg,
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
