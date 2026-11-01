# -*- coding: utf-8 -*-
"""Fond de carte vectoriel : extraction depuis le build quotidien de Protomaps.

Deux archives PMTiles :
  - `fond`     : l'emprise Soest ±10 km (build/emprise.geojson), zoom 0 → 15 ;
  - `contexte` : l'Europe au zoom 0 → 6, pour que le dézoom ne tombe pas dans le vide.

Chaque archive est ensuite découpée en morceaux de 48 Mo (`data/<nom>/<nom>.000`…) :
GitHub refuse les fichiers de plus de 100 Mo et avertit au-delà de 50 Mo, et
l'application sait lire une archive répartie sur plusieurs fichiers (stockage.js)
aussi bien en ligne (requêtes Range) qu'hors ligne (OPFS).

Usage : python build/tuiles.py [AAAAMMJJ]      (défaut : build de la veille)
"""
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PMTILES = os.path.join(RACINE, "build", "pmtiles.exe")
DATA = os.path.join(RACINE, "data")
VERSION = os.path.join(DATA, "version.json")
TAILLE_MORCEAU = 48_000_000

ARCHIVES = {
    "fond": {"region": os.path.join(RACINE, "build", "emprise.geojson"), "maxzoom": 15,
             "nom": "Fond de carte Soest et environs"},
    "contexte": {"bbox": "-12,35,30,60", "maxzoom": 6, "nom": "Contexte Europe"},
}


def lancer(args):
    print("  $", " ".join(os.path.basename(a) if i == 0 else a for i, a in enumerate(args)))
    return subprocess.run(args, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")


def extraire(cle, source, chemin):
    spec = ARCHIVES[cle]
    args = [PMTILES, "extract", source, chemin, "--maxzoom=%d" % spec["maxzoom"]]
    if "region" in spec:
        args.append("--region=" + spec["region"])
    else:
        args.append("--bbox=" + spec["bbox"])
    r = lancer(args)
    for ligne in (r.stdout + r.stderr).splitlines():
        if "archive size" in ligne or "fetching" in ligne:
            print("   ", ligne.split("extract.go:")[-1].split(": ", 1)[-1])


def entete(chemin):
    r = lancer([PMTILES, "show", chemin])
    infos = {}
    for ligne in r.stdout.splitlines():
        m = re.match(r"(min zoom|max zoom|addressed tiles count|planetiler:osm:osmosisreplicationtime|bounds)[: ] ?(.*)", ligne)
        if m:
            infos[m.group(1)] = m.group(2).strip()
    return infos


def decouper(chemin, cle):
    dossier = os.path.join(DATA, cle)
    os.makedirs(dossier, exist_ok=True)
    for ancien in os.listdir(dossier):
        os.remove(os.path.join(dossier, ancien))
    morceaux = []
    h = hashlib.sha256()
    with open(chemin, "rb") as f:
        i = 0
        while True:
            bloc = f.read(TAILLE_MORCEAU)
            if not bloc:
                break
            h.update(bloc)
            nom = "%s.%03d" % (cle, i)
            with open(os.path.join(dossier, nom), "wb") as g:
                g.write(bloc)
            morceaux.append("data/%s/%s" % (cle, nom))
            i += 1
    return morceaux, h.hexdigest()


def charger_version():
    if os.path.exists(VERSION):
        with open(VERSION, encoding="utf-8") as f:
            return json.load(f)
    return {"paquets": {}}


def main():
    date = sys.argv[1] if len(sys.argv) > 1 else (dt.date.today() - dt.timedelta(days=1)).strftime("%Y%m%d")
    source = "https://build.protomaps.com/%s.pmtiles" % date
    print("Source :", source)
    os.makedirs(DATA, exist_ok=True)
    version = charger_version()
    for cle in ARCHIVES:
        print("\n==", cle)
        chemin = os.path.join(DATA, cle + ".pmtiles")
        extraire(cle, source, chemin)
        infos = entete(chemin)
        taille = os.path.getsize(chemin)
        morceaux, sha = decouper(chemin, cle)
        os.remove(chemin)
        version["paquets"][cle] = {
            "nom": ARCHIVES[cle]["nom"],
            "taille": taille,
            "taille_morceau": TAILLE_MORCEAU,
            "morceaux": morceaux,
            "sha256": sha,
            "zoom_min": int(infos.get("min zoom", 0)),
            "zoom_max": int(infos.get("max zoom", ARCHIVES[cle]["maxzoom"])),
            "tuiles": int(infos.get("addressed tiles count", 0)),
            "osm": infos.get("planetiler:osm:osmosisreplicationtime", "")[:10],
            "source": "Protomaps " + date,
        }
        print("   %s : %.1f Mo, %d morceaux, %s tuiles, OSM du %s" % (
            cle, taille / 1e6, len(morceaux), infos.get("addressed tiles count", "?"),
            version["paquets"][cle]["osm"]))
    version["build"] = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    with open(VERSION, "w", encoding="utf-8") as f:
        json.dump(version, f, ensure_ascii=False, indent=1)
    print("\nÉcrit :", os.path.relpath(VERSION, RACINE))


if __name__ == "__main__":
    main()
