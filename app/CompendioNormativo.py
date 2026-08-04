from __future__ import annotations

import argparse
import json
import re
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from pypdf import PdfReader, PdfWriter
from playwright.sync_api import sync_playwright

APP_DIR = Path(__file__).resolve().parent
BASE_DIR = APP_DIR.parent
WORK_DIR = BASE_DIR / "trabajo"
TMP_DIR = WORK_DIR / "descargas"
LOG_PATH = WORK_DIR / "ultimo_log.txt"
TMP_DIR.mkdir(parents=True, exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
}


def log(message: str) -> None:
    print(message, flush=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(message + "\n")


def safe_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", value).strip("_") or "archivo"


def output_name_from_base(base_name: str) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M_UTC")
    return f"{safe_name(base_name)}_{timestamp}.pdf"


def assert_pdf(path: Path) -> None:
    if not path.exists() or path.stat().st_size < 1000:
        raise RuntimeError(f"El archivo no existe o es demasiado pequeño: {path}")
    with path.open("rb") as f:
        if f.read(5) != b"%PDF-":
            raise RuntimeError(f"No parece ser un PDF válido: {path}")


def read_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if not isinstance(data.get("fuentes"), list):
        raise ValueError("El archivo fuentes.json debe contener una lista llamada 'fuentes'.")
    return data


def save_debug(page, prefix: str, name: str) -> None:
    stamp = time.strftime("%Y%m%d_%H%M%S")
    base = TMP_DIR / f"debug_{prefix}_{safe_name(name)}_{stamp}"
    try:
        page.screenshot(path=str(base.with_suffix(".png")), full_page=True, timeout=15000)
    except Exception:
        pass
    try:
        base.with_suffix(".html").write_text(page.content(), encoding="utf-8", errors="ignore")
    except Exception:
        pass


def session_from_context(context, referer: str) -> requests.Session:
    session = requests.Session()
    session.headers.update(HEADERS | {"Referer": referer})
    for cookie in context.cookies():
        session.cookies.set(cookie["name"], cookie["value"], domain=cookie.get("domain"), path=cookie.get("path", "/"))
    return session


def find_export_links(page) -> list[str]:
    return page.evaluate(
        r"""
        () => {
            const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch(e) { return null; } };
            const out = [];
            for (const a of Array.from(document.querySelectorAll('a[href]'))) {
                const href = a.href || a.getAttribute('href') || '';
                const text = [a.innerText || '', a.getAttribute('title') || '', a.getAttribute('aria-label') || '', a.outerHTML || ''].join(' ');
                const u = abs(href);
                if (!u) continue;
                if (/\/servicios\/Consulta\/Exportar/i.test(u) && /exportar_formato=pdf/i.test(u) && /radioExportar=Normas/i.test(u)) {
                    let score = 0;
                    if (/Descargar\s+PDF\s+de\s+esta\s+norma/i.test(text)) score += 1000;
                    if (/Descargar|download|fa-download/i.test(text)) score += 300;
                    out.push({u, score});
                }
            }
            return out.sort((a, b) => b.score - a.score).map(x => x.u).filter((x, i, arr) => arr.indexOf(x) === i);
        }
        """
    )


def click_download(page) -> None:
    selectors = [
        "a[title*='Descargar']", "button[title*='Descargar']", "[aria-label*='Descargar']",
        "a:has-text('Descargar')", "button:has-text('Descargar')", "a:has(i.fa-download)",
        "button:has(i.fa-download)", "a:has(.fa-download)", "button:has(.fa-download)",
    ]
    for selector in selectors:
        try:
            loc = page.locator(selector)
            for i in range(min(loc.count(), 12)):
                item = loc.nth(i)
                if item.is_visible(timeout=1000):
                    item.scroll_into_view_if_needed(timeout=5000)
                    item.click(timeout=5000, force=True)
                    page.wait_for_timeout(1000)
                    return
        except Exception:
            pass
    raise RuntimeError("No se encontró el botón de descarga de LeyChile.")


def click_sin_firma(page, out_path: Path) -> bool:
    responses = []
    downloads = []
    page.context.on("response", lambda resp: responses.append(resp))
    page.on("download", lambda download: downloads.append(download))
    selectors = ["button:has-text('SIN FIRMA')", "a:has-text('SIN FIRMA')", "[role='button']:has-text('SIN FIRMA')", "input[value*='SIN FIRMA']", "input[value*='Sin firma']"]
    for selector in selectors:
        try:
            loc = page.locator(selector).first
            if loc.count() and loc.is_visible(timeout=1000):
                loc.click(timeout=10000, force=True)
                break
        except Exception:
            pass
    else:
        return False
    deadline = time.time() + 75
    while time.time() < deadline:
        if downloads:
            downloads[-1].save_as(str(out_path))
            assert_pdf(out_path)
            return True
        for response in reversed(responses):
            try:
                body = response.body()
                if body.startswith(b"%PDF-"):
                    out_path.write_bytes(body)
                    assert_pdf(out_path)
                    return True
            except Exception:
                pass
        page.wait_for_timeout(1000)
    return False


def download_bcn(context, source: dict[str, Any], out_path: Path) -> None:
    url = source.get("url") or f"https://www.bcn.cl/leychile/navegar?idNorma={source['id_norma']}"
    if out_path.exists():
        out_path.unlink()
    page = context.new_page()
    try:
        log(f"  Abriendo LeyChile: {url}")
        page.goto(url, wait_until="networkidle", timeout=180000)
        page.wait_for_timeout(1200)
        session = session_from_context(context, url)
        for href in find_export_links(page):
            log(f"  Descargando enlace real expuesto por LeyChile: {href}")
            response = session.get(href, timeout=180, allow_redirects=True)
            response.raise_for_status()
            if response.content.startswith(b"%PDF-") or "pdf" in (response.headers.get("content-type") or "").lower():
                out_path.write_bytes(response.content)
                assert_pdf(out_path)
                return
        log("  Buscando descarga mediante modal de LeyChile...")
        click_download(page)
        page.wait_for_timeout(1000)
        for href in find_export_links(page):
            response = session.get(href, timeout=180, allow_redirects=True)
            response.raise_for_status()
            if response.content.startswith(b"%PDF-"):
                out_path.write_bytes(response.content)
                assert_pdf(out_path)
                return
        if click_sin_firma(page, out_path):
            return
        save_debug(page, "bcn", out_path.stem)
        raise RuntimeError("No se pudo obtener el PDF desde LeyChile. Revise el artifact de diagnóstico.")
    finally:
        page.close()


def copy_outline(reader: PdfReader, writer: PdfWriter, outline: list[Any], parent: Any, page_offset: int, page_count: int) -> int:
    copied = 0
    last_added = None
    for item in outline:
        if isinstance(item, list):
            if last_added is not None:
                copied += copy_outline(reader, writer, item, last_added, page_offset, page_count)
            continue
        try:
            title = str(getattr(item, "title", None) or item.get("/Title", "")).strip()[:300]
            page_index = reader.get_destination_page_number(item)
        except Exception:
            last_added = None
            continue
        if 0 <= page_index < page_count:
            last_added = writer.add_outline_item(title or "Marcador", page_offset + page_index, parent=parent)
            copied += 1
    return copied


def merge(parts: list[tuple[str, Path]], out_path: Path, title: str) -> None:
    log("\nUniendo documentos y creando marcadores...")
    writer = PdfWriter()
    for marker, path in parts:
        reader = PdfReader(str(path))
        start_page = len(writer.pages)
        page_count = len(reader.pages)
        for page in reader.pages:
            writer.add_page(page)
        parent = writer.add_outline_item(marker, start_page)
        try:
            copied = copy_outline(reader, writer, reader.outline or [], parent, start_page, page_count)
            log(f"  Marcador principal: {marker}; marcadores internos: {copied}")
        except Exception:
            log(f"  Marcador principal: {marker}")
    writer.add_metadata({"/Title": title, "/Creator": "CompendioNormativo.py"})
    with out_path.open("wb") as f:
        writer.write(f)
    assert_pdf(out_path)


def resolve_output_path(args: argparse.Namespace, config: dict[str, Any]) -> Path:
    out_path = Path(args.salida) if args.salida else Path(output_name_from_base(str(config.get("salida_base") or "CompendioDerechoPenalChile")))
    return out_path if out_path.is_absolute() else BASE_DIR / out_path


def main() -> int:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    LOG_PATH.write_text("", encoding="utf-8")
    parser = argparse.ArgumentParser(description="Genera un compendio PDF de normas de Derecho Penal chileno.")
    parser.add_argument("--config", default=str(APP_DIR / "fuentes.json"), help="Ruta al archivo fuentes.json")
    parser.add_argument("--salida", default=None, help="Ruta opcional del PDF final")
    args = parser.parse_args()
    config = read_config(Path(args.config))
    out_path = resolve_output_path(args, config)
    log(f"Configuración: {Path(args.config).resolve()}")
    log(f"Salida: {out_path.resolve()}")
    parts: list[tuple[str, Path]] = []
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(WORK_DIR / "bcn_perfil_chromium"),
            headless=not bool(config.get("bcn_navegador_visible", False)),
            accept_downloads=True,
            viewport={"width": 1440, "height": 1400},
            user_agent=HEADERS["User-Agent"],
        )
        try:
            for index, source in enumerate(config["fuentes"], start=1):
                marker = source["marcador"]
                path = TMP_DIR / f"{source.get('archivo') or safe_name(marker)}.pdf"
                log(f"\n[{index}/{len(config['fuentes'])}] {marker}")
                if source["tipo"] != "bcn":
                    raise ValueError(f"Tipo de fuente no soportado: {source['tipo']}")
                download_bcn(context, source, path)
                parts.append((marker, path))
        finally:
            context.close()
    merge(parts, out_path, config.get("titulo_compendio", "Compendio de normas de Derecho Penal chileno"))
    log(f"\nListo: {out_path.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        log("\nERROR:")
        log(traceback.format_exc())
        raise
