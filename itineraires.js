"use strict";
/* Itinéraires : calcul en ligne (Valhalla public de FOSSGIS, repli OSRM pour la
 * voiture), affichage, suivi guidé pas à pas, et mémorisation sur l'appareil
 * pour les rejouer sans réseau. Les points de départ et d'arrivée viennent de
 * la position, d'un lieu enregistré, d'une adresse, ou d'un clic sur la carte. */
var Itineraires = (function () {
  var carte = Carte.instance();
  var VALHALLA = "https://valhalla1.openstreetmap.de/route";
  var OSRM = "https://router.project-osrm.org/route/v1/driving/";
  var MODES = [["auto", "Voiture", "🚗"], ["bicycle", "Vélo", "🚲"], ["pedestrian", "À pied", "🚶"]];
  var BASE = "soest-itineraires", STORE = "itineraires";
  var baseOuverte = null;
  var depart = null, arrivee = null;      // { lon, lat, nom }
  var mode = localStorage.getItem("soest.modeItineraire") || "auto";
  var courant = null;                     // itinéraire affiché
  var suivi = null;                       // { itineraire, prochaineEtape }
  var choixEnCours = null;                // "depart" | "arrivee" quand on attend un clic carte
  var controleur = null;

  // ---------- IndexedDB ----------
  function ouvrirBase() {
    if (baseOuverte) return baseOuverte;
    baseOuverte = new Promise(function (resolve, reject) {
      var req = indexedDB.open(BASE, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return baseOuverte;
  }
  function magasin(m) { return ouvrirBase().then(function (db) { return db.transaction(STORE, m).objectStore(STORE); }); }
  function attendre(req) { return new Promise(function (res, rej) { req.onsuccess = function () { res(req.result); }; req.onerror = function () { rej(req.error); }; }); }
  function tous() { return magasin("readonly").then(function (m) { return attendre(m.getAll()); }); }

  // ---------- géométrie ----------
  function decoderPolyligne(s, precision) {
    var facteur = Math.pow(10, precision || 6), pts = [], i = 0, lat = 0, lon = 0;
    while (i < s.length) {
      var b, shift = 0, result = 0;
      do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lon += (result & 1) ? ~(result >> 1) : (result >> 1);
      pts.push([lon / facteur, lat / facteur]);
    }
    return pts;
  }
  function longueur(pts) {
    var d = 0;
    for (var i = 1; i < pts.length; i++) d += Navigation.distance(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    return d;
  }

  // ---------- calcul ----------
  function calculer() {
    if (!depart || !arrivee) return Promise.reject(new Error("départ et arrivée nécessaires"));
    if (!navigator.onLine) return Promise.reject(new Error("pas de réseau : seuls les itinéraires enregistrés sont disponibles"));
    if (controleur) controleur.abort();
    controleur = new AbortController();
    var signal = controleur.signal;
    return viaValhalla(signal).catch(function (e) {
      if (e.name === "AbortError") throw e;
      if (mode !== "auto") throw e;
      return viaOsrm(signal);
    });
  }

  function viaValhalla(signal) {
    var corps = {
      locations: [{ lat: depart.lat, lon: depart.lon }, { lat: arrivee.lat, lon: arrivee.lon }],
      costing: mode, directions_options: { units: "kilometers", language: "fr-FR" }, id: "soest"
    };
    return fetch(VALHALLA, { method: "POST", body: JSON.stringify(corps), headers: { "Content-Type": "application/json" }, signal: signal })
      .then(function (r) { if (!r.ok) throw new Error("Valhalla HTTP " + r.status); return r.json(); })
      .then(function (j) {
        var leg = j.trip && j.trip.legs && j.trip.legs[0];
        if (!leg) throw new Error("réponse Valhalla sans tronçon");
        var pts = decoderPolyligne(leg.shape, 6);
        var etapes = (leg.maneuvers || []).map(function (m) {
          var p = pts[Math.min(m.begin_shape_index || 0, pts.length - 1)];
          return { instruction: m.instruction || "", distance: Math.round((m.length || 0) * 1000), duree: Math.round(m.time || 0),
                   lon: p[0], lat: p[1], type: m.type, rue: (m.street_names || [])[0] || "" };
        });
        return { mode: mode, distance: Math.round(leg.summary.length * 1000), duree: Math.round(leg.summary.time), geometrie: pts, etapes: etapes, moteur: "Valhalla" };
      });
  }

  function viaOsrm(signal) {
    var url = OSRM + depart.lon + "," + depart.lat + ";" + arrivee.lon + "," + arrivee.lat + "?overview=full&geometries=polyline&steps=true";
    return fetch(url, { signal: signal }).then(function (r) { if (!r.ok) throw new Error("OSRM HTTP " + r.status); return r.json(); })
      .then(function (j) {
        var route = j.routes && j.routes[0];
        if (!route) throw new Error("aucun itinéraire");
        var pts = decoderPolyligne(route.geometry, 5);
        var etapes = [];
        (route.legs || []).forEach(function (leg) {
          (leg.steps || []).forEach(function (s) {
            etapes.push({ instruction: phraseOsrm(s), distance: Math.round(s.distance), duree: Math.round(s.duration),
                          lon: s.maneuver.location[0], lat: s.maneuver.location[1], type: s.maneuver.type, rue: s.name || "" });
          });
        });
        return { mode: "auto", distance: Math.round(route.distance), duree: Math.round(route.duration), geometrie: pts, etapes: etapes, moteur: "OSRM" };
      });
  }
  function phraseOsrm(s) {
    var m = s.maneuver, rue = s.name ? " sur " + s.name : "";
    var dir = { left: "à gauche", right: "à droite", "slight left": "légèrement à gauche", "slight right": "légèrement à droite",
                "sharp left": "franchement à gauche", "sharp right": "franchement à droite", straight: "tout droit", uturn: "demi-tour" }[m.modifier] || "";
    switch (m.type) {
      case "depart": return "Départ" + rue;
      case "arrive": return "Arrivée";
      case "roundabout": case "rotary": return "Au rond-point, prendre la sortie " + (m.exit || "") + rue;
      case "merge": return "S'insérer" + rue;
      case "on ramp": return "Prendre la bretelle" + rue;
      case "off ramp": return "Prendre la sortie" + rue;
      case "fork": return "À l'embranchement, rester " + dir + rue;
      case "end of road": return "Au bout de la route, tourner " + dir + rue;
      case "continue": return "Continuer " + dir + rue;
      default: return "Tourner " + dir + rue;
    }
  }

  // ---------- couches ----------
  function poserCouches(m) {
    if (m.getSource("itineraire")) return;
    m.addSource("itineraire", { type: "geojson", data: geojsonItineraire() });
    var avant = m.getLayer("lieux-halo") ? "lieux-halo" : undefined;
    m.addLayer({ id: "itineraire-bord", type: "line", source: "itineraire", filter: ["==", "$type", "LineString"],
                 layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 } }, avant);
    m.addLayer({ id: "itineraire-ligne", type: "line", source: "itineraire", filter: ["==", "$type", "LineString"],
                 layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#2563eb", "line-width": 5.5 } }, avant);
    m.addLayer({ id: "itineraire-etapes", type: "circle", source: "itineraire", filter: ["==", "$type", "Point"], minzoom: 12,
                 paint: { "circle-radius": ["case", ["get", "extremite"], 8, 4], "circle-color": ["case", ["get", "extremite"], "#2563eb", "#ffffff"],
                          "circle-stroke-color": ["case", ["get", "extremite"], "#ffffff", "#2563eb"], "circle-stroke-width": 2 } }, avant);
  }
  Carte.surStyle(poserCouches);
  function geojsonItineraire() {
    var feats = [];
    if (courant) {
      feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: courant.geometrie } });
      courant.etapes.forEach(function (e, i) {
        feats.push({ type: "Feature", properties: { extremite: i === 0 || i === courant.etapes.length - 1, i: i }, geometry: { type: "Point", coordinates: [e.lon, e.lat] } });
      });
    }
    return { type: "FeatureCollection", features: feats };
  }
  function redessiner() { var s = carte.getSource("itineraire"); if (s) s.setData(geojsonItineraire()); }
  function afficher(it, cadrer) {
    courant = it;
    redessiner();
    if (cadrer && it) {
      var lons = it.geometrie.map(function (p) { return p[0]; }), lats = it.geometrie.map(function (p) { return p[1]; });
      carte.fitBounds([[Math.min.apply(null, lons), Math.min.apply(null, lats)], [Math.max.apply(null, lons), Math.max.apply(null, lats)]],
                      { padding: { top: 90, bottom: 90, left: 40, right: window.innerWidth > 640 ? 460 : 40 }, duration: 900, maxZoom: 16 });
    }
  }
  function effacer() { courant = null; arreterSuivi(); redessiner(); }

  // ---------- suivi guidé ----------
  var hud = document.getElementById("hud"), hudFleche = document.getElementById("hud-fleche"), hudDistance = document.getElementById("hud-distance"),
      hudNom = document.getElementById("hud-nom"), hudDetail = document.getElementById("hud-detail");
  function suivre(it) {
    Navigation.cibler(null);
    afficher(it, false);
    suivi = { itineraire: it, prochaine: 1 };
    Panneau.fermer();
    if (Navigation.mode() === "inactif" || Navigation.mode() === "actif") Navigation.definirMode("cap");
    hud.hidden = false;
    hudFleche.style.transform = "";
    majHud();
  }
  function arreterSuivi() {
    if (!suivi) return;
    suivi = null;
    hud.hidden = true;
    if (Navigation.mode() === "cap") Navigation.definirMode("actif");
  }
  document.getElementById("hud-stop").addEventListener("click", arreterSuivi);

  function projeter(p, it) {
    // point le plus proche sur la polyligne : index du segment et distance restante
    var g = it.geometrie, meilleur = 0, dmin = Infinity;
    for (var i = 0; i < g.length; i++) {
      var d = Navigation.distance(p.lon, p.lat, g[i][0], g[i][1]);
      if (d < dmin) { dmin = d; meilleur = i; }
    }
    var restant = 0;
    for (var k = meilleur + 1; k < g.length; k++) restant += Navigation.distance(g[k - 1][0], g[k - 1][1], g[k][0], g[k][1]);
    return { index: meilleur, ecart: dmin, restant: restant + dmin };
  }
  function majHud() {
    if (!suivi) return;
    var it = suivi.itineraire, p = Navigation.position();
    hudNom.textContent = (arrivee && arrivee.nom) || it.nomArrivee || "Destination";
    if (!p) { hudDistance.textContent = Navigation.distanceTexte(it.distance); hudDetail.textContent = "en attente de la position"; return; }
    var proj = projeter(p, it);
    // prochaine étape : première manœuvre située après la position projetée
    var prochaine = null, dProchaine = 0;
    for (var i = 1; i < it.etapes.length; i++) {
      var e = it.etapes[i];
      var idx = indexEtape(it, e);
      if (idx > proj.index || (idx === proj.index && Navigation.distance(p.lon, p.lat, e.lon, e.lat) > 15)) {
        prochaine = e;
        dProchaine = Navigation.distance(p.lon, p.lat, e.lon, e.lat);
        break;
      }
    }
    if (proj.ecart > 120) {
      hudDistance.textContent = Navigation.distanceTexte(proj.ecart);
      hudDetail.textContent = "hors itinéraire : rejoignez le tracé" + (navigator.onLine ? " (recalcul : bouton Itinéraire)" : "");
      var az = Navigation.azimut(p.lon, p.lat, it.geometrie[proj.index][0], it.geometrie[proj.index][1]);
      var cap = Navigation.capCourant();
      hudFleche.style.transform = "rotate(" + (cap !== null ? az - cap : az - carte.getBearing()) + "deg)";
      return;
    }
    if (prochaine) {
      hudDistance.textContent = Navigation.distanceTexte(dProchaine);
      hudNom.textContent = prochaine.instruction;
      hudDetail.textContent = "reste " + Navigation.distanceTexte(proj.restant) + (p.vitesse > 0.5 ? " · ≈ " + Navigation.dureeTexte(proj.restant / Math.max(p.vitesse, 0.5)) : " · ≈ " + Navigation.dureeTexte(it.duree * proj.restant / Math.max(it.distance, 1)));
      var az2 = Navigation.azimut(p.lon, p.lat, prochaine.lon, prochaine.lat);
      var cap2 = Navigation.capCourant();
      hudFleche.style.transform = "rotate(" + (cap2 !== null ? az2 - cap2 : az2 - carte.getBearing()) + "deg)";
    } else {
      hudDistance.textContent = Navigation.distanceTexte(proj.restant);
      hudDetail.textContent = proj.restant < 30 ? "Vous êtes arrivé" : "vers l'arrivée";
    }
  }
  function indexEtape(it, e) {
    if (e._idx !== undefined) return e._idx;
    var g = it.geometrie, meilleur = 0, dmin = Infinity;
    for (var i = 0; i < g.length; i++) { var d = Math.abs(g[i][0] - e.lon) + Math.abs(g[i][1] - e.lat); if (d < dmin) { dmin = d; meilleur = i; } }
    e._idx = meilleur;
    return meilleur;
  }
  Navigation.surPosition(function () { if (suivi) majHud(); });
  carte.on("rotate", function () { if (suivi && Navigation.capCourant() === null) majHud(); });

  // ---------- choix d'un point sur la carte ----------
  carte.on("click", function (ev) {
    if (!choixEnCours) return;
    var quoi = choixEnCours;
    choixEnCours = null;
    carte.getCanvas().style.cursor = "";
    var point = { lon: ev.lngLat.lng, lat: ev.lngLat.lat, nom: Recherche.formaterCoordonnees(ev.lngLat.lat, ev.lngLat.lng) };
    if (window.Adresses) {
      Adresses.inverse(point.lon, point.lat, 80).then(function (r) { if (r) point.nom = r.libelle; definirPoint(quoi, point); ouvrirPanneau(); });
    } else { definirPoint(quoi, point); ouvrirPanneau(); }
  });
  function definirPoint(quoi, point) { if (quoi === "depart") depart = point; else arrivee = point; }

  // ---------- panneau ----------
  function ouvrirPanneau() {
    var corps = Panneau.ouvrir("Itinéraire", "", "itineraire");
    var el = Panneau.element;

    function ligneDe(quoi, libelle) {
      var point = quoi === "depart" ? depart : arrivee;
      var bloc = el("div", "champ");
      bloc.appendChild(el("span", "", libelle));
      var champ = document.createElement("input");
      champ.type = "search"; champ.autocomplete = "off"; champ.placeholder = "Adresse, lieu, coordonnées…";
      champ.value = point ? point.nom : "";
      bloc.appendChild(champ);
      var suggestions = el("ul", "liste suggestions");
      suggestions.hidden = true;
      bloc.appendChild(suggestions);
      var minuterie = null;
      champ.addEventListener("input", function () {
        clearTimeout(minuterie);
        minuterie = setTimeout(function () {
          var q = champ.value.trim();
          if (q.length < 2) { suggestions.hidden = true; return; }
          Recherche.chercher(q, 6).then(function (res) {
            suggestions.textContent = "";
            res.forEach(function (r) {
              var li = el("li", "");
              var t = el("div", "texte"); t.appendChild(el("div", "", r.libelle)); if (r.detail) t.appendChild(el("small", "", r.detail));
              li.appendChild(t);
              li.addEventListener("mousedown", function (ev) { ev.preventDefault(); definirPoint(quoi, { lon: r.lon, lat: r.lat, nom: r.libelle }); champ.value = r.libelle; suggestions.hidden = true; });
              suggestions.appendChild(li);
            });
            suggestions.hidden = res.length === 0;
          });
        }, 150);
      });
      champ.addEventListener("blur", function () { setTimeout(function () { suggestions.hidden = true; }, 150); });
      var actions = el("div", "actions");
      actions.appendChild(Panneau.bouton("Ma position", function () {
        Navigation.positionActuelle().then(function (p) { definirPoint(quoi, { lon: p.lon, lat: p.lat, nom: "Ma position" }); champ.value = "Ma position"; })
          .catch(function (e) { Panneau.message("Position indisponible : " + e.message); });
      }, "secondaire"));
      actions.appendChild(Panneau.bouton("Sur la carte", function () {
        choixEnCours = quoi; Panneau.fermer(); carte.getCanvas().style.cursor = "crosshair";
        Panneau.message("Touchez la carte pour choisir " + (quoi === "depart" ? "le départ" : "l'arrivée"), 5000);
      }, "secondaire"));
      if (window.Lieux) {
        actions.appendChild(Panneau.bouton("Un de mes lieux", function () {
          Lieux.tous().then(function (liste) {
            suggestions.textContent = "";
            liste.forEach(function (l) {
              var li = el("li", "");
              var t = el("div", "texte"); t.appendChild(el("div", "", l.nom)); if (l.adresse) t.appendChild(el("small", "", l.adresse));
              li.appendChild(t);
              li.addEventListener("mousedown", function (ev) { ev.preventDefault(); definirPoint(quoi, { lon: l.lon, lat: l.lat, nom: l.nom }); champ.value = l.nom; suggestions.hidden = true; });
              suggestions.appendChild(li);
            });
            suggestions.hidden = liste.length === 0;
            if (!liste.length) Panneau.message("Aucun lieu enregistré");
          });
        }, "secondaire"));
      }
      bloc.appendChild(actions);
      return bloc;
    }
    corps.appendChild(ligneDe("depart", "Départ"));
    corps.appendChild(ligneDe("arrivee", "Arrivée"));

    var modes = el("div", "actions modes");
    MODES.forEach(function (m) {
      var b = Panneau.bouton(m[2] + " " + m[1], function () {
        mode = m[0]; localStorage.setItem("soest.modeItineraire", mode);
        Array.prototype.forEach.call(modes.children, function (x) { x.classList.toggle("primaire", x.dataset.mode === mode); });
      }, m[0] === mode ? "primaire" : "secondaire");
      b.dataset.mode = m[0];
      modes.appendChild(b);
    });
    corps.appendChild(modes);

    var actions = el("div", "actions");
    var etat = el("p", "note", "");
    actions.appendChild(Panneau.bouton("Calculer l'itinéraire", function () {
      etat.textContent = "Calcul en cours…";
      calculer().then(function (it) {
        it.nomDepart = depart.nom; it.nomArrivee = arrivee.nom;
        afficher(it, true);
        etat.textContent = "";
        afficherResultat(corps, it, resultat);
      }).catch(function (e) { if (e.name !== "AbortError") etat.textContent = "Impossible de calculer : " + e.message; });
    }, "primaire"));
    actions.appendChild(Panneau.bouton("Inverser", function () { var t = depart; depart = arrivee; arrivee = t; ouvrirPanneau(); }));
    if (arrivee) actions.appendChild(Panneau.bouton("À vol d'oiseau", function () { Navigation.cibler(arrivee); }));
    if (courant) actions.appendChild(Panneau.bouton("Effacer le tracé", function () { effacer(); ouvrirPanneau(); }));
    corps.appendChild(actions);
    corps.appendChild(etat);
    var resultat = el("div", "resultat");
    corps.appendChild(resultat);
    if (courant) afficherResultat(corps, courant, resultat);

    corps.appendChild(el("h3", "", "Itinéraires enregistrés"));
    var ul = el("ul", "liste");
    corps.appendChild(ul);
    tous().then(function (liste) {
      if (!liste.length) { var v = el("li", "", "Aucun. Un itinéraire enregistré reste consultable et suivable sans réseau."); v.style.cursor = "default"; ul.appendChild(v); return; }
      liste.sort(function (a, b) { return b.date - a.date; }).forEach(function (it) {
        var li = document.createElement("li");
        var t = el("div", "texte");
        t.appendChild(el("div", "", it.nom));
        t.appendChild(el("small", "", libelleMode(it.mode) + " · " + Navigation.distanceTexte(it.distance) + " · " + Navigation.dureeTexte(it.duree)));
        li.appendChild(t);
        var suppr = Panneau.bouton("✕", function (ev) { ev.stopPropagation(); if (confirm("Supprimer cet itinéraire ?")) magasin("readwrite").then(function (m) { return attendre(m.delete(it.id)); }).then(function () { li.remove(); }); }, "danger");
        var s = el("span", ""); s.appendChild(suppr); li.appendChild(s);
        li.addEventListener("click", function () {
          depart = it.depart; arrivee = it.arrivee; mode = it.mode;
          afficher(it, true);
          ouvrirPanneau();
        });
        ul.appendChild(li);
      });
    });
    corps.appendChild(el("p", "note", "Calcul par les serveurs publics Valhalla (FOSSGIS) ou OSRM, données OpenStreetMap. Réseau nécessaire pour calculer ; pas pour suivre un itinéraire enregistré."));
  }

  function libelleMode(m) { for (var i = 0; i < MODES.length; i++) if (MODES[i][0] === m) return MODES[i][1]; return m; }

  function afficherResultat(corps, it, conteneur) {
    var el = Panneau.element;
    conteneur.textContent = "";
    conteneur.appendChild(el("p", "", libelleMode(it.mode) + " : " + Navigation.distanceTexte(it.distance) + ", environ " + Navigation.dureeTexte(it.duree) + (it.moteur ? " (" + it.moteur + ")" : "")));
    var actions = el("div", "actions");
    actions.appendChild(Panneau.bouton("Suivre cet itinéraire", function () { suivre(it); }, "primaire"));
    if (!it.id) {
      actions.appendChild(Panneau.bouton("Enregistrer pour le hors ligne", function () {
        var copie = { nom: (it.nomDepart || "Départ") + " → " + (it.nomArrivee || "Arrivée"), mode: it.mode, distance: it.distance, duree: it.duree,
                      geometrie: it.geometrie, etapes: it.etapes.map(function (e) { return { instruction: e.instruction, distance: e.distance, duree: e.duree, lon: e.lon, lat: e.lat, rue: e.rue }; }),
                      depart: depart, arrivee: arrivee, date: Date.now(), moteur: it.moteur };
        magasin("readwrite").then(function (m) { return attendre(m.add(copie)); }).then(function (id) { it.id = id; Panneau.message("Itinéraire enregistré"); ouvrirPanneau(); });
      }));
    }
    actions.appendChild(Panneau.bouton("Exporter en GPX", function () {
      var g = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Soest" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>' +
        String((it.nomDepart || "") + " - " + (it.nomArrivee || "")).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</name><trkseg>\n" +
        it.geometrie.map(function (p) { return '<trkpt lat="' + p[1].toFixed(6) + '" lon="' + p[0].toFixed(6) + '"></trkpt>'; }).join("\n") + "\n</trkseg></trk>\n</gpx>\n";
      var url = URL.createObjectURL(new Blob([g], { type: "application/gpx+xml" }));
      var a = document.createElement("a"); a.href = url; a.download = "itineraire.gpx"; document.body.appendChild(a); a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 2000);
    }));
    conteneur.appendChild(actions);
    var ol = el("ol", "etapes");
    it.etapes.forEach(function (e) {
      var li = el("li", "", "");
      li.appendChild(el("div", "", e.instruction));
      if (e.distance) li.appendChild(el("small", "", Navigation.distanceTexte(e.distance)));
      li.addEventListener("click", function () { Carte.allerA(e.lon, e.lat, 16.5); });
      ol.appendChild(li);
    });
    conteneur.appendChild(ol);
  }

  /* Ouvre le panneau avec l'arrivée préremplie (bouton « Y aller » des lieux). */
  function vers(lieu) {
    arrivee = { lon: lieu.lon, lat: lieu.lat, nom: lieu.nom || Recherche.formaterCoordonnees(lieu.lat, lieu.lon) };
    var p = Navigation.position();
    if (p && !depart) depart = { lon: p.lon, lat: p.lat, nom: "Ma position" };
    ouvrirPanneau();
    if (!depart) {
      Navigation.positionActuelle().then(function (pos) { depart = { lon: pos.lon, lat: pos.lat, nom: "Ma position" }; if (Panneau.estOuvert("itineraire")) ouvrirPanneau(); }).catch(function () {});
    }
  }

  var chip = document.getElementById("chip-itineraire");
  chip.hidden = false;
  chip.addEventListener("click", ouvrirPanneau);

  return { ouvrirPanneau: ouvrirPanneau, vers: vers, suivre: suivre, afficher: afficher, effacer: effacer, calculer: calculer, courant: function () { return courant; } };
})();
