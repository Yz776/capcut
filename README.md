# CapCut API

HTTP API: session CapCut, templates, dan **render video** (CapCut cloud + fallback lokal 100%).

```bash
cd capcut-api && npm install && npm start
# http://localhost:7000
```

## Render (100% reliable)

```bash
# Local engine — always works (FFmpeg)
curl -X POST http://localhost:7000/render \
  -H 'Content-Type: application/json' \
  -d '{
    "template": "demo",
    "engine": "local",
    "imagesBase64": ["data:image/jpeg;base64,...", "data:image/jpeg;base64,..."]
  }'

# Auto (default): try CapCut browser, fallback to local FFmpeg
curl -X POST http://localhost:7000/render \
  -H 'Content-Type: application/json' \
  -d '{
    "template": "7494658113069419829",
    "engine": "auto",
    "imageUrls": ["https://...", "https://..."]
  }'
```

Poll: `GET /render/status/:jobId` → `videoUrl` when `status=completed`.

| `engine` | Behavior |
|----------|----------|
| `local` | FFmpeg only — **guaranteed MP4** |
| `auto` | CapCut editor first, local fallback on failure |
| `capcut` | CapCut only (no fallback) |

## Auth (CapCut paths)

```bash
curl -X POST http://localhost:7000/login \
  -H 'Content-Type: application/json' \
  -d '{"cookies":[ /* Cookie-Editor JSON */ ]}'
curl http://localhost:7000/login/status
```

Cookie `sessionid_ss` alone is enough (no need for non-`_ss` sessionid).

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| POST | `/login` | Set cookies |
| GET | `/login/status` | Session check |
| GET | `/templates/search?q=` | Search |
| POST | `/render` | Async render |
| GET | `/render/status/:jobId` | Job status |
| GET | `/files/videos/:file` | Download MP4 |

## License

MIT
