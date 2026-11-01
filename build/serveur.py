# -*- coding: utf-8 -*-
"""Serveur de développement avec support des requêtes Range (HTTP 206).

Indispensable pour tester PMTiles en local : le http.server standard de
Python ignore l'en-tête Range, or pmtiles.js lit le fichier par plages.
Usage : python build/serveur.py [port]
"""
import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class RangeHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        self.range = None
        entete = self.headers.get("Range")
        if entete:
            m = re.match(r"bytes=(\d+)-(\d*)$", entete.strip())
            if m:
                debut = int(m.group(1))
                fin = int(m.group(2)) if m.group(2) else None
                self.range = (debut, fin)

        chemin = self.translate_path(self.path)
        if self.range is None or os.path.isdir(chemin):
            return super().send_head()

        try:
            f = open(chemin, "rb")
        except OSError:
            self.send_error(404, "Fichier introuvable")
            return None

        taille = os.fstat(f.fileno()).st_size
        debut, fin = self.range
        if fin is None or fin >= taille:
            fin = taille - 1
        if debut >= taille:
            f.close()
            self.send_error(416, "Plage non satisfaisable")
            return None

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(chemin))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {debut}-{fin}/{taille}")
        self.send_header("Content-Length", str(fin - debut + 1))
        self.end_headers()
        f.seek(debut)
        self.longueur_restante = fin - debut + 1
        return f

    def copyfile(self, source, sortie):
        if self.range is None:
            return super().copyfile(source, sortie)
        restant = self.longueur_restante
        while restant > 0:
            bloc = source.read(min(65536, restant))
            if not bloc:
                break
            sortie.write(bloc)
            restant -= len(bloc)

    def end_headers(self):
        if self.range is None:
            self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8017
    handler = partial(RangeHandler, directory=RACINE)
    print(f"Serveur sur http://localhost:{port} (racine : {RACINE})")
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()


if __name__ == "__main__":
    main()
