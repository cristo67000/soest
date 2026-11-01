# -*- coding: utf-8 -*-
"""Icônes PWA (icons/icon-*.png) et image d'aperçu pour le partage.

Motif : le Wallring de Soest — l'anneau presque complet des remparts médiévaux
qui enserre la vieille ville — dessiné en clair sur le vert du grès vert
(Grünsandstein) dont la ville est bâtie (accent #2e7d4f), avec une rue qui
traverse l'anneau et le repère orange des lieux personnels. Polygones Pillow,
sans photo ni police : zéro build.
"""
import math
import pathlib
from PIL import Image, ImageDraw

RACINE = pathlib.Path(__file__).resolve().parent.parent
DOSSIER = RACINE / "icons"
FOND = (46, 125, 79, 255)
CLAIR = (226, 241, 230, 255)
ORANGE = (234, 88, 12, 255)
BLANC = (255, 255, 255, 255)


def wallring(dessin, cx, cy, r, epaisseur, ouverture_deg=28):
    """Anneau des remparts avec une brèche (la porte) en bas à droite."""
    debut = 60 + ouverture_deg / 2
    fin = 60 - ouverture_deg / 2 + 360
    dessin.arc([cx - r, cy - r, cx + r, cy + r], start=debut, end=fin, fill=CLAIR, width=int(epaisseur))
    # tourelles : trois pastilles sur l'anneau
    for angle in (200, 290, 345):
        a = math.radians(angle)
        px, py = cx + math.cos(a) * r, cy + math.sin(a) * r
        rr = epaisseur * 0.95
        dessin.ellipse([px - rr, py - rr, px + rr, py + rr], fill=CLAIR)


def rue(dessin, cx, cy, r, largeur):
    """Rue qui traverse la ville du sud-ouest à la porte."""
    pts = [(cx - r * 0.95, cy + r * 0.55), (cx - r * 0.3, cy + r * 0.15), (cx + r * 0.25, cy + r * 0.2), (cx + r * 0.9, cy + r * 0.78)]
    dessin.line(pts, fill=CLAIR, width=int(largeur), joint="curve")


def repere(dessin, cx, cy, r):
    """Goutte de repère : cercle + pointe, disque blanc au centre."""
    dessin.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ORANGE)
    dessin.polygon([(cx - r * 0.72, cy + r * 0.68), (cx + r * 0.72, cy + r * 0.68), (cx, cy + r * 1.9)], fill=ORANGE)
    dessin.ellipse([cx - r * 0.42, cy - r * 0.42, cx + r * 0.42, cy + r * 0.42], fill=BLANC)


def image(taille, marge_ratio, rayon_coins=None):
    img = Image.new("RGBA", (taille, taille), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rayon_coins:
        d.rounded_rectangle([0, 0, taille - 1, taille - 1], radius=rayon_coins, fill=FOND)
    else:
        d.rectangle([0, 0, taille, taille], fill=FOND)
    marge = taille * marge_ratio
    r = (taille - 2 * marge) / 2
    cx, cy = taille / 2, taille / 2
    rue(d, cx, cy, r, taille * 0.055)
    wallring(d, cx, cy, r, taille * 0.075)
    repere(d, cx + r * 0.05, cy - r * 0.25, taille * 0.11)
    return img


def apercu():
    """Image 1200×630 pour l'aperçu de lien (og:image)."""
    larg, haut = 1200, 630
    img = Image.new("RGBA", (larg, haut), FOND)
    d = ImageDraw.Draw(img)
    cx, cy, r = 600, 330, 250
    rue(d, cx, cy, r, 30)
    wallring(d, cx, cy, r, 40)
    for px, py in [(620, 260), (300, 150), (930, 420)]:
        repere(d, px, py, 34)
    return img


def main():
    DOSSIER.mkdir(exist_ok=True)
    image(192, 0.16, rayon_coins=38).save(DOSSIER / "icon-192.png")
    image(512, 0.16, rayon_coins=100).save(DOSSIER / "icon-512.png")
    image(512, 0.28).save(DOSSIER / "icon-maskable-512.png")   # zone sûre : marge généreuse
    apercu().convert("RGB").save(DOSSIER / "apercu-1200x630.png", optimize=True)
    print("Icônes écrites dans", DOSSIER)


if __name__ == "__main__":
    main()
