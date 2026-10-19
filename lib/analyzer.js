'use strict';

/**
 * Phân tích HTML theo yêu cầu của đề bài:
 *  - chiều dài trang;
 *  - số lượng tag <p>, <div>, <span>, <img>.
 *
 * Hai cái bẫy khi đếm:
 *  1. Tag có attribute: <p class="intro"> — không thể chỉ tìm chuỗi "<p>".
 *  2. Chuỗi "<div>" nằm trong <script>, <style> hoặc comment HTML không phải tag
 *     thật, phải loại bỏ trước khi đếm.
 */

const REQUIRED_TAGS = ['p', 'div', 'span', 'img'];
const EXTRA_TAGS = [
  'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'tr', 'td', 'th', 'li', 'ul', 'ol',
  'form', 'input', 'button', 'script', 'style', 'link', 'meta',
];

const COMMENT = /<!--[\s\S]*?-->/g;
const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const STYLE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;

/** Bỏ comment, script, style để tránh đếm nhầm. */
function stripNoise(html) {
  return String(html)
    .replace(COMMENT, ' ')
    .replace(SCRIPT, ' ')
    .replace(STYLE, ' ');
}

/**
 * Đếm số lần mở tag <name>, kể cả khi có attribute hoặc tự đóng.
 * Lookahead ngăn <p> khớp nhầm vào <pre>.
 */
function countTag(html, tagName) {
  const pattern = new RegExp(`<${tagName}(?=[\\s/>])`, 'gi');
  return (html.match(pattern) || []).length;
}

function attribute(tagText, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(tagText);
  if (!match) {
    return null;
  }
  return match[2] ?? match[3] ?? match[4] ?? null;
}

function collect(html, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  return html.match(pattern) || [];
}

function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return match ? decodeEntities(match[1].trim()) : null;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * @param {string} html nội dung đã decode
 * @param {number} byteLength số byte nhận từ mạng (trước khi decode)
 */
function analyze(html, byteLength) {
  const source = html == null ? '' : String(html);
  const cleaned = stripNoise(source);

  const counts = {};
  for (const tag of REQUIRED_TAGS) {
    counts[tag] = { count: countTag(cleaned, tag), required: true };
  }
  for (const tag of EXTRA_TAGS) {
    counts[tag] = { count: countTag(cleaned, tag), required: false };
  }

  const images = collect(cleaned, 'img').map((tag) => attribute(tag, 'src') || '(không có src)');
  const links = collect(cleaned, 'a')
    .map((tag) => attribute(tag, 'href'))
    .filter((href) => href !== null);

  return {
    title: extractTitle(source),
    characterLength: source.length,
    byteLength: Number.isFinite(byteLength) ? byteLength : Buffer.byteLength(source, 'utf8'),
    utf8ByteLength: Buffer.byteLength(source, 'utf8'),
    lineCount: source ? source.split('\n').length : 0,
    counts,
    images,
    links,
    requiredTags: REQUIRED_TAGS,
  };
}

module.exports = { analyze, countTag, stripNoise, REQUIRED_TAGS, EXTRA_TAGS };
