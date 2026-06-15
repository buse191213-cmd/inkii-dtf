import { useState, useRef, useCallback } from "react";

/**
 * DTF-Engine — Yükleme ve İşleme Bileşeni
 * --------------------------------------
 * DTF1.de mantığında: kullanıcı logosunu yükler, backend hattı
 * her adımı (analiz → arka plan → upscale → keskinleştirme → vektör)
 * canlı olarak gösterir.
 *
 * Backend adresini değiştir:  const API = "http://localhost:4000"
 */

const API = "http://localhost:4000";

// İşleme adımları — DTF1'deki sırayla
const STEP_DEFS = [
  { key: "analyze",    label: "Datei analysieren" },
  { key: "background", label: "Hintergrund entfernen" },
  { key: "upscale",    label: "Auflösung erhöhen" },
  { key: "sharpen",    label: "Kanten schärfen" },
  { key: "vector",     label: "Vektorisierbarkeit prüfen" },
];

export default function DtfEngine() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [steps, setSteps] = useState({});       // { key: {status, label, info} }
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const pickFile = (f) => {
    if (!f) return;
    setError(null);
    setResult(null);
    setSteps({});
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    pickFile(e.dataTransfer.files?.[0]);
  }, []);

  // Backend'e gönder — SSE ile adım adım ilerlemeyi dinle
  const process = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    // Adımları "bekliyor" olarak başlat
    setSteps(Object.fromEntries(STEP_DEFS.map((s) => [s.key, { ...s, status: "pending" }])));

    try {
      const form = new FormData();
      form.append("image", file);
      const res = await fetch(`${API}/api/process-stream`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`Sunucu hatası: ${res.status}`);

      // SSE akışını oku
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop(); // yarım kalanı sakla

        for (const block of events) {
          const evtMatch = block.match(/^event: (.+)$/m);
          const dataMatch = block.match(/^data: (.+)$/m);
          if (!evtMatch || !dataMatch) continue;
          const evt = evtMatch[1];
          const data = JSON.parse(dataMatch[1]);

          if (evt === "step") {
            setSteps((prev) => ({ ...prev, [data.key]: { ...prev[data.key], ...data } }));
          } else if (evt === "done") {
            setResult(data);
          } else if (evt === "error") {
            setError(data.message);
          }
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dtf-engine">
      <h2>DTF-Engine V2.2</h2>

      {/* Yükleme alanı */}
      {!file && (
        <div
          className={`dropzone ${dragging ? "dragging" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
        >
          <p className="dz-title">Hier klicken oder Datei per Drag &amp; Drop ablegen</p>
          <p className="dz-sub">PNG, JPG, GIF, WebP oder PDF</p>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
            hidden
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
        </div>
      )}

      {/* Önizleme + İşle butonu */}
      {file && (
        <div className="work-area">
          <div className="preview-col">
            <div className="preview-box checker">
              <img src={result?.resultUrl ? API + result.resultUrl : preview} alt="Vorschau" />
            </div>
            {result && (
              <p className="size-label">
                {result.printSizeCm.width} × {result.printSizeCm.height} cm
              </p>
            )}
          </div>

          <div className="steps-col">
            {/* Adım listesi */}
            <ul className="steps">
              {STEP_DEFS.map((def) => {
                const s = steps[def.key] || {};
                return (
                  <li key={def.key} className={`step ${s.status || ""}`}>
                    <span className="dot" />
                    <span className="step-label">{s.label || def.label}</span>
                    <span className="step-status">
                      {s.status === "running" && "…"}
                      {s.status === "done" && "✓"}
                      {s.status === "skipped" && "—"}
                    </span>
                  </li>
                );
              })}
            </ul>

            {/* Sonuç bilgileri */}
            {result && (
              <div className="result-info">
                {result.vectorizable && <span className="badge vector">✨ Vektor-Version bereit</span>}
                <span className="badge">{result.width} × {result.height} px</span>
              </div>
            )}

            {error && <p className="error">{error}</p>}

            <div className="actions">
              {!result && (
                <button className="btn primary" onClick={process} disabled={busy}>
                  {busy ? "Wird optimiert…" : "Design optimieren"}
                </button>
              )}
              {result && (
                <a className="btn primary" href={API + result.resultUrl} download>
                  Ergebnis herunterladen
                </a>
              )}
              <button className="btn ghost" onClick={() => { setFile(null); setPreview(null); setResult(null); setSteps({}); }}>
                Neues Motiv
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
