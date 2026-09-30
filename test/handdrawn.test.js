import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOneStroke, countCrossings } from '../public/lib/onestroke.js';
import { stylize, resample, keepClearance, clearanceViolations, pressure, toHandSvg } from '../public/lib/handdrawn.js';

/** 近接した平行線や交差しそうな線が多い画像: 細い間隔の縞 + 円 */
function busyImage(w = 220, h = 220) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - 110, y - 110);
    const stripe = y > 30 && y < 90 && x > 20 && x < 200 && y % 7 < 2;
    if (Math.abs(d - 60) < 1.5 || stripe || Math.abs(x - y) < 1.2) {
      const p = (y * w + x) * 4; data[p] = data[p + 1] = data[p + 2] = 0;
    }
  }
  return { width: w, height: h, data };
}

test('手描き風に仕上げても交差しない', () => {
  for (const mode of ['edges', 'lines', 'shade']) {
    const raw = generateOneStroke(busyImage(), { mode, maxPoints: 1500, optimizeMs: 100 });
    for (const hand of [0, 0.5, 1]) {
      const res = stylize(raw, { hand, gap: 2, strokeWidth: 1.6 });
      assert.equal(countCrossings(res.points, res.count), 0, `${mode} hand=${hand}`);
    }
  }
});

test('すき間: 近づきすぎた箇所を大きく減らし、元の位置から離しすぎない', () => {
  const raw = generateOneStroke(busyImage(), { mode: 'lines', maxPoints: 2000, optimizeMs: 200 });
  const target = 4, step = 1.6;
  const p = resample(raw.points, raw.count, step);
  const n = p.length / 2;
  const orig = p.slice();
  const before = clearanceViolations(p, n, target, step);
  keepClearance(p, n, target, { step });
  const after = clearanceViolations(p, n, target, step);
  assert.ok(before > 50, `テスト画像に近接箇所が少ない: ${before}`);
  assert.ok(after < before * 0.1, `${before} → ${after}`);
  let maxShift = 0;
  for (let i = 0; i < n; i++) maxShift = Math.max(maxShift, Math.hypot(p[i * 2] - orig[i * 2], p[i * 2 + 1] - orig[i * 2 + 1]));
  assert.ok(maxShift <= target * 2 + 1e-3, `離れすぎ: ${maxShift}`);
  assert.equal(countCrossings(p, n), 0);
});

test('すき間 0 では線を押し広げない', () => {
  const raw = generateOneStroke(busyImage(), { mode: 'lines', maxPoints: 800, optimizeMs: 50 });
  const res = stylize(raw, { hand: 0, gap: 0, smooth: 0 });
  // 打ち直しただけなので、元の頂点がすべて残っている
  const set = new Set();
  for (let i = 0; i < res.count; i++) set.add(`${res.points[i * 2]},${res.points[i * 2 + 1]}`);
  for (let i = 0; i < raw.count; i++) assert.ok(set.has(`${raw.points[i * 2]},${raw.points[i * 2 + 1]}`));
});

test('筆圧: 端は細く、曲がり角は直線より太い', () => {
  // 長い直線 → 直角 → 長い直線
  const pts = [];
  for (let x = 0; x <= 200; x += 2) pts.push(x, 0);
  for (let y = 2; y <= 200; y += 2) pts.push(200, y);
  const p = new Float32Array(pts);
  const n = p.length / 2;
  const w = pressure(p, n, 1, 1);
  const corner = 100, straight = 50;
  assert.ok(w[0] < 0.5 && w[n - 1] < 0.5, `端: ${w[0]}, ${w[n - 1]}`);
  assert.ok(w[corner] > w[straight], `角 ${w[corner]} <= 直線 ${w[straight]}`);
  assert.ok(pressure(p, n, 0, 1).every((v) => v === 1));
});

test('SVG: 筆圧ありは塗りの線、なしは一定の太さの線', () => {
  const raw = generateOneStroke(busyImage(), { mode: 'lines', maxPoints: 300, optimizeMs: 50 });
  const res = stylize(raw, {});
  assert.match(toHandSvg(res, { pressure: 0.7 }), /<path d="M[^"]+Z" fill="#111"\/>/);
  assert.match(toHandSvg(res, { pressure: 0.7, animated: true }), /<mask id="reveal"/);
  assert.match(toHandSvg(res, { pressure: 0 }), /fill="none" stroke="#111"/);
});
