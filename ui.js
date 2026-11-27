import { basename, englishDiagnostic, formatDisplayPath } from './paths.js';
import { PROVIDER_LABELS, parseCredentials, providerLabel } from './providers.js';

export const MAX_PENDING_DISPLAY = 6;
export const MAX_RECENT_LOGS = 5;

export function formatBytes(numBytes) {
  let val = Math.max(0, Math.trunc(Number(numBytes) || 0));
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  if (idx === 0) {
    return `${Math.trunc(val)} B`;
  }
  if (idx === 1 && (val >= 100 || Math.abs(val - Math.round(val)) < 0.05)) {
    return `${Math.round(val)} KiB`;
  }
  return `${val.toFixed(1)} ${units[idx]}`;
}

export function uploadDedupeKey(nbRoot, localPath, notePath, namingRule) {
  if (namingRule === 'note_dir') {
    return JSON.stringify([nbRoot, localPath, notePath]);
  }
  return JSON.stringify([nbRoot, localPath]);
}

export function collectPendingImages(noteItems, multiNb, namingRule = '') {
  const seen = new Map();
  const ordered = [];
  for (const item of noteItems) {
    const { nbRoot, nbName, notePath, refs } = item;
    const displayNote = multiNb ? `${nbName} / ${notePath}` : notePath;
    for (const ref of refs) {
      const dedupeKey = uploadDedupeKey(nbRoot, ref.local_path, notePath, namingRule);
      const existing = seen.get(dedupeKey);
      if (existing) {
        if (!existing.notes.includes(displayNote)) {
          existing.notes.push(displayNote);
        }
        continue;
      }
      const entry = {
        rel_path: ref.rel_path,
        note_label: displayNote,
        notes: [displayNote],
        local_path: ref.local_path,
        size: ref.size,
      };
      seen.set(dedupeKey, entry);
      ordered.push(entry);
    }
  }
  ordered.sort((a, b) => {
    if (a.size !== b.size) {
      return b.size - a.size;
    }
    return a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : 0;
  });
  return ordered;
}

export function buildPendingEntries(pendingImages, tr) {
  if (!pendingImages.length) {
    return [];
  }
  const maxSize = Math.max(...pendingImages.map((item) => item.size));
  const entries = [];
  for (const item of pendingImages.slice(0, MAX_PENDING_DISPLAY)) {
    const noteSub =
      item.notes.length === 1
        ? item.note_label
        : tr(
            `${item.note_label} 等 ${item.notes.length} 篇`,
            `${item.note_label} (${item.notes.length} notes total)`,
          );
    let ratio = maxSize > 0 ? Math.round((item.size / maxSize) * 10000) / 10000 : 0.04;
    if (ratio <= 0) {
      ratio = 0.01;
    }
    entries.push({
      title: item.rel_path,
      sub_text: noteSub,
      time: formatBytes(item.size),
      ratio,
      tone: 'assets',
      tooltip: item.local_path,
    });
  }
  const restItems = pendingImages.slice(MAX_PENDING_DISPLAY);
  if (restItems.length > 0) {
    const restBytes = restItems.reduce((sum, item) => sum + item.size, 0);
    entries.push({
      title: tr(`其余 ${restItems.length} 张待上传图片`, `More images pending: ${restItems.length}`),
      time: formatBytes(restBytes),
    });
  }
  return entries;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function englishLogTooltip(tooltip, tone, errorDetail) {
  if (/^https?:\/\/\S+$/.test(tooltip)) {
    return tooltip;
  }
  const known = {
    '未找到本地文件': 'Local file not found.',
    '笔记内容已变化，请重试': 'The note has changed. Try again.',
    '宿主未确认写回成功': 'The host did not confirm the note update.',
  };
  if (Object.prototype.hasOwnProperty.call(known, tooltip)) {
    return known[tooltip];
  }
  for (const [provider, label] of Object.entries(PROVIDER_LABELS)) {
    const re = new RegExp(`^${escapeRegExp(label)} 连接成功（存储桶 (.+) 可访问）$`);
    const match = re.exec(tooltip);
    if (match) {
      return `Connected to ${providerLabel(provider, true)}. Bucket ${match[1]} is accessible.`;
    }
  }
  const github = /^GitHub 仓库 (.+)（分支 (.+)）连接成功$/.exec(tooltip);
  if (github) {
    return `Connected to GitHub repository ${github[1]} (branch: ${github[2]}).`;
  }

  const prefixes = [
    ['网络不可达：', 'Network unreachable'],
    ['写回笔记失败：', 'Could not update the note'],
    ['连接校验失败：', 'Connection test failed'],
    ['无法连接图床服务（', 'Could not connect to the image host'],
    ['无法连接 GitHub API（', 'Could not connect to the GitHub API'],
  ];
  for (const [prefix, english] of prefixes) {
    if (tooltip.startsWith(prefix)) {
      let detail = tooltip.slice(prefix.length);
      if (prefix.endsWith('（') && detail.endsWith('）')) {
        detail = detail.slice(0, -1);
      }
      detail = known[detail] || errorDetail(detail);
      return `${english}: ${detail}`;
    }
  }

  const httpStatus = /^(?:图床服务端返回 |GitHub API 返回 )?(HTTP [0-9]{3})/.exec(tooltip);
  return (
    englishDiagnostic(tooltip) ||
    (httpStatus ? httpStatus[1] : '') ||
    (tone === 'success' ? 'Operation completed successfully.' : 'No English error details available.')
  );
}

export function formatRecentLogs(logs, isEnglish, errorDetail) {
  const entries = [];
  for (const raw of logs.slice(0, MAX_RECENT_LOGS)) {
    let title = String(raw.title || '').trim();
    const timeStr = String(raw.time || '').trim();
    if (!title || !timeStr) {
      continue;
    }
    let status = String(raw.status || '').trim();
    let tone = String(raw.tone || '').trim();
    if (status === '已上传' || status === '通过' || status === '已连通') {
      status = '成功';
    } else if (
      status === '未连通' ||
      ['失败', '异常', '未找到', '不可达'].some((k) => status.includes(k))
    ) {
      status = '失败';
    }
    if (!tone) {
      if (status === '成功') tone = 'success';
      else if (status === '失败') tone = 'danger';
      else tone = 'info';
    }
    status = status || '成功';
    if (isEnglish) {
      if (title.startsWith('菜单栏 -> ')) {
        title = `Menu bar -> ${title.slice('菜单栏 -> '.length)}`;
      } else {
        for (const [provider, label] of Object.entries(PROVIDER_LABELS)) {
          if (title === `连接测试（${label}）`) {
            title = `Connection test (${providerLabel(provider, true)})`;
            break;
          }
        }
      }
      if (status === '失败' || tone === 'danger') {
        status = 'Failed';
      } else if (status === '成功' || tone === 'success') {
        status = 'Success';
      } else {
        status = englishDiagnostic(status) || 'Unknown status';
      }
    }
    const entry = {
      title,
      status,
      time: timeStr,
      tone,
    };
    if (raw.tooltip) {
      const tooltip = String(raw.tooltip);
      entry.tooltip = isEnglish ? englishLogTooltip(tooltip, tone, errorDetail) : tooltip;
    }
    entries.push(entry);
  }
  return entries;
}

export function isConfigReady(config, tr) {
  const { errMsg } = parseCredentials(config, tr);
  return !errMsg;
}

export function buildPage({
  config,
  logs,
  selected,
  noteItems,
  knownNotebooks,
  supportsAddFolder,
  homeDir,
  isEnglish,
  tr,
  errorDetail,
  statusOverride = null,
}) {
  const curProviderLabel = providerLabel(config.provider, isEnglish);
  const multiNb = selected.length > 1;
  const pendingImages = collectPendingImages(
    noteItems,
    multiNb,
    config.naming_rule || 'ym_hash',
  );
  const pendingCount = pendingImages.length;
  const pendingBytes = pendingImages.reduce((sum, item) => sum + item.size, 0);

  const configured = isConfigReady(config, tr);
  const channelBadge = configured
    ? tr(`${curProviderLabel} 已配置`, `${curProviderLabel} ready`)
    : tr('未配置', 'Not configured');

  let pageStatus;
  if (statusOverride !== null && statusOverride !== undefined) {
    pageStatus = statusOverride;
  } else if (!selected.length) {
    pageStatus = tr('未选择笔记本', 'No notebooks selected');
  } else {
    pageStatus = channelBadge;
  }

  const queueMeta = pendingCount > 0 ? formatBytes(pendingBytes) : '';
  const pendingEmpty = !selected.length
    ? supportsAddFolder
      ? tr('请先点击上方 + 添加要同步的笔记本', 'Click + above to add a notebook to sync.')
      : tr('请先在上方勾选要同步的笔记本', 'Select the notebooks to sync above.')
    : tr(
        '已选笔记本内所有图片均已外链化',
        'All images in the selected notebooks are already linked to remote URLs.',
      );

  const pendingEntries = buildPendingEntries(pendingImages, tr);
  const recentEntries = formatRecentLogs(logs, isEnglish, errorDetail);

  const rescanAction = {
    id: 'rescan',
    label: tr('重新扫描', 'Rescan'),
    busy_label: tr('扫描中...', 'Scanning...'),
    success_label: tr('已扫描', 'Scanned'),
    error_label: tr('扫描失败', 'Scan failed'),
    retry_label: tr('重试扫描', 'Retry scan'),
    variant: 'secondary',
  };
  const headerActions =
    configured && pendingCount > 0
      ? [
          {
            id: 'upload_now',
            label: tr(
              `上传 ${pendingCount} 张图片`,
              `Upload ${pendingCount} ${pendingCount === 1 ? 'image' : 'images'}`,
            ),
            busy_label: tr('上传中...', 'Uploading...'),
            success_label: tr('已上传', 'Uploaded'),
            error_label: tr('上传失败', 'Upload failed'),
            retry_label: tr('重试上传', 'Retry upload'),
            variant: 'primary',
          },
          rescanAction,
        ]
      : [rescanAction];

  const nbOptions = [];
  let listed;
  if (supportsAddFolder) {
    const knownByPath = new Map(knownNotebooks.map((e) => [e.path, e]));
    listed = selected.map((p) => knownByPath.get(p) || { path: p, name: basename(p) || p });
  } else {
    listed = knownNotebooks;
  }
  for (const entry of listed) {
    const p = entry.path;
    const opt = {
      value: p,
      label: entry.name,
      detail: formatDisplayPath(p, homeDir),
      tooltip: p,
    };
    if (entry.active) {
      opt.badge = tr('当前', 'Current');
    }
    nbOptions.push(opt);
  }
  const nbEmpty = supportsAddFolder
    ? tr('点击右上角 + 添加要同步的文件夹', 'Click + to add a folder to sync')
    : tr('暂无已打开的笔记本', 'No open notebooks');

  const checklistItem = {
    kind: 'checklist',
    id: 'selected_notebooks',
    value: selected,
    options: nbOptions,
    empty_text: nbEmpty,
  };
  if (supportsAddFolder) {
    checklistItem.add_folder = true;
  }

  const endpointPlaceholder =
    config.provider === 'r2'
      ? 'https://<account>.r2.cloudflarestorage.com'
      : tr(
          'https://s3.amazonaws.com 或兼容端点',
          'https://s3.amazonaws.com or a compatible endpoint',
        );
  const publicDomainPlaceholder =
    config.provider === 'r2'
      ? tr(
          'https://pub-xxx.r2.dev 或自定义域名（R2 必填）',
          'https://pub-xxx.r2.dev or a custom domain (required for R2)',
        )
      : tr('https://img.example.com（可留空）', 'https://img.example.com (optional)');

  return {
    title: tr('图床上传', 'Image Host'),
    status: pageStatus,
    header_actions: headerActions,
    cards: [
      {
        id: 'notebooks-card',
        title: tr('同步笔记本', 'Notebooks to sync'),
        items: [checklistItem],
      },
      {
        id: 'queue-card',
        title: tr('待上传队列', 'Upload queue'),
        meta: queueMeta,
        items: [
          {
            kind: 'log_list',
            id: 'pending_list',
            empty_text: pendingEmpty,
            entries: pendingEntries,
          },
          {
            kind: 'log_list',
            id: 'recent_logs',
            label: tr('最近上传', 'Recent uploads'),
            empty_text: tr('暂无上传记录', 'No upload history'),
            entries: recentEntries,
          },
        ],
      },
      {
        id: 'channel-card',
        title: tr('通道与上传规则', 'Image host and upload rules'),
        collapsible: true,
        default_collapsed: configured,
        items: [
          {
            kind: 'segmented',
            id: 'provider',
            label: tr('图床通道', 'Image host'),
            value: config.provider,
            options: [
              { value: 'r2', label: 'Cloudflare R2' },
              { value: 's3', label: providerLabel('s3', isEnglish) },
              { value: 'github', label: providerLabel('github', isEnglish) },
            ],
          },
          {
            kind: 'group',
            visible_when: { control_id: 'provider', in: ['r2', 's3'] },
            fields: [
              {
                kind: 'input',
                id: 's3_endpoint',
                label: tr('Endpoint 地址', 'Endpoint URL'),
                layout: 'stacked',
                value: config.s3_endpoint,
                placeholder: endpointPlaceholder,
              },
              {
                kind: 'input',
                id: 's3_bucket',
                label: tr('Bucket 存储桶', 'Bucket'),
                layout: 'stacked',
                value: config.s3_bucket,
                placeholder: tr('存储桶名（支持 bucket/prefix）', 'Bucket name (or bucket/prefix)'),
              },
            ],
          },
          {
            kind: 'group',
            visible_when: { control_id: 'provider', in: ['r2', 's3'] },
            fields: [
              {
                kind: 'input',
                id: 's3_access_key',
                label: 'Access Key ID',
                layout: 'stacked',
                value: config.s3_access_key,
                placeholder: tr('对象存储访问公钥 ID', 'Object storage access key ID'),
              },
              {
                kind: 'secret',
                id: 's3_secret_key',
                label: 'Secret Access Key',
                layout: 'stacked',
                value: config.s3_secret_key,
                placeholder: tr('对象存储访问密钥', 'Object storage secret access key'),
              },
            ],
          },
          {
            kind: 'group',
            visible_when: { control_id: 'provider', equals: 'github' },
            fields: [
              {
                kind: 'input',
                id: 'gh_repo',
                label: tr('仓库 (owner/repo)', 'Repository (owner/repo)'),
                layout: 'stacked',
                value: config.gh_repo,
                placeholder: tr('例如 username/image-assets', 'e.g. username/image-assets'),
              },
              {
                kind: 'input',
                id: 'gh_branch',
                label: tr('目标分支', 'Target branch'),
                layout: 'stacked',
                value: config.gh_branch,
                placeholder: 'main',
              },
            ],
          },
          {
            kind: 'group',
            visible_when: { control_id: 'provider', equals: 'github' },
            fields: [
              {
                kind: 'secret',
                id: 'gh_token',
                label: 'Personal Access Token',
                layout: 'stacked',
                value: config.gh_token,
                placeholder: tr(
                  '具备 repo 写入权限的 GitHub Token',
                  'GitHub token with repository write access',
                ),
              },
              {
                kind: 'segmented',
                id: 'gh_cdn',
                label: tr('外链加速', 'Image URL source'),
                layout: 'stacked',
                value: config.gh_cdn,
                options: [
                  { value: 'jsdelivr', label: tr('jsDelivr 加速', 'jsDelivr CDN') },
                  { value: 'raw', label: tr('GitHub 原生', 'GitHub Raw') },
                ],
              },
            ],
          },
          {
            kind: 'group',
            fields: [
              {
                kind: 'input',
                id: 'public_domain',
                label: tr('公开访问域名', 'Public domain'),
                layout: 'stacked',
                value: config.public_domain,
                placeholder: publicDomainPlaceholder,
                visible_when: { control_id: 'provider', in: ['r2', 's3'] },
              },
              {
                kind: 'input',
                id: 'remote_prefix',
                label: tr('远端目录前缀', 'Remote path prefix'),
                layout: 'stacked',
                value: config.remote_prefix,
                placeholder: tr('例如 notes（可留空）', 'e.g. notes (optional)'),
              },
            ],
          },
          {
            kind: 'segmented',
            id: 'naming_rule',
            label: tr('远端命名规则', 'Remote file naming'),
            value: config.naming_rule,
            options: [
              { value: 'ym_hash', label: tr('年月哈希', 'Year/month and hash') },
              { value: 'note_dir', label: tr('按笔记目录', 'By note directory') },
              { value: 'original', label: tr('原文件名', 'Original filename') },
            ],
          },
          {
            kind: 'segmented',
            id: 'menubar_copy_format',
            label: tr('菜单栏复制格式', 'Menu bar copy format'),
            value: config.menubar_copy_format,
            options: [
              { value: 'markdown', label: 'Markdown' },
              { value: 'url', label: 'URL' },
            ],
          },
          {
            kind: 'switch',
            id: 'auto_upload',
            label: tr(
              '保存笔记时自动上传本地图片（保留本地原图）',
              'Auto-upload local images when saving a note (keep local originals)',
            ),
            value: Boolean(config.auto_upload),
          },
          {
            kind: 'actions',
            buttons: [
              {
                id: 'test_conn',
                label: tr('测试连接', 'Test connection'),
                busy_label: tr('测试中...', 'Testing...'),
                success_label: tr('连接正常', 'Connected'),
                error_label: tr('连接失败', 'Connection failed'),
                retry_label: tr('重新测试', 'Test again'),
                variant: 'secondary',
              },
              {
                id: 'save_config',
                label: tr('保存配置', 'Save configuration'),
                busy_label: tr('保存中...', 'Saving...'),
                success_label: tr('已保存', 'Saved'),
                error_label: tr('保存失败', 'Save failed'),
                retry_label: tr('重试保存', 'Retry save'),
                variant: 'primary',
              },
            ],
          },
        ],
      },
    ],
  };
}
