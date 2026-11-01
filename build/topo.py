# -*- coding: utf-8 -*-
"""Carte topographique officielle du Land (DTK, Geobasis NRW) en tuiles hors ligne.

Le service WMS `wms_nw_dtk` (couche `nw_dtk_col`, licence Datenlizenz Deutschland
Zero 2.0, aucune restriction d'accès) sert toutes les cartes topographiques du
Land : DTK10 lisible dès le zoom 16 (1,5 m/pixel), DTK25/50 en dessous, cartes
du Bund aux petites échelles. On demande des tuiles de 512 px en EPSG:3857
(un niveau d'adressage en dessous du zoom « 256 px » équivalent : une tuile
512 px du niveau z couvre les quatre tuiles 256 px du niveau z+1) — mesuré 35 %
plus compact que quatre tuiles de 256 px — puis réencodage WebP q90 (85 Ko PNG →
~30 Ko par 256 px équivalent). Assemblé en MBTiles puis PMTiles, découpé en
morceaux de 48 Mo comme les autres paquets.

Zooms : adressage 5 → 15 (équivalent 256 px : 6 → 16) sur toute l'emprise, plus le
niveau 16 (net jusqu'au zoom 17) sur la seule commune de Soest (build/ville.geojson,
limite Nominatim, ~680 tuiles, ~35 Mo) — demande de l'utilisateur du 2026-11-01. En
dessous du zoom 10, l'application montre le fond OpenStreetMap ; hors commune au-delà
du niveau 15, elle agrandit elle-même la tuile parente (carte.js).

Usage : python build/topo.py
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

from PIL import Image

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(RACINE, "build", "cache", "dtk")
DATA = os.path.join(RACINE, "data")
PMTILES = os.path.join(RACINE, "build", "pmtiles.exe")
UA = "soest-build/1.0 (carte hors ligne ; contact : cristo67000 sur GitHub)"
WMS = "https://www.wms.nrw.de/geobasis/wms_nw_dtk"
COUCHE = "nw_dtk_col"
TAILLE = 512
ZOOM_MIN, ZOOM_MAX = 5, 15     # adressage des tuiles 512 px, toute l'emprise
ZOOM_VILLE = 16                # un niveau de plus sur la commune (build/ville.geojson)
VILLE = os.path.join(RACINE, "build", "ville.geojson")
QUALITE = 90
TAILLE_MORCEAU = 48_000_000
R = 6378137 * math.pi          # demi-périmètre en Web Mercator


def log(*a):
    print(*a, flush=True)


def bbox3857(z, x, y):
    n = 2 ** z
    return (-R + 2 * R * x / n, R - 2 * R * (y + 1) / n, -R + 2 * R * (x + 1) / n, R - 2 * R * y / n)


def tuiles_de_l_emprise():
    gj = json.load(open(os.path.join(RACINE, "build", "emprise.geojson"), encoding="utf-8"))
    xs = [p[0] for p in gj["geometry"]["coordinates"][0]]
    ys = [p[1] for p in gj["geometry"]["coordinates"][0]]
    lon0, lat0, lon1, lat1 = min(xs), min(ys), max(xs), max(ys)
    tuiles = []

    def grille(z, a, b, c, d):
        n = 2 ** z

        def tx(lon):
            return int((lon + 180) / 360 * n)

        def ty(lat):
            return int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)

        for x in range(max(0, tx(a)), min(n - 1, tx(c)) + 1):
            for y in range(max(0, ty(d)), min(n - 1, ty(b)) + 1):
                yield (z, x, y)

    for z in range(ZOOM_MIN, ZOOM_MAX + 1):
        tuiles.extend(grille(z, lon0, lat0, lon1, lat1))
    # niveau supplémentaire sur la commune : tuiles dont l'emprise touche le contour
    from shapely.geometry import shape, box
    from shapely.prepared import prep
    ville = prep(shape(json.load(open(VILLE, encoding="utf-8"))))
    vb = shape(json.load(open(VILLE, encoding="utf-8"))).bounds
    n_ville = 0
    for (z, x, y) in grille(ZOOM_VILLE, *vb):
        n = 2 ** z
        a = x / n * 360 - 180
        c = (x + 1) / n * 360 - 180
        b = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
        d = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
        if ville.intersects(box(a, b, c, d)):
            tuiles.append((z, x, y))
            n_ville += 1
    log("  dont %d tuiles du niveau %d sur la commune" % (n_ville, ZOOM_VILLE))
    return tuiles, (lon0, lat0, lon1, lat1)


def telecharger(t):
    z, x, y = t
    dossier = os.path.join(CACHE, str(z), str(x))
    chemin = os.path.join(dossier, "%d.png" % y)
    if os.path.exists(chemin) and os.path.getsize(chemin) > 0:
        return chemin
    os.makedirs(dossier, exist_ok=True)
    b = bbox3857(z, x, y)
    url = ("%s?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=%s&STYLES=&CRS=EPSG:3857"
           "&BBOX=%.3f,%.3f,%.3f,%.3f&WIDTH=%d&HEIGHT=%d&FORMAT=image/png"
           % (WMS, COUCHE, b[0], b[1], b[2], b[3], TAILLE, TAILLE))
    derniere = None
    for essai in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                ct = r.headers.get("Content-Type", "")
                octets = r.read()
            if not ct.startswith("image/"):
                raise RuntimeError("réponse non image (%s) : %s" % (ct, octets[:160].decode("utf-8", "replace")))
            with open(chemin, "wb") as f:
                f.write(octets)
            return chemin
        except Exception as e:
            derniere = e
            time.sleep(2 * (essai + 1))
    raise RuntimeError("tuile %d/%d/%d : %s" % (z, x, y, derniere))


def reencoder(chemin):
    im = Image.open(chemin).convert("RGB")
    b = io.BytesIO()
    im.save(b, "WEBP", quality=QUALITE, method=6)
    return b.getvalue()


def main():
    t0 = time.time()
    tuiles, bbox = tuiles_de_l_emprise()
    log("%s tuiles de %d px à traiter (adressage %d → %d)" % (format(len(tuiles), ","), TAILLE, ZOOM_MIN, ZOOM_MAX))
    os.makedirs(DATA, exist_ok=True)
    mbtiles = os.path.join(DATA, "topo.mbtiles")
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
            if faits % 100 == 0:
                log("  %s/%s tuiles, %.1f Mo, %.0f s" % (format(faits, ","), format(len(tuiles), ","), total / 1e6, time.time() - t0))
    meta = {"name": "Carte topographique NRW (DTK)", "format": "webp", "type": "baselayer", "version": "1",
            "description": "Digitale Topographische Karte (DTK10/25/50) du Land de Rhénanie-du-Nord-Westphalie, Geobasis NRW, tuiles 512 px",
            "minzoom": str(ZOOM_MIN), "maxzoom": str(ZOOM_VILLE), "bounds": ",".join("%.4f" % v for v in bbox),
            "attribution": "© Geobasis NRW (dl-de/zero-2.0)", "tilesize": str(TAILLE)}
    db.executemany("INSERT INTO metadata VALUES (?,?)", meta.items())
    db.commit()
    db.close()
    log("  MBTiles : %s tuiles, %.1f Mo" % (format(faits, ","), total / 1e6))

    pm = os.path.join(DATA, "topo.pmtiles")
    if os.path.exists(pm):
        os.remove(pm)
    subprocess.run([PMTILES, "convert", mbtiles, pm], check=True)
    os.remove(mbtiles)
    taille = os.path.getsize(pm)

    dossier = os.path.join(DATA, "topo")
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
            nom = "topo.%03d" % i
            with open(os.path.join(dossier, nom), "wb") as g:
                g.write(bloc)
            morceaux.append("data/topo/" + nom)
            i += 1
    os.remove(pm)
    chemin_version = os.path.join(DATA, "version.json")
    version = json.load(open(chemin_version, encoding="utf-8"))
    version["paquets"]["topo"] = {
        "nom": "Carte topographique officielle (DTK)", "type": "raster", "format": "webp", "taille_tuile": TAILLE,
        "taille": taille, "taille_morceau": TAILLE_MORCEAU, "morceaux": morceaux, "sha256": h.hexdigest(),
        "zoom_min": ZOOM_MIN, "zoom_max": ZOOM_VILLE, "zoom_max_partout": ZOOM_MAX, "tuiles": faits, "osm": time.strftime("%Y-%m-%d"),
        "source": "Geobasis NRW, DTK (dl-de/zero-2.0)"
    }
    json.dump(version, open(chemin_version, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log("Topo : %.1f Mo en %d morceau(x), %.0f s" % (taille / 1e6, len(morceaux), time.time() - t0))


if __name__ == "__main__":
    sys.exit(main())
