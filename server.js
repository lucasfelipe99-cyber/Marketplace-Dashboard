const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');


function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadLocalEnv(path.join(__dirname, '.env'));

const port = process.env.PORT || 8787;
const projectDir = __dirname;
const legacyDataDir = path.join(projectDir, 'data');
const dataDir = resolveDataDirectory(projectDir);
const assetsDir = path.join(projectDir, 'assets');
const metadataPath = path.join(dataDir, 'metadata.json');
const legacyMetadataPath = path.join(legacyDataDir, 'metadata.json');
const aiAnalysisCachePath = path.join(dataDir, 'ai-urgencies-cache.json');
const compositionsPath = path.join(dataDir, 'compositions.json');
const intelligentAnalysisCachePath = path.join(dataDir, 'ai-intelligent-cache.json');
const intelligentAnalysisFallbackCachePath = path.join(os.tmpdir(), 'marketplace-ai-intelligent-cache.json');
const allowedBaseExtensions = new Set(['.xlsx', '.xls', '.csv']);
const allowedAssetExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico']);
const monthKeys = new Set(Array.from({ length: 12 }, (_, index) => String(index + 1)));
const aiAnalysisCooldownMs = 30 * 1000;
const aiAnalysisLastRunByIp = new Map();
const copilotLastRunByIp = new Map();
let intelligentAnalysisPromise = null;
let intelligentAnalysisMemoryCache = null;
const maxAiRequestBytes = 80 * 1024;
const maxCopilotRequestBytes = 8 * 1024 * 1024;
const maxUploadBytes = getPositiveIntegerEnv('MAX_UPLOAD_MB', 4096) * 1024 * 1024;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

fs.mkdirSync(dataDir, { recursive: true });

function resolveDataDirectory(baseDir) {
  if (process.env.DATA_DIR) {
    return path.resolve(process.env.DATA_DIR);
  }

  if (process.platform !== 'win32' && fs.existsSync('/var/data')) {
    return '/var/data';
  }

  if (process.platform === 'win32' && /\\Drives compartilhados\\/i.test(baseDir)) {
    return path.join(
      os.tmpdir(),
      'MarketplaceDashboard',
      'data'
    );
  }

  return path.join(baseDir, 'data');
}

function resolveDataFilePath(fileName) {
  if (!fileName || fileName !== path.basename(fileName)) {
    return '';
  }

  const runtimePath = path.join(dataDir, fileName);
  if (fs.existsSync(runtimePath)) {
    return runtimePath;
  }

  const legacyPath = path.join(legacyDataDir, fileName);
  return fs.existsSync(legacyPath) ? legacyPath : runtimePath;
}

function getPositiveIntegerEnv(name, fallback) {
  const parsed = Number(process.env[name]);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sendFile(response, filePath, contentType, cacheControl) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      const notFound = !error || error.code === 'ENOENT';
      response.writeHead(notFound ? 404 : 500, {
        'Content-Type': 'text/plain; charset=utf-8'
      });
      response.end(notFound ? 'Arquivo nao encontrado.' : 'Erro ao ler arquivo.');
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': cacheControl || 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(text);
}

function resolvePublicFile(urlPath) {
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(urlPath.split('?')[0]);
  } catch (error) {
    return null;
  }

  if (decodedPath === '/' || decodedPath === '/index.html') {
    return path.join(projectDir, 'index.html');
  }

  if (decodedPath.startsWith('/assets/')) {
    const relativePath = decodedPath.slice('/assets/'.length);
    const resolvedPath = path.resolve(assetsDir, relativePath);
    const relativeResolvedPath = path.relative(assetsDir, resolvedPath);
    const extension = path.extname(resolvedPath).toLowerCase();

    if (relativeResolvedPath.startsWith('..') || path.isAbsolute(relativeResolvedPath) || !allowedAssetExtensions.has(extension)) {
      return null;
    }

    return resolvedPath;
  }

  if (decodedPath.startsWith('/data/')) {
    const requestedName = decodedPath.slice('/data/'.length);

    if (!requestedName || requestedName !== path.basename(requestedName) || !getPublishedDataFileNames().has(requestedName)) {
      return null;
    }

    return resolveDataFilePath(requestedName);
  }

  return null;
}

function getPublishedDataFileNames() {
  const names = new Set();
  const metadata = readMetadata();

  Object.values(metadata.areas || {}).forEach((area) => {
    Object.values(area && area.months || {}).forEach((month) => {
      if (month && month.storedName) {
        names.add(month.storedName);
      }
      if (month && month.rowsName) {
        names.add(month.rowsName);
      }
    });
  });

  return names;
}

function safePasswordEquals(providedPassword, configuredPassword) {
  const provided = Buffer.from(String(providedPassword || ''), 'utf8');
  const configured = Buffer.from(String(configuredPassword || ''), 'utf8');

  return provided.length === configured.length && crypto.timingSafeEqual(provided, configured);
}

function normalizeMonth(value) {
  const month = String(value || '').trim();

  return monthKeys.has(month) ? month : '';
}

function getMonthFromUrl(url) {
  try {
    const parsedUrl = new URL(url, 'http://localhost');

    return normalizeMonth(parsedUrl.searchParams.get('month'));
  } catch (error) {
    return '';
  }
}

function readMetadata() {
  const sourcePath = fs.existsSync(metadataPath)
    ? metadataPath
    : legacyMetadataPath;

  if (!fs.existsSync(sourcePath)) {
    return { areas: { area1: { months: {} } } };
  }

  try {
    const metadata = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

    if (metadata.areas) {
      metadata.areas.area1 = metadata.areas.area1 || { months: {} };
      return metadata;
    }

    if (metadata.months) {
      return { areas: { area1: metadata } };
    }

    if (metadata.storedName) {
      const legacyMonth = metadata.updatedAt
        ? String(new Date(metadata.updatedAt).getMonth() + 1)
        : String(new Date().getMonth() + 1);

      return { areas: { area1: { months: { [legacyMonth]: metadata } } } };
    }

    return { areas: { area1: { months: {} } } };
  } catch (error) {
    return { areas: { area1: { months: {} } } };
  }
}

function getPublishedMetadata(month) {
  const metadata = readMetadata();
  const areaMetadata = metadata.areas.area1 || { months: {} };
  const monthMetadata = areaMetadata.months[month] || {};
  const filePath = resolveDataFilePath(monthMetadata.storedName || '');

  if (!monthMetadata.storedName || !fs.existsSync(filePath)) {
    return { exists: false, month };
  }

  return {
    exists: true,
    month,
    fileName: monthMetadata.fileName,
    storedName: monthMetadata.storedName,
    rowsName: monthMetadata.rowsName,
    updatedAt: monthMetadata.updatedAt,
    rowsUpdatedAt: monthMetadata.rowsUpdatedAt,
    size: monthMetadata.size,
    url: '/data/' + encodeURIComponent(monthMetadata.storedName),
    rowsUrl: monthMetadata.rowsName && fs.existsSync(resolveDataFilePath(monthMetadata.rowsName))
      ? '/data/' + encodeURIComponent(monthMetadata.rowsName)
      : ''
  };
}

function getAllPublishedMetadata() {
  const months = {};

  monthKeys.forEach((month) => {
    const monthMetadata = getPublishedMetadata(month);

    if (monthMetadata.exists) {
      months[month] = monthMetadata;
    }
  });

  return {
    exists: Object.keys(months).length > 0,
    months
  };
}

function deletePreviousBases(area, month, keepNames) {
  const keep = new Set((keepNames || []).filter(Boolean));

  fs.readdirSync(dataDir).forEach((name) => {
    const pattern = new RegExp('^' + area + '-current-(base|rows)-' + month + '(?:-[0-9]+)?\\.(xlsx|xls|csv|json)$', 'i');

    if (!pattern.test(name) || keep.has(name)) {
      return;
    }

    try {
      fs.unlinkSync(path.join(dataDir, name));
    } catch (error) {
      console.warn('Nao foi possivel apagar base antiga, seguindo com novo arquivo:', name, error.message);
    }
  });
}

function createStoredName(area, type, month, extension) {
  const timestamp = Date.now();
  const suffix = Math.random().toString(36).slice(2, 8);

  return area + '-current-' + type + '-' + month + '-' + timestamp + '-' + suffix + extension;
}

function writeFileWithRetry(filePath, content, attempts = 6) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.writeFileSync(filePath, content, { flag: 'wx' });
      return;
    } catch (error) {
      lastError = error;

      if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(error.code) || attempt === attempts) {
        break;
      }

      const waitUntil = Date.now() + attempt * 120;
      while (Date.now() < waitUntil) {}
    }
  }

  throw lastError;
}

function createUploadStagingPath(extension) {
  return path.join(
    os.tmpdir(),
    'marketplace-upload-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + extension
  );
}

function waitSynchronously(milliseconds) {
  const waitBuffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(waitBuffer), 0, 0, milliseconds);
}

function persistStagedFile(stagingPath, destinationPath, attempts = 10) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.copyFileSync(stagingPath, destinationPath, fs.constants.COPYFILE_EXCL);
      return;
    } catch (error) {
      lastError = error;
      if (error.code === 'EEXIST') {
        throw error;
      }
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOENT'].includes(error.code) || attempt === attempts) {
        break;
      }
      waitSynchronously(Math.min(250 * attempt, 1500));
    }
  }

  throw lastError;
}

function writeJsonWithRetry(filePath, value, attempts = 10) {
  const content = JSON.stringify(value, null, 2);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.writeFileSync(filePath, content);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === attempts) {
        break;
      }
      waitSynchronously(Math.min(200 * attempt, 1200));
    }
  }

  throw lastError;
}

function streamRequestToFile(request, filePath, maxBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers['content-length']) || 0;
    let totalBytes = 0;
    let settled = false;
    const output = fs.createWriteStream(filePath, { flags: 'wx' });

    const cleanupPartialFile = () => {
      fs.rm(filePath, { force: true }, () => {});
    };
    const fail = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      request.unpipe(output);
      output.destroy();
      request.resume();
      cleanupPartialFile();
      reject(error);
    };

    if (declaredLength > maxBytes) {
      output.destroy();
      cleanupPartialFile();
      reject(new Error('UPLOAD_TOO_LARGE'));
      request.resume();
      return;
    }

    request.on('data', (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > maxBytes) {
        fail(new Error('UPLOAD_TOO_LARGE'));
      }
    });
    request.on('aborted', () => fail(new Error('UPLOAD_ABORTED')));
    request.on('error', fail);
    output.on('error', fail);
    output.on('finish', () => {
      if (settled) {
        return;
      }

      settled = true;
      if (totalBytes === 0) {
        cleanupPartialFile();
        reject(new Error('EMPTY_UPLOAD'));
        return;
      }
      resolve(totalBytes);
    });

    request.pipe(output);
  });
}

function writeMonthMetadata(month, nextMetadata) {
  const metadata = readMetadata();

  metadata.areas.area1 = metadata.areas.area1 || { months: {} };
  metadata.areas.area1.months[month] = nextMetadata;
  writeJsonWithRetry(metadataPath, metadata);
}

function getLegacyPublishedMetadata() {
  const sourcePath = fs.existsSync(metadataPath) ? metadataPath : legacyMetadataPath;
  if (!fs.existsSync(sourcePath)) {
    return { exists: false };
  }

  try {
    const metadata = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const filePath = resolveDataFilePath(metadata.storedName || '');

    if (!metadata.storedName || !fs.existsSync(filePath)) {
      return { exists: false };
    }

    return {
      exists: true,
      fileName: metadata.fileName,
      storedName: metadata.storedName,
      updatedAt: metadata.updatedAt,
      size: metadata.size,
      url: '/data/' + encodeURIComponent(metadata.storedName)
    };
  } catch (error) {
    return { exists: false };
  }
}

async function handleBaseUpload(request, response) {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const providedPassword = request.headers['x-admin-password'] || '';
  const month = normalizeMonth(request.headers['x-base-month']);
  const area = 'area1';

  if (!configuredPassword) {
    sendText(response, 500, 'ADMIN_PASSWORD nao configurada no servidor.');
    return;
  }

  if (!safePasswordEquals(providedPassword, configuredPassword)) {
    sendText(response, 401, 'Senha invalida.');
    return;
  }

  if (!month) {
    sendText(response, 400, 'Mes invalido para publicacao.');
    return;
  }

  const originalName = decodeURIComponent(request.headers['x-file-name'] || '');
  const extension = path.extname(originalName).toLowerCase();

  if (!allowedBaseExtensions.has(extension)) {
    sendText(response, 400, 'Formato nao aceito. Envie .xlsx, .xls ou .csv.');
    return;
  }

  const storedName = createStoredName(area, 'base', month, extension);
  const storedPath = path.join(dataDir, storedName);
  const stagingPath = createUploadStagingPath(extension);

  try {
    const size = await streamRequestToFile(request, stagingPath, maxUploadBytes);
    persistStagedFile(stagingPath, storedPath);
    const metadata = {
      fileName: path.basename(originalName),
      storedName,
      updatedAt: new Date().toISOString(),
      size
    };

    writeMonthMetadata(month, metadata);
    deletePreviousBases(area, month, [storedName]);
    sendJson(response, 200, getPublishedMetadata(month));
  } catch (writeError) {
    console.error('Erro ao publicar base:', writeError);
    if (writeError.message === 'UPLOAD_TOO_LARGE') {
      sendText(response, 413, 'Arquivo acima do limite configurado de ' + Math.round(maxUploadBytes / 1024 / 1024) + ' MB.');
      return;
    }
    sendText(response, 500, 'Erro ao salvar a base no servidor: ' + writeError.message);
  } finally {
    fs.rm(stagingPath, { force: true }, () => {});
  }
}

async function handleRowsUpload(request, response) {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const providedPassword = request.headers['x-admin-password'] || '';
  const month = normalizeMonth(request.headers['x-base-month']);
  const area = 'area1';

  if (!configuredPassword) {
    sendText(response, 500, 'ADMIN_PASSWORD nao configurada no servidor.');
    return;
  }

  if (!safePasswordEquals(providedPassword, configuredPassword)) {
    sendText(response, 401, 'Senha invalida.');
    return;
  }

  if (!month) {
    sendText(response, 400, 'Mes invalido para publicacao.');
    return;
  }

  const metadata = readMetadata();
  const areaMetadata = metadata.areas.area1 || { months: {} };
  const monthMetadata = areaMetadata.months[month];

  if (!monthMetadata || !monthMetadata.storedName) {
    sendText(response, 400, 'Publique a base do mes antes de salvar os dados processados.');
    request.resume();
    return;
  }

  const rowsName = createStoredName(area, 'rows', month, '.json');
  const rowsPath = path.join(dataDir, rowsName);
  const stagingPath = createUploadStagingPath('.json');

  try {
    await streamRequestToFile(request, stagingPath, maxUploadBytes);
    persistStagedFile(stagingPath, rowsPath);
    monthMetadata.rowsName = rowsName;
    monthMetadata.rowsUpdatedAt = new Date().toISOString();
    metadata.areas.area1 = metadata.areas.area1 || { months: {} };
    metadata.areas.area1.months[month] = monthMetadata;
    writeJsonWithRetry(metadataPath, metadata);
    deletePreviousBases(area, month, [monthMetadata.storedName, rowsName]);
    sendJson(response, 200, getPublishedMetadata(month));
    setImmediate(() => {
      ensureIntelligentAnalysis(true).catch((error) => {
        console.error('Nao foi possivel atualizar a Analise Inteligente apos a publicacao:', error.message);
      });
    });
  } catch (writeError) {
    console.error('Erro ao salvar dados processados:', writeError);
    if (writeError.message === 'UPLOAD_TOO_LARGE') {
      sendText(response, 413, 'Dados processados acima do limite configurado de ' + Math.round(maxUploadBytes / 1024 / 1024) + ' MB.');
      return;
    }
    sendText(response, 500, 'Erro ao congelar os dados do mes: ' + writeError.message);
  } finally {
    fs.rm(stagingPath, { force: true }, () => {});
  }
}


function collectJsonRequest(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    request.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error('INVALID_JSON'));
      }
    });

    request.on('error', reject);
  });
}

function extractResponseText(payload) {
  if (payload && typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const texts = [];
  const visit = (value, parentKey) => {
    if (typeof value === 'string') {
      if ((parentKey === 'text' || parentKey === 'output_text') && value.trim()) {
        texts.push(value.trim());
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, parentKey));
      return;
    }

    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, child]) => visit(child, key));
    }
  };

  visit(payload && payload.output, 'output');
  return Array.from(new Set(texts)).join('\n\n').trim();
}

function normalizeAnalysisText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAnalysisNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  let text = String(value || '').trim();
  if (!text) {
    return 0;
  }

  const negative = /^-/.test(text) || /^\(.*\)$/.test(text);
  text = text.replace(/[^0-9,.\-]/g, '');

  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (text.includes(',')) {
    text = text.replace(/\./g, '').replace(',', '.');
  }

  const parsed = Number(text.replace(/[()]/g, ''));
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return negative ? -Math.abs(parsed) : parsed;
}

function findAnalysisHeader(headers, names) {
  const normalizedNames = names.map(normalizeAnalysisText);
  return headers.findIndex((header) => normalizedNames.includes(normalizeAnalysisText(header)));
}

function isActualAnalysisValue(value) {
  return ['actual', 'atual', 'real', 'realizado'].includes(normalizeAnalysisText(value));
}

function isForecastAnalysisValue(value) {
  return ['forecast', 'previsao', 'previsto', 'orcado', 'budget'].includes(normalizeAnalysisText(value));
}

function parseAnalysisDateParts(value, expectedMonth, expectedYear) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { day: value.getDate(), month: value.getMonth() + 1, year: value.getFullYear() };
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 20000) {
    const excelDate = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return {
      day: excelDate.getUTCDate(),
      month: excelDate.getUTCMonth() + 1,
      year: excelDate.getUTCFullYear()
    };
  }

  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,4})[\/.-](\d{1,2})[\/.-](\d{1,4})/);
  if (!match) {
    return null;
  }

  let first = Number(match[1]);
  let second = Number(match[2]);
  let third = Number(match[3]);
  if (first > 999) {
    return { day: third, month: second, year: first };
  }
  const year = third < 100 ? 2000 + third : third;
  let day = first;
  let month = second;

  if (first === expectedMonth && second <= 31) {
    month = first;
    day = second;
  } else if (second === expectedMonth && first <= 31) {
    month = second;
    day = first;
  } else if (first <= 12 && second > 12) {
    month = first;
    day = second;
  }

  return { day, month, year: year || expectedYear };
}

function getSaoPauloDateParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    day: Number(values.day),
    month: Number(values.month),
    year: Number(values.year)
  };
}

function readPublishedRows(monthMetadata) {
  if (!monthMetadata || !monthMetadata.rowsName) {
    return [];
  }

  const rowsPath = resolveDataFilePath(monthMetadata.rowsName);
  if (!fs.existsSync(rowsPath)) {
    return [];
  }

  try {
    const payload = JSON.parse(fs.readFileSync(rowsPath, 'utf8'));
    return Array.isArray(payload.rows) ? payload.rows : [];
  } catch (error) {
    console.warn('Nao foi possivel ler dados processados para analise inteligente:', error.message);
    return [];
  }
}

function createEmptyMetricBucket(name) {
  return {
    name: String(name || '(vazio)'),
    revenue: 0,
    netRevenue: 0,
    quantity: 0,
    gm: 0,
    advertising: 0,
    affiliates: 0,
    adsRevenue: 0,
    orders: new Set(),
    ads: new Set(),
    channelRevenue: new Map()
  };
}

function addMetricBucket(target, source) {
  target.revenue += source.revenue || 0;
  target.netRevenue += source.netRevenue || 0;
  target.quantity += source.quantity || 0;
  target.gm += source.gm || 0;
  target.advertising += source.advertising || 0;
  target.affiliates += source.affiliates || 0;
  target.adsRevenue += source.adsRevenue || 0;
  source.orders.forEach((value) => target.orders.add(value));
  source.ads.forEach((value) => target.ads.add(value));
  source.channelRevenue.forEach((value, channel) => {
    target.channelRevenue.set(channel, (target.channelRevenue.get(channel) || 0) + value);
  });
}

function finalizeMetricBucket(bucket) {
  const attributedRevenue = Math.abs(bucket.adsRevenue || 0);

  return {
    name: bucket.name,
    revenue: bucket.revenue,
    netRevenue: bucket.netRevenue,
    quantity: bucket.quantity,
    orders: bucket.orders.size || null,
    averageTicket: bucket.quantity === 0 ? 0 : bucket.revenue / bucket.quantity,
    gm: bucket.gm,
    gmPercent: bucket.netRevenue === 0 ? 0 : bucket.gm / bucket.netRevenue,
    advertising: Math.abs(bucket.advertising),
    affiliates: Math.abs(bucket.affiliates),
    adsRevenue: attributedRevenue,
    tacos: bucket.revenue === 0 ? 0 : Math.abs(bucket.advertising) / bucket.revenue,
    acos: attributedRevenue === 0 ? null : Math.abs(bucket.advertising) / attributedRevenue,
    roas: bucket.advertising === 0 ? null : attributedRevenue / Math.abs(bucket.advertising),
    adsRevenueShare: bucket.revenue === 0 ? 0 : attributedRevenue / bucket.revenue,
    ads: bucket.ads.size,
    channels: Array.from(bucket.channelRevenue.entries())
      .map(([name, revenue]) => ({
        name,
        revenue,
        share: bucket.revenue === 0 ? 0 : revenue / bucket.revenue
      }))
      .filter((item) => item.revenue !== 0)
      .sort((a, b) => b.revenue - a.revenue)
  };
}

function aggregatePublishedScenario(rows, month, year, scenarioKind, options) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return null;
  }

  const headers = rows[0].map((header) => String(header || ''));
  const indexes = {
    category: findAnalysisHeader(headers, ['Categoria']),
    category2: findAnalysisHeader(headers, ['Categoria2', 'Categoria 2']),
    subcategory: findAnalysisHeader(headers, ['Sub Categoria', 'Subcategoria', 'Sub-Categoria']),
    marketplace: findAnalysisHeader(headers, ['Marketplace']),
    marketplaceSale: findAnalysisHeader(headers, ['Marketplace venda']),
    sku: findAnalysisHeader(headers, ['SKU']),
    ad: findAnalysisHeader(headers, ['Id anuncio', 'Id anúncio', 'ID do anuncio', 'Anúncio']),
    order: findAnalysisHeader(headers, ['ID do pedido', 'Id pedido', 'Pedido']),
    date: findAnalysisHeader(headers, ['Data', 'Full Data', 'Record Date']),
    scenario: findAnalysisHeader(headers, ['Datatype', 'Data Type', 'Tipo de dado', 'Tipo dados']),
    amount: findAnalysisHeader(headers, ['Valor completo', 'Actual', 'Valor', 'Faturamento', 'Total'])
  };
  const groups = {
    marketplaces: new Map(),
    categories: new Map(),
    skus: new Map(),
    ads: new Map()
  };
  const total = createEmptyMetricBucket('Total');
  const rawGroups = new Map();
  const availableDays = new Set();
  let latestDay = 0;
  const cutoffDay = Number(options && options.cutoffDay) || 0;

  rows.slice(1).forEach((row) => {
    const scenario = indexes.scenario >= 0 ? row[indexes.scenario] : 'actual';
    const matchesScenario = scenarioKind === 'forecast'
      ? isForecastAnalysisValue(scenario)
      : isActualAnalysisValue(scenario);
    if (!matchesScenario) {
      return;
    }
    const dateParts = indexes.date >= 0
      ? parseAnalysisDateParts(row[indexes.date], Number(month), year)
      : null;
    if (dateParts && dateParts.month === Number(month)) {
      if (cutoffDay && dateParts.day > cutoffDay) {
        return;
      }
    }

    const category = indexes.category >= 0 ? String(row[indexes.category] || '') : '';
    const category2 = indexes.category2 >= 0 ? String(row[indexes.category2] || '(vazio)') : '(vazio)';
    const subcategory = indexes.subcategory >= 0 ? String(row[indexes.subcategory] || '') : '';
    const marketplace = indexes.marketplace >= 0 ? String(row[indexes.marketplace] || '(vazio)') : '(vazio)';
    const marketplaceSale = indexes.marketplaceSale >= 0 ? String(row[indexes.marketplaceSale] || '(vazio)') : '(vazio)';
    const sku = indexes.sku >= 0 ? String(row[indexes.sku] || '(vazio)') : '(vazio)';
    const ad = indexes.ad >= 0 ? String(row[indexes.ad] || '(vazio)') : '(vazio)';
    const order = indexes.order >= 0 ? String(row[indexes.order] || '').trim() : '';
    const amount = indexes.amount >= 0 ? parseAnalysisNumber(row[indexes.amount]) : 0;
    if (dateParts && dateParts.month === Number(month) && amount !== 0) {
      latestDay = Math.max(latestDay, dateParts.day);
      availableDays.add(dateParts.day);
    }
    const key = [marketplace, marketplaceSale, category2, sku, ad].join('||');
    const bucket = rawGroups.get(key) || {
      marketplace,
      marketplaceSale,
      category2,
      sku,
      ad,
      orders: new Set(),
      revenue: 0,
      tax: 0,
      marketplaceExpenses: 0,
      costs: 0,
      quantity: 0,
      advertising: 0,
      affiliates: 0,
      adsRevenue: 0
    };
    const normalizedCategory = normalizeAnalysisText(category);
    const categoryNumberMatch = String(category || '').trim().match(/^(\d{1,2})\s*\./);
    const categoryNumber = categoryNumberMatch ? Number(categoryNumberMatch[1]) : 0;

    if (normalizedCategory === '13.faturamento bruto') {
      bucket.revenue += amount;
    } else if (normalizedCategory === '02.imposto') {
      bucket.tax += amount;
    } else if (normalizedCategory === '03.despesas marketplace') {
      bucket.marketplaceExpenses += amount;
    } else if (normalizedCategory === '14.quantidade') {
      bucket.quantity += amount;
    } else if (normalizedCategory === 'ads f') {
      bucket.adsRevenue += amount;
    } else if (categoryNumber >= 4 && categoryNumber <= 13) {
      bucket.costs += amount;
    }

    if (normalizeAnalysisText(subcategory) === 'publicidade') {
      bucket.advertising += amount;
    }
    if (normalizeAnalysisText(subcategory) === 'afiliados') {
      bucket.affiliates += amount;
    }
    if (order) {
      bucket.orders.add(order);
    }
    rawGroups.set(key, bucket);
  });

  rawGroups.forEach((raw) => {
    const metrics = createEmptyMetricBucket(raw.sku);
    metrics.revenue = raw.revenue;
    metrics.netRevenue = raw.revenue + raw.tax;
    metrics.quantity = raw.quantity;
    metrics.gm = metrics.netRevenue + raw.marketplaceExpenses + raw.costs;
    metrics.advertising = raw.advertising;
    metrics.affiliates = raw.affiliates;
    metrics.adsRevenue = raw.adsRevenue;
    metrics.channelRevenue.set(raw.marketplace, raw.revenue);
    raw.orders.forEach((value) => metrics.orders.add(value));
    if (normalizeAnalysisText(raw.ad) !== 'xx' && normalizeAnalysisText(raw.ad) !== '(vazio)') {
      metrics.ads.add(raw.ad);
    }
    addMetricBucket(total, metrics);

    [
      ['marketplaces', raw.marketplace],
      ['categories', raw.category2],
      ['skus', raw.sku],
      ['ads', raw.ad]
    ].forEach(([groupName, groupKey]) => {
      const map = groups[groupName];
      const current = map.get(groupKey) || createEmptyMetricBucket(groupKey);
      addMetricBucket(current, metrics);
      map.set(groupKey, current);
    });
  });

  const finalizeMap = (map, limit) => {
    const items = Array.from(map.values())
      .map(finalizeMetricBucket)
      .filter((item) => normalizeAnalysisText(item.name) !== 'x' && normalizeAnalysisText(item.name) !== 'xx')
      .sort((a, b) => b.revenue - a.revenue);
    return Number.isFinite(limit) ? items.slice(0, limit) : items;
  };
  const totalMetrics = finalizeMetricBucket(total);
  const analysisPools = {
    marketplaces: finalizeMap(groups.marketplaces),
    categories: finalizeMap(groups.categories),
    skus: finalizeMap(groups.skus),
    ads: finalizeMap(groups.ads)
  };
  const result = {
    month: Number(month),
    year,
    label: String(month).padStart(2, '0') + '/' + year,
    coverage: {
      latestDay,
      daysWithData: availableDays.size,
      calendarDays: new Date(year, Number(month), 0).getDate(),
      asOfDate: latestDay
        ? String(latestDay).padStart(2, '0') + '/' + String(month).padStart(2, '0') + '/' + year
        : ''
    },
    totals: totalMetrics,
    marketplaces: analysisPools.marketplaces.slice(0, 20),
    categories: analysisPools.categories.slice(0, 20),
    skus: analysisPools.skus.slice(0, 30),
    ads: analysisPools.ads.slice(0, 30)
  };
  Object.defineProperty(result, '_analysisPools', { value: analysisPools, enumerable: false });
  return result;
}

function aggregatePublishedMonth(rows, month, year) {
  const actual = aggregatePublishedScenario(rows, month, year, 'actual');
  const forecast = aggregatePublishedScenario(rows, month, year, 'forecast');
  const base = actual || forecast;

  if (!base) {
    return null;
  }

  const result = Object.assign({}, base, {
    totals: actual ? actual.totals : finalizeMetricBucket(createEmptyMetricBucket('Total')),
    marketplaces: actual ? actual.marketplaces : [],
    categories: actual ? actual.categories : [],
    skus: actual ? actual.skus : [],
    ads: actual ? actual.ads : [],
    forecastTotals: forecast ? forecast.totals : null,
    forecastMarketplaces: forecast ? forecast.marketplaces : [],
    forecastCategories: forecast ? forecast.categories : []
  });
  const poolSource = actual || forecast;
  if (poolSource && poolSource._analysisPools) {
    Object.defineProperty(result, '_analysisPools', { value: poolSource._analysisPools, enumerable: false });
  }
  return result;
}

function calculateAverageMetrics(months) {
  if (!months.length) {
    return null;
  }

  const numericKeys = [
    'revenue', 'netRevenue', 'quantity', 'averageTicket', 'gm', 'gmPercent',
    'advertising', 'affiliates', 'adsRevenue', 'tacos', 'acos', 'adsRevenueShare'
  ];
  const result = {};

  numericKeys.forEach((key) => {
    result[key] = months.reduce((total, month) => total + (Number(month.totals[key]) || 0), 0) / months.length;
  });
  return result;
}

function calculateMetricVariation(current, comparison) {
  if (!comparison) {
    return null;
  }
  if (comparison === 0) {
    return current === 0 ? 0 : null;
  }
  return (current - comparison) / Math.abs(comparison);
}

function scaleMetricTotals(totals, factor) {
  if (!totals) {
    return null;
  }
  const scaled = Object.assign({}, totals);
  ['revenue', 'netRevenue', 'quantity', 'gm', 'advertising', 'affiliates', 'adsRevenue'].forEach((key) => {
    scaled[key] = (Number(totals[key]) || 0) * factor;
  });
  scaled.orders = totals.orders ? totals.orders * factor : totals.orders;
  return scaled;
}

function scaleMetricItems(items, factor) {
  return (items || []).map((item) => Object.assign({}, item, {
    revenue: (Number(item.revenue) || 0) * factor,
    netRevenue: (Number(item.netRevenue) || 0) * factor,
    quantity: (Number(item.quantity) || 0) * factor,
    orders: item.orders ? item.orders * factor : item.orders,
    gm: (Number(item.gm) || 0) * factor,
    advertising: (Number(item.advertising) || 0) * factor,
    affiliates: (Number(item.affiliates) || 0) * factor,
    adsRevenue: (Number(item.adsRevenue) || 0) * factor
  }));
}

function hasReliableDailyHistory(month, year) {
  return year > 2026 || (year === 2026 && Number(month) >= 6);
}

function buildComparableMonth(source, reportDay) {
  const daysInMonth = new Date(source.year, Number(source.month), 0).getDate();

  if (hasReliableDailyHistory(source.month, source.year)) {
    const dailyAggregate = aggregatePublishedScenario(source.rows, source.month, source.year, 'actual', {
      cutoffDay: Math.min(reportDay, daysInMonth)
    });
    if (dailyAggregate) {
      return Object.assign({}, dailyAggregate, {
        comparisonMethod: 'daily_actual',
        comparisonDescription: 'Dados reais do mesmo número de dias'
      });
    }
  }

  const fullMonth = source.aggregate;
  const factor = Math.min(reportDay, daysInMonth) / daysInMonth;
  return Object.assign({}, fullMonth, {
    totals: scaleMetricTotals(fullMonth.totals, factor),
    marketplaces: scaleMetricItems(fullMonth.marketplaces, factor),
    categories: scaleMetricItems(fullMonth.categories, factor),
    skus: scaleMetricItems(fullMonth.skus, factor),
    ads: scaleMetricItems(fullMonth.ads, factor),
    comparisonMethod: 'estimated_daily_average',
    comparisonDescription: 'Estimativa pela média diária do mês completo',
    estimation: {
      fullMonthDays: daysInMonth,
      comparableDays: Math.min(reportDay, daysInMonth),
      factor
    }
  });
}

function addTrendVariation(currentItems, previousItems) {
  const previousMap = new Map((previousItems || []).map((item) => [normalizeAnalysisText(item.name), item]));

  return (currentItems || []).map((item) => {
    const previous = previousMap.get(normalizeAnalysisText(item.name));
    return Object.assign({}, item, {
      previousRevenue: previous ? previous.revenue : 0,
      revenueVariation: previous ? calculateMetricVariation(item.revenue, previous.revenue) : null,
      previousGm: previous ? previous.gm : 0,
      gmVariation: previous ? calculateMetricVariation(item.gm, previous.gm) : null
    });
  });
}

function buildIntelligentAbcSummary(items) {
  const ranked = (items || [])
    .filter((item) => item.revenue > 0)
    .slice()
    .sort((a, b) => b.revenue - a.revenue);
  const totalRevenue = ranked.reduce((total, item) => total + item.revenue, 0);
  const summary = {
    totalItems: ranked.length,
    curveA: { items: 0, revenue: 0, share: 0 },
    curveB: { items: 0, revenue: 0, share: 0 },
    curveC: { items: 0, revenue: 0, share: 0 }
  };
  let accumulatedShare = 0;

  ranked.forEach((item) => {
    const share = totalRevenue === 0 ? 0 : item.revenue / totalRevenue;
    const curve = accumulatedShare < 0.8 ? 'curveA' : accumulatedShare < 0.95 ? 'curveB' : 'curveC';
    summary[curve].items += 1;
    summary[curve].revenue += item.revenue;
    accumulatedShare += share;
  });
  ['curveA', 'curveB', 'curveC'].forEach((curve) => {
    summary[curve].share = totalRevenue === 0 ? 0 : summary[curve].revenue / totalRevenue;
  });
  return summary;
}

function buildIntelligentRiskSummary(current) {
  const skus = current.skus || [];
  const ads = current.ads || [];
  const marketplaces = current.marketplaces || [];
  const categories = current.categories || [];
  const negativeMarginSkus = skus.filter((item) => item.gm < 0);
  const highTacosAds = ads.filter((item) => item.advertising > 0 && item.tacos > 0.05);
  const zeroRevenueAds = ads.filter((item) => item.advertising > 0 && item.revenue <= 0);
  const totalRevenue = current.totals.revenue || 0;
  const topMarketplace = marketplaces[0] || null;

  return {
    negativeMarginSkuCount: negativeMarginSkus.length,
    negativeMarginGm: negativeMarginSkus.reduce((total, item) => total + item.gm, 0),
    worstMarginSkus: negativeMarginSkus.slice().sort((a, b) => a.gm - b.gm).slice(0, 10),
    highTacosAdCount: highTacosAds.length,
    highTacosAdvertising: highTacosAds.reduce((total, item) => total + item.advertising, 0),
    worstTacosAds: highTacosAds.slice().sort((a, b) => b.tacos - a.tacos).slice(0, 10),
    zeroRevenueAdCount: zeroRevenueAds.length,
    topMarketplace: topMarketplace ? {
      name: topMarketplace.name,
      revenue: topMarketplace.revenue,
      share: totalRevenue === 0 ? 0 : topMarketplace.revenue / totalRevenue,
      gm: topMarketplace.gm,
      gmPercent: topMarketplace.gmPercent
    } : null,
    lowestMarginCategories: categories.slice().sort((a, b) => a.gm - b.gm).slice(0, 8)
  };
}

function buildIntelligentCoverageAudit(current) {
  const pools = current && current._analysisPools || {};
  return {
    marketplacesAnalyzed: (pools.marketplaces || current.marketplaces || []).length,
    categoriesAnalyzed: (pools.categories || current.categories || []).length,
    skusAnalyzed: (pools.skus || current.skus || []).length,
    adsAnalyzed: (pools.ads || current.ads || []).length,
    scope: 'Todos os registros agregados da base atual; listas enviadas à IA são rankings derivados desse universo.'
  };
}

function buildIntelligentDecisionViews(current) {
  const pools = current && current._analysisPools || {};
  const skus = (pools.skus || current.skus || []).slice();
  const ads = (pools.ads || current.ads || []).slice();
  const categories = (pools.categories || current.categories || []).slice();
  const byRevenue = (items) => items.slice().sort((a, b) => b.revenue - a.revenue).slice(0, 20);
  const byLowestGm = (items) => items.slice().sort((a, b) => a.gm - b.gm).slice(0, 20);
  const byAdvertising = (items) => items.slice().sort((a, b) => b.advertising - a.advertising).slice(0, 20);
  const byAcos = (items) => items.filter((item) => item.acos !== null).sort((a, b) => b.acos - a.acos).slice(0, 20);

  return {
    topRevenueSkus: byRevenue(skus),
    lowestMarginSkus: byLowestGm(skus),
    lowestMarginCategories: byLowestGm(categories),
    highestInvestmentAds: byAdvertising(ads),
    highestAcosAds: byAcos(ads)
  };
}

function buildIntelligentAnalytics() {
  const metadata = readMetadata();
  const monthEntries = Object.entries(metadata.areas.area1 && metadata.areas.area1.months || {})
    .filter((entry) => entry[1] && entry[1].rowsName)
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  const fallbackYear = new Date().getFullYear();
  const monthSources = monthEntries.map(([month, monthMetadata]) => {
    const rows = readPublishedRows(monthMetadata);
    const updatedYear = monthMetadata.updatedAt ? new Date(monthMetadata.updatedAt).getFullYear() : fallbackYear;
    return {
      month,
      year: updatedYear,
      rows,
      aggregate: aggregatePublishedMonth(rows, month, updatedYear)
    };
  }).filter((source) => source.aggregate);
  const months = monthSources.map((source) => source.aggregate);

  if (!months.length) {
    return null;
  }

  const currentFull = months[months.length - 1];
  const currentSource = monthSources[monthSources.length - 1];
  const today = getSaoPauloDateParts();
  const mtdDay = currentFull.month === today.month && currentFull.year === today.year
    ? Math.max(today.day - 1, 1)
    : currentFull.coverage && currentFull.coverage.calendarDays;
  const actualDataDay = Math.max(1, Math.min(
    currentFull.coverage && currentFull.coverage.latestDay || mtdDay || 1,
    mtdDay || 1
  ));
  const calendarDays = currentFull.coverage && currentFull.coverage.calendarDays
    || new Date(currentFull.year, currentFull.month, 0).getDate();
  const currentMtd = aggregatePublishedScenario(
    currentSource.rows,
    currentSource.month,
    currentSource.year,
    'actual',
    { cutoffDay: mtdDay }
  );
  const current = Object.assign({}, currentFull, {
    totals: currentMtd ? currentMtd.totals : currentFull.totals,
    marketplaces: currentMtd ? currentMtd.marketplaces : currentFull.marketplaces,
    categories: currentMtd ? currentMtd.categories : currentFull.categories,
    skus: currentMtd ? currentMtd.skus : currentFull.skus,
    ads: currentMtd ? currentMtd.ads : currentFull.ads
  });
  const currentPoolSource = currentMtd || currentFull;
  if (currentPoolSource && currentPoolSource._analysisPools) {
    Object.defineProperty(current, '_analysisPools', { value: currentPoolSource._analysisPools, enumerable: false });
  }
  months[months.length - 1] = current;
  const priorComparableMonths = monthSources.slice(0, -1)
    .map((source) => buildComparableMonth(source, mtdDay))
    .filter(Boolean);
  const previous = months.length > 1 ? months[months.length - 2] : null;
  const previousComparable = priorComparableMonths.length
    ? priorComparableMonths[priorComparableMonths.length - 1]
    : null;
  const average3 = calculateAverageMetrics(priorComparableMonths.slice(-3));
  const average6 = calculateAverageMetrics(priorComparableMonths.slice(-6));
  const forecastToDate = scaleMetricTotals(current.forecastTotals, mtdDay / calendarDays);
  const projectedTotals = scaleMetricTotals(current.totals, calendarDays / actualDataDay);
  const reportDateLabel = String(actualDataDay).padStart(2, '0') + '/'
    + String(current.month).padStart(2, '0') + '/' + current.year;
  const mtdDateLabel = String(mtdDay).padStart(2, '0') + '/'
    + String(current.month).padStart(2, '0') + '/' + current.year;
  const comparisons = {};

  ['revenue', 'netRevenue', 'quantity', 'averageTicket', 'gm', 'gmPercent', 'advertising', 'affiliates', 'tacos', 'acos'].forEach((key) => {
    comparisons[key] = {
      vsPrevious: calculateMetricVariation(current.totals[key], previousComparable && previousComparable.totals[key]),
      vsAverage3: calculateMetricVariation(current.totals[key], average3 && average3[key]),
      vsAverage6: calculateMetricVariation(current.totals[key], average6 && average6[key]),
      vsForecast: calculateMetricVariation(current.totals[key], forecastToDate && forecastToDate[key]),
      projectedVsForecast: calculateMetricVariation(projectedTotals && projectedTotals[key], current.forecastTotals && current.forecastTotals[key])
    };
  });

  return {
    generatedFrom: getPublishedDataSignature(),
    availableMonths: months.map((month) => month.label),
    currentMonth: current.label,
    previousMonth: previous ? previous.label : '',
    periodContext: {
      status: 'MTD Forecast',
      reportRule: 'D-1',
      reportDay: mtdDay,
      mtdDay,
      mtdDate: mtdDateLabel,
      actualDataDay,
      expectedD1Day: mtdDay,
      expectedD1Date: mtdDateLabel,
      dataLagDays: Math.max(mtdDay - actualDataDay, 0),
      calendarDays,
      elapsedShare: mtdDay / calendarDays,
      asOfDate: reportDateLabel,
      isPartialMonth: mtdDay < calendarDays,
      currentPeriodLabel: '01/' + String(current.month).padStart(2, '0') + '/' + current.year
        + ' a ' + reportDateLabel,
      comparisonRule: previousComparable && previousComparable.comparisonMethod === 'estimated_daily_average'
        ? 'Período anterior estimado pela média diária do mês completo'
        : 'Mesmo número de dias com dados diários reais',
      previousComparisonMethod: previousComparable && previousComparable.comparisonMethod || '',
      previousComparisonDescription: previousComparable && previousComparable.comparisonDescription || '',
      dailyHistoryAvailableFrom: '01/06/2026'
    },
    months,
    current: Object.assign({}, current, {
      marketplaces: addTrendVariation(current.marketplaces, previousComparable && previousComparable.marketplaces),
      categories: addTrendVariation(current.categories, previousComparable && previousComparable.categories),
      skus: addTrendVariation(current.skus, previousComparable && previousComparable.skus),
      ads: addTrendVariation(current.ads, previousComparable && previousComparable.ads)
    }),
    previous,
    previousComparable,
    average3,
    average6,
    forecastToDate,
    projectedTotals,
    comparisons,
    coverageAudit: buildIntelligentCoverageAudit(current),
    decisionViews: buildIntelligentDecisionViews(current),
    abc: buildIntelligentAbcSummary(current._analysisPools ? current._analysisPools.skus : current.skus),
    risks: buildIntelligentRiskSummary(Object.assign({}, current, {
      skus: current._analysisPools ? current._analysisPools.skus : current.skus,
      ads: current._analysisPools ? current._analysisPools.ads : current.ads,
      categories: current._analysisPools ? current._analysisPools.categories : current.categories,
      marketplaces: current._analysisPools ? current._analysisPools.marketplaces : current.marketplaces
    }))
  };
}

function getPublishedDataSignature() {
  const metadata = readMetadata();
  const months = Object.entries(metadata.areas.area1 && metadata.areas.area1.months || {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([month, item]) => ({
      month,
      storedName: item.storedName || '',
      rowsName: item.rowsName || '',
      updatedAt: item.updatedAt || '',
      rowsUpdatedAt: item.rowsUpdatedAt || ''
    }));

  return crypto.createHash('sha256').update(JSON.stringify({
    analysisVersion: 10,
    months
  })).digest('hex');
}

function sanitizeUrgencyContext(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const takeItems = (items) => (Array.isArray(items) ? items : []).slice(0, 25).map((item) => ({
    marketplace: String(item.marketplace || '').slice(0, 80),
    marketplaceSale: String(item.marketplaceSale || '').slice(0, 120),
    category: String(item.category || '').slice(0, 120),
    sku: String(item.sku || '').slice(0, 80),
    ad: String(item.ad || '').slice(0, 120),
    revenue: Number(item.revenue) || 0,
    gm: Number(item.gm) || 0,
    gmPercent: Number(item.gmPercent) || 0,
    advertising: Number(item.advertising) || 0,
    tacos: Number(item.tacos) || 0
  }));
  const takeSummaries = (items) => (Array.isArray(items) ? items : []).slice(0, 15).map((item) => ({
    name: String(item.name || '').slice(0, 120),
    revenue: Number(item.revenue) || 0,
    gm: Number(item.gm) || 0,
    gmPercent: Number(item.gmPercent) || 0,
    advertising: Number(item.advertising) || 0,
    tacos: Number(item.tacos) || 0,
    negativeMarginCount: Number(item.negativeMarginCount) || 0,
    highTacosCount: Number(item.highTacosCount) || 0,
    ads: Number(item.ads) || 0
  }));

  return {
    period: String(source.period || '').slice(0, 80),
    totals: {
      analyzedAds: Number(source.totals && source.totals.analyzedAds) || 0,
      negativeMarginCount: Number(source.totals && source.totals.negativeMarginCount) || 0,
      highTacosCount: Number(source.totals && source.totals.highTacosCount) || 0,
      totalRevenue: Number(source.totals && source.totals.totalRevenue) || 0,
      totalAdvertising: Number(source.totals && source.totals.totalAdvertising) || 0,
      totalNegativeGm: Number(source.totals && source.totals.totalNegativeGm) || 0,
      criticalTacosInvestment: Number(source.totals && source.totals.criticalTacosInvestment) || 0
    },
    negativeMarginItems: takeItems(source.negativeMarginItems),
    highTacosItems: takeItems(source.highTacosItems),
    channelSummary: takeSummaries(source.channelSummary),
    categorySummary: takeSummaries(source.categorySummary),
    riskBands: source.riskBands && typeof source.riskBands === 'object' ? source.riskBands : {},
    zeroRevenueWithAds: takeItems(source.zeroRevenueWithAds)
  };
}


function readAiAnalysisCache() {
  if (!fs.existsSync(aiAnalysisCachePath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(aiAnalysisCachePath, 'utf8')) || {};
  } catch (error) {
    console.warn('N\u00e3o foi poss\u00edvel ler o cache de an\u00e1lise IA:', error.message);
    return {};
  }
}

function writeAiAnalysisCache(cache) {
  try {
    const entries = Object.entries(cache).sort((a, b) => {
      return new Date(b[1] && b[1].generatedAt || 0) - new Date(a[1] && a[1].generatedAt || 0);
    }).slice(0, 24);
    fs.writeFileSync(aiAnalysisCachePath, JSON.stringify(Object.fromEntries(entries), null, 2));
  } catch (error) {
    console.warn('N\u00e3o foi poss\u00edvel salvar o cache de an\u00e1lise IA:', error.message);
  }
}

function getAiAnalysisCacheKey(context, model) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ version: 3, model, context }))
    .digest('hex');
}

function parseStructuredAnalysis(text) {
  try {
    const parsed = JSON.parse(text);
    const relevantPoints = Array.isArray(parsed.relevantPoints)
      ? parsed.relevantPoints.slice(0, 6).map((item, index) => ({
          title: String(item && item.title || 'Ponto relevante ' + (index + 1)),
          body: String(item && item.body || '')
        }))
      : [];

    return {
      analysis: String(parsed.analysis || '').trim(),
      relevantPoints
    };
  } catch (error) {
    return { analysis: String(text || '').trim(), relevantPoints: [] };
  }
}

async function handleAiUrgencyAnalysis(request, response) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
  const clientIp = request.socket.remoteAddress || 'unknown';
  const lastRun = aiAnalysisLastRunByIp.get(clientIp) || 0;

  if (!apiKey) {
    sendJson(response, 503, { error: 'OPENAI_API_KEY n\u00e3o configurada no servidor.' });
    return;
  }

  try {
    const requestPayload = await collectJsonRequest(request, maxAiRequestBytes);
    const context = sanitizeUrgencyContext(requestPayload);
    const cacheKey = getAiAnalysisCacheKey(context, model);
    const cache = readAiAnalysisCache();
    const cachedResult = cache[cacheKey];

    if (cachedResult && cachedResult.analysis && Array.isArray(cachedResult.relevantPoints)) {
      sendJson(response, 200, Object.assign({ cached: true }, cachedResult));
      return;
    }

    if (Date.now() - lastRun < aiAnalysisCooldownMs) {
      sendJson(response, 429, { error: 'Aguarde alguns segundos antes de gerar uma nova an\u00e1lise.' });
      return;
    }

    aiAnalysisLastRunByIp.set(clientIp, Date.now());

    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        instructions: [
          'Voc\u00ea \u00e9 um analista s\u00eanior de FP&A, performance comercial e marketplaces.',
          'Responda sempre em portugu\u00eas do Brasil, usando linguagem simples, clara e f\u00e1cil de entender.',
          'Analise somente os dados fornecidos e nunca invente n\u00fameros, causas ou fatos.',
          'A resposta possui dois n\u00edveis obrigat\u00f3rios: uma an\u00e1lise principal profunda e seis pontos relevantes detalhados.',
          'A propriedade analysis deve conter a an\u00e1lise principal completa, e nunca uma frase de encaminhamento como an\u00e1lise pronta, veja abaixo ou equivalente.',
          'Na an\u00e1lise principal, explore explicitamente os seis pontos relevantes, conectando-os entre si e explicando o impacto total no neg\u00f3cio.',
          'A an\u00e1lise principal deve ter entre 900 e 1.400 palavras e conter estes t\u00edtulos: Vis\u00e3o executiva; Leitura dos seis pontos; Diagn\u00f3stico de margem; Diagn\u00f3stico de publicidade e TACOS; Estrat\u00e9gia de bids; Plano de recupera\u00e7\u00e3o; Prioridades das pr\u00f3ximas 24 horas; Indicadores de acompanhamento.',
          'Em Leitura dos seis pontos, crie seis subt\u00edtulos numerados e aprofunde cada ponto com: evid\u00eancia num\u00e9rica, impacto financeiro, causa prov\u00e1vel indicada pelos dados, n\u00edvel de urg\u00eancia, a\u00e7\u00e3o recomendada e resultado esperado.',
          'Cada item de relevantPoints deve resumir um dos mesmos seis temas da an\u00e1lise principal, mas seu body deve ser detalhado, com pelo menos tr\u00eas frases \u00fateis e espec\u00edficas.',
          'Os seis pontos devem cobrir temas diferentes e relevantes, como concentra\u00e7\u00e3o de perdas, pior canal, pior categoria, an\u00fancios com receita zero, publicidade cr\u00edtica, margem negativa e oportunidade de realoca\u00e7\u00e3o.',
          'Explique rapidamente TACOS, GM, margem e bids quando aparecerem, evitando jarg\u00f5es sem explica\u00e7\u00e3o.',
          'Na estrat\u00e9gia de bids, classifique os casos entre pausar, reduzir, manter, testar e aumentar. Nunca recomende aumento sem margem positiva e evid\u00eancia suficiente.',
          'N\u00e3o trate TACOS acima de 5% como pausa autom\u00e1tica. Avalie TACOS junto com faturamento, margem, investimento e relev\u00e2ncia do an\u00fancio.',
          'Para cada recomenda\u00e7\u00e3o, diga de forma simples: o que fazer, por que fazer, quem deve agir, prazo sugerido e qual resultado esperar.',
          'Use valores, percentuais, canais, categorias, SKUs e an\u00fancios presentes no contexto para tornar a an\u00e1lise concreta.'
        ].join(' '),
        reasoning: { effort: 'low' },
        text: {
          format: {
            type: 'json_schema',
            name: 'urgency_analysis',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                analysis: { type: 'string' },
                relevantPoints: {
                  type: 'array',
                  minItems: 6,
                  maxItems: 6,
                  items: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      body: { type: 'string' }
                    },
                    required: ['title', 'body'],
                    additionalProperties: false
                  }
                }
              },
              required: ['analysis', 'relevantPoints'],
              additionalProperties: false
            }
          }
        },
        input: 'Contexto consolidado da aba Urg\u00eancias:\n' + JSON.stringify(context),
        max_output_tokens: 7600
      })
    });

    const result = await openAiResponse.json().catch(() => ({}));

    if (!openAiResponse.ok) {
      console.error('Erro OpenAI:', openAiResponse.status, result);
      const apiErrorMessage = result.error && result.error.message ? result.error.message : '';
      const friendlyMessage = openAiResponse.status === 429 && /quota|billing/i.test(apiErrorMessage)
        ? 'A conta da OpenAI est\u00e1 sem cr\u00e9ditos ou faturamento ativo. Verifique o plano e o billing da API.'
        : apiErrorMessage || 'N\u00e3o foi poss\u00edvel gerar a an\u00e1lise com IA.';

      sendJson(response, openAiResponse.status, { error: friendlyMessage });
      return;
    }

    const responseText = extractResponseText(result);
    if (!responseText) {
      const incompleteReason = result.incomplete_details && result.incomplete_details.reason;
      console.error('Resposta OpenAI sem texto:', { status: result.status, incompleteReason, outputTypes: Array.isArray(result.output) ? result.output.map((item) => item.type) : [] });
      sendJson(response, 502, { error: incompleteReason === 'max_output_tokens'
        ? 'A resposta atingiu o limite antes de concluir. Tente gerar novamente.'
        : 'A OpenAI n\u00e3o retornou texto para a an\u00e1lise. Tente gerar novamente.' });
      return;
    }

    const structured = parseStructuredAnalysis(responseText);
    const detailedPoints = structured.relevantPoints.every((point) => String(point.body || '').trim().length >= 120);
    if (!structured.analysis || structured.analysis.length < 1800 || structured.relevantPoints.length !== 6 || !detailedPoints) {
      sendJson(response, 502, { error: 'A an\u00e1lise retornada ficou superficial ou incompleta. A gera\u00e7\u00e3o ser\u00e1 refeita automaticamente ao recarregar a base.' });
      return;
    }

    const generatedResult = {
      analysis: structured.analysis,
      relevantPoints: structured.relevantPoints,
      model,
      generatedAt: new Date().toISOString()
    };
    cache[cacheKey] = generatedResult;
    writeAiAnalysisCache(cache);
    sendJson(response, 200, Object.assign({ cached: false }, generatedResult));
  } catch (error) {
    const statusCode = error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    const message = error.message === 'PAYLOAD_TOO_LARGE'
      ? 'O resumo enviado para an\u00e1lise \u00e9 muito grande.'
      : error.message === 'INVALID_JSON'
        ? 'Dados inv\u00e1lidos para an\u00e1lise.'
        : 'Erro ao gerar an\u00e1lise com IA: ' + error.message;

    console.error('Erro na an\u00e1lise IA:', error);
    sendJson(response, statusCode, { error: message });
  }
}

async function handleVariationAnalysis(request, response) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
  if (!apiKey) { sendJson(response, 503, { error: 'OPENAI_API_KEY n\u00e3o configurada no servidor.' }); return; }
  try {
    const context = await collectJsonRequest(request, maxAiRequestBytes);
    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, instructions: ['Você é um analista sênior de FP&A e marketplaces.','Responda em português do Brasil com 6 a 9 frases objetivas, em texto corrido e sem markdown.','Use somente os dados fornecidos e conclua todas as frases; nunca termine a resposta no meio de uma análise.','Comece informando a variação total do faturamento entre os períodos, em reais e percentual.','Explique os efeitos de mix, quantidade e preço, destacando quais impulsionaram e quais pressionaram o resultado.','Depois apresente as principais oscilações de Categoria2 e SKU, considerando altas e quedas.','Dê atenção explícita às principais quedas: cite pelo menos duas Categorias2 e dois SKUs com queda, quando existirem no contexto.','Comente quantidade, faturamento e margem apenas quando forem relevantes para explicar cada movimento.','Analise exclusivamente Categoria2 e SKU. Não cite anúncios.','Formate todos os valores monetários no padrão brasileiro, como R$ 19.328,46.','Todo número citado deve ter exatamente duas casas decimais e vírgula decimal, inclusive quantidades, variações, efeitos, percentuais e pontos percentuais; escreva, por exemplo, quantidade +37,00, variação +22,99% e margem -2,93 p.p.','Nunca apresente números inteiros sem ,00 e nunca exponha mais de duas casas decimais.','Encerre com uma recomendação prática baseada nas maiores quedas identificadas.'].join(' '), input: 'Comparação de períodos com valores já arredondados para duas casas decimais:\n' + JSON.stringify(context), reasoning: { effort: 'low' }, max_output_tokens: 1000 })
    });
    const result = await openAiResponse.json().catch(() => ({}));
    if (!openAiResponse.ok) { sendJson(response, openAiResponse.status, { error: result.error && result.error.message || 'N\u00e3o foi poss\u00edvel gerar o resumo agora.' }); return; }
    const summary = extractResponseText(result);
    if (!summary) { sendJson(response, 502, { error: 'A OpenAI n\u00e3o retornou texto para o resumo.' }); return; }
    sendJson(response, 200, { summary, model });
  } catch (error) { sendJson(response, error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: 'N\u00e3o foi poss\u00edvel gerar o resumo agora.' }); }
}

function readIntelligentAnalysisCache() {
  if (intelligentAnalysisMemoryCache) {
    return intelligentAnalysisMemoryCache;
  }

  for (const cachePath of [intelligentAnalysisCachePath, intelligentAnalysisFallbackCachePath]) {
    if (!fs.existsSync(cachePath)) {
      continue;
    }
    try {
      intelligentAnalysisMemoryCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      return intelligentAnalysisMemoryCache;
    } catch (error) {
      console.warn('Nao foi possivel ler o cache da Analise Inteligente:', error.message);
    }
  }
  return null;
}

function writeIntelligentAnalysisCache(result) {
  const payload = JSON.stringify(result);
  intelligentAnalysisMemoryCache = result;

  try {
    fs.writeFileSync(intelligentAnalysisCachePath, payload);
    return;
  } catch (error) {
    console.warn('Drive indisponivel para o cache da Analise Inteligente; usando cache alternativo:', error.message);
  }

  try {
    fs.writeFileSync(intelligentAnalysisFallbackCachePath, payload);
  } catch (error) {
    console.warn('Nao foi possivel persistir o cache alternativo da Analise Inteligente:', error.message);
  }
}

function removeForecastComparisons(comparisons) {
  if (!comparisons || typeof comparisons !== 'object') {
    return comparisons;
  }
  return Object.fromEntries(Object.entries(comparisons).map(([key, value]) => {
    if (!value || typeof value !== 'object') {
      return [key, value];
    }
    const copy = Object.assign({}, value);
    delete copy.vsForecast;
    delete copy.projectedVsForecast;
    return [key, copy];
  }));
}

function compactIntelligentAnalytics(analytics, options) {
  const includeFullBase = Boolean(options && options.includeFullBase);
  const dailyMode = Boolean(options && options.dailyMode);
  const actualOnly = Boolean(options && options.actualOnly);
  const compactMetric = (item) => ({
    name: item.name,
    revenue: item.revenue,
    netRevenue: item.netRevenue,
    quantity: item.quantity,
    orders: item.orders,
    averageTicket: item.averageTicket,
    gm: item.gm,
    gmPercent: item.gmPercent,
    advertising: item.advertising,
    affiliates: item.affiliates,
    adsRevenue: item.adsRevenue,
    tacos: item.tacos,
    acos: item.acos,
    adsRevenueShare: item.adsRevenueShare,
    channels: item.channels,
    revenueVariation: item.revenueVariation,
    gmVariation: item.gmVariation
  });
  const listMetrics = (items) => (Array.isArray(items) ? items : []).map(compactMetric);
  const poolItems = (source, key) => source && source._analysisPools && Array.isArray(source._analysisPools[key])
    ? source._analysisPools[key]
    : (source && Array.isArray(source[key]) ? source[key] : []);
  const result = {
    availableMonths: analytics.availableMonths,
    currentMonth: analytics.currentMonth,
    previousMonth: analytics.previousMonth,
    periodContext: analytics.periodContext,
    monthlyEvolution: analytics.months.map((month) => ({
      month: month.label,
      totals: month.totals,
      marketplaces: month.marketplaces.map(compactMetric)
    })),
    currentTotals: analytics.current.totals,
    forecastTotals: actualOnly ? null : analytics.current.forecastTotals,
    forecastToDate: actualOnly ? null : analytics.forecastToDate,
    projectedClosing: actualOnly ? null : analytics.projectedTotals,
    previousTotals: analytics.previous && analytics.previous.totals,
    previousComparableTotals: analytics.previousComparable && analytics.previousComparable.totals,
    average3: analytics.average3,
    average6: analytics.average6,
    comparisons: actualOnly ? removeForecastComparisons(analytics.comparisons) : analytics.comparisons,
    coverageAudit: analytics.coverageAudit,
    decisionViews: analytics.decisionViews,
    marketplaces: analytics.current.marketplaces.map(compactMetric),
    categories: analytics.current.categories.map(compactMetric),
    skus: analytics.current.skus.map(compactMetric),
    ads: analytics.current.ads.map(compactMetric),
    goals: actualOnly ? null : {
      source: 'Forecast da base carregada',
      totals: analytics.current.forecastTotals,
      marketplaces: analytics.current.forecastMarketplaces.map(compactMetric),
      categories: analytics.current.forecastCategories.map(compactMetric)
    },
    abc: analytics.abc,
    urgencies: analytics.risks
  };

  if (includeFullBase) {
    const currentPools = {
      marketplaces: poolItems(analytics.current, 'marketplaces'),
      categories: poolItems(analytics.current, 'categories'),
      skus: poolItems(analytics.current, 'skus'),
      ads: poolItems(analytics.current, 'ads')
    };
    const monthFull = (month) => ({
      month: month.label,
      coverage: month.coverage,
      totals: month.totals,
      marketplaces: listMetrics(poolItems(month, 'marketplaces')),
      categories: listMetrics(poolItems(month, 'categories')),
      skus: dailyMode ? [] : listMetrics(poolItems(month, 'skus')).slice(0, 80),
      ads: dailyMode ? [] : listMetrics(poolItems(month, 'ads')).slice(0, 120)
    });
    const catalogFromMonths = (key) => Array.from(new Set(analytics.months.flatMap((month) => poolItems(month, key).map((item) => item.name)))).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));

    result.completeBase = {
      scope: dailyMode
        ? 'Base de apoio agregada. Como a pergunta contém dias específicos, o recorte diário completo está em dailyData e deve ser usado como fonte prioritária sem cortes.'
        : 'Base completa agregada a partir dos arquivos publicados: todos os registros foram consolidados por mês, Marketplace, Categoria2, SKU e Anúncio. O contexto não envia cada linha bruta para evitar estouro de tokens; envia agregados calculados do universo disponível e usa targetedData para recortes específicos.',
      currentPeriod: {
        month: analytics.current.label,
        coverage: analytics.current.coverage,
        totals: analytics.current.totals,
        marketplaces: listMetrics(currentPools.marketplaces),
        categories: listMetrics(currentPools.categories),
        skus: dailyMode ? listMetrics(currentPools.skus).slice(0, 80) : listMetrics(currentPools.skus),
        ads: dailyMode ? listMetrics(currentPools.ads).slice(0, 120) : listMetrics(currentPools.ads)
      },
      allMonths: analytics.months.map(monthFull),
      catalog: dailyMode ? {
        marketplaces: catalogFromMonths('marketplaces'),
        categories: catalogFromMonths('categories')
      } : {
        marketplaces: catalogFromMonths('marketplaces'),
        categories: catalogFromMonths('categories'),
        skus: catalogFromMonths('skus'),
        ads: catalogFromMonths('ads')
      },
      counts: {
        months: analytics.months.length,
        currentMarketplaces: currentPools.marketplaces.length,
        currentCategories: currentPools.categories.length,
        currentSkus: currentPools.skus.length,
        currentAds: currentPools.ads.length,
        catalogMarketplaces: catalogFromMonths('marketplaces').length,
        catalogCategories: catalogFromMonths('categories').length,
        catalogSkus: dailyMode ? 0 : catalogFromMonths('skus').length,
        catalogAds: dailyMode ? 0 : catalogFromMonths('ads').length
      }
    };
  }

  return result;
}

function sanitizeCopilotMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  const recent = messages.slice(-12);
  return recent.map((message, index) => {
    const role = message && message.role === 'assistant' ? 'assistant' : 'user';
    const text = String(message && message.text || '').trim().slice(0, 5000);
    const image = index === recent.length - 1 && role === 'user' && typeof message.image === 'string'
      && /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(message.image)
      && message.image.length <= 6 * 1024 * 1024
      ? message.image
      : '';

    return { role, text, image };
  }).filter((message) => message.text || message.image);
}

function getPublishedAnalysisSources() {
  const metadata = readMetadata();
  return Object.entries(metadata.areas.area1 && metadata.areas.area1.months || {})
    .filter(([, item]) => item && item.rowsName)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([month, monthMetadata]) => {
      const year = monthMetadata.updatedAt
        ? new Date(monthMetadata.updatedAt).getFullYear()
        : getSaoPauloDateParts().year;
      return {
        month: Number(month),
        year,
        rows: readPublishedRows(monthMetadata),
        rowsName: monthMetadata.rowsName,
        updatedAt: monthMetadata.rowsUpdatedAt || monthMetadata.updatedAt || ''
      };
    })
    .filter((source) => Array.isArray(source.rows) && source.rows.length > 1);
}

function getLatestPublishedAnalysisSource() {
  const sources = getPublishedAnalysisSources();
  return sources[sources.length - 1] || null;
}

function extractCopilotSearchTerms(messages) {
  const recentUserMessages = (messages || []).filter((message) => message && message.role === 'user').slice(-4);
  const text = recentUserMessages.map((message) => String(message.text || '')).join('\n');
  const stopWords = new Set([
    'sobre', 'qual', 'quais', 'como', 'porque', 'por', 'que', 'onde', 'este', 'esta', 'esse', 'essa',
    'produto', 'produtos', 'anuncio', 'anuncios', 'marketplace', 'categoria', 'conta', 'canal',
    'faturamento', 'margem', 'publicidade', 'investimento', 'analise', 'analisar', 'dados', 'resultado',
    'comparar', 'comparativo', 'cresceu', 'crescimento', 'queda', 'quedas', 'maiores', 'menores'
  ]);

  return Array.from(new Set(text.split(/[^A-Za-zÀ-ÿ0-9_-]+/)
    .map((term) => normalizeAnalysisText(term))
    .filter((term) => term.length >= 3 && !stopWords.has(term))));
}

function buildCopilotTargetedContext(messages, options) {
  const sources = getPublishedAnalysisSources();
  const terms = extractCopilotSearchTerms(messages);

  if (!sources.length || !terms.length) {
    return null;
  }

  const identifierTerms = terms.filter((term) => /\d/.test(term) || term.length >= 8);
  const effectiveTerms = identifierTerms.length ? identifierTerms : terms;
  const periods = [];
  const globalDimensions = new Map();
  let totalMatchedRows = 0;

  sources.forEach((source) => {
    const headers = source.rows[0].map((header) => String(header || ''));
    const searchableColumns = [
      ['Marketplace'], ['Marketplace venda'], ['SKU'],
      ['Id anuncio', 'Id anúncio', 'ID do anuncio', 'Anúncio'],
      ['Categoria'], ['Categoria2', 'Categoria 2'],
      ['Sub Categoria', 'Subcategoria', 'Sub-Categoria'],
      ['Descrição', 'Descricao'], ['Type']
    ].map((names) => findAnalysisHeader(headers, names)).filter((index) => index >= 0);
    const matchedRows = source.rows.slice(1).filter((row) => {
      const searchableText = searchableColumns
        .map((index) => normalizeAnalysisText(row[index]))
        .join(' | ');
      return identifierTerms.length
        ? effectiveTerms.every((term) => searchableText.includes(term))
        : effectiveTerms.some((term) => searchableText.includes(term));
    });

    if (!matchedRows.length) {
      return;
    }

    totalMatchedRows += matchedRows.length;
    const today = getSaoPauloDateParts();
    const cutoffDay = source.month === today.month && source.year === today.year
      ? Math.max(today.day - 1, 1)
      : new Date(source.year, source.month, 0).getDate();
    const matchedDataset = [headers].concat(matchedRows);
    const actual = aggregatePublishedScenario(matchedDataset, source.month, source.year, 'actual', { cutoffDay });
    const forecast = options && options.actualOnly ? null : aggregatePublishedScenario(matchedDataset, source.month, source.year, 'forecast');
    const dimensions = {};

    searchableColumns.forEach((index) => {
      const name = headers[index];
      const values = Array.from(new Set(matchedRows.map((row) => String(row[index] || '').trim()).filter(Boolean))).slice(0, 100);
      dimensions[name] = values;
      const globalSet = globalDimensions.get(name) || new Set();
      values.forEach((value) => globalSet.add(value));
      globalDimensions.set(name, globalSet);
    });

    periods.push({
      period: String(source.month).padStart(2, '0') + '/' + source.year,
      rowsName: source.rowsName,
      updatedAt: source.updatedAt,
      matchedRows: matchedRows.length,
      dimensions,
      actual,
      forecast
    });
  });

  if (!periods.length) {
    return {
      queryTerms: effectiveTerms,
      matchedRows: 0,
      searchedMonths: sources.map((source) => String(source.month).padStart(2, '0') + '/' + source.year),
      note: 'Nenhum registro específico da base correspondeu aos termos pesquisados; use completeBase para responder análises gerais e explique se o identificador citado não existir no catálogo.'
    };
  }

  return {
    queryTerms: effectiveTerms,
    matchedRows: totalMatchedRows,
    searchedMonths: sources.map((source) => String(source.month).padStart(2, '0') + '/' + source.year),
    dimensions: Object.fromEntries(Array.from(globalDimensions.entries()).map(([name, values]) => [name, Array.from(values).slice(0, 200)])),
    periods
  };
}

function toAnalysisIsoDate(parts) {
  if (!parts || !parts.day || !parts.month || !parts.year) {
    return '';
  }
  return String(parts.year).padStart(4, '0') + '-' + String(parts.month).padStart(2, '0') + '-' + String(parts.day).padStart(2, '0');
}

function getCopilotLatestSourceForDateFallback(sources) {
  return sources[sources.length - 1] || { month: getSaoPauloDateParts().month, year: getSaoPauloDateParts().year };
}

function extractCopilotRequestedDates(messages) {
  const recentUserMessages = (messages || []).filter((message) => message && message.role === 'user').slice(-4);
  const text = recentUserMessages.map((message) => String(message.text || '')).join('\n');
  const normalized = normalizeAnalysisText(text);
  const sources = getPublishedAnalysisSources();
  const fallback = getCopilotLatestSourceForDateFallback(sources);
  const dates = new Map();
  const explicitDates = [];
  const buildDate = (day, month, year, sourceText, index) => {
    const safeDay = Number(day);
    const safeMonth = Number(month) || Number(fallback.month);
    const safeYear = Number(year) ? (Number(year) < 100 ? 2000 + Number(year) : Number(year)) : Number(fallback.year);
    if (!safeDay || safeDay < 1 || safeDay > 31 || !safeMonth || safeMonth < 1 || safeMonth > 12 || !safeYear) {
      return null;
    }
    const date = new Date(safeYear, safeMonth - 1, safeDay);
    if (date.getFullYear() !== safeYear || date.getMonth() !== safeMonth - 1 || date.getDate() !== safeDay) {
      return null;
    }
    const iso = toAnalysisIsoDate({ day: safeDay, month: safeMonth, year: safeYear });
    return iso ? { iso, day: safeDay, month: safeMonth, year: safeYear, sourceText, index: Number(index) || 0 } : null;
  };
  const addDate = (date) => {
    if (date) {
      dates.set(date.iso, date);
    }
  };
  const addRange = (startDate, endDate, sourceText) => {
    if (!startDate || !endDate) {
      return;
    }
    const startTime = new Date(startDate.year, startDate.month - 1, startDate.day).getTime();
    const endTime = new Date(endDate.year, endDate.month - 1, endDate.day).getTime();
    const step = startTime <= endTime ? 86400000 : -86400000;
    const length = Math.floor(Math.abs(endTime - startTime) / 86400000) + 1;
    if (length > 45) {
      addDate(startDate);
      addDate(endDate);
      return;
    }
    for (let time = startTime, count = 0; count < length; time += step, count += 1) {
      const date = new Date(time);
      addDate({
        iso: toAnalysisIsoDate({ day: date.getDate(), month: date.getMonth() + 1, year: date.getFullYear() }),
        day: date.getDate(),
        month: date.getMonth() + 1,
        year: date.getFullYear(),
        sourceText
      });
    }
  };

  Array.from(text.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)).forEach((match) => {
    const date = buildDate(match[3], match[2], match[1], match[0], match.index);
    addDate(date);
    if (date) explicitDates.push(Object.assign({}, date, { endIndex: match.index + match[0].length }));
  });
  Array.from(text.matchAll(/\b(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?\b/g)).forEach((match) => {
    const date = buildDate(match[1], match[2], match[3] || fallback.year, match[0], match.index);
    addDate(date);
    if (date) explicitDates.push(Object.assign({}, date, { endIndex: match.index + match[0].length }));
  });
  Array.from(normalized.matchAll(/\bdia\s+(\d{1,2})\b/g)).forEach((match) => {
    addDate(buildDate(match[1], fallback.month, fallback.year, match[0], match.index));
  });

  explicitDates.sort((a, b) => a.index - b.index);
  for (let index = 0; index < explicitDates.length - 1; index += 1) {
    const current = explicitDates[index];
    const next = explicitDates[index + 1];
    const between = normalizeAnalysisText(text.slice(current.endIndex, next.index));
    if (/^(?:\s)*(?:a|ate|até|ao|ate o dia|até o dia|e ate|e até)(?:\s)*$/.test(between)) {
      addRange(current, next, current.sourceText + ' a ' + next.sourceText);
    }
  }

  return Array.from(dates.values()).sort((a, b) => a.iso.localeCompare(b.iso)).slice(0, 45);
}

function compactCopilotDailyScenario(scenario, options) {
  if (!scenario) {
    return null;
  }
  const compact = (item) => ({
    name: item.name,
    revenue: item.revenue,
    netRevenue: item.netRevenue,
    quantity: item.quantity,
    orders: item.orders,
    averageTicket: item.averageTicket,
    gm: item.gm,
    gmPercent: item.gmPercent,
    advertising: item.advertising,
    affiliates: item.affiliates,
    adsRevenue: item.adsRevenue,
    tacos: item.tacos,
    acos: item.acos,
    adsRevenueShare: item.adsRevenueShare,
    channels: item.channels
  });
  const pools = scenario._analysisPools || {};
  const summaryOnly = Boolean(options && options.summaryOnly);
  return {
    coverage: scenario.coverage,
    totals: scenario.totals,
    marketplaces: (pools.marketplaces || scenario.marketplaces || []).map(compact),
    categories: (pools.categories || scenario.categories || []).map(compact),
    skus: summaryOnly ? [] : (pools.skus || scenario.skus || []).map(compact),
    ads: summaryOnly ? [] : (pools.ads || scenario.ads || []).map(compact)
  };
}

function buildCopilotNegativeMarginSummary(actualScenario) {
  if (!actualScenario) {
    return null;
  }
  const summarize = (items) => {
    const negatives = (items || []).filter((item) => Number(item.gm) < 0);
    return {
      count: negatives.length,
      gm: negatives.reduce((total, item) => total + (Number(item.gm) || 0), 0),
      revenue: negatives.reduce((total, item) => total + (Number(item.revenue) || 0), 0),
      items: negatives.slice().sort((a, b) => (Number(a.gm) || 0) - (Number(b.gm) || 0)).slice(0, 25)
    };
  };
  return {
    source: 'Soma de GM negativa calculada no servidor com todos os agregados do recorte. A soma usa GM < 0.',
    byCategory: summarize(actualScenario.categories),
    bySku: summarize(actualScenario.skus),
    byAd: summarize(actualScenario.ads)
  };
}

function calculateCopilotDailyComparisons(days) {
  if (!Array.isArray(days) || days.length < 2) {
    return null;
  }
  const [first, second] = days;
  const firstTotals = first.actual && first.actual.totals || {};
  const secondTotals = second.actual && second.actual.totals || {};
  const keys = ['revenue', 'netRevenue', 'quantity', 'averageTicket', 'gm', 'gmPercent', 'advertising', 'affiliates', 'tacos', 'acos'];
  const totals = {};
  keys.forEach((key) => {
    totals[key] = {
      first: firstTotals[key],
      second: secondTotals[key],
      variation: (Number(firstTotals[key]) || 0) - (Number(secondTotals[key]) || 0),
      variationPercent: calculateMetricVariation(Number(firstTotals[key]) || 0, Number(secondTotals[key]) || 0)
    };
  });
  return {
    base: first.date,
    comparedWith: second.date,
    totals
  };
}

function buildCopilotDailyContext(messages) {
  const requestedDates = extractCopilotRequestedDates(messages);
  if (!requestedDates.length) {
    return null;
  }

  const sources = getPublishedAnalysisSources();
  const isRange = requestedDates.length > 2;
  const combinedByPeriod = new Map();
  const days = requestedDates.map((requestedDate) => {
    const source = sources.find((item) => Number(item.month) === Number(requestedDate.month) && Number(item.year) === Number(requestedDate.year));
    if (!source) {
      return {
        date: requestedDate.iso,
        requestedAs: requestedDate.sourceText,
        matchedRows: 0,
        note: 'Nenhum arquivo publicado encontrado para este mês/ano.'
      };
    }

    const headers = source.rows[0].map((header) => String(header || ''));
    const dateIndex = findAnalysisHeader(headers, ['Data', 'Full Data', 'Record Date']);
    if (dateIndex < 0) {
      return {
        date: requestedDate.iso,
        requestedAs: requestedDate.sourceText,
        matchedRows: 0,
        note: 'A base publicada não possui coluna de data reconhecida.'
      };
    }

    const dateRows = source.rows.slice(1).filter((row) => {
      const parts = parseAnalysisDateParts(row[dateIndex], source.month, source.year);
      return toAnalysisIsoDate(parts) === requestedDate.iso;
    });
    const periodKey = String(source.month).padStart(2, '0') + '/' + source.year;
    const periodBucket = combinedByPeriod.get(periodKey) || { source, headers, rows: [] };
    periodBucket.rows = periodBucket.rows.concat(dateRows);
    combinedByPeriod.set(periodKey, periodBucket);
    const dataset = [headers].concat(dateRows);

    return {
      date: requestedDate.iso,
      label: String(requestedDate.day).padStart(2, '0') + '/' + String(requestedDate.month).padStart(2, '0') + '/' + requestedDate.year,
      requestedAs: requestedDate.sourceText,
      period: periodKey,
      rowsName: source.rowsName,
      updatedAt: source.updatedAt,
      matchedRows: dateRows.length,
      actual: compactCopilotDailyScenario(aggregatePublishedScenario(dataset, source.month, source.year, 'actual'), { summaryOnly: isRange }),
      forecast: null
    };
  });

  const periodAggregates = Array.from(combinedByPeriod.entries()).map(([period, bucket]) => {
    const dataset = [bucket.headers].concat(bucket.rows);
    const actual = compactCopilotDailyScenario(aggregatePublishedScenario(dataset, bucket.source.month, bucket.source.year, 'actual'));
    const forecast = null;
    return {
      period,
      dates: requestedDates.filter((date) => String(date.month).padStart(2, '0') + '/' + date.year === period).map((date) => date.iso),
      matchedRows: bucket.rows.length,
      actual,
      forecast,
      negativeMarginSummary: buildCopilotNegativeMarginSummary(actual)
    };
  });

  return {
    scope: isRange
      ? 'Recorte de intervalo diário solicitado. days traz totais, Marketplace e Categoria2 por dia; periodAggregates traz o período consolidado com todos os SKUs e anúncios, sem corte, para cálculos minuciosos do intervalo.'
      : 'Recorte diário exato solicitado pelo usuário. Cada dia inclui todas as linhas da base para a data, agregadas por totais, Marketplace, Categoria2, SKU e Anúncio, sem cortes de top ranking.',
    requestedDates: requestedDates.map((item) => item.iso),
    days,
    periodAggregates,
    comparison: calculateCopilotDailyComparisons(days.filter((day) => day.actual && day.actual.totals))
  };
}

function buildCopilotActualDailyIndex() {
  const sources = getPublishedAnalysisSources();
  return sources.map((source) => {
    const headers = source.rows[0].map((header) => String(header || ''));
    const dateIndex = findAnalysisHeader(headers, ['Data', 'Full Data', 'Record Date']);
    const scenarioIndex = findAnalysisHeader(headers, ['Datatype', 'Data Type', 'Tipo de dado', 'Tipo dados']);
    if (dateIndex < 0) {
      return null;
    }
    const dateBuckets = new Map();
    source.rows.slice(1).forEach((row) => {
      const scenario = scenarioIndex >= 0 ? row[scenarioIndex] : 'actual';
      if (!isActualAnalysisValue(scenario)) {
        return;
      }
      const parts = parseAnalysisDateParts(row[dateIndex], source.month, source.year);
      const iso = toAnalysisIsoDate(parts);
      if (!iso) {
        return;
      }
      const bucket = dateBuckets.get(iso) || [];
      bucket.push(row);
      dateBuckets.set(iso, bucket);
    });
    const days = Array.from(dateBuckets.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([iso, rows]) => {
      const aggregate = aggregatePublishedScenario([headers].concat(rows), source.month, source.year, 'actual');
      return {
        date: iso,
        rows: rows.length,
        totals: aggregate && aggregate.totals || null,
        marketplaces: aggregate ? aggregate.marketplaces : [],
        categories: aggregate ? aggregate.categories : []
      };
    });
    return {
      period: String(source.month).padStart(2, '0') + '/' + source.year,
      rowsName: source.rowsName,
      actualDays: days.map((day) => day.date),
      days
    };
  }).filter(Boolean);
}

function getCopilotConversationContext(messages) {
  const userMessages = (messages || []).filter((message) => message && message.role === 'user');
  const latest = userMessages[userMessages.length - 1] || {};
  const requestedDates = extractCopilotRequestedDates(messages).map((date) => date.iso);
  const latestText = normalizeAnalysisText(latest.text || '');
  let requestedBreakdown = '';
  if (/\bsku\b/.test(latestText)) requestedBreakdown = 'SKU';
  else if (/\banuncio\b|\banuncios\b|\bads?\b/.test(latestText)) requestedBreakdown = 'Anúncio';
  else if (/categoria|categoria2/.test(latestText)) requestedBreakdown = 'Categoria2';
  else if (/marketplace|canal/.test(latestText)) requestedBreakdown = 'Marketplace';
  return {
    latestUserText: String(latest.text || '').slice(0, 500),
    recentUserTexts: userMessages.slice(-4).map((message) => String(message.text || '').slice(0, 500)),
    carriedDates: requestedDates,
    requestedBreakdown,
    isFollowUp: userMessages.length > 1 && requestedBreakdown && !/\d{1,2}[/.\-]\d{1,2}/.test(String(latest.text || ''))
  };
}

function buildCopilotContext(messages) {
  const analytics = buildIntelligentAnalytics();
  const intelligentCache = readIntelligentAnalysisCache();

  if (!analytics) {
    return null;
  }

  const dailyData = buildCopilotDailyContext(messages);
  const conversationContext = getCopilotConversationContext(messages);

  return {
    generatedFrom: analytics.generatedFrom,
    businessData: compactIntelligentAnalytics(analytics, { includeFullBase: true, dailyMode: Boolean(dailyData), actualOnly: true }),
    latestAiAnalysis: null,
    targetedData: dailyData ? null : buildCopilotTargetedContext(messages, { actualOnly: true }),
    dailyData,
    conversationContext,
    actualDailyIndex: buildCopilotActualDailyIndex()
  };
}

function buildCopilotInput(messages) {
  return messages.map((message) => {
    if (message.image) {
      return {
        role: message.role,
        content: [
          { type: 'input_text', text: message.text || 'Analise esta imagem de anúncio considerando o contexto financeiro da empresa.' },
          { type: 'input_image', image_url: message.image }
        ]
      };
    }

    return {
      role: message.role,
      content: message.text
    };
  });
}

async function handleCopilotChat(request, response) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
  const clientIp = request.socket.remoteAddress || 'unknown';
  const lastRun = copilotLastRunByIp.get(clientIp) || 0;

  if (!apiKey) {
    sendJson(response, 500, { error: 'OPENAI_API_KEY não configurada no servidor.' });
    request.resume();
    return;
  }

  if (Date.now() - lastRun < 1200) {
    sendJson(response, 429, { error: 'Aguarde um instante antes de enviar outra pergunta.' });
    request.resume();
    return;
  }

  copilotLastRunByIp.set(clientIp, Date.now());

  try {
    const payload = await collectJsonRequest(request, maxCopilotRequestBytes);
    const messages = sanitizeCopilotMessages(payload.messages);
    const context = buildCopilotContext(messages);
    const pageContext = payload.pageContext && typeof payload.pageContext === 'object'
      ? {
        page: String(payload.pageContext.page || '').slice(0, 80),
        month: String(payload.pageContext.month || '').slice(0, 30),
        periodStart: String(payload.pageContext.periodStart || '').slice(0, 20),
        periodEnd: String(payload.pageContext.periodEnd || '').slice(0, 20),
        filters: payload.pageContext.filters && typeof payload.pageContext.filters === 'object'
          ? payload.pageContext.filters
          : {}
      }
      : {};

    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      sendJson(response, 400, { error: 'Envie uma pergunta para o Copiloto FP&A.' });
      return;
    }

    if (!context) {
      sendJson(response, 400, { error: 'Nenhuma base processada está disponível para análise.' });
      return;
    }

    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        instructions: [
          'Você é o Copiloto FP&A da empresa, um assistente especializado em controladoria, finanças, e-commerce, marketplaces, publicidade, precificação e crescimento.',
          'Responda sempre em português do Brasil, com linguagem profissional, clara, direta e fácil de compreender.',
          'Use exclusivamente os dados Actual/realizados fornecidos no contexto. O campo businessData.completeBase contém apenas a base Actual agregada disponível; consulte esse campo antes de concluir que não há informação. Nunca invente números, causas, metas, estoque, conversão ou informações indisponíveis.',
          'Considere que o mês atual é parcial e segue a regra D-1. Não trate o mês como encerrado.',
          'Todas as análises do Copiloto devem usar exclusivamente dados Actual/realizados. Não use Forecast, metas, orçamento, projeção ou MTD Forecast estimado para responder análises, exceto se o usuário pedir explicitamente Forecast.',
          'O contexto actualDailyIndex contém todos os dias carregados em Actual. Use esse índice para saber quais datas existem, analisar tendências diárias e evitar dizer que não há dados quando a data está listada ali.',
          'Quando a pergunta for sobre queda, crescimento ou eficiência, apresente números e comparações que sustentem a conclusão.',
          'Não traga recomendações de ação na primeira resposta. Só apresente recomendações se o usuário pedir explicitamente ou escolher essa opção no aprofundamento.',
          'Para produtos, categorias, marketplaces ou anúncios, cite os nomes, SKUs e IDs presentes nos dados.',
          'Para publicidade, use os campos reais: Publicidade como investimento, ADS F como faturamento atribuído, ACOS como Publicidade dividido por ADS F e TACOS como Publicidade dividido por Faturamento Bruto.',
          'Considere também o investimento em Afiliados separado da Publicidade.',
          'Não use ROAS nem MOAS nas conclusões, pois esses indicadores foram removidos desta análise. Nunca escreva a palavra ROAS; para publicidade use apenas ACOS, TACOS, investimento e faturamento ADS F.',
          'Não invente percentuais de aumento de verba, limites de pausa ou metas. Só proponha números quando puder calculá-los com os dados fornecidos; caso contrário, recomende um teste controlado sem fixar percentual.',
          'Quando targetedData estiver preenchido, ele é o recorte prioritário e exato da base para o SKU, anúncio, conta, canal ou categoria citado pelo usuário.',
          'Cruze o recorte específico com histórico realizado, Curva ABC, urgências e demais agregados Actual antes de concluir.',
          'Para imagens de anúncios, avalie qualidade visual, clareza, hierarquia, diferenciais, potencial de conversão e melhorias; não afirme atributos que não estejam visíveis.',
          'Antes de dizer que não possui dados, verifique businessData.completeBase, businessData.decisionViews, businessData.urgencies, monthlyEvolution, targetedData e dailyData. Só informe falta de dados quando o recorte Actual realmente não contiver a dimensão ou métrica pedida; nesse caso diga exatamente o que falta.',
          'Quando dailyData estiver preenchido, a pergunta envolve dias específicos. Use dailyData como recorte prioritário de Actual dia contra dia, preservando todos os agregados realizados daquele dia.',
          'Use conversationContext para continuar a análise da sessão. Se a última mensagem for apenas um aprofundamento como Por SKU, Por Anúncio, Por Categoria2 ou Por Marketplace, mantenha as datas e o assunto das mensagens anteriores.',
          'Se não houver Actual para uma data solicitada, não substitua por Forecast. Diga: não há Actual carregado para essa data, e informe quais datas com Actual estão disponíveis no recorte.',
          'Se o usuário pedir aprofundamento curto, como Por SKU, Por Anúncio ou Por Categoria, mantenha o período da conversa anterior e use o recorte diário já reconstruído. Não diga que faltam dados se dailyData.periodAggregates trouxer skus, ads ou categories.',
          'Quando dailyData.periodAggregates[].actual.skus existir, há breakdown por SKU no período. Use esses SKUs para listar maiores reduções de GM ou margens negativas.',
          'Se o usuário informar um intervalo explícito de datas, assuma exatamente esse intervalo e responda direto. Não pergunte se é MTD Forecast, mês completo ou outro recorte. Só faça pergunta se não houver nenhuma data ou dimensão suficiente para calcular.',
          'Para perguntas de soma, total, margem negativa, faturamento, GM, publicidade ou quantidade em datas explícitas, calcule somente com Actual em dailyData.periodAggregates quando existir e apresente o valor primeiro.',
          'Se a pergunta pedir soma da margem negativa, use dailyData.periodAggregates[].negativeMarginSummary. Responda direto a soma de GM negativa por SKU como padrão; não pergunte se o usuário quer soma ou lista. Depois ofereça aprofundamento por SKU, Categoria2 ou Anúncio.',
          'Não cite nomes técnicos internos como dailyData, periodAggregates, completeBase, targetedData ou JSON. Diga apenas que o cálculo veio do recorte diário da base.',
          'Formato obrigatório: resposta curta, objetiva e sem repetição. Comece com o número principal em uma frase.',
          'Depois mostre apenas a composição mais relevante em bullets. Cada bullet deve ficar em uma nova linha começando com hífen. Não escreva a palavra item; use, por exemplo: - GA953: R$ -78,58.',
          'Não repita o mesmo número, causa ou conclusão em mais de um bloco. Se uma informação já apareceu no número principal, não reexplique em outro parágrafo.',
          'Escolha no máximo 1 dimensão principal para detalhar por padrão: SKU para margem negativa, Marketplace para canal, Anúncio para publicidade, Categoria2 para mix. Só adicione outra dimensão se ela trouxer uma causa diferente.',
          'Limite listas a no máximo 8 itens. Se houver mais itens, diga Outros: R$ X,XX.',
          'Use no máximo 4 blocos: Resposta, Composição, Observação curta e Quer aprofundar?.',
          'No final, ofereça uma enquete curta com 2 ou 3 opções de aprofundamento, podendo incluir Recomendações como uma das opções. Não traga recomendações antes do usuário escolher.',
          'Evite respostas genéricas, jargões desnecessários, recomendações iniciais e parágrafos longos.',
          'A tela e o período que o usuário está visualizando são: ' + JSON.stringify(pageContext) + '. Use isso apenas como contexto de navegação; os números devem vir do contexto consolidado.',
          'Contexto consolidado da empresa: ' + JSON.stringify(context)
        ].join(' '),
        input: buildCopilotInput(messages),
        reasoning: { effort: 'low' },
        max_output_tokens: 1800
      })
    });
    const result = await openAiResponse.json().catch(() => ({}));

    if (!openAiResponse.ok) {
      const message = result.error && result.error.message
        ? result.error.message
        : 'Não foi possível consultar o Copiloto FP&A.';
      sendJson(response, openAiResponse.status, { error: message });
      return;
    }

    const answer = extractResponseText(result);
    if (!answer) {
      sendJson(response, 502, { error: 'O Copiloto não retornou uma resposta. Tente novamente.' });
      return;
    }

    sendJson(response, 200, {
      answer: cleanAiBusinessText(answer),
      model,
      generatedAt: new Date().toISOString(),
      signature: context.generatedFrom
    });
  } catch (error) {
    const statusCode = error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    const message = error.message === 'PAYLOAD_TOO_LARGE'
      ? 'A conversa ou imagem enviada excede o limite permitido.'
      : error.message === 'INVALID_JSON'
        ? 'A solicitação enviada é inválida.'
        : 'Erro ao consultar o Copiloto FP&A: ' + error.message;

    console.error('Erro no Copiloto FP&A:', error);
    sendJson(response, statusCode, { error: message });
  }
}

function parseIntelligentStructuredAnalysis(text) {
  try {
    const parsed = JSON.parse(text);
    const mapItems = (items, limit) => (Array.isArray(items) ? items : []).slice(0, limit).map((item) => ({
      title: cleanAiBusinessText(item && item.title),
      evidence: cleanAiBusinessText(item && item.evidence),
      diagnosis: cleanAiBusinessText(item && item.diagnosis),
      action: cleanAiBusinessText(item && item.action)
    }));

    return {
      executiveSummary: cleanAiBusinessText(parsed.executiveSummary),
      businessNarrative: cleanAiBusinessText(parsed.businessNarrative),
      financialDiagnosis: cleanAiBusinessText(parsed.financialDiagnosis),
      kpiAssessment: cleanAiBusinessText(parsed.kpiAssessment),
      trends: mapItems(parsed.trends, 4),
      alerts: mapItems(parsed.alerts, 4),
      recommendations: mapItems(parsed.recommendations, 5)
    };
  } catch (error) {
    return null;
  }
}

function cleanAiBusinessText(value) {
  return String(value || '')
    .replace(/\bforecastToDate\b/gi, 'Forecast proporcional ao MTD Forecast')
    .replace(/\bactualDataDay\s*=\s*(\d+)/gi, 'dados realizados até o dia $1')
    .replace(/\bmtdDay\s*=\s*(\d+)/gi, 'MTD Forecast D-$1')
    .replace(/\bdataLagDays\s*=\s*(\d+)/gi, 'defasagem de $1 dia(s)')
    .replace(/\bcurrentTotals\b/gi, 'resultado atual')
    .replace(/\bpreviousComparableTotals\b/gi, 'período anterior comparável')
    .replace(/\bgoals\b/gi, 'metas')
    .replace(/\bROAS\b/g, 'retorno de mídia')
    .replace(/dailyData\.periodAggregates\[\]\.negativeMarginSummary\.bySku/gi, 'recorte diário da base por SKU')
    .replace(/\bdailyData\b/g, 'recorte diário da base')
    .replace(/\bperiodAggregates\b/g, 'período consolidado')
    .replace(/\bcompleteBase\b/g, 'base consolidada')
    .replace(/\btargetedData\b/g, 'recorte específico')
    .replace(/\broas\b/g, 'retorno de mídia')
    .replace(/(^|\n)\s*[-•]\s*item\s+/gi, '$1- ')
    .replace(/\burgencies\b/gi, 'alertas')
    .replace(/\bPontos de atencao:/gi, 'Pontos de atenção:')
    .replace(/\bAcoes imediatas:/gi, 'Ações imediatas:')
    .replace(/\bstop-sale\b/gi, 'suspensão temporária da venda')
    .replace(/\blinearizado\b/gi, 'projetado pelo ritmo médio diário')
    .replace(/\bmargem bruta\b/gi, 'margem de contribuição')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function generateIntelligentAnalysis(force) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
  const currentSignature = getPublishedDataSignature();
  const cached = readIntelligentAnalysisCache();
  if (!force && cached && cached.signature === currentSignature && cached.analysis) {
    return Object.assign({ cached: true }, cached);
  }

  const analytics = buildIntelligentAnalytics();
  if (!analytics) {
    throw new Error('Nenhuma base processada disponivel para a Analise Inteligente.');
  }

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY nao configurada no servidor.');
  }

  const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      instructions: [
        'Voce e um CFO, Controller e especialista senior em e-commerce e marketplaces.',
        'Responda sempre em portugues do Brasil, com linguagem simples, executiva e objetiva.',
        'Use exclusivamente os numeros fornecidos. Nunca invente dados, causas, metas, conversao ou indicadores indisponiveis.',
        'Quando um KPI estiver indisponivel ou for apenas uma aproximacao, declare isso claramente.',
        'O mes atual e parcial e segue a regra D-1. Nunca escreva como se o mes ja tivesse terminado.',
        'O MTD Forecast e sempre o Forecast mensal dividido pelos dias do mes e multiplicado pelo D-1 do calendario, mesmo quando a ultima data realizada carregada for anterior.',
        'Diferencie claramente mtdDay, que calcula a meta proporcional, de actualDataDay, que informa ate quando existem dados realizados.',
        'Use periodContext para informar claramente a data de corte, os dias transcorridos e quantos dias faltam.',
        'Se dataLagDays for maior que zero, avise que a base esta atrasada em relacao ao D-1 esperado e nao atribua resultado aos dias ausentes.',
        'Para meses anteriores a 01/06/2026, o comparativo foi estimado por: total do mes anterior dividido pelos dias daquele mes, multiplicado pelos dias fechados do mes atual.',
        'A partir de 01/06/2026, compare o realizado com o MTD Forecast usando os dados diarios reais do mesmo numero de dias.',
        'Explique quando o comparativo for estimado e nao apresente a estimativa como dado realizado.',
        'Nao compare o realizado parcial diretamente com meses completos. Separe realizado ate D-1, ritmo atual e projecao de fechamento.',
        'A projecao de fechamento e uma estimativa linear baseada no ritmo medio diario; identifique-a como projecao, nunca como resultado realizado.',
        'Compare tambem o realizado com o Forecast da base, que representa as metas e o orcamento do periodo.',
        'Explique se o crescimento gera lucro ou apenas faturamento, se a margem melhora ou piora, se publicidade gera retorno e onde o negocio perde dinheiro.',
        'Considere faturamento bruto e liquido, quantidade, ticket medio, GM em reais e percentual, publicidade, investimento em afiliados, TACOS, ACOS, faturamento atribuido ADS F e participacao da receita dos anuncios.',
        'Identifique crescimento e queda por marketplace, categoria, SKU e anuncio, concentracao de receita, margem negativa, publicidade ineficiente e oportunidades de escala.',
        'Use explicitamente os blocos goals, abc e urgencies para avaliar atingimento das metas, concentracao da Curva ABC e riscos operacionais.',
        'O contexto consolida Base de dados, Marketplace Dashboard, Dashboard Macro, Metas, Curva ABC, Publicidade, Urgencias e Historico de Venda. Cruze os blocos e nao analise cada um isoladamente.',
        'Avalie todos os canais, categorias, SKUs e anuncios presentes no contexto, incluindo os melhores, os piores, os de maior investimento e os de margem negativa.',
        'Cada conclusao deve citar valores, percentuais, nomes de canais, categorias, SKUs ou anuncios presentes no contexto.',
        'As recomendacoes devem dizer o que fazer, por que fazer e a prioridade.',
        'A propriedade businessNarrative deve responder de forma clara: o que aconteceu, o que melhorou, o que piorou, o que exige atencao, acoes imediatas e oportunidades de lucro.',
        'Organize cada texto em paragrafos curtos, com uma ideia principal por paragrafo, pontuacao correta e transicoes claras.',
        'Separe os paragrafos com uma linha em branco.',
        'No resumo executivo, siga esta ordem: situacao atual, desempenho financeiro, rentabilidade, publicidade, riscos e recomendacao principal.',
        'Em businessNarrative, use exatamente estes subtitulos: O que aconteceu:, O que melhorou:, O que piorou:, Pontos de atencao:, Acoes imediatas: e Oportunidades:.',
        'Nunca exponha nomes internos dos campos ou variaveis, como mtdDay, actualDataDay, dataLagDays, forecastToDate, currentTotals, goals ou urgencies.',
        'Converta nomes tecnicos para linguagem natural. Exemplo: em vez de actualDataDay=17, escreva dados realizados ate o dia 17.',
        'Nao inicie o texto com expressoes redundantes como Resumo Executivo ou O que aconteceu, pois o titulo da secao ja informa o assunto.',
        'Evite jargoes desnecessarios. Quando usar termos como TACOS ou ACOS, explique brevemente o significado no contexto.',
        'Use linguagem profissional, direta e facil de compreender por gestores financeiros, comerciais e operacionais.',
        'Seja direto: executiveSummary deve ter de 180 a 280 palavras; financialDiagnosis, kpiAssessment e businessNarrative de 120 a 220 palavras cada.',
        'Entregue tendencias, alertas e recomendacoes diferentes entre si e fundamentados em evidencias numericas.'
      ].join(' '),
      reasoning: { effort: 'low' },
      text: {
        format: {
          type: 'json_schema',
          name: 'intelligent_business_analysis',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              executiveSummary: { type: 'string' },
              businessNarrative: { type: 'string' },
              financialDiagnosis: { type: 'string' },
              kpiAssessment: { type: 'string' },
              trends: {
                type: 'array',
                minItems: 4,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    evidence: { type: 'string' },
                    diagnosis: { type: 'string' },
                    action: { type: 'string' }
                  },
                  required: ['title', 'evidence', 'diagnosis', 'action'],
                  additionalProperties: false
                }
              },
              alerts: {
                type: 'array',
                minItems: 4,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    evidence: { type: 'string' },
                    diagnosis: { type: 'string' },
                    action: { type: 'string' }
                  },
                  required: ['title', 'evidence', 'diagnosis', 'action'],
                  additionalProperties: false
                }
              },
              recommendations: {
                type: 'array',
                minItems: 5,
                maxItems: 5,
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    evidence: { type: 'string' },
                    diagnosis: { type: 'string' },
                    action: { type: 'string' }
                  },
                  required: ['title', 'evidence', 'diagnosis', 'action'],
                  additionalProperties: false
                }
              }
            },
            required: [
              'executiveSummary', 'businessNarrative', 'financialDiagnosis',
              'kpiAssessment', 'trends', 'alerts', 'recommendations'
            ],
            additionalProperties: false
          }
        }
      },
      input: 'Dados consolidados do negocio:\n' + JSON.stringify(compactIntelligentAnalytics(analytics)),
      max_output_tokens: 4000
    })
  });
  const result = await openAiResponse.json().catch(() => ({}));

  if (!openAiResponse.ok) {
    const message = result.error && result.error.message
      ? result.error.message
      : 'Nao foi possivel gerar a Analise Inteligente.';
    throw new Error(message);
  }

  const responseText = extractResponseText(result);
  const analysis = parseIntelligentStructuredAnalysis(responseText);
  if (!analysis
      || analysis.executiveSummary.length < 300
      || analysis.businessNarrative.length < 200
      || analysis.financialDiagnosis.length < 200
      || analysis.kpiAssessment.length < 200
      || analysis.trends.length < 4
      || analysis.alerts.length < 4
      || analysis.recommendations.length < 5) {
    throw new Error('A analise retornada ficou incompleta. Ela sera gerada novamente.');
  }

  const generated = {
    signature: analytics.generatedFrom,
    model,
    generatedAt: new Date().toISOString(),
    analysis,
    analytics
  };
  writeIntelligentAnalysisCache(generated);
  return Object.assign({ cached: false }, generated);
}

function ensureIntelligentAnalysis(force) {
  if (intelligentAnalysisPromise) {
    return intelligentAnalysisPromise;
  }

  intelligentAnalysisPromise = generateIntelligentAnalysis(force)
    .finally(() => {
      intelligentAnalysisPromise = null;
    });
  return intelligentAnalysisPromise;
}

async function handleIntelligentAnalysis(request, response) {
  const cached = readIntelligentAnalysisCache();
  const currentSignature = getPublishedDataSignature();

  if (cached && cached.analysis) {
    const stale = cached.signature !== currentSignature;
    const refreshedAnalytics = buildIntelligentAnalytics();
    sendJson(response, 200, Object.assign({ cached: true, stale }, cached, {
      analytics: refreshedAnalytics || cached.analytics
    }));
    if (stale) {
      setImmediate(() => {
        ensureIntelligentAnalysis(true).catch((error) => {
          console.error('Nao foi possivel atualizar a Analise Inteligente em segundo plano:', error.message);
        });
      });
    }
    return;
  }

  try {
    const result = await ensureIntelligentAnalysis(false);
    sendJson(response, 200, result);
  } catch (error) {
    console.error('Erro na Analise Inteligente:', error);
    sendJson(response, 500, { error: error.message || 'Erro ao gerar Analise Inteligente.' });
  }
}

function normalizeBomText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeBomSku(value) {
  return normalizeBomText(value).toUpperCase();
}

function readCompositions() {
  try {
    const sourcePath = fs.existsSync(compositionsPath)
      ? compositionsPath
      : path.join(legacyDataDir, 'compositions.json');
    const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : []);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Erro ao ler composicoes:', error.message);
    return [];
  }
}

function writeCompositions(items, source) {
  writeJsonWithRetry(compositionsPath, {
    version: 1,
    source: source || 'CRUD do dashboard',
    updatedAt: new Date().toISOString(),
    items
  });
}

function validateCompositionInput(input, existing) {
  const skuProduct = normalizeBomSku(input && input.skuProduct);
  const skuComponent = normalizeBomSku(input && input.skuComponent);
  const quantity = Number(input && input.quantity);
  if (!skuProduct || !skuComponent) throw new Error('SKU do produto e SKU do componente sao obrigatorios.');
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('A quantidade do componente deve ser maior que zero.');
  const now = new Date().toISOString();
  return {
    id: existing && existing.id || crypto.randomUUID(),
    skuProduct,
    productName: normalizeBomText(input.productName || existing && existing.productName),
    skuComponent,
    quantity,
    createdAt: existing && existing.createdAt || now,
    updatedAt: now
  };
}

function requireAdmin(request, response) {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) { sendJson(response, 500, { error: 'ADMIN_PASSWORD nao configurada.' }); return false; }
  if (!safePasswordEquals(request.headers['x-admin-password'] || '', configured)) {
    sendJson(response, 401, { error: 'Senha invalida.' }); return false;
  }
  return true;
}

async function handleCompositionCreate(request, response) {
  if (!requireAdmin(request, response)) return;
  try {
    const input = await collectJsonRequest(request, maxAiRequestBytes);
    const items = readCompositions();
    const item = validateCompositionInput(input);
    items.push(item);
    writeCompositions(items);
    sendJson(response, 201, item);
  } catch (error) { sendJson(response, 400, { error: error.message }); }
}

async function handleCompositionUpdate(request, response, id) {
  if (!requireAdmin(request, response)) return;
  try {
    const input = await collectJsonRequest(request, maxAiRequestBytes);
    const items = readCompositions();
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) { sendJson(response, 404, { error: 'Composicao nao encontrada.' }); return; }
    items[index] = validateCompositionInput(input, items[index]);
    writeCompositions(items);
    sendJson(response, 200, items[index]);
  } catch (error) { sendJson(response, 400, { error: error.message }); }
}

function handleCompositionDelete(request, response, id) {
  if (!requireAdmin(request, response)) return;
  const items = readCompositions();
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) { sendJson(response, 404, { error: 'Composicao nao encontrada.' }); return; }
  writeCompositions(next);
  sendJson(response, 200, { deleted: true });
}

async function handleCompositionImport(request, response) {
  if (!requireAdmin(request, response)) return;
  try {
    const payload = await collectJsonRequest(request, maxCopilotRequestBytes);
    const incoming = Array.isArray(payload.items) ? payload.items : [];
    if (!incoming.length) throw new Error('Nenhuma linha valida encontrada para importar.');
    const items = readCompositions();
    let created = 0; let updated = 0;
    incoming.forEach((raw) => {
      const skuProduct = normalizeBomSku(raw.skuProduct);
      const skuComponent = normalizeBomSku(raw.skuComponent);
      const index = items.findIndex((item) => item.skuProduct === skuProduct && item.skuComponent === skuComponent);
      if (index >= 0) { items[index] = validateCompositionInput(raw, items[index]); updated += 1; }
      else { items.push(validateCompositionInput(raw)); created += 1; }
    });
    writeCompositions(items, normalizeBomText(payload.fileName) || 'Importacao em massa');
    sendJson(response, 200, { created, updated, total: items.length });
  } catch (error) { sendJson(response, 400, { error: error.message }); }
}

function getBomHeaderIndex(headers, names) {
  const normalized = headers.map((value) => normalizeAnalysisText(value));
  for (const name of names) {
    const index = normalized.indexOf(normalizeAnalysisText(name));
    if (index >= 0) return index;
  }
  return -1;
}

function getBomIsoDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000));
    return date.toISOString().slice(0, 10);
  }
  const textValue = normalizeBomText(value);
  const match = textValue.match(/^(\d{1,4})[\/-](\d{1,2})[\/-](\d{1,4})/);
  if (!match) return '';
  let year; let month; let day;
  if (match[1].length === 4) { year = Number(match[1]); month = Number(match[2]); day = Number(match[3]); }
  else { month = Number(match[1]); day = Number(match[2]); year = Number(match[3]); }
  if (year < 100) year += 2000;
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function buildComponentExplosion(startDate, endDate) {
  const metadata = readMetadata();
  const sales = new Map();
  const originGroups = new Map();
  Object.values(metadata.areas.area1 && metadata.areas.area1.months || {}).forEach((monthMetadata) => {
    if (!monthMetadata || !monthMetadata.rowsName) return;
    const rows = readPublishedRows(monthMetadata);
    if (!rows || rows.length < 2) return;
    const headers = rows[0];
    const skuIndex = getBomHeaderIndex(headers, ['SKU']);
    const nameIndex = getBomHeaderIndex(headers, ['Descricao', 'Descrição', 'Produto']);
    const categoryIndex = getBomHeaderIndex(headers, ['Categoria2', 'Categoria']);
    const marketplaceIndex = getBomHeaderIndex(headers, ['Marketplace']);
    const marketplaceSaleIndex = getBomHeaderIndex(headers, ['Marketplace venda']);
    const accountIndex = getBomHeaderIndex(headers, ['Categoria']);
    const scenarioIndex = getBomHeaderIndex(headers, ['Datatype']);
    const dateIndex = getBomHeaderIndex(headers, ['Full Data', 'Data', 'Record Date']);
    const valueIndex = getBomHeaderIndex(headers, ['Valor completo', 'Valor']);
    rows.slice(1).forEach((row) => {
      if (skuIndex < 0 || valueIndex < 0 || dateIndex < 0) return;
      if (scenarioIndex >= 0 && !isActualAnalysisValue(row[scenarioIndex])) return;
      const isoDate = getBomIsoDate(row[dateIndex]);
      if (!isoDate || isoDate < startDate || isoDate > endDate) return;
      const sku = normalizeBomSku(row[skuIndex]);
      const amount = parseAnalysisNumber(row[valueIndex]);
      if (!sku || !Number.isFinite(amount)) return;
      const category = normalizeBomText(row[categoryIndex]) || 'Sem categoria';
      const marketplace = normalizeBomText(row[marketplaceIndex]) || '(vazio)';
      const marketplaceSale = normalizeBomText(row[marketplaceSaleIndex]) || '(vazio)';
      const productName = normalizeBomText(row[nameIndex]);
      const originId = [marketplace, marketplaceSale, sku].join('||');
      const origin = originGroups.get(originId) || { originId, sku, productName: '', category, marketplace, marketplaceSale, quantitySold: 0, revenue: 0, tax: 0, marketplaceExpenses: 0, costs: 0 };
      origin.productName = productName || origin.productName;
      if (category !== 'Sem categoria') origin.category = category;
      const normalizedAccount = accountIndex >= 0 ? normalizeAnalysisText(row[accountIndex]) : '';
      const accountNumberMatch = String(accountIndex >= 0 ? row[accountIndex] || '' : '').trim().match(/^(\d{1,2})\s*\./);
      const accountNumber = accountNumberMatch ? Number(accountNumberMatch[1]) : 0;
      if (normalizedAccount === '14.quantidade') origin.quantitySold += amount;
      else if (normalizedAccount === '13.faturamento bruto') origin.revenue += amount;
      else if (normalizedAccount === '02.imposto') origin.tax += amount;
      else if (normalizedAccount === '03.despesas marketplace') origin.marketplaceExpenses += amount;
      else if (accountNumber >= 4 && accountNumber <= 13) origin.costs += amount;
      originGroups.set(originId, origin);
    });
  });

  Array.from(originGroups.values()).forEach((origin) => {
    if (!origin.quantitySold) { originGroups.delete(origin.originId); return; }
    origin.netRevenue = origin.revenue + origin.tax;
    origin.gm = origin.netRevenue + origin.marketplaceExpenses + origin.costs;
    origin.gmPercent = origin.netRevenue ? origin.gm / origin.netRevenue : 0;
    const current = sales.get(origin.sku) || { sku: origin.sku, productName: '', category: origin.category, quantitySold: 0, revenue: 0, gm: 0 };
    current.quantitySold += origin.quantitySold;
    current.revenue += origin.revenue;
    current.gm += origin.gm;
    current.productName = origin.productName || current.productName;
    current.category = origin.category || current.category;
    sales.set(origin.sku, current);
  });

  const compositions = readCompositions();
  const byProduct = new Map();
  compositions.forEach((item) => {
    const list = byProduct.get(item.skuProduct) || [];
    list.push(item); byProduct.set(item.skuProduct, list);
  });
  const componentNames = new Map();
  sales.forEach((sale) => componentNames.set(sale.sku, sale.productName));
  compositions.forEach((item) => { if (item.productName && !componentNames.has(item.skuProduct)) componentNames.set(item.skuProduct, item.productName); });
  const summaryMap = new Map(); const missing = []; const invalid = []; const detailRows = [];
  sales.forEach((sale) => { if (!byProduct.get(sale.sku) || !byProduct.get(sale.sku).length) missing.push(sale); });
  originGroups.forEach((sale) => {
    const lines = byProduct.get(sale.sku) || [];
    if (!lines.length) return;
    lines.forEach((line) => {
      if (!(Number(line.quantity) > 0)) { invalid.push(line); return; }
      const consumed = sale.quantitySold * Number(line.quantity);
      const summary = summaryMap.get(line.skuComponent) || { skuComponent: line.skuComponent, description: componentNames.get(line.skuComponent) || '', totalQuantity: 0, origins: [] };
      summary.totalQuantity += consumed;
      summary.origins.push({ skuProduct: sale.sku, productName: sale.productName, category: sale.category, quantitySold: sale.quantitySold, quantityPerUnit: line.quantity, consumed });
      summaryMap.set(line.skuComponent, summary);
      detailRows.push({
        originId: sale.originId,
        category: sale.category,
        marketplace: sale.marketplace,
        marketplaceSale: sale.marketplaceSale,
        sku: sale.sku,
        productName: sale.productName,
        unitsSold: sale.quantitySold,
        revenue: sale.revenue,
        netRevenue: sale.netRevenue,
        gm: sale.gm,
        gmPercent: sale.gmPercent,
        skuComponent: line.skuComponent,
        componentDescription: componentNames.get(line.skuComponent) || '',
        quantityPerUnit: Number(line.quantity),
        componentQuantity: consumed
      });
    });
  });
  return {
    startDate, endDate,
    totals: { productsSold: sales.size, unitsSold: Array.from(sales.values()).reduce((sum, item) => sum + item.quantitySold, 0), components: summaryMap.size, missing: missing.length },
    summary: Array.from(summaryMap.values()).sort((a, b) => b.totalQuantity - a.totalQuantity),
    detailRows: detailRows.sort((a, b) => b.revenue - a.revenue || a.category.localeCompare(b.category, 'pt-BR') || a.sku.localeCompare(b.sku)),
    missing: missing.sort((a, b) => b.quantitySold - a.quantitySold), invalid
  };
}

async function handleComponentExplosion(request, response) {
  try {
    const payload = await collectJsonRequest(request, maxAiRequestBytes);
    const startDate = normalizeBomText(payload.startDate);
    const endDate = normalizeBomText(payload.endDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
      sendJson(response, 400, { error: 'Periodo invalido.' }); return;
    }
    sendJson(response, 200, buildComponentExplosion(startDate, endDate));
  } catch (error) { console.error('Erro na explosao de componentes:', error); sendJson(response, 500, { error: 'Erro ao calcular componentes.' }); }
}

const server = http.createServer((request, response) => {
  let requestPath;

  try {
    requestPath = new URL(request.url, 'http://localhost').pathname;
  } catch (error) {
    sendText(response, 400, 'Requisicao invalida.');
    return;
  }

  if (request.method === 'GET' && requestPath === '/api/latest-base') {
    const month = getMonthFromUrl(request.url);
    sendJson(response, 200, month ? getPublishedMetadata(month) : getAllPublishedMetadata());
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/upload-base') {
    handleBaseUpload(request, response);
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/upload-rows') {
    handleRowsUpload(request, response);
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/analyze-urgencies') {
    handleAiUrgencyAnalysis(request, response);
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/analyze-variation') {
    handleVariationAnalysis(request, response);
    return;
  }

  if (request.method === 'GET' && requestPath === '/api/intelligent-analysis') {
    handleIntelligentAnalysis(request, response);
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/copilot-chat') {
    handleCopilotChat(request, response);
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/component-explosion') {
    handleComponentExplosion(request, response);
    return;
  }

  if (request.method === 'GET' && requestPath === '/api/compositions') {
    sendJson(response, 200, { items: readCompositions() });
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/compositions') {
    handleCompositionCreate(request, response);
    return;
  }

  if (request.method === 'POST' && requestPath === '/api/compositions/import') {
    handleCompositionImport(request, response);
    return;
  }

  const compositionMatch = requestPath.match(/^\/api\/compositions\/([^/]+)$/);
  if (compositionMatch && request.method === 'PUT') {
    handleCompositionUpdate(request, response, decodeURIComponent(compositionMatch[1]));
    return;
  }
  if (compositionMatch && request.method === 'DELETE') {
    handleCompositionDelete(request, response, decodeURIComponent(compositionMatch[1]));
    return;
  }

  const filePath = resolvePublicFile(request.url);

  if (!filePath) {
    sendText(response, 404, 'Arquivo nao encontrado.');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const cacheControl = filePath === path.join(projectDir, 'index.html')
    ? 'no-store'
    : 'public, max-age=31536000, immutable';
  sendFile(response, filePath, mimeTypes[extension] || 'application/octet-stream', cacheControl);
});

server.requestTimeout = 60 * 60 * 1000;
server.headersTimeout = 65 * 1000;
server.keepAliveTimeout = 65 * 1000;

server.listen(port, '0.0.0.0', () => {
  console.log(`Dashboard rodando na porta ${port}`);
});

