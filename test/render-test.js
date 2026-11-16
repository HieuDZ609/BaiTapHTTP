'use strict';

/**
 * Kiểm thử phần lọc HTML và các bộ dựng trang (không cần server, không cần mạng).
 * Chạy: node test/render-test.js
 */

const render = require('../lib/render');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

console.log('Lọc HTML');

const dirty = `<!DOCTYPE html><html><head>
<base href="https://evil.example/">
<meta http-equiv="refresh" content="0; url=https://evil.example">
<title>Bài thử</title>
</head><body onload="alert('x')">
<script>alert('xss')</script>
<a href="javascript:alert(1)">bấm</a>
<img src="data:image/gif;base64,R0lGOD" data-src="/anh/that.jpg" loading="lazy">
<img src="/ok.jpg" onerror="alert(1)">
<form action="/tim"><input name="q"></form>
</body></html>`;

const clean = render.sanitizeHtml(dirty, 'https://tuoitre.vn/bai-viet.htm');

check('bỏ thẻ <script>', !clean.includes("alert('xss')"));
check('bỏ thuộc tính onload/onerror', !/onload=|onerror=/i.test(clean));
check('bỏ href javascript:', !/href="javascript:/i.test(clean));
check('bỏ meta refresh', !/http-equiv="refresh"/i.test(clean));
check('bỏ <base> cũ', !clean.includes('evil.example'));
check('chèn <base> mới', clean.includes('<base href="https://tuoitre.vn/bai-viet.htm">'));
check('ảnh lazy lấy data-src', clean.includes('src="/anh/that.jpg"'));
check('không còn src rỗng cũ', !clean.includes('data:image/gif'));
check('bỏ loading="lazy"', !/loading="lazy"/i.test(clean));
check('chèn script điều hướng', clean.includes("type: 'navigate'"));

console.log('\nYouTube');

check('nhận watch?v=', render.parseYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.id === 'dQw4w9WgXcQ');
check('nhận youtu.be', render.parseYouTube('https://youtu.be/dQw4w9WgXcQ')?.id === 'dQw4w9WgXcQ');
check('nhận /shorts/', render.parseYouTube('https://www.youtube.com/shorts/abc123XYZ_-')?.id === 'abc123XYZ_-');
check('nhận trang tìm kiếm', render.parseYouTube('https://www.youtube.com/results?search_query=nhac')?.kind === 'search');
check('nhận trang chủ', render.parseYouTube('https://www.youtube.com/')?.kind === 'page');
check('bỏ qua trang khác', render.parseYouTube('https://tuoitre.vn/') === null);

const player = render.youtubePlayerPage('dQw4w9WgXcQ');
check('trang phát video dùng /embed/', player.includes('youtube.com/embed/dQw4w9WgXcQ'));

console.log('\nTìm kiếm');

const ddg = `
<div class="result results_links web-result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftuoitre.vn%2F&rut=x">Báo Tuổi Trẻ</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftuoitre.vn%2F">Tin tức mới nhất</a>
</div>
<div class="result results_links web-result">
  <a rel="nofollow" class="result__a" href="https://vnexpress.net/">VnExpress</a>
  <a class="result__snippet">Báo điện tử</a>
</div>`;
const results = render.parseSearchResults(ddg);
check('lấy được 2 kết quả', results.length === 2, JSON.stringify(results));
check('giải mã link duckduckgo', results[0]?.url === 'https://tuoitre.vn/');
check('lấy tiêu đề', results[0]?.title === 'Báo Tuổi Trẻ');
check('lấy mô tả', results[0]?.description === 'Tin tức mới nhất');
check('giữ link trực tiếp', results[1]?.url === 'https://vnexpress.net/');
check('searchUrl dùng DuckDuckGo HTML', render.searchUrl('a b').startsWith('https://html.duckduckgo.com/html/?q=a%20b'));

console.log('\nTrang lỗi & nhị phân');

const error = render.errorPage('Không tải được', 'Lỗi mạng', 'chi tiết', 'https://x.test/');
check('trang lỗi có meta ok=false', error.includes('"ok":false'));
check('trang lỗi thoát HTML an toàn', !error.includes('<script>alert'));

const binary = render.binaryPage({
  finalUrl: 'https://x.test/anh.png',
  contentType: 'image/png',
  byteLength: 1234,
});
check('trang nhị phân có nút tải xuống', binary.includes('/api/raw?url='));
check('trang nhị phân hiện ảnh', binary.includes('<img'));

console.log(`\nKết quả: ${passed} đạt, ${failed} lỗi`);
process.exit(failed === 0 ? 0 : 1);
