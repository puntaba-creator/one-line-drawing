import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOneStroke, countCrossings, edgeMap, toChannels, toInk } from '../public/lib/onestroke.js';
import { traceChains } from '../public/lib/chains.js';
import { resample, keepClearance } from '../public/lib/handdrawn.js';

function blank(w, h, rgb = [255, 255, 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
}
function paint(img, fn, rgb) {
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (fn(x, y)) img.data.set([...rgb, 255], (y * img.width + x) * 4);
  }
}
const segLengths = (r) => Array.from({ length: r.count - 1 }, (_, i) => Math.hypot(r.points[i * 2 + 2] - r.points[i * 2], r.points[i * 2 + 3] - r.points[i * 2 + 1]));

test('traceChains: 閉じた輪・線分・分岐をそれぞれ取り出す', () => {
  const w = 40, h = 40, bin = new Uint8Array(w * h);
  // 輪（正方形の枠）
  for (let i = 5; i <= 15; i++) { bin[5 * w + i] = bin[15 * w + i] = bin[i * w + 5] = bin[i * w + 15] = 1; }
  // T 字（分岐 1 つ・枝 3 本）
  for (let x = 20; x <= 35; x++) bin[25 * w + x] = 1;
  for (let y = 26; y <= 35; y++) bin[y * w + 28] = 1;
  const { open, loops } = traceChains(bin, w, h);
  assert.equal(loops.length, 1);
  assert.equal(open.length, 3);
});

test('色だけが違う境目（明るさが同じ）も輪郭として拾う', () => {
  // 左: 青っぽい灰、右: 肌色。明るさはほぼ同じ
  // 下のほうに黒い帯（くっきりした明暗の境目）を置いて、強さの基準にする
  const img = blank(60, 60, [170, 190, 215]);
  paint(img, (x) => x >= 30, [223, 180, 140]);
  paint(img, (x, y) => y >= 45, [0, 0, 0]);
  const lumOnly = edgeMap([toInk(img)], 60, 60);
  const withColor = edgeMap([toInk(img), ...toChannels(img)], 60, 60);
  const col = (m) => Math.max(...Array.from({ length: 30 }, (_, y) => Math.max(m[(y + 5) * 60 + 29], m[(y + 5) * 60 + 30])));
  // 既定のしきい値（0.25 → エッジ強度 0.14）を超えるか
  assert.ok(col(withColor) > 0.14, `色の境目が弱い: ${col(withColor)}`);
  assert.ok(col(lumOnly) < 0.14, `明るさだけでも拾えてしまう（テスト画像が不適切）: ${col(lumOnly)}`);
  const res = generateOneStroke(img, { mode: 'edges', maxPoints: 500, optimizeMs: 50 });
  assert.ok(res.count > 10, `境目が描かれていない: ${res.count}`);
});

test('輪郭モード: 細い線は両側の 2 本ではなく中心線 1 本で描く', () => {
  const img = blank(200, 60);
  paint(img, (x, y) => x >= 20 && x < 180 && Math.abs(y - 30) <= 1, [40, 40, 40]); // 幅 3px の線
  const res = generateOneStroke(img, { mode: 'edges', maxPoints: 800, optimizeMs: 50 });
  for (let i = 0; i < res.count; i++) assert.ok(Math.abs(res.points[i * 2 + 1] - 30) < 1.5, `中心から外れた点: y=${res.points[i * 2 + 1]}`);
  assert.ok(res.length < 160 * 1.15, `二重になっている: 長さ ${res.length}`);
});

test('輪郭をひと続きに辿るので、つなぎ線はチェーンの数 − 1 本以下', () => {
  // 離れた円 3 つ（顔の目・鼻のような配置）
  const img = blank(240, 160);
  for (const [cx, cy, r] of [[60, 60, 20], [180, 60, 20], [120, 120, 12]]) {
    paint(img, (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) < 1.2, [30, 30, 30]);
  }
  const res = generateOneStroke(img, { mode: 'lines', maxPoints: 1500, optimizeMs: 200 });
  const long = segLengths(res).filter((l) => l > 6).length;
  assert.ok(long <= 2, `つなぎ線が多い: ${long}`);
  assert.equal(countCrossings(res.points, res.count), 0);
});

test('すき間を空けても、形をなす線はほとんど動かず、つなぎ線が避ける', () => {
  // 輪（形）と、その脇をかすめるつなぎ線
  const pts = [];
  for (let k = 0; k <= 120; k++) { const a = (k / 120) * Math.PI * 2 + 0.3; if (k < 120) pts.push(100 + 30 * Math.cos(a), 100 + 30 * Math.sin(a)); }
  pts.push(131.5, 20, 132, 180); // 輪の右端 (130,100) の 1.5px 外を通る長い直線
  const raw = new Float32Array(pts);
  const target = 4, step = 1.6;
  const p = resample(raw, raw.length / 2, step);
  const n = p.length / 2;
  const orig = p.slice();
  keepClearance(p, n, target, { step, mobility: p.mobility });
  let ringMax = 0, lineMax = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(p[i * 2] - orig[i * 2], p[i * 2 + 1] - orig[i * 2 + 1]);
    if (p.mobility[i] < 0.5) ringMax = Math.max(ringMax, d); else lineMax = Math.max(lineMax, d);
  }
  assert.ok(ringMax < 1.5, `形が動きすぎ: ${ringMax}`);
  assert.ok(lineMax > 1.5, `つなぎ線が避けていない: ${lineMax}`);
});
