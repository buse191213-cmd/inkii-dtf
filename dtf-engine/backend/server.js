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

import "dotenv/config";
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
import { checkVectorizable, makeVector } from "./providers/vectorize.js";
import { analyzeQuality, analyzeWhiteInk, buildReport, buildReportPDF } from "./providers/quality.js";
import { optimizeColor } from "./providers/coloroptimize.js";
import { cleanEdges } from "./providers/edgecleanup.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const archiver = require("archiver");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use("/results", express.static(path.join(__dirname, "results")));
// Web arayüzü (index.html) — tarayıcıda http://localhost:4000 açılınca gelir
app.use(express.static(path.join(__dirname, "public")));

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
  const bgResult = await removeBackground(buffer);
  let working = bgResult.buffer;
  let bgRemoved = bgResult.ok;
  onStep({
    key: "background",
    label: bgResult.ok ? "Hintergrund entfernt" : `Hintergrund: ${bgResult.message}`,
    status: bgResult.ok ? "done" : "error",
  });

  // ── Adım 2.2: Kenar temizleme (defringe) ────────────────
  // Arka plan kaldırma sonrası kalan beyaz/gri halo'yu temizle.
  if (bgRemoved) {
    onStep({ key: "edge", label: "Kanten reinigen", status: "running" });
    const edgeRes = await cleanEdges(working);
    working = edgeRes.buffer;
    onStep({
      key: "edge",
      label: edgeRes.applied ? "Kanten gereinigt" : "Kanten sauber",
      status: edgeRes.applied ? "done" : "skipped",
    });
  }

  // ── Adım 2.5: AUTO-CROP (arka plandan sonra, upscale'den ÖNCE) ──
  // Saydam boşluğu kırp, içeriği kadraja oturt. Küçük görseli büyütmek,
  // boş kareyi büyütmekten çok daha kaliteli sonuç verir (DTF1 mantığı).
  try {
    const cropped = await sharp(working).trim({ threshold: 10 }).toBuffer();
    // trim tüm resmi atmadıysa kullan
    const cm = await sharp(cropped).metadata();
    if (cm.width > 10 && cm.height > 10) working = cropped;
  } catch { /* trim başarısızsa orijinali tut */ }

  // ── Adım 3: Çözünürlük yükseltme (akıllı) ───────────────
  // upscaleImage kendi karar verir: küçükse çok, büyükse az/hiç büyütür,
  // hedef ~4000px en uzun kenara ulaşmaya çalışır.
  onStep({ key: "upscale", label: "Auflösung erhöhen", status: "running" });
  const beforeW = (await sharp(working).metadata()).width;
  working = await upscaleImage(working);
  const afterW = (await sharp(working).metadata()).width;
  const factor = (afterW / beforeW).toFixed(1);
  onStep({
    key: "upscale",
    label: afterW > beforeW ? `Auflösung erhöht (${factor}×)` : "Auflösung ausreichend",
    status: afterW > beforeW ? "done" : "skipped",
  });

  // ── Adım 3.5: Renk/kontrast optimizasyonu (akıllı) ──────
  onStep({ key: "color", label: "Farben optimieren", status: "running" });
  const colorRes = await optimizeColor(working, { force: false });
  working = colorRes.buffer;
  onStep({
    key: "color",
    label: colorRes.applied ? "Farben optimiert" : "Farben bereits optimal",
    status: colorRes.applied ? "done" : "skipped",
    info: colorRes.analysis,
  });

  // ── Adım 4: Kenar keskinleştirme ────────────────────────
  onStep({ key: "sharpen", label: "Kanten schärfen", status: "running" });
  working = await sharpenEdges(working);
  onStep({ key: "sharpen", label: "Kanten geschärft", status: "done" });

  // ── Adım 5: Vektörleştirme ──────────────────────────────
  onStep({ key: "vector", label: "Vektorisierbarkeit prüfen", status: "running" });
  const vector = await checkVectorizable(working);
  let vectorUrl = null;
  if (vector.vectorizable) {
    const vec = await makeVector(working);
    if (vec && vec.svg) {
      const svgName = `${id}.svg`;
      await fs.writeFile(path.join(outDir, svgName), vec.svg);
      vectorUrl = `/results/${svgName}`;
    }
  }
  onStep({
    key: "vector",
    label: vector.vectorizable ? "Vektor-Version bereit" : "Pixel-Version",
    status: "done",
    info: vector,
  });

  // ── Adım 6: DTF baskı kalite analizi ────────────────────
  onStep({ key: "quality", label: "Druckqualität prüfen", status: "running" });
  const quality = await analyzeQuality(working);
  const whiteInk = await analyzeWhiteInk(working);
  const report = buildReport(quality, whiteInk, vector);
  // rapor PDF üret (INKIIWORKS markalı, indirilesin)
  const reportName = `${id}_report.pdf`;
  try {
    const pdfBuffer = await buildReportPDF(report, quality, whiteInk, working);
    await fs.writeFile(path.join(outDir, reportName), pdfBuffer);
  } catch (e) {
    console.error("PDF rapor üretilemedi:", e.message);
  }
  onStep({
    key: "quality",
    label: `Qualität: ${quality.score}/100 ${quality.statusIcon}`,
    status: "done",
    info: { score: quality.score, status: quality.status },
  });

  // ── Yapılandırılmış çıktıları kaydet (madde 9) ──────────
  // Hepsi {id}/ klasör mantığıyla, ZIP'te düzenli olsun.
  const outName = `${id}.png`;                    // ana çıktı (final)
  await fs.writeFile(path.join(outDir, outName), working);
  // şeffaf versiyon (zaten şeffaf ama isimli kopya)
  const transparentName = `${id}_transparent.png`;
  await fs.writeFile(path.join(outDir, transparentName), working);
  // upscaled versiyon (final zaten upscaled — büyük baskı için isimli)
  const upscaledName = `${id}_upscaled.png`;
  await fs.writeFile(path.join(outDir, upscaledName), working);

  const finalMeta = await sharp(working).metadata();
  return {
    id,
    resultUrl: `/results/${outName}`,
    vectorUrl,
    reportUrl: `/results/${reportName}`,
    zipUrl: `/api/download-all/${id}`,
    width: finalMeta.width,
    height: finalMeta.height,
    printSizeCm: {
      width: +(finalMeta.width / 300 * 2.54).toFixed(2),
      height: +(finalMeta.height / 300 * 2.54).toFixed(2),
    },
    vectorizable: vector.vectorizable,
    bgRemoved,
    bgMessage: bgResult.message,
    quality,
    whiteInk,
    report,
  };
}

// ── Tüm çıktıları ZIP olarak indir (madde 9) ──────────────
app.get("/api/download-all/:id", async (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9-]/gi, ""); // güvenlik
  const outDir = path.join(__dirname, "results");
  // bu id'ye ait dosyaları bul
  let files;
  try {
    const all = await fs.readdir(outDir);
    files = all.filter((f) => f.startsWith(id));
  } catch {
    return res.status(404).json({ error: "Sonuç bulunamadı" });
  }
  if (!files.length) return res.status(404).json({ error: "Dosya yok" });

  res.attachment(`inkiiworks-dtf-${id}.zip`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => res.status(500).end(String(err)));
  archive.pipe(res);

  // dosyaları anlamlı isimlerle ZIP'e ekle
  const nameMap = {
    [`${id}.png`]: "final.png",
    [`${id}_transparent.png`]: "final_transparent.png",
    [`${id}_upscaled.png`]: "final_upscaled.png",
    [`${id}.svg`]: "final_vector.svg",
    [`${id}_report.pdf`]: "quality_report.pdf",
  };
  for (const f of files) {
    const nice = nameMap[f] || f;
    archive.file(path.join(outDir, f), { name: nice });
  }
  archive.finalize();
});

app.listen(PORT, () => console.log(`DTF-Engine backend → http://localhost:${PORT}`));
