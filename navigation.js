"use strict";
/* Navigation : position GPS, cap (boussole), suivi, guidage à vol d'oiseau
 * vers un lieu (distance + flèche), enregistrement de traces (GPX).
 * Les itinéraires calculés (voiture, vélo, piéton) sont dans itineraires.js.
 * Tout se passe sur l'appareil : la position n'est envoyée nulle part. */
var Navigation = (function () {
  var carte = Carte.instance();
  var MODES = ["inactif", "actif", "centre", "cap"]; // bouton position : cycle
  var mode = "inactif";
  var surveillance = null;         // id de watchPosition
  var position = null;             // { lon, lat, precision, cap, vitesse, altitude, horodatage }
  var capBoussole = null;          // degrés, 0 = nord, sens horaire
  var ecouteBoussole = false;
  var cible = null;                // { lon, lat, nom }
  var ecouteursPosition = [];
  var verrouEcran = null;
  var BASE = "soest-traces", STORE = "traces";
  var baseOuverte = null;
  var traceEnCours = null;         // { debut, points: [[lon, lat, alt, t]], distance }
  var tracesAffichees = {};        // id -> true

  // ---------- géométrie ----------
  function distance(lon1, lat1, lon2, lat2) {
    var R = 6371000, r = Math.PI / 180;
    var dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function azimut(lon1, lat1, lon2, lat2) {
    var r = Math.PI / 180;
    var y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
    var x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
    return ((Math.atan2(y, x) / r) + 360) % 360;
  }
  function cercle(lon, lat, rayon) {
    var pts = [], n = 48;
    var dLat = rayon / 111320, dLon = rayon / (111320 * Math.cos(lat * Math.PI / 180));
    for (var i = 0; i <= n; i++) {
      var a = (i / n) * 2 * Math.PI;
      pts.push([lon + Math.cos(a) * dLon, lat + Math.sin(a) * dLat]);
    }
    return pts;
  }
  function distanceTexte(m) {
    return m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(m < 10000 ? 1 : 0).replace(".", ",") + " km";
  }
  function dureeTexte(s) {
    s = Math.round(s);
    var h = Math.floor(s / 3600), mn = Math.floor((s % 3600) / 60);
    return h ? h + " h " + String(mn).padStart(2, "0") : mn + " min";
  }

  // ---------- couches ----------
  function imageFleche(m) {
    if (m.hasImage("cap-cone")) return;
    var t = 64, c = document.createElement("canvas");
    c.width = t; c.height = t;
    var g = c.getContext("2d");
    var grad = g.createRadialGradient(t / 2, t / 2, 2, t / 2, t / 2, t / 2);
    grad.addColorStop(0, "rgba(14,116,144,0.55)");
    grad.addColorStop(1, "rgba(14,116,144,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(t / 2, t / 2);
    g.arc(t / 2, t / 2, t / 2, (-90 - 30) * Math.PI / 180, (-90 + 30) * Math.PI / 180);
    g.closePath();
    g.fill();
    m.addImage("cap-cone", g.getImageData(0, 0, t, t), { pixelRatio: 2 });
  }

  function poserCouches(m) {
    imageFleche(m);
    if (m.getSource("position")) return;
    m.addSource("position", { type: "geojson", data: geojsonPosition() });
    m.addSource("cible", { type: "geojson", data: geojsonCible() });
    m.addSource("traces", { type: "geojson", data: geojsonTraces() });
    m.addLayer({ id: "traces-ligne", type: "line", source: "traces", layout: { "line-cap": "round", "line-join": "round" },
                 paint: { "line-color": ["coalesce", ["get", "couleur"], "#ea580c"], "line-width": 4, "line-opacity": 0.85 } });
    m.addLayer({ id: "cible-ligne", type: "line", source: "cible", filter: ["==", "$type", "LineString"],
                 paint: { "line-color": "#ea580c", "line-width": 2.5, "line-dasharray": [2, 2], "line-opacity": 0.8 } });
    m.addLayer({ id: "cible-point", type: "circle", source: "cible", filter: ["==", "$type", "Point"],
                 paint: { "circle-radius": 9, "circle-color": "#ea580c", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
    m.addLayer({ id: "position-precision", type: "fill", source: "position", filter: ["==", "$type", "Polygon"],
                 paint: { "fill-color": "#2e7d4f", "fill-opacity": 0.12 } });
    m.addLayer({ id: "position-cap", type: "symbol", source: "position", filter: ["all", ["==", "$type", "Point"], ["has", "cap"]],
                 layout: { "icon-image": "cap-cone", "icon-size": 1.6, "icon-rotate": ["get", "cap"], "icon-rotation-alignment": "map",
                           "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-anchor": "center" } });
    m.addLayer({ id: "position-point", type: "circle", source: "position", filter: ["==", "$type", "Point"],
                 paint: { "circle-radius": 7, "circle-color": "#2e7d4f", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
  }
  Carte.surStyle(poserCouches);

  function geojsonPosition() {
    if (!position) return { type: "FeatureCollection", features: [] };
    var cap = capCourant();
    var props = {};
    if (cap !== null) props.cap = cap;
    var feats = [{ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [position.lon, position.lat] } }];
    if (position.precision && position.precision > 15) {
      feats.unshift({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [cercle(position.lon, position.lat, position.precision)] } });
    }
    return { type: "FeatureCollection", features: feats };
  }
  function geojsonCible() {
    var feats = [];
    if (cible) {
      feats.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [cible.lon, cible.lat] } });
      if (position) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[position.lon, position.lat], [cible.lon, cible.lat]] } });
    }
    return { type: "FeatureCollection", features: feats };
  }
  function geojsonTraces() {
    var feats = [];
    if (traceEnCours && traceEnCours.points.length > 1) {
      feats.push({ type: "Feature", properties: { couleur: "#ea580c" }, geometry: { type: "LineString", coordinates: traceEnCours.points.map(function (p) { return [p[0], p[1]]; }) } });
    }
    Object.keys(tracesAffichees).forEach(function (id) {
      var t = tracesAffichees[id];
      if (t && t.points && t.points.length > 1) {
        feats.push({ type: "Feature", properties: { couleur: "#7c3aed" }, geometry: { type: "LineString", coordinates: t.points.map(function (p) { return [p[0], p[1]]; }) } });
      }
    });
    return { type: "FeatureCollection", features: feats };
  }
  function rafraichirCouches() {
    var s;
    if ((s = carte.getSource("position"))) s.setData(geojsonPosition());
    if ((s = carte.getSource("cible"))) s.setData(geojsonCible());
  }

  // ---------- cap ----------
  function capCourant() {
    if (capBoussole !== null) return capBoussole;
    if (position && position.cap !== null && position.cap !== undefined && !isNaN(position.cap) && position.vitesse > 0.8) return position.cap;
    return null;
  }
  function surOrientation(ev) {
    var cap = null;
    if (typeof ev.webkitCompassHeading === "number" && !isNaN(ev.webkitCompassHeading)) cap = ev.webkitCompassHeading;
    else if (ev.absolute && typeof ev.alpha === "number") cap = (360 - ev.alpha) % 360;
    else if (typeof ev.alpha === "number" && ev.type === "deviceorientationabsolute") cap = (360 - ev.alpha) % 360;
    if (cap === null) return;
    var angleEcran = (screen.orientation && typeof screen.orientation.angle === "number") ? screen.orientation.angle : (window.orientation || 0);
    capBoussole = (cap + angleEcran + 360) % 360;
    rafraichirCap();
  }
  var dernierRafraichissementCap = 0;
  function rafraichirCap() {
    var t = Date.now();
    if (t - dernierRafraichissementCap < 120) return;
    dernierRafraichissementCap = t;
    var s = carte.getSource("position");
    if (s) s.setData(geojsonPosition());
    if (mode === "cap" && position && capBoussole !== null) carte.easeTo({ bearing: capBoussole, duration: 150, easing: function (x) { return x; } });
    majHud();
  }
  function activerBoussole() {
    if (ecouteBoussole) return Promise.resolve(true);
    var demande = Promise.resolve("granted");
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") {
      demande = DeviceOrientationEvent.requestPermission().catch(function () { return "denied"; });
    }
    return demande.then(function (etat) {
      if (etat !== "granted") return false;
      ecouteBoussole = true;
      if ("ondeviceorientationabsolute" in window) window.addEventListener("deviceorientationabsolute", surOrientation, true);
      else window.addEventListener("deviceorientation", surOrientation, true);
      return true;
    });
  }

  // ---------- position ----------
  function surPosition(p) {
    var c = p.coords;
    position = { lon: c.longitude, lat: c.latitude, precision: c.accuracy || 0, cap: c.heading, vitesse: c.speed || 0,
                 altitude: c.altitude, horodatage: p.timestamp || Date.now() };
    rafraichirCouches();
    if (mode === "centre") carte.easeTo({ center: [position.lon, position.lat], duration: 600 });
    else if (mode === "cap") {
      var options = { center: [position.lon, position.lat], duration: 600 };
      var cap = capCourant();
      if (cap !== null) options.bearing = cap;
      carte.easeTo(options);
    }
    if (traceEnCours) enregistrerPoint();
    majHud();
    ecouteursPosition.forEach(function (fn) { try { fn(position); } catch (e) { console.error(e); } });
  }
  function surErreur(e) {
    var texte = e.code === 1 ? "Accès à la position refusé : autorisez-le dans les réglages du navigateur." :
                e.code === 2 ? "Position indisponible (pas de signal GPS)." : "La position met trop de temps à arriver.";
    Panneau.message(texte, 5000);
    if (e.code === 1) definirMode("inactif");
  }
  function demarrerSurveillance() {
    if (surveillance !== null || !navigator.geolocation) return;
    surveillance = navigator.geolocation.watchPosition(surPosition, surErreur, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  function arreterSurveillance() {
    if (surveillance !== null) { navigator.geolocation.clearWatch(surveillance); surveillance = null; }
    if (!traceEnCours && !cible) { position = null; rafraichirCouches(); }
  }
  /* Une position fraîche, promesse : pour « ajouter ma position ». */
  function positionActuelle() {
    if (position && Date.now() - position.horodatage < 15000) return Promise.resolve(position);
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error("pas de géolocalisation")); return; }
      navigator.geolocation.getCurrentPosition(function (p) { surPosition(p); resolve(position); },
        function (e) { reject(new Error(e.code === 1 ? "accès refusé" : "pas de signal")); },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    });
  }

  function definirMode(nouveau) {
    mode = nouveau;
    btnPosition.setAttribute("aria-pressed", mode === "inactif" ? "false" : "true");
    btnPosition.textContent = mode === "cap" ? "⇧" : mode === "centre" ? "◎" : "⌖";
    btnPosition.title = mode === "inactif" ? "Afficher ma position" : mode === "actif" ? "Centrer sur ma position" :
                        mode === "centre" ? "Orienter la carte selon mon cap" : "Arrêter le suivi";
    if (mode === "inactif") { arreterSurveillance(); if (carte.getBearing() !== 0) carte.easeTo({ bearing: 0 }); return; }
    demarrerSurveillance();
    if (mode === "centre" && position) carte.easeTo({ center: [position.lon, position.lat], zoom: Math.max(carte.getZoom(), 15) });
    if (mode === "cap") {
      activerBoussole().then(function (ok) { if (!ok && capCourant() === null) Panneau.message("Boussole indisponible : le cap suivra votre déplacement."); });
      if (position) carte.easeTo({ center: [position.lon, position.lat], zoom: Math.max(carte.getZoom(), 16), pitch: 45 });
    } else if (carte.getPitch() > 0 && mode !== "cap") {
      /* on garde l'inclinaison choisie par l'utilisateur */
    }
  }
  function cyclerMode() {
    var i = MODES.indexOf(mode);
    var suivant = MODES[(i + 1) % MODES.length];
    if (suivant === "actif" && mode === "cap") suivant = "inactif";
    if (mode === "inactif") suivant = "centre"; // premier appui : afficher ET centrer
    definirMode(suivant);
  }
  carte.on("dragstart", function () { if (mode === "centre" || mode === "cap") definirMode("actif"); });
  carte.on("rotatestart", function () { if (mode === "cap") definirMode("actif"); });

  // ---------- guidage à vol d'oiseau ----------
  var hud = document.getElementById("hud");
  var hudFleche = document.getElementById("hud-fleche");
  var hudDistance = document.getElementById("hud-distance");
  var hudNom = document.getElementById("hud-nom");
  var hudDetail = document.getElementById("hud-detail");
  document.getElementById("hud-stop").addEventListener("click", function () { cibler(null); });

  function cibler(lieu) {
    cible = lieu ? { lon: lieu.lon, lat: lieu.lat, nom: lieu.nom || "Destination" } : null;
    if (cible) {
      Panneau.fermer();
      if (mode === "inactif") definirMode("actif");
      hud.hidden = false;
      verrouillerEcran(true);
      if (position) {
        // sud-ouest puis nord-est, sinon MapLibre croit à des limites qui font le tour du monde
        carte.fitBounds([[Math.min(position.lon, cible.lon), Math.min(position.lat, cible.lat)],
                         [Math.max(position.lon, cible.lon), Math.max(position.lat, cible.lat)]],
                        { padding: 80, maxZoom: 16, duration: 900 });
      } else {
        Carte.allerA(cible.lon, cible.lat, 15);
      }
    } else {
      hud.hidden = true;
      verrouillerEcran(false);
      if (!traceEnCours && mode === "actif") definirMode("inactif");
    }
    rafraichirCouches();
    majHud();
  }
  function majHud() {
    if (!cible) return;
    hudNom.textContent = cible.nom;
    if (!position) { hudDistance.textContent = "…"; hudDetail.textContent = "en attente de la position"; hudFleche.style.transform = ""; return; }
    var d = distance(position.lon, position.lat, cible.lon, cible.lat);
    var az = azimut(position.lon, position.lat, cible.lon, cible.lat);
    hudDistance.textContent = distanceTexte(d);
    var cap = capCourant();
    // flèche : par rapport au cap de l'appareil si connu, sinon par rapport au nord de la carte affichée
    var angle = cap !== null ? az - cap : az - carte.getBearing();
    hudFleche.style.transform = "rotate(" + angle + "deg)";
    var txt = "cap " + Math.round(az) + "°";
    if (position.vitesse > 0.5) txt += " · " + (position.vitesse * 3.6).toFixed(0) + " km/h · ≈ " + dureeTexte(d / position.vitesse);
    else txt += " · à vol d'oiseau";
    if (d < 25) txt = "Vous y êtes";
    hudDetail.textContent = txt;
  }
  carte.on("rotate", function () { if (cible && capCourant() === null) majHud(); });

  function verrouillerEcran(actif) {
    if (!navigator.wakeLock) return;
    if (actif && !verrouEcran) {
      navigator.wakeLock.request("screen").then(function (v) { verrouEcran = v; v.addEventListener("release", function () { verrouEcran = null; }); }).catch(function () {});
    } else if (!actif && verrouEcran && !traceEnCours && !cible) {
      verrouEcran.release().catch(function () {});
      verrouEcran = null;
    }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && (cible || traceEnCours)) verrouillerEcran(true);
  });

  // ---------- traces ----------
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
  function magasin(mode_) { return ouvrirBase().then(function (db) { return db.transaction(STORE, mode_).objectStore(STORE); }); }
  function attendre(req) { return new Promise(function (res, rej) { req.onsuccess = function () { res(req.result); }; req.onerror = function () { rej(req.error); }; }); }
  function toutesTraces() { return magasin("readonly").then(function (m) { return attendre(m.getAll()); }); }

  function enregistrerPoint() {
    var pts = traceEnCours.points;
    var dernier = pts[pts.length - 1];
    if (dernier) {
      var d = distance(dernier[0], dernier[1], position.lon, position.lat);
      if (d < Math.max(3, position.precision / 3) && position.horodatage - dernier[3] < 10000) return; // immobile
      traceEnCours.distance += d;
    }
    pts.push([+position.lon.toFixed(6), +position.lat.toFixed(6), position.altitude === null || position.altitude === undefined ? null : Math.round(position.altitude), position.horodatage]);
    var s = carte.getSource("traces");
    if (s) s.setData(geojsonTraces());
    majBoutonTrace();
  }
  var btnTrace = document.createElement("button");
  btnTrace.type = "button";
  btnTrace.id = "btn-trace";
  btnTrace.title = "Enregistrer une trace";
  btnTrace.textContent = "●";
  btnTrace.addEventListener("click", function () { if (traceEnCours) arreterTrace(); else demarrerTrace(); });
  function majBoutonTrace() {
    btnTrace.setAttribute("aria-pressed", traceEnCours ? "true" : "false");
    btnTrace.classList.toggle("enregistre", !!traceEnCours);
    btnTrace.title = traceEnCours ? "Arrêter la trace (" + distanceTexte(traceEnCours.distance) + ")" : "Enregistrer une trace";
  }
  function demarrerTrace() {
    traceEnCours = { debut: Date.now(), points: [], distance: 0 };
    if (mode === "inactif") definirMode("centre");
    verrouillerEcran(true);
    majBoutonTrace();
    Panneau.message("Enregistrement de la trace démarré");
  }
  function arreterTrace() {
    var t = traceEnCours;
    traceEnCours = null;
    majBoutonTrace();
    verrouillerEcran(false);
    if (!t || t.points.length < 2) { Panneau.message("Trace trop courte, rien à enregistrer"); var s = carte.getSource("traces"); if (s) s.setData(geojsonTraces()); return; }
    var trace = { nom: "Trace du " + new Date(t.debut).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }),
                  debut: t.debut, fin: Date.now(), distance: Math.round(t.distance), points: t.points };
    magasin("readwrite").then(function (m) { return attendre(m.add(trace)); }).then(function (id) {
      trace.id = id;
      tracesAffichees[id] = trace;
      var s = carte.getSource("traces"); if (s) s.setData(geojsonTraces());
      Panneau.message("Trace enregistrée : " + distanceTexte(trace.distance) + " en " + dureeTexte((trace.fin - trace.debut) / 1000));
    });
  }
  function supprimerTrace(id) {
    return magasin("readwrite").then(function (m) { return attendre(m.delete(id)); }).then(function () {
      delete tracesAffichees[id];
      var s = carte.getSource("traces"); if (s) s.setData(geojsonTraces());
    });
  }
  function gpxTrace(t) {
    var g = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Soest" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>' +
      String(t.nom).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</name><trkseg>\n";
    t.points.forEach(function (p) {
      g += '<trkpt lat="' + p[1] + '" lon="' + p[0] + '">' + (p[2] !== null ? "<ele>" + p[2] + "</ele>" : "") + "<time>" + new Date(p[3]).toISOString() + "</time></trkpt>\n";
    });
    return g + "</trkseg></trk>\n</gpx>\n";
  }
  function telecharger(nom, contenu, type) {
    var url = URL.createObjectURL(new Blob([contenu], { type: type }));
    var a = document.createElement("a"); a.href = url; a.download = nom; document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 2000);
  }
  /* Section « Traces » ajoutée au panneau Mes lieux. */
  function ajouterSectionTraces(corps) {
    var el = Panneau.element;
    var titre = el("h3", "", "Traces enregistrées");
    corps.appendChild(titre);
    var ul = el("ul", "liste");
    corps.appendChild(ul);
    toutesTraces().then(function (liste) {
      if (!liste.length) { var v = el("li", "", "Aucune trace. Bouton ● en bas à droite pour en enregistrer une."); v.style.cursor = "default"; ul.appendChild(v); return; }
      liste.sort(function (a, b) { return b.debut - a.debut; }).forEach(function (t) {
        var li = document.createElement("li");
        var pastille = el("span", "pastille"); pastille.style.background = tracesAffichees[t.id] ? "#7c3aed" : "#bbb";
        var texte = el("div", "texte");
        texte.appendChild(el("div", "", t.nom));
        texte.appendChild(el("small", "", distanceTexte(t.distance) + " · " + dureeTexte((t.fin - t.debut) / 1000) + " · " + t.points.length + " points"));
        li.appendChild(pastille); li.appendChild(texte);
        var actions = el("span", "");
        var bExport = Panneau.bouton("GPX", function (ev) { ev.stopPropagation(); telecharger(t.nom.replace(/[^\w\d-]+/g, "_") + ".gpx", gpxTrace(t), "application/gpx+xml"); }, "secondaire");
        var bSuppr = Panneau.bouton("✕", function (ev) { ev.stopPropagation(); if (confirm("Supprimer cette trace ?")) supprimerTrace(t.id).then(function () { li.remove(); }); }, "danger");
        actions.appendChild(bExport); actions.appendChild(bSuppr);
        li.appendChild(actions);
        li.addEventListener("click", function () {
          if (tracesAffichees[t.id]) { delete tracesAffichees[t.id]; pastille.style.background = "#bbb"; }
          else {
            tracesAffichees[t.id] = t; pastille.style.background = "#7c3aed";
            var lons = t.points.map(function (p) { return p[0]; }), lats = t.points.map(function (p) { return p[1]; });
            carte.fitBounds([[Math.min.apply(null, lons), Math.min.apply(null, lats)], [Math.max.apply(null, lons), Math.max.apply(null, lats)]], { padding: 60, duration: 800 });
          }
          var s = carte.getSource("traces"); if (s) s.setData(geojsonTraces());
        });
        ul.appendChild(li);
      });
    });
  }

  // ---------- boutons flottants ----------
  var flottants = document.getElementById("flottants");
  var btnPosition = document.createElement("button");
  btnPosition.type = "button";
  btnPosition.id = "btn-position";
  btnPosition.textContent = "⌖";
  btnPosition.title = "Afficher ma position";
  btnPosition.setAttribute("aria-pressed", "false");
  btnPosition.addEventListener("click", cyclerMode);
  flottants.appendChild(btnTrace);
  flottants.appendChild(btnPosition);
  majBoutonTrace();

  function surPositionEcouteur(fn) { ecouteursPosition.push(fn); }

  /* Position simulée (recette automatisée, démonstration sans GPS). */
  function simulerPosition(lon, lat, precision, cap, vitesse) {
    surPosition({ coords: { longitude: lon, latitude: lat, accuracy: precision || 10, heading: cap === undefined ? null : cap,
                            speed: vitesse || 0, altitude: null }, timestamp: Date.now() });
  }

  return {
    simulerPosition: simulerPosition,
    position: function () { return position; },
    positionActuelle: positionActuelle,
    surPosition: surPositionEcouteur,
    cibler: cibler,
    cible: function () { return cible; },
    distance: distance,
    azimut: azimut,
    distanceTexte: distanceTexte,
    dureeTexte: dureeTexte,
    capCourant: capCourant,
    mode: function () { return mode; },
    definirMode: definirMode,
    ajouterSectionTraces: ajouterSectionTraces
  };
})();
