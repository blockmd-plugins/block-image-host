import { serve, callHost, notifyHost } from '/runtime/block-sdk.js';
import {
  basename,
  deriveHomeDir,
  englishDiagnostic,
  htmlEscape,
  isPlainObject,
  normalizePath,
  utf8ByteLength,
} from './paths.js';
import {
  LocalizedError,
  formatMdReplacement,
  isStatRegularFile,
  resolveLocalFile,
  scanNotebooks,
  writeNote,
} from './markdown.js';
import {
  HttpError,
  NetworkError,
  PROVIDER_LABELS,
  extractHttpErrorDetail,
  normalizeConfig,
  parseCredentials,
  providerLabel,
  testConnection,
  uploadFile,
} from './providers.js';
import {
  buildPage,
  collectPendingImages,
  connConfigSignature,
  isConfigReady,
  uploadDedupeKey,
} from './ui.js';

const MENUBAR_ITEM_ID = 'uploader';
const MAX_MENUBAR_RECENT = 10;
const MAX_LOGS = 20;

const state = {
  notebookRoot: '',
  knownNotebooks: [],
  dataDir: '',
  downloadsDir: '',
  homeDir: '',
  locale: 'zh',
  supportsChecklist: false,
  supportsAddFolder: false,
  supportsMultiNotebook: false,
  supportsActionProgress: false,
  supportsProgressBar: false,
  supportsFormAutosave: false,
  supportsButtonLink: false,
  supportsToastBanner: false,
  supportsOpenSettings: false,
};

function isEnglish() {
  return String(state.locale || '').toLowerCase().startsWith('en');
}

function tr(zh, en) {
  return isEnglish() ? en : zh;
}

function errorDetail(error) {
  const detail = error && error.message !== undefined ? String(error.message) : String(error ?? '');
  if (!isEnglish() || error instanceof LocalizedError) {
    return detail;
  }
  return englishDiagnostic(detail) || 'No English error details available.';
}

function emitProgress(done, total, progress, extra = null) {
  if (!state.supportsActionProgress) {
    return;
  }
  const params = {};
  if (done !== undefined && done !== null) {
    params.done = Math.trunc(done);
  }
  if (total !== undefined && total !== null) {
    params.total = Math.trunc(total);
  }
  if (progress !== undefined && progress !== null) {
    params.progress = Number(progress);
  }
  if (extra && typeof extra === 'object' && state.supportsProgressBar) {
    if (extra.channel) params.channel = String(extra.channel);
    if (extra.label) params.label = String(extra.label);
    if (extra.tone) params.tone = String(extra.tone);
    if (typeof extra.running === 'boolean') params.running = extra.running;
  }
  if (Object.keys(params).length === 0) {
    return;
  }
  try {
    notifyHost('host.action.progress', params);
  } catch {
    // Progress notifications are best-effort
  }
}

function notifyUploadResult(title, body = '', tone = 'info', withSettingsAction = false) {
  if (!state.supportsToastBanner || !title) {
    return;
  }
  const params = { message: title, tone };
  if (body) {
    params.body = body;
  }
  if (withSettingsAction && state.supportsOpenSettings) {
    params.action = {
      id: 'open_image_host_settings',
      label: tr('查看', 'View'),
    };
  }
  try {
    callHost('host.ui.toast', params);
  } catch {
    // Ignore toast errors
  }
}

function normNbPath(raw) {
  let text = String(raw ?? '').trim();
  if (!text) {
    return '';
  }
  if (state.homeDir) {
    if (text === '~') {
      text = state.homeDir;
    } else if (text.startsWith('~/') || text.startsWith('~\\')) {
      text = `${state.homeDir}${text.slice(1)}`;
    }
  }
  return normalizePath(text);
}

function notebookLabel(nbRoot) {
  const norm = normNbPath(nbRoot);
  for (const entry of state.knownNotebooks) {
    if (entry.path === norm && entry.name) {
      return entry.name;
    }
  }
  return basename(norm) || norm || tr('默认笔记本', 'Default notebook');
}

function refreshKnownNotebooks() {
  const entries = [];
  const seen = new Set();

  function addEntry(pathRaw, nameRaw = '', active = false) {
    const norm = normNbPath(pathRaw);
    if (!norm || seen.has(norm)) {
      return;
    }
    seen.add(norm);
    const label = String(nameRaw ?? '').trim() || basename(norm) || norm;
    entries.push({ path: norm, name: label, active: Boolean(active) });
  }

  let activeNorm = normNbPath(state.notebookRoot);
  let fetchedFromHost = false;
  try {
    const res = callHost('host.notebooks.list', {});
    const rawList = isPlainObject(res) ? res.notebooks : null;
    if (!Array.isArray(rawList)) {
      throw new LocalizedError(tr('宿主返回的笔记本列表无效', 'The host returned an invalid notebook list.'));
    }
    for (const item of rawList) {
      if (!isPlainObject(item) || typeof item.path !== 'string' || !item.path.trim()) {
        throw new LocalizedError(tr('宿主返回的笔记本路径无效', 'The host returned an invalid notebook path.'));
      }
      const p = item.path;
      const isActive = Boolean(item.active) || normNbPath(p) === activeNorm;
      if (isActive) {
        activeNorm = normNbPath(p);
        state.notebookRoot = activeNorm;
      }
      addEntry(p, item.name, isActive);
    }
    fetchedFromHost = true;
  } catch (err) {
    if (state.supportsMultiNotebook) {
      throw new LocalizedError(
        tr(
          `读取笔记本列表失败：${err && err.message ? err.message : err}`,
          `Could not load notebooks: ${errorDetail(err)}`,
        ),
      );
    }
  }

  if (!fetchedFromHost) {
    for (const existing of state.knownNotebooks) {
      if (isPlainObject(existing)) {
        const p = existing.path;
        addEntry(p, existing.name, Boolean(activeNorm) && normNbPath(p) === activeNorm);
      } else if (typeof existing === 'string') {
        addEntry(existing, '', Boolean(activeNorm) && normNbPath(existing) === activeNorm);
      }
    }
  }

  if (activeNorm) {
    addEntry(activeNorm, basename(activeNorm) || activeNorm, true);
  }

  state.knownNotebooks = entries;
  return entries;
}

function noNotebookText() {
  if (state.supportsAddFolder) {
    return tr('请先添加至少一个笔记本', 'Add at least one notebook.');
  }
  return tr('请先勾选至少一个笔记本', 'Select at least one notebook.');
}

function selectedNotebooks(config) {
  const raw = config.selected_notebooks;
  const knownSet = new Set(state.knownNotebooks.map((e) => e.path));
  const out = [];
  const seen = new Set();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const norm = normNbPath(item);
      if (!norm || seen.has(norm)) {
        continue;
      }
      if (knownSet.size > 0 && !knownSet.has(norm)) {
        continue;
      }
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

function loadState() {
  refreshKnownNotebooks();
  const res = callHost('host.storage.get', {});
  let data = isPlainObject(res) ? res.data : null;
  if (data === null || data === undefined) {
    data = {};
  }
  if (!isPlainObject(data)) {
    throw new LocalizedError(
      tr('宿主返回的图床配置无效', 'The host returned an invalid image hosting configuration.'),
    );
  }
  const rawCfg = isPlainObject(data.config) ? data.config : {};
  const config = normalizeConfig(rawCfg, normNbPath);
  if (!('selected_notebooks' in rawCfg)) {
    const activeNorm = normNbPath(state.notebookRoot);
    if (activeNorm) {
      config.selected_notebooks = [activeNorm];
    } else if (state.knownNotebooks.length > 0) {
      config.selected_notebooks = [state.knownNotebooks[0].path];
    }
  }

  const stats = isPlainObject(data.stats) ? data.stats : {};
  const uploadedTotal = Number.parseInt(stats.uploaded_total ?? 0, 10) || 0;
  const logs = Array.isArray(data.logs) ? data.logs : [];
  const cleanLogs = [];
  for (const entry of logs.slice(0, MAX_LOGS)) {
    if (isPlainObject(entry) && entry.title && entry.time) {
      const item = { title: String(entry.title), time: String(entry.time) };
      if (entry.status) item.status = String(entry.status);
      if (entry.tone) item.tone = String(entry.tone);
      if (entry.tooltip) item.tooltip = String(entry.tooltip);
      cleanLogs.push(item);
    }
  }
  const connState = isPlainObject(data.conn_state) ? data.conn_state : null;
  return { config, stats: { uploaded_total: uploadedTotal }, logs: cleanLogs, connState };
}

function saveConfig(config) {
  callHost('host.storage.set', { key: 'config', value: config });
}

function saveStats(stats) {
  callHost('host.storage.set', { key: 'stats', value: stats });
}

function saveLogs(logs) {
  callHost('host.storage.set', { key: 'logs', value: logs.slice(0, MAX_LOGS) });
}

function saveConnState(connState) {
  callHost('host.storage.set', { key: 'conn_state', value: connState });
}

function loadMenubarRecent() {
  const res = callHost('host.storage.get', { key: 'menubar_recent' });
  const raw = isPlainObject(res) ? res.value : null;
  if (!Array.isArray(raw)) {
    return [];
  }
  const items = [];
  for (const entry of raw.slice(0, MAX_MENUBAR_RECENT)) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const filename = String(entry.filename || '').trim();
    const url = String(entry.url || '').trim();
    if (!filename || !url) {
      continue;
    }
    const item = { filename, url };
    if (entry.time) {
      item.time = String(entry.time).trim();
    }
    items.push(item);
  }
  return items;
}

function saveMenubarRecent(recent) {
  callHost('host.storage.set', { key: 'menubar_recent', value: recent.slice(0, MAX_MENUBAR_RECENT) });
}

function formatLocalDateTime(date) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const yyyy = String(date.getFullYear()).padStart(4, '0');
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatLocalTime(date) {
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function recordMenubarRecent(recent, uploadedItems) {
  const nowStr = formatLocalDateTime(new Date());
  let updated = [...recent];
  for (const [filename, url] of uploadedItems) {
    updated = updated.filter((item) => item.url !== url);
    updated.unshift({ filename, url, time: nowStr });
  }
  return updated.slice(0, MAX_MENUBAR_RECENT);
}

function syncMenubarMenu(recent) {
  const entries = [];
  for (let idx = 0; idx < Math.min(recent.length, MAX_MENUBAR_RECENT); idx += 1) {
    const item = recent[idx];
    const url = item.url;
    if (utf8ByteLength(url) > 4096) {
      continue;
    }
    entries.push({
      id: `recent-${idx}`,
      title: item.filename,
      subtitle: url,
      command: 'copy-link',
      payload: url,
    });
  }
  const params = { id: MENUBAR_ITEM_ID };
  if (entries.length > 0) {
    params.menu = entries;
  } else {
    params.clear_menu = true;
  }
  try {
    callHost('host.menubar.set', params);
  } catch {
    // Ignore menubar sync failures on unsupported hosts
  }
}

function appendLog(logs, title, statusText, tone = 'info', tooltip = '') {
  const nowStr = formatLocalTime(new Date());
  const entry = { title, time: nowStr, tone };
  if (statusText) {
    entry.status = statusText;
  }
  if (tooltip) {
    entry.tooltip = tooltip;
  }
  return [entry, ...logs.slice(0, MAX_LOGS - 1)];
}

function formatCopiedLinks(config, uploadedItems) {
  const copyFormat = config.menubar_copy_format || 'markdown';
  const lines = [];
  for (const [filename, url] of uploadedItems) {
    if (copyFormat === 'url') {
      lines.push(url);
    } else {
      const safeAlt = filename.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
      lines.push(`![${safeAlt}](${url})`);
    }
  }
  return lines.join('\n');
}

function formatUploadException(err) {
  if (err instanceof HttpError) {
    return extractHttpErrorDetail(err, isEnglish());
  }
  if (err instanceof NetworkError) {
    return tr(
      `网络不可达：${err.reason}`,
      `Network unreachable: ${errorDetail(err.reason)}`,
    );
  }
  return errorDetail(err);
}

function isLocalRegularFile(filePath) {
  try {
    const st = callHost('host.fs.stat', { path: filePath });
    return isStatRegularFile(st);
  } catch {
    return false;
  }
}

function handleMenubarUpload(commandId, context) {
  const source = String(context.source || '').trim();
  const rawFiles = Array.isArray(context.files) ? context.files : [];
  const localFiles = [];
  const seenPaths = new Set();

  for (const rawPath of rawFiles) {
    const filePath = String(rawPath || '').trim();
    if (!filePath || seenPaths.has(filePath) || !isLocalRegularFile(filePath)) {
      continue;
    }
    seenPaths.add(filePath);
    localFiles.push(filePath);
  }

  if (localFiles.length === 0) {
    if (commandId === 'upload-clipboard' && source !== 'menubar' && source !== 'menubar_drop') {
      return {
        ok: false,
        tone: 'info',
        status: tr(
          '请从菜单栏图标菜单点击「上传剪贴板」或拖入图片上传',
          'Click Upload Clipboard in the menu bar icon or drop images on it',
        ),
      };
    }
    return {
      ok: false,
      tone: 'warning',
      status: tr(
        '未检测到可上传的本地图片文件',
        'No readable local image files found to upload',
      ),
    };
  }

  let { config, stats, logs } = loadState();
  const { creds, errMsg: credErr } = parseCredentials(config, tr);
  if (credErr) {
    return {
      ok: false,
      tone: 'warning',
      status: tr(
        '请先前往插件设置页配置图床凭证',
        'Configure your image host credentials in plugin settings first',
      ),
    };
  }

  const uploadedItems = [];
  let failedCount = 0;
  let lastError = '';
  for (const localPath of localFiles) {
    const filename = basename(localPath);
    try {
      const remoteUrl = uploadFile(config, creds, '', '', localPath);
      uploadedItems.push([filename, remoteUrl]);
      stats.uploaded_total = Number(stats.uploaded_total || 0) + 1;
      logs = appendLog(logs, `菜单栏 -> ${filename}`, '成功', 'success', remoteUrl);
    } catch (err) {
      const detail = formatUploadException(err);
      failedCount += 1;
      lastError = detail;
      logs = appendLog(logs, filename, '失败', 'danger', detail);
    }
  }

  saveStats(stats);
  saveLogs(logs);

  if (uploadedItems.length === 0) {
    return {
      ok: false,
      tone: 'error',
      status: tr(`上传失败：${lastError}`, `Upload failed: ${lastError}`),
    };
  }

  let recent = loadMenubarRecent();
  recent = recordMenubarRecent(recent, uploadedItems);
  saveMenubarRecent(recent);
  syncMenubarMenu(recent);

  const copyText = formatCopiedLinks(config, uploadedItems);
  const count = uploadedItems.length;
  if (failedCount > 0) {
    return {
      ok: true,
      tone: 'warning',
      status: tr(
        `已上传 ${count} 张并复制链接，${failedCount} 张失败`,
        `Uploaded ${count} image(s) and copied link(s); ${failedCount} failed`,
      ),
      copy_text: copyText,
    };
  }

  const status =
    count === 1
      ? tr('已上传并复制链接', 'Uploaded and copied link')
      : tr(`已上传 ${count} 张图片并复制链接`, `Uploaded ${count} images and copied links`);
  return { ok: true, tone: 'success', status, copy_text: copyText };
}

function handleCopyLink(context) {
  const payload = String(context.payload || '').trim();
  if (payload) {
    return {
      ok: true,
      tone: 'success',
      status: tr('已复制图片链接', 'Copied image link'),
      copy_text: payload,
    };
  }
  const recent = loadMenubarRecent();
  if (recent.length === 0) {
    return {
      ok: false,
      tone: 'info',
      status: tr('暂无最近上传记录', 'No recent uploads yet'),
    };
  }
  return {
    ok: true,
    tone: 'success',
    status: tr('已复制最近上传链接', 'Copied recent upload link'),
    copy_text: recent[0].url,
  };
}

function executeUpload(config, stats, logs, notebooks, { targetNote = null, reportProgress = false } = {}) {
  if (!notebooks || notebooks.length === 0) {
    return {
      stats,
      logs,
      status: noNotebookText(),
      uploadedCount: 0,
      failedCount: 0,
      credErr: '',
    };
  }

  const { totalRefs, noteItems } = scanNotebooks(notebooks, targetNote, {
    normNbPath,
    notebookLabel,
    errorDetail,
    tr,
  });
  const { creds, errMsg } = parseCredentials(config, tr);
  if (errMsg) {
    return {
      stats,
      logs,
      status: tr(`待上传 ${totalRefs} 张图片；${errMsg}`, `${totalRefs} image(s) pending. ${errMsg}`),
      uploadedCount: 0,
      failedCount: 0,
      credErr: errMsg,
    };
  }

  if (totalRefs === 0) {
    return {
      stats,
      logs,
      status: tr('无待上传图片', 'No local images to upload'),
      uploadedCount: 0,
      failedCount: 0,
      credErr: '',
    };
  }

  const uploadedCache = new Map();
  let uploadedCount = 0;
  let failedCount = 0;
  let failureDetail = '';
  const namingRule = config.naming_rule || 'ym_hash';
  const multiNb = notebooks.length > 1;

  // Match collectPendingImages's exact deduplication key (including notePath for note_dir)
  const remainingRefs = new Map();
  const refProgressKeys = [];
  for (const item of noteItems) {
    const noteKeys = [];
    for (const ref of item.refs) {
      let keyPath = ref.local_path || '';
      if (!keyPath) {
        const asset = resolveLocalFile(item.nbRoot, item.notePath, ref.rel_path);
        keyPath = asset ? asset.localPath : ref.rel_path;
      }
      const pkey = uploadDedupeKey(item.nbRoot, keyPath, item.notePath, namingRule);
      noteKeys.push(pkey);
      remainingRefs.set(pkey, (remainingRefs.get(pkey) || 0) + 1);
    }
    refProgressKeys.push(noteKeys);
  }

  const totalFiles = remainingRefs.size;
  const processedKeys = new Set();
  if (reportProgress && totalFiles > 0) {
    emitProgress(0, totalFiles);
  }

  for (let idx = 0; idx < noteItems.length; idx += 1) {
    const item = noteItems[idx];
    const noteKeys = refProgressKeys[idx];
    const { nbRoot, nbName, notePath, content, revision, refs } = item;
    const pieces = [];
    let cursor = 0;
    let noteChanged = false;
    const displayNote = multiNb ? `${nbName}/${notePath}` : notePath;

    for (let rIdx = 0; rIdx < refs.length; rIdx += 1) {
      const ref = refs[rIdx];
      const progressKey = noteKeys[rIdx];
      const { start, end, rel_path: relPath } = ref;
      pieces.push(content.slice(cursor, start));
      cursor = end;
      let refSucceeded = false;

      try {
        let remoteUrl;
        try {
          const asset = resolveLocalFile(nbRoot, notePath, relPath);
          if (asset === null) {
            throw new LocalizedError(tr('未找到本地文件', 'Local file not found.'));
          }
          const localPath = asset.localPath;
          const cacheKey = uploadDedupeKey(nbRoot, localPath, notePath, namingRule);
          remoteUrl = uploadedCache.get(cacheKey);
          if (remoteUrl === undefined) {
            remoteUrl = uploadFile(config, creds, nbRoot, notePath, localPath);
            uploadedCache.set(cacheKey, remoteUrl);
            uploadedCount += 1;
            stats.uploaded_total = Number(stats.uploaded_total || 0) + 1;
            logs = appendLog(
              logs,
              `${displayNote} -> ${basename(localPath)}`,
              '成功',
              'success',
              remoteUrl,
            );
          }
          refSucceeded = true;
        } catch (err) {
          const detail = formatUploadException(err);
          failedCount += 1;
          failureDetail = tr(`${relPath}：${detail}`, `${relPath}: ${detail}`);
          logs = appendLog(logs, relPath, '失败', 'danger', detail);
          pieces.push(content.slice(start, end));
          continue;
        }

        if (ref.kind === 'html') {
          pieces.push(htmlEscape(remoteUrl));
        } else {
          pieces.push(formatMdReplacement(ref, remoteUrl));
        }
        noteChanged = true;
      } finally {
        remainingRefs.set(progressKey, Math.max(0, (remainingRefs.get(progressKey) || 1) - 1));
        if (
          reportProgress &&
          totalFiles > 0 &&
          !processedKeys.has(progressKey) &&
          (refSucceeded || remainingRefs.get(progressKey) <= 0)
        ) {
          processedKeys.add(progressKey);
          emitProgress(Math.min(processedKeys.size, totalFiles), totalFiles);
        }
      }
    }

    pieces.push(content.slice(cursor));
    if (noteChanged) {
      const newContent = pieces.join('');
      try {
        writeNote(nbRoot, notePath, content, revision, newContent, tr);
      } catch (err) {
        failedCount += 1;
        failureDetail = tr(
          `写回笔记失败：${err && err.message ? err.message : err}`,
          `Could not update the note: ${errorDetail(err)}`,
        );
        logs = appendLog(logs, displayNote, '失败', 'danger', failureDetail);
      }
    }
  }

  saveStats(stats);
  saveLogs(logs);

  if (targetNote && failedCount > 0) {
    const toastTitle =
      uploadedCount > 0
        ? tr(
            `自动上传 ${uploadedCount} 张，失败 ${failedCount} 项`,
            `Auto-uploaded ${uploadedCount}, ${failedCount} failed`,
          )
        : tr(`自动上传失败（${failedCount} 项）`, `Auto-upload failed (${failedCount})`);
    const toastTone = uploadedCount > 0 ? 'warning' : 'error';
    notifyUploadResult(toastTitle, failureDetail, toastTone, true);
    throw new LocalizedError(
      tr(
        `自动上传有 ${failedCount} 项失败：${failureDetail}`,
        `Auto-upload failures: ${failedCount}. ${failureDetail}`,
      ),
    );
  }

  if (targetNote && uploadedCount > 0) {
    const noteLabel = Array.isArray(targetNote) && targetNote.length > 1 ? targetNote[1] : '';
    notifyUploadResult(
      tr(`已自动上传 ${uploadedCount} 张图片`, `Auto-uploaded ${uploadedCount} image(s)`),
      noteLabel,
      'success',
    );
  }

  let status;
  if (failedCount > 0 && uploadedCount === 0) {
    status = tr(
      `上传失败 ${failedCount} 项，请查看记录`,
      `${failedCount} upload(s) failed; see Recent uploads`,
    );
  } else if (failedCount > 0) {
    status = tr(
      `已上传 ${uploadedCount} 张，失败 ${failedCount} 项`,
      `Uploaded ${uploadedCount}, ${failedCount} failed`,
    );
  } else {
    status = tr(`已上传 ${uploadedCount} 张图片`, `Uploaded ${uploadedCount} image(s)`);
  }

  return { stats, logs, status, uploadedCount, failedCount, credErr: '' };
}

function saveImmediateConfig(storedCfg, config, incomingValues) {
  const immediateKeys = [
    'selected_notebooks',
    'auto_upload',
    'naming_rule',
    'gh_cdn',
    'menubar_copy_format',
  ];
  const accepted = {};
  let dirty = false;
  for (const key of immediateKeys) {
    if (key in incomingValues) {
      accepted[key] = config[key];
      if (JSON.stringify(storedCfg[key]) !== JSON.stringify(config[key])) {
        storedCfg[key] = config[key];
        dirty = true;
      }
    }
  }
  if (dirty) {
    saveConfig(storedCfg);
  }
  return accepted;
}

function isDraftIncomplete(config) {
  const c = config || {};
  if (c.provider === 'r2' || c.provider === 's3') {
    if (!c.s3_endpoint || !c.s3_bucket || !c.s3_access_key || !c.s3_secret_key) {
      return true;
    }
    if (c.provider === 'r2' && !c.public_domain) {
      return true;
    }
    return false;
  }
  return !c.gh_repo || !c.gh_token;
}

function renderSettingsPage({
  config,
  logs,
  selected,
  noteItems,
  connState = null,
  statusOverride = null,
}) {
  return buildPage({
    config,
    logs,
    selected,
    noteItems,
    knownNotebooks: state.knownNotebooks,
    supportsAddFolder: state.supportsAddFolder,
    supportsFormAutosave: state.supportsFormAutosave,
    supportsProgressBar: state.supportsProgressBar,
    connState,
    homeDir: state.homeDir,
    isEnglish: isEnglish(),
    tr,
    errorDetail,
    statusOverride,
  });
}

function handle(method, params) {
  if (method === 'plugin.initialize') {
    state.downloadsDir = String(params.downloads_dir || '');
    state.homeDir = deriveHomeDir(state.downloadsDir);
    state.notebookRoot = normNbPath(params.notebook_root || '');
    state.dataDir = String(params.data_dir || '');
    state.locale = String(params.locale || 'zh');
    const caps = new Set(Array.isArray(params.ui_capabilities) ? params.ui_capabilities : []);
    state.supportsChecklist = caps.has('checklist');
    state.supportsAddFolder = caps.has('checklist_add_folder');
    state.supportsMultiNotebook = caps.has('multi_notebook');
    state.supportsActionProgress = caps.has('action_progress');
    state.supportsProgressBar = caps.has('progress_bar');
    state.supportsFormAutosave = caps.has('form_autosave');
    state.supportsButtonLink = caps.has('button_link');
    state.supportsToastBanner = caps.has('toast_banner');
    state.supportsOpenSettings = caps.has('open_settings');

    const rawNbs = params.notebooks;
    if (Array.isArray(rawNbs)) {
      state.knownNotebooks = rawNbs
        .filter((p) => String(p || '').trim())
        .map((p) => {
          const norm = normNbPath(p);
          return {
            path: norm,
            name: basename(norm) || String(p),
            active: norm === state.notebookRoot,
          };
        });
    }
    try {
      const recent = loadMenubarRecent();
      if (recent.length > 0) {
        syncMenubarMenu(recent);
      }
    } catch {
      // Ignore startup menubar sync errors
    }
    return { ready: true };
  }

  if (method === 'plugin.render') {
    const { config: storedCfg, logs, connState } = loadState();
    const incomingValues = isPlainObject(params.values) ? params.values : {};
    const config =
      Object.keys(incomingValues).length > 0
        ? normalizeConfig({ ...storedCfg, ...incomingValues }, normNbPath)
        : storedCfg;
    const selected = selectedNotebooks(config);
    const { noteItems } = scanNotebooks(selected, null, {
      normNbPath,
      notebookLabel,
      errorDetail,
      tr,
    });
    const page = renderSettingsPage({ config, logs, selected, noteItems, connState });
    const accepted = saveImmediateConfig(storedCfg, config, incomingValues);
    return { page, values: accepted };
  }

  if (method === 'plugin.action') {
    const actionId = String(params.action_id || '');
    const isAutosave = String(params.trigger || '') === 'autosave';
    if (actionId === 'open_image_host_settings') {
      if (state.supportsOpenSettings) {
        try {
          callHost('host.ui.open_settings', {});
        } catch {
          // Ignore open_settings failures
        }
      }
      return { ok: true };
    }

    const incomingValues = isPlainObject(params.values) ? params.values : {};
    const { config: prevConfig, stats: prevStats, logs: prevLogs, connState: prevConnState } = loadState();
    const config = normalizeConfig({ ...prevConfig, ...incomingValues }, normNbPath);
    const selected = selectedNotebooks(config);

    if (actionId === 'rescan') {
      saveImmediateConfig(prevConfig, config, incomingValues);
      const { totalRefs, noteItems } = scanNotebooks(selected, null, {
        normNbPath,
        notebookLabel,
        errorDetail,
        tr,
      });
      let ok;
      let tone;
      let status;
      if (selected.length === 0) {
        ok = false;
        tone = 'warning';
        status = noNotebookText();
      } else if (totalRefs === 0) {
        ok = true;
        tone = 'success';
        status = tr('无待上传图片', 'No images to upload');
      } else {
        ok = true;
        tone = 'success';
        const pendingCount = collectPendingImages(
          noteItems,
          selected.length > 1,
          config.naming_rule || 'ym_hash',
        ).length;
        status = tr(`待上传 ${pendingCount} 张图片`, `${pendingCount} image(s) pending`);
      }
      const page = renderSettingsPage({
        config,
        logs: prevLogs,
        selected,
        noteItems,
        connState: prevConnState,
        statusOverride: status,
      });
      return { ok, tone, values: config, page, status };
    }

    if (actionId === 'save_config') {
      const { errMsg: credErr } = parseCredentials(config, tr);
      if (credErr) {
        if (isAutosave) {
          if (isDraftIncomplete(config)) {
            return { ok: true, tone: 'info', status: '' };
          }
          return { ok: false, tone: 'danger', status: credErr };
        }
        const { noteItems } = scanNotebooks(selected, null, {
          normNbPath,
          notebookLabel,
          errorDetail,
          tr,
        });
        const page = renderSettingsPage({
          config,
          logs: prevLogs,
          selected,
          noteItems,
          connState: prevConnState,
          statusOverride: credErr,
        });
        return { ok: false, tone: 'danger', values: config, page, status: credErr };
      }

      const connChanged = connConfigSignature(prevConfig) !== connConfigSignature(config);
      saveConfig(config);
      let nextLogs = prevLogs;
      let nextConnState = prevConnState;

      if (isAutosave && connChanged) {
        emitProgress(null, null, null, {
          channel: 'image_host',
          label: tr('已保存 · 正在检测连接…', 'Saved · Checking connection…'),
          tone: 'accent',
          running: true,
        });
        const { ok: testOk, message } = testConnection(config, {
          tr,
          isEnglish: isEnglish(),
          errorDetail,
        });
        const testTone = testOk ? 'success' : 'danger';
        nextLogs = appendLog(
          prevLogs,
          `连接测试（${PROVIDER_LABELS[config.provider]}）`,
          testOk ? '成功' : '失败',
          testTone,
          message,
        );
        saveLogs(nextLogs);
        nextConnState = {
          ok: Boolean(testOk),
          message,
          target_sig: connConfigSignature(config),
          time: formatLocalTime(new Date()),
          locale: isEnglish() ? 'en' : 'zh',
        };
        saveConnState(nextConnState);
      }

      const { noteItems } = scanNotebooks(selected, null, {
        normNbPath,
        notebookLabel,
        errorDetail,
        tr,
      });
      if (isAutosave) {
        const page = renderSettingsPage({
          config,
          logs: nextLogs,
          selected,
          noteItems,
          connState: nextConnState,
        });
        return { ok: true, tone: 'success', values: config, page, status: '' };
      }
      const status = tr('已保存配置', 'Configuration saved');
      const page = renderSettingsPage({
        config,
        logs: nextLogs,
        selected,
        noteItems,
        connState: nextConnState,
        statusOverride: status,
      });
      return { ok: true, tone: 'success', values: config, page, status };
    }

    if (actionId === 'test_conn') {
      const { noteItems } = scanNotebooks(selected, null, {
        normNbPath,
        notebookLabel,
        errorDetail,
        tr,
      });
      const { ok, message } = testConnection(config, {
        tr,
        isEnglish: isEnglish(),
        errorDetail,
      });
      const tone = ok ? 'success' : 'danger';
      const logs = appendLog(
        prevLogs,
        `连接测试（${PROVIDER_LABELS[config.provider]}）`,
        ok ? '成功' : '失败',
        tone,
        message,
      );
      saveLogs(logs);
      const nextConnState = {
        ok: Boolean(ok),
        message,
        target_sig: connConfigSignature(config),
        time: formatLocalTime(new Date()),
        locale: isEnglish() ? 'en' : 'zh',
      };
      saveConnState(nextConnState);
      const page = renderSettingsPage({
        config,
        logs,
        selected,
        noteItems,
        connState: nextConnState,
        statusOverride: message,
      });
      return { ok, tone, values: config, page, status: message };
    }

    if (actionId === 'upload_now') {
      const res = executeUpload(config, prevStats, prevLogs, selected, { reportProgress: true });
      const { logs, status, uploadedCount, failedCount, credErr } = res;
      let ok;
      let tone;
      let nextConnState = prevConnState;
      if (selected.length === 0) {
        ok = false;
        tone = 'warning';
      } else if (credErr || (failedCount > 0 && uploadedCount === 0)) {
        ok = false;
        tone = 'danger';
      } else if (failedCount > 0) {
        ok = false;
        tone = 'warning';
      } else if (uploadedCount === 0) {
        ok = true;
        tone = 'info';
        saveConfig(config);
      } else {
        ok = true;
        tone = 'success';
        saveConfig(config);
        if (prevConnState && prevConnState.ok === false) {
          nextConnState = {
            ok: true,
            message: '',
            target_sig: connConfigSignature(config),
            time: formatLocalTime(new Date()),
            locale: isEnglish() ? 'en' : 'zh',
          };
          saveConnState(nextConnState);
        }
      }
      if (uploadedCount > 0 || failedCount > 0) {
        notifyUploadResult(status, '', tone, failedCount > 0);
      }
      const { noteItems } = scanNotebooks(selected, null, {
        normNbPath,
        notebookLabel,
        errorDetail,
        tr,
      });
      const page = renderSettingsPage({
        config,
        logs,
        selected,
        noteItems,
        connState: nextConnState,
        statusOverride: status,
      });
      return { ok, tone, values: config, page, status };
    }

    const { noteItems } = scanNotebooks(selected, null, {
      normNbPath,
      notebookLabel,
      errorDetail,
      tr,
    });
    const engActionId = englishDiagnostic(actionId);
    const status = tr(
      `未知操作：${actionId}`,
      engActionId ? `Unknown action: ${engActionId}` : 'Unknown action.',
    );
    const page = renderSettingsPage({
      config,
      logs: prevLogs,
      selected,
      noteItems,
      connState: prevConnState,
      statusOverride: status,
    });
    return { ok: false, tone: 'warning', values: config, page, status };
  }

  if (method === 'plugin.command') {
    const commandId = String(params.command_id || '').trim();
    const context = isPlainObject(params.context) ? params.context : {};
    if (commandId === 'upload-clipboard' || commandId === 'upload-dropped') {
      return handleMenubarUpload(commandId, context);
    }
    if (commandId === 'copy-link') {
      return handleCopyLink(context);
    }
    const engCmd = englishDiagnostic(commandId);
    return {
      ok: false,
      tone: 'warning',
      status: tr(
        `未知命令：${commandId}`,
        engCmd ? `Unknown command: ${engCmd}` : 'Unknown command',
      ),
    };
  }

  if (method === 'plugin.event') {
    const eventName = params.event;
    if (eventName === 'locale.changed' && params.locale) {
      state.locale = String(params.locale);
      return { handled: true };
    }
    if (eventName === 'note.saved') {
      const { config, stats, logs } = loadState();
      if (config.auto_upload && isConfigReady(config, tr)) {
        const notePath = String(params.path || '');
        const eventNb = normNbPath(params.notebook_root || state.notebookRoot);
        const selected = selectedNotebooks(config);
        if (notePath.trim() && eventNb && selected.includes(eventNb)) {
          executeUpload(config, stats, logs, selected, {
            targetNote: [eventNb, notePath],
          });
        }
      }
    }
    return { handled: true };
  }

  if (method === 'plugin.shutdown') {
    return { ok: true };
  }

  throw new Error(`unsupported method: ${method}`);
}

serve((method, params) => {
  try {
    return handle(method, params);
  } catch (err) {
    const localized = new Error(errorDetail(err));
    if (err && typeof err.code === 'number') {
      localized.code = err.code;
    }
    throw localized;
  }
});
