"use strict";
/* Recherche unifiée : coordonnées GPS tapées ou collées, puis les
   fournisseurs enregistrés par les autres modules (mes lieux, adresses hors
   ligne, communes, recherche en ligne…). Chaque fournisseur renvoie des
   entrées { libelle, detail, type, lon, lat, zoom, action } ; `action`
   (facultative) remplace le comportement par défaut « aller au point ». */
var Recherche = (function () {
  var champ = document.getElementById("champ-recherche");
  var liste = document.getElementById("resultats");
  var fournisseurs = [];   // { nom, priorite, chercher(q, max) -> Promise<entrees> }
  var affiches = [];
  var selection = -1;
  var jeton = 0;
  var minuterie = null;

  function normaliser(s) {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  // ---------- coordonnées ----------
  /* Accepte : « 48.5814, 7.7507 », « 48,5814 7,7507 », « N 48.5814 E 7.7507 »,
     « 48°34'53"N 7°45'03"E », « 48° 34.88' N, 7° 45.04' E », « geo:48.58,7.75 »,
     et l'ordre longitude/latitude si le premier nombre ne peut pas être une
     latitude de la région. */
  function analyserCoordonnees(texte) {
    var t = texte.trim().replace(/^geo:/i, "").replace(/[;]/g, " ");
    if (!/\d/.test(t)) return null;
    // degrés-minutes-secondes ou degrés-minutes décimales
    var dms = /(\d{1,3})\s*[°º]\s*(\d{1,2}(?:[.,]\d+)?)?\s*['’′]?\s*(\d{1,2}(?:[.,]\d+)?)?\s*(?:["”″]|'')?\s*([NSEWO])?/gi;
    var trouves = [], m;
    while ((m = dms.exec(t)) !== null) {
      var deg = parseFloat(m[1]);
      var minutes = m[2] ? parseFloat(m[2].replace(",", ".")) : 0;
      var secondes = m[3] ? parseFloat(m[3].replace(",", ".")) : 0;
      var valeur = deg + minutes / 60 + secondes / 3600;
      var hemis = (m[4] || "").toUpperCase();
      if (hemis === "S" || hemis === "W" || hemis === "O") valeur = -valeur;
      trouves.push({ valeur: valeur, hemis: hemis });
    }
    if (trouves.length >= 2) return ordonner(trouves[0], trouves[1]);

    // décimal : préfixes N/E possibles, virgule décimale tolérée si pas de point
    var sansPrefixe = t.replace(/\b([NSEWO])\s*(?=[\d-])/gi, "$1").replace(/(\d)\s*([NSEWO])\b/gi, "$1$2");
    var virguleDecimale = !/\./.test(sansPrefixe) && /\d,\d/.test(sansPrefixe) && (sansPrefixe.match(/,/g) || []).length >= 2;
    if (!/\./.test(sansPrefixe) && /\d,\d/.test(sansPrefixe) && (sansPrefixe.match(/,/g) || []).length === 1 && /\s/.test(sansPrefixe.trim()) === false) {
      // « 48,5814 7,7507 » sans espace impossible ; « 48,5814,7,7507 » ambigu : on tente paires
      virguleDecimale = false;
    }
    var nombres = [];
    var re = virguleDecimale ? /([NSEWO])?(-?\d+(?:,\d+)?)([NSEWO])?/gi : /([NSEWO])?(-?\d+(?:\.\d+)?)([NSEWO])?/gi;
    while ((m = re.exec(sansPrefixe)) !== null) {
      nombres.push({ valeur: parseFloat(m[2].replace(",", ".")), hemis: (m[1] || m[3] || "").toUpperCase() });
      if (nombres.length === 2) break;
    }
    if (nombres.length < 2) return null;
    nombres.forEach(function (n) { if (n.hemis === "S" || n.hemis === "W" || n.hemis === "O") n.valeur = -Math.abs(n.valeur); });
    return ordonner(nombres[0], nombres[1]);
  }

  function ordonner(a, b) {
    var lat, lon;
    var aEstLon = a.hemis === "E" || a.hemis === "W" || a.hemis === "O";
    var bEstLat = b.hemis === "N" || b.hemis === "S";
    if (aEstLon || bEstLat || (Math.abs(a.valeur) <= 15 && Math.abs(b.valeur) > 15 && Math.abs(b.valeur) <= 90)) {
      lon = a.valeur; lat = b.valeur;
    } else {
      lat = a.valeur; lon = b.valeur;
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat: lat, lon: lon };
  }

  function formaterCoordonnees(lat, lon) {
    return lat.toFixed(5) + ", " + lon.toFixed(5);
  }

  function formaterDms(lat, lon) {
    function un(v, pos, neg) {
      var h = v >= 0 ? pos : neg; v = Math.abs(v);
      var d = Math.floor(v), mn = Math.floor((v - d) * 60), s = ((v - d) * 3600 - mn * 60);
      return d + "°" + String(mn).padStart(2, "0") + "'" + s.toFixed(1).padStart(4, "0") + "\"" + h;
    }
    return un(lat, "N", "S") + " " + un(lon, "E", "O");
  }

  // ---------- fournisseurs ----------
  function enregistrer(fournisseur) {
    fournisseurs.push(fournisseur);
    fournisseurs.sort(function (a, b) { return (a.priorite || 50) - (b.priorite || 50); });
  }

  /* onPartiel(resultats) est rappelé à chaque fournisseur qui répond : les
     résultats locaux s'affichent sans attendre la recherche en ligne. */
  function chercher(requete, maximum, onPartiel) {
    var q = requete.trim();
    var base = [];
    var coord = analyserCoordonnees(q);
    if (coord) {
      base.push({
        libelle: formaterCoordonnees(coord.lat, coord.lon),
        detail: formaterDms(coord.lat, coord.lon),
        type: "coordonnées", lon: coord.lon, lat: coord.lat, zoom: 16, score: 0
      });
    }
    if (normaliser(q).length < 2) return Promise.resolve(base);
    var parFournisseur = fournisseurs.map(function () { return []; });
    function assembler() {
      var resultats = base.slice();
      parFournisseur.forEach(function (l, i) {
        l.forEach(function (e) {
          if (e.score === undefined) e.score = fournisseurs[i].priorite || 50;
          resultats.push(e);
        });
      });
      // tri stable par score (un fournisseur peut se placer devant quand la requête lui ressemble)
      return resultats.map(function (e, i) { return [e.score, i, e]; })
        .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }).map(function (t) { return t[2]; })
        .slice(0, maximum || 10);
    }
    return Promise.all(fournisseurs.map(function (f, i) {
      return Promise.resolve().then(function () { return f.chercher(q, maximum || 8); })
        .catch(function (e) { console.warn("recherche " + f.nom + " :", e); return []; })
        .then(function (l) {
          parFournisseur[i] = l || [];
          if (onPartiel && parFournisseur[i].length) onPartiel(assembler());
        });
    })).then(assembler);
  }

  // ---------- interface ----------
  function fermer() {
    liste.hidden = true;
    liste.textContent = "";
    selection = -1;
    affiches = [];
  }

  function choisir(entree) {
    fermer();
    champ.value = entree.libelle;
    champ.blur();
    if (entree.action) { entree.action(entree); return; }
    Carte.marquer(entree.lon, entree.lat);
    Carte.allerA(entree.lon, entree.lat, entree.zoom || 16);
    ouvrirFichePoint(entree);
  }

  /* Fiche d'un point quelconque : coordonnées, altitude si relief, et
     raccourcis vers les modules présents (ajouter à mes lieux, itinéraire). */
  function ouvrirFichePoint(entree) {
    var corps = Panneau.ouvrir(entree.libelle, entree.detail || "", "point");
    var el = Panneau.element;
    var p = el("p", "coordonnees", formaterCoordonnees(entree.lat, entree.lon) + "  ·  " + formaterDms(entree.lat, entree.lon));
    corps.appendChild(p);
    if (!Carte.dansEmprise(entree.lon, entree.lat)) {
      corps.appendChild(el("p", "note", "Ce point est en dehors de la carte détaillée hors ligne (Soest ±10 km)."));
    }
    if (window.Relief && Relief.altitude) {
      var alt = el("p", "note", "Altitude : …");
      corps.appendChild(alt);
      Relief.altitude(entree.lon, entree.lat).then(function (a) {
        alt.textContent = a === null ? "Altitude inconnue ici." : "Altitude : " + Math.round(a) + " m";
      });
    }
    var actions = el("div", "actions");
    if (window.Lieux) {
      actions.appendChild(Panneau.bouton("Ajouter à mes lieux", function () {
        Lieux.nouveau({ lon: entree.lon, lat: entree.lat, nom: entree.type === "coordonnées" ? "" : entree.libelle, adresse: entree.adresse || "" });
      }, "primaire"));
    }
    if (window.Itineraires) {
      actions.appendChild(Panneau.bouton("Y aller", function () {
        Itineraires.vers({ lon: entree.lon, lat: entree.lat, nom: entree.libelle });
      }));
    } else if (window.Navigation) {
      actions.appendChild(Panneau.bouton("Y aller", function () {
        Navigation.cibler({ lon: entree.lon, lat: entree.lat, nom: entree.libelle });
      }));
    }
    actions.appendChild(Panneau.bouton("Copier les coordonnées", function () {
      var texte = formaterCoordonnees(entree.lat, entree.lon);
      if (navigator.clipboard) navigator.clipboard.writeText(texte).then(function () { Panneau.message("Coordonnées copiées"); });
    }));
    actions.appendChild(Panneau.bouton("Partager", function () {
      var url = "https://www.openstreetmap.org/?mlat=" + entree.lat.toFixed(5) + "&mlon=" + entree.lon.toFixed(5) + "#map=16/" + entree.lat.toFixed(5) + "/" + entree.lon.toFixed(5);
      if (navigator.share) navigator.share({ title: entree.libelle, text: formaterCoordonnees(entree.lat, entree.lon), url: url }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { Panneau.message("Lien copié"); });
    }));
    corps.appendChild(actions);
  }

  function afficher(resultats) {
    liste.textContent = "";
    selection = -1;
    affiches = resultats;
    if (resultats.length === 0) {
      var vide = document.createElement("li");
      vide.className = "vide";
      vide.textContent = "Aucun résultat";
      liste.appendChild(vide);
    }
    resultats.forEach(function (entree) {
      var li = document.createElement("li");
      var lib = document.createElement("span");
      lib.className = "libelle";
      lib.textContent = entree.libelle;
      if (entree.detail) {
        var petit = document.createElement("small");
        petit.textContent = entree.detail;
        lib.appendChild(petit);
      }
      var type = document.createElement("span");
      type.className = "type" + (entree.type === "lieu" ? " lieu" : "");
      type.textContent = entree.type || "";
      li.appendChild(lib);
      li.appendChild(type);
      li.addEventListener("mousedown", function (ev) { ev.preventDefault(); choisir(entree); });
      liste.appendChild(li);
    });
    liste.hidden = false;
  }

  function lancer() {
    var q = champ.value;
    if (normaliser(q).length < 2 && !analyserCoordonnees(q)) { fermer(); return; }
    var mien = ++jeton;
    chercher(q, 10, function (partiels) {
      if (mien === jeton) afficher(partiels);
    }).then(function (r) {
      if (mien !== jeton) return;
      afficher(r);
    });
  }

  function majSelection(delta) {
    var items = liste.querySelectorAll("li:not(.vide)");
    if (items.length === 0) return;
    if (selection >= 0) items[selection].classList.remove("actif");
    selection = (selection + delta + items.length) % items.length;
    items[selection].classList.add("actif");
    items[selection].scrollIntoView({ block: "nearest" });
  }

  champ.addEventListener("input", function () {
    clearTimeout(minuterie);
    minuterie = setTimeout(lancer, 120);
  });
  champ.addEventListener("focus", function () { if (champ.value.trim()) lancer(); });
  champ.addEventListener("blur", function () { setTimeout(fermer, 150); });
  champ.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowDown") { ev.preventDefault(); majSelection(1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); majSelection(-1); }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      var cible = selection >= 0 ? affiches[selection] : affiches[0];
      if (cible) choisir(cible);
      else if (!liste.hidden) { /* aucun résultat */ }
      else lancer();
    } else if (ev.key === "Escape") { fermer(); champ.blur(); }
  });

  return {
    enregistrer: enregistrer,
    chercher: chercher,
    choisir: choisir,
    ouvrirFichePoint: ouvrirFichePoint,
    analyserCoordonnees: analyserCoordonnees,
    formaterCoordonnees: formaterCoordonnees,
    formaterDms: formaterDms,
    normaliser: normaliser
  };
})();
