# -*- coding: utf-8 -*-
"""Index d'adresses hors ligne : OpenStreetMap, Soest et environs (±10 km).

Source : l'extrait Geofabrik de la Regierungsbezirk Arnsberg
(`build/cache/pbf/arnsberg-regbez-latest.osm.pbf`, ~195 Mo) lu par pyosmium ;
on garde les objets porteurs de `addr:housenumber` et les lieux habités
`place=*` qui tombent dans l'emprise (build/emprise.geojson, élargie de ~1 km).
Les bâtiments (ways fermés, multipolygones) donnent le centre de leur anneau
extérieur. En Allemagne, OSM porte la quasi-totalité des adresses (il n'y a pas
d'équivalent ouvert et national de la BAN).

Produit :
  - data/adresses/adresses.000 : paquet binaire gzippé lu par adresses.js —
        "SOADR1\0\0" | u32 longueur JSON | u32 n | JSON { communes, reps, rues } |
        n × u16 numéro | n × u16 suffixe | n × i32 lon·1e6 | n × i32 lat·1e6 ;
  - data/communes.json : villes, villages, hameaux et quartiers pour la
        recherche de localités (léger, précaché).

Usage : python build/adresses.py
"""
import gzip
import hashlib
import json
import os
import re
import struct
import sys
import time
import unicodedata

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(RACINE, "build", "cache")
DATA = os.path.join(RACINE, "data")
PBF = os.path.join(CACHE, "pbf", "arnsberg-regbez-latest.osm.pbf")
TAILLE_MORCEAU = 48_000_000
MARGE = 0.01   # degrés : une adresse juste hors du carré reste trouvable
PLACES = ("city", "town", "village", "hamlet", "suburb", "quarter", "neighbourhood")


def log(*a):
    print(*a, flush=True)


def normaliser(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", s.lower().strip())


RE_NUMERO = re.compile(r"^\s*(\d{1,5})\s*(.*)$")


def decouper_numero(texte):
    """'12a' → (12, 'a') ; '12-14' → (12, '-14') ; '12 1/2' → (12, '1/2') ; 'sans' → (0, texte)."""
    m = RE_NUMERO.match(texte or "")
    if not m:
        return 0, (texte or "").strip()[:12]
    return min(int(m.group(1)), 65535), m.group(2).strip().replace(" ", "")[:12]


class Collecte:
    def __init__(self):
        self.communes = {}
        self.communes_liste = []  # [nom, pays, somme_lon, somme_lat, n, cp]
        self.reps = {"": 0}
        self.reps_liste = [""]
        self.rues = {}
        self.rues_liste = []      # [nom, commune_idx, cp]
        self.adresses = []        # (rue_idx, numero, rep_idx, lon_e6, lat_e6)

    def commune(self, pays, nom, cp, lon, lat):
        cle = (pays, nom)
        if cle not in self.communes:
            self.communes[cle] = len(self.communes_liste)
            self.communes_liste.append([nom, pays, 0.0, 0.0, 0, cp or ""])
        i = self.communes[cle]
        c = self.communes_liste[i]
        c[2] += lon
        c[3] += lat
        c[4] += 1
        if not c[5] and cp:
            c[5] = cp
        return i

    def rep(self, texte):
        if texte not in self.reps:
            self.reps[texte] = len(self.reps_liste)
            self.reps_liste.append(texte)
        return self.reps[texte]

    def ajouter(self, pays, commune, cp, voie, numero_texte, lon, lat):
        if not voie or not commune or lon is None or lat is None:
            return
        ci = self.commune(pays, commune, cp, lon, lat)
        cle = (ci, voie)
        if cle not in self.rues:
            self.rues[cle] = len(self.rues_liste)
            self.rues_liste.append([voie, ci, cp or ""])
        ri = self.rues[cle]
        numero, suffixe = decouper_numero(numero_texte)
        self.adresses.append((ri, numero, self.rep(suffixe), int(round(lon * 1e6)), int(round(lat * 1e6))))


def emprise():
    from shapely.geometry import shape
    gj = json.load(open(os.path.join(RACINE, "build", "emprise.geojson"), encoding="utf-8"))
    return shape(gj["geometry"]).buffer(MARGE)


def charger_osm(col):
    import osmium
    from shapely.geometry import Point
    from shapely.prepared import prep
    from shapely.strtree import STRtree

    zone = emprise()
    prepare = prep(zone)
    lon0, lat0, lon1, lat1 = zone.bounds
    lieux = []
    bruts = []   # (lon, lat, numero, voie, cp, ville)

    class Lecteur(osmium.SimpleHandler):
        def _dedans(self, lon, lat):
            return lon0 <= lon <= lon1 and lat0 <= lat <= lat1 and prepare.contains(Point(lon, lat))

        def _adresse(self, lon, lat, t):
            if not self._dedans(lon, lat):
                return
            voie = t.get("addr:street") or t.get("addr:place") or ""
            if not voie:
                return
            bruts.append((lon, lat, t.get("addr:housenumber", ""), voie, t.get("addr:postcode", ""), t.get("addr:city", "")))

        def node(self, n):
            t = n.tags
            if not n.location.valid():
                return
            if "addr:housenumber" in t:
                self._adresse(n.location.lon, n.location.lat, t)
            elif "place" in t and "name" in t and t["place"] in PLACES:
                if self._dedans(n.location.lon, n.location.lat):
                    try:
                        pop = int(re.sub(r"[^0-9]", "", t.get("population", "") or "0") or 0)
                    except ValueError:
                        pop = 0
                    lieux.append((t["name"], n.location.lon, n.location.lat, t["place"], pop))

        def area(self, a):
            t = a.tags
            if "addr:housenumber" not in t:
                return
            try:
                anneau = next(iter(a.outer_rings()))
            except StopIteration:
                return
            sx = sy = 0.0
            k = 0
            for nd in anneau:
                if nd.location.valid():
                    sx += nd.location.lon
                    sy += nd.location.lat
                    k += 1
            if k:
                self._adresse(sx / k, sy / k, t)

    log("  lecture de", os.path.basename(PBF))
    t0 = time.time()
    Lecteur().apply_file(PBF, locations=True, idx="flex_mem")
    log("    %s adresses brutes, %s lieux habités, %.0f s" % (format(len(bruts), ","), format(len(lieux), ","), time.time() - t0))

    vus = {}
    for l in lieux:
        cle = (normaliser(l[0]), round(l[1], 2), round(l[2], 2))
        vus.setdefault(cle, l)
    lieux = list(vus.values())
    gros = [l for l in lieux if l[3] in ("city", "town", "village")]
    arbre = STRtree([Point(l[1], l[2]) for l in gros])

    def commune_proche(lon, lat):
        i = arbre.nearest(Point(lon, lat))
        return gros[i][0] if i is not None else ""

    vues = set()
    n = 0
    for lon, lat, numero, voie, cp, ville in bruts:
        if not ville:
            ville = commune_proche(lon, lat)
        cle = (normaliser(ville), normaliser(voie), normaliser(numero))
        if cle in vues:
            continue
        vues.add(cle)
        col.ajouter("DE", ville, cp, voie, numero, lon, lat)
        n += 1
    log("  OSM : %s adresses, %s lieux habités" % (format(n, ","), format(len(lieux), ",")))
    return lieux


def ecrire_index(col, lieux):
    col.adresses.sort(key=lambda a: (a[0], a[1], col.reps_liste[a[2]]))
    rues = []
    n_total = len(col.adresses)
    k = 0
    for ri, r in enumerate(col.rues_liste):
        j = k
        lon_min = lat_min = 1 << 31
        lon_max = lat_max = -(1 << 31)
        while j < n_total and col.adresses[j][0] == ri:
            a = col.adresses[j]
            lon_min = min(lon_min, a[3])
            lon_max = max(lon_max, a[3])
            lat_min = min(lat_min, a[4])
            lat_max = max(lat_max, a[4])
            j += 1
        rues.append([r[0], r[1], r[2], k, j - k, lon_min, lat_min, lon_max, lat_max])
        k = j
    communes = [[c[0], c[1], round(c[2] / c[4], 5), round(c[3] / c[4], 5), c[5]] for c in col.communes_liste]
    entete = {"version": 1, "n": n_total, "communes": communes, "reps": col.reps_liste, "rues": rues,
              "sources": {"DE": "OpenStreetMap (ODbL)"}, "date": time.strftime("%Y-%m-%d")}
    entete_octets = json.dumps(entete, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    numeros = struct.pack("<%dH" % n_total, *[a[1] for a in col.adresses])
    reps = struct.pack("<%dH" % n_total, *[a[2] for a in col.adresses])
    lons = struct.pack("<%di" % n_total, *[a[3] for a in col.adresses])
    lats = struct.pack("<%di" % n_total, *[a[4] for a in col.adresses])
    brut = b"SOADR1\0\0" + struct.pack("<II", len(entete_octets), n_total) + entete_octets + numeros + reps + lons + lats
    comprime = gzip.compress(brut, compresslevel=9)
    log("  index : %s adresses, %s rues, %s communes ; %.1f Mo bruts → %.2f Mo gzip" % (
        format(n_total, ","), format(len(rues), ","), format(len(communes), ","), len(brut) / 1e6, len(comprime) / 1e6))

    dossier = os.path.join(DATA, "adresses")
    os.makedirs(dossier, exist_ok=True)
    for ancien in os.listdir(dossier):
        os.remove(os.path.join(dossier, ancien))
    morceaux = []
    for i in range(0, len(comprime), TAILLE_MORCEAU):
        nom = "adresses.%03d" % (i // TAILLE_MORCEAU)
        with open(os.path.join(dossier, nom), "wb") as f:
            f.write(comprime[i:i + TAILLE_MORCEAU])
        morceaux.append("data/adresses/" + nom)

    chemin_version = os.path.join(DATA, "version.json")
    version = json.load(open(chemin_version, encoding="utf-8"))
    version["paquets"]["adresses"] = {
        "nom": "Adresses Soest et environs", "type": "index", "taille": len(comprime), "taille_morceau": TAILLE_MORCEAU,
        "morceaux": morceaux, "sha256": hashlib.sha256(comprime).hexdigest(), "adresses": n_total, "rues": len(rues),
        "osm": entete["date"], "source": "OpenStreetMap"
    }
    json.dump(version, open(chemin_version, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    localites = [[l[0], "DE", round(l[1], 5), round(l[2], 5), l[3], l[4]] for l in lieux]
    localites.sort(key=lambda x: (-x[5], x[0]))
    json.dump(localites, open(os.path.join(DATA, "communes.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    log("  communes.json : %d localités" % len(localites))


def main():
    if not os.path.exists(PBF) or os.path.getsize(PBF) < 1_000_000:
        log("Extrait Geofabrik absent : " + PBF)
        log("  → https://download.geofabrik.de/europe/germany/nordrhein-westfalen/arnsberg-regbez-latest.osm.pbf")
        return 1
    col = Collecte()
    log("== OpenStreetMap, Soest et environs")
    lieux = charger_osm(col)
    log("== Écriture")
    ecrire_index(col, lieux)


if __name__ == "__main__":
    sys.exit(main())
