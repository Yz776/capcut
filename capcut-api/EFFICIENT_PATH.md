# Jalur paling efisien (ringkas)

## Produksi sekarang → `POST /render` (browser)

1. `npm start` / `bash scripts/start-server.sh`
2. Buka `/login` → paste cookies CapCut
3. `POST /render` + template + images → poll status → MP4

Satu login cookie dipakai browser + pure-API.

## Unblok pure-API (ROI tertinggi, sekali kerja)

Bottleneck: `ERR_DRAFT_NOT_COMPLETE` pada draft buatan sendiri.  
Solusi: **replay body `plane_draft/save` asli** dari editor CapCut.

```bash
# cookies.json harus ada (dari /login)
npm run capture:oneshot -- <TEMPLATE_ID>
# atau di server tanpa display:
npm run capture:oneshot:xvfb -- <TEMPLATE_ID>
```

Output:
- `tmp/captured-save-body.json` — golden fixture
- `tmp/captured-api.jsonl` — full traffic

Setelah file itu ada, `POST /render-direct` **otomatis** memakainya (patch `asset_id` saja). Tidak perlu tebak schema lagi.

## Jangan pivot ke cutsdk/CapCut Mate kecuali…

…kamu **tidak** butuh template CapCut Web. Cloud mereka = draft desktop format + renderer pihak ketiga, bukan `edit-api-sg.capcut.com`.

## Ringkasan

| Kebutuhan | Endpoint / perintah |
|-----------|---------------------|
| Cepat dapat MP4 dari template CapCut | `/render` |
| Scale tanpa browser (setelah 1x capture) | `capture:oneshot` lalu `/render-direct` |
| Slideshow sederhana tanpa CapCut | pakai tool lain (FFmpeg / cutcli) |
