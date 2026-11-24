// Visor en línea del compendio: PDF.js con índice de marcadores y buscador propio.
import * as pdfjsLib from "./pdfjs/build/pdf.min.mjs";

globalThis.pdfjsLib = pdfjsLib;
const { EventBus, PDFLinkService, PDFViewer, LinkTarget } = await import("./pdfjs/web/pdf_viewer.mjs");

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/build/pdf.worker.min.mjs", import.meta.url).href;

const RUTAS = {
  pdf: "compendio.pdf",
  meta: "datos/compendio.json",
  texto: "datos/texto.json",
};
const URL_RELEASES = "https://github.com/n-a-monterocarvajal/Compendio-Derecho-Penal-Chile/releases/latest";
const POR_TANDA = 150;
const MAX_RESULTADOS = 10000;
const CONTEXTO = 70;

const $ = (id) => document.getElementById(id);
const numero = new Intl.NumberFormat("es-CL");
const movil = matchMedia("(max-width: 760px)");

// ---------------------------------------------------------------------------
// Normalización: minúsculas y sin tildes (la ñ se conserva), largo idéntico al
// original para que cada posición del texto normalizado sea la misma del real.
// ---------------------------------------------------------------------------
const plegados = new Map();
function plegarCaracter(c) {
  let r = plegados.get(c);
  if (r === undefined) {
    if (c === "ñ" || c === "Ñ") r = "ñ";
    else {
      const base = c.normalize("NFD")[0].toLowerCase();
      r = base.length === 1 ? base : c;
    }
    plegados.set(c, r);
  }
  return r;
}
function plegar(texto) {
  const minusculas = texto.toLowerCase();
  if (minusculas.length === texto.length) return minusculas.replace(/[^\x00-\x7f]/g, plegarCaracter);
  let salida = "";
  for (const c of texto) salida += c.length === 1 ? plegarCaracter(c) : c;
  return salida;
}

// Pie de página que Ley Chile repite en cada hoja: no cuenta para la búsqueda. Se
// reemplaza por \0 (mismo largo), así no hay coincidencias dentro de él ni a través de él.
const PIE_LEY_CHILE = /biblioteca del congreso nacional de chile - www\.leychile\.cl - documento generado el \S+ ?pagina \d+ de \d+/g;
function sinPie(plano) {
  return plano.replace(PIE_LEY_CHILE, (m) => "\0".repeat(m.length));
}
const esLetra = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const prepararConsulta = (texto) => plegar(texto.replace(/\s+/g, " ").trim());

function* coincidencias(plano, q, palabraCompleta) {
  let desde = 0;
  while (true) {
    const i = plano.indexOf(q, desde);
    if (i === -1) return;
    desde = i + 1;
    if (palabraCompleta && (esLetra(plano[i - 1]) || esLetra(plano[i + q.length]))) continue;
    yield i;
  }
}

function escapar(t) {
  return t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
const tituloLegible = (t) => t.replace(/^ART[ÍíI]CULO\b/, "Artículo").replace(/\s+/g, " ").trim();
// Primer hijo de una norma incluida en parte: «Selección: títulos I a III…».
const esSeleccion = (t) => t.startsWith("Selección:");
// «◐» (norma incluida en parte) con una fuente que de seguro trae el símbolo.
const conSimbolo = (html) => html.replace(/◐/g, '<span class="parcial" title="Norma incluida en parte">◐</span>');
const recortar = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);

// Forma breve de una división para la ruta: «TITULO SEGUNDO DE LA …» → «Título segundo».
const DIVISIONES = { titulo: "Título", capitulo: "Capítulo", parrafo: "Párrafo", libro: "Libro", seccion: "Sección", articulo: "Artículo", parte: "Parte" };
function divisionBreve(t) {
  const limpio = tituloLegible(t);
  const m = limpio.match(/^(\S+)\s+(\S+)/);
  const clave = m && DIVISIONES[plegar(m[1]).replace(/[^a-z]/g, "")];
  if (clave) {
    let ordinal = m[2].replace(/[.,:;-]+$/, "");
    if (!/^[IVXLC]+$/.test(ordinal)) ordinal = ordinal.toLowerCase();
    return `${clave} ${ordinal}`;
  }
  const frase = limpio === limpio.toUpperCase() ? limpio.charAt(0) + limpio.slice(1).toLowerCase() : limpio;
  return recortar(frase, 34);
}

// Nombre corto de una norma: lo que va antes de «, que…», «, de…» o «, sobre…».
function nombreCorto(titulo) {
  const m = titulo.match(/^(.+?N\.º\s*[\d.\-]+(?:,\s*de\s*\d{4})?)/);
  return m ? m[1] : recortar(titulo, 70);
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const estado = {
  meta: null,
  marcadores: [], // {nivel, titulo, pagina, offset, padre}
  normas: [], // índices de marcadores de nivel 2
  notaSeleccion: "", // nota final del PDF que explica «◐»
  textos: null,
  planos: null,
  cargaTexto: null,
  resultados: [],
  mostrados: 0,
  actual: -1,
  consulta: "",
  palabraCompleta: false,
  soloNorma: false,
  pendiente: null,
};

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------
function temaActual() {
  const elegido = document.documentElement.dataset.theme;
  if (elegido) return elegido;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
$("tema").addEventListener("click", () => {
  const nuevo = temaActual() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = nuevo;
  try { localStorage.setItem("visor-tema", nuevo); } catch (e) { /* sin almacenamiento */ }
});

// ---------------------------------------------------------------------------
// Visor PDF.js
// ---------------------------------------------------------------------------
const contenedor = $("contenedor-visor");
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget?.BLANK ?? 2, externalLinkRel: "noopener noreferrer" });
const viewer = new PDFViewer({
  container: contenedor,
  viewer: $("visor"),
  eventBus,
  linkService,
  textLayerMode: 1,
  removePageBorders: true,
});
linkService.setViewer(viewer);

const paginaInicial = (() => {
  const m = location.hash.match(/(?:pagina|page)=(\d+)/);
  return m ? Number(m[1]) : 1;
})();

eventBus.on("pagesinit", () => {
  viewer.currentScaleValue = "page-width";
  if (paginaInicial > 1) viewer.currentPageNumber = Math.min(paginaInicial, viewer.pagesCount);
});

// Reajusta «ancho de página» o «página completa» cuando cambia el espacio disponible
// (paneles que se abren o cierran, ventana que cambia de tamaño).
// Se espera a que el tamaño se estabilice para no redibujar las páginas en cada cuadro.
let ajuste = null;
new ResizeObserver(() => {
  clearTimeout(ajuste);
  ajuste = setTimeout(() => {
    const valor = viewer.currentScaleValue;
    if (viewer.pagesCount && (valor === "page-width" || valor === "page-fit")) viewer.currentScaleValue = valor;
  }, 150);
}).observe(contenedor);

let primeraPagina = true;
eventBus.on("pagerendered", () => {
  if (primeraPagina) {
    primeraPagina = false;
    $("aviso-carga").classList.add("oculto");
  }
});

eventBus.on("pagechanging", ({ pageNumber }) => {
  if (document.activeElement !== $("pagina")) $("pagina").value = pageNumber;
  actualizarUbicacion(pageNumber);
  history.replaceState(null, "", `#pagina=${pageNumber}`);
});

eventBus.on("scalechanging", ({ scale, presetValue }) => {
  $("escala").textContent = presetValue === "page-width" ? "Ancho" : presetValue === "page-fit" ? "Página" : `${Math.round(scale * 100)} %`;
});

eventBus.on("textlayerrendered", ({ pageNumber }) => {
  resaltarPagina(pageNumber);
  if (estado.pendiente && estado.pendiente.p === pageNumber) enfocarActual();
});

function progreso(fraccion) {
  const barra = $("progreso");
  barra.firstElementChild.style.width = `${Math.round(fraccion * 100)}%`;
  barra.classList.toggle("listo", fraccion >= 1);
}

async function abrirDocumento() {
  progreso(0.08);
  const tarea = pdfjsLib.getDocument({
    url: RUTAS.pdf,
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 256 * 1024,
    standardFontDataUrl: "pdfjs/standard_fonts/",
    cMapUrl: "pdfjs/cmaps/",
    cMapPacked: true,
    wasmUrl: "pdfjs/wasm/",
  });
  tarea.onProgress = ({ loaded, total }) => {
    if (total) progreso(Math.max(0.08, loaded / total));
  };
  try {
    const documento = await tarea.promise;
    viewer.setDocument(documento);
    linkService.setDocument(documento);
    $("total-paginas").textContent = `/ ${numero.format(documento.numPages)}`;
    setTimeout(() => progreso(1), 1500);
  } catch (error) {
    console.error(error);
    progreso(1);
    $("aviso-carga").innerHTML = `No se pudo abrir el PDF. <a href="${URL_RELEASES}">Descárguelo desde el release</a>.`;
  }
}

// ---------------------------------------------------------------------------
// Metadatos e índice
// ---------------------------------------------------------------------------
async function cargarMeta() {
  const meta = await (await fetch(RUTAS.meta)).json();
  estado.meta = meta;
  // La nota final del motor que explica «◐» no es una norma: va al pie del índice.
  let marcadores = meta.marcadores;
  const ultimo = marcadores.at(-1);
  if (ultimo && ultimo[0] === 1 && ultimo[1].startsWith("◐ ") && !/N\.º/.test(ultimo[1])) {
    estado.notaSeleccion = ultimo[1].slice(2);
    marcadores = marcadores.slice(0, -1);
  }
  // Compendios sin capítulos (normas en el nivel 1): se bajan un nivel, así las normas
  // quedan siempre en el nivel 2 y el resto del visor no distingue entre ambos casos.
  const conCapitulos = marcadores.some(([nivel, titulo]) => nivel === 1 && /^[IVXLC]+\.\s/.test(titulo));
  const desfase = conCapitulos ? 0 : 1;
  const pila = [];
  estado.marcadores = marcadores.map(([nivelOriginal, titulo, pagina], i) => {
    const nivel = nivelOriginal + desfase;
    while (pila.length && pila.at(-1).nivel >= nivel) pila.pop();
    const m = { nivel, titulo, pagina, offset: 0, padre: pila.length ? pila.at(-1).i : -1, i };
    pila.push(m);
    return m;
  });
  estado.normas = estado.marcadores.flatMap((m, i) => (m.nivel === 2 ? [i] : []));
  if (meta.url_descarga) $("descargar").href = meta.url_descarga;

  const fecha = meta.publicado ? new Date(meta.publicado).toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric" }) : "";
  const version = meta.url_release ? `<a href="${escapar(meta.url_release)}">${escapar(meta.tag || meta.archivo)}</a>` : escapar(meta.archivo);
  $("pie").innerHTML =
    `${numero.format(estado.normas.length)} normas · ${numero.format(meta.paginas)} páginas<br>` +
    `Versión ${version}${fecha ? `, publicada el ${escapar(fecha)}` : ""}.<br>` +
    `<a href="${escapar($("repositorio").href)}">Repositorio en GitHub</a>` +
    (estado.notaSeleccion ? `<span class="nota-seleccion">${conSimbolo("◐")} ${escapar(estado.notaSeleccion)}</span>` : "");

  construirIndice();
  actualizarUbicacion(viewer.currentPageNumber || 1);
}

const iconoFlecha = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const filasPorMarcador = new Map();

function hijosDe(i) {
  const { marcadores } = estado;
  const nivel = i < 0 ? 0 : marcadores[i].nivel;
  const hijos = [];
  for (let j = i + 1; j < marcadores.length && marcadores[j].nivel > nivel; j++) {
    if (marcadores[j].padre === i) hijos.push(j);
  }
  return hijos;
}
const tieneHijos = (i) => i + 1 < estado.marcadores.length && estado.marcadores[i + 1].padre === i;

function contenidoEntrada(m) {
  if (m.nivel === 1) {
    const partes = m.titulo.match(/^([IVXLC]+)\.\s+(.*)$/);
    if (partes) return `<span><span class="numeral">${partes[1]}</span>${escapar(partes[2])}</span>`;
  }
  if (m.nivel === 2) {
    const corto = nombreCorto(m.titulo);
    const resto = m.titulo.slice(corto.length).replace(/^[,.\s]+/, "");
    if (resto) return `<span><span class="norma-nombre">${conSimbolo(escapar(corto))}</span><span class="norma-materia">${escapar(resto)}</span></span>`;
  }
  if (esSeleccion(m.titulo)) return `<span class="seleccion">${escapar(m.titulo)}</span>`;
  return `<span>${escapar(tituloLegible(m.titulo))}</span>`;
}

function crearFila(i, ul, abrirHasta) {
  const m = estado.marcadores[i];
  const li = document.createElement("li");
  li.className = `nivel-${Math.min(m.nivel, 3)}`;
  const fila = document.createElement("div");
  fila.className = "fila";
  const conHijos = tieneHijos(i);

  const desplegar = document.createElement("button");
  desplegar.type = "button";
  desplegar.className = "desplegar" + (conHijos ? "" : " vacio");
  desplegar.innerHTML = iconoFlecha;
  desplegar.setAttribute("aria-expanded", "false");
  desplegar.setAttribute("aria-label", "Desplegar");
  desplegar.tabIndex = conHijos ? 0 : -1;

  const entrada = document.createElement("button");
  entrada.type = "button";
  entrada.className = "entrada";
  entrada.title = m.titulo;
  entrada.innerHTML = `${contenidoEntrada(m)}<span class="pag">${numero.format(m.pagina)}</span>`;
  entrada.addEventListener("click", () => {
    irAPagina(m.pagina);
    if (movil.matches) mostrarIndice(false);
  });
  filasPorMarcador.set(i, fila);

  fila.append(desplegar, entrada);
  li.append(fila);
  ul.append(li);

  if (conHijos) {
    let sub = null;
    const alternar = (abrir) => {
      if (abrir && !sub) {
        sub = document.createElement("ul");
        for (const h of hijosDe(i)) crearFila(h, sub, abrirHasta);
        li.append(sub);
      }
      if (sub) sub.hidden = !abrir;
      desplegar.setAttribute("aria-expanded", String(abrir));
    };
    desplegar.addEventListener("click", () => alternar(desplegar.getAttribute("aria-expanded") !== "true"));
    li.alternar = alternar;
    if (m.nivel < abrirHasta) alternar(true);
  }
  return li;
}

function construirIndice() {
  const nav = $("indice");
  nav.textContent = "";
  filasPorMarcador.clear();
  normaMarcada = null;
  const ul = document.createElement("ul");
  for (const i of hijosDe(-1)) crearFila(i, ul, 2);
  nav.append(ul);
}

function filtrarIndice() {
  const q = prepararConsulta($("filtro-indice").value);
  if (!q) { construirIndice(); actualizarUbicacion(viewer.currentPageNumber || 1); return; }
  const nav = $("indice");
  nav.textContent = "";
  const ul = document.createElement("ul");
  let total = 0;
  for (const i of estado.normas) {
    const m = estado.marcadores[i];
    if (!plegar(m.titulo).includes(q)) continue;
    total++;
    const li = document.createElement("li");
    li.className = "nivel-2 filtrada";
    const capitulo = m.padre >= 0 ? estado.marcadores[m.padre].titulo : "";
    li.innerHTML = `<div class="fila"><button type="button" class="entrada" title="${escapar(m.titulo)}"><span>${conSimbolo(escapar(m.titulo))}<span class="capitulo-filtro">${escapar(capitulo)}</span></span><span class="pag">${numero.format(m.pagina)}</span></button></div>`;
    li.querySelector("button").addEventListener("click", () => {
      irAPagina(m.pagina);
      if (movil.matches) mostrarIndice(false);
    });
    ul.append(li);
  }
  nav.append(total ? ul : Object.assign(document.createElement("p"), { className: "aviso", textContent: "Ninguna norma coincide con el filtro." }));
}

// Última norma (marcador de nivel 2) que empieza en la página indicada o antes.
function normaDePagina(p) {
  const { normas, marcadores } = estado;
  let lo = 0, hi = normas.length - 1, r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marcadores[normas[mid]].pagina <= p) { r = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return r;
}

// Marcador más profundo (nivel ≥ 3) vigente en una posición de una página.
function seccionDePosicion(p, pos) {
  const { marcadores } = estado;
  let lo = 0, hi = marcadores.length - 1, r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = marcadores[mid];
    if (m.pagina < p || (m.pagina === p && m.offset <= pos)) { r = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return r >= 0 && marcadores[r].nivel > 2 ? r : -1;
}

// Ruta dentro de la norma: «Título II › Párrafo 1° › Artículo 24».
function rutaDe(i) {
  const partes = [];
  for (let j = i; j >= 0 && estado.marcadores[j].nivel > 2; j = estado.marcadores[j].padre) {
    const t = estado.marcadores[j].titulo;
    if (t !== "Encabezado" && !esSeleccion(t)) partes.unshift(tituloLegible(t));
  }
  return partes;
}

let normaMarcada = null;
function actualizarUbicacion(p) {
  if (!estado.marcadores.length) return;
  const n = normaDePagina(p);
  const marcador = n >= 0 ? estado.marcadores[estado.normas[n]] : null;
  $("ubicacion").textContent = marcador ? marcador.titulo : "";
  $("ubicacion").title = marcador ? marcador.titulo : "";
  const fila = n >= 0 ? filasPorMarcador.get(estado.normas[n]) : null;
  if (normaMarcada !== fila) {
    normaMarcada?.classList.remove("actual");
    fila?.classList.add("actual");
    normaMarcada = fila;
  }
}

function irAPagina(p) {
  viewer.scrollPageIntoView({ pageNumber: p });
}

// ---------------------------------------------------------------------------
// Texto para el buscador
// ---------------------------------------------------------------------------
function cargarTexto() {
  if (!estado.cargaTexto) {
    $("contador").textContent = "Cargando…";
    estado.cargaTexto = fetch(RUTAS.texto)
      .then((r) => r.json())
      .then((textos) => {
        estado.textos = textos;
        estado.planos = textos.map((t) => sinPie(plegar(t)));
        ubicarMarcadoresEnTexto();
        if (!estado.consulta) $("contador").textContent = "";
      })
      .catch((error) => {
        console.error(error);
        $("contador").textContent = "Sin texto";
        estado.cargaTexto = null;
        throw error;
      });
  }
  return estado.cargaTexto;
}

// Ubica cada marcador profundo (artículos, títulos) dentro del texto de su página,
// para saber en qué artículo cae cada coincidencia.
function ubicarMarcadoresEnTexto() {
  let paginaPrevia = 0, desde = 0;
  for (const m of estado.marcadores) {
    if (m.pagina !== paginaPrevia) { paginaPrevia = m.pagina; desde = 0; }
    if (m.nivel <= 2) { m.offset = 0; continue; }
    const plano = estado.planos[m.pagina - 1] || "";
    const i = plano.indexOf(prepararConsulta(m.titulo), desde);
    if (i >= 0) { m.offset = i; desde = i + 1; } else m.offset = desde;
  }
}

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------
function rangoDePaginas() {
  const total = estado.textos.length;
  if (!estado.soloNorma || !estado.normas.length) return [1, total];
  const n = normaDePagina(viewer.currentPageNumber || 1);
  if (n < 0) return [1, total];
  const desde = estado.marcadores[estado.normas[n]].pagina;
  const siguiente = estado.normas[n + 1];
  return [desde, siguiente !== undefined ? estado.marcadores[siguiente].pagina : total];
}

function mostrarResultados(visible) {
  $("resultados-panel").hidden = !visible;
  $("buscador").classList.toggle("activo", visible);
  actualizarVelo();
}

async function buscar() {
  const q = prepararConsulta($("consulta").value);
  estado.consulta = q.length >= 2 ? q : "";
  estado.palabraCompleta = $("palabra-completa").getAttribute("aria-pressed") === "true";
  estado.resultados = [];
  estado.actual = -1;
  estado.pendiente = null;
  $("resultados").textContent = "";

  if (!estado.consulta) {
    $("contador").textContent = "";
    mostrarResultados(false);
    actualizarFlechas();
    resaltarTodo();
    return;
  }
  mostrarResultados(true);
  $("estado-busqueda").textContent = "Buscando…";
  await cargarTexto();
  if (q !== prepararConsulta($("consulta").value)) return; // llegó otra consulta mientras cargaba

  const [desde, hasta] = rangoDePaginas();
  const resultados = [];
  const porNorma = new Map();
  let excedido = false;
  for (let p = desde; p <= hasta && !excedido; p++) {
    let k = 0;
    for (const pos of coincidencias(estado.planos[p - 1], q, estado.palabraCompleta)) {
      const n = normaDePagina(p);
      resultados.push({ p, pos, k: k++, n });
      porNorma.set(n, (porNorma.get(n) || 0) + 1);
      if (resultados.length >= MAX_RESULTADOS) { excedido = true; break; }
    }
  }
  estado.resultados = resultados;
  estado.porNorma = porNorma;
  estado.mostrados = 0;
  const total = excedido ? `${numero.format(MAX_RESULTADOS)}+` : numero.format(resultados.length);
  if (!resultados.length) {
    $("estado-busqueda").textContent = "Sin coincidencias";
    $("contador").textContent = "0";
    $("resultados").innerHTML = `<li class="aviso">No hay coincidencias${estado.soloNorma ? " en esta norma" : ""}. La búsqueda no distingue mayúsculas ni tildes.</li>`;
  } else {
    $("estado-busqueda").textContent = `${total} ${resultados.length === 1 ? "coincidencia" : "coincidencias"} en ${numero.format(porNorma.size)} ${porNorma.size === 1 ? "norma" : "normas"}`;
    $("contador").textContent = total;
    mostrarMas();
  }
  actualizarFlechas();
  resaltarTodo();
}

// Contexto de una coincidencia, sin el pie de página de Ley Chile.
function fragmento(r) {
  const original = estado.textos[r.p - 1];
  const plano = estado.planos[r.p - 1];
  const largo = estado.consulta.length;
  const limpio = (desde, hasta) => {
    let t = "";
    for (let i = desde; i < hasta; i++) if (plano[i] !== "\0") t += original[i];
    return t.replace(/\s+/g, " ");
  };
  let antes = limpio(Math.max(0, r.pos - 400), r.pos);
  let despues = limpio(r.pos + largo, Math.min(original.length, r.pos + largo + 400));
  const cortaAntes = antes.length > CONTEXTO || r.pos > 400;
  const cortaDespues = despues.length > CONTEXTO || r.pos + largo + 400 < original.length;
  if (antes.length > CONTEXTO) {
    antes = antes.slice(-CONTEXTO);
    const s = antes.indexOf(" ");
    if (s !== -1) antes = antes.slice(s + 1);
  }
  if (despues.length > CONTEXTO) {
    despues = despues.slice(0, CONTEXTO);
    const s = despues.lastIndexOf(" ");
    if (s > 0) despues = despues.slice(0, s);
  }
  return (cortaAntes ? "… " : "") + escapar(antes) + "<mark>" + escapar(original.slice(r.pos, r.pos + largo)) + "</mark>" + escapar(despues) + (cortaDespues ? " …" : "");
}

function mostrarMas() {
  const ol = $("resultados");
  ol.querySelector(".mas")?.remove();
  const hasta = Math.min(estado.resultados.length, estado.mostrados + POR_TANDA);
  const tanda = document.createDocumentFragment();
  for (let i = estado.mostrados; i < hasta; i++) {
    const r = estado.resultados[i];
    const anterior = estado.resultados[i - 1];
    if (!anterior || anterior.n !== r.n) {
      const norma = r.n >= 0 ? estado.marcadores[estado.normas[r.n]].titulo : "Sin norma";
      const grupo = document.createElement("li");
      grupo.className = "grupo";
      grupo.title = norma;
      grupo.innerHTML = `<span>${escapar(nombreCorto(norma))}</span><span>${numero.format(estado.porNorma.get(r.n) || 0)}</span>`;
      tanda.append(grupo);
    }
    const seccion = seccionDePosicion(r.p, r.pos);
    const ruta = seccion >= 0 ? rutaDe(seccion) : [];
    const rutaTexto = ruta.map(divisionBreve).join(" › ");
    const li = document.createElement("li");
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "resultado";
    boton.dataset.i = i;
    boton.title = ruta.join(" › ");
    boton.innerHTML =
      `<span class="donde"><span>${escapar(rutaTexto || "Encabezado")}</span><span>p. ${numero.format(r.p)}</span></span>` +
      fragmento(r);
    li.append(boton);
    tanda.append(li);
  }
  ol.append(tanda);
  estado.mostrados = hasta;
  if (hasta < estado.resultados.length) {
    const li = document.createElement("li");
    li.className = "mas";
    const boton = document.createElement("button");
    boton.type = "button";
    boton.textContent = `Mostrar ${numero.format(Math.min(POR_TANDA, estado.resultados.length - hasta))} más`;
    boton.addEventListener("click", mostrarMas);
    li.append(boton);
    ol.append(li);
  }
}

function seleccionar(i) {
  if (!estado.resultados.length) return;
  i = (i + estado.resultados.length) % estado.resultados.length;
  while (i >= estado.mostrados) mostrarMas();
  $("resultados").querySelector(".resultado.actual")?.classList.remove("actual");
  const boton = $("resultados").querySelector(`.resultado[data-i="${i}"]`);
  boton?.classList.add("actual");
  boton?.scrollIntoView({ block: "nearest" });
  estado.actual = i;
  const r = estado.resultados[i];
  $("contador").textContent = `${numero.format(i + 1)} de ${numero.format(estado.resultados.length)}${estado.resultados.length >= MAX_RESULTADOS ? "+" : ""}`;
  estado.pendiente = r;
  actualizarFlechas();
  resaltarTodo();
  if (!enfocarActual()) irAPagina(r.p);
}

function actualizarFlechas() {
  const hay = estado.resultados.length > 0;
  $("anterior").disabled = !hay;
  $("siguiente").disabled = !hay;
}

// ---------------------------------------------------------------------------
// Resaltado sobre la capa de texto de PDF.js (CSS Custom Highlight API)
// ---------------------------------------------------------------------------
const soportaResaltado = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
const resaltado = soportaResaltado ? new Highlight() : null;
const resaltadoActual = soportaResaltado ? new Highlight() : null;
if (soportaResaltado) {
  resaltadoActual.priority = 1;
  CSS.highlights.set("busqueda", resaltado);
  CSS.highlights.set("busqueda-actual", resaltadoActual);
}
const rangosPorPagina = new Map();

function textoDeCapa(div) {
  const nodos = [], nodo = [], offset = [];
  let texto = "";
  let espacio = false;
  const recorrido = document.createTreeWalker(div, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = recorrido.nextNode(); n; n = recorrido.nextNode()) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      if (n.tagName === "BR") espacio = true;
      continue;
    }
    const indice = nodos.push(n) - 1;
    const valor = n.nodeValue;
    for (let i = 0; i < valor.length; i++) {
      const c = valor[i];
      if (/\s/.test(c)) { espacio = true; continue; }
      if (espacio && texto.length) { texto += " "; nodo.push(indice); offset.push(i); }
      espacio = false;
      texto += c;
      nodo.push(indice);
      offset.push(i);
    }
  }
  return { plano: sinPie(plegar(texto)), nodos, nodo, offset };
}

function resaltarPagina(p) {
  if (!soportaResaltado) return [];
  for (const r of rangosPorPagina.get(p) || []) { resaltado.delete(r); resaltadoActual.delete(r); }
  rangosPorPagina.delete(p);
  if (!estado.consulta) return [];
  const div = viewer.getPageView(p - 1)?.textLayer?.div;
  if (!div || !div.isConnected || !div.firstChild) return [];

  const { plano, nodos, nodo, offset } = textoDeCapa(div);
  const rangos = [];
  const largo = estado.consulta.length;
  for (const s of coincidencias(plano, estado.consulta, estado.palabraCompleta)) {
    const e = s + largo - 1;
    if (e >= nodo.length) break;
    const rango = document.createRange();
    rango.setStart(nodos[nodo[s]], offset[s]);
    rango.setEnd(nodos[nodo[e]], offset[e] + 1);
    rangos.push(rango);
    resaltado.add(rango);
  }
  rangosPorPagina.set(p, rangos);
  const actual = estado.resultados[estado.actual];
  if (actual && actual.p === p && rangos.length) resaltadoActual.add(rangos[Math.min(actual.k, rangos.length - 1)]);
  return rangos;
}

function resaltarTodo() {
  if (!soportaResaltado) return;
  resaltado.clear();
  resaltadoActual.clear();
  rangosPorPagina.clear();
  for (let i = 0; i < viewer.pagesCount; i++) {
    const div = viewer.getPageView(i)?.textLayer?.div;
    if (div && div.isConnected && div.firstChild) resaltarPagina(i + 1);
  }
}

// Desplaza el documento hasta la coincidencia seleccionada, si su página ya tiene capa de texto.
function enfocarActual() {
  const r = estado.pendiente;
  if (!r) return false;
  const rangos = rangosPorPagina.get(r.p);
  if (!rangos || !rangos.length) {
    const vista = viewer.getPageView(r.p - 1);
    if (!vista?.textLayer?.div?.firstChild) return false;
    if (!soportaResaltado) { estado.pendiente = null; irAPagina(r.p); return true; }
    return false;
  }
  const rango = rangos[Math.min(r.k, rangos.length - 1)];
  const caja = rango.getBoundingClientRect();
  const marco = contenedor.getBoundingClientRect();
  contenedor.scrollTo({
    top: contenedor.scrollTop + caja.top - marco.top - marco.height * 0.3,
    left: caja.left < marco.left || caja.right > marco.right ? contenedor.scrollLeft + caja.left - marco.left - 40 : contenedor.scrollLeft,
  });
  estado.pendiente = null;
  return true;
}

// ---------------------------------------------------------------------------
// Paneles y teclado
// ---------------------------------------------------------------------------
const sinMovimiento = matchMedia("(prefers-reduced-motion: reduce)");
let finDeslizamiento = null;
function mostrarIndice(visible) {
  const panel = $("indice-panel");
  $("alternar-indice").setAttribute("aria-expanded", String(visible));
  const visibleAhora = !panel.classList.contains("oculto") && !panel.classList.contains("fuera");
  if (movil.matches || sinMovimiento.matches || visible === visibleAhora) {
    panel.classList.remove("flotante", "fuera");
    panel.classList.toggle("oculto", !visible);
    actualizarVelo();
    return;
  }
  // Escritorio: el panel se desliza con transform y el documento cambia de ancho una sola
  // vez, al terminar (igual que el panel lateral del visor oficial de PDF.js).
  clearTimeout(finDeslizamiento);
  const terminar = () => {
    panel.classList.remove("flotante", "fuera");
    panel.classList.toggle("oculto", !visible);
  };
  if (visible) {
    panel.classList.remove("oculto");
    panel.classList.add("flotante", "fuera");
    panel.getBoundingClientRect(); // fija la posición inicial antes de animar
    requestAnimationFrame(() => panel.classList.remove("fuera"));
  } else {
    panel.classList.add("fuera");
  }
  finDeslizamiento = setTimeout(terminar, 220);
  actualizarVelo();
}
function actualizarVelo() {
  const indiceAbierto = !$("indice-panel").classList.contains("oculto");
  const resultadosAbiertos = !$("resultados-panel").hidden;
  $("velo").hidden = !(movil.matches && (indiceAbierto || resultadosAbiertos));
}
function cerrarResultados() {
  if (movil.matches) mostrarResultados(false);
  else {
    $("consulta").value = "";
    buscar();
  }
}

function abrirBusqueda() {
  const consulta = $("consulta");
  consulta.focus();
  consulta.select();
  cargarTexto().catch(() => {});
}

let espera = null;
$("consulta").addEventListener("input", () => {
  clearTimeout(espera);
  espera = setTimeout(buscar, 200);
});
$("consulta").addEventListener("focus", () => {
  cargarTexto().catch(() => {});
  if (estado.consulta && movil.matches) mostrarResultados(true);
});
$("consulta").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(espera);
    const avanzar = () => {
      seleccionar(estado.actual + (e.shiftKey ? -1 : 1));
      if (movil.matches) { mostrarResultados(false); $("consulta").blur(); }
    };
    if (prepararConsulta($("consulta").value) !== estado.consulta) buscar().then(avanzar);
    else avanzar();
  } else if (e.key === "Escape") {
    $("consulta").value = "";
    buscar();
    contenedor.focus();
  }
});
$("buscador").addEventListener("submit", (e) => e.preventDefault());
$("anterior").addEventListener("click", () => seleccionar(estado.actual - 1));
$("siguiente").addEventListener("click", () => seleccionar(estado.actual + 1));
$("resultados").addEventListener("click", (e) => {
  const boton = e.target.closest(".resultado");
  if (!boton) return;
  seleccionar(Number(boton.dataset.i));
  if (movil.matches) mostrarResultados(false);
});
for (const boton of document.querySelectorAll("[data-alcance]")) {
  boton.addEventListener("click", () => {
    for (const b of document.querySelectorAll("[data-alcance]")) b.setAttribute("aria-checked", String(b === boton));
    estado.soloNorma = boton.dataset.alcance === "norma";
    buscar();
  });
}
$("palabra-completa").addEventListener("click", (e) => {
  const boton = e.currentTarget;
  boton.setAttribute("aria-pressed", String(boton.getAttribute("aria-pressed") !== "true"));
  buscar();
});
document.querySelector('[data-cerrar="resultados"]').addEventListener("click", cerrarResultados);
document.querySelector('[data-cerrar="indice"]').addEventListener("click", () => mostrarIndice(false));
$("velo").addEventListener("click", () => {
  mostrarIndice(false);
  mostrarResultados(false);
});

let esperaFiltro = null;
$("filtro-indice").addEventListener("input", () => {
  clearTimeout(esperaFiltro);
  esperaFiltro = setTimeout(filtrarIndice, 120);
});

$("alternar-indice").addEventListener("click", () => mostrarIndice($("indice-panel").classList.contains("oculto")));

$("pagina").addEventListener("change", () => {
  const p = parseInt($("pagina").value, 10);
  if (p >= 1 && p <= viewer.pagesCount) viewer.currentPageNumber = p;
  else $("pagina").value = viewer.currentPageNumber;
});
$("pagina").addEventListener("focus", () => $("pagina").select());
$("pagina").addEventListener("keydown", (e) => { if (e.key === "Enter") $("pagina").blur(); });
$("escala").addEventListener("click", () => {
  viewer.currentScaleValue = viewer.currentScaleValue === "page-width" ? "page-fit" : "page-width";
});
$("acercar").addEventListener("click", () => viewer.increaseScale());
$("alejar").addEventListener("click", () => viewer.decreaseScale());

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    abrirBusqueda();
  } else if (e.key === "F3" || (mod && e.key.toLowerCase() === "g")) {
    if (!estado.resultados.length) return;
    e.preventDefault();
    seleccionar(estado.actual + (e.shiftKey ? -1 : 1));
  } else if (e.key === "Escape" && movil.matches) {
    mostrarIndice(false);
    mostrarResultados(false);
  }
});

movil.addEventListener("change", () => {
  mostrarIndice(!movil.matches);
  actualizarVelo();
});
if (movil.matches) mostrarIndice(false);

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------
abrirDocumento();
cargarMeta().catch((error) => {
  console.error(error);
  $("indice").innerHTML = '<p class="aviso">No se pudo cargar el índice.</p>';
});

const consultaInicial = new URLSearchParams(location.hash.slice(1)).get("buscar");
if (consultaInicial) {
  $("consulta").value = consultaInicial;
  buscar();
}
