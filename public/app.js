import { toSvg } from './lib/onestroke.js';

const $ = (id) => document.getElementById(id);

// 解析に使う画像の長辺(px)。大きいほど細部を拾えるが遅くなる。
const ANALYSIS_SIZE = 640;
// 出力 SVG は解析解像度の何倍で書き出すか
const OUTPUT_SCALE = 2;

const MODE_HELP = {
  edges: '写真向き。明るさが変わる境目（輪郭）をなぞります。',
  lines: 'イラスト・線画・文字向き。暗い線の中心をなぞります。',
  shade: '暗いところほど線が密になる、点描風の陰影表現です。',
};

const FONTS = {
  sans: '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif',
  serif: '"Hiragino Mincho ProN", "Noto Serif JP", "Yu Mincho", serif',
  rounded: '"Hiragino Maru Gothic ProN", "M PLUS Rounded 1c", "Arial Rounded MT Bold", sans-serif',
  cursive: '"Snell Roundhand", "Segoe Script", "Brush Script MT", cursive',
};

const state = {
  source: null, // { width, height, data } 解析用の画像
  result: null, // 一筆書きの点列
  jobId: 0,
};

// ---------------------------------------------------------------------------
// Worker

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.id !== state.jobId) return; // 古いジョブの結果は捨てる
  if (msg.type === 'progress') {
    const label = { analyze: '画像を解析中…', sample: '線をたどる点を配置中…', route: '一本の線でつなぎ中…', done: '仕上げ中…' }[msg.stage];
    setBusy(label, msg.stage === 'route' ? msg.ratio : null);
  } else if (msg.type === 'result') {
    state.result = msg.result;
    setBusy(null);
    render(true);
  } else if (msg.type === 'error') {
    setBusy(null);
    showError(`生成に失敗しました: ${msg.message}`);
  }
};

function settings() {
  return {
    mode: document.querySelector('input[name="mode"]:checked').value,
    maxPoints: Number($('detail').value),
    threshold: Number($('threshold').value),
    smooth: Number($('smooth').value),
    strokeWidth: Number($('stroke-width').value),
    stroke: $('stroke-color').value,
    background: $('bg-transparent').checked ? 'transparent' : $('bg-color').value,
  };
}

function generate() {
  if (!state.source) return;
  showError(null);
  const s = settings();
  const id = ++state.jobId;
  setBusy('画像を解析中…', 0);
  // 画像データは Worker 側でも使い回さないのでコピーを渡す
  const image = { width: state.source.width, height: state.source.height, data: state.source.data.slice() };
  worker.postMessage({
    id,
    image,
    options: {
      mode: s.mode,
      maxPoints: s.maxPoints,
      threshold: s.threshold,
      // 点が多いほど経路最適化に時間をかける
      optimizeMs: Math.min(4000, 600 + s.maxPoints * 0.4),
    },
  }, [image.data.buffer]);
}

// ---------------------------------------------------------------------------
// 描画

function buildSvg() {
  const s = settings();
  return toSvg(state.result, {
    scale: OUTPUT_SCALE,
    smooth: s.smooth,
    stroke: s.stroke,
    strokeWidth: s.strokeWidth * OUTPUT_SCALE,
    background: s.background,
  });
}

function render(animate = false) {
  const r = state.result;
  if (!r) return;
  $('placeholder').hidden = true;
  if (r.count < 2) {
    $('svg-holder').innerHTML = '';
    $('stats').textContent = '';
    showError('線が見つかりませんでした。「しきい値」を下げるか、スタイルを変えてみてください。');
    setActions(false);
    return;
  }
  // buildSvg は数値と検証済みの色だけから組み立てるので innerHTML で安全
  $('svg-holder').innerHTML = buildSvg();
  const ratio = r.length / r.width;
  $('stats').textContent = `${r.count.toLocaleString()} 点を 1 本の線でつなぎました（線の長さは画像の幅の約 ${Math.round(ratio)} 倍）`;
  setActions(true);
  if (animate) playDrawing();
}

function playDrawing() {
  const path = $('svg-holder').querySelector('path');
  if (!path) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const len = path.getTotalLength();
  const duration = Math.min(9000, 2500 + state.result.count * 1.2);
  path.style.transition = 'none';
  path.style.strokeDasharray = `${len} ${len}`;
  path.style.strokeDashoffset = `${len}`;
  path.getBoundingClientRect(); // リフローさせてから遷移開始
  path.style.transition = `stroke-dashoffset ${duration}ms linear`;
  path.style.strokeDashoffset = '0';
}

function setActions(enabled) {
  for (const id of ['replay', 'dl-svg', 'dl-png']) $(id).disabled = !enabled;
}

function setBusy(label, ratio = null) {
  $('busy').hidden = !label;
  if (!label) return;
  $('busy-label').textContent = label;
  const bar = $('busy').querySelector('.bar');
  bar.classList.toggle('indeterminate', ratio == null);
  $('bar-fill').style.width = ratio == null ? '' : `${Math.round(ratio * 100)}%`;
}

function showError(message) {
  $('error').hidden = !message;
  $('error').textContent = message || '';
}

// ---------------------------------------------------------------------------
// 入力 → 解析用画像

function useCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  state.source = { width, height, data: ctx.getImageData(0, 0, width, height).data };
  const preview = $('source-canvas');
  preview.width = width;
  preview.height = height;
  preview.getContext('2d').drawImage(canvas, 0, 0);
  $('source-figure').hidden = false;
  generate();
}

function drawableToCanvas(source, w, h, background = '#ffffff') {
  const scale = Math.min(1, ANALYSIS_SIZE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showError('画像ファイルを選んでください。');
    return;
  }
  try {
    const bitmap = await createImageBitmap(file);
    useCanvas(drawableToCanvas(bitmap, bitmap.width, bitmap.height, null));
  } catch {
    // SVG など createImageBitmap が扱えない形式
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      useCanvas(drawableToCanvas(img, img.naturalWidth || 512, img.naturalHeight || 512, null));
    } catch {
      showError('この画像は読み込めませんでした。');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** SVG 文字列を <img> 経由でラスタライズ（スクリプトは実行されない） */
async function svgToCanvas(svgText) {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const size = 512;
    return drawableToCanvas(img, size, size);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function renderText() {
  const text = $('text-input').value.trim();
  if (!text) {
    showError('文字を入力してください。');
    return;
  }
  const family = FONTS[$('font-select').value];
  const lines = text.split(/\n/).slice(0, 4);
  const fontSize = 200;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `700 ${fontSize}px ${family}`;
  const textW = Math.max(...lines.map((l) => measure.measureText(l).width));
  const lineH = fontSize * 1.25;
  const pad = fontSize * 0.3;
  const w = Math.ceil(textW + pad * 2), h = Math.ceil(lineH * lines.length + pad * 2);

  const big = document.createElement('canvas');
  big.width = w;
  big.height = h;
  const ctx = big.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.font = measure.font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  lines.forEach((l, i) => ctx.fillText(l, w / 2, pad + lineH * (i + 0.5)));
  useCanvas(drawableToCanvas(big, w, h));
}

async function renderAi() {
  const prompt = $('ai-input').value.trim();
  if (!prompt) {
    showError('描きたいものを入力してください。');
    return;
  }
  showError(null);
  $('ai-go').disabled = true;
  state.jobId++; // 進行中の生成結果を無効化
  setBusy('AI が下絵を描いています…（30 秒ほど）');
  try {
    const res = await fetch('/api/text-to-svg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `サーバーエラー (${res.status})`);
    setMode('lines');
    useCanvas(await svgToCanvas(body.svg));
  } catch (err) {
    setBusy(null);
    showError(err instanceof TypeError
      ? 'サーバーに接続できませんでした。「文章から絵」は npm start で起動したサーバーが必要です。'
      : err.message);
  } finally {
    $('ai-go').disabled = false;
  }
}

async function loadSample() {
  const res = await fetch('samples/coffee.svg');
  setMode('lines');
  useCanvas(await svgToCanvas(await res.text()));
}

// ---------------------------------------------------------------------------
// UI 配線

function setMode(mode) {
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  $('mode-help').textContent = MODE_HELP[mode];
}

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[role="tab"]')) t.setAttribute('aria-selected', String(t === tab));
    for (const b of document.querySelectorAll('.tab-body')) b.hidden = b.dataset.body !== tab.dataset.tab;
  });
}

const dz = $('dropzone');
$('file').addEventListener('change', (e) => loadImageFile(e.target.files[0]));
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  loadImageFile(e.dataTransfer.files[0]);
});
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) loadImageFile(item.getAsFile());
});
$('sample-btn').addEventListener('click', loadSample);
$('text-go').addEventListener('click', () => { setMode('edges'); renderText(); });
$('ai-go').addEventListener('click', renderAi);

// 再計算が必要な設定（少し待ってから実行）
let timer;
const regenerate = () => { clearTimeout(timer); timer = setTimeout(generate, 250); };
for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.addEventListener('change', () => { setMode(input.value); generate(); });
}
$('detail').addEventListener('input', regenerate);
$('threshold').addEventListener('input', regenerate);

// 見た目だけの設定（再計算なし）
for (const id of ['smooth', 'stroke-width', 'stroke-color', 'bg-color', 'bg-transparent']) {
  $(id).addEventListener('input', () => render(false));
}

function syncOutputs() {
  $('detail-out').textContent = `${Number($('detail').value).toLocaleString()} 点`;
  $('threshold-out').textContent = Number($('threshold').value).toFixed(2);
  $('smooth-out').textContent = Number($('smooth').value).toFixed(2);
  $('width-out').textContent = Number($('stroke-width').value).toFixed(1);
}
document.querySelector('.settings').addEventListener('input', syncOutputs);
syncOutputs();
setMode('edges');

$('replay').addEventListener('click', playDrawing);

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('dl-svg').addEventListener('click', () => {
  download(new Blob([buildSvg()], { type: 'image/svg+xml' }), 'one-line-drawing.svg');
});

$('dl-png').addEventListener('click', async () => {
  const url = URL.createObjectURL(new Blob([buildSvg()], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    canvas.toBlob((blob) => download(blob, 'one-line-drawing.png'), 'image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
});
