/**
 * DTF-Engine Backend
 * -------------------
 * DTF1.de mantığında bir görüntü işleme hattı (pipeline).
 * Yüklenen logo/görsel sırayla şu adımlardan geçer:
 *   1) Dosya analizi      (boyut, format, çözünürlük)
 *   2) Arka plan kaldırma  (KI / AI)
 *   3) Çözünürlük yükseltme (upscale)
 *   4) Kenar keskinleştirme
 *   5) Vektörleştirme kontrolü (opsiyonel)
 *
 * Her adım için İKİ sağlayıcı (provider) seçeneği vardır:
 *   - "api":   hazır AI servisleri (kurulum yok, ücretli)
 *   - "local": kendi sunucunda açık kaynak araçlar (ücretsiz, GPU önerilir)
 * Hangisinin kullanılacağı .env dosyasından belirlenir.
 * Hiçbiri ayarlı değilse "demo" modunda akışı taklit eder.
 */

import express from "express";
import multer from "multer";
import cors from "cors";
import sharp from "sharp";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { removeBackground } from "./providers/background.js";
import { upscaleImage } from "./providers/upscale.js";
import { sharpenEdges } from "./providers/sharpen.js";
import { checkVectorizable } from "./providers/vectorize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use("/results", express.static(path.join(__dirname, "results")));

// Yüklenen dosyaları bellekte tut (max 25 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|gif|webp)|application\/pdf/.test(file.mimetype);
    cb(ok ? null : new Error("Desteklenmeyen dosya türü"), ok);
  },
});

/**
 * Tek seferlik işleme (basit kullanım).
 * Görseli alır, tüm hattı çalıştırır, sonuç URL'ini döner.
 */
app.post("/api/process", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Dosya bulunamadı" });
  try {
    const result = await runPipeline(req.file.buffer, req.file.originalname);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Adım adım işleme (Server-Sent Events).
 * Frontend bu uç noktayı dinleyerek DTF1'deki gibi
 * her adımın ilerlemesini canlı gösterir.
 */
app.post("/api/process-stream", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Dosya bulunamadı" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    await runPipeline(req.file.buffer, req.file.originalname, {
      onStep: (step) => send("step", step),
    }).then((result) => send("done", result));
  } catch (err) {
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

/**
 * İşleme hattı (pipeline).
 * @param {Buffer} buffer  ham görsel verisi
 * @param {string} name    orijinal dosya adı
 * @param {object} opts     { onStep } isteğe bağlı ilerleme bildirimi
 */
async function runPipeline(buffer, name, { onStep = () => {} } = {}) {
  const id = Date.now().toString(36);
  const outDir = path.join(__dirname, "results");
  await fs.mkdir(outDir, { recursive: true });

  // ── Adım 1: Analiz ──────────────────────────────────────
  onStep({ key: "analyze", label: "Datei analysieren", status: "running" });
  const meta = await sharp(buffer).metadata();
  const dpiAtWidth = (cmWidth) => Math.round((meta.width / (cmWidth / 2.54)));
  onStep({
    key: "analyze",
    label: "Datei analysieren",
    status: "done",
    info: {
      format: meta.format,
      width: meta.width,
      height: meta.height,
      hasAlpha: meta.hasAlpha,
      // 25 cm baskı genişliğinde tahmini DPI (DTF için 300 ideal)
      estimatedDpi: dpiAtWidth(25),
    },
  });

  // ── Adım 2: Arka plan kaldırma ──────────────────────────
  onStep({ key: "background", label: "Hintergrund entfernen", status: "running" });
  let working = await removeBackground(buffer);
  onStep({ key: "background", label: "Hintergrund entfernt", status: "done" });

  // ── Adım 3: Çözünürlük yükseltme ────────────────────────
  // Sadece düşük çözünürlükteyse upscale et (gereksiz maliyet/yavaşlık olmasın)
  const needsUpscale = meta.width < 1500 || meta.height < 1500;
  if (needsUpscale) {
    onStep({ key: "upscale", label: "Auflösung erhöhen", status: "running" });
    working = await upscaleImage(working, { scale: 4 });
    onStep({ key: "upscale", label: "Auflösung erhöht (4×)", status: "done" });
  } else {
    onStep({ key: "upscale", label: "Auflösung ausreichend", status: "skipped" });
  }

  // ── Adım 4: Kenar keskinleştirme ────────────────────────
  onStep({ key: "sharpen", label: "Kanten schärfen", status: "running" });
  working = await sharpenEdges(working);
  onStep({ key: "sharpen", label: "Kanten geschärft", status: "done" });

  // ── Adım 5: Vektörleştirilebilirlik ─────────────────────
  onStep({ key: "vector", label: "Vektorisierbarkeit prüfen", status: "running" });
  const vector = await checkVectorizable(working);
  onStep({
    key: "vector",
    label: vector.vectorizable ? "Vektor-Version bereit" : "Pixel-Version",
    status: "done",
    info: vector,
  });

  // ── Çıktıyı kaydet ──────────────────────────────────────
  const outName = `${id}.png`;
  const outPath = path.join(outDir, outName);
  await fs.writeFile(outPath, working);

  const finalMeta = await sharp(working).metadata();
  return {
    id,
    resultUrl: `/results/${outName}`,
    width: finalMeta.width,
    height: finalMeta.height,
    // Baskı boyutu (cm) — 300 DPI varsayımıyla
    printSizeCm: {
      width: +(finalMeta.width / 300 * 2.54).toFixed(2),
      height: +(finalMeta.height / 300 * 2.54).toFixed(2),
    },
    vectorizable: vector.vectorizable,
  };
}

app.listen(PORT, () => console.log(`DTF-Engine backend → http://localhost:${PORT}`));
