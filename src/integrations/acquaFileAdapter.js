/* ============================================================================
   ACQUA FILE ADAPTER (Fase 1 del intercambio ACQUA ↔ Logística Perona)
   ============================================================================
   Aísla TODO lo específico del formato de archivo de ACQUA del resto de la
   app: Producción/OF no saben nada de XLSX, CSV, ni de qué nombre de columna
   usa ACQUA — sólo llaman a las funciones de este módulo y trabajan con la
   forma interna que devuelven.

   Import: normalizeAcquaRow()/parseAcquaImportRows()/validateAcquaOfRow()
   Export: buildAcquaExportRows()/exportRowsToAOA()/exportRowsToCsv()

   *** NADA de esto conoce a Supabase, `state`, ni el DOM. *** Son funciones
   puras: mismo input → mismo output, sin efectos secundarios. Eso es
   deliberado: es lo que permite testearlo con Node directo (ver
   test_acqua_adapter.mjs) y es exactamente la costura por la que, el día que
   ACQUA tenga API, se reemplaza este archivo por un ACQUA API ADAPTER con
   las mismas firmas de salida (mismo `{ ofRows, errors }` de importación,
   mismo array de filas de exportación) sin tocar Producción/OF en absoluto.

   *** FORMATO PROVISORIO ***  Todavía no conocemos la especificación real de
   ACQUA (columnas exactas, nombres, si manda insumos detallados o sólo
   cabecera, códigos de producto, etc.). Todo lo de abajo — nombres de columna
   por defecto (`ACQUA_COLUMN_DEFAULTS`), columnas de exportación
   (`ACQUA_EXPORT_COLUMNS`) — es un mapeo EDITABLE desde Configuración →
   Integración ACQUA (persistido en `app_settings` como "acqua_config"), no
   un contrato fijo. Ver ACQUA_INTEGRATION_SPEC.md para lo que hace falta
   confirmar con el proveedor.
   ========================================================================== */

/** Mapeo de columnas por defecto para IMPORTAR (archivo ACQUA → OF interna).
 * Clave = campo interno; valor = encabezado esperado en el archivo de ACQUA.
 * Editable en Configuración → Integración ACQUA sin tocar código. */
export const ACQUA_COLUMN_DEFAULTS = {
  externalOfId: "ID_OF",
  numero: "NUMERO_OF",
  fecha: "FECHA",
  productoCodigo: "COD_PRODUCTO",
  productoNombre: "PRODUCTO",
  ean13: "EAN13",
  cantidadPlanificada: "CANTIDAD",
  estadoOrigen: "ESTADO",
  prioridad: "PRIORIDAD",
  fechaPlanificacion: "FECHA_PLANIFICACION",
  // Opcionales: si el archivo de ACQUA trae el detalle de insumos por OF (una
  // fila adicional por insumo, repitiendo el mismo ID_OF), estas tres
  // columnas identifican esa fila-insumo. Si no vienen, se ignoran sin error
  // — la OF se ejecuta igual con la LDP interna (box_configs), que sigue
  // siendo la única fuente real de qué consume cada caja.
  itemCodigo: "COD_INSUMO",
  itemNombre: "INSUMO",
  itemCantidad: "CANTIDAD_INSUMO",
};

/** Columnas del archivo de EXPORTACIÓN (OF cerradas → ACQUA), en el orden en
 * que se escriben. También editable — ver mismo comentario de arriba. */
export const ACQUA_EXPORT_COLUMNS = [
  { key: "of", label: "OF" },
  { key: "externalOfId", label: "ID_OF_ACQUA" },
  { key: "productoTerminadoCodigo", label: "COD_PRODUCTO_TERMINADO" },
  { key: "productoTerminadoNombre", label: "PRODUCTO_TERMINADO" },
  { key: "tipoMovimiento", label: "TIPO_MOVIMIENTO" }, // consumo | sustitucion | cierre
  { key: "productoCodigo", label: "COD_PRODUCTO" },
  { key: "productoNombre", label: "PRODUCTO" },
  { key: "ean13", label: "EAN13" },
  { key: "cantidadPlanificada", label: "CANTIDAD_PLANIFICADA" },
  { key: "cantidadReal", label: "CANTIDAD_REAL" },
  { key: "productoOriginalCodigo", label: "COD_PRODUCTO_ORIGINAL" },
  { key: "productoSustitutoCodigo", label: "COD_PRODUCTO_SUSTITUTO" },
  { key: "cantidadSustituida", label: "CANTIDAD_SUSTITUIDA" },
  { key: "fecha", label: "FECHA" },
  { key: "usuario", label: "USUARIO" },
  { key: "estado", label: "ESTADO" },
  { key: "idMovimiento", label: "ID_MOVIMIENTO" }, // clave única — evita duplicados (punto 10)
];

// ---------------------------------------------------------------------------
// IMPORTACIÓN
// ---------------------------------------------------------------------------

function normKey(k) {
  return String(k ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim().replace(/\s+/g, " ");
}

/** Convierte una fila cruda (ya parseada por SheetJS/CSV, un objeto
 * {encabezado: valor}) a un objeto normalizado por clave (sin tildes,
 * minúsculas) para tolerar variaciones menores del header del archivo real
 * de ACQUA frente al mapeo configurado. */
function normalizeRawRow(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) out[normKey(k)] = v;
  return out;
}
function readCell(normRow, headerName) {
  const v = normRow[normKey(headerName)];
  return v === undefined || v === null ? "" : String(v).trim();
}

/** Aplica el mapeo de columnas configurado a UNA fila cruda del archivo y
 * devuelve la forma interna (sin validar todavía). */
export function normalizeAcquaRow(rawRow, columnMapping) {
  const map = { ...ACQUA_COLUMN_DEFAULTS, ...(columnMapping || {}) };
  const r = normalizeRawRow(rawRow);
  return {
    externalOfId: readCell(r, map.externalOfId),
    numero: readCell(r, map.numero),
    fecha: readCell(r, map.fecha),
    productoCodigo: readCell(r, map.productoCodigo),
    productoNombre: readCell(r, map.productoNombre),
    ean13: readCell(r, map.ean13),
    cantidadPlanificada: readCell(r, map.cantidadPlanificada),
    estadoOrigen: readCell(r, map.estadoOrigen),
    prioridad: readCell(r, map.prioridad),
    fechaPlanificacion: readCell(r, map.fechaPlanificacion),
    itemCodigo: readCell(r, map.itemCodigo),
    itemNombre: readCell(r, map.itemNombre),
    itemCantidad: readCell(r, map.itemCantidad),
  };
}

/** Intenta interpretar una fecha en varios formatos comunes de export de
 * ERP (ISO, DD/MM/AAAA, serial de Excel ya resuelto por SheetJS a texto) sin
 * inventar una fecha cuando no se puede — devuelve null si no es fecha. */
function parseFlexibleDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const dmy = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

/** Agrupa filas crudas ya normalizadas por `externalOfId` — soporta tanto
 * "una fila = una OF" (caso simple) como "una fila = una OF + un insumo"
 * (si ACQUA manda el detalle repitiendo el ID_OF): las filas siguientes con
 * el mismo externalOfId aportan sólo su insumo (itemCodigo/itemNombre/
 * itemCantidad) a `itemsRaw`, informativo — nunca reemplaza la LDP interna
 * (box_configs), que sigue siendo la fuente real de qué consume la caja. */
export function parseAcquaImportRows(rawRows, columnMapping) {
  const ofRows = [];
  const errors = [];
  const byExtId = new Map();
  (rawRows || []).forEach((raw, i) => {
    const fila = i + 2; // fila 1 = header
    const n = normalizeAcquaRow(raw, columnMapping);
    if (!n.externalOfId) {
      // Fila totalmente vacía (frecuente al final de un Excel) — se ignora
      // en silencio sólo si TODO lo demás también está vacío; si no, es un
      // error real (falta el identificador de OF).
      const otherFieldsPresent = [n.numero, n.productoCodigo, n.cantidadPlanificada].some(Boolean);
      if (otherFieldsPresent) errors.push({ fila, message: "Sin identificador de OF (ID_OF) — no se puede importar sin arriesgar duplicarla en el próximo archivo." });
      return;
    }
    if (byExtId.has(n.externalOfId)) {
      // Fila repetida del mismo ID_OF: se toma como detalle de insumo,
      // nunca se pisa la cabecera ya leída.
      const ofRow = byExtId.get(n.externalOfId);
      if (n.itemCodigo || n.itemNombre) {
        ofRow.itemsRaw.push({ codigo: n.itemCodigo, nombre: n.itemNombre, cantidad: n.itemCantidad });
      }
      return;
    }
    const ofRow = {
      fila,
      externalOfId: n.externalOfId,
      numero: n.numero || n.externalOfId,
      fecha: parseFlexibleDate(n.fecha),
      fechaRaw: n.fecha,
      productoCodigo: n.productoCodigo,
      productoNombre: n.productoNombre,
      ean13: n.ean13 || null,
      cantidadPlanificada: n.cantidadPlanificada,
      estadoOrigen: n.estadoOrigen || null,
      prioridad: n.prioridad || null,
      fechaPlanificacion: parseFlexibleDate(n.fechaPlanificacion) || parseFlexibleDate(n.fecha),
      itemsRaw: n.itemCodigo || n.itemNombre ? [{ codigo: n.itemCodigo, nombre: n.itemNombre, cantidad: n.itemCantidad }] : [],
    };
    byExtId.set(n.externalOfId, ofRow);
    ofRows.push(ofRow);
  });
  // Duplicados DENTRO del mismo archivo (mismo ID_OF en filas no consecutivas
  // ya fue absorbido arriba; esto detecta el caso de numero de OF repetido
  // con distinto externalOfId, que sería un error de datos del archivo).
  const numeroCount = new Map();
  ofRows.forEach((r) => numeroCount.set(r.numero, (numeroCount.get(r.numero) || 0) + 1));
  ofRows.forEach((r) => {
    if (numeroCount.get(r.numero) > 1) errors.push({ fila: r.fila, message: `Número de OF "${r.numero}" repetido en el archivo con distinto ID_OF — revisar el archivo de origen.` });
  });
  return { ofRows, errors };
}

/** Valida UNA fila de OF ya parseada — estructural, no conoce `state` (por
 * eso recibe `ctx` con lo que necesita mirar afuera: mapeo producto→LDP
 * configurado y si ya existe una OF con ese externalOfId). No es una
 * validación de negocio completa (eso sigue en app.js, que sí puede mirar
 * `state`) — es la primera pasada, la que puede resolverse sólo con el dato
 * de la fila. */
export function validateAcquaOfRow(ofRow, ctx = {}) {
  const errors = [];
  if (!ofRow.externalOfId) errors.push("Sin identificador de OF (ID_OF)");
  if (!ofRow.productoCodigo && !ofRow.productoNombre) errors.push("Sin código ni nombre de producto terminado");
  const cantidad = Number(ofRow.cantidadPlanificada);
  if (!(cantidad > 0)) errors.push(`Cantidad planificada inválida: "${ofRow.cantidadPlanificada}"`);
  if (ofRow.fechaRaw && !ofRow.fecha) errors.push(`Fecha no reconocida: "${ofRow.fechaRaw}" (se esperaba AAAA-MM-DD o DD/MM/AAAA)`);
  if (ctx.productoLdpMap && ofRow.productoCodigo && !ctx.productoLdpMap[ofRow.productoCodigo]) {
    errors.push(`Producto "${ofRow.productoCodigo}" sin LDP interna mapeada — configurar en Configuración → Integración ACQUA`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// IMPORTACIÓN — REPORTE IMPRESO INDIVIDUAL (formato REAL confirmado)
// ---------------------------------------------------------------------------
// A partir de un archivo real exportado por ACQUA (hoja "mrp_production_order"
// — ACQUA corre sobre Odoo) se confirmó que la exportación de una OF NO es una
// fila de una tabla: es el reporte impreso de UNA sola OF (como el PDF de
// "Imprimir OF" guardado como Excel), con etiquetas y valores en celdas
// sueltas dentro de un layout con muchas celdas combinadas, más una tabla
// chica de componentes y una sección "FICHA TÉCNICA" de personalización.
// Por eso "importar varias OF" significa elegir VARIOS archivos a la vez
// (uno por OF), no un único archivo con muchas filas — ver combineAcquaImportResults.
// Las funciones de abajo son la lectura de ESE formato real; el parser
// tabular de arriba (parseAcquaImportRows) se conserva por si en el futuro
// ACQUA agrega una exportación masiva distinta.

const ACQUA_PRINT_REPORT_LABELS = {
  of: /^OF\s*:/i,
  producto: /^Producto\s*:/i,
  cliente: /^Cliente\s*:/i,
  fechaPlanificada: /^Fecha Planificada\s*:/i,
  estado: /^Estado\s*:/i,
  cantidadAProducir: /^Cantidad a producir\s*:/i,
  fechaCreacion: /^Fecha\/?Hora Creaci[oó]n\s*:/i,
  depositoDestino: /^Dep[oó]sito destino\s*:/i,
  vendedor: /^Vendedor\s*:/i,
  codigoHeader: /^C[oó]digo$/i,
  productoHeader: /^Producto$/i,
  cantidadHeader: /^Cantidad$/i,
  fichaTecnica: /^FICHA T[EÉ]CNICA$/i,
};

/** ¿Esta hoja (ya leída como array-of-arrays, `sheet_to_json(ws,{header:1})`)
 * es un reporte impreso de UNA OF de ACQUA, en vez de una tabla con
 * encabezados en la fila 1? Se detecta por la celda "OF: <numero>" que
 * encabeza siempre el reporte — si no aparece, se asume tabla plana. */
export function looksLikeAcquaPrintReport(aoa) {
  for (const row of (aoa || []).slice(0, 10)) {
    for (const cell of row || []) {
      if (typeof cell === "string" && ACQUA_PRINT_REPORT_LABELS.of.test(cell.trim())) return true;
    }
  }
  return false;
}

function findLabelCell(aoa, regex, fromRow = 0, toRow = aoa.length) {
  for (let r = fromRow; r < Math.min(toRow, aoa.length); r++) {
    const row = aoa[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (typeof row[c] === "string" && regex.test(row[c].trim())) return { r, c };
    }
  }
  return null;
}
function valueRightOf(aoa, r, c) {
  const row = aoa[r] || [];
  for (let cc = c + 1; cc < row.length; cc++) {
    const v = row[cc];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}
/** La 2da fecha de "Fecha Planificada" (rango Desde/Hasta) se imprime SIN
 * etiqueta propia, en la fila siguiente — Odoo la muestra como dos líneas
 * apiladas bajo la misma etiqueta. */
function valueLoneBelow(aoa, r, cRef) {
  const row = aoa[r + 1] || [];
  for (let cc = Math.max(0, cRef - 3); cc < row.length; cc++) {
    const v = row[cc];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}
function parseOdooDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  const dmy = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) { const [, d, m, y] = dmy; return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0].slice(0, 10) : null;
}
/** "0165 - ROOFTOP DEVLAB S.A.S" / "ESP-003296 - EMPRESAS - ROOFTOP MOCHILA"
 * → separa sólo en el PRIMER " - " (el nombre puede tener guiones propios). */
function splitCodeName(s) {
  if (!s) return { codigo: "", nombre: "" };
  const m = String(s).match(/^\s*(\S+)\s*-\s*(.+)$/);
  if (!m) return { codigo: "", nombre: String(s).trim() };
  return { codigo: m[1].trim(), nombre: m[2].trim() };
}
/** Odoo imprime cantidades con coma decimal ("1,00") — se normaliza a punto
 * SOLO cuando el formato es inequívocamente decimal-con-coma, nunca se
 * inventa un separador de miles. */
function normalizeDecimal(s) {
  if (s == null) return s;
  const str = String(s).trim();
  return /^\d+,\d+$/.test(str) ? str.replace(",", ".") : str;
}

/** Parsea UN archivo = UNA OF en el formato real de reporte impreso de
 * ACQUA. Devuelve `{ ofRow, errors }` — nunca varias OF (para eso, ver
 * combineAcquaImportResults con un archivo por cada llamada). La sección
 * "FICHA TÉCNICA" (personalización: talle, material, forma de entrega, etc.)
 * se guarda entera y sin interpretar en `ofRow.fichaTecnicaRaw` — son
 * casilleros de un formulario impreso y no hay forma confiable de saber cuál
 * está marcado sin inventar una convención; se deja como referencia para el
 * operador, nunca se usa para calcular nada. */
export function parseAcquaPrintReportSheet(aoa, sourceLabel) {
  const L = ACQUA_PRINT_REPORT_LABELS;
  const ofCell = findLabelCell(aoa, L.of);
  if (!ofCell) {
    return { ofRow: null, errors: [{ fila: sourceLabel || "archivo", message: 'No se encontró la etiqueta "OF:" — no parece un reporte de OF de ACQUA.' }] };
  }
  const externalOfId = String(aoa[ofCell.r][ofCell.c]).replace(L.of, "").trim();
  if (!externalOfId) {
    return { ofRow: null, errors: [{ fila: sourceLabel || "archivo", message: "La celda \"OF:\" no tiene número." }] };
  }

  const productoCell = findLabelCell(aoa, L.producto, ofCell.r);
  const { codigo: productoCodigo, nombre: productoNombre } = splitCodeName(productoCell ? valueRightOf(aoa, productoCell.r, productoCell.c) : "");

  const clienteCell = findLabelCell(aoa, L.cliente, ofCell.r);
  const { codigo: clienteCodigo, nombre: clienteNombre } = splitCodeName(clienteCell ? valueRightOf(aoa, clienteCell.r, clienteCell.c) : "");

  const fechaPlanCell = findLabelCell(aoa, L.fechaPlanificada, ofCell.r);
  const fechaDesdeRaw = fechaPlanCell ? valueRightOf(aoa, fechaPlanCell.r, fechaPlanCell.c) : "";
  const fechaHastaRaw = fechaPlanCell ? valueLoneBelow(aoa, fechaPlanCell.r, fechaPlanCell.c) : "";

  const estadoCell = findLabelCell(aoa, L.estado, ofCell.r);
  const estadoOrigen = estadoCell ? valueRightOf(aoa, estadoCell.r, estadoCell.c) : "";

  const cantidadCell = findLabelCell(aoa, L.cantidadAProducir, ofCell.r);
  const cantidadPlanificada = normalizeDecimal(cantidadCell ? valueRightOf(aoa, cantidadCell.r, cantidadCell.c) : "");

  const fechaCreacionCell = findLabelCell(aoa, L.fechaCreacion, ofCell.r);
  const fechaCreacion = parseOdooDate(fechaCreacionCell ? valueRightOf(aoa, fechaCreacionCell.r, fechaCreacionCell.c) : "");

  const depositoCell = findLabelCell(aoa, L.depositoDestino, ofCell.r);
  const depositoDestino = depositoCell ? valueRightOf(aoa, depositoCell.r, depositoCell.c) : "";

  const vendedorCell = findLabelCell(aoa, L.vendedor, ofCell.r);
  const vendedor = vendedorCell ? valueRightOf(aoa, vendedorCell.r, vendedorCell.c) : "";

  // Tabla de componentes (informativa — nunca reemplaza la LDP interna).
  const codigoHeaderCell = findLabelCell(aoa, L.codigoHeader, ofCell.r + 1);
  const itemsRaw = [];
  let fichaTecnicaRow = null;
  if (codigoHeaderCell) {
    const productoHeaderCell = findLabelCell(aoa, L.productoHeader, codigoHeaderCell.r, codigoHeaderCell.r + 1);
    const cantidadHeaderCell = findLabelCell(aoa, L.cantidadHeader, Math.max(0, codigoHeaderCell.r - 2), codigoHeaderCell.r + 1);
    const colCodigo = codigoHeaderCell.c;
    const colProducto = productoHeaderCell ? productoHeaderCell.c : null;
    const colCantidad = cantidadHeaderCell ? cantidadHeaderCell.c : null;
    for (let r = codigoHeaderCell.r + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      if (row.some((v) => typeof v === "string" && L.fichaTecnica.test(v.trim()))) { fichaTecnicaRow = r; break; }
      const codigoVal = row[colCodigo];
      if (codigoVal !== undefined && codigoVal !== null && String(codigoVal).trim() !== "") {
        itemsRaw.push({
          codigo: String(codigoVal).trim(),
          nombre: colProducto != null ? String(row[colProducto] ?? "").trim() : "",
          cantidad: colCantidad != null ? normalizeDecimal(String(row[colCantidad] ?? "").trim()) : "",
        });
      }
    }
  }

  // FICHA TÉCNICA: se guarda cruda (fila, celda, valor) desde donde aparece
  // la etiqueta hasta "Impreso:" (pie del reporte) o el final de la hoja —
  // sin interpretar casilleros. Puramente informativo para el operador.
  const fichaTecnicaRaw = [];
  if (fichaTecnicaRow != null) {
    for (let r = fichaTecnicaRow; r < aoa.length; r++) {
      const row = aoa[r] || [];
      if (row.some((v) => typeof v === "string" && /^Impreso\s*:/i.test(v.trim()))) break;
      row.forEach((v, c) => {
        if (typeof v === "string" && v.trim() !== "") fichaTecnicaRaw.push({ r, c, valor: v.trim() });
      });
    }
  }

  const ofRow = {
    fila: sourceLabel || externalOfId,
    externalOfId, numero: externalOfId,
    fecha: parseOdooDate(fechaDesdeRaw), fechaRaw: fechaDesdeRaw,
    fechaPlanificacion: parseOdooDate(fechaDesdeRaw),
    fechaPlanificacionHasta: parseOdooDate(fechaHastaRaw),
    fechaCreacion,
    productoCodigo, productoNombre, ean13: null,
    cantidadPlanificada, estadoOrigen: estadoOrigen || null,
    prioridad: null,
    clienteCodigo, clienteNombre,
    depositoDestino: depositoDestino || null, vendedor: vendedor || null,
    itemsRaw, fichaTecnicaRaw,
  };
  return { ofRow, errors: [] };
}

/** Junta los resultados de parsear varios archivos (uno por OF, formato real
 * de reporte impreso — o una mezcla con archivos tabulares) en un único
 * `{ ofRows, errors }`, con la MISMA detección de número de OF repetido que
 * ya hace parseAcquaImportRows para un solo archivo, más la detección de un
 * mismo ID_OF apareciendo en dos archivos distintos de la misma tanda. */
export function combineAcquaImportResults(results) {
  const ofRows = [];
  const errors = [];
  (results || []).forEach((res) => {
    (res?.ofRows || []).forEach((r) => ofRows.push(r));
    (res?.errors || []).forEach((e) => errors.push(e));
  });
  const numeroCount = new Map();
  ofRows.forEach((r) => numeroCount.set(r.numero, (numeroCount.get(r.numero) || 0) + 1));
  const extIdCount = new Map();
  ofRows.forEach((r) => extIdCount.set(r.externalOfId, (extIdCount.get(r.externalOfId) || 0) + 1));
  ofRows.forEach((r) => {
    if (numeroCount.get(r.numero) > 1) errors.push({ fila: r.fila, message: `Número de OF "${r.numero}" repetido en la selección — revisar los archivos de origen.` });
    else if (extIdCount.get(r.externalOfId) > 1) errors.push({ fila: r.fila, message: `La OF con ID "${r.externalOfId}" aparece repetida en la selección de archivos.` });
  });
  return { ofRows, errors };
}

// ---------------------------------------------------------------------------
// EXPORTACIÓN
// ---------------------------------------------------------------------------

/** Construye las filas planas del archivo de retorno a ACQUA a partir de UNA
 * OF cerrada y sus movimientos reales ya resueltos a forma simple (sin tocar
 * Supabase — eso lo hace app.js antes de llamar acá). `movimientos` es un
 * array de `{ tipo: 'consumo'|'sustitucion'|'cierre', productoCodigo,
 * productoNombre, ean13, cantidadPlanificada, cantidadReal,
 * productoOriginalCodigo, productoSustitutoCodigo, cantidadSustituida,
 * fecha, usuario, idMovimiento }` — ya filtrados por quien llama para excluir
 * lo ya exportado antes (la deduplicación por movimiento vive en la base,
 * no aquí: este adaptador no sabe qué se exportó ya). */
export function buildAcquaExportRows(of, movimientos) {
  return (movimientos || []).map((m) => ({
    of: of.numero,
    externalOfId: of.externalOfId || "",
    productoTerminadoCodigo: of.productoTerminadoCodigo || "",
    productoTerminadoNombre: of.productoTerminadoNombre || "",
    tipoMovimiento: m.tipo,
    productoCodigo: m.productoCodigo || "",
    productoNombre: m.productoNombre || "",
    ean13: m.ean13 || "",
    cantidadPlanificada: m.cantidadPlanificada ?? "",
    cantidadReal: m.cantidadReal ?? "",
    productoOriginalCodigo: m.productoOriginalCodigo || "",
    productoSustitutoCodigo: m.productoSustitutoCodigo || "",
    cantidadSustituida: m.cantidadSustituida ?? "",
    fecha: m.fecha || "",
    usuario: m.usuario || "",
    estado: of.estado || "COMPLETADA",
    idMovimiento: m.idMovimiento,
  }));
}

/** Filas de exportación → array-of-arrays (para XLSXStyle.utils.aoa_to_sheet
 * en app.js, que es quien tiene la dependencia de xlsx-js-style). Primera
 * fila = encabezados según `ACQUA_EXPORT_COLUMNS` (o el mapeo configurado). */
export function exportRowsToAOA(rows, columns = ACQUA_EXPORT_COLUMNS) {
  const header = columns.map((c) => c.label);
  const body = rows.map((r) => columns.map((c) => r[c.key] ?? ""));
  return [header, ...body];
}

/** Mismo contenido en CSV plano (separador ";", más tolerante para ERPs que
 * no abren XLSX directamente) — alternativa de formato ya funcional, no sólo
 * declarada; ver ACQUA_CONFIG_DEFAULTS.formatoExportacion en app.js. */
export function exportRowsToCsv(rows, columns = ACQUA_EXPORT_COLUMNS) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(";")];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c.key] ?? "")).join(";"));
  return lines.join("\r\n");
}

/** Genera un código de lote de exportación legible y ordenable:
 * ACQUA-AAAAMMDD-NNNN, con NNNN correlativo dentro del mismo día (a partir
 * de cuántos lotes ya existen ese día — lo decide app.js, que es quien
 * puede mirar `state.acqua_export_batches`; esta función sólo formatea). */
export function formatExportBatchId(date, seqInDay) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `ACQUA-${y}${m}${d}-${String(seqInDay).padStart(4, "0")}`;
}
