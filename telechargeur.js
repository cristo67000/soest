"use strict";
/* Worker de téléchargement des paquets vers l'OPFS.
 *
 * Seul un worker dédié peut ouvrir un fichier OPFS en écriture synchrone
 * (createSyncAccessHandle), ce qui est aussi la seule voie commune à Chrome,
 * Firefox et Safari. Chaque morceau est écrit à sa place ; si une installation
 * a été interrompue, on reprend là où le fichier s'arrête (requête Range).
 * Le manifeste n'est écrit qu'à la toute fin : tant qu'il manque, le paquet
 * est considéré comme absent par stockage.js. */
var controleur = null;

self.onmessage = function (ev) {
  var m = ev.data;
  if (m.type === "installer") installer(m);
  else if (m.type === "annuler" && controleur) controleur.abort();
};

function ecrireTexte(dossier, nom, texte) {
  return dossier.getFileHandle(nom, { create: true }).then(function (fh) {
    return fh.createSyncAccessHandle();
  }).then(function (h) {
    try {
      h.truncate(0);
      h.write(new TextEncoder().encode(texte), { at: 0 });
      h.flush();
    } finally {
      h.close();
    }
  });
}

async function installer(m) {
  controleur = new AbortController();
  var signal = controleur.signal;
  try {
    var racine = await navigator.storage.getDirectory();
    var paquets = await racine.getDirectoryHandle("paquets", { create: true });
    var dossier = await paquets.getDirectoryHandle(m.cle, { create: true });
    try { await dossier.removeEntry("manifeste.json"); } catch (e) { /* absent */ }

    var total = 0, recu = 0, dernierEnvoi = 0;
    m.morceaux.forEach(function (x) { total += x.taille; });
    function progression(force) {
      var t = Date.now();
      if (force || t - dernierEnvoi > 150) {
        dernierEnvoi = t;
        self.postMessage({ type: "progression", recu: recu, total: total });
      }
    }

    // Morceaux d'une version précédente qui ne sont plus listés : supprimés.
    var attendus = {};
    m.morceaux.forEach(function (x) { attendus[x.nom] = true; });
    for await (var entree of dossier.keys()) {
      if (!attendus[entree] && entree !== "manifeste.json") {
        try { await dossier.removeEntry(entree); } catch (e) { /* tant pis */ }
      }
    }

    for (var i = 0; i < m.morceaux.length; i++) {
      var morceau = m.morceaux[i];
      var fh = await dossier.getFileHandle(morceau.nom, { create: true });
      var h = await fh.createSyncAccessHandle();
      try {
        var taille = h.getSize();
        if (taille > morceau.taille) { h.truncate(0); taille = 0; }
        recu += taille;
        if (taille < morceau.taille) {
          var entetes = taille > 0 ? { Range: "bytes=" + taille + "-" } : {};
          var r = await fetch(morceau.url, { headers: entetes, signal: signal, cache: "no-store" });
          if (!r.ok) throw new Error("HTTP " + r.status + " sur " + morceau.nom);
          if (r.status !== 206 && taille > 0) {
            // le serveur a ignoré la reprise : on repart du début de ce morceau
            recu -= taille;
            h.truncate(0);
            taille = 0;
          }
          var lecteur = r.body.getReader();
          while (true) {
            var etape = await lecteur.read();
            if (etape.done) break;
            h.write(etape.value, { at: taille });
            taille += etape.value.byteLength;
            recu += etape.value.byteLength;
            progression(false);
          }
          h.flush();
        }
        if (h.getSize() !== morceau.taille) {
          throw new Error("taille inattendue pour " + morceau.nom + " (" + h.getSize() + " au lieu de " + morceau.taille + ")");
        }
      } finally {
        h.close();
      }
      progression(true);
    }

    await ecrireTexte(dossier, "manifeste.json", JSON.stringify(m.manifeste));
    if (m.versionTexte) {
      try { await ecrireTexte(paquets, "version.json", m.versionTexte); } catch (e) { /* facultatif */ }
    }
    self.postMessage({ type: "termine" });
  } catch (e) {
    self.postMessage({
      type: "erreur",
      message: (e && e.message) || String(e),
      annule: !!(e && e.name === "AbortError")
    });
  }
}
