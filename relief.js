"use strict";
/* Relief : ombrage, terrain 3D, courbes de niveau et altitude d'un point, à
 * partir du paquet « relief » (tuiles d'altitude Terrarium WebP, zoom ≤ 13).
 * Les courbes sont calculées sur l'appareil par courbes-worker.js et servies à
 * MapLibre par le protocole courbes://{z}/{x}/{y}. */
var Relief = (function () {
  var CLE = "relief";
  var ZOOM_DEM = 13;
  var carte = Carte.instance();
  var INTERVALLES = { 10: [100, 500], 11: [50, 250], 12: [20, 100], 13: [20, 100], 14: [10, 50], 15: [10, 50] };
  var worker = null;
  var attentes = {};
  var compteur = 0;
  var cacheOctets = new Map();      // "z/x/y" -> Promise<ArrayBuffer|null>
  var cacheAltitudes = new Map();   // "z/x/y" -> Float32Array (fil principal, pour altitude())
  var disponible = false;

  function verifierDisponibilite() {
    return Stockage.etat(CLE).then(function (e) {
      disponible = e.installe || (navigator.onLine && !!e.publie);
      return disponible;
    }).catch(function () { disponible = false; return false; });
  }
  Stockage.surChangement(function (cle) { if (cle === CLE) { cacheOctets.clear(); cacheAltitudes.clear(); verifierDisponibilite().then(appliquerReglages); } });
  window.addEventListener("online", function () { verifierDisponibilite().then(appliquerReglages); });

  // ---------- octets des tuiles d'altitude ----------
  function octetsDem(z, x, y) {
    var cle = z + "/" + x + "/" + y;
    if (cacheOctets.has(cle)) return cacheOctets.get(cle);
    var n = 1 << z;
    if (x < 0 || y < 0 || x >= n || y >= n) return Promise.resolve(null);
    var p = Carte.archive(CLE).getZxy(z, x, y).then(function (r) { return r ? r.data : null; }).catch(function () { return null; });
    cacheOctets.set(cle, p);
    if (cacheOctets.size > 400) cacheOctets.delete(cacheOctets.keys().next().value);
    return p;
  }

  // ---------- protocole courbes:// ----------
  function demanderCourbes(z, x, y, signal) {
    if (!window.Worker || !window.OffscreenCanvas) return Promise.resolve(null);
    if (!worker) {
      worker = new Worker("courbes-worker.js");
      worker.onmessage = function (ev) {
        var a = attentes[ev.data.id];
        if (!a) return;
        delete attentes[ev.data.id];
        if (ev.data.erreur) a.reject(new Error(ev.data.erreur)); else a.resolve(ev.data.octets);
      };
    }
    var zd = Math.min(z, ZOOM_DEM);
    var px = x >> (z - zd), py = y >> (z - zd);
    var besoins = [[px, py], [px + 1, py], [px, py + 1], [px + 1, py + 1]];
    return Promise.all(besoins.map(function (b) { return octetsDem(zd, b[0], b[1]); })).then(function (octets) {
      if (!octets[0]) return null;
      if (signal && signal.aborted) return null;
      var dem = {};
      besoins.forEach(function (b, i) { dem[zd + "/" + b[0] + "/" + b[1]] = octets[i] ? octets[i].slice(0) : null; });
      var id = ++compteur;
      var iv = INTERVALLES[Math.min(Math.max(z, 10), 15)];
      return new Promise(function (resolve, reject) {
        attentes[id] = { resolve: resolve, reject: reject };
        worker.postMessage({ type: "courbes", id: id, z: z, x: x, y: y, zd: zd, dem: dem, intervalle: iv[0], index: iv[1] },
                           Object.keys(dem).map(function (k) { return dem[k]; }).filter(Boolean));
      });
    });
  }

  maplibregl.addProtocol("courbes", function (params, controleur) {
    var m = /^courbes:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) return Promise.reject(new Error("URL courbes:// invalide"));
    return demanderCourbes(+m[1], +m[2], +m[3], controleur && controleur.signal).then(function (octets) {
      return { data: octets || new Uint8Array() };
    });
  });

  // ---------- couches ----------
  function premiereCouche(m, regex) {
    var couches = m.getStyle().layers;
    for (var i = 0; i < couches.length; i++) if (regex.test(couches[i].id)) return couches[i].id;
    return undefined;
  }

  function poserCouches(m) {
    if (m.getSource("relief")) { appliquerReglages(); return; }
    var sombre = Carte.themeSombre();
    m.addSource("relief", {
      type: "raster-dem", tiles: ["soest://relief/{z}/{x}/{y}"], tileSize: 256, encoding: "terrarium",
      minzoom: 0, maxzoom: ZOOM_DEM, attribution: "Relief : Terrain Tiles, EU-DEM © Copernicus"
    });
    m.addSource("courbes", { type: "vector", tiles: ["courbes://{z}/{x}/{y}"], minzoom: 10, maxzoom: 15 });
    /* Sur le fond OpenStreetMap, l'ombrage passe sous l'eau et les routes ;
       sur la carte topographique (raster opaque posé au-dessus de tout le
       fond), il doit venir au-dessus d'elle : juste avant le repère des modules. */
    var surTopo = !!m.getLayer("topo");
    var avantEau = surTopo ? "reperes-modules" : (premiereCouche(m, /^water/) || premiereCouche(m, /^roads/));
    m.addLayer({
      id: "relief-ombrage", type: "hillshade", source: "relief", layout: { visibility: "none" },
      paint: { "hillshade-exaggeration": surTopo ? 0.22 : (sombre ? 0.45 : 0.32), "hillshade-shadow-color": sombre ? "#000000" : "#4a3f33",
               "hillshade-highlight-color": sombre ? "#6b7f8a" : "#ffffff", "hillshade-accent-color": sombre ? "#000" : "#5b4d3f",
               "hillshade-illumination-anchor": "map" }
    }, avantEau);
    var avantRoutes = surTopo ? "reperes-modules" : (premiereCouche(m, /^roads/) || premiereCouche(m, /^buildings/));
    var brun = sombre ? "#c9a27a" : "#8a5a2b";
    m.addLayer({
      id: "courbes-ligne", type: "line", source: "courbes", "source-layer": "courbes", layout: { visibility: "none", "line-join": "round" },
      paint: { "line-color": brun, "line-width": ["case", [">=", ["get", "niveau"], 1], 1.1, 0.55], "line-opacity": sombre ? 0.75 : 0.6 }
    }, avantRoutes);
    m.addLayer({
      id: "courbes-texte", type: "symbol", source: "courbes", "source-layer": "courbes", minzoom: 12,
      filter: [">=", ["get", "niveau"], 1],
      layout: { visibility: "none", "symbol-placement": "line", "text-field": ["to-string", ["get", "ele"]], "text-font": ["Noto Sans Regular"],
                "text-size": 10, "symbol-spacing": 320, "text-max-angle": 30, "text-rotation-alignment": "map", "text-padding": 6 },
      paint: { "text-color": brun, "text-halo-color": sombre ? "#1a1d20" : "#ffffff", "text-halo-width": 1.2 }
    }, avantRoutes);
    verifierDisponibilite().then(appliquerReglages);
  }
  Carte.surStyle(poserCouches);

  function appliquerReglages() {
    if (!carte.getLayer("relief-ombrage")) return;
    var ombrage = disponible && Carte.reglage("relief");
    var courbes = disponible && Carte.reglage("courbes") && !!window.OffscreenCanvas;
    var terrain = disponible && Carte.reglage("terrain3D");
    carte.setLayoutProperty("relief-ombrage", "visibility", ombrage ? "visible" : "none");
    carte.setLayoutProperty("courbes-ligne", "visibility", courbes ? "visible" : "none");
    carte.setLayoutProperty("courbes-texte", "visibility", courbes ? "visible" : "none");
    var actuel = carte.getTerrain();
    if (terrain && !actuel) {
      carte.setTerrain({ source: "relief", exaggeration: 1.25 });
      if (carte.getPitch() < 30) carte.easeTo({ pitch: 55, duration: 800 });
    } else if (!terrain && actuel) {
      carte.setTerrain(null);
    }
  }

  // ---------- altitude d'un point ----------
  function decoderPrincipal(cle, octets) {
    if (cacheAltitudes.has(cle)) return Promise.resolve(cacheAltitudes.get(cle));
    return createImageBitmap(new Blob([octets])).then(function (bmp) {
      var c = document.createElement("canvas");
      c.width = 256; c.height = 256;
      var g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      var d = g.getImageData(0, 0, 256, 256).data;
      var out = new Float32Array(65536);
      for (var i = 0, j = 0; i < 65536; i++, j += 4) out[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
      cacheAltitudes.set(cle, out);
      if (cacheAltitudes.size > 40) cacheAltitudes.delete(cacheAltitudes.keys().next().value);
      return out;
    });
  }
  function altitude(lon, lat) {
    var n = 1 << ZOOM_DEM;
    var fx = (lon + 180) / 360 * n;
    var latR = lat * Math.PI / 180;
    var fy = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
    var x = Math.floor(fx), y = Math.floor(fy);
    var cle = ZOOM_DEM + "/" + x + "/" + y;
    return verifierDisponibilite().then(function (ok) {
      if (!ok) return null;
      return octetsDem(ZOOM_DEM, x, y).then(function (octets) {
        if (!octets) return null;
        return decoderPrincipal(cle, octets).then(function (g) {
          var i = Math.min(255, Math.floor((fx - x) * 256)), j = Math.min(255, Math.floor((fy - y) * 256));
          var h = g[j * 256 + i];
          return h < -1000 ? null : h;
        });
      });
    }).catch(function () { return null; });
  }

  return { altitude: altitude, appliquerReglages: appliquerReglages, disponible: function () { return disponible; } };
})();
