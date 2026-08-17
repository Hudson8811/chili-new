import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const startUrl = new URL(process.argv[2] || 'https://pulkovoservice.ru/');
const outputRoot = path.resolve(process.argv[3] || 'pulkovoservice-local');
const startOrigin = startUrl.origin;
const urlToLocal = new Map();
const queue = [];
const textFiles = [];
const failures = [];

const assetExtensions = new Set([
  '.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm',
  '.mp3', '.wav', '.pdf', '.json', '.xml'
]);

function normalizeUrl(raw, base) {
  if (!raw || /^(?:data:|blob:|mailto:|tel:|javascript:|#)/i.test(raw.trim())) return null;
  try {
    const url = new URL(raw.trim().replace(/&amp;/g, '&'), base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function cleanSegment(segment) {
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch {}
  const cleaned = decoded.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  return cleaned || '_';
}

function localNameFor(url) {
  const parts = url.pathname.split('/').filter(Boolean).map(cleanSegment);
  let relative;
  if (url.origin === startOrigin) {
    relative = parts.join('/');
  } else {
    relative = ['_external', cleanSegment(url.hostname), ...parts].join('/');
  }
  if (!relative || url.pathname.endsWith('/')) relative = path.posix.join(relative, 'index.html');
  const ext = path.posix.extname(relative);
  if (!ext) {
    const typeHint = url.searchParams.get('format');
    if (typeHint && /^[a-z0-9]+$/i.test(typeHint)) relative += `.${typeHint}`;
  }
  return relative;
}

function keyFor(url) {
  return url.href;
}

function enqueue(url, forcedLocal = null) {
  const key = keyFor(url);
  if (urlToLocal.has(key)) return urlToLocal.get(key);
  let local = forcedLocal || localNameFor(url);
  const existing = new Set(urlToLocal.values());
  if (existing.has(local)) {
    const ext = path.posix.extname(local);
    const stem = ext ? local.slice(0, -ext.length) : local;
    const suffix = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
    local = `${stem}-${suffix}${ext}`;
  }
  urlToLocal.set(key, local);
  queue.push({ url, local });
  return local;
}

function shouldFetch(raw, tag, attr, base) {
  const url = normalizeUrl(raw, base);
  if (!url) return null;
  if (attr.toLowerCase() !== 'href') return url;
  const lowerTag = tag.toLowerCase();
  if (/<link\b/.test(lowerTag)) return url;
  return assetExtensions.has(path.posix.extname(url.pathname).toLowerCase()) ? url : null;
}

function discoverHtml(html, base) {
  const tagRe = /<[^>]+>/g;
  for (const match of html.matchAll(tagRe)) {
    const tag = match[0];
    const attrRe = /\b(src|href|poster|data-src|data-lazy-src|data-original)\s*=\s*(["'])(.*?)\2/gi;
    for (const attr of tag.matchAll(attrRe)) {
      const url = shouldFetch(attr[3], tag, attr[1], base);
      if (url) enqueue(url);
    }
    const srcsetRe = /\b(srcset|data-srcset)\s*=\s*(["'])(.*?)\2/gi;
    for (const attr of tag.matchAll(srcsetRe)) {
      for (const item of attr[3].split(',')) {
        const raw = item.trim().split(/\s+/)[0];
        const url = normalizeUrl(raw, base);
        if (url) enqueue(url);
      }
    }
  }
  for (const match of html.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    const url = normalizeUrl(match[2], base);
    if (url) enqueue(url);
  }
}

function discoverCss(css, base) {
  for (const match of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    const url = normalizeUrl(match[2], base);
    if (url) enqueue(url);
  }
  for (const match of css.matchAll(/@import\s+(?:url\(\s*)?(["'])(.*?)\1\s*\)?/gi)) {
    const url = normalizeUrl(match[2], base);
    if (url) enqueue(url);
  }
}

function relativeReference(fromLocal, targetLocal) {
  let rel = path.posix.relative(path.posix.dirname(fromLocal), targetLocal);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return encodeURI(rel).replace(/#/g, '%23');
}

function rewriteOne(raw, base, fromLocal) {
  const url = normalizeUrl(raw, base);
  if (!url) return raw;
  const local = urlToLocal.get(keyFor(url));
  return local ? relativeReference(fromLocal, local) : raw;
}

function rewriteText(text, base, fromLocal) {
  let rewritten = text.replace(
    /(\b(?:src|href|poster|data-src|data-lazy-src|data-original)\s*=\s*)(["'])(.*?)\2/gi,
    (_whole, prefix, quote, raw) => `${prefix}${quote}${rewriteOne(raw, base, fromLocal)}${quote}`
  );
  rewritten = rewritten.replace(
    /(\b(?:srcset|data-srcset)\s*=\s*)(["'])(.*?)\2/gi,
    (_whole, prefix, quote, value) => {
      const items = value.split(',').map(item => {
        const parts = item.trim().split(/\s+/);
        parts[0] = rewriteOne(parts[0], base, fromLocal);
        return parts.join(' ');
      });
      return `${prefix}${quote}${items.join(', ')}${quote}`;
    }
  );
  rewritten = rewritten.replace(
    /url\(\s*(["']?)(.*?)\1\s*\)/gi,
    (_whole, quote, raw) => `url(${quote}${rewriteOne(raw, base, fromLocal)}${quote})`
  );
  rewritten = rewritten.replace(
    /(@import\s+(?:url\(\s*)?)(["'])(.*?)\2(\s*\)?)/gi,
    (_whole, prefix, quote, raw, suffix) => `${prefix}${quote}${rewriteOne(raw, base, fromLocal)}${quote}${suffix}`
  );
  return rewritten.replace(/\b(?:integrity|crossorigin)\s*=\s*(["']).*?\1/gi, '');
}

async function download(item) {
  const response = await fetch(item.url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; local-layout-mirror/1.0)' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  const ext = path.posix.extname(item.local).toLowerCase();
  const isText = /(?:text|javascript|json|xml|svg)/i.test(contentType) || ['.css', '.js', '.mjs', '.svg', '.json', '.xml', '.html'].includes(ext);
  if (isText) {
    const text = buffer.toString('utf8');
    textFiles.push({ ...item, text, contentType });
    if (ext === '.css' || /text\/css/i.test(contentType)) discoverCss(text, item.url);
  } else {
    const fullPath = path.join(outputRoot, ...item.local.split('/'));
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);
  }
}

await fs.mkdir(outputRoot, { recursive: true });
enqueue(startUrl, 'index.html');

let cursor = 0;
while (cursor < queue.length) {
  const batch = queue.slice(cursor, cursor + 8);
  cursor += batch.length;
  await Promise.all(batch.map(async item => {
    try {
      await download(item);
      if (item.local === 'index.html') {
        const entry = textFiles.find(file => file.local === 'index.html');
        if (entry) discoverHtml(entry.text, item.url);
      }
    } catch (error) {
      failures.push({ url: item.url.href, error: String(error.message || error) });
    }
  }));
}

for (const file of textFiles) {
  const rewritten = rewriteText(file.text, file.url, file.local);
  const fullPath = path.join(outputRoot, ...file.local.split('/'));
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, rewritten, 'utf8');
}

const manifest = {
  source: startUrl.href,
  createdAt: new Date().toISOString(),
  files: urlToLocal.size - failures.length,
  failures
};
await fs.writeFile(path.join(outputRoot, 'mirror-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify(manifest, null, 2));
