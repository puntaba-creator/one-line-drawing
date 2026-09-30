import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSvg } from '../server.js';

test('extractSvg は SVG 部分だけを取り出し、危険な要素を落とす', () => {
  const text = 'はい！\n<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script>' +
    '<image href="https://example.com/x.png"/><path d="M0 0L10 10"/></svg>\n以上です';
  const svg = extractSvg(text);
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  assert.doesNotMatch(svg, /script|onload|href/);
  assert.match(svg, /<path d="M0 0L10 10"\/>/);
});

test('extractSvg は SVG が無ければ null', () => {
  assert.equal(extractSvg('ごめんなさい'), null);
});
