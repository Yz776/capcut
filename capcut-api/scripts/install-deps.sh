#!/bin/bash
# scripts/install-deps.sh
# Install semua system dependencies yang dibutuhkan Chromium di Ubuntu/Debian minimal.
# CapCut login script (manual-login.js) butuh Chromium yang berfungsi penuh.
#
# Cara pakai:
#   bash scripts/install-deps.sh
#
# Setelah install, jalankan: npm run login:manual

set -e

echo "=== CapCut JJ API — System Dependencies Installer ==="
echo ""

# Detect distro
if [ -f /etc/os-release ]; then
  . /etc/os-release
  echo "Distro: $PRETTY_NAME"
  echo ""
else
  echo "[ERROR] /etc/os-release tidak ditemukan. Distro tidak dikenali."
  exit 1
fi

# Cek root
if [ "$(id -u)" -ne 0 ]; then
  echo "[WARN] Tidak jalan sebagai root. Mungkin perlu sudo."
  SUDO="sudo"
else
  SUDO=""
fi

# === Debian/Ubuntu ===
if [ -n "$ID" ] && echo "$ID $ID_LIKE" | grep -qE "debian|ubuntu"; then
  echo ">> Installing Chromium shared libs (Debian/Ubuntu)..."
  $SUDO apt-get update -y
  $SUDO apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    2>&1 | tail -20

  echo ""
  echo ">> Installing dbus (untuk fix error 'Failed to connect to bus')..."
  $SUDO apt-get install -y --no-install-recommends dbus 2>&1 | tail -5 || true

  echo ""
  echo ">> Installing CJK fonts (untuk render teks Chinese di CapCut login page)..."
  $SUDO apt-get install -y --no-install-recommends \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    2>&1 | tail -5 || true

  echo ""
  echo ">> (Optional) Installing xvfb untuk non-headless mode..."
  $SUDO apt-get install -y --no-install-recommends xvfb 2>&1 | tail -5 || true

else
  echo "[ERROR] Distro $ID tidak didukung oleh script ini."
  echo "Silakan install manual: libnss3, libatk1.0-0, libatk-bridge2.0-0, libcups2,"
  echo "libdrm2, libxkbcommon0, libxcomposite1, libxdamage1, libxfixes3, libxrandr2,"
  echo "libgbm1, libpango-1.0-0, libcairo2, libasound2, fonts-noto-cjk"
  exit 1
fi

echo ""
echo "=== Verifikasi Chromium ==="
echo "Puppeteer akan otomatis download Chromium ke ~/.cache/puppeteer/"
echo "Cek versi Chromium yang akan dipakai:"
node -e "const puppeteer = require('puppeteer'); console.log('Puppeteer:', require('puppeteer/package.json').version);"

echo ""
echo "=== Test launch Chromium ==="
node -e "
const puppeteer = require('puppeteer');
(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.goto('about:blank');
    console.log('✓ Chromium launch berhasil di headless mode');
    await browser.close();
  } catch (e) {
    console.error('✗ Chromium launch gagal:', e.message);
    process.exit(1);
  }
})();
"

echo ""
echo "=== DONE ==="
echo "Sekarang jalankan: npm run login:manual"
echo "Lalu buka SSH tunnel di laptop: ssh -L 3001:localhost:3001 root@sakura.proxy.rlwy.net -p 39551"
echo "Buka http://localhost:3001/ di browser → scan QR pake CapCut HP"
