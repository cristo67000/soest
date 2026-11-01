"use strict";
/* Stockage des gros paquets de données (fond de carte, contexte, relief, adresses).
 *
 * Chaque paquet est une archive PMTiles (ou un index binaire) répartie en
 * morceaux de 48 Mo listés dans data/version.json — GitHub refuse les fichiers
 * de plus de 100 Mo. La lecture se fait par plages d'octets :
 *   - paquet installé : morceaux écrits dans l'OPFS (Origin Private File
 *     System) par le worker telechargeur.js, lus ici par File.slice() ;
 *   - sinon : requêtes HTTP Range sur les morceaux publiés (GitHub Pages les
 *     accepte), c'est le mode « en ligne ».
 * Le Cache Storage est volontairement évité : il ne sait pas servir une plage
 * d'octets d'une entrée complète sans la recharger entièrement (piège rencontré
 * sur strasbourg-eurometropole). */
var Stockage = (function () {
  var versionPromesse = null;
  var instantanes = {};     // cle -> tableau de File (OPFS), par index de morceau
  var manifestes = {};      // cle -> manifeste OPFS (null si non installé), mis en cache
  var ouvriers = {};        // cle -> Worker de téléchargement en cours
  var ecouteurs = [];

  function support() {
    return !!(navigator.storage && navigator.storage.getDirectory && window.Worker);
  }

  // ---------- version.json ----------
  function version() {
    if (!versionPromesse) {
      versionPromesse = fetch("data/version.json", { cache: "no-cache" })
        .then(function (r) {
          if (!r.ok) throw new Error("version.json : HTTP " + r.status);
          return r.json();
        })
        .catch(function (e) {
          // Hors ligne sans service worker : la copie gardée à l'installation.
          return lireTexte(null, "version.json").then(function (t) {
            if (!t) throw e;
            return JSON.parse(t);
          });
        });
    }
    return versionPromesse;
  }

  function urlMorceau(v, chemin) {
    return new URL(chemin, v.base ? v.base : location.href).href;
  }

  // ---------- OPFS ----------
  function dossierPaquets(creer) {
    return navigator.storage.getDirectory().then(function (racine) {
      return racine.getDirectoryHandle("paquets", { create: !!creer });
    });
  }

  function dossierPaquet(cle, creer) {
    return dossierPaquets(creer).then(function (d) {
      return d.getDirectoryHandle(cle, { create: !!creer });
    });
  }

  function lireTexte(cle, nom) {
    if (!support()) return Promise.resolve(null);
    var p = cle ? dossierPaquet(cle, false) : dossierPaquets(false);
    return p.then(function (d) { return d.getFileHandle(nom); })
      .then(function (fh) { return fh.getFile(); })
      .then(function (f) { return f.text(); })
      .catch(function () { return null; });
  }

  /* Manifeste écrit par le worker une fois tous les morceaux présents.
     Son absence signifie « pas installé » ou « installation interrompue ». */
  function manifeste(cle) {
    if (manifestes[cle] !== undefined) return Promise.resolve(manifestes[cle]);
    return lireTexte(cle, "manifeste.json").then(function (t) {
      var m = null;
      try { m = t ? JSON.parse(t) : null; } catch (e) { m = null; }
      manifestes[cle] = m;
      return m;
    });
  }

  function fichiersOpfs(cle, m) {
    if (instantanes[cle]) return Promise.resolve(instantanes[cle]);
    return dossierPaquet(cle, false).then(function (d) {
      return Promise.all(m.morceaux.map(function (x) {
        return d.getFileHandle(x.nom).then(function (fh) { return fh.getFile(); });
      }));
    }).then(function (liste) {
      instantanes[cle] = liste;
      return liste;
    });
  }

  function oublier(cle) {
    delete instantanes[cle];
    delete manifestes[cle];
  }

  // ---------- état d'un paquet ----------
  /* { installe, octets, manifeste, perime } ; `perime` compare la somme de
     contrôle installée à celle publiée (nouvelle extraction OSM). */
  function etat(cle) {
    return Promise.all([version(), manifeste(cle)]).then(function (r) {
      var v = r[0], m = r[1];
      var publie = v.paquets[cle];
      if (!m || !publie) return { installe: false, octets: 0, manifeste: null, perime: false, publie: publie || null };
      return fichiersOpfs(cle, m).then(function (fichiers) {
        var complet = fichiers.every(function (f, i) { return f.size === m.morceaux[i].taille; });
        return {
          installe: complet,
          octets: complet ? m.taille : 0,
          manifeste: m,
          perime: complet && !!publie.sha256 && publie.sha256 !== m.sha256,
          publie: publie
        };
      }).catch(function () {
        return { installe: false, octets: 0, manifeste: null, perime: false, publie: publie };
      });
    });
  }

  function estime() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate().catch(function () { return null; });
  }

  function persister() {
    if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(false);
    return navigator.storage.persisted().then(function (deja) {
      return deja ? true : navigator.storage.persist();
    }).catch(function () { return false; });
  }

  // ---------- lecture par plages ----------
  function concatener(parties) {
    if (parties.length === 1) return parties[0];
    var total = 0;
    parties.forEach(function (p) { total += p.byteLength; });
    var sortie = new Uint8Array(total);
    var pos = 0;
    parties.forEach(function (p) { sortie.set(new Uint8Array(p), pos); pos += p.byteLength; });
    return sortie.buffer;
  }

  function lireHttp(url, debut, fin, signal) {
    // fin incluse ; un serveur qui ignore Range renvoie 200 et le fichier entier
    return fetch(url, { headers: { Range: "bytes=" + debut + "-" + fin }, signal: signal })
      .then(function (r) {
        if (r.status === 206) return r.arrayBuffer();
        if (r.status === 200) return r.arrayBuffer().then(function (b) { return b.slice(debut, fin + 1); });
        throw new Error("HTTP " + r.status + " sur " + url);
      });
  }

  /* Octets [debut, debut+longueur) du paquet `cle`, où qu'ils soient. */
  function lire(cle, debut, longueur, signal) {
    return Promise.all([version(), etat(cle)]).then(function (r) {
      var v = r[0], e = r[1];
      var p = v.paquets[cle];
      if (!p) throw new Error("paquet inconnu : " + cle);
      var tm = p.taille_morceau;
      var fin = Math.min(debut + longueur, p.taille); // exclue
      if (fin <= debut) return new ArrayBuffer(0);
      var taches = [];
      for (var i = Math.floor(debut / tm); i * tm < fin; i++) {
        var a = Math.max(debut, i * tm) - i * tm;
        var b = Math.min(fin, (i + 1) * tm) - i * tm; // exclue
        if (e.installe) {
          taches.push(fichiersOpfs(cle, e.manifeste).then((function (idx, a, b) {
            return function (fichiers) { return fichiers[idx].slice(a, b).arrayBuffer(); };
          })(i, a, b)));
        } else {
          taches.push(lireHttp(urlMorceau(v, p.morceaux[i]), a, b - 1, signal));
        }
      }
      return Promise.all(taches).then(concatener);
    });
  }

  /* Source au sens de pmtiles.js : getKey() + getBytes(). La clé change avec
     l'état installé/en ligne pour que pmtiles.js oublie ses répertoires. */
  function sourcePmtiles(cle) {
    var cleCache = cle + ":" + Date.now();
    return {
      getKey: function () { return cleCache; },
      getBytes: function (debut, longueur, signal) {
        return lire(cle, debut, longueur, signal).then(function (data) { return { data: data }; });
      }
    };
  }

  // ---------- installation / suppression ----------
  function prevenir(cle) {
    ecouteurs.forEach(function (fn) { try { fn(cle); } catch (e) { console.error(e); } });
  }

  function surChangement(fn) { ecouteurs.push(fn); }

  /* Télécharge tous les morceaux du paquet dans l'OPFS (avec reprise si une
     installation précédente a été interrompue). onProgress(recu, total). */
  function installer(cle, onProgress) {
    if (!support()) return Promise.reject(new Error("navigateur sans stockage de fichiers (OPFS)"));
    if (ouvriers[cle]) return Promise.reject(new Error("téléchargement déjà en cours"));
    return version().then(function (v) {
      var p = v.paquets[cle];
      if (!p) throw new Error("paquet inconnu : " + cle);
      oublier(cle);
      return persister().then(function () {
        return new Promise(function (resolve, reject) {
          var w = new Worker("telechargeur.js");
          ouvriers[cle] = w;
          w.onmessage = function (ev) {
            var m = ev.data;
            if (m.type === "progression") { if (onProgress) onProgress(m.recu, m.total); }
            else if (m.type === "termine") { fin(); resolve(); }
            else if (m.type === "erreur") { fin(); reject(Object.assign(new Error(m.message), { annule: !!m.annule })); }
          };
          w.onerror = function (ev) { fin(); reject(new Error(ev.message || "erreur du worker")); };
          function fin() { w.terminate(); delete ouvriers[cle]; oublier(cle); prevenir(cle); }
          w.postMessage({
            type: "installer",
            cle: cle,
            morceaux: p.morceaux.map(function (chemin, i) {
              var derniere = i === p.morceaux.length - 1;
              return {
                nom: chemin.split("/").pop(),
                url: urlMorceau(v, chemin),
                taille: derniere ? p.taille - i * p.taille_morceau : p.taille_morceau
              };
            }),
            manifeste: {
              cle: cle, taille: p.taille, sha256: p.sha256 || null, osm: p.osm || null,
              source: p.source || null, installe_le: new Date().toISOString(),
              morceaux: p.morceaux.map(function (chemin, i) {
                var derniere = i === p.morceaux.length - 1;
                return { nom: chemin.split("/").pop(), taille: derniere ? p.taille - i * p.taille_morceau : p.taille_morceau };
              })
            },
            versionTexte: JSON.stringify(v)
          });
        });
      });
    });
  }

  function annuler(cle) {
    if (ouvriers[cle]) ouvriers[cle].postMessage({ type: "annuler" });
  }

  function supprimer(cle) {
    if (!support()) return Promise.resolve();
    oublier(cle);
    return dossierPaquets(false).then(function (d) {
      return d.removeEntry(cle, { recursive: true });
    }).catch(function () {}).then(function () { prevenir(cle); });
  }

  function enCours(cle) { return !!ouvriers[cle]; }

  return {
    support: support,
    version: version,
    etat: etat,
    estime: estime,
    lire: lire,
    sourcePmtiles: sourcePmtiles,
    installer: installer,
    annuler: annuler,
    supprimer: supprimer,
    enCours: enCours,
    surChangement: surChangement
  };
})();
