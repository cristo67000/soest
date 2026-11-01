# -*- coding: utf-8 -*-
"""Emprise de la carte : carré de ±10 km autour du centre de Soest.

Le scénario retenu (« C », 2026-11-01) couvre Soest et ses environs dans un
rayon d'environ 10 km : Bad Sassendorf, Welver, Lippetal (sud), Möhnesee,
Ense (est), Werl (ouest)… Pas de limite administrative à aller chercher :
l'emprise est le carré géographique de 20 km de côté centré sur la ville,
écrit en `build/emprise.geojson` (région passée à `pmtiles extract`) et en
`data/emprise.json` (contour affiché par l'application, test « dans la carte ? »).

Usage : python build/emprise.py
"""
import json
import math
import os

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CENTRE = (8.1056, 51.5711)   # Soest, place du marché (lon, lat)
RAYON_KM = 10.0


def main():
    lon, lat = CENTRE
    dlat = RAYON_KM / 111.2
    dlon = RAYON_KM / (111.32 * math.cos(math.radians(lat)))
    bbox = [round(lon - dlon, 4), round(lat - dlat, 4), round(lon + dlon, 4), round(lat + dlat, 4)]
    contour = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]
    surface = (2 * RAYON_KM) ** 2
    print(f"Centre {lon}, {lat} ; carré de ±{RAYON_KM:.0f} km = {surface:.0f} km²")
    print(f"Boîte englobante : {bbox[0]},{bbox[1]} → {bbox[2]},{bbox[3]}")
    with open(os.path.join(RACINE, "build", "emprise.geojson"), "w", encoding="utf-8") as f:
        json.dump({"type": "Feature", "properties": {"nom": "Soest ±10 km"},
                   "geometry": {"type": "Polygon", "coordinates": [contour]}}, f)
    os.makedirs(os.path.join(RACINE, "data"), exist_ok=True)
    with open(os.path.join(RACINE, "data", "emprise.json"), "w", encoding="utf-8") as f:
        json.dump({"bbox": bbox, "contour": contour, "centre": [lon, lat], "rayon_km": RAYON_KM}, f)
    print("Écrit : build/emprise.geojson, data/emprise.json")


if __name__ == "__main__":
    main()
