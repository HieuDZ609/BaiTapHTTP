# Bài 7 — Giao thức HTTP: Browser đơn giản (web app)

Browser cho phép nhập URL và gửi 3 loại request **GET / POST / HEAD** tới một web server,
sau đó phân tích trang HTML trả về hoặc hiển thị thông tin tài nguyên.

Đây là bản web app (Node.js) của bài lab. Toàn bộ project chạy độc lập, không cần
`npm install` và không phụ thuộc thư viện ngoài.

---

## 1. Yêu cầu môi trường

- Node.js **>= 18** (đã kiểm thử với Node 24)
- Không cần cài thêm package nào

```bash
node --version
```

## 2. Chạy local

```bash
./start.sh        # chỉ chạy web app
# hoặc: npm start
```

Mở <http://localhost:3000>. Đổi cổng: `PORT=8080 ./start.sh`.

Muốn chạy nền cả web app lẫn ngrok bằng một lệnh:

```bash
./serve.sh        # khởi động nền, log trong .run/
./stop.sh         # dừng cả hai
```

Kiểm thử API (cần server đang chạy):

```bash
./test.sh
```

## 3. Deploy bằng ngrok

```bash
# lần đầu: nạp authtoken (lấy tại dashboard.ngrok.com)
ngrok config add-authtoken <TOKEN>

# cách nhanh: chạy nền cả hai
./serve.sh

# hoặc hai terminal
./start.sh          # terminal 1
./ngrok.sh          # terminal 2
# tương đương: ngrok http 3000 --url https://tint-humped-december.ngrok-free.dev
```

Sau đó mở `https://tint-humped-december.ngrok-free.dev`.

> **Lưu ý về ngrok free:** lần đầu mở bằng trình duyệt sẽ thấy trang cảnh báo
> *"You are about to visit…"*. Bấm **Visit Site** một lần, sau đó không hiện nữa
> (ngrok ghi cookie). Nếu gọi bằng `curl`/tool khác thì gửi thêm header
> `ngrok-skip-browser-warning: true`.
>
> **Bảo mật:** không dán authtoken vào chat, issue hay commit. Nếu đã lộ, vào
> dashboard → *Revoke* rồi tạo token mới.

## 4. Cấu trúc

```
BailabHTTP/
├── text.txt                 # đề bài
├── server.js                # HTTP server: phục vụ UI + API /api/fetch + trang demo
├── lib/
│   ├── fetcher.js           # client HTTP: redirect, chunked, gzip/deflate/br, charset
│   └── analyzer.js          # đếm tag, chiều dài, tiêu đề, danh sách ảnh/link
├── public/
│   ├── index.html           # giao diện
│   ├── app.js               # gọi API, render 5 tab
│   ├── style.css
│   └── demo/                # trang mẫu để test không cần server ngoài
├── test/
│   └── api-test.js          # 27 kiểm thử API
├── start.sh
├── ngrok.sh
└── test.sh
```

## 5. Đối chiếu với đề bài

| Yêu cầu trong `text.txt` | Cách thực hiện |
|---|---|
| Người dùng gõ URL để lấy tài nguyên | Ô địa chỉ trên UI; gõ thiếu scheme thì tự thêm `http://` |
| Hỗ trợ 3 loại request GET / POST / HEAD | Combobox method; backend chỉ chấp nhận 3 method này |
| GET/POST: hiển thị **chiều dài** | Tab *Phân tích*: số ký tự, số byte nhận từ mạng, số byte UTF-8, số dòng |
| GET/POST: số lượng `<p>`, `<div>`, `<span>`, `<img>` | Tab *Phân tích*: 4 thẻ số lớn, cộng bảng tag khác |
| HEAD: hiển thị thông tin tài nguyên | Tab *Header* + tab *Phân tích*: status, Content-Type, Content-Length, Last-Modified, ETag, Server, Encoding |
| Khả năng hiểu và biểu diễn HTML (khá hơn) | Tab *Xem trước*: render HTML trong iframe (lọc `<script>`, chèn `<base>` cho ảnh/link tương đối) |

## 6. API

`POST /api/fetch`

```json
{
  "url": "https://vku.udn.vn",
  "method": "GET",
  "data": "ten=Hieu&lop=24IT062",
  "headers": { "X-Custom": "value" }
}
```

Trả về:

```json
{
  "request":  { "url": "...", "method": "GET" },
  "response": {
    "finalUrl": "...", "statusCode": 200, "statusMessage": "OK",
    "httpVersion": "1.1", "headers": [{ "name": "Content-Type", "value": "..." }],
    "contentType": "...", "charset": "utf-8", "byteLength": 361092,
    "isHtml": true, "isTextual": true, "bodyText": "<!DOCTYPE html>..."
  },
  "analysis": {
    "title": "...", "characterLength": 359399, "byteLength": 361092,
    "utf8ByteLength": 361092, "lineCount": 61,
    "counts": { "p": { "count": 47, "required": true }, "div": { "count": 921 } },
    "images": [], "links": [], "requiredTags": ["p", "div", "span", "img"]
  },
  "log": ["→ GET / HTTP/1.1", "→ Host: vku.udn.vn", "← 200 OK (361092 byte body)"],
  "timeMs": 363
}
```

Lỗi trả `502` kèm `{ "error": "câu tiếng Việt" }`.

## 7. Trang demo có sẵn

| URL | Method | Mục đích |
|---|---|---|
| `/demo/index.html` | GET / HEAD | Trang đủ tag để đếm, có header đầy đủ |
| `/demo/echo` | GET / POST | Form; POST thì server echo lại dữ liệu nhận được |
| `/demo/redirect` | GET | 302 → `/demo/index.html` |
| `/demo/chunked` | GET | Body theo `Transfer-Encoding: chunked` |
| `/demo/gzip` | GET | Body nén gzip |
| `/demo/slow?s=10` | GET | Trễ 10 giây để thử nút Dừng |
| `/demo/khong-ton-tai` | GET | 404 |

## 8. Ghi chú kỹ thuật

- **Phải fetch qua server:** trình duyệt chặn JavaScript đọc nội dung khác origin (CORS),
  nên UI gửi URL về `/api/fetch`; server Node thực hiện request rồi trả JSON.
- **HEAD thật:** server phụ trợ không đọc body; response `byteLength = 0` và không phân tích tag.
- **Redirect:** theo tối đa 5 hop; 303 (và 301/302 với POST) đổi sang GET; `Location`
  tương đối được resolve theo URL hiện tại.
- **Chunked / nén:** Node tự giải chunked; `gzip`, `deflate`, `br` được giải nén thủ công
  trong `lib/fetcher.js`.
- **Charset:** `Content-Type` → `<meta charset>` → UTF-8; decode bằng `TextDecoder`.
- **Giới hạn:** timeout 15 s kết nối / 30 s đọc, body tối đa 20 MB.
- **An toàn khi render:** iframe có `sandbox` (không chạy script), HTML được lọc
  `<script>`/`<noscript>` và thuộc tính `on*`.
- **Path traversal:** server tĩnh chuẩn hoá đường dẫn và chỉ phục vụ file trong `public/`.

## 9. Xử lý sự cố

### "Không gọi được API: JSON.parse: unexpected character at line 1 column 1"

Nghĩa là `/api/fetch` trả về **HTML** thay vì JSON — thường do một trong hai nguyên nhân:

| Nguyên nhân | Cách xử lý |
|---|---|
| Server Node đã dừng | Chạy `./serve.sh` hoặc `./start.sh` |
| Tunnel ngrok đã dừng (trang `ERR_NGROK_3200`) | Chạy `./serve.sh` hoặc `./ngrok.sh` |
| Ngrok chèn trang cảnh báo | Bấm **Visit Site** một lần; API đã tự gửi header `ngrok-skip-browser-warning` nên sau đó không bị nữa |

Kiểm tra nhanh:

```bash
curl -s http://localhost:3000/api/health
curl -s -H "ngrok-skip-browser-warning: true" https://<domain>.ngrok-free.dev/api/health
```

Cả hai phải trả `{"ok":true,...}`. Giao diện cũng đã hiển thị thông báo cụ thể
kèm HTTP status, Content-Type và đoạn nội dung nhận được thay vì lỗi JSON khó hiểu.

## 10. Hạn chế đã biết

- Không render được CSS hiện đại (flex/grid) đầy đủ như trình duyệt thật — iframe dùng
  engine của trình duyệt nên thực tế render khá tốt, nhưng trang có JS động sẽ không chạy
  (đã chặn script vì lý do an toàn).
- Trang yêu cầu đăng nhập/cookie sẽ trả về trang login.
- Ngrok free có trang cảnh báo một lần cho mỗi trình duyệt.
