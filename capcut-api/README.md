# CapCut JJ API

Pure Node.js API untuk otomatisasi CapCut: ambil template, sisipkan 2+ gambar, render jadi video, dan hasilkan URL unduhan. Sepenuhnya otomatis menggunakan Puppeteer (headless Chromium) + Hono.

## Fitur

- **Template management**: list, search by keyword, get by URL/ID
- **Render template**: sisipkan 2+ gambar ke template, CapCut render video
- **Input fleksibel**: URL gambar, multipart upload, base64, atau mix
- **Async job**: POST /render → return jobId → poll /status/:jobId → /download/:jobId
- **Static serve**: video hasil disimpan lokal, di-serve via `/files/videos/*`
- **Auth**: email/password, atau persistent userDataDir (login 1x pakai `manual-login.js`)

## Stack

- Node.js 18+
- Hono (HTTP framework)
- Puppeteer (browser automation)
- formidable (multipart parser)
- axios (image download)
- pino (logger)
- **ffmpeg + ffprobe** (required by the ffmpeg fallback composer — the default
  render path when `CAPCUT_EDITOR_ENABLED=false`)

## Setup

### 0. Install ffmpeg (REQUIRED)

The default render path (`CAPCUT_EDITOR_ENABLED=false`) overlays user images
onto the template preview MP4 using ffmpeg. Both `ffmpeg` and `ffprobe` must
be callable from the Node process.

```bash
# Debian / Ubuntu
sudo apt-get install -y ffmpeg

# macOS (Homebrew)
brew install ffmpeg

# Alpine
apk add --no-cache ffmpeg

# Or, if you've already cloned this repo, this script also installs ffmpeg:
bash scripts/install-deps.sh
```

Verify:

```bash
which ffmpeg       # e.g. /usr/bin/ffmpeg
which ffprobe      # e.g. /usr/bin/ffprobe
ffmpeg -version
```

**If ffmpeg is installed but the Node process still can't find it** (very
common with `pm2`, `systemd`, Docker slim images, or VS Code task launchers
that strip `PATH`), set absolute paths in `.env`:

```dotenv
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
```

Without ffmpeg, every `POST /render` will fail at ~42% progress with
`spawn ffprobe ENOENT` (or, with this fix, a friendlier error message that
includes the same install instructions).

## Setup

### 1. Install dependencies

```bash
cd /home/z/my-project/capcut-api
npm install
```

Puppeteer akan otomatis download Chromium (~300MB) saat install pertama.

### 2. Konfigurasi environment

```bash
cp .env.example .env
```

Edit `.env`, isi minimal:

```dotenv
CAPCUT_EMAIL=email_kamu@xxx.com
CAPCUT_PASSWORD=password_kamu
HEADLESS=true           # set false saat debugging selector
PORT=3000
PUBLIC_BASE_URL=http://localhost:3000
```

### 3. (Rekomendasi) Login manual sekali untuk dapat session

Email/password login rawan captcha. Lebih stabil: login 1x manual, simpan session:

#### A. Di local/desktop (punya display)

```bash
npm run login:manual
```

Browser non-headless akan terbuka. Login CapCut via QR atau email. Setelah terdeteksi login, session tersimpan ke `./.capcut-profile`. Lalu update `.env`:

#### B. Di server headless (VPS/Railway/Docker tanpa X server)

Script `manual-login.js` otomatis pakai mode headless kalau env `DISPLAY` kosong, dan menjalankan HTTP server kecil di port 3001 untuk serve screenshot QR code.

**Langkah 1 — Install system deps (sekali saja):**

```bash
bash scripts/install-deps.sh
# atau
npm run deps:install
```

**Langkah 2 — Buka SSH tunnel di laptop lokal kamu:**

```bash
# Di terminal lokal (bukan server), buka tunnel port 3001
ssh -L 3001:localhost:3001 root@sakura.proxy.rlwy.net -p 39551
# Masukkan password server (Wifi.id123)
# Biarkan terminal ini terbuka
```

**Langkah 3 — Jalankan login di server:**

```bash
# Di terminal server
npm run login:manual
```

Output log akan menampilkan:
```
HTTP QR viewer listening on http://0.0.0.0:3001/
1. Di terminal lokal (laptop), buka SSH tunnel:
     ssh -L 3001:localhost:3001 root@sakura.proxy.rlwy.net -p 39551
2. Di browser lokal, buka: http://localhost:3001/
3. Scan QR code yang muncul pake aplikasi CapCut di HP
4. Script akan auto-detect login & save session
```

**Langkah 4 — Buka http://localhost:3001/ di browser lokal, scan QR:**

Page akan auto-refresh setiap 2 detik. Buka aplikasi CapCut di HP → menu Profile → icon Scan di kanan atas → arahkan ke QR code di browser.

**Langkah 5 — Tunggu script detect login:**

Setelah QR di-scan dan dikonfirmasi di HP, script otomatis detect login (via cookies, URL change, atau avatar element), save session ke `.capcut-profile/`, dan exit.

**Troubleshooting server headless:**

- **Error `Missing X server or $DISPLAY`** → pastikan pakai versi script terbaru (sudah auto-detect DISPLAY)
- **Error `Failed to connect to bus /run/dbus/system_bus_socket`** → install dbus: `apt-get install -y dbus`
- **Port 3001 sudah dipakai** → set `CAPCUT_LOGIN_PORT=3002` sebelum `npm run login:manual`
- **Chromium launch gagal (missing libs)** → run `bash scripts/install-deps.sh` lagi
- **QR tidak muncul di page** → script otomatis capture full page screenshot sebagai fallback; cek `/qr` endpoint

Lalu update `.env`:

```dotenv
CAPCUT_USER_DATA_DIR=./.capcut-profile
# CAPCUT_EMAIL & PASSWORD bisa dikosongkan
```

### 4. Jalankan API

```bash
npm start
# atau untuk dev (auto-reload)
npm run dev
```

API listening di `http://localhost:3000`.

### 5. Smoke test

```bash
npm run test:smoke
```

## API Endpoints

### `GET /`
Info API & daftar endpoint.

### `GET /health`
Health check.

### `POST /render`
Render video dari template + gambar. Async, return jobId.

**Body (JSON)**:
```json
{
  "template": "https://www.capcut.com/templates/detail/123456",
  "imageUrls": [
    "https://example.com/img1.jpg",
    "https://example.com/img2.jpg"
  ]
}
```

**Atau base64**:
```json
{
  "template": "123456",
  "imagesBase64": [
    "data:image/png;base64,iVBORw0KGgo...",
    "data:image/png;base64,iVBORw0KGgo..."
  ]
}
```

**Atau mix**:
```json
{
  "template": { "url": "https://www.capcut.com/templates/detail/123456" },
  "images": [
    { "type": "url", "value": "https://example.com/img1.jpg" },
    { "type": "base64", "value": "data:image/png;base64,..." },
    { "type": "file", "value": "/tmp/already/saved.jpg" }
  ]
}
```

**Atau multipart/form-data**:
```
POST /render
Content-Type: multipart/form-data

template=https://www.capcut.com/templates/detail/123456
images=@/path/to/img1.jpg
images=@/path/to/img2.jpg
```

**Response 202**:
```json
{
  "jobId": "abc123def456",
  "status": "queued",
  "statusUrl": "/render/status/abc123def456",
  "downloadUrl": "/render/download/abc123def456"
}
```

### `GET /render/status/:jobId`
Cek status job.

```json
{
  "jobId": "abc123def456",
  "status": "running",
  "progress": 50,
  "message": "Images uploaded, waiting for editor to apply",
  "videoUrl": null,
  "error": null,
  "createdAt": 1736000000000,
  "updatedAt": 1736000030000
}
```

`status`: `queued` | `running` | `completed` | `failed`

### `GET /render/download/:jobId`
Redirect ke URL file video (302) saat status `completed`. Status lain return 409.

### `GET /templates?limit=20&category=`
List template populer CapCut.

### `GET /templates/search?q=keyword&limit=20`
Search template by keyword.

### `GET /templates/:id?url=` 
Detail template. `:id` bisa template ID, atau gunakan `?url=https://...`.

### `GET /files/videos/:filename`
Static serve video hasil render.

## Contoh End-to-End (curl)

```bash
# 1. Submit render
JOB=$(curl -s -X POST http://localhost:3000/render \
  -H 'Content-Type: application/json' \
  -d '{
    "template": "https://www.capcut.com/templates/detail/123456",
    "imageUrls": ["https://example.com/img1.jpg", "https://example.com/img2.jpg"]
  }' | jq -r .jobId)

echo "Job: $JOB"

# 2. Poll status (CapCut render butuh 2-5 menit)
while true; do
  STATUS=$(curl -s http://localhost:3000/render/status/$JOB)
  echo "$STATUS" | jq '{status, progress, message}'
  if echo "$STATUS" | jq -e '.status == "completed" or .status == "failed"' > /dev/null; then break; fi
  sleep 10
done

# 3. Download video
curl -L http://localhost:3000/render/download/$JOB -o result.mp4
echo "Video saved to result.mp4"
```

## ⚠️ Catatan Penting

### Selector DOM bisa berubah
CapCut adalah SPA yang sering update UI. Selector di `src/services/capcut-browser.js` (constant `SELECTORS`) diuji Desember 2024. Bila gagal:
1. Set `HEADLESS=false` di `.env`
2. Jalankan `npm run dev` lalu trigger request
3. Inspect DOM yang berubah, update selector di `SELECTORS` constant

### Anti-bot & TOS
Otomatisasi CapCut bisa melanggar TOS mereka. Gunakan dengan akun demo/testing, bukan akun utama. Untuk skala produksi, pertimbangkan:
- Rotate IP / proxy
- Delay antar request (`SLOW_MO=200`)
- Limit concurrency (`MAX_CONCURRENT_JOBS=1`)
- Captcha solver service (kalau login via email kena captcha)

### Render waktu
CapCut render video butuh 1-5 menit tergantung template complexity & server load. Pastikan:
- `RENDER_TIMEOUT=300000` (5 menit) cukup
- Client poll setiap 10-15 detik, bukan block
- Browser memory cukup (Chromium butuh ~500MB per session)

### Production deployment
- Run di Docker container dengan Chromium dependencies (`apt-get install -y libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2`)
- Reverse proxy (nginx) untuk HTTPS & static file caching
- Set `PUBLIC_BASE_URL` ke URL public (bukan localhost)
- Monitor `videos/` folder size, setup cron cleanup
- `MAX_CONCURRENT_JOBS` naikkan ke 2-3 kalau RAM server besar

## Struktur Project

```
capcut-api/
├── src/
│   ├── index.js                 # Entry point, Hono app, server bootstrap
│   ├── routes/
│   │   ├── render.js            # POST /render, GET /status, GET /download
│   │   └── templates.js         # GET /templates, /templates/search, /templates/:id
│   ├── services/
│   │   ├── capcut-browser.js    # Puppeteer wrapper: login, list, search, getTemplate, renderTemplate
│   │   ├── input-handler.js     # Resolve input (URL/upload/base64/mix) → local file paths
│   │   ├── job-manager.js       # Async job queue, status tracking, cleanup
│   │   └── render-worker.js     # End-to-end render pipeline (browser launch → render → save)
│   └── utils/
│       ├── config.js            # dotenv config loader
│       ├── logger.js            # pino logger
│       ├── paths.js             # dir init, saveVideo, videoPublicUrl, sleep
│       └── multipart.js         # formidable wrapper
├── scripts/
│   ├── manual-login.js          # 1x manual login, save session
│   └── smoke-test.js            # Basic endpoint test
├── videos/                      # rendered video output (gitignored)
├── downloads/                   # temp downloaded images (gitignored)
├── tmp/                         # tmp working files (gitignored)
├── .env.example
├── package.json
└── README.md
```

## Troubleshooting

**`Error: CAPCUT_EMAIL/CAPCUT_PASSWORD not set`**
Isi credentials di `.env`, atau set `CAPCUT_USER_DATA_DIR` untuk reuse session.

**`Login failed. Page text snippet: ...`**
CapCut menampilkan captcha atau error message. Buka `HEADLESS=false`, login manual via `npm run login:manual`.

**`Upload file input not found in CapCut editor`**
Selector `fileInput` di `capcut-browser.js` berubah. Update `SELECTORS.fileInput` setelah inspect DOM baru.

**`Render timeout or no download URL detected`**
Render butuh >5 menit. Naikkan `RENDER_TIMEOUT` di `.env`, atau template terlalu kompleks.

**Browser crash / SIGKILL**
Memory kurang. Turunkan `MAX_CONCURRENT_JOBS=1`, atau tambah RAM swap.

**`spawn ffprobe ENOENT` / `spawn ffmpeg ENOENT` / job fails at ~42% with "[ffmpeg] Probing template video"**
The Node process can't find `ffmpeg` or `ffprobe` in its `PATH`. Fixes (in order of preference):

1. Install ffmpeg on the host:
   ```bash
   sudo apt-get install -y ffmpeg      # Debian/Ubuntu
   brew install ffmpeg                 # macOS
   apk add --no-cache ffmpeg           # Alpine
   ```
2. If ffmpeg is installed but the Node process still can't find it (very common
   when launched via `pm2`, `systemd`, Docker slim images, or VS Code tasks
   that strip `PATH`), set absolute paths in `.env`:
   ```dotenv
   FFMPEG_PATH=/usr/bin/ffmpeg
   FFPROBE_PATH=/usr/bin/ffprobe
   ```
   Verify the real paths with `which ffmpeg` / `which ffprobe` from a normal
   shell, then restart the API.
3. Or rerun `bash scripts/install-deps.sh` (now also installs ffmpeg).

After applying the fix, restart the API server and re-submit the render job.

## License

MIT. Gunakan dengan tanggung jawab. Pengembang tidak bertanggung jawab atas penyalahgunaan akun CapCut atau pelanggaran TOS.
