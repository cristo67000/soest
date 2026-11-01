"use strict";
/* Enregistrement du service worker et panneau « Hors ligne » : installation,
 * mise à jour et suppression des paquets de données (stockage.js). Le reste
 * de l'application (code, styles, glyphes, sprites) est pré-caché par sw.js
 * à l'installation. */
var Pwa = (function () {
  var GROUPES = [
    { id: "carte", nom: "Fond de carte", cles: ["fond", "contexte"],
      description: "Rues, chemins, bâtiments, rivières et forêts de Soest et de ses environs (±10 km, OpenStreetMap), plus l'Europe dézoomée. Indispensable hors ligne." },
    { id: "topo", nom: "Carte topographique", cles: ["topo"],
      description: "Carte topographique officielle du Land (DTK10/25/50, Geobasis NRW) jusqu'au 1:10 000 : courbes de niveau, chemins, lieux-dits, bâtiments. Fond « Topo »." },
    { id: "relief", nom: "Relief", cles: ["relief"],
      description: "Altitudes (EU-DEM 25 m) pour l'ombrage, les courbes de niveau calculées et l'altitude d'un point." },
    { id: "adresses", nom: "Adresses", cles: ["adresses"],
      description: "Recherche d'adresses hors ligne (OpenStreetMap) et numéros de maison sur la carte." }
  ];
  var corpsOuvert = null;

  function enregistrerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js")
        .then(function (inscription) { if (window.MiseAJour) MiseAJour.surveiller(inscription); })
        .catch(function (e) { console.warn("service worker :", e.message); });
    });
  }

  function mo(octets) {
    if (octets >= 1e9) return (octets / 1e9).toFixed(2).replace(".", ",") + " Go";
    if (octets < 1e6) return (octets / 1e6).toFixed(1).replace(".", ",") + " Mo";   // « 0,3 Mo », pas « 0 Mo »
    return Math.round(octets / 1e6) + " Mo";
  }

  function etatGroupe(groupe, v) {
    var cles = groupe.cles.filter(function (c) { return v.paquets[c]; });
    return Promise.all(cles.map(function (c) { return Stockage.etat(c); })).then(function (etats) {
      var taille = 0, installes = 0, perime = false, enCours = false;
      cles.forEach(function (c, i) {
        taille += v.paquets[c].taille;
        if (etats[i].installe) installes++;
        if (etats[i].perime) perime = true;
        if (Stockage.enCours(c)) enCours = true;
      });
      return { cles: cles, taille: taille, complet: cles.length > 0 && installes === cles.length,
               partiel: installes > 0 && installes < cles.length, perime: perime, enCours: enCours,
               osm: cles.length ? v.paquets[cles[0]].osm : "" };
    });
  }

  function installerGroupe(groupe, etat, bloc) {
    var barre = bloc.querySelector(".progression");
    var remplissage = barre.firstChild;
    var texteEtat = bloc.querySelector(".etat");
    var actions = bloc.querySelector(".actions");
    actions.textContent = "";
    barre.hidden = false;
    remplissage.style.width = "0%";
    var total = etat.taille, cumul = 0;
    actions.appendChild(Panneau.bouton("Annuler", function () {
      etat.cles.forEach(function (c) { Stockage.annuler(c); });
    }, "secondaire"));

    function suivant(i) {
      if (i >= etat.cles.length) return Promise.resolve();
      var cle = etat.cles[i];
      return Stockage.etat(cle).then(function (e) {
        if (e.installe && !e.perime) { cumul += e.publie.taille; return suivant(i + 1); }
        var base = cumul;
        return Stockage.installer(cle, function (recu, totalPaquet) {
          var pct = total ? Math.round(((base + recu) / total) * 100) : 0;
          remplissage.style.width = pct + "%";
          texteEtat.textContent = "Téléchargement… " + mo(base + recu) + " / " + mo(total) + " (" + pct + " %)";
        }).then(function () { cumul += e.publie.taille; return suivant(i + 1); });
      });
    }
    texteEtat.textContent = "Téléchargement…";
    texteEtat.className = "etat";
    suivant(0).then(function () {
      Panneau.message(groupe.nom + " : installé pour le hors ligne");
      rafraichir();
    }).catch(function (e) {
      texteEtat.textContent = e.annule ? "Téléchargement interrompu : il reprendra là où il s'est arrêté." : "Échec : " + e.message;
      texteEtat.className = "etat alerte";
      barre.hidden = true;
      actions.textContent = "";
      actions.appendChild(Panneau.bouton(e.annule ? "Reprendre" : "Réessayer", function () { installerGroupe(groupe, etat, bloc); }, "primaire"));
      if (!e.annule) actions.appendChild(Panneau.bouton("Supprimer", function () { supprimerGroupe(etat); }, "danger"));
    });
  }

  function supprimerGroupe(etat) {
    Promise.all(etat.cles.map(function (c) { return Stockage.supprimer(c); })).then(rafraichir);
  }

  function blocGroupe(groupe, etat) {
    var el = Panneau.element;
    var bloc = el("div", "paquet");
    var titre = el("div", "titre");
    titre.appendChild(el("span", "", groupe.nom));
    titre.appendChild(el("span", "note", mo(etat.taille)));
    bloc.appendChild(titre);
    bloc.appendChild(el("p", "note", groupe.description));
    var texteEtat = el("div", "etat");
    bloc.appendChild(texteEtat);
    var barre = el("div", "progression");
    barre.hidden = true;
    barre.appendChild(document.createElement("div"));
    bloc.appendChild(barre);
    var actions = el("div", "actions");
    bloc.appendChild(actions);

    if (etat.complet && !etat.perime) {
      texteEtat.textContent = "Installé, disponible hors ligne" + (etat.osm ? " (données du " + etat.osm + ")" : "") + ".";
      texteEtat.className = "etat ok";
      actions.appendChild(Panneau.bouton("Supprimer", function () { supprimerGroupe(etat); }, "danger"));
    } else if (etat.complet && etat.perime) {
      texteEtat.textContent = "Installé, mais une version plus récente est disponible.";
      texteEtat.className = "etat alerte";
      actions.appendChild(Panneau.bouton("Mettre à jour", function () { installerGroupe(groupe, etat, bloc); }, "primaire"));
      actions.appendChild(Panneau.bouton("Supprimer", function () { supprimerGroupe(etat); }, "danger"));
    } else {
      texteEtat.textContent = etat.partiel ? "Installation incomplète." : "Non installé : nécessite le réseau.";
      actions.appendChild(Panneau.bouton(etat.partiel ? "Terminer l'installation" : "Installer", function () { installerGroupe(groupe, etat, bloc); }, "primaire"));
      if (etat.partiel) actions.appendChild(Panneau.bouton("Supprimer", function () { supprimerGroupe(etat); }, "danger"));
    }
    return bloc;
  }

  var jetonRafraichissement = 0;

  function rafraichir() {
    if (!corpsOuvert || !Panneau.estOuvert("horsligne")) return;
    var corps = corpsOuvert;
    var jeton = ++jetonRafraichissement; // deux rafraîchissements concurrents (fond puis contexte) : seul le dernier écrit
    corps.textContent = "";
    var el = Panneau.element;
    if (!Stockage.support()) {
      corps.appendChild(el("p", "note", "Ce navigateur ne permet pas de stocker les cartes (pas de système de fichiers privé). Sur iPhone, utilisez Safari ; sur Android, Chrome ou Firefox."));
      return;
    }
    var intro = el("p", "note", "Les paquets s'enregistrent dans le navigateur, sur cet appareil. Sur iPhone, ajoutez l'application à l'écran d'accueil pour que Safari ne les efface pas.");
    corps.appendChild(intro);
    var attente = el("p", "note", "Vérification…");
    corps.appendChild(attente);
    Stockage.version().then(function (v) {
      var groupes = GROUPES.filter(function (g) { return g.cles.some(function (c) { return v.paquets[c]; }); });
      return Promise.all(groupes.map(function (g) { return etatGroupe(g, v); })).then(function (etats) {
        if (jeton !== jetonRafraichissement) return null;
        attente.remove();
        groupes.forEach(function (g, i) {
          corps.appendChild(blocGroupe(g, etats[i]));
        });
        return Stockage.estime();
      });
    }).then(function (e) {
      if (!e || jeton !== jetonRafraichissement) return;
      var p = el("p", "note");
      p.textContent = "Espace utilisé par l'application : " + mo(e.usage || 0) +
        (e.quota ? " · disponible : " + mo(e.quota) : "") + ".";
      corps.appendChild(p);
    }).catch(function (e) {
      attente.textContent = "Impossible de lire la liste des paquets : " + e.message;
    });
  }

  function ouvrirPanneau() {
    corpsOuvert = Panneau.ouvrir("Hors ligne", "Cartes et données sur l'appareil", "horsligne");
    rafraichir();
  }

  function initialiser() {
    enregistrerServiceWorker();
    document.getElementById("chip-horsligne").addEventListener("click", ouvrirPanneau);
    Stockage.surChangement(function () { rafraichir(); });
    // Premier lancement : si rien n'est installé, on le signale discrètement.
    if (Stockage.support()) {
      Stockage.etat("fond").then(function (e) {
        if (!e.installe && !localStorage.getItem("soest.avertiHorsLigne")) {
          localStorage.setItem("soest.avertiHorsLigne", "1");
          Panneau.message("Pour utiliser la carte sans réseau : bouton « Hors ligne »", 6000);
        }
      }).catch(function () {});
    }
  }

  return { initialiser: initialiser, ouvrirPanneau: ouvrirPanneau };
})();

Pwa.initialiser();
