/**
 * Arka plan kaldırma sağlayıcıları.
 * BG_PROVIDER: replicate | removebg | photoroom | local | demo
 *
 * "replicate" = BRIA RMBG 1.4 (Replicate üzerinden, ~1000 görsel/1$, kaliteli)
 *
 * Hata durumu: API başarısız olursa (403, kredi bitti vs.) ARTIK ÇÖKMÜYOR.
 * Bunun yerine hatayı üst katmana bildiriyor ki kullanıcı sebebini görsün,
 * ama isteğe bağlı: hata olursa orijinali döndürüp süreç devam etsin.
 */
import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";

const run = promisify(execFile);
const PROVIDER = (process.env.BG_PROVIDER || "demo").toLowerCase();

// Sonuç + bilgi döndürür: { buffer, ok, message }
export async function removeBackground(buffer) {
  try {
    let out;
    switch (PROVIDER) {
      case "replicate": out = await viaReplicateRMBG(buffer); break;
      case "birefnet":  out = await viaBiRefNet(buffer); break;
      case "removebg":  out = await viaRemoveBg(buffer); break;
      case "photoroom": out = await viaPhotoroom(buffer); break;
      case "local":     out = await viaRembgLocal(buffer); break;
      default:          out = await viaDemo(buffer); return { buffer: out, ok: true, message: "demo (arka plan silinmedi)" };
    }
    return { buffer: out, ok: true, message: "Hintergrund entfernt" };
  } catch (err) {
    // Hata olsa bile süreç devam etsin: orijinali döndür ama hatayı bildir
    const fallback = await sharp(buffer).ensureAlpha().png().toBuffer();
    return { buffer: fallback, ok: false, message: err.message };
  }
}

// ── BRIA RMBG 2.0 (Replicate, resmi model - kaliteli kenar) ──
async function viaReplicateRMBG(buffer) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token || token.includes("BURAYA") || token.includes("ANAHTAR")) {
    throw new Error("Replicate token .env'de ayarli degil");
  }
  const base64 = `data:image/png;base64,${buffer.toString("base64")}`;
  // Resmi model: versiyon hash'i yerine model adıyla çağrılır
  const start = await fetch("https://api.replicate.com/v1/models/bria/remove-background/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      input: { image: base64 },
    }),
  });
  let pred;
  try { pred = await start.json(); } catch { throw new Error(`Replicate cevabi okunamadi (HTTP ${start.status})`); }
  if (!start.ok) throw new Error(`Replicate HTTP ${start.status}: ${pred?.detail || pred?.error || ""}`);
  if (pred.error) throw new Error(`Replicate: ${pred.error}`);

  let final = pred;
  for (let i = 0; i < 60 && final.status !== "succeeded" && final.status !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const pollUrl = final?.urls?.get || `https://api.replicate.com/v1/predictions/${final.id}`;
    const poll = await fetch(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
    final = await poll.json();
  }
  if (final.status === "failed") throw new Error("Replicate RMBG basarisiz");
  const outUrl = Array.isArray(final.output) ? final.output[0] : final.output;
  if (!outUrl) throw new Error("Replicate RMBG ciktisi bos");
  const img = await fetch(outUrl);
  return Buffer.from(await img.arrayBuffer());
}

// ── BiRefNet (Replicate) - RMBG 2.0 ile karşılaştırma için ──
async function viaBiRefNet(buffer) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token || token.includes("BURAYA") || token.includes("ANAHTAR")) {
    throw new Error("Replicate token .env'de ayarli degil");
  }
  const base64 = `data:image/png;base64,${buffer.toString("base64")}`;
  const start = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      version: "f74986db0355b58403ed20963af156525e2891ea3c2d499bfbfb2a28cd87c5d7",
      input: { image: base64 },
    }),
  });
  let pred;
  try { pred = await start.json(); } catch { throw new Error(`Replicate cevabi okunamadi (HTTP ${start.status})`); }
  if (!start.ok) throw new Error(`Replicate HTTP ${start.status}: ${pred?.detail || pred?.error || ""}`);
  if (pred.error) throw new Error(`Replicate: ${pred.error}`);

  let final = pred;
  for (let i = 0; i < 60 && final.status !== "succeeded" && final.status !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const pollUrl = final?.urls?.get || `https://api.replicate.com/v1/predictions/${final.id}`;
    const poll = await fetch(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
    final = await poll.json();
  }
  if (final.status === "failed") throw new Error("Replicate BiRefNet basarisiz");
  const outUrl = Array.isArray(final.output) ? final.output[0] : final.output;
  if (!outUrl) throw new Error("Replicate BiRefNet ciktisi bos");
  const img = await fetch(outUrl);
  return Buffer.from(await img.arrayBuffer());
}

async function viaRemoveBg(buffer) {
  const key = process.env.REMOVEBG_API_KEY;
  if (!key || key.includes("BURAYA") || key.includes("ANAHTAR")) {
    throw new Error("remove.bg API anahtarı .env'de ayarlı değil");
  }
  const form = new FormData();
  form.append("image_file", new Blob([buffer]), "input.png");
  form.append("size", "auto");
  const res = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": key },
    body: form,
  });
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j?.errors?.[0]?.title || ""; } catch {}
    const hint = res.status === 403 ? " (anahtar geçersiz/iptal)" :
                 res.status === 402 ? " (kredi bitti)" : "";
    throw new Error(`remove.bg ${res.status}${hint} ${detail}`.trim());
  }
  return Buffer.from(await res.arrayBuffer());
}

async function viaPhotoroom(buffer) {
  const form = new FormData();
  form.append("image_file", new Blob([buffer]), "input.png");
  const res = await fetch("https://sdk.photoroom.com/v1/segment", {
    method: "POST",
    headers: { "x-api-key": process.env.PHOTOROOM_API_KEY },
    body: form,
  });
  if (!res.ok) throw new Error(`Photoroom hatası: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function viaRembgLocal(buffer) {
  const tmp = os.tmpdir();
  const inPath = path.join(tmp, `bg_in_${Date.now()}.png`);
  const outPath = path.join(tmp, `bg_out_${Date.now()}.png`);
  await fs.writeFile(inPath, buffer);
  // RMBG-1.4 modeli (isnet-general-use) ince kenarlarda çok iyi sonuç verir.
  // "python3 -m rembg" çağrısı PATH sorunlarını önler.
  try {
    await run("python3", ["-m", "rembg", "i", "-m", "isnet-general-use", inPath, outPath]);
  } catch {
    // model adı eski rembg'de farklıysa varsayılan u2net'e düş
    await run("python3", ["-m", "rembg", "i", inPath, outPath]);
  }
  const out = await fs.readFile(outPath);
  fs.unlink(inPath).catch(() => {});
  fs.unlink(outPath).catch(() => {});
  return out;
}

async function viaDemo(buffer) {
  return sharp(buffer).ensureAlpha().png().toBuffer();
}
