"use strict";
/* Soest — socle carte.
 * MapLibre GL + archives PMTiles réparties (stockage.js), style Protomaps
 * clair/sombre, réglages persistants. Expose le namespace `Carte` dont
 * dépendent les autres modules (recherche, lieux, navigation, relief…). */
var Carte = (function () {
  var VUE_INITIALE = { center: [8.1056, 51.5711], zoom: 12.4 }; // Soest, son Wallring et les villages alentour
  var URL_GLYPHES = new URL("assets/glyphs/", location.href).href + "{fontstack}/{range}.pbf";
  var CLE_REGLAGES = "soest.reglages";
  var DEFAUTS = {
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "sombre" : "clair",
    fond: "topo",          // "topo" : carte topographique officielle du Land (paquet topo) ; "osm" : fond vectoriel seul
    transports: true,      // arrêts et lignes de bus et de train (transports.js)
    sites: true,           // musées, églises, parcs, mairies, piscines, hôpitaux… cliquables (sites.js)
    nomsFrancais: false,   // sinon noms locaux (Köln plutôt que Cologne) ; sans effet autour de Soest
    pois: true,            // commerces et services du fond de carte
    troisD: false,
    relief: true,          // ombrage (module relief.js, s'il est chargé)
    courbes: false,        // courbes de niveau (idem)
    terrain3D: false,      // terrain en relief réel (idem)
    numeros: true,         // numéros de maison à fort zoom (paquet adresses)
    enLigne: true          // recherche en ligne de secours (Photon)
  };
  // Genres de commerces retirés du fond : bruit visuel (même choix que
  // strasbourg-eurometropole), les restaurants, cafés, bars… restent ; et les
  // genres que sites.js dessine lui-même avec une fiche (musées, parcs,
  // mairies, bibliothèques…), pour ne pas doubler les pictogrammes.
  var GENRES_POI_EXCLUS = ["fast_food", "supermarket", "convenience", "beauty",
                           "park", "garden", "zoo", "stadium", "university", "library", "post_office", "townhall", "attraction", "museum", "theatre"];

  var reglages = chargerReglages();
  var archives = {};        // cle de paquet -> pmtiles.PMTiles
  var surStyleFns = [];     // rappels rejoués à chaque reconstruction du style
  var emprise = null;       // { bbox, contour } (data/emprise.json)
  var carte = null;
  var marqueur = null;

  // ---------- réglages ----------
  function chargerReglages() {
    try {
      return Object.assign({}, DEFAUTS, JSON.parse(localStorage.getItem(CLE_REGLAGES) || "{}"));
    } catch (e) {
      return Object.assign({}, DEFAUTS);
    }
  }
  function sauverReglages() {
    try { localStorage.setItem(CLE_REGLAGES, JSON.stringify(reglages)); } catch (e) { /* mode privé */ }
  }
  function reglage(nom) { return reglages[nom]; }
  function definirReglage(nom, valeur) {
    if (reglages[nom] === valeur) return;
    reglages[nom] = valeur;
    sauverReglages();
    if (nom === "theme") document.body.classList.toggle("sombre", valeur === "sombre");
    if (nom === "troisD" && carte && carte.getLayer("batiments-3d")) {
      carte.setLayoutProperty("batiments-3d", "visibility", valeur ? "visible" : "none");
      carte.easeTo({ pitch: valeur ? 55 : 0, duration: 600 });
      return;
    }
    if (nom === "pois" && carte && carte.getLayer("pois")) {
      carte.setLayoutProperty("pois", "visibility", valeur ? "visible" : "none");
      return;
    }
    if (nom === "relief" || nom === "courbes" || nom === "terrain3D") {
      if (window.Relief) Relief.appliquerReglages();
      return;
    }
    if (nom === "numeros" || nom === "enLigne") {
      if (window.Adresses) Adresses.appliquerReglages();
      return;
    }
    if (nom === "transports") {
      if (window.Transports) Transports.appliquerReglages();
      return;
    }
    if (nom === "sites") {
      if (window.Sites) Sites.appliquerReglages();
      return;
    }
    if (nom === "fond") majBoutonFond();
    if (carte) carte.setStyle(construireStyle());
  }
  function themeSombre() { return reglages.theme === "sombre"; }
  document.body.classList.toggle("sombre", themeSombre());

  // ---------- archives PMTiles et protocole soest:// ----------
  function archive(cle) {
    if (!archives[cle]) archives[cle] = new pmtiles.PMTiles(Stockage.sourcePmtiles(cle));
    return archives[cle];
  }

  Stockage.surChangement(function (cle) {
    delete archives[cle];
    // les tuiles déjà affichées restent ; les suivantes viendront du bon endroit
    if (carte && carte.getSource("fond")) carte.getSource("fond").setTiles(["soest://fond/{z}/{x}/{y}"]);
  });

  /* soest://<paquet>/{z}/{x}/{y} : le fond de carte sert les zooms 7 à 15,
     le contexte Europe les zooms 0 à 6 (avec repli sur le fond, dont
     l'extraction contient aussi les tuiles basses de l'emprise) ; `topo`
     (carte topographique officielle, tuiles 512 px) et `relief` sont des
     rasters servis tels quels. */
  maplibregl.addProtocol("soest", function (params, controleur) {
    var m = /^soest:\/\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) return Promise.reject(new Error("URL soest:// invalide : " + params.url));
    var nom = m[1], z = +m[2], x = +m[3], y = +m[4];
    var signal = controleur ? controleur.signal : undefined;
    var cle = nom === "fond" && z <= 6 ? "contexte" : nom;
    var promesse = archive(cle).getZxy(z, x, y, signal);
    if (cle === "contexte") {
      promesse = promesse.then(function (r) {
        return r || archive("fond").getZxy(z, x, y, signal);
      }).catch(function (e) {
        if (e && e.name === "AbortError") throw e;
        return archive("fond").getZxy(z, x, y, signal);
      });
    }
    return promesse.then(function (r) {
      // Une tuile raster absente doit être une erreur : avec des octets vides,
      // MapLibre fabrique une image 1 × 1 (et pour le relief, l'ombrage voisin
      // échoue : « dem dimension mismatch »). Une tuile vectorielle vide est normale.
      if (!r && (nom === "relief" || nom === "topo")) throw new Error("tuile absente (" + nom + ")");
      return { data: r ? r.data : new Uint8Array() };
    });
  });

  // ---------- style ----------
  function construireStyle() {
    var flavorNom = themeSombre() ? "dark" : "light";
    var flavor = basemaps.namedFlavor(flavorNom);
    // `lang` inconnu → coalesce(name:xx, name) = nom local tel qu'écrit sur les panneaux
    var couches = basemaps.layers("fond", flavor, { lang: reglages.nomsFrancais ? "fr" : "xx" });

    couches.forEach(function (c) {
      // place=locality : lieux-dits (Flurnamen) sans population, bruit cartographique
      if (c.id === "places_locality") {
        c.filter = ["all", c.filter, ["!=", "kind_detail", "locality"]];
      }
      if (c.id === "pois" && c.filter && c.filter[1] && c.filter[1][2] && c.filter[1][2][0] === "literal") {
        var clause = c.filter[1];
        clause[2] = ["literal", clause[2][1].filter(function (g) { return GENRES_POI_EXCLUS.indexOf(g) === -1; })];
        c.layout = Object.assign({}, c.layout, { visibility: reglages.pois ? "visible" : "none" });
      }
      if (!reglages.nomsFrancais && c.id === "places_country" && c.layout) {
        // en mode « noms locaux », les pays restent en français (France, Allemagne, Suisse)
        c.layout["text-field"] = ["coalesce", ["get", "name:fr"], ["get", "name"]];
      }
    });

    if (reglages.fond === "topo") {
      /* Carte topographique officielle du Land (paquet « topo », tuiles 512 px)
         posée au-dessus du fond vectoriel : opaque, elle le recouvre dans
         l'emprise ; ailleurs et sous le zoom 10, OpenStreetMap reste visible. */
      couches.push({
        id: "topo", type: "raster", source: "topo", minzoom: 10,
        paint: themeSombre()
          ? { "raster-brightness-max": 0.82, "raster-saturation": -0.2, "raster-contrast": 0.05, "raster-fade-duration": 150 }
          : { "raster-fade-duration": 150 }
      });
    }

    couches.push({
      id: "batiments-3d",
      type: "fill-extrusion",
      source: "fond",
      "source-layer": "buildings",
      minzoom: 14,
      layout: { visibility: reglages.troisD ? "visible" : "none" },
      paint: {
        "fill-extrusion-color": flavor.buildings,
        "fill-extrusion-height": ["coalesce", ["get", "height"], 8],
        "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
        "fill-extrusion-opacity": 0.85
      }
    });

    couches.push({
      id: "emprise-contour",
      type: "line",
      source: "emprise",
      paint: {
        "line-color": themeSombre() ? "#9ad9b5" : "#2e7d4f",
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 12, 2.5],
        "line-dasharray": [4, 3],
        "line-opacity": 0.55
      }
    });

    /* Repère de fin du fond : les modules qui veulent passer sous les lieux et
       la position (relief, transports) insèrent leurs couches juste avant lui ;
       les autres s'ajoutent après. Ce calque ne dessine rien. */
    couches.push({ id: "reperes-modules", type: "line", source: "emprise", filter: ["==", ["geometry-type"], "Point"] });

    var sources = {
      fond: {
        type: "vector",
        tiles: ["soest://fond/{z}/{x}/{y}"],
        minzoom: 0,
        maxzoom: 15,
        attribution: "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> · <a href=\"https://protomaps.com\">Protomaps</a>"
      },
      emprise: { type: "geojson", data: geojsonEmprise() }
    };
    if (reglages.fond === "topo") {
      sources.topo = {
        type: "raster", tiles: ["soest://topo/{z}/{x}/{y}"], tileSize: 512, minzoom: 5, maxzoom: 15,
        bounds: emprise ? emprise.bbox : undefined,
        attribution: "Carte topographique © <a href=\"https://www.bezreg-koeln.nrw.de/geobasis-nrw\">Geobasis NRW</a> (dl-de/zero-2.0)"
      };
    }

    return {
      version: 8,
      glyphs: URL_GLYPHES,
      sprite: new URL("assets/sprites/v4/" + flavorNom, location.href).href,
      sources: sources,
      layers: couches
    };
  }

  function geojsonEmprise() {
    if (!emprise) return { type: "FeatureCollection", features: [] };
    return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: emprise.contour } };
  }

  /* Point dans le contour de la carte hors ligne (lancer de rayon). */
  function dansEmprise(lon, lat) {
    if (!emprise) return true;
    var b = emprise.bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return false;
    var c = emprise.contour, dedans = false;
    for (var i = 0, j = c.length - 1; i < c.length; j = i++) {
      var xi = c[i][0], yi = c[i][1], xj = c[j][0], yj = c[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) dedans = !dedans;
    }
    return dedans;
  }

  // ---------- carte ----------
  carte = new maplibregl.Map({
    container: "carte",
    style: construireStyle(),
    center: VUE_INITIALE.center,
    zoom: VUE_INITIALE.zoom,
    minZoom: 3,
    maxZoom: 20,
    maxPitch: 70,
    attributionControl: { compact: true },
    fadeDuration: 150
  });

  carte.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  carte.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-left");

  /* L'attribution compacte s'ouvre dépliée au premier rendu et masque les
     boutons du bas sur téléphone : on la replie après quelques secondes
     (le bouton ⓘ la rouvre à la demande). */
  setTimeout(function () {
    var attrib = document.querySelector(".maplibregl-ctrl-attrib");
    if (attrib) attrib.classList.remove("maplibregl-compact-show");
  }, 5000);

  /* Sans écouteur « error », MapLibre écrit chaque erreur de tuile dans la
     console ; on filtre les absences attendues (relief hors emprise). */
  carte.on("error", function (ev) {
    var message = (ev && ev.error && ev.error.message) || "";
    if (/tuile absente|AbortError/.test(message)) return;
    console.error("MapLibre :", ev.error || ev);
  });

  /* Pictogrammes référencés par le style Protomaps mais absents du jeu de
     sprites officiel (townhall, hospital, station) : substitut transparent. */
  carte.on("styleimagemissing", function (ev) {
    if (!carte.hasImage(ev.id)) carte.addImage(ev.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  /* Les modules posent leurs sources et couches ici : rejoué après chaque
     setStyle (changement de thème, de langue), qui efface tout ce qui n'est
     pas dans le style de base. Les fonctions doivent être idempotentes. */
  carte.on("styledata", function () {
    surStyleFns.forEach(function (fn) { try { fn(carte); } catch (e) { console.error(e); } });
  });

  /* isStyleLoaded() retombe à faux dès qu'une source GeoJSON d'un module se
     charge : le module suivant croirait le style absent et attendrait un
     « styledata » qui ne vient pas. On teste donc la présence des couches,
     signe que le style est analysé et accepte addSource/addLayer. */
  function stylePret() {
    try { var s = carte.getStyle(); return !!(s && s.layers && s.layers.length); } catch (e) { return false; }
  }
  function surStyle(fn) {
    surStyleFns.push(fn);
    if (stylePret()) { try { fn(carte); } catch (e) { console.error(e); } }
  }

  fetch("data/emprise.json").then(function (r) { return r.json(); }).then(function (e) {
    emprise = e;
    var src = carte.getSource("emprise");
    if (src) src.setData(geojsonEmprise());
    // la source topo apprend ses limites : plus de tuiles demandées hors emprise
    if (carte.getSource("topo") && carte.getSource("topo").setTiles) carte.getSource("topo").setTiles(["soest://topo/{z}/{x}/{y}"]);
  }).catch(function () { /* sans emprise, pas de contour : l'app marche quand même */ });

  // ---------- déplacements et marqueur de résultat ----------
  function allerA(lon, lat, zoom) {
    carte.flyTo({ center: [lon, lat], zoom: zoom || Math.max(carte.getZoom(), 15), duration: 900 });
  }

  function marquer(lon, lat) {
    if (marqueur) marqueur.remove();
    if (lon === undefined) { marqueur = null; return; }
    marqueur = new maplibregl.Marker({ color: "#2e7d4f" }).setLngLat([lon, lat]).addTo(carte);
  }

  // ---------- réglages (panneau) ----------
  function ouvrirReglages() {
    var corps = Panneau.ouvrir("Réglages", "", "reglages");
    var el = Panneau.element, inter = Panneau.interrupteur;

    corps.appendChild(el("h3", "", "Fond de carte"));
    corps.appendChild(Panneau.choix([["topo", "Topographique officielle"], ["osm", "OpenStreetMap"]], reglages.fond,
      function (v) { definirReglage("fond", v); },
      "La carte du Land (DTK10/25/50, Geobasis NRW) s'affiche à partir du zoom 10 et reste nette jusqu'au 1:10 000 ; " +
      "OpenStreetMap prend le relais en dessous et hors de l'emprise. Hors ligne, installez le paquet « Carte topographique »."));

    corps.appendChild(el("h3", "", "Affichage"));
    corps.appendChild(inter("Thème sombre", themeSombre(), function (v) { definirReglage("theme", v ? "sombre" : "clair"); },
      "La carte topographique est légèrement assombrie ; le fond OpenStreetMap passe en sombre."));
    corps.appendChild(inter("Noms de lieux en français", reglages.nomsFrancais, function (v) { definirReglage("nomsFrancais", v); },
      "Pour le dézoom (Cologne, Munich…) : autour de Soest, les noms sont les mêmes dans les deux cas."));
    corps.appendChild(inter("Commerces et services", reglages.pois, function (v) { definirReglage("pois", v); },
      "Restaurants, cafés, boutiques, pharmacies… du fond OpenStreetMap."));
    if (window.Sites) {
      corps.appendChild(inter("Lieux et services publics", reglages.sites, function (v) { definirReglage("sites", v); },
        "Musées, églises, châteaux, parcs, mairies, bibliothèques, piscines, hôpitaux, pharmacies… cliquables : descriptif, horaires, téléphone, site, photo."));
    }
    if (window.Transports) {
      corps.appendChild(inter("Arrêts et lignes de transport", reglages.transports, function (v) { definirReglage("transports", v); },
        "Gare, haltes, arrêts de bus et tracés des lignes (OpenStreetMap), avec les lignes desservant chaque arrêt."));
    }
    corps.appendChild(inter("Bâtiments en relief (3D)", reglages.troisD, function (v) { definirReglage("troisD", v); }));
    if (window.Adresses) {
      corps.appendChild(inter("Numéros de maison", reglages.numeros, function (v) { definirReglage("numeros", v); },
        "À fort zoom, si le paquet « Adresses » est installé."));
      corps.appendChild(inter("Recherche en ligne de secours", reglages.enLigne, function (v) { definirReglage("enLigne", v); },
        "Interroge photon.komoot.io (OpenStreetMap) quand le réseau est là : commerces, lieux-dits, adresses hors paquet."));
    }
    if (window.Relief) {
      corps.appendChild(el("h3", "", "Relief"));
      corps.appendChild(inter("Ombrage du relief", reglages.relief, function (v) { definirReglage("relief", v); },
        "Paquet « Relief » installé, ou réseau disponible."));
      corps.appendChild(inter("Courbes de niveau", reglages.courbes, function (v) { definirReglage("courbes", v); },
        "Tous les 20 m, 10 m à fort zoom ; calculées sur l'appareil. La carte topographique officielle a déjà les siennes."));
      corps.appendChild(inter("Terrain en 3D", reglages.terrain3D, function (v) { definirReglage("terrain3D", v); },
        "Vue inclinée sur le vrai relief (Haarstrang, Arnsberger Wald, vallée de la Möhne)."));
    }

    corps.appendChild(el("h3", "", "Données"));
    var infos = el("p", "note", "Chargement…");
    corps.appendChild(infos);
    Stockage.version().then(function (v) {
      var f = v.paquets.fond || {}, t = v.paquets.topo;
      infos.textContent = "Fond OpenStreetMap du " + (f.osm || "?") + " (" + (f.source || "") + "), " +
        "zoom " + (f.zoom_min || 0) + " à " + (f.zoom_max || 15) + ", " + Math.round((f.taille || 0) / 1e6) + " Mo. " +
        (t ? "Carte topographique DTK (Geobasis NRW) récupérée le " + (t.osm || "?") + ", " + Math.round((t.taille || 0) / 1e6) + " Mo. " : "") +
        "Version de l'application : " + (v.build || "?") + ".";
    }).catch(function () { infos.textContent = "Version des données inconnue (hors ligne ?)."; });
    var actionsDonnees = el("div", "actions");
    actionsDonnees.appendChild(Panneau.bouton("Gérer les cartes hors ligne", function () { Pwa.ouvrirPanneau(); }, "secondaire"));
    if (window.MiseAJour) {
      actionsDonnees.appendChild(Panneau.bouton("Rechercher une mise à jour", function () {
        MiseAJour.verifier(true).then(function (r) {
          Panneau.message({ prete: "Nouvelle version prête : voir le bandeau en haut", "en-cours": "Téléchargement de la nouvelle version…",
                            "a-jour": "L'application est à jour", echec: "Vérification impossible (hors ligne ?)",
                            "sans-service-worker": "Pas de service worker ici", "trop-tot": "Déjà vérifié à l'instant" }[r] || r);
        });
      }, "secondaire"));
    }
    corps.appendChild(actionsDonnees);
    corps.appendChild(el("p", "note", "Fond © les contributeurs OpenStreetMap (ODbL) via Protomaps ; carte topographique © Geobasis NRW (Datenlizenz Deutschland – Zero 2.0). Tout reste sur votre appareil : aucun compte, aucun envoi."));
  }

  document.getElementById("chip-reglages").addEventListener("click", ouvrirReglages);
  document.getElementById("btn-theme").addEventListener("click", function () {
    definirReglage("theme", themeSombre() ? "clair" : "sombre");
    if (Panneau.estOuvert("reglages")) ouvrirReglages();
  });

  // ---------- bouton de fond (en-tête) ----------
  var boutonFond = document.getElementById("btn-fond");
  function majBoutonFond() {
    if (!boutonFond) return;
    var topo = reglages.fond === "topo";
    boutonFond.textContent = topo ? "Topo" : "OSM";
    boutonFond.setAttribute("aria-pressed", topo ? "true" : "false");
    boutonFond.title = topo ? "Fond : carte topographique officielle (cliquer pour OpenStreetMap)" : "Fond : OpenStreetMap (cliquer pour la carte topographique)";
  }
  if (boutonFond) {
    boutonFond.addEventListener("click", function () {
      definirReglage("fond", reglages.fond === "topo" ? "osm" : "topo");
      if (Panneau.estOuvert("reglages")) ouvrirReglages();
    });
    majBoutonFond();
  }

  return {
    instance: function () { return carte; },
    archive: archive,
    reglage: reglage,
    definirReglage: definirReglage,
    themeSombre: themeSombre,
    fondTopo: function () { return reglages.fond === "topo"; },
    surStyle: surStyle,
    allerA: allerA,
    marquer: marquer,
    dansEmprise: dansEmprise,
    emprise: function () { return emprise; },
    ouvrirReglages: ouvrirReglages
  };
})();
