/**
 * Embed brand images as data URIs so downloaded / emailed invoices always show
 * logo + signatures (remote /brand URLs are blocked by CORP when opening file://).
 */
const fs = require('fs');
const path = require('path');

const BRAND_DIR = path.join(__dirname, '..', '..', 'public', 'brand');
const cache = new Map();

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/png';
}

function localBrandPath(urlOrPath) {
  if (!urlOrPath) return null;
  if (/^data:/i.test(urlOrPath)) return null;
  let p = String(urlOrPath).split('?')[0].split('#')[0];
  try {
    if (/^https?:\/\//i.test(p)) {
      p = new URL(p).pathname;
    }
  } catch {
    /* ignore */
  }
  const marker = '/brand/';
  const idx = p.indexOf(marker);
  if (idx >= 0) p = p.slice(idx + marker.length);
  else if (p.startsWith('brand/')) p = p.slice('brand/'.length);
  else if (p.startsWith('/')) return null;
  p = path.basename(p);
  if (!p || p.includes('..')) return null;
  return path.join(BRAND_DIR, p);
}

function dataUriFor(urlOrPath, fallbackFile) {
  const key = `${urlOrPath || ''}|${fallbackFile || ''}`;
  if (cache.has(key)) return cache.get(key);

  const candidates = [localBrandPath(urlOrPath), fallbackFile ? path.join(BRAND_DIR, fallbackFile) : null].filter(
    Boolean
  );

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const buf = fs.readFileSync(file);
      const uri = `data:${mimeFor(file)};base64,${buf.toString('base64')}`;
      cache.set(key, uri);
      return uri;
    } catch {
      /* try next */
    }
  }

  cache.set(key, '');
  return '';
}

function resolveBrandSrc(urlOrPath, fallbackFile, publicBaseUrl = '', { embed = true } = {}) {
  if (embed) {
    const embedded = dataUriFor(urlOrPath, fallbackFile);
    if (embedded) return embedded;
  }
  if (urlOrPath && /^data:/i.test(urlOrPath)) return urlOrPath;

  const root = (publicBaseUrl || 'https://cresos.cresdynamics.com').replace(/\/$/, '');
  let pathname = `/brand/${fallbackFile || 'logo.png'}`;
  let query = '';

  if (urlOrPath) {
    const raw = String(urlOrPath);
    const qIdx = raw.indexOf('?');
    if (qIdx >= 0) query = raw.slice(qIdx);
    let p = (qIdx >= 0 ? raw.slice(0, qIdx) : raw).split('#')[0];
    try {
      if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
    } catch {
      /* ignore */
    }
    if (p.startsWith('/brand/')) pathname = p;
    else if (p.startsWith('brand/')) pathname = `/${p}`;
    else if (!p.includes('/') && p.includes('.')) pathname = `/brand/${p}`;
  }

  return `${root}${pathname}${query}`;
}

module.exports = { dataUriFor, resolveBrandSrc, localBrandPath };
