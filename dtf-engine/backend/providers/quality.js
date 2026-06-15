// providers/quality.js
// DTF baskı kalite analizi: skor, beyaz mürekkep uyarısı, üretim raporu.
// Hepsi yerel hesaplama (AI/kredi gerekmez).
import sharp from "sharp";
import PDFDocument from "pdfkit";

// ── 1) Baskı kalite skoru (0-100) ──────────────────────────
// Çözünürlük, şeffaflık ve baskı boyutuna göre puanlar.
export async function analyzeQuality(buffer) {
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  const longEdge = Math.max(width, height);
  const hasAlpha = !!meta.hasAlpha;

  // 300 DPI'da baskı boyutu (cm)
  const printW = +(width / 300 * 2.54).toFixed(1);
  const printH = +(height / 300 * 2.54).toFixed(1);

  // Renk sayısı (örnekleme ile, hız için küçült)
  const colorCount = await countColors(buffer);

  // ── Skor hesabı ──
  let score = 0;
  const reasons = [];

  // Çözünürlük puanı (max 50): uzun kenar 4000px+ = tam puan
  if (longEdge >= 4000) { score += 50; }
  else if (longEdge >= 3000) { score += 44; }
  else if (longEdge >= 2000) { score += 36; reasons.push("Orta çözünürlük"); }
  else if (longEdge >= 1200) { score += 25; reasons.push("Düşük çözünürlük — büyük baskıda zorlanır"); }
  else if (longEdge >= 600)  { score += 14; reasons.push("Çok düşük çözünürlük"); }
  else { score += 6; reasons.push("Baskı için yetersiz çözünürlük"); }

  // Şeffaflık puanı (max 25): DTF için şeffaf zemin şart
  if (hasAlpha) { score += 25; }
  else { reasons.push("Şeffaf zemin yok — arka plan temizlenmeli"); }

  // Baskı boyutu puanı (max 15): mantıklı baskı boyutu
  if (printW >= 20) { score += 15; }
  else if (printW >= 10) { score += 11; }
  else if (printW >= 5) { score += 7; }
  else { score += 3; reasons.push("Küçük baskı boyutu"); }

  // En-boy / netlik puanı (max 10)
  if (longEdge >= 1500) { score += 10; }
  else { score += 5; }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // ── Durum etiketi ──
  let status, statusIcon;
  if (score >= 85) { status = "Druckbereit"; statusIcon = "✓"; }
  else if (score >= 65) { status = "Gut — Upscaling empfohlen"; statusIcon = "↑"; }
  else if (score >= 45) { status = "Niedrige Auflösung"; statusIcon = "⚠"; }
  else { status = "Nicht für große Drucke geeignet"; statusIcon = "✗"; }

  // Tahmini DPI farklı baskı boyutlarında
  const dpiAt = (cm) => Math.round(width / (cm / 2.54));

  // Maksimum önerilen baskı genişliği (300 DPI koruyarak)
  const maxPrintWidth = +(width / 300 * 2.54).toFixed(0);
  // 150 DPI'a kadar kabul edilebilir (büyük baskı, uzaktan bakılır)
  const maxPrintWidth150 = +(width / 150 * 2.54).toFixed(0);

  return {
    width, height, longEdge, hasAlpha,
    printSizeCm: { width: printW, height: printH },
    colorCount,
    estimatedDpi: dpiAt(25),
    maxPrintWidthCm: maxPrintWidth,
    maxPrintWidthRelaxedCm: maxPrintWidth150,
    score, status, statusIcon, reasons,
  };
}

// ── 2) Beyaz mürekkep / kıyafet uyumu analizi ──────────────
// Logodaki beyaz/açık piksel oranını ölçer.
export async function analyzeWhiteInk(buffer) {
  // küçült (hız) + raw RGBA al
  const { data, info } = await sharp(buffer)
    .resize(200, 200, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let opaque = 0, white = 0, nearWhite = 0, lightGrey = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
    if (a < 30) continue; // şeffaf, sayma
    opaque++;
    const min = Math.min(r, g, b), max = Math.max(r, g, b);
    const lum = (r*0.299 + g*0.587 + b*0.114);
    const isGrey = (max - min) < 18; // renksiz (gri tonu)
    if (lum >= 245 && isGrey) white++;
    else if (lum >= 225 && isGrey) nearWhite++;
    else if (lum >= 200 && isGrey) lightGrey++;
  }
  const whitePct = opaque ? (white / opaque) * 100 : 0;
  const lightPct = opaque ? ((white + nearWhite + lightGrey) / opaque) * 100 : 0;

  const warnings = [];
  let whiteInkRecommended = false;
  let garmentHint = "";

  if (whitePct >= 5) {
    warnings.push("Enthält reine weiße Elemente — auf weißen Textilien unsichtbar.");
    whiteInkRecommended = true;
  }
  if (lightPct >= 15) {
    warnings.push("Helle Bereiche vorhanden — auf hellen Textilien schwach sichtbar.");
    whiteInkRecommended = true;
  }
  if (whiteInkRecommended) {
    garmentHint = "Für dunkle Textilien geeignet. Weiße Druckschicht (White Ink) empfohlen.";
  } else {
    garmentHint = "Für helle und dunkle Textilien geeignet.";
  }

  return {
    whitePct: +whitePct.toFixed(1),
    lightPct: +lightPct.toFixed(1),
    whiteInkRecommended,
    warnings,
    garmentHint,
  };
}

// ── 3) Üretim raporu (skor + beyaz mürekkep + öneriler) ────
export function buildReport(quality, whiteInk, vector) {
  // Önerilen ürünler (baskı boyutuna göre)
  const w = quality.maxPrintWidthRelaxedCm;
  const products = [];
  if (w >= 20) products.push("T-Shirts", "Hoodies", "Tote Bags", "Jacken");
  else if (w >= 10) products.push("T-Shirts", "Hoodies", "Polo");
  else if (w >= 6) products.push("Polo (Brust)", "Caps");
  else products.push("Caps", "Kleine Logos");

  let printStatus, printStatusIcon;
  if (quality.score >= 85) { printStatus = "READY FOR DTF PRODUCTION"; printStatusIcon = "✓"; }
  else if (quality.score >= 65) { printStatus = "PRODUKTION MÖGLICH — Upscaling empfohlen"; printStatusIcon = "↑"; }
  else { printStatus = "NICHT EMPFOHLEN für große Drucke"; printStatusIcon = "⚠"; }

  return {
    artworkSize: `${quality.width} × ${quality.height} px`,
    printSize: `${quality.printSizeCm.width} × ${quality.printSizeCm.height} cm`,
    estimatedDpi: quality.estimatedDpi,
    transparency: quality.hasAlpha ? "Ja (transparent)" : "Nein",
    colorCount: quality.colorCount,
    vectorAvailable: !!(vector && vector.vectorizable),
    qualityScore: quality.score,
    qualityStatus: quality.status,
    recommendedProducts: products,
    maxRecommendedWidthCm: quality.maxPrintWidthRelaxedCm,
    whiteInkRecommended: whiteInk.whiteInkRecommended,
    garmentHint: whiteInk.garmentHint,
    warnings: whiteInk.warnings,
    printStatus, printStatusIcon,
  };
}

// ── yardımcı: renk sayısı (örnekleme) ──────────────────────
async function countColors(buffer) {
  const { data } = await sharp(buffer)
    .resize(100, 100, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const set = new Set();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i+3] < 30) continue;
    // 16'ya yuvarla (yakın renkleri birleştir)
    const r = data[i] >> 4, g = data[i+1] >> 4, b = data[i+2] >> 4;
    set.add((r << 8) | (g << 4) | b);
  }
  return set.size;
}

// ── 4) PDF üretim raporu (INKIIWORKS markalı) ──────────────
// quality + whiteInk + report verilerinden profesyonel PDF üretir.
// previewBuffer: işlenmiş logo PNG (rapora küçük görsel koymak için, opsiyonel)
export async function buildReportPDF(report, quality, whiteInk, previewBuffer) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      const GREEN = "#1c2721", GOLD = "#d1aa81", GREY = "#64748b", DARK = "#0f172a";
      const pageW = doc.page.width - 100; // içerik genişliği

      // ── Sade başlık: sadece logo + ince çizgi ──
      doc.fillColor(DARK).fontSize(22).font("Helvetica-Bold")
         .text("INKIIWORKS", 50, 50);
      // altında ince ayraç çizgi
      doc.moveTo(50, 84).lineTo(doc.page.width - 50, 84).lineWidth(1).strokeColor("#e2e8f0").stroke();

      let y = 110;

      // rapor başlığı (sade)
      doc.fillColor(GREY).fontSize(11).font("Helvetica").text("PRODUKTIONSBERICHT", 50, y);
      y += 22;

      // ── Kalite skoru (sade, köşeli) ──
      let scoreColor = "#16a34a";
      if (quality.score < 85) scoreColor = "#f59e0b";
      if (quality.score < 65) scoreColor = "#ef4444";
      doc.rect(50, y, pageW, 64).fillAndStroke("#fbfcfd", "#e2e8f0");
      // skor (sade kare-rozet, solda)
      doc.rect(50, y, 64, 64).fill(scoreColor);
      doc.fillColor("#ffffff").fontSize(24).font("Helvetica-Bold")
         .text(String(quality.score), 50, y + 19, { width: 64, align: "center" });
      doc.fillColor(DARK).fontSize(14).font("Helvetica-Bold")
         .text(quality.status, 130, y + 18);
      doc.fillColor(GREY).fontSize(10).font("Helvetica")
         .text("Qualitätsbewertung " + quality.score + " / 100", 130, y + 38);
      y += 84;

      // ── Teknik bilgiler tablosu ──
      doc.fillColor(DARK).fontSize(13).font("Helvetica-Bold").text("Technische Daten", 50, y);
      y += 22;
      const rows = [
        ["Auflösung", quality.width + " × " + quality.height + " px"],
        ["Druckgröße (300 DPI)", quality.printSizeCm.width + " × " + quality.printSizeCm.height + " cm"],
        ["Geschätzte DPI (bei 25 cm)", String(quality.estimatedDpi)],
        ["Transparenz", quality.hasAlpha ? "Ja (transparent)" : "Nein"],
        ["Farbanzahl", String(quality.colorCount)],
        ["Vektor verfügbar", report.vectorAvailable ? "Ja" : "Nein (Pixel)"],
        ["Max. empfohlene Breite", report.maxRecommendedWidthCm + " cm"],
      ];
      doc.fontSize(10).font("Helvetica");
      rows.forEach((r, i) => {
        if (i % 2 === 0) doc.rect(50, y - 3, pageW, 20).fill("#f8fafc");
        doc.fillColor(GREY).font("Helvetica").text(r[0], 60, y);
        doc.fillColor(DARK).font("Helvetica-Bold").text(r[1], 50, y, { width: pageW - 10, align: "right" });
        y += 20;
      });
      y += 15;

      // ── Beyaz mürekkep / kıyafet uyarısı ──
      doc.fillColor(DARK).fontSize(13).font("Helvetica-Bold").text("Textil-Kompatibilität", 50, y);
      y += 20;
      const warnBg = whiteInk.whiteInkRecommended ? "#fef3c7" : "#f0fdf4";
      const warnBorder = whiteInk.whiteInkRecommended ? "#fcd34d" : "#86efac";
      const warnText = whiteInk.whiteInkRecommended ? "#92400e" : "#166534";
      const warnLines = (whiteInk.warnings && whiteInk.warnings.length ? whiteInk.warnings : [whiteInk.garmentHint]);
      const boxH = 24 + warnLines.length * 14 + 18;
      doc.rect(50, y, pageW, boxH).fillAndStroke(warnBg, warnBorder);
      doc.fillColor(warnText).fontSize(10).font("Helvetica");
      let ty = y + 12;
      warnLines.forEach((w) => {
        doc.text((whiteInk.whiteInkRecommended ? "! " : "+ ") + w, 62, ty, { width: pageW - 24 });
        ty += 14;
      });
      doc.font("Helvetica-Bold").text(whiteInk.garmentHint, 62, ty + 2, { width: pageW - 24 });
      y += boxH + 20;

      // ── Önerilen ürünler ──
      doc.fillColor(DARK).fontSize(13).font("Helvetica-Bold").text("Empfohlene Produkte", 50, y);
      y += 20;
      doc.fillColor(GREY).fontSize(11).font("Helvetica")
         .text((report.recommendedProducts || []).join("  ·  "), 50, y, { width: pageW });
      y += 30;

      // ── Üretim durumu (büyük) ──
      const statusBg = quality.score >= 65 ? "#f0fdf4" : "#fef2f2";
      const statusColor = quality.score >= 65 ? "#166534" : "#991b1b";
      doc.rect(50, y, pageW, 40).fill(statusBg);
      doc.fillColor(statusColor).fontSize(14).font("Helvetica-Bold")
         .text(report.printStatus, 50, y + 12, { width: pageW, align: "center" });

      // ── Alt bilgi ──
      doc.fillColor(GREY).fontSize(8).font("Helvetica")
         .text("INKIIWORKS DTF-Engine · Textilveredelung · Werbemittel · Druck", 50, doc.page.height - 60, { width: pageW, align: "center" });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
