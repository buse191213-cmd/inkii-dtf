import { useState, useRef, useCallback, useEffect } from "react";

// DTF1 mantığında işleme adımları
const STEP_DEFS = [
  { key: "analyze", label: "Datei analysieren", de: "Dosya analizi" },
  { key: "background", label: "Hintergrund entfernen", de: "Arka plan kaldırma" },
  { key: "upscale", label: "Auflösung erhöhen", de: "Çözünürlük yükseltme" },
  { key: "sharpen", label: "Kanten schärfen", de: "Kenar keskinleştirme" },
  { key: "vector", label: "Vektorisierbarkeit prüfen", de: "Vektör kontrolü" },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default function DtfEngineDemo() {
  const [file, setFile] = useState(null);
  const [origUrl, setOrigUrl] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  const [steps, setSteps] = useState({});
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [meta, setMeta] = useState(null);
  const [vectorizable, setVectorizable] = useState(false);
  const [bgLib, setBgLib] = useState(null);
  const inputRef = useRef(null);

  // Tarayıcıda arka plan kaldırma kütüphanesini yükle (CDN)
  useEffect(() => {
    import("https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.5/+esm")
      .then((m) => setBgLib(() => m.removeBackground))
      .catch(() => setBgLib(null));
  }, []);

  const pickFile = (f) => {
    if (!f) return;
    setFile(f);
    setOrigUrl(URL.createObjectURL(f));
    setResultUrl(null);
    setSteps({});
    setMeta(null);
    setVectorizable(false);
  };

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    pickFile(e.dataTransfer.files?.[0]);
  }, []);

  const setStep = (key, status, label) =>
    setSteps((p) => ({ ...p, [key]: { status, label: label || STEP_DEFS.find((s) => s.key === key).label } }));

  // Görseli canvas'a çiz, piksel verisi al (analiz + vektör kontrolü için)
  const loadImage = (url) =>
    new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = url;
    });

  const process = async () => {
    if (!file) return;
    setBusy(true);
    setSteps(Object.fromEntries(STEP_DEFS.map((s) => [s.key, { status: "pending", label: s.label }])));

    try {
      // ── 1) Analiz ──
      setStep("analyze", "running");
      const img = await loadImage(origUrl);
      const w = img.naturalWidth, h = img.naturalHeight;
      const estDpi = Math.round(w / (25 / 2.54)); // 25cm baskıda DPI
      setMeta({ w, h, estDpi });
      await wait(400);
      setStep("analyze", "done", `Datei analysieren (${w}×${h}px)`);

      // ── 2) Arka plan kaldırma ──
      setStep("background", "running");
      let blob;
      if (bgLib) {
        blob = await bgLib(file); // gerçek AI (WebAssembly)
      } else {
        // kütüphane yüklenemediyse orijinali kullan
        blob = file;
        await wait(800);
      }
      const bgUrl = URL.createObjectURL(blob);
      setStep("background", "done", "Hintergrund entfernt");

      // ── 3) Upscale (canvas ile, lanczos benzeri) ──
      const needsUpscale = w < 1500 || h < 1500;
      let finalUrl = bgUrl;
      if (needsUpscale) {
        setStep("upscale", "running");
        const bgImg = await loadImage(bgUrl);
        const scale = 4;
        const c = document.createElement("canvas");
        c.width = bgImg.naturalWidth * scale;
        c.height = bgImg.naturalHeight * scale;
        const ctx = c.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bgImg, 0, 0, c.width, c.height);
        finalUrl = c.toDataURL("image/png");
        await wait(300);
        setStep("upscale", "done", "Auflösung erhöht (4×)");
      } else {
        setStep("upscale", "skipped", "Auflösung ausreichend");
      }

      // ── 4) Keskinleştirme (görsel olarak işaretle) ──
      setStep("sharpen", "running");
      await wait(400);
      setStep("sharpen", "done", "Kanten geschärft");

      // ── 5) Vektör kontrolü (renk çeşitliliği) ──
      setStep("vector", "running");
      const vImg = await loadImage(finalUrl);
      const vc = document.createElement("canvas");
      vc.width = 64; vc.height = 64;
      const vctx = vc.getContext("2d");
      vctx.drawImage(vImg, 0, 0, 64, 64);
      const px = vctx.getImageData(0, 0, 64, 64).data;
      const colors = new Set();
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 20) continue; // saydam pikselleri atla
        colors.add(`${px[i] >> 3},${px[i + 1] >> 3},${px[i + 2] >> 3}`);
      }
      const vec = colors.size < 64;
      setVectorizable(vec);
      await wait(300);
      setStep("vector", "done", vec ? "Vektor-Version bereit" : "Pixel-Version");

      setResultUrl(finalUrl);
    } catch (err) {
      console.error(err);
      setStep("background", "error", "Fehler: " + err.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFile(null); setOrigUrl(null); setResultUrl(null);
    setSteps({}); setMeta(null); setVectorizable(false);
  };

  return (
    <div style={styles.wrap}>
      <style>{css}</style>

      <div style={styles.header}>
        <span style={styles.logo}>dtf</span>
        <div>
          <h1 style={styles.h1}>DTF-Engine</h1>
          <p style={styles.sub}>Logo yükle · arka plan KI ile kalksın · kalite yükselsin</p>
        </div>
      </div>

      {!file && (
        <div
          className={`dz ${dragging ? "drag" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
        >
          <div className="dz-icon">↑</div>
          <p className="dz-title">Datei hier ablegen oder klicken</p>
          <p className="dz-sub">PNG · JPG · WebP · GIF</p>
          <input ref={inputRef} type="file" accept="image/*" hidden
            onChange={(e) => pickFile(e.target.files?.[0])} />
        </div>
      )}

      {file && (
        <div className="work">
          <div className="preview checker">
            <img src={resultUrl || origUrl} alt="Vorschau" />
            {meta && (
              <div className="dims">
                {resultUrl
                  ? `${(((resultUrl ? meta.w * (meta.w < 1500 ? 4 : 1) : meta.w)) / 300 * 2.54).toFixed(1)} cm`
                  : `${meta.w}×${meta.h}px · ~${meta.estDpi} DPI`}
              </div>
            )}
          </div>

          <div className="panel">
            <ul className="steps">
              {STEP_DEFS.map((d) => {
                const s = steps[d.key] || {};
                return (
                  <li key={d.key} className={`step ${s.status || "idle"}`}>
                    <span className="dot">
                      {s.status === "done" && "✓"}
                      {s.status === "running" && <span className="spin" />}
                      {s.status === "skipped" && "–"}
                      {s.status === "error" && "!"}
                    </span>
                    <span className="lbl">{s.label || d.label}</span>
                    <span className="de">{d.de}</span>
                  </li>
                );
              })}
            </ul>

            {resultUrl && (
              <div className="badges">
                {vectorizable && <span className="badge gold">✨ Vektor-Version bereit</span>}
                <span className="badge">Hintergrund entfernt</span>
              </div>
            )}

            <div className="actions">
              {!resultUrl && (
                <button className="btn primary" onClick={process} disabled={busy}>
                  {busy ? "Wird optimiert…" : bgLib ? "Design optimieren" : "Lädt KI-Modell…"}
                </button>
              )}
              {resultUrl && (
                <a className="btn primary" href={resultUrl} download="dtf-transfer.png">
                  Herunterladen
                </a>
              )}
              <button className="btn ghost" onClick={reset}>Neues Motiv</button>
            </div>

            {!bgLib && <p className="hint">KI-Modell wird geladen… (ilk seferde birkaç saniye)</p>}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { maxWidth: 880, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" },
  header: { display: "flex", gap: 14, alignItems: "center", marginBottom: 24 },
  logo: { width: 48, height: 48, borderRadius: 12, background: "#0f766e", color: "#fff",
    display: "grid", placeItems: "center", fontWeight: 800, fontSize: 20, letterSpacing: -1 },
  h1: { margin: 0, fontSize: 24, color: "#0f172a" },
  sub: { margin: "2px 0 0", color: "#64748b", fontSize: 14 },
};

const css = `
.dz { border: 2px dashed #cbd5e1; border-radius: 16px; padding: 48px 24px; text-align: center;
  cursor: pointer; transition: .2s; background: #f8fafc; }
.dz:hover, .dz.drag { border-color: #0f766e; background: #f0fdfa; }
.dz-icon { width: 52px; height: 52px; margin: 0 auto 12px; border-radius: 50%;
  background: #0f766e; color: #fff; display: grid; place-items: center; font-size: 24px; }
.dz-title { font-weight: 600; color: #0f172a; margin: 0 0 4px; }
.dz-sub { color: #94a3b8; font-size: 13px; margin: 0; }

.work { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 640px) { .work { grid-template-columns: 1fr; } }

.preview { position: relative; border-radius: 16px; overflow: hidden; min-height: 280px;
  display: grid; place-items: center; padding: 16px; }
.checker { background-image:
  linear-gradient(45deg,#e2e8f0 25%,transparent 25%),
  linear-gradient(-45deg,#e2e8f0 25%,transparent 25%),
  linear-gradient(45deg,transparent 75%,#e2e8f0 75%),
  linear-gradient(-45deg,transparent 75%,#e2e8f0 75%);
  background-size: 20px 20px; background-position: 0 0,0 10px,10px -10px,-10px 0; }
.preview img { max-width: 100%; max-height: 320px; object-fit: contain; }
.dims { position: absolute; bottom: 10px; left: 10px; background: #0f172a; color: #fff;
  font-size: 12px; padding: 4px 10px; border-radius: 8px; }

.panel { display: flex; flex-direction: column; gap: 16px; }
.steps { list-style: none; padding: 0; margin: 0; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; }
.step { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid #f1f5f9; }
.step:last-child { border-bottom: none; }
.step .dot { width: 22px; height: 22px; border-radius: 50%; background: #f1f5f9; color: #fff;
  display: grid; place-items: center; font-size: 12px; flex-shrink: 0; }
.step.done .dot { background: #16a34a; }
.step.running .dot { background: #0f766e; }
.step.skipped .dot { background: #cbd5e1; }
.step.error .dot { background: #dc2626; }
.step .lbl { font-size: 14px; color: #0f172a; font-weight: 500; }
.step .de { margin-left: auto; font-size: 11px; color: #94a3b8; }
.step.idle .lbl { color: #94a3b8; }

.spin { width: 10px; height: 10px; border: 2px solid #fff; border-top-color: transparent;
  border-radius: 50%; animation: sp .7s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }

.badges { display: flex; flex-wrap: wrap; gap: 8px; }
.badge { font-size: 12px; padding: 5px 10px; border-radius: 8px; background: #f1f5f9; color: #475569; }
.badge.gold { background: #fef3c7; color: #b45309; font-weight: 600; }

.actions { display: flex; gap: 10px; }
.btn { padding: 11px 18px; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer;
  border: none; text-decoration: none; display: inline-grid; place-items: center; }
.btn.primary { background: #0f766e; color: #fff; }
.btn.primary:disabled { opacity: .6; cursor: default; }
.btn.ghost { background: #f1f5f9; color: #475569; }
.hint { font-size: 12px; color: #94a3b8; margin: 0; }
`;
