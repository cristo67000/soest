# Soest — carte hors ligne de la ville et de ses environs

Application web installable (PWA) de navigation et de géolocalisation couvrant **Soest
(Westphalie, Rhénanie-du-Nord-Westphalie) et ses environs dans un rayon de 10 km** —
Bad Sassendorf, Welver, Lippetal (sud), Möhnesee, Ense, Werl… — utilisable **sans réseau**
une fois les paquets téléchargés (≈ 78 Mo en tout).

**En ligne : <https://cristo67000.github.io/soest/>** — à ouvrir dans Chrome (Android) ou
Safari (iPhone), puis « Ajouter à l'écran d'accueil » et bouton « Hors ligne » pour
télécharger les cartes.

- **Carte topographique officielle du Land** (DTK10/25/50, Geobasis NRW, licence
  Datenlizenz Deutschland – Zero 2.0) : nette jusqu'au 1:10 000 — bâtiments, chemins,
  courbes de niveau, lieux-dits, toponymes. Bouton « Topo » / « OSM » pour basculer.
- **Fond OpenStreetMap très détaillé** (Protomaps, zoom 15) : rues et chemins, bâtiments,
  commerces et services, rivières, forêts, villages ; noms locaux ou en français,
  bâtiments 3D. Contexte Europe pour le dézoom.
- **Relief** : ombrage, courbes de niveau calculées sur l'appareil, terrain 3D, altitude
  d'un point (EU-DEM 25 m).
- **Transports** : gare de Soest et haltes (RE 11, RB 59, RB 89), 655 arrêts de bus,
  tracés des lignes, lignes desservant chaque arrêt (OpenStreetMap ; pas d'horaires).
- **Adresses hors ligne** : 36 478 adresses OpenStreetMap, numéros de maison sur la carte,
  adresse la plus proche d'un point ; recherche en ligne de secours (Photon).
- **Mes lieux** : adresses, lieux et coordonnées GPS (décimal, DMS, lien geo:) ajoutés par
  appui long, depuis la position ou par saisie ; catégories, notes, import/export
  GeoJSON, GPX, CSV.
- **Navigation** : position et cap (boussole), carte orientée, guidage à vol d'oiseau,
  itinéraires voiture/vélo/piéton calculés en ligne (Valhalla, OSRM) puis **enregistrés pour
  le hors ligne**, suivi pas à pas, enregistrement de traces GPX.

Tout reste sur l'appareil : aucun compte, aucune télémétrie.

## Paquets téléchargeables (bouton « Hors ligne »)

| Paquet | Poids | Contenu |
|---|---|---|
| Fond de carte | 16 Mo | tuiles vectorielles OSM zoom 0 → 15 (10 Mo) + Europe dézoomée (6 Mo) |
| Carte topographique | 59 Mo | DTK officielle, tuiles 512 px WebP, zoom 6 → 16 |
| Relief | 2,4 Mo | altitudes Terrarium (EU-DEM 25 m) zoom 0 → 13 |
| Adresses | 0,3 Mo | 36 478 adresses, 2 303 rues, 148 localités |

Les arrêts et lignes de transport (1,6 Mo) font partie de l'application elle-même.

## Développement

Aucune compilation : fichiers statiques. Serveur local avec requêtes Range (indispensable
pour PMTiles) :

```bash
python build/serveur.py 8162
```

Reconstruction des données (Python 3.11, `shapely`, `numpy`, `Pillow`, `osmium`,
`build/pmtiles.exe` à télécharger depuis les versions de go-pmtiles, et l'extrait
Geofabrik `arnsberg-regbez-latest.osm.pbf` dans `build/cache/pbf/`) :

```bash
python build/emprise.py      # carré de ±10 km autour de Soest
python build/tuiles.py       # fond Protomaps + contexte Europe
python build/relief.py       # tuiles d'altitude
python build/topo.py         # carte topographique officielle (WMS Geobasis NRW)
python build/adresses.py     # index d'adresses
python build/transports.py   # arrêts et lignes
python build/icones.py && python build/manifeste.py
```

Les scripts qui écrivent `data/version.json` (tuiles, relief, topo, adresses) se lancent
l'un après l'autre, jamais en parallèle. Voir [ARCHITECTURE.md](ARCHITECTURE.md) pour les
choix techniques et les pièges rencontrés.

## Données et licences

- Carte topographique : © [Geobasis NRW](https://www.bezreg-koeln.nrw.de/geobasis-nrw),
  Datenlizenz Deutschland – Zero – Version 2.0 (service WMS `wms_nw_dtk`).
- Fond de carte, adresses, transports : © les contributeurs
  [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL) ; tuiles
  [Protomaps](https://protomaps.com), extrait [Geofabrik](https://download.geofabrik.de).
- Relief : Terrain Tiles (Mapzen/AWS), EU-DEM © Union européenne, Copernicus.
- Itinéraires : serveurs publics [Valhalla](https://valhalla.openstreetmap.de) (FOSSGIS) et
  [OSRM](https://project-osrm.org). Recherche en ligne : [Photon](https://photon.komoot.io).
- Polices Noto Sans (OFL), MapLibre GL JS (BSD), pmtiles.js (BSD), @protomaps/basemaps (BSD).
