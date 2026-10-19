'use strict';

/**
 * Client HTTP viết tay trên `http`/`https` của Node.
 *
 * Mục tiêu của bài lab là nhìn thấy giao thức, nên ở đây:
 *  - tự dựng header, tự theo redirect;
 *  - tự giải nén gzip / deflate / br (không bật decompress tự động);
 *  - tự giới hạn kích thước và thời gian;
 *  - ghi lại nhật ký từng bước để hiển thị ở tab "Nhật ký".
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { URL } = require('node:url');
const { TextDecoder } = require('node:util');

const CONNECT_TIMEOUT_MS = 15000;
const READ_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'VKU-HTTP-Browser/2.0 (Node.js)';

/** Thêm scheme nếu người dùng gõ thiếu, ví dụ "vku.udn.vn". */
function normalizeUrl(input) {
  let text = String(input == null ? '' : input).trim();
  if (!text) {
    throw new Error('URL rỗng');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = 'http://' + text;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`URL không hợp lệ: ${text}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Chỉ hỗ trợ http:// và https:// (nhận được ${url.protocol})`);
  }
  return url;
}

/**
 * Chuẩn hoá dữ liệu form sang application/x-www-form-urlencoded.
 * Giữ nguyên các chuỗi %XX đã encode để không bị encode hai lần.
 */
function encodeForm(data) {
  const text = data == null ? '' : String(data);
  if (!text) {
    return '';
  }
  return text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) {
        return encodeComponent(pair);
      }
      return `${encodeComponent(pair.slice(0, eq))}=${encodeComponent(pair.slice(eq + 1))}`;
    })
    .join('&');
}

function encodeComponent(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '%' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      out += text.slice(i, i + 3);
      i += 2;
      continue;
    }
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
      continue;
    }
    if (ch === ' ') {
      out += '+';
      continue;
    }
    const bytes = Buffer.from(ch, 'utf8');
    for (const byte of bytes) {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/** Biến lỗi mạng khó đọc thành câu tiếng Việt kèm gợi ý. */
function friendlyError(error) {
  const code = error && error.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Không phân giải được tên miền "${error.hostname || ''}". Kiểm tra chính tả tên miền và DNS.`;
    case 'ECONNREFUSED':
      return 'Không kết nối được tới server (connection refused). Server chưa chạy? Sai port? Tường lửa chặn?';
    case 'ECONNRESET':
      return 'Server đóng kết nối đột ngột (connection reset).';
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return 'Hết thời gian chờ phản hồi từ server.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Không có đường tới host — kiểm tra mạng hoặc tường lửa.';
    case 'CERT_HAS_EXPIRED':
      return 'Chứng chỉ TLS của server đã hết hạn.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'Chứng chỉ TLS tự ký — không tin cậy được.';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'Không xác thực được chứng chỉ TLS của server.';
    default:
      break;
  }
  if (error && error.message === 'TIMEOUT') {
    return `Hết thời gian chờ phản hồi (${READ_TIMEOUT_MS / 1000} giây).`;
  }
  return (error && error.message) || 'Lỗi mạng không xác định';
}

/** Chọn module theo protocol. */
function transportFor(protocol) {
  return protocol === 'https:' ? https : http;
}

/** Dựng các header mặc định rồi cho phép người dùng ghi đè. */
function buildHeaders(url, method, bodyBuffer, userHeaders) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'close',
  };
  if (bodyBuffer.length > 0 || method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    headers['Content-Length'] = String(bodyBuffer.length);
  }
  for (const [name, value] of Object.entries(userHeaders || {})) {
    if (!name) {
      continue;
    }
    const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    if (existing) {
      delete headers[existing];
    }
    headers[name] = String(value);
  }
  return headers;
}

/** Gửi đúng một request, không theo redirect. */
function requestOnce(url, method, bodyBuffer, userHeaders, log) {
  return new Promise((resolve, reject) => {
    const transport = transportFor(url.protocol);
    const headers = buildHeaders(url, method, bodyBuffer, userHeaders);
    const requestLine = `${method} ${url.pathname}${url.search} HTTP/1.1`;

    log.push(`→ ${requestLine}`);
    log.push(`→ Host: ${url.host}`);
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'host') {
        continue;
      }
      log.push(`→ ${name}: ${value}`);
    }
    if (bodyBuffer.length > 0) {
      log.push(`→ Body (${bodyBuffer.length} byte): ${bodyBuffer.toString('utf8')}`);
    }

    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      timeout: CONNECT_TIMEOUT_MS,
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      let total = 0;
      let tooLarge = false;

      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          tooLarge = true;
          req.destroy(new Error(`Tài nguyên vượt giới hạn ${MAX_BODY_BYTES} byte`));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (tooLarge) {
          return;
        }
        const rawBody = Buffer.concat(chunks);
        const headerPairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          headerPairs.push({ name: res.rawHeaders[i], value: res.rawHeaders[i + 1] });
        }
        log.push(`← ${res.statusCode} ${res.statusMessage || ''} (${rawBody.length} byte body)`);
        resolve({
          statusCode: res.statusCode,
          statusMessage: res.statusMessage || '',
          httpVersion: res.httpVersion,
          headers: headerPairs,
          rawBody,
        });
      });

      res.on('error', (error) => reject(new Error(friendlyError(error))));
    });

    req.setTimeout(READ_TIMEOUT_MS, () => {
      req.destroy(new Error('TIMEOUT'));
    });

    req.on('error', (error) => reject(new Error(friendlyError(error))));

    if (bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

/** Tra một header (không phân biệt hoa/thường) trong mảng cặp name/value. */
function headerValue(pairs, name) {
  const found = pairs.find((pair) => pair.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : null;
}

/** Giải nén theo Content-Encoding. */
function decodeContent(rawBody, contentEncoding, log) {
  if (!rawBody.length || !contentEncoding) {
    return rawBody;
  }
  const encoding = contentEncoding.toLowerCase().trim();
  try {
    if (encoding.includes('gzip')) {
      log.push(`… Giải nén gzip (${rawBody.length} byte)`);
      return zlib.gunzipSync(rawBody);
    }
    if (encoding.includes('deflate')) {
      log.push(`… Giải nén deflate (${rawBody.length} byte)`);
      try {
        return zlib.inflateSync(rawBody);
      } catch {
        return zlib.inflateRawSync(rawBody);
      }
    }
    if (encoding.includes('br')) {
      log.push(`… Giải nén brotli (${rawBody.length} byte)`);
      return zlib.brotliDecompressSync(rawBody);
    }
  } catch (error) {
    throw new Error(`Không giải nén được Content-Encoding=${contentEncoding}: ${error.message}`);
  }
  return rawBody;
}

function isTextualContentType(contentType) {
  if (!contentType) {
    return false;
  }
  const lower = contentType.toLowerCase();
  return (
    lower.startsWith('text/') ||
    lower.includes('json') ||
    lower.includes('xml') ||
    lower.includes('html') ||
    lower.includes('javascript') ||
    lower.includes('css')
  );
}

/** Dò charset: header Content-Type → <meta charset> → utf-8. */
function detectCharset(body, contentType) {
  const fromHeader = /charset\s*=\s*"?([^\s;"]+)/i.exec(contentType || '');
  if (fromHeader) {
    return fromHeader[1];
  }
  const head = body.subarray(0, 4096).toString('latin1');
  const fromMeta =
    /charset\s*=\s*["']?([\w-]+)/i.exec(head) ||
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : 'utf-8';
}

function decodeText(body, charset) {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
}

/**
 * Thực hiện yêu cầu đầy đủ, tự theo redirect.
 *
 * @returns {Promise<{finalUrl, statusCode, statusMessage, httpVersion, headers,
 *                    body, bodyText, byteLength, contentType, charset, isHtml, isTextual, log}>}
 */
async function fetchResource({ url, method = 'GET', data = '', headers = {} } = {}) {
  const upperMethod = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'HEAD'].includes(upperMethod)) {
    throw new Error(`Method không hỗ trợ: ${upperMethod} (chỉ có GET, POST, HEAD)`);
  }

  let currentUrl = normalizeUrl(url);
  let currentMethod = upperMethod;
  let bodyText = upperMethod === 'POST' ? encodeForm(data) : '';
  let bodyBuffer = Buffer.from(bodyText, 'utf8');
  const log = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestOnce(currentUrl, currentMethod, bodyBuffer, headers, log);

    const location = headerValue(response.headers, 'Location');
    const isRedirect = [301, 302, 303, 307, 308].includes(response.statusCode);

    if (!isRedirect || !location) {
      return finalize(response, currentUrl, currentMethod, log);
    }

    const nextUrl = new URL(location.trim(), currentUrl);
    if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
      throw new Error(`Redirect tới protocol không hỗ trợ: ${nextUrl.protocol}`);
    }
    log.push(`↪ Redirect ${response.statusCode} → ${nextUrl.href}`);

    // 303 luôn chuyển sang GET; 301/302 với POST trên thực tế cũng vậy.
    if (response.statusCode === 303 ||
        ((response.statusCode === 301 || response.statusCode === 302) && currentMethod === 'POST')) {
      currentMethod = 'GET';
      bodyText = '';
      bodyBuffer = Buffer.alloc(0);
    }
    currentUrl = nextUrl;
  }

  throw new Error(`Quá ${MAX_REDIRECTS} lần redirect liên tiếp — có thể bị vòng lặp`);
}

function finalize(response, url, method, log) {
  const contentType = headerValue(response.headers, 'Content-Type');
  const contentEncoding = headerValue(response.headers, 'Content-Encoding');
  const body = decodeContent(response.rawBody, contentEncoding, log);
  const charset = detectCharset(body, contentType);
  const textual = isTextualContentType(contentType) ||
    (contentType == null && body.subarray(0, 5).toString('latin1').toLowerCase().includes('<'));
  const text = textual ? decodeText(body, charset) : '';
  const isHtml = /html/i.test(contentType || '') ||
    /<html|<!doctype html/i.test(text.slice(0, 1024));

  return {
    finalUrl: url.href,
    method,
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    httpVersion: response.httpVersion,
    headers: response.headers,
    body,
    bodyText: text,
    byteLength: body.length,
    contentType: contentType || null,
    charset,
    isHtml,
    isTextual: textual,
    log,
  };
}

module.exports = {
  fetchResource,
  normalizeUrl,
  encodeForm,
  friendlyError,
  MAX_REDIRECTS,
  MAX_BODY_BYTES,
};
