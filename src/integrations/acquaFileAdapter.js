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
