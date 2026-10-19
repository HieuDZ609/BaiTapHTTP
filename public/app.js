'use strict';

/**
 * Giao diện browser. Toàn bộ việc fetch trang web diễn ra ở server
 * (`/api/fetch`) vì trình duyệt bị CORS chặn khi đọc nội dung trang khác.
 */

const methodButtons = [...document.querySelectorAll('.method')];
const urlInput = document.getElementById('url');
const sendButton = document.getElementById('send');
const stopButton = document.getElementById('stop');
const postRow = document.getElementById('post-row');
const postData = document.getElementById('post-data');
const statusText = document.getElementById('status');
const metaText = document.getElementById('meta');
const spinner = document.getElementById('spinner');
const tabs = [...document.querySelectorAll('.tab')];
const panels = {
  preview: document.getElementById('panel-preview'),
  source: document.getElementById('panel-source'),
  analysis: document.getElementById('panel-analysis'),
  headers: document.getElementById('panel-headers'),
  log: document.getElementById('panel-log'),
};
const sourceText = document.getElementById('source-text');
const logText = document.getElementById('log-text');

let controller = null;
let lastResult = null;
/** Phương thức đang chọn: GET | POST | HEAD. */
let currentMethod = 'GET';
/** Tab ưu tiên từ deep link; dùng một lần rồi trả về hành vi mặc định. */
let preferredTab = null;

// ------------------------------------------------------------------ tiện ích

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('vi-VN');
}

function setStatus(message, meta = '', isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle('error', isError);
  metaText.textContent = meta;
}

function setBusy(busy) {
  sendButton.disabled = busy;
  stopButton.disabled = !busy;
  spinner.hidden = !busy;
  for (const button of methodButtons) {
    button.disabled = busy;
  }
  urlInput.disabled = busy;
}

/** Đổi phương thức và hiện/ẩn ô dữ liệu POST tương ứng. */
function setMethod(name) {
  if (!['GET', 'POST', 'HEAD'].includes(name)) {
    return;
  }
  currentMethod = name;
  for (const button of methodButtons) {
    const active = button.dataset.method === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  postRow.hidden = name !== 'POST';
}

function switchTab(name) {
  for (const tab of tabs) {
    tab.classList.toggle('active', tab.dataset.panel === name);
  }
  for (const [key, panel] of Object.entries(panels)) {
    panel.classList.toggle('active', key === name);
  }
}

function absoluteUrl(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return '';
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('/')) {
    return new URL(trimmed, window.location.origin).href;
  }
  return `http://${trimmed}`;
}

// ---------------------------------------------------------------- hiển thị

function showEmpty(panel, title, note) {
  panel.innerHTML = `<div class="empty"><strong>${escapeHtml(title)}</strong>`
    + (note ? `<p>${escapeHtml(note)}</p>` : '') + '</div>';
}

function renderPreview(result) {
  const { response } = result;
  panels.preview.innerHTML = '';

  if (result.request.method === 'HEAD') {
    showEmpty(panels.preview, 'Method HEAD — không có body',
      'Server chỉ gửi header. Xem thông tin tài nguyên ở tab Header.');
    return;
  }

  if (!response.isHtml) {
    showEmpty(panels.preview, 'Không phải HTML',
      `Content-Type: ${response.contentType || '(không có)'} — không thể render.`);
    return;
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('title', 'Xem trước trang HTML');
  iframe.srcdoc = buildPreviewDocument(response.bodyText, response.finalUrl);
  panels.preview.appendChild(iframe);
}

/** Lọc script và thuộc tính sự kiện, chèn <base> để đường dẫn tương đối đúng. */
function buildPreviewDocument(html, baseUrl) {
  const cleaned = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');

  const baseTag = `<base href="${escapeHtml(baseUrl)}">`;
  if (/<head[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }
  if (/<html[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
  }
  return `<!DOCTYPE html><html><head>${baseTag}</head><body>${cleaned}</body></html>`;
}

function renderSource(result) {
  const { response } = result;
  if (result.request.method === 'HEAD') {
    sourceText.textContent = '(Method HEAD — server không gửi body)\n\n'
      + 'Xem thông tin tài nguyên ở tab Header.';
    return;
  }
  if (response.isTextual) {
    sourceText.textContent = response.bodyText;
    return;
  }
  sourceText.textContent = `(Nội dung nhị phân — không hiển thị dạng text)\n`
    + `Content-Type: ${response.contentType || '(không có)'}\n`
    + `Số byte: ${response.byteLength}`;
}

function renderAnalysis(result) {
  const { response, analysis } = result;

  if (result.request.method === 'HEAD') {
    panels.analysis.innerHTML = `
      <div class="analysis">
        <h2>Thông tin tài nguyên (method HEAD)</h2>
        <p class="muted">Server không gửi body, chỉ gửi header — đúng đặc tả HTTP.</p>
        <table class="data">${resourceRows(response)}</table>
        <p class="muted">So sánh: gửi GET cùng URL rồi xem <code>Content-Length</code> ở tab Header
          để thấy khớp với con số dưới đây.</p>
      </div>`;
    return;
  }

  if (!analysis) {
    panels.analysis.innerHTML = `
      <div class="analysis">
        <h2>Không phân tích được</h2>
        <p>Tài nguyên không phải HTML nên không có tag để đếm.</p>
        <table class="data">
          <tr><th>Content-Type</th><td class="mono">${escapeHtml(response.contentType || '(không có)')}</td></tr>
          <tr><th>Số byte</th><td>${formatNumber(response.byteLength)}</td></tr>
        </table>
      </div>`;
    return;
  }

  const required = analysis.requiredTags
    .map((tag) => `
      <li class="tag-card">
        <span class="name">&lt;${tag}&gt;</span>
        <span class="value">${formatNumber(analysis.counts[tag].count)}</span>
      </li>`)
    .join('');

  const otherRows = Object.entries(analysis.counts)
    .filter(([, info]) => !info.required && info.count > 0)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([tag, info]) => `<tr><td class="mono">&lt;${tag}&gt;</td><td>${formatNumber(info.count)}</td></tr>`)
    .join('');

  const images = analysis.images.length
    ? `<h3>Ảnh tìm thấy (${analysis.images.length})</h3>
       <ul class="plain">${analysis.images.map((src) => `<li><code>${escapeHtml(src)}</code></li>`).join('')}</ul>`
    : '';

  const links = analysis.links.length
    ? `<h3>Liên kết tìm thấy (${analysis.links.length})</h3>
       <ul class="plain">${analysis.links.map((href) => `<li><code>${escapeHtml(href)}</code></li>`).join('')}</ul>`
    : '';

  panels.analysis.innerHTML = `
    <div class="analysis">
      <h2>${escapeHtml(analysis.title || '(không có tiêu đề)')}</h2>
      <div class="summary">
        <span class="pill">Chiều dài: <strong>${formatNumber(analysis.characterLength)}</strong> ký tự</span>
        <span class="pill"><strong>${formatNumber(analysis.byteLength)}</strong> byte nhận từ mạng</span>
        <span class="pill"><strong>${formatNumber(analysis.utf8ByteLength)}</strong> byte UTF-8</span>
        <span class="pill"><strong>${formatNumber(analysis.lineCount)}</strong> dòng</span>
      </div>

      <h3>Tag đề bài yêu cầu</h3>
      <ul class="tag-grid">${required}</ul>

      ${otherRows ? `<h3>Tag khác</h3>
        <table class="data">
          <tr><th>Tag</th><th>Số lượng</th></tr>
          ${otherRows}
        </table>` : ''}

      ${images}
      ${links}
    </div>`;
}

function resourceRows(response) {
  const header = (name) => {
    const found = response.headers.find((item) => item.name.toLowerCase() === name.toLowerCase());
    return found ? found.value : '(không có)';
  };
  return `
    <tr><th>Status</th><td class="mono">HTTP/${escapeHtml(response.httpVersion)} ${response.statusCode} ${escapeHtml(response.statusMessage)}</td></tr>
    <tr><th>Content-Type</th><td class="mono">${escapeHtml(header('Content-Type'))}</td></tr>
    <tr><th>Charset</th><td class="mono">${escapeHtml(response.charset || '(không rõ)')}</td></tr>
    <tr><th>Content-Length</th><td class="mono">${escapeHtml(header('Content-Length'))}</td></tr>
    <tr><th>Last-Modified</th><td class="mono">${escapeHtml(header('Last-Modified'))}</td></tr>
    <tr><th>ETag</th><td class="mono">${escapeHtml(header('ETag'))}</td></tr>
    <tr><th>Server</th><td class="mono">${escapeHtml(header('Server'))}</td></tr>
    <tr><th>Content-Encoding</th><td class="mono">${escapeHtml(header('Content-Encoding'))}</td></tr>
    <tr><th>Số header</th><td>${formatNumber(response.headers.length)}</td></tr>
    <tr><th>Body</th><td>không có (đúng với method HEAD)</td></tr>`;
}

function renderHeaders(result) {
  const { response } = result;
  const rows = response.headers
    .map((item) => `<tr><td class="mono">${escapeHtml(item.name)}</td><td class="mono">${escapeHtml(item.value)}</td></tr>`)
    .join('');

  const urlParts = describeUrl(response.finalUrl)
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td class="mono">${escapeHtml(value)}</td></tr>`)
    .join('');

  panels.headers.innerHTML = `
    <div class="analysis">
      <h2>HTTP/${escapeHtml(response.httpVersion)} ${response.statusCode} ${escapeHtml(response.statusMessage)}</h2>
      <p class="muted">URL cuối cùng sau redirect: <code>${escapeHtml(response.finalUrl)}</code></p>

      <h3>Thành phần của URL</h3>
      <table class="data">${urlParts}</table>

      <h3>Header response (${formatNumber(response.headers.length)})</h3>
      <table class="data">
        <tr><th>Tên</th><th>Giá trị</th></tr>
        ${rows || '<tr><td colspan="2">(không có header)</td></tr>'}
      </table>
    </div>`;
}

function describeUrl(href) {
  try {
    const url = new URL(href);
    return [
      ['URL đầy đủ', url.href],
      ['Protocol', url.protocol.replace(':', '')],
      ['Host', url.host],
      ['Port', url.port || '(mặc định)'],
      ['Path', url.pathname || '/'],
      ['Query', url.search || '(không có)'],
      ['Ref (fragment)', url.hash || '(không có)'],
      ['User info', url.username ? `${url.username}:***` : '(không có)'],
    ];
  } catch {
    return [['URL', href]];
  }
}

function renderLog(result) {
  logText.textContent = result.log.join('\n');
}

/**
 * Gợi ý khi response là lỗi hay gặp lúc làm bài.
 *  - 405: server không nhận method đó ở URL đó (trang tĩnh chỉ nhận GET/HEAD).
 *  - 404: sai đường dẫn.
 * Con số phân tích vẫn đúng, nhưng là thống kê của trang lỗi — nói rõ để khỏi hiểu nhầm.
 */
function buildStatusNote(result) {
  const { response } = result;
  const method = escapeHtml(result.request.method);

  if (response.statusCode === 405) {
    const allow = response.headers.find((item) => item.name.toLowerCase() === 'allow');
    const allowText = allow ? `<code>${escapeHtml(allow.value)}</code>` : '(server không gửi header Allow)';
    return `<div class="note">
      <strong>405 Method Not Allowed</strong> — server không chấp nhận method
      <code>${method}</code> ở URL này. Header <code>Allow</code> cho biết server chỉ nhận:
      ${allowText}. Trang tĩnh chỉ phục vụ GET/HEAD; muốn thử POST thành công, dùng
      <code>/demo/echo</code> (chip “POST form”). Các con số bên dưới vẫn đúng — nhưng chúng là
      thống kê của <em>trang báo lỗi 405</em>, không phải trang bạn định lấy.
    </div>`;
  }

  if (response.statusCode === 404) {
    return `<div class="note">
      <strong>404 Not Found</strong> — không có tài nguyên ở đường dẫn này, nên phần phân tích bên dưới
      là thống kê của <em>trang báo lỗi</em> do server trả về.
    </div>`;
  }

  return '';
}

function renderResult(result) {
  lastResult = result;
  renderPreview(result);
  renderSource(result);
  renderAnalysis(result);
  renderHeaders(result);
  renderLog(result);

  // Chèn gợi ý khi server trả mã lỗi mà sinh viên hay hỏi (405, 404).
  const note = buildStatusNote(result);
  if (note) {
    panels.analysis.innerHTML = note + panels.analysis.innerHTML;
  }

  const { response } = result;
  setStatus(
    `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`,
    `${formatNumber(response.byteLength)} byte · ${formatNumber(result.timeMs)} ms · ${result.request.method}`,
  );

  const targetTab = preferredTab || (result.request.method === 'HEAD' ? 'headers' : 'preview');
  preferredTab = null;
  switchTab(targetTab);
}

function renderError(message, log) {
  setStatus(message, '', true);
  panels.analysis.innerHTML = `<div class="error-box">${escapeHtml(message)}</div>`;
  panels.preview.innerHTML = '';
  showEmpty(panels.preview, 'Không lấy được tài nguyên', message);
  logText.textContent = (log || []).join('\n');
  switchTab('analysis');
}

// ------------------------------------------------------------------ hành động

async function sendRequest() {
  if (controller) {
    return;
  }
  const method = currentMethod;
  const url = absoluteUrl(urlInput.value);
  if (!url) {
    setStatus('Hãy nhập URL', '', true);
    urlInput.focus();
    return;
  }
  urlInput.value = url;

  const payload = { url, method };
  if (method === 'POST') {
    payload.data = postData.value;
  }

  controller = new AbortController();
  setBusy(true);
  setStatus('Đang gửi yêu cầu...', `${method} ${url}`);

  try {
    const response = await fetch('/api/fetch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Ngrok free chèn trang cảnh báo HTML cho request trông giống trình duyệt.
        // Header này bỏ qua trang đó để API luôn nhận được JSON.
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    // Không dùng response.json() trực tiếp: khi server/tunnel có sự cố, response có thể
    // là trang HTML (ví dụ ERR_NGROK_3200), và JSON.parse sẽ ném "unexpected character".
    const raw = await response.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      renderError(describeBadResponse(response, raw), []);
      return;
    }

    if (!response.ok) {
      renderError(data.error || `Lỗi ${response.status}`, data.log);
      return;
    }
    renderResult(data);
  } catch (error) {
    if (error.name === 'AbortError') {
      setStatus('Đã huỷ yêu cầu', '', false);
      return;
    }
    renderError(
      `Không kết nối được tới server của web app (${error.message}).\n`
      + '• Server đã chạy chưa? Mở terminal và chạy ./start.sh\n'
      + '• Nếu đang dùng ngrok: tunnel còn sống không? Chạy ./ngrok.sh',
      [],
    );
  } finally {
    controller = null;
    setBusy(false);
  }
}

/** Giải thích response không phải JSON (thường là trang lỗi HTML của ngrok hoặc proxy). */
function describeBadResponse(response, raw) {
  const contentType = response.headers.get('content-type') || '(không rõ)';
  const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 220);

  if (/ERR_NGROK_3200|endpoint .* is offline/i.test(raw)) {
    return 'Tunnel ngrok đang offline (ERR_NGROK_3200).\n'
      + 'Server Node hoặc tiến trình ngrok đã dừng.\n'
      + '• Chạy lại ./start.sh ở terminal thứ nhất\n'
      + '• Chạy lại ./ngrok.sh ở terminal thứ hai\n'
      + '• Rồi tải lại trang này.';
  }

  return `Server trả về ${response.status} ${response.statusText} nhưng không phải JSON.\n`
    + `Content-Type: ${contentType}\n`
    + `Nội dung nhận được: ${snippet || '(rỗng)'}`;
}

function stopRequest() {
  if (controller) {
    controller.abort();
  }
}

// ------------------------------------------------------------------ sự kiện

for (const button of methodButtons) {
  button.addEventListener('click', () => {
    setMethod(button.dataset.method);
    if (currentMethod === 'POST') {
      postData.focus();
    }
  });
}

sendButton.addEventListener('click', sendRequest);
stopButton.addEventListener('click', stopRequest);

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendRequest();
  }
});

postData.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendRequest();
  }
});

for (const tab of tabs) {
  tab.addEventListener('click', () => switchTab(tab.dataset.panel));
}

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    const target = chip.dataset.url;
    urlInput.value = target.startsWith('/')
      ? new URL(target, window.location.origin).href
      : target;
    setMethod(chip.dataset.method || 'GET');
    sendRequest();
  });
}

// Khởi động: URL mặc định trỏ đúng origin hiện tại (localhost hay domain ngrok).
// Hỗ trợ deep link để chia sẻ một yêu cầu:
//   /?url=https://vku.udn.vn&method=GET&send=1&tab=analysis
const params = new URLSearchParams(window.location.search);

if (params.get('method')) {
  setMethod(params.get('method').toUpperCase());
}

if (params.get('data')) {
  postData.value = params.get('data');
}

urlInput.value = params.get('url') || new URL('/demo/index.html', window.location.origin).href;

// Đồng bộ trạng thái nút phương thức với biến currentMethod.
setMethod(currentMethod);

if (params.get('tab')) {
  preferredTab = params.get('tab');
  switchTab(preferredTab);
}

if (params.get('send') === '1') {
  sendRequest();
} else {
  setStatus('Sẵn sàng', 'Nhập URL rồi bấm Gửi yêu cầu (Enter cũng được)');
}
