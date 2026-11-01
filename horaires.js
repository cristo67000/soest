"use strict";
/* Horaires d'ouverture OpenStreetMap (syntaxe `opening_hours`) : état à
 * l'instant (ouvert / fermé / inconnu) et résumé hebdomadaire en français.
 * Moteur repris de strasbourg-eurometropole (musees.js), jours fériés de
 * Rhénanie-du-Nord-Westphalie.
 *
 * Seul un sous-ensemble est interprété ; dès qu'une règle sort de ce cadre
 * (semaines, n-ième dimanche, dates absolues à venir, vacances scolaires,
 * commentaire libre), on renonce à conclure et l'appelant affiche l'horaire
 * tel quel plutôt que d'annoncer une ouverture fausse. */
var Horaires = (function () {
  var JOURS_OSM = { Mo: 0, Tu: 1, We: 2, Th: 3, Fr: 4, Sa: 5, Su: 6 };
  var JOURS_FR = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
  var MOIS_OSM = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  var MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

  // ---------- jours fériés (Nordrhein-Westfalen) ----------
  /* Dimanche de Pâques, algorithme de Meeus/Jones/Butcher. */
  function paques(annee) {
    var a = annee % 19, b = Math.floor(annee / 100), c = annee % 100;
    var d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    var g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4), k = c % 4;
    var l = (32 + 2 * e + 2 * i - h - k) % 7;
    var m = Math.floor((a + 11 * h + 22 * l) / 451);
    var mois = Math.floor((h + l - 7 * m + 114) / 31);
    var jour = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(annee, mois - 1, jour);
  }

  var cacheFeries = {};

  /* NRW : Neujahr, Karfreitag, Ostermontag, Tag der Arbeit, Christi Himmelfahrt,
     Pfingstmontag, Fronleichnam, Tag der Deutschen Einheit, Allerheiligen,
     1. et 2. Weihnachtstag. */
  function feries(annee) {
    if (cacheFeries[annee]) return cacheFeries[annee];
    var p = paques(annee);
    function decale(jours) {
      var d = new Date(p.getTime());
      d.setDate(d.getDate() + jours);
      return d.getMonth() + "-" + d.getDate();
    }
    var liste = {};
    [[0, 1], [4, 1], [9, 3], [10, 1], [11, 25], [11, 26]].forEach(function (md) { liste[md[0] + "-" + md[1]] = true; });
    [-2, 1, 39, 50, 60].forEach(function (n) { liste[decale(n)] = true; });
    cacheFeries[annee] = liste;
    return liste;
  }

  function estFerie(date) {
    return !!feries(date.getFullYear())[date.getMonth() + "-" + date.getDate()];
  }

  // ---------- interprétation ----------
  function minutesDepuis(texte) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(texte.trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  /* Découpe un `opening_hours` en règles {specMois, specJours, specHeures}.
     `null` dès que la syntaxe dépasse le sous-ensemble reconnu. Les plages de
     mois (horaires d'été) sont reconnues ; une virgule suivie d'un nouveau
     groupe de mois ou de jours vaut séparateur de règle (fiches OSM qui
     enchaînent deux clauses sans point-virgule). */
  function analyserRegles(horaires, refDate) {
    if (!horaires) return null;
    var texte = horaires.trim();
    if (/["]/.test(texte)) return null;               // commentaire libre
    if (/^24\/7$/.test(texte)) return [{ specMois: "", specJours: "", specHeures: "24/7" }];
    var anneeCourante = (refDate || new Date()).getFullYear();

    var motifMois = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
    var regexMois = new RegExp("^((?:" + motifMois + "(?:-" + motifMois + ")?)(?:,\\s*" + motifMois + "(?:-" + motifMois + ")?)*)\\s*:?\\s+(.*)$");
    var motifJours = "(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)";
    var regexRegle = new RegExp("^((?:" + motifJours + "(?:-" + motifJours + ")?)(?:,\\s*" + motifJours + "(?:-" + motifJours + ")?)*)?\\s*(.*)$");
    var regexReprise = new RegExp("(?<=\\d{1,2}:\\d{2}),\\s*(?=" + motifMois + "(?:-" + motifMois + ")?[\\s:])", "g");
    var regexRepriseJours = new RegExp("(?<=\\d{1,2}:\\d{2}),\\s*(?=" + motifJours + "(?:[-,]|\\s))", "g");
    texte = texte.replace(regexReprise, ";").replace(regexRepriseJours, ";");

    var sortie = [];
    var morceaux = texte.split(";");
    for (var r = 0; r < morceaux.length; r++) {
      var regle = morceaux[r].trim();
      if (!regle) continue;
      // exception à date absolue : ignorée si toutes ses années sont passées,
      // sinon on renonce plutôt que de deviner
      if (/^\d{4}\b/.test(regle)) {
        var annees = (regle.match(/\d{4}/g) || []).map(Number);
        if (annees.length && annees.every(function (a) { return a < anneeCourante; })) continue;
        return null;
      }
      var specMois = "";
      var reste = regle;
      var mM = regexMois.exec(regle);
      if (mM) { specMois = mM[1].trim(); reste = mM[2].trim(); }
      if (/[:\[]/.test(reste.replace(/\d{1,2}:\d{2}/g, ""))) return null;   // semaines, n-ième jour, dates…
      var m = regexRegle.exec(reste);
      if (!m) return null;
      var specJours = (m[1] || "").trim();
      var specHeures = (m[2] || "").trim();
      if (specJours.split(",").some(function (b) { return b.trim() === "SH"; })) return null;   // vacances scolaires
      sortie.push({ specMois: specMois, specJours: specJours, specHeures: specHeures });
    }
    return sortie;
  }

  function moisConcerne(specMois, mois) {
    if (!specMois) return true;
    var blocs = specMois.split(",");
    for (var b = 0; b < blocs.length; b++) {
      var bornes = blocs[b].trim().split("-");
      var debut = MOIS_OSM[bornes[0]];
      if (debut === undefined) return false;
      if (bornes.length === 1) {
        if (mois === debut) return true;
      } else {
        var fin = MOIS_OSM[bornes[1]];
        if (fin === undefined) return false;
        if (fin >= debut ? (mois >= debut && mois <= fin) : (mois >= debut || mois <= fin)) return true;
      }
    }
    return false;
  }

  /* Intervalles d'ouverture [debut, fin] en minutes pour une date, ou null. */
  function intervalles(horaires, date) {
    var regles = analyserRegles(horaires, date);
    if (regles === null) return null;
    if (regles.length === 1 && regles[0].specHeures === "24/7") return [[0, 1440]];
    var jour = (date.getDay() + 6) % 7;
    var ferie = estFerie(date);
    var resultat = [];
    for (var r = 0; r < regles.length; r++) {
      var specMois = regles[r].specMois, specJours = regles[r].specJours, specHeures = regles[r].specHeures;
      if (!moisConcerne(specMois, date.getMonth())) continue;
      var concerne;
      if (!specJours) {
        concerne = true;
      } else {
        concerne = false;
        var blocs = specJours.split(",");
        for (var b = 0; b < blocs.length; b++) {
          var bloc = blocs[b].trim();
          if (bloc === "PH") { if (ferie) concerne = true; continue; }
          var bornes = bloc.split("-");
          var debut = JOURS_OSM[bornes[0]];
          if (debut === undefined) return null;
          if (bornes.length === 1) {
            if (jour === debut) concerne = true;
          } else {
            var fin = JOURS_OSM[bornes[1]];
            if (fin === undefined) return null;
            if (fin >= debut ? (jour >= debut && jour <= fin) : (jour >= debut || jour <= fin)) concerne = true;
          }
        }
      }
      if (!concerne) continue;
      if (/^(off|closed)$/i.test(specHeures)) { resultat = []; continue; }
      if (!specHeures) return null;
      var plages = specHeures.split(",");
      for (var p = 0; p < plages.length; p++) {
        var bornesH = plages[p].trim().split("-");
        if (bornesH.length !== 2) return null;
        var d1 = minutesDepuis(bornesH[0]), f1 = minutesDepuis(bornesH[1]);
        if (d1 === null || f1 === null) return null;
        if (f1 <= d1) f1 += 1440;     // plage passant minuit
        resultat.push([d1, f1]);
      }
    }
    resultat.sort(function (a, b) { return a[0] - b[0]; });
    return resultat;
  }

  // ---------- résumé lisible ----------
  function segmentJours(bloc) {
    if (bloc === "PH") return "les jours fériés";
    var bornes = bloc.split("-");
    if (bornes.length === 1) return "le " + JOURS_FR[JOURS_OSM[bornes[0]]];
    return "du " + JOURS_FR[JOURS_OSM[bornes[0]]] + " au " + JOURS_FR[JOURS_OSM[bornes[1]]];
  }
  function texteJours(specJours) {
    if (!specJours) return "tous les jours";
    return specJours.split(",").map(function (b) { return segmentJours(b.trim()); }).join(", ");
  }
  function deMois(mois) { return (/^[aeiouy]/.test(mois) ? "d'" : "de ") + mois; }   // « d'avril », « de mai »
  function segmentMois(bloc) {
    var bornes = bloc.split("-");
    if (bornes.length === 1) return "en " + MOIS_FR[MOIS_OSM[bornes[0]]];
    return deMois(MOIS_FR[MOIS_OSM[bornes[0]]]) + " à " + MOIS_FR[MOIS_OSM[bornes[1]]];
  }
  function texteMois(specMois) {
    return specMois.split(",").map(function (b) { return segmentMois(b.trim()); }).join(", ");
  }
  function texteQuand(specMois, specJours) {
    var jours = texteJours(specJours);
    return specMois ? texteMois(specMois) + ", " + jours : jours;
  }
  function majuscule(texte) { return texte.charAt(0).toUpperCase() + texte.slice(1); }
  /* « 17:00-25:00 » (jusqu'au lendemain 1 h) se lit « de 17h à 1h ». */
  function texteHeure(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    var h = parseInt(m[1], 10) % 24, mn = m[2];
    return h + "h" + (mn === "00" ? "" : mn);
  }

  /* Lignes « Du mardi au samedi : de 10h à 18h », ou null si on renonce. */
  function resume(horaires) {
    var regles = analyserRegles(horaires);
    if (regles === null) return null;
    if (regles.length === 1 && regles[0].specHeures === "24/7") return ["Ouvert 24 h/24, 7 jours sur 7"];
    var lignes = [];
    for (var r = 0; r < regles.length; r++) {
      var specMois = regles[r].specMois, specJours = regles[r].specJours, specHeures = regles[r].specHeures;
      if (/^(off|closed)$/i.test(specHeures)) { lignes.push("Fermé " + texteQuand(specMois, specJours)); continue; }
      if (!specHeures) return null;
      var plages = specHeures.split(",");
      var texteHeures = [];
      for (var p = 0; p < plages.length; p++) {
        var bornes = plages[p].trim().split("-");
        if (bornes.length !== 2) return null;
        var d = texteHeure(bornes[0]), f = texteHeure(bornes[1]);
        if (d === null || f === null) return null;
        texteHeures.push("de " + d + " à " + f);
      }
      lignes.push(majuscule(texteQuand(specMois, specJours)) + " : " + texteHeures.join(" et "));
    }
    return lignes;
  }

  // ---------- état à l'instant ----------
  function heure(minutes) {
    var m = ((minutes % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mn = m % 60;
    return h + "h" + (mn < 10 ? "0" : "") + mn;
  }

  /* {etat: "ouvert" | "ferme" | "inconnu", texte} */
  function etat(horaires, maintenant) {
    maintenant = maintenant || new Date();
    var plages = intervalles(horaires, maintenant);
    if (plages === null) return { etat: "inconnu", texte: "" };
    var minute = maintenant.getHours() * 60 + maintenant.getMinutes();
    // une plage codée la veille et passant minuit déborde sur ce matin
    var hier = new Date(maintenant.getTime() - 86400000);
    var plagesHier = intervalles(horaires, hier);
    if (plagesHier) {
      for (var h = 0; h < plagesHier.length; h++) {
        if (plagesHier[h][1] > 1440 && minute < plagesHier[h][1] - 1440) {
          var dureeHier = plagesHier[h][1] - plagesHier[h][0];
          return { etat: "ouvert", texte: dureeHier >= 1440 ? "ouvert 24 h/24" : "ferme à " + heure(plagesHier[h][1]) };
        }
      }
    }
    for (var i = 0; i < plages.length; i++) {
      if (minute >= plages[i][0] && minute < plages[i][1]) {
        var dureeVraie = plages[i][1] - plages[i][0];
        return { etat: "ouvert", texte: dureeVraie >= 1440 ? "ouvert 24 h/24" : "ferme à " + heure(plages[i][1]) };
      }
    }
    for (var j = 0; j < plages.length; j++) {
      if (plages[j][0] > minute) return { etat: "ferme", texte: "ouvre à " + heure(plages[j][0]) };
    }
    for (var d = 1; d <= 7; d++) {
      var suivant = new Date(maintenant.getTime() + d * 86400000);
      var p = intervalles(horaires, suivant);
      if (p && p.length) {
        return { etat: "ferme", texte: "ouvre " + (d === 1 ? "demain" : JOURS_FR[(suivant.getDay() + 6) % 7]) + " à " + heure(p[0][0]) };
      }
    }
    return { etat: "ferme", texte: "" };
  }

  return { etat: etat, resume: resume, intervalles: intervalles, estFerie: estFerie };
})();
