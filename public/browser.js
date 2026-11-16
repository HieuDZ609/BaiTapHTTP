'use strict';


const el = {
  frame: document.getElementById('frame'),
  home: document.getElementById('home'),
  tabTitle: document.getElementById('tab-title'),
  tabFavicon: document.getElementById('tab-favicon'),
  tabSpinner: document.getElementById('tab-spinner'),
  address: document.getElementById('address'),
  addressForm: document.getElementById('address-form'),
  addrIcon: document.getElementById('addr-icon'),
  clearBtn: document.getElementById('btn-clear'),
  methodSelect: document.getElementById('method'),
  body: document.getElementById('body'),
  bodyBar: document.getElementById('bodybar'),
  back: document.getElementById('btn-back'),
  forward: document.getElementById('btn-forward'),
  reload: document.getElementById('btn-reload'),
  homeBtn: document.getElementById('btn-home'),
  historyBtn: document.getElementById('btn-history'),
  external: document.getElementById('btn-external'),
  progress: document.getElementById('progress'),
  historyPop: document.getElementById('history-pop'),
  historyList: document.getElementById('history-list'),
  clearHistory: document.getElementById('clear-history'),
  historyOffNote: document.getElementById('history-off-note'),
  historyToggle: document.getElementById('history-toggle'),
  historyState: document.getElementById('history-state'),
  historyClear: document.getElementById('history-clear'),
  homeForm: document.getElementById('home-form'),
  homeInput: document.getElementById('home-input'),
  quickLinks: document.getElementById('quick-links'),
  lab: document.getElementById('lab'),
  labBtn: document.getElementById('btn-lab'),
  labClose: document.getElementById('lab-close'),
  labUrl: document.getElementById('lab-url'),
  labBody: document.getElementById('lab-body'),
  labTabs: [...document.querySelectorAll('.lab-tab')],
};

const HISTORY_KEY = 'httpbrowser.history.v2';
const HISTORY_SETTING_KEY = 'httpbrowser.history.enabled';
const MAX_HISTORY = 200;
const LOAD_TIMEOUT_MS = 35000;

const state = {
  stack: [],
  index: -1,
  current: null,
  loadToken: 0,
  loadTimer: null,
  homeVisible: true,
  labOpen: false,
  labTab: 'analysis',
  labFor: null,
  labData: null,
  sourceCache: new Map(),
};

let historyEntries = loadHistory();
let historyEnabled = loadHistorySetting();

// ------------------------------------------------------------------ tiện ích

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((item) => item && item.url) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(historyEntries.slice(0, MAX_HISTORY)));
  } catch {
    /* trình duyệt chặn localStorage thì bỏ qua */
  }
}

/** Công tắc "Ghi lịch sử" — lưu riêng, không xoá dữ liệu đã có khi tắt. */
function loadHistorySetting() {
  try {
    return localStorage.getItem(HISTORY_SETTING_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveHistorySetting() {
  try {
    localStorage.setItem(HISTORY_SETTING_KEY, historyEnabled ? '1' : '0');
  } catch {
    /* trình duyệt chặn localStorage thì bỏ qua */
  }
}

function searchUrl(query) {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=vn`;
}

/** Quyết định người dùng nhập URL hay từ khoá tìm kiếm. */
function resolveInput(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return null;
  }
  if (/^https?:\/\//i.test(text)) {
    return { url: text, kind: 'url' };
  }
  if (text.startsWith('/')) {
    return { url: `${location.origin}${text}`, kind: 'url' };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    return { url: text, kind: 'url' };
  }

  const hostPart = text.split('/')[0];
  const isLocal = /^localhost(:\d+)?$/i.test(hostPart)
    || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(hostPart);
  const isDomain = /^[\w-]+(\.[\w-]+)+(:\d+)?$/i.test(hostPart);

  if (!/\s/.test(text) && (isDomain || isLocal)) {
    return { url: `${isLocal ? 'http' : 'https'}://${text}`, kind: 'url' };
  }
  return { url: searchUrl(text), kind: 'search', query: text };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function faviconFor(url) {
  const host = hostOf(url);
  if (!host) {
    return '🌐';
  }
  if (host.includes('youtube')) {
    return '▶';
  }
  if (host.includes('duckduckgo')) {
    return '🔍';
  }
  if (host.includes('tuoitre')) {
    return '📰';
  }
  if (host.includes('vnexpress')) {
    return '📰';
  }
  if (host.includes('github')) {
    return '🐙';
  }
  if (host.includes('wikipedia')) {
    return '📚';
  }
  return '🌐';
}

function formatTime(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) {
    return 'vừa xong';
  }
  if (diff < 60 * 60 * 1000) {
    return `${Math.floor(diff / 60000)} phút trước`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / 3600000)} giờ trước`;
  }
  const date = new Date(timestamp);
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// -------------------------------------------------------------- trạng thái UI

function setLoading(loading) {
  el.progress.hidden = !loading;
  el.tabSpinner.hidden = !loading;
  el.reload.classList.toggle('spinning', loading);

  clearTimeout(state.loadTimer);
  if (loading) {
    state.loadTimer = setTimeout(() => {
      setLoading(false);
      setTabTitle('Tải quá lâu — thử lại', '⏱');
    }, LOAD_TIMEOUT_MS);
  }
}

function setTabTitle(title, favicon) {
  el.tabTitle.textContent = title || 'Trang mới';
  el.tabTitle.title = title || '';
  el.tabFavicon.textContent = favicon || '🌐';
  document.title = title ? `${title} — Trình duyệt HTTP` : 'Trình duyệt HTTP — Bài 7';
}

function updateNavButtons() {
  el.back.disabled = state.index <= 0 && !state.homeVisible;
  el.forward.disabled = state.index >= state.stack.length - 1;
  if (state.homeVisible) {
    el.back.disabled = state.stack.length === 0;
    el.forward.disabled = state.index >= state.stack.length - 1;
  }
}

function setAddressIcon(value) {
  const looksLikeUrl = /^https?:\/\//i.test(value) || /^[\w-]+(\.[\w-]+)+/.test(value);
  el.addrIcon.textContent = looksLikeUrl ? '🌐' : '🔍';
}

// ----------------------------------------------------------------- điều hướng

function navigate(input, options = {}) {
  const target = typeof input === 'string'
    ? resolveInput(input)
    : input;
  if (!target || !target.url) {
    return;
  }
  if (!/^https?:\/\//i.test(target.url)) {
    setTabTitle('Chỉ hỗ trợ http:// và https://', '⚠');
    return;
  }

  const method = target.kind === 'search'
    ? 'GET'
    : (options.method || 'GET').toUpperCase();
  const data = method === 'POST'
    ? String(options.data != null ? options.data : el.body.value)
    : '';
  const baseTitle = target.kind === 'search' ? `Tìm: ${target.query}` : hostOf(target.url) || target.url;
  const title = method === 'GET' ? baseTitle : `${method} · ${baseTitle}`;

  hideHome();
  el.frame.hidden = false;
  el.address.value = target.url;
  setAddressIcon(target.url);
  el.clearBtn.hidden = !target.url;
  el.external.href = target.url;
  el.external.hidden = false;

  state.current = { url: target.url, title, method, data, meta: null };
  setTabTitle(title, target.kind === 'search' ? '🔍' : faviconFor(target.url));

  if (options.push !== false) {
    state.stack = state.stack.slice(0, state.index + 1);
    state.stack.push({ url: target.url, title, method, data });
    state.index = state.stack.length - 1;
  }
  updateNavButtons();

  state.loadToken += 1;
  const token = state.loadToken;
  setLoading(true);

  const params = new URLSearchParams({ url: target.url });
  if (method !== 'GET') {
    params.set('method', method);
  }
  if (method === 'POST' && data) {
    params.set('data', data);
  }
  if (options.bust) {
    params.set('r', String(Date.now()));
  }

  // Gán src sau một nhịp để sự kiện load cũ không đè lên lần điều hướng mới.
  el.frame.src = `/view?${params.toString()}`;
  el.frame.dataset.token = String(token);
}

function hideHome() {
  state.homeVisible = false;
  el.home.hidden = true;
  el.frame.hidden = false;
}

function showHome() {
  state.homeVisible = true;
  state.current = null;
  state.loadToken += 1;
  el.frame.hidden = true;
  el.frame.src = 'about:blank';
  el.home.hidden = false;
  el.address.value = '';
  el.clearBtn.hidden = true;
  el.addrIcon.textContent = '🔍';
  el.external.hidden = true;
  setTabTitle('Trang mới', '🌐');
  setLoading(false);
  updateNavButtons();
  closeHistory();
  el.homeInput.focus();
}

function goBack() {
  if (state.homeVisible) {
    if (state.stack.length && state.index >= 0) {
      navigate(state.stack[state.index].url, entryOptions(state.stack[state.index]));
    }
    return;
  }
  if (state.index > 0) {
    state.index -= 1;
    navigate(state.stack[state.index].url, entryOptions(state.stack[state.index]));
  }
}

function goForward() {
  if (state.index < state.stack.length - 1) {
    state.index += 1;
    hideHome();
    navigate(state.stack[state.index].url, entryOptions(state.stack[state.index]));
  }
}

function entryOptions(entry) {
  return {
    push: false,
    method: entry.method || 'GET',
    data: entry.data || '',
  };
}

function reload() {
  if (!state.current) {
    return;
  }
  navigate(state.current.url, {
    push: false,
    bust: true,
    method: state.current.method || 'GET',
    data: state.current.data || '',
  });
}

// --------------------------------------------------------------- load trong frame

el.frame.addEventListener('load', () => {
  if (state.homeVisible) {
    return;
  }
  const token = Number(el.frame.dataset.token || 0);
  if (token !== state.loadToken) {
    return;
  }
  setLoading(false);

  let meta = null;
  try {
    const doc = el.frame.contentDocument;
    if (doc) {
      const node = doc.getElementById('httpbrowser-meta');
      if (node) {
        meta = JSON.parse(node.textContent);
      } else {
        meta = {
          ok: true,
          url: el.frame.contentWindow.location.href,
          title: doc.title || state.current?.title,
        };
      }
      el.frame.contentWindow.scrollTo(0, 0);
    }
  } catch {
    meta = null;
  }

  if (!meta) {
    return;
  }

  const finalUrl = meta.url || state.current?.url || '';
  const title = meta.title || hostOf(finalUrl) || finalUrl;
  const favicon = faviconFor(finalUrl);

  if (state.current) {
    state.current.meta = meta;
    state.current.url = finalUrl;
    state.current.title = title;

    const entry = state.stack[state.index];
    if (entry) {
      entry.url = finalUrl;
      entry.title = title;
    }

    el.address.value = finalUrl;
    el.external.href = finalUrl;
    setAddressIcon(finalUrl);
  }

  setTabTitle(meta.ok === false ? (meta.error || title) : title, meta.ok === false ? '⚠' : favicon);

  if (meta.ok !== false && state.current?.method === 'GET') {
    addHistory(finalUrl, title);
  }

  if (state.labOpen && finalUrl) {
    loadLab(finalUrl, state.current?.method || 'GET', state.current?.data || '');
  }
  updateNavButtons();
});

function addHistory(url, title) {
  if (!historyEnabled || !url || /^about:/i.test(url)) {
    return;
  }
  // Tạo id duy nhất: kết hợp timestamp + ngắn URL (tránh trùng lặp)
  const newId = `h_${Date.now()}_${btoa(url).slice(0, 8).replace(/=/g, '')}`;

  // Lọc: giữ lại các entry khác url này (tránh trùng)
  historyEntries = historyEntries.filter((item) => item.url !== url || item.id !== newId);

  historyEntries.unshift({
    id: newId,
    url,
    title: title || url,
    ts: Date.now(),
    method: state.current?.method || 'GET'
  });
  if (historyEntries.length > MAX_HISTORY) {
    historyEntries.length = MAX_HISTORY;
  }
  saveHistory();
  // Đồng bộ lên server DB (không chờ lỗi làm treo UI)
  fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: newId, url, title: title || url, method: state.current?.method || 'GET' })
  }).catch(() => {});   // ignored
  // Sắp xếp lại theo id giảm dần (mới nhất lên đầu) sau khi thêm
  historyEntries.sort((a, b) => (b.id || 0) - (a.id || 0));
  renderHistory();
}

// -------------------------------------------------------------------- lịch sửr

function renderHistory() {
  // Ưu tiên lấy từ DB server
  fetch('/api/history')
    .then((r) => r.json())
    .then((db) => {
      const dbHistory = db.history || [];
      if (dbHistory.length > 0) {
        // Render bảng table từ DB
        let rows = '';
        dbHistory.slice(0, 20).forEach((entry, i) => {
          const urlPreview = entry.url.length > 50 ? entry.url.substring(0, 47) + '...' : entry.url;
          rows += `
            <tr>
              <td style="padding:6px; font-family:Cascadia Code, monospace; font-size:12px; color:#2a3833; white-space:nowrap;" title="${escapeHtml(entry.url)}">${escapeHtml(urlPreview)}</td>
              <td style="padding:6px; font-size:12px; color:#5b6570;">${escapeHtml(entry.method)}</td>
              <td style="padding:6px; font-size:11px; color:#8a9793;">${escapeHtml(new Date(entry.addedAt).toLocaleString())}</td>
            </tr>`;
        });
        el.historyList.innerHTML = `<table style="width:100%; border-collapse:collapse; margin-top:8px;">
          <thead>
            <tr style="border-bottom:1px solid var(--line);">
              <th style="padding:6px; color:var(--muted); font-size:12px;">URL</th>
              <th style="padding:6px; color:var(--muted); font-size:12px;">Method</th>
              <th style="padding:6px; color:var(--muted); font-size:12px;">Thêm lúc</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
        return;
      }
    })
    .catch(() => {})
    // Fallback: nếu DB rỗng hoặc lỗi, hiển thị localStorage
    if (!historyEntries.length) {
      el.historyList.innerHTML = '<p class="history-empty">Chưa có trang nào được xem.</p>';
      // Dừng refresh nếu đang chạy
      if (historyRefreshId) {
        clearInterval(historyRefreshId);
        historyRefreshId = null;
      }
      return;
    }
    // Render localStorage dạng table
    let lsRows = '';
    historyEntries.slice(0, 20).forEach((entry) => {
      lsRows += `
        <tr>
          <td style="padding:6px; font-family:Cascadia Code, monospace; font-size:12px; color:#2a3833; white-space:nowrap;" title="${escapeHtml(entry.url)}">${escapeHtml(entry.url.substring(0, 40) + (entry.url.length > 40 ? '...' : ''))}</td>
          <td style="padding:6px; font-size:12px; color:#5b6570;">GET</td>
          <td style="padding:6px; font-size:11px; color:#8a9793;">${escapeHtml(formatTime(entry.ts || Date.now()))}</td>
        </tr>`;
    });
    el.historyList.innerHTML = `<table style="width:100%; border-collapse:collapse; margin-top:8px;">
      <thead>
        <tr style="border-bottom:1px solid var(--line);">
          <th style="padding:6px; color:var(--muted); font-size:12px;">URL</th>
          <th style="padding:6px; color:var(--muted); font-size:12px;">Method</th>
          <th style="padding:6px; color:var(--muted); font-size:12px;">Thêm lúc</th>
        </tr>
      </thead>
      <tbody>${lsRows}</tbody>
    </table>`;
}

let historyRefreshId = null;
function openHistory() {
  el.historyPop.hidden = false;
  renderHistory();
  // Tự động refresh mỗi 3s
  if (!historyRefreshId) {
    historyRefreshId = setInterval(() => {
      renderHistory();
    }, 3000);
  }
}

function closeHistory() {
  el.historyPop.hidden = true;
  if (historyRefreshId) {
    clearInterval(historyRefreshId);
    historyRefreshId = null;
  }
}

el.historyBtn.addEventListener('click', () => {
  if (el.historyPop.hidden) {
    openHistory();
  } else {
    closeHistory();
  }
});

el.historyList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-url]');
  if (!button) {
    return;
  }
  closeHistory();
  navigate(button.dataset.url);
});

function clearAllHistory() {
  // 1. Gọi API xóa dữ liệu trên server (DB cục bộ)
  fetch('/api/history', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }
  })
    .then((r) => r.json())
    .then(() => {
      // 2. Sau khi API xong, xóa bộ nhớ cục bộ
      historyEntries = [];
      saveHistory();
      renderHistory();
    })
    .catch(() => {
      // Nếu API thất bại (server tắt...), vẫn xóa local để UI không kẹt
      historyEntries = [];
      saveHistory();
      renderHistory();
    });
}

/** Đồng bộ giao diện: công tắc, nhãn trạng thái, nút 🕘 và ghi chú trong popup. */
function applyHistorySetting() {
  el.historyToggle.checked = historyEnabled;
  el.historyState.textContent = historyEnabled ? 'Đang ghi' : 'Đang tắt';
  el.historyState.classList.toggle('off', !historyEnabled);
  el.historyBtn.classList.toggle('off', !historyEnabled);
  el.historyBtn.title = historyEnabled
    ? 'Lịch sử đã xem'
    : 'Lịch sử đang tắt — bật lại trong Bài lab';
  el.historyOffNote.hidden = historyEnabled;
}

el.historyToggle.addEventListener('change', () => {
  historyEnabled = el.historyToggle.checked;
  saveHistorySetting();
  applyHistorySetting();
});

el.clearHistory.addEventListener('click', clearAllHistory);
el.historyClear.addEventListener('click', clearAllHistory);

// Công tắc bị đổi ở tab khác thì tab này cũng theo.
window.addEventListener('storage', (event) => {
  if (event.key === HISTORY_SETTING_KEY) {
    historyEnabled = loadHistorySetting();
    applyHistorySetting();
  }
});

document.addEventListener('click', (event) => {
  if (!el.historyPop.hidden
      && !el.historyPop.contains(event.target)
      && !el.historyBtn.contains(event.target)) {
    closeHistory();
  }
});

// ---------------------------------------------------------------- thanh địa chỉ

el.addressForm.addEventListener('submit', (event) => {
  event.preventDefault();
  navigate(el.address.value, {
    method: el.methodSelect.value,
    data: el.body.value.trim(),
  });
  el.address.blur();
});

/** Hiện ô Body khi chọn POST, đổi placeholder cho hợp ngữ cảnh. */
function applyMethodUI() {
  const method = el.methodSelect.value;
  el.bodyBar.hidden = method !== 'POST';
  el.address.placeholder = method === 'POST'
    ? 'URL nhận POST, ví dụ /demo/echo…'
    : 'Tìm kiếm hoặc nhập URL…';
}

el.methodSelect.addEventListener('change', () => {
  applyMethodUI();
  if (el.methodSelect.value === 'POST' && !el.body.value) {
    el.body.focus();
  }
});

el.body.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  event.preventDefault();
  el.addressForm.requestSubmit();
});

el.address.addEventListener('input', () => {
  setAddressIcon(el.address.value);
  el.clearBtn.hidden = !el.address.value;
});

el.address.addEventListener('focus', () => {
  el.address.select();
});

el.clearBtn.addEventListener('click', () => {
  el.address.value = '';
  el.clearBtn.hidden = true;
  setAddressIcon('');
  el.address.focus();
});

// ---------------------------------------------------------------- trang chủ

el.homeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = el.homeInput.value.trim();
  if (value) {
    navigate(value);
  }
});

el.quickLinks.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-url]');
  if (!link) {
    return;
  }
  event.preventDefault();
  navigate(link.dataset.url);
});

// ------------------------------------------------------------- nút công cụ

el.back.addEventListener('click', goBack);
el.forward.addEventListener('click', goForward);
el.reload.addEventListener('click', reload);
el.homeBtn.addEventListener('click', showHome);

// ------------------------------------------------------------------ bài lab

function openLab() {
  state.labOpen = true;
  el.lab.hidden = false;
  el.labBtn.classList.add('active');
  if (state.current) {
    loadLab(state.current.url, state.current.method, state.current.data);
  } else {
    el.labBody.innerHTML = '<div class="lab-empty">Hãy mở một trang web trước, rồi bấm lại nút này để xem phân tích.</div>';
    el.labUrl.textContent = '';
  }
}

function closeLab() {
  state.labOpen = false;
  el.lab.hidden = true;
  el.labBtn.classList.remove('active');
}

el.labBtn.addEventListener('click', () => {
  if (state.labOpen) {
    closeLab();
  } else {
    openLab();
  }
});

el.labClose.addEventListener('click', closeLab);

for (const tab of el.labTabs) {
  tab.addEventListener('click', () => {
    state.labTab = tab.dataset.lab;
    for (const item of el.labTabs) {
      item.classList.toggle('active', item === tab);
    }
    if (state.labTab === 'source') {
      loadLabSource();
    } else {
      renderLab();
    }
  });
}

async function loadLab(url, method = 'GET', requestData = '') {
  if (!url) {
    return;
  }
  state.labFor = url;
  state.labData = null;
  state.sourceCache.delete(url);
  el.labUrl.textContent = method === 'GET' ? url : `${method} ${url}`;

  if (state.labTab === 'source') {
    loadLabSource();
    return;
  }

  el.labBody.innerHTML = '<div class="lab-empty">Đang tải dữ liệu phân tích…</div>';
  try {
    const payload = { url, method };
    if (method === 'POST' && requestData) {
      payload.data = requestData;
    }
    const response = await fetch('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (state.labFor !== url) {
      return;
    }
    if (!response.ok) {
      throw new Error(data.error || `Lỗi ${response.status}`);
    }
    state.labData = data;
    renderLab();
  } catch (error) {
    if (state.labFor === url) {
      el.labBody.innerHTML = `<div class="lab-error">${escapeHtml(error.message)}</div>`;
    }
  }
}

function renderLab() {
  if (state.labTab === 'source') {
    loadLabSource();
    return;
  }
  const data = state.labData;
  if (!data) {
    el.labBody.innerHTML = '<div class="lab-empty">Chưa có dữ liệu.</div>';
    return;
  }

  if (state.labTab === 'analysis') {
    renderLabAnalysis(data);
  } else if (state.labTab === 'headers') {
    renderLabHeaders(data);
  } else if (state.labTab === 'log') {
    el.labBody.innerHTML = `<pre class="code">${escapeHtml((data.log || []).join('\n'))}</pre>`;
  }
}

function renderLabAnalysis(data) {
  const response = data.response;
  const analysis = data.analysis;

  if (!analysis) {
    el.labBody.innerHTML = `
      <h2 class="lab-heading">Không có HTML để phân tích</h2>
      <p class="lab-sub">${escapeHtml(data.request?.method || 'GET')} · ${escapeHtml(response.contentType || 'không rõ Content-Type')}</p>
      <table class="data">
        <tr><th>Status</th><td class="mono">${response.statusCode} ${escapeHtml(response.statusMessage)}</td></tr>
        <tr><th>Số byte</th><td>${response.byteLength.toLocaleString('vi-VN')}</td></tr>
      </table>`;
    return;
  }

  const required = analysis.requiredTags.map((tag) => `
    <li class="tag-card">
      <span class="name">&lt;${tag}&gt;</span>
      <span class="value">${analysis.counts[tag].count.toLocaleString('vi-VN')}</span>
    </li>`).join('');

  const other = Object.entries(analysis.counts)
    .filter(([, info]) => !info.required && info.count > 0)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 12)
    .map(([tag, info]) => `<tr><td class="mono">&lt;${tag}&gt;</td><td>${info.count}</td></tr>`)
    .join('');

  el.labBody.innerHTML = `
    <h2 class="lab-heading">${escapeHtml(analysis.title || '(không có tiêu đề)')}</h2>
    <p class="lab-sub">${escapeHtml(response.finalUrl)}</p>
    <div class="lab-pills">
      <span class="lab-pill"><strong>${escapeHtml(data.request?.method || 'GET')}</strong></span>
      <span class="lab-pill">Chiều dài: <strong>${analysis.characterLength.toLocaleString('vi-VN')}</strong> ký tự</span>
      <span class="lab-pill"><strong>${response.byteLength.toLocaleString('vi-VN')}</strong> byte</span>
      <span class="lab-pill"><strong>${analysis.lineCount.toLocaleString('vi-VN')}</strong> dòng</span>
      <span class="lab-pill"><strong>${data.timeMs}</strong> ms</span>
    </div>

    <h3>Tag đề bài yêu cầu</h3>
    <ul class="tag-grid">${required}</ul>

    ${other ? `<h3>Tag khác</h3><table class="data">${other}</table>` : ''}

    <h3>Thông tin response</h3>
    <table class="data">
      <tr><th>Status</th><td class="mono">HTTP/${escapeHtml(response.httpVersion)} ${response.statusCode} ${escapeHtml(response.statusMessage)}</td></tr>
      <tr><th>Content-Type</th><td class="mono">${escapeHtml(response.contentType || '(không có)')}</td></tr>
      <tr><th>Charset</th><td class="mono">${escapeHtml(response.charset || '(không rõ)')}</td></tr>
      <tr><th>Số header</th><td>${response.headers.length}</td></tr>
    </table>`;
}

function renderLabHeaders(data) {
  const response = data.response;
  const rows = response.headers
    .map((item) => `<tr><td class="mono">${escapeHtml(item.name)}</td><td class="mono">${escapeHtml(item.value)}</td></tr>`)
    .join('');

  let urlRows = '';
  try {
    const parsed = new URL(response.finalUrl);
    urlRows = [
      ['Method', data.request?.method || 'GET'],
      ['Protocol', parsed.protocol.replace(':', '')],
      ['Host', parsed.host],
      ['Path', parsed.pathname || '/'],
      ['Query', parsed.search || '(không có)'],
    ].map(([label, value]) => `<tr><th>${label}</th><td class="mono">${escapeHtml(value)}</td></tr>`).join('');
  } catch {
    urlRows = '';
  }

  el.labBody.innerHTML = `
    <h3>Thành phần URL</h3>
    <table class="data">${urlRows}</table>
    <h3>Header response (${response.headers.length})</h3>
    <table class="data">
      <tr><th>Tên</th><th>Giá trị</th></tr>
      ${rows || '<tr><td colspan="2">(không có)</td></tr>'}
    </table>`;
}

async function loadLabSource() {
  const url = state.labFor;
  if (!url) {
    el.labBody.innerHTML = '<div class="lab-empty">Chưa có trang nào.</div>';
    return;
  }
  if (state.sourceCache.has(url)) {
    el.labBody.innerHTML = `<pre class="code">${escapeHtml(state.sourceCache.get(url))}</pre>`;
    return;
  }

  el.labBody.innerHTML = '<div class="lab-empty">Đang tải mã nguồn…</div>';
  try {
    const response = await fetch(`/api/source?url=${encodeURIComponent(url)}`);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `Lỗi ${response.status}`);
    }
    state.sourceCache.set(url, text);
    if (state.labFor === url && state.labTab === 'source') {
      el.labBody.innerHTML = `<pre class="code">${escapeHtml(text)}</pre>`;
    }
  } catch (error) {
    if (state.labFor === url) {
      el.labBody.innerHTML = `<div class="lab-error">${escapeHtml(error.message)}</div>`;
    }
  }
}

// ------------------------------------------------------- thông điệp từ iframe

window.addEventListener('message', (event) => {
  if (event.source !== el.frame.contentWindow) {
    return;
  }
  const data = event.data || {};
  if (data.source !== 'httpbrowser') {
    return;
  }
  if (data.type === 'navigate' && data.url) {
    navigate(data.url);
  } else if (data.type === 'post' && data.url) {
    el.methodSelect.value = 'POST';
    el.body.value = data.data || '';
    applyMethodUI();
    navigate(data.url, { method: 'POST', data: data.data || '' });
  } else if (data.type === 'search' && data.query) {
    navigate(searchUrl(data.query));
  } else if (data.type === 'youtube' && data.query) {
    navigate(`https://www.youtube.com/results?search_query=${encodeURIComponent(data.query)}`);
  }
});

// --------------------------------------------------------------- phím tắt

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

  if (event.key === 'Escape') {
    closeHistory();
    if (state.labOpen) {
      closeLab();
    }
    if (typing) {
      document.activeElement.blur();
    }
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    el.address.focus();
    el.address.select();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    reload();
    return;
  }

  if (event.key === 'F5') {
    event.preventDefault();
    reload();
    return;
  }

  if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    goBack();
    return;
  }

  if (event.altKey && event.key === 'ArrowRight') {
    event.preventDefault();
    goForward();
    return;
  }

  if (!typing && event.key === '/') {
    event.preventDefault();
    el.address.focus();
  }
});

// ------------------------------------------------------------------ khởi động

renderHistory();
applyHistorySetting();
applyMethodUI();
el.homeInput.focus();
setTabTitle('Trang mới', '🌐');

// Hỗ trợ deep link để chia sẻ / kiểm tra nhanh: /?url=https://tuoitre.vn hoặc /?q=...
const bootParams = new URLSearchParams(location.search);
const bootUrl = bootParams.get('url');
const bootQuery = bootParams.get('q');
if (bootUrl) {
  navigate(bootUrl);
} else if (bootQuery) {
  navigate(bootQuery);
}
