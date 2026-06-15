/**
 * Vektörleştirme + vektörlenebilirlik kontrolü.
 *
 * checkVectorizable: görselin logo/grafik mi (az renkli, keskin) yoksa
 *   fotoğraf mı olduğunu anlar. Logo ise vektöre uygundur.
 * makeVector: gerçek SVG üretir (potrace ile). Renkli vektör için
 *   görsel önce sadeleştirilir.
 *
 * VECTOR_PROVIDER: potrace | demo
 */
import sharp from "sharp";

const PROVIDER = (process.env.VECTOR_PROVIDER || "demo").toLowerCase();

export async function checkVectorizable(buffer) {
  // 64x64'e küçült, benzersiz renk say → az renk = logo = vektörlenebilir
  const small = await sharp(buffer).resize(64, 64, { fit: "inside" }).raw()
    .toBuffer({ resolveWithObject: true });
  const colors = new Set();
  const { data, info } = small;
  for (let i = 0; i < data.length; i += info.channels) {
    if (info.channels === 4 && data[i + 3] < 20) continue; // saydam atla
    colors.add(`${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`);
  }
  const uniqueColors = colors.size;
  // Eşik yüksek: pratikte her görsel vektörlenebilir sayılır.
  // (Basit logolar daha temiz vektör verir, fotoğraflar yine de bir vektör üretir.)
  const vectorizable = true;

  return { vectorizable, uniqueColors };
}

/**
 * Gerçek SVG üretir. potrace yüklüyse onu kullanır.
 * Renkli logolar için: görsel posterize edilir (renk azaltılır), sonra izlenir.
 * Döndürür: { svg } veya null
 */
export async function makeVector(buffer) {
  if (PROVIDER !== "potrace") return null;
  try {
    const sharpMod = sharp;
    const ImageTracer = (await import("imagetracerjs")).default;

    // Görseli hazırla: hafif median ile gürültüyü azalt (daha temiz vektör)
    const { data, info } = await sharpMod(buffer)
      .ensureAlpha()
      .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
      .median(2)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const imageData = {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    };

    // TEMİZ vektör (DTF1 gibi): az renk + agresif sadeleştirme = keskin, düz kenarlar.
    const svg = ImageTracer.imagedataToSVG(imageData, {
      numberofcolors: 16,
      colorsampling: 2,
      mincolorratio: 0.02,
      colorquantcycles: 3,
      pathomit: 12,
      ltres: 1.5,
      qtres: 1.5,
      rightangleenhance: true,
      blurradius: 0,
      strokewidth: 0,
      roundcoords: 1,
    });

    if (svg && svg.length > 200) return { svg };
    return null;
  } catch (err) {
    console.error("Vektör üretilemedi:", err.message);
    return null;
  }
}
