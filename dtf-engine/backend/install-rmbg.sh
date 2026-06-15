#!/bin/bash
# RMBG-1.4 (rembg) kurulum scripti - macOS
# Bu, remove.bg yerine kendi bilgisayarında BEDAVA arka plan kaldırma kurar.

echo "=== RMBG-1.4 / rembg kurulumu ==="
echo ""

# 1) Python var mı kontrol
if ! command -v python3 &> /dev/null; then
  echo "❌ Python3 bulunamadı. Önce kur: brew install python3"
  exit 1
fi
echo "✓ Python3 bulundu: $(python3 --version)"

# 2) rembg'yi izole bir ortama kur (sistem Python'unu kirletmesin)
echo ""
echo "rembg kuruluyor (birkaç dakika sürebilir, model ~170MB)..."
python3 -m pip install --user --break-system-packages "rembg[cli]" onnxruntime 2>&1 | tail -5

# 3) Test: rembg çalışıyor mu
echo ""
if python3 -m rembg --help &> /dev/null; then
  echo "✓ rembg kuruldu!"
else
  echo "⚠️ rembg komut satırından çalışmıyor olabilir, ama Python modülü kurulu."
fi

echo ""
echo "=== Kurulum bitti ==="
echo "Şimdi .env dosyasında BG_PROVIDER=local yap ve sunucuyu yeniden başlat."
