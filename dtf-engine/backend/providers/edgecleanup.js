// providers/edgecleanup.js
// DTF için kenar temizleme: arka plan kaldırma sonrası kalan
// beyaz/gri halo (fringe), yarı saydam matte ve izole artık pikselleri temizler.
import sharp from "sharp";

export async function cleanEdges(buffer, { aggressive = true } = {}) {
  try {
    const { data, info } = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.channels !== 4) return { buffer, applied: false };

    const W = info.width, H = info.height;
    const idx = (x, y) => (y * W + x) * 4;

    const isEdge = (x, y) => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) return true;
          if (data[idx(nx, ny) + 3] < 40) return true;
        }
      }
      return false;
    };

    // agresif modda eşik daha yüksek (daha çok yarı saydam temizlenir)
    const aThresh = aggressive ? 230 : 180;
    let cleaned = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        const a = data[i + 3];
        if (a === 0 || a === 255) continue;
        if (a >= 240) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const lum = (r * 0.299 + g * 0.587 + b * 0.114);
        const isGreyish = (max - min) < 40;
        const isLight = lum > 150;
        if (isEdge(x, y) && (isLight || isGreyish) && a < aThresh) {
          data[i + 3] = 0;
          cleaned++;
        }
      }
    }

    // renk emdirme (beyaz fringe → içerik rengi)
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = idx(x, y);
        const a = data[i + 3];
        if (a < 60 || a >= 230) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lum = (r * 0.299 + g * 0.587 + b * 0.114);
        if (lum <= 150) continue;
        let bestA = 0, br = r, bg = g, bb = b;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = idx(x + dx, y + dy);
            if (data[j + 3] > bestA && data[j + 3] >= 230) {
              bestA = data[j + 3]; br = data[j]; bg = data[j + 1]; bb = data[j + 2];
            }
          }
        }
        if (bestA >= 230) { data[i] = br; data[i + 1] = bg; data[i + 2] = bb; }
      }
    }

    // AGRESİF: izole küçük opak adacıkları temizle (arka plandan kopuk parçalar)
    // Flood-fill ile bağlı bölgeleri bul, en büyük bölge dışındaki küçükleri sil.
    if (aggressive) {
      const visited = new Uint8Array(W * H);
      const stack = [];
      const regions = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x;
          if (visited[p] || data[p * 4 + 3] < 30) { visited[p] = 1; continue; }
          // yeni bölge - flood fill
          const region = [];
          stack.length = 0; stack.push(p); visited[p] = 1;
          while (stack.length) {
            const cur = stack.pop();
            region.push(cur);
            const cx = cur % W, cy = (cur / W) | 0;
            const nb = [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]];
            for (const [nx, ny] of nb) {
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const np = ny * W + nx;
              if (!visited[np] && data[np * 4 + 3] >= 30) { visited[np] = 1; stack.push(np); }
            }
          }
          regions.push(region);
        }
      }
      // en büyük bölgeyi bul (ana nesne)
      let maxSize = 0;
      for (const reg of regions) if (reg.length > maxSize) maxSize = reg.length;
      // küçük adacıkları sil: ana nesnenin %15'inden küçük olanlar arka plan artığıdır
      for (const reg of regions) {
        if (reg.length < maxSize * 0.15) {
          for (const p of reg) { data[p * 4 + 3] = 0; cleaned++; }
        }
      }
    }

    const out = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
      .png().toBuffer();
    return { buffer: out, applied: cleaned > 0, cleanedPixels: cleaned };
  } catch (err) {
    console.error("Kenar temizleme hatası:", err.message);
    return { buffer, applied: false };
  }
}
