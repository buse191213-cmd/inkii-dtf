/**
 * Çözünürlük yükseltme (upscale) sağlayıcıları.
 * AKILLI ÖLÇEK: hedef ~4000px en uzun kenar. Küçük görsel çok, büyük az/hiç büyür.
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
const TARGET_LONG_EDGE = 4000;
const MAX_LONG_EDGE = 6000;

async function decideScale(buffer) {
  const meta = await sharp(buffer).metadata();
  const longEdge = Math.max(meta.width, meta.height);
  if (longEdge >= TARGET_LONG_EDGE) return { scale: 1 };
  const ratio = TARGET_LONG_EDGE / longEdge;
  return { scale: ratio > 2.2 ? 4 : 2 };
}

export async function upscaleImage(buffer) {
  const { scale } = await decideScale(buffer);
  if (scale === 1) return buffer;

  let out;
  try {
    switch (PROVIDER) {
      case "clarity":   out = await viaClarity(buffer, scale); break;
      case "replicate": out = await viaReplicate(buffer, scale); break;
      case "local":     out = await viaRealEsrganLocal(buffer, scale); break;
      default:          out = await viaDemo(buffer, scale);
    }
  } catch (err) {
    // Replicate başarısız olursa süreç çökmesin — demo (lanczos) ile devam
    console.error("Upscale hatası, lanczos'a düşülüyor:", err.message);
    out = await viaDemo(buffer, scale);
  }

  const m = await sharp(out).metadata();
  if (Math.max(m.width, m.height) > MAX_LONG_EDGE) {
    out = await sharp(out)
      .resize(
        m.width >= m.height ? MAX_LONG_EDGE : null,
        m.height > m.width ? MAX_LONG_EDGE : null,
        { kernel: "lanczos3", withoutEnlargement: true }
      ).png().toBuffer();
  }
  return out;
}

// ── Clarity Upscaler (Replicate) - en yüksek kalite, baskı için ──
async function viaClarity(buffer, scale) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN yok");
  const base64 = `data:image/png;base64,${buffer.toString("base64")}`;
  const start = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      version: "7787569e916746b4d7a19b7dbf5439fbcfd4d39445f875fc6e15d4b49786e46b",
      input: {
        image: base64,
        scale_factor: scale >= 4 ? 4 : 2,
        dynamic: 6,
        creativity: 0.3,
        resemblance: 1.5,
        sharpen: 1,
        output_format: "png",
      },
    }),
  });
  let pred;
  try { pred = await start.json(); } catch { throw new Error(`Clarity cevabi okunamadi (HTTP ${start.status})`); }
  if (!start.ok) throw new Error(`Clarity HTTP ${start.status}: ${pred?.detail || pred?.error || ""}`);
  if (pred.error) throw new Error(`Clarity: ${pred.error}`);

  let final = pred;
  for (let i = 0; i < 80 && final.status !== "succeeded" && final.status !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollUrl = final?.urls?.get || `https://api.replicate.com/v1/predictions/${final.id}`;
    const poll = await fetch(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
    final = await poll.json();
  }
  if (final.status === "failed") throw new Error("Clarity başarısız");
  const outUrl = Array.isArray(final.output) ? final.output[0] : final.output;
  if (!outUrl) throw new Error("Clarity çıktısı boş");
  const img = await fetch(outUrl);
  return Buffer.from(await img.arrayBuffer());
}

async function viaReplicate(buffer, scale) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN yok");
  const base64 = `data:image/png;base64,${buffer.toString("base64")}`;

  const startRes = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      version: "f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa",
      input: { image: base64, scale, face_enhance: false },
    }),
  });

  // Cevabı güvenli parse et
  let pred;
  try { pred = await startRes.json(); }
  catch { throw new Error(`Replicate cevabı okunamadı (HTTP ${startRes.status})`); }

  if (!startRes.ok) {
    throw new Error(`Replicate HTTP ${startRes.status}: ${pred?.detail || pred?.error || "bilinmeyen"}`);
  }
  if (pred.error) throw new Error(`Replicate: ${pred.error}`);

  // Zaten bittiyse direkt çıktıyı al
  if (pred.status === "succeeded" && pred.output) {
    return await fetchOutput(pred.output);
  }

  // Bitmemişse poll et — urls.get güvenli kontrol
  const getUrl = pred?.urls?.get;
  if (!getUrl) {
    // urls yoksa ama id varsa standart URL kur
    if (!pred.id) throw new Error("Replicate: prediction id alınamadı");
    return await pollById(pred.id, token);
  }
  return await pollByUrl(getUrl, token);
}

async function pollByUrl(url, token) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const p = await res.json();
    if (p.status === "succeeded") return await fetchOutput(p.output);
    if (p.status === "failed" || p.status === "canceled") throw new Error("Replicate işlemi başarısız");
  }
  throw new Error("Replicate zaman aşımı");
}

async function pollById(id, token) {
  return pollByUrl(`https://api.replicate.com/v1/predictions/${id}`, token);
}

async function fetchOutput(output) {
  const url = Array.isArray(output) ? output[0] : output;
  if (!url) throw new Error("Replicate çıktı URL'i boş");
  const img = await fetch(url);
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
