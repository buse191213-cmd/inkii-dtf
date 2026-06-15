/**
 * Çözünürlük yükseltme (upscale) sağlayıcıları.
 *
 * AKILLI ÖLÇEK: Sabit 4× yerine, görseli DTF baskı için
 * hedef çözünürlüğe ulaştıracak kadar büyütür.
 * - Hedef: en uzun kenar ~4000 px (yaklaşık 33 cm @ 300 DPI'a denk)
 * - Küçük görsel çok büyütülür, zaten büyük olan az/hiç büyütülmez
 * - Real-ESRGAN 2× veya 4× destekler; ihtiyaca göre seçilir
 *
 * UPSCALE_PROVIDER: replicate | local | demo
 */
import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";

const run = promisify(execFile);
const PROVIDER = (process.env.UPSCALE_PROVIDER || "demo").toLowerCase();

const TARGET_LONG_EDGE = 4000; // hedef en uzun kenar (px)
const MAX_LONG_EDGE = 6000;    // güvenlik üst sınırı

async function decideScale(buffer) {
  const meta = await sharp(buffer).metadata();
  const longEdge = Math.max(meta.width, meta.height);
  if (longEdge >= TARGET_LONG_EDGE) return { scale: 1, meta, longEdge };
  const ratio = TARGET_LONG_EDGE / longEdge;
  const scale = ratio > 2.2 ? 4 : 2;
  return { scale, meta, longEdge };
}

export async function upscaleImage(buffer) {
  const { scale } = await decideScale(buffer);
  if (scale === 1) return buffer;

  let out;
  switch (PROVIDER) {
    case "replicate": out = await viaReplicate(buffer, scale); break;
    case "local":     out = await viaRealEsrganLocal(buffer, scale); break;
    default:          out = await viaDemo(buffer, scale);
  }

  const m = await sharp(out).metadata();
  const longEdge = Math.max(m.width, m.height);
  if (longEdge > MAX_LONG_EDGE) {
    out = await sharp(out)
      .resize(
        m.width >= m.height ? MAX_LONG_EDGE : null,
        m.height > m.width ? MAX_LONG_EDGE : null,
        { kernel: "lanczos3", withoutEnlargement: true }
      )
      .png().toBuffer();
  }
  return out;
}

async function viaReplicate(buffer, scale) {
  const base64 = `data:image/png;base64,${buffer.toString("base64")}`;
  const start = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      version: "f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa",
      input: { image: base64, scale, face_enhance: false },
    }),
  });
  const pred = await start.json();
  if (pred.error) throw new Error(`Replicate: ${pred.error}`);

  let final = pred;
  for (let i = 0; i < 60 && final.status !== "succeeded" && final.status !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch(final.urls.get, {
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
    });
    final = await poll.json();
  }
  if (final.status === "failed") throw new Error("Replicate işlemi başarısız");

  const outUrl = Array.isArray(final.output) ? final.output[0] : final.output;
  if (!outUrl) throw new Error("Replicate çıktısı alınamadı");
  const img = await fetch(outUrl);
  return Buffer.from(await img.arrayBuffer());
}

async function viaRealEsrganLocal(buffer, scale) {
  const tmp = os.tmpdir();
  const inPath = path.join(tmp, `up_in_${Date.now()}.png`);
  const outPath = path.join(tmp, `up_out_${Date.now()}.png`);
  await fs.writeFile(inPath, buffer);
  await run("realesrgan-ncnn-vulkan", ["-i", inPath, "-o", outPath, "-s", String(scale), "-n", "realesrgan-x4plus"]);
  const out = await fs.readFile(outPath);
  fs.unlink(inPath).catch(() => {});
  fs.unlink(outPath).catch(() => {});
  return out;
}

async function viaDemo(buffer, scale) {
  const meta = await sharp(buffer).metadata();
  return sharp(buffer)
    .resize(Math.round(meta.width * scale), Math.round(meta.height * scale), { kernel: "lanczos3" })
    .png().toBuffer();
}
