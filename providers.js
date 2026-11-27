import { callHost } from '/runtime/block-sdk.js';
import {
  awsUriEncode,
  basename,
  bytesToBase64,
  englishDiagnostic,
  guessMimeType,
  isPlainObject,
  normalizePath,
  parseUrl,
  prependAsciiToBase64,
  relativePath,
} from './paths.js';
import { extractAssetTimestampSec } from './markdown.js';

export const DEFAULT_CONFIG = {
  provider: 'r2',
  s3_endpoint: '',
  s3_bucket: '',
  s3_access_key: '',
  s3_secret_key: '',
  public_domain: '',
  gh_repo: '',
  gh_branch: 'main',
  gh_token: '',
  gh_cdn: 'jsdelivr',
  remote_prefix: '',
  auto_upload: true,
  naming_rule: 'ym_hash',
  menubar_copy_format: 'markdown',
  selected_notebooks: [],
};

export const PROVIDER_LABELS = {
  r2: 'Cloudflare R2',
  s3: 'S3 兼容',
  github: 'GitHub 仓库',
};

export const EN_PROVIDER_LABELS = {
  r2: 'Cloudflare R2',
  s3: 'S3-compatible',
  github: 'GitHub repository',
};

export const VALID_PROVIDERS = new Set(['r2', 's3', 'github']);
export const VALID_GH_CDNS = new Set(['jsdelivr', 'raw']);
export const VALID_NAMING_RULES = new Set(['ym_hash', 'note_dir', 'original']);
export const VALID_COPY_FORMATS = new Set(['markdown', 'url']);

export class HttpError extends Error {
  constructor(status, headers, body) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers || {};
    this.body = body || '';
  }
}

export class NetworkError extends Error {
  constructor(reason) {
    super(String(reason || 'network error'));
    this.name = 'NetworkError';
    this.reason = this.message;
  }
}

export function normalizeConfig(raw, normNbPathFn) {
  const cfg = { ...DEFAULT_CONFIG, selected_notebooks: [] };
  if (!isPlainObject(raw)) {
    return cfg;
  }

  const provider = String(raw.provider ?? cfg.provider).trim();
  if (VALID_PROVIDERS.has(provider)) {
    cfg.provider = provider;
  }

  const strFields = [
    's3_endpoint',
    's3_bucket',
    's3_access_key',
    's3_secret_key',
    'public_domain',
    'gh_repo',
    'gh_branch',
    'gh_token',
    'remote_prefix',
  ];
  for (const key of strFields) {
    if (key in raw && raw[key] !== null && raw[key] !== undefined) {
      cfg[key] = String(raw[key]).trim();
    }
  }

  // Backward compatibility with legacy config keys
  const legacyEndpoint = String(raw.endpoint ?? '').trim();
  if (legacyEndpoint) {
    if ((cfg.provider === 'r2' || cfg.provider === 's3') && !cfg.s3_endpoint) {
      cfg.s3_endpoint = legacyEndpoint;
    } else if (cfg.provider === 'github' && !cfg.gh_repo) {
      cfg.gh_repo = legacyEndpoint;
    }
  }

  const legacyBucket = String(raw.bucket_prefix ?? '').trim();
  if (legacyBucket && (cfg.provider === 'r2' || cfg.provider === 's3') && !cfg.s3_bucket) {
    cfg.s3_bucket = legacyBucket;
  }

  const legacySecret = String(raw.access_secret ?? '').trim();
  if (legacySecret) {
    if (
      (cfg.provider === 'r2' || cfg.provider === 's3') &&
      !cfg.s3_access_key &&
      !cfg.s3_secret_key &&
      legacySecret.includes(':')
    ) {
      const idx = legacySecret.indexOf(':');
      cfg.s3_access_key = legacySecret.slice(0, idx).trim();
      cfg.s3_secret_key = legacySecret.slice(idx + 1).trim();
    } else if (cfg.provider === 'github' && !cfg.gh_token) {
      cfg.gh_token = legacySecret;
    }
  }

  const legacyBranch = raw.gh_branch_preset;
  if (legacyBranch === 'main' || legacyBranch === 'master') {
    cfg.gh_branch = legacyBranch;
  }

  if (!('remote_prefix' in raw)) {
    const legacyPrefix = raw.prefix_preset;
    if (legacyPrefix === 'images' || legacyPrefix === 'block') {
      cfg.remote_prefix = legacyPrefix;
    } else if (legacyPrefix === 'custom') {
      cfg.remote_prefix = String(raw.custom_prefix ?? '').trim();
    }
  }

  const ghCdn = String(raw.gh_cdn ?? cfg.gh_cdn).trim();
  if (VALID_GH_CDNS.has(ghCdn)) {
    cfg.gh_cdn = ghCdn;
  }

  if ('auto_upload' in raw) {
    cfg.auto_upload = Boolean(raw.auto_upload);
  }

  const namingRule = String(raw.naming_rule ?? cfg.naming_rule).trim();
  if (VALID_NAMING_RULES.has(namingRule)) {
    cfg.naming_rule = namingRule;
  }

  const copyFormat = String(raw.menubar_copy_format ?? cfg.menubar_copy_format).trim();
  if (VALID_COPY_FORMATS.has(copyFormat)) {
    cfg.menubar_copy_format = copyFormat;
  }

  if (Array.isArray(raw.selected_notebooks)) {
    const seen = new Set();
    const dedup = [];
    for (const item of raw.selected_notebooks) {
      const norm = normNbPathFn(item);
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        dedup.push(norm);
      }
    }
    cfg.selected_notebooks = dedup;
  }

  return cfg;
}

export function effectivePrefix(config, bucketPrefix = '') {
  const prefix = String(config.remote_prefix ?? '').replace(/^\/+|\/+$/g, '');
  const bp = String(bucketPrefix ?? '').replace(/^\/+|\/+$/g, '');
  return [bp, prefix].filter(Boolean).join('/');
}

export function detectS3Region(provider, netloc) {
  if (provider === 'r2') {
    return 'auto';
  }
  const patterns = [
    /s3[.-]([a-z0-9-]+)\.amazonaws\.com/i,
    /s3\.([a-z0-9-]+)\.backblazeb2\.com/i,
    /([a-z0-9-]+)\.digitaloceanspaces\.com/i,
    /oss-([a-z0-9-]+)\.aliyuncs\.com/i,
    /cos\.([a-z0-9-]+)\.myqcloud\.com/i,
  ];
  for (const pat of patterns) {
    const m = pat.exec(netloc);
    if (m) {
      return m[1].toLowerCase();
    }
  }
  return 'us-east-1';
}

export function parseS3Credentials(config, tr) {
  let endpoint = String(config.s3_endpoint || '').trim();
  if (!endpoint) {
    return { creds: null, errMsg: tr('请填写 Endpoint 地址', 'Enter an endpoint URL.') };
  }
  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    endpoint = `https://${endpoint}`;
  }
  let parsed = parseUrl(endpoint);
  if (!parsed || !parsed.netloc) {
    return { creds: null, errMsg: tr('Endpoint 地址格式无效', 'Enter a valid endpoint URL.') };
  }

  const bp = String(config.s3_bucket || '').trim().replace(/^\/+|\/+$/g, '');
  if (!bp) {
    return { creds: null, errMsg: tr('请填写 Bucket 存储桶名', 'Enter a bucket name.') };
  }
  const slashIdx = bp.indexOf('/');
  const bucket = (slashIdx >= 0 ? bp.slice(0, slashIdx) : bp).trim();
  const bucketPrefix = slashIdx >= 0 ? bp.slice(slashIdx + 1).replace(/^\/+|\/+$/g, '') : '';
  if (!bucket) {
    return { creds: null, errMsg: tr('Bucket 存储桶名不能为空', 'The bucket name cannot be empty.') };
  }

  if (parsed.path.replace(/^\/+|\/+$/g, '') === bucket) {
    endpoint = `${parsed.scheme}://${parsed.netloc}`;
    parsed = parseUrl(endpoint);
  }

  const prefix = effectivePrefix(config, bucketPrefix);

  const accessKey = String(config.s3_access_key || '').trim();
  const secretKey = String(config.s3_secret_key || '').trim();
  if (!accessKey || !secretKey) {
    return {
      creds: null,
      errMsg: tr(
        '请完整填写 Access Key ID 与 Secret Access Key',
        'Enter both the Access Key ID and Secret Access Key.',
      ),
    };
  }

  let publicDomain = String(config.public_domain || '').trim().replace(/\/+$/, '');
  if (publicDomain && !publicDomain.startsWith('http://') && !publicDomain.startsWith('https://')) {
    publicDomain = `https://${publicDomain}`;
  }
  if (config.provider === 'r2' && !publicDomain) {
    return {
      creds: null,
      errMsg: tr(
        'Cloudflare R2 需填写公开访问域名（如 https://pub-xxx.r2.dev），否则图片无法公开加载',
        'Enter a public domain for Cloudflare R2 (e.g. https://pub-xxx.r2.dev) so images can load publicly.',
      ),
    };
  }

  const region = detectS3Region(config.provider, parsed.netloc);

  return {
    creds: {
      endpoint: endpoint.replace(/\/+$/, ''),
      parsed_endpoint: parsed,
      bucket,
      prefix,
      public_domain: publicDomain,
      access_key: accessKey,
      secret_key: secretKey,
      region,
    },
    errMsg: null,
  };
}

export function parseGitHubRepo(repoSpec) {
  let spec = String(repoSpec || '').trim();
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    const parsed = parseUrl(spec);
    spec = (parsed ? parsed.path : '').replace(/^\/+|\/+$/g, '');
    if (spec.endsWith('.git')) {
      spec = spec.slice(0, -4);
    }
  }
  let branchHint = '';
  if (spec.includes('@')) {
    const idx = spec.indexOf('@');
    branchHint = spec.slice(idx + 1).trim();
    spec = spec.slice(0, idx);
  }
  const parts = spec.split('/').filter(Boolean);
  if (parts.length !== 2) {
    return { owner: null, repo: null, branchHint };
  }
  return { owner: parts[0], repo: parts[1], branchHint };
}

export function parseGitHubCredentials(config, tr) {
  const repoSpec = String(config.gh_repo || '').trim();
  if (!repoSpec) {
    return {
      creds: null,
      errMsg: tr(
        '请填写 GitHub 仓库（格式: owner/repo）',
        'Enter a GitHub repository (owner/repo).',
      ),
    };
  }
  const { owner, repo, branchHint } = parseGitHubRepo(repoSpec);
  if (!owner || !repo) {
    return {
      creds: null,
      errMsg: tr(
        'GitHub 仓库格式应为 owner/repo',
        'Use the owner/repo format for the GitHub repository.',
      ),
    };
  }

  const branch = config.gh_branch || branchHint || 'main';
  const token = String(config.gh_token || '').trim();
  if (!token) {
    return {
      creds: null,
      errMsg: tr(
        '请填写 GitHub Personal Access Token',
        'Enter a GitHub personal access token.',
      ),
    };
  }

  const ghCdn = VALID_GH_CDNS.has(config.gh_cdn) ? config.gh_cdn : 'jsdelivr';

  return {
    creds: {
      owner,
      repo,
      branch,
      prefix: effectivePrefix(config),
      token,
      gh_cdn: ghCdn,
    },
    errMsg: null,
  };
}

export function parseCredentials(config, tr) {
  if (config.provider === 'r2' || config.provider === 's3') {
    return parseS3Credentials(config, tr);
  }
  return parseGitHubCredentials(config, tr);
}

export function extractHttpErrorDetail(err, isEnglish) {
  let detail = `HTTP ${err.status}`;
  try {
    const text = String(err.body || '').slice(0, 4096).trim();
    if (!text) {
      return detail;
    }
    if (text.startsWith('{')) {
      const data = JSON.parse(text);
      let msg = String((data && data.message) || '').trim();
      if (isEnglish) {
        msg = englishDiagnostic(msg);
      }
      if (msg) {
        return `HTTP ${err.status}: ${msg}`;
      }
    }
    const codeM = /<Code>([^<]+)<\/Code>/.exec(text);
    const msgM = /<Message>([^<]+)<\/Message>/.exec(text);
    let code = codeM ? codeM[1] : '';
    let msg = msgM ? msgM[1] : '';
    if (isEnglish) {
      code = englishDiagnostic(code);
      msg = englishDiagnostic(msg);
    }
    if (code) {
      detail = `${detail} (${code})`;
      if (msg || (msgM && !isEnglish)) {
        return `${detail}: ${msg}`;
      }
    }
  } catch {
    // Ignore parse failures and fall back to status code
  }
  return detail;
}

function getHeaderIgnoreCase(headers, targetName) {
  if (!isPlainObject(headers)) {
    return '';
  }
  const want = targetName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) {
      const raw = Array.isArray(v) ? v[0] : v;
      return String(raw ?? '').trim();
    }
  }
  return '';
}

function hexToBytes(hex) {
  const clean = String(hex || '').trim();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16) & 0xff;
  }
  return out;
}

function hmacBase64(res) {
  if (isPlainObject(res) && typeof res.base64 === 'string' && res.base64) {
    return res.base64;
  }
  if (isPlainObject(res) && typeof res.hex === 'string' && res.hex) {
    return bytesToBase64(hexToBytes(res.hex));
  }
  throw new Error('Invalid HMAC response from host');
}

function sha256Hex(params) {
  const res = callHost('host.crypto.hash', { algorithm: 'sha256', ...params });
  const hex = isPlainObject(res) ? String(res.hex ?? res.hash ?? '').toLowerCase() : '';
  if (!hex) {
    throw new Error('Invalid SHA-256 response from host');
  }
  return hex;
}

function sha1Hex(params) {
  const res = callHost('host.crypto.hash', { algorithm: 'sha1', ...params });
  const hex = isPlainObject(res) ? String(res.hex ?? res.hash ?? '').toLowerCase() : '';
  if (!hex) {
    throw new Error('Invalid SHA-1 response from host');
  }
  return hex;
}

function formatAmzTimestamps(date) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = pad2(date.getUTCMonth() + 1);
  const dd = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  const dateStamp = `${yyyy}${mm}${dd}`;
  return { dateStamp, amzDate: `${dateStamp}T${hh}${mi}${ss}Z` };
}

function performHttpRequest(req) {
  let res;
  try {
    res = callHost('host.http.request', req);
  } catch (err) {
    throw new NetworkError(err && err.message ? err.message : err);
  }
  if (!isPlainObject(res) || typeof res.status !== 'number') {
    throw new NetworkError('Invalid HTTP response from host');
  }
  const body = typeof res.body === 'string' ? res.body : '';
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(res.status, res.headers || {}, body);
  }
  return res;
}

export function s3SignedRequestOnce(creds, method, pathSegments, queryParams = null, options = {}) {
  const parsed = creds.parsed_endpoint;
  const basePath = parsed.path.replace(/\/+$/, '');
  const quotedSegs = pathSegments.filter((seg) => seg !== '').map((seg) => awsUriEncode(seg));
  let canonicalUri = `${basePath}/${quotedSegs.join('/')}`;
  if (!canonicalUri.startsWith('/')) {
    canonicalUri = `/${canonicalUri}`;
  }

  const queryItems = Object.entries(queryParams || {}).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const canonicalQs = queryItems
    .map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`)
    .join('&');

  const { dateStamp, amzDate } = formatAmzTimestamps(new Date());
  const bodyFilePath = options.bodyFilePath || '';
  const bodyText = options.bodyText ?? '';
  const payloadHash =
    options.payloadHash ||
    (bodyFilePath ? sha256Hex({ file_path: bodyFilePath }) : sha256Hex({ text: bodyText }));
  const hostHeader = parsed.netloc;

  const headersToSign = {
    host: hostHeader,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const sortedHeaderKeys = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headersToSign[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQs,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${creds.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex({ text: canonicalRequest }),
  ].join('\n');

  const kDate = callHost('host.crypto.hmac', {
    algorithm: 'sha256',
    key_text: `AWS4${creds.secret_key}`,
    data_text: dateStamp,
  });
  const kRegion = callHost('host.crypto.hmac', {
    algorithm: 'sha256',
    key_base64: hmacBase64(kDate),
    data_text: creds.region,
  });
  const kService = callHost('host.crypto.hmac', {
    algorithm: 'sha256',
    key_base64: hmacBase64(kRegion),
    data_text: 's3',
  });
  const kSigning = callHost('host.crypto.hmac', {
    algorithm: 'sha256',
    key_base64: hmacBase64(kService),
    data_text: 'aws4_request',
  });
  const sigRes = callHost('host.crypto.hmac', {
    algorithm: 'sha256',
    key_base64: hmacBase64(kSigning),
    data_text: stringToSign,
  });
  const signature = isPlainObject(sigRes) ? String(sigRes.hex || '').toLowerCase() : '';
  if (!signature) {
    throw new Error('Invalid HMAC signature from host');
  }

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${creds.access_key}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  let url = `${parsed.scheme}://${parsed.netloc}${canonicalUri}`;
  if (canonicalQs) {
    url += `?${canonicalQs}`;
  }

  const reqHeaders = {
    Host: hostHeader,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: authHeader,
  };
  if (options.contentType) {
    reqHeaders['Content-Type'] = options.contentType;
  }

  const req = {
    method,
    url,
    headers: reqHeaders,
    response_encoding: 'utf8',
    timeout_ms: 20000,
  };
  if (bodyFilePath) {
    req.body_file_path = bodyFilePath;
  } else if (method === 'PUT' && bodyText) {
    req.body = bodyText;
  }

  const res = performHttpRequest(req);
  return { status: res.status, body: res.body || '' };
}

export function s3SignedRequest(creds, method, pathSegments, queryParams = null, options = {}) {
  try {
    return s3SignedRequestOnce(creds, method, pathSegments, queryParams, options);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 301 || err.status === 400 || err.status === 403)) {
      let hintRegion = getHeaderIgnoreCase(err.headers, 'x-amz-bucket-region');
      if (!hintRegion && err.body) {
        const m = /<Region>([^<]+)<\/Region>/.exec(err.body.slice(0, 2048));
        if (m) {
          hintRegion = m[1].trim();
        }
      }
      if (hintRegion && hintRegion !== creds.region) {
        creds.region = hintRegion;
        return s3SignedRequestOnce(creds, method, pathSegments, queryParams, options);
      }
    }
    throw err;
  }
}

export function githubApiRequest(creds, method, apiUrl, payload = undefined) {
  const headers = {
    Authorization: `Bearer ${creds.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'block-image-host/1.2',
  };
  const req = {
    method,
    url: apiUrl,
    headers,
    response_encoding: 'utf8',
    timeout_ms: 20000,
  };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    req.body = JSON.stringify(payload);
  }
  const res = performHttpRequest(req);
  const raw = String(res.body || '');
  return { status: res.status, data: raw ? JSON.parse(raw) : {} };
}

function formatUtcYearMonth(assetTimeSec) {
  const dt = new Date(assetTimeSec * 1000);
  const yyyy = String(dt.getUTCFullYear()).padStart(4, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}/${mm}`;
}

export function buildRemoteKey(namingRule, prefix, nbRoot, notePath, localPath, fileSha256Hex, assetTimeSec) {
  const filename = basename(localPath);
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  let identity;
  if (nbRoot && notePath) {
    const root = normalizePath(nbRoot);
    identity = [root, relativePath(root, localPath), fileSha256Hex];
  } else {
    identity = ['menubar', filename, fileSha256Hex];
  }

  let folder = '';
  if (namingRule === 'note_dir' && notePath) {
    const canonicalNote = normalizePath(notePath);
    identity.push(canonicalNote);
    let stem = canonicalNote.replace(/\\/g, '/');
    if (stem.toLowerCase().endsWith('.md')) {
      stem = stem.slice(0, -3);
    }
    folder =
      stem
        .split('/')
        .filter((part) => part && part !== '.' && part !== '..')
        .map((part) => part.replace(/[^A-Za-z0-9._-]/g, '_'))
        .join('/') || 'notes';
  } else if (namingRule === 'ym_hash' || namingRule === 'note_dir') {
    folder = formatUtcYearMonth(assetTimeSec);
  }

  const digest = sha256Hex({ text: JSON.stringify(identity) });
  return [prefix, folder, digest, safeName].filter(Boolean).join('/');
}

function base64DecodedByteLength(b64) {
  const clean = String(b64 ?? '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) {
    return 0;
  }
  let pad = 0;
  if (clean.endsWith('==')) pad = 2;
  else if (clean.endsWith('=')) pad = 1;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
}

export function uploadFile(config, creds, nbRoot, notePath, localPath) {
  const statRes = callHost('host.fs.stat', { path: localPath });
  const assetTimeSec = extractAssetTimestampSec(statRes);
  const fileSha256Hex = sha256Hex({ file_path: localPath });
  const remoteKey = buildRemoteKey(
    config.naming_rule || 'ym_hash',
    creds.prefix || '',
    nbRoot,
    notePath,
    localPath,
    fileSha256Hex,
    assetTimeSec,
  );
  const contentType = guessMimeType(localPath);

  if (config.provider === 'r2' || config.provider === 's3') {
    const segments = [creds.bucket, ...remoteKey.split('/')];
    s3SignedRequest(creds, 'PUT', segments, null, {
      bodyFilePath: localPath,
      payloadHash: fileSha256Hex,
      contentType,
    });
    const encodedKey = remoteKey
      .split('/')
      .map((seg) => awsUriEncode(seg))
      .join('/');
    if (creds.public_domain) {
      return `${creds.public_domain}/${encodedKey}`;
    }
    return `${creds.endpoint}/${awsUriEncode(creds.bucket)}/${encodedKey}`;
  }

  const encodedPath = remoteKey
    .split('/')
    .map((seg) => awsUriEncode(seg))
    .join('/');
  const apiUrl = `https://api.github.com/repos/${creds.owner}/${creds.repo}/contents/${encodedPath}`;
  let existingSha = null;
  try {
    const { data: info } = githubApiRequest(
      creds,
      'GET',
      `${apiUrl}?ref=${encodeURIComponent(creds.branch)}`,
    );
    if (isPlainObject(info) && info.sha) {
      existingSha = info.sha;
    }
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) {
      throw err;
    }
  }

  const readRes = callHost('host.fs.read', { path: localPath, encoding: 'base64' });
  const fileB64 = String(
    (isPlainObject(readRes)
      ? readRes.content_base64 ?? readRes.content ?? readRes.base64 ?? readRes.data
      : '') || '',
  );
  let needUpload = !existingSha;
  if (!needUpload) {
    const byteLen = base64DecodedByteLength(fileB64);
    const blobB64 = prependAsciiToBase64(`blob ${byteLen}\0`, fileB64);
    const blobSha1 = sha1Hex({ base64: blobB64 });
    needUpload = existingSha !== blobSha1;
  }

  if (needUpload) {
    const payload = {
      message: `chore(image-host): upload ${basename(localPath)}`,
      content: fileB64,
      branch: creds.branch,
    };
    if (existingSha) {
      payload.sha = existingSha;
    }
    githubApiRequest(creds, 'PUT', apiUrl, payload);
  }

  const branchQuoted = creds.branch
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  if (creds.gh_cdn === 'jsdelivr') {
    return `https://cdn.jsdelivr.net/gh/${creds.owner}/${creds.repo}@${branchQuoted}/${encodedPath}`;
  }
  return `https://raw.githubusercontent.com/${creds.owner}/${creds.repo}/${branchQuoted}/${encodedPath}`;
}

export function providerLabel(provider, isEnglish) {
  const labels = isEnglish ? EN_PROVIDER_LABELS : PROVIDER_LABELS;
  return labels[provider] || provider;
}

export function testConnection(config, { tr, isEnglish, errorDetail }) {
  if (config.provider === 'r2' || config.provider === 's3') {
    const { creds, errMsg } = parseS3Credentials(config, tr);
    if (errMsg) {
      return { ok: false, message: errMsg };
    }
    try {
      s3SignedRequest(creds, 'GET', [creds.bucket], { 'list-type': '2', 'max-keys': '1' });
      return {
        ok: true,
        message: tr(
          `${PROVIDER_LABELS[config.provider]} 连接成功（存储桶 ${creds.bucket} 可访问）`,
          `Connected to ${providerLabel(config.provider, isEnglish)}. Bucket ${creds.bucket} is accessible.`,
        ),
      };
    } catch (err) {
      if (err instanceof HttpError) {
        const detail = extractHttpErrorDetail(err, isEnglish);
        return {
          ok: false,
          message: tr(
            `图床服务端返回 ${detail}，请核对凭证、区域或存储桶权限`,
            `The image host returned ${detail}. Check your credentials, region, and bucket permissions.`,
          ),
        };
      }
      if (err instanceof NetworkError) {
        return {
          ok: false,
          message: tr(
            `无法连接图床服务（${err.reason}）`,
            `Could not connect to the image host: ${errorDetail(err.reason)}`,
          ),
        };
      }
      return {
        ok: false,
        message: tr(
          `连接校验失败：${err && err.message ? err.message : err}`,
          `Connection test failed: ${errorDetail(err)}`,
        ),
      };
    }
  }

  const { creds, errMsg } = parseGitHubCredentials(config, tr);
  if (errMsg) {
    return { ok: false, message: errMsg };
  }
  try {
    const apiUrl = `https://api.github.com/repos/${creds.owner}/${creds.repo}`;
    const { data: info } = githubApiRequest(creds, 'GET', apiUrl);
    const perms = isPlainObject(info) && isPlainObject(info.permissions) ? info.permissions : {};
    if (perms.push === false) {
      return {
        ok: false,
        message: tr(
          `已连接仓库 ${creds.owner}/${creds.repo}，但当前令牌缺少写入权限`,
          `Connected to ${creds.owner}/${creds.repo}, but the token lacks write access.`,
        ),
      };
    }
    if (isPlainObject(info) && Number(info.size || 0) > 0) {
      const branchUrl = `${apiUrl}/branches/${encodeURIComponent(creds.branch)}`;
      try {
        githubApiRequest(creds, 'GET', branchUrl);
      } catch (bErr) {
        if (bErr instanceof HttpError && bErr.status === 404) {
          const defaultBr = info.default_branch || 'main';
          return {
            ok: false,
            message: tr(
              `仓库 ${creds.owner}/${creds.repo} 中不存在分支 ${creds.branch}（默认分支为 ${defaultBr}）`,
              `Branch ${creds.branch} was not found in ${creds.owner}/${creds.repo} (default branch: ${defaultBr}).`,
            ),
          };
        }
        throw bErr;
      }
    }
    return {
      ok: true,
      message: tr(
        `GitHub 仓库 ${creds.owner}/${creds.repo}（分支 ${creds.branch}）连接成功`,
        `Connected to GitHub repository ${creds.owner}/${creds.repo} (branch: ${creds.branch}).`,
      ),
    };
  } catch (err) {
    if (err instanceof HttpError) {
      const detail = extractHttpErrorDetail(err, isEnglish);
      return {
        ok: false,
        message: tr(
          `GitHub API 返回 ${detail}，请核对仓库名称或令牌权限`,
          `The GitHub API returned ${detail}. Check the repository name and token permissions.`,
        ),
      };
    }
    if (err instanceof NetworkError) {
      return {
        ok: false,
        message: tr(
          `无法连接 GitHub API（${err.reason}）`,
          `Could not connect to the GitHub API: ${errorDetail(err.reason)}`,
        ),
      };
    }
    return {
      ok: false,
      message: tr(
        `连接校验失败：${err && err.message ? err.message : err}`,
        `Connection test failed: ${errorDetail(err)}`,
      ),
    };
  }
}
