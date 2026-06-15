/**
 * Kenar temizleme + keskinleştirme.
 * Alpha eşikleme ÇOK HAFİF: sadece neredeyse görünmez (hayalet) pikselleri siler,
 * görselin gerçek içeriğine dokunmaz.
 */
import sharp from "sharp";

export async function sharpenEdges(buffer) {
  // 1) ÇOK hafif alpha temizleme: sadece alpha < 15 olanları sil (gerçek hayalet).
  //    İçeriği (logo, açık renkler) korur.
  let cleaned = buffer;
  try {
    const img = sharp(buffer).ensureAlpha();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    if (info.channels === 4) {
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 15) data[i + 3] = 0; // sadece neredeyse görünmez olanı sil
      }
      cleaned = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png().toBuffer();
    }
  } catch {
    cleaned = buffer;
  }

  // 2) Güvenlik payı (%4 şeffaf çerçeve)
  const meta = await sharp(cleaned).metadata();
  const pad = Math.round(Math.max(meta.width, meta.height) * 0.04);
  const padded = await sharp(cleaned)
    .ensureAlpha()
    .extend({ top: pad, bottom: pad, left: pad, right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  // 3) Keskinleştirme
  return sharp(padded)
    .sharpen({ sigma: 1.2, m1: 0.8, m2: 2.0 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
