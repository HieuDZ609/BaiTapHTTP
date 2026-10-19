'use strict';

/**
 * Kiểm thử API của web app bằng fetch có sẵn trong Node (>= 18).
 *
 * Chạy:  node test/api-test.js
 * Yêu cầu: server đang chạy ở http://localhost:3000 (hoặc đặt BASE_URL).
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

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

async function callApi(payload) {
  const response = await fetch(`${BASE}/api/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, data: await response.json() };
}

async function main() {
  console.log(`Kiểm thử API tại ${BASE}\n`);

  console.log('Sức khoẻ server');
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  check('/api/health trả ok', health && health.ok === true);
  if (!health) {
    console.log('\nServer chưa chạy. Hãy chạy ./start.sh trước.');
    process.exit(1);
  }

  console.log('\nGET');
  const getResult = await callApi({ url: `${BASE}/demo/index.html`, method: 'GET' });
  const counts = getResult.data.analysis ? getResult.data.analysis.counts : {};
  check('status 200', getResult.data.response?.statusCode === 200);
  check('phân tích HTML được trả về', Boolean(getResult.data.analysis));
  check('<p> = 7', counts.p?.count === 7, `nhận được ${counts.p?.count}`);
  check('<div> = 10', counts.div?.count === 10, `nhận được ${counts.div?.count}`);
  check('<span> = 11', counts.span?.count === 11, `nhận được ${counts.span?.count}`);
  check('<img> = 1', counts.img?.count === 1, `nhận được ${counts.img?.count}`);
  check('có tiêu đề trang', Boolean(getResult.data.analysis?.title));
  check('nhật ký giao thức không rỗng', (getResult.data.log || []).length > 0);

  console.log('\nHEAD');
  const headResult = await callApi({ url: `${BASE}/demo/index.html`, method: 'HEAD' });
  const headHeaders = Object.fromEntries(
    (headResult.data.response?.headers || []).map((h) => [h.name.toLowerCase(), h.value]),
  );
  check('status 200', headResult.data.response?.statusCode === 200);
  check('body rỗng', headResult.data.response?.byteLength === 0);
  check('có Content-Length', Boolean(headHeaders['content-length']));
  check('không phân tích tag', headResult.data.analysis === null);
  check('có thông tin tài nguyên (Last-Modified)',
    Boolean(headHeaders['last-modified']), JSON.stringify(headHeaders));

  console.log('\nPOST');
  const postResult = await callApi({
    url: `${BASE}/demo/echo`,
    method: 'POST',
    data: 'ten=Hà Điền Trung Hiếu&lop=24IT062',
  });
  const postBody = postResult.data.response?.bodyText || '';
  check('status 200', postResult.data.response?.statusCode === 200);
  check('echo đúng tên tiếng Việt', postBody.includes('Hà Điền Trung Hiếu'));
  check('echo đúng lớp', postBody.includes('24IT062'));
  check('phân tích được HTML trả về', Boolean(postResult.data.analysis));
  check('Content-Length của body form = 60 byte',
    postBody.includes('60 byte'), postBody.match(/Độ dài body: <strong>(\d+) byte/)?.[1]);

  console.log('\nĐiều hướng & lỗi');
  const redirect = await callApi({ url: `${BASE}/demo/redirect`, method: 'GET' });
  check('theo redirect 302', redirect.data.response?.finalUrl.endsWith('/demo/index.html'));

  const notFound = await callApi({ url: `${BASE}/demo/khong-ton-tai`, method: 'GET' });
  check('404 đúng mã', notFound.data.response?.statusCode === 404);

  const badHost = await callApi({ url: 'http://khong-ton-tai.abcxyz', method: 'GET' });
  check('báo lỗi DNS bằng tiếng Việt',
    badHost.status === 502 && /phân giải/.test(badHost.data.error || ''));

  const badMethod = await callApi({ url: `${BASE}/`, method: 'PUT' });
  check('từ chối method PUT', badMethod.status === 502 && /không hỗ trợ/i.test(badMethod.data.error || ''));

  console.log('\nChunked & nén');
  const chunked = await callApi({ url: `${BASE}/demo/chunked`, method: 'GET' });
  const chunkedHeaders = Object.fromEntries(
    (chunked.data.response?.headers || []).map((h) => [h.name.toLowerCase(), h.value]),
  );
  check('có Transfer-Encoding: chunked', chunkedHeaders['transfer-encoding'] === 'chunked');
  check('giải mã chunked ra đủ nội dung', (chunked.data.response?.bodyText || '').includes('Chunked'));

  const gzip = await callApi({ url: `${BASE}/demo/gzip`, method: 'GET' });
  const gzipHeaders = Object.fromEntries(
    (gzip.data.response?.headers || []).map((h) => [h.name.toLowerCase(), h.value]),
  );
  check('có Content-Encoding: gzip', gzipHeaders['content-encoding'] === 'gzip');
  check('giải nén gzip đúng', gzip.data.analysis?.counts.p?.count === 7);

  console.log(`\nKết quả: ${passed} đạt, ${failed} lỗi`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Lỗi khi chạy test:', error.message);
  process.exit(1);
});
