// providers/coloroptimize.js
// DTF baskı için akıllı renk/kontrast optimizasyonu.
// Soluk/donuk/düşük kontrastlı logoları canlandırır — ama orijinali bozmadan.
// Zaten canlı bir görseli aşırı doygunlaştırmaz (akıllı karar).
import sharp from "sharp";

// ── Görseli analiz et: soluk mu, düşük kontrast mı? ────────
export async function analyzeColor(buffer) {
  // küçült + raw RGBA (hız)
  const { data } = await sharp(buffer)
    .resize(150, 150, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let count = 0;
  let sumSat = 0;          // ortalama doygunluk
  let minLum = 255, maxLum = 0;  // kontrast aralığı
  const lumValues = [];

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
    if (a < 30) continue; // şeffaf piksel sayma
    count++;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    // HSL doygunluk
    const sat = max === 0 ? 0 : (max - min) / max;
    sumSat += sat;
    const lum = (r*0.299 + g*0.587 + b*0.114);
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
    lumValues.push(lum);
  }

  if (count === 0) return { isFaded: false, isLowContrast: false, avgSaturation: 0, contrastRange: 0 };

  const avgSat = sumSat / count;
  const contrastRange = maxLum - minLum; // 0-255

  // Kararlar (eşikler deneyimle ayarlandı):
  const isFaded = avgSat < 0.32;            // doygunluk düşük = soluk
  const isLowContrast = contrastRange < 140; // dar aralık = düşük kontrast

  return {
    isFaded,
    isLowContrast,
    avgSaturation: +avgSat.toFixed(2),
    contrastRange: Math.round(contrastRange),
  };
}

// ── Akıllı optimizasyon uygula ─────────────────────────────
// force=true → kullanıcı manuel istedi (her zaman uygula)
// force=false → sadece gerekiyorsa (soluk/düşük kontrast) uygula
export async function optimizeColor(buffer, { force = false } = {}) {
  const analysis = await analyzeColor(buffer);
  const needsWork = analysis.isFaded || analysis.isLowContrast;

  if (!force && !needsWork) {
    // zaten canlı/iyi → dokunma (doğallığı koru)
    return { buffer, applied: false, analysis };
  }

  // İyileştirme miktarını duruma göre ayarla (aşırıya kaçma)
  let saturation = 1.0, brightness = 1.0;
  const modulate = {};

  if (analysis.isFaded) {
    // soluk → doygunluğu artır (ne kadar soluksa o kadar)
    saturation = analysis.avgSaturation < 0.18 ? 1.45 : 1.28;
  } else if (force) {
    saturation = 1.18; // manuel ama zaten canlıysa hafif
  }
  modulate.saturation = saturation;

  // şeffaflığı koru: alpha kanalını ayır, RGB'yi işle, geri birleştir
  let pipeline = sharp(buffer).ensureAlpha();

  // doygunluk/parlaklık
  pipeline = pipeline.modulate({ saturation });

  // düşük kontrast → hafif kontrast eğrisi (linear: çarpan + offset)
  if (analysis.isLowContrast) {
    // hafif S-eğrisi etkisi: kontrastı aç ama kırpma yapma
    pipeline = pipeline.linear(1.12, -15); // a*x + b
  }

  const out = await pipeline.png().toBuffer();
  return { buffer: out, applied: true, analysis, settings: { saturation, contrast: analysis.isLowContrast } };
}
