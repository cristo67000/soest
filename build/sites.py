# -*- coding: utf-8 -*-
"""Sites et services publics -> data/sites.json (+ photos dans img/sites/).

Lieux particuliers (musées, églises, châteaux, monuments, parcs, théâtres…)
et services publics (mairies, bibliothèques, piscines, hôpitaux, pharmacies,
police, poste…) de l'emprise, cliquables dans l'application avec descriptif,
horaires, téléphone, site web et photo.

Trois sources, chacune pour ce qu'elle sait faire :

* **OpenStreetMap** (extrait Geofabrik lu par pyosmium) : position, nom,
  `opening_hours`, téléphone, site web, courriel, adresse, accessibilité,
  identifiants `wikidata` / `wikipedia`. Les horaires sont recopiés tels quels
  et interprétés côté client (horaires.js), avec repli sur le texte brut.
* **Wikipédia / Wikidata** : premier paragraphe de l'article (français de
  préférence, sinon allemand — jamais traduit ni résumé par nos soins) et, à
  défaut, la description courte Wikidata.
* **Wikimedia Commons** : la photo rattachée au lieu par Wikidata (P18), ou
  l'image de tête de l'article, uniquement sous licence libre (CC0, CC BY,
  CC BY-SA, domaine public…) et créditée.

Rien n'est inventé : un lieu sans descriptif n'en a pas, un lieu sans photo
n'en a pas. Les réponses distantes sont gardées dans build/cache/wiki/.

Usage : python build/sites.py [--sans-wiki] [--sans-photos]
"""
import io
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PBF = os.path.join(RACINE, "build", "cache", "pbf", "arnsberg-regbez-latest.osm.pbf")
CACHE_WIKI = os.path.join(RACINE, "build", "cache", "wiki")
SORTIE = os.path.join(RACINE, "data", "sites.json")
IMAGES = os.path.join(RACINE, "img", "sites")
AGENT = "soest-build/1.0 (+https://github.com/cristo67000/soest; carte hors ligne) Python-urllib"
API_WIKIDATA = "https://www.wikidata.org/w/api.php"
API_COMMONS = "https://commons.wikimedia.org/w/api.php"
LARGEUR_PHOTO = 640
PAUSE_COMMONS = 1.2
MARGE = 0.004
LICENCES_LIBRES = re.compile(r"CC0|CC[ -]BY|Public domain|Domaine public|GFDL|FAL|Free Art|PD-|Gemeinfrei", re.I)

# Ordre = priorité : le premier test vrai donne la catégorie.
def categoriser(t):
    a, to, h, le = t.get("amenity"), t.get("tourism"), t.get("historic"), t.get("leisure")
    sport = t.get("sport", "")
    if to == "museum":
        return "musee"
    if to == "gallery":
        return "galerie"
    if to == "zoo":
        return "zoo"
    if to == "theme_park":
        return "parc_attractions"
    if to == "viewpoint":
        return "point_de_vue"
    if to == "information" and t.get("information") == "office":
        return "office_tourisme"
    if h in ("castle", "manor", "palace"):
        return "chateau"
    if h in ("monument", "memorial"):
        # plaques individuelles (Stolpersteine) et tombes : pas des lieux à visiter
        if t.get("memorial") in ("stolperstein", "grave", "plaque") or t.get("historic:memorial") == "stolperstein":
            return None
        return "monument"
    if h in ("city_gate", "citywalls", "tower", "fort"):
        return "fortification"
    if h in ("ruins", "archaeological_site"):
        return "ruines"
    if a == "place_of_worship":
        return "culte"
    if a == "theatre":
        return "theatre"
    if a == "cinema":
        return "cinema"
    if a in ("arts_centre", "community_centre"):
        return "centre_culturel"
    if a == "townhall":
        return "mairie"
    if a == "library":
        return "bibliotheque"
    if a == "hospital":
        return "hopital"
    if a == "clinic":
        return "clinique"
    if a == "pharmacy":
        return "pharmacie"
    if a == "police":
        return "police"
    if a == "fire_station":
        return "pompiers"
    if a == "post_office":
        return "poste"
    if a == "courthouse":
        return "tribunal"
    if a == "marketplace":
        return "marche"
    if a == "public_bath" or le == "water_park" or to == "spa":
        return "thermes"
    if le == "swimming_pool" and t.get("access") != "private" and not t.get("swimming_pool") == "private":
        return "piscine"
    if le in ("sports_centre", "sports_hall") and "swimming" in sport:
        return "piscine"
    if le in ("sports_centre", "sports_hall", "fitness_centre"):
        return "centre_sportif"
    if le == "stadium":
        return "stade"
    if le == "ice_rink":
        return "patinoire"
    if le in ("park", "garden"):
        return "parc"
    if le == "nature_reserve":
        return "reserve_naturelle"
    if a in ("university", "college"):
        return "universite"
    if to == "attraction":
        return "attraction"
    return None


def log(*a):
    print(*a, flush=True)


def normaliser(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", s.lower().strip())


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", normaliser(s).replace("ß", "ss")).strip("-")[:60]


def metres(lon1, lat1, lon2, lat2):
    kx = 111320 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lon1 - lon2) * kx, (lat1 - lat2) * 110574)


def sans_html(texte, maximum=700):
    texte = re.sub(r"<[^>]+>", " ", texte or "")
    texte = " ".join(texte.replace("&nbsp;", " ").replace("&amp;", "&").split())
    if len(texte) > maximum:
        coupe = texte[:maximum].rsplit(". ", 1)
        texte = (coupe[0] + ".") if len(coupe) == 2 and len(coupe[0]) > 200 else texte[:maximum].rsplit(" ", 1)[0] + "…"
    return texte


def emprise():
    gj = json.load(open(os.path.join(RACINE, "build", "emprise.geojson"), encoding="utf-8"))
    xs = [p[0] for p in gj["geometry"]["coordinates"][0]]
    ys = [p[1] for p in gj["geometry"]["coordinates"][0]]
    return (min(xs) - MARGE, min(ys) - MARGE, max(xs) + MARGE, max(ys) + MARGE)


# ---------------------------------------------------------------- OpenStreetMap
def lire_osm():
    import osmium
    b = emprise()
    bruts = []

    def retenir(t, lon, lat, osm_id):
        if not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
            return
        nom = (t.get("name") or "").strip()
        if not nom:
            return
        cat = categoriser(t)
        if not cat:
            return
        tel = t.get("phone") or t.get("contact:phone") or t.get("contact:mobile") or ""
        site = t.get("website") or t.get("contact:website") or t.get("url") or ""
        if site and not re.match(r"^https?://", site):
            site = "https://" + site
        courriel = t.get("email") or t.get("contact:email") or ""
        adresse = ""
        if t.get("addr:street"):
            adresse = (t["addr:street"] + " " + (t.get("addr:housenumber") or "")).strip()
            if t.get("addr:city"):
                adresse += ", " + ((t.get("addr:postcode") or "") + " " + t["addr:city"]).strip()
        wiki = (t.get("wikipedia") or "").strip()
        bruts.append({
            "id": osm_id, "nom": nom, "cat": cat, "lon": round(lon, 6), "lat": round(lat, 6),
            "adresse": adresse, "horaires": (t.get("opening_hours") or "").strip(), "tel": tel.strip(),
            "site": site.strip(), "courriel": courriel.strip(), "description_osm": (t.get("description") or "").strip(),
            "wikidata": (t.get("wikidata") or "").strip(), "wikipedia": wiki,
            "fauteuil": t.get("wheelchair", ""), "payant": t.get("fee", ""), "operateur": t.get("operator", ""),
            "religion": t.get("religion", ""), "confession": t.get("denomination", ""),
            "image": t.get("image", "") if re.match(r"^https?://", t.get("image", "") or "") else "",
            "n_tags": len(t),
        })

    class Lecteur(osmium.SimpleHandler):
        def node(self, n):
            if n.location.valid() and len(n.tags) >= 2:
                retenir(n.tags, n.location.lon, n.location.lat, "n%d" % n.id)

        def area(self, a):
            if len(a.tags) < 2:
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
                retenir(a.tags, sx / k, sy / k, ("w%d" if a.from_way() else "r%d") % a.orig_id())

    t0 = time.time()
    Lecteur().apply_file(PBF, locations=True, idx="flex_mem")
    log("  OSM : %d candidats, %.0f s" % (len(bruts), time.time() - t0))
    return dedoublonner(bruts)


def dedoublonner(bruts):
    """Même nom et même catégorie à moins de 200 m (nœud + bâtiment) : on garde le plus renseigné."""
    bruts.sort(key=lambda s: (-(bool(s["horaires"]) + bool(s["site"]) + bool(s["wikidata"])), -s["n_tags"]))
    gardes = []
    for s in bruts:
        n = normaliser(s["nom"])
        doublon = False
        for g in gardes:
            if g["cat"] == s["cat"] and normaliser(g["nom"]) == n and metres(g["lon"], g["lat"], s["lon"], s["lat"]) < 200:
                doublon = True
                for champ in ("horaires", "tel", "site", "courriel", "wikidata", "wikipedia", "adresse", "description_osm"):
                    if not g[champ] and s[champ]:
                        g[champ] = s[champ]
                break
        if not doublon:
            gardes.append(s)
    log("  %d sites après dédoublonnage" % len(gardes))
    return gardes


# ---------------------------------------------------------------- Wikipédia / Wikidata
def json_distant(url, params=None, cle=None, essais=3):
    os.makedirs(CACHE_WIKI, exist_ok=True)
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    chemin = os.path.join(CACHE_WIKI, (cle or re.sub(r"[^a-zA-Z0-9]+", "_", url)[-120:]) + ".json")
    if os.path.exists(chemin):
        return json.load(open(chemin, encoding="utf-8"))
    derniere = None
    for essai in range(essais):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            json.dump(data, open(chemin, "w", encoding="utf-8"), ensure_ascii=False)
            time.sleep(0.4)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                json.dump({"absent": True}, open(chemin, "w", encoding="utf-8"))
                return {"absent": True}
            derniere = e
            time.sleep(2 * (essai + 1))
        except Exception as e:
            derniere = e
            time.sleep(2 * (essai + 1))
    log("    échec distant : %s (%s)" % (url[:100], derniere))
    return None


def resume_wikipedia(langue, titre):
    url = "https://%s.wikipedia.org/api/rest_v1/page/summary/%s" % (langue, urllib.parse.quote(titre.replace(" ", "_"), safe=""))
    return json_distant(url, cle="resume-%s-%s" % (langue, slug(titre)))


def entite_wikidata(qid):
    return json_distant(API_WIKIDATA, {"action": "wbgetentities", "ids": qid, "props": "claims|sitelinks|descriptions",
                                       "languages": "fr|de", "format": "json"}, cle="wd-" + qid)


def enrichir_wiki(sites):
    n_desc = n_photo = 0
    for s in sites:
        qid = s["wikidata"]
        resume = None
        if not qid and s["wikipedia"] and ":" in s["wikipedia"]:
            langue, titre = s["wikipedia"].split(":", 1)
            if langue in ("de", "fr", "en", "nl"):
                resume = resume_wikipedia(langue, titre)
                if resume and not resume.get("absent"):
                    qid = resume.get("wikibase_item", "") or ""
                    s["wikidata"] = qid
        if not qid:
            continue
        ent = entite_wikidata(qid)
        if not ent or ent.get("absent"):
            continue
        e = (ent.get("entities") or {}).get(qid) or {}
        liens = e.get("sitelinks") or {}
        fichier = ""
        for rev in (e.get("claims") or {}).get("P18") or []:
            v = rev.get("mainsnak", {}).get("datavalue", {}).get("value")
            if v:
                fichier = v
                break
        description = ""
        source = ""
        url_article = ""
        for langue in ("fr", "de"):
            titre = (liens.get(langue + "wiki") or {}).get("title")
            if not titre:
                continue
            r = resume if (resume and resume.get("lang") == langue) else resume_wikipedia(langue, titre)
            if not r or r.get("absent"):
                continue
            extrait = sans_html(r.get("extract") or "")
            if extrait:
                description = extrait
                source = "Wikipédia" + (" (en allemand)" if langue == "de" else "")
                url_article = (r.get("content_urls") or {}).get("desktop", {}).get("page", "") or "https://%s.wikipedia.org/wiki/%s" % (langue, urllib.parse.quote(titre.replace(" ", "_")))
                if not fichier:
                    src = ((r.get("originalimage") or {}).get("source") or "")
                    m = re.search(r"/commons/[0-9a-f]/[0-9a-f]{2}/([^/?]+)", src)
                    if m:
                        fichier = urllib.parse.unquote(m.group(1)).replace("_", " ")
                break
        if not description:
            d = e.get("descriptions") or {}
            for langue in ("fr", "de"):
                if d.get(langue, {}).get("value"):
                    description = d[langue]["value"]
                    description = description[0].upper() + description[1:]
                    source = "Wikidata" + (" (en allemand)" if langue == "de" else "")
                    break
        if description:
            s["description"] = description
            s["description_source"] = source
            s["article"] = url_article
            n_desc += 1
        if fichier:
            s["_fichier"] = fichier
            n_photo += 1
    log("  Wikipédia/Wikidata : %d descriptifs, %d photos référencées" % (n_desc, n_photo))


# ---------------------------------------------------------------- Commons
def details_commons(noms):
    details = {}
    noms = sorted(set(noms))
    for debut in range(0, len(noms), 20):
        lot = noms[debut:debut + 20]
        data = json_distant(API_COMMONS, {
            "action": "query", "format": "json", "titles": "|".join("File:" + n for n in lot),
            "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": str(LARGEUR_PHOTO),
        }, cle="commons-%d-%s" % (debut, slug("".join(lot))[:40]))
        if not data:
            continue
        for page in (data.get("query", {}).get("pages") or {}).values():
            infos = (page.get("imageinfo") or [{}])[0]
            if not infos.get("thumburl"):
                continue
            meta = infos.get("extmetadata") or {}

            def champ(cle):
                return sans_html((meta.get(cle) or {}).get("value", ""), 120)

            licence = champ("LicenseShortName")
            if not LICENCES_LIBRES.search(licence or ""):
                continue   # licence absente ou non libre : pas de photo
            details[page["title"][len("File:"):]] = {
                "url": infos["thumburl"], "auteur": champ("Artist") or "auteur inconnu", "licence": licence,
                "page": infos.get("descriptionurl", ""),
            }
    return details


def telecharger_photos(sites):
    from PIL import Image
    os.makedirs(IMAGES, exist_ok=True)
    fichiers = [s["_fichier"] for s in sites if s.get("_fichier")]
    details = details_commons(fichiers)
    log("  Commons : %d fichiers sous licence libre sur %d" % (len(details), len(set(fichiers))))
    obtenues = 0
    for s in sites:
        f = s.pop("_fichier", None)
        if not f or f not in details:
            continue
        info = details[f]
        nom = slug(s["nom"]) + "-" + s["id"] + ".webp"
        cible = os.path.join(IMAGES, nom)
        if not os.path.exists(cible):
            brut = None
            for essai in range(3):
                try:
                    req = urllib.request.Request(info["url"], headers={"User-Agent": AGENT})
                    with urllib.request.urlopen(req, timeout=120) as r:
                        brut = r.read()
                    break
                except Exception as e:
                    if essai == 2:
                        log("    photo indisponible pour %s : %s" % (s["nom"], e))
                    time.sleep(3 * (essai + 1))
            if brut is None:
                continue
            try:
                im = Image.open(io.BytesIO(brut)).convert("RGB")
                im.thumbnail((LARGEUR_PHOTO, LARGEUR_PHOTO))
                im.save(cible, "WEBP", quality=78, method=5)
            except Exception as e:
                log("    image illisible pour %s : %s" % (s["nom"], e))
                continue
            time.sleep(PAUSE_COMMONS)
        s["photo"] = "img/sites/" + nom
        s["photo_credit"] = "%s — %s (Wikimedia Commons)" % (info["auteur"], info["licence"])
        s["photo_page"] = info["page"]
        obtenues += 1
    log("  %d photos embarquées" % obtenues)


# ---------------------------------------------------------------- programme
def main():
    sans_wiki = "--sans-wiki" in sys.argv
    sans_photos = "--sans-photos" in sys.argv or sans_wiki
    if not os.path.exists(PBF):
        log("Extrait Geofabrik absent :", PBF)
        return 1
    log("== OpenStreetMap")
    sites = lire_osm()
    if not sans_wiki:
        log("== Wikipédia / Wikidata")
        enrichir_wiki(sites)
    if not sans_photos:
        log("== Wikimedia Commons")
        telecharger_photos(sites)
    for s in sites:
        s.pop("_fichier", None)
        s.pop("n_tags", None)
        for k in list(s.keys()):
            if s[k] in ("", None):
                del s[k]
    sites.sort(key=lambda s: (s["cat"], normaliser(s["nom"])))
    from collections import Counter
    compte = Counter(s["cat"] for s in sites)
    resultat = {"date": time.strftime("%Y-%m-%d"), "source": "OpenStreetMap (ODbL) ; descriptifs Wikipédia/Wikidata (CC BY-SA) ; photos Wikimedia Commons, créditées",
                "sites": sites}
    os.makedirs(os.path.dirname(SORTIE), exist_ok=True)
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(resultat, f, ensure_ascii=False, separators=(",", ":"))
    log("  %s : %d sites, %d avec horaires, %d avec descriptif, %d avec photo, %d Ko" % (
        os.path.relpath(SORTIE, RACINE), len(sites), sum(1 for s in sites if s.get("horaires")),
        sum(1 for s in sites if s.get("description")), sum(1 for s in sites if s.get("photo")), os.path.getsize(SORTIE) // 1000))
    for cat, n in sorted(compte.items(), key=lambda x: -x[1]):
        log("    %-20s %d" % (cat, n))


if __name__ == "__main__":
    sys.exit(main())
