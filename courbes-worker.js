"use strict";
/* Worker : courbes de niveau calculées à la volée à partir des tuiles
 * d'altitude Terrarium (paquet relief), renvoyées en tuiles vectorielles MVT.
 *
 * Pour une tuile demandée (z, x, y), le fil principal envoie les octets WebP de
 * la tuile d'altitude parente (zoom ≤ 13) et de ses voisines droite, basse et
 * diagonale : une grille 257 × 257 est échantillonnée (bilinéaire) jusqu'au
 * bord exclu compris, puis parcourue par « marching squares » pour chaque
 * seuil ; les segments sont chaînés en polylignes et encodés en protobuf MVT. */
var decodes = new Map();   // clé "z/x/y" -> Float32Array 256×256 (altitudes en m)
var ORDRE = [];
var LIMITE_CACHE = 160;

self.onmessage = function (ev) {
  var m = ev.data;
  if (m.type !== "courbes") return;
  traiter(m).then(function (octets) {
    self.postMessage({ id: m.id, octets: octets }, octets ? [octets] : []);
  }).catch(function (e) {
    self.postMessage({ id: m.id, erreur: (e && e.message) || String(e) });
  });
};

// ---------- décodage Terrarium ----------
function decoder(cle, octets) {
  if (decodes.has(cle)) return Promise.resolve(decodes.get(cle));
  if (!octets) return Promise.resolve(null);
  return createImageBitmap(new Blob([octets])).then(function (bmp) {
    var c = new OffscreenCanvas(256, 256);
    var g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    var d = g.getImageData(0, 0, 256, 256).data;
    var out = new Float32Array(256 * 256);
    for (var i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
    }
    decodes.set(cle, out);
    ORDRE.push(cle);
    if (ORDRE.length > LIMITE_CACHE) decodes.delete(ORDRE.shift());
    return out;
  }).catch(function () { return null; });
}

// ---------- échantillonnage ----------
function traiter(m) {
  var z = m.z, x = m.x, y = m.y, zd = m.zd;
  var cles = Object.keys(m.dem);
  return Promise.all(cles.map(function (k) { return decoder(k, m.dem[k]); })).then(function (grilles) {
    var dem = {};
    cles.forEach(function (k, i) { dem[k] = grilles[i]; });
    var s = 1 << (z - zd);
    var px = x >> (z - zd), py = y >> (z - zd);
    var w = 256 / s;                       // largeur de la fenêtre dans la tuile parente
    var ox = (x - px * s) * w, oy = (y - py * s) * w;
    var base = dem[zd + "/" + px + "/" + py];
    if (!base) return null;
    var droite = dem[zd + "/" + (px + 1) + "/" + py] || null;
    var bas = dem[zd + "/" + px + "/" + (py + 1)] || null;
    var diag = dem[zd + "/" + (px + 1) + "/" + (py + 1)] || null;

    function pixel(i, j) { // i colonne, j ligne, en pixels de la tuile parente, peut déborder à droite/en bas
      var t = base, ii = i, jj = j;
      if (i >= 256 && j >= 256) { t = diag || bas || droite || base; ii = t === diag || t === droite ? i - 256 : 255; jj = t === diag || t === bas ? j - 256 : 255; }
      else if (i >= 256) { t = droite || base; ii = droite ? i - 256 : 255; }
      else if (j >= 256) { t = bas || base; jj = bas ? j - 256 : 255; }
      if (ii > 255) ii = 255;
      if (jj > 255) jj = 255;
      if (ii < 0) ii = 0;
      if (jj < 0) jj = 0;
      return t[jj * 256 + ii];
    }
    var N = 256;
    var G = new Float32Array((N + 1) * (N + 1));
    var pas = w / N;
    var vmin = Infinity, vmax = -Infinity;
    for (var r = 0; r <= N; r++) {
      var v = oy + r * pas - 0.5;          // centres de pixels à +0,5
      var j0 = Math.floor(v), fj = v - j0;
      for (var c = 0; c <= N; c++) {
        var u = ox + c * pas - 0.5;
        var i0 = Math.floor(u), fi = u - i0;
        var a = pixel(i0, j0), b = pixel(i0 + 1, j0), cc = pixel(i0, j0 + 1), dd = pixel(i0 + 1, j0 + 1);
        var h = a * (1 - fi) * (1 - fj) + b * fi * (1 - fj) + cc * (1 - fi) * fj + dd * fi * fj;
        G[r * (N + 1) + c] = h;
        if (h < vmin) vmin = h;
        if (h > vmax) vmax = h;
      }
    }
    var intervalle = m.intervalle, index = m.index;
    var lignes = [];
    if (vmax - vmin > 0.5) {
      var t0 = Math.ceil(vmin / intervalle) * intervalle;
      for (var t = t0; t <= vmax; t += intervalle) {
        if (t === 0) continue;
        var poly = isolignes(G, N, t);
        for (var k = 0; k < poly.length; k++) lignes.push({ ele: t, niveau: t % index === 0 ? 1 : 0, points: poly[k] });
      }
    }
    return encoderMvt(lignes, N);
  });
}

// ---------- marching squares ----------
function isolignes(G, N, seuil) {
  var W = N + 1;
  var segments = [];
  function interp(x0, y0, v0, x1, y1, v1) {
    var f = (seuil - v0) / (v1 - v0);
    return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
  }
  for (var r = 0; r < N; r++) {
    for (var c = 0; c < N; c++) {
      var tl = G[r * W + c], tr = G[r * W + c + 1], bl = G[(r + 1) * W + c], br = G[(r + 1) * W + c + 1];
      var code = (tl >= seuil ? 8 : 0) | (tr >= seuil ? 4 : 0) | (br >= seuil ? 2 : 0) | (bl >= seuil ? 1 : 0);
      if (code === 0 || code === 15) continue;
      var haut = (code & 8) !== (code & 4) >> 1 ? interp(c, r, tl, c + 1, r, tr) : null;
      var droite = ((code & 4) >> 2) !== ((code & 2) >> 1) ? interp(c + 1, r, tr, c + 1, r + 1, br) : null;
      var bas = ((code & 2) >> 1) !== (code & 1) ? interp(c, r + 1, bl, c + 1, r + 1, br) : null;
      var gauche = ((code & 8) >> 3) !== (code & 1) ? interp(c, r, tl, c, r + 1, bl) : null;
      switch (code) {
        case 1: case 14: segments.push([gauche, bas]); break;
        case 2: case 13: segments.push([bas, droite]); break;
        case 3: case 12: segments.push([gauche, droite]); break;
        case 4: case 11: segments.push([haut, droite]); break;
        case 5: { var centre = (tl + tr + bl + br) / 4; if (centre >= seuil) { segments.push([gauche, haut]); segments.push([bas, droite]); } else { segments.push([gauche, bas]); segments.push([haut, droite]); } break; }
        case 6: case 9: segments.push([haut, bas]); break;
        case 7: case 8: segments.push([gauche, haut]); break;
        case 10: { var centre2 = (tl + tr + bl + br) / 4; if (centre2 >= seuil) { segments.push([haut, droite]); segments.push([gauche, bas]); } else { segments.push([gauche, haut]); segments.push([bas, droite]); } break; }
      }
    }
  }
  return chainer(segments);
}

function cleDe(p) { return Math.round(p[0] * 64) + "," + Math.round(p[1] * 64); }

/* Chaîne les segments en polylignes (chaque extrémité relie au plus deux segments). */
function chainer(segments) {
  var parDebut = new Map(), parFin = new Map();
  segments.forEach(function (s, i) {
    var a = cleDe(s[0]), b = cleDe(s[1]);
    (parDebut.get(a) || parDebut.set(a, []).get(a)).push(i);
    (parFin.get(b) || parFin.set(b, []).get(b)).push(i);
  });
  var utilises = new Uint8Array(segments.length);
  var lignes = [];
  function prendre(map, cle) {
    var l = map.get(cle);
    if (!l) return -1;
    while (l.length) { var i = l.pop(); if (!utilises[i]) return i; }
    return -1;
  }
  for (var i = 0; i < segments.length; i++) {
    if (utilises[i]) continue;
    utilises[i] = 1;
    var pts = [segments[i][0], segments[i][1]];
    // vers l'avant
    var suivant;
    while ((suivant = prendre(parDebut, cleDe(pts[pts.length - 1]))) !== -1) { utilises[suivant] = 1; pts.push(segments[suivant][1]); if (pts.length > 5000) break; }
    while ((suivant = prendre(parFin, cleDe(pts[pts.length - 1]))) !== -1) { utilises[suivant] = 1; pts.push(segments[suivant][0]); if (pts.length > 5000) break; }
    // vers l'arrière
    var precedent;
    while ((precedent = prendre(parFin, cleDe(pts[0]))) !== -1) { utilises[precedent] = 1; pts.unshift(segments[precedent][0]); if (pts.length > 5000) break; }
    while ((precedent = prendre(parDebut, cleDe(pts[0]))) !== -1) { utilises[precedent] = 1; pts.unshift(segments[precedent][1]); if (pts.length > 5000) break; }
    lignes.push(pts);
  }
  return lignes;
}

// ---------- encodage MVT (protobuf écrit à la main) ----------
function Ecrivain() { this.buf = new Uint8Array(1 << 16); this.pos = 0; }
Ecrivain.prototype.reserver = function (n) {
  if (this.pos + n <= this.buf.length) return;
  var nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
  nb.set(this.buf.subarray(0, this.pos));
  this.buf = nb;
};
Ecrivain.prototype.varint = function (v) {
  this.reserver(10);
  while (v >= 0x80) { this.buf[this.pos++] = (v & 0x7f) | 0x80; v = Math.floor(v / 128); }
  this.buf[this.pos++] = v;
};
Ecrivain.prototype.octets = function (champ, u8) {
  this.varint((champ << 3) | 2);
  this.varint(u8.length);
  this.reserver(u8.length);
  this.buf.set(u8, this.pos);
  this.pos += u8.length;
};
Ecrivain.prototype.chaine = function (champ, s) { this.octets(champ, new TextEncoder().encode(s)); };
Ecrivain.prototype.entier = function (champ, v) { this.varint((champ << 3) | 0); this.varint(v); };
Ecrivain.prototype.resultat = function () { return this.buf.slice(0, this.pos); };

function zigzag(n) { return (n << 1) ^ (n >> 31); }

function encoderMvt(lignes, N) {
  if (!lignes.length) return null;
  var EXTENT = 4096, echelle = EXTENT / N;
  var cles = ["ele", "niveau"];
  var valeurs = [], indexValeurs = new Map();
  function valeur(v) {
    if (indexValeurs.has(v)) return indexValeurs.get(v);
    var w = new Ecrivain();
    w.entier(4, v); // int_value
    valeurs.push(w.resultat());
    indexValeurs.set(v, valeurs.length - 1);
    return valeurs.length - 1;
  }
  var couche = new Ecrivain();
  couche.entier(15, 2);
  couche.chaine(1, "courbes");
  lignes.forEach(function (l, idx) {
    var pts = l.points;
    if (pts.length < 2) return;
    var f = new Ecrivain();
    f.entier(1, idx + 1);
    var tags = new Ecrivain();
    tags.varint(0); tags.varint(valeur(l.ele)); tags.varint(1); tags.varint(valeur(l.niveau));
    f.octets(2, tags.resultat());
    f.entier(3, 2); // LINESTRING
    var g = new Ecrivain();
    var cx = 0, cy = 0;
    var coords = [];
    var dernierX = null, dernierY = null;
    for (var i = 0; i < pts.length; i++) {
      var X = Math.round(pts[i][0] * echelle), Y = Math.round(pts[i][1] * echelle);
      if (X === dernierX && Y === dernierY) continue;
      coords.push([X, Y]); dernierX = X; dernierY = Y;
    }
    if (coords.length < 2) return;
    g.varint((1 & 0x7) | (1 << 3));
    g.varint(zigzag(coords[0][0] - cx)); g.varint(zigzag(coords[0][1] - cy));
    cx = coords[0][0]; cy = coords[0][1];
    g.varint((2 & 0x7) | ((coords.length - 1) << 3));
    for (var k = 1; k < coords.length; k++) {
      g.varint(zigzag(coords[k][0] - cx)); g.varint(zigzag(coords[k][1] - cy));
      cx = coords[k][0]; cy = coords[k][1];
    }
    f.octets(4, g.resultat());
    couche.octets(2, f.resultat());
  });
  cles.forEach(function (k) { couche.chaine(3, k); });
  valeurs.forEach(function (v) { couche.octets(4, v); });
  couche.entier(5, EXTENT);
  var tuile = new Ecrivain();
  tuile.octets(3, couche.resultat());
  var sortie = tuile.resultat();
  return sortie.buffer.slice(sortie.byteOffset, sortie.byteOffset + sortie.byteLength);
}
