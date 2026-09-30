// 静的ファイル配信 + 「文章 → 線画イラスト(SVG)」API
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.CLAUDE_EFFORT || 'medium';
const MAX_PROMPT_CHARS = 300;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 6;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

// API キーが無くても写真・文字モードは動くよう、クライアントは遅延生成する
let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM_PROMPT = `You are an illustrator who draws minimal line art as SVG.
The drawing will later be traced into a single continuous line, so it must read clearly as outlines.

Rules for the SVG you return:
- Root element: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">.
- Start with a white background: <rect width="512" height="512" fill="#fff"/>.
- Every other shape uses fill="none", stroke="#000", stroke-width between 3 and 6, round caps and joins.
- Use only path, line, polyline, polygon, circle, ellipse and rect. No text, images, gradients, filters, patterns, masks, scripts, styles or external references.
- One clear subject, centered, filling roughly 70% of the canvas. 15 to 60 shapes. Prefer smooth curves (C/Q commands) and a few characteristic interior details; skip hatching and shading.

Reply with the SVG code only, no explanation and no code fences.`;

/** 返答から SVG を取り出し、描画に不要な要素を落とす（クライアントは <img> 経由で描くので二重の防御） */
export function extractSvg(text) {
  const m = text.match(/<svg[\s\S]*<\/svg>/i);
  if (!m) return null;
  return m[0]
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*')/gi, '');
}

async function textToSvg(prompt) {
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    output_config: { effort: EFFORT },
    // 安全性分類器が断った場合はサーバー側で推奨モデルに自動フォールバック
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Draw: ${prompt}` }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    const err = new Error('この内容は描けませんでした。別の言葉で試してください。');
    err.status = 422;
    throw err;
  }
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const svg = extractSvg(text);
  if (!svg) {
    const err = new Error(message.stop_reason === 'max_tokens'
      ? 'イラストが複雑すぎて途中で切れました。もう少し簡単な題材で試してください。'
      : 'イラストを生成できませんでした。もう一度お試しください。');
    err.status = 502;
    throw err;
  }
  return svg;
}

// とても単純な IP 単位のレート制限（1 分あたり）
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_LIMIT_PER_MIN;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 10_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('リクエストが大きすぎます'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON が不正です'), { status: 400 });
  }
}

async function handleApi(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST のみ対応しています' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (rateLimited(ip)) return sendJson(res, 429, { error: '少し時間をおいてから試してください' });

  const body = await readJson(req);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return sendJson(res, 400, { error: '描きたいものを入力してください' });
  if (prompt.length > MAX_PROMPT_CHARS) return sendJson(res, 400, { error: `${MAX_PROMPT_CHARS} 文字以内で入力してください` });

  try {
    const svg = await textToSvg(prompt);
    sendJson(res, 200, { svg });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('Anthropic API の認証に失敗しました。ANTHROPIC_API_KEY を確認してください。');
      return sendJson(res, 503, { error: 'AI イラスト機能は現在利用できません（サーバー設定）' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return sendJson(res, 429, { error: '混み合っています。少し時間をおいてから試してください' });
    }
    if (err instanceof Anthropic.APIError) {
      console.error('Anthropic API error', err.status, err.message);
      return sendJson(res, 502, { error: 'AI イラストの生成に失敗しました' });
    }
    if (err.status) return sendJson(res, err.status, { error: err.message });
    // 認証情報が見つからない場合など
    console.error(err);
    return sendJson(res, 503, { error: 'AI イラスト機能は現在利用できません（サーバー設定）' });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/text-to-svg')) return await handleApi(req, res);
    return await serveStatic(req, res);
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'サーバーエラー' });
    else res.end();
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`一筆書きメーカー: http://localhost:${PORT}`));
}

export { server };
