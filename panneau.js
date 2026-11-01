"use strict";
/* Panneau latéral unique (fiche, réglages, hors ligne, lieux…) et messages
   éphémères. Les modules y écrivent leur contenu dans le corps renvoyé par
   ouvrir() ; ouvrir un autre panneau remplace le précédent. */
var Panneau = (function () {
  var el = document.getElementById("fiche");
  var titre = document.getElementById("fiche-titre");
  var sousTitre = document.getElementById("fiche-sous-titre");
  var corps = document.getElementById("fiche-corps");
  var fermerBtn = document.getElementById("fiche-fermer");
  var zoneMessage = document.getElementById("message");
  var ecouteursFermeture = [];
  var identifiant = null;
  var minuterie = null;

  function ouvrir(t, st, id) {
    titre.textContent = t || "";
    sousTitre.textContent = st || "";
    sousTitre.hidden = !st;
    corps.textContent = "";
    corps.scrollTop = 0;
    identifiant = id || null;
    el.hidden = false;
    document.body.classList.add("panneau-ouvert");
    return corps;
  }

  function fermer() {
    if (el.hidden) return;
    el.hidden = true;
    document.body.classList.remove("panneau-ouvert");
    var id = identifiant;
    identifiant = null;
    ecouteursFermeture.forEach(function (fn) { try { fn(id); } catch (e) { console.error(e); } });
  }

  function estOuvert(id) {
    return !el.hidden && (id === undefined || identifiant === id);
  }

  function surFermeture(fn) { ecouteursFermeture.push(fn); }

  function message(texte, duree) {
    zoneMessage.textContent = texte;
    zoneMessage.hidden = false;
    clearTimeout(minuterie);
    minuterie = setTimeout(function () { zoneMessage.hidden = true; }, duree || 3500);
  }

  // ---------- petits constructeurs d'interface ----------
  function element(balise, classe, texte) {
    var e = document.createElement(balise);
    if (classe) e.className = classe;
    if (texte !== undefined && texte !== null) e.textContent = texte;
    return e;
  }

  function bouton(texte, onClick, classe) {
    var b = element("button", classe || "", texte);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function interrupteur(libelle, actif, onChange, aide) {
    var ligne = element("label", "interrupteur");
    var case_ = document.createElement("input");
    case_.type = "checkbox";
    case_.checked = !!actif;
    case_.addEventListener("change", function () { onChange(case_.checked); });
    var texte = element("span", "", libelle);
    ligne.appendChild(texte);
    if (aide) {
      var petit = element("small", "", aide);
      texte.appendChild(document.createElement("br"));
      texte.appendChild(petit);
    }
    ligne.appendChild(case_);
    return ligne;
  }

  /* Choix exclusif (boutons segmentés) : options = [[valeur, libellé], …]. */
  function choix(options, actuel, onChange, aide) {
    var bloc = element("div", "choix");
    var groupe = element("div", "choix-boutons");
    options.forEach(function (o) {
      var b = bouton(o[1], function () {
        Array.prototype.forEach.call(groupe.children, function (x) { x.setAttribute("aria-pressed", "false"); });
        b.setAttribute("aria-pressed", "true");
        onChange(o[0]);
      });
      b.setAttribute("aria-pressed", o[0] === actuel ? "true" : "false");
      groupe.appendChild(b);
    });
    bloc.appendChild(groupe);
    if (aide) bloc.appendChild(element("small", "", aide));
    return bloc;
  }

  fermerBtn.addEventListener("click", fermer);
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !el.hidden) fermer();
  });

  return {
    ouvrir: ouvrir,
    fermer: fermer,
    estOuvert: estOuvert,
    surFermeture: surFermeture,
    message: message,
    element: element,
    bouton: bouton,
    interrupteur: interrupteur,
    choix: choix
  };
})();
