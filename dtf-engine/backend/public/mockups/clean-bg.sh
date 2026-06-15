#!/bin/bash
# Mockup'ların beyaz arka planını flood-fill ile şeffaf yapar (kıyafeti korur)
cd "$(dirname "$0")"
/usr/bin/python3 << 'PYEOF'
from PIL import Image
import collections

# tüm mockup'lar
names = ['tshirt','hoodie','cap','polo','bag','jacket']
for name in names:
    import os
    path = name+'.png'
    if not os.path.exists(path):
        print(name, 'yok, atlandi'); continue
    im = Image.open(path).convert('RGBA')
    W,H = im.size
    px = im.load()
    visited = bytearray(W*H)
    q = collections.deque()
    for x in range(W):
        q.append((x,0)); q.append((x,H-1))
    for y in range(H):
        q.append((0,y)); q.append((W-1,y))
    def is_bg(p):
        r,g,b,a = p
        # beyaza yakin (esik 218) - omuzdaki acik gri lekeleri de yakalar
        return a>10 and r>218 and g>218 and b>218
    while q:
        x,y = q.popleft()
        if x<0 or y<0 or x>=W or y>=H or visited[y*W+x]:
            continue
        visited[y*W+x]=1
        if not is_bg(px[x,y]):
            continue
        r,g,b,a = px[x,y]
        px[x,y]=(r,g,b,0)
        q.append((x+1,y)); q.append((x-1,y)); q.append((x,y+1)); q.append((x,y-1))
    im.save(path)
    print(name+': arka plan temizlendi')
print("HEPSI BITTI")
PYEOF
