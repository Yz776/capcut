# CapCut API

HTTP API untuk otomatisasi CapCut: auth session, list/search template, render video dari template + gambar.

```bash
cd capcut-api && npm install && npm start
# → http://localhost:7000
```

## Endpoints

| Method | Path | Deskripsi |
|--------|------|-----------|
| `GET` | `/` | Info API + daftar endpoint |
| `GET` | `/health` | Health check |
| `POST` | `/login` | Set session cookies |
| `GET` | `/login/status` | Cek session |
| `GET` | `/templates` | List template populer |
| `GET` | `/templates/search?q=` | Cari template |
| `GET` | `/templates/:id` | Detail template |
| `POST` | `/render` | **Render video** (async) |
| `GET` | `/render/status/:jobId` | Status job |
| `GET` | `/render/download/:jobId` | Redirect ke MP4 |
| `POST` | `/render-direct` | Render pure-API (experimental) |
| `GET` | `/files/videos/:file` | Serve MP4 hasil render |

## Auth

CapCut memakai cookie session. Set sekali, dipakai semua request render.

```bash
# Export cookies dari browser (Cookie-Editor → JSON), lalu:
curl -X POST http://localhost:7000/login \
  -H "Content-Type: application/json" \
  -d '{"cookies": [ /* array dari extension */ ]}'

curl http://localhost:7000/login/status
```

Atau buka `http://localhost:7000/login` di browser dan paste di form.

## Render

```bash
curl -X POST http://localhost:7000/render \
  -H "Content-Type: application/json" \
  -d '{
    "template": "https://www.capcut.com/templates/detail/TEMPLATE_ID",
    "imageUrls": [
      "https://example.com/a.jpg",
      "https://example.com/b.jpg"
    ]
  }'
```

Response `202`:

```json
{
  "jobId": "abc123",
  "status": "queued",
  "statusUrl": "/render/status/abc123",
  "downloadUrl": "/render/download/abc123"
}
```

Poll:

```bash
curl http://localhost:7000/render/status/abc123
```

Selesai:

```json
{
  "jobId": "abc123",
  "status": "completed",
  "progress": 100,
  "videoUrl": "http://localhost:7000/files/videos/....mp4"
}
```

Multipart juga didukung (`template` + file `images`).

## Config

Salin `capcut-api/.env.example` → `capcut-api/.env`.

| Var | Default | Keterangan |
|-----|---------|------------|
| `PORT` | `7000` | Port HTTP |
| `HEADLESS` | `true` | Puppeteer headless |
| `MAX_CONCURRENT_JOBS` | `1` | Job paralel |
| `PUBLIC_BASE_URL` | `http://localhost:7000` | Base URL di response |
| `RENDER_TIMEOUT` | `300000` | Timeout render (ms) |

## Deploy

```bash
cd capcut-api
npm install
bash scripts/start-server.sh
```

Atau Docker:

```bash
docker build -t capcut-api ./capcut-api
docker run -p 7000:7000 -v $(pwd)/data:/app/.capcut-profile capcut-api
```

## License

MIT
