'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const { fetchResource, normalizeUrl } = require('./lib/fetcher');
const { analyze } = require('./lib/analyzer');
const render = require('./lib/render');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_JSON_BYTES = 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.htm': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.txt': 'text/plain; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, statusCode, contentType, body, extraHeaders = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(buffer);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, 'application/json; charset=UTF-8', JSON.stringify(payload));
}

/** Đọc dữ liệu từ file DB cục bộ (data/db.json) */
function readDb() {
  try {
    const data = fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { history: [], createdAt: new Date().toISOString() };
  }
}

/** Ghi dữ liệu vào file DB cục bộ */
function writeDb(db) {
  const dbPath = path.join(__dirname, 'data', 'db.json');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_JSON_BYTES) {
        reject(new Error('Dữ liệu gửi lên quá lớn'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Body không phải JSON hợp lệ'));
      }
    });
    req.on('error', reject);
  });
}

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** Phục vụ file tĩnh trong public/, chặn path traversal. */
async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    send(res, 403, 'text/html; charset=UTF-8', '<h1>403 Forbidden</h1>');
    return true;
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    return false;
  }
  if (stat.isDirectory()) {
    return serveStatic(req, res, pathname.replace(/\/?$/, '/') + 'index.html');
  }

  const data = await fsp.readFile(resolved);
  const headers = {
    'Cache-Control': 'no-cache',
    'Last-Modified': stat.mtime.toUTCString(),
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': contentTypeFor(resolved),
      'Content-Length': data.length,
      ...headers,
    });
    res.end();
    return true;
  }
  send(res, 200, contentTypeFor(resolved), data, headers);
  return true;
}

// ------------------------------------------------------------------ demo pages

function demoPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <link rel="stylesheet" href="/demo/style.css">
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function handleDemo(req, res, url) {
  const pathname = url.pathname;

  if (pathname === '/demo/redirect') {
    res.writeHead(302, { Location: '/demo/index.html', 'Content-Length': 0 });
    res.end();
    return true;
  }

  if (pathname === '/demo/slow') {
    const seconds = Math.min(Number(url.searchParams.get('s') || 10), 60);
    setTimeout(() => {
      send(res, 200, 'text/html; charset=UTF-8',
        demoPage('Chậm', `<div class="card"><h1>Đã chờ ${seconds} giây</h1>
          <p>Trang này dùng để thử nút <strong>Dừng</strong> của browser.</p></div>`));
    }, seconds * 1000);
    return true;
  }

  if (pathname === '/demo/chunked') {
    // Không đặt Content-Length → Node tự dùng Transfer-Encoding: chunked.
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=UTF-8',
      'X-Demo': 'chunked',
    });
    const chunks = [
      '<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">',
      '<title>Chunked</title></head><body>',
      '<h1>Response dạng chunked</h1>',
      '<p>Mỗi dòng này được gửi trong một chunk riêng.</p>',
      '<div>Client phải đọc từng khối theo kích thước hex.</div>',
      '<span>Nếu đọc đúng, trang hiển thị đủ nội dung.</span>',
      '<img src="/demo/logo.svg" alt="logo">',
      '</body></html>',
    ];
    let index = 0;
    const writeNext = () => {
      if (index >= chunks.length) {
        res.end();
        return;
      }
      res.write(chunks[index]);
      index += 1;
      setTimeout(writeNext, 60);
    };
    writeNext();
    return true;
  }

  if (pathname === '/demo/gzip') {
    const html = await fsp.readFile(path.join(PUBLIC_DIR, 'demo', 'index.html'));
    const compressed = zlib.gzipSync(html);
    send(res, 200, 'text/html; charset=UTF-8', compressed, {
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
      'X-Demo': 'gzip',
    });
    return true;
  }

  if (pathname === '/demo/echo') {
    if (req.method !== 'POST') {
      send(res, 200, 'text/html; charset=UTF-8', demoPage('Form POST', `
        <div class="card">
          <h1>Gửi dữ liệu bằng POST</h1>
          <p>Đây là trang để thử method POST của browser.</p>
          <form method="post" action="/demo/echo">
            <p><label>Họ tên: <input type="text" name="ten" value="Hà Điền Trung Hiếu"></label></p>
            <p><label>Lớp: <input type="text" name="lop" value="24IT062"></label></p>
            <p><label>Ghi chú: <input type="text" name="ghichu" value="Bài lab HTTP"></label></p>
            <p><button type="submit">Gửi</button></p>
          </form>
        </div>`));
      return true;
    }

    const body = await readRawBody(req);
    const params = new URLSearchParams(body.toString('utf8'));
    const rows = [...params.entries()]
      .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`)
      .join('');

    send(res, 200, 'text/html; charset=UTF-8', demoPage('Kết quả POST', `
      <div class="card">
        <h1>Server đã nhận dữ liệu POST</h1>
        <p>Nội dung form mà server đọc được từ body của request:</p>
        <table>
          <tr><th>Trường</th><th>Giá trị</th></tr>
          ${rows || '<tr><td colspan="2"><em>Body rỗng</em></td></tr>'}
        </table>
        <p>Độ dài body: <strong>${body.length} byte</strong></p>
        <p><a href="/demo/index.html">Quay lại trang chủ</a></p>
      </div>`));
    return true;
  }

  return false;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
        reject(new Error('Body quá lớn'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ------------------------------------------------------- trình duyệt (view/raw)

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_CACHE_MAX = 40;
const VIEW_METHODS = ['GET', 'POST', 'HEAD'];
const pageCache = new Map();

/**
 * Tải trang và cache lại để tab "Bài lab" không phải tải lại lần hai.
 * Cache tách riêng theo method (và body với POST) để HEAD không đè lên GET.
 */
async function getPageResource(target, method = 'GET', data = '') {
  const url = String(target);
  const key = method === 'POST' ? `POST ${url}\n${data}` : `${method} ${url}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < PAGE_CACHE_TTL_MS) {
    return hit.result;
  }

  const request = {
    url,
    method,
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'vi,en;q=0.8',
    },
  };
  if (method === 'POST') {
    request.data = data;
  }

  const result = await fetchResource(request);
  pageCache.set(key, { at: Date.now(), result });
  if (pageCache.size > PAGE_CACHE_MAX) {
    pageCache.delete(pageCache.keys().next().value);
  }
  return result;
}

function viewHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    ...extra,
  };
}

function sendViewPage(res, html) {
  send(res, 200, 'text/html; charset=UTF-8', html, viewHeaders());
}

async function handleView(res, url) {
  const target = url.searchParams.get('url') || '';
  const method = (url.searchParams.get('method') || 'GET').toUpperCase();
  const data = url.searchParams.get('data') || '';

  if (!VIEW_METHODS.includes(method)) {
    sendViewPage(res, render.errorPage(
      'Method không hỗ trợ',
      `Route /view chỉ nhận ${VIEW_METHODS.join(', ')} (nhận được ${method}).`,
      target,
      '/',
    ));
    return;
  }

  let parsed;
  try {
    parsed = normalizeUrl(target);
  } catch (error) {
    sendViewPage(res, render.errorPage(
      'Địa chỉ không hợp lệ',
      error.message,
      target,
      '/',
    ));
    return;
  }

  const started = Date.now();

  // Các trang đặc biệt chỉ áp dụng cho GET: POST/HEAD phải đi đúng giao thức.
  if (method === 'GET') {
    // YouTube: dựng trang phát video bằng iframe embed chính thức.
    const youtube = render.parseYouTube(parsed);
    if (youtube) {
      if (youtube.kind === 'video') {
        sendViewPage(res, render.youtubePlayerPage(youtube.id));
      } else if (youtube.kind === 'search') {
        let videos = [];
        if (youtube.query) {
          try {
            const raw = await fetchResource({
              url: `https://www.youtube.com/results?search_query=${encodeURIComponent(youtube.query)}&hl=vi&gl=VN`,
              method: 'GET',
              headers: {
                'User-Agent': BROWSER_UA,
                'Accept-Language': 'vi,en;q=0.8',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              },
            });
            videos = render.parseYouTubeVideos(raw.bodyText || '');
          } catch {
            videos = [];
          }
        }
        sendViewPage(res, render.youtubeSearchPage(youtube.query, videos));
      } else {
        sendViewPage(res, render.youtubeLandingPage(parsed.href));
      }
      return;
    }

    // Tìm kiếm: DuckDuckGo bản HTML trả trang tĩnh, server lọc thành kết quả gọn.
    if (/(^|\.)duckduckgo\.com$/.test(parsed.hostname)) {
      const query = parsed.searchParams.get('q') || '';
      const searchStarted = Date.now();
      try {
        const raw = await fetchResource({
          url: render.searchUrl(query),
          method: 'GET',
          headers: {
            'User-Agent': BROWSER_UA,
            'Accept-Language': 'vi,en;q=0.8',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
        const results = render.parseSearchResults(raw.bodyText || '');
        if (results.length > 0) {
          sendViewPage(res, render.searchPage(query, results));
          return;
        }
        const analysis = analyze(raw.bodyText || '', raw.byteLength);
        sendViewPage(res, render.renderHtmlPage(raw, {
          title: `${query} — Tìm kiếm`,
          timeMs: Date.now() - searchStarted,
          analysis,
        }));
      } catch (error) {
        sendViewPage(res, render.errorPage(
          'Không tìm kiếm được',
          error.message,
          parsed.href,
          parsed.href,
        ));
      }
      return;
    }
  }

  try {
    const result = await getPageResource(parsed.href, method, data);

    // HEAD không có body: hiển thị trang thông tin tài nguyên riêng.
    if (method === 'HEAD') {
      sendViewPage(res, render.headPage(result, {
        title: `HEAD — ${parsed.hostname}`,
        timeMs: Date.now() - started,
      }));
      return;
    }

    if (!result.isHtml) {
      sendViewPage(res, render.binaryPage(result));
      return;
    }

    const analysis = analyze(result.bodyText, result.byteLength);
    const title = analysis.title
      || result.finalUrl.replace(/^https?:\/\//, '').split('/')[0];

    sendViewPage(res, render.renderHtmlPage(result, {
      title,
      timeMs: Date.now() - started,
      analysis,
    }));
  } catch (error) {
    sendViewPage(res, render.errorPage(
      method === 'HEAD' ? 'Không lấy được thông tin tài nguyên' : 'Không tải được trang',
      error.message,
      parsed.href,
      parsed.href,
    ));
  }
}

async function handleSource(res, url) {
  const target = url.searchParams.get('url') || '';
  try {
    const parsed = normalizeUrl(target);
    const result = await getPageResource(parsed.href);
    if (!result.isTextual) {
      send(res, 200, 'text/plain; charset=UTF-8',
        `(Nội dung nhị phân — ${result.contentType || 'không rõ loại'}, ${result.byteLength} byte. Dùng nút Tải xuống.)`);
      return;
    }
    send(res, 200, 'text/plain; charset=UTF-8', result.bodyText);
  } catch (error) {
    send(res, 502, 'text/plain; charset=UTF-8', `Lỗi: ${error.message}`);
  }
}

async function handleRaw(res, url) {
  const target = url.searchParams.get('url') || '';
  const download = url.searchParams.get('download') === '1';
  try {
    const parsed = normalizeUrl(target);
    const result = await getPageResource(parsed.href);
    const name = decodeURIComponent(parsed.pathname.split('/').pop() || 'tai-nguyen');
    const disposition = download
      ? `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
      : 'inline';
    send(res, 200, result.contentType || 'application/octet-stream', result.body, {
      'Cache-Control': 'no-store',
      'Content-Disposition': disposition,
    });
  } catch (error) {
    send(res, 502, 'text/plain; charset=UTF-8', `Lỗi: ${error.message}`);
  }
}

// ----------------------------------------------------------------------- API

async function handleApiFetch(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const started = Date.now();
  try {
    const result = await fetchResource({
      url: payload.url,
      method: payload.method,
      data: payload.data,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'vi,en;q=0.8',
        ...(payload.headers || {}),
      },
    });

    // HEAD không có body nên không thể phân tích tag; trang chỉ hiển thị thông tin tài nguyên.
    const analysis = result.isHtml && result.method !== 'HEAD'
      ? analyze(result.bodyText, result.byteLength)
      : null;

    sendJson(res, 200, {
      request: {
        url: payload.url,
        method: result.method,
      },
      response: {
        finalUrl: result.finalUrl,
        statusCode: result.statusCode,
        statusMessage: result.statusMessage,
        httpVersion: result.httpVersion,
        headers: result.headers,
        contentType: result.contentType,
        charset: result.charset,
        byteLength: result.byteLength,
        isHtml: result.isHtml,
        isTextual: result.isTextual,
        bodyText: result.isTextual ? result.bodyText : null,
      },
      analysis,
      log: result.log,
      timeMs: Date.now() - started,
    });
  } catch (error) {
    sendJson(res, 502, {
      error: error.message,
      log: [],
      timeMs: Date.now() - started,
    });
  }
}

// --------------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, uptime: process.uptime() });
      return;
    }

    if (url.pathname === '/api/fetch') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Chỉ hỗ trợ POST cho /api/fetch' });
        return;
      }
      await handleApiFetch(req, res);
      return;
    }

    if (url.pathname === '/view') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Chỉ hỗ trợ GET cho /view' });
        return;
      }
      await handleView(res, url);
      return;
    }

    if (url.pathname === '/api/source') {
      await handleSource(res, url);
      return;
    }

    if (url.pathname === '/api/raw') {
      await handleRaw(res, url);
      return;
    }

    if (url.pathname === '/api/history') {
      if (req.method === 'GET') {
        sendJson(res, 200, readDb());
      } else if (req.method === 'POST') {
        readJsonBody(req).then((payload) => {
          const db = readDb();
          // Tạo id duy nhất nếu không có
          const id = payload.id || `h_${Date.now()}_${btoa(payload.url || '').slice(0, 8).replace(/=/g, '')}`;
          // Kiểm tra trùng lặp: cùng url và cùng id thì không thêm
          const exists = db.history.some((e) => e.url === payload.url && e.id === id);
          if (exists) {
            return sendJson(res, 200, { success: true, alreadyExists: true, entry: db.history.find((e) => e.url === payload.url) });
          }
          const entry = {
            id,
            url: payload.url,
            title: payload.title || payload.url,
            method: payload.method || 'GET',
            addedAt: new Date().toISOString()
          };
          db.history.unshift(entry);
          if (db.history.length > 200) db.history.length = 200;
          writeDb(db);
          sendJson(res, 200, { success: true, entry });
        }).catch((err) => {
          sendJson(res, 400, { error: err.message });
        });
      } else if (req.method === 'DELETE') {
        await writeDb({ history: [] });
        sendJson(res, 200, { success: true });
      }
      return;
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname.startsWith('/demo/')) {
      const handled = await handleDemo(req, res, url);
      if (handled) {
        return;
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/html; charset=UTF-8', '<h1>405 Method Not Allowed</h1>', {
        Allow: 'GET, HEAD',
      });
      return;
    }

    if (await serveStatic(req, res, url.pathname)) {
      return;
    }

    const fallbackPath = path.join(PUBLIC_DIR, 'demo', '404.html');
    try {
      const page = await fsp.readFile(fallbackPath);
      send(res, 404, 'text/html; charset=UTF-8', page);
    } catch {
      send(res, 404, 'text/html; charset=UTF-8', '<h1>404 Not Found</h1>');
    }
  } catch (error) {
    console.error('Lỗi server:', error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: error.message || 'Lỗi server' });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  const addresses = [];
  for (const [name, list] of Object.entries(require('node:os').networkInterfaces())) {
    void name;
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) {
        addresses.push(item.address);
      }
    }
  }
  console.log('HTTP Browser web app đã khởi động');
  console.log(`  Local   : http://localhost:${PORT}/`);
  for (const address of addresses) {
    console.log(`  LAN     : http://${address}:${PORT}/`);
  }
  console.log('  Nhấn Ctrl+C để dừng.\n');
});

process.on('SIGINT', () => {
  console.log('\nĐang dừng server...');
  server.close(() => process.exit(0));
});
