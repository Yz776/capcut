# CapCut JJ API v2.0

Pure Node.js API untuk otomatisasi CapCut: list/search template, inject gambar, render jadi video, dan serve hasilnya.

## Architecture

**Two render pipelines available:**

| Pipeline | Endpoint | Browser needed? | Status |
|----------|----------|-----------------|--------|
| **Browser editor (PRIMARY)** | `POST /render` | ✅ Puppeteer + CapCut editor | ✅ Stabil — recommended production path |
| **Direct API (experimental)** | `POST /render-direct` | ❌ NO browser for render step | ⚠️ Code complete; draft materials validation masih experimental |

**Browser pipeline** (primary):
1. Resolve template ID/URL
2. Launch headless Chromium + inject cookies dari `/login`
3. Buka `editor-template?create_id=...`
4. Upload images via `<input type="file">`
5. Click Export → intercept network untuk URL MP4 → download

**Direct API pipeline** (experimental, reverse-engineered):
1. VOD upload + register cloud asset
2. Build / save plane draft
3. Create + poll render task
4. Download MP4

**Auth**: Cookie-based. Satu kali paste di `/login` → dipakai kedua pipeline (cookies.json + profile).

## Quick Start

```bash
# 1. Install deps
npm install

# 2. Start server (port 7000 by default, auto-fallback to 3002-3010)
npm start
# atau: bash scripts/start-server.sh

# 3. Open login form in browser
open http://localhost:7000/login

# 4. Paste cookies from logged-in CapCut session (see "Login" section below)

# 5. Verify session
curl http://localhost:7000/login/status

# 6. Render via browser pipeline (PRIMARY)
curl -X POST http://localhost:7000/render \
  -H "Content-Type: application/json" \
  -d '{
    "template": "https://www.capcut.com/templates/detail/YOUR_TEMPLATE_ID",
    "imageUrls": ["https://example.com/img1.jpg", "https://example.com/img2.jpg"]
  }'

# 7. Poll status
curl http://localhost:7000/render/status/<jobId>
```

## Login (Required for /render and /render-direct)

CapCut session cookies expire after some days. When expired, API returns `ret=1015 notLogin`. Refresh via:

### Option A: Web form (recommended)

1. Open `http://localhost:7000/login` in browser
2. In another tab, log in to https://www.capcut.com
3. Open DevTools → Application → Cookies → `https://www.capcut.com`
4. Use a cookie export extension (e.g., EditThisCookie, Cookie-Editor) to copy all cookies as JSON
5. Paste the JSON array into the form → click Login
6. Form calls `POST /login` with `{cookies: [...]}` → cookies saved to `.capcut-profile`
7. Verify with `GET /login/status`

### Option B: curl

```bash
# Cookie header string format
curl -X POST http://localhost:7000/login \
  -H "Content-Type: application/json" \
  -d '{"cookieHeader": "sessionid=xxx; passport_csrf_token=yyy; passport=zzz; sid_tt=aaa; ttwid=bbb; ..."}'

# JSON array format
curl -X POST http://localhost:7000/login \
  -H "Content-Type: application/json" \
  -d '{"cookies": [{"name":"sessionid","value":"xxx","domain":".capcut.com"}, ...]}'
```

### Option C: Manual login (interactive browser)

```bash
# Starts Xvfb + Chromium, navigate to https://www.capcut.com/login
curl -X POST http://localhost:7000/login/manual
```

### Required cookies

These 5 cookies are required for full API access:
- `sessionid` — main session token
- `passport` — passport auth token
- `sid_tt` — session ID (TikTok)
- `passport_csrf_token` — CSRF token (sent as `x-tt-passport-csrf-token` header)
- `ttwid` — TikTok web ID

## API Reference

### `GET /`
Server info & endpoint list.

### `GET /health`
```json
{"status": "ok", "uptime": 12.3, "ts": 1786332000, "pid": 12345, "memoryMB": 97}
```

### `GET /login`
HTML form for cookie paste.

### `GET /login/status`
Check current session validity. Cached for 60s. Pass `?refresh=1` to force reload.

```json
{
  "loggedIn": false,
  "userId": null,
  "cookieCount": 24,
  "critical": ["passport_csrf_token", "ttwid"],
  "missing": ["sessionid", "passport", "sid_tt"],
  "error": "session expired, please sign in again",
  "cached": true,
  "cacheAge": 12
}
```

### `POST /login`
Accept cookies and store in profile. Body formats:
- `{"cookies": [{name, value, domain, path, ...}, ...]}` — JSON array
- `{"cookieHeader": "name1=val1; name2=val2; ..."}` — cookie header string
- `{"netscape": "# Netscape HTTP Cookie File\n..."}` — Netscape format

### `POST /login/manual`
Start interactive browser (Xvfb + Chromium) for manual login at https://www.capcut.com/login. Returns immediately; login state is polled via `GET /login/status`.

### `POST /render-direct`
Pure-API render. Accepts JSON or multipart:

```json
{
  "images": ["/local/path.jpg", "https://example.com/img.jpg", "data:image/jpeg;base64,..."],
  "videoName": "My Render"
}
```

Returns 202 with `jobId`:
```json
{
  "jobId": "abc123",
  "status": "queued",
  "statusUrl": "/render-direct/status/abc123",
  "downloadUrl": "/render-direct/download/abc123"
}
```

### `GET /render-direct/status/:jobId`
```json
{
  "jobId": "abc123",
  "status": "running",
  "progress": 45,
  "message": "Uploading asset 1/2: img1.jpg",
  "videoUrl": null
}
```

Statuses: `queued` → `running` → `completed` (or `failed`).

When `status=completed`, `videoUrl` is set to `/files/videos/My_Render_abc123.mp4`.

### `GET /render-direct/download/:jobId`
Redirect to the rendered video URL (or 409 if not completed).

### `POST /render` (legacy browser editor pipeline)
Same interface as /render-direct but uses Puppeteer to drive the CapCut web editor for rendering. Slower but works as a fallback.

### `GET /templates?limit=20&category=social`
List popular templates. **No login required.**

### `GET /templates/search?q=keyword&limit=20`
Search templates by keyword. **No login required.**

### `GET /templates/:id`
Get template detail by ID or URL. **No login required.**

### `GET /files/videos/:filename`
Static serve for rendered videos.

## End-to-end test

```bash
# Verify all endpoints work (no login needed for /templates, /health, /login)
node scripts/test-endpoints.js
```

## Configuration

Create `.env` file (see `.env.example`):

```bash
PORT=7000
HOST=0.0.0.0
HEADLESS=true
CAPCUT_USER_DATA_DIR=./.capcut-profile
LOG_LEVEL=info
MAX_CONCURRENT_JOBS=1
```

## File structure

```
capcut-api/
├── src/
│   ├── index.js                    # Hono server entry point
│   ├── routes/
│   │   ├── login.js                # Cookie-paste login + session check
│   │   ├── render.js               # Browser-editor render (legacy)
│   │   ├── direct-render.js        # Pure-API render (recommended)
│   │   └── templates.js            # Template list/search/detail
│   ├── services/
│   │   ├── capcut-direct-api.js    # Pure-API client (upload, save, render)
│   │   ├── capcut-browser.js       # Puppeteer browser automation
│   │   ├── capcut-api.js           # Public template API (no login)
│   │   ├── vod-uploader.js         # VOD upload (AWS Sigv4)
│   │   ├── input-handler.js        # Image URL/base64/file resolver
│   │   ├── job-manager.js          # Async job queue
│   │   └── render-worker.js        # Browser render worker
│   └── utils/
│       ├── config.js
│       ├── logger.js
│       ├── multipart.js
│       └── paths.js
├── scripts/                        # Test & dev scripts
├── test-assets/                    # Sample images
├── .capcut-profile/                # Chromium userDataDir (cookies stored here)
├── videos/                         # Rendered MP4s (served via /files/videos/)
└── tmp/                            # Scratch space
```

## Reverse-engineering notes

See `REVERSE_ENGINEERED.md` for detailed notes on:
- All 5 internal API endpoints (upload_sign, plane_draft/save, render_task/create, render_task/batch_get, download)
- Sign algorithm: `md5("9e2c|" + last7(path) + "|7|5.8.0|" + ts + "|web|11ac")`
- Bundle analysis (bundle-018.js, bundle-035.js)
- Draft schema (Cm for video material, SN for segment, In for crop, Im for stable, IA for matting, Ek for video_algorithm, Sb for responsive_layout)

## Troubleshooting

### `ret=1015 notLogin` / `SESSION_EXPIRED`
Session cookies expired. Refresh via `POST /login` with fresh cookies.

### `ret=2009 ERR_DRAFT_NOT_COMPLETE`
Draft JSON is missing required fields or asset is not properly registered. Make sure `registerCloudAsset()` is called and `materials.video_id` uses the `cloud_asset.asset_id`, not the raw VOD `vid`.

### `render_ret_code=19070005` (empty materials)
Draft was saved without materials. Render task has nothing to render. Check that `materials.videos[]` is populated before `saveDraft()`.

### Server dies silently
Already mitigated with `uncaughtException` + `unhandledRejection` handlers in `src/index.js`. If still happening, check `free -m` for OOM, and reduce `MAX_CONCURRENT_JOBS` to 1.

### `/login/status` is slow (30+ seconds)
First call spawns a puppeteer browser to read cookies from the profile. Result is cached for 60 seconds. Subsequent calls are fast.

## License

MIT
