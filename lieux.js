"use strict";
/* Mes lieux : adresses, lieux et coordonnées GPS enregistrés par l'utilisateur.
 *
 * Création par appui long sur la carte (ou clic droit), depuis la position,
 * depuis des coordonnées tapées, depuis une adresse trouvée par la recherche.
 * Stockage IndexedDB, sur l'appareil uniquement ; import/export GeoJSON, GPX
 * et CSV pour la sauvegarde ou le transfert. Les lieux se dessinent dans une
 * source GeoJSON (points colorés par catégorie + étiquette). */
var Lieux = (function () {
  var BASE = "soest-lieux", STORE = "lieux", VERSION_BASE = 1;
  var CATEGORIES = [
    ["maison", "Maison", "#0e7490"], ["proche", "Famille, amis", "#db2777"], ["travail", "Travail", "#4b5563"],
    ["restaurant", "Restaurant, café", "#ea580c"], ["hebergement", "Hébergement", "#7c3aed"],
    ["commerce", "Commerce, service", "#16a34a"], ["nature", "Nature, randonnée", "#15803d"],
    ["culture", "Culture, visite", "#b45309"], ["parking", "Parking", "#2563eb"],
    ["transport", "Gare, arrêt", "#0891b2"], ["sante", "Santé", "#dc2626"], ["autre", "Autre", "#6b7280"]
  ];
  var COULEURS = {};
  CATEGORIES.forEach(function (c) { COULEURS[c[0]] = c[2]; });
  var carte = Carte.instance();
  var baseOuverte = null;
  var cache = null;          // tous les lieux, en mémoire
  var visibles = true;

  // ---------- IndexedDB ----------
  function ouvrirBase() {
    if (baseOuverte) return baseOuverte;
    baseOuverte = new Promise(function (resolve, reject) {
      var req = indexedDB.open(BASE, VERSION_BASE);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var s = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          s.createIndex("categorie", "categorie");
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return baseOuverte;
  }
  function magasin(mode) {
    return ouvrirBase().then(function (db) { return db.transaction(STORE, mode).objectStore(STORE); });
  }
  function attendre(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function tous() {
    if (cache) return Promise.resolve(cache);
    return magasin("readonly").then(function (m) { return attendre(m.getAll()); }).then(function (l) {
      cache = l;
      return l;
    });
  }
  function enregistrer(lieu) {
    lieu.modifieLe = new Date().toISOString();
    if (!lieu.creeLe) lieu.creeLe = lieu.modifieLe;
    return magasin("readwrite").then(function (m) { return attendre(m.put(lieu)); }).then(function (id) {
      lieu.id = id;
      cache = null;
      return tous().then(function () { redessiner(); return lieu; });
    });
  }
  function supprimer(id) {
    return magasin("readwrite").then(function (m) { return attendre(m.delete(id)); }).then(function () {
      cache = null;
      return tous().then(redessiner);
    });
  }
  function parId(id) {
    return tous().then(function (l) {
      for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
      return null;
    });
  }

  // ---------- couches ----------
  function geojson(liste) {
    return {
      type: "FeatureCollection",
      features: (liste || []).map(function (p) {
        return {
          type: "Feature", id: p.id,
          properties: { id: p.id, nom: p.nom || "", categorie: p.categorie || "autre", couleur: COULEURS[p.categorie] || COULEURS.autre },
          geometry: { type: "Point", coordinates: [p.lon, p.lat] }
        };
      })
    };
  }

  function poserCouches(m) {
    if (m.getSource("lieux")) return;
    m.addSource("lieux", { type: "geojson", data: geojson(cache) });
    var visibilite = visibles ? "visible" : "none";
    m.addLayer({
      id: "lieux-halo", type: "circle", source: "lieux", layout: { visibility: visibilite },
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 6, 14, 11], "circle-color": "#ffffff", "circle-opacity": 0.95 }
    });
    m.addLayer({
      id: "lieux-point", type: "circle", source: "lieux", layout: { visibility: visibilite },
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 4, 14, 8], "circle-color": ["get", "couleur"] }
    });
    m.addLayer({
      id: "lieux-nom", type: "symbol", source: "lieux", minzoom: 9, layout: {
        visibility: visibilite,
        "text-field": ["get", "nom"], "text-font": ["Noto Sans Medium"], "text-size": 12.5,
        "text-offset": [0, 1.1], "text-anchor": "top", "text-max-width": 9, "text-optional": true
      },
      paint: { "text-color": ["get", "couleur"], "text-halo-color": Carte.themeSombre() ? "#111" : "#fff", "text-halo-width": 1.6 }
    });
  }
  Carte.surStyle(poserCouches);

  function redessiner() {
    var src = carte.getSource("lieux");
    if (src) src.setData(geojson(cache));
  }

  function definirVisibles(v) {
    visibles = v;
    ["lieux-halo", "lieux-point", "lieux-nom"].forEach(function (id) {
      if (carte.getLayer(id)) carte.setLayoutProperty(id, "visibility", v ? "visible" : "none");
    });
  }

  carte.on("click", "lieux-point", function (ev) {
    if (!ev.features || !ev.features.length) return;
    ev.originalEvent.__lieuTraite = true;
    ouvrirFiche(ev.features[0].properties.id);
  });
  carte.on("mouseenter", "lieux-point", function () { carte.getCanvas().style.cursor = "pointer"; });
  carte.on("mouseleave", "lieux-point", function () { carte.getCanvas().style.cursor = ""; });

  // ---------- appui long / clic droit ----------
  var dernierAppuiLong = 0;
  carte.on("contextmenu", function (ev) {
    ev.preventDefault();
    // Android émet aussi un contextmenu après l'appui long déjà traité
    if (Date.now() - dernierAppuiLong < 1500) return;
    nouveau({ lon: ev.lngLat.lng, lat: ev.lngLat.lat, source: "carte" });
  });
  (function appuiLong() {
    var conteneur = carte.getCanvasContainer();
    var minuterie = null, depart = null;
    function annuler() { clearTimeout(minuterie); minuterie = null; depart = null; }
    conteneur.addEventListener("touchstart", function (ev) {
      if (ev.touches.length !== 1) { annuler(); return; }
      var t = ev.touches[0];
      depart = { x: t.clientX, y: t.clientY };
      minuterie = setTimeout(function () {
        var rect = carte.getCanvas().getBoundingClientRect();
        var p = carte.unproject([depart.x - rect.left, depart.y - rect.top]);
        annuler();
        dernierAppuiLong = Date.now();
        if (navigator.vibrate) navigator.vibrate(30);
        nouveau({ lon: p.lng, lat: p.lat, source: "carte" });
      }, 600);
    }, { passive: true });
    conteneur.addEventListener("touchmove", function (ev) {
      if (!depart) return;
      var t = ev.touches[0];
      if (Math.abs(t.clientX - depart.x) > 8 || Math.abs(t.clientY - depart.y) > 8) annuler();
    }, { passive: true });
    conteneur.addEventListener("touchend", annuler, { passive: true });
    conteneur.addEventListener("touchcancel", annuler, { passive: true });
  })();

  // ---------- utilitaires ----------
  function libelleCategorie(cle) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i][0] === cle) return CATEGORIES[i][1];
    return "Autre";
  }
  function distanceTexte(m) {
    if (m === null || m === undefined || !isFinite(m)) return "";
    return m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(m < 10000 ? 1 : 0).replace(".", ",") + " km";
  }
  function distanceDepuisPosition(lieu) {
    if (!window.Navigation) return null;
    var p = Navigation.position();
    if (!p) return null;
    return Navigation.distance(p.lon, p.lat, lieu.lon, lieu.lat);
  }

  // ---------- formulaire ----------
  /* nouveau({lon, lat, nom, adresse, source}) ouvre le formulaire de création ;
     modifier(lieu) le même formulaire prérempli. */
  function nouveau(graine) {
    formulaire(Object.assign({ nom: "", categorie: "autre", adresse: "", note: "" }, graine || {}), true);
  }
  function modifier(lieu) { formulaire(Object.assign({}, lieu), false); }

  function formulaire(lieu, creation) {
    var corps = Panneau.ouvrir(creation ? "Nouveau lieu" : "Modifier le lieu", "", "lieu-formulaire");
    var el = Panneau.element;
    Carte.marquer(lieu.lon, lieu.lat);

    function champ(libelle, type, valeur, attrs) {
      var lab = el("label", "champ");
      lab.appendChild(el("span", "", libelle));
      var inp = document.createElement(type === "textarea" ? "textarea" : "input");
      if (type !== "textarea") inp.type = type;
      inp.value = valeur === undefined || valeur === null ? "" : valeur;
      Object.keys(attrs || {}).forEach(function (k) { inp.setAttribute(k, attrs[k]); });
      lab.appendChild(inp);
      corps.appendChild(lab);
      return inp;
    }

    var nom = champ("Nom", "text", lieu.nom, { autocomplete: "off", placeholder: "Chez Anne, parking de la gare…" });
    var labCat = el("label", "champ");
    labCat.appendChild(el("span", "", "Catégorie"));
    var select = document.createElement("select");
    CATEGORIES.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c[0]; o.textContent = c[1];
      if (c[0] === lieu.categorie) o.selected = true;
      select.appendChild(o);
    });
    labCat.appendChild(select);
    corps.appendChild(labCat);
    var adresse = champ("Adresse (facultative)", "text", lieu.adresse, { autocomplete: "off", placeholder: "Markt 1, Soest" });
    var coords = champ("Coordonnées (latitude, longitude)", "text", Recherche.formaterCoordonnees(lieu.lat, lieu.lon), { autocomplete: "off", inputmode: "decimal" });
    coords.classList.add("coordonnees");
    var aideCoords = el("small", "", "Décimal (48.5814, 7.7507), degrés-minutes-secondes ou lien geo: — collez ce que vous avez.");
    corps.appendChild(aideCoords);
    var note = champ("Note", "textarea", lieu.note, { rows: 3, placeholder: "Code du portail, horaires, souvenirs…" });

    var actionsAdresse = el("div", "actions");
    if (window.Adresses) {
      actionsAdresse.appendChild(Panneau.bouton("Trouver l'adresse sur la carte", function () {
        if (!adresse.value.trim()) { Panneau.message("Tapez d'abord une adresse"); return; }
        Adresses.chercher(adresse.value, 1).then(function (r) {
          if (!r.length) { Panneau.message("Adresse introuvable hors ligne"); return; }
          lieu.lon = r[0].lon; lieu.lat = r[0].lat;
          coords.value = Recherche.formaterCoordonnees(lieu.lat, lieu.lon);
          adresse.value = r[0].libelle;
          Carte.marquer(lieu.lon, lieu.lat);
          Carte.allerA(lieu.lon, lieu.lat, 17);
        });
      }, "secondaire"));
      actionsAdresse.appendChild(Panneau.bouton("Adresse la plus proche", function () {
        Adresses.inverse(lieu.lon, lieu.lat).then(function (r) {
          if (r) adresse.value = r.libelle; else Panneau.message("Aucune adresse connue à proximité");
        });
      }, "secondaire"));
    }
    if (window.Navigation) {
      actionsAdresse.appendChild(Panneau.bouton("Prendre ma position", function () {
        Navigation.positionActuelle().then(function (p) {
          lieu.lon = p.lon; lieu.lat = p.lat;
          coords.value = Recherche.formaterCoordonnees(p.lat, p.lon);
          Carte.marquer(p.lon, p.lat);
          Carte.allerA(p.lon, p.lat, 17);
        }).catch(function (e) { Panneau.message("Position indisponible : " + e.message); });
      }, "secondaire"));
    }
    corps.appendChild(actionsAdresse);

    coords.addEventListener("change", function () {
      var c = Recherche.analyserCoordonnees(coords.value);
      if (!c) { Panneau.message("Coordonnées non comprises"); return; }
      lieu.lon = c.lon; lieu.lat = c.lat;
      coords.value = Recherche.formaterCoordonnees(c.lat, c.lon);
      Carte.marquer(c.lon, c.lat);
      Carte.allerA(c.lon, c.lat, Math.max(carte.getZoom(), 14));
    });

    var actions = el("div", "actions");
    actions.appendChild(Panneau.bouton("Enregistrer", function () {
      var c = Recherche.analyserCoordonnees(coords.value);
      if (!c) { Panneau.message("Coordonnées non comprises"); return; }
      lieu.lon = c.lon; lieu.lat = c.lat;
      lieu.nom = nom.value.trim() || adresse.value.trim() || Recherche.formaterCoordonnees(c.lat, c.lon);
      lieu.categorie = select.value;
      lieu.adresse = adresse.value.trim();
      lieu.note = note.value.trim();
      delete lieu.source;
      enregistrer(lieu).then(function (l) {
        Carte.marquer();
        Panneau.message(creation ? "Lieu enregistré" : "Lieu modifié");
        ouvrirFiche(l.id);
      });
    }, "primaire"));
    if (!creation) {
      actions.appendChild(Panneau.bouton("Supprimer", function () {
        if (!confirm("Supprimer « " + (lieu.nom || "ce lieu") + " » ?")) return;
        supprimer(lieu.id).then(function () { Carte.marquer(); Panneau.fermer(); Panneau.message("Lieu supprimé"); });
      }, "danger"));
    }
    actions.appendChild(Panneau.bouton("Annuler", function () { Carte.marquer(); Panneau.fermer(); }));
    corps.appendChild(actions);
    if (!Carte.dansEmprise(lieu.lon, lieu.lat)) {
      corps.appendChild(el("p", "note", "Ce point est hors de la carte détaillée (Soest ±10 km) : il sera enregistré, mais le fond de carte hors ligne ne le couvre pas."));
    }
    setTimeout(function () { if (creation && !lieu.nom) nom.focus(); }, 50);
  }

  // ---------- fiche ----------
  function ouvrirFiche(id) {
    parId(id).then(function (lieu) {
      if (!lieu) return;
      var corps = Panneau.ouvrir(lieu.nom, libelleCategorie(lieu.categorie), "lieu");
      var el = Panneau.element;
      Carte.marquer();
      if (lieu.adresse) corps.appendChild(el("p", "", lieu.adresse));
      corps.appendChild(el("p", "coordonnees", Recherche.formaterCoordonnees(lieu.lat, lieu.lon) + "  ·  " + Recherche.formaterDms(lieu.lat, lieu.lon)));
      var d = distanceDepuisPosition(lieu);
      if (d !== null) corps.appendChild(el("p", "note", "À " + distanceTexte(d) + " de votre position (à vol d'oiseau)."));
      if (window.Relief && Relief.altitude) {
        var alt = el("p", "note", "Altitude : …");
        corps.appendChild(alt);
        Relief.altitude(lieu.lon, lieu.lat).then(function (a) { alt.textContent = a === null ? "" : "Altitude : " + Math.round(a) + " m"; });
      }
      if (lieu.note) {
        var n = el("p", "", "");
        n.style.whiteSpace = "pre-wrap";
        n.textContent = lieu.note;
        corps.appendChild(n);
      }
      var actions = el("div", "actions");
      if (window.Itineraires) {
        actions.appendChild(Panneau.bouton("Y aller", function () { Itineraires.vers({ lon: lieu.lon, lat: lieu.lat, nom: lieu.nom }); }, "primaire"));
      } else if (window.Navigation) {
        actions.appendChild(Panneau.bouton("Y aller", function () { Navigation.cibler({ lon: lieu.lon, lat: lieu.lat, nom: lieu.nom }); }, "primaire"));
      }
      actions.appendChild(Panneau.bouton("Voir sur la carte", function () { Carte.allerA(lieu.lon, lieu.lat, 16); }));
      actions.appendChild(Panneau.bouton("Modifier", function () { modifier(lieu); }));
      actions.appendChild(Panneau.bouton("Partager", function () {
        var texte = lieu.nom + (lieu.adresse ? " — " + lieu.adresse : "") + " — " + Recherche.formaterCoordonnees(lieu.lat, lieu.lon);
        var url = "geo:" + lieu.lat.toFixed(6) + "," + lieu.lon.toFixed(6) + "?q=" + lieu.lat.toFixed(6) + "," + lieu.lon.toFixed(6) + "(" + encodeURIComponent(lieu.nom) + ")";
        if (navigator.share) navigator.share({ title: lieu.nom, text: texte + "\n" + url }).catch(function () {});
        else if (navigator.clipboard) navigator.clipboard.writeText(texte + "\n" + url).then(function () { Panneau.message("Lieu copié"); });
      }));
      corps.appendChild(actions);
      corps.appendChild(el("p", "note", "Ajouté le " + new Date(lieu.creeLe).toLocaleDateString("fr-FR") + "."));
    });
  }

  // ---------- liste ----------
  function ouvrirListe() {
    var corps = Panneau.ouvrir("Mes lieux", "", "lieux");
    var el = Panneau.element;
    var actions = el("div", "actions");
    actions.appendChild(Panneau.bouton("Ajouter au centre de la carte", function () {
      var c = carte.getCenter();
      nouveau({ lon: c.lng, lat: c.lat, source: "carte" });
    }, "primaire"));
    if (window.Navigation) {
      actions.appendChild(Panneau.bouton("Ajouter ma position", function () {
        Navigation.positionActuelle().then(function (p) { nouveau({ lon: p.lon, lat: p.lat, source: "position" }); })
          .catch(function (e) { Panneau.message("Position indisponible : " + e.message); });
      }));
    }
    actions.appendChild(Panneau.bouton("Saisir des coordonnées", function () {
      var c = carte.getCenter();
      nouveau({ lon: c.lng, lat: c.lat, source: "coordonnees" });
      setTimeout(function () { var i = document.querySelector("#fiche-corps input.coordonnees"); if (i) { i.focus(); i.select(); } }, 80);
    }));
    corps.appendChild(actions);
    corps.appendChild(el("p", "note", "Sur la carte : appui long (ou clic droit) pour ajouter un lieu à cet endroit."));

    var filtre = document.createElement("input");
    filtre.type = "search"; filtre.placeholder = "Filtrer mes lieux…"; filtre.className = "filtre";
    filtre.setAttribute("aria-label", "Filtrer mes lieux");
    var labF = el("label", "champ"); labF.appendChild(filtre); corps.appendChild(labF);
    var ul = el("ul", "liste");
    corps.appendChild(ul);
    var pied = el("div", "actions");
    corps.appendChild(pied);

    function remplir() {
      tous().then(function (liste) {
        var q = Recherche.normaliser(filtre.value || "");
        var p = window.Navigation ? Navigation.position() : null;
        var items = liste.filter(function (l) {
          return !q || Recherche.normaliser((l.nom || "") + " " + (l.adresse || "") + " " + (l.note || "") + " " + libelleCategorie(l.categorie)).indexOf(q) !== -1;
        }).map(function (l) {
          return { lieu: l, d: p ? Navigation.distance(p.lon, p.lat, l.lon, l.lat) : null };
        });
        items.sort(function (a, b) {
          if (a.d !== null && b.d !== null) return a.d - b.d;
          return (a.lieu.nom || "").localeCompare(b.lieu.nom || "", "fr");
        });
        ul.textContent = "";
        if (!items.length) {
          var vide = el("li", "", liste.length ? "Aucun lieu ne correspond." : "Aucun lieu enregistré pour l'instant.");
          vide.style.cursor = "default";
          ul.appendChild(vide);
        }
        items.forEach(function (it) {
          var li = document.createElement("li");
          var pastille = el("span", "pastille");
          pastille.style.background = COULEURS[it.lieu.categorie] || COULEURS.autre;
          var texte = el("div", "texte");
          texte.appendChild(el("div", "", it.lieu.nom));
          texte.appendChild(el("small", "", (it.lieu.adresse || libelleCategorie(it.lieu.categorie)) + (it.d !== null ? " · " + distanceTexte(it.d) : "")));
          li.appendChild(pastille);
          li.appendChild(texte);
          li.addEventListener("click", function () { ouvrirFiche(it.lieu.id); Carte.allerA(it.lieu.lon, it.lieu.lat, Math.max(carte.getZoom(), 14)); });
          ul.appendChild(li);
        });
        pied.textContent = "";
        pied.appendChild(Panneau.interrupteur("Afficher mes lieux sur la carte", visibles, definirVisibles));
        if (liste.length) {
          pied.appendChild(Panneau.bouton("Exporter en GeoJSON", function () { exporter("geojson"); }));
          pied.appendChild(Panneau.bouton("Exporter en GPX", function () { exporter("gpx"); }));
          pied.appendChild(Panneau.bouton("Exporter en CSV", function () { exporter("csv"); }));
        }
        pied.appendChild(Panneau.bouton("Importer (GeoJSON, GPX, CSV)", importer));
        if (window.Navigation && Navigation.ajouterSectionTraces) Navigation.ajouterSectionTraces(corps);
      });
    }
    filtre.addEventListener("input", remplir);
    remplir();
  }

  // ---------- import / export ----------
  function telecharger(nom, contenu, type) {
    var blob = new Blob([contenu], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = nom;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 2000);
  }
  function echapperXml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function exporter(format) {
    tous().then(function (liste) {
      var date = new Date().toISOString().slice(0, 10);
      if (format === "geojson") {
        var fc = { type: "FeatureCollection", features: liste.map(function (l) {
          return { type: "Feature", properties: { nom: l.nom, categorie: l.categorie, adresse: l.adresse || "", note: l.note || "", creeLe: l.creeLe },
                   geometry: { type: "Point", coordinates: [l.lon, l.lat] } };
        }) };
        telecharger("mes-lieux-" + date + ".geojson", JSON.stringify(fc, null, 1), "application/geo+json");
      } else if (format === "gpx") {
        var gpx = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Soest" xmlns="http://www.topografix.com/GPX/1/1">\n';
        liste.forEach(function (l) {
          gpx += '  <wpt lat="' + l.lat.toFixed(6) + '" lon="' + l.lon.toFixed(6) + '"><name>' + echapperXml(l.nom) + "</name>";
          if (l.adresse || l.note) gpx += "<desc>" + echapperXml((l.adresse ? l.adresse + "\n" : "") + (l.note || "")) + "</desc>";
          gpx += "<type>" + echapperXml(l.categorie) + "</type></wpt>\n";
        });
        gpx += "</gpx>\n";
        telecharger("mes-lieux-" + date + ".gpx", gpx, "application/gpx+xml");
      } else {
        var csv = "﻿nom;categorie;latitude;longitude;adresse;note\n";
        liste.forEach(function (l) {
          csv += [l.nom, l.categorie, l.lat.toFixed(6), l.lon.toFixed(6), l.adresse || "", (l.note || "").replace(/\s+/g, " ")]
            .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(";") + "\n";
        });
        telecharger("mes-lieux-" + date + ".csv", csv, "text/csv");
      }
    });
  }

  function importer() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".geojson,.json,.gpx,.csv,application/geo+json,application/gpx+xml,text/csv";
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (!f) return;
      f.text().then(function (texte) {
        var lieux = analyserImport(texte, f.name);
        if (!lieux.length) { Panneau.message("Aucun lieu reconnu dans ce fichier"); return; }
        var suite = Promise.resolve();
        lieux.forEach(function (l) { suite = suite.then(function () { return enregistrer(l); }); });
        suite.then(function () { Panneau.message(lieux.length + " lieu" + (lieux.length > 1 ? "x" : "") + " importé" + (lieux.length > 1 ? "s" : "")); ouvrirListe(); });
      });
    });
    input.click();
  }

  function analyserImport(texte, nom) {
    var lieux = [];
    var t = texte.trim();
    function ajouter(lon, lat, props) {
      if (!isFinite(lon) || !isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      var cat = props.categorie || props.type || "autre";
      if (!COULEURS[cat]) cat = "autre";
      lieux.push({ nom: props.nom || props.name || props.title || "Lieu importé", categorie: cat, lon: lon, lat: lat,
                   adresse: props.adresse || props.address || "", note: props.note || props.desc || props.description || "" });
    }
    if (t[0] === "{" || t[0] === "[") {
      try {
        var gj = JSON.parse(t);
        var feats = gj.type === "FeatureCollection" ? gj.features : gj.type === "Feature" ? [gj] : Array.isArray(gj) ? gj : [];
        feats.forEach(function (f) {
          if (f && f.geometry && f.geometry.type === "Point") ajouter(f.geometry.coordinates[0], f.geometry.coordinates[1], f.properties || {});
          else if (f && typeof f.lon === "number") ajouter(f.lon, f.lat, f);
        });
      } catch (e) { /* pas du JSON */ }
      return lieux;
    }
    if (t[0] === "<") {
      var doc = new DOMParser().parseFromString(t, "application/xml");
      Array.prototype.forEach.call(doc.getElementsByTagName("wpt"), function (w) {
        function texteDe(b) { var e = w.getElementsByTagName(b)[0]; return e ? e.textContent : ""; }
        ajouter(parseFloat(w.getAttribute("lon")), parseFloat(w.getAttribute("lat")), { nom: texteDe("name"), desc: texteDe("desc"), type: texteDe("type") });
      });
      // KML simple : <Placemark><name/><Point><coordinates>lon,lat</coordinates>
      Array.prototype.forEach.call(doc.getElementsByTagName("Placemark"), function (p) {
        var c = p.getElementsByTagName("coordinates")[0];
        var n = p.getElementsByTagName("name")[0];
        if (!c) return;
        var xy = c.textContent.trim().split(/[\s]+/)[0].split(",");
        ajouter(parseFloat(xy[0]), parseFloat(xy[1]), { nom: n ? n.textContent : "" });
      });
      return lieux;
    }
    // CSV : en-tête libre, colonnes repérées par leur nom
    var lignes = t.replace(/^﻿/, "").split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lignes.length < 2) return lieux;
    var sep = (lignes[0].match(/;/g) || []).length >= (lignes[0].match(/,/g) || []).length ? ";" : ",";
    function decouper(l) {
      var out = [], cur = "", dans = false;
      for (var i = 0; i < l.length; i++) {
        var ch = l[i];
        if (ch === '"') { if (dans && l[i + 1] === '"') { cur += '"'; i++; } else dans = !dans; }
        else if (ch === sep && !dans) { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out;
    }
    var entete = decouper(lignes[0]).map(function (h) { return Recherche.normaliser(h); });
    function col(noms) { for (var i = 0; i < noms.length; i++) { var k = entete.indexOf(noms[i]); if (k !== -1) return k; } return -1; }
    var iLat = col(["latitude", "lat", "y"]), iLon = col(["longitude", "lon", "lng", "long", "x"]);
    var iNom = col(["nom", "name", "titre", "title"]), iCat = col(["categorie", "category", "type"]);
    var iAdr = col(["adresse", "address"]), iNote = col(["note", "notes", "description", "desc"]);
    if (iLat === -1 || iLon === -1) return lieux;
    lignes.slice(1).forEach(function (l) {
      var v = decouper(l);
      ajouter(parseFloat(String(v[iLon]).replace(",", ".")), parseFloat(String(v[iLat]).replace(",", ".")), {
        nom: iNom !== -1 ? v[iNom] : "", categorie: iCat !== -1 ? v[iCat] : "", adresse: iAdr !== -1 ? v[iAdr] : "", note: iNote !== -1 ? v[iNote] : ""
      });
    });
    return lieux;
  }

  // ---------- recherche ----------
  Recherche.enregistrer({
    nom: "lieux", priorite: 10,
    chercher: function (q, max) {
      var n = Recherche.normaliser(q);
      return tous().then(function (liste) {
        return liste.filter(function (l) {
          return Recherche.normaliser((l.nom || "") + " " + (l.adresse || "") + " " + (l.note || "")).indexOf(n) !== -1;
        }).slice(0, max).map(function (l) {
          return { libelle: l.nom, detail: l.adresse || libelleCategorie(l.categorie), type: "lieu", lon: l.lon, lat: l.lat, zoom: 16,
                   action: function () { Carte.allerA(l.lon, l.lat, 16); ouvrirFiche(l.id); } };
        });
      });
    }
  });

  // ---------- amorçage ----------
  var chip = document.getElementById("chip-lieux");
  chip.hidden = false;
  chip.addEventListener("click", ouvrirListe);
  tous().then(redessiner);

  return {
    nouveau: nouveau,
    modifier: modifier,
    ouvrirFiche: ouvrirFiche,
    ouvrirListe: ouvrirListe,
    tous: tous,
    CATEGORIES: CATEGORIES
  };
})();
