'use strict';

/**
 * Biến HTML tải về thành một trang có thể hiển thị an toàn trong iframe.
 *
 * Các bước chính:
 *  - bỏ <script>, <noscript>, comment, meta refresh, base cũ;
 *  - bỏ thuộc tính sự kiện on*, URL javascript:;
 *  - sửa ảnh lazy-load (data-src → src) để ảnh hiện ra;
 *  - chèn <base href> để đường dẫn tương đối trỏ đúng site gốc;
 *  - chèn script nhỏ để bắt click link / submit form → gửi về khung trình duyệt cha.
 *
 * Trang YouTube được dựng riêng bằng iframe embed chính thức (xem được video),
 * vì trang youtube.com là ứng dụng JS, tải HTML tĩnh sẽ không dùng được.
 */

const { URL } = require('node:url');

const NAV_SCRIPT = `<script>
(function () {
  document.documentElement.setAttribute('data-httpbrowser', '1');

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link || link.hasAttribute('data-external')) {
      return;
    }
    var href = link.getAttribute('href') || '';
    if (/^(mailto:|tel:|#)/i.test(href)) {
      return;
    }
    if (/^javascript:/i.test(href)) {
      event.preventDefault();
      return;
    }
    var absolute;
    try {
      absolute = new URL(href, document.baseURI).href;
    } catch (error) {
      return;
    }
    if (!/^https?:/i.test(absolute)) {
      return;
    }
    event.preventDefault();
    parent.postMessage({ source: 'httpbrowser', type: 'navigate', url: absolute }, '*');
  }, true);

  document.addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.target;
    if (!form) {
      return;
    }

    if (form.hasAttribute('data-youtube-search')) {
      var ytInput = form.querySelector('input[name="q"], input[type="search"], input[type="text"]');
      var ytQuery = ytInput && ytInput.value.trim();
      if (ytQuery) {
        parent.postMessage({ source: 'httpbrowser', type: 'youtube', query: ytQuery }, '*');
      }
      return;
    }

    // method="post": gửi dữ liệu thật về khung cha để nó gọi /view?method=POST.
    var method = (form.getAttribute('method') || 'get').toLowerCase();
    if (method === 'post') {
      var action;
      try {
        action = new URL(form.getAttribute('action') || location.href, document.baseURI).href;
      } catch (error) {
        return;
      }
      if (!/^https?:/i.test(action)) {
        return;
      }
      var pairs = [];
      try {
        new FormData(form).forEach(function (value, name) {
          pairs.push(encodeURIComponent(name) + '=' + encodeURIComponent(value));
        });
      } catch (error) {
        return;
      }
      parent.postMessage({
        source: 'httpbrowser',
        type: 'post',
        url: action,
        data: pairs.join('&')
      }, '*');
      return;
    }

    // Còn lại là form tìm kiếm (DuckDuckGo…) → chuyển thành tìm kiếm của app.
    var input = form.querySelector('input[name="q"], input[type="search"], input[type="text"]');
    if (!input || !input.value.trim()) {
      return;
    }
    parent.postMessage({ source: 'httpbrowser', type: 'search', query: input.value.trim() }, '*');
  }, true);
})();
</script>`;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
};

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code.charAt(0) === '#') {
      const hex = code.charAt(1).toLowerCase() === 'x';
      const value = hex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function stripTags(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '');
}

function cleanText(html, maxLength = 400) {
  const text = decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text) {
  return escapeHtml(text);
}

/** JSON nhúng trong <script> không được chứa chuỗi </script>. */
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// ------------------------------------------------------------------ YouTube

/** Trả về { kind: 'video', id } | { kind: 'search', query } | { kind: 'page' } | null */
function parseYouTube(url) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be' && host !== 'youtube-nocookie.com') {
    return null;
  }

  if (host === 'youtu.be') {
    const id = parsed.pathname.split('/').filter(Boolean)[0];
    return id ? { kind: 'video', id } : { kind: 'page' };
  }
  if (parsed.pathname === '/watch') {
    const id = parsed.searchParams.get('v');
    return id ? { kind: 'video', id } : { kind: 'page' };
  }
  const match = /^\/(shorts|embed|live|v)\/([\w-]{6,})/.exec(parsed.pathname);
  if (match) {
    return { kind: 'video', id: match[2] };
  }
  if (parsed.pathname === '/results' || parsed.pathname === '/search') {
    const query = parsed.searchParams.get('search_query') || parsed.searchParams.get('q') || '';
    return { kind: 'search', query };
  }
  return { kind: 'page' };
}

function youtubePlayerPage(videoId) {
  const embed = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?rel=0&autoplay=1&mute=1&playsinline=1`;
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>YouTube</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f0f0f; }
  .player { position: fixed; inset: 0; }
  iframe { width: 100%; height: 100%; border: 0; display: block; }
</style>
</head>
<body>
<div class="player">
  <iframe src="${embed}" title="YouTube" allowfullscreen
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerpolicy="strict-origin-when-cross-origin"></iframe>
</div>
${metaTag({ ok: true, title: 'YouTube', url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, youtube: true })}
</body>
</html>`;
}

// ---------------------------------------------------- YouTube: kết quả tìm kiếm

/** Lấy khối JSON cân bằng ngoặc đứng sau một mốc trong HTML. */
function extractJsonObject(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const start = html.indexOf('{', html.indexOf('=', markerIndex));
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, i + 1);
      }
    }
  }
  return null;
}

function textOf(node) {
  if (!node) {
    return '';
  }
  if (typeof node === 'string') {
    return node;
  }
  if (node.simpleText) {
    return String(node.simpleText);
  }
  if (Array.isArray(node.runs)) {
    return node.runs.map((run) => run.text || '').join('');
  }
  return '';
}

/**
 * Trang youtube.com/results là ứng dụng JS nhưng vẫn nhúng sẵn JSON
 * `ytInitialData` chứa danh sách video — lấy ra để dựng trang kết quả.
 */
function parseYouTubeVideos(html) {
  const json = extractJsonObject(String(html), 'ytInitialData');
  if (!json) {
    return [];
  }

  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }

  const renderers = [];
  const seen = new Set();

  const walk = (node) => {
    if (!node || typeof node !== 'object' || renderers.length >= 24) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    const video = node.videoRenderer;
    if (video && video.videoId && !seen.has(video.videoId)) {
      seen.add(video.videoId);
      renderers.push(video);
    }
    for (const value of Object.values(node)) {
      walk(value);
    }
  };
  walk(data);

  return renderers.map((video) => ({
    id: video.videoId,
    title: textOf(video.title) || '(không có tiêu đề)',
    channel: textOf(video.ownerText) || textOf(video.longBylineText),
    length: textOf(video.lengthText),
    views: [textOf(video.viewCountText), textOf(video.publishedTimeText)].filter(Boolean).join(' · '),
    thumb: video.thumbnail?.thumbnails?.slice(-1)[0]?.url
      || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
  }));
}

function youtubeSearchPage(query, videos = []) {
  const cards = videos.map((video) => `
    <a class="card" href="https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}">
      <div class="thumb">
        <img src="${escapeAttr(video.thumb)}" alt="" loading="lazy">
        ${video.length ? `<span class="len">${escapeHtml(video.length)}</span>` : ''}
      </div>
      <div class="info">
        <div class="vtitle">${escapeHtml(video.title)}</div>
        <div class="ch">${escapeHtml(video.channel)}</div>
        <div class="sub">${escapeHtml(video.views)}</div>
      </div>
    </a>`).join('');

  const empty = `<div class="empty">
      <p>Không lấy được danh sách video cho “${escapeHtml(query)}”.</p>
      <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(query)}"
         target="_blank" rel="noreferrer" data-external>Mở YouTube trong tab mới ↗</a>
    </div>`;

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>YouTube — ${escapeHtml(query || 'Trang chủ')}</title>
<style>
  html, body { margin: 0; background: #0f0f0f; color: #f1f1f1;
               font-family: "Segoe UI", system-ui, Arial, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px;
           padding: 12px 20px; background: #0f0f0f; border-bottom: 1px solid #272727; }
  header strong { color: #ff4444; font-size: 19px; letter-spacing: -0.6px; }
  header form { flex: 1; display: flex; gap: 8px; max-width: 620px; }
  header input { flex: 1; padding: 9px 16px; border-radius: 999px; border: 1px solid #333;
                 background: #121212; color: #eee; font: inherit; }
  header input:focus { outline: none; border-color: #3ea6ff; }
  header button { padding: 9px 18px; border-radius: 999px; border: 0; background: #272727;
                  color: #f1f1f1; font: inherit; font-weight: 600; cursor: pointer; }
  header button:hover { background: #3f3f3f; }
  main { padding: 20px; }
  .heading { margin: 0 0 16px; font-size: 15px; color: #aaa; font-weight: 500; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 22px 18px; }
  .card { display: block; color: inherit; text-decoration: none; }
  .thumb { position: relative; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: #1c1c1c; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .len { position: absolute; right: 6px; bottom: 6px; padding: 1px 5px; border-radius: 4px;
         background: rgba(0,0,0,.82); font-size: 11.5px; font-weight: 600; }
  .info { padding: 9px 2px 0; }
  .vtitle { font-size: 14px; font-weight: 600; line-height: 1.4; display: -webkit-box;
            -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .ch { margin-top: 5px; color: #aaa; font-size: 12.5px; }
  .sub { margin-top: 2px; color: #8a8a8a; font-size: 12px; }
  .card:hover .vtitle { color: #3ea6ff; }
  .empty { padding: 60px 10px; text-align: center; color: #aaa; }
  .empty a { display: inline-block; margin-top: 12px; padding: 10px 18px; border-radius: 8px;
             background: #272727; color: #f1f1f1; text-decoration: none; }
</style>
</head>
<body>
<header>
  <strong>YouTube</strong>
  <form data-youtube-search>
    <input type="search" name="q" placeholder="Tìm video trên YouTube" value="${escapeAttr(query)}">
    <button type="submit">Tìm</button>
  </form>
</header>
<main>
  ${videos.length
    ? `<p class="heading">Kết quả cho “${escapeHtml(query)}” · ${videos.length} video</p><div class="grid">${cards}</div>`
    : empty}
</main>
${NAV_SCRIPT}
${metaTag({ ok: true, title: `YouTube — ${query}`, url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, youtube: true, search: true, query })}
</body>
</html>`;
}

function youtubeLandingPage(originalUrl) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>YouTube</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f0f0f;
         color: #e5e5e5; font-family: "Segoe UI", system-ui, Arial, sans-serif; text-align: center; }
  .card { max-width: 520px; padding: 32px; }
  h1 { color: #ff4444; margin: 0 0 8px; }
  p { color: #aaa; line-height: 1.6; }
  form { display: flex; gap: 8px; margin: 22px 0 14px; }
  input { flex: 1; padding: 11px 16px; border-radius: 999px; border: 1px solid #444;
          background: #121212; color: #eee; font: inherit; }
  button { padding: 11px 20px; border-radius: 999px; border: 0; background: #ff4444;
           color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .links { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 10px; }
  .links a { color: #8ab4f8; font-size: 13.5px; }
  a.external { display: inline-block; margin-top: 18px; padding: 10px 18px; border-radius: 8px;
               background: #272727; color: #eee; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <h1>YouTube</h1>
  <p>Trang chủ YouTube là ứng dụng JavaScript nên không tải tĩnh được.
     Nhập từ khoá để xem video, hoặc dán link video (youtube.com/watch?v=…).</p>
  <form data-youtube-search>
    <input type="search" name="q" placeholder="Tìm video…" autofocus>
    <button type="submit">Tìm</button>
  </form>
  <div class="links">
    <a href="https://www.youtube.com/results?search_query=nh%E1%BA%A1c+vi%E1%BB%87t">Nhạc Việt</a>
    <a href="https://www.youtube.com/results?search_query=phim+ho%E1%BA%A1t+h%C3%ACnh">Hoạt hình</a>
    <a href="https://www.youtube.com/results?search_query=th%E1%BB%83+thao">Thể thao</a>
  </div>
  <a class="external" href="${escapeAttr(originalUrl)}" target="_blank" rel="noreferrer" data-external>
    Mở YouTube trong tab mới ↗
  </a>
</div>
${metaTag({ ok: true, title: 'YouTube', url: 'https://www.youtube.com/', youtube: true })}
</body>
</html>`;
}

// ------------------------------------------------------------------ tìm kiếm

/**
 * DuckDuckGo bản HTML (html.duckduckgo.com) trả về trang tĩnh, không cần
 * JavaScript và không chặn server như Google. Đây là engine mặc định.
 */
function searchUrl(query) {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=vn`;
}

/** Link kết quả của DDG bọc qua //duckduckgo.com/l/?uddg=<url>. */
function decodeDdgLink(href) {
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const target = parsed.searchParams.get('uddg');
    if (target) {
      return decodeURIComponent(target);
    }
    return /^https?:\/\//i.test(parsed.href) && !/duckduckgo\.com/.test(parsed.hostname)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function parseSearchResults(html) {
  const chunks = String(html).split(/<div class="result\b[^"]*"/).slice(1);
  const results = [];
  const seen = new Set();

  for (const chunk of chunks) {
    if (results.length >= 15) {
      break;
    }
    const anchor = /<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!anchor) {
      continue;
    }
    const href = /href\s*=\s*"([^"]+)"/i.exec(anchor[1]);
    if (!href) {
      continue;
    }
    const url = decodeDdgLink(decodeEntities(href[1]));
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);

    const snippet = /<a\b[^>]*\bresult__snippet\b[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      host = '';
    }
    results.push({
      url,
      title: cleanText(anchor[2], 160),
      description: snippet ? cleanText(snippet[1], 260) : '',
      host,
    });
  }
  return results;
}

function searchPage(query, results) {
  const rows = results.map((item) => `
    <li class="result">
      <div class="site">${escapeHtml(item.host)}</div>
      <a class="title" href="${escapeAttr(item.url)}">${escapeHtml(item.title)}</a>
      <p class="desc">${escapeHtml(item.description || '(không có mô tả)')}</p>
    </li>`).join('');

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(query)} — Tìm kiếm</title>
<style>
  :root { --ink:#1f2328; --muted:#5b6570; --accent:#0b6e4f; --line:#e3e8ee; }
  * { box-sizing: border-box; }
  body { margin:0; background:#fff; color:var(--ink);
         font-family:"Segoe UI","DejaVu Sans",system-ui,Arial,sans-serif; font-size:15px; }
  .top { position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:14px;
         padding:12px 20px; background:#fff; border-bottom:1px solid var(--line); }
  .top strong { color:var(--accent); font-size:18px; letter-spacing:-0.3px; white-space:nowrap; }
  .top form { flex:1; max-width:620px; display:flex; }
  .top input { width:100%; padding:9px 14px; border:1px solid var(--line); border-radius:999px;
               font:inherit; outline:none; }
  .top input:focus { border-color:var(--accent); box-shadow:0 0 0 3px #e2f1eb; }
  main { max-width:760px; padding:18px 20px 60px; }
  .count { color:var(--muted); font-size:13px; margin:0 0 14px; }
  ul { list-style:none; margin:0; padding:0; }
  .result { padding:14px 0; border-bottom:1px solid #f0f2f5; }
  .site { color:var(--muted); font-size:12.5px; }
  .title { display:inline-block; margin:3px 0 5px; color:#1a4fa0; font-size:18px;
           text-decoration:none; line-height:1.35; }
  .title:hover { text-decoration:underline; }
  .desc { margin:0; color:#3d4752; font-size:14px; line-height:1.55; }
  .footer { margin-top:22px; color:var(--muted); font-size:12.5px; }
</style>
</head>
<body>
<div class="top">
  <strong>Tìm kiếm</strong>
  <form><input type="search" name="q" value="${escapeAttr(query)}" autofocus></form>
</div>
<main>
  <p class="count">Khoảng ${results.length} kết quả cho “${escapeHtml(query)}”</p>
  <ul>${rows || '<li>Không tìm thấy kết quả.</li>'}</ul>
  <p class="footer">Nguồn: DuckDuckGo · Trang được tải qua server rồi hiển thị trong trình duyệt này.</p>
</main>
${NAV_SCRIPT}
${metaTag({ ok: true, title: `${query} — Tìm kiếm`, url: searchUrl(query), search: true })}
</body>
</html>`;
}

// --------------------------------------------------------------- trang lỗi

function errorPage(title, message, detail, url) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f5f7f9;
         color:#1f2328; font-family:"Segoe UI","DejaVu Sans",system-ui,Arial,sans-serif; }
  .box { max-width:560px; padding:34px 30px; background:#fff; border:1px solid #e3e8ee;
         border-radius:14px; text-align:center; box-shadow:0 8px 30px rgba(16,49,42,.06); }
  .icon { width:56px; height:56px; margin:0 auto 14px; border-radius:50%; display:grid;
          place-items:center; background:#fdeceb; color:#b3261e; font-size:26px; font-weight:700; }
  h1 { margin:0 0 8px; font-size:20px; }
  p { margin:6px 0; color:#5b6570; line-height:1.6; font-size:14.5px; }
  .detail { margin-top:14px; padding:10px 12px; background:#f7f9fb; border-radius:8px;
            font-family:"Cascadia Code","DejaVu Sans Mono",Consolas,monospace; font-size:12.5px;
            color:#3d4752; word-break:break-word; }
  .actions { margin-top:20px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }
  a { padding:9px 16px; border-radius:8px; text-decoration:none; font-size:14px; }
  a.primary { background:#0b6e4f; color:#fff; }
  a.ghost { border:1px solid #dbe3ea; color:#1f2328; }
</style>
</head>
<body>
  <div class="box">
    <div class="icon">!</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${detail ? `<div class="detail">${escapeHtml(detail)}</div>` : ''}
    <div class="actions">
      <a class="primary" href="${escapeAttr(url)}" data-external>Thử lại</a>
      <a class="ghost" href="https://www.google.com/" target="_blank" rel="noreferrer" data-external>Mở tab mới</a>
    </div>
  </div>
${metaTag({ ok: false, error: message, title, url })}
</body>
</html>`;
}

// ------------------------------------------------------------------ HEAD

/** Trang thông tin tài nguyên khi dùng HEAD: chỉ có header, không có body. */
function headPage(result, extra = {}) {
  const map = new Map();
  for (const header of result.headers) {
    const key = header.name.toLowerCase();
    if (!map.has(key)) {
      map.set(key, header.value);
    }
  }
  const pick = (name) => map.get(name) || '';

  const facts = [
    ['Content-Type', pick('content-type')],
    ['Content-Length', pick('content-length')],
    ['Last-Modified', pick('last-modified')],
    ['ETag', pick('etag')],
    ['Content-Encoding', pick('content-encoding')],
    ['Server', pick('server')],
  ].filter(([, value]) => value);

  const factRows = facts.map(([label, value]) =>
    `<tr><th>${escapeHtml(label)}</th><td class="mono">${escapeHtml(value)}</td></tr>`).join('');

  const headerRows = result.headers.map((header) =>
    `<tr><td class="mono name">${escapeHtml(header.name)}</td><td class="mono">${escapeHtml(header.value)}</td></tr>`).join('');

  const statusClass = result.statusCode < 300 ? 'ok' : (result.statusCode < 400 ? 'redirect' : 'bad');
  const title = extra.title || `HEAD — ${result.finalUrl}`;
  const raw = `/api/raw?url=${encodeURIComponent(result.finalUrl)}`;

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { --ink:#1f2328; --muted:#5b6570; --accent:#0b6e4f; --line:#e3e8ee; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f5f7f9; color:var(--ink);
         font-family:"Segoe UI","DejaVu Sans",system-ui,Arial,sans-serif; font-size:14px; }
  .wrap { max-width:820px; margin:0 auto; padding:26px 20px 60px; }
  .top { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:6px; }
  .badge { padding:5px 10px; border-radius:999px; font-size:12.5px; font-weight:700;
           letter-spacing:.3px; background:#e7f4ef; color:var(--accent); }
  .badge.redirect { background:#fff4e2; color:#8a5a12; }
  .badge.bad { background:#fdeceb; color:#b3261e; }
  .url { font-family:"Cascadia Code","DejaVu Sans Mono",Consolas,monospace; font-size:12.5px;
         color:var(--muted); word-break:break-all; }
  h1 { font-size:17px; margin:10px 0 2px; word-break:break-word; }
  .lead { margin:0 0 18px; color:var(--muted); font-size:13px; }
  .kind { margin:0 0 18px; padding:10px 14px; background:#fff; border:1px solid var(--line);
          border-left:3px solid var(--accent); border-radius:8px; font-size:13px; color:#3d4752; }
  .kind em { font-style:normal; font-weight:600; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line);
          border-radius:10px; overflow:hidden; }
  th, td { padding:9px 12px; text-align:left; font-size:13px; border-bottom:1px solid #eef2f5;
           vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  th { width:190px; color:var(--muted); font-weight:600; background:#fafcfd; }
  .mono { font-family:"Cascadia Code","DejaVu Sans Mono",Consolas,monospace; font-size:12px;
          word-break:break-word; }
  .name { white-space:nowrap; color:#2a3833; }
  h2 { margin:24px 0 8px; font-size:13px; text-transform:uppercase; letter-spacing:.5px;
       color:var(--muted); }
  .actions { margin-top:22px; display:flex; gap:10px; flex-wrap:wrap; }
  a.btn { padding:9px 16px; border-radius:8px; text-decoration:none; font-size:13.5px; }
  a.primary { background:var(--accent); color:#fff; }
  a.ghost { border:1px solid #dbe3ea; color:var(--ink); background:#fff; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <span class="badge ${statusClass}">HEAD</span>
      <span class="badge ${statusClass}">HTTP/${escapeHtml(result.httpVersion)} ${result.statusCode} ${escapeHtml(result.statusMessage)}</span>
      <span class="url">${escapeHtml(result.finalUrl)}</span>
    </div>
    <h1>Thông tin tài nguyên</h1>
    <p class="lead">${extra.timeMs != null ? `${extra.timeMs} ms · ` : ''}${result.headers.length} header · body không được gửi về</p>

    <p class="kind">HEAD giống GET nhưng server <em>không gửi body</em>. Vì vậy trang này chỉ hiển thị
      metadata của tài nguyên: không có HTML để đếm tag, nhưng Content-Length cho biết kích thước thật.</p>

    ${factRows ? `<table><tbody>${factRows}</tbody></table>` : ''}

    <h2>Tất cả header phản hồi</h2>
    <table>
      <tbody>
        ${headerRows || '<tr><td colspan="2">(không có header)</td></tr>'}
      </tbody>
    </table>

    <div class="actions">
      <a class="btn primary" href="${raw}" data-external>Tải nội dung (GET)</a>
      <a class="btn ghost" href="${escapeAttr(result.finalUrl)}" target="_blank" rel="noreferrer" data-external>Mở URL gốc ↗</a>
    </div>
  </div>
${metaTag({
  ok: true,
  method: 'HEAD',
  url: result.finalUrl,
  title,
  status: result.statusCode,
  statusText: result.statusMessage,
  contentType: result.contentType,
  byteLength: result.byteLength,
  timeMs: extra.timeMs,
  headers: result.headers,
  log: result.log,
})}
</body>
</html>`;
}

// ------------------------------------------------------------- nhị phân

function binaryPage(result) {
  const type = (result.contentType || '').toLowerCase();
  const raw = `/api/raw?url=${encodeURIComponent(result.finalUrl)}`;
  const download = `${raw}&download=1`;
  const isImage = type.startsWith('image/');
  const isPdf = type.includes('pdf');
  const isVideo = type.startsWith('video/');
  const isAudio = type.startsWith('audio/');

  let preview = '';
  if (isImage) {
    preview = `<img class="preview" src="${raw}" alt="Nội dung ảnh">`;
  } else if (isPdf) {
    preview = `<iframe class="preview frame" src="${raw}" title="PDF"></iframe>`;
  } else if (isVideo) {
    preview = `<video class="preview" src="${raw}" controls></video>`;
  } else if (isAudio) {
    preview = `<audio class="preview" src="${raw}" controls></audio>`;
  }

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>Tệp — ${escapeHtml(result.finalUrl.split('/').pop() || 'tài nguyên')}</title>
<style>
  body { margin:0; min-height:100vh; background:#f5f7f9; color:#1f2328;
         font-family:"Segoe UI","DejaVu Sans",system-ui,Arial,sans-serif; }
  .wrap { max-width:900px; margin:0 auto; padding:26px 20px; }
  h1 { font-size:18px; margin:0 0 6px; word-break:break-all; }
  .meta { color:#5b6570; font-size:13px; margin-bottom:18px; }
  .preview { max-width:100%; border-radius:10px; border:1px solid #e3e8ee; background:#fff; display:block; }
  .frame { width:100%; height:70vh; }
  .actions { margin-top:20px; display:flex; gap:10px; flex-wrap:wrap; }
  a { padding:10px 18px; border-radius:8px; text-decoration:none; font-size:14px; }
  a.primary { background:#0b6e4f; color:#fff; }
  a.ghost { border:1px solid #dbe3ea; color:#1f2328; background:#fff; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(result.finalUrl.split('/').pop() || result.finalUrl)}</h1>
    <div class="meta">${escapeHtml(result.contentType || 'không rõ loại')} · ${result.byteLength.toLocaleString('vi-VN')} byte</div>
    ${preview}
    <div class="actions">
      <a class="primary" href="${download}" data-external>Tải xuống</a>
      <a class="ghost" href="${escapeAttr(result.finalUrl)}" target="_blank" rel="noreferrer" data-external>Mở URL gốc</a>
    </div>
  </div>
${metaTag({ ok: true, title: result.finalUrl.split('/').pop() || 'Tệp', url: result.finalUrl, binary: true })}
</body>
</html>`;
}

// ---------------------------------------------------------------- meta tag

function metaTag(meta) {
  return `<script type="application/json" id="httpbrowser-meta">${safeJson(meta)}</script>`;
}

// -------------------------------------------------------------- HTML sạch

function fixLazyImages(html) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const lazy = /\sdata-(?:src|original|lazy-src|actualsrc|url)\s*=\s*(["'])(.*?)\1/i.exec(tag);
    let out = tag;
    if (lazy) {
      out = out.replace(/\ssrc\s*=\s*(["'])[^"']*\1/i, '');
      out = out.replace(/\sdata-(?:src|original|lazy-src|actualsrc|url)\s*=\s*(["'])(.*?)\1/i, ` src="$2"`);
    }
    return out
      .replace(/\sloading\s*=\s*(["'])lazy\1/gi, '')
      .replace(/\sdecoding\s*=\s*(["'])async\1/gi, '');
  });
}

/** Chuyển link trung gian của Bing (bing.com/ck/a?...u=a1<base64>) về URL thật. */
function decodeBingLinks(html) {
  return html.replace(/href="(https?:\/\/www\.bing\.com\/ck\/a\?[^"]+)"/g, (match, href) => {
    const real = decodeBingUrl(href);
    return real ? `href="${escapeAttr(real)}"` : match;
  });
}

function decodeBingUrl(href) {
  try {
    const parsed = new URL(decodeEntities(href));
    const raw = parsed.searchParams.get('u');
    if (!raw || !raw.startsWith('a1')) {
      return null;
    }
    const base64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function sanitizeHtml(html, finalUrl) {
  let out = String(html);

  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<meta[^>]+http-equiv\s*=\s*["']?(refresh|content-security-policy)["']?[^>]*>/gi, '');
  out = out.replace(/<base\b[^>]*>/gi, '');
  out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/(href|src|action)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
  out = fixLazyImages(out);
  out = decodeBingLinks(out);

  const head = `<base href="${escapeAttr(finalUrl)}">`
    + '<meta name="referrer" content="no-referrer">'
    + '<meta name="httpbrowser" content="1">'
    + '<style id="httpbrowser-style">'
    + '#LeaderBoardTop,#admWrapsite>[id^="adm"]:empty,ins.adsbygoogle,[id^="div-gpt-ad"],'
    + '[id^="_ads"],[class*="banner-ads"],[class*="section-ads"],[class*="banner-top"],[class*="ads-top"]'
    + '{display:none !important}'
    + 'html{scroll-behavior:smooth}'
    + '</style>';

  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, `<html$1><head>${head}<meta charset="UTF-8"></head>`);
  } else {
    out = `<!DOCTYPE html><html><head>${head}<meta charset="UTF-8"></head><body>${out}</body></html>`;
  }

  // Nav script + meta phải nằm cuối body để chắc chắn DOM đã có.
  if (/<\/body\s*>/i.test(out)) {
    out = out.replace(/<\/body\s*>/i, `${NAV_SCRIPT}</body>`);
  } else {
    out += NAV_SCRIPT;
  }
  return out;
}

/** Chuẩn bị trang cuối cùng cho iframe: meta + HTML đã lọc. */
function renderHtmlPage(result, extraMeta) {
  const withMeta = sanitizeHtml(result.bodyText, result.finalUrl);
  const meta = metaTag({
    ok: true,
    url: result.finalUrl,
    title: extraMeta.title,
    status: result.statusCode,
    statusText: result.statusMessage,
    contentType: result.contentType,
    byteLength: result.byteLength,
    timeMs: extraMeta.timeMs,
    analysis: extraMeta.analysis,
    headers: result.headers,
    log: result.log,
    ...(extraMeta.extra || {}),
  });
  return withMeta.replace(/<\/body\s*>/i, `${meta}</body>`);
}

module.exports = {
  NAV_SCRIPT,
  escapeHtml,
  escapeAttr,
  decodeEntities,
  cleanText,
  parseYouTube,
  youtubePlayerPage,
  youtubeSearchPage,
  parseYouTubeVideos,
  youtubeLandingPage,
  searchUrl,
  parseSearchResults,
  searchPage,
  errorPage,
  headPage,
  binaryPage,
  sanitizeHtml,
  renderHtmlPage,
  metaTag,
};
