"use strict";
/* Transports en commun : gare et haltes, arrêts de bus, tracés des lignes
 * (data/transports.json, extrait d'OpenStreetMap par build/transports.py).
 * Le fond Protomaps n'a pas de couche transport : celle-ci s'insère sous les
 * lieux et la position (avant le repère « reperes-modules » du style), au-dessus
 * du fond et de la carte topographique. Un arrêt cliqué ouvre la fiche du point
 * (coordonnées, altitude, « y aller ») complétée des lignes qui le desservent ;
 * les arrêts se cherchent aussi depuis le champ de recherche. */
var Transports = (function () {
  var carte = Carte.instance();
  var COULEURS = { train: "#1d4ed8", bus: "#b45309", tram: "#be123c" };
  var LIBELLES = { train: "Gare", bus: "Arrêt de bus", tram: "Arrêt de tram" };
  var COUCHES = ["transports-lignes-train", "transports-lignes-bus", "transports-arrets-halo", "transports-arrets", "transports-arrets-nom"];
  var donnees = null;
  var chargement = null;

  function normaliser(s) { return Recherche.normaliser(String(s || "").replace(/ß/g, "ss")); }

  // ---------- données ----------
  function charger() {
    if (donnees) return Promise.resolve(donnees);
    if (chargement) return chargement;
    chargement = fetch("data/transports.json").then(function (r) {
      if (!r.ok) throw new Error("transports.json : HTTP " + r.status);
      return r.json();
    }).then(function (d) {
      var parRef = {};
      d.lignes.forEach(function (l) {
        var k = l.type + ":" + l.ref;
        if (!parRef[k]) parRef[k] = [];
        parRef[k].push(l);
      });
      d.parRef = parRef;
      d.arretsNorm = d.arrets.map(function (a) { return normaliser(a[0]); });
      donnees = d;
      return d;
    }).catch(function (e) { chargement = null; throw e; });
    return chargement;
  }

  function couleurLigne(l) {
    var c = (l.couleur || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    return COULEURS[l.type] || COULEURS.bus;
  }

  function geojsonLignes(d) {
    return {
      type: "FeatureCollection",
      features: d.lignes.map(function (l) {
        return {
          type: "Feature",
          properties: { id: l.id, ref: l.ref, nom: l.nom, type: l.type, couleur: couleurLigne(l) },
          geometry: { type: "MultiLineString", coordinates: l.traces }
        };
      })
    };
  }

  function geojsonArrets(d) {
    return {
      type: "FeatureCollection",
      features: d.arrets.map(function (a, i) {
        return {
          type: "Feature",
          properties: { i: i, nom: a[0], type: a[3], lignes: a[4].join(" · "), couleur: COULEURS[a[3]] || COULEURS.bus },
          geometry: { type: "Point", coordinates: [a[1], a[2]] }
        };
      })
    };
  }

  // ---------- couches ----------
  function poserCouches(m) {
    if (m.getSource("transports-arrets")) { appliquerReglages(); return; }
    var sombre = Carte.themeSombre();
    var avant = m.getLayer("reperes-modules") ? "reperes-modules" : undefined;
    var vide = { type: "FeatureCollection", features: [] };
    m.addSource("transports-lignes", { type: "geojson", data: vide });
    m.addSource("transports-arrets", { type: "geojson", data: vide });
    m.addLayer({
      id: "transports-lignes-train", type: "line", source: "transports-lignes", filter: ["==", ["get", "type"], "train"], minzoom: 8,
      layout: { "line-join": "round", "line-cap": "round", visibility: "none" },
      paint: { "line-color": ["get", "couleur"], "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 13, 2.4, 16, 3.5],
               "line-opacity": 0.75, "line-dasharray": [3, 1.5] }
    }, avant);
    m.addLayer({
      id: "transports-lignes-bus", type: "line", source: "transports-lignes", filter: ["==", ["get", "type"], "bus"], minzoom: 12,
      layout: { "line-join": "round", "line-cap": "round", visibility: "none" },
      paint: { "line-color": ["get", "couleur"], "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1, 15, 2, 17, 3],
               "line-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.3, 15, 0.5] }
    }, avant);
    m.addLayer({
      id: "transports-arrets-halo", type: "circle", source: "transports-arrets",
      minzoom: 9, layout: { visibility: "none" },
      filter: ["any", ["==", ["get", "type"], "train"], [">=", ["zoom"], 13]],
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 5, 14, 8, 17, 11],
               "circle-color": sombre ? "#1a1d20" : "#ffffff", "circle-opacity": 0.95 }
    }, avant);
    m.addLayer({
      id: "transports-arrets", type: "circle", source: "transports-arrets",
      minzoom: 9, layout: { visibility: "none" },
      filter: ["any", ["==", ["get", "type"], "train"], [">=", ["zoom"], 13]],
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3, 14, 5, 17, 7],
               "circle-color": ["get", "couleur"], "circle-stroke-color": sombre ? "#1a1d20" : "#ffffff", "circle-stroke-width": 1.2 }
    }, avant);
    m.addLayer({
      id: "transports-arrets-nom", type: "symbol", source: "transports-arrets", minzoom: 11,
      filter: ["any", ["==", ["get", "type"], "train"], [">=", ["zoom"], 15]],
      layout: { visibility: "none", "text-field": ["get", "nom"], "text-font": ["Noto Sans Regular"],
                "text-size": ["case", ["==", ["get", "type"], "train"], 12.5, 11], "text-offset": [0, 0.9], "text-anchor": "top",
                "text-max-width": 8, "text-optional": true },
      paint: { "text-color": ["get", "couleur"], "text-halo-color": sombre ? "#1a1d20" : "#ffffff", "text-halo-width": 1.4 }
    }, avant);
    charger().then(function (d) {
      var sl = m.getSource("transports-lignes"), sa = m.getSource("transports-arrets");
      if (sl) sl.setData(geojsonLignes(d));
      if (sa) sa.setData(geojsonArrets(d));
      appliquerReglages();
    }).catch(function (e) { console.warn("transports :", e.message); });
  }
  Carte.surStyle(poserCouches);

  function appliquerReglages() {
    var visible = Carte.reglage("transports") !== false;
    COUCHES.forEach(function (id) {
      if (carte.getLayer(id)) carte.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    });
  }

  // ---------- fiches ----------
  function lignesDe(d, type, refs) {
    var out = [];
    refs.forEach(function (ref) {
      var liste = d.parRef[type + ":" + ref] || (type === "train" ? d.parRef["tram:" + ref] : null) || [];
      out.push({ ref: ref, variantes: liste });
    });
    return out;
  }

  function ouvrirFicheArret(i) {
    charger().then(function (d) {
      var a = d.arrets[i];
      if (!a) return;
      var libelle = LIBELLES[a[3]] || "Arrêt";
      Recherche.ouvrirFichePoint({ libelle: a[0], detail: libelle + (a[4].length ? " · " + a[4].join(", ") : ""), type: "arrêt",
                                   lon: a[1], lat: a[2], adresse: a[0] + " (" + libelle.toLowerCase() + ")" });
      var corps = document.getElementById("fiche-corps");
      var el = Panneau.element;
      corps.appendChild(el("h3", "", a[4].length ? "Lignes" : "Lignes desservant cet arrêt"));
      if (!a[4].length) {
        corps.appendChild(el("p", "note", "Aucune ligne rattachée à cet arrêt dans OpenStreetMap."));
        return;
      }
      var ul = el("ul", "lignes");
      lignesDe(d, a[3], a[4]).forEach(function (x) {
        var li = el("li");
        var badge = el("span", "badge", x.ref);
        var l0 = x.variantes[0];
        badge.style.background = l0 ? couleurLigne(l0) : (COULEURS[a[3]] || COULEURS.bus);
        li.appendChild(badge);
        var texte = el("span");
        var directions = x.variantes.map(function (l) { return l.a ? "vers " + l.a : (l.nom || ""); }).filter(Boolean);
        var uniques = directions.filter(function (v, k) { return directions.indexOf(v) === k; });
        texte.textContent = uniques.length ? uniques.join(" / ") : (l0 && l0.nom) || "";
        if (l0 && l0.op) {
          texte.appendChild(document.createElement("br"));
          texte.appendChild(el("small", "", l0.op));
        }
        li.appendChild(texte);
        ul.appendChild(li);
      });
      corps.appendChild(ul);
    });
  }

  function ouvrirFicheLigne(props) {
    charger().then(function (d) {
      var variantes = d.parRef[props.type + ":" + props.ref] || [];
      var l = variantes.filter(function (x) { return x.id === props.id; })[0] || variantes[0];
      if (!l) return;
      var corps = Panneau.ouvrir((l.type === "train" ? "Ligne " : "Bus ") + l.ref, l.op || "", "ligne");
      var el = Panneau.element;
      variantes.forEach(function (v) {
        var p = el("p", "", "");
        var badge = el("span", "badge", v.ref);
        badge.style.background = couleurLigne(v);
        p.appendChild(badge);
        p.appendChild(document.createTextNode(" " + (v.de && v.a ? v.de + " → " + v.a : v.nom || "")));
        corps.appendChild(p);
      });
      // arrêts desservis dans l'emprise : ceux qui portent cette référence
      var desservis = [];
      d.arrets.forEach(function (a, i) { if (a[3] === l.type && a[4].indexOf(l.ref) !== -1) desservis.push(i); });
      if (desservis.length) {
        corps.appendChild(el("h3", "", "Arrêts (" + desservis.length + ")"));
        var ul = el("ul", "arrets-ligne");
        desservis.forEach(function (i) {
          var a = d.arrets[i];
          var li = el("li");
          var b = Panneau.bouton(a[0], function () { Carte.allerA(a[1], a[2], 16); Carte.marquer(a[1], a[2]); ouvrirFicheArret(i); }, "lien");
          li.appendChild(b);
          ul.appendChild(li);
        });
        corps.appendChild(ul);
      }
      corps.appendChild(el("p", "note", "Tracés et arrêts © les contributeurs OpenStreetMap. Pas d'horaires hors ligne."));
    });
  }

  carte.on("click", "transports-arrets", function (ev) {
    if (!ev.features || !ev.features.length) return;
    var p = ev.features[0].properties;
    Carte.marquer();
    ouvrirFicheArret(p.i);
    ev.preventDefault && ev.preventDefault();
    ev.originalEvent.cancelBubble = true;
  });
  carte.on("click", "transports-lignes-train", function (ev) {
    if (!ev.features || !ev.features.length) return;
    if (carte.queryRenderedFeatures(ev.point, { layers: ["transports-arrets"] }).length) return;
    ouvrirFicheLigne(ev.features[0].properties);
  });
  ["transports-arrets", "transports-lignes-train"].forEach(function (id) {
    carte.on("mouseenter", id, function () { carte.getCanvas().style.cursor = "pointer"; });
    carte.on("mouseleave", id, function () { carte.getCanvas().style.cursor = ""; });
  });

  // ---------- recherche ----------
  Recherche.enregistrer({
    nom: "arrêts", priorite: 18,
    chercher: function (q, max) {
      var n = normaliser(q);
      if (n.length < 2 || Recherche.analyserCoordonnees(q)) return Promise.resolve([]);
      return charger().then(function (d) {
        var trouves = [];
        for (var i = 0; i < d.arrets.length && trouves.length < 30; i++) {
          var pos = d.arretsNorm[i].indexOf(n);
          if (pos === -1) continue;
          var a = d.arrets[i];
          trouves.push([pos === 0 ? 0 : 1, a[3] === "train" ? 0 : 1, -a[4].length, i]);
        }
        trouves.sort(function (x, y) { return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
        return trouves.slice(0, Math.min(max, 4)).map(function (t) {
          var a = d.arrets[t[3]], i = t[3];
          return { libelle: a[0], detail: (LIBELLES[a[3]] || "Arrêt") + (a[4].length ? " · " + a[4].join(", ") : ""), type: "arrêt",
                   lon: a[1], lat: a[2], zoom: 16, score: a[3] === "train" ? 12 : 18,
                   action: function () { Carte.allerA(a[1], a[2], 16); Carte.marquer(a[1], a[2]); ouvrirFicheArret(i); } };
        });
      }).catch(function () { return []; });
    }
  });

  return { appliquerReglages: appliquerReglages, charger: charger, ouvrirFicheArret: ouvrirFicheArret };
})();
