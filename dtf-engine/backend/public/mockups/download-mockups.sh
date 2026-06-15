#!/bin/bash
# DTF1 mockup'larını yerel klasöre indirir
cd "$(dirname "$0")"
echo "Mockup'lar indiriliyor..."
curl -s -o tshirt.png "https://dtf1.de/wp-content/uploads/2026/02/base-tshirt.png"
curl -s -o hoodie.png "https://dtf1.de/wp-content/uploads/2026/02/base-hoodie.png"
curl -s -o cap.png    "https://dtf1.de/wp-content/uploads/2026/02/base-cap.png"
curl -s -o bag.png    "https://dtf1.de/wp-content/uploads/2026/02/base-bag.png"
curl -s -o polo.png   "https://dtf1.de/wp-content/uploads/2026/02/base-polo.png"
curl -s -o jacket.png "https://dtf1.de/wp-content/uploads/2026/02/base-jacket.png"
echo "İndirildi:"
ls -la *.png
