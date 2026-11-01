"use strict";
/* Adresses : recherche hors ligne (paquet « adresses » : OpenStreetMap, Soest
 * et environs), localités (data/communes.json), géocodage inverse, numéros de
 * maison dessinés à fort zoom, et recherche en ligne de secours (Photon/OSM).
 *
 * Format du paquet (build/adresses.py) : gzip de
 *   "SOADR1\0\0" | u32 longueur JSON | u32 n | JSON { communes, reps, rues } |
 *   n × u16 numéro | n × u16 suffixe | n × i32 lon·1e6 | n × i32 lat·1e6
 * Les rues portent [nom, communeIdx, cp, debut, n, lonMin, latMin, lonMax, latMax]. */
var Adresses = (function () {
  var CLE = "adresses";
  var PAS_GRILLE = 0.01;      // degrés (≈ 0,7 × 1,1 km)
  var carte = Carte.instance();
  var index = null;
  var chargement = null;
  var localites = null;
  var controleurEnLigne = null;
  var minuterieNumeros = null;

  var ABREVIATIONS = {
    "r": "rue", "r.": "rue", "av": "avenue", "av.": "avenue", "bd": "boulevard", "bd.": "boulevard", "blvd": "boulevard",
    "pl": "place", "pl.": "place", "imp": "impasse", "imp.": "impasse", "all": "allee", "all.": "allee", "rte": "route",
    "ch": "chemin", "ch.": "chemin", "st": "saint", "st.": "saint", "ste": "sainte", "ste.": "sainte", "fbg": "faubourg",
    "str": "strasse", "str.": "strasse", "pl ": "platz"
  };

  function normaliser(s) {
    return Recherche.normaliser(String(s || "").replace(/ß/g, "ss")).replace(/str\.(?=\s|$)/g, "strasse")
      .replace(/(\w)str(\.|\b)/g, "$1strasse").replace(/[-–'’.,/]/g, " ").replace(/\s+/g, " ").trim();
  }
  function jetons(q) {
    return normaliser(q).split(" ").filter(Boolean).map(function (t) { return ABREVIATIONS[t] || t; });
  }

  // ---------- chargement du paquet ----------
  function installe() { return Stockage.etat(CLE).then(function (e) { return e.installe; }); }

  function charger() {
    if (index) return Promise.resolve(index);
    if (chargement) return chargement;
    chargement = Stockage.etat(CLE).then(function (e) {
      if (!e.installe) throw new Error("paquet d'adresses non installé");
      return Stockage.lire(CLE, 0, e.publie.taille);
    }).then(function (gz) {
      var flux = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Response(flux).arrayBuffer();
    }).then(function (buf) {
      var vue = new DataView(buf);
      var magie = new TextDecoder().decode(new Uint8Array(buf, 0, 6));
      if (magie !== "SOADR1") throw new Error("format d'index inconnu");
      var lEntete = vue.getUint32(8, true), n = vue.getUint32(12, true);
      var entete = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 16, lEntete)));
      var p = 16 + lEntete;
      var idx = {
        n: n, communes: entete.communes, reps: entete.reps, rues: entete.rues, date: entete.date,
        numeros: new Uint16Array(buf.slice(p, p + 2 * n)),
        suffixes: new Uint16Array(buf.slice(p + 2 * n, p + 4 * n)),
        lons: new Int32Array(buf.slice(p + 4 * n, p + 8 * n)),
        lats: new Int32Array(buf.slice(p + 8 * n, p + 12 * n)),
        ruesNorm: null, communesNorm: null, grille: null
      };
      idx.communesNorm = idx.communes.map(function (c) { return normaliser(c[0]); });
      idx.ruesNomLong = new Uint16Array(idx.rues.length);
      idx.ruesNorm = idx.rues.map(function (r, i) {
        var nom = normaliser(r[0]);
        idx.ruesNomLong[i] = nom.length;
        return nom + " " + idx.communesNorm[r[1]] + " " + (r[2] || "");
      });
      idx.grille = new Map();
      idx.rues.forEach(function (r, i) {
        if (r[4] === 0) return;
        var x0 = Math.floor(r[5] / 1e6 / PAS_GRILLE), x1 = Math.floor(r[7] / 1e6 / PAS_GRILLE);
        var y0 = Math.floor(r[6] / 1e6 / PAS_GRILLE), y1 = Math.floor(r[8] / 1e6 / PAS_GRILLE);
        if ((x1 - x0) * (y1 - y0) > 400) return; // rue aberrante (numéros dispersés) : ignorée dans la grille
        for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
          var k = x + ":" + y;
          var l = idx.grille.get(k);
          if (!l) idx.grille.set(k, l = []);
          l.push(i);
        }
      });
      index = idx;
      return idx;
    }).catch(function (e) { chargement = null; throw e; });
    return chargement;
  }

  Stockage.surChangement(function (cle) { if (cle === CLE) { index = null; chargement = null; dessinerNumeros(); } });

  // ---------- formats ----------
  function libelleNumero(idx, i) {
    var num = idx.numeros[i], suf = idx.reps[idx.suffixes[i]] || "";
    if (!num) return suf;
    return num + (suf && /^[a-z]/i.test(suf) && suf.length <= 2 ? suf : (suf ? " " + suf : ""));
  }
  function libelleRue(idx, r, i) {
    var pays = idx.communes[r[1]][1];
    var num = i === undefined ? "" : libelleNumero(idx, i);
    if (!num) return r[0];
    return pays === "DE" ? r[0] + " " + num : num + " " + r[0];
  }
  function detailRue(idx, r) {
    var c = idx.communes[r[1]];
    return ((r[2] || c[4] || "") + " " + c[0]).trim();
  }

  // ---------- recherche hors ligne ----------
  /* Le numéro peut être devant (« 12 rue des Vosges Strasbourg »), au milieu
     (« Hauptstraße 5 Kehl ») ou à la fin ; un nombre précédé de « du », « de »,
     « am »… appartient au nom (« rue du 22 Novembre »). Les mots restants
     doivent contenir une lettre. */
  var TYPES_VOIE = { rue: 1, avenue: 1, boulevard: 1, place: 1, impasse: 1, allee: 1, route: 1, chemin: 1, quai: 1, strasse: 1, weg: 1, platz: 1, gasse: 1 };
  var ARTICLES_AVANT_NOMBRE = { du: 1, de: 1, la: 1, le: 1, les: 1, des: 1, au: 1, aux: 1, am: 1, an: 1, der: 1, dem: 1, den: 1, zum: 1, zur: 1, im: 1 };
  function analyserRequete(q) {
    var jetonsBruts = normaliser(q).split(" ").filter(Boolean);
    var numero = 0, suffixe = "", mots = [];
    for (var i = 0; i < jetonsBruts.length; i++) {
      var j = jetonsBruts[i];
      var m = /^(\d{1,5})(bis|ter|quater|[a-z])?$/.exec(j);
      if (m && !numero && (i === 0 || !ARTICLES_AVANT_NOMBRE[jetonsBruts[i - 1]])) {
        numero = +m[1];
        suffixe = m[2] || "";
        var suivant = jetonsBruts[i + 1];
        if (!suffixe && suivant && /^(bis|ter|quater)$/.test(suivant)) { suffixe = suivant; i++; }
        continue;
      }
      mots.push(ABREVIATIONS[j] || j);
    }
    mots = mots.filter(function (x) { return /[a-z]/.test(x) || /^\d+$/.test(x); });
    return { numero: numero, suffixe: suffixe, mots: mots };
  }

  function chercherHorsLigne(q, max) {
    return charger().then(function (idx) {
      var req = analyserRequete(q);
      if (!req.mots.length || !req.mots.some(function (x) { return /[a-z]/.test(x); })) return [];
      function collecter(mots) {
        var candidats = [];
        for (var i = 0; i < idx.ruesNorm.length && candidats.length < 400; i++) {
          var s = idx.ruesNorm[i];
          var ok = true, score = 0, dansLeNom = false;
          var longueurNom = idx.ruesNomLong[i];
          for (var j = 0; j < mots.length; j++) {
            var pos = s.indexOf(mots[j]);
            if (pos === -1) { ok = false; break; }
            if (pos < longueurNom) dansLeNom = true;
            // mot en début de nom de rue : bonus ; mot trouvé en milieu de mot : malus
            if (pos === 0) score -= 3;
            else if (s[pos - 1] !== " ") score += 2;
          }
          // une requête qui ne touche que la commune (« Lauterbourg ») n'est pas une rue
          if (!ok || !dansLeNom) continue;
          var r = idx.rues[i];
          score += Math.min(r[0].length / 10, 4);
          if (req.numero && r[4] === 0) score += 5;
          candidats.push([score, i]);
        }
        return candidats;
      }
      var candidats = collecter(req.mots);
      if (!candidats.length) {
        // « rue des Vosges Strasbourg » n'existe pas (c'est une avenue) : sans le type de voie
        var sansType = req.mots.filter(function (x) { return !TYPES_VOIE[x]; });
        if (sansType.length && sansType.length < req.mots.length) candidats = collecter(sansType);
      }
      if (!candidats.length && req.mots.length > 1) {
        // puis sans le dernier mot, souvent la commune : la rue existe peut-être ailleurs
        candidats = collecter(req.mots.slice(0, -1));
      }
      candidats.sort(function (a, b) { return a[0] - b[0]; });
      var resultats = [];
      var vus = {};
      for (var k = 0; k < candidats.length && resultats.length < max; k++) {
        var ri = candidats[k][1], r = idx.rues[ri];
        var cle = normaliser(r[0]) + "|" + r[1];
        if (vus[cle]) continue;
        vus[cle] = true;
        var e = entreeRue(idx, ri, req);
        if (e) resultats.push(e);
      }
      return resultats;
    }).catch(function () { return []; });
  }

  /* Entrée de résultat pour une rue, au numéro demandé (le plus proche sinon). */
  function entreeRue(idx, ri, req) {
    var r = idx.rues[ri];
    if (r[4] === 0) return null;
    var debut = r[3], fin = r[3] + r[4];
    var i = -1, approche = false;
    if (req.numero) {
      var meilleur = -1, ecart = Infinity;
      for (var k = debut; k < fin; k++) {
        var d = Math.abs(idx.numeros[k] - req.numero);
        var sufOk = !req.suffixe || normaliser(idx.reps[idx.suffixes[k]]) === req.suffixe;
        var c = d * 2 + (sufOk ? 0 : 1);
        if (c < ecart) { ecart = c; meilleur = k; }
      }
      i = meilleur;
      approche = ecart > 0;
    } else {
      i = debut + Math.floor(r[4] / 2); // milieu de la rue
    }
    var lon = idx.lons[i] / 1e6, lat = idx.lats[i] / 1e6;
    var libelle = req.numero ? libelleRue(idx, r, i) : r[0];
    var detail = detailRue(idx, r) + (req.numero ? (approche ? " · numéro le plus proche" : "") : " · " + r[4] + " numéro" + (r[4] > 1 ? "s" : ""));
    return { libelle: libelle, detail: detail, type: "adresse", lon: lon, lat: lat, zoom: req.numero ? 18 : 16,
             adresse: libelle + ", " + detailRue(idx, r), score: req.numero ? 5 : 20 };
  }

  /* Résultats pour un libellé (utilisé par le formulaire de lieu). */
  function chercher(q, max) { return chercherHorsLigne(q, max || 5); }

  // ---------- géocodage inverse ----------
  function ruesAutour(idx, lon, lat, rayonCellules) {
    var cx = Math.floor(lon / PAS_GRILLE), cy = Math.floor(lat / PAS_GRILLE), out = [], vus = {};
    for (var x = cx - rayonCellules; x <= cx + rayonCellules; x++) for (var y = cy - rayonCellules; y <= cy + rayonCellules; y++) {
      var l = idx.grille.get(x + ":" + y);
      if (!l) continue;
      for (var i = 0; i < l.length; i++) if (!vus[l[i]]) { vus[l[i]] = true; out.push(l[i]); }
    }
    return out;
  }
  function inverse(lon, lat, rayonMax) {
    rayonMax = rayonMax || 150;
    return charger().then(function (idx) {
      var kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574;
      var meilleur = -1, d2min = rayonMax * rayonMax;
      ruesAutour(idx, lon, lat, 1).forEach(function (ri) {
        var r = idx.rues[ri];
        for (var k = r[3]; k < r[3] + r[4]; k++) {
          var dx = (idx.lons[k] / 1e6 - lon) * kx, dy = (idx.lats[k] / 1e6 - lat) * ky;
          var d2 = dx * dx + dy * dy;
          if (d2 < d2min) { d2min = d2; meilleur = k; }
        }
      });
      if (meilleur === -1) return null;
      var ri = rueDeLIndex(idx, meilleur), r = idx.rues[ri];
      return { libelle: libelleRue(idx, r, meilleur) + ", " + detailRue(idx, r), distance: Math.sqrt(d2min),
               lon: idx.lons[meilleur] / 1e6, lat: idx.lats[meilleur] / 1e6 };
    }).catch(function () { return null; });
  }
  function rueDeLIndex(idx, i) {
    // recherche dichotomique de la rue dont le bloc contient i
    var a = 0, b = idx.rues.length - 1;
    while (a < b) {
      var m = (a + b + 1) >> 1;
      if (idx.rues[m][3] <= i) a = m; else b = m - 1;
    }
    return a;
  }

  // ---------- numéros de maison sur la carte ----------
  function poserCouches(m) {
    if (m.getSource("numeros")) return;
    m.addSource("numeros", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    m.addLayer({
      id: "numeros-texte", type: "symbol", source: "numeros", minzoom: 17,
      layout: { "text-field": ["get", "num"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-padding": 1,
                "text-allow-overlap": false, "text-anchor": "center" },
      paint: { "text-color": Carte.themeSombre() ? "#cfd8dc" : "#4b5563", "text-halo-color": Carte.themeSombre() ? "#1a1d20" : "#ffffff", "text-halo-width": 1.2 }
    });
    dessinerNumeros();
  }
  Carte.surStyle(poserCouches);

  function dessinerNumeros() {
    var src = carte.getSource("numeros");
    if (!src) return;
    if (!Carte.reglage("numeros") || carte.getZoom() < 16.8 || !index) {
      if (!index && Carte.reglage("numeros") && carte.getZoom() >= 16.8) {
        installe().then(function (ok) { if (ok) charger().then(dessinerNumeros).catch(function () {}); });
      }
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    var b = carte.getBounds();
    var o = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    var feats = [];
    var rues = ruesAutourBbox(index, o, s, e, n);
    for (var j = 0; j < rues.length && feats.length < 4000; j++) {
      var r = index.rues[rues[j]];
      for (var k = r[3]; k < r[3] + r[4]; k++) {
        var lon = index.lons[k] / 1e6, lat = index.lats[k] / 1e6;
        if (lon < o || lon > e || lat < s || lat > n || !index.numeros[k]) continue;
        feats.push({ type: "Feature", properties: { num: libelleNumero(index, k) }, geometry: { type: "Point", coordinates: [lon, lat] } });
      }
    }
    src.setData({ type: "FeatureCollection", features: feats });
  }
  function ruesAutourBbox(idx, o, s, e, n) {
    var out = [], vus = {};
    for (var x = Math.floor(o / PAS_GRILLE); x <= Math.floor(e / PAS_GRILLE); x++) {
      for (var y = Math.floor(s / PAS_GRILLE); y <= Math.floor(n / PAS_GRILLE); y++) {
        var l = idx.grille.get(x + ":" + y);
        if (!l) continue;
        for (var i = 0; i < l.length; i++) if (!vus[l[i]]) { vus[l[i]] = true; out.push(l[i]); }
      }
    }
    return out;
  }
  carte.on("moveend", function () { clearTimeout(minuterieNumeros); minuterieNumeros = setTimeout(dessinerNumeros, 150); });
  function appliquerReglages() { dessinerNumeros(); }

  // ---------- localités ----------
  var TYPES = { commune: "commune", city: "ville", town: "ville", village: "village", hamlet: "hameau", suburb: "quartier", quarter: "quartier", neighbourhood: "quartier" };
  var ZOOMS = { commune: 14, city: 12, town: 13, village: 14.5, hamlet: 15.5, suburb: 14.5, quarter: 15, neighbourhood: 15.5 };
  function chargerLocalites() {
    if (localites) return Promise.resolve(localites);
    return fetch("data/communes.json").then(function (r) { return r.json(); }).then(function (l) {
      localites = l.map(function (x) { return { nom: x[0], pays: x[1], lon: x[2], lat: x[3], type: x[4], pop: x[5], norm: normaliser(x[0]) }; });
      return localites;
    }).catch(function () { return []; });
  }
  Recherche.enregistrer({
    nom: "localites", priorite: 15,
    chercher: function (q, max) {
      var n = normaliser(q);
      if (n.length < 2 || /\d/.test(n)) return Promise.resolve([]);
      return chargerLocalites().then(function (l) {
        var trouves = [];
        for (var i = 0; i < l.length && trouves.length < 40; i++) {
          var pos = l[i].norm.indexOf(n);
          if (pos === -1) continue;
          trouves.push([pos === 0 ? 0 : 1, -l[i].pop, l[i]]);
        }
        trouves.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        return trouves.slice(0, Math.min(max, 4)).map(function (t) {
          var x = t[2];
          return { libelle: x.nom, detail: (TYPES[x.type] || x.type), type: "localité",
                   lon: x.lon, lat: x.lat, zoom: ZOOMS[x.type] || 14, score: 15 };
        });
      });
    }
  });

  // ---------- adresses hors ligne : fournisseur ----------
  Recherche.enregistrer({
    nom: "adresses", priorite: 20,
    chercher: function (q, max) {
      if (Recherche.analyserCoordonnees(q)) return Promise.resolve([]);
      return installe().then(function (ok) { return ok ? chercherHorsLigne(q, Math.min(max, 6)) : []; });
    }
  });

  // ---------- recherche en ligne (Photon, données OSM) ----------
  /* Photon public : au plus une requête toutes les 1,2 s (au-delà, 429 sans
     en-tête CORS, que le navigateur rapporte comme une erreur CORS). */
  var dernierPhoton = 0, minuteriePhoton = null;
  Recherche.enregistrer({
    nom: "en ligne", priorite: 40,
    chercher: function (q, max) {
      if (!Carte.reglage("enLigne") || !navigator.onLine || normaliser(q).length < 3 || Recherche.analyserCoordonnees(q)) return Promise.resolve([]);
      if (controleurEnLigne) controleurEnLigne.abort();
      controleurEnLigne = new AbortController();
      var signal = controleurEnLigne.signal;
      var e = Carte.emprise();
      var bbox = e ? e.bbox.join(",") : "7.96,51.48,8.25,51.66";
      var c = carte.getCenter();
      var url = "https://photon.komoot.io/api/?q=" + encodeURIComponent(q) + "&limit=5&lang=fr&bbox=" + bbox +
                "&lat=" + c.lat.toFixed(4) + "&lon=" + c.lng.toFixed(4);
      var attente = Math.max(0, 1200 - (Date.now() - dernierPhoton));
      clearTimeout(minuteriePhoton);
      return new Promise(function (resolve) { minuteriePhoton = setTimeout(resolve, attente); }).then(function () {
        if (signal.aborted) return { features: [] };
        dernierPhoton = Date.now();
        return fetch(url, { signal: signal }).then(function (r) { return r.ok ? r.json() : { features: [] }; });
      })
        .then(function (gj) {
          return (gj.features || []).map(function (f) {
            var p = f.properties || {};
            var nom = p.name || ((p.housenumber ? p.housenumber + " " : "") + (p.street || "")).trim();
            if (!nom) return null;
            var detail = [p.postcode, p.city || p.town || p.village, p.osm_value && p.osm_key !== "place" ? p.osm_value.replace(/_/g, " ") : ""].filter(Boolean).join(" ");
            return { libelle: nom, detail: detail, type: "en ligne", lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
                     zoom: p.housenumber ? 18 : 15, adresse: nom + (detail ? ", " + detail : ""), score: 40 };
          }).filter(Boolean).slice(0, Math.min(max, 5));
        }).catch(function () { return []; });
    }
  });

  return {
    chercher: chercher,
    inverse: inverse,
    installe: installe,
    charger: charger,
    appliquerReglages: appliquerReglages,
    normaliser: normaliser
  };
})();
