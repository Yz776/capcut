---
Task ID: github-sync-1
Agent: main (Super Z)
Task: Timpah (overwrite) local capcut-api scripts dengan isi repo GitHub Yz776/capcut menggunakan PAT yang diberikan user

Work Log:
- Clone https://github.com/Yz776/capcut.git ke /tmp/capcut-github dengan PAT
- Inspeksi struktur repo: Next.js 16 + TypeScript + Prisma + shadcn/ui + Tailwind + Framer Motion
- Backup file lama (Hono-based API) ke /home/z/my-project/capcut-api-backup/ (.env, .env.example, .capcut-profile, README-hono.md, package-hono.json, src-hono, scripts-hono)
- Bersihkan /home/z/my-project/capcut-api/ dari semua file Hono lama
- Rsync semua file dari repo GitHub ke /home/z/my-project/capcut-api/ (exclude .git, node_modules, bun.lock)
- Restore .capcut-profile (CapCut login session) dari backup
- Buat .env baru dengan DATABASE_URL, NEXTAUTH_SECRET, PUBLIC_BASE_URL, CAPCUT_USER_DATA_DIR, RENDER_TIMEOUT_MS
- npm install (837 packages, ~2 menit)
- npx prisma generate + prisma db push (SQLite DB terbentuk di /home/z/my-project/db/custom.db via parent .env)
- Buat script /home/z/my-project/scripts/start-capcut-dev.sh untuk start dev server secara persistent
- Start Next.js dev server (PID 10621) — Ready in 325ms, HTTP 200 di localhost:3000
- Test /api (hello world) — OK
- Test /api/render GET — OK, ffmpeg 7.1.5 terdeteksi, libx264 available
- Test /api/capcut/list?count=3 — OK, 3 template CapCut asli (PONK FANK, new templet video, Power) dengan cover_url, video_url, stats, dll
- Test /api/capcut/search?q=phonk — OK, ditemukan "funk abnormal" dan "LUNACY JUMPSTYLE" (filter-from-trending fallback)
- Test /api/render POST — OK, berhasil render MP4 306KB dalam 3.5 detik dari 3 gambar FF + cover CapCut, output disimpan di /home/z/my-project/download/test-render-ff.mp4

Stage Summary:
- Stack berpindah dari Hono (pure Node.js API) ke Next.js 16 (full-stack web app)
- 48 shadcn/ui components tersedia di src/components/ui/
- 4 API routes: /api, /api/capcut/list, /api/capcut/search, /api/capcut/detail, /api/render
- Main UI: src/app/page.tsx (1272 lines, 3 view modes: Detail/List/Render, 9 FF screenshot slots, 6 style presets)
- Prisma + SQLite aktif (User, Post models — boilerplate)
- ffmpeg 7.1.5 terinstall, render pipeline verified working
- CapCut SSR scrape approach (no login needed) — lebih reliable dari approach API internal lama
- Dev server berjalan di http://localhost:3000 (PID 10621)
- File backup Hono lama tersimpan di /home/z/my-project/capcut-api-backup/ jika perlu referensi
- File deliverable test: /home/z/my-project/download/test-render-ff.mp4 (306KB MP4)
