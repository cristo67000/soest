# -*- coding: utf-8 -*-
"""Liste des fichiers de l'app shell à pré-cacher par le service worker.

Énumère les dossiers concernés et écrit `data/precache.json` (lu par sw.js à
l'installation). Les paquets de données (data/fond/, data/relief/…) en sont
exclus : ils se téléchargent à la demande dans l'OPFS (bouton « Hors ligne »).
Le champ `build` vient de data/version.json ; le relancer après chaque
modification du code suffit à faire passer la nouvelle version aux appareils
installés (le worker compare le nom du cache).

Usage : python build/manifeste.py
"""
import datetime as dt
import json
import pathlib

RACINE = pathlib.Path(__file__).resolve().parent.parent
DOSSIERS = ["lib", "assets/glyphs", "assets/sprites", "icons"]
RACINE_FICHIERS = ["index.html", "style.css", "manifest.webmanifest",
                   "panneau.js", "stockage.js", "telechargeur.js", "carte.js", "recherche.js", "transports.js",
                   "lieux.js", "adresses.js", "navigation.js", "relief.js", "courbes-worker.js", "itineraires.js", "miseajour.js", "pwa.js"]
DATA = ["data/emprise.json", "data/version.json", "data/communes.json", "data/transports.json"]


def lister():
    chemins = []
    for rel in RACINE_FICHIERS + DATA:
        if (RACINE / rel).is_file():
            chemins.append(rel)
        else:
            print("  (absent, ignoré :", rel + ")")
    for dossier in DOSSIERS:
        base = RACINE / dossier
        if not base.is_dir():
            continue
        for chemin in sorted(base.rglob("*")):
            if chemin.is_file():
                chemins.append(chemin.relative_to(RACINE).as_posix())
    return chemins


def main():
    chemin_version = RACINE / "data" / "version.json"
    version = json.loads(chemin_version.read_text(encoding="utf-8"))
    version["build"] = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    chemin_version.write_text(json.dumps(version, ensure_ascii=False, indent=1), encoding="utf-8")
    chemins = lister()
    (RACINE / "data" / "precache.json").write_text(
        json.dumps({"build": version["build"].replace(" ", "-").replace(":", ""), "fichiers": chemins},
                   ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(chemins)} fichiers listés dans data/precache.json (build {version['build']})")


if __name__ == "__main__":
    main()
