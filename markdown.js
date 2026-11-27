import { callHost } from '/runtime/block-sdk.js';
import {
  basename,
  dirname,
  extname,
  htmlUnescape,
  isPlainObject,
  normalizePath,
  resolveSafeSubpath,
  safeDecodeURIComponent,
} from './paths.js';

export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.avif',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
]);

const FENCE_PATTERN = /^[ \t]*(`{3,}|~{3,})/;
const INLINE_CODE_PATTERN = /(`+)(?!`)(.+?)(?<!`)\1/g;
const MD_IMAGE_PATTERN =
  /!\[((?:\\.|[^\]\n])*)\]\([ \t]*(<[^>\n]+>|(?:\\.|[^()\\\s])*(?:\((?:\\.|[^()\\\s])*\)(?:\\.|[^()\\\s])*)*)([ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\)/g;
const MD_REFERENCE_IMAGE_PATTERN =
  /!\[((?:\\.|[^\]\\\n])*)\](?:\[((?:\\.|[^\]\\\n])*)\])?(?![\[(])/g;
const MD_REFERENCE_DEFINITION_PATTERN =
  /^ {0,3}\[((?:\\.|[^\]\\\n])+)\]:[ \t]*(?:\r?\n[ \t]*)?(<[^>\n]*>|[^<\s]\S*)(?:(?:[ \t]+|[ \t]*\r?\n[ \t]*)("[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*(?=\r?\n|\r|$)/;
const HTML_IMG_TAG_PATTERN = /<img(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
const HTML_IMG_ATTR_PATTERN =
  /\s+([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\`]+)))?/gi;

export class LocalizedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalizedError';
  }
}

export function splitLinesKeepEnds(text) {
  const src = String(text ?? '');
  const lines = [];
  let start = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\r') {
      if (i + 1 < src.length && src[i + 1] === '\n') {
        i += 1;
      }
      lines.push(src.slice(start, i + 1));
      start = i + 1;
    } else if (ch === '\n') {
      lines.push(src.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < src.length) {
    lines.push(src.slice(start));
  }
  return lines;
}

export function normalizeLocalAssetRef(target) {
  if (!target) {
    return null;
  }
  const stripped = String(target).trim();
  const lower = stripped.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('//')
  ) {
    return null;
  }
  const clean = stripped.split('#', 1)[0].split('?', 1)[0].trim();
  if (!clean || clean.startsWith('/')) {
    return null;
  }
  if (clean.length >= 2 && clean[1] === ':' && /[A-Za-z]/.test(clean[0])) {
    return null;
  }
  const unquoted = safeDecodeURIComponent(clean);
  if (!IMAGE_EXTENSIONS.has(extname(unquoted))) {
    return null;
  }
  return clean;
}

export function maskInlineCode(line) {
  return line.replace(INLINE_CODE_PATTERN, (match) => ' '.repeat(match.length));
}

export function stripQuotePrefix(line, maxDepth = null) {
  let depth = 0;
  let pos = 0;
  let current = line;
  let n = current.length;
  while (pos < n && (maxDepth === null || depth < maxDepth)) {
    let spaces = 0;
    let scan = pos;
    while (scan < n && current[scan] === ' ' && spaces < 4) {
      spaces += 1;
      scan += 1;
    }
    if (spaces <= 3 && scan < n && current[scan] === '>') {
      depth += 1;
      pos = scan + 1;
      if (pos < n && current[pos] === ' ') {
        pos += 1;
      } else if (pos < n && current[pos] === '\t') {
        const colAfterGt = spaces + 1;
        const tabCols = 4 - (colAfterGt % 4);
        pos += 1;
        const extraSpaces = Math.max(0, tabCols - 1);
        if (extraSpaces > 0) {
          current = ' '.repeat(extraSpaces) + current.slice(pos);
          pos = 0;
          n = current.length;
        }
      }
    } else {
      break;
    }
  }
  return [depth, current.slice(pos)];
}

export function leadingIndentWidth(text) {
  let cols = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === ' ') {
      cols += 1;
    } else if (ch === '\t') {
      cols += 4 - (cols % 4);
    } else {
      break;
    }
  }
  return cols;
}

export function parseListMarker(body) {
  let pos = 0;
  const n = body.length;
  let markerIndent = 0;
  while (pos < n && (body[pos] === ' ' || body[pos] === '\t')) {
    if (body[pos] === ' ') {
      markerIndent += 1;
    } else {
      markerIndent += 4 - (markerIndent % 4);
    }
    pos += 1;
  }
  if (pos >= n) {
    return null;
  }

  let markerLen = 0;
  let after = 0;
  if (body[pos] === '-' || body[pos] === '+' || body[pos] === '*') {
    markerLen = 1;
    after = pos + 1;
    const markerChar = body[pos];
    const rest = body.slice(after);
    const compacted = rest.replace(/[ \t]/g, '');
    if (rest.trim() && compacted.split('').every((ch) => ch === markerChar)) {
      let count = 0;
      for (let i = pos; i < n; i += 1) {
        if (body[i] === markerChar) count += 1;
      }
      if (count >= 3) {
        return null;
      }
    }
  } else if (body[pos] >= '0' && body[pos] <= '9') {
    const start = pos;
    while (pos < n && pos - start < 9 && body[pos] >= '0' && body[pos] <= '9') {
      pos += 1;
    }
    if (pos >= n || (body[pos] !== '.' && body[pos] !== ')')) {
      return null;
    }
    markerLen = pos - start + 1;
    after = pos + 1;
  } else {
    return null;
  }

  if (after < n && body[after] !== ' ' && body[after] !== '\t') {
    return null;
  }

  let wsCols = 0;
  let col = markerIndent + markerLen;
  let scan = after;
  while (scan < n && (body[scan] === ' ' || body[scan] === '\t')) {
    if (body[scan] === ' ') {
      wsCols += 1;
      col += 1;
    } else {
      const step = 4 - (col % 4);
      wsCols += step;
      col += step;
    }
    scan += 1;
  }
  const contentIndent =
    scan >= n || wsCols >= 5
      ? markerIndent + markerLen + 1
      : markerIndent + markerLen + wsCols;
  return [markerIndent, contentIndent];
}

export function markdownLines(content) {
  let fenceChar = '';
  let fenceLen = 0;
  let fenceQuoteDepth = 0;
  let fenceBaseIndent = 0;
  let allowIndentedCode = true;
  let afterBlank = true;
  const listStacks = new Map();
  let prevQuoteDepth = 0;
  let offset = 0;
  const result = [];

  for (const line of splitLinesKeepEnds(content)) {
    const lineNoEol = line.replace(/[\r\n]+$/, '');
    const [quoteDepth, body] = stripQuotePrefix(lineNoEol);

    if (fenceChar) {
      if (quoteDepth < fenceQuoteDepth) {
        fenceChar = '';
        fenceLen = 0;
        fenceQuoteDepth = 0;
        fenceBaseIndent = 0;
        allowIndentedCode = true;
        afterBlank = true;
        for (const depthKey of [...listStacks.keys()]) {
          if (depthKey > quoteDepth) {
            listStacks.delete(depthKey);
          }
        }
      } else {
        const [, fenceBody] = stripQuotePrefix(lineNoEol, fenceQuoteDepth);
        const closeIndent = leadingIndentWidth(fenceBody);
        const closeMatch = FENCE_PATTERN.exec(fenceBody);
        if (closeMatch && closeIndent < fenceBaseIndent + 4) {
          const marker = closeMatch[1];
          if (
            marker[0] === fenceChar &&
            marker.length >= fenceLen &&
            fenceBody.slice(closeMatch[0].length).trim() === ''
          ) {
            fenceChar = '';
            fenceLen = 0;
            fenceQuoteDepth = 0;
            fenceBaseIndent = 0;
            allowIndentedCode = true;
            afterBlank = true;
            prevQuoteDepth = quoteDepth;
            offset += line.length;
            continue;
          }
        }
        prevQuoteDepth = quoteDepth;
        offset += line.length;
        continue;
      }
    }

    if (quoteDepth < prevQuoteDepth) {
      for (const depthKey of [...listStacks.keys()]) {
        if (depthKey > quoteDepth) {
          listStacks.delete(depthKey);
        }
      }
    }
    prevQuoteDepth = quoteDepth;

    if (body.trim() === '') {
      allowIndentedCode = true;
      afterBlank = true;
      result.push([offset, line]);
      offset += line.length;
      continue;
    }

    const indent = leadingIndentWidth(body);
    let stack = listStacks.get(quoteDepth);
    if (!stack) {
      stack = [];
      listStacks.set(quoteDepth, stack);
    }
    if (afterBlank) {
      while (stack.length > 0 && indent < stack[stack.length - 1][1]) {
        stack.pop();
      }
    }
    const baseIndent = stack.length > 0 ? stack[stack.length - 1][1] : 0;

    if (allowIndentedCode && indent >= baseIndent + 4) {
      allowIndentedCode = true;
      afterBlank = false;
      offset += line.length;
      continue;
    }

    const fenceMatch = FENCE_PATTERN.exec(body);
    if (fenceMatch && indent < baseIndent + 4) {
      const marker = fenceMatch[1];
      const rest = body.slice(fenceMatch[0].length);
      if (!(marker[0] === '`' && rest.includes('`'))) {
        fenceChar = marker[0];
        fenceLen = marker.length;
        fenceQuoteDepth = quoteDepth;
        fenceBaseIndent = baseIndent;
        allowIndentedCode = false;
        afterBlank = false;
        offset += line.length;
        continue;
      }
    }

    const lm = parseListMarker(body);
    if (lm !== null && indent < baseIndent + 4) {
      const [markerIndent, contentIndent] = lm;
      while (stack.length > 0 && markerIndent < stack[stack.length - 1][1]) {
        stack.pop();
      }
      stack.push([markerIndent, contentIndent]);
      const afterMarkerMatch = body.match(/^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+(`{3,}|~{3,})(.*)$/);
      if (afterMarkerMatch) {
        const marker = afterMarkerMatch[1];
        const rest = afterMarkerMatch[2];
        if (!(marker[0] === '`' && rest.includes('`'))) {
          fenceChar = marker[0];
          fenceLen = marker.length;
          fenceQuoteDepth = quoteDepth;
          fenceBaseIndent = contentIndent;
          allowIndentedCode = false;
          afterBlank = false;
          offset += line.length;
          continue;
        }
      }
      allowIndentedCode = false;
      afterBlank = false;
      result.push([offset, line]);
      offset += line.length;
      continue;
    }

    const isNonParaBlock =
      indent < baseIndent + 4 &&
      /^[ \t]*(?:#{1,6}(?:[ \t]|$)|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/.test(body);
    if (isNonParaBlock) {
      while (stack.length > 0 && indent < stack[stack.length - 1][1]) {
        stack.pop();
      }
    }
    allowIndentedCode = isNonParaBlock;
    afterBlank = isNonParaBlock;
    result.push([offset, line]);
    offset += line.length;
  }

  return result;
}

export function markdownAssetPath(destination) {
  let dest = String(destination ?? '');
  if (dest.startsWith('<') && dest.endsWith('>')) {
    dest = dest.slice(1, -1);
  }
  dest = dest.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
  return normalizeLocalAssetRef(htmlUnescape(dest));
}

function countTrailingBackslashes(text) {
  let count = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    count += 1;
  }
  return count;
}

export function extractLocalRefs(content) {
  const definitions = new Map();
  const lines = markdownLines(content);
  let definitionEnd = 0;
  const definitionLines = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const [offset, line] = lines[index];
    if (offset < definitionEnd) {
      definitionLines.add(offset);
      continue;
    }
    if (!line.trimStart().startsWith('[') || !line.includes(']:')) {
      continue;
    }
    let candidate = line;
    for (const [nextOffset, nextLine] of lines.slice(index + 1, index + 3)) {
      if (nextOffset !== offset + candidate.length) {
        break;
      }
      candidate += nextLine;
    }
    const match = MD_REFERENCE_DEFINITION_PATTERN.exec(candidate);
    if (!match) {
      continue;
    }
    const label = match[1];
    const destination = match[2];
    const title = match[3] || '';
    const key = label.trim().split(/\s+/).join(' ').toLowerCase();
    if (!definitions.has(key)) {
      definitions.set(key, [markdownAssetPath(destination), title ? ` ${title}` : '']);
    }
    definitionLines.add(offset);
    definitionEnd = offset + match[0].length;
  }

  const refs = [];
  for (const [offset, line] of lines) {
    if (definitionLines.has(offset)) {
      continue;
    }
    const scanLine = maskInlineCode(line);
    const lineRefs = [];

    MD_IMAGE_PATTERN.lastIndex = 0;
    let match;
    while ((match = MD_IMAGE_PATTERN.exec(scanLine)) !== null) {
      const before = line.slice(0, match.index);
      if (countTrailingBackslashes(before) % 2 === 1) {
        continue;
      }
      const altStart = match.index + 2;
      const altEnd = altStart + match[1].length;
      const alt = line.slice(altStart, altEnd);

      let targetStart = altEnd + 2;
      while (targetStart < line.length && (line[targetStart] === ' ' || line[targetStart] === '\t')) {
        targetStart += 1;
      }
      const targetEnd = targetStart + match[2].length;
      const dest = line.slice(targetStart, targetEnd);
      const relPath = markdownAssetPath(dest);
      const titleRaw = match[3] || '';
      const title = titleRaw ? line.slice(targetEnd, targetEnd + titleRaw.length) : '';

      if (relPath) {
        lineRefs.push({
          kind: 'md',
          start: offset + match.index,
          end: offset + match.index + match[0].length,
          alt,
          rel_path: relPath,
          suffix: title,
        });
      }
    }

    MD_REFERENCE_IMAGE_PATTERN.lastIndex = 0;
    while ((match = MD_REFERENCE_IMAGE_PATTERN.exec(scanLine)) !== null) {
      const before = line.slice(0, match.index);
      if (countTrailingBackslashes(before) % 2 === 1) {
        continue;
      }
      const altStart = match.index + 2;
      const altEnd = altStart + match[1].length;
      const alt = line.slice(altStart, altEnd);
      let label = '';
      if (match[2] !== undefined && match[2].length > 0) {
        const labelStart = altEnd + 2;
        label = line.slice(labelStart, labelStart + match[2].length);
      }
      const key = (label || alt).trim().split(/\s+/).join(' ').toLowerCase();
      const def = definitions.get(key);
      const relPath = def ? def[0] : null;
      const title = def ? def[1] : '';
      if (relPath) {
        lineRefs.push({
          kind: 'md',
          start: offset + match.index,
          end: offset + match.index + match[0].length,
          alt,
          rel_path: relPath,
          suffix: title,
        });
      }
    }

    HTML_IMG_TAG_PATTERN.lastIndex = 0;
    let tagMatch;
    while ((tagMatch = HTML_IMG_TAG_PATTERN.exec(scanLine)) !== null) {
      const tagStart = tagMatch.index;
      const tagEnd = tagStart + tagMatch[0].length;
      const attrRegionStart = tagStart + 4;
      const attrRegion = line.slice(attrRegionStart, tagEnd);
      HTML_IMG_ATTR_PATTERN.lastIndex = 0;
      let attrMatch;
      while ((attrMatch = HTML_IMG_ATTR_PATTERN.exec(attrRegion)) !== null) {
        if (attrMatch[1].toLowerCase() !== 'src') {
          continue;
        }
        const fullAttr = attrMatch[0];
        let val = null;
        let localStart = -1;
        if (attrMatch[2] !== undefined) {
          val = attrMatch[2];
          localStart = fullAttr.indexOf('"') + 1;
        } else if (attrMatch[3] !== undefined) {
          val = attrMatch[3];
          localStart = fullAttr.indexOf("'") + 1;
        } else if (attrMatch[4] !== undefined) {
          val = attrMatch[4];
          const eqIdx = fullAttr.indexOf('=');
          localStart = eqIdx + 1;
          while (localStart < fullAttr.length && /\s/.test(fullAttr[localStart])) {
            localStart += 1;
          }
        }
        if (val !== null && localStart >= 0) {
          const relPath = normalizeLocalAssetRef(htmlUnescape(val));
          if (relPath) {
            const absStart = offset + attrRegionStart + attrMatch.index + localStart;
            lineRefs.push({
              kind: 'html',
              start: absStart,
              end: absStart + val.length,
              rel_path: relPath,
            });
          }
        }
        break;
      }
    }

    let lastEnd = offset;
    lineRefs.sort((a, b) => a.start - b.start || b.end - a.end);
    for (const ref of lineRefs) {
      if (ref.start >= lastEnd) {
        refs.push(ref);
        lastEnd = ref.end;
      }
    }
  }

  return refs;
}

export function extractStatSize(statRes) {
  if (!isPlainObject(statRes)) {
    return 0;
  }
  const n = Number(statRes.size);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

export function isStatRegularFile(statRes) {
  if (!isPlainObject(statRes) || statRes.exists === false) {
    return false;
  }
  if (statRes.is_icloud_placeholder === true || statRes.is_symlink === true) {
    return false;
  }
  if (typeof statRes.is_regular === 'boolean') {
    return statRes.is_regular;
  }
  if (typeof statRes.is_file === 'boolean') {
    return statRes.is_file;
  }
  if (typeof statRes.is_dir === 'boolean') {
    return !statRes.is_dir;
  }
  return statRes.size !== undefined;
}

export function extractAssetTimestampSec(statRes) {
  if (isPlainObject(statRes)) {
    for (const key of ['birthtime_ms', 'mtime_ms', 'mod_time_ms']) {
      const val = Number(statRes[key]);
      if (Number.isFinite(val) && val > 0) {
        return val / 1000;
      }
    }
    for (const key of ['birthtime_sec', 'mtime_sec']) {
      const val = Number(statRes[key]);
      if (Number.isFinite(val) && val > 0) {
        return val;
      }
    }
    for (const key of ['birthtime', 'mtime', 'mod_time']) {
      const raw = statRes[key];
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return raw > 1e12 ? raw / 1000 : raw;
      }
      if (typeof raw === 'string' && raw.trim()) {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed / 1000;
        }
      }
    }
  }
  return Date.now() / 1000;
}

export function resolveLocalFile(nbRoot, notePath, relAssetPath) {
  if (!nbRoot) {
    return null;
  }
  const rootNorm = normalizePath(nbRoot);
  const unquoted = safeDecodeURIComponent(relAssetPath);
  const noteDir = notePath ? dirname(notePath) : '';
  const candidates = [];
  if (noteDir) {
    const c1 = resolveSafeSubpath(rootNorm, noteDir, unquoted);
    if (c1) candidates.push(c1);
    const c2 = resolveSafeSubpath(rootNorm, noteDir, relAssetPath);
    if (c2 && c2 !== c1) candidates.push(c2);
  }
  const c3 = resolveSafeSubpath(rootNorm, '', unquoted);
  if (c3 && !candidates.includes(c3)) candidates.push(c3);
  const c4 = resolveSafeSubpath(rootNorm, '', relAssetPath);
  if (c4 && !candidates.includes(c4)) candidates.push(c4);

  for (const cand of candidates) {
    try {
      const st = callHost('host.fs.stat', { path: cand, lstat: true });
      if (isStatRegularFile(st)) {
        const realPath =
          (typeof st.real_path === 'string' && st.real_path.trim()) ||
          (typeof st.path === 'string' && st.path.trim()) ||
          cand;
        return { localPath: realPath, size: extractStatSize(st) };
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export function readNote(noteParams, tr) {
  const result = callHost('host.notes.read', noteParams);
  if (!isPlainObject(result) || typeof result.content !== 'string') {
    throw new LocalizedError(tr('宿主返回的笔记内容无效', 'The host returned invalid note content.'));
  }
  const revision = result.revision;
  if (revision !== undefined && revision !== null && (typeof revision !== 'string' || !revision)) {
    throw new LocalizedError(tr('宿主返回的笔记版本无效', 'The host returned an invalid note revision.'));
  }
  return { content: result.content, revision: revision ?? null };
}

export function writeNote(nbRoot, notePath, content, revision, newContent, tr) {
  const noteParams = { notebook_root: nbRoot, path: notePath };
  const writeParams = { ...noteParams, content: newContent };
  if (revision !== null && revision !== undefined) {
    writeParams.expected_revision = revision;
  } else {
    const latest = readNote(noteParams, tr);
    if (latest.content !== content) {
      throw new LocalizedError(tr('笔记内容已变化，请重试', 'The note has changed. Try again.'));
    }
    if (latest.revision !== null) {
      writeParams.expected_revision = latest.revision;
    }
  }
  const result = callHost('host.notes.write', writeParams);
  if (!isPlainObject(result) || result.ok !== true) {
    throw new LocalizedError(tr('宿主未确认写回成功', 'The host did not confirm the note update.'));
  }
}

export function scanNotebooks(notebooks, targetNote, { normNbPath, notebookLabel, errorDetail, tr }) {
  const results = [];
  let totalRefs = 0;
  let scannedNotes = 0;

  const targetNb = targetNote ? normNbPath(targetNote[0]) : '';
  const targetRel = targetNote ? String(targetNote[1] || '') : '';

  for (const nbRoot of notebooks) {
    const normNb = normNbPath(nbRoot);
    if (!normNb) {
      continue;
    }
    if (targetNb && normNb !== targetNb) {
      continue;
    }
    const nbName = notebookLabel(normNb);

    let notePaths;
    if (targetRel) {
      notePaths = [targetRel];
    } else {
      try {
        const listRes = callHost('host.notes.list', { notebook_root: normNb });
        const notes = isPlainObject(listRes) ? listRes.notes : null;
        if (notes !== null && notes !== undefined && !Array.isArray(notes)) {
          throw new LocalizedError(tr('宿主返回的笔记列表无效', 'The host returned an invalid note list.'));
        }
        notePaths = [];
        for (const item of notes || []) {
          const notePath = isPlainObject(item) ? item.path : null;
          if (typeof notePath !== 'string' || !notePath.trim()) {
            throw new LocalizedError(tr('宿主返回的笔记路径无效', 'The host returned an invalid note path.'));
          }
          notePaths.push(notePath);
        }
      } catch (err) {
        throw new LocalizedError(
          tr(
            `扫描笔记本「${nbName}」失败：${err && err.message ? err.message : err}`,
            `Could not scan notebook ${nbName}: ${errorDetail(err)}`,
          ),
        );
      }
    }

    for (const notePath of notePaths) {
      let content;
      let revision;
      const refs = [];
      try {
        const read = readNote({ notebook_root: normNb, path: notePath }, tr);
        content = read.content;
        revision = read.revision;
        for (const ref of extractLocalRefs(content)) {
          const asset = resolveLocalFile(normNb, notePath, ref.rel_path);
          if (asset !== null) {
            ref.local_path = asset.localPath;
            ref.size = asset.size;
            refs.push(ref);
          }
        }
      } catch (err) {
        throw new LocalizedError(
          tr(
            `扫描笔记「${nbName}/${notePath}」失败：${err && err.message ? err.message : err}`,
            `Could not scan note ${nbName}/${notePath}: ${errorDetail(err)}`,
          ),
        );
      }
      scannedNotes += 1;
      if (refs.length > 0) {
        totalRefs += refs.length;
        results.push({
          nbRoot: normNb,
          nbName,
          notePath,
          content,
          revision,
          refs,
        });
      }
    }
  }

  return { scannedNotes, totalRefs, noteItems: results };
}

export function formatMdReplacement(ref, remoteUrl) {
  let dest = remoteUrl;
  if (/[ \t()<>]/.test(dest)) {
    dest = `<${dest}>`;
  }
  return `![${ref.alt}](${dest}${ref.suffix})`;
}

export function basenameSafe(filePath) {
  return basename(filePath);
}
