# Soest — Architecture de l'application

Carte de navigation et de géolocalisation hors ligne de **Soest et de ses environs
(carré de ±10 km autour du centre)**, scénario « C » retenu le 2026-11-01 : fond vectoriel
OpenStreetMap au zoom 15, **carte topographique officielle du Land jusqu'au zoom 16**,
relief, adresses, transports, lieux personnels, itinéraires en ligne mémorisés. PWA sans
build, socle repris de `rhin-superieur` (lui-même issu de `strasbourg-eurometropole`) :
MapLibre GL + PMTiles, paquets en morceaux lus par plages d'octets, OPFS hors ligne.

Tout reste sur l'appareil : aucun compte, aucune télémétrie ; les seuls accès réseau
facultatifs sont le téléchargement des paquets, la recherche en ligne de secours (Photon)
et le calcul d'itinéraires (Valhalla/OSRM publics).

## 1. Emprise et données

| Paquet | Contenu | Poids | Fabrication |
|---|---|---|---|
| `fond` | Fond vectoriel Protomaps (OpenStreetMap) zoom 0 → 15 sur l'emprise | 10 Mo, 1 060 tuiles | `build/tuiles.py` (`pmtiles extract --region`) |
| `contexte` | Europe zoom 0 → 6, pour le dézoom | 6,2 Mo | idem |
| `topo` | Carte topographique officielle DTK (Geobasis NRW), tuiles **512 px** WebP q90, adressage zoom 5 → 15 (équivalent 256 px : 6 → 16) | 58,8 Mo, 1 055 tuiles, 2 morceaux | `build/topo.py` (WMS `wms_nw_dtk`, couche `nw_dtk_col`) |
| `relief` | Altitudes Terrarium (EU-DEM 25 m) zoom 0 → 13, WebP sans perte, précision 25 cm | 2,4 Mo, 102 tuiles | `build/relief.py` |
| `adresses` | Index OSM : 36 478 adresses, 2 303 rues, 20 communes | 0,26 Mo gzip | `build/adresses.py` (pyosmium sur l'extrait Geofabrik `arnsberg-regbez`) |
| — | `data/transports.json` : 662 arrêts (7 gares/haltes, 655 arrêts de bus), 226 relations de lignes (16 train, 210 bus) avec tracés | 1,6 Mo, précaché | `build/transports.py` (pyosmium, deux passes) |
| — | `data/communes.json` : 148 localités (`place=*`) | 10 Ko, précaché | `build/adresses.py` |
| — | `data/sites.json` : 370 lieux et services publics (OSM) dont 86 avec descriptif Wikipédia/Wikidata et 75 avec photo Commons (`img/sites/*.webp`, 640 px) | 4,6 Mo, précachés | `build/sites.py` |

L'emprise (`build/emprise.py` → `build/emprise.geojson`, `data/emprise.json`) est le carré
géographique de 20 km de côté centré sur 51,5711 N / 8,1056 E (400 km²) : pas de limite
administrative à aller chercher pour un rayon demandé « d'environ 10 km ».

Chaque paquet est **découpé en morceaux de 48 Mo** (`data/<paquet>/<paquet>.NNN`) : GitHub
refuse les fichiers > 100 Mo. `data/version.json` décrit les paquets (taille, morceaux,
sha256, date) ; `data/precache.json` (`build/manifeste.py`) liste l'app shell.

### Carte topographique officielle (`build/topo.py`)

Geobasis NRW publie ses cartes en licence Datenlizenz Deutschland – Zero 2.0 ; le WMS
`https://www.wms.nrw.de/geobasis/wms_nw_dtk` (AccessConstraints NONE) accepte EPSG:3857 et
répond en ~0,5 s. La couche `nw_dtk_col` enchaîne DTK500/250/100/50/25/10 selon l'échelle :
la DTK10 apparaît au zoom 16 (1,5 m/pixel) ; au-delà, MapLibre agrandit la dernière tuile.
Mesuré sur échantillons : une tuile 512 px réencodée WebP q90 pèse 83 Ko contre 4 × 31 Ko
en 256 px (−35 %), d'où l'adressage « @2x » (`tileSize: 512`, une tuile du niveau z couvre
les quatre tuiles 256 px du niveau z+1). Les PNG WMS sont gardés dans `build/cache/dtk/`.

## 2. Lecture des données : `stockage.js`

Une archive PMTiles se lit par plages d'octets. `Stockage.lire(cle, debut, longueur)`
répartit la plage sur les morceaux et lit :

- **hors ligne** : fichiers de l'OPFS (Origin Private File System), écrits par le worker
  `telechargeur.js` (`createSyncAccessHandle`, reprise au byte près après interruption,
  manifeste écrit en dernier) et lus par `File.slice()` ;
- **sinon** : requêtes HTTP `Range` sur les morceaux publiés (GitHub Pages les sert).

Le Cache Storage est évité pour les gros fichiers (il ne sert pas une plage sans recharger
l'entrée entière — piège de Strasbourg). `Stockage.sourcePmtiles(cle)` fournit à pmtiles.js
un objet `{ getKey, getBytes }` ; `carte.js` enregistre le protocole
`soest://<paquet>/{z}/{x}/{y}` qui route le zoom ≤ 6 du fond vers `contexte` (repli sur
`fond`) et sert `topo` et `relief` tels quels — une tuile raster absente est une **erreur**
(filtrée dans l'écouteur `error`), jamais un tableau vide (voir § 5).

## 3. Modules (ordre de chargement)

`panneau.js` (volet latéral, messages, constructeurs d'interface dont `choix()`, boutons
segmentés) → `stockage.js` → `carte.js` (style Protomaps clair/sombre, couche raster `topo`,
réglages persistants, protocole, emprise, bouton « Topo / OSM ») → `recherche.js`
(coordonnées GPS en décimal/DMS/geo:, agrégation des fournisseurs par score) →
`navigation.js` (position, cap boussole, suivi/orientation, guidage à vol d'oiseau, traces
GPX) → `adresses.js` → `relief.js` (+ `courbes-worker.js`) → `transports.js` → `lieux.js` →
`itineraires.js` → `pwa.js` (service worker, panneau Hors ligne).

Chaque module pose ses sources et couches via `Carte.surStyle(fn)` : `fn` est rejouée à
chaque reconstruction du style (thème, langue, fond), donc idempotente.

### Ordre des couches et fond topographique

Le style de base se termine par la couche raster `topo` (si le réglage `fond` vaut
`"topo"`, `minzoom: 10` : en dessous, et hors de l'emprise, OpenStreetMap reste visible
sous le raster opaque), les bâtiments 3D, le contour de l'emprise, puis un calque vide
**`reperes-modules`**. Les modules qui doivent passer *sous* les lieux et la position mais
*au-dessus* du raster (ombrage et courbes de `relief.js`, lignes et arrêts de
`transports.js`) insèrent leurs couches juste avant ce repère ; les autres (position, numéros,
lieux, itinéraires) s'ajoutent en fin de pile. Sur le fond OpenStreetMap seul, l'ombrage
retourne sous l'eau et les routes, comme dans Rhin supérieur. En thème sombre, le raster est
assombri (`raster-brightness-max` 0,82, saturation −0,2) plutôt que remplacé.

### Transports (`transports.js`)

`data/transports.json` : `arrets` = `[nom, lon, lat, type, [refs]]`, `lignes` = relations
OSM (`ref`, `nom`, `type`, `couleur`, `op`, `de`, `a`, `traces` MultiLineString). Deux sources
GeoJSON, cinq couches (trains dès le zoom 8, bus dès 12, arrêts de bus dès 13, étiquettes
dès 15). Un arrêt cliqué ouvre `Recherche.ouvrirFichePoint` (coordonnées, altitude, « y
aller », « ajouter à mes lieux ») complété des lignes qui le desservent (sens, exploitant) ;
une ligne cliquée liste ses arrêts dans l'emprise. Fournisseur de recherche « arrêts »
(priorité 18). Rattachement arrêt ↔ ligne côté build : nœud membre de la relation à moins
de 80 m (bus) ou 400 m (gares, sinon tracé à moins de 150 m) — 124 arrêts de bus sur 655
n'appartiennent à aucune relation dans OSM et s'affichent sans ligne.

### Sites et services publics (`sites.js`, `horaires.js`)

`build/sites.py` lit l'extrait Geofabrik (pyosmium) et classe en 33 catégories les objets
nommés : musées, galeries, châteaux, tours et fortifications (les mémoriaux, plaques et
Stolpersteine sont écartés : ils encombraient la carte sans être des lieux à visiter),
lieux de culte, théâtres, cinémas, centres culturels, parcs, réserves, points de vue, offices
de tourisme, mairies, bibliothèques, hôpitaux, cliniques, pharmacies, police, pompiers, poste,
tribunal, marché, thermes, piscines, centres sportifs, stades… (nœud ou centre du bâtiment,
doublons nœud + bâtiment fusionnés à moins de 200 m). Il complète par Wikipédia (premier
paragraphe en français, sinon en allemand, jamais traduit), à défaut la description courte
Wikidata, et par la photo Wikidata P18 ou l'image de tête de l'article, **uniquement sous
licence libre** (CC0, CC BY, CC BY-SA, domaine public…), réduite à 640 px et créditée
(auteur, licence, lien Commons). Réponses distantes en cache dans `build/cache/wiki/`.

Côté client, `sites.js` dessine des pictogrammes **sans étiquette** (disque blanc cerclé de la
couleur de la catégorie, émoji au centre, rendus sur canvas et enregistrés comme images du
style) sous les lieux et la position, avec un zoom d'apparition par catégorie ; les genres correspondants du
fond Protomaps (`museum`, `park`, `library`, `townhall`…) sont retirés de la couche `pois`
pour ne pas doubler les symboles. La fiche : photo créditée, pastille ouvert / fermé /
horaires à vérifier, résumé des horaires en français ou texte brut, descriptif et lien vers
l'article, téléphone (`tel:`), site, courriel, adresse (ou adresse la plus proche via
l'index hors ligne), « ajouter à mes lieux », « y aller ». Fournisseur de recherche par nom
ou par catégorie (priorité 17). `horaires.js` reprend le moteur `opening_hours` de
strasbourg-eurometropole (règles mois/jours/plages, PH, 24/7, plages passant minuit,
exceptions datées périmées ignorées) avec les jours fériés de NRW (Fronleichnam,
Allerheiligen…) ; hors du sous-ensemble reconnu, on affiche le texte brut plutôt qu'un
état faux.

### Adresses (`adresses.js`)
Paquet binaire gzippé (`SOADR1`, en-tête JSON + 4 tableaux alignés : numéro u16, suffixe u16,
lon/lat i32 en millionièmes), décompressé en mémoire au premier usage (paquet installé
seulement). Recherche par mots (abréviations str./pl.), numéro devant ou derrière le nom,
numéro le plus proche sinon ; géocodage inverse par grille de 0,01° ; numéros de maison
dessinés dès le zoom 17. Photon public en secours quand le réseau est là (1 requête / 1,2 s).

### Relief (`relief.js`)
Ombrage (`hillshade`), terrain 3D, courbes calculées sur l'appareil (worker marching squares
→ MVT maison, protocole `courbes://`), altitude d'un point. Exagération réduite (0,22) sur la
carte topographique, qui porte déjà ses propres courbes.

### Mise à jour de l'application (`miseajour.js`, `sw.js`)
Service worker à cache unique versionné par `build` (`data/precache.json`, 806 fichiers) ;
la nouvelle version attend un clic sur le bandeau (`skipWaiting` sur message), revérification
au retour à l'écran, au plus toutes les 15 minutes. Les paquets (`data/fond|contexte|topo|
relief|adresses/`) ne passent jamais par le service worker.

## 4. Recette

Serveur de développement : `python build/serveur.py 8162` (requêtes Range), entrée `soest`
de `.claude/launch.json`. Recette du 2026-11-01 dans le volet Navigateur de l'app de bureau :
fond topographique au zoom 12 et 16, bascule OSM, thème sombre, fiche de la gare de Soest
(RB 59, RB 89, RE 11 avec sens et exploitants), recherche (arrêt + localité + Photon),
adresses hors ligne (« Markt 1 Soest » → 59494 Soest), installation des quatre groupes de
paquets par le panneau Hors ligne, puis **serveur coupé et rechargement** : application
servie par le service worker, carte topographique, arrêts et altitude (99,75 m au Markt)
lus dans l'OPFS, aucune ressource en échec.

Le volet Navigateur ne rend rien tant qu'il est masqué (MapLibre dessine dans
`requestAnimationFrame`) : afficher le volet (`show_pane preview`) avant d'interroger
`queryRenderedFeatures` ou de capturer, sinon on conclut à tort à une carte vide.

## 5. Enseignements techniques

Hérités de Rhin supérieur (toujours valables) :
- `isStyleLoaded()` retombe à faux dès qu'une source GeoJSON d'un module charge : `Carte.surStyle`
  teste la présence des couches du style (`getStyle().layers`) et appelle aussitôt.
- `fitBounds` attend sud-ouest puis nord-est.
- Un `[hidden]` HTML est annulé par tout `display:` en CSS : règle globale `[hidden] { display: none !important; }`.
- Protomaps v4 : pas de numéros de maison ni de couche transit (d'où `transports.js`) ; `lang`
  inconnu (`xx`) donne les noms locaux.
- Terrarium : quantifier le canal bleu à 64 près puis WebP sans perte (96 Ko → 19 Ko par tuile).
- Les Releases GitHub ne renvoient pas d'en-tête CORS : les données vivent dans le dépôt Pages.

Propres à Soest :
- **Tuile raster absente → erreur, pas d'octets vides** : avec `new Uint8Array()` MapLibre
  fabrique une image 1 × 1 ; pour le relief l'ombrage voisin échoue (« dem dimension
  mismatch »), pour la topo on obtiendrait des carrés gris. Le protocole lève
  `tuile absente (<paquet>)`, filtré dans l'écouteur `error`.
- **Raster opaque au-dessus du fond vectoriel** plutôt que fond remplacé : hors emprise et
  sous le zoom 10, OpenStreetMap reste visible sans logique supplémentaire ; le prix est
  un calque repère (`reperes-modules`) pour que l'ombrage et les transports s'insèrent entre
  le raster et les lieux.
- **WMS en 512 px** : 35 % plus compact que 4 × 256 px à qualité égale (moins d'en-têtes,
  meilleure compression) ; `tileSize: 512` dans la source MapLibre, adressage un niveau plus bas.
- **Les scripts de build qui écrivent `data/version.json` ne doivent pas tourner en même
  temps** (lecture-modification-écriture sans verrou) : topo et adresses ont été séquencés.
- Extraits Geofabrik + pyosmium pour les adresses et les transports (72 s pour 195 Mo) :
  pas d'Overpass. Les relations de lignes sont lues en première passe pour connaître leurs
  chemins membres avant la seconde.
- `python -c "…"` avec guillemets imbriqués et heredocs longs dans le shell Git Bash de
  Windows : préférer un fichier de script (voir la mémoire « pièges Write / heredoc »).
- Les `historic=memorial` d'OSM sont aux trois quarts des **Stolpersteine** (plaques
  nominatives au sol) : les écarter (`memorial=stolperstein|grave|plaque`), sinon la couche
  « monuments » n'est qu'une liste de noms de personnes.
- `Recherche.chercher()` ne doit pas être appelée en parallèle depuis du code : le
  fournisseur Photon annule la temporisation de l'appel précédent, dont la promesse ne se
  règle alors jamais (sans effet dans l'interface, où chaque frappe remplace la précédente).
- Les émojis dessinés sur canvas (`fillText`) donnent des pictogrammes lisibles sans jeu
  d'icônes à maintenir ; `addImage` les prend avec `pixelRatio: 2` pour rester nets.
- **Lisibilité à fort zoom (2026-11-01)** : plus aucune étiquette en couleur sur la carte —
  ni pour les lieux, ni pour les arrêts de bus (seules les gares gardent leur nom sous le
  zoom 15), ni pour les commerces du fond Protomaps (`text-field` vidé, pictogrammes
  conservés) ; le nom apparaît dans la fiche. Au-delà du zoom 17, la carte topographique
  (dernière tuile à 1,5 m/pixel) deviendrait floue en s'agrandissant : `raster-opacity`
  passe de 1 à 0 entre 17 et 18 et le fond vectoriel, net à tout zoom, prend le relais.
