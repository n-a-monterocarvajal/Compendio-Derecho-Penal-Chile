"""Prepara los datos del visor en línea a partir del PDF del último release.

Escribe en la carpeta de salida:
- compendio.pdf: copia exacta del PDF publicado (mismo SHA-256 que el release).
- datos/compendio.json: metadatos y marcadores (nivel, título, página).
- datos/texto.json: texto de cada página, para el buscador del visor.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

import pymupdf

ESPACIOS = re.compile(r"\s+")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--salida", required=True, type=Path)
    parser.add_argument("--tag", default="")
    parser.add_argument("--url-release", default="")
    parser.add_argument("--url-descarga", default="")
    parser.add_argument("--publicado", default="")
    args = parser.parse_args()

    datos = args.salida / "datos"
    datos.mkdir(parents=True, exist_ok=True)

    sha256 = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
    shutil.copyfile(args.pdf, args.salida / "compendio.pdf")

    documento = pymupdf.open(args.pdf)
    textos = [ESPACIOS.sub(" ", pagina.get_text("text")).strip() for pagina in documento]
    marcadores = [[nivel, titulo, pagina] for nivel, titulo, pagina in documento.get_toc(simple=True)]

    meta = {
        "titulo": documento.metadata.get("title") or args.pdf.stem,
        "archivo": args.pdf.name,
        "tag": args.tag,
        "url_release": args.url_release,
        "url_descarga": args.url_descarga,
        "publicado": args.publicado,
        "paginas": len(documento),
        "sha256": sha256,
        "marcadores": marcadores,
    }

    (datos / "compendio.json").write_text(
        json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    (datos / "texto.json").write_text(
        json.dumps(textos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(
        f"Visor preparado: {len(documento)} páginas, {len(marcadores)} marcadores, "
        f"{sum(map(len, textos)):,} caracteres de texto."
    )


if __name__ == "__main__":
    main()
