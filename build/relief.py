# -*- coding: utf-8 -*-
"""Relief : tuiles d'altitude (Terrarium, AWS Terrain Tiles / Mapzen) de l'emprise.

Télécharge les tuiles PNG Terrarium du zoom 0 au zoom 13 qui touchent
build/emprise.geojson, ramène la précision verticale à 25 cm (le canal bleu,
1/256 m, n'est que du bruit pour l'ombrage et les courbes) et les réencode en
WebP sans perte : 96 Ko → ~19 Ko par tuile. Assemble le tout en MBTiles puis
PMTiles (pmtiles.exe convert), découpé en morceaux comme les autres paquets.

Sources Terrarium en Europe : EU-DEM 25 m (Copernicus), SRTM en repli.
Usage : python build/relief.py
"""
import concurrent.futures as cf
import hashlib
import io
import json
import math
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(RACINE, "build", "cache", "terrarium")
DATA = os.path.join(RACINE, "data")
PMTILES = os.path.join(RACINE, "build", "pmtiles.exe")
URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
UA = "soest-build/1.0 (carte hors ligne ; contact : cristo67000 sur GitHub)"
ZOOM_MAX = 13
TAILLE_MORCEAU = 48_000_000


def log(*a):
    print(*a, flush=True)


def tuile_bbox(z, x, y):
    n = 2 ** z
    lon0 = x / n * 360 - 180
    lon1 = (x + 1) / n * 360 - 180
    lat0 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    lat1 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon0, lat0, lon1, lat1


def tuiles_de_l_emprise():
    from shapely.geometry import shape, box
    from shapely.prepared import prep
    gj = json.load(open(os.path.join(RACINE, "build", "emprise.geojson"), encoding="utf-8"))
    emprise = shape(gj["geometry"]).buffer(0.01)
    prepare = prep(emprise)
    lon0, lat0, lon1, lat1 = emprise.bounds
    tuiles = []
    for z in range(0, ZOOM_MAX + 1):
        n = 2 ** z
        def tx(lon): return int((lon + 180) / 360 * n)
        def ty(lat): return int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
        for x in range(max(0, tx(lon0)), min(n - 1, tx(lon1)) + 1):
            for y in range(max(0, ty(lat1)), min(n - 1, ty(lat0)) + 1):
                if prepare.intersects(box(*tuile_bbox(z, x, y))):
                    tuiles.append((z, x, y))
    return tuiles


def telecharger(t):
    z, x, y = t
    dossier = os.path.join(CACHE, str(z), str(x))
    chemin = os.path.join(dossier, f"{y}.png")
    if os.path.exists(chemin) and os.path.getsize(chemin) > 0:
        return chemin
    os.makedirs(dossier, exist_ok=True)
    for essai in range(4):
        try:
            req = urllib.request.Request(URL.format(z=z, x=x, y=y), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                octets = r.read()
            with open(chemin, "wb") as f:
                f.write(octets)
            return chemin
        except Exception as e:
            time.sleep(1.5 * (essai + 1))
            derniere = e
    raise RuntimeError(f"tuile {z}/{x}/{y} : {derniere}")


def reencoder(chemin):
    im = Image.open(chemin).convert("RGB")
    a = np.array(im)
    a[:, :, 2] = (a[:, :, 2] // 64) * 64   # précision 0,25 m
    b = io.BytesIO()
    Image.fromarray(a).save(b, "WEBP", lossless=True, quality=100, method=5)
    return b.getvalue()


def main():
    t0 = time.time()
    tuiles = tuiles_de_l_emprise()
    log(f"{len(tuiles):,} tuiles à traiter (zoom 0 → {ZOOM_MAX})")
    os.makedirs(DATA, exist_ok=True)
    mbtiles = os.path.join(DATA, "relief.mbtiles")
    if os.path.exists(mbtiles):
        os.remove(mbtiles)
    db = sqlite3.connect(mbtiles)
    db.executescript("""
        CREATE TABLE metadata (name TEXT, value TEXT);
        CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
        CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
    """)
    total = 0
    faits = 0
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        for (z, x, y), octets in zip(tuiles, pool.map(lambda t: reencoder(telecharger(t)), tuiles)):
            db.execute("INSERT INTO tiles VALUES (?,?,?,?)", (z, x, (2 ** z - 1) - y, sqlite3.Binary(octets)))
            total += len(octets)
            faits += 1
            if faits % 200 == 0:
                log(f"  {faits:,}/{len(tuiles):,} tuiles, {total / 1e6:.1f} Mo, {time.time() - t0:.0f} s")
    gj = json.load(open(os.path.join(RACINE, "build", "emprise.geojson"), encoding="utf-8"))
    from shapely.geometry import shape
    b = shape(gj["geometry"]).bounds
    meta = {"name": "Relief Soest", "format": "webp", "type": "baselayer", "version": "1",
            "description": "Altitudes Terrarium (AWS Terrain Tiles, EU-DEM 25 m) précision 0,25 m",
            "minzoom": "0", "maxzoom": str(ZOOM_MAX), "bounds": ",".join(f"{v:.4f}" for v in b),
            "attribution": "Terrain Tiles (Mapzen/AWS), EU-DEM © Union européenne, Copernicus", "encoding": "terrarium"}
    db.executemany("INSERT INTO metadata VALUES (?,?)", meta.items())
    db.commit()
    db.close()
    log(f"  MBTiles : {faits:,} tuiles, {total / 1e6:.1f} Mo")

    pm = os.path.join(DATA, "relief.pmtiles")
    if os.path.exists(pm):
        os.remove(pm)
    subprocess.run([PMTILES, "convert", mbtiles, pm], check=True)
    os.remove(mbtiles)
    taille = os.path.getsize(pm)

    dossier = os.path.join(DATA, "relief")
    os.makedirs(dossier, exist_ok=True)
    for ancien in os.listdir(dossier):
        os.remove(os.path.join(dossier, ancien))
    morceaux = []
    h = hashlib.sha256()
    with open(pm, "rb") as f:
        i = 0
        while True:
            bloc = f.read(TAILLE_MORCEAU)
            if not bloc:
                break
            h.update(bloc)
            nom = "relief.%03d" % i
            with open(os.path.join(dossier, nom), "wb") as g:
                g.write(bloc)
            morceaux.append("data/relief/" + nom)
            i += 1
    os.remove(pm)
    chemin_version = os.path.join(DATA, "version.json")
    version = json.load(open(chemin_version, encoding="utf-8"))
    version["paquets"]["relief"] = {
        "nom": "Relief (altitudes)", "type": "raster-dem", "encodage": "terrarium", "format": "webp",
        "taille": taille, "taille_morceau": TAILLE_MORCEAU, "morceaux": morceaux, "sha256": h.hexdigest(),
        "zoom_min": 0, "zoom_max": ZOOM_MAX, "tuiles": faits, "osm": time.strftime("%Y-%m-%d"),
        "source": "Terrain Tiles Terrarium (EU-DEM 25 m)"
    }
    json.dump(version, open(chemin_version, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log(f"Relief : {taille / 1e6:.1f} Mo en {len(morceaux)} morceau(x), {time.time() - t0:.0f} s")


if __name__ == "__main__":
    sys.exit(main())
