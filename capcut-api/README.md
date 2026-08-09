# JJ CapCut Free Fire Template Generator

A Next.js 16 web app that fetches **real CapCut template data** from CapCut's public template page (no auth/token required) and lets users preview them with their own Free Fire screenshots as photo placeholders.

> Built with Next.js 16 · TypeScript · Tailwind CSS · Framer Motion · shadcn/ui

## Features

- **Live CapCut Data** — Pulls 60+ real templates directly from `capcut.com/template` via SSR scraping (no API key needed)
- **3 View Modes** — Detail / List / Render preview
- **9 FF Screenshot Slots** — Upload your own Free Fire screenshots as template photo placeholders
- **6 Style Presets** — JJ / Viral / DJ / Aesthetic / Cinematic / Trending
- **11 Categories** — editors-pick, social, holiday, calendar, anniversary, record, effects, industry, business, insights, others
- **Real Video Playback** — Plays actual CapCut template preview MP4s
- **Real Stats** — useCount, likeCount, viewCount, duration, ratio, resolution
- **Mobile Responsive** — Works great on 390px mobile viewports

## How It Works

### 1. CapCut Data Fetching (`src/app/api/capcut/list/route.ts`)

CapCut's `/template` page is server-side rendered and embeds template data inside `<script data-fn-name="r" data-fn-args='[...]'>` tags. This app:

1. Fetches `https://www.capcut.com/template` server-side
2. Parses all `data-fn-args` script tags
3. HTML-entity decodes the payload (`&quot;` → `"`, `&amp;` → `&`, `&#x2F;` → `/`, etc.)
4. Extracts the `videoTemplates` array from the JSON structure
5. Returns clean JSON to the client

No signature, token, or cookie is required — CapCut serves this data publicly in the initial HTML.

### 2. Template Fields

Each template includes:

```ts
{
  templateId: string         // 19-digit CapCut template ID
  title: string
  coverUrl: string           // signed webp cover image
  videoUrl: string           // v16-vod.capcutvod.com MP4
  useCount: number
  likeCount: number
  viewCount: number
  duration: number           // milliseconds
  ratio: string              // "9:16" etc
  resolution: string         // "1080p"
  clipsCount: number
  uploadDate: number
  shareUrl: string           // share.capcut.com link
}
```

### 3. Views

- **Detail View** — Cover + play button (loads real CapCut MP4) + stats chips + 9 FF screenshot upload slots
- **List View** — Compact grid with title, stats, ratio, duration
- **Render View** — Cover preview + render button (mock animation, not actual video processing)

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── capcut/
│   │   │   ├── list/route.ts       # SSR scrape of capcut.com/template
│   │   │   ├── search/route.ts     # Search proxy (limited - CapCut search is CSR)
│   │   │   └── detail/route.ts     # Detail proxy
│   │   └── render/route.ts         # Render endpoint
│   ├── page.tsx                    # Main UI with 3 view modes
│   ├── layout.tsx
│   └── globals.css
├── components/ui/                  # shadcn/ui components
├── hooks/
└── lib/
public/
└── uploads/
    └── freefire-1.jpg ~ freefire-9.jpg   # FF screenshot placeholders
```

## Getting Started

```bash
# Install deps
bun install   # or npm install / pnpm install

# Run dev server
bun dev       # or npm run dev

# Open http://localhost:3000
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4 |
| Animation | Framer Motion 12 |
| UI Components | shadcn/ui + Radix UI |
| Icons | lucide-react |
| Runtime | Bun (recommended) / Node 20+ |

## Known Limitations

1. **Search** — CapCut's search is client-side rendered with signed requests. The search endpoint exists but returns limited results.
2. **Render** — The render button triggers a mock animation. Real video rendering would require server-side ffmpeg/Remotion.
3. **Download** — No actual file download yet; the button is UI-only.
4. **Rate Limits** — Hitting CapCut too frequently may trigger Cloudflare blocks. The app refreshes on demand, not on a timer.

## License

MIT — for educational purposes. CapCut is a trademark of ByteDance; this project is not affiliated with CapCut.
