const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

const HTML_NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function englishDiagnostic(detail) {
  const normalized = String(detail ?? '').trim().split(/\s+/).filter(Boolean).join(' ');
  return /^[\x20-\x7E]*$/.test(normalized) ? normalized : '';
}

export function utf8ByteLength(str) {
  const text = String(str ?? '');
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function htmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function htmlUnescape(str) {
  return String(str ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);?/g, (full, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const cp = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    if (entity.startsWith('#')) {
      const cp = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
    }
    const lower = entity.toLowerCase();
    return Object.prototype.hasOwnProperty.call(HTML_NAMED_ENTITIES, lower)
      ? HTML_NAMED_ENTITIES[lower]
      : full;
  });
}

export function awsUriEncode(str) {
  return encodeURIComponent(String(str ?? '')).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(String(str ?? ''));
  } catch {
    return String(str ?? '');
  }
}

export function parseUrl(rawUrl) {
  const match = String(rawUrl ?? '').trim().match(
    /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/,
  );
  if (!match) {
    return null;
  }
  const scheme = match[1].toLowerCase();
  const netloc = match[2];
  if (!netloc) {
    return null;
  }
  return {
    scheme,
    netloc,
    path: match[3] || '',
    query: match[4] || '',
    fragment: match[5] || '',
  };
}

export function base64ToBytes(b64) {
  const clean = String(b64 ?? '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) {
    return new Uint8Array(0);
  }
  let pad = 0;
  if (clean.endsWith('==')) pad = 2;
  else if (clean.endsWith('=')) pad = 1;
  const byteLen = Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
  const out = new Uint8Array(byteLen);
  let outIdx = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_LOOKUP[clean.charCodeAt(i)];
    const b = B64_LOOKUP[clean.charCodeAt(i + 1)];
    const c = clean[i + 2] === '=' ? 0 : B64_LOOKUP[clean.charCodeAt(i + 2)];
    const d = clean[i + 3] === '=' ? 0 : B64_LOOKUP[clean.charCodeAt(i + 3)];
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new Error('Invalid base64 input');
    }
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (outIdx < byteLen) out[outIdx++] = (triple >> 16) & 0xff;
    if (outIdx < byteLen) out[outIdx++] = (triple >> 8) & 0xff;
    if (outIdx < byteLen) out[outIdx++] = triple & 0xff;
  }
  return out;
}

export function bytesToBase64(bytes) {
  const len = bytes.length;
  if (len === 0) {
    return '';
  }
  const chunks = [];
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < len;
    const has2 = i + 2 < len;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    chunks.push(
      B64_ALPHABET[(triple >> 18) & 0x3f] +
        B64_ALPHABET[(triple >> 12) & 0x3f] +
        (has1 ? B64_ALPHABET[(triple >> 6) & 0x3f] : '=') +
        (has2 ? B64_ALPHABET[triple & 0x3f] : '='),
    );
  }
  return chunks.join('');
}

export function prependAsciiToBase64(asciiPrefix, base64Data) {
  const body = base64ToBytes(base64Data);
  const combined = new Uint8Array(asciiPrefix.length + body.length);
  for (let i = 0; i < asciiPrefix.length; i += 1) {
    combined[i] = asciiPrefix.charCodeAt(i) & 0xff;
  }
  combined.set(body, asciiPrefix.length);
  return bytesToBase64(combined);
}

function splitPathPrefix(rawPath) {
  const text = String(rawPath ?? '').trim();
  if (!text) {
    return { root: '', sep: '/', parts: [] };
  }
  const winDrive = text.match(/^([A-Za-z]:)([/\\])(.*)$/);
  if (winDrive) {
    const sep = text.includes('/') && !text.includes('\\') ? '/' : '\\';
    const parts = winDrive[3].split(/[/\\]+/).filter(Boolean);
    return { root: `${winDrive[1]}${sep}`, sep, parts };
  }
  if (text.startsWith('\\\\')) {
    const parts = text.slice(2).split(/[/\\]+/).filter(Boolean);
    return { root: '\\\\', sep: '\\', parts };
  }
  if (text.startsWith('/')) {
    const parts = text.slice(1).split(/[/\\]+/).filter(Boolean);
    return { root: '/', sep: '/', parts };
  }
  const sep = text.includes('\\') && !text.includes('/') ? '\\' : '/';
  const parts = text.split(/[/\\]+/).filter(Boolean);
  return { root: '', sep, parts };
}

export function normalizePath(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return '';
  }
  const { root, sep, parts } = splitPathPrefix(text);
  const stack = [];
  for (const part of parts) {
    if (part === '.' || part === '') {
      continue;
    }
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!root) {
        stack.push('..');
      }
    } else {
      stack.push(part);
    }
  }
  if (root) {
    return stack.length > 0 ? `${root}${stack.join(sep)}` : root;
  }
  return stack.length > 0 ? stack.join(sep) : '.';
}

export function basename(rawPath) {
  const norm = normalizePath(rawPath);
  if (!norm || norm === '/' || norm === '\\' || /^[A-Za-z]:[/\\]?$/.test(norm)) {
    return norm === '/' || norm === '\\' ? '' : norm;
  }
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

export function dirname(rawPath) {
  const text = String(rawPath ?? '').trim();
  if (!text) {
    return '';
  }
  const trimmed = text.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) {
    return '';
  }
  if (idx === 0) {
    return trimmed[0];
  }
  const parent = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}${trimmed[idx]}`;
  }
  return parent;
}

export function extname(rawPath) {
  const base = basename(rawPath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return '';
  }
  return base.slice(dot).toLowerCase();
}

export function joinPath(base, ...segments) {
  const baseInfo = splitPathPrefix(base);
  const sep = baseInfo.sep || '/';
  const combined = [...baseInfo.parts];
  for (const seg of segments) {
    if (!seg) continue;
    for (const part of String(seg).split(/[/\\]+/)) {
      if (part) combined.push(part);
    }
  }
  const stack = [];
  for (const part of combined) {
    if (part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!baseInfo.root) {
        stack.push('..');
      }
    } else {
      stack.push(part);
    }
  }
  if (baseInfo.root) {
    return stack.length > 0 ? `${baseInfo.root}${stack.join(sep)}` : baseInfo.root;
  }
  return stack.length > 0 ? stack.join(sep) : '.';
}

/** Resolve a relative asset path inside `nbRoot`, returning null if it escapes `nbRoot`. */
export function resolveSafeSubpath(nbRoot, noteDir, relAsset) {
  const rootNorm = normalizePath(nbRoot);
  if (!rootNorm) {
    return null;
  }
  const rootInfo = splitPathPrefix(rootNorm);
  const sep = rootInfo.sep || '/';
  const stack = [];
  const rawParts = [];
  if (noteDir) {
    for (const p of String(noteDir).split(/[/\\]+/)) {
      if (p) rawParts.push(p);
    }
  }
  for (const p of String(relAsset).split(/[/\\]+/)) {
    if (p) rawParts.push(p);
  }
  for (const part of rawParts) {
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      if (stack.length === 0) {
        return null;
      }
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  if (stack.length === 0) {
    return null;
  }
  if (rootNorm === '/' || /^[A-Za-z]:[/\\]$/.test(rootNorm)) {
    return `${rootNorm}${stack.join(sep)}`;
  }
  return `${rootNorm}${sep}${stack.join(sep)}`;
}

export function relativePath(fromRoot, targetPath) {
  const fromNorm = normalizePath(fromRoot);
  const targetNorm = normalizePath(targetPath);
  const fromInfo = splitPathPrefix(fromNorm);
  const targetInfo = splitPathPrefix(targetNorm);
  if (fromInfo.root !== targetInfo.root) {
    return targetNorm;
  }
  let common = 0;
  while (
    common < fromInfo.parts.length &&
    common < targetInfo.parts.length &&
    fromInfo.parts[common] === targetInfo.parts[common]
  ) {
    common += 1;
  }
  const ups = new Array(fromInfo.parts.length - common).fill('..');
  const rest = targetInfo.parts.slice(common);
  const out = [...ups, ...rest];
  return out.length > 0 ? out.join('/') : '.';
}

export function deriveHomeDir(downloadsDir) {
  const clean = String(downloadsDir ?? '').trim().replace(/[/\\]+$/, '');
  if (!clean) {
    return '';
  }
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  if (idx > 0 && clean.slice(idx + 1).toLowerCase() === 'downloads') {
    return clean.slice(0, idx);
  }
  return '';
}

export function formatDisplayPath(raw, homeDir) {
  const path = normalizePath(raw);
  if (!path) {
    return '';
  }
  const home = normalizePath(homeDir);
  if (!home) {
    return path;
  }
  if (path === home) {
    return '~';
  }
  if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

export function guessMimeType(filePath) {
  return MIME_TYPES[extname(filePath)] || 'application/octet-stream';
}
