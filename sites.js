"use strict";
/* Sites et services publics : musées, églises, châteaux, monuments, parcs,
 * théâtres, mairies, bibliothèques, piscines, hôpitaux, pharmacies, police,
 * poste… (data/sites.json, build/sites.py : OpenStreetMap + Wikipédia/Wikidata
 * + photos Wikimedia Commons créditées). Pictogrammes cliquables, fiche avec
 * photo, état d'ouverture (horaires.js), horaires en français, descriptif,
 * téléphone, site web, courriel ; recherche par nom ou par catégorie. */
var Sites = (function () {
  var carte = Carte.instance();
  // clé : [libellé, pictogramme, couleur, zoom d'apparition]
  var CATEGORIES = {
    musee: ["Musée", "🏛", "#7c3aed", 12], galerie: ["Galerie d'art", "🖼", "#7c3aed", 14],
    chateau: ["Château", "🏰", "#b45309", 12],
    fortification: ["Tour, porte, fortification", "🧱", "#78716c", 13], ruines: ["Ruines, site archéologique", "🏚", "#78716c", 14],
    culte: ["Lieu de culte", "⛪", "#4b5563", 13], theatre: ["Théâtre", "🎭", "#db2777", 12],
    cinema: ["Cinéma", "🎬", "#db2777", 13], centre_culturel: ["Centre culturel", "🎨", "#db2777", 14],
    parc: ["Parc, jardin", "🌳", "#15803d", 13], reserve_naturelle: ["Réserve naturelle", "🦋", "#15803d", 12],
    point_de_vue: ["Point de vue", "🔭", "#0369a1", 13], zoo: ["Parc animalier", "🦁", "#15803d", 12],
    parc_attractions: ["Parc d'attractions", "🎡", "#db2777", 12], attraction: ["Curiosité", "⭐", "#ca8a04", 14],
    office_tourisme: ["Office de tourisme", "ℹ️", "#0369a1", 12],
    mairie: ["Mairie", "🏢", "#1d4ed8", 12], bibliotheque: ["Bibliothèque, médiathèque", "📚", "#1d4ed8", 13],
    hopital: ["Hôpital", "🏥", "#dc2626", 12], clinique: ["Clinique, cabinet médical", "🩺", "#dc2626", 14],
    pharmacie: ["Pharmacie", "💊", "#dc2626", 14], police: ["Police", "👮", "#1d4ed8", 13],
    pompiers: ["Pompiers", "🚒", "#dc2626", 14], poste: ["Poste", "✉️", "#ca8a04", 14],
    tribunal: ["Tribunal", "⚖️", "#1d4ed8", 13], marche: ["Marché", "🛒", "#ca8a04", 14],
    thermes: ["Thermes, bains", "♨️", "#0891b2", 12], piscine: ["Piscine", "🏊", "#0891b2", 12],
    centre_sportif: ["Centre sportif", "⚽", "#0891b2", 14], stade: ["Stade", "🏟", "#0891b2", 13],
    patinoire: ["Patinoire", "⛸", "#0891b2", 13], universite: ["Université, école supérieure", "🎓", "#1d4ed8", 13]
  };
  var INCONNU = ["Lieu", "📍", "#6b7280", 14];
  var CONFESSIONS = { catholic: "catholique", roman_catholic: "catholique", protestant: "protestante", lutheran: "luthérienne",
                      evangelical: "évangélique", reformed: "réformée", orthodox: "orthodoxe", baptist: "baptiste",
                      methodist: "méthodiste", new_apostolic: "néo-apostolique", jehovahs_witness: "témoins de Jéhovah",
                      sunni: "sunnite", shia: "chiite", old_catholic: "vieille-catholique", anglican: "anglicane", free_church: "église libre" };
  var RELIGIONS = { christian: "chrétien", muslim: "musulman", jewish: "juif", buddhist: "bouddhiste", hindu: "hindou" };
  var donnees = null;
  var chargement = null;

  function normaliser(s) { return Recherche.normaliser(String(s || "").replace(/ß/g, "ss")); }
  function categorie(s) { return CATEGORIES[s.cat] || INCONNU; }

  // ---------- données ----------
  function charger() {
    if (donnees) return Promise.resolve(donnees);
    if (chargement) return chargement;
    chargement = fetch("data/sites.json").then(function (r) {
      if (!r.ok) throw new Error("sites.json : HTTP " + r.status);
      return r.json();
    }).then(function (d) {
      d.norm = d.sites.map(function (s) { return normaliser(s.nom); });
      d.normCat = d.sites.map(function (s) { return normaliser(categorie(s)[0]); });
      donnees = d;
      return d;
    }).catch(function (e) { chargement = null; throw e; });
    return chargement;
  }

  function geojson(d) {
    return {
      type: "FeatureCollection",
      features: d.sites.map(function (s, i) {
        var c = categorie(s);
        return {
          type: "Feature",
          properties: { i: i, nom: s.nom, cat: s.cat, icone: "site-" + (CATEGORIES[s.cat] ? s.cat : "autre"), zmin: c[3], couleur: c[2] },
          geometry: { type: "Point", coordinates: [s.lon, s.lat] }
        };
      })
    };
  }

  // ---------- pictogrammes (disque blanc cerclé de la couleur, émoji au centre) ----------
  function dessinerIcone(emoji, couleur) {
    var taille = 30, ratio = 2;
    var c = document.createElement("canvas");
    c.width = c.height = taille * ratio;
    var g = c.getContext("2d");
    g.scale(ratio, ratio);
    g.beginPath();
    g.arc(taille / 2, taille / 2, taille / 2 - 1.5, 0, Math.PI * 2);
    g.fillStyle = "#ffffff";
    g.fill();
    g.lineWidth = 2.2;
    g.strokeStyle = couleur;
    g.stroke();
    g.font = "16px 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', 'Noto Sans', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = couleur;
    g.fillText(emoji, taille / 2, taille / 2 + 1);
    return { data: g.getImageData(0, 0, taille * ratio, taille * ratio), ratio: ratio };
  }

  function poserIcones(m) {
    Object.keys(CATEGORIES).forEach(function (cle) {
      var id = "site-" + cle;
      if (m.hasImage(id)) return;
      var ic = dessinerIcone(CATEGORIES[cle][1], CATEGORIES[cle][2]);
      m.addImage(id, ic.data, { pixelRatio: ic.ratio });
    });
    if (!m.hasImage("site-autre")) {
      var ic2 = dessinerIcone(INCONNU[1], INCONNU[2]);
      m.addImage("site-autre", ic2.data, { pixelRatio: ic2.ratio });
    }
  }

  // ---------- couches ----------
  function poserCouches(m) {
    poserIcones(m);
    if (m.getSource("sites")) { appliquerReglages(); return; }
    var sombre = Carte.themeSombre();
    var avant = m.getLayer("reperes-modules") ? "reperes-modules" : undefined;
    m.addSource("sites", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    /* Pictogrammes seuls, sans étiquette : les noms en couleur rendaient la
       carte illisible à fort zoom (demande du 2026-11-01) ; le nom s'affiche
       dans la fiche au toucher. */
    m.addLayer({
      id: "sites-icones", type: "symbol", source: "sites", minzoom: 11,
      filter: [">=", ["zoom"], ["get", "zmin"]],
      layout: {
        visibility: "none",
        "icon-image": ["get", "icone"], "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 14, 0.85, 17, 1],
        "icon-padding": 2, "icon-allow-overlap": ["step", ["zoom"], false, 16, true]
      }
    }, avant);
    charger().then(function (d) {
      var src = m.getSource("sites");
      if (src) src.setData(geojson(d));
      appliquerReglages();
    }).catch(function (e) { console.warn("sites :", e.message); });
  }
  Carte.surStyle(poserCouches);

  function appliquerReglages() {
    var visible = Carte.reglage("sites") !== false;
    if (carte.getLayer("sites-icones")) carte.setLayoutProperty("sites-icones", "visibility", visible ? "visible" : "none");
  }

  carte.on("click", "sites-icones", function (ev) {
    if (!ev.features || !ev.features.length) return;
    Carte.marquer();
    ouvrirFiche(ev.features[0].properties.i);
    ev.originalEvent.cancelBubble = true;
  });
  carte.on("mouseenter", "sites-icones", function () { carte.getCanvas().style.cursor = "pointer"; });
  carte.on("mouseleave", "sites-icones", function () { carte.getCanvas().style.cursor = ""; });

  // ---------- fiche ----------
  function lien(url, texte) {
    var a = document.createElement("a");
    a.href = url;
    a.textContent = texte;
    if (!/^(tel|mailto):/.test(url)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    return a;
  }

  function ouvrirFiche(i) {
    charger().then(function (d) {
      var s = d.sites[i];
      if (!s) return;
      var c = categorie(s);
      var el = Panneau.element;
      var corps = Panneau.ouvrir(s.nom, c[0] + (s.adresse ? " · " + s.adresse : ""), "site");

      if (s.photo) {
        var figure = el("figure", "photo-site");
        var img = document.createElement("img");
        img.src = s.photo;
        img.alt = s.nom;
        img.loading = "lazy";
        figure.appendChild(img);
        if (s.photo_credit) {
          var legende = el("figcaption", "", s.photo_credit + " ");
          if (s.photo_page) legende.appendChild(lien(s.photo_page, "↗"));
          figure.appendChild(legende);
        }
        corps.appendChild(figure);
      }

      var etiquettes = el("div", "etiquettes");
      if (s.horaires) {
        var e = Horaires.etat(s.horaires);
        var pastille = el("span", "pastille " + e.etat, e.etat === "ouvert" ? "Ouvert" : e.etat === "ferme" ? "Fermé" : "Horaires à vérifier");
        etiquettes.appendChild(pastille);
        if (e.texte) etiquettes.appendChild(el("span", "detail-etat", e.texte));
      }
      if (s.payant === "yes" || s.payant === "no") etiquettes.appendChild(el("span", "etiquette", s.payant === "yes" ? "payant" : "gratuit"));
      if (s.fauteuil === "yes" || s.fauteuil === "limited" || s.fauteuil === "no") {
        etiquettes.appendChild(el("span", "etiquette", { yes: "accessible en fauteuil", limited: "accès fauteuil limité", no: "non accessible en fauteuil" }[s.fauteuil]));
      }
      if (s.cat === "culte" && (s.confession || s.religion)) {
        var conf = CONFESSIONS[s.confession] || (s.confession ? s.confession.replace(/_/g, " ") : "");
        etiquettes.appendChild(el("span", "etiquette", conf || RELIGIONS[s.religion] || s.religion));
      }
      if (etiquettes.childNodes.length) corps.appendChild(etiquettes);

      if (s.horaires) {
        var lignes = Horaires.resume(s.horaires);
        if (lignes) {
          var ul = el("ul", "horaires-resume");
          lignes.forEach(function (l) { ul.appendChild(el("li", "", l)); });
          corps.appendChild(ul);
        } else {
          corps.appendChild(el("p", "horaires-bruts", s.horaires));
        }
      }

      if (s.description) {
        corps.appendChild(el("p", "description-site", s.description));
        var src = el("p", "note", "Source : " + (s.description_source || "Wikipédia") + (s.article ? " · " : ""));
        if (s.article) src.appendChild(lien(s.article, "lire l'article"));
        corps.appendChild(src);
      }
      if (s.description_osm && s.description_osm !== s.description) {
        corps.appendChild(el("p", "description-site", s.description_osm));
      }
      if (s.operateur && s.cat !== "culte") corps.appendChild(el("p", "note", "Exploitant : " + s.operateur));

      if (s.tel || s.site || s.courriel) {
        var contacts = el("ul", "contacts");
        if (s.tel) {
          var liTel = el("li", "", "📞 ");
          liTel.appendChild(lien("tel:" + s.tel.replace(/[^\d+]/g, ""), s.tel));
          contacts.appendChild(liTel);
        }
        if (s.site) {
          var liSite = el("li", "", "🌐 ");
          var hote = s.site.replace(/^https?:\/\//, "").replace(/\/$/, "");
          liSite.appendChild(lien(s.site, hote.length > 40 ? hote.slice(0, 38) + "…" : hote));
          contacts.appendChild(liSite);
        }
        if (s.courriel) {
          var liMail = el("li", "", "✉️ ");
          liMail.appendChild(lien("mailto:" + s.courriel, s.courriel));
          contacts.appendChild(liMail);
        }
        corps.appendChild(contacts);
      }

      if (!s.adresse && window.Adresses) {
        var pres = el("p", "note", "");
        corps.appendChild(pres);
        Adresses.inverse(s.lon, s.lat, 150).then(function (r) {
          if (r) pres.textContent = "Près de : " + r.libelle; else pres.remove();
        });
      }

      var actions = el("div", "actions");
      if (window.Lieux) {
        actions.appendChild(Panneau.bouton("Ajouter à mes lieux", function () {
          Lieux.nouveau({ lon: s.lon, lat: s.lat, nom: s.nom, adresse: s.adresse || "" });
        }, "primaire"));
      }
      if (window.Itineraires) {
        actions.appendChild(Panneau.bouton("Y aller", function () { Itineraires.vers({ lon: s.lon, lat: s.lat, nom: s.nom }); }));
      } else if (window.Navigation) {
        actions.appendChild(Panneau.bouton("Y aller", function () { Navigation.cibler({ lon: s.lon, lat: s.lat, nom: s.nom }); }));
      }
      actions.appendChild(Panneau.bouton("Copier les coordonnées", function () {
        var texte = Recherche.formaterCoordonnees(s.lat, s.lon);
        if (navigator.clipboard) navigator.clipboard.writeText(texte).then(function () { Panneau.message("Coordonnées copiées"); });
      }));
      corps.appendChild(actions);

      corps.appendChild(el("p", "note", "Position, horaires et contacts : OpenStreetMap, relevés le " + (d.date || "?") +
        ". Aucun tarif n'est publié ici : vérifier auprès du lieu avant de vous déplacer."));
    });
  }

  // ---------- recherche : nom ou catégorie ----------
  Recherche.enregistrer({
    nom: "sites", priorite: 17,
    chercher: function (q, max) {
      var n = normaliser(q);
      if (n.length < 2 || Recherche.analyserCoordonnees(q)) return Promise.resolve([]);
      return charger().then(function (d) {
        var centre = carte.getCenter();
        var trouves = [];
        for (var i = 0; i < d.sites.length; i++) {
          var pos = d.norm[i].indexOf(n);
          var parCat = pos === -1 && d.normCat[i].indexOf(n) !== -1;
          if (pos === -1 && !parCat) continue;
          var s = d.sites[i];
          var dist = Math.hypot((s.lon - centre.lng) * 69, (s.lat - centre.lat) * 111);
          trouves.push([parCat ? 2 : (pos === 0 ? 0 : 1), dist, i]);
        }
        trouves.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        return trouves.slice(0, Math.min(max, 5)).map(function (t) {
          var s = d.sites[t[2]], i = t[2], c = categorie(s);
          var detail = c[0] + (s.adresse ? " · " + s.adresse : "");
          if (s.horaires) {
            var e = Horaires.etat(s.horaires);
            if (e.etat !== "inconnu") detail += " · " + (e.etat === "ouvert" ? "ouvert" : "fermé");
          }
          return { libelle: s.nom, detail: detail, type: "site", lon: s.lon, lat: s.lat, zoom: 16, score: t[0] === 2 ? 19 : 14,
                   action: function () { Carte.allerA(s.lon, s.lat, 16); Carte.marquer(s.lon, s.lat); ouvrirFiche(i); } };
        });
      }).catch(function () { return []; });
    }
  });

  return { charger: charger, ouvrirFiche: ouvrirFiche, appliquerReglages: appliquerReglages, categories: CATEGORIES };
})();
