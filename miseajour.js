"use strict";
/* La mise à jour, et le fait de la dire (repris de wortschatz/js/miseajour.js).
 *
 * Une application posée sur l'écran d'accueil ne se recharge jamais : le service
 * worker installe la version suivante en silence et, sans ce module, la
 * correction n'atteindrait personne. Ici : on surveille l'arrivée d'une version
 * (`updatefound` → état `installed`), on l'annonce par un bandeau, rien ne
 * bascule sans un clic (une navigation en cours ne doit pas être perdue), et on
 * revérifie au retour à l'écran, au plus une fois par quart d'heure. Le service
 * worker n'appelle `skipWaiting()` qu'à la réception du feu vert. */
var MiseAJour = (function () {
  var ENTRE_DEUX_VERIFICATIONS = 15 * 60 * 1000;
  var PATIENCE = 3000;
  var enregistrement = null;
  var elements = null;
  var versionActive = null;
  var derniereVerification = 0;
  var rechargementDemande = false;
  var ecarte = false;

  function brancher() {
    if (elements) return;
    elements = {
      bandeau: document.getElementById("mise-a-jour"),
      appliquer: document.getElementById("b-mettre-a-jour"),
      plusTard: document.getElementById("b-maj-plus-tard")
    };
    if (!elements.bandeau) return;
    elements.appliquer.addEventListener("click", appliquer);
    elements.plusTard.addEventListener("click", function () { ecarte = true; masquer(); });
  }

  function annoncer() {
    brancher();
    if (!elements.bandeau || ecarte) return;
    elements.appliquer.disabled = false;
    elements.bandeau.hidden = false;
    requestAnimationFrame(function () { elements.bandeau.classList.add("visible"); });
  }

  function masquer() {
    if (!elements || !elements.bandeau) return;
    elements.bandeau.classList.remove("visible");
    elements.bandeau.hidden = true;
  }

  function enAttente() {
    return !!(enregistrement && enregistrement.waiting && navigator.serviceWorker.controller);
  }

  function appliquer() {
    rechargementDemande = true;
    if (elements && elements.appliquer) elements.appliquer.disabled = true;
    var attendant = enregistrement && enregistrement.waiting;
    if (!attendant) { location.reload(); return; }
    attendant.postMessage({ type: "passer-devant" });
    setTimeout(function () { if (rechargementDemande) location.reload(); }, PATIENCE);
  }

  function surveiller(inscription) {
    if (!inscription) return;
    enregistrement = inscription;
    derniereVerification = Date.now();
    brancher();
    demanderLaVersion();
    if (enAttente()) annoncer();
    inscription.addEventListener("updatefound", function () {
      var arrivant = inscription.installing;
      if (!arrivant) return;
      arrivant.addEventListener("statechange", function () {
        if (arrivant.state === "installed" && navigator.serviceWorker.controller) annoncer();
      });
    });
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (rechargementDemande) location.reload();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") verifier();
    });
  }

  /* 'prete' | 'en-cours' | 'a-jour' | 'echec' | 'sans-service-worker' | 'trop-tot' */
  function verifier(force) {
    if (!enregistrement) return Promise.resolve("sans-service-worker");
    if (force) ecarte = false;
    if (!force) {
      var t = Date.now();
      if (t - derniereVerification < ENTRE_DEUX_VERIFICATIONS) return Promise.resolve("trop-tot");
      if (navigator.onLine === false) return Promise.resolve("trop-tot");
      derniereVerification = t;
    }
    return enregistrement.update().then(function () {
      if (enAttente()) { if (force) annoncer(); return "prete"; }
      if (enregistrement.installing) return "en-cours";
      return "a-jour";
    }).catch(function () { return "echec"; });
  }

  function demanderLaVersion() {
    var actif = navigator.serviceWorker.controller;
    if (!actif) return;
    var canal = new MessageChannel();
    canal.port1.onmessage = function (e) { if (e.data && e.data.version) versionActive = e.data.version; };
    actif.postMessage({ type: "version" }, [canal.port2]);
  }

  return { surveiller: surveiller, verifier: verifier, appliquer: appliquer, version: function () { return versionActive; } };
})();
