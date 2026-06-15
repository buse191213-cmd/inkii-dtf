# DTF-Engine — DTF1.de mantığında görüntü işleme hattı

Kullanıcının yüklediği logo/görseli alır ve sırayla şu adımlardan geçirir:

```
Yükle → Analiz → Arka plan kaldır (KI) → Upscale → Keskinleştir → Vektör kontrolü → Sonuç
```

Tıpkı dtf1.de/dtf-transfers sayfasındaki "DTF-Engine V2.2" gibi.

## Mimari

```
dtf-engine/
├── backend/                  Node.js + Express işleme sunucusu
│   ├── server.js             pipeline + 2 uç nokta (/process, /process-stream)
│   ├── providers/
│   │   ├── background.js      arka plan kaldırma (removebg/photoroom/local/demo)
│   │   ├── upscale.js         çözünürlük (replicate/local/demo)
│   │   ├── sharpen.js         kenar keskinleştirme (sharp, her zaman yerel)
│   │   └── vectorize.js       vektör kontrolü (vtracer/demo)
│   └── .env.example          sağlayıcı ve API anahtarı ayarları
└── frontend/
    ├── DtfEngine.jsx          backend'e bağlanan üretim bileşeni (SSE canlı adımlar)
    └── DtfEngineDemo.jsx      tarayıcıda çalışan demo (sunucusuz, hemen test)
```

## Her adım için sağlayıcı seçenekleri

| Adım | Hazır API (kolay) | Kendi sunucun (ücretsiz) |
|------|-------------------|--------------------------|
| Arka plan | remove.bg, Photoroom | rembg (U²-Net) |
| Upscale | Replicate (Real-ESRGAN) | realesrgan-ncnn-vulkan |
| Vektör | — | vtracer |
| Keskinleştirme | her zaman yerel (sharp) | sharp |

`.env` dosyasında sağlayıcıyı seçersin. Hiçbiri ayarlı değilse **demo modunda**
akış çalışır (gerçek AI yapmadan adımları gösterir) — entegrasyonu test etmek için.

## Kurulum

### Backend
```bash
cd backend
npm install
cp .env.example .env      # anahtarlarını gir
npm start                 # http://localhost:4000
```

### Frontend
`DtfEngine.jsx` veya `DtfEngineDemo.jsx` dosyasını React projene koy.
Backend kullanıyorsan dosyanın başındaki `const API = "..."` adresini ayarla.

## Kullanıma geçiş yolu (öneri)

1. **Başlangıç:** `BG_PROVIDER=removebg` + `UPSCALE_PROVIDER=replicate`
   → kurulum yok, görsel başına birkaç cent.
2. **Hacim artınca:** GPU'lu bir sunucu kirala, `local` provider'lara geç
   → görsel başına ücret sıfır.

Kod aynı kalır, sadece `.env` değişir.

## WordPress/WooCommerce notu

Senin siten WooCommerce. Bu backend'i ayrı bir Node servisi olarak çalıştırıp
WordPress'ten `fetch` ile çağırabilirsin; ya da aynı mantığı bir WP eklentisi
içinde PHP'ye taşıyabilirsin (rembg/Real-ESRGAN'ı `shell_exec` ile çağırarak).
İstersen PHP sürümünü de çıkarabilirim.
