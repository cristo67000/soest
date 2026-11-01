# -*- coding: utf-8 -*-
"""Transports en commun hors ligne : arrêts et lignes OpenStreetMap de l'emprise.

Le fond Protomaps n'a pas de couche transport dédiée : on extrait de l'extrait
Geofabrik (build/cache/pbf/arnsberg-regbez-latest.osm.pbf, pyosmium) :
  - les relations `type=route` (bus, train, tram, light_rail) dont au moins un
    chemin traverse l'emprise élargie : référence (« RE 11 », « R52 »), nom,
    couleur, exploitant, terminus, tracé (chemins membres dans l'emprise) ;
  - les arrêts : gares et haltes (`railway=station|halt`), arrêts de bus
    (`highway=bus_stop`, quais `public_transport=platform` + `bus=yes`), arrêts
    de tram ; chaque arrêt porte les lignes qui le desservent (membres des
    relations à moins de 80 m).

Deux lectures du fichier : les relations d'abord (pour connaître les chemins
membres), puis nœuds et chemins. Produit data/transports.json (précaché).

Usage : python build/transports.py
"""
import json
import math
import os
import sys
import time

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PBF = os.path.join(RACINE, "build", "cache", "pbf", "arnsberg-regbez-latest.osm.pbf")
SORTIE = os.path.join(RACINE, "data", "transports.json")
MARGE_LIGNES = 0.03    # degrés (~2 km) : les tracés débordent un peu du carré
MARGE_ARRETS = 0.005
ROUTES = {"bus": "bus", "trolleybus": "bus", "train": "train", "light_rail": "train", "tram": "tram", "subway": "tram",
          "ferry": None, "bicycle": None, "hiking": None, "road": None, "foot": None, "mtb": None, "horse": None}
RAYON_RATTACHEMENT = {"bus": 80, "tram": 80, "train": 400}


def log(*a):
    print(*a, flush=True)


def emprise(marge):
    gj = json.load(open(os.path.join(RACINE, "build", "emprise.geojson"), encoding="utf-8"))
    xs = [p[0] for p in gj["geometry"]["coordinates"][0]]
    ys = [p[1] for p in gj["geometry"]["coordinates"][0]]
    return (min(xs) - marge, min(ys) - marge, max(xs) + marge, max(ys) + marge)


def distance_m(lon1, lat1, lon2, lat2):
    kx = 111320 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lon1 - lon2) * kx, (lat1 - lat2) * 110574)


def main():
    import osmium
    if not os.path.exists(PBF):
        log("Extrait Geofabrik absent :", PBF)
        return 1
    b_lignes = emprise(MARGE_LIGNES)
    b_arrets = emprise(MARGE_ARRETS)

    def dans(b, lon, lat):
        return b[0] <= lon <= b[2] and b[1] <= lat <= b[3]

    # ---- passe 1 : relations de lignes
    relations = {}   # id -> {ref, nom, type, couleur, op, de, a, ways:[id], noeuds:[id]}
    t0 = time.time()

    class Relations(osmium.SimpleHandler):
        def relation(self, r):
            t = r.tags
            if t.get("type") != "route":
                return
            genre = ROUTES.get(t.get("route", ""), None)
            if not genre:
                return
            ways, noeuds = [], []
            for m in r.members:
                if m.type == "w":
                    ways.append(m.ref)
                elif m.type == "n":
                    noeuds.append(m.ref)
            if not ways:
                return
            relations[r.id] = {
                "ref": t.get("ref", "") or t.get("name", "")[:20], "nom": t.get("name", ""), "type": genre,
                "couleur": t.get("colour", ""), "op": t.get("operator", "") or t.get("network", ""),
                "de": t.get("from", ""), "a": t.get("to", ""), "ways": ways, "noeuds": noeuds}

    Relations().apply_file(PBF)
    ways_voulus = set()
    for r in relations.values():
        ways_voulus.update(r["ways"])
    log("  passe 1 : %s relations de transport, %s chemins membres, %.0f s" % (
        format(len(relations), ","), format(len(ways_voulus), ","), time.time() - t0))

    # ---- passe 2 : chemins membres et arrêts
    geoms = {}       # way id -> [[lon, lat], ...] (si touche l'emprise élargie)
    arrets = []      # [nom, lon, lat, type, id]
    membres_pos = {}  # node id -> (lon, lat) pour les nœuds membres des relations
    noeuds_voulus = set()
    for r in relations.values():
        noeuds_voulus.update(r["noeuds"])

    class Objets(osmium.SimpleHandler):
        def node(self, n):
            if not n.location.valid():
                return
            lon, lat = n.location.lon, n.location.lat
            if n.id in noeuds_voulus and dans(b_lignes, lon, lat):
                membres_pos[n.id] = (lon, lat)
            if not dans(b_arrets, lon, lat):
                return
            t = n.tags
            nom = t.get("name", "")
            genre = None
            if t.get("railway") in ("station", "halt") and t.get("station") not in ("subway",):
                genre = "tram" if t.get("station") == "light_rail" or t.get("tram") == "yes" and t.get("train") != "yes" else "train"
            elif t.get("railway") == "tram_stop":
                genre = "tram"
            elif t.get("highway") == "bus_stop" or (t.get("public_transport") == "platform" and t.get("bus") == "yes"):
                genre = "bus"
            elif t.get("public_transport") == "stop_position" and t.get("bus") == "yes" and nom:
                genre = "bus"
            if genre and nom:
                arrets.append([nom, lon, lat, genre, n.id, t.get("public_transport", "")])

        def way(self, w):
            if w.id not in ways_voulus:
                return
            pts = []
            touche = False
            for nd in w.nodes:
                if not nd.location.valid():
                    continue
                lon, lat = nd.location.lon, nd.location.lat
                pts.append([round(lon, 5), round(lat, 5)])
                if not touche and dans(b_lignes, lon, lat):
                    touche = True
            if touche and len(pts) >= 2:
                geoms[w.id] = pts

    t1 = time.time()
    Objets().apply_file(PBF, locations=True, idx="flex_mem")
    log("  passe 2 : %s chemins dans l'emprise, %s arrêts candidats, %.0f s" % (
        format(len(geoms), ","), format(len(arrets), ","), time.time() - t1))

    # ---- lignes : relations dont au moins un chemin est dans l'emprise
    lignes = []
    for rid, r in relations.items():
        traces = [geoms[w] for w in r["ways"] if w in geoms]
        if not traces:
            continue
        # fusion des chemins consécutifs quand ils s'enchaînent bout à bout
        fusion = []
        for tr in traces:
            if fusion and fusion[-1][-1] == tr[0]:
                fusion[-1].extend(tr[1:])
            elif fusion and fusion[-1][-1] == tr[-1]:
                fusion[-1].extend(list(reversed(tr))[1:])
            elif fusion and fusion[-1][0] == tr[-1]:
                fusion[-1] = tr[:-1] + fusion[-1]
            elif fusion and fusion[-1][0] == tr[0]:
                fusion[-1] = list(reversed(tr))[:-1] + fusion[-1]
            else:
                fusion.append(list(tr))
        pts_membres = [membres_pos[n] for n in r["noeuds"] if n in membres_pos]
        lignes.append({"id": rid, "ref": r["ref"], "nom": r["nom"], "type": r["type"], "couleur": r["couleur"],
                       "op": r["op"], "de": r["de"], "a": r["a"], "traces": fusion, "_membres": pts_membres})
    log("  %d lignes retenues" % len(lignes))

    # ---- arrêts : dédoublonnage (même nom à moins de 60 m), rattachement aux lignes
    arrets.sort(key=lambda a: (a[0], 0 if a[5] == "platform" or a[3] == "train" else 1))
    gardes = []
    for a in arrets:
        doublon = False
        for g in gardes:
            if g[0] == a[0] and g[3] == a[3] and distance_m(g[1], g[2], a[1], a[2]) < 60:
                doublon = True
                break
        if not doublon:
            gardes.append(a)
    sortie_arrets = []
    for nom, lon, lat, genre, nid, _pt in gardes:
        refs = {}
        rayon = RAYON_RATTACHEMENT[genre]
        for l in lignes:
            if l["type"] != genre and not (genre == "train" and l["type"] == "tram"):
                continue
            proche = False
            for (mlon, mlat) in l["_membres"]:
                if distance_m(lon, lat, mlon, mlat) < rayon:
                    proche = True
                    break
            if not proche and genre == "train":
                # gare sans nœud membre à proximité : le tracé passe-t-il à moins de 150 m ?
                for tr in l["traces"]:
                    for p in tr[::3]:
                        if distance_m(lon, lat, p[0], p[1]) < 150:
                            proche = True
                            break
                    if proche:
                        break
            if proche and l["ref"]:
                refs.setdefault(l["ref"], l["id"])
        sortie_arrets.append([nom, round(lon, 5), round(lat, 5), genre, sorted(refs.keys(), key=cle_ref)])
    sortie_arrets.sort(key=lambda a: (a[3] != "train", a[0]))
    for l in lignes:
        del l["_membres"]
    lignes.sort(key=lambda l: (l["type"] != "train", cle_ref(l["ref"])))
    nb = {"bus": 0, "train": 0, "tram": 0}
    for a in sortie_arrets:
        nb[a[3]] += 1
    resultat = {"date": time.strftime("%Y-%m-%d"), "source": "OpenStreetMap (ODbL)", "arrets": sortie_arrets, "lignes": lignes}
    os.makedirs(os.path.dirname(SORTIE), exist_ok=True)
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(resultat, f, ensure_ascii=False, separators=(",", ":"))
    log("  %s : %d arrêts (%d gares, %d bus, %d tram), %d lignes, %.0f Ko" % (
        os.path.relpath(SORTIE, RACINE), len(sortie_arrets), nb["train"], nb["bus"], nb["tram"], len(lignes), os.path.getsize(SORTIE) / 1000))


def cle_ref(ref):
    """Tri naturel des références : « R52 » < « R53 », « RE 11 » < « RE 2 » → non : tri numérique."""
    import re
    parties = re.split(r"(\d+)", ref or "")
    return [int(p) if p.isdigit() else p.lower() for p in parties]


if __name__ == "__main__":
    sys.exit(main())
