/* ============================================================================
   LOGÍSTICA PERONA — lógica de aplicación
   SPA vanilla JS. Persistencia real en Supabase (Postgres + Auth + Realtime)
   y mapa real con Google Maps Platform (Maps JS API, Places API (New),
   Geocoding, Directions, Street View).
   ========================================================================== */
import { COLLECTIONS, loadAll, saveRecord, deleteRecord, subscribeCollection, callRpc } from "./db.js";
import { signIn, signUp, signOut, getSession, onAuthStateChange } from "./auth.js";
import {
  mountMap, mountPickerMap, destroyMap, geocodeAddress, mountLogisticsMap, focusLogisticsMap,
  googleMapsKeyConfigured, searchPlacesAutocomplete, getPlaceById, createPlacesSessionToken,
  calculateRoute, openStreetView,
} from "./map.js";
import * as XLSXStyle from "xlsx-js-style";
import { fmtMoney, expedicionStageFromStatus, haversineKm, transportRateCost, expedicionPuntuar, expedicionChecklist } from "./domain/expedicion.js";
import { orderGeoPoint, transportBasePoint, computeOperationalKpis, nodeSummary, distinctValues, zoneCoverageMarkers, incidentGeoPoint } from "./domain/geo.js";
import { cameraScanSupported, detectDeviceLabel, openCameraScan } from "./domain/barcode.js";

/* ---------------------------------------------------------------------------
   0. UTILIDADES
   ------------------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Las columnas "id" en Supabase son tipo uuid: generamos UUIDs reales.
// El prefijo (p) ya no se usa en el id — se conserva el parámetro para no
// tener que tocar cada llamada uid("ord"), uid("cus"), etc.
const uid = (_p) => (crypto.randomUUID ? crypto.randomUUID() : uuidFallback());
function uuidFallback() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
const todayISO = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function parseDate(d) { return d ? new Date(d + (d.length === 10 ? "T00:00:00" : "")) : null; }
function fmtDate(d) {
  if (!d) return "—";
  const dt = parseDate(d);
  return dt.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtDateShort(d) {
  if (!d) return "—";
  const dt = parseDate(d);
  return dt.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  return dt.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" }) + " " +
    dt.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}
function daysBetween(a, b) {
  const A = parseDate(a), B = parseDate(b);
  if (!A || !B) return null;
  return Math.round((B - A) / 86400000);
}
function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "recién";
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return `hace ${Math.floor(diff / 86400)} d`;
}
function toast(msg, kind = "ok") {
  const host = $("#toast-host");
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<span class="toast-dot"></span><span>${esc(msg)}</span>`;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 250); }, 3200);
}
function animateCount(el, to, opts = {}) {
  const from = 0, dur = opts.dur ?? 700, start = performance.now();
  const suffix = opts.suffix || "";
  function step(t) {
    const p = clamp((t - start) / dur, 0, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * eased) + suffix;
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ---------------------------------------------------------------------------
   1. CONSTANTES DE DOMINIO
   ------------------------------------------------------------------------- */
const ORDER_FLOW = ["pendiente", "preparacion", "preparado", "controlado", "despachado", "en_camino", "entregado"];
const ORDER_META = {
  pendiente:    { label: "Pendiente",     dot: "🟡", cls: "st-yellow" },
  preparacion:  { label: "En preparación",dot: "🔵", cls: "st-blue" },
  preparado:    { label: "Preparado",     dot: "🟣", cls: "st-violet" },
  controlado:   { label: "Controlado",    dot: "🟣", cls: "st-violet" },
  despachado:   { label: "Despachado",    dot: "🟠", cls: "st-orange" },
  en_camino:    { label: "En camino",     dot: "🚚", cls: "st-orange" },
  entregado:    { label: "Entregado",     dot: "🟢", cls: "st-green" },
  incidencia:   { label: "Incidencia",    dot: "🔴", cls: "st-red" },
  cancelado:    { label: "Cancelado",     dot: "⚫", cls: "st-gray" },
};

const PO_FLOW = ["generada", "confirmada", "preparando", "despachada", "en_transito", "llegada", "recibida", "controlada", "cerrada"];
const PO_META = {
  generada:    { label: "OC generada",           dot: "🟡", cls: "st-yellow" },
  confirmada:  { label: "Confirmada",            dot: "🔵", cls: "st-blue" },
  preparando:  { label: "Preparando proveedor",  dot: "🔵", cls: "st-blue" },
  despachada:  { label: "Despachada",            dot: "🟠", cls: "st-orange" },
  en_transito: { label: "En tránsito",           dot: "🚚", cls: "st-orange" },
  llegada:     { label: "Llegada a destino",     dot: "🟣", cls: "st-violet" },
  recibida:    { label: "Recibida",              dot: "🟣", cls: "st-violet" },
  controlada:  { label: "Controlada",            dot: "🟢", cls: "st-green" },
  cerrada:     { label: "Cerrada",               dot: "⚫", cls: "st-gray" },
  incidencia:  { label: "Incidencia",            dot: "🔴", cls: "st-red" },
};

const INCIDENT_FLOW = ["abierta", "en_tratamiento", "resuelta", "cerrada"];
const INCIDENT_META = {
  abierta:        { label: "Abierta",        cls: "st-red" },
  en_tratamiento: { label: "En tratamiento", cls: "st-orange" },
  resuelta:       { label: "Resuelta",       cls: "st-blue" },
  cerrada:        { label: "Cerrada",        cls: "st-gray" },
};

const TASK_FLOW = ["pendiente", "en_curso", "completada"];
const TASK_META = {
  pendiente:  { label: "Pendiente",  cls: "st-yellow" },
  en_curso:   { label: "En curso",   cls: "st-blue" },
  completada: { label: "Completada", cls: "st-green" },
};

const PRIORITY_META = {
  baja:    { label: "Baja",    cls: "pr-low" },
  media:   { label: "Media",   cls: "pr-mid" },
  alta:    { label: "Alta",    cls: "pr-high" },
  urgente: { label: "Urgente", cls: "pr-urgent" },
};

const LOCATION_TYPES = {
  cliente:   { label: "Cliente",   icon: "📍" },
  proveedor: { label: "Proveedor", icon: "🏭" },
  deposito:  { label: "Depósito",  icon: "🏢" },
  otro:      { label: "Otro",      icon: "📌" },
};

const VEHICLE_TYPES = {
  camion:     { label: "Camión", icon: "🚛" },
  auto:       { label: "Auto / utilitario", icon: "🚗" },
  moto:       { label: "Moto", icon: "🏍️" },
  furgon:     { label: "Furgón", icon: "🚐" },
  utilitario: { label: "Utilitario", icon: "🚙" },
  combi:      { label: "Combi", icon: "🚐" },
  camioneta:  { label: "Camioneta", icon: "🛻" },
};
function vehicleBadges(t) {
  const types = Array.isArray(t.vehicleTypes) ? t.vehicleTypes : [];
  if (!types.length) return "";
  return types.map((k) => VEHICLE_TYPES[k] ? `<span class="badge st-blue">${VEHICLE_TYPES[k].icon} ${VEHICLE_TYPES[k].label}</span>` : "").join(" ");
}

/* ---------------------------------------------------------------------------
   2. ESTADO EN MEMORIA + CAPA DE PERSISTENCIA (Supabase)
   ------------------------------------------------------------------------- */
const state = {
  ready: false,
  route: { view: "dashboard", id: null },
  locations: [], customers: [], suppliers: [], transports: [], routes: [],
  inv_suppliers: [], products: [], inventory_lots: [], stock_movements: [], lot_locations: [], app_settings: [],
  box_configs: [], box_config_items: [], production_orders: [],
  ldp_versions: [], ldp_version_items: [], manufacturing_orders: [], production_reservations: [], production_consumptions: [], production_substitutions: [], production_audit_log: [],
  orders: [], purchase_orders: [], incidents: [], tasks: [],
  dispatch_details: [], transport_rates: [], transport_selections: [], client_notifications: [],
  logistics_zones: [],
  integration_sync_logs: [], integration_errors: [],
  search: "",
  mapFilter: "todos",
  auth: false,
  session: null, // sesión de Supabase Auth
};

let unsubscribers = [];

async function initStore() {
  const all = await loadAll();
  COLLECTIONS.forEach((c) => (state[c] = all[c]));
  state.ready = true;
  renderApp();
  reconcileExpiredLots();

  // Tiempo real: si tenés la app abierta en dos pestañas o dispositivos, se
  // reflejan los cambios sin recargar.
  unsubscribers.forEach((u) => u());
  unsubscribers = COLLECTIONS.map((col) =>
    subscribeCollection(col, async () => {
      const fresh = await loadAll();
      COLLECTIONS.forEach((c) => (state[c] = fresh[c]));
      renderApp();
    })
  );
}

function teardownStore() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  COLLECTIONS.forEach((c) => (state[c] = []));
  state.ready = false;
}

async function persist(col, rec) {
  const arr = state[col];
  const i = arr.findIndex((r) => r.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec); // actualización optimista
  try {
    const saved = await saveRecord(col, rec);
    const j = state[col].findIndex((r) => r.id === saved.id);
    if (j >= 0) state[col][j] = saved;
  } catch (e) {
    console.error(e);
    toast("No se pudo guardar en Supabase: " + (e.message || "error desconocido"), "warn");
  }
}

async function removeRecord(col, id) {
  state[col] = state[col].filter((r) => r.id !== id);
  try { await deleteRecord(col, id); } catch (e) { console.error(e); toast("No se pudo borrar en Supabase", "warn"); }
}

function getById(col, id) { return state[col].find((r) => r.id === id); }
function locName(id) { const l = getById("locations", id); return l ? l.name : "—"; }

/* ---------------------------------------------------------------------------
   3. CÁLCULOS DERIVADOS (sin persistir — solo visuales)
   ------------------------------------------------------------------------- */
function orderUrgency(o) {
  if (o.status === "entregado") return { key: "entregado", label: "Entregada", cls: "st-green", dot: "🟢" };
  if (o.status === "cancelado") return { key: "cancelado", label: "Cancelado", cls: "st-gray", dot: "⚫" };
  const d = daysBetween(todayISO(), o.expectedDate);
  if (d === null) return { key: "sf", label: "Sin fecha", cls: "st-gray", dot: "—" };
  if (d < 0) return { key: "atrasada", label: `Atrasada ${Math.abs(d)}d`, cls: "st-red", dot: "🔴" };
  if (d === 0) return { key: "hoy", label: "Entrega hoy", cls: "st-orange", dot: "🟠" };
  if (d === 1) return { key: "manana", label: "Entrega mañana", cls: "st-yellow", dot: "🟡" };
  return { key: "proxima", label: `En ${d} días`, cls: "st-gray", dot: "⚪" };
}
function poUrgency(po) {
  if (["recibida", "controlada", "cerrada"].includes(po.status)) return { key: "ok", label: PO_META[po.status].label, cls: "st-green" };
  const d = daysBetween(todayISO(), po.expectedArrival);
  if (d === null) return { key: "sf", label: "Sin fecha", cls: "st-gray" };
  if (d < 0) return { key: "atrasada", label: `Atrasada ${Math.abs(d)}d`, cls: "st-red" };
  if (d === 0) return { key: "hoy", label: "Llega hoy", cls: "st-orange" };
  return { key: "proxima", label: `En ${d} días`, cls: "st-gray" };
}

function kpis() {
  const orders = state.orders;
  const activeOrders = orders.filter((o) => !["entregado", "cancelado"].includes(o.status));
  const deliveredToday = orders.filter((o) => o.status === "entregado" && o.actualDeliveryDate === todayISO());
  const dueToday = orders.filter((o) => o.status !== "entregado" && o.status !== "cancelado" && o.expectedDate === todayISO());
  const late = orders.filter((o) => o.status !== "entregado" && o.status !== "cancelado" && daysBetween(todayISO(), o.expectedDate) < 0);
  const poInTransit = state.purchase_orders.filter((p) => p.status === "en_transito");
  const poArrivingToday = state.purchase_orders.filter((p) => p.expectedArrival === todayISO() && !["recibida", "controlada", "cerrada"].includes(p.status));
  const openIncidents = state.incidents.filter((i) => !["resuelta", "cerrada"].includes(i.status));
  const pendingTasks = state.tasks.filter((t) => t.status !== "completada");
  return { activeOrders, deliveredToday, dueToday, late, poInTransit, poArrivingToday, openIncidents, pendingTasks };
}

/* ---------------------------------------------------------------------------
   4. ROUTER
   ------------------------------------------------------------------------- */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [view, id, sub] = h.split("/").filter(Boolean);
  return { view: view || "dashboard", id: id || null, sub: sub || null };
}
window.addEventListener("hashchange", () => { state.route = parseHash(); renderApp(); window.scrollTo(0, 0); });

/* ---------------------------------------------------------------------------
   5. COMPONENTES REUTILIZABLES (como funciones que devuelven HTML)
   ------------------------------------------------------------------------- */
function statusBadge(meta) {
  if (!meta) return "";
  return `<span class="badge ${meta.cls}"><i class="dot-ind ${meta.cls}"></i>${esc(meta.label)}</span>`;
}
function priorityBadge(p) {
  const m = PRIORITY_META[p] || PRIORITY_META.media;
  return `<span class="pill ${m.cls}">${esc(m.label)}</span>`;
}
function dateUrgencyBadge(u) {
  return `<span class="badge ${u.cls}"><i class="dot-ind ${u.cls}"></i>${esc(u.label)}</span>`;
}
function progressBar(flow, meta, current) {
  const idx = flow.indexOf(current);
  return `<div class="flowbar">${flow.map((s, i) => {
    const state_ = idx < 0 ? "pending" : i < idx ? "done" : i === idx ? "current" : "pending";
    return `<div class="flowstep ${state_}">
      <div class="flowdot">${state_ === "done" ? "✓" : state_ === "current" ? "●" : "○"}</div>
      <div class="flowlabel">${esc(meta[s].label)}</div>
    </div>`;
  }).join(`<div class="flowline"></div>`)}</div>`;
}
function emptyState(icon, title, sub, actionHtml = "") {
  return `<div class="empty-state">
    <div class="empty-icon">${icon}</div>
    <div class="empty-title">${esc(title)}</div>
    <div class="empty-sub">${esc(sub)}</div>
    ${actionHtml}
  </div>`;
}
function kpiCard(value, label, icon, cls, delay) {
  return `<div class="kpi-card" style="--d:${delay}ms">
    <div class="kpi-icon ${cls}">${icon}</div>
    <div class="kpi-value" data-count="${value}">0</div>
    <div class="kpi-label">${esc(label)}</div>
  </div>`;
}
/** Card principal del dashboard: una métrica con más jerarquía visual que el resto. */
function heroKpiCard(label, value, subParts) {
  return `<div class="kpi-hero">
    <div class="kpi-hero-label">${esc(label)}</div>
    <div class="kpi-hero-value" data-count="${value}">0</div>
    <div class="kpi-hero-sub">${subParts.map((p) => `<span>${esc(p.label)}: <b data-count="${p.value}">0</b></span>`).join("")}</div>
  </div>`;
}
function routeLine(activeCount = 0) {
  const dots = [0, 1, 2];
  return `<div class="route-line">${dots.map((i) => `<span class="rl-dot ${i < activeCount ? "on" : ""}"></span>${i < 2 ? '<span class="rl-seg"></span>' : ""}`).join("")}</div>`;
}
function avatarInitials(name) {
  return (name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

/* ---------------------------------------------------------------------------
   6. DATOS DE DEMOSTRACIÓN
   ------------------------------------------------------------------------- */
function buildSeed() {
  const locations = [
    { id: "loc_dep1", type: "deposito", name: "Depósito Central Perona", address: "Av. Circunvalación 4520", city: "Córdoba", province: "Córdoba", lat: -31.4201, lng: -64.1888, contact: "", phone: "", notes: "Depósito principal de operaciones." },
    { id: "loc_c1", type: "cliente", name: "Distribuidora del Sur", address: "San Martín 850", city: "Córdoba", province: "Córdoba", lat: -31.44, lng: -64.19, contact: "Marcos Ibarra", phone: "351-455-1122" },
    { id: "loc_c2", type: "cliente", name: "Almacén Rivadavia", address: "Rivadavia 1203", city: "Rosario", province: "Santa Fe", lat: -32.95, lng: -60.65, contact: "Celeste Duarte", phone: "341-233-9087" },
    { id: "loc_c3", type: "cliente", name: "Comercial Litoral", address: "Bv. Oroño 2140", city: "Rosario", province: "Santa Fe", lat: -32.96, lng: -60.64, contact: "Hugo Ferreyra", phone: "341-455-2231" },
    { id: "loc_c4", type: "cliente", name: "Mayorista Andina", address: "Colón 780", city: "Mendoza", province: "Mendoza", lat: -32.89, lng: -68.84, contact: "Rocío Salinas", phone: "261-420-7754" },
    { id: "loc_c5", type: "cliente", name: "Norte Insumos", address: "Belgrano 430", city: "Tucumán", province: "Tucumán", lat: -26.82, lng: -65.22, contact: "Damián Coria", phone: "381-455-9021" },
    { id: "loc_c6", type: "cliente", name: "Ferretería Central Bahía", address: "Alsina 90", city: "Bahía Blanca", province: "Buenos Aires", lat: -38.71, lng: -62.27, contact: "Julieta Moyano", phone: "291-455-3312" },
    { id: "loc_c7", type: "cliente", name: "Almacén Plaza La Plata", address: "Calle 7 n.º 850", city: "La Plata", province: "Buenos Aires", lat: -34.92, lng: -57.95, contact: "Nicolás Bertoni", phone: "221-455-6690" },
    { id: "loc_c8", type: "cliente", name: "Distribuciones Cuyo", address: "San Juan 560", city: "San Juan", province: "San Juan", lat: -31.53, lng: -68.52, contact: "Agustina Peralta", phone: "264-455-8871" },
    { id: "loc_p1", type: "proveedor", name: "Proveedor Industrias Córdoba", address: "Ruta 9 km 12", city: "Córdoba", province: "Córdoba", lat: -31.3, lng: -64.2, contact: "Pablo Nuñez", phone: "351-420-1100" },
    { id: "loc_p2", type: "proveedor", name: "Textilera del Litoral SA", address: "Ruta 33 km 4", city: "Rosario", province: "Santa Fe", lat: -32.9, lng: -60.7, contact: "Verónica Sosa", phone: "341-420-3388" },
    { id: "loc_p3", type: "proveedor", name: "Envases del Oeste", address: "Acceso Norte 2200", city: "Mendoza", province: "Mendoza", lat: -32.85, lng: -68.8, contact: "Ezequiel Vargas", phone: "261-420-9012" },
    { id: "loc_p4", type: "proveedor", name: "Metalúrgica San Nicolás", address: "Av. Savio 1400", city: "San Nicolás", province: "Buenos Aires", lat: -33.33, lng: -60.21, contact: "Lorena Aquino", phone: "336-420-5567" },
    { id: "loc_p5", type: "proveedor", name: "Insumos del Norte SRL", address: "Ruta 38 km 8", city: "Tucumán", province: "Tucumán", lat: -26.9, lng: -65.3, contact: "Franco Ledesma", phone: "381-420-6643" },
  ];

  const customers = [
    { id: "cus_1", name: "Distribuidora del Sur", phone: "351-455-1122", locationId: "loc_c1", notes: "" },
    { id: "cus_2", name: "Almacén Rivadavia", phone: "341-233-9087", locationId: "loc_c2", notes: "" },
    { id: "cus_3", name: "Comercial Litoral", phone: "341-455-2231", locationId: "loc_c3", notes: "" },
    { id: "cus_4", name: "Mayorista Andina", phone: "261-420-7754", locationId: "loc_c4", notes: "" },
    { id: "cus_5", name: "Norte Insumos", phone: "381-455-9021", locationId: "loc_c5", notes: "" },
    { id: "cus_6", name: "Ferretería Central Bahía", phone: "291-455-3312", locationId: "loc_c6", notes: "" },
    { id: "cus_7", name: "Almacén Plaza La Plata", phone: "221-455-6690", locationId: "loc_c7", notes: "" },
    { id: "cus_8", name: "Distribuciones Cuyo", phone: "264-455-8871", locationId: "loc_c8", notes: "" },
  ];

  const suppliers = [
    { id: "sup_1", name: "Proveedor Industrias Córdoba", locationId: "loc_p1", contact: "Pablo Nuñez", phone: "351-420-1100", email: "ventas@induscba.com.ar", notes: "Provee insumos metálicos.", usualTransports: ["tra_1"] },
    { id: "sup_2", name: "Textilera del Litoral SA", locationId: "loc_p2", contact: "Verónica Sosa", phone: "341-420-3388", email: "pedidos@textilitoral.com.ar", notes: "Rollos e hilados.", usualTransports: ["tra_2"] },
    { id: "sup_3", name: "Envases del Oeste", locationId: "loc_p3", contact: "Ezequiel Vargas", phone: "261-420-9012", email: "contacto@envasesoeste.com.ar", notes: "Envases plásticos.", usualTransports: ["tra_3"] },
    { id: "sup_4", name: "Metalúrgica San Nicolás", locationId: "loc_p4", contact: "Lorena Aquino", phone: "336-420-5567", email: "info@metsn.com.ar", notes: "", usualTransports: ["tra_1", "tra_4"] },
    { id: "sup_5", name: "Insumos del Norte SRL", locationId: "loc_p5", contact: "Franco Ledesma", phone: "381-420-6643", email: "ventas@insumosnorte.com.ar", notes: "", usualTransports: ["tra_2"] },
  ];

  const transports = [
    { id: "tra_1", name: "Transporte Yunes", contact: "Carlos Yunes", phone: "351-500-1234", email: "carlos@transporteyunes.com.ar", type: "Camión completo", notes: "Rutas Córdoba - Buenos Aires." },
    { id: "tra_2", name: "Vía Litoral Cargas", contact: "Marina Gómez", phone: "341-500-5678", email: "operaciones@vialitoral.com.ar", type: "Paquetería", notes: "Rutas Santa Fe - Rosario." },
    { id: "tra_3", name: "Cuyo Express", contact: "Adrián Ríos", phone: "261-500-9911", email: "despacho@cuyoexpress.com.ar", type: "Camión completo", notes: "Cobertura Cuyo." },
    { id: "tra_4", name: "Transporte del Norte", contact: "Brenda Ortiz", phone: "381-500-4432", email: "info@transnorte.com.ar", type: "Media carga", notes: "Rutas NOA." },
  ];

  const mkHist = (steps) => steps.map((s) => ({ from: s.from, to: s.to, date: s.date, note: s.note || "" }));

  const orders = [
    { id: "ord_1", number: "1528", customerId: "cus_1", customerName: "Distribuidora del Sur", phone: "351-455-1122", address: "San Martín 850", locationId: "loc_c1", orderDate: "2026-09-08", expectedDate: "2026-09-09", expectedTime: "14:00", priority: "alta",
      items: [{ product: "Perfil de aluminio 6m", qty: 40 }, { product: "Tornillería surtida", qty: 12 }],
      notes: "Entregar por playa de carga trasera.", status: "en_camino", transportId: "tra_1", dispatchDate: "2026-09-11T11:25:00", actualDeliveryDate: null, incidentId: null,
      history: mkHist([
        { from: null, to: "pendiente", date: "2026-09-08T08:30:00" },
        { from: "pendiente", to: "preparacion", date: "2026-09-08T09:10:00" },
        { from: "preparacion", to: "preparado", date: "2026-09-08T10:15:00" },
        { from: "preparado", to: "controlado", date: "2026-09-08T10:30:00" },
        { from: "controlado", to: "despachado", date: "2026-09-11T11:00:00" },
        { from: "despachado", to: "en_camino", date: "2026-09-11T11:25:00" },
      ]) },
    { id: "ord_2", number: "1529", customerId: "cus_2", customerName: "Almacén Rivadavia", phone: "341-233-9087", address: "Rivadavia 1203", locationId: "loc_c2", orderDate: "2026-09-09", expectedDate: "2026-09-11", expectedTime: "10:00", priority: "media",
      items: [{ product: "Cajas de cartón reforzado", qty: 200 }], notes: "", status: "despachado", transportId: "tra_2", dispatchDate: "2026-09-11T08:00:00", actualDeliveryDate: null, incidentId: null,
      history: mkHist([{ from: null, to: "pendiente", date: "2026-09-09T09:00:00" }, { from: "pendiente", to: "preparacion", date: "2026-09-10T08:30:00" }, { from: "preparacion", to: "preparado", date: "2026-09-10T15:00:00" }, { from: "preparado", to: "controlado", date: "2026-09-11T07:40:00" }, { from: "controlado", to: "despachado", date: "2026-09-11T08:00:00" }]) },
    { id: "ord_3", number: "1530", customerId: "cus_3", customerName: "Comercial Litoral", phone: "341-455-2231", address: "Bv. Oroño 2140", locationId: "loc_c3", orderDate: "2026-09-09", expectedDate: "2026-09-10", expectedTime: "", priority: "urgente",
      items: [{ product: "Bobinas de film stretch", qty: 30 }], notes: "Cliente reclamó demora.", status: "incidencia", transportId: "tra_2", dispatchDate: null, actualDeliveryDate: null, incidentId: "inc_1",
      history: mkHist([{ from: null, to: "pendiente", date: "2026-09-09T09:20:00" }, { from: "pendiente", to: "preparacion", date: "2026-09-09T14:00:00" }, { from: "preparacion", to: "incidencia", date: "2026-09-10T09:00:00", note: "Falta de stock de bobinas." }]) },
    { id: "ord_4", number: "1531", customerId: "cus_4", customerName: "Mayorista Andina", phone: "261-420-7754", address: "Colón 780", locationId: "loc_c4", orderDate: "2026-09-10", expectedDate: "2026-09-12", expectedTime: "09:00", priority: "media",
      items: [{ product: "Bidones 20L", qty: 60 }], notes: "", status: "preparado", transportId: "tra_3", dispatchDate: null, actualDeliveryDate: null, incidentId: null,
      history: mkHist([{ from: null, to: "pendiente", date: "2026-09-10T08:00:00" }, { from: "pendiente", to: "preparacion", date: "2026-09-10T09:00:00" }, { from: "preparacion", to: "preparado", date: "2026-09-11T08:00:00" }]) },
    { id: "ord_5", number: "1532", customerId: "cus_5", customerName: "Norte Insumos", phone: "381-455-9021", address: "Belgrano 430", locationId: "loc_c5", orderDate: "2026-09-10", expectedDate: "2026-09-13", expectedTime: "", priority: "baja",
      items: [{ product: "Repuestos varios", qty: 15 }], notes: "Pendiente de preparación.", status: "pendiente", transportId: "tra_4", dispatchDate: null, actualDeliveryDate: null, incidentId: null,
      history: mkHist([{ from: null, to: "pendiente", date: "2026-09-10T10:00:00" }]) },
    { id: "ord_6", number: "1533", customerId: "cus_6", customerName: "Ferretería Central Bahía", phone: "291-455-3312", address: "Alsina 90", locationId: "loc_c6", orderDate: "2026-09-07", expectedDate: "2026-09-09", expectedTime: "11:00", priority: "alta",
      items: [{ product: "Herramientas surtidas", qty: 25 }], notes: "", status: "entregado", transportId: "tra_1", dispatchDate: "2026-09-08T09:00:00", actualDeliveryDate: "2026-09-09", incidentId: null,
      history: mkHist([{ from: null, to: "pendiente", date: "2026-09-07T08:00:00" }, { from: "pendiente", to: "preparacion", date: "2026-09-07T10:00:00" }, { from: "preparacion", to: "preparado", date: "2026-09-07T15:00:00" }, { from: "preparado", to: "controlado", date: "2026-09-08T08:00:00" }, { from: "controlado", to: "despachado", date: "2026-09-08T09:00:00" }, { from: "despachado", to: "en_camino", date: "2026-09-08T09:30:00" }, { from: "en_camino", to: "entregado", date: "2026-09-09T11:10:00" }]) },
    { id: "ord_7", number: "1534", customerId: "cus_7", customerName: "Almacén Plaza La Plata", phone: "221-455-6690", address: "Calle 7 n.º 850", locationId: "loc_c7", orderDate: "2026-09-11", expectedDate: "2026-09-15", expectedTime: "", priority: "media",
      items: [{ product: "Estanterías metálicas", qty: 8 }], notes: "", status: "preparacion", transportId: "tra_1", dispatchDate: null, actualDeliveryDate: null, incidentId: null,
      history: mkHist([{ from: null, to: "pendiente", date: "2026-09-11T08:10:00" }, { from: "pendiente", to: "preparacion", date: "2026-09-11T09:00:00" }]) },
    { id: "ord_8", number: "1535", customerId: "cus_8", customerName: "Distribuciones Cuyo", phone: "264-455-8871", address: "San Juan 560", locationId: "loc_c8", orderDate: "2026-09-06", expectedDate: "2026-09-08", expectedTime: "", priority: "alta",
      items: [{ product: "Pallets de mercadería surtida", qty: 4 }], notes: "Reclamo por atraso.", status: "controlado", transportId: "tra_3", dispatchDate: null, actualDeliveryDate: null, incidentId: null,
      history: mkHist([{ from: null, to: "pendiente", date: "2026-09-06T08:00:00" }, { from: "pendiente", to: "preparacion", date: "2026-09-06T09:00:00" }, { from: "preparacion", to: "preparado", date: "2026-09-07T09:00:00" }, { from: "preparado", to: "controlado", date: "2026-09-08T09:00:00" }]) },
    { id: "ord_9", number: "1536", customerId: "cus_1", customerName: "Distribuidora del Sur", phone: "351-455-1122", address: "San Martín 850", locationId: "loc_c1", orderDate: "2026-09-11", expectedDate: "2026-09-11", expectedTime: "17:00", priority: "urgente",
      items: [{ product: "Repuesto urgente motor", qty: 1 }], notes: "Cliente espera en planta.", status: "preparado", transportId: "tra_1", dispatchDate: null, actualDeliveryDate: null, incidentId: null,
      history: mkHist([{ from: null, to: "pendiente", date: "2026-09-11T09:00:00" }, { from: "pendiente", to: "preparacion", date: "2026-09-11T09:20:00" }, { from: "preparacion", to: "preparado", date: "2026-09-11T10:00:00" }]) },
    { id: "ord_10", number: "1537", customerId: "cus_2", customerName: "Almacén Rivadavia", phone: "341-233-9087", address: "Rivadavia 1203", locationId: "loc_c2", orderDate: "2026-09-05", expectedDate: "2026-09-07", expectedTime: "", priority: "baja",
      items: [{ product: "Pedido cancelado por cliente", qty: 0 }], notes: "Cliente canceló la compra.", status: "cancelado", transportId: null, dispatchDate: null, actualDeliveryDate: null, incidentId: null,
      history: mkHist([{ from: null, to: "pendiente", date: "2026-09-05T08:00:00" }, { from: "pendiente", to: "cancelado", date: "2026-09-05T12:00:00", note: "Cancelado por el cliente." }]) },
  ];

  const purchase_orders = [
    { id: "po_1", number: "4587", supplierId: "sup_1", supplierName: "Proveedor Industrias Córdoba", supplierAddress: "Ruta 9 km 12", locationId: "loc_p1", issueDate: "2026-09-10", expectedDispatch: "2026-09-11", expectedArrival: "2026-09-12", actualArrival: null, destination: "Depósito Central Perona", transportId: "tra_1",
      items: [{ product: "Perfiles de aluminio", qty: 500 }], notes: "", status: "en_transito",
      history: mkHist([{ from: null, to: "generada", date: "2026-09-10T09:00:00" }, { from: "generada", to: "confirmada", date: "2026-09-10T11:00:00" }, { from: "confirmada", to: "preparando", date: "2026-09-10T15:00:00" }, { from: "preparando", to: "despachada", date: "2026-09-11T08:00:00" }, { from: "despachada", to: "en_transito", date: "2026-09-11T08:15:00" }]) },
    { id: "po_2", number: "4588", supplierId: "sup_2", supplierName: "Textilera del Litoral SA", supplierAddress: "Ruta 33 km 4", locationId: "loc_p2", issueDate: "2026-09-09", expectedDispatch: "2026-09-10", expectedArrival: "2026-09-11", actualArrival: "2026-09-11", destination: "Depósito Central Perona", transportId: "tra_2",
      items: [{ product: "Rollos de tela", qty: 120 }], notes: "", status: "controlada",
      history: mkHist([{ from: null, to: "generada", date: "2026-09-09T08:00:00" }, { from: "generada", to: "confirmada", date: "2026-09-09T10:00:00" }, { from: "confirmada", to: "preparando", date: "2026-09-09T14:00:00" }, { from: "preparando", to: "despachada", date: "2026-09-10T08:00:00" }, { from: "despachada", to: "en_transito", date: "2026-09-10T08:20:00" }, { from: "en_transito", to: "llegada", date: "2026-09-11T09:00:00" }, { from: "llegada", to: "recibida", date: "2026-09-11T09:30:00" }, { from: "recibida", to: "controlada", date: "2026-09-11T10:15:00" }]) },
    { id: "po_3", number: "4589", supplierId: "sup_3", supplierName: "Envases del Oeste", supplierAddress: "Acceso Norte 2200", locationId: "loc_p3", issueDate: "2026-09-11", expectedDispatch: "2026-09-13", expectedArrival: "2026-09-15", actualArrival: null, destination: "Depósito Central Perona", transportId: "tra_3",
      items: [{ product: "Bidones plásticos 20L", qty: 300 }], notes: "", status: "confirmada",
      history: mkHist([{ from: null, to: "generada", date: "2026-09-11T08:30:00" }, { from: "generada", to: "confirmada", date: "2026-09-11T10:00:00" }]) },
    { id: "po_4", number: "4590", supplierId: "sup_4", supplierName: "Metalúrgica San Nicolás", supplierAddress: "Av. Savio 1400", locationId: "loc_p4", issueDate: "2026-09-08", expectedDispatch: "2026-09-09", expectedArrival: "2026-09-10", actualArrival: null, destination: "Depósito Central Perona", transportId: "tra_4",
      items: [{ product: "Chapas de acero", qty: 80 }], notes: "Demora informada por el proveedor.", status: "incidencia",
      history: mkHist([{ from: null, to: "generada", date: "2026-09-08T08:00:00" }, { from: "generada", to: "confirmada", date: "2026-09-08T09:00:00" }, { from: "confirmada", to: "preparando", date: "2026-09-08T12:00:00" }, { from: "preparando", to: "incidencia", date: "2026-09-09T09:00:00", note: "Rotura de stock en planta." }]) },
    { id: "po_5", number: "4591", supplierId: "sup_5", supplierName: "Insumos del Norte SRL", supplierAddress: "Ruta 38 km 8", locationId: "loc_p5", issueDate: "2026-09-11", expectedDispatch: "2026-09-12", expectedArrival: "2026-09-14", actualArrival: null, destination: "Depósito Central Perona", transportId: "tra_4",
      items: [{ product: "Insumos varios", qty: 200 }], notes: "", status: "generada",
      history: mkHist([{ from: null, to: "generada", date: "2026-09-11T11:00:00" }]) },
    { id: "po_6", number: "4592", supplierId: "sup_1", supplierName: "Proveedor Industrias Córdoba", supplierAddress: "Ruta 9 km 12", locationId: "loc_p1", issueDate: "2026-09-01", expectedDispatch: "2026-09-02", expectedArrival: "2026-09-04", actualArrival: "2026-09-04", destination: "Depósito Central Perona", transportId: "tra_1",
      items: [{ product: "Tornillería industrial", qty: 1000 }], notes: "", status: "cerrada",
      history: mkHist([{ from: null, to: "generada", date: "2026-09-01T08:00:00" }, { from: "generada", to: "confirmada", date: "2026-09-01T09:00:00" }, { from: "confirmada", to: "preparando", date: "2026-09-01T13:00:00" }, { from: "preparando", to: "despachada", date: "2026-09-02T08:00:00" }, { from: "despachada", to: "en_transito", date: "2026-09-02T08:30:00" }, { from: "en_transito", to: "llegada", date: "2026-09-04T09:00:00" }, { from: "llegada", to: "recibida", date: "2026-09-04T09:30:00" }, { from: "recibida", to: "controlada", date: "2026-09-04T10:00:00" }, { from: "controlada", to: "cerrada", date: "2026-09-04T10:30:00" }]) },
  ];

  const incidents = [
    { id: "inc_1", title: "Falta de stock para pedido #1530", description: "No hay bobinas de film stretch suficientes en depósito para completar el pedido.", date: "2026-09-10", priority: "alta", status: "en_tratamiento", responsible: "Alejandro Perona", relatedType: "order", relatedId: "ord_3", resolution: "", resolutionDate: null },
    { id: "inc_2", title: "Demora del proveedor Metalúrgica San Nicolás", description: "El proveedor informó rotura de stock en planta, retrasando la OC #4590.", date: "2026-09-09", priority: "alta", status: "abierta", responsible: "Alejandro Perona", relatedType: "purchase_order", relatedId: "po_4", resolution: "", resolutionDate: null },
    { id: "inc_3", title: "Diferencia en remito de recepción", description: "El remito indicaba 130 rollos y se recibieron 120.", date: "2026-09-05", priority: "media", status: "resuelta", responsible: "Alejandro Perona", relatedType: "purchase_order", relatedId: "po_2", resolution: "Se contactó al proveedor, ajustó la factura.", resolutionDate: "2026-09-06" },
    { id: "inc_4", title: "Domicilio incorrecto en pedido", description: "El cliente cambió de domicilio y no se actualizó a tiempo.", date: "2026-09-03", priority: "baja", status: "cerrada", responsible: "Alejandro Perona", relatedType: "order", relatedId: "ord_6", resolution: "Se corrigió el domicilio antes del despacho.", resolutionDate: "2026-09-04" },
    { id: "inc_5", title: "Transporte no confirmó horario de retiro", description: "Transporte del Norte no confirmó el horario de retiro para la OC #4591.", date: "2026-09-11", priority: "media", status: "abierta", responsible: "Alejandro Perona", relatedType: "transport", relatedId: "tra_4", resolution: "", resolutionDate: null },
  ];

  const tasks = [
    { id: "tsk_1", title: "Revisar órdenes de compra pendientes", date: "2026-09-11", time: "08:00", priority: "media", category: "Compras", status: "completada", notes: "" },
    { id: "tsk_2", title: "Controlar recepción de Textilera del Litoral", date: "2026-09-11", time: "09:00", priority: "alta", category: "Recepción", status: "completada", notes: "" },
    { id: "tsk_3", title: "Confirmar transporte para OC #4591", date: "2026-09-11", time: "10:30", priority: "media", category: "Transporte", status: "en_curso", notes: "" },
    { id: "tsk_4", title: "Controlar pedido #1528 antes del despacho", date: "2026-09-11", time: "11:30", priority: "alta", category: "Pedidos", status: "pendiente", notes: "" },
    { id: "tsk_5", title: "Verificar entrega de pedido #1533", date: "2026-09-11", time: "14:00", priority: "media", category: "Entregas", status: "pendiente", notes: "" },
    { id: "tsk_6", title: "Llamar a Transporte del Norte por demora", date: "2026-09-11", time: "15:00", priority: "alta", category: "Transporte", status: "pendiente", notes: "" },
    { id: "tsk_7", title: "Actualizar estado del pedido #1536", date: "2026-09-11", time: "16:00", priority: "urgente", category: "Pedidos", status: "pendiente", notes: "" },
    { id: "tsk_8", title: "Controlar diferencias de OC #4589", date: "2026-09-12", time: "09:00", priority: "media", category: "Compras", status: "pendiente", notes: "" },
    { id: "tsk_9", title: "Verificar remito de pedido #1534", date: "2026-09-12", time: "10:00", priority: "baja", category: "Pedidos", status: "pendiente", notes: "" },
    { id: "tsk_10", title: "Revisar incidencias abiertas de la semana", date: "2026-09-12", time: "17:00", priority: "media", category: "Incidencias", status: "pendiente", notes: "" },
  ];

  return { locations, customers, suppliers, transports, routes: [], inv_suppliers: [], products: [], inventory_lots: [], stock_movements: [], lot_locations: [], app_settings: [], box_configs: [], box_config_items: [], production_orders: [], orders, purchase_orders, incidents, tasks, dispatch_details: [], transport_rates: [], transport_selections: [], client_notifications: [], logistics_zones: [], integration_sync_logs: [], integration_errors: [] };
}

/**
 * Los ids de arriba ("loc_c1", "ord_3", ...) son legibles para escribir el
 * seed a mano, pero las columnas "id" en Supabase son uuid de verdad.
 * Acá se reemplaza cada id legible por un UUID real y se actualizan todas
 * las referencias cruzadas (locationId, customerId, incidentId, relatedId…)
 * para que sigan apuntando al registro correcto.
 */
function remapSeedIds(seed) {
  const idMap = {};
  COLLECTIONS.forEach((col) => seed[col].forEach((rec) => { idMap[rec.id] = uid("x"); }));
  const remap = (v) => (v && idMap[v]) || v;
  COLLECTIONS.forEach((col) => {
    seed[col].forEach((rec) => {
      rec.id = idMap[rec.id];
      ["locationId", "customerId", "supplierId", "transportId", "incidentId", "relatedId"].forEach((f) => {
        if (f in rec) rec[f] = remap(rec[f]);
      });
      if (Array.isArray(rec.usualTransports)) rec.usualTransports = rec.usualTransports.map(remap);
    });
  });
  return seed;
}

/* ---------------------------------------------------------------------------
   7. BÚSQUEDA GLOBAL
   ------------------------------------------------------------------------- */
function globalSearch(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const res = [];
  state.orders.forEach((o) => {
    if (o.number.includes(q) || o.customerName.toLowerCase().includes(q) || (o.address || "").toLowerCase().includes(q)) {
      res.push({ kind: "Pedido", icon: "📦", title: `Pedido #${o.number}`, sub: o.customerName, href: `#/pedidos/${o.id}` });
    }
  });
  state.purchase_orders.forEach((p) => {
    if (p.number.includes(q) || p.supplierName.toLowerCase().includes(q)) {
      res.push({ kind: "OC", icon: "🛒", title: `OC #${p.number}`, sub: p.supplierName, href: `#/compras/${p.id}` });
    }
  });
  state.customers.forEach((c) => { if (c.name.toLowerCase().includes(q)) res.push({ kind: "Cliente", icon: "📍", title: c.name, sub: c.phone || "", href: `#/ubicaciones` }); });
  state.suppliers.forEach((s) => { if (s.name.toLowerCase().includes(q)) res.push({ kind: "Proveedor", icon: "🏭", title: s.name, sub: s.contact || "", href: `#/proveedores/${s.id}` }); });
  state.transports.forEach((t) => { if (t.name.toLowerCase().includes(q)) res.push({ kind: "Transporte", icon: "🚚", title: t.name, sub: t.contact || "", href: `#/transporte/${t.id}` }); });
  state.products.forEach((p) => { if (p.name.toLowerCase().includes(q)) res.push({ kind: "Producto", icon: "📦", title: p.name, sub: invSupplierName(p.supplierId), href: `#/producto/${p.id}` }); });
  state.inv_suppliers.forEach((s) => { if (s.name.toLowerCase().includes(q)) res.push({ kind: "Proveedor de insumos", icon: "🏷️", title: s.name, sub: s.contact || "", href: `#/inventario` }); });
  state.locations.forEach((l) => { if ((l.address || "").toLowerCase().includes(q) || l.name.toLowerCase().includes(q)) res.push({ kind: "Ubicación", icon: "📌", title: l.name, sub: l.address, href: `#/ubicaciones` }); });
  state.incidents.forEach((i) => { if (i.title.toLowerCase().includes(q)) res.push({ kind: "Incidencia", icon: "⚠️", title: i.title, sub: INCIDENT_META[i.status].label, href: `#/incidencias/${i.id}` }); });
  return res.slice(0, 20);
}

/* ---------------------------------------------------------------------------
   8. SHELL: SIDEBAR / TOPBAR
   ------------------------------------------------------------------------- */
const NAV = [
  { view: "dashboard", label: "Inicio", icon: "home" },
  { view: "gerencia", label: "Gerencia", icon: "gauge" },
  { view: "mapa", label: "Mapa", icon: "map" },
  { view: "pedidos", label: "Pedidos", icon: "box" },
  { view: "compras", label: "Órdenes de compra", icon: "cart" },
  { view: "transporte", label: "Transporte", icon: "truck" },
  { view: "expedicion", label: "Expedición", icon: "dispatch" },
  { view: "ubicaciones", label: "Ubicaciones", icon: "pin" },
  { view: "proveedores", label: "Proveedores", icon: "supplier" },
  { view: "inventario", label: "Inventario", icon: "layers" },
  { view: "produccion", label: "Producción", icon: "factory" },
  { view: "of_produccion", label: "Órdenes de Fabricación", icon: "of" },
  { view: "incidencias", label: "Incidencias", icon: "alert" },
  { view: "tareas", label: "Tareas", icon: "check" },
  { view: "reportes", label: "Reportes", icon: "chart" },
  { view: "config", label: "Configuración", icon: "gear" },
];

/** Íconos minimalistas monolínea (24x24) para la navegación del sidebar. */
const NAV_ICONS = {
  home: '<path d="M4 11.5 12 4l8 7.5" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M6 10v9h12v-9" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  map: '<path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2Z" stroke-width="1.7" stroke-linejoin="round" fill="none"/><path d="M9 4v14M15 6v14" stroke-width="1.7"/>',
  box: '<path d="M4 8 12 4l8 4-8 4-8-4Z" stroke-width="1.7" stroke-linejoin="round" fill="none"/><path d="M4 8v9l8 4 8-4V8M12 12v9" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  cart: '<circle cx="9.5" cy="19.5" r="1.4"/><circle cx="17.5" cy="19.5" r="1.4"/><path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.6h8a2 2 0 0 0 2-1.6L21 8H6" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  truck: '<path d="M3 7h11v9H3z" stroke-width="1.7" stroke-linejoin="round" fill="none"/><path d="M14 10h4l3 3v3h-7z" stroke-width="1.7" stroke-linejoin="round" fill="none"/><circle cx="7" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/>',
  pin: '<path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z" stroke-width="1.7" stroke-linejoin="round" fill="none"/><circle cx="12" cy="9" r="2.3" stroke-width="1.7" fill="none"/>',
  supplier: '<path d="M4 10.5 12 4l8 6.5V20H4V10.5Z" stroke-width="1.7" stroke-linejoin="round" fill="none"/><path d="M9 20v-5.5h6V20" stroke-width="1.7" stroke-linejoin="round" fill="none"/><path d="M9 11h6" stroke-width="1.5" stroke-linecap="round"/>',
  alert: '<path d="M12 4 2 20h20L12 4Z" stroke-width="1.7" stroke-linejoin="round" fill="none"/><path d="M12 10.5v4" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  check: '<circle cx="12" cy="12" r="8.5" stroke-width="1.7" fill="none"/><path d="M8.3 12.3 11 15l5-6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  chart: '<path d="M4 20V10M11 20V4M18 20v-7" stroke-width="1.9" stroke-linecap="round"/>',
  gear: '<circle cx="12" cy="12" r="2.9" stroke-width="1.7" fill="none"/><path d="M12 3.5v2.3M12 18.2v2.3M20.5 12h-2.3M5.8 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" stroke-width="1.7" stroke-linecap="round"/>',
  layers: '<rect x="4.5" y="4" width="15" height="6.2" rx="1.2" stroke-width="1.7" fill="none"/><path d="M4.5 14.2h15M4.5 18.2h15" stroke-width="1.7" stroke-linecap="round"/>',
  factory: '<path d="M4 20V11l4.5 3V11l4.5 3V11l4.5 3V6h3v14H4Z" stroke-width="1.7" stroke-linejoin="round" fill="none"/><path d="M8 20v-4h3v4" stroke-width="1.7" stroke-linejoin="round" fill="none"/>',
  of: '<rect x="6" y="3.5" width="12" height="17" rx="2" stroke-width="1.7" fill="none"/><path d="M9 3.5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v.5" stroke-width="1.6" fill="none"/><path d="M8.5 12.5l2 2 4-4.2" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  gauge: '<path d="M4 15a8 8 0 1 1 16 0" stroke-width="1.7" stroke-linecap="round" fill="none"/><path d="M12 15 16.2 9.8" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="15" r="1.3" fill="currentColor" stroke="none"/>',
  dispatch: '<circle cx="12" cy="12" r="8.5" stroke-width="1.7" fill="none"/><path d="M12 7.2v4.8l3.4 2" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
};
function navIconSvg(key) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${NAV_ICONS[key] || NAV_ICONS.pin}</svg>`;
}

function navBadgeCount(view) {
  const k = kpis();
  if (view === "pedidos") return k.activeOrders.length;
  if (view === "compras") return state.purchase_orders.filter((p) => !["cerrada"].includes(p.status)).length;
  if (view === "incidencias") return k.openIncidents.length;
  if (view === "tareas") return k.pendingTasks.length;
  if (view === "inventario") return state.products.filter((p) => ["vencido", "critico"].includes(productWorstStatus(p.id).key)).length;
  if (view === "produccion") return state.production_orders.filter((o) => ["planificada", "pendiente", "en_produccion"].includes(o.status)).length;
  if (view === "of_produccion") return state.manufacturing_orders.filter((o) => ["PLANIFICADA", "RESERVADA", "EN_PRODUCCION", "BLOQUEADA"].includes(o.estado)).length;
  if (view === "gerencia") return gerenciaAlertas().filter((a) => a.level === "red").length;
  if (view === "expedicion") return expedicionRequierenAtencion().length;
  return 0;
}

function renderSidebar() {
  return `
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-mark">LP</div>
      <div class="brand-text"><div class="brand-name">LOGÍSTICA</div><div class="brand-name2">PERONA</div></div>
    </div>
    <div class="brand-tag">LP / OPERACIONES</div>
    <nav class="nav">
      ${NAV.map((n) => {
        const count = navBadgeCount(n.view);
        const active = state.route.view === n.view;
        return `<a href="#/${n.view}" class="nav-item ${active ? "active" : ""}" data-nav="${n.view}">
          <span class="nav-icon">${navIconSvg(n.icon)}</span><span class="nav-label">${n.label}</span>
          ${count ? `<span class="nav-count">${count}</span>` : ""}
        </a>`;
      }).join("")}
    </nav>
    <div class="sidebar-foot">
      <div class="mode-pill" title="Guardado en Supabase">
        <span class="dot dot-green dot-pulse"></span>Sincronizado<span class="live-tag">● LIVE</span>
      </div>
    </div>
  </aside>`;
}

function renderTopbar() {
  const title = NAV.find((n) => n.view === state.route.view)?.label || "";
  const email = state.session?.user?.email || "";
  const k = kpis();
  const notifCount = k.late.length + k.openIncidents.length;
  const quickAction = { pedidos: { href: "#/pedidos/nuevo", label: "+ Nuevo pedido" }, compras: { href: "#/compras/nueva", label: "+ Nueva OC" }, incidencias: { href: "#/incidencias/nueva", label: "+ Nueva incidencia" } }[state.route.view];
  return `
  <header class="topbar">
    <button class="icon-btn only-mobile" data-action="toggle-menu" aria-label="Menú">☰</button>
    <div class="topbar-title">${esc(title)}</div>
    <span class="topbar-code only-desktop">LP / ${esc(title).toUpperCase()}</span>
    <div class="topbar-search">
      <input id="global-search" type="text" placeholder="Buscar pedido, cliente, OC, dirección…" autocomplete="off" />
      <div id="search-results" class="search-results hidden"></div>
    </div>
    <div class="topbar-right">
      ${quickAction ? `<a href="${quickAction.href}" class="btn btn-primary btn-sm only-desktop">${quickAction.label}</a>` : ""}
      <button class="icon-btn" title="Notificaciones">🔔${notifCount ? `<span class="notif-badge">${notifCount}</span>` : ""}</button>
      <div class="user-chip" title="${esc(email)}"><span class="avatar">${avatarInitials(email || "?")}</span><span class="only-desktop">${esc(email.split("@")[0] || "")}</span></div>
      <button class="icon-btn" data-action="logout" title="Cerrar sesión">⏻</button>
    </div>
  </header>`;
}

/* ---------------------------------------------------------------------------
   9. VISTA: DASHBOARD
   ------------------------------------------------------------------------- */
function viewDashboard() {
  const k = kpis();
  const priorities = [];
  k.late.slice(0, 4).forEach((o) => priorities.push({ cls: "st-red", dot: "🔴", text: `Pedido #${o.number} — entrega atrasada`, href: `#/pedidos/${o.id}` }));
  k.poArrivingToday.slice(0, 3).forEach((p) => priorities.push({ cls: "st-orange", dot: "🟠", text: `OC #${p.number} — llega hoy`, href: `#/compras/${p.id}` }));
  k.openIncidents.filter((i) => i.priority === "alta").slice(0, 3).forEach((i) => priorities.push({ cls: "st-red", dot: "🔴", text: i.title, href: `#/incidencias/${i.id}` }));
  state.orders.filter((o) => o.status === "pendiente").slice(0, 2).forEach((o) => priorities.push({ cls: "st-yellow", dot: "🟡", text: `Pedido #${o.number} — pendiente de preparación`, href: `#/pedidos/${o.id}` }));

  const todayTasks = state.tasks.filter((t) => t.date === todayISO()).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const recent = [...state.orders.flatMap((o) => o.history.map((h) => ({ ...h, kind: "Pedido", num: o.number, id: o.id, href: `#/pedidos/${o.id}` }))),
                  ...state.purchase_orders.flatMap((p) => p.history.map((h) => ({ ...h, kind: "OC", num: p.number, id: p.id, href: `#/compras/${p.id}` })))]
    .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6);

  const hour = new Date().getHours();
  const greet = hour < 12 ? "Buen día" : hour < 20 ? "Buenas tardes" : "Buenas noches";

  return `
  <div class="view-dashboard watermark-host">
    <div class="brand-watermark">LOGÍSTICA<br>PERONA</div>
    <div class="dash-hero">
      <div>
        <div class="dash-greet">${greet}, <span class="accent-text">Perona</span></div>
        <div class="dash-sub">Tu operación de hoy · ${new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" })}</div>
        ${routeLine(k.dueToday.length ? 1 : 0)}
      </div>
      <a href="#/pedidos/nuevo" class="btn btn-primary">+ Nuevo pedido</a>
    </div>

    <div class="kpi-hero-row">
      ${heroKpiCard("Entregas previstas hoy", k.dueToday.length, [
        { label: "Entregadas", value: k.deliveredToday.length },
        { label: "Atrasadas", value: k.late.length },
      ])}
      <div class="kpi-grid kpi-grid-compact">
        ${kpiCard(k.activeOrders.length, "Pedidos activos", "📦", "kpi-violet", 0)}
        ${kpiCard(k.poInTransit.length, "OC en tránsito", "🛒", "kpi-blue", 60)}
        ${kpiCard(k.poArrivingToday.length, "Recepciones previstas", "🏢", "kpi-blue", 120)}
        ${kpiCard(k.openIncidents.length, "Incidencias abiertas", "⚠️", "kpi-red", 180)}
        ${kpiCard(k.pendingTasks.length, "Tareas pendientes", "✅", "kpi-violet", 240)}
      </div>
    </div>

    <div class="dash-grid">
      <div class="panel map-panel">
        <div class="panel-head"><h3>Mapa logístico</h3><a href="#/mapa" class="link-more">Ver completo →</a></div>
        ${renderMiniMap()}
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Prioridades de hoy</h3></div>
        ${priorities.length ? `<div class="priority-list">${priorities.slice(0, 6).map((p) => `
          <a href="${p.href}" class="priority-item">
            <i class="dot-ind ${p.cls}"></i><span class="priority-text">${esc(p.text)}</span>
          </a>`).join("")}</div>` : emptyState("✨", "Sin prioridades urgentes", "No hay atrasos ni incidencias críticas por ahora.")}
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Agenda de hoy</h3><a href="#/tareas" class="link-more">Ver todas →</a></div>
        ${todayTasks.length ? `<div class="agenda-list">${todayTasks.map((t) => `
          <div class="agenda-item" data-agenda-toggle="${t.id}">
            <span class="agenda-check ${t.status === "completada" ? "done" : t.status === "en_curso" ? "mid" : ""}">${t.status === "completada" ? "✓" : t.status === "en_curso" ? "●" : "○"}</span>
            <span class="agenda-time">${t.time || "--:--"}</span>
            <span class="agenda-title ${t.status === "completada" ? "strike" : ""}">${esc(t.title)}</span>
          </div>`).join("")}</div>` : emptyState("🗓️", "Sin tareas para hoy", "Cargá una tarea nueva para organizar tu jornada.")}
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Actividad reciente</h3></div>
        ${recent.length ? `<div class="timeline">${recent.map((h) => `
          <a href="${h.href}" class="timeline-item">
            <div class="timeline-dot"></div>
            <div>
              <div class="timeline-text"><b>${h.kind} #${h.num}</b> → ${esc((h.kind === "Pedido" ? ORDER_META[h.to] : PO_META[h.to])?.label || h.to)}</div>
              <div class="timeline-time">${fmtDateTime(h.date)}</div>
            </div>
          </a>`).join("")}</div>` : emptyState("🕒", "Sin actividad", "Los cambios de estado aparecerán acá.")}
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Top clientes</h3><a href="#/reportes" class="link-more">Ver ranking completo →</a></div>
        ${clientRankingHTML(clientRankingData(state.orders, 5))}
      </div>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------------------
   10. MAPA LOGÍSTICO (Leaflet + OpenStreetMap, calles reales)
   ------------------------------------------------------------------------- */
function mapMarkers(filterKey) {
  const markers = [];
  state.locations.forEach((l) => {
    if (l.type === "deposito") markers.push({ kind: "deposito", loc: l, label: l.name });
  });
  state.orders.forEach((o) => {
    const loc = getById("locations", o.locationId);
    if (!loc) return;
    const show = filterKey === "todos" || filterKey === "pedidos" ||
      (filterKey === "hoy" && o.expectedDate === todayISO()) ||
      (filterKey === "atrasadas" && daysBetween(todayISO(), o.expectedDate) < 0 && !["entregado","cancelado"].includes(o.status)) ||
      (filterKey === o.status);
    if (show && !["cancelado"].includes(o.status)) markers.push({ kind: o.status === "incidencia" ? "incidencia" : "pedido", loc, order: o, label: `Pedido #${o.number}` });
  });
  if (filterKey === "todos" || filterKey === "proveedores" || filterKey === "compras") {
    state.suppliers.forEach((s) => {
      const loc = getById("locations", s.locationId);
      if (loc) markers.push({ kind: "proveedor", loc, label: s.name });
    });
  }
  return markers;
}

function markerPopupHTML(m) {
  if (m.kind === "pedido" || m.kind === "incidencia") {
    const o = m.order, u = orderUrgency(o);
    return `<div class="map-popup">
      <div class="map-popup-title">PEDIDO #${esc(o.number)}</div>
      <div class="map-popup-row"><span>Cliente</span><b>${esc(o.customerName)}</b></div>
      <div class="map-popup-row"><span>Estado</span>${statusBadge(ORDER_META[o.status])}</div>
      <div class="map-popup-row"><span>Entrega prevista</span><b>${fmtDate(o.expectedDate)}</b></div>
      <div class="map-popup-row"><span>Dirección</span><b>${esc(o.address)}</b></div>
      <div class="map-popup-row"><span>Prioridad</span>${priorityBadge(o.priority)}</div>
      <a href="#/pedidos/${o.id}" class="btn btn-sm btn-primary" style="margin-top:8px;width:100%;text-align:center;">Ver pedido</a>
    </div>`;
  }
  if (m.kind === "proveedor") {
    return `<div class="map-popup"><div class="map-popup-title">${esc(m.label)}</div><div class="map-popup-row"><span>Dirección</span><b>${esc(m.loc.address || "—")}</b></div><div class="map-popup-row"><span>Ciudad</span><b>${esc(m.loc.city || "—")}</b></div></div>`;
  }
  return `<div class="map-popup"><div class="map-popup-title">${esc(m.label)}</div><div class="map-popup-row"><span>Dirección</span><b>${esc(m.loc.address || "—")}</b></div></div>`;
}

/** Convierte nuestros marcadores de dominio al formato que espera map.js */
function toLeafletMarkers(markers) {
  return markers
    .filter((m) => typeof m.loc.lat === "number" && typeof m.loc.lng === "number")
    .map((m) => ({ id: m.loc.id, kind: m.kind, lat: m.loc.lat, lng: m.loc.lng, label: m.label, popupHtml: markerPopupHTML(m) }));
}

/** Rutas (recorridos) que recorre cada transporte, filtradas para el mapa general. */
function mapRoutes(filterKey, transportId) {
  if (transportId) return state.routes.filter((r) => r.transportId === transportId);
  if (filterKey === "todos" || filterKey === "transportes") return state.routes;
  return [];
}

function routePopupHTML(r) {
  const t = getById("transports", r.transportId);
  return `<div class="map-popup">
    <div class="map-popup-title">${esc(t ? t.name : "Ruta")}</div>
    <div class="map-popup-row"><span>Recorrido</span><b>${esc(r.label || `${r.originCity || "—"} → ${r.destinationCity || "—"}`)}</b></div>
    ${t ? `<a href="#/transporte/${t.id}" class="btn btn-sm btn-primary" style="margin-top:8px;width:100%;text-align:center;">Ver transporte</a>` : ""}
  </div>`;
}

/** Convierte rutas de dominio al formato de polylines que espera map.js */
function toLeafletRoutes(routes) {
  return routes
    .filter((r) => typeof r.originLat === "number" && typeof r.originLng === "number" && typeof r.destinationLat === "number" && typeof r.destinationLng === "number")
    .map((r) => ({ id: r.id, points: [[r.originLat, r.originLng], [r.destinationLat, r.destinationLng]], popupHtml: routePopupHTML(r) }));
}

/** Rutas regionales/internacionales sin un destino puntual (ej: "Internacional —
 * Brasil, Bolivia, Chile…") no se pueden dibujar como línea. En vez de dejar el
 * mapa vacío, mostramos al menos el origen como marcador. */
function routeOriginMarkers(routes) {
  return routes
    .filter((r) => typeof r.originLat === "number" && typeof r.originLng === "number" &&
      !(typeof r.destinationLat === "number" && typeof r.destinationLng === "number"))
    .map((r) => {
      const t = getById("transports", r.transportId);
      return {
        id: `ruta-origen-${r.id}`, kind: "ruta", lat: r.originLat, lng: r.originLng,
        label: r.label || (t ? t.name : "Ruta"),
        popupHtml: `<div class="map-popup">
          <div class="map-popup-title">${esc(t ? t.name : "Ruta")}</div>
          <div class="map-popup-row"><span>Recorrido</span><b>${esc(r.label || `${r.originCity || "—"} → ${r.destinationCity || "—"}`)}</b></div>
          <div class="hint" style="margin-top:6px">Destino sin coordenadas exactas (ruta regional o con varios destinos) — se muestra solo el origen.</div>
          ${t ? `<a href="#/transporte/${t.id}" class="btn btn-sm btn-primary" style="margin-top:8px;width:100%;text-align:center;">Ver transporte</a>` : ""}
        </div>`,
      };
    });
}

let miniMapMarkers = [];
let ubicacionesMapMarkers = [];
let transporteMapRoutes = [];

function renderMiniMap() {
  const markers = mapMarkers("todos");
  miniMapMarkers = markers;
  const withCoords = markers.filter((m) => typeof m.loc.lat === "number");
  return `<div id="mapa-mini" class="leaflet-box" style="height:220px"></div>
    <div class="map-legend-mini"><span>📍 ${state.orders.filter(o=>!["cancelado"].includes(o.status)).length} pedidos</span><span>🏭 ${state.suppliers.length} proveedores</span></div>
    ${!withCoords.length ? `<div class="map-empty-hint">Cargá direcciones en Ubicaciones para verlas acá.</div>` : ""}`;
}

/* =============================================================================
   CENTRO GEOESPACIAL DE LOGÍSTICA PERONA
   =============================================================================
   Reemplaza el mapa básico anterior (arriba quedaron intactos mapMarkers/
   toLeafletMarkers/toLeafletRoutes/routeOriginMarkers/mapRoutes — los sigue
   usando el mini-mapa del Dashboard, Ubicaciones y el mapa del detalle de un
   Transporte, que no se tocaron).

   Tres niveles (Operativo / Estratégico / Táctico) dentro de la misma vista,
   sin abandonar el módulo. Esta primera entrega construye el nivel
   OPERATIVO completo con datos 100% reales; Estratégico y Táctico quedan
   con un panel honesto de "próxima fase" (nunca datos de ejemplo) hasta que
   existan las tablas de corredores/zonas tarifarias (ver diagnóstico).

   Decisiones de honestidad de datos (no inventar nada):
   - La app no modela vehículos individuales (flota), sólo tipos de vehículo
     por transportista. La capa "Vehículos" y el KPI correspondiente lo dicen
     explícitamente en vez de simular una posición o un conteo de flota.
   - GPS: no existe ninguna conexión real. Se deja el punto de entrega del
     pedido como referencia visual, marcando siempre "Ubicación GPS no
     disponible" — nunca una posición inventada.
   - Un pedido sin ubicación geocodificada (locationId con lat/lng) no se
     dibuja en el mapa: se cuenta aparte como "sin geolocalización".
   ========================================================================= */
let mapLevel = "operativo";
let mapFiltersOpen = false;
let mapGeoFilters = { provincia: "", ciudad: "", estadoPedido: "", transportistaId: "", vehiculo: "", carga: "", tiempo: "todos", tiempoDesde: "", tiempoHasta: "", costoMin: "", costoMax: "" };
let mapLayerToggles = { pedidos: true, transportistas: true, rutas: true, nodos: true, vehiculos: false, heat: false, clientes: false, proveedores: false, incidencias: true };
let mapHeatVariable = "pedidos"; // pedidos | costo | bultos | incidencias
let mapSelection = null; // { type: "order"|"location"|"transport"|"route", id }
let mapSearchQuery = "";
// Resultados de Google Places (New) para el buscador general — se cargan de
// forma asíncrona (no bloquean el resultado interno, que sigue siendo
// síncrono) y se muestran en un grupo aparte, nunca reemplazando la búsqueda
// interna de pedidos/clientes/proveedores/transportistas.
let mapPlacesSuggestions = [];
let mapPlacesSessionToken = null;
let mapPlacesSearchSeq = 0; // evita que una respuesta vieja pise a una más nueva
let mapPlanSearchSeq = { origen: 0, destino: 0 };

/** Busca sugerencias de Google Places (New) para el buscador general del
 * mapa. Nunca reemplaza la búsqueda interna (mapSearchResults sigue siendo
 * síncrona y aparece siempre); esto sólo agrega un segundo grupo. Se descarta
 * en silencio si Google no responde — no es un dato crítico. */
async function fetchGlobalMapPlaces(query) {
  const seq = ++mapPlacesSearchSeq;
  if (!mapPlacesSessionToken) mapPlacesSessionToken = await createPlacesSessionToken();
  const results = await searchPlacesAutocomplete(query, mapPlacesSessionToken);
  if (seq !== mapPlacesSearchSeq) return; // llegó una búsqueda más nueva mientras tanto
  mapPlacesSuggestions = results;
  renderMainOnly();
}
/** Igual que la anterior, pero para los campos de "Planificar recorrido"
 * (origen/destino son independientes entre sí). */
async function fetchPlanPlaces(which, query) {
  const seq = ++mapPlanSearchSeq[which];
  const token = await createPlacesSessionToken();
  const results = await searchPlacesAutocomplete(query, token);
  if (seq !== mapPlanSearchSeq[which]) return;
  mapPlanSuggestions[which] = results;
  renderMainOnly();
}
let mapCoverageRadiusKm = null; // radio activo dibujado sobre el nodo seleccionado
let mapGeoCtx = null; // capas ya calculadas por viewMapaLogistico(), reusadas al montar el mapa real
let mapLevelForFit = null; // último nivel montado en el mapa real — al cambiar, se fuerza un solo re-encuadre
let mapZoneEditing = null; // null | "new" | id de una zona tarifaria en edición (nivel Táctico)
// Paleta puramente decorativa para diferenciar zonas tarifarias entre sí en el mapa.
// A diferencia de --ok/--warn/--danger/--info (reservados para estado de pedido/
// tránsito), esto no tiene ningún significado semántico — sólo ayuda a distinguir
// "Zona A" de "Zona B" a simple vista, así que no usa rojo/verde/amarillo/el gris-info.
const ZONE_PALETTE = ["#4B5A6B", "#7C5C46", "#3E6B5E", "#6B4C7C", "#8A6D1F", "#4C6B8A", "#7C4C4C", "#4C7C6B"];

const MAP_TIEMPO_OPTS = [
  { key: "todos", label: "Todos" }, { key: "hoy", label: "Hoy" }, { key: "manana", label: "Mañana" },
  { key: "7d", label: "Próximos 7 días" }, { key: "30d", label: "Próximos 30 días" }, { key: "personalizado", label: "Personalizado" },
];
const MAP_CARGA_OPTS = ["Paquetería", "Bultos", "Pallets"];

function matchesMapTiempo(dateStr, f) {
  if (f.tiempo === "todos") return true;
  if (!dateStr) return false;
  if (f.tiempo === "personalizado") return (!f.tiempoDesde || dateStr >= f.tiempoDesde) && (!f.tiempoHasta || dateStr <= f.tiempoHasta);
  const d = daysBetween(todayISO(), dateStr);
  if (d === null) return false;
  if (f.tiempo === "hoy") return d === 0;
  if (f.tiempo === "manana") return d === 1;
  if (f.tiempo === "7d") return d >= 0 && d <= 7;
  if (f.tiempo === "30d") return d >= 0 && d <= 30;
  return true;
}

/** Pedidos activos (no cancelados) que pasan los filtros geo/operativos/de
 * transporte/carga/tiempo/costo vigentes. Todo sobre datos reales de `state`. */
function mapFilteredOrders() {
  const f = mapGeoFilters;
  const locsById = new Map(state.locations.map((l) => [l.id, l]));
  return state.orders.filter((o) => {
    if (o.status === "cancelado") return false;
    const loc = o.locationId ? locsById.get(o.locationId) : null;
    if (f.provincia && (!loc || loc.province !== f.provincia)) return false;
    if (f.ciudad && (!loc || loc.city !== f.ciudad)) return false;
    if (f.estadoPedido && o.status !== f.estadoPedido) return false;
    if (f.transportistaId && o.transportId !== f.transportistaId) return false;
    if (f.vehiculo) { const sel = latestSelection(o.id); if (!sel || sel.vehicleType !== f.vehiculo) return false; }
    if (f.carga) { const t = getById("transports", o.transportId); if (!t || !(t.type || "").toLowerCase().includes(f.carga.toLowerCase())) return false; }
    if (!matchesMapTiempo(o.expectedDate, f)) return false;
    const cost = latestSelection(o.id)?.estimatedCost;
    if (f.costoMin && (cost == null || cost < parseFloat(f.costoMin))) return false;
    if (f.costoMax && (cost == null || cost > parseFloat(f.costoMax))) return false;
    return true;
  });
}

const MAP_ORDER_KIND = { pendiente: "pedido_pendiente", preparacion: "pedido_pendiente", preparado: "pedido_pendiente", controlado: "pedido_pendiente", despachado: "pedido_transito", en_camino: "pedido_transito", entregado: "pedido_entregado", incidencia: "pedido_incidencia" };

/** Botones "Ver 360°" / "Cómo llegar" reutilizados en todos los popups y
 * paneles del mapa. "Ver 360°" sólo aparece si hay una coordenada real
 * (nunca se ofrece Street View sobre una posición inventada); "Cómo llegar"
 * sólo si el punto corresponde a una ubicación guardada (locationId real, no
 * una coordenada suelta) porque "Planificar recorrido" trabaja con
 * ubicaciones geocodificadas. */
function mapActionButtonsHTML({ lat, lng, label, locationId }) {
  if (typeof lat !== "number" || typeof lng !== "number") return "";
  return `<div class="form-actions map-popup-actions" style="margin-top:8px;">
    <button type="button" class="btn btn-ghost btn-sm" data-action="map-street-view" data-lat="${lat}" data-lng="${lng}" data-label="${esc(label || "")}">🌐 Ver 360°</button>
    ${locationId ? `<button type="button" class="btn btn-ghost btn-sm" data-action="map-como-llegar" data-location-id="${locationId}">🧭 Cómo llegar</button>` : ""}
  </div>`;
}

function mapOrderPopupHTML(o) {
  const sel = latestSelection(o.id);
  const loc = getById("locations", o.locationId);
  return `<div class="map-popup">
    <div class="map-popup-title">PEDIDO #${esc(o.number)}</div>
    <div class="map-popup-row"><span>Cliente</span><b>${esc(o.customerName)}</b></div>
    <div class="map-popup-row"><span>Dirección</span><b>${esc(loc?.address || o.address || "—")}</b></div>
    <div class="map-popup-row"><span>Estado</span>${statusBadge(ORDER_META[o.status])}</div>
    <div class="map-popup-row"><span>Entrega prevista</span><b>${fmtDate(o.expectedDate)}</b></div>
    ${sel ? `<div class="map-popup-row"><span>Transporte</span><b>${esc(getById("transports", sel.transportId)?.name || "—")}</b></div>` : ""}
    <a href="#/pedidos/${o.id}" class="btn btn-sm btn-primary" style="margin-top:8px;width:100%;text-align:center;">Ver pedido</a>
    <a href="#/expedicion/${o.id}" data-action="map-comparar-transporte" data-id="${o.id}" class="btn btn-sm btn-ghost" style="margin-top:6px;width:100%;text-align:center;">Comparar transporte</a>
    ${mapActionButtonsHTML({ lat: loc?.lat, lng: loc?.lng, label: `Pedido #${o.number}`, locationId: loc?.id })}
  </div>`;
}

function mapVehiclePopupHTML(o, sel) {
  const loc = getById("locations", o.locationId);
  return `<div class="map-popup">
    <div class="map-popup-title">VEHÍCULO — PEDIDO #${esc(o.number)}</div>
    <div class="map-popup-row"><span>Tipo</span><b>${esc(VEHICLE_TYPES[sel.vehicleType]?.label || sel.vehicleType || "—")}</b></div>
    <div class="map-popup-row"><span>Transportista</span><b>${esc(getById("transports", sel.transportId)?.name || "—")}</b></div>
    <div class="map-popup-row"><span>Estado del envío</span>${statusBadge(ORDER_META[o.status])}</div>
    <div class="hint" style="margin-top:6px">Ubicación GPS no disponible — se muestra el punto de entrega del pedido, no la posición real del vehículo.</div>
    <a href="#/pedidos/${o.id}" class="btn btn-sm btn-primary" style="margin-top:8px;width:100%;text-align:center;">Ver pedido</a>
    ${mapActionButtonsHTML({ lat: loc?.lat, lng: loc?.lng, label: `Pedido #${o.number}` })}
  </div>`;
}

function mapTransportPopupHTML(t) {
  const enRuta = state.orders.filter((o) => o.transportId === t.id && ["despachado", "en_camino"].includes(o.status)).length;
  const base = transportBasePoint(t.id, state.routes);
  return `<div class="map-popup">
    <div class="map-popup-title">${esc(t.name)}</div>
    <div class="map-popup-row"><span>Tipo de carga</span><b>${esc(t.type || "—")}</b></div>
    <div class="map-popup-row"><span>Envíos en ruta</span><b>${enRuta}</b></div>
    <a href="#/transporte/${t.id}" class="btn btn-sm btn-primary" style="margin-top:8px;width:100%;text-align:center;">Ver transportista</a>
    ${mapActionButtonsHTML({ lat: base?.lat, lng: base?.lng, label: t.name })}
  </div>`;
}

function mapNodePopupHTML(l) {
  const s = nodeSummary(l.id, { orders: state.orders, transportSelections: state.transport_selections });
  return `<div class="map-popup">
    <div class="map-popup-title">${esc(l.name)}</div>
    <div class="map-popup-row"><span>Dirección</span><b>${esc(l.address || "—")}</b></div>
    <div class="map-popup-row"><span>Pedidos pendientes</span><b>${s.pendientes}</b></div>
    <div class="map-popup-row"><span>Pedidos en tránsito</span><b>${s.enTransito}</b></div>
    <div class="map-popup-row"><span>Pedidos entregados</span><b>${s.entregados}</b></div>
    <div class="map-popup-row"><span>Costo logístico acumulado</span><b>${fmtMoney(s.costoAcumulado)}</b></div>
    <div class="map-popup-row"><span>Vehículos disponibles</span><b>Sin datos</b></div>
    <div class="hint" style="margin-top:6px">La app todavía no modela una flota de vehículos individual — por eso ese dato no se muestra como número.</div>
    <button type="button" data-action="map-select-node" data-id="${l.id}" class="btn btn-sm btn-primary" style="margin-top:8px;width:100%;text-align:center;">Ver detalle en el panel</button>
    ${mapActionButtonsHTML({ lat: l.lat, lng: l.lng, label: l.name, locationId: l.id })}
  </div>`;
}

function mapClientePopupHTML(c, loc) {
  const pedidos = state.orders.filter((o) => o.customerId === c.id && !["cancelado"].includes(o.status));
  return `<div class="map-popup">
    <div class="map-popup-title">${esc(c.name)}</div>
    <div class="map-popup-row"><span>Dirección</span><b>${esc(loc?.address || "—")}</b></div>
    <div class="map-popup-row"><span>Teléfono</span><b>${esc(c.phone || "—")}</b></div>
    <div class="map-popup-row"><span>Pedidos activos</span><b>${pedidos.length}</b></div>
    <button type="button" data-action="map-select-cliente" data-id="${c.id}" class="btn btn-sm btn-primary" style="margin-top:8px;width:100%;text-align:center;">Ver sus pedidos</button>
    ${mapActionButtonsHTML({ lat: loc?.lat, lng: loc?.lng, label: c.name, locationId: loc?.id })}
  </div>`;
}

function mapProveedorPopupHTML(s, loc) {
  const ocs = state.purchase_orders.filter((p) => p.supplierId === s.id && p.status !== "cerrada");
  return `<div class="map-popup">
    <div class="map-popup-title">${esc(s.name)}</div>
    <div class="map-popup-row"><span>Dirección</span><b>${esc(loc?.address || "—")}</b></div>
    <div class="map-popup-row"><span>Contacto</span><b>${esc(s.contact || "—")}</b></div>
    <div class="map-popup-row"><span>OC activas</span><b>${ocs.length}</b></div>
    <a href="#/proveedores/${s.id}" class="btn btn-sm btn-primary" style="margin-top:8px;width:100%;text-align:center;">Ver proveedor</a>
    ${mapActionButtonsHTML({ lat: loc?.lat, lng: loc?.lng, label: s.name, locationId: loc?.id })}
  </div>`;
}

function mapIncidenciaPopupHTML(i) {
  return `<div class="map-popup">
    <div class="map-popup-title">⚠️ ${esc(i.title)}</div>
    <div class="map-popup-row"><span>Estado</span>${statusBadge(INCIDENT_META[i.status])}</div>
    <div class="map-popup-row"><span>Relacionada con</span><b>${esc(relatedLabel(i) || "—")}</b></div>
    <div class="map-popup-row"><span>Fecha</span><b>${fmtDate(i.date)}</b></div>
    <a href="#/incidencias/${i.id}" class="btn btn-sm btn-primary" style="margin-top:8px;width:100%;text-align:center;">Ver incidencia</a>
  </div>`;
}

/** Construye las capas del nivel Operativo a partir de los pedidos ya
 * filtrados. Devuelve también contadores de lo que no se pudo geolocalizar
 * (nunca se inventa una coordenada para esos casos). */
function buildOperativeLayers(orders) {
  const locsById = new Map(state.locations.map((l) => [l.id, l]));
  const pedidosMarkers = [], vehiculosMarkers = [];
  let sinGeo = 0;
  orders.forEach((o) => {
    const p = orderGeoPoint(o, locsById);
    if (!p) { sinGeo++; return; }
    pedidosMarkers.push({ id: o.id, lat: p.lat, lng: p.lng, kind: MAP_ORDER_KIND[o.status] || "pedido_sin_estado", popupHtml: mapOrderPopupHTML(o), onClick: () => { mapSelection = { type: "order", id: o.id }; renderMainOnly(); } });
    if (["despachado", "en_camino"].includes(o.status)) {
      const sel = latestSelection(o.id);
      if (sel && sel.vehicleType) vehiculosMarkers.push({ id: o.id, lat: p.lat, lng: p.lng, kind: `veh_${sel.vehicleType}`, popupHtml: mapVehiclePopupHTML(o, sel), onClick: () => { mapSelection = { type: "order", id: o.id }; renderMainOnly(); } });
    }
  });

  // Por defecto se muestran TODOS los transportistas cargados (es un directorio de
  // referencia, no sólo los que tienen un pedido activo hoy); el filtro de
  // transportista, si está puesto, acota a ese uno solo.
  const transportesToShow = mapGeoFilters.transportistaId ? state.transports.filter((t) => t.id === mapGeoFilters.transportistaId) : state.transports;
  const transportistasMarkers = [];
  let transportesSinBase = 0;
  transportesToShow.forEach((t) => {
    const p = transportBasePoint(t.id, state.routes);
    if (!p) { transportesSinBase++; return; }
    transportistasMarkers.push({ id: t.id, lat: p.lat, lng: p.lng, kind: "transportista", popupHtml: mapTransportPopupHTML(t), onClick: () => { mapSelection = { type: "transport", id: t.id }; renderMainOnly(); } });
  });

  const nodosMarkers = state.locations.filter((l) => l.type === "deposito").map((l) => ({
    id: l.id, lat: l.lat, lng: l.lng, kind: "deposito", popupHtml: mapNodePopupHTML(l),
    onClick: () => { mapSelection = { type: "location", id: l.id }; renderMainOnly(); },
  })).filter((m) => typeof m.lat === "number" && typeof m.lng === "number");

  // Clientes y proveedores: se ubican en su propia dirección guardada
  // (locationId) — el mismo dato que ya usan sus pedidos/OC, no algo nuevo.
  const clientesMarkers = state.customers.map((c) => {
    const loc = c.locationId ? locsById.get(c.locationId) : null;
    if (!loc || typeof loc.lat !== "number") return null;
    return { id: c.id, lat: loc.lat, lng: loc.lng, kind: "cliente", popupHtml: mapClientePopupHTML(c, loc), onClick: () => { mapSelection = { type: "cliente", id: c.id }; renderMainOnly(); } };
  }).filter(Boolean);
  const proveedoresMarkers = state.suppliers.map((s) => {
    const loc = s.locationId ? locsById.get(s.locationId) : null;
    if (!loc || typeof loc.lat !== "number") return null;
    return { id: s.id, lat: loc.lat, lng: loc.lng, kind: "proveedor", popupHtml: mapProveedorPopupHTML(s, loc), onClick: () => { mapSelection = { type: "proveedor", id: s.id }; renderMainOnly(); } };
  }).filter(Boolean);

  // Incidencias: resueltas de forma honesta a través de la entidad relacionada
  // (ver incidentGeoPoint en domain/geo.js) — nunca se inventa un punto para
  // las que no tienen una relación con coordenada real.
  const incidentesAbiertos = state.incidents.filter((i) => !["resuelta", "cerrada"].includes(i.status));
  let incidenciasSinGeo = 0;
  const incidenciasMarkers = incidentesAbiertos.map((i) => {
    const p = incidentGeoPoint(i, { orders: state.orders, purchaseOrders: state.purchase_orders, suppliers: state.suppliers, routes: state.routes, locationsById: locsById });
    if (!p) { incidenciasSinGeo++; return null; }
    return { id: i.id, lat: p.lat, lng: p.lng, kind: "incidencia", popupHtml: mapIncidenciaPopupHTML(i), onClick: () => { mapSelection = { type: "incidencia", id: i.id }; renderMainOnly(); } };
  }).filter(Boolean);

  const routesToShow = mapGeoFilters.transportistaId ? state.routes.filter((r) => r.transportId === mapGeoFilters.transportistaId) : state.routes;
  const rutaCoberturaMarkers = routeOriginMarkers(routesToShow);

  return { pedidosMarkers, vehiculosMarkers, transportistasMarkers, nodosMarkers, clientesMarkers, proveedoresMarkers, incidenciasMarkers, rutaCoberturaMarkers, routesToShow, sinGeo, transportesSinBase, incidenciasSinGeo };
}

/** Puntos para el mapa de calor, según la variable elegida. Nunca promedia
 * ni estima: cada punto es un pedido real con su peso real. */
function buildHeatPoints(orders, variable) {
  const locsById = new Map(state.locations.map((l) => [l.id, l]));
  const pts = [];
  orders.forEach((o) => {
    const p = orderGeoPoint(o, locsById);
    if (!p) return;
    let weight = 1;
    if (variable === "costo") weight = latestSelection(o.id)?.estimatedCost || 0;
    else if (variable === "bultos") weight = dispatchDetail(o.id)?.boxesCount || 0;
    else if (variable === "incidencias") { if (o.status !== "incidencia") return; weight = 1; }
    if (weight > 0 || variable === "pedidos") pts.push({ lat: p.lat, lng: p.lng, weight: weight || 1 });
  });
  return pts;
}

function mapKpiRow() {
  const k = computeOperationalKpis({ orders: state.orders, dispatchDetails: state.dispatch_details, transportSelections: state.transport_selections, incidents: state.incidents }, todayISO());
  const pesoTransito = state.orders.filter((o) => ["despachado", "en_camino"].includes(o.status)).reduce((s, o) => s + (dispatchDetail(o.id)?.weightKg || 0), 0);
  const tiles = [
    { label: "Pedidos en ruta", value: k.pedidosEnRuta },
    { label: "Transportistas activos", value: k.transportistasActivos },
    { label: "Entregas hoy", value: k.entregasHoy },
    { label: "Bultos en tránsito", value: k.bultosEnTransito },
    { label: "Peso en tránsito (kg)", value: pesoTransito ? Math.round(pesoTransito) : 0 },
    { label: "Costo logístico", value: fmtMoney(k.costoLogistico) },
    { label: "Incidencias", value: k.incidencias, alert: k.incidencias > 0 },
  ];
  return `<div class="geo-kpi-row">${tiles.map((t) => `<div class="geo-kpi ${t.alert ? "geo-kpi-alert" : ""}"><b>${t.value}</b><span>${t.label}</span></div>`).join("")}</div>`;
}

function mapFiltersBar() {
  const f = mapGeoFilters;
  const provincias = distinctValues(state.locations, "province");
  const ciudades = distinctValues(state.locations.filter((l) => !f.provincia || l.province === f.provincia), "city");
  return `<div class="panel geo-filters ${mapFiltersOpen ? "" : "collapsed"}">
    <div class="panel-head" data-action="map-toggle-filters" style="cursor:pointer;user-select:none;"><h3>Filtros</h3><span class="hint">${mapFiltersOpen ? "Ocultar ▲" : "Mostrar ▼"}</span></div>
    ${mapFiltersOpen ? `<div class="geo-filters-grid">
      <label>Provincia<select id="geo-f-provincia" class="input"><option value="">Todas</option>${provincias.map((p) => `<option value="${esc(p)}" ${f.provincia === p ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></label>
      <label>Ciudad<select id="geo-f-ciudad" class="input"><option value="">Todas</option>${ciudades.map((c) => `<option value="${esc(c)}" ${f.ciudad === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>Estado del pedido<select id="geo-f-estado" class="input"><option value="">Todos</option>${Object.entries(ORDER_META).map(([k, v]) => `<option value="${k}" ${f.estadoPedido === k ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
      <label>Transportista<select id="geo-f-transportista" class="input"><option value="">Todos</option>${state.transports.map((t) => `<option value="${t.id}" ${f.transportistaId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
      <label>Tipo de vehículo<select id="geo-f-vehiculo" class="input"><option value="">Todos</option>${Object.entries(VEHICLE_TYPES).map(([k, v]) => `<option value="${k}" ${f.vehiculo === k ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
      <label>Tipo de carga<select id="geo-f-carga" class="input"><option value="">Todos</option>${MAP_CARGA_OPTS.map((c) => `<option value="${esc(c)}" ${f.carga === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>Tiempo<select id="geo-f-tiempo" class="input">${MAP_TIEMPO_OPTS.map((o) => `<option value="${o.key}" ${f.tiempo === o.key ? "selected" : ""}>${o.label}</option>`).join("")}</select></label>
      ${f.tiempo === "personalizado" ? `<label>Desde<input type="date" id="geo-f-desde" class="input" value="${f.tiempoDesde}" /></label><label>Hasta<input type="date" id="geo-f-hasta" class="input" value="${f.tiempoHasta}" /></label>` : ""}
      <label>Costo mín. (ARS)<input type="number" id="geo-f-costo-min" class="input" value="${f.costoMin}" /></label>
      <label>Costo máx. (ARS)<input type="number" id="geo-f-costo-max" class="input" value="${f.costoMax}" /></label>
      <div class="span2"><button type="button" class="btn btn-ghost btn-sm" data-action="map-clear-filters">Limpiar filtros</button></div>
    </div>` : ""}
  </div>`;
}

function mapLayersPanel() {
  const layers = [
    { key: "pedidos", label: "Pedidos" }, { key: "vehiculos", label: "Vehículos (sin GPS real)" },
    { key: "transportistas", label: "Transportistas" }, { key: "rutas", label: "Rutas" }, { key: "nodos", label: "Depósitos" },
    { key: "clientes", label: "Clientes" }, { key: "proveedores", label: "Proveedores" }, { key: "incidencias", label: "Incidencias" },
    { key: "heat", label: "Mapa de calor" },
  ];
  return `<div class="geo-layers">
    ${layers.map((l) => `<label class="geo-layer-toggle"><input type="checkbox" data-map-layer="${l.key}" ${mapLayerToggles[l.key] ? "checked" : ""} /> ${esc(l.label)}</label>`).join("")}
    ${mapLayerToggles.heat ? `<select id="geo-heat-var" class="input geo-heat-var"><option value="pedidos" ${mapHeatVariable === "pedidos" ? "selected" : ""}>Concentración: pedidos</option><option value="costo" ${mapHeatVariable === "costo" ? "selected" : ""}>Concentración: costo</option><option value="bultos" ${mapHeatVariable === "bultos" ? "selected" : ""}>Concentración: bultos</option><option value="incidencias" ${mapHeatVariable === "incidencias" ? "selected" : ""}>Concentración: incidencias</option></select>` : ""}
  </div>`;
}

/** Panel lateral: resumen general cuando no hay nada seleccionado, o el
 * detalle real del elemento clickeado (pedido / nodo / transportista). */
function mapSidePanel(ctx) {
  if (!mapSelection) {
    const k = computeOperationalKpis({ orders: state.orders, dispatchDetails: state.dispatch_details, transportSelections: state.transport_selections, incidents: state.incidents }, todayISO());
    return `<div class="panel geo-side">
      <div class="panel-head"><h3>Operación actual</h3></div>
      <div class="kv"><span>Pedidos activos</span><b>${k.pedidosActivos}</b></div>
      <div class="kv"><span>En preparación</span><b>${state.orders.filter((o) => ["preparacion", "preparado", "controlado"].includes(o.status)).length}</b></div>
      <div class="kv"><span>Listos / pendientes de transporte</span><b>${state.orders.filter((o) => o.status === "controlado").length}</b></div>
      <div class="kv"><span>Despachados</span><b>${state.orders.filter((o) => o.status === "despachado").length}</b></div>
      <div class="kv"><span>En tránsito</span><b>${state.orders.filter((o) => o.status === "en_camino").length}</b></div>
      <div class="kv"><span>Entregados</span><b>${state.orders.filter((o) => o.status === "entregado").length}</b></div>
      <div class="kv"><span>Incidencias</span><b class="${k.incidencias ? "text-danger" : ""}">${k.incidencias}</b></div>
      ${ctx.sinGeo ? `<div class="hint" style="margin-top:10px">${ctx.sinGeo} pedido(s) filtrados no tienen ubicación geocodificada — no aparecen en el mapa. Cargá su dirección en Ubicaciones para que se muestren.</div>` : ""}
      ${ctx.transportesSinBase ? `<div class="hint" style="margin-top:6px">${ctx.transportesSinBase} transportista(s) sin ninguna ruta con coordenadas — no aparecen en la capa Transportistas.</div>` : ""}
      ${ctx.incidenciasSinGeo ? `<div class="hint" style="margin-top:6px">${ctx.incidenciasSinGeo} incidencia(s) abierta(s) sin una ubicación real resoluble — no aparecen en la capa Incidencias.</div>` : ""}
    </div>`;
  }
  if (mapSelection.type === "order") {
    const o = getById("orders", mapSelection.id);
    if (!o) { mapSelection = null; return mapSidePanel(ctx); }
    const sel = latestSelection(o.id);
    const d = dispatchDetail(o.id);
    const loc = getById("locations", o.locationId);
    return `<div class="panel geo-side">
      <div class="panel-head"><h3>Pedido #${esc(o.number)}</h3><button type="button" class="btn btn-ghost btn-sm" data-action="map-clear-selection">✕</button></div>
      <div class="kv"><span>Cliente</span><b>${esc(o.customerName)}</b></div>
      <div class="kv"><span>Estado</span>${statusBadge(ORDER_META[o.status])}</div>
      <div class="kv"><span>Entrega prevista</span><b>${fmtDate(o.expectedDate)}</b></div>
      ${sel ? `<div class="kv"><span>Transportista</span><b>${esc(getById("transports", sel.transportId)?.name || "—")}</b></div>
      <div class="kv"><span>Vehículo</span><b>${esc(VEHICLE_TYPES[sel.vehicleType]?.label || "—")}</b></div>
      <div class="kv"><span>Costo estimado</span><b>${fmtMoney(sel.estimatedCost)}</b></div>` : `<div class="hint" style="margin-top:8px">Todavía no tiene transporte seleccionado.</div>`}
      ${d?.boxesCount ? `<div class="kv"><span>Bultos</span><b>${d.boxesCount}</b></div>` : ""}
      <div class="form-actions" style="margin-top:10px"><a href="#/pedidos/${o.id}" class="btn btn-ghost btn-sm">Ver pedido</a><a href="#/expedicion/${o.id}" data-action="map-comparar-transporte" data-id="${o.id}" class="btn btn-primary btn-sm">Comparar transporte</a></div>
      ${mapActionButtonsHTML({ lat: loc?.lat, lng: loc?.lng, label: `Pedido #${o.number}`, locationId: loc?.id })}
    </div>`;
  }
  if (mapSelection.type === "location") {
    const l = getById("locations", mapSelection.id);
    if (!l) { mapSelection = null; return mapSidePanel(ctx); }
    const s = nodeSummary(l.id, { orders: state.orders, transportSelections: state.transport_selections });
    return `<div class="panel geo-side">
      <div class="panel-head"><h3>${esc(l.name)}</h3><button type="button" class="btn btn-ghost btn-sm" data-action="map-clear-selection">✕</button></div>
      <div class="kv"><span>Tipo de nodo</span><b>${esc(LOCATION_TYPES[l.type]?.label || l.type)}</b></div>
      <div class="kv"><span>Dirección</span><b>${esc(l.address || "—")}</b></div>
      <div class="kv"><span>Pedidos pendientes</span><b>${s.pendientes}</b></div>
      <div class="kv"><span>Pedidos en tránsito</span><b>${s.enTransito}</b></div>
      <div class="kv"><span>Pedidos entregados</span><b>${s.entregados}</b></div>
      <div class="kv"><span>Costo logístico acumulado</span><b>${fmtMoney(s.costoAcumulado)}</b></div>
      <div class="kv"><span>Vehículos disponibles</span><b>Sin datos</b></div>
      <div class="kv-notes"><span>Radio geográfico (no es tiempo de entrega)</span>
        <div class="chip-row" style="margin-top:6px">${[100, 300, 500].map((r) => `<button type="button" class="chip chip-sm ${mapCoverageRadiusKm === r ? "active" : ""}" data-map-radius="${r}">${r} km</button>`).join("")}<button type="button" class="chip chip-sm ${mapCoverageRadiusKm === 501 ? "active" : ""}" data-map-radius="501">+500 km</button>${mapCoverageRadiusKm ? `<button type="button" class="chip chip-sm" data-map-radius="0">Quitar</button>` : ""}</div>
      </div>
      ${mapActionButtonsHTML({ lat: l.lat, lng: l.lng, label: l.name, locationId: l.id })}
    </div>`;
  }
  if (mapSelection.type === "transport") {
    const t = getById("transports", mapSelection.id);
    if (!t) { mapSelection = null; return mapSidePanel(ctx); }
    const hist = transportHistoryStats(t.id);
    const activos = state.orders.filter((o) => o.transportId === t.id && ["despachado", "en_camino"].includes(o.status));
    const base = transportBasePoint(t.id, state.routes);
    return `<div class="panel geo-side">
      <div class="panel-head"><h3>${esc(t.name)}</h3><button type="button" class="btn btn-ghost btn-sm" data-action="map-clear-selection">✕</button></div>
      <div class="kv"><span>Tipo de carga</span><b>${esc(t.type || "—")}</b></div>
      <div class="kv"><span>Vehículos que opera</span><b>${vehicleBadges(t) || "—"}</b></div>
      <div class="kv"><span>Pedidos en ruta ahora</span><b>${activos.length}</b></div>
      <div class="kv"><span>Envíos históricos</span><b>${hist.envios}</b></div>
      <div class="kv"><span>Cumplimiento a tiempo</span><b>${hist.onTimePct != null ? hist.onTimePct + "%" : "Sin datos (menos de 3 entregas)"}</b></div>
      <div class="form-actions" style="margin-top:10px"><a href="#/transporte/${t.id}" class="btn btn-primary btn-sm">Ver transportista</a></div>
      ${mapActionButtonsHTML({ lat: base?.lat, lng: base?.lng, label: t.name })}
    </div>`;
  }
  if (mapSelection.type === "cliente") {
    const c = getById("customers", mapSelection.id);
    if (!c) { mapSelection = null; return mapSidePanel(ctx); }
    const loc = getById("locations", c.locationId);
    const pedidos = state.orders.filter((o) => o.customerId === c.id && o.status !== "cancelado");
    return `<div class="panel geo-side">
      <div class="panel-head"><h3>${esc(c.name)}</h3><button type="button" class="btn btn-ghost btn-sm" data-action="map-clear-selection">✕</button></div>
      <div class="kv"><span>Dirección</span><b>${esc(loc?.address || "—")}</b></div>
      <div class="kv"><span>Teléfono</span><b>${esc(c.phone || "—")}</b></div>
      <div class="kv-notes"><span>Sus pedidos (${pedidos.length})</span>
        ${pedidos.length ? pedidos.slice(0, 8).map((o) => `<div class="geo-candidato"><a href="#/pedidos/${o.id}">#${esc(o.number)}</a> · ${statusBadge(ORDER_META[o.status])}</div>`).join("") : `<p class="hint">Sin pedidos activos.</p>`}
      </div>
      ${mapActionButtonsHTML({ lat: loc?.lat, lng: loc?.lng, label: c.name, locationId: loc?.id })}
    </div>`;
  }
  if (mapSelection.type === "proveedor") {
    const s = getById("suppliers", mapSelection.id);
    if (!s) { mapSelection = null; return mapSidePanel(ctx); }
    const loc = getById("locations", s.locationId);
    const ocs = state.purchase_orders.filter((p) => p.supplierId === s.id && p.status !== "cerrada");
    return `<div class="panel geo-side">
      <div class="panel-head"><h3>${esc(s.name)}</h3><button type="button" class="btn btn-ghost btn-sm" data-action="map-clear-selection">✕</button></div>
      <div class="kv"><span>Dirección</span><b>${esc(loc?.address || "—")}</b></div>
      <div class="kv"><span>Contacto</span><b>${esc(s.contact || "—")}</b></div>
      <div class="kv-notes"><span>Sus órdenes de compra (${ocs.length})</span>
        ${ocs.length ? ocs.slice(0, 8).map((p) => `<div class="geo-candidato"><a href="#/compras/${p.id}">OC #${esc(p.number)}</a> · ${statusBadge(PO_META[p.status] || { label: p.status, cls: "st-gray" })}</div>`).join("") : `<p class="hint">Sin OC activas.</p>`}
      </div>
      <div class="form-actions" style="margin-top:10px"><a href="#/proveedores/${s.id}" class="btn btn-primary btn-sm">Ver proveedor</a></div>
      ${mapActionButtonsHTML({ lat: loc?.lat, lng: loc?.lng, label: s.name, locationId: loc?.id })}
    </div>`;
  }
  if (mapSelection.type === "incidencia") {
    const i = getById("incidents", mapSelection.id);
    if (!i) { mapSelection = null; return mapSidePanel(ctx); }
    return `<div class="panel geo-side">
      <div class="panel-head"><h3>⚠️ ${esc(i.title)}</h3><button type="button" class="btn btn-ghost btn-sm" data-action="map-clear-selection">✕</button></div>
      <div class="kv"><span>Estado</span>${statusBadge(INCIDENT_META[i.status])}</div>
      <div class="kv"><span>Relacionada con</span><b>${esc(relatedLabel(i) || "—")}</b></div>
      <div class="kv"><span>Fecha</span><b>${fmtDate(i.date)}</b></div>
      <div class="form-actions" style="margin-top:10px"><a href="#/incidencias/${i.id}" class="btn btn-primary btn-sm">Ver incidencia</a></div>
    </div>`;
  }
  if (mapSelection.type === "zone") {
    const z = getById("logistics_zones", mapSelection.id);
    if (!z) { mapSelection = null; return mapSidePanel(ctx); }
    const cost = transportRateCost(z, null, null);
    return `<div class="panel geo-side">
      <div class="panel-head"><h3>${esc(z.name)}</h3><button type="button" class="btn btn-ghost btn-sm" data-action="map-clear-selection">✕</button></div>
      <div class="kv"><span>Provincias</span><b>${(z.provinces || []).map(esc).join(", ") || "—"}</b></div>
      <div class="kv-notes"><span>Tarifa de referencia</span>
        ${cost.breakdown.length ? cost.breakdown.map((b) => `<div class="geo-candidato"><span>${esc(b.label)}</span> ${b.missing ? `<span class="hint">${esc(b.missing)}</span>` : `<b>${fmtMoney(b.value)}</b>`}</div>`).join("") : `<p class="hint">Sin componentes de tarifa configurados.</p>`}
      </div>
      ${z.notes ? `<div class="kv"><span>Notas</span><b>${esc(z.notes)}</b></div>` : ""}
      <div class="form-actions" style="margin-top:10px">
        <button type="button" class="btn btn-ghost btn-sm" data-action="map-zone-edit" data-id="${z.id}">Editar</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="map-zone-delete" data-id="${z.id}">Eliminar</button>
      </div>
    </div>`;
  }
  if (mapSelection.type === "place") {
    const { lat, lng, label } = mapSelection;
    return `<div class="panel geo-side">
      <div class="panel-head"><h3>${esc(label || "Ubicación")}</h3><button type="button" class="btn btn-ghost btn-sm" data-action="map-clear-selection">✕</button></div>
      <div class="hint">Resultado de Google — no es un registro guardado en Logística Perona.</div>
      <div class="form-actions" style="margin-top:10px;flex-wrap:wrap;">
        <button type="button" class="btn btn-ghost btn-sm" data-action="plan-use-as" data-which="origen" data-lat="${lat}" data-lng="${lng}" data-label="${esc(label || "")}">Usar como origen</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="plan-use-as" data-which="destino" data-lat="${lat}" data-lng="${lng}" data-label="${esc(label || "")}">Usar como destino</button>
      </div>
      ${mapActionButtonsHTML({ lat, lng, label })}
    </div>`;
  }
  mapSelection = null;
  return mapSidePanel(ctx);
}

/** Punto resuelto para "Planificar recorrido": una coordenada suelta de
 * Google Places (búsqueda de una dirección que no está guardada como
 * ubicación) tiene prioridad si existe; si no, se usa la ubicación elegida
 * por id. Nunca inventa una coordenada — si no hay nada resuelto, null. */
function planResolvedPoint(which) {
  const point = which === "origen" ? mapOrigenDestino.origenPoint : mapOrigenDestino.destinoPoint;
  if (point) return point;
  const id = which === "origen" ? mapOrigenDestino.origenId : mapOrigenDestino.destinoId;
  if (id) {
    const loc = getById("locations", id);
    if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") return { lat: loc.lat, lng: loc.lng, label: loc.name, province: loc.province, city: loc.city, locationId: loc.id };
  }
  return null;
}
function planClearField(which) {
  mapPlanQuery[which] = "";
  mapPlanSuggestions[which] = [];
  if (which === "origen") { mapOrigenDestino.origenId = ""; mapOrigenDestino.origenPoint = null; }
  else { mapOrigenDestino.destinoId = ""; mapOrigenDestino.destinoPoint = null; }
  mapRouteResult = null; mapRouteError = "";
}
/** Ubicaciones ya geocodificadas que matchean el texto tipeado — nunca una
 * lista fija: sale directo de las ubicaciones reales cargadas. */
function planLocationMatches(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return state.locations
    .filter((l) => typeof l.lat === "number" && typeof l.lng === "number")
    .filter((l) => [l.name, l.city, l.address, l.province].some((v) => (v || "").toLowerCase().includes(q)))
    .slice(0, 6);
}
function planFieldInputHTML(which, label) {
  const resolved = planResolvedPoint(which);
  const value = resolved ? resolved.label : mapPlanQuery[which];
  const showDropdown = !resolved && mapPlanQuery[which].trim().length >= 2;
  const locMatches = showDropdown ? planLocationMatches(mapPlanQuery[which]) : [];
  const placeMatches = showDropdown ? (mapPlanSuggestions[which] || []) : [];
  return `<label class="geo-plan-field">
    ${label}
    <div class="geo-plan-input-row">
      <input type="text" id="geo-plan-${which}" class="input" placeholder="Buscar ubicación..." autocomplete="off" value="${esc(value)}" ${resolved ? "readonly" : ""} />
      ${resolved ? `<button type="button" class="geo-plan-clear" data-action="plan-clear-field" data-which="${which}" title="Cambiar">✕</button>` : ""}
    </div>
    ${showDropdown && (locMatches.length || placeMatches.length) ? `<div class="geo-plan-suggest">
      ${locMatches.length ? `<div class="geo-plan-suggest-group">En Logística Perona</div>${locMatches.map((l) => `<button type="button" class="geo-plan-suggest-item" data-action="plan-select-loc" data-which="${which}" data-id="${l.id}"><span>📍</span><div><b>${esc(l.name)}</b><span class="hint">${esc([l.city, l.province].filter(Boolean).join(", "))}</span></div></button>`).join("")}` : ""}
      ${placeMatches.length ? `<div class="geo-plan-suggest-group">Direcciones y lugares (Google)</div>${placeMatches.map((p) => `<button type="button" class="geo-plan-suggest-item" data-action="plan-select-place" data-which="${which}" data-place-id="${esc(p.placeId)}"><span>🌍</span><div><b>${esc(p.label)}</b></div></button>`).join("")}` : ""}
    </div>` : ""}
  </label>`;
}

/** "Planificar recorrido": reemplaza el antiguo Origen → Destino. Origen y
 * destino se buscan por texto (ubicación ya guardada o una dirección real de
 * Google Places) y, cuando ambos están resueltos, se calcula una ruta REAL
 * sobre calles (Directions). Si Directions no está disponible (sin clave
 * configurada, sin cobertura), se avisa con claridad y se muestra sólo la
 * distancia en línea recta como referencia — nunca se presenta una como si
 * fuera la otra. */
function mapPlanificarRecorridoTool() {
  const origen = planResolvedPoint("origen");
  const destino = planResolvedPoint("destino");
  let resultado = "";
  if (origen && destino) {
    const kmLinea = Math.round(haversineKm(origen.lat, origen.lng, destino.lat, destino.lng));
    const texto = (t) => [t.province, t.city, t.zone, t.originCoverage].filter(Boolean).join(" ").toLowerCase();
    const candidatos = (origen.province || destino.province || origen.city || destino.city)
      ? state.transports.filter((t) => {
          const tx = texto(t);
          return (origen.province && tx.includes(origen.province.toLowerCase())) || (destino.province && tx.includes(destino.province.toLowerCase())) ||
            (origen.city && tx.includes(origen.city.toLowerCase())) || (destino.city && tx.includes(destino.city.toLowerCase()));
        })
      : [];
    const pendientesEntre = destino.locationId ? state.orders.filter((o) => o.locationId === destino.locationId && !["entregado", "cancelado"].includes(o.status)) : [];
    if (mapRouteBusy) {
      resultado = `<div class="hint" style="margin-top:8px">Calculando ruta real…</div>`;
    } else if (mapRouteResult) {
      resultado = `<div class="geo-plan-results">
        <div class="geo-plan-stat"><b>${esc(mapRouteResult.distanceText || mapRouteResult.distanceKm + " km")}</b><span>Distancia</span></div>
        <div class="geo-plan-stat"><b>${esc(mapRouteResult.durationText || "—")}</b><span>Tiempo estimado</span></div>
        <div class="geo-plan-stat"><b>0</b><span>Paradas</span></div>
        <div class="geo-plan-stat"><b>${candidatos.length ? esc(candidatos[0].name) : "—"}</b><span>Transportista sugerido</span></div>
      </div>`;
    } else if (mapRouteError) {
      resultado = `<div class="hint" style="margin-top:8px">${esc(mapRouteError)} Distancia en línea recta como referencia: ${kmLinea} km.</div>`;
    }
    resultado += `${pendientesEntre.length ? `<div class="kv" style="margin-top:8px"><span>Pedidos pendientes hacia ese destino</span><b>${pendientesEntre.length}</b></div>` : ""}
      <div class="kv-notes" style="margin-top:8px"><span>Transportistas con cobertura declarada en esa zona (${candidatos.length})</span>
        ${candidatos.length ? candidatos.slice(0, 6).map((t) => `<div class="geo-candidato"><b>${esc(t.name)}</b> · ${vehicleBadges(t) || esc(t.type || "—")}</div>`).join("") : `<p>Sin datos — ningún transportista cargado menciona esta zona en su cobertura, o el punto no tiene provincia/ciudad conocida.</p>`}
      </div>
      ${pendientesEntre.length === 1 ? `<a href="#/expedicion/${pendientesEntre[0].id}" data-action="map-comparar-transporte" data-id="${pendientesEntre[0].id}" class="btn btn-primary btn-sm" style="margin-top:8px;width:100%;text-align:center;">Comparar transporte para el pedido #${esc(pendientesEntre[0].number)}</a>` : pendientesEntre.length > 1 ? `<a href="#/expedicion" class="btn btn-ghost btn-sm" style="margin-top:8px;width:100%;text-align:center;">Ver los ${pendientesEntre.length} pedidos en Expedición</a>` : ""}`;
  }
  return `<div class="panel geo-od">
    <div class="panel-head"><h3>Planificar recorrido</h3></div>
    <div class="geo-plan-grid">
      ${planFieldInputHTML("origen", "Origen")}
      ${planFieldInputHTML("destino", "Destino")}
    </div>
    <button type="button" class="btn btn-primary btn-sm" style="width:100%;margin-top:4px" data-action="plan-calcular" ${origen && destino && !mapRouteBusy ? "" : "disabled"}>Calcular ruta</button>
    ${resultado || `<div class="hint" style="margin-top:8px">Buscá origen y destino: una ubicación ya guardada o cualquier dirección real.</div>`}
  </div>`;
}
// origenId/destinoId: una ubicación ya guardada (locations). origenPoint/
// destinoPoint: una coordenada suelta resuelta vía Google Places (una
// dirección que no tiene (todavía) un registro en locations) — nunca se crea
// un registro nuevo en la base sólo por buscarla, se usa la coordenada nomás
// para este cálculo puntual. routeResult guarda la última ruta calculada con
// Directions (o null si no se pudo calcular / todavía no se calculó).
let mapOrigenDestino = { origenId: "", destinoId: "", origenPoint: null, destinoPoint: null };
let mapPlanQuery = { origen: "", destino: "" };
let mapPlanSuggestions = { origen: [], destino: [] };
let mapRouteResult = null; // { distanceKm, distanceText, durationMin, durationText, path } | null
let mapRouteBusy = false;
let mapRouteError = "";

/** Búsqueda interna (base de datos de Logística Perona): pedidos, órdenes de
 * compra, clientes, proveedores, transportistas, ubicaciones guardadas
 * (depósitos incluidos), ciudades y provincias — todo dato real ya cargado.
 * Google Places (buscador de direcciones/lugares reales) se agrega aparte en
 * mapSearchResultsHTML(), nunca reemplaza a esta. */
function mapSearchResults(q) {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const results = [];
  state.orders.forEach((o) => { if (String(o.number).toLowerCase().includes(query) || (o.customerName || "").toLowerCase().includes(query)) results.push({ icon: "📦", title: `Pedido #${o.number}`, sub: o.customerName, action: () => { mapSelection = { type: "order", id: o.id }; const p = orderGeoPoint(o, new Map(state.locations.map((l) => [l.id, l]))); if (p) focusLogisticsMap("mapa-geo", p.lat, p.lng, 12); renderMainOnly(); } }); });
  state.purchase_orders.forEach((po) => { if (String(po.number).toLowerCase().includes(query) || (po.supplierName || "").toLowerCase().includes(query)) results.push({ icon: "🛒", title: `OC #${po.number}`, sub: po.supplierName, action: () => { location.hash = `#/compras/${po.id}`; } }); });
  state.customers.forEach((c) => { if (c.name.toLowerCase().includes(query)) results.push({ icon: "🏢", title: c.name, sub: "Cliente", action: () => { mapSelection = null; const loc = getById("locations", c.locationId); if (loc && typeof loc.lat === "number") { mapSelection = { type: "location", id: loc.id }; focusLogisticsMap("mapa-geo", loc.lat, loc.lng, 13); } renderMainOnly(); } }); });
  state.suppliers.forEach((s) => { if (s.name.toLowerCase().includes(query)) results.push({ icon: "🛒", title: s.name, sub: "Proveedor", action: () => { mapSelection = null; const loc = getById("locations", s.locationId); if (loc && typeof loc.lat === "number") { mapSelection = { type: "location", id: loc.id }; focusLogisticsMap("mapa-geo", loc.lat, loc.lng, 13); } renderMainOnly(); } }); });
  state.transports.forEach((t) => { if (t.name.toLowerCase().includes(query)) results.push({ icon: "🚚", title: t.name, sub: t.type || "Transportista", action: () => { mapSelection = { type: "transport", id: t.id }; const p = transportBasePoint(t.id, state.routes); if (p) focusLogisticsMap("mapa-geo", p.lat, p.lng, 10); renderMainOnly(); } }); });
  state.locations.forEach((l) => { if ((l.name || "").toLowerCase().includes(query) || (l.address || "").toLowerCase().includes(query)) results.push({ icon: LOCATION_TYPES[l.type]?.icon || "📍", title: l.name, sub: l.address || LOCATION_TYPES[l.type]?.label, action: () => { mapSelection = { type: "location", id: l.id }; if (typeof l.lat === "number") focusLogisticsMap("mapa-geo", l.lat, l.lng, 13); renderMainOnly(); } }); });
  distinctValues(state.locations, "city").forEach((c) => { if (c.toLowerCase().includes(query)) { const loc = state.locations.find((l) => l.city === c); results.push({ icon: "🏙️", title: c, sub: loc?.province || "Ciudad", action: () => { mapGeoFilters.provincia = loc?.province || ""; mapGeoFilters.ciudad = c; renderMainOnly(); } }); } });
  distinctValues(state.locations, "province").forEach((p) => { if (p.toLowerCase().includes(query)) results.push({ icon: "🗺️", title: p, sub: "Provincia", action: () => { mapGeoFilters.provincia = p; mapGeoFilters.ciudad = ""; renderMainOnly(); } }); });
  return results.slice(0, 8);
}

/** Buscador combinado del mapa: agrupa los resultados internos (base de
 * Logística Perona, siempre presentes y síncronos) y — si hay una clave de
 * Google Maps configurada — un segundo grupo de direcciones/lugares reales
 * vía Places (New), cargado de forma asíncrona. Ninguno reemplaza al otro. */
function mapSearchResultsHTML() {
  if (!mapSearchQuery.trim()) return "";
  const internos = mapSearchResults(mapSearchQuery);
  const lugares = googleMapsKeyConfigured() ? mapPlacesSuggestions : [];
  if (!internos.length && !lugares.length) return `<div class="geo-search-results"><div class="search-empty">Sin resultados</div></div>`;
  return `<div class="geo-search-results">
    ${internos.length ? `<div class="geo-search-group">En Logística Perona</div>${internos.map((r, i) => `<button type="button" class="search-result-item" data-map-search-result="${i}"><span class="sr-icon">${r.icon}</span><div><div class="sr-title">${esc(r.title)}</div><div class="sr-sub">${esc(r.sub || "")}</div></div></button>`).join("")}` : ""}
    ${lugares.length ? `<div class="geo-search-group">Direcciones y lugares (Google)</div>${lugares.map((p) => `<button type="button" class="search-result-item" data-map-search-place="${esc(p.placeId)}"><span class="sr-icon">🌍</span><div><div class="sr-title">${esc(p.label)}</div></div></button>`).join("")}` : ""}
  </div>`;
}

function mapGeoHeader() {
  const k = computeOperationalKpis({ orders: state.orders, dispatchDetails: state.dispatch_details, transportSelections: state.transport_selections, incidents: state.incidents }, todayISO());
  const enTransito = state.orders.filter((o) => ["despachado", "en_camino"].includes(o.status)).length;
  const entregasHoy = state.orders.filter((o) => o.status === "entregado" && o.actualDeliveryDate === todayISO()).length;
  return `<div class="geo-header">
    <div>
      <h2>LOGÍSTICA PERONA</h2>
      <div class="detail-sub">Centro de operaciones y distribución</div>
      <div class="geo-live-indicators">
        <span class="geo-live-ind"><i class="dot-ind st-blue"></i>${k.pedidosActivos} pedidos activos</span>
        <span class="geo-live-ind"><i class="dot-ind st-orange"></i>${enTransito} en tránsito</span>
        <span class="geo-live-ind"><i class="dot-ind st-green"></i>${entregasHoy} entregas hoy</span>
        <span class="geo-live-ind ${k.incidencias ? "geo-live-alert" : ""}"><i class="dot-ind ${k.incidencias ? "st-red" : "st-gray"}"></i>${k.incidencias} incidencias</span>
      </div>
    </div>
    <div class="chip-row">${["operativo", "estrategico", "tactico"].map((lv) => `<button class="chip ${mapLevel === lv ? "active" : ""}" data-map-level="${lv}">${lv[0].toUpperCase() + lv.slice(1)}</button>`).join("")}</div>
  </div>`;
}

/** Provincias reales que ya aparecen en los datos cargados (ubicaciones y
 * transportes) — nunca una lista de provincias inventada de antemano. */
function allKnownProvinces() {
  return Array.from(new Set([...distinctValues(state.locations, "province"), ...distinctValues(state.transports, "province")])).sort((a, b) => a.localeCompare(b));
}

/** Provincias ya asignadas a alguna zona (opcionalmente excluyendo una, para
 * poder seguir mostrando sus propias provincias como disponibles al editarla). */
function provincesUsedByZones(excludeZoneId) {
  const used = new Set();
  state.logistics_zones.forEach((z) => { if (z.id !== excludeZoneId) (z.provinces || []).forEach((p) => used.add(p)); });
  return used;
}

function mapZonaPopupHTML(m) {
  const z = getById("logistics_zones", m.zoneId);
  return `<div class="map-popup">
    <div class="map-popup-title">${esc(m.zoneName)}</div>
    <div class="map-popup-row"><span>Provincia</span><b>${esc(m.province)}</b></div>
    <div class="map-popup-row"><span>Referencia (capital)</span><b>${esc(m.city)}</b></div>
    ${z ? `<div class="map-popup-row"><span>Costo fijo</span><b>${fmtMoney(z.fixedAmount || 0)}</b></div>` : ""}
  </div>`;
}

/** Panel: lista de zonas ya definidas + provincias todavía sin asignar
 * (informado explícitamente, nunca omitido en silencio). */
function mapZoneList() {
  const zones = state.logistics_zones;
  const used = provincesUsedByZones(null);
  const sinZona = allKnownProvinces().filter((p) => !used.has(p));
  return `<div class="panel geo-zone-list">
    <div class="panel-head"><h3>Zonas tarifarias</h3><button type="button" class="btn btn-primary btn-sm" data-action="map-zone-new">+ Nueva zona</button></div>
    ${zones.length ? zones.map((z) => `
      <div class="geo-zone-row" data-action="map-zone-select" data-id="${z.id}">
        <span class="geo-zone-swatch" style="background:${esc(z.color || ZONE_PALETTE[0])}"></span>
        <div class="geo-zone-info"><b>${esc(z.name)}</b><span class="hint">${(z.provinces || []).map(esc).join(", ") || "Sin provincias asignadas"}</span></div>
      </div>`).join("") : `<p class="hint">Todavía no definiste ninguna zona tarifaria.</p>`}
    ${sinZona.length ? `<div class="hint" style="margin-top:10px">Provincias cargadas sin zona asignada: ${sinZona.map(esc).join(", ")}.</div>` : ""}
  </div>`;
}

/** Formulario de alta/edición de una zona — provincias tomadas de las que ya
 * existen en los datos reales, nunca una lista fija. Una provincia ya usada
 * por OTRA zona se muestra deshabilitada (una provincia pertenece a una sola
 * zona a la vez, para que el mapa de cobertura no sea ambiguo). */
function mapZoneForm(editingId) {
  const z = editingId && editingId !== "new" ? getById("logistics_zones", editingId) : null;
  const used = provincesUsedByZones(z?.id);
  const provincias = allKnownProvinces();
  return `<form data-form="zona" data-id="${z ? z.id : ""}" class="panel geo-zone-form">
    <div class="panel-head"><h3>${z ? "Editar zona" : "Nueva zona tarifaria"}</h3></div>
    <div class="form-grid">
      <label class="span2">Nombre<input class="input" name="name" required value="${esc(z?.name || "")}" placeholder="Ej: Zona NOA" /></label>
      <div class="span2">
        <span style="display:block;margin-bottom:6px;">Provincias que incluye</span>
        ${provincias.length ? `<div class="chip-row" style="margin:0;flex-wrap:wrap;">${provincias.map((p) => {
          const disabled = used.has(p) && !(z?.provinces || []).includes(p);
          return `<label class="checkbox-row${disabled ? " disabled" : ""}"><input type="checkbox" name="provinces" value="${esc(p)}" ${(z?.provinces || []).includes(p) ? "checked" : ""} ${disabled ? "disabled" : ""} /> ${esc(p)}${disabled ? " (en otra zona)" : ""}</label>`;
        }).join("")}</div>` : `<p class="hint">Todavía no hay ninguna provincia cargada en Ubicaciones ni Transportes.</p>`}
      </div>
      <label>Costo fijo (ARS)<input class="input" type="number" step="0.01" name="fixedAmount" value="${z?.fixedAmount || 0}" /></label>
      <label>Por km (ARS)<input class="input" type="number" step="0.01" name="perKm" value="${z?.perKm || 0}" /></label>
      <label>Por caja (ARS)<input class="input" type="number" step="0.01" name="perBox" value="${z?.perBox || 0}" /></label>
      <label>Por kg (ARS)<input class="input" type="number" step="0.01" name="perKg" value="${z?.perKg || 0}" /></label>
      <label class="span2">% del valor del pedido<input class="input" type="number" step="0.01" name="percent" value="${z?.percent || 0}" /></label>
      <label class="span2">Notas<textarea class="input" name="notes" rows="2">${esc(z?.notes || "")}</textarea></label>
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" data-action="map-zone-cancel">Cancelar</button>
      <button type="submit" class="btn btn-primary">${z ? "Guardar cambios" : "Crear zona"}</button>
    </div>
  </form>`;
}

/** Nivel Táctico: zonas tarifarias por provincia. Sin polígonos (la app no
 * tiene los límites reales de cada provincia): cada zona se ubica en el mapa
 * por la coordenada real de la capital de cada provincia que la integra. */
function viewMapaTactico() {
  const { markers, unresolved } = zoneCoverageMarkers(state.logistics_zones);
  const zonaMarkers = markers.map((m) => ({
    lat: m.lat, lng: m.lng, kind: "zona", color: m.color || ZONE_PALETTE[0],
    popupHtml: mapZonaPopupHTML(m),
    onClick: () => { mapSelection = { type: "zone", id: m.zoneId }; mapZoneEditing = null; renderMainOnly(); },
  }));
  mapGeoCtx = { zonaMarkers };
  return `<div class="view-mapa-geo">
    ${mapGeoHeader()}
    <div class="geo-main-grid">
      <div class="geo-map-col">
        <div class="panel geo-map-panel">
          <div class="hint">Zonas tarifarias configurables por provincia. Cada punto marca la capital real de una provincia asignada a una zona — la app no tiene los límites geográficos reales de cada provincia, así que no se dibuja ningún polígono.</div>
          <div id="mapa-geo" class="leaflet-box geo-leaflet"></div>
          ${unresolved.length ? `<div class="hint">Sin coordenada de referencia para: ${unresolved.map((u) => esc(u.province)).join(", ")}.</div>` : ""}
        </div>
      </div>
      <div class="geo-side-col">
        ${mapZoneEditing ? mapZoneForm(mapZoneEditing) : mapZoneList()}
        ${!mapZoneEditing && mapSelection?.type === "zone" ? mapSidePanel({}) : ""}
      </div>
    </div>
  </div>`;
}

/** Nivel Estratégico: nodos logísticos (depósitos) y radios de cobertura —
 * ambos ya son datos reales, reusados tal cual del nivel Operativo. Los
 * corredores viales quedan pendientes: definir qué nodos conecta cada uno
 * (ej. Ruta 9) es una relación que hoy no existe en ningún lado de los datos
 * cargados, y esta ronda no se construyó esa configuración (ver el diagnóstico
 * en el proyecto) — se informa como "Sin datos", nunca se inventa. */
function viewMapaEstrategico() {
  const nodosMarkers = state.locations.filter((l) => l.type === "deposito" && typeof l.lat === "number" && typeof l.lng === "number").map((l) => ({
    lat: l.lat, lng: l.lng, kind: "deposito", popupHtml: mapNodePopupHTML(l),
    onClick: () => { mapSelection = { type: "location", id: l.id }; renderMainOnly(); },
  }));
  mapGeoCtx = { nodosMarkers };
  return `<div class="view-mapa-geo">
    ${mapGeoHeader()}
    <div class="geo-main-grid">
      <div class="geo-map-col">
        <div class="panel geo-map-panel">
          <div class="hint">Nodos logísticos (depósitos) reales. Hacé click en uno para ver su radio de cobertura geográfica.</div>
          <div id="mapa-geo" class="leaflet-box geo-leaflet"></div>
        </div>
      </div>
      <div class="geo-side-col">
        ${mapSidePanel({})}
        <div class="panel geo-placeholder">
          <div class="panel-head"><h3>Corredores viales</h3></div>
          <p class="hint">Sin datos todavía. Qué nodos conecta cada corredor (ej. Ruta 9) es una relación que no existe hoy en ningún dato cargado — se deja para una próxima fase, en vez de inventarla.</p>
        </div>
      </div>
    </div>
  </div>`;
}

function viewMapaLogistico() {
  if (mapLevel === "estrategico") return viewMapaEstrategico();
  if (mapLevel === "tactico") return viewMapaTactico();
  const orders = mapFilteredOrders();
  const ctx = buildOperativeLayers(orders);
  const heatPoints = mapLayerToggles.heat ? buildHeatPoints(orders, mapHeatVariable) : [];
  mapGeoCtx = ctx; // se reusa en mountMapsIfPresent para no recalcular las capas al montar el Leaflet real

  return `<div class="view-mapa-geo">
    ${mapGeoHeader()}
    ${mapKpiRow()}
    <div class="geo-toolbar">
      <input type="text" id="geo-search" class="input geo-search" placeholder="Buscar en Logística Perona..." value="${esc(mapSearchQuery)}" />
      ${mapSearchResultsHTML()}
    </div>
    ${mapFiltersBar()}
    <div class="geo-main-grid">
      <div class="geo-map-col">
        <div class="panel geo-map-panel">
          ${mapLayersPanel()}
          <div id="mapa-geo" class="leaflet-box geo-leaflet"></div>
        </div>
      </div>
      <div class="geo-side-col">
        ${mapSidePanel(ctx)}
        ${mapPlanificarRecorridoTool()}
      </div>
    </div>
  </div>`;
}

/** Se llama después de insertar el HTML en el DOM: monta/actualiza cada mapa Leaflet presente. */
function mountMapsIfPresent() {
  if (document.getElementById("mapa-geo")) {
    const ctx = mapGeoCtx || {};
    // El auto-encuadre del mapa se fuerza una sola vez al cambiar de nivel
    // (cada nivel muestra una geografía distinta); dentro del mismo nivel,
    // el propio mapa ya evita re-encuadrar en cada click/filtro/toggle.
    const forceFit = mapLevelForFit !== mapLevel;
    mapLevelForFit = mapLevel;
    const circles = [];
    if (mapSelection?.type === "location" && mapCoverageRadiusKm) {
      const loc = getById("locations", mapSelection.id);
      if (loc && typeof loc.lat === "number") circles.push({ lat: loc.lat, lng: loc.lng, radiusMeters: mapCoverageRadiusKm * 1000, color: "#C9142B", label: `Radio geográfico: ${mapCoverageRadiusKm > 500 ? "+500" : mapCoverageRadiusKm} km` });
    }
    if (mapLevel === "tactico") {
      mountLogisticsMap("mapa-geo", {
        layers: { zonas: { markers: ctx.zonaMarkers || [], cluster: false, visible: true } },
        routesVisible: false,
        circles: [],
        fitBounds: forceFit,
        selectedId: mapSelection?.id,
      });
    } else if (mapLevel === "estrategico") {
      mountLogisticsMap("mapa-geo", {
        layers: { nodos: { markers: ctx.nodosMarkers || [], cluster: false, visible: true } },
        routesVisible: false,
        circles,
        fitBounds: forceFit,
        selectedId: mapSelection?.id,
      });
    } else {
      const orders = mapFilteredOrders();
      const l = mapLayerToggles;
      // La ruta que acaba de calcular "Planificar recorrido" (si la hay) se
      // dibuja además de las rutas de transporte normales, bien destacada.
      const rutasAMostrar = toLeafletRoutes(ctx.routesToShow || []);
      if (mapRouteResult && Array.isArray(mapRouteResult.path) && mapRouteResult.path.length > 1) {
        rutasAMostrar.push({
          id: "plan-recorrido",
          points: mapRouteResult.path.map((p) => [p.lat, p.lng]),
          color: "#C9142B",
          popupHtml: `<div class="map-popup"><div class="map-popup-title">Recorrido planificado</div><div class="map-popup-row"><span>Distancia</span><b>${esc(mapRouteResult.distanceText || "")}</b></div><div class="map-popup-row"><span>Tiempo estimado</span><b>${esc(mapRouteResult.durationText || "")}</b></div></div>`,
        });
      }
      mountLogisticsMap("mapa-geo", {
        layers: {
          pedidos: { markers: ctx.pedidosMarkers || [], cluster: true, visible: l.pedidos },
          vehiculos: { markers: ctx.vehiculosMarkers || [], cluster: false, visible: l.vehiculos },
          transportistas: { markers: [...(ctx.transportistasMarkers || []), ...(ctx.rutaCoberturaMarkers || [])], cluster: false, visible: l.transportistas },
          nodos: { markers: ctx.nodosMarkers || [], cluster: false, visible: l.nodos },
          clientes: { markers: ctx.clientesMarkers || [], cluster: true, visible: l.clientes },
          proveedores: { markers: ctx.proveedoresMarkers || [], cluster: false, visible: l.proveedores },
          incidencias: { markers: ctx.incidenciasMarkers || [], cluster: false, visible: l.incidencias },
        },
        routes: rutasAMostrar,
        routesVisible: l.rutas || !!mapRouteResult,
        circles,
        heat: { visible: l.heat, points: l.heat ? buildHeatPoints(orders, mapHeatVariable) : [] },
        fitBounds: forceFit,
        selectedId: mapSelection?.id,
      });
    }
  }
  if (document.getElementById("mapa-mini")) mountMap("mapa-mini", toLeafletMarkers(miniMapMarkers), { scrollWheelZoom: false });
  if (document.getElementById("mapa-ubicaciones")) mountMap("mapa-ubicaciones", toLeafletMarkers(ubicacionesMapMarkers));
  if (document.getElementById("mapa-transporte")) mountMap("mapa-transporte", routeOriginMarkers(transporteMapRoutes), { routes: toLeafletRoutes(transporteMapRoutes), scrollWheelZoom: false });
}

/* ---------------------------------------------------------------------------
   11. FILTROS DE FECHA (reutilizable)
   ------------------------------------------------------------------------- */
const DATE_FILTERS = [
  { key: "todos", label: "Todas" }, { key: "hoy", label: "Hoy" }, { key: "manana", label: "Mañana" }, { key: "pasado", label: "Pasado mañana" }, { key: "ayer", label: "Ayer" },
  { key: "semana", label: "Esta semana" }, { key: "prox_semana", label: "Próx. semana" },
  { key: "mes", label: "Este mes" }, { key: "mes_ant", label: "Mes anterior" },
];
function inDateFilter(dateStr, key) {
  if (key === "todos" || !dateStr) return true;
  const d = parseDate(dateStr), t = parseDate(todayISO());
  const diffDays = Math.round((d - t) / 86400000);
  const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  if (key === "hoy") return diffDays === 0;
  if (key === "manana") return diffDays === 1;
  if (key === "pasado") return diffDays === 2;
  if (key === "ayer") return diffDays === -1;
  if (key === "semana") return diffDays >= -t.getDay() && diffDays < 7 - t.getDay();
  if (key === "prox_semana") return diffDays >= 7 - t.getDay() && diffDays < 14 - t.getDay();
  if (key === "mes") return sameMonth(d, t);
  if (key === "mes_ant") { const m = new Date(t.getFullYear(), t.getMonth() - 1, 1); return sameMonth(d, m); }
  return true;
}

/* ---------------------------------------------------------------------------
   12. VISTA: PEDIDOS
   ------------------------------------------------------------------------- */
let pedidosFilter = { status: "todos", date: "todos", q: "" };

function orderCard(o) {
  const u = orderUrgency(o);
  return `<a href="#/pedidos/${o.id}" class="order-card">
    <div class="order-card-top">
      <span class="order-num">#${esc(o.number)}</span>
      ${priorityBadge(o.priority)}
    </div>
    <div class="order-card-customer">${esc(o.customerName)}</div>
    <div class="order-card-addr">📍 ${esc(o.address)}</div>
    <div class="order-card-bottom">
      ${statusBadge(ORDER_META[o.status])}
      ${dateUrgencyBadge(u)}
    </div>
  </a>`;
}

/* ---------------------------------------------------------------------------
   IMPORTAR PEDIDOS DESDE EXCEL (archivo de envíos del operador logístico,
   hoja con columnas "Destinatario - …", "Cliente", "Seguimiento", etc. — el
   usuario lo sube periódicamente con los envíos vigentes).
   Usa el mecanismo source/external_id que ya existía en el schema, pensado
   para integraciones externas (ver claude/arquitectura-acqua-diagnostico.md):
   "Seguimiento" (código de tracking del operador, único y estable por envío)
   es el external_id, así que volver a subir un archivo que incluye envíos ya
   importados antes ACTUALIZA esos pedidos en vez de duplicarlos. Cada corrida
   deja un registro en integration_sync_logs, y las filas que no se pueden
   importar (ej. sin "Seguimiento") quedan en integration_errors — nunca se
   ocultan ni se descartan en silencio.
   ------------------------------------------------------------------------- */
const IMPORT_ORDERS_SOURCE = "excel_envios";
let importOrdersParsed = null; // { rows, errors, fileName } luego de elegir el archivo
let importOrdersRunning = false;

/** Normaliza las claves de una fila ya parseada por SheetJS (sin tildes,
 * minúsculas, espacios colapsados) para tolerar pequeñas variaciones del
 * header del Excel entre una exportación y otra. */
function importOrdersNormalizeRow(r) {
  const map = {};
  Object.keys(r).forEach((k) => { map[stripAccentsLower(k).replace(/\s+/g, " ")] = r[k]; });
  return map;
}
function importOrdersReadCell(normRow, key) {
  const v = normRow[stripAccentsLower(key).replace(/\s+/g, " ")];
  return v === undefined || v === null ? "" : String(v).trim();
}

/** Convierte las filas crudas del Excel al formato que necesita la
 * importación. No inventa nada: una fila sin "Seguimiento" (el external_id
 * que evita duplicar en el próximo archivo) se marca como error y no se
 * importa — nada se fuerza a entrar sin esa clave. */
function parseImportOrdersRows(rawRows) {
  const rows = [];
  const errors = [];
  rawRows.forEach((raw, i) => {
    const r = importOrdersNormalizeRow(raw);
    const fila = i + 2; // fila 1 = header
    const externalId = importOrdersReadCell(r, "Seguimiento");
    if (!externalId) { errors.push({ fila, message: "Sin 'Seguimiento' (código único de envío) — no se puede importar sin arriesgar duplicarlo en el próximo archivo." }); return; }
    const calle = importOrdersReadCell(r, "Destinatario - Calle");
    const numero = importOrdersReadCell(r, "Destinatario - Número");
    const piso = importOrdersReadCell(r, "Destinatario - Piso");
    const depto = importOrdersReadCell(r, "Destinatario - Depto.");
    const cp = importOrdersReadCell(r, "Destinatario - Código Postal");
    const localidad = importOrdersReadCell(r, "Destinatario - Localidad");
    const provincia = importOrdersReadCell(r, "Destinatario - Provincia");
    const apellido = importOrdersReadCell(r, "Destinatario - Apellido");
    const nombre = importOrdersReadCell(r, "Destinatario - Nombre");
    const pisoDepto = [piso && `Piso ${piso}`, depto && `Depto ${depto}`].filter(Boolean).join(", ");
    const addressLine = ([calle, numero].filter(Boolean).join(" ") + (pisoDepto ? ` (${pisoDepto})` : "")).trim();
    const clienteInformado = importOrdersReadCell(r, "Cliente");
    const destinatario = [apellido, nombre].filter(Boolean).join(", ");
    rows.push({
      fila, externalId,
      clienteName: clienteInformado || destinatario || "Cliente sin identificar",
      clienteEsFallback: !clienteInformado,
      destinatario, telefono: importOrdersReadCell(r, "Destinatario - Teléfono"),
      addressLine, cp, localidad, provincia,
      cantidad: importOrdersReadCell(r, "Paquete - Cantidad"),
      peso: importOrdersReadCell(r, "Paquete - Peso [kg]"),
      valorAsegurado: importOrdersReadCell(r, "Valor Asegurado"),
      remito: importOrdersReadCell(r, "Número de Remito"),
      contenido: importOrdersReadCell(r, "Código de Orden de Compra"),
      observaciones: importOrdersReadCell(r, "Observaciones"),
      estado: importOrdersReadCell(r, "Estado"),
      fechaDespacho: importOrdersReadCell(r, "Fecha de despacho"),
    });
  });
  return { rows, errors };
}

function buildImportOrdersPreview(rows) {
  const existingByExtId = new Set(state.orders.filter((o) => o.source === IMPORT_ORDERS_SOURCE && o.externalId).map((o) => o.externalId));
  const existingCustomerNames = new Set(state.customers.map((c) => stripAccentsLower(c.name)));
  let nuevos = 0, actualizados = 0, sinCliente = 0;
  const clientesNuevos = new Set();
  rows.forEach((r) => {
    if (existingByExtId.has(r.externalId)) actualizados++; else nuevos++;
    if (r.clienteEsFallback) sinCliente++;
    if (!existingCustomerNames.has(stripAccentsLower(r.clienteName))) clientesNuevos.add(stripAccentsLower(r.clienteName));
  });
  return { total: rows.length, nuevos, actualizados, sinCliente, clientesNuevosCount: clientesNuevos.size };
}

function importOrdersPreviewHTML(stats, errors, fileName) {
  return `
    <div class="stat-row wrap">
      <div class="stat-box"><b>${stats.total}</b><span>Envíos leídos</span></div>
      <div class="stat-box"><b>${stats.nuevos}</b><span>Pedidos nuevos</span></div>
      <div class="stat-box"><b>${stats.actualizados}</b><span>Pedidos a actualizar</span></div>
      <div class="stat-box"><b>${stats.clientesNuevosCount}</b><span>Clientes nuevos</span></div>
    </div>
    ${stats.sinCliente ? `<div class="hint" style="margin-top:8px">${stats.sinCliente} envío(s) sin "Cliente" informado en el Excel — se usa el nombre del destinatario.</div>` : ""}
    ${errors.length ? `<div class="hint" style="margin-top:8px;color:var(--danger)">${errors.length} fila(s) no se van a importar — ${errors.slice(0, 5).map((e) => `fila ${e.fila} (${esc(e.message)})`).join("; ")}${errors.length > 5 ? "…" : ""}</div>` : ""}
    <div class="hint" style="margin-top:8px">Archivo: ${esc(fileName)}</div>
  `;
}

/** Ejecuta la importación: por cada fila matchea (o crea) cliente y
 * ubicación de entrega — geocodificando direcciones nuevas —, y crea o
 * actualiza el pedido según si ya existía un pedido con ese external_id. Al
 * actualizar un pedido existente NUNCA pisa `status`/`history` (el estado
 * logístico real, que puede ya estar avanzado en la app) — sólo refresca
 * datos de contacto/dirección/contenido y guarda el estado del operador en
 * `commercialStatus`, aparte, tal como está pensado el campo. */
async function runImportOrders(rows, fileName) {
  const startedAt = nowISO();
  let created = 0, updated = 0, failed = 0;
  const errorRows = [];
  const locKeyOf = (addressLine, city, province) => stripAccentsLower([addressLine, city, province].filter(Boolean).join(", "));
  const locationByKey = new Map(state.locations.map((l) => [locKeyOf(l.address, l.city, l.province), l]));

  for (const r of rows) {
    try {
      const existing = state.orders.find((o) => o.source === IMPORT_ORDERS_SOURCE && o.externalId === r.externalId);
      let customer = state.customers.find((c) => stripAccentsLower(c.name) === stripAccentsLower(r.clienteName));

      const lkey = locKeyOf(r.addressLine, r.localidad, r.provincia);
      let loc = locationByKey.get(lkey);
      if (!loc) {
        let lat = null, lng = null;
        const query = [r.addressLine, r.localidad, r.provincia, "Argentina"].filter(Boolean).join(", ");
        const geo = await geocodeAddress(query);
        if (geo[0]) { lat = geo[0].lat; lng = geo[0].lng; }
        loc = { id: uid("loc"), type: "cliente", name: r.clienteName, address: r.addressLine, city: r.localidad, province: r.provincia, lat, lng, contact: r.destinatario, phone: r.telefono, notes: r.cp ? `CP ${r.cp}` : "" };
        await persist("locations", loc);
        locationByKey.set(lkey, loc);
      }
      if (!customer) {
        customer = { id: uid("cus"), name: r.clienteName, phone: r.telefono || "", locationId: loc.id, notes: r.clienteEsFallback ? `Cliente no informado en el Excel de envíos — se usó el destinatario "${r.destinatario}".` : "" };
        await persist("customers", customer);
      }

      const items = [{ product: r.contenido || "Envío sin descripción", qty: parseInt(r.cantidad, 10) || 1 }];
      const notesParts = [];
      if (r.observaciones) notesParts.push(`Obs.: ${r.observaciones}`);
      if (r.peso) notesParts.push(`Peso: ${r.peso} kg`);
      if (r.valorAsegurado) notesParts.push(`Valor asegurado: $${r.valorAsegurado}`);
      if (r.remito) notesParts.push(`Remito: ${r.remito}`);
      notesParts.push(`Importado de "${fileName}" el ${todayISO()} (seguimiento ${r.externalId}).`);
      const notes = notesParts.join(" | ");

      if (existing) {
        const rec = { ...existing,
          customerId: customer.id, customerName: customer.name, phone: r.telefono || existing.phone,
          address: r.addressLine || existing.address, locationId: loc.id,
          expectedDate: r.fechaDespacho || existing.expectedDate,
          items, notes, commercialStatus: r.estado || existing.commercialStatus,
        };
        await persist("orders", rec);
        updated++;
      } else {
        const rec = {
          id: uid("ord"), number: r.externalId, customerId: customer.id, customerName: customer.name,
          phone: r.telefono || "", address: r.addressLine, locationId: loc.id,
          orderDate: todayISO(), expectedDate: r.fechaDespacho || "", expectedTime: "",
          priority: "media", items, notes, status: "pendiente", transportId: null,
          dispatchDate: null, actualDeliveryDate: null, incidentId: null,
          history: [{ from: null, to: "pendiente", date: nowISO() }],
          source: IMPORT_ORDERS_SOURCE, externalId: r.externalId, commercialStatus: r.estado || null,
        };
        await persist("orders", rec);
        created++;
      }
    } catch (err) {
      failed++;
      errorRows.push({ id: uid("ierr"), syncLogId: null, source: IMPORT_ORDERS_SOURCE, entity: "order", externalId: r.externalId, field: null, message: String(err?.message || err), attempts: 1, status: "error" });
    }
  }

  const log = {
    id: uid("isl"), source: IMPORT_ORDERS_SOURCE, startedAt, finishedAt: nowISO(), status: failed ? "completed_with_errors" : "completed",
    recordsReceived: rows.length, recordsCreated: created, recordsUpdated: updated, recordsUnchanged: 0, recordsFailed: failed,
    notes: `Archivo: ${fileName}`,
  };
  await persist("integration_sync_logs", log);
  for (const er of errorRows) { er.syncLogId = log.id; await persist("integration_errors", er); }

  return { created, updated, failed, total: rows.length };
}

function viewPedidos() {
  const statuses = ["todos", ...ORDER_FLOW, "incidencia", "cancelado"];
  let list = state.orders.filter((o) => (pedidosFilter.status === "todos" || o.status === pedidosFilter.status) && inDateFilter(o.expectedDate, pedidosFilter.date));
  if (pedidosFilter.q) {
    const q = pedidosFilter.q.toLowerCase();
    list = list.filter((o) => o.number.includes(q) || o.customerName.toLowerCase().includes(q));
  }
  list = [...list].sort((a, b) => (a.expectedDate || "9999").localeCompare(b.expectedDate || "9999"));
  return `
  <div class="view-list">
    <div class="list-toolbar">
      <input type="text" id="pedidos-q" placeholder="Buscar por número o cliente…" value="${esc(pedidosFilter.q)}" class="input" />
      <button type="button" class="btn btn-secondary" data-action="open-modal" data-modal="import-orders">📥 Importar desde Excel</button>
      <a href="#/pedidos/nuevo" class="btn btn-primary">+ Nuevo pedido</a>
    </div>
    <div class="chip-row">${statuses.map((s) => `<button class="chip ${pedidosFilter.status === s ? "active" : ""}" data-pedidos-status="${s}">${s === "todos" ? "Todos" : (ORDER_META[s]?.label || s)}</button>`).join("")}</div>
    <div class="chip-row">${DATE_FILTERS.map((f) => `<button class="chip chip-ghost ${pedidosFilter.date === f.key ? "active" : ""}" data-pedidos-date="${f.key}">${f.label}</button>`).join("")}</div>
    ${list.length ? `<div class="card-grid">${list.map(orderCard).join("")}</div>` :
      emptyState("📦", "Sin pedidos", "No hay pedidos que coincidan con el filtro actual.", `<a href="#/pedidos/nuevo" class="btn btn-primary">+ Nuevo pedido</a>`)}
  </div>`;
}

function orderDetail(id) {
  const o = getById("orders", id);
  if (!o) return emptyState("📦", "Pedido no encontrado", "Puede haber sido eliminado.");
  const u = orderUrgency(o);
  const nextStatus = ORDER_FLOW[ORDER_FLOW.indexOf(o.status) + 1];
  const loc = getById("locations", o.locationId);
  const transport = getById("transports", o.transportId);
  const incident = o.incidentId ? getById("incidents", o.incidentId) : null;
  return `
  <div class="detail-view">
    <div class="detail-head">
      <div>
        <a href="#/pedidos" class="back-link">← Pedidos</a>
        <h2>PEDIDO #${esc(o.number)}</h2>
        <div class="detail-sub">${esc(o.customerName)} · ${priorityBadge(o.priority)}</div>
      </div>
      <div class="detail-actions">
        ${o.status !== "entregado" && o.status !== "cancelado" ? `<button class="btn btn-secondary" data-action="order-incident" data-id="${o.id}">⚠️ Registrar incidencia</button>` : ""}
        ${nextStatus ? `<button class="btn btn-primary" data-action="order-advance" data-id="${o.id}">Avanzar a: ${ORDER_META[nextStatus].label} →</button>` : ""}
        <button class="btn btn-ghost" data-action="order-edit" data-id="${o.id}">Editar</button>
      </div>
    </div>

    <div class="detail-grid">
      <div class="panel">
        <div class="panel-head"><h3>Progreso</h3>${statusBadge(ORDER_META[o.status])}</div>
        ${progressBar(ORDER_FLOW, ORDER_META, o.status)}
        <div class="status-select-row">
          <label>Cambiar estado manualmente</label>
          <select class="input" data-action="order-set-status" data-id="${o.id}">
            ${[...ORDER_FLOW, "incidencia", "cancelado"].map((s) => `<option value="${s}" ${o.status === s ? "selected" : ""}>${ORDER_META[s].label}</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Datos del pedido</h3></div>
        <div class="kv"><span>Cliente</span><b>${esc(o.customerName)}</b></div>
        ${o.source && o.source !== "manual" ? `<div class="kv"><span>Seguimiento</span><b>${esc(o.externalId || "—")}</b></div>` : ""}
        ${o.commercialStatus ? `<div class="kv"><span>Estado en origen</span><b>${esc(o.commercialStatus)}</b></div>` : ""}
        <div class="kv"><span>Teléfono</span><b>${esc(o.phone || "—")}</b></div>
        <div class="kv"><span>Domicilio</span><b>${esc(o.address)}</b></div>
        <div class="kv"><span>Ubicación</span><b>${esc(loc ? `${loc.city}, ${loc.province}` : "—")}</b></div>
        <div class="kv"><span>Fecha de pedido</span><b>${fmtDate(o.orderDate)}</b></div>
        <div class="kv"><span>Entrega prevista</span><b>${fmtDate(o.expectedDate)} ${o.expectedTime ? `· ${o.expectedTime}` : ""}</b></div>
        <div class="kv"><span>Urgencia</span>${dateUrgencyBadge(u)}</div>
        <div class="kv"><span>Transporte</span><b>${esc(transport ? transport.name : "—")}</b></div>
        <div class="kv"><span>Despacho</span><b>${o.dispatchDate ? fmtDateTime(o.dispatchDate) : "—"}</b></div>
        <div class="kv"><span>Entrega real</span><b>${o.actualDeliveryDate ? fmtDate(o.actualDeliveryDate) : "—"}</b></div>
        ${incident ? `<div class="kv"><span>Incidencia</span><a href="#/incidencias/${incident.id}" class="link-more">${esc(incident.title)}</a></div>` : ""}
        ${o.notes ? `<div class="kv-notes"><span>Observaciones</span><p>${esc(o.notes)}</p></div>` : ""}
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Productos</h3></div>
        <table class="mini-table"><thead><tr><th>Producto</th><th>Cantidad</th></tr></thead>
          <tbody>${o.items.map((it) => `<tr><td>${esc(it.product)}</td><td>${it.qty}</td></tr>`).join("")}</tbody>
        </table>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Historial</h3></div>
        ${o.history.length ? `<div class="hist-timeline">${[...o.history].reverse().map((h) => `
          <div class="hist-item">
            <div class="hist-dot"></div>
            <div>
              <div class="hist-date">${fmtDateTime(h.date)}</div>
              <div class="hist-text">${h.from ? `${ORDER_META[h.from]?.label || h.from} → ` : ""}<b>${ORDER_META[h.to]?.label || h.to}</b></div>
              ${h.note ? `<div class="hist-note">${esc(h.note)}</div>` : ""}
            </div>
          </div>`).join("")}</div>` : emptyState("🕒", "Sin historial", "")}
      </div>
    </div>
  </div>`;
}

function orderForm(id) {
  const o = id ? getById("orders", id) : null;
  const customers = state.customers;
  const transports = state.transports;
  const nextNum = String(1527 + state.orders.length + 1);
  if (!customers.length) {
    return `<div class="detail-view">
      <div class="detail-head"><div><a href="#/pedidos" class="back-link">← Pedidos</a><h2>Nuevo pedido</h2></div></div>
      ${emptyState("📍", "Primero cargá un cliente", "Un pedido necesita un cliente con ubicación. Cargalo desde Ubicaciones y volvé acá.", `<a href="#/ubicaciones" class="btn btn-primary">Ir a Ubicaciones</a>`)}
    </div>`;
  }
  return `
  <div class="detail-view">
    <div class="detail-head">
      <div><a href="#/pedidos${o ? "/" + o.id : ""}" class="back-link">← ${o ? "Volver al pedido" : "Pedidos"}</a><h2>${o ? `Editar pedido #${esc(o.number)}` : "Nuevo pedido"}</h2></div>
    </div>
    <form class="panel form-panel" data-form="order" data-id="${o ? o.id : ""}">
      <div class="form-grid">
        <label>Número<input class="input" name="number" value="${esc(o ? o.number : nextNum)}" required /></label>
        <label>Cliente<select class="input" name="customerId" required>
          <option value="">Seleccionar…</option>
          ${customers.map((c) => `<option value="${c.id}" ${o && o.customerId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select></label>
        <label>Teléfono (opcional)<input class="input" name="phone" value="${esc(o?.phone || "")}" /></label>
        <label>Prioridad<select class="input" name="priority">
          ${Object.keys(PRIORITY_META).map((p) => `<option value="${p}" ${o && o.priority === p ? "selected" : (!o && p === "media" ? "selected" : "")}>${PRIORITY_META[p].label}</option>`).join("")}
        </select></label>
        <label class="span2">Domicilio de entrega<input class="input" name="address" value="${esc(o?.address || "")}" required placeholder="Buscar o escribir la dirección" /></label>
        <label>Fecha de pedido<input class="input" type="date" name="orderDate" value="${o?.orderDate || todayISO()}" required /></label>
        <label>Fecha prevista de entrega<input class="input" type="date" name="expectedDate" value="${o?.expectedDate || ""}" required /></label>
        <label>Hora prevista (opcional)<input class="input" type="time" name="expectedTime" value="${o?.expectedTime || ""}" /></label>
        <label>Transporte<select class="input" name="transportId">
          <option value="">Sin asignar</option>
          ${transports.map((t) => `<option value="${t.id}" ${o && o.transportId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
        </select></label>
        <label class="span2">Productos <span class="hint">(uno por línea: producto, cantidad)</span>
          <textarea class="input" name="itemsText" rows="3" placeholder="Perfil de aluminio 6m, 40">${o ? o.items.map((i) => `${i.product}, ${i.qty}`).join("\n") : ""}</textarea>
        </label>
        <label class="span2">Observaciones<textarea class="input" name="notes" rows="2">${esc(o?.notes || "")}</textarea></label>
      </div>
      <div class="form-actions">
        <a href="#/pedidos${o ? "/" + o.id : ""}" class="btn btn-ghost">Cancelar</a>
        <button type="submit" class="btn btn-primary">${o ? "Guardar cambios" : "Crear pedido"}</button>
      </div>
    </form>
  </div>`;
}

/* ---------------------------------------------------------------------------
   13. VISTA: ÓRDENES DE COMPRA
   ------------------------------------------------------------------------- */
let comprasFilter = { status: "todos", date: "todos", q: "" };

function poCard(p) {
  const u = poUrgency(p);
  return `<a href="#/compras/${p.id}" class="order-card">
    <div class="order-card-top"><span class="order-num">OC #${esc(p.number)}</span></div>
    <div class="order-card-customer">${esc(p.supplierName)}</div>
    <div class="order-card-addr">📍 ${esc(p.supplierAddress || "")}</div>
    <div class="order-card-bottom">${statusBadge(PO_META[p.status])}<span class="badge ${u.cls}">${esc(u.label)}</span></div>
  </a>`;
}

function viewCompras() {
  const statuses = ["todos", ...PO_FLOW, "incidencia"];
  let list = state.purchase_orders.filter((p) => (comprasFilter.status === "todos" || p.status === comprasFilter.status) && inDateFilter(p.expectedArrival, comprasFilter.date));
  if (comprasFilter.q) { const q = comprasFilter.q.toLowerCase(); list = list.filter((p) => p.number.includes(q) || p.supplierName.toLowerCase().includes(q)); }
  list = [...list].sort((a, b) => (a.expectedArrival || "9999").localeCompare(b.expectedArrival || "9999"));
  return `
  <div class="view-list">
    <div class="list-toolbar">
      <input type="text" id="compras-q" placeholder="Buscar por número o proveedor…" value="${esc(comprasFilter.q)}" class="input" />
      <a href="#/compras/nueva" class="btn btn-primary">+ Nueva OC</a>
    </div>
    <div class="chip-row">${statuses.map((s) => `<button class="chip ${comprasFilter.status === s ? "active" : ""}" data-compras-status="${s}">${s === "todos" ? "Todos" : PO_META[s].label}</button>`).join("")}</div>
    <div class="chip-row">${DATE_FILTERS.map((f) => `<button class="chip chip-ghost ${comprasFilter.date === f.key ? "active" : ""}" data-compras-date="${f.key}">${f.label}</button>`).join("")}</div>
    ${list.length ? `<div class="card-grid">${list.map(poCard).join("")}</div>` : emptyState("🛒", "Sin órdenes de compra", "No hay OC que coincidan con el filtro actual.", `<a href="#/compras/nueva" class="btn btn-primary">+ Nueva OC</a>`)}
  </div>`;
}

function poDetail(id) {
  const p = getById("purchase_orders", id);
  if (!p) return emptyState("🛒", "OC no encontrada", "");
  const u = poUrgency(p);
  const nextStatus = PO_FLOW[PO_FLOW.indexOf(p.status) + 1];
  const transport = getById("transports", p.transportId);
  const supplier = getById("suppliers", p.supplierId);
  return `
  <div class="detail-view">
    <div class="detail-head">
      <div><a href="#/compras" class="back-link">← Órdenes de compra</a><h2>OC #${esc(p.number)}</h2><div class="detail-sub">${esc(p.supplierName)}</div></div>
      <div class="detail-actions">
        ${!["cerrada"].includes(p.status) ? `<button class="btn btn-secondary" data-action="po-incident" data-id="${p.id}">⚠️ Registrar incidencia</button>` : ""}
        ${nextStatus ? `<button class="btn btn-primary" data-action="po-advance" data-id="${p.id}">Avanzar a: ${PO_META[nextStatus].label} →</button>` : ""}
        <button class="btn btn-ghost" data-action="po-edit" data-id="${p.id}">Editar</button>
      </div>
    </div>
    <div class="detail-grid">
      <div class="panel">
        <div class="panel-head"><h3>Progreso</h3>${statusBadge(PO_META[p.status])}</div>
        ${progressBar(PO_FLOW, PO_META, p.status)}
        <div class="status-select-row">
          <label>Cambiar estado manualmente</label>
          <select class="input" data-action="po-set-status" data-id="${p.id}">
            ${[...PO_FLOW, "incidencia"].map((s) => `<option value="${s}" ${p.status === s ? "selected" : ""}>${PO_META[s].label}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Datos de la orden</h3></div>
        <div class="kv"><span>Proveedor</span><b>${supplier ? `<a href="#/proveedores/${supplier.id}" class="link-more">${esc(supplier.name)}</a>` : esc(p.supplierName)}</b></div>
        <div class="kv"><span>Origen</span><b>${esc(p.supplierAddress || "—")}</b></div>
        <div class="kv"><span>Destino</span><b>${esc(p.destination || "—")}</b></div>
        <div class="kv"><span>Emisión</span><b>${fmtDate(p.issueDate)}</b></div>
        <div class="kv"><span>Despacho previsto</span><b>${fmtDate(p.expectedDispatch)}</b></div>
        <div class="kv"><span>Llegada prevista</span><b>${fmtDate(p.expectedArrival)}</b></div>
        <div class="kv"><span>Llegada real</span><b>${p.actualArrival ? fmtDate(p.actualArrival) : "—"}</b></div>
        <div class="kv"><span>Urgencia</span><span class="badge ${u.cls}">${esc(u.label)}</span></div>
        <div class="kv"><span>Transporte</span><b>${esc(transport ? transport.name : "—")}</b></div>
        ${p.notes ? `<div class="kv-notes"><span>Observaciones</span><p>${esc(p.notes)}</p></div>` : ""}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Productos</h3></div>
        <table class="mini-table"><thead><tr><th>Producto</th><th>Cantidad</th></tr></thead>
          <tbody>${p.items.map((it) => `<tr><td>${esc(it.product)}</td><td>${it.qty}</td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Historial</h3></div>
        ${p.history.length ? `<div class="hist-timeline">${[...p.history].reverse().map((h) => `
          <div class="hist-item"><div class="hist-dot"></div><div>
            <div class="hist-date">${fmtDateTime(h.date)}</div>
            <div class="hist-text">${h.from ? `${PO_META[h.from]?.label || h.from} → ` : ""}<b>${PO_META[h.to]?.label || h.to}</b></div>
            ${h.note ? `<div class="hist-note">${esc(h.note)}</div>` : ""}
          </div></div>`).join("")}</div>` : emptyState("🕒", "Sin historial", "")}
      </div>
    </div>
  </div>`;
}

function poForm(id) {
  const p = id ? getById("purchase_orders", id) : null;
  const suppliers = state.suppliers;
  const transports = state.transports;
  const nextNum = String(4586 + state.purchase_orders.length + 1);
  if (!suppliers.length) {
    return `<div class="detail-view">
      <div class="detail-head"><div><a href="#/compras" class="back-link">← Órdenes de compra</a><h2>Nueva orden de compra</h2></div></div>
      ${emptyState("🏭", "Primero cargá un proveedor", "Una OC necesita un proveedor con ubicación. Cargalo desde Proveedores y volvé acá.", `<a href="#/proveedores" class="btn btn-primary">Ir a Proveedores</a>`)}
    </div>`;
  }
  return `
  <div class="detail-view">
    <div class="detail-head"><div><a href="#/compras${p ? "/" + p.id : ""}" class="back-link">← ${p ? "Volver a la OC" : "Órdenes de compra"}</a><h2>${p ? `Editar OC #${esc(p.number)}` : "Nueva orden de compra"}</h2></div></div>
    <form class="panel form-panel" data-form="po" data-id="${p ? p.id : ""}">
      <div class="form-grid">
        <label>Número<input class="input" name="number" value="${esc(p ? p.number : nextNum)}" required /></label>
        <label>Proveedor<select class="input" name="supplierId" required>
          <option value="">Seleccionar…</option>
          ${suppliers.map((s) => `<option value="${s.id}" ${p && p.supplierId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
        </select></label>
        <label>Destino<input class="input" name="destination" value="${esc(p?.destination || "Depósito Central Perona")}" /></label>
        <label>Transporte<select class="input" name="transportId">
          <option value="">Sin asignar</option>
          ${transports.map((t) => `<option value="${t.id}" ${p && p.transportId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
        </select></label>
        <label>Fecha de emisión<input class="input" type="date" name="issueDate" value="${p?.issueDate || todayISO()}" required /></label>
        <label>Despacho previsto<input class="input" type="date" name="expectedDispatch" value="${p?.expectedDispatch || ""}" /></label>
        <label>Llegada prevista<input class="input" type="date" name="expectedArrival" value="${p?.expectedArrival || ""}" required /></label>
        <label class="span2">Productos <span class="hint">(uno por línea: producto, cantidad)</span>
          <textarea class="input" name="itemsText" rows="3">${p ? p.items.map((i) => `${i.product}, ${i.qty}`).join("\n") : ""}</textarea>
        </label>
        <label class="span2">Observaciones<textarea class="input" name="notes" rows="2">${esc(p?.notes || "")}</textarea></label>
      </div>
      <div class="form-actions">
        <a href="#/compras${p ? "/" + p.id : ""}" class="btn btn-ghost">Cancelar</a>
        <button type="submit" class="btn btn-primary">${p ? "Guardar cambios" : "Crear OC"}</button>
      </div>
    </form>
  </div>`;
}

/* ---------------------------------------------------------------------------
   14. PROVEEDORES / TRANSPORTE / UBICACIONES
   ------------------------------------------------------------------------- */
function viewProveedorDetail(id) {
  const s = getById("suppliers", id);
  if (!s) return emptyState("🏭", "Proveedor no encontrado", "");
  const loc = getById("locations", s.locationId);
  const pos = state.purchase_orders.filter((p) => p.supplierId === id);
  const pending = pos.filter((p) => !["recibida", "controlada", "cerrada"].includes(p.status));
  const transit = pos.filter((p) => p.status === "en_transito");
  const received = pos.filter((p) => ["recibida", "controlada", "cerrada"].includes(p.status));
  const incidents = state.incidents.filter((i) => (i.relatedType === "purchase_order" && pos.some((p) => p.id === i.relatedId)) || (i.relatedType === "supplier" && i.relatedId === id));
  return `
  <div class="detail-view">
    <div class="detail-head"><div><a href="#/proveedores" class="back-link">← Proveedores</a><h2>${esc(s.name)}</h2><div class="detail-sub">${esc(loc ? loc.city + ", " + loc.province : "")}</div></div>
    ${loc ? `<div class="detail-actions"><button class="btn btn-ghost" data-action="open-modal" data-modal="location" data-id="${loc.id}">Editar</button></div>` : ""}</div>
    <div class="detail-grid">
      <div class="panel">
        <div class="panel-head"><h3>Datos de contacto</h3></div>
        <div class="kv"><span>Dirección</span><b>${esc(s.address || loc?.address || "—")}</b></div>
        <div class="kv"><span>Contacto</span><b>${esc(s.contact || "—")}</b></div>
        <div class="kv"><span>Teléfono</span><b>${esc(s.phone || "—")}</b></div>
        <div class="kv"><span>Email</span><b>${esc(s.email || "—")}</b></div>
        ${s.notes ? `<div class="kv-notes"><span>Observaciones</span><p>${esc(s.notes)}</p></div>` : ""}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Resumen de compras</h3></div>
        <div class="stat-row"><div class="stat-box"><b>${pos.length}</b><span>OC realizadas</span></div><div class="stat-box"><b>${pending.length}</b><span>Pendientes</span></div><div class="stat-box"><b>${transit.length}</b><span>En tránsito</span></div><div class="stat-box"><b>${received.length}</b><span>Recibidas</span></div></div>
      </div>
      <div class="panel span2">
        <div class="panel-head"><h3>Órdenes de compra</h3></div>
        ${pos.length ? `<div class="card-grid">${pos.map(poCard).join("")}</div>` : emptyState("🛒", "Sin órdenes", "")}
      </div>
      ${incidents.length ? `<div class="panel span2"><div class="panel-head"><h3>Incidencias</h3></div><div class="card-grid">${incidents.map(incidentCard).join("")}</div></div>` : ""}
    </div>
  </div>`;
}

function routeRow(r) {
  const origin = [r.originCity, r.originProvince].filter(Boolean).join(", ") || "—";
  const dest = [r.destinationCity, r.destinationProvince].filter(Boolean).join(", ") || null;
  return `<div class="route-row">
    <span class="route-row-code">${esc(r.code || "")}</span>
    <span class="route-row-path"><b>${esc(origin)}</b> <i class="route-arrow">→</i> ${dest ? `<b>${esc(dest)}</b>` : `<span class="muted-title" style="text-transform:none">${esc(r.label || "cobertura extendida")}</span>`}</span>
  </div>`;
}

function viewTransporteDetail(id) {
  const t = getById("transports", id);
  if (!t) return emptyState("🚚", "Transporte no encontrado", "");
  const orders = state.orders.filter((o) => o.transportId === id);
  const pos = state.purchase_orders.filter((p) => p.transportId === id);
  const incidents = state.incidents.filter((i) => i.relatedType === "transport" && i.relatedId === id);
  const routes = state.routes.filter((r) => r.transportId === id);
  const rate = transportRate(id);
  transporteMapRoutes = routes;
  const location = [t.city, t.province].filter(Boolean).join(", ");
  return `
  <div class="detail-view">
    <div class="detail-head"><div><a href="#/transporte" class="back-link">← Transportes</a><h2>${esc(t.name)}${t.code ? ` <span class="topbar-code" style="position:static;">${esc(t.code)}</span>` : ""}</h2><div class="detail-sub">${esc(t.type || "")}${location ? " · " + esc(location) : ""}</div></div>
    <div class="detail-actions"><button class="btn btn-ghost" data-action="open-modal" data-modal="transport" data-id="${t.id}">Editar</button></div></div>
    <div class="detail-grid">
      <div class="panel">
        <div class="panel-head"><h3>Costo de transporte</h3><button type="button" class="btn btn-ghost btn-sm" data-action="open-modal" data-modal="exp-rate" data-id="${t.id}">${rate ? "Editar tarifa" : "Configurar tarifa"}</button></div>
        ${rate ? `
        <div class="kv"><span>Monto fijo</span><b>${fmtMoney(rate.fixedAmount)}</b></div>
        <div class="kv"><span>Por km</span><b>${fmtMoney(rate.perKm)}</b></div>
        <div class="kv"><span>Por caja</span><b>${fmtMoney(rate.perBox)}</b></div>
        <div class="kv"><span>Por kg</span><b>${fmtMoney(rate.perKg)}</b></div>
        <div class="kv"><span>% del valor del pedido</span><b>${rate.percent || 0}%</b></div>
        ${rate.notes ? `<div class="kv-notes"><span>Observaciones</span><p>${esc(rate.notes)}</p></div>` : ""}
        ` : `<div class="hint">Sin tarifa configurada todavía — se usa para calcular el costo real de cada envío en Expedición.</div>`}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Datos de contacto</h3></div>
        ${t.businessName ? `<div class="kv"><span>Razón social</span><b>${esc(t.businessName)}</b></div>` : ""}
        ${t.cuit ? `<div class="kv"><span>CUIT</span><b>${esc(t.cuit)}</b></div>` : ""}
        <div class="kv"><span>Contacto</span><b>${esc(t.contact || "—")}</b></div>
        <div class="kv"><span>Teléfono</span><b>${esc(t.phone || t.mobile || "—")}</b></div>
        ${t.whatsapp ? `<div class="kv"><span>WhatsApp</span><b>${esc(t.whatsapp)}</b></div>` : ""}
        <div class="kv"><span>Email</span><b>${esc(t.email || "—")}</b></div>
        ${t.website ? `<div class="kv"><span>Sitio web</span><b><a href="${esc(t.website)}" target="_blank" rel="noopener" class="link-more">${esc(t.website.replace(/^https?:\/\//,""))}</a></b></div>` : ""}
        ${t.instagram ? `<div class="kv"><span>Instagram</span><b><a href="${esc(t.instagram)}" target="_blank" rel="noopener" class="link-more">${esc(t.instagram.replace(/^https?:\/\/(www\.)?/,""))}</a></b></div>` : ""}
        ${t.facebook ? `<div class="kv"><span>Facebook</span><b><a href="${esc(t.facebook)}" target="_blank" rel="noopener" class="link-more">${esc(t.facebook.replace(/^https?:\/\/(www\.)?/,""))}</a></b></div>` : ""}
        ${t.address ? `<div class="kv"><span>Dirección</span><b>${esc(t.address)}${location ? ", " + esc(location) : ""}</b></div>` : ""}
        <div class="kv"><span>Tipo</span><b>${esc(t.type || "—")}</b></div>
        <div class="kv"><span>Vehículos</span><b>${vehicleBadges(t) || "—"}</b></div>
        ${t.zone ? `<div class="kv-notes"><span>Zona de operación</span><p>${esc(t.zone)}</p></div>` : ""}
        ${t.originCoverage ? `<div class="kv-notes"><span>Cobertura de origen</span><p>${esc(t.originCoverage)}</p></div>` : ""}
        ${t.routeNumbers ? `<div class="kv-notes"><span>Rutas que recorre</span><p>${esc(t.routeNumbers)}</p></div>` : ""}
        ${t.deliveryTime ? `<div class="kv"><span>Tiempo de entrega</span><b>${esc(t.deliveryTime)}</b></div>` : ""}
        ${t.costReference ? `<div class="kv"><span>Costo aproximado</span><b>${esc(t.costReference)}</b></div>` : ""}
        ${t.notes ? `<div class="kv-notes"><span>Observaciones</span><p>${esc(t.notes)}</p></div>` : ""}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Resumen</h3></div>
        <div class="stat-row"><div class="stat-box"><b>${orders.length + pos.length}</b><span>Envíos</span></div><div class="stat-box"><b>${orders.filter(o=>o.status==="entregado").length}</b><span>Entregas</span></div><div class="stat-box"><b>${incidents.length}</b><span>Incidencias</span></div><div class="stat-box"><b>${routes.length}</b><span>Rutas</span></div></div>
      </div>
      ${routes.length ? `
      <div class="panel span2">
        <div class="panel-head"><h3>Rutas que recorre (${routes.length})</h3></div>
        <div class="route-list">${routes.map(routeRow).join("")}</div>
        <div id="mapa-transporte" class="leaflet-box" style="height:280px;margin-top:12px"></div>
      </div>` : ""}
      <div class="panel span2"><div class="panel-head"><h3>Pedidos transportados</h3></div>${orders.length ? `<div class="card-grid">${orders.map(orderCard).join("")}</div>` : emptyState("📦","Sin pedidos","")}</div>
      <div class="panel span2"><div class="panel-head"><h3>Órdenes de compra transportadas</h3></div>${pos.length ? `<div class="card-grid">${pos.map(poCard).join("")}</div>` : emptyState("🛒","Sin órdenes","")}</div>
    </div>
  </div>`;
}

let transporteFilter = { q: "", vehicle: "" };

/** true si alguna ruta del transporte tiene origen o destino que matchea el texto buscado. */
function transportMatchesPlace(t, q) {
  const routes = state.routes.filter((r) => r.transportId === t.id);
  return routes.some((r) =>
    (r.originCity || "").toLowerCase().includes(q) || (r.originProvince || "").toLowerCase().includes(q) ||
    (r.destinationCity || "").toLowerCase().includes(q) || (r.destinationProvince || "").toLowerCase().includes(q)
  );
}

function viewTransporte() {
  const q = transporteFilter.q.trim().toLowerCase();
  const vehicle = transporteFilter.vehicle;
  const list = state.transports.filter((t) => {
    if (vehicle && !(Array.isArray(t.vehicleTypes) ? t.vehicleTypes : []).includes(vehicle)) return false;
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || transportMatchesPlace(t, q);
  });
  return `<div class="view-list">
    <div class="list-toolbar"><h3 class="muted-title">Transportes registrados</h3><button class="btn btn-primary" data-action="open-modal" data-modal="transport">+ Nuevo transporte</button></div>
    <div class="list-toolbar" style="margin-top:-6px">
      <input type="text" id="transporte-q" placeholder="Buscar por nombre, origen o destino…" value="${esc(transporteFilter.q)}" class="input" />
    </div>
    <div class="chip-row">
      <button class="chip ${!vehicle ? "active" : ""}" data-transporte-vehicle="">Todos</button>
      ${Object.entries(VEHICLE_TYPES).map(([k, v]) => `<button class="chip ${vehicle === k ? "active" : ""}" data-transporte-vehicle="${k}">${v.icon} ${v.label}</button>`).join("")}
    </div>
    ${list.length ? `<div class="card-grid">${list.map((t) => {
      const cnt = state.orders.filter((o) => o.transportId === t.id).length + state.purchase_orders.filter((p) => p.transportId === t.id).length;
      const routeCnt = state.routes.filter((r) => r.transportId === t.id).length;
      const location = [t.city, t.province].filter(Boolean).join(", ");
      return `<a href="#/transporte/${t.id}" class="entity-card">
        <div class="entity-card-icon">🚚</div>
        <div><div class="entity-card-title">${esc(t.name)}</div><div class="entity-card-sub">${esc(t.type || "")}${location ? " · " + esc(location) : ""}</div><div class="entity-card-meta">${cnt} envíos${routeCnt ? ` · ${routeCnt} rutas` : ""} · ${esc(t.contact||t.phone||"")}</div>${vehicleBadges(t) ? `<div class="entity-card-meta">${vehicleBadges(t)}</div>` : ""}</div>
      </a>`;
    }).join("")}</div>` : emptyState("🚚", "Sin transportes", "No hay transportes que coincidan con el filtro actual.")}
  </div>`;
}

let proveedoresFilter = { q: "" };

/**
 * Unifica dos fuentes de proveedores que existen en la app:
 *  - state.suppliers      → proveedores logísticos, ligados a una ubicación, usados en Órdenes de Compra.
 *  - state.inv_suppliers  → proveedores de insumos, asignados directamente a productos en Inventario.
 * Antes solo se veían los primeros acá; esta vista ahora detecta y deja editar ambos.
 */
function viewProveedores() {
  const q = proveedoresFilter.q.trim().toLowerCase();

  const logisticsCards = state.suppliers.filter((s) => {
    if (!q) return true;
    const loc = getById("locations", s.locationId);
    return s.name.toLowerCase().includes(q) || (s.contact || "").toLowerCase().includes(q) ||
      (loc && ((loc.city || "").toLowerCase().includes(q) || (loc.province || "").toLowerCase().includes(q)));
  }).map((s) => {
    const loc = getById("locations", s.locationId);
    const pos = state.purchase_orders.filter((p) => p.supplierId === s.id);
    const pending = pos.filter((p) => !["recibida", "controlada", "cerrada"].includes(p.status)).length;
    const location = loc ? [loc.city, loc.province].filter(Boolean).join(", ") : "";
    return { name: s.name, html: `<div class="entity-card">
        <a href="#/proveedores/${s.id}" style="display:flex;gap:12px;align-items:center;flex:1;min-width:0;color:inherit;text-decoration:none">
          <div class="entity-card-icon">🏭</div>
          <div style="flex:1;min-width:0"><div class="entity-card-title">${esc(s.name)}</div><div class="entity-card-sub">${esc(loc?.address || "")}${location ? ", " + esc(location) : ""}</div><div class="entity-card-meta">${pos.length} OC${pending ? ` · ${pending} pendientes` : ""}${s.phone ? ` · ${esc(s.phone)}` : ""}</div></div>
        </a>
        ${loc ? `<button class="btn btn-secondary btn-sm" data-action="open-modal" data-modal="location" data-id="${loc.id}">Editar</button>` : ""}
      </div>` };
  });

  const insumosCards = state.inv_suppliers.filter((s) => {
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || (s.contact || "").toLowerCase().includes(q) || (s.email || "").toLowerCase().includes(q);
  }).map((s) => {
    const cnt = state.products.filter((p) => p.supplierId === s.id).length;
    return { name: s.name, html: `<div class="entity-card">
        <div style="display:flex;gap:12px;align-items:center;flex:1;min-width:0">
          <div class="entity-card-icon">🏷️</div>
          <div style="flex:1;min-width:0"><div class="entity-card-title">${esc(s.name)}</div><div class="entity-card-sub">Proveedor de insumos · ${cnt} producto${cnt === 1 ? "" : "s"}</div><div class="entity-card-meta">${[s.contact, s.phone, s.email].filter(Boolean).map(esc).join(" · ") || "Sin datos de contacto"}</div></div>
        </div>
        <button class="btn btn-secondary btn-sm" data-action="open-modal" data-modal="inv-supplier" data-id="${s.id}">Editar</button>
      </div>` };
  });

  const combined = [...logisticsCards, ...insumosCards].sort((a, b) => a.name.localeCompare(b.name));

  return `<div class="view-list">
    <div class="list-toolbar"><h3 class="muted-title">Proveedores</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary" data-action="open-modal" data-modal="inv-supplier">+ Proveedor de insumos</button>
        <button class="btn btn-primary" data-action="open-modal" data-modal="location" data-type="proveedor">+ Nuevo proveedor</button>
      </div>
    </div>
    <div class="list-toolbar" style="margin-top:-6px">
      <input type="text" id="proveedores-q" placeholder="Buscar por nombre, contacto o ciudad…" value="${esc(proveedoresFilter.q)}" class="input" />
    </div>
    ${combined.length ? `<div class="card-grid">${combined.map((x) => x.html).join("")}</div>` : emptyState("🏭", "Sin proveedores", q ? "No hay proveedores que coincidan con el filtro actual." : "Cargá tu primer proveedor para empezar a generar órdenes de compra o asociarlo a productos.", "")}
  </div>`;
}

function viewUbicaciones() {
  const types = Object.keys(LOCATION_TYPES).filter((t) => t !== "proveedor");
  if (!state.locations.filter((l) => l.type !== "proveedor").length) {
    return `<div class="view-list">
      <div class="list-toolbar"><h3 class="muted-title">Ubicaciones</h3><button class="btn btn-primary" data-action="open-modal" data-modal="location">+ Nueva ubicación</button></div>
      ${emptyState("📍", "Sin ubicaciones cargadas", "Cargá tu depósito y tus clientes para empezar a operar. Los proveedores se cargan desde su propia sección.", `<button class="btn btn-primary" data-action="open-modal" data-modal="location">+ Nueva ubicación</button>`)}
    </div>`;
  }
  return `<div class="view-list">
    <div class="list-toolbar"><h3 class="muted-title">Ubicaciones</h3><button class="btn btn-primary" data-action="open-modal" data-modal="location">+ Nueva ubicación</button></div>
    ${types.map((ty) => {
      const items = state.locations.filter((l) => l.type === ty);
      if (!items.length) return "";
      return `<div class="loc-group"><div class="loc-group-title">${LOCATION_TYPES[ty].icon} ${LOCATION_TYPES[ty].label}s</div>
        <div class="card-grid">${items.map((l) => {
          const sup = state.suppliers.find(s=>s.locationId===l.id);
          const href = sup ? `#/proveedores/${sup.id}` : null;
          const inner = `<div class="entity-card-icon">${LOCATION_TYPES[ty].icon}</div>
            <div style="flex:1;min-width:0"><div class="entity-card-title">${esc(l.name)}</div><div class="entity-card-sub">${esc(l.address)}, ${esc(l.city)}</div>${l.phone ? `<div class="entity-card-meta">${esc(l.phone)}</div>` : ""}</div>`;
          return `<div class="entity-card">
            ${href ? `<a href="${href}" style="display:flex;gap:12px;align-items:center;flex:1;min-width:0;color:inherit;text-decoration:none">${inner}</a>` : `<div style="display:flex;gap:12px;align-items:center;flex:1;min-width:0">${inner}</div>`}
            <button class="btn btn-secondary btn-sm" data-action="open-modal" data-modal="location" data-id="${l.id}">Editar</button>
          </div>`;
        }).join("")}</div></div>`;
    }).join("")}
    ${(() => { ubicacionesMapMarkers = state.locations.filter((l) => l.type !== "proveedor").map((l) => ({ kind: l.type, loc: l, label: l.name })); return ""; })()}
    <div class="panel"><div class="panel-head"><h3>Todas en el mapa</h3></div><div id="mapa-ubicaciones" class="leaflet-box" style="height:320px"></div></div>
  </div>`;
}

/* ---------------------------------------------------------------------------
   14.5 INVENTARIO (productos, proveedores de insumos, lotes con vencimiento)
   Nota: "inv_suppliers" es un proveedor de insumos para stock — distinto del
   "suppliers" que ya existía para Órdenes de Compra/logística. Se mantienen
   separados a propósito para no tocar esa lógica existente.
   ------------------------------------------------------------------------- */
let inventarioTab = "resumen"; // "resumen" | "productos" | "lotes" | "proveedores"
let inventarioSearch = "";
let inventarioLotesFilter = { producto: "", categoria: "", proveedor: "", deposito: "", estado: "", dias: "" };
let inventarioTrazaQuery = "";

const MOVEMENT_META = {
  recepcion:       { label: "Recepción",       cls: "st-green" },
  salida:          { label: "Salida",          cls: "st-blue" },
  transferencia:   { label: "Transferencia",   cls: "st-blue" },
  ajuste_positivo: { label: "Ajuste (+)",      cls: "st-green" },
  ajuste_negativo: { label: "Ajuste (-)",      cls: "st-orange" },
  merma:           { label: "Merma",           cls: "st-red" },
  devolucion:      { label: "Devolución",      cls: "st-violet" },
  vencimiento:     { label: "Vencimiento",     cls: "st-red" },
  bloqueo:         { label: "Bloqueo",         cls: "st-gray" },
  desbloqueo:      { label: "Desbloqueo",      cls: "st-gray" },
  produccion:      { label: "Salida por producción", cls: "st-violet" },
  consumo_of:      { label: "Consumo (OF)", cls: "st-violet" },
};
const LOT_ESTADO_LABEL = { vencido: "Vencido", critico: "Crítico", proximo: "Próximo a vencer", ok: "Normal", bloqueado: "Bloqueado", agotado: "Agotado", sf: "Sin fecha" };

function alertThresholds() {
  const row = getById("app_settings", "alert_thresholds");
  const v = row?.value || {};
  return { yellow: typeof v.yellow === "number" ? v.yellow : 30, orange: typeof v.orange === "number" ? v.orange : 7 };
}
function lotStatus(l) {
  if (l.bloqueado) return { key: "bloqueado", label: "Bloqueado", cls: "st-gray" };
  if (typeof l.quantity === "number" && l.quantity <= 0) return { key: "agotado", label: "Agotado", cls: "st-gray" };
  if (!l.expiryDate) return { key: "sf", label: "Sin fecha", cls: "st-gray" };
  const th = alertThresholds();
  const d = daysBetween(todayISO(), l.expiryDate);
  if (d < 0) return { key: "vencido", label: `Vencido hace ${Math.abs(d)}d`, cls: "st-red" };
  if (d <= th.orange) return { key: "critico", label: `Crítico: vence en ${d}d`, cls: "st-orange" };
  if (d <= th.yellow) return { key: "proximo", label: `Vence en ${d}d`, cls: "st-yellow" };
  return { key: "ok", label: `Vence ${fmtDate(l.expiryDate)}`, cls: "st-green" };
}
function productLots(productId) {
  return state.inventory_lots.filter((l) => l.productId === productId)
    .sort((a, b) => (a.expiryDate || "9999-99-99").localeCompare(b.expiryDate || "9999-99-99"));
}
function productTotalQty(productId) {
  // Los lotes bloqueados no cuentan como stock disponible (siguen existiendo,
  // pero no se ofrecen ni se usan para pedidos/salidas).
  return productLots(productId).filter((l) => !l.bloqueado).reduce((s, l) => s + (typeof l.quantity === "number" ? l.quantity : 0), 0);
}
const LOT_STATUS_RANK = { vencido: 0, critico: 1, proximo: 2, bloqueado: 3, ok: 4, agotado: 5, sf: 6 };
function productWorstStatus(productId) {
  const lots = productLots(productId);
  if (!lots.length) return { key: "sinstock", label: "Sin stock", cls: "st-gray" };
  return lots.map(lotStatus).sort((a, b) => LOT_STATUS_RANK[a.key] - LOT_STATUS_RANK[b.key])[0];
}
function stockLevelInfo(p) {
  const total = productTotalQty(p.id);
  if (typeof p.minQty === "number" && total <= p.minQty) return { label: "Bajo mínimo", cls: "pr-urgent" };
  if (typeof p.maxQty === "number" && total >= p.maxQty) return { label: "Sobre máximo", cls: "pr-low" };
  if (typeof p.minQty === "number" || typeof p.maxQty === "number") return { label: "En rango", cls: "pr-mid" };
  return null;
}
function invSupplierName(id) { const s = getById("inv_suppliers", id); return s ? s.name : "—"; }
function lotLocations(lotId) { return state.lot_locations.filter((ll) => ll.lotId === lotId); }
function lotValue(l) { return (typeof l.quantity === "number" && typeof l.costoUnitario === "number") ? l.quantity * l.costoUnitario : null; }
function lotMovements(lotId) { return state.stock_movements.filter((m) => m.lotId === lotId).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); }
function productMovements(productId) { return state.stock_movements.filter((m) => m.productId === productId).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); }

/** FEFO — First Expired, First Out: asigna la cantidad pedida priorizando los
 * lotes con vencimiento más próximo (los bloqueados o sin stock no entran). */
function fefoAllocate(productId, qtyNeeded) {
  const lots = productLots(productId).filter((l) => !l.bloqueado && typeof l.quantity === "number" && l.quantity > 0);
  const alloc = [];
  let remaining = qtyNeeded;
  for (const l of lots) {
    if (remaining <= 0) break;
    const take = Math.min(l.quantity, remaining);
    if (take > 0) { alloc.push({ lot: l, qty: take }); remaining -= take; }
  }
  return { alloc, remaining };
}
/** Registra un movimiento de stock. Nunca se borra ni se edita desde la app. */
async function registerMovement(opts) {
  const rec = {
    id: uid("mov"), productId: opts.productId || null, lotId: opts.lotId || null, type: opts.type,
    quantity: opts.quantity ?? 0, previousQty: opts.previousQty ?? null, newQty: opts.newQty ?? null,
    reason: opts.reason || "", relatedDocument: opts.relatedDocument || "", location: opts.location || "",
  };
  await persist("stock_movements", rec);
  return rec;
}
/** Cuando un lote vence, queda registrado un movimiento tipo "vencimiento" la
 * primera vez que se detecta (no hay cron: se revisa al cargar los datos). */
let reconcilingExpired = false;
async function reconcileExpiredLots() {
  if (reconcilingExpired) return;
  reconcilingExpired = true;
  try {
    const today = todayISO();
    const pending = state.inventory_lots.filter((l) => l.expiryDate && l.expiryDate < today && !l.bloqueado);
    for (const l of pending) {
      const already = state.stock_movements.some((m) => m.lotId === l.id && m.type === "vencimiento");
      if (already) continue;
      await registerMovement({ productId: l.productId, lotId: l.id, type: "vencimiento", quantity: l.quantity ?? 0, previousQty: l.quantity ?? 0, newQty: l.quantity ?? 0, reason: "Detectado automáticamente al vencer" });
    }
  } finally {
    reconcilingExpired = false;
  }
}

function viewInventario() {
  return `<div class="view-list">
    <div class="list-toolbar">
      <h3 class="muted-title">Inventario</h3>
      <div class="chip-row" style="margin:0">
        <button class="chip ${inventarioTab === "resumen" ? "active" : ""}" data-inv-tab="resumen">Resumen</button>
        <button class="chip ${inventarioTab === "productos" ? "active" : ""}" data-inv-tab="productos">Productos (${state.products.length})</button>
        <button class="chip ${inventarioTab === "lotes" ? "active" : ""}" data-inv-tab="lotes">Lotes (${state.inventory_lots.length})</button>
        <button class="chip ${inventarioTab === "proveedores" ? "active" : ""}" data-inv-tab="proveedores">Proveedores (${state.inv_suppliers.length})</button>
      </div>
      ${inventarioTab === "productos"
        ? `<button class="btn btn-primary" data-action="open-modal" data-modal="inv-product">+ Nuevo producto</button>`
        : inventarioTab === "proveedores"
        ? `<button class="btn btn-primary" data-action="open-modal" data-modal="inv-supplier">+ Nuevo proveedor</button>`
        : ""}
    </div>
    ${inventarioTab === "resumen" ? viewInventarioResumen()
      : inventarioTab === "productos" ? viewInventarioProductos()
      : inventarioTab === "lotes" ? viewInventarioLotes()
      : viewInventarioProveedores()}
  </div>`;
}

function viewInventarioResumen() {
  const th = alertThresholds();
  const lotsWithExpiry = state.inventory_lots.filter((l) => l.expiryDate);
  const statuses = state.inventory_lots.map(lotStatus);
  const count = (key) => statuses.filter((s) => s.key === key).length;
  const proximos = count("proximo"), criticos = count("critico"), vencidos = count("vencido");
  const valorProximoVencer = state.inventory_lots
    .filter((l) => ["proximo", "critico"].includes(lotStatus(l).key))
    .reduce((s, l) => s + (lotValue(l) || 0), 0);
  const merma = state.stock_movements.filter((m) => ["merma", "vencimiento"].includes(m.type))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  return `
    <div class="kpi-grid kpi-grid-compact" style="margin-bottom:16px">
      ${kpiCard(lotsWithExpiry.length, "Stock con vencimiento", "📦", "kpi-blue", 0)}
      ${kpiCard(proximos, "Próximos a vencer", "🟡", "kpi-violet", 60)}
      ${kpiCard(criticos, "Críticos", "🟠", "kpi-red", 120)}
      ${kpiCard(vencidos, "Vencidos", "🔴", "kpi-red", 180)}
    </div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>Valor económico próximo a vencer</h3><button class="btn btn-ghost btn-sm" data-action="open-modal" data-modal="inv-alert-settings">⚙️ Configurar alertas</button></div>
      <div class="stat-row"><div class="stat-box"><b>$${valorProximoVencer.toLocaleString("es-AR")}</b><span>Solo lotes con costo cargado</span></div></div>
      <div class="hint" style="margin-top:6px">🟢 Normal: más de ${th.yellow}d · 🟡 Próximo a vencer: ${th.orange + 1}–${th.yellow}d · 🟠 Crítico: hasta ${th.orange}d · 🔴 Vencido: fecha superada</div>
    </div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>Accesos rápidos</h3></div>
      <div class="chip-row">
        ${[7, 15, 30, 60].map((d) => `<button class="chip" data-inv-quick-dias="${d}">Vencen en ${d}d</button>`).join("")}
        <button class="chip" data-inv-quick-estado="vencido">Mercadería vencida</button>
        <button class="chip" data-inv-quick-estado="bloqueado">Bloqueados</button>
      </div>
    </div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>Merma y vencimientos (últimos movimientos)</h3></div>
      ${merma.length ? `<div style="overflow-x:auto"><table class="mini-table">
        <thead><tr><th>Producto</th><th>Tipo</th><th>Cantidad</th><th>Costo</th><th>Fecha</th><th>Motivo</th></tr></thead>
        <tbody>${merma.slice(0, 15).map((m) => {
          const p = getById("products", m.productId);
          const lot = getById("inventory_lots", m.lotId);
          const costo = lot && typeof lot.costoUnitario === "number" ? `$${(lot.costoUnitario * m.quantity).toLocaleString("es-AR")}` : "—";
          return `<tr><td>${esc(p?.name || "—")}</td><td>${statusBadge(MOVEMENT_META[m.type])}</td><td>${m.quantity}</td><td>${costo}</td><td>${fmtDateTime(m.createdAt)}</td><td>${esc(m.reason || "—")}</td></tr>`;
        }).join("")}</tbody>
      </table></div>` : emptyState("✨", "Sin mermas registradas", "Los registros de merma y vencimiento van a aparecer acá.")}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Trazabilidad</h3></div>
      <input type="text" id="inv-traza-search" class="input" placeholder="Buscar por producto, lote, remito u orden de compra…" value="${esc(inventarioTrazaQuery)}" style="margin-bottom:12px;max-width:420px" />
      ${renderTrazabilidad()}
    </div>`;
}

function renderTrazabilidad() {
  const q = inventarioTrazaQuery.trim().toLowerCase();
  if (!q) return `<div class="hint">Escribí para buscar un producto, número de lote, remito u orden de compra.</div>`;
  const lots = state.inventory_lots.filter((l) => {
    const p = getById("products", l.productId);
    return (p && p.name.toLowerCase().includes(q)) || (l.numeroLote || "").toLowerCase().includes(q) || (l.remito || "").toLowerCase().includes(q) || (l.ordenCompra || "").toLowerCase().includes(q);
  });
  if (!lots.length) return `<div class="hint">Sin resultados para "${esc(inventarioTrazaQuery)}"</div>`;
  return lots.map((l) => {
    const p = getById("products", l.productId);
    const moves = lotMovements(l.id);
    return `<div class="kv-notes" style="margin-bottom:10px">
      <span>${esc(p?.name || "—")} · Lote ${esc(l.numeroLote || l.id.slice(0, 8))}</span>
      <p>${moves.length ? moves.map((m) => `${fmtDateTime(m.createdAt)} — ${esc((MOVEMENT_META[m.type] || { label: m.type }).label)}: ${m.quantity}${m.reason ? " · " + esc(m.reason) : ""}`).join("<br>") : "Sin movimientos registrados."}</p>
    </div>`;
  }).join("");
}

/** Paleta de alerta visual para el Excel exportado — los mismos colores que
 * ya usa la app en pantalla para cada estado (badges .st-red/.st-orange/
 * .st-yellow/.st-green/.st-gray en styles.css), traducidos a hex para que
 * cada fila se vea con el mismo semáforo al abrirla en Excel. */
const XLSX_ALERT_COLORS = {
  "st-red": { bg: "FBE6E8", font: "C9142B" },
  "st-orange": { bg: "F3E7D1", font: "A3691F" },
  "st-yellow": { bg: "F1E8D5", font: "8A6E33" },
  "st-green": { bg: "E3F2E8", font: "1E7A46" },
  "st-gray": { bg: "EDEAE1", font: "5B5850" },
};
function xlsxCellStyle({ bg, font, bold } = {}) {
  const s = {};
  if (bg) s.fill = { patternType: "solid", fgColor: { rgb: bg } };
  if (font || bold) s.font = { ...(font ? { color: { rgb: font } } : {}), ...(bold ? { bold: true } : {}) };
  return s;
}
/** Exporta a Excel (.xlsx) los productos de Inventario que están visibles
 * en ese momento (respeta el buscador de la pestaña Productos), con
 * alertas visuales: cada fila se colorea según el estado de vencimiento
 * más próximo de ese producto (mismo semáforo 🔴🟠🟡🟢 que ya usa
 * Inventario en pantalla — productWorstStatus()), y la columna de stock se
 * resalta en rojo y negrita cuando está por debajo del mínimo configurado
 * (stockLevelInfo()). Sólo lee state.products — no modifica ni borra nada. */
function exportInventarioProductosExcel() {
  const q = inventarioSearch.trim().toLowerCase();
  const list = state.products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || invSupplierName(p.supplierId).toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q) || (p.categoria || "").toLowerCase().includes(q) || (p.marca || "").toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  const headers = ["Producto", "Marca", "SKU", "Categoría", "Proveedor", "Unidad", "Tamaño de paquete", "Stock total", "Estado de vencimiento", "Stock mínimo", "Stock óptimo", "Stock máximo", "Maneja lote", "Maneja vencimiento", "Días de alerta", "Notas"];
  const aoa = [headers, ...list.map((p) => {
    const status = productWorstStatus(p.id);
    return [
      p.name, p.marca || "", p.sku || "", p.categoria || "", invSupplierName(p.supplierId), p.unit || "", p.packageSize ?? "",
      productTotalQty(p.id), status.label, p.minQty ?? "", p.optimalQty ?? "", p.maxQty ?? "",
      p.manejaLote ? "Sí" : "No", p.manejaVencimiento ? "Sí" : "No", p.diasAlerta ?? "", p.notes || "",
    ];
  })];

  const ws = XLSXStyle.utils.aoa_to_sheet(aoa);
  const colCount = headers.length;

  // Encabezado: fondo oscuro y texto blanco en negrita — misma jerarquía visual que el resto de la app.
  for (let c = 0; c < colCount; c++) {
    const ref = XLSXStyle.utils.encode_cell({ r: 0, c });
    if (ws[ref]) ws[ref].s = xlsxCellStyle({ bg: "111111", font: "FFFFFF", bold: true });
  }

  // Filas: semáforo por estado de vencimiento + resalte de stock bajo mínimo.
  list.forEach((p, i) => {
    const r = i + 1;
    const status = productWorstStatus(p.id);
    const rowStyle = xlsxCellStyle(XLSX_ALERT_COLORS[status.cls] || {});
    for (let c = 0; c < colCount; c++) {
      const ref = XLSXStyle.utils.encode_cell({ r, c });
      if (ws[ref]) ws[ref].s = rowStyle;
    }
    const stockLevel = stockLevelInfo(p);
    if (stockLevel && stockLevel.cls === "pr-urgent") {
      const stockRef = XLSXStyle.utils.encode_cell({ r, c: 6 }); // columna "Stock total"
      if (ws[stockRef]) ws[stockRef].s = xlsxCellStyle({ bg: "FBE6E8", font: "C9142B", bold: true });
    }
  });

  ws["!cols"] = [
    { wch: 26 }, { wch: 14 }, { wch: 16 }, { wch: 20 }, { wch: 10 }, { wch: 14 },
    { wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 30 },
  ];

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, "Productos");
  XLSXStyle.writeFile(wb, `inventario-productos-${todayISO()}.xlsx`);
  toast(`${list.length} producto${list.length === 1 ? "" : "s"} exportado${list.length === 1 ? "" : "s"} a Excel`);
}
function viewInventarioProductos() {
  if (!state.products.length) {
    return emptyState("📦", "Sin productos cargados", "Creá productos para empezar a llevar el stock y sus vencimientos.", `<button class="btn btn-primary" data-action="open-modal" data-modal="inv-product">+ Nuevo producto</button>`);
  }
  const q = inventarioSearch.trim().toLowerCase();
  const list = state.products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || invSupplierName(p.supplierId).toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q) || (p.categoria || "").toLowerCase().includes(q) || (p.marca || "").toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  return `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <input type="text" id="inv-search" class="input" placeholder="Buscar producto, marca, proveedor, SKU o categoría…" value="${esc(inventarioSearch)}" style="max-width:360px;margin-bottom:0" />
      <button class="btn btn-secondary btn-sm" data-action="inv-export-productos">⬇️ Exportar a Excel${q ? ` (${list.length})` : ""}</button>
    </div>
    <div class="panel" style="overflow-x:auto">
      <table class="mini-table">
        <thead><tr><th>Producto</th><th>Proveedor</th><th>Stock</th><th>Vencimiento más próximo</th><th>Mín / Óptimo / Máx</th><th></th></tr></thead>
        <tbody>${list.length ? list.map((p) => {
          const total = productTotalQty(p.id);
          const status = productWorstStatus(p.id);
          const range = [p.minQty, p.optimalQty, p.maxQty].map((v) => (v == null ? "—" : v)).join(" / ");
          return `<tr>
            <td><a href="#/producto/${p.id}" class="link-more" style="color:var(--ink)">${esc(p.name)}</a><div class="entity-card-meta">${[p.marca, p.sku, p.categoria, p.unit, p.packageSize ? String(p.packageSize) : null].filter(Boolean).map(esc).join(" · ")}</div></td>
            <td>${esc(invSupplierName(p.supplierId))}</td>
            <td>${total || total === 0 ? total : "—"} UND</td>
            <td>${statusBadge(status)}</td>
            <td>${range}</td>
            <td><a href="#/producto/${p.id}" class="link-more">Ver →</a></td>
          </tr>`;
        }).join("") : `<tr><td colspan="6"><div class="hint" style="padding:14px 0">Sin resultados para "${esc(inventarioSearch)}"</div></td></tr>`}</tbody>
      </table>
    </div>`;
}

function viewInventarioLotes() {
  const f = inventarioLotesFilter;
  const depositos = Array.from(new Set(state.inventory_lots.map((l) => l.deposito).filter(Boolean))).sort();
  const categorias = Array.from(new Set(state.products.map((p) => p.categoria).filter(Boolean))).sort();
  let list = state.inventory_lots.map((l) => ({ lot: l, product: getById("products", l.productId) }));
  if (f.producto) list = list.filter((x) => x.lot.productId === f.producto);
  if (f.proveedor) list = list.filter((x) => x.product && x.product.supplierId === f.proveedor);
  if (f.categoria) list = list.filter((x) => x.product && x.product.categoria === f.categoria);
  if (f.deposito) list = list.filter((x) => x.lot.deposito === f.deposito);
  if (f.estado) list = list.filter((x) => lotStatus(x.lot).key === f.estado);
  if (f.dias) {
    const maxD = parseInt(f.dias, 10);
    list = list.filter((x) => { const d = daysBetween(todayISO(), x.lot.expiryDate); return d !== null && d >= 0 && d <= maxD; });
  }
  list.sort((a, b) => (a.lot.expiryDate || "9999-99-99").localeCompare(b.lot.expiryDate || "9999-99-99"));
  const hasFilters = f.producto || f.categoria || f.proveedor || f.deposito || f.estado || f.dias;

  return `
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
      <select class="input" id="inv-lotes-producto" style="max-width:220px"><option value="">Todos los productos</option>${state.products.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<option value="${p.id}" ${f.producto === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <select class="input" id="inv-lotes-categoria" style="max-width:180px"><option value="">Todas las categorías</option>${categorias.map((c) => `<option value="${esc(c)}" ${f.categoria === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <select class="input" id="inv-lotes-proveedor" style="max-width:200px"><option value="">Todos los proveedores</option>${state.inv_suppliers.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => `<option value="${s.id}" ${f.proveedor === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      <select class="input" id="inv-lotes-deposito" style="max-width:180px"><option value="">Todos los depósitos</option>${depositos.map((d) => `<option value="${esc(d)}" ${f.deposito === d ? "selected" : ""}>${esc(d)}</option>`).join("")}</select>
      <select class="input" id="inv-lotes-estado" style="max-width:180px">
        <option value="">Todos los estados</option>
        ${Object.keys(LOT_ESTADO_LABEL).map((k) => `<option value="${k}" ${f.estado === k ? "selected" : ""}>${esc(LOT_ESTADO_LABEL[k])}</option>`).join("")}
      </select>
      ${hasFilters ? `<button class="btn btn-ghost btn-sm" data-action="inv-lotes-clear">Limpiar filtros</button>` : ""}
    </div>
    <div class="panel" style="overflow-x:auto">
      <table class="mini-table">
        <thead><tr><th>Producto</th><th>Lote</th><th>Cantidad</th><th>Depósito</th><th>Vencimiento</th><th>Estado</th><th>Valor</th><th></th></tr></thead>
        <tbody>${list.length ? list.map(({ lot: l, product: p }) => {
          const val = lotValue(l);
          return `<tr>
            <td><a href="#/producto/${l.productId}" class="link-more" style="color:var(--ink)">${esc(p?.name || "—")}</a></td>
            <td>${esc(l.numeroLote || l.id.slice(0, 8))}</td>
            <td>${l.quantity ?? "—"}${l.quantity != null ? " UND" : ""}</td>
            <td>${esc(l.deposito || "—")}</td>
            <td>${l.expiryDate ? fmtDate(l.expiryDate) : "—"}</td>
            <td>${statusBadge(lotStatus(l))}</td>
            <td>${val != null ? "$" + val.toLocaleString("es-AR") : "—"}</td>
            <td><a href="#/producto/${l.productId}" class="link-more">Ver →</a></td>
          </tr>`;
        }).join("") : `<tr><td colspan="8"><div class="hint" style="padding:14px 0">Sin lotes para estos filtros</div></td></tr>`}</tbody>
      </table>
    </div>`;
}

function viewInventarioProveedores() {
  if (!state.inv_suppliers.length) {
    return emptyState("🏷️", "Sin proveedores de insumos", "Creá el primer proveedor para poder asociarle productos.", `<button class="btn btn-primary" data-action="open-modal" data-modal="inv-supplier">+ Nuevo proveedor</button>`);
  }
  return `<div class="card-grid">${state.inv_suppliers.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => {
    const cnt = state.products.filter((p) => p.supplierId === s.id).length;
    return `<div class="entity-card">
      <div class="entity-card-icon">🏷️</div>
      <div style="flex:1;min-width:0">
        <div class="entity-card-title">${esc(s.name)}</div>
        <div class="entity-card-sub">${cnt} producto${cnt === 1 ? "" : "s"}</div>
        <div class="entity-card-meta">${[s.contact, s.phone, s.email].filter(Boolean).map(esc).join(" · ") || "Sin datos de contacto"}</div>
      </div>
      <button class="btn btn-secondary btn-sm" data-action="open-modal" data-modal="inv-supplier" data-id="${s.id}">Editar</button>
    </div>`;
  }).join("")}</div>`;
}

function viewInventarioProductoDetail(id) {
  const p = getById("products", id);
  if (!p) return emptyState("📦", "Producto no encontrado", "");
  const lots = productLots(id);
  const total = productTotalQty(id);
  const level = stockLevelInfo(p);
  const supplier = p.supplierId ? getById("inv_suppliers", p.supplierId) : null;
  const moves = productMovements(id);
  const totalValue = lots.reduce((s, l) => s + (lotValue(l) || 0), 0);
  return `
  <div class="detail-view">
    <div class="detail-head">
      <div><a href="#/inventario" class="back-link">← Inventario</a><h2>${esc(p.name)}</h2>
        <div class="detail-sub">${[p.marca, p.sku, p.categoria, invSupplierName(p.supplierId), p.unit, p.packageSize ? String(p.packageSize) : null].filter(Boolean).map(esc).join(" · ")}</div>
      </div>
      <div class="detail-actions">
        <button class="btn btn-secondary" data-action="open-modal" data-modal="inv-lot" data-product-id="${p.id}">+ Agregar lote</button>
        <button class="btn btn-secondary" data-action="open-modal" data-modal="inv-salida" data-product-id="${p.id}">Registrar salida</button>
        <button class="btn btn-ghost" data-action="open-modal" data-modal="inv-product" data-id="${p.id}">Editar producto</button>
      </div>
    </div>
    <div class="detail-grid">
      <div class="panel">
        <div class="panel-head"><h3>Niveles de stock</h3>${level ? `<span class="pill ${level.cls}">${level.label}</span>` : ""}</div>
        <div class="stat-row">
          <div class="stat-box"><b>${total}</b><span>Stock total (UND)</span></div>
          <div class="stat-box"><b>${p.minQty ?? "—"}</b><span>Mínimo</span></div>
          <div class="stat-box"><b>${p.optimalQty ?? "—"}</b><span>Óptimo de compra</span></div>
          <div class="stat-box"><b>${p.maxQty ?? "—"}</b><span>Máximo</span></div>
        </div>
        ${totalValue ? `<div class="hint" style="margin-top:8px">Valor actual: $${totalValue.toLocaleString("es-AR")}</div>` : ""}
        ${p.notes ? `<div class="kv-notes"><span>Observaciones</span><p>${esc(p.notes)}</p></div>` : ""}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Proveedor</h3></div>
        ${supplier ? `
          <div class="kv"><span>Nombre</span><b>${esc(supplier.name)}</b></div>
          <div class="kv"><span>Contacto</span><b>${esc(supplier.contact || "—")}</b></div>
          <div class="kv"><span>Teléfono</span><b>${esc(supplier.phone || "—")}</b></div>
          <div class="kv"><span>Email</span><b>${esc(supplier.email || "—")}</b></div>
        ` : emptyState("🏷️", "Sin proveedor asignado", "", `<button class="btn btn-secondary btn-sm" data-action="open-modal" data-modal="inv-product" data-id="${p.id}">Asignar proveedor</button>`)}
      </div>
      <div class="panel span2">
        <div class="panel-head"><h3>Lotes en stock (${lots.length})</h3>
          <div class="chip-row" style="margin:0">
            <button class="chip" data-action="open-modal" data-modal="inv-merma" data-product-id="${p.id}">Registrar merma</button>
            <button class="chip" data-action="open-modal" data-modal="inv-devolucion" data-product-id="${p.id}">Registrar devolución</button>
            <button class="chip" data-action="open-modal" data-modal="inv-ajuste" data-product-id="${p.id}">Ajuste manual</button>
          </div>
        </div>
        ${lots.length ? `<div style="overflow-x:auto"><table class="mini-table">
          <thead><tr><th>Lote</th><th>Cantidad</th><th>Depósito</th><th>Vencimiento</th><th>Estado</th><th>Valor</th><th></th></tr></thead>
          <tbody>${lots.map((l) => {
            const val = lotValue(l);
            const locs = lotLocations(l.id);
            return `<tr>
              <td>${esc(l.numeroLote || l.id.slice(0, 8))}</td>
              <td>${l.quantity ?? "—"}${l.quantity != null ? " UND" : ""}</td>
              <td>${esc(l.deposito || "—")}${locs.length ? `<div class="entity-card-meta">${locs.map((ll) => `${esc(ll.locationLabel)}: ${ll.quantity}`).join(" · ")}</div>` : ""}</td>
              <td>${l.expiryDate ? fmtDate(l.expiryDate) : "—"}</td>
              <td>${statusBadge(lotStatus(l))}</td>
              <td>${val != null ? "$" + val.toLocaleString("es-AR") : "—"}</td>
              <td style="white-space:nowrap">
                <button class="btn btn-ghost btn-sm" data-action="open-modal" data-modal="inv-lot" data-id="${l.id}">Editar</button>
                ${l.bloqueado
                  ? `<button class="btn btn-ghost btn-sm" data-action="inv-lot-unblock" data-id="${l.id}">Desbloquear</button>`
                  : `<button class="btn btn-ghost btn-sm" data-action="open-modal" data-modal="inv-lot-block" data-id="${l.id}">Bloquear</button>`}
                <button class="btn btn-ghost btn-sm" data-action="open-modal" data-modal="inv-lot-location" data-id="${l.id}">+ Ubicación</button>
              </td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>` : emptyState("📦", "Sin lotes cargados", "Agregá el primer lote con su cantidad y vencimiento.", `<button class="btn btn-primary btn-sm" data-action="open-modal" data-modal="inv-lot" data-product-id="${p.id}">+ Agregar lote</button>`)}
      </div>
      <div class="panel span2">
        <div class="panel-head"><h3>Movimientos y trazabilidad (${moves.length})</h3></div>
        ${moves.length ? `<div style="overflow-x:auto"><table class="mini-table">
          <thead><tr><th>Tipo</th><th>Cantidad</th><th>Antes → Después</th><th>Motivo / Documento</th><th>Fecha</th></tr></thead>
          <tbody>${moves.slice(0, 30).map((m) => `<tr>
            <td>${statusBadge(MOVEMENT_META[m.type] || { cls: "st-gray", label: m.type })}</td>
            <td>${m.quantity}</td>
            <td>${m.previousQty ?? "—"} → ${m.newQty ?? "—"}</td>
            <td>${esc([m.reason, m.relatedDocument].filter(Boolean).join(" · ") || "—")}</td>
            <td>${fmtDateTime(m.createdAt)}</td>
          </tr>`).join("")}</tbody>
        </table></div>` : emptyState("🕒", "Sin movimientos", "Los movimientos de stock de este producto van a aparecer acá.")}
      </div>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------------------
   14.6 PRODUCCIÓN (planificación de cajas a partir del Inventario existente)
   No crea un inventario paralelo: usa "products" e "inventory_lots" tal como
   están. Al confirmar una producción se descuenta stock con el mismo
   mecanismo FEFO + stock_movements que ya usa Inventario (fefoAllocate /
   registerMovement), y las cajas producidas quedan cargadas como un producto
   terminado más dentro del mismo Inventario (ver confirmProduction()).
   ------------------------------------------------------------------------- */
const BOX_SIZES = ["estandar", "navidena", "valija"];
const BOX_SIZE_LABELS = { estandar: "Estándar", navidena: "Navideña", valija: "Valija" };
function boxSizeLabel(size) { return BOX_SIZE_LABELS[size] || size; }
const PRODUCTION_STATUS_META = {
  planificada:   { label: "Planificada",   cls: "st-gray" },
  pendiente:     { label: "Pendiente",     cls: "st-yellow" },
  en_produccion: { label: "En producción", cls: "st-blue" },
  finalizada:    { label: "Finalizada",    cls: "st-green" },
  cancelada:     { label: "Cancelada",     cls: "st-red" },
};
const PRODUCTION_FLOW = ["planificada", "pendiente", "en_produccion", "finalizada"];

let produccionTab = "planificar"; // "planificar" | "configurar" | "historial"
// `produccionPlan.lines`: una planificación puede combinar varias líneas de
// tamaño de caja (ej: 10 L + 5 M) en una sola tanda a confirmar — no se
// asume una única caja por producción. Tamaños repetidos se consolidan al
// calcular (misma lógica de agrupación que ya usa el Simulador, 14.7).
let produccionPlan = { lines: [{ id: uid("pline"), size: "estandar", quantity: 10 }] };
let produccionConfigSize = "estandar";
/** Próximo tamaño "libre" (sin usar todavía) para sugerir al agregar una
 * línea nueva — si ya están los 4 usados, vuelve a ofrecer el primero. */
function produccionNextUnusedSize() {
  const used = new Set(produccionPlan.lines.map((l) => l.size));
  return BOX_SIZES.find((s) => !used.has(s)) || BOX_SIZES[0];
}
/** Consolida las líneas de la planificación por tamaño (suma si hay más de
 * una línea con el mismo tamaño) — mismo criterio que simuladorConsolidado(). */
function produccionPlanBySize() {
  const bySize = { estandar: 0, navidena: 0, valija: 0 };
  produccionPlan.lines.forEach((l) => { bySize[l.size] = (bySize[l.size] || 0) + Math.max(0, Number(l.quantity) || 0); });
  return bySize;
}

function productionSettings() {
  const row = getById("app_settings", "production_settings");
  const v = row?.value || {};
  return {
    prepMinutes: typeof v.prepMinutes === "number" ? v.prepMinutes : 15,
    boxMinutes: { estandar: 6, navidena: 12, valija: 9, ...(v.boxMinutes || {}) },
    dailyHours: typeof v.dailyHours === "number" ? v.dailyHours : 8,
    // Campos del Simulador de producción (14.7) — aditivos, con default que
    // no altera el cálculo de la planificación de una sola caja (14.6).
    packMinutes: typeof v.packMinutes === "number" ? v.packMinutes : 0,
    jornadaInicio: v.jornadaInicio || "08:00",
    jornadaFin: v.jornadaFin || "17:00",
    descansoMin: typeof v.descansoMin === "number" ? v.descansoMin : 60,
    efficiencyByPeople: { 1: 100, 2: 95, 3: 90, 4: 85, 5: 80, 6: 75, 7: 70, 8: 65, ...(v.efficiencyByPeople || {}) },
  };
}
function boxConfigForSize(size) { return state.box_configs.find((c) => c.size === size) || null; }
function boxConfigItems(boxConfigId) { return state.box_config_items.filter((i) => i.boxConfigId === boxConfigId); }
function fmtMinutes(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  const h = Math.floor(m / 60), r = m % 60;
  if (h && r) return `${h} h ${r} min`;
  if (h) return `${h} h`;
  return `${r} min`;
}

/** Calcula, para un tamaño y cantidad de cajas, el consumo por producto, el
 * máximo de cajas que el stock actual permite y cuál producto es el
 * limitante. Cálculo puro para el simulador — no modifica nada. */
function computeBoxPlan(size, quantity) {
  const config = boxConfigForSize(size);
  const items = config ? boxConfigItems(config.id) : [];
  const qty = Math.max(0, Number(quantity) || 0);
  const rows = items.map((it) => {
    const p = getById("products", it.productId);
    const stockAvailable = p ? productTotalQty(p.id) : 0;
    const qtyPerBox = it.quantity || 0;
    const qtyNeeded = qtyPerBox * qty;
    const diff = stockAvailable - qtyNeeded;
    const maxBoxesByThis = qtyPerBox > 0 ? Math.floor(stockAvailable / qtyPerBox) : Infinity;
    return {
      itemId: it.id, productId: it.productId,
      name: p ? p.name : "(producto eliminado)", sku: p ? p.sku : null,
      qtyPerBox, qtyNeeded, stockAvailable, diff, maxBoxesByThis, ok: diff >= 0,
    };
  });
  const finiteMax = rows.filter((r) => Number.isFinite(r.maxBoxesByThis));
  const maxBoxes = !config || !items.length ? 0 : (finiteMax.length ? Math.min(...finiteMax.map((r) => r.maxBoxesByThis)) : Infinity);
  const limiting = finiteMax.length ? finiteMax.reduce((a, b) => (b.maxBoxesByThis < a.maxBoxesByThis ? b : a)) : null;
  return {
    config, items: rows, hasConfig: !!config && items.length > 0,
    stockOk: items.length > 0 && rows.every((r) => r.ok),
    maxBoxes: Number.isFinite(maxBoxes) ? maxBoxes : 0,
    limitingProduct: limiting ? limiting.name : null,
    totalUnits: rows.reduce((s, r) => s + r.qtyNeeded, 0),
  };
}
/** Tiempo estimado: preparación fija por lote + tiempo por caja × cantidad. */
function computeProductionTime(size, quantity, settings) {
  const s = settings || productionSettings();
  const perBox = s.boxMinutes[size] ?? 0;
  const qty = Math.max(0, Number(quantity) || 0);
  const armado = perBox * qty;
  const prep = qty > 0 ? s.prepMinutes : 0;
  return { prep, armado, total: prep + armado, perBox };
}
/** Capacidad real: el mínimo entre lo que permite el stock y lo que permite
 * el tiempo disponible de la jornada. */
function computeCapacity(size, plan, settings) {
  const s = settings || productionSettings();
  const perBox = s.boxMinutes[size] ?? 0;
  const availableForBoxes = Math.max(0, s.dailyHours * 60 - s.prepMinutes);
  const maxByTime = perBox > 0 ? Math.floor(availableForBoxes / perBox) : Infinity;
  const maxByStock = plan.hasConfig ? plan.maxBoxes : Infinity;
  const real = Math.min(maxByTime, maxByStock);
  return {
    maxByTime: Number.isFinite(maxByTime) ? maxByTime : 0,
    maxByStock: Number.isFinite(maxByStock) ? maxByStock : 0,
    real: Number.isFinite(real) ? real : 0,
    limitante: maxByStock <= maxByTime ? "stock" : "tiempo",
  };
}

function produccionDashboard() {
  const today = todayISO();
  const orders = state.production_orders;
  const plannedToday = orders.filter((o) => (o.createdAt || "").slice(0, 10) === today && o.status !== "cancelada").length;
  const finalizadasHoy = orders.filter((o) => o.status === "finalizada" && (o.finishedAt || "").slice(0, 10) === today);
  const boxesToday = finalizadasHoy.reduce((s, o) => s + (o.quantity || 0), 0);
  const minutesToday = finalizadasHoy.reduce((s, o) => s + (o.actualMinutes ?? o.estimatedMinutes ?? 0), 0);
  const settings = productionSettings();
  const occupancy = settings.dailyHours > 0 ? Math.min(100, (minutesToday / (settings.dailyHours * 60)) * 100) : 0;
  const lowStock = state.products.filter((p) => typeof p.minQty === "number" && productTotalQty(p.id) <= p.minQty).length;
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6);
  const weekStartISO = weekStart.toISOString().slice(0, 10);
  const weekBoxes = orders.filter((o) => o.status === "finalizada" && (o.finishedAt || "").slice(0, 10) >= weekStartISO).reduce((s, o) => s + (o.quantity || 0), 0);
  return { plannedToday, boxesToday, hoursToday: minutesToday / 60, occupancy, lowStock, weekBoxes };
}
function produccionChartsData() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const boxes = state.production_orders.filter((o) => o.status === "finalizada" && (o.finishedAt || "").slice(0, 10) === iso).reduce((s, o) => s + (o.quantity || 0), 0);
    days.push({ label: d.toLocaleDateString("es-AR", { weekday: "short" }), boxes });
  }
  const bySize = BOX_SIZES.map((size) => ({
    size, boxes: state.production_orders.filter((o) => o.status === "finalizada" && o.boxSize === size).reduce((s, o) => s + (o.quantity || 0), 0),
  }));
  return { days, bySize };
}

function viewProduccion() {
  const dash = produccionDashboard();
  const charts = produccionChartsData();
  const maxDay = Math.max(1, ...charts.days.map((d) => d.boxes));
  const maxSize = Math.max(1, ...charts.bySize.map((d) => d.boxes));
  return `<div class="view-list">
    <div class="list-toolbar"><h3 class="muted-title">Producción</h3></div>
    <div class="kpi-grid kpi-grid-compact" style="margin-bottom:16px">
      ${kpiCard(dash.plannedToday, "Planificadas hoy", "📦", "kpi-blue", 0)}
      ${kpiCard(dash.boxesToday, "Cajas producidas hoy", "📦", "kpi-violet", 40)}
      ${kpiCard(dash.hoursToday.toFixed(1), "Horas de producción", "⏱", "kpi-blue", 80)}
      ${kpiCard(Math.round(dash.occupancy) + "%", "Capacidad utilizada", "📊", dash.occupancy >= 90 ? "kpi-red" : "kpi-orange", 120)}
      ${kpiCard(dash.lowStock, "Stock insuficiente", "⚠", dash.lowStock ? "kpi-red" : "kpi-blue", 160)}
      ${kpiCard(dash.weekBoxes, "Producción de la semana", "📈", "kpi-blue", 200)}
    </div>
    <div class="detail-grid" style="margin-bottom:16px">
      <div class="panel">
        <div class="panel-head"><h3>Cajas producidas por día</h3></div>
        <div class="prod-bars">${charts.days.map((d) => `<div class="prod-bar-col"><div class="prod-bar" style="height:${Math.max(4, (d.boxes / maxDay) * 100)}%" title="${d.boxes} cajas"></div><span>${esc(d.label)}</span></div>`).join("")}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Producción por tamaño</h3></div>
        ${charts.bySize.map((d) => `<div class="prod-hbar-row"><span class="prod-hbar-label">${esc(boxSizeLabel(d.size))}</span><div class="prod-hbar-track"><div class="prod-hbar-fill" style="width:${Math.max(3, (d.boxes / maxSize) * 100)}%"></div></div><span class="prod-hbar-value">${d.boxes}</span></div>`).join("")}
      </div>
    </div>
    <div class="chip-row">
      <button class="chip ${produccionTab === "planificar" ? "active" : ""}" data-prod-tab="planificar">Planificar</button>
      <button class="chip ${produccionTab === "simulador" ? "active" : ""}" data-prod-tab="simulador">Simulador de producción</button>
      <button class="chip ${produccionTab === "configurar" ? "active" : ""}" data-prod-tab="configurar">Configurar cajas</button>
      <button class="chip ${produccionTab === "historial" ? "active" : ""}" data-prod-tab="historial">Historial (${state.production_orders.length})</button>
    </div>
    ${produccionTab === "planificar" ? viewProduccionPlanificar()
      : produccionTab === "simulador" ? viewProduccionSimulador()
      : produccionTab === "configurar" ? viewProduccionConfigurar()
      : viewProduccionHistorial()}
  </div>`;
}

function viewProduccionPlanificar() {
  const settings = productionSettings();
  const lines = produccionPlan.lines;
  const bySize = produccionPlanBySize();
  const totalQty = BOX_SIZES.reduce((s, sz) => s + bySize[sz], 0);
  // Reutiliza el mismo cálculo de consolidación/stock/tiempo que ya usa el
  // Simulador de producción (14.7) — una planificación con varios tamaños
  // de caja se trata igual que una tanda, sin duplicar la lógica.
  const multiPlan = computeMultiBoxPlan(bySize);
  const time = computeSimTime(bySize, settings);
  const canConfirm = multiPlan.sizesUsed.length > 0 && multiPlan.hasAllConfigs && multiPlan.stockOk && totalQty > 0;

  let estadoBadge, estadoTexto;
  if (!multiPlan.sizesUsed.length || totalQty <= 0) {
    estadoBadge = `<span class="badge st-gray">—</span>`;
    estadoTexto = `Ingresá al menos una cantidad de cajas para planificar.`;
  } else if (!multiPlan.hasAllConfigs) {
    estadoBadge = `<span class="badge st-gray">Sin configurar</span>`;
    estadoTexto = `Faltan recetas configuradas para: ${multiPlan.missingConfigs.map((s) => `Caja ${esc(boxSizeLabel(s))}`).join(", ")}. Andá a "Configurar cajas".`;
  } else if (multiPlan.stockOk) {
    estadoBadge = `<span class="badge st-green">🟢 Producción posible</span>`;
    estadoTexto = `Listo para producir.`;
  } else {
    const r = multiPlan.limitingProduct;
    estadoBadge = `<span class="badge st-red">🔴 Producción no disponible</span>`;
    estadoTexto = r ? `Falta stock de ${esc(r.name)}: disponible ${r.stockAvailable}, necesario ${r.qtyNeeded} (faltan ${Math.abs(r.diff)}).` : `Falta stock para completar esta planificación.`;
  }
  const occPct = settings.dailyHours > 0 ? Math.min(100, (time.trabajoTotal / (settings.dailyHours * 60)) * 100) : 0;

  return `
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>Planificar producción</h3><button class="btn btn-ghost btn-sm" data-action="prod-line-add">+ Agregar tamaño</button></div>
      <div style="overflow-x:auto"><table class="mini-table">
        <thead><tr><th>Tamaño</th><th style="text-align:right">Cantidad de cajas</th><th></th></tr></thead>
        <tbody>${lines.map((l) => `<tr>
          <td><select class="input" data-prod-line-size="${l.id}">${BOX_SIZES.map((s) => `<option value="${s}" ${l.size === s ? "selected" : ""}>${boxSizeLabel(s)}</option>`).join("")}</select></td>
          <td style="text-align:right"><input class="input" type="number" min="0" step="1" data-prod-line-qty="${l.id}" value="${l.quantity}" style="max-width:120px;text-align:right" /></td>
          <td style="white-space:nowrap">${lines.length > 1 ? `<button class="btn btn-ghost btn-sm" data-action="prod-line-remove" data-id="${l.id}">Quitar</button>` : ""}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>
    <div class="kpi-hero-row" style="margin:0 0 16px">
      ${heroKpiCard("Cajas a producir", totalQty, [{ label: "Tamaños", value: multiPlan.sizesUsed.length }, { label: "Productos", value: multiPlan.totalUnits }])}
      <div class="panel">
        <div class="panel-head"><h3>Resumen de producción</h3>${estadoBadge}</div>
        <div class="stat-row wrap">
          <div class="stat-box"><b>${totalQty}</b><span>Cajas</span></div>
          <div class="stat-box"><b>${multiPlan.sizesUsed.map((s) => boxSizeLabel(s)).join(", ") || "—"}</b><span>Tamaños</span></div>
          <div class="stat-box"><b>${multiPlan.totalUnits}</b><span>Productos totales</span></div>
          <div class="stat-box"><b>${fmtMinutes(time.trabajoTotal)}</b><span>Tiempo estimado</span></div>
          <div class="stat-box"><b>${occPct.toFixed(1)}%</b><span>Ocupación</span></div>
        </div>
        <div class="hint">${estadoTexto}</div>
      </div>
    </div>
    <div class="stat-row wrap" style="margin-bottom:16px">
      ${BOX_SIZES.map((s) => `<div class="stat-box"><b>${bySize[s]}</b><span>Caja ${boxSizeLabel(s)}</span></div>`).join("")}
      <div class="stat-box"><b>${totalQty}</b><span>Total de cajas</span></div>
    </div>
    <div class="detail-grid" style="margin-bottom:16px">
      <div class="panel">
        <div class="panel-head"><h3>Tiempo estimado</h3></div>
        <div class="kv"><span>Preparación</span><b>${fmtMinutes(time.prep)}</b></div>
        ${multiPlan.sizesUsed.map((s) => `<div class="kv"><span>Armado Caja ${esc(boxSizeLabel(s))} (${bySize[s]} × ${settings.boxMinutes[s] ?? 0} min)</span><b>${fmtMinutes(bySize[s] * (settings.boxMinutes[s] ?? 0))}</b></div>`).join("")}
        ${settings.packMinutes ? `<div class="kv"><span>Cierre / embalaje</span><b>${fmtMinutes(time.pack)}</b></div>` : ""}
        <div class="kv"><span>Total</span><b>${fmtMinutes(time.trabajoTotal)}</b></div>
        <div class="meter" style="margin-top:10px"><div class="meter-fill ${occPct >= 100 ? "st-red" : occPct >= 80 ? "st-orange" : "st-green"}" style="width:${Math.min(100, occPct)}%"></div></div>
        <div class="hint" style="margin-top:6px">Jornada disponible: ${settings.dailyHours} h · Ocupación: ${occPct.toFixed(1)}%</div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Consumo de inventario</h3></div>
        ${multiPlan.rows.length ? multiPlan.rows.map((r) => `
          <div class="kv"><span>${esc(r.name)}</span><b>${r.stockAvailable} → ${r.stockAvailable - r.qtyNeeded}${r.diff < 0 ? ` <span class="badge st-red">Faltan ${Math.abs(r.diff)}</span>` : ""}</b></div>
        `).join("") : `<div class="hint">${multiPlan.missingConfigs.length ? `Configurá los productos de la caja ${esc(multiPlan.missingConfigs.map((s) => boxSizeLabel(s)).join(", "))} primero.` : "Agregá una cantidad para ver el consumo de inventario."}</div>`}
      </div>
    </div>
    ${multiPlan.rows.length ? `
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>Productos necesarios (${totalQty} cajas: ${multiPlan.sizesUsed.map((s) => boxSizeLabel(s)).join(", ")})</h3></div>
      <div style="overflow-x:auto"><table class="mini-table">
        <thead><tr><th>Producto</th><th>SKU</th><th style="text-align:right">Necesario</th><th style="text-align:right">Stock disponible</th><th style="text-align:right">Diferencia</th><th>Estado</th></tr></thead>
        <tbody>${multiPlan.rows.map((r) => `<tr>
          <td>${esc(r.name)}</td>
          <td>${esc(r.sku || "—")}</td>
          <td style="text-align:right">${r.qtyNeeded}</td>
          <td style="text-align:right">${r.stockAvailable}</td>
          <td style="text-align:right">${r.diff}</td>
          <td>${r.ok ? `<span class="badge st-green">✓</span>` : `<span class="badge st-red">⚠ Faltan ${Math.abs(r.diff)}</span>`}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>` : ""}
    <div class="form-actions" style="border-top:none;padding-top:0;justify-content:flex-start">
      <button class="btn btn-primary" data-action="prod-confirm" ${canConfirm ? "" : "disabled"}>Confirmar producción</button>
    </div>
  `;
}

function viewProduccionConfigurar() {
  const size = produccionConfigSize;
  const config = boxConfigForSize(size);
  const items = config ? boxConfigItems(config.id) : [];
  const settings = productionSettings();
  return `
    <div class="chip-row">${BOX_SIZES.map((s) => `<button class="chip ${size === s ? "active" : ""}" data-prod-config-size="${s}">Caja ${boxSizeLabel(s)}</button>`).join("")}</div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>Composición — Caja ${esc(boxSizeLabel(size))}</h3><button class="btn btn-primary btn-sm" data-action="open-modal" data-modal="prod-config-item" data-size="${size}">+ Agregar producto</button></div>
      ${items.length ? `<div style="overflow-x:auto"><table class="mini-table">
        <thead><tr><th>Producto</th><th>SKU</th><th style="text-align:right">Cantidad por caja</th><th></th></tr></thead>
        <tbody>${items.map((it) => {
          const p = getById("products", it.productId);
          return `<tr>
            <td>${esc(p ? p.name : "(producto eliminado)")}</td>
            <td>${esc(p?.sku || "—")}</td>
            <td style="text-align:right">${it.quantity}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-ghost btn-sm" data-action="open-modal" data-modal="prod-config-item" data-id="${it.id}" data-size="${size}">Editar</button>
              <button class="btn btn-ghost btn-sm" data-action="prod-config-item-delete" data-id="${it.id}">Eliminar</button>
            </td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>` : emptyState("📦", `La caja ${boxSizeLabel(size)} todavía no tiene productos`, "Agregá los productos que la componen y en qué cantidad.", `<button class="btn btn-primary btn-sm" data-action="open-modal" data-modal="prod-config-item" data-size="${size}">+ Agregar producto</button>`)}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Tiempos de producción</h3><button class="btn btn-ghost btn-sm" data-action="open-modal" data-modal="prod-settings">⚙️ Configurar</button></div>
      <div class="stat-row wrap">
        ${BOX_SIZES.map((s) => `<div class="stat-box"><b>${settings.boxMinutes[s] ?? 0}</b><span>Min. caja ${boxSizeLabel(s)}</span></div>`).join("")}
        <div class="stat-box"><b>${settings.prepMinutes}</b><span>Prep. por lote (min)</span></div>
        <div class="stat-box"><b>${settings.dailyHours}</b><span>Horas / jornada</span></div>
      </div>
    </div>
  `;
}

function viewProduccionHistorial() {
  const orders = [...state.production_orders].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return `
    <div class="panel">
      <div class="panel-head"><h3>Historial de producción</h3></div>
      ${orders.length ? `<div style="overflow-x:auto"><table class="mini-table">
        <thead><tr><th>Fecha</th><th>Orden</th><th>Caja</th><th style="text-align:right">Cantidad</th><th>Tiempo estimado</th><th>Tiempo real</th><th>Estado</th></tr></thead>
        <tbody>${orders.map((o) => `<tr>
          <td>${fmtDateTime(o.createdAt)}</td>
          <td><a href="#/produccion/${o.id}" class="link-more">${esc(o.code || o.id.slice(0, 8))}</a></td>
          <td>${esc(boxSizeLabel(o.boxSize))}</td>
          <td style="text-align:right">${o.quantity}</td>
          <td>${fmtMinutes(o.estimatedMinutes)}</td>
          <td>${o.actualMinutes != null ? fmtMinutes(o.actualMinutes) : "—"}</td>
          <td>${statusBadge(PRODUCTION_STATUS_META[o.status])}</td>
        </tr>`).join("")}</tbody>
      </table></div>` : emptyState("🏭", "Sin producciones registradas", "Cuando confirmes una producción, va a aparecer acá.")}
    </div>
  `;
}

function viewProduccionOrderDetail(id) {
  const o = getById("production_orders", id);
  if (!o) return emptyState("🏭", "Orden de producción no encontrada", "");
  const nextStatus = PRODUCTION_FLOW[PRODUCTION_FLOW.indexOf(o.status) + 1];
  const desvio = (o.actualMinutes != null && o.estimatedMinutes != null) ? o.actualMinutes - o.estimatedMinutes : null;
  return `
  <div class="detail-view">
    <div class="detail-head">
      <div><a href="#/produccion" class="back-link">← Producción</a><h2>${esc(o.code || o.id.slice(0, 8))}</h2>
        <div class="detail-sub">Caja ${esc(boxSizeLabel(o.boxSize))} · ${o.quantity} unidades ${statusBadge(PRODUCTION_STATUS_META[o.status])}</div>
      </div>
      <div class="detail-actions">
        ${nextStatus && o.status !== "cancelada" ? `<button class="btn btn-primary" data-action="prod-advance" data-id="${o.id}">Avanzar a: ${PRODUCTION_STATUS_META[nextStatus].label} →</button>` : ""}
        ${!["finalizada", "cancelada"].includes(o.status) ? `<button class="btn btn-secondary" data-action="open-modal" data-modal="prod-real-time" data-id="${o.id}">Registrar tiempo real</button>` : ""}
        ${!["finalizada", "cancelada"].includes(o.status) ? `<button class="btn btn-ghost" data-action="prod-cancel" data-id="${o.id}">Cancelar</button>` : ""}
      </div>
    </div>
    <div class="detail-grid">
      <div class="panel">
        <div class="panel-head"><h3>Tiempos</h3></div>
        <div class="kv"><span>Tiempo estimado</span><b>${fmtMinutes(o.estimatedMinutes)}</b></div>
        <div class="kv"><span>Tiempo real</span><b>${o.actualMinutes != null ? fmtMinutes(o.actualMinutes) : "—"}</b></div>
        ${desvio != null ? `<div class="kv"><span>Desvío</span><b>${desvio >= 0 ? "+" : "−"}${fmtMinutes(Math.abs(desvio))}</b></div>` : ""}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Resumen</h3></div>
        <div class="stat-row">
          <div class="stat-box"><b>${o.quantity}</b><span>Cajas</span></div>
          <div class="stat-box"><b>${esc(boxSizeLabel(o.boxSize))}</b><span>Tamaño</span></div>
          <div class="stat-box"><b>${(o.items || []).reduce((s, i) => s + (i.qtyNeeded || 0), 0)}</b><span>Productos</span></div>
        </div>
        ${o.notes ? `<div class="kv-notes"><span>Observaciones</span><p>${esc(o.notes)}</p></div>` : ""}
      </div>
      <div class="panel span2">
        <div class="panel-head"><h3>Productos consumidos</h3></div>
        <div style="overflow-x:auto"><table class="mini-table">
          <thead><tr><th>Producto</th><th style="text-align:right">Cant. x caja</th><th style="text-align:right">Consumo total</th></tr></thead>
          <tbody>${(o.items || []).map((i) => `<tr><td>${esc(i.name)}</td><td style="text-align:right">${i.qtyPerBox}</td><td style="text-align:right">${i.qtyNeeded}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>
    </div>
  </div>`;
}

/** Confirma la planificación de `produccionPlan.lines` (una o varias líneas
 * de tamaño de caja): revalida stock CONSOLIDADO por producto entre todos
 * los tamaños de la tanda (para que, por ejemplo, dos tamaños que comparten
 * un mismo insumo no se pisen entre sí), crea una orden de producción por
 * cada tamaño, descuenta inventario por FEFO (mismo mecanismo que
 * Inventario) y da de alta las cajas producidas como producto terminado. */
async function confirmProduction() {
  const lines = produccionPlan.lines
    .map((l) => ({ size: l.size, quantity: Math.max(0, Number(l.quantity) || 0) }))
    .filter((l) => l.quantity > 0);
  const bySize = produccionPlanBySize();
  const totalQty = BOX_SIZES.reduce((s, sz) => s + bySize[sz], 0);
  const settings = productionSettings();
  const multiPlan = computeMultiBoxPlan(bySize);
  if (!lines.length || totalQty <= 0) { toast("Ingresá al menos una cantidad de cajas antes de confirmar", "warn"); return; }
  if (!multiPlan.hasAllConfigs) { toast(`Configurá las cajas y una cantidad válida antes de confirmar (faltan: ${multiPlan.missingConfigs.map((s) => boxSizeLabel(s)).join(", ")})`, "warn"); return; }

  // Revalidar y reservar stock por PRODUCTO combinando todos los tamaños de
  // la tanda antes de persistir nada (puede haber cambiado desde que se
  // armó la planificación).
  const allocations = [];
  for (const row of multiPlan.rows) {
    const { alloc, remaining } = fefoAllocate(row.productId, row.qtyNeeded);
    if (remaining > 0) {
      toast(`Stock insuficiente para confirmar: faltan ${remaining} de ${row.name}`, "warn");
      return;
    }
    allocations.push({ row, alloc });
  }

  // Con un solo tamaño se mantiene el formato de código de siempre
  // (OP-00N); con varios, se agrupan bajo el mismo número de tanda con un
  // sufijo por tamaño (OP-00N-S, OP-00N-L, ...).
  const batchCode = `OP-${String(state.production_orders.length + 1).padStart(3, "0")}`;
  const multiSize = lines.length > 1;
  const resumenLineas = lines.map((l) => `Caja ${boxSizeLabel(l.size)} x${l.quantity}`).join(", ");
  const createdOrders = [];

  for (const line of lines) {
    const linePlan = computeBoxPlan(line.size, line.quantity);
    const time = computeProductionTime(line.size, line.quantity, settings);
    const code = multiSize ? `${batchCode}-${line.size}` : batchCode;
    const order = {
      id: uid("pro"), code, boxSize: line.size, boxConfigId: linePlan.config.id, quantity: line.quantity,
      items: linePlan.items.map((r) => ({ productId: r.productId, name: r.name, sku: r.sku, qtyPerBox: r.qtyPerBox, qtyNeeded: r.qtyNeeded })),
      status: "planificada", estimatedMinutes: time.total, actualMinutes: null,
      startedAt: null, finishedAt: null,
      notes: multiSize ? `Parte de la tanda ${batchCode} (${resumenLineas}).` : "",
      history: [{ from: null, to: "planificada", date: nowISO() }],
    };
    await persist("production_orders", order);
    createdOrders.push(order);
  }

  // Descuenta stock una sola vez por producto (ya consolidado entre todos
  // los tamaños) usando la asignación FEFO validada arriba.
  for (const { row, alloc } of allocations) {
    for (const a of alloc) {
      const previousQty = a.lot.quantity;
      const newQty = previousQty - a.qty;
      await persist("inventory_lots", { ...a.lot, quantity: newQty });
      await registerMovement({ productId: row.productId, lotId: a.lot.id, type: "produccion", quantity: a.qty, previousQty, newQty, reason: `Producción ${batchCode} — ${resumenLineas}`, relatedDocument: batchCode });
    }
  }

  // Las cajas producidas quedan como un producto terminado más en Inventario
  // (reutiliza products/inventory_lots — no crea una estructura paralela),
  // una por cada tamaño de la tanda.
  for (const line of lines) {
    const sku = `CAJA-${line.size.toUpperCase()}`;
    let boxProduct = state.products.find((p) => p.sku === sku && p.categoria === "Caja terminada");
    if (!boxProduct) {
      boxProduct = {
        id: uid("prd"), name: `Caja ${boxSizeLabel(line.size)}`, sku, categoria: "Caja terminada", supplierId: null,
        unit: "und", packageSize: null, minQty: null, maxQty: null, optimalQty: null,
        manejaLote: true, manejaVencimiento: false, diasAlerta: null,
        notes: "Producto terminado generado automáticamente por el módulo de Producción.",
      };
      await persist("products", boxProduct);
    }
    const lineCode = multiSize ? `${batchCode}-${line.size}` : batchCode;
    const boxLot = {
      id: uid("lot"), productId: boxProduct.id, quantity: line.quantity, cantidadInicial: line.quantity, cantidadComprometida: 0,
      numeroLote: lineCode, fechaElaboracion: todayISO(), deposito: null, bloqueado: false, motivoBloqueo: null,
      remito: null, ordenCompra: lineCode, fechaRecepcion: todayISO(), costoUnitario: null, expiryDate: null,
    };
    await persist("inventory_lots", boxLot);
    await registerMovement({ productId: boxProduct.id, lotId: boxLot.id, type: "recepcion", quantity: line.quantity, previousQty: 0, newQty: line.quantity, reason: `Producción ${lineCode} — Caja ${boxSizeLabel(line.size)} x${line.quantity}`, relatedDocument: lineCode });
  }

  toast(multiSize
    ? `Producción ${batchCode} confirmada (${resumenLineas}) — stock descontado y cajas cargadas en Inventario`
    : `Producción ${batchCode} confirmada — stock descontado y caja cargada en Inventario`);
  if (createdOrders.length === 1) {
    location.hash = `#/produccion/${createdOrders[0].id}`;
  } else {
    produccionTab = "historial";
    location.hash = "#/produccion";
    renderApp();
  }
}

async function advanceProductionStatus(id) {
  const o = getById("production_orders", id);
  if (!o) return;
  const next = PRODUCTION_FLOW[PRODUCTION_FLOW.indexOf(o.status) + 1];
  if (!next) return;
  const rec = { ...o, status: next, history: [...(o.history || []), { from: o.status, to: next, date: nowISO() }] };
  if (next === "en_produccion" && !rec.startedAt) rec.startedAt = nowISO();
  if (next === "finalizada" && !rec.finishedAt) rec.finishedAt = nowISO();
  await persist("production_orders", rec);
  toast(`${o.code} → ${PRODUCTION_STATUS_META[next].label}`);
  renderApp();
}
async function cancelProductionOrder(id) {
  const o = getById("production_orders", id);
  if (!o) return;
  const rec = { ...o, status: "cancelada", history: [...(o.history || []), { from: o.status, to: "cancelada", date: nowISO() }] };
  await persist("production_orders", rec);
  toast("Producción cancelada");
  renderApp();
}

/* ---------------------------------------------------------------------------
   14.7 SIMULADOR DE PRODUCCIÓN
   Permite cargar una tanda de pedidos (número, cliente, fecha, caja,
   cantidad) y simular cuánto trabajo representa ANTES de producir: consolida
   por tamaño de caja, calcula productos necesarios reutilizando las mismas
   recetas (box_configs/box_config_items) e Inventario (productTotalQty) que
   ya usa 14.6, y estima tiempo + horas-hombre + ocupación de jornada según
   la cantidad de personas.

   Es puramente una SIMULACIÓN: sólo lee datos existentes (products,
   inventory_lots, box_configs, orders). Nunca descuenta stock ni registra
   movimientos — eso sigue siendo exclusivo de confirmProduction() (14.6).
   La tanda en sí (simuladorPedidos) vive únicamente en memoria del navegador
   para esta sesión: no se persiste en Supabase ni crea tablas nuevas, para
   no generar datos ficticios permanentes. El único punto de contacto con
   "Pedidos" es de sólo lectura (adaptador no destructivo): al agregar un
   pedido a la tanda se puede elegir un pedido real para copiar
   número/cliente/fecha, sin modificar ni leer su relación con cajas (los
   pedidos reales todavía no tienen ese concepto).
   ------------------------------------------------------------------------- */
let simuladorPedidos = []; // [{id, numero, cliente, fechaEntrega, size, quantity}] — sólo en memoria
let simuladorPeople = 2;
let simuladorStart = null; // "HH:MM"; null = usa jornadaInicio de la config
let simuladorCode = null; // "TP-001"… generado al agregar el primer pedido, sólo cosmético
let simuladorCounter = 0;

function parseHHMM(str) {
  const [h, m] = (str || "00:00").split(":").map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
}
function fmtHHMM(totalMin) {
  const m = Math.round(((totalMin % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
/** Eficiencia configurable por cantidad de personas (14.7 punto 8): más
 * personas no siempre reducen el tiempo proporcionalmente. Para cantidades
 * no configuradas explícitamente, extrapola bajando 5% por persona extra
 * desde el último valor conocido, con piso de 50%. */
function efficiencyFor(people, settings) {
  const s = settings || productionSettings();
  const n = Math.max(1, Math.round(people || 1));
  if (s.efficiencyByPeople[n] != null) return s.efficiencyByPeople[n];
  const known = Object.keys(s.efficiencyByPeople).map(Number).filter((k) => !isNaN(k)).sort((a, b) => a - b);
  const last = known.length ? known[known.length - 1] : 1;
  const lastVal = s.efficiencyByPeople[last] ?? 100;
  return Math.max(50, lastVal - (n - last) * 5);
}
function jornadaMinutosProductivos(settings) {
  const s = settings || productionSettings();
  const bruto = Math.max(0, parseHHMM(s.jornadaFin) - parseHHMM(s.jornadaInicio));
  return Math.max(0, bruto - (s.descansoMin || 0));
}

/** Agrupa los pedidos de la tanda por tamaño de caja — no trata cada pedido
 * como una producción independiente si comparten tamaño (14.7 punto 3). */
function simuladorConsolidado() {
  const bySize = { estandar: 0, navidena: 0, valija: 0 };
  simuladorPedidos.forEach((p) => { bySize[p.size] = (bySize[p.size] || 0) + (Number(p.quantity) || 0); });
  return { bySize, totalCajas: BOX_SIZES.reduce((s, sz) => s + bySize[sz], 0) };
}
/** Productos necesarios para TODA la tanda (mezcla de tamaños), reutilizando
 * las recetas ya configuradas en "Configurar cajas". Cálculo puro, de sólo
 * lectura — nunca descuenta stock. */
function computeMultiBoxPlan(bySize) {
  const sizesUsed = BOX_SIZES.filter((s) => (bySize[s] || 0) > 0);
  const missingConfigs = [];
  const totals = new Map();
  sizesUsed.forEach((size) => {
    const config = boxConfigForSize(size);
    const items = config ? boxConfigItems(config.id) : [];
    if (!config || !items.length) { missingConfigs.push(size); return; }
    items.forEach((it) => {
      const p = getById("products", it.productId);
      const prev = totals.get(it.productId) || { productId: it.productId, name: p ? p.name : "(producto eliminado)", sku: p ? p.sku : null, qtyNeeded: 0 };
      prev.qtyNeeded += (it.quantity || 0) * bySize[size];
      totals.set(it.productId, prev);
    });
  });
  const rows = Array.from(totals.values()).map((r) => {
    const stockAvailable = productTotalQty(r.productId);
    return { ...r, stockAvailable, diff: stockAvailable - r.qtyNeeded, ok: stockAvailable - r.qtyNeeded >= 0 };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const worst = rows.filter((r) => !r.ok).sort((a, b) => a.diff - b.diff)[0] || null;
  return {
    rows, missingConfigs, sizesUsed,
    hasAllConfigs: missingConfigs.length === 0,
    stockOk: rows.every((r) => r.ok),
    totalUnits: rows.reduce((s, r) => s + r.qtyNeeded, 0),
    limitingProduct: worst,
  };
}
/** Desglose de tiempo de la tanda: preparación fija + armado (suma por
 * tamaño × minutos configurados) + cierre/embalaje. "Trabajo total" es la
 * cantidad de horas-hombre de referencia (a 1 persona, 100% eficiencia). */
function computeSimTime(bySize, settings) {
  const s = settings || productionSettings();
  const totalCajas = BOX_SIZES.reduce((sum, sz) => sum + (bySize[sz] || 0), 0);
  const armado = BOX_SIZES.reduce((sum, sz) => sum + (bySize[sz] || 0) * (s.boxMinutes[sz] ?? 0), 0);
  const prep = totalCajas > 0 ? s.prepMinutes : 0;
  const pack = totalCajas > 0 ? (s.packMinutes || 0) : 0;
  return { prep, armado, pack, trabajoTotal: prep + armado + pack };
}
/** Para una cantidad de personas dada: tiempo estimado (calendario) aplicando
 * la eficiencia configurada, y ocupación de la jornada. "horasHombre" es
 * siempre el trabajo total de referencia (no cambia con la cantidad de
 * personas — ver 14.7 punto 6). */
function computeScenario(trabajoTotalMin, people, settings) {
  const s = settings || productionSettings();
  const n = Math.max(1, Math.round(people || 1));
  const eficiencia = efficiencyFor(n, s);
  const tiempoEstimado = trabajoTotalMin / (n * (eficiencia / 100));
  const jornadaMin = jornadaMinutosProductivos(s);
  return {
    people: n, eficiencia, tiempoEstimado, horasHombre: trabajoTotalMin,
    ocupacion: jornadaMin > 0 ? (tiempoEstimado / jornadaMin) * 100 : 0,
  };
}
function computeFinalizacion(tiempoEstimadoMin, settings, startOverride) {
  const s = settings || productionSettings();
  const startMin = parseHHMM(startOverride || s.jornadaInicio);
  const endMin = startMin + Math.max(0, tiempoEstimadoMin || 0);
  return { startStr: fmtHHMM(startMin), endStr: fmtHHMM(endMin) };
}
/** Identifica qué limita la tanda: sin pedidos, recetas faltantes, stock, o
 * tiempo vs. jornada disponible (14.7 punto 10), en ese orden de prioridad. */
function simuladorBottleneck(multiPlan, scenario, jornadaMin) {
  if (!multiPlan.sizesUsed.length) return { type: "vacio", label: "Agregá pedidos a la tanda para simular." };
  if (!multiPlan.hasAllConfigs) return { type: "config", label: `Faltan recetas configuradas para: ${multiPlan.missingConfigs.map((s) => `Caja ${boxSizeLabel(s)}`).join(", ")}.` };
  if (!multiPlan.stockOk && multiPlan.limitingProduct) {
    const r = multiPlan.limitingProduct;
    return { type: "stock", label: `Stock — ${r.name}`, detail: `Disponible: ${r.stockAvailable} · Necesario: ${r.qtyNeeded} · Faltan: ${Math.abs(r.diff)}.` };
  }
  if (scenario.tiempoEstimado > jornadaMin) {
    return { type: "tiempo", label: "Tiempo de producción", detail: `La tanda requiere ${fmtMinutes(scenario.tiempoEstimado)} y la jornada disponible es ${fmtMinutes(jornadaMin)} (faltan ${fmtMinutes(scenario.tiempoEstimado - jornadaMin)}).` };
  }
  return { type: "ninguno", label: "Sin cuello de botella detectado" };
}
function simuladorEstado(multiPlan, bottleneck, scenario, jornadaMin) {
  if (!multiPlan.sizesUsed.length) return { cls: "st-gray", label: "—", texto: "Agregá pedidos para empezar a simular." };
  if (!multiPlan.hasAllConfigs || !multiPlan.stockOk) return { cls: "st-red", label: "🔴 No", texto: bottleneck.detail || bottleneck.label };
  if (scenario.tiempoEstimado > jornadaMin) return { cls: "st-orange", label: "⚠ Ajustado", texto: `Producción posible, pero no entra en la jornada disponible (faltan ${fmtMinutes(scenario.tiempoEstimado - jornadaMin)}).` };
  return { cls: "st-green", label: "✓ Sí", texto: "La tanda entra en la jornada disponible y el stock alcanza." };
}

function viewProduccionSimulador() {
  const settings = productionSettings();
  const consolidado = simuladorConsolidado();
  const multiPlan = computeMultiBoxPlan(consolidado.bySize);
  const simTime = computeSimTime(consolidado.bySize, settings);
  const scenario = computeScenario(simTime.trabajoTotal, simuladorPeople, settings);
  const jornadaMin = jornadaMinutosProductivos(settings);
  const finalizacion = computeFinalizacion(scenario.tiempoEstimado, settings, simuladorStart);
  const bottleneck = simuladorBottleneck(multiPlan, scenario, jornadaMin);
  const estado = simuladorEstado(multiPlan, bottleneck, scenario, jornadaMin);

  if (!simuladorPedidos.length) {
    return `<div class="panel">
      <div class="panel-head"><h3>Simulador de producción</h3><button class="btn btn-primary btn-sm" data-action="open-modal" data-modal="sim-pedido">+ Agregar pedido</button></div>
      ${emptyState("🧮", "Armá una tanda para simular", "Cargá los pedidos (cliente, caja y cantidad) y el simulador calcula productos necesarios, tiempo, horas-hombre y si entra en la jornada — sin tocar el stock real.", `<button class="btn btn-primary btn-sm" data-action="open-modal" data-modal="sim-pedido">+ Agregar pedido</button>`)}
    </div>`;
  }

  return `
    <div class="kpi-hero-row" style="margin:0 0 16px">
      ${heroKpiCard("Cajas en la tanda", consolidado.totalCajas, [{ label: "Pedidos", value: simuladorPedidos.length }, { label: "Productos", value: Math.round(multiPlan.totalUnits) }])}
      <div class="panel">
        <div class="panel-head"><h3>${simuladorCode ? esc(simuladorCode) : "Simulación de producción"}</h3><span class="badge ${estado.cls}">${estado.label}</span></div>
        <div class="stat-row wrap">
          <div class="stat-box"><b>${fmtMinutes(simTime.trabajoTotal)}</b><span>Trabajo total (h-h)</span></div>
          <div class="stat-box"><b>${simuladorPeople}</b><span>Personas</span></div>
          <div class="stat-box"><b>${fmtMinutes(scenario.tiempoEstimado)}</b><span>Tiempo estimado</span></div>
          <div class="stat-box"><b>${Math.round(scenario.ocupacion)}%</b><span>Capacidad utilizada</span></div>
          <div class="stat-box"><b>${finalizacion.startStr}</b><span>Inicio</span></div>
          <div class="stat-box"><b>${finalizacion.endStr}</b><span>Fin estimado</span></div>
        </div>
        <div class="hint">${esc(estado.texto)}</div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>Pedidos de la tanda (${simuladorPedidos.length})</h3>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" data-action="sim-reset">Nueva simulación</button>
          <button class="btn btn-primary btn-sm" data-action="open-modal" data-modal="sim-pedido">+ Agregar pedido</button>
        </div>
      </div>
      <div style="overflow-x:auto"><table class="mini-table">
        <thead><tr><th>N° pedido</th><th>Cliente</th><th>Entrega</th><th>Caja</th><th style="text-align:right">Cantidad</th><th></th></tr></thead>
        <tbody>${simuladorPedidos.map((p) => `<tr>
          <td>${esc(p.numero)}</td>
          <td>${esc(p.cliente)}</td>
          <td>${p.fechaEntrega ? fmtDate(p.fechaEntrega) : "—"}</td>
          <td>${esc(p.size)}</td>
          <td style="text-align:right">${p.quantity}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-ghost btn-sm" data-action="open-modal" data-modal="sim-pedido" data-id="${p.id}">Editar</button>
            <button class="btn btn-ghost btn-sm" data-action="sim-pedido-delete" data-id="${p.id}">Quitar</button>
          </td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>Producción total consolidada</h3></div>
      <div class="stat-row wrap">
        ${BOX_SIZES.map((s) => `<div class="stat-box"><b>${consolidado.bySize[s] || 0}</b><span>Caja ${boxSizeLabel(s)}</span></div>`).join("")}
        <div class="stat-box"><b>${consolidado.totalCajas}</b><span>Total de cajas</span></div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>Productos necesarios</h3></div>
      ${multiPlan.missingConfigs.length ? `<div class="hint" style="margin-bottom:8px">⚠ Faltan recetas configuradas para: ${multiPlan.missingConfigs.map((s) => `Caja ${boxSizeLabel(s)}`).join(", ")}. Andá a "Configurar cajas".</div>` : ""}
      ${multiPlan.rows.length ? `<div style="overflow-x:auto"><table class="mini-table">
        <thead><tr><th>Producto</th><th style="text-align:right">Necesario total</th><th style="text-align:right">Stock actual</th><th style="text-align:right">Stock restante</th><th>Estado</th></tr></thead>
        <tbody>${multiPlan.rows.map((r) => `<tr>
          <td>${esc(r.name)}</td>
          <td style="text-align:right">${r.qtyNeeded}</td>
          <td style="text-align:right">${r.stockAvailable}</td>
          <td style="text-align:right">${r.diff}</td>
          <td>${r.ok ? `<span class="badge st-green">✓</span>` : `<span class="badge st-red">⚠ Faltan ${Math.abs(r.diff)}</span>`}</td>
        </tr>`).join("")}</tbody>
      </table></div>` : `<div class="hint">Agregá pedidos con cajas configuradas para ver el consumo de inventario.</div>`}
    </div>

    <div class="detail-grid" style="margin-bottom:16px">
      <div class="panel">
        <div class="panel-head"><h3>Personas disponibles</h3><button class="btn btn-ghost btn-sm" data-action="open-modal" data-modal="prod-settings">⚙️ Eficiencia / jornada</button></div>
        <div class="form-grid">
          <label>Cantidad de personas<select class="input" id="sim-people">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}" ${simuladorPeople === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
          <label>Hora de inicio<input class="input" type="time" id="sim-start" value="${simuladorStart || settings.jornadaInicio}" /></label>
        </div>
        <div class="stat-row wrap" style="margin-top:4px">
          <div class="stat-box"><b>${Math.round(scenario.eficiencia)}%</b><span>Eficiencia (${simuladorPeople}p)</span></div>
          <div class="stat-box"><b>${fmtMinutes(jornadaMin)}</b><span>Jornada disponible</span></div>
          <div class="stat-box"><b>${settings.descansoMin} min</b><span>Descanso</span></div>
        </div>
        <div class="meter" style="margin-top:10px"><div class="meter-fill ${scenario.ocupacion >= 100 ? "st-red" : scenario.ocupacion >= 80 ? "st-orange" : "st-green"}" style="width:${Math.min(100, scenario.ocupacion)}%"></div></div>
        <div class="hint" style="margin-top:6px">Capacidad utilizada: ${scenario.ocupacion.toFixed(1)}% · Fin estimado: ${finalizacion.endStr}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Desglose del trabajo</h3></div>
        <div class="kv"><span>Preparación</span><b>${fmtMinutes(simTime.prep)}</b></div>
        <div class="kv"><span>Armado de cajas</span><b>${fmtMinutes(simTime.armado)}</b></div>
        <div class="kv"><span>Cierre / embalaje</span><b>${fmtMinutes(simTime.pack)}</b></div>
        <div class="kv"><span>Trabajo total (horas-hombre)</span><b>${fmtMinutes(simTime.trabajoTotal)}</b></div>
        <div class="hint" style="margin-top:6px">Con ${simuladorPeople} persona${simuladorPeople > 1 ? "s" : ""} (eficiencia ${Math.round(scenario.eficiencia)}%): tiempo estimado ${fmtMinutes(scenario.tiempoEstimado)}.</div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>Comparar escenarios (personas)</h3></div>
      <div style="overflow-x:auto"><table class="mini-table">
        <thead><tr><th style="text-align:right">Personas</th><th style="text-align:right">Tiempo estimado</th><th style="text-align:right">Horas-hombre</th><th style="text-align:right">Ocupación</th><th>Fin estimado</th></tr></thead>
        <tbody>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
          const sc = computeScenario(simTime.trabajoTotal, n, settings);
          const fin = computeFinalizacion(sc.tiempoEstimado, settings, simuladorStart);
          const active = n === simuladorPeople;
          return `<tr style="${active ? "font-weight:700;" : ""}">
            <td style="text-align:right">${active ? "★ " : ""}${n}</td>
            <td style="text-align:right">${fmtMinutes(sc.tiempoEstimado)}</td>
            <td style="text-align:right">${fmtMinutes(sc.horasHombre)}</td>
            <td style="text-align:right">${sc.ocupacion.toFixed(0)}%</td>
            <td>${fin.endStr}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Análisis de capacidad</h3></div>
      ${bottleneck.type === "ninguno" ? `<div class="hint">✓ Sin cuello de botella detectado — la tanda entra en la jornada con el stock actual.</div>`
        : bottleneck.type === "vacio" ? `<div class="hint">${esc(bottleneck.label)}</div>`
        : `<div class="kv"><span>⚠ Cuello de botella</span><b>${esc(bottleneck.label)}</b></div>${bottleneck.detail ? `<div class="hint" style="margin-top:4px">${esc(bottleneck.detail)}</div>` : ""}`}
    </div>
  `;
}

/* ---------------------------------------------------------------------------
   15. INCIDENCIAS
   ------------------------------------------------------------------------- */
let incidenciasFilter = "todas";

function relatedLabel(i) {
  if (i.relatedType === "order") { const o = getById("orders", i.relatedId); return o ? `Pedido #${o.number}` : ""; }
  if (i.relatedType === "purchase_order") { const p = getById("purchase_orders", i.relatedId); return p ? `OC #${p.number}` : ""; }
  if (i.relatedType === "supplier") { const s = getById("suppliers", i.relatedId); return s ? s.name : ""; }
  if (i.relatedType === "transport") { const t = getById("transports", i.relatedId); return t ? t.name : ""; }
  return "";
}
function relatedHref(i) {
  if (i.relatedType === "order") return `#/pedidos/${i.relatedId}`;
  if (i.relatedType === "purchase_order") return `#/compras/${i.relatedId}`;
  if (i.relatedType === "supplier") return `#/proveedores/${i.relatedId}`;
  if (i.relatedType === "transport") return `#/transporte/${i.relatedId}`;
  return "#";
}
function incidentCard(i) {
  return `<a href="#/incidencias/${i.id}" class="order-card">
    <div class="order-card-top"><span class="order-num">${esc(i.title)}</span>${priorityBadge(i.priority)}</div>
    <div class="order-card-addr">${esc(relatedLabel(i))}</div>
    <div class="order-card-bottom">${statusBadge(INCIDENT_META[i.status])}<span class="badge st-gray">${fmtDate(i.date)}</span></div>
  </a>`;
}
function viewIncidencias() {
  const filters = ["todas", ...INCIDENT_FLOW];
  const list = state.incidents.filter((i) => incidenciasFilter === "todas" || i.status === incidenciasFilter).sort((a,b)=> new Date(b.date)-new Date(a.date));
  return `<div class="view-list">
    <div class="list-toolbar"><h3 class="muted-title">Incidencias</h3><a href="#/incidencias/nueva" class="btn btn-primary">+ Nueva incidencia</a></div>
    <div class="chip-row">${filters.map((f) => `<button class="chip ${incidenciasFilter===f?"active":""}" data-incidencias-status="${f}">${f==="todas"?"Todas":INCIDENT_META[f].label}</button>`).join("")}</div>
    ${list.length ? `<div class="card-grid">${list.map(incidentCard).join("")}</div>` : emptyState("⚠️","Sin incidencias","No hay incidencias que coincidan con el filtro.", `<a href="#/incidencias/nueva" class="btn btn-primary">+ Nueva incidencia</a>`)}
  </div>`;
}
function incidentDetail(id) {
  const i = getById("incidents", id);
  if (!i) return emptyState("⚠️", "Incidencia no encontrada", "");
  const nextStatus = INCIDENT_FLOW[INCIDENT_FLOW.indexOf(i.status) + 1];
  return `<div class="detail-view">
    <div class="detail-head"><div><a href="#/incidencias" class="back-link">← Incidencias</a><h2>${esc(i.title)}</h2><div class="detail-sub">${priorityBadge(i.priority)} · ${statusBadge(INCIDENT_META[i.status])}</div></div>
      <div class="detail-actions">${nextStatus ? `<button class="btn btn-primary" data-action="incident-advance" data-id="${i.id}">Avanzar a: ${INCIDENT_META[nextStatus].label} →</button>` : ""}</div>
    </div>
    <div class="detail-grid">
      <div class="panel span2">
        <div class="panel-head"><h3>Descripción</h3></div>
        <p class="desc-text">${esc(i.description || "—")}</p>
        ${i.resolution ? `<div class="kv-notes"><span>Resolución</span><p>${esc(i.resolution)}</p></div>` : `<div class="form-panel-inline"><label>Resolución<textarea class="input" id="incident-resolution-${i.id}" rows="2" placeholder="Describí cómo se resolvió…">${esc(i.resolution||"")}</textarea></label><button class="btn btn-secondary" data-action="incident-resolve" data-id="${i.id}">Guardar resolución</button></div>`}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Datos</h3></div>
        <div class="kv"><span>Fecha</span><b>${fmtDate(i.date)}</b></div>
        <div class="kv"><span>Responsable</span><b>${esc(i.responsible||"—")}</b></div>
        <div class="kv"><span>Relacionado a</span><b>${relatedLabel(i) ? `<a href="${relatedHref(i)}" class="link-more">${esc(relatedLabel(i))}</a>` : "—"}</b></div>
        <div class="kv"><span>Fecha de resolución</span><b>${i.resolutionDate ? fmtDate(i.resolutionDate) : "—"}</b></div>
      </div>
    </div>
  </div>`;
}
function incidentForm() {
  const relTypes = { order: "Pedido", purchase_order: "Orden de compra", supplier: "Proveedor", transport: "Transporte" };
  return `<div class="detail-view">
    <div class="detail-head"><div><a href="#/incidencias" class="back-link">← Incidencias</a><h2>Nueva incidencia</h2></div></div>
    <form class="panel form-panel" data-form="incident">
      <div class="form-grid">
        <label class="span2">Título<input class="input" name="title" required placeholder="Ej: Falta de stock para pedido #1530" /></label>
        <label>Fecha<input class="input" type="date" name="date" value="${todayISO()}" required /></label>
        <label>Prioridad<select class="input" name="priority">${Object.keys(PRIORITY_META).map(p=>`<option value="${p}" ${p==="media"?"selected":""}>${PRIORITY_META[p].label}</option>`).join("")}</select></label>
        <label>Relacionado con<select class="input" name="relatedType" id="incident-reltype">
          <option value="">Ninguno</option>${Object.entries(relTypes).map(([k,v])=>`<option value="${k}">${v}</option>`).join("")}
        </select></label>
        <label>Elemento<select class="input" name="relatedId" id="incident-relid"><option value="">—</option></select></label>
        <label>Responsable<input class="input" name="responsible" value="Alejandro Perona" /></label>
        <label class="span2">Descripción<textarea class="input" name="description" rows="3"></textarea></label>
      </div>
      <div class="form-actions"><a href="#/incidencias" class="btn btn-ghost">Cancelar</a><button type="submit" class="btn btn-primary">Crear incidencia</button></div>
    </form>
  </div>`;
}

/* ---------------------------------------------------------------------------
   16. TAREAS
   ------------------------------------------------------------------------- */
let tareasFilter = "todas";
function taskCard(t) {
  return `<div class="task-card" data-task-id="${t.id}">
    <button class="task-check ${t.status}" data-action="task-cycle" data-id="${t.id}">${t.status === "completada" ? "✓" : t.status === "en_curso" ? "●" : "○"}</button>
    <div class="task-body">
      <div class="task-title ${t.status === "completada" ? "strike" : ""}">${esc(t.title)}</div>
      <div class="task-meta">${fmtDate(t.date)} ${t.time ? "· " + t.time : ""} · ${esc(t.category)}</div>
    </div>
    ${priorityBadge(t.priority)}
  </div>`;
}
function viewTareas() {
  const filters = ["todas", ...TASK_FLOW];
  let list = state.tasks.filter((t) => tareasFilter === "todas" || t.status === tareasFilter);
  list = [...list].sort((a,b) => (a.date+"" + (a.time||"")).localeCompare(b.date+""+(b.time||"")));
  const today = list.filter(t=>t.date===todayISO());
  const rest = list.filter(t=>t.date!==todayISO());
  return `<div class="view-list">
    <div class="list-toolbar"><h3 class="muted-title">Tareas</h3><button class="btn btn-primary" data-action="open-modal" data-modal="task">+ Nueva tarea</button></div>
    <div class="chip-row">${filters.map((f) => `<button class="chip ${tareasFilter===f?"active":""}" data-tareas-status="${f}">${f==="todas"?"Todas":TASK_META[f].label}</button>`).join("")}</div>
    ${today.length ? `<div class="panel"><div class="panel-head"><h3>Hoy</h3></div><div class="task-list">${today.map(taskCard).join("")}</div></div>` : ""}
    <div class="panel"><div class="panel-head"><h3>${today.length?"Próximas":"Todas"}</h3></div>${rest.length ? `<div class="task-list">${rest.map(taskCard).join("")}</div>` : emptyState("✅","Sin tareas","No hay tareas para mostrar.")}</div>
  </div>`;
}

/* ---------------------------------------------------------------------------
   17. REPORTES
   ------------------------------------------------------------------------- */
function svgBar(data, opts = {}) {
  const w = 100, h = opts.h || 44, max = Math.max(1, ...data.map(d => d.value));
  const bw = w / data.length;
  return `<svg viewBox="0 0 ${w} ${h + 14}" class="bar-chart" preserveAspectRatio="none">
    ${data.map((d, i) => {
      const bh = (d.value / max) * h;
      return `<rect x="${i * bw + bw * 0.18}" y="${h - bh}" width="${bw * 0.64}" height="${bh}" rx="1.2" fill="${d.color || "var(--accent)"}"></rect>
        <text x="${i * bw + bw / 2}" y="${h + 9}" font-size="4.6" text-anchor="middle" fill="var(--ink-soft)">${esc(d.label)}</text>
        <text x="${i * bw + bw / 2}" y="${h - bh - 2 < 5 ? h - bh + 6 : h - bh - 2}" font-size="4.6" text-anchor="middle" fill="${h-bh-2<5? 'var(--surface)':'var(--ink)'}" font-weight="700">${d.value}</text>`;
    }).join("")}
  </svg>`;
}
function donut(segments, size=120) {
  const total = segments.reduce((a,s)=>a+s.value,0) || 1;
  let acc = 0;
  const r = 15.9155, cx=21, cy=21;
  const circles = segments.map(s => {
    const frac = s.value/total, dash = frac*100;
    const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="transparent" stroke="${s.color}" stroke-width="5.2" stroke-dasharray="${dash} ${100-dash}" stroke-dashoffset="${-acc}" />`;
    acc += dash;
    return el;
  }).join("");
  return `<svg viewBox="0 0 42 42" style="width:${size}px;height:${size}px;transform:rotate(-90deg)">${circles}</svg>`;
}
/** Ranking de clientes por cantidad de despachos (pedidos), sobre el listado
 * de pedidos que se le pase — no asume un período: quien llama decide si es
 * todo el historial o un rango filtrado. Sólo cuenta pedidos con customerId
 * real (no inventa clientes para pedidos sueltos sin cliente asignado). */
function clientRankingData(orders, limit = 15) {
  const counts = {};
  orders.forEach((o) => {
    if (!o.customerId) return;
    counts[o.customerId] = (counts[o.customerId] || 0) + 1;
  });
  const rows = Object.entries(counts).map(([customerId, count]) => {
    const c = getById("customers", customerId);
    if (!c) return null;
    const loc = c.locationId ? getById("locations", c.locationId) : null;
    const address = loc ? [loc.address, loc.city].filter(Boolean).join(", ") : "";
    return { customer: c, count, address };
  }).filter(Boolean);
  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, limit);
}
function clientRankingHTML(rows, opts = {}) {
  if (!rows.length) return emptyState("🏢", "Sin despachos con cliente asignado", "Todavía no hay pedidos vinculados a un cliente en este período.");
  return `<table class="mini-table"><thead><tr><th>#</th><th>Cliente</th><th>Despachos</th>${opts.showAddress ? "<th>Domicilio habitual</th>" : ""}</tr></thead><tbody>
    ${rows.map((r, i) => `<tr><td>${i + 1}</td><td><a href="#/ubicaciones">${esc(r.customer.name)}</a></td><td><b>${r.count}</b></td>${opts.showAddress ? `<td>${esc(r.address || "—")}</td>` : ""}</tr>`).join("")}
  </tbody></table>`;
}

/** Alias de variantes de escritura del mismo transportista en la columna
 * "Transporte" de la planilla histórica "Caja Business" (importada como
 * texto libre en orders.notes, sin transportId real — ver
 * claude/import-historico-caja-business.md). Sólo junta escrituras
 * inequívocas del mismo nombre; "Carlos" o "Local" solos quedan como están
 * por ser ambiguos. */
const HISTORIC_TRANSPORT_ALIASES = {
  "nico etche": "Nicolás Etchebehere", "nicolas etchebehere": "Nicolás Etchebehere",
  "nico echebehere": "Nicolás Etchebehere", "nicolas echebehere": "Nicolás Etchebehere",
  "nico echebere": "Nicolás Etchebehere", "nicolas etchebere": "Nicolás Etchebehere",
  "nico etchebehere": "Nicolás Etchebehere", "nicolas echebere": "Nicolás Etchebehere",
  "nico": "Nicolás Etchebehere",
  "walter": "Walter Ibarra", "walter ibarra": "Walter Ibarra",
  "marcelo": "Marcelo (moto)", "marcelito": "Marcelo (moto)", "moto marcelo": "Marcelo (moto)",
  "daniel": "Daniel Aguirre", "daniel aguirre": "Daniel Aguirre",
  "terminal": "Terminal (encomienda en ómnibus)", "cba terminal": "Terminal (encomienda en ómnibus)",
  "terminal de caba": "Terminal (encomienda en ómnibus)",
  "carpio": "Carlos Carpio",
  "carlos de francisco": "Carlos de Francisco",
  "bbb": "Bbb",
  "baronetto": "Baroneto",
  "scarello": "Scarelo",
  "el clasico": "El clásico",
};
function stripAccentsLower(s) { return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(); }

/** Ranking de transportes por cantidad de despachos. Cuenta pedidos con
 * transportId real (dispatches hechos con la app), y además — para los ~6224
 * pedidos importados del histórico "Caja Business" que no tienen transportId,
 * sólo texto libre — parsea "Transportista (histórico): …" de orders.notes,
 * normaliza variantes de escritura conocidas y, si el nombre coincide con un
 * transporte ya cargado, suma ahí; si no, lo deja como fila de sólo texto
 * (no vinculada a ningún transportId). */
function transportRankingData(orders, limit = 15) {
  const byTransportId = {};
  const byTextLabel = {};
  orders.forEach((o) => {
    if (o.transportId) {
      byTransportId[o.transportId] = (byTransportId[o.transportId] || 0) + 1;
      return;
    }
    const m = (o.notes || "").match(/Transportista \(histórico\):\s*([^|]+)/);
    if (!m) return;
    const raw = m[1].trim();
    if (!raw) return;
    const label = HISTORIC_TRANSPORT_ALIASES[stripAccentsLower(raw)] || raw;
    const match = state.transports.find((t) => stripAccentsLower(t.name) === stripAccentsLower(label));
    if (match) { byTransportId[match.id] = (byTransportId[match.id] || 0) + 1; return; }
    const key = stripAccentsLower(label);
    byTextLabel[key] = byTextLabel[key] || { label, count: 0 };
    byTextLabel[key].count++;
  });
  const rows = [
    ...Object.entries(byTransportId).map(([id, count]) => { const t = getById("transports", id); return t ? { label: t.name, count, transportId: t.id } : null; }).filter(Boolean),
    ...Object.values(byTextLabel).map((r) => ({ label: r.label, count: r.count, transportId: null })),
  ];
  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, limit);
}
function transportRankingHTML(rows) {
  if (!rows.length) return emptyState("🚚", "Sin despachos con transporte informado", "");
  return `<table class="mini-table"><thead><tr><th>#</th><th>Transporte</th><th>Despachos</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.transportId ? `<a href="#/transporte/${r.transportId}">${esc(r.label)}</a>` : esc(r.label)}</td><td><b>${r.count}</b></td></tr>`).join("")}
  </tbody></table>`;
}

function viewReportes() {
  const orders = state.orders, pos = state.purchase_orders, incs = state.incidents;
  const oStats = { total: orders.length, entregados: orders.filter(o=>o.status==="entregado").length, pendientes: orders.filter(o=>!["entregado","cancelado"].includes(o.status)).length, atrasados: orders.filter(o=>orderUrgency(o).key==="atrasada").length, camino: orders.filter(o=>o.status==="en_camino").length, incidencias: orders.filter(o=>o.status==="incidencia").length };
  const pStats = { generadas: pos.length, recibidas: pos.filter(p=>["recibida","controlada","cerrada"].includes(p.status)).length, transito: pos.filter(p=>p.status==="en_transito").length, atrasadas: pos.filter(p=>poUrgency(p).key==="atrasada").length };
  const incStats = { abiertas: incs.filter(i=>i.status==="abierta").length, tratamiento: incs.filter(i=>i.status==="en_tratamiento").length, resueltas: incs.filter(i=>i.status==="resuelta").length, cerradas: incs.filter(i=>i.status==="cerrada").length };
  const byCategory = {};
  incs.forEach(i => { const k = i.relatedType || "otro"; byCategory[k] = (byCategory[k]||0)+1; });
  const catLabels = { order: "Pedidos", purchase_order: "Compras", supplier: "Proveedores", transport: "Transporte", otro: "Otro" };

  return `<div class="view-list">
    <div class="report-grid">
      <div class="panel">
        <div class="panel-head"><h3>Pedidos</h3></div>
        <div class="stat-row wrap"><div class="stat-box"><b>${oStats.total}</b><span>Total</span></div><div class="stat-box"><b>${oStats.entregados}</b><span>Entregados</span></div><div class="stat-box"><b>${oStats.pendientes}</b><span>Pendientes</span></div><div class="stat-box"><b>${oStats.atrasados}</b><span>Atrasados</span></div><div class="stat-box"><b>${oStats.camino}</b><span>En camino</span></div><div class="stat-box"><b>${oStats.incidencias}</b><span>Incidencias</span></div></div>
        ${svgBar([{label:"Entreg.",value:oStats.entregados,color:"var(--ok)"},{label:"Pend.",value:oStats.pendientes,color:"var(--pending)"},{label:"Atras.",value:oStats.atrasados,color:"var(--danger)"},{label:"Camino",value:oStats.camino,color:"var(--accent)"}])}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Compras</h3></div>
        <div class="stat-row wrap"><div class="stat-box"><b>${pStats.generadas}</b><span>Generadas</span></div><div class="stat-box"><b>${pStats.recibidas}</b><span>Recibidas</span></div><div class="stat-box"><b>${pStats.transito}</b><span>En tránsito</span></div><div class="stat-box"><b>${pStats.atrasadas}</b><span>Atrasadas</span></div></div>
        ${svgBar([{label:"Gener.",value:pStats.generadas,color:"var(--accent)"},{label:"Recib.",value:pStats.recibidas,color:"var(--ok)"},{label:"Tránsito",value:pStats.transito,color:"var(--info)"},{label:"Atras.",value:pStats.atrasadas,color:"var(--danger)"}])}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Incidencias por estado</h3></div>
        <div class="donut-row">
          ${donut([{value:incStats.abiertas,color:"var(--danger)"},{value:incStats.tratamiento,color:"var(--warn)"},{value:incStats.resueltas,color:"var(--info)"},{value:incStats.cerradas,color:"var(--ink-soft)"}])}
          <div class="donut-legend">
            <div><i style="background:var(--danger)"></i>Abiertas <b>${incStats.abiertas}</b></div>
            <div><i style="background:var(--warn)"></i>En tratamiento <b>${incStats.tratamiento}</b></div>
            <div><i style="background:var(--info)"></i>Resueltas <b>${incStats.resueltas}</b></div>
            <div><i style="background:var(--ink-soft)"></i>Cerradas <b>${incStats.cerradas}</b></div>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Incidencias por categoría</h3></div>
        ${svgBar(Object.entries(byCategory).map(([k,v])=>({label:catLabels[k]||k,value:v,color:"var(--accent)"})))}
      </div>
      <div class="panel span2">
        <div class="panel-head"><h3>Top clientes por despachos</h3><span class="hint">Todo el historial</span></div>
        ${clientRankingHTML(clientRankingData(orders, 15), { showAddress: true })}
      </div>
      <div class="panel span2">
        <div class="panel-head"><h3>Top transportes por despachos</h3><span class="hint">Todo el historial</span></div>
        ${transportRankingHTML(transportRankingData(orders, 15))}
      </div>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------------------
   17.5 DASHBOARD GERENCIAL
   Vista exclusiva para Gerencia/Dirección: sólo lectura y análisis, pensada
   para responder en segundos "¿cómo está la operación?". No crea tablas ni
   colecciones nuevas — lee exactamente los mismos datos que ya usan Pedidos,
   Producción, Inventario, Transporte e Incidencias (state.orders,
   state.production_orders, state.products/inventory_lots/stock_movements,
   state.incidents). No modifica ni escribe en ninguno de esos módulos.

   Único dato propio que persiste: los objetivos gerenciales configurables
   (app_settings id "gerencia_objetivos"), siguiendo el mismo patrón que ya
   usan production_settings / alert_thresholds — sólo sirven para comparar
   contra los datos reales, nunca reemplazan ni fabrican un dato real.

   Regla de honestidad de datos (pedida explícitamente): cuando una métrica
   no puede calcularse con los campos que existen hoy en el esquema (ej: no
   hay "personas" en production_orders → no hay horas-hombre real; no hay
   capacidad/costo/km en transports/routes → no hay costo de transporte ni
   km recorridos), se muestra explícitamente "Sin datos disponibles" /
   "Datos insuficientes para calcular" en lugar de estimar o inventar un
   valor.
   ------------------------------------------------------------------------- */
let gerenciaPeriodo = "hoy"; // hoy | ayer | 7d | 30d | mes | mes_ant | custom
let gerenciaCustomFrom = null;
let gerenciaCustomTo = null;

function gerenciaPeriodoRange(periodo) {
  const today = todayISO();
  const back = (n) => { const dt = new Date(); dt.setDate(dt.getDate() - n); return dt.toISOString().slice(0, 10); };
  if (periodo === "ayer") { const y = back(1); return { from: y, to: y, label: "Ayer" }; }
  if (periodo === "7d") return { from: back(6), to: today, label: "Últimos 7 días" };
  if (periodo === "30d") return { from: back(29), to: today, label: "Últimos 30 días" };
  if (periodo === "mes") { const dt = new Date(); return { from: new Date(dt.getFullYear(), dt.getMonth(), 1).toISOString().slice(0, 10), to: today, label: "Este mes" }; }
  if (periodo === "mes_ant") {
    const dt = new Date();
    const from = new Date(dt.getFullYear(), dt.getMonth() - 1, 1);
    const to = new Date(dt.getFullYear(), dt.getMonth(), 0);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), label: "Mes anterior" };
  }
  if (periodo === "custom") {
    const from = gerenciaCustomFrom || today, to = gerenciaCustomTo || today;
    return { from: from <= to ? from : to, to: from <= to ? to : from, label: "Personalizado" };
  }
  return { from: today, to: today, label: "Hoy" };
}
/** Mismo largo de días, inmediatamente anterior al rango — para comparar
 * "esta semana vs. anterior", "este mes vs. mes anterior", etc. de forma
 * genérica sin hardcodear cada caso. */
function gerenciaPreviousRange(range) {
  const from = parseDate(range.from), to = parseDate(range.to);
  const days = Math.round((to - from) / 86400000) + 1;
  const prevTo = new Date(from); prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (days - 1));
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}
function inRangeDate(dateStr, range) {
  if (!dateStr) return false;
  const d = dateStr.slice(0, 10);
  return d >= range.from && d <= range.to;
}
/** Objetivos gerenciales — arquitectura preparada para configurarlos, sin
 * complejidad extra: mismo patrón que productionSettings()/alertThresholds().
 * No son datos reales medidos, son metas editables por Gerencia. */
function gerenciaObjetivos() {
  const row = getById("app_settings", "gerencia_objetivos");
  const v = row?.value || {};
  return {
    cumplimiento: typeof v.cumplimiento === "number" ? v.cumplimiento : 95,
    utilizacion: typeof v.utilizacion === "number" ? v.utilizacion : 80,
    entregasATiempo: typeof v.entregasATiempo === "number" ? v.entregasATiempo : 95,
    productividad: typeof v.productividad === "number" ? v.productividad : null,
  };
}
function orderHistoryDate(o, status) {
  const h = (o.history || []).find((e) => e.to === status);
  return h ? h.date : null;
}
function minutesBetweenISO(a, b) {
  if (!a || !b) return null;
  const diff = (new Date(b) - new Date(a)) / 60000;
  return isFinite(diff) ? diff : null;
}
function gerenciaMissing(reason) {
  return `<div class="ger-missing">${esc(reason || "Sin datos disponibles")}</div>`;
}
/** Clon no animado de kpiCard() — kpiCard() anima con animateCount() a
 * partir de parseInt(data-count), lo que trunca valores compuestos como
 * "92 / 126" o con texto ("Sin datos"). staticKpiCard() reutiliza las mismas
 * clases visuales sin data-count, así el barrido de animateCount() (que
 * selecciona por clase .kpi-value) no lo toca. */
function staticKpiCard(value, label, icon, cls, delay) {
  return `<div class="kpi-card" style="--d:${delay}ms">
    <div class="kpi-icon ${cls}">${icon}</div>
    <div class="ger-kpi-value">${esc(value)}</div>
    <div class="kpi-label">${esc(label)}</div>
  </div>`;
}
function gerenciaMissingCard(label, icon, reason) {
  return `<div class="kpi-card ger-kpi-missing">
    <div class="kpi-icon kpi-blue">${icon}</div>
    <div class="ger-kpi-value ger-missing-value">Sin datos</div>
    <div class="kpi-label">${esc(label)}</div>
    <div class="ger-missing-reason">${esc(reason)}</div>
  </div>`;
}
/** Indicador de variación vs. el período anterior — sólo se muestra cuando
 * ambos valores son reales; nunca compara contra un valor inventado. */
function gerenciaDeltaHTML(current, previous, opts = {}) {
  if (current == null || previous == null) return `<span class="ger-delta ger-delta-na">Sin período anterior para comparar</span>`;
  const diff = current - previous;
  const dec = opts.decimals ?? 1;
  if (Math.abs(diff) < (opts.epsilon ?? 0.05)) return `<span class="ger-delta ger-delta-flat">= Sin cambios vs. período anterior</span>`;
  const higherIsBetter = opts.higherIsBetter !== false;
  const good = higherIsBetter ? diff > 0 : diff < 0;
  const arrow = diff > 0 ? "▲" : "▼";
  return `<span class="ger-delta ${good ? "ger-delta-up" : "ger-delta-down"}">${arrow} ${Math.abs(diff).toFixed(dec)}${opts.suffix || ""} vs. período anterior</span>`;
}
/** Dos series de barras por día (ej: programadas vs. realizadas) — mismo
 * estilo visual que svgBar(), sin duplicar su lógica de un solo valor. */
function svgBarDual(data, opts = {}) {
  const w = 100, h = opts.h || 46, max = Math.max(1, ...data.map((d) => Math.max(d.a, d.b)));
  const bw = w / Math.max(1, data.length);
  const colA = opts.colorA || "var(--ink-faint)", colB = opts.colorB || "var(--accent)";
  return `<svg viewBox="0 0 ${w} ${h + 14}" class="bar-chart" preserveAspectRatio="none">
    ${data.map((d, i) => {
      const gx = i * bw, seg = bw * 0.32;
      const ha = (d.a / max) * h, hb = (d.b / max) * h;
      return `<rect x="${gx + bw * 0.14}" y="${h - ha}" width="${seg}" height="${ha}" rx="1" fill="${colA}"></rect>
        <rect x="${gx + bw * 0.52}" y="${h - hb}" width="${seg}" height="${hb}" rx="1" fill="${colB}"></rect>
        <text x="${gx + bw / 2}" y="${h + 9}" font-size="4.2" text-anchor="middle" fill="var(--ink-soft)">${esc(d.label)}</text>`;
    }).join("")}
  </svg>`;
}

/** Serie diaria (para gráficos) dentro del rango — cajas producidas,
 * entregas programadas y realizadas, todo leído en vivo de los mismos
 * arrays que usan Pedidos/Producción. Recorta a 31 puntos como máximo para
 * no saturar el gráfico si el rango elegido es muy largo. */
function gerenciaSeriesDias(range) {
  const from = parseDate(range.from), to = parseDate(range.to);
  const totalDays = Math.max(1, Math.round((to - from) / 86400000) + 1);
  const days = [];
  for (let i = 0; i < totalDays; i++) {
    const dt = new Date(from); dt.setDate(dt.getDate() + i);
    const iso = dt.toISOString().slice(0, 10);
    const cajas = state.production_orders.filter((o) => o.status === "finalizada" && (o.finishedAt || "").slice(0, 10) === iso).reduce((s, o) => s + (o.quantity || 0), 0);
    const programadas = state.orders.filter((o) => o.expectedDate === iso).length;
    const realizadas = state.orders.filter((o) => o.status === "entregado" && o.actualDeliveryDate === iso).length;
    days.push({ iso, label: dt.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" }), cajas, programadas, realizadas });
  }
  return days.slice(-31);
}

/** Agregación central del dashboard gerencial para un rango de fechas.
 * Cada bloque documenta, en el propio cálculo, de qué dato real sale — no
 * hay ningún valor generado al azar ni copiado de otra parte de la app. */
function gerenciaData(range) {
  const prevRange = gerenciaPreviousRange(range);
  const settings = productionSettings();
  const objetivos = gerenciaObjetivos();

  const ordersInRange = state.orders.filter((o) => inRangeDate(o.orderDate, range));
  const ordersPrev = state.orders.filter((o) => inRangeDate(o.orderDate, prevRange));

  const entregasProgramadas = state.orders.filter((o) => inRangeDate(o.expectedDate, range));
  const entregasRealizadas = state.orders.filter((o) => o.status === "entregado" && inRangeDate(o.actualDeliveryDate, range));
  const entregasRealizadasPrev = state.orders.filter((o) => o.status === "entregado" && inRangeDate(o.actualDeliveryDate, prevRange));
  const entregasATiempo = entregasRealizadas.filter((o) => o.expectedDate && o.actualDeliveryDate && o.actualDeliveryDate <= o.expectedDate);
  const entregasATiempoPrev = entregasRealizadasPrev.filter((o) => o.expectedDate && o.actualDeliveryDate && o.actualDeliveryDate <= o.expectedDate);
  const entregasConDemora = entregasRealizadas.filter((o) => o.expectedDate && o.actualDeliveryDate && o.actualDeliveryDate > o.expectedDate);
  const entregasPendientes = state.orders.filter((o) => !["entregado", "cancelado"].includes(o.status) && inRangeDate(o.expectedDate, range));
  const entregasAtrasadas = state.orders.filter((o) => !["entregado", "cancelado"].includes(o.status) && orderUrgency(o).key === "atrasada" && inRangeDate(o.expectedDate, range));
  const entregasIncidencia = state.orders.filter((o) => o.status === "incidencia" && inRangeDate(o.expectedDate, range));

  const cumplimiento = entregasRealizadas.length ? (entregasATiempo.length / entregasRealizadas.length) * 100 : null;
  const cumplimientoPrev = entregasRealizadasPrev.length ? (entregasATiempoPrev.length / entregasRealizadasPrev.length) * 100 : null;

  // -------- Producción --------
  const prodCreadasRange = state.production_orders.filter((o) => o.status !== "cancelada" && inRangeDate((o.createdAt || "").slice(0, 10), range));
  const prodFinalizadasRange = state.production_orders.filter((o) => o.status === "finalizada" && inRangeDate((o.finishedAt || "").slice(0, 10), range));
  const prodFinalizadasPrev = state.production_orders.filter((o) => o.status === "finalizada" && inRangeDate((o.finishedAt || "").slice(0, 10), prevRange));
  const cajasPlanificadas = prodCreadasRange.reduce((s, o) => s + (o.quantity || 0), 0);
  const cajasRealizadas = prodFinalizadasRange.reduce((s, o) => s + (o.quantity || 0), 0);
  const cajasRealizadasPrev = prodFinalizadasPrev.reduce((s, o) => s + (o.quantity || 0), 0);
  const cajasPendientes = Math.max(0, cajasPlanificadas - cajasRealizadas);
  const bySize = BOX_SIZES.map((size) => ({ size, boxes: prodFinalizadasRange.filter((o) => o.boxSize === size).reduce((s, o) => s + (o.quantity || 0), 0) }));

  const days = Math.max(1, Math.round((parseDate(range.to) - parseDate(range.from)) / 86400000) + 1);
  const capacidadDisponibleMin = settings.dailyHours * 60 * days;
  const minutosUsados = prodFinalizadasRange.reduce((s, o) => s + (typeof o.actualMinutes === "number" ? o.actualMinutes : (o.estimatedMinutes || 0)), 0);
  const capacidadUtilizada = prodFinalizadasRange.length && capacidadDisponibleMin > 0 ? (minutosUsados / capacidadDisponibleMin) * 100 : null;

  const conActual = prodFinalizadasRange.filter((o) => typeof o.actualMinutes === "number");
  const estimadoTotal = conActual.reduce((s, o) => s + (o.estimatedMinutes || 0), 0);
  const realTotal = conActual.reduce((s, o) => s + (o.actualMinutes || 0), 0);
  const desvioPct = conActual.length && estimadoTotal > 0 ? ((realTotal - estimadoTotal) / estimadoTotal) * 100 : null;

  // -------- Costos --------
  // Costo de producción: se calcula sólo sobre los movimientos de stock
  // "produccion" que tienen un lote con costoUnitario cargado en Inventario
  // (campo real, ya existente). Si ningún movimiento del período tiene
  // costo cargado, se marca explícitamente como no disponible.
  const movsProduccion = state.stock_movements.filter((m) => m.type === "produccion" && inRangeDate((m.createdAt || "").slice(0, 10), range));
  let costoProduccion = 0, movsConCosto = 0;
  movsProduccion.forEach((m) => {
    const lot = getById("inventory_lots", m.lotId);
    if (lot && typeof lot.costoUnitario === "number") { costoProduccion += (m.quantity || 0) * lot.costoUnitario; movsConCosto++; }
  });
  const produccionDisponible = movsConCosto > 0;
  const costoPorCaja = produccionDisponible && cajasRealizadas > 0 ? costoProduccion / cajasRealizadas : null;

  const movsMerma = state.stock_movements.filter((m) => m.type === "merma" && inRangeDate((m.createdAt || "").slice(0, 10), range));
  const movsDevolucion = state.stock_movements.filter((m) => m.type === "devolucion" && inRangeDate((m.createdAt || "").slice(0, 10), range));
  const mermaQty = movsMerma.reduce((s, m) => s + (m.quantity || 0), 0);
  const devolucionQty = movsDevolucion.reduce((s, m) => s + (m.quantity || 0), 0);

  // -------- Productividad (tiempos reales, vía el historial de estados) --------
  const tiemposPrep = ordersInRange.map((o) => {
    const a = orderHistoryDate(o, "pendiente") || (o.orderDate ? o.orderDate + "T00:00:00" : null);
    const b = orderHistoryDate(o, "preparado");
    return minutesBetweenISO(a, b);
  }).filter((v) => typeof v === "number" && v >= 0);
  const tiempoPrepProm = tiemposPrep.length ? tiemposPrep.reduce((s, v) => s + v, 0) / tiemposPrep.length : null;

  const tiemposEntrega = entregasRealizadas.map((o) => minutesBetweenISO(orderHistoryDate(o, "despachado"), orderHistoryDate(o, "entregado"))).filter((v) => typeof v === "number" && v >= 0);
  const tiempoEntregaProm = tiemposEntrega.length ? tiemposEntrega.reduce((s, v) => s + v, 0) / tiemposEntrega.length : null;

  return {
    range, prevRange, objetivos, settings,
    pedidos: { total: ordersInRange.length, totalPrev: ordersPrev.length },
    entregas: {
      programadas: entregasProgramadas.length, realizadas: entregasRealizadas.length, realizadasPrev: entregasRealizadasPrev.length,
      pendientes: entregasPendientes.length, atrasadas: entregasAtrasadas.length, aTiempo: entregasATiempo.length,
      conDemora: entregasConDemora.length, conIncidencia: entregasIncidencia.length,
      cumplimiento, cumplimientoPrev,
    },
    produccion: {
      planificadas: cajasPlanificadas, realizadas: cajasRealizadas, realizadasPrev: cajasRealizadasPrev, pendientes: cajasPendientes,
      bySize, capacidadUtilizada, capacidadDisponibleMin, minutosUsados,
      estimadoTotal: conActual.length ? estimadoTotal : null, realTotal: conActual.length ? realTotal : null, desvioPct,
      ordenesCreadas: prodCreadasRange.length,
    },
    costos: { produccionDisponible, costoProduccion: produccionDisponible ? costoProduccion : null, costoPorCaja, mermaQty, mermaCount: movsMerma.length, devolucionQty, devolucionCount: movsDevolucion.length },
    productividad: { tiempoPrepProm, tiempoEntregaProm },
    clientesTop: clientRankingData(ordersInRange, 8),
  };
}

/** Alertas gerenciales — se generan en vivo a partir del estado ACTUAL
 * (no del rango filtrado: una alerta es "ahora", no histórica) de Pedidos,
 * Inventario, Producción e Incidencias. Nunca hay una alerta ficticia ni de
 * relleno: si no se detecta ninguna condición real, se muestra un único
 * ítem "Sin problemas críticos". */
function gerenciaAlertas() {
  const alerts = [];
  const today = todayISO();

  const atrasados = state.orders.filter((o) => !["entregado", "cancelado"].includes(o.status) && orderUrgency(o).key === "atrasada");
  if (atrasados.length) {
    alerts.push({
      level: "red", icon: "📦",
      title: `${atrasados.length} pedido${atrasados.length > 1 ? "s" : ""} atrasado${atrasados.length > 1 ? "s" : ""}`,
      detail: atrasados.slice(0, 3).map((o) => `#${o.number} (${o.customerName || "—"}) — ${orderUrgency(o).label}`).join(" · ") + (atrasados.length > 3 ? ` y ${atrasados.length - 3} más` : ""),
      modulo: "Pedidos", href: "#/pedidos",
    });
  }

  const stockCritico = state.products.filter((p) => typeof p.minQty === "number" && productTotalQty(p.id) <= p.minQty);
  if (stockCritico.length) {
    alerts.push({
      level: "red", icon: "⚠️",
      title: `${stockCritico.length} producto${stockCritico.length > 1 ? "s" : ""} con stock insuficiente`,
      detail: stockCritico.slice(0, 3).map((p) => `${p.name}: disponible ${productTotalQty(p.id)}, necesario ${p.minQty} (faltan ${Math.max(0, p.minQty - productTotalQty(p.id))})`).join(" · ") + (stockCritico.length > 3 ? ` y ${stockCritico.length - 3} más` : ""),
      modulo: "Inventario", href: "#/inventario",
    });
  }

  const dash = produccionDashboard();
  if (dash.occupancy >= 90) {
    alerts.push({
      level: dash.occupancy >= 100 ? "red" : "yellow", icon: "🏭",
      title: `Producción al ${Math.round(dash.occupancy)}% de capacidad hoy`,
      detail: `${fmtMinutes(dash.hoursToday * 60)} usadas sobre ${productionSettings().dailyHours} h disponibles por jornada.`,
      modulo: "Producción", href: "#/produccion",
    });
  }

  const prodRetrasada = state.production_orders.filter((o) => ["pendiente", "en_produccion"].includes(o.status) && daysBetween((o.createdAt || "").slice(0, 10), today) >= 2);
  if (prodRetrasada.length) {
    alerts.push({
      level: "yellow", icon: "⏱",
      title: `${prodRetrasada.length} orden${prodRetrasada.length > 1 ? "es" : ""} de producción demorada${prodRetrasada.length > 1 ? "s" : ""}`,
      detail: prodRetrasada.slice(0, 3).map((o) => `${o.code} (Caja ${boxSizeLabel(o.boxSize)} x${o.quantity})`).join(" · ") + (prodRetrasada.length > 3 ? ` y ${prodRetrasada.length - 3} más` : ""),
      modulo: "Producción", href: "#/produccion",
    });
  }

  const incOrders = state.orders.filter((o) => o.status === "incidencia");
  const incAbiertas = state.incidents.filter((i) => i.relatedType === "order" && !["resuelta", "cerrada"].includes(i.status));
  if (incOrders.length || incAbiertas.length) {
    const n = Math.max(incOrders.length, incAbiertas.length);
    alerts.push({
      level: "red", icon: "🚨",
      title: `${n} entrega${n > 1 ? "s" : ""} con incidencia abierta`,
      detail: (incAbiertas.length ? incAbiertas : incOrders).slice(0, 3).map((x) => x.title ? x.title : `Pedido #${x.number}`).join(" · "),
      modulo: "Incidencias", href: "#/incidencias",
    });
  }

  if (!alerts.length) {
    alerts.push({ level: "green", icon: "✅", title: "Sin problemas críticos", detail: "No se detectan alertas en pedidos, stock, producción ni incidencias.", modulo: null, href: null });
  }
  return alerts;
}
function gerenciaEstadoGeneral(alerts) {
  if (alerts.some((a) => a.level === "red")) return { key: "critico", label: "CRÍTICO", cls: "st-red", emoji: "🔴" };
  if (alerts.some((a) => a.level === "yellow")) return { key: "atencion", label: "ATENCIÓN", cls: "st-orange", emoji: "🟡" };
  return { key: "normal", label: "NORMAL", cls: "st-green", emoji: "🟢" };
}

function gerenciaFiltrosHTML(range) {
  const opts = [["hoy", "Hoy"], ["ayer", "Ayer"], ["7d", "Últimos 7 días"], ["30d", "Últimos 30 días"], ["mes", "Este mes"], ["mes_ant", "Mes anterior"], ["custom", "Personalizado"]];
  return `<div class="ger-filters-bar">
    <div class="chip-row" style="margin:0">
      ${opts.map(([k, l]) => `<button class="chip ${gerenciaPeriodo === k ? "active" : ""}" data-ger-periodo="${k}">${l}</button>`).join("")}
    </div>
    ${gerenciaPeriodo === "custom"
      ? `<div class="ger-custom-dates">
          <input class="input" type="date" id="ger-from" value="${gerenciaCustomFrom || range.from}" />
          <span class="hint">a</span>
          <input class="input" type="date" id="ger-to" value="${gerenciaCustomTo || range.to}" />
        </div>`
      : `<div class="hint">${esc(range.label)}: ${fmtDateShort(range.from)} – ${fmtDateShort(range.to)}</div>`}
  </div>`;
}
function gerenciaSemaforoHTML(estado, range) {
  return `<div class="ger-semaforo ${estado.cls}">
    <div class="ger-semaforo-emoji">${estado.emoji}</div>
    <div>
      <div class="ger-semaforo-label">${estado.label}</div>
      <div class="ger-semaforo-sub">Estado general de la operación — ${esc(range.label)}</div>
    </div>
  </div>`;
}
function gerenciaResumenHTML(data, range) {
  const p = data.pedidos, e = data.entregas, pr = data.produccion;
  return `<div class="kpi-grid">
    ${kpiCard(p.total, "Pedidos del período", "📦", "kpi-blue", 0)}
    ${gerenciaMissingCard("Cajas a preparar", "📦", "Los pedidos no especifican cajas por producto todavía")}
    ${staticKpiCard(`${pr.realizadas} / ${pr.planificadas}`, "Producción (real/planificada)", "🏭", "kpi-violet", 80)}
    ${staticKpiCard(`${e.realizadas} / ${e.programadas}`, "Entregas (realizadas/programadas)", "🚚", "kpi-blue", 120)}
    ${kpiCard(e.pendientes, "Pedidos pendientes", "⏳", "kpi-orange", 160)}
    ${e.cumplimiento != null
      ? staticKpiCard(`${Math.round(e.cumplimiento)}%`, "Cumplimiento de entregas", "⏱", e.cumplimiento >= (data.objetivos.cumplimiento || 95) ? "kpi-blue" : "kpi-red", 200)
      : gerenciaMissingCard("Cumplimiento de entregas", "⏱", "Todavía no hay entregas registradas en este período")}
    ${gerenciaMissingCard("Horas-hombre", "👥", "Las órdenes de producción no registran personas asignadas")}
    ${pr.capacidadUtilizada != null
      ? staticKpiCard(`${Math.round(pr.capacidadUtilizada)}%`, "Capacidad utilizada", "📈", pr.capacidadUtilizada >= 90 ? "kpi-red" : "kpi-blue", 280)
      : gerenciaMissingCard("Capacidad utilizada", "📈", "Sin producción finalizada en este período")}
  </div>`;
}
function gerenciaProduccionHTML(data) {
  const pr = data.produccion;
  const maxSize = Math.max(1, ...pr.bySize.map((d) => d.boxes));
  return `<div class="detail-grid">
    <div class="panel">
      <div class="panel-head"><h3>Producción del período</h3><a class="link-more" href="#/produccion">Ver producción →</a></div>
      <div class="stat-row wrap">
        <div class="stat-box"><b>${pr.planificadas}</b><span>Planificadas</span></div>
        <div class="stat-box"><b>${pr.realizadas}</b><span>Realizadas</span></div>
        <div class="stat-box"><b>${pr.pendientes}</b><span>Pendientes</span></div>
        <div class="stat-box"><b>${pr.ordenesCreadas}</b><span>Órdenes creadas</span></div>
      </div>
      ${gerenciaDeltaHTML(pr.realizadas, pr.realizadasPrev, { suffix: " cajas" })}
      <div style="margin-top:14px">
        <div class="hint" style="margin-bottom:6px;font-weight:700;">Capacidad del período</div>
        ${pr.capacidadUtilizada != null
          ? `<div class="meter"><div class="meter-fill ${pr.capacidadUtilizada >= 100 ? "danger" : pr.capacidadUtilizada >= 90 ? "warn" : "ok"}" style="width:${Math.min(100, pr.capacidadUtilizada)}%"></div></div>
             <div class="hint" style="margin-top:6px">${fmtMinutes(pr.minutosUsados)} usadas de ${fmtMinutes(pr.capacidadDisponibleMin)} disponibles (${Math.round(pr.capacidadUtilizada)}%)</div>`
          : gerenciaMissing("Sin producción finalizada en el período para calcular la capacidad utilizada")}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Cajas producidas por tamaño</h3></div>
      ${pr.bySize.some((d) => d.boxes > 0)
        ? pr.bySize.map((d) => `<div class="prod-hbar-row"><span class="prod-hbar-label">${esc(boxSizeLabel(d.size))}</span><div class="prod-hbar-track"><div class="prod-hbar-fill" style="width:${Math.max(3, (d.boxes / maxSize) * 100)}%"></div></div><span class="prod-hbar-value">${d.boxes}</span></div>`).join("")
        : gerenciaMissing("Sin cajas producidas en el período")}
    </div>
    <div class="panel span2">
      <div class="panel-head"><h3>Tiempo estimado vs. real</h3></div>
      ${pr.estimadoTotal != null
        ? `<div class="stat-row wrap">
            <div class="stat-box"><b>${fmtMinutes(pr.estimadoTotal)}</b><span>Estimado</span></div>
            <div class="stat-box"><b>${fmtMinutes(pr.realTotal)}</b><span>Real</span></div>
            <div class="stat-box"><b style="color:${pr.desvioPct > 0 ? "var(--danger)" : "var(--ok)"}">${pr.desvioPct > 0 ? "+" : ""}${pr.desvioPct.toFixed(1)}%</b><span>Desvío</span></div>
          </div>`
        : gerenciaMissing("Sin órdenes finalizadas con tiempo real cargado en el período (se carga al finalizar una producción)")}
    </div>
  </div>`;
}
function gerenciaDistribucionHTML(data) {
  const e = data.entregas;
  const recientes = state.orders.filter((o) => o.status === "entregado" && inRangeDate(o.actualDeliveryDate, data.range))
    .sort((a, b) => (b.actualDeliveryDate || "").localeCompare(a.actualDeliveryDate || "")).slice(0, 6);
  return `<div class="detail-grid">
    <div class="panel">
      <div class="panel-head"><h3>Entregas del período</h3><a class="link-more" href="#/pedidos">Ver pedidos →</a></div>
      <div class="stat-row wrap">
        <div class="stat-box"><b>${e.programadas}</b><span>Programadas</span></div>
        <div class="stat-box"><b>${e.realizadas}</b><span>Realizadas</span></div>
        <div class="stat-box"><b>${e.pendientes}</b><span>Pendientes</span></div>
        <div class="stat-box"><b style="color:var(--danger)">${e.atrasadas}</b><span>Atrasadas</span></div>
        <div class="stat-box"><b>${e.conDemora}</b><span>Con demora</span></div>
        <div class="stat-box"><b style="color:var(--danger)">${e.conIncidencia}</b><span>Con incidencia</span></div>
      </div>
      ${e.cumplimiento != null
        ? `<div class="hint" style="margin-top:6px">Cumplimiento: <b style="color:var(--ink)">${Math.round(e.cumplimiento)}%</b></div>${gerenciaDeltaHTML(e.cumplimiento, e.cumplimientoPrev, { suffix: " pts" })}`
        : gerenciaMissing("Sin entregas realizadas en el período para calcular el cumplimiento")}
      <div class="hint" style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--border)">Km recorridos, horas de distribución, ocupación de vehículos y costo de distribución: ${gerenciaMissing("no disponibles — Transporte todavía no registra estos campos")}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Últimas entregas</h3></div>
      ${recientes.length
        ? `<table class="mini-table"><thead><tr><th>Pedido</th><th>Cliente</th><th>Estado</th></tr></thead><tbody>
            ${recientes.map((o) => {
              const onTime = o.expectedDate && o.actualDeliveryDate && o.actualDeliveryDate <= o.expectedDate;
              const sem = o.status === "incidencia" ? "🔴" : onTime ? "🟢" : "🟡";
              return `<tr><td><a href="#/pedidos/${o.id}">#${esc(o.number)}</a></td><td>${esc(o.customerName || "—")}</td><td>${sem} ${o.status === "incidencia" ? "Incidencia" : onTime ? "A tiempo" : "Con demora"}</td></tr>`;
            }).join("")}
          </tbody></table>`
        : gerenciaMissing("Sin entregas registradas en el período")}
    </div>
    <div class="panel span2">
      <div class="panel-head"><h3>Top clientes por despachos</h3><span class="hint">${esc(data.range.label)}</span></div>
      ${clientRankingHTML(data.clientesTop)}
    </div>
  </div>`;
}
function gerenciaCostosHTML(data) {
  const c = data.costos;
  return `<div class="detail-grid">
    <div class="panel">
      <div class="panel-head"><h3>Costo de producción</h3></div>
      ${c.produccionDisponible
        ? `<div class="stat-row wrap">
            <div class="stat-box"><b>$${Math.round(c.costoProduccion).toLocaleString("es-AR")}</b><span>Materia prima usada</span></div>
            ${c.costoPorCaja != null ? `<div class="stat-box"><b>$${c.costoPorCaja.toFixed(2)}</b><span>Costo por caja</span></div>` : ""}
          </div>
          <div class="hint">Calculado sólo sobre los lotes consumidos en producción que tienen costo unitario cargado en Inventario — puede estar subestimado si hay lotes sin costo.</div>`
        : gerenciaMissing("Datos insuficientes para calcular — ningún lote consumido en producción tiene costo unitario cargado en Inventario")}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Merma y devoluciones</h3></div>
      <div class="stat-row wrap">
        <div class="stat-box"><b>${c.mermaCount}</b><span>Movs. de merma</span></div>
        <div class="stat-box"><b>${c.mermaQty}</b><span>Unid. de merma</span></div>
        <div class="stat-box"><b>${c.devolucionCount}</b><span>Movs. devolución</span></div>
        <div class="stat-box"><b>${c.devolucionQty}</b><span>Unid. devueltas</span></div>
      </div>
    </div>
    <div class="panel span2">
      <div class="panel-head"><h3>Otros costos logísticos</h3></div>
      ${gerenciaMissing("Datos insuficientes para calcular — costo logístico total, costo por pedido, costo de transporte y costo de horas-hombre necesitan campos que Transporte y Producción todavía no registran (capacidad/costo del vehículo, personas por orden de producción).")}
    </div>
  </div>`;
}
function gerenciaAlertasHTML(alerts) {
  return `<div class="panel">
    ${alerts.map((a) => `<div class="ger-alert-card ${a.level}" ${a.href ? `data-ger-alert-href="${a.href}"` : ""}>
      <div class="ger-alert-title">${a.icon} ${esc(a.title)}</div>
      ${a.detail ? `<div class="ger-alert-detail">${esc(a.detail)}</div>` : ""}
      ${a.modulo ? `<div class="ger-alert-modulo">${esc(a.modulo)} — clic para ver el detalle</div>` : ""}
    </div>`).join("")}
  </div>`;
}
function gerenciaProductividadHTML(data) {
  const pd = data.productividad;
  return `<div class="detail-grid">
    <div class="panel">
      <div class="panel-head"><h3>Tiempos operativos</h3></div>
      ${pd.tiempoPrepProm != null
        ? `<div class="stat-box" style="max-width:220px;margin-bottom:10px"><b>${fmtMinutes(pd.tiempoPrepProm)}</b><span>Prom. de preparación</span></div>`
        : gerenciaMissing("Tiempo promedio de preparación: sin pedidos que llegaron a 'Preparado' en el período")}
      ${pd.tiempoEntregaProm != null
        ? `<div class="stat-box" style="max-width:220px"><b>${fmtMinutes(pd.tiempoEntregaProm)}</b><span>Prom. despacho → entrega</span></div>`
        : gerenciaMissing("Tiempo promedio de entrega: sin historial de despacho/entrega en el período")}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Productividad por hora-hombre</h3></div>
      ${gerenciaMissing("Cajas/hora-hombre, pedidos/hora-hombre y entregas/hora no disponibles — las órdenes de producción no registran cantidad de personas asignadas")}
    </div>
  </div>`;
}
function gerenciaObjetivosHTML(data) {
  const o = data.objetivos, e = data.entregas, pr = data.produccion;
  const rows = [
    { label: "Cumplimiento de entregas", real: e.cumplimiento, objetivo: o.cumplimiento, suffix: "%" },
    { label: "Capacidad utilizada", real: pr.capacidadUtilizada, objetivo: o.utilizacion, suffix: "%" },
    { label: "Entregas a tiempo", real: e.realizadas ? (e.aTiempo / e.realizadas) * 100 : null, objetivo: o.entregasATiempo, suffix: "%" },
    { label: "Productividad (cajas/hora-hombre)", real: null, objetivo: o.productividad, suffix: "" },
  ];
  return `<div class="panel">
    <div class="panel-head"><h3>Objetivos vs. real</h3><button class="btn btn-ghost btn-sm" data-action="open-modal" data-modal="gerencia-objetivos">⚙️ Configurar objetivos</button></div>
    ${rows.map((r) => {
      if (r.real == null) return `<div class="ger-obj-row"><span>${esc(r.label)}</span><span class="ger-missing" style="padding:0">${r.objetivo != null ? `Objetivo: ${r.objetivo}${r.suffix} — ` : ""}real no disponible</span></div>`;
      const diff = r.real - r.objetivo, ok = diff >= 0;
      return `<div class="ger-obj-row"><span>${esc(r.label)}</span><span>${r.real.toFixed(1)}${r.suffix} <b style="color:${ok ? "var(--ok)" : "var(--danger)"}">(${ok ? "+" : ""}${diff.toFixed(1)} pts vs. objetivo ${r.objetivo}${r.suffix})</b></span></div>`;
    }).join("")}
  </div>`;
}
function gerenciaChartsHTML(series) {
  return `<div class="detail-grid">
    <div class="panel">
      <div class="panel-head"><h3>Producción — cajas por día</h3></div>
      ${series.some((d) => d.cajas > 0) ? svgBar(series.map((d) => ({ label: d.label, value: d.cajas, color: "var(--accent)" }))) : gerenciaMissing("Sin cajas producidas en el rango mostrado")}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Distribución — programadas vs. realizadas</h3></div>
      ${series.some((d) => d.programadas > 0 || d.realizadas > 0)
        ? `${svgBarDual(series.map((d) => ({ label: d.label, a: d.programadas, b: d.realizadas })), { colorA: "var(--ink-faint)", colorB: "var(--accent)" })}
           <div class="donut-legend" style="margin-top:8px;flex-direction:row;gap:16px;">
             <div><i style="background:var(--ink-faint)"></i>Programadas</div>
             <div><i style="background:var(--accent)"></i>Realizadas</div>
           </div>`
        : gerenciaMissing("Sin entregas programadas ni realizadas en el rango mostrado")}
    </div>
  </div>`;
}

function viewGerencia() {
  const range = gerenciaPeriodoRange(gerenciaPeriodo);
  const data = gerenciaData(range);
  const alerts = gerenciaAlertas();
  const estado = gerenciaEstadoGeneral(alerts);
  const series = gerenciaSeriesDias(range);

  return `<div class="view-list ger-view">
    ${gerenciaFiltrosHTML(range)}
    ${gerenciaSemaforoHTML(estado, range)}
    <div class="ger-flow"><span class="ger-flow-label">📊 Resumen</span></div>
    ${gerenciaResumenHTML(data, range)}
    <div class="ger-flow"><span class="ger-flow-arrow">↓</span><span class="ger-flow-label">🏭 Producción</span></div>
    ${gerenciaProduccionHTML(data)}
    <div class="ger-flow"><span class="ger-flow-arrow">↓</span><span class="ger-flow-label">🚚 Distribución</span></div>
    ${gerenciaDistribucionHTML(data)}
    <div class="ger-flow"><span class="ger-flow-arrow">↓</span><span class="ger-flow-label">💰 Costos</span></div>
    ${gerenciaCostosHTML(data)}
    <div class="ger-flow"><span class="ger-flow-arrow">↓</span><span class="ger-flow-label">📈 Productividad</span></div>
    ${gerenciaProductividadHTML(data)}
    <div class="ger-flow"><span class="ger-flow-arrow">↓</span><span class="ger-flow-label">⚠️ Alertas gerenciales</span></div>
    ${gerenciaAlertasHTML(alerts)}
    <div class="ger-flow"><span class="ger-flow-label">🎯 Objetivos</span></div>
    ${gerenciaObjetivosHTML(data)}
    <div class="ger-flow"><span class="ger-flow-label">📉 Evolución</span></div>
    ${gerenciaChartsHTML(series)}
  </div>`;
}

/* ---------------------------------------------------------------------------
   18. CONFIGURACIÓN
   ------------------------------------------------------------------------- */
function viewConfig() {
  const email = state.session?.user?.email || "—";
  return `<div class="view-list">
    <div class="panel">
      <div class="panel-head"><h3>Cuenta</h3></div>
      <div class="kv"><span>Correo</span><b>${esc(email)}</b></div>
      <div class="kv"><span>Modo de datos</span><b>Sincronizado en tu base de Supabase</b></div>
      <div class="form-actions" style="justify-content:flex-start"><button class="btn btn-ghost" data-action="logout">Cerrar sesión</button></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Datos</h3></div>
      <p class="desc-text">Todos los datos de Logística Perona se cargan y actualizan manualmente. No hay integraciones automáticas activas en esta versión.</p>
      <div class="form-actions" style="justify-content:flex-start">
        <button class="btn btn-secondary" data-action="export-data">Exportar datos (JSON)</button>
        <button class="btn btn-ghost" data-action="clear-data">Vaciar todos los datos</button>
        <button class="btn btn-ghost" data-action="reset-demo">Cargar datos de ejemplo</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Próximamente</h3></div>
      <p class="desc-text">La arquitectura está preparada para incorporar, en versiones futuras: integración ERP, GPS y tracking en tiempo real, automatizaciones (n8n, WhatsApp), IA y predicción de demoras, y optimización de rutas. Nada de esto está activo en esta primera versión.</p>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------------------
   19. MUTACIONES DE ESTADO (con trazabilidad)
   ------------------------------------------------------------------------- */
async function changeOrderStatus(id, newStatus, note) {
  const o = getById("orders", id);
  if (!o) return;
  const from = o.status;
  o.status = newStatus;
  o.history = [...o.history, { from, to: newStatus, date: nowISO(), note: note || "" }];
  if (newStatus === "despachado" && !o.dispatchDate) o.dispatchDate = nowISO();
  if (newStatus === "entregado") o.actualDeliveryDate = todayISO();
  await persist("orders", o);
  if (newStatus === "despachado") await ensureDispatchNotification(o);
  toast(`Pedido #${o.number} → ${ORDER_META[newStatus].label}`);
  renderApp();
}
async function changePoStatus(id, newStatus, note) {
  const p = getById("purchase_orders", id);
  if (!p) return;
  const from = p.status;
  p.status = newStatus;
  p.history = [...p.history, { from, to: newStatus, date: nowISO(), note: note || "" }];
  if (newStatus === "llegada" && !p.actualArrival) p.actualArrival = todayISO();
  await persist("purchase_orders", p);
  toast(`OC #${p.number} → ${PO_META[newStatus].label}`);
  renderApp();
}
async function changeIncidentStatus(id, newStatus) {
  const i = getById("incidents", id);
  if (!i) return;
  i.status = newStatus;
  if (newStatus === "resuelta" && !i.resolutionDate) i.resolutionDate = todayISO();
  await persist("incidents", i);
  toast(`Incidencia → ${INCIDENT_META[newStatus].label}`);
  renderApp();
}
async function cycleTaskStatus(id) {
  const t = getById("tasks", id);
  if (!t) return;
  const idx = TASK_FLOW.indexOf(t.status);
  t.status = TASK_FLOW[(idx + 1) % TASK_FLOW.length];
  await persist("tasks", t);
  renderApp();
}
async function createIncidentFromDetail(kind, id) {
  const rec = getById(kind === "order" ? "orders" : "purchase_orders", id);
  if (!rec) return;
  const title = kind === "order" ? `Incidencia en pedido #${rec.number}` : `Incidencia en OC #${rec.number}`;
  const inc = { id: uid("inc"), title, description: "", date: todayISO(), priority: "media", status: "abierta", responsible: "Alejandro Perona", relatedType: kind === "order" ? "order" : "purchase_order", relatedId: id, resolution: "", resolutionDate: null };
  await persist("incidents", inc);
  rec.incidentId = inc.id;
  const from = rec.status; rec.status = "incidencia";
  rec.history = [...rec.history, { from, to: "incidencia", date: nowISO(), note: "Incidencia registrada." }];
  await persist(kind === "order" ? "orders" : "purchase_orders", rec);
  location.hash = `#/incidencias/${inc.id}`;
}

/* ---------------------------------------------------------------------------
   20. MODALES RÁPIDOS
   ------------------------------------------------------------------------- */
function openModal(kind, opts = {}) {
  const host = $("#modal-host");
  let body = "";
  if (kind === "transport") {
    const t = opts.id ? getById("transports", opts.id) : null;
    const vt = Array.isArray(t?.vehicleTypes) ? t.vehicleTypes : [];
    body = `<form data-form="transport-quick" data-id="${t ? t.id : ""}">
      <h3>${t ? "Editar transporte" : "Nuevo transporte"}</h3>
      <div class="form-grid">
        <label>Nombre<input class="input" name="name" required value="${esc(t?.name || "")}" /></label>
        <label>Tipo<input class="input" name="type" placeholder="Camión completo, paquetería…" value="${esc(t?.type || "")}" /></label>
        <label>Contacto<input class="input" name="contact" value="${esc(t?.contact || "")}" /></label>
        <label>Teléfono<input class="input" name="phone" value="${esc(t?.phone || "")}" /></label>
        <label class="span2">Email<input class="input" name="email" type="email" value="${esc(t?.email || "")}" /></label>
        <div class="span2">
          <span style="display:block;margin-bottom:6px;">Tipo de vehículo</span>
          <div class="chip-row" style="margin:0">
            ${Object.entries(VEHICLE_TYPES).map(([k, v]) => `<label class="checkbox-row"><input type="checkbox" name="vehicleTypes" value="${k}" ${vt.includes(k) ? "checked" : ""} /> ${v.icon} ${v.label}</label>`).join("")}
          </div>
        </div>
        <div class="span2" style="margin-top:4px;padding-top:10px;border-top:1px dashed var(--border);">
          <span style="display:block;margin-bottom:4px;font-weight:700;">${t ? "Sumar una ruta (opcional)" : "Ruta que recorre"}</span>
          <div class="hint" style="margin-bottom:8px;">${t ? "Completá origen y destino para agregarle otra ruta a este transporte. Las rutas que ya tiene no se tocan." : "Se usa para ubicarlo en el mapa de rutas."}</div>
        </div>
        <label>Origen — ciudad<input class="input" name="originCity" ${t ? "" : "required"} /></label>
        <label>Origen — provincia<input class="input" name="originProvince" /></label>
        <label>Destino — ciudad<input class="input" name="destinationCity" ${t ? "" : "required"} /></label>
        <label>Destino — provincia<input class="input" name="destinationProvince" /></label>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button><button type="submit" class="btn btn-primary">${t ? "Guardar cambios" : "Crear"}</button></div>
    </form>`;
  } else if (kind === "location") {
    const l = opts.id ? getById("locations", opts.id) : null;
    const linkedSupplier = l ? state.suppliers.find((s) => s.locationId === l.id) : null;
    body = `<form data-form="location-quick" data-id="${l ? l.id : ""}">
      <h3>${l ? "Editar ubicación" : "Nueva ubicación"}</h3>
      <div class="form-grid">
        <label>Nombre<input class="input" name="name" required value="${esc(l?.name || "")}" /></label>
        <label>Tipo<select class="input" name="type">${Object.entries(LOCATION_TYPES).map(([k,v])=>`<option value="${k}" ${(l ? l.type===k : opts.type===k)?"selected":""}>${v.label}</option>`).join("")}</select></label>
        <label class="span2">Dirección
          <div class="addr-search-row">
            <input class="input" name="address" id="loc-address" required placeholder="Ej: San Martín 850, Córdoba" value="${esc(l?.address || "")}" />
            <button type="button" class="btn btn-secondary btn-sm" data-action="geocode-address">📍 Buscar en el mapa</button>
          </div>
        </label>
        <div class="span2" id="loc-picker-wrap" ${l?.lat && l?.lng ? "" : "hidden"}>
          <div id="mapa-picker" class="leaflet-box" style="height:200px"></div>
          <div class="hint" style="margin-top:6px">Arrastrá el marcador (o tocá el mapa) para ajustar el punto exacto.</div>
        </div>
        <input type="hidden" name="lat" id="loc-lat" value="${l?.lat ?? ""}" />
        <input type="hidden" name="lng" id="loc-lng" value="${l?.lng ?? ""}" />
        <label>Ciudad<input class="input" name="city" value="${esc(l?.city || "")}" /></label>
        <label>Provincia<input class="input" name="province" value="${esc(l?.province || "")}" /></label>
        <label>Contacto<input class="input" name="contact" value="${esc(l?.contact || linkedSupplier?.contact || "")}" /></label>
        <label>Teléfono<input class="input" name="phone" value="${esc(l?.phone || linkedSupplier?.phone || "")}" /></label>
        ${linkedSupplier ? `
        <label class="span2">Email (proveedor)<input class="input" type="email" name="email" value="${esc(linkedSupplier.email || "")}" /></label>
        <label class="span2">Observaciones (proveedor)<textarea class="input" name="notes" rows="2">${esc(linkedSupplier.notes || "")}</textarea></label>` : ""}
      </div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button><button type="submit" class="btn btn-primary">${l ? "Guardar cambios" : "Crear"}</button></div>
    </form>`;
  } else if (kind === "import-orders") {
    body = `<div>
      <h3>Importar pedidos desde Excel</h3>
      <div class="hint" style="margin-bottom:10px">Subí el archivo de envíos (mismo formato de siempre: columnas de Destinatario, Cliente, Seguimiento, etc.). La app identifica el cliente, arma el pedido a partir del código de seguimiento y geocodifica el destino. Si volvés a subir un archivo que incluye envíos ya importados antes, actualiza esos pedidos en vez de duplicarlos.</div>
      <input type="file" id="import-orders-file" accept=".xlsx,.xls" class="input" />
      <div id="import-orders-preview" style="margin-top:12px"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="button" class="btn btn-primary" id="import-orders-confirm" disabled>Confirmar importación</button>
      </div>
    </div>`;
  } else if (kind === "task") {
    body = `<form data-form="task-quick">
      <h3>Nueva tarea</h3>
      <div class="form-grid">
        <label class="span2">Título<input class="input" name="title" required /></label>
        <label>Fecha<input class="input" type="date" name="date" value="${todayISO()}" required /></label>
        <label>Hora (opcional)<input class="input" type="time" name="time" /></label>
        <label>Prioridad<select class="input" name="priority">${Object.keys(PRIORITY_META).map(p=>`<option value="${p}" ${p==="media"?"selected":""}>${PRIORITY_META[p].label}</option>`).join("")}</select></label>
        <label>Categoría<input class="input" name="category" placeholder="Pedidos, Compras, Transporte…" /></label>
        <label class="span2">Observaciones<textarea class="input" name="notes" rows="2"></textarea></label>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button><button type="submit" class="btn btn-primary">Crear</button></div>
    </form>`;
  } else if (kind === "inv-supplier") {
    const s = opts.id ? getById("inv_suppliers", opts.id) : null;
    body = `<form data-form="inv-supplier" data-id="${s ? s.id : ""}">
      <h3>${s ? "Editar proveedor" : "Nuevo proveedor de insumos"}</h3>
      <div class="form-grid">
        <label class="span2">Nombre<input class="input" name="name" required value="${esc(s?.name || "")}" /></label>
        <label>Contacto<input class="input" name="contact" value="${esc(s?.contact || "")}" /></label>
        <label>Teléfono<input class="input" name="phone" value="${esc(s?.phone || "")}" /></label>
        <label class="span2">Email<input class="input" type="email" name="email" value="${esc(s?.email || "")}" /></label>
        <label class="span2">Observaciones<textarea class="input" name="notes" rows="2">${esc(s?.notes || "")}</textarea></label>
      </div>
      <div class="form-actions">
        ${s ? `<button type="button" class="btn btn-ghost" data-action="inv-supplier-delete" data-id="${s.id}" style="margin-right:auto">Eliminar</button>` : ""}
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${s ? "Guardar cambios" : "Crear"}</button>
      </div>
    </form>`;
  } else if (kind === "inv-product") {
    const p = opts.id ? getById("products", opts.id) : null;
    body = `<form data-form="inv-product" data-id="${p ? p.id : ""}">
      <h3>${p ? "Editar producto" : "Nuevo producto"}</h3>
      <div class="form-grid">
        <label class="span2">Nombre<input class="input" name="name" required value="${esc(p?.name || "")}" /></label>
        <label>Marca<input class="input" name="marca" value="${esc(p?.marca || "")}" /></label>
        <label>SKU / Código<input class="input" name="sku" value="${esc(p?.sku || "")}" /></label>
        <label>Categoría<input class="input" name="categoria" value="${esc(p?.categoria || "")}" /></label>
        <label class="span2">Proveedor<select class="input" name="supplierId">
          <option value="">— Sin proveedor —</option>
          ${state.inv_suppliers.slice().sort((a,b)=>a.name.localeCompare(b.name)).map((s) => `<option value="${s.id}" ${p?.supplierId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
        </select></label>
        <label>Unidad de medida<input class="input" name="unit" placeholder="gm, ml, und, paq…" value="${esc(p?.unit || "")}" /></label>
        <label>Envase<input class="input" type="number" step="any" name="packageSize" value="${p?.packageSize ?? ""}" /></label>
        <label>Mínimo<input class="input" type="number" step="any" name="minQty" value="${p?.minQty ?? ""}" /></label>
        <label>Óptimo de compra<input class="input" type="number" step="any" name="optimalQty" value="${p?.optimalQty ?? ""}" /></label>
        <label>Máximo<input class="input" type="number" step="any" name="maxQty" value="${p?.maxQty ?? ""}" /></label>
        <label>Días de anticipación para alerta<input class="input" type="number" step="1" name="diasAlerta" placeholder="Usa el umbral general si se deja vacío" value="${p?.diasAlerta ?? ""}" /></label>
        <label class="checkbox-row"><input type="checkbox" name="manejaLote" ${p?.manejaLote !== false ? "checked" : ""} /> Maneja lote</label>
        <label class="checkbox-row"><input type="checkbox" name="manejaVencimiento" ${p?.manejaVencimiento !== false ? "checked" : ""} /> Maneja vencimiento</label>
        <label class="span2">Observaciones<textarea class="input" name="notes" rows="2">${esc(p?.notes || "")}</textarea></label>
      </div>
      <div class="form-actions">
        ${p ? `<button type="button" class="btn btn-ghost" data-action="inv-product-delete" data-id="${p.id}" style="margin-right:auto">Eliminar</button>` : ""}
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${p ? "Guardar cambios" : "Crear"}</button>
      </div>
    </form>`;
  } else if (kind === "inv-lot") {
    const l = opts.id ? getById("inventory_lots", opts.id) : null;
    const productId = l ? l.productId : opts.productId;
    const product = getById("products", productId);
    body = `<form data-form="inv-lot" data-id="${l ? l.id : ""}" data-product-id="${productId || ""}">
      <h3>${l ? "Editar lote" : "Nuevo lote"}${product ? " · " + esc(product.name) : ""}</h3>
      <div class="form-grid">
        <label>Número de lote<input class="input" name="numeroLote" value="${esc(l?.numeroLote || "")}" /></label>
        <label>Cantidad${product?.unit ? ` (${esc(product.unit)})` : ""}<input class="input" type="number" step="any" name="quantity" value="${l?.quantity ?? ""}" /></label>
        ${l ? `<label>Cantidad inicial recibida<input class="input" value="${l.cantidadInicial ?? l.quantity ?? "—"}" disabled /></label>` : ""}
        <label>Fecha de elaboración<input class="input" type="date" name="fechaElaboracion" value="${l?.fechaElaboracion || ""}" /></label>
        <label>Vencimiento<input class="input" type="date" name="expiryDate" value="${l?.expiryDate || ""}" /></label>
        <label>Fecha de recepción<input class="input" type="date" name="fechaRecepcion" value="${l?.fechaRecepcion || ""}" /></label>
        <label>Depósito / Ubicación<input class="input" name="deposito" placeholder="Cámara 1, Depósito Central…" value="${esc(l?.deposito || "")}" /></label>
        <label>Remito<input class="input" name="remito" value="${esc(l?.remito || "")}" /></label>
        <label>Orden de compra<input class="input" name="ordenCompra" value="${esc(l?.ordenCompra || "")}" /></label>
        <label>Costo unitario<input class="input" type="number" step="any" name="costoUnitario" value="${l?.costoUnitario ?? ""}" /></label>
        <label class="span2">Observaciones<textarea class="input" name="notes" rows="2">${esc(l?.notes || "")}</textarea></label>
      </div>
      <div class="form-actions">
        ${l ? `<button type="button" class="btn btn-ghost" data-action="inv-lot-delete" data-id="${l.id}" style="margin-right:auto">Eliminar</button>` : ""}
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${l ? "Guardar cambios" : "Agregar lote"}</button>
      </div>
    </form>`;
  } else if (kind === "inv-salida") {
    const productId = opts.productId;
    const product = getById("products", productId);
    const disponible = productTotalQty(productId);
    body = `<form data-form="inv-salida" data-product-id="${productId || ""}">
      <h3>Registrar salida${product ? " · " + esc(product.name) : ""}</h3>
      <div class="hint" style="margin-bottom:8px">El sistema asigna automáticamente los lotes por FEFO (primero el que vence antes). Disponible: ${disponible} UND.</div>
      <div class="form-grid">
        <label>Cantidad a retirar<input class="input" type="number" step="any" name="quantity" required /></label>
        <label>Documento relacionado<input class="input" name="relatedDocument" placeholder="N° de pedido, remito…" /></label>
        <label class="span2">Motivo<textarea class="input" name="reason" rows="2"></textarea></label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Registrar salida</button>
      </div>
    </form>`;
  } else if (kind === "inv-merma" || kind === "inv-devolucion" || kind === "inv-ajuste") {
    const productId = opts.productId;
    const product = getById("products", productId);
    const lots = productLots(productId);
    const titles = { "inv-merma": "Registrar merma", "inv-devolucion": "Registrar devolución", "inv-ajuste": "Ajuste manual de stock" };
    body = `<form data-form="${kind}" data-product-id="${productId || ""}">
      <h3>${titles[kind]}${product ? " · " + esc(product.name) : ""}</h3>
      <div class="form-grid">
        <label class="span2">Lote<select class="input" name="lotId" required>
          <option value="">— Elegir lote —</option>
          ${lots.map((l) => `<option value="${l.id}" ${opts.id === l.id ? "selected" : ""}>${esc(l.numeroLote || l.id.slice(0, 8))} · ${l.quantity ?? 0} UND${l.expiryDate ? " · vence " + fmtDate(l.expiryDate) : ""}</option>`).join("")}
        </select></label>
        ${kind === "inv-ajuste" ? `<label>Dirección<select class="input" name="direction"><option value="positivo">Ajuste positivo (+)</option><option value="negativo">Ajuste negativo (-)</option></select></label>` : ""}
        <label>Cantidad<input class="input" type="number" step="any" name="quantity" required /></label>
        <label class="span2">Motivo<textarea class="input" name="reason" rows="2" ${kind !== "inv-ajuste" ? "required" : ""}></textarea></label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Registrar</button>
      </div>
    </form>`;
  } else if (kind === "inv-lot-block") {
    const l = getById("inventory_lots", opts.id);
    body = `<form data-form="inv-lot-block" data-id="${opts.id}">
      <h3>Bloquear lote${l ? " · " + esc(l.numeroLote || l.id.slice(0, 8)) : ""}</h3>
      <div class="form-grid">
        <label class="span2">Motivo del bloqueo<textarea class="input" name="reason" rows="2" required></textarea></label>
      </div>
      <div class="hint">Un lote bloqueado no puede usarse para nuevas salidas ni se cuenta como stock disponible, pero sigue existiendo y mantiene su trazabilidad.</div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Bloquear lote</button>
      </div>
    </form>`;
  } else if (kind === "inv-lot-location") {
    const l = getById("inventory_lots", opts.id);
    const locs = l ? lotLocations(l.id) : [];
    body = `<form data-form="inv-lot-location" data-id="${opts.id}">
      <h3>Ubicaciones del lote${l ? " · " + esc(l.numeroLote || l.id.slice(0, 8)) : ""}</h3>
      ${locs.length ? `<div class="kv-notes" style="margin-bottom:10px"><span>Ya asignado</span><p>${locs.map((ll) => `${esc(ll.locationLabel)}: ${ll.quantity} <button type="button" class="btn btn-ghost btn-sm" data-action="lot-location-delete" data-id="${ll.id}">Quitar</button>`).join("<br>")}</p></div>` : ""}
      <div class="form-grid">
        <label class="span2">Ubicación<input class="input" name="locationLabel" placeholder="Cámara 1 / Estantería A" required /></label>
        <label>Cantidad<input class="input" type="number" step="any" name="quantity" required /></label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Agregar ubicación</button>
      </div>
    </form>`;
  } else if (kind === "inv-alert-settings") {
    const th = alertThresholds();
    body = `<form data-form="inv-alert-settings">
      <h3>Configurar alertas de vencimiento</h3>
      <div class="form-grid">
        <label>🟡 Próximo a vencer — hasta (días)<input class="input" type="number" name="yellow" min="1" value="${th.yellow}" required /></label>
        <label>🟠 Crítico — hasta (días)<input class="input" type="number" name="orange" min="0" value="${th.orange}" required /></label>
      </div>
      <div class="hint">🔴 Vencido es automático (fecha superada). 🟢 Normal es todo lo que supere el umbral amarillo.</div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Guardar</button>
      </div>
    </form>`;
  } else if (kind === "prod-config-item") {
    const it = opts.id ? state.box_config_items.find((i) => i.id === opts.id) : null;
    const size = it ? (getById("box_configs", it.boxConfigId)?.size || opts.size) : opts.size;
    const config = boxConfigForSize(size);
    const usedIds = config ? boxConfigItems(config.id).filter((i) => i.id !== opts.id).map((i) => i.productId) : [];
    const options = state.products.slice().sort((a, b) => a.name.localeCompare(b.name))
      .filter((p) => !usedIds.includes(p.id))
      .map((p) => `<option value="${p.id}" ${it?.productId === p.id ? "selected" : ""}>${esc(p.name)}${p.sku ? ` (${esc(p.sku)})` : ""}</option>`).join("");
    body = `<form data-form="prod-config-item" data-id="${it ? it.id : ""}" data-size="${esc(size || "")}">
      <h3>${it ? "Editar producto de la caja" : "Agregar producto a la caja"} ${esc(boxSizeLabel(size) || "")}</h3>
      <div class="form-grid">
        <label class="span2">Producto<select class="input" name="productId" required>${it ? "" : `<option value="">— Elegí un producto —</option>`}${options}</select></label>
        <label>Cantidad por caja<input class="input" type="number" min="0.01" step="any" name="quantity" value="${it?.quantity ?? 1}" required /></label>
      </div>
      <div class="form-actions">
        ${it ? `<button type="button" class="btn btn-ghost" data-action="prod-config-item-delete" data-id="${it.id}" style="margin-right:auto">Eliminar</button>` : ""}
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${it ? "Guardar cambios" : "Agregar"}</button>
      </div>
    </form>`;
  } else if (kind === "prod-settings") {
    const s = productionSettings();
    body = `<form data-form="prod-settings">
      <h3>Configurar tiempos de producción</h3>
      <div class="form-grid">
        ${BOX_SIZES.map((sz) => `<label>Minutos por caja ${boxSizeLabel(sz)}<input class="input" type="number" min="0" step="any" name="min_${sz}" value="${s.boxMinutes[sz] ?? 0}" required /></label>`).join("")}
        <label>Preparación fija por lote (min)<input class="input" type="number" min="0" step="any" name="prepMinutes" value="${s.prepMinutes}" required /></label>
        <label>Cierre / embalaje por lote (min)<input class="input" type="number" min="0" step="any" name="packMinutes" value="${s.packMinutes}" required /></label>
        <label>Horas disponibles de producción / jornada<input class="input" type="number" min="0" step="any" name="dailyHours" value="${s.dailyHours}" required /></label>

        <div class="span2" style="margin-top:4px;padding-top:10px;border-top:1px dashed var(--border);">
          <span style="display:block;margin-bottom:4px;font-weight:700;">Jornada de trabajo (Simulador de producción)</span>
        </div>
        <label>Hora de inicio<input class="input" type="time" name="jornadaInicio" value="${s.jornadaInicio}" required /></label>
        <label>Hora de finalización<input class="input" type="time" name="jornadaFin" value="${s.jornadaFin}" required /></label>
        <label>Descanso (min)<input class="input" type="number" min="0" step="1" name="descansoMin" value="${s.descansoMin}" required /></label>

        <div class="span2" style="margin-top:4px;padding-top:10px;border-top:1px dashed var(--border);">
          <span style="display:block;margin-bottom:4px;font-weight:700;">Eficiencia por cantidad de personas</span>
          <span class="hint" style="display:block;">Más personas no siempre reducen el tiempo en la misma proporción (espacio, herramientas compartidas, organización, esperas).</span>
        </div>
        ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<label>Eficiencia ${n} persona${n > 1 ? "s" : ""} (%)<input class="input" type="number" min="1" max="100" step="1" name="eff_${n}" value="${s.efficiencyByPeople[n] ?? efficiencyFor(n, s)}" required /></label>`).join("")}
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Guardar</button>
      </div>
    </form>`;
  } else if (kind === "sim-pedido") {
    const it = opts.id ? simuladorPedidos.find((p) => p.id === opts.id) : null;
    const ordersSorted = state.orders.slice().sort((a, b) => new Date(b.orderDate || 0) - new Date(a.orderDate || 0));
    body = `<form data-form="sim-pedido" data-id="${it ? it.id : ""}">
      <h3>${it ? "Editar pedido de la tanda" : "Agregar pedido a la tanda"}</h3>
      <div class="form-grid">
        <label class="span2">Cargar desde un pedido existente (opcional)
          <select class="input" id="sim-pedido-source">
            <option value="">— Cargar manualmente —</option>
            ${ordersSorted.map((o) => `<option value="${o.id}">#${esc(o.number)} · ${esc(o.customerName)}</option>`).join("")}
          </select>
        </label>
        <label>N° de pedido<input class="input" name="numero" required value="${esc(it?.numero || "")}" /></label>
        <label>Cliente<input class="input" name="cliente" required value="${esc(it?.cliente || "")}" /></label>
        <label>Fecha de entrega<input class="input" type="date" name="fechaEntrega" value="${it?.fechaEntrega || ""}" /></label>
        <label>Tipo de caja<select class="input" name="size">${BOX_SIZES.map((s) => `<option value="${s}" ${(it?.size || "estandar") === s ? "selected" : ""}>${boxSizeLabel(s)}</option>`).join("")}</select></label>
        <label>Cantidad de cajas<input class="input" type="number" min="1" step="1" name="quantity" required value="${it?.quantity ?? 10}" /></label>
      </div>
      <div class="form-actions">
        ${it ? `<button type="button" class="btn btn-ghost" data-action="sim-pedido-delete" data-id="${it.id}" style="margin-right:auto">Quitar</button>` : ""}
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">${it ? "Guardar cambios" : "Agregar"}</button>
      </div>
    </form>`;
  } else if (kind === "prod-real-time") {
    const o = getById("production_orders", opts.id);
    body = `<form data-form="prod-real-time" data-id="${opts.id}">
      <h3>Registrar tiempo real</h3>
      <div class="hint" style="margin-bottom:10px">Estimado: ${fmtMinutes(o?.estimatedMinutes)}</div>
      <div class="form-grid">
        <label class="span2">Tiempo real (minutos)<input class="input" type="number" min="0" step="any" name="actualMinutes" value="${o?.actualMinutes ?? ""}" required /></label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Guardar</button>
      </div>
    </form>`;
  } else if (kind === "gerencia-objetivos") {
    const o = gerenciaObjetivos();
    body = `<form data-form="gerencia-objetivos">
      <h3>Configurar objetivos gerenciales</h3>
      <div class="hint" style="margin-bottom:12px">Estos objetivos sólo se usan para comparar contra los datos reales del Dashboard Gerencial — no afectan ningún cálculo de Pedidos, Producción, Inventario ni Distribución.</div>
      <div class="form-grid">
        <label>Cumplimiento de entregas — objetivo (%)<input class="input" type="number" min="0" max="100" step="any" name="cumplimiento" value="${o.cumplimiento}" required /></label>
        <label>Capacidad utilizada — objetivo (%)<input class="input" type="number" min="0" max="100" step="any" name="utilizacion" value="${o.utilizacion}" required /></label>
        <label>Entregas a tiempo — objetivo (%)<input class="input" type="number" min="0" max="100" step="any" name="entregasATiempo" value="${o.entregasATiempo}" required /></label>
        <label>Productividad — objetivo (cajas/hora-hombre)<input class="input" type="number" min="0" step="any" name="productividad" value="${o.productividad ?? ""}" placeholder="Sin dato real disponible todavía" /></label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Guardar</button>
      </div>
    </form>`;
  } else if (kind === "exp-dispatch") {
    const o = getById("orders", opts.id);
    const dd = dispatchDetail(opts.id);
    body = `<form data-form="exp-dispatch" data-order-id="${opts.id}">
      <h3>Datos de despacho${o ? " · #" + esc(o.number) : ""}</h3>
      <div class="form-grid">
        <label>Cantidad de cajas<input class="input" type="number" min="0" step="1" name="boxesCount" value="${dd?.boxesCount ?? ""}" /></label>
        <label>Tipo de caja<input class="input" name="boxType" value="${esc(dd?.boxType || "")}" placeholder="S / M / L / personalizada" /></label>
        <label>Peso estimado (kg)<input class="input" type="number" min="0" step="any" name="weightKg" value="${dd?.weightKg ?? ""}" /></label>
        <label>Volumen estimado (m³)<input class="input" type="number" min="0" step="any" name="volumeM3" value="${dd?.volumeM3 ?? ""}" /></label>
        <label>Valor del pedido<input class="input" type="number" min="0" step="any" name="orderValue" value="${dd?.orderValue ?? ""}" /></label>
        <label>Horario de recepción<input class="input" name="receptionSchedule" value="${esc(dd?.receptionSchedule || "")}" placeholder="Ej: 8 a 12hs" /></label>
        <label class="span2">Observaciones<textarea class="input" name="notes" rows="2">${esc(dd?.notes || "")}</textarea></label>
      </div>
      <div class="hint">Estos datos alimentan el cálculo real de costo de transporte y el comparador de Expedición — nada se completa automáticamente.</div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Guardar</button>
      </div>
    </form>`;
  } else if (kind === "exp-rate") {
    const t = getById("transports", opts.id);
    const r = transportRate(opts.id);
    body = `<form data-form="exp-rate" data-transport-id="${opts.id}">
      <h3>Tarifa de transporte${t ? " · " + esc(t.name) : ""}</h3>
      <div class="hint" style="margin-bottom:10px">Costo = fijo + (por km × km) + (por caja × cajas) + (por kg × kg) + (% × valor del pedido). Dejá en 0 los componentes que no uses.</div>
      <div class="form-grid">
        <label>Monto fijo<input class="input" type="number" min="0" step="any" name="fixedAmount" value="${r?.fixedAmount ?? 0}" /></label>
        <label>Por km<input class="input" type="number" min="0" step="any" name="perKm" value="${r?.perKm ?? 0}" /></label>
        <label>Por caja<input class="input" type="number" min="0" step="any" name="perBox" value="${r?.perBox ?? 0}" /></label>
        <label>Por kg<input class="input" type="number" min="0" step="any" name="perKg" value="${r?.perKg ?? 0}" /></label>
        <label>% del valor del pedido<input class="input" type="number" min="0" step="any" name="percent" value="${r?.percent ?? 0}" /></label>
        <label class="span2">Observaciones<textarea class="input" name="notes" rows="2">${esc(r?.notes || "")}</textarea></label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Guardar tarifa</button>
      </div>
    </form>`;
  } else if (kind === "exp-config") {
    const cfg = expedicionConfig();
    const depositos = state.locations.filter((l) => l.type === "deposito");
    body = `<form data-form="exp-config">
      <h3>Configurar Expedición</h3>
      <div class="form-grid">
        <label class="span2">Depósito de origen (para calcular distancia/km)<select class="input" name="origenLocationId">
          <option value="">— Sin configurar —</option>
          ${depositos.map((l) => `<option value="${l.id}" ${cfg.origenLocationId === l.id ? "selected" : ""}>${esc(l.name)}${l.lat == null ? " (sin coordenadas)" : ""}</option>`).join("")}
        </select></label>
        <label>Criterio — costo (%)<input class="input" type="number" min="0" max="100" name="critCosto" value="${cfg.criterios.costo}" /></label>
        <label>Criterio — tiempo (%)<input class="input" type="number" min="0" max="100" name="critTiempo" value="${cfg.criterios.tiempo}" /></label>
        <label>Criterio — cumplimiento (%)<input class="input" type="number" min="0" max="100" name="critCumplimiento" value="${cfg.criterios.cumplimiento}" /></label>
        <label>Canal preferido para avisos<select class="input" name="canalPreferido">
          <option value="whatsapp" ${cfg.canalPreferido === "whatsapp" ? "selected" : ""}>WhatsApp</option>
          <option value="email" ${cfg.canalPreferido === "email" ? "selected" : ""}>Email</option>
          <option value="sms" ${cfg.canalPreferido === "sms" ? "selected" : ""}>SMS</option>
        </select></label>
        <div class="span2" style="margin-top:4px;padding-top:10px;border-top:1px dashed var(--border);">
          <span style="display:block;margin-bottom:4px;font-weight:700;">Plantillas de mensaje</span>
          <span class="hint" style="display:block;">Variables disponibles: [NOMBRE], [PEDIDO], [TRANSPORTISTA], [CAJAS], [FECHA], [LOCALIDAD]. No se envía nada real: sólo queda preparado el mensaje, listo para cuando se conecte un canal real.</span>
        </div>
        <label class="span2">WhatsApp<textarea class="input" name="plantillaWhatsapp" rows="2">${esc(cfg.plantillas.whatsapp)}</textarea></label>
        <label class="span2">Email<textarea class="input" name="plantillaEmail" rows="3">${esc(cfg.plantillas.email)}</textarea></label>
        <label class="span2">SMS<textarea class="input" name="plantillaSms" rows="2">${esc(cfg.plantillas.sms)}</textarea></label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Guardar</button>
      </div>
    </form>`;
  } else if (kind === "exp-despachar") {
    const o = getById("orders", opts.id);
    const dd = dispatchDetail(opts.id);
    const sel = latestSelection(opts.id);
    const transport = sel ? getById("transports", sel.transportId) : null;
    const checklist = expedicionChecklist(o, dd, sel);
    body = `<form data-form="exp-despachar" data-order-id="${opts.id}">
      <h3>🚚 Confirmar despacho — Pedido #${esc(o.number)}</h3>
      <div class="kv"><span>Transportista</span><b>${esc(transport?.name || "—")}</b></div>
      <div class="kv"><span>Cajas</span><b>${dd?.boxesCount ?? "—"}</b></div>
      <ul class="checklist" style="margin:10px 0">
        ${checklist.map((c) => `<li class="${c.ok ? "ok" : "pending"}">${c.ok ? "✅" : "⬜"} ${esc(c.label)}</li>`).join("")}
      </ul>
      <label style="display:flex;align-items:center;gap:8px;margin:6px 0 12px;">
        <input type="checkbox" name="docsListas" required style="width:16px;height:16px;margin:0;" /> Documentación disponible (remito / factura)
      </label>
      <div class="hint">Al confirmar: el pedido pasa a "Despachado", queda registrada la trazabilidad completa (transportista, vehículo, costo, fecha, operador) y se prepara automáticamente el aviso al cliente — sin enviar nada real todavía.</div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Confirmar despacho</button>
      </div>
    </form>`;
  } else if (kind === "of-new") {
    const finalOptions = ofFinalProductOptions();
    if (!finalOptions.length) {
      body = `<div>
        <h3>Nueva Orden de Fabricación</h3>
        <div class="hint" style="margin:10px 0">No hay ninguna receta de caja configurada todavía. Configurala primero en Producción → Configurar cajas.</div>
        <div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cerrar</button></div>
      </div>`;
    } else {
      const depositos = depositoLocations();
      body = `<form data-form="of-new">
        <h3>Nueva Orden de Fabricación</h3>
        <div class="form-grid">
          <label class="span2">Producto final<select class="input" name="boxConfigId" required>
            ${finalOptions.map((opt) => `<option value="${opt.config.id}">${esc(boxSizeLabel(opt.size))}${opt.config.name ? " — " + esc(opt.config.name) : ""}</option>`).join("")}
          </select></label>
          <label>Cantidad planificada<input class="input" type="number" name="cantidadPlanificada" min="1" step="1" required /></label>
          <label>Fecha de planificación<input class="input" type="date" name="fechaPlanificacion" value="${todayISO()}" /></label>
          <label>Fecha prevista<input class="input" type="date" name="fechaPrevista" /></label>
          <label>Almacén origen<select class="input" name="almacenOrigenId">
            <option value="">— Sin especificar —</option>
            ${depositos.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("")}
          </select></label>
          <label>Almacén intermedio<select class="input" name="almacenIntermedioId">
            <option value="">— Sin especificar —</option>
            ${depositos.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("")}
          </select></label>
          <label class="span2">Notas<textarea class="input" name="notes"></textarea></label>
        </div>
        <div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button><button type="submit" class="btn btn-primary">Crear OF</button></div>
      </form>`;
    }
  } else if (kind === "streetview") {
    body = `<div class="sv-modal">
      <div class="panel-head"><h3>360° — ${esc(opts.label || "Vista de calle")}</h3><button type="button" class="btn btn-ghost btn-sm" data-action="close-modal">✕</button></div>
      <div id="sv-pano" class="sv-pano-box"><div class="gmap-sv-loading">Buscando cobertura de Street View…</div></div>
    </div>`;
  }
  host.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal-box ${kind === "streetview" ? "modal-box-wide" : ""}" data-stop>${body}</div></div>`;
  host.classList.remove("hidden");
  requestAnimationFrame(() => host.querySelector(".modal-backdrop")?.classList.add("show"));
  if (kind === "streetview") openStreetView("sv-pano", opts.lat, opts.lng);
  if (kind === "location" && opts.id) {
    const editedLoc = getById("locations", opts.id);
    if (editedLoc?.lat && editedLoc?.lng) {
      mountPickerMap("mapa-picker", editedLoc.lat, editedLoc.lng, (nlat, nlng) => { $("#loc-lat").value = nlat; $("#loc-lng").value = nlng; });
    }
  }
}

/** Abre el modal de Street View real para un punto — nunca una imagen
 * inventada: si Google no tiene cobertura ahí, openStreetView() ya escribe el
 * aviso "no disponible" dentro del propio contenedor. */
function openStreetViewModal(lat, lng, label) {
  openModal("streetview", { lat, lng, label });
}
function closeModal() {
  const host = $("#modal-host");
  host.classList.add("hidden");
  host.innerHTML = "";
}

/* ---------------------------------------------------------------------------
   21. ENVÍO DE FORMULARIOS
   ------------------------------------------------------------------------- */
function parseItemsText(text) {
  return (text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const parts = line.split(",");
    const qty = parseInt(parts[parts.length - 1], 10);
    const hasQty = !isNaN(qty) && parts.length > 1;
    return { product: (hasQty ? parts.slice(0, -1) : parts).join(",").trim(), qty: hasQty ? qty : 1 };
  });
}

async function handleFormSubmit(form) {
  const kind = form.dataset.form;
  const fd = new FormData(form);
  const val = (k) => (fd.get(k) || "").toString().trim();

  if (kind === "order") {
    const id = form.dataset.id || uid("ord");
    const existing = form.dataset.id ? getById("orders", id) : null;
    const customer = getById("customers", val("customerId"));
    const rec = existing ? { ...existing } : { id, history: [{ from: null, to: "pendiente", date: nowISO() }], status: "pendiente", dispatchDate: null, actualDeliveryDate: null, incidentId: null };
    rec.number = val("number"); rec.customerId = val("customerId"); rec.customerName = customer ? customer.name : rec.customerName || "";
    rec.locationId = customer ? customer.locationId : rec.locationId;
    rec.phone = val("phone") || (customer ? customer.phone : "");
    rec.address = val("address"); rec.orderDate = val("orderDate"); rec.expectedDate = val("expectedDate"); rec.expectedTime = val("expectedTime");
    rec.priority = val("priority"); rec.transportId = val("transportId") || null;
    rec.items = parseItemsText(val("itemsText")); rec.notes = val("notes");
    await persist("orders", rec);
    toast(existing ? "Pedido actualizado" : "Pedido creado");
    location.hash = `#/pedidos/${rec.id}`;
  } else if (kind === "po") {
    const id = form.dataset.id || uid("po");
    const existing = form.dataset.id ? getById("purchase_orders", id) : null;
    const supplier = getById("suppliers", val("supplierId"));
    const supplierLoc = supplier ? getById("locations", supplier.locationId) : null;
    const rec = existing ? { ...existing } : { id, history: [{ from: null, to: "generada", date: nowISO() }], status: "generada", actualArrival: null };
    rec.number = val("number"); rec.supplierId = val("supplierId"); rec.supplierName = supplier ? supplier.name : rec.supplierName || "";
    rec.supplierAddress = supplierLoc ? supplierLoc.address : rec.supplierAddress || "";
    rec.locationId = supplier ? supplier.locationId : rec.locationId;
    rec.destination = val("destination"); rec.transportId = val("transportId") || null;
    rec.issueDate = val("issueDate"); rec.expectedDispatch = val("expectedDispatch"); rec.expectedArrival = val("expectedArrival");
    rec.items = parseItemsText(val("itemsText")); rec.notes = val("notes");
    await persist("purchase_orders", rec);
    toast(existing ? "OC actualizada" : "OC creada");
    location.hash = `#/compras/${rec.id}`;
  } else if (kind === "incident") {
    const rec = { id: uid("inc"), title: val("title"), date: val("date"), priority: val("priority"), status: "abierta",
      relatedType: val("relatedType") || null, relatedId: val("relatedId") || null, responsible: val("responsible"), description: val("description"), resolution: "", resolutionDate: null };
    await persist("incidents", rec);
    toast("Incidencia creada");
    location.hash = `#/incidencias/${rec.id}`;
  } else if (kind === "transport-quick") {
    const editing = !!form.dataset.id;
    const existing = editing ? getById("transports", form.dataset.id) : null;
    const rec = {
      ...(existing || {}),
      id: form.dataset.id || uid("tra"),
      name: val("name"), type: val("type"), contact: val("contact"), phone: val("phone"), email: val("email"),
      vehicleTypes: fd.getAll("vehicleTypes"),
      notes: existing ? existing.notes : "",
    };
    await persist("transports", rec);

    let msg = editing ? "Transporte actualizado" : "Transporte creado";
    const originCity = val("originCity"), destinationCity = val("destinationCity");
    if (originCity && destinationCity) {
      const originProvince = val("originProvince"), destinationProvince = val("destinationProvince");
      let originGeo = null, destGeo = null;
      try {
        const [originResults, destResults] = await Promise.all([
          geocodeAddress([originCity, originProvince, "Argentina"].filter(Boolean).join(", ")),
          geocodeAddress([destinationCity, destinationProvince, "Argentina"].filter(Boolean).join(", ")),
        ]);
        originGeo = originResults[0] || null;
        destGeo = destResults[0] || null;
      } catch { /* geocodificación falló: se guarda igual la ruta, sin coordenadas */ }
      const routeRec = {
        id: uid("rut"), transportId: rec.id,
        originCity, originProvince, originLat: originGeo?.lat ?? null, originLng: originGeo?.lng ?? null,
        destinationCity, destinationProvince, destinationLat: destGeo?.lat ?? null, destinationLng: destGeo?.lng ?? null,
        label: `${originCity} → ${destinationCity}`, frequency: "", notes: "", source: "app", verifiedAt: todayISO(),
      };
      await persist("routes", routeRec);
      msg += originGeo && destGeo ? " con su ruta" : ". No se pudo ubicar el origen/destino exacto en el mapa, pero la ruta quedó cargada";
    }
    closeModal(); toast(msg); renderApp();
  } else if (kind === "location-quick") {
    const editing = !!form.dataset.id;
    const existing = editing ? getById("locations", form.dataset.id) : null;
    const latVal = val("lat"), lngVal = val("lng");
    const rec = {
      ...(existing || {}),
      id: form.dataset.id || uid("loc"),
      type: val("type") || "otro", name: val("name"), address: val("address"), city: val("city"), province: val("province"),
      contact: val("contact"), phone: val("phone"),
      lat: latVal ? parseFloat(latVal) : null, lng: lngVal ? parseFloat(lngVal) : null,
    };
    await persist("locations", rec);
    // Un cliente o proveedor recién ubicado (o editado) queda disponible/actualizado
    // de inmediato en los formularios de pedidos / OC, sin tener que cargarlo dos veces.
    const linkedCustomer = editing ? state.customers.find((c) => c.locationId === rec.id) : null;
    const linkedSupplier = editing ? state.suppliers.find((s) => s.locationId === rec.id) : null;
    if (rec.type === "cliente") {
      if (linkedCustomer) {
        await persist("customers", { ...linkedCustomer, name: rec.name, phone: rec.phone || "" });
      } else {
        await persist("customers", { id: uid("cus"), name: rec.name, phone: rec.phone || "", locationId: rec.id, notes: "" });
      }
    } else if (rec.type === "proveedor") {
      if (linkedSupplier) {
        await persist("suppliers", { ...linkedSupplier, name: rec.name, contact: rec.contact || "", phone: rec.phone || "", email: val("email") || "", notes: val("notes") || "" });
      } else {
        await persist("suppliers", { id: uid("sup"), name: rec.name, locationId: rec.id, contact: rec.contact || "", phone: rec.phone || "", email: val("email") || "", notes: val("notes") || "", usualTransports: [] });
      }
    }
    closeModal(); toast(editing ? "Ubicación actualizada" : "Ubicación creada"); renderApp();
  } else if (kind === "task-quick") {
    const rec = { id: uid("tsk"), title: val("title"), date: val("date"), time: val("time"), priority: val("priority"), category: val("category") || "General", status: "pendiente", notes: val("notes") };
    await persist("tasks", rec);
    closeModal(); toast("Tarea creada"); renderApp();
  } else if (kind === "inv-supplier") {
    const editing = !!form.dataset.id;
    const rec = { id: form.dataset.id || uid("isu"), name: val("name"), contact: val("contact"), phone: val("phone"), email: val("email"), notes: val("notes") };
    await persist("inv_suppliers", rec);
    closeModal(); toast(editing ? "Proveedor actualizado" : "Proveedor creado"); renderApp();
  } else if (kind === "inv-product") {
    const editing = !!form.dataset.id;
    const numVal = (k) => { const v = val(k); return v === "" ? null : parseFloat(v); };
    const intVal = (k) => { const v = val(k); return v === "" ? null : parseInt(v, 10); };
    const rec = {
      id: form.dataset.id || uid("prd"), name: val("name"), marca: val("marca") || null, sku: val("sku") || null, categoria: val("categoria") || null,
      supplierId: val("supplierId") || null, unit: val("unit"), packageSize: numVal("packageSize"),
      minQty: numVal("minQty"), optimalQty: numVal("optimalQty"), maxQty: numVal("maxQty"), diasAlerta: intVal("diasAlerta"),
      manejaLote: val("manejaLote") === "on", manejaVencimiento: val("manejaVencimiento") === "on",
      notes: val("notes"),
    };
    await persist("products", rec);
    closeModal(); toast(editing ? "Producto actualizado" : "Producto creado"); renderApp();
  } else if (kind === "inv-lot") {
    const editing = !!form.dataset.id;
    const existing = editing ? getById("inventory_lots", form.dataset.id) : null;
    const qtyVal = val("quantity");
    const newQty = qtyVal === "" ? null : parseFloat(qtyVal);
    const costoVal = val("costoUnitario");
    const rec = {
      id: form.dataset.id || uid("lot"), productId: form.dataset.productId,
      numeroLote: val("numeroLote") || null, quantity: newQty,
      cantidadInicial: existing ? (existing.cantidadInicial ?? existing.quantity) : newQty,
      cantidadComprometida: existing?.cantidadComprometida ?? 0,
      fechaElaboracion: val("fechaElaboracion") || null, expiryDate: val("expiryDate") || null,
      fechaRecepcion: val("fechaRecepcion") || null, deposito: val("deposito") || null,
      remito: val("remito") || null, ordenCompra: val("ordenCompra") || null,
      costoUnitario: costoVal === "" ? null : parseFloat(costoVal),
      bloqueado: existing?.bloqueado || false, motivoBloqueo: existing?.motivoBloqueo || "",
      notes: val("notes"),
    };
    await persist("inventory_lots", rec);
    if (!editing) {
      await registerMovement({ productId: rec.productId, lotId: rec.id, type: "recepcion", quantity: newQty ?? 0, previousQty: 0, newQty: newQty ?? 0, reason: "Alta de lote", relatedDocument: rec.remito || rec.ordenCompra || "" });
    } else if (existing && existing.quantity !== newQty) {
      const prev = existing.quantity ?? 0;
      const diff = (newQty ?? 0) - prev;
      await registerMovement({ productId: rec.productId, lotId: rec.id, type: diff >= 0 ? "ajuste_positivo" : "ajuste_negativo", quantity: Math.abs(diff), previousQty: prev, newQty: newQty ?? 0, reason: "Ajuste manual desde edición de lote" });
    }
    closeModal(); toast(editing ? "Lote actualizado" : "Lote agregado"); renderApp();
  } else if (kind === "inv-salida") {
    const productId = form.dataset.productId;
    const qty = parseFloat(val("quantity"));
    if (!qty || qty <= 0) { toast("Ingresá una cantidad válida", "warn"); return; }
    const { alloc, remaining } = fefoAllocate(productId, qty);
    if (remaining > 0) {
      const p = getById("products", productId);
      toast(`Stock insuficiente: faltan ${remaining} UND (de ${qty} pedidas). No se registró nada.`, "warn");
      return;
    }
    const reason = val("reason"), doc = val("relatedDocument");
    for (const a of alloc) {
      const previousQty = a.lot.quantity;
      const newQty = previousQty - a.qty;
      await persist("inventory_lots", { ...a.lot, quantity: newQty });
      await registerMovement({ productId, lotId: a.lot.id, type: "salida", quantity: a.qty, previousQty, newQty, reason, relatedDocument: doc });
    }
    closeModal();
    toast(`Salida registrada (FEFO): ${alloc.map((a) => `${a.qty} de lote ${a.lot.numeroLote || a.lot.id.slice(0, 6)}`).join(", ")}`);
    renderApp();
  } else if (kind === "inv-merma" || kind === "inv-devolucion") {
    const lot = getById("inventory_lots", val("lotId"));
    if (!lot) { toast("Seleccioná un lote", "warn"); return; }
    const qty = parseFloat(val("quantity"));
    if (!qty || qty <= 0) { toast("Ingresá una cantidad válida", "warn"); return; }
    const sign = kind === "inv-merma" ? -1 : 1;
    const previousQty = lot.quantity ?? 0;
    const newQty = Math.max(0, previousQty + sign * qty);
    await persist("inventory_lots", { ...lot, quantity: newQty });
    await registerMovement({ productId: lot.productId, lotId: lot.id, type: kind === "inv-merma" ? "merma" : "devolucion", quantity: qty, previousQty, newQty, reason: val("reason") });
    closeModal(); toast(kind === "inv-merma" ? "Merma registrada" : "Devolución registrada"); renderApp();
  } else if (kind === "inv-ajuste") {
    const lot = getById("inventory_lots", val("lotId"));
    if (!lot) { toast("Seleccioná un lote", "warn"); return; }
    const qty = parseFloat(val("quantity"));
    if (!qty || qty <= 0) { toast("Ingresá una cantidad válida", "warn"); return; }
    const negativo = val("direction") === "negativo";
    const previousQty = lot.quantity ?? 0;
    const newQty = Math.max(0, previousQty + (negativo ? -qty : qty));
    await persist("inventory_lots", { ...lot, quantity: newQty });
    await registerMovement({ productId: lot.productId, lotId: lot.id, type: negativo ? "ajuste_negativo" : "ajuste_positivo", quantity: qty, previousQty, newQty, reason: val("reason") });
    closeModal(); toast("Ajuste registrado"); renderApp();
  } else if (kind === "inv-lot-block") {
    const lot = getById("inventory_lots", form.dataset.id);
    if (!lot) return;
    const motivo = val("reason");
    await persist("inventory_lots", { ...lot, bloqueado: true, motivoBloqueo: motivo });
    await registerMovement({ productId: lot.productId, lotId: lot.id, type: "bloqueo", quantity: 0, reason: motivo });
    closeModal(); toast("Lote bloqueado"); renderApp();
  } else if (kind === "inv-lot-location") {
    const lotId = form.dataset.id;
    const label = val("locationLabel");
    const qty = parseFloat(val("quantity"));
    if (!label || !qty) { toast("Completá ubicación y cantidad", "warn"); return; }
    await persist("lot_locations", { id: uid("loli"), lotId, locationLabel: label, quantity: qty });
    closeModal(); toast("Ubicación agregada"); renderApp();
  } else if (kind === "inv-alert-settings") {
    const yellow = parseInt(val("yellow"), 10) || 30;
    const orange = parseInt(val("orange"), 10) || 7;
    await persist("app_settings", { id: "alert_thresholds", value: { yellow, orange } });
    closeModal(); toast("Umbrales de alerta actualizados"); renderApp();
  } else if (kind === "prod-config-item") {
    const size = form.dataset.size;
    const productId = val("productId");
    const quantity = parseFloat(val("quantity"));
    if (!productId || !quantity || quantity <= 0) { toast("Elegí un producto y una cantidad válida", "warn"); return; }
    let config = boxConfigForSize(size);
    if (!config) {
      config = { id: uid("bxc"), size, name: `Caja ${boxSizeLabel(size)}`, notes: "" };
      await persist("box_configs", config);
    }
    const existingId = form.dataset.id;
    const rec = { id: existingId || uid("bxi"), boxConfigId: config.id, productId, quantity };
    await persist("box_config_items", rec);
    closeModal(); toast(existingId ? "Producto actualizado" : "Producto agregado a la caja"); renderApp();
  } else if (kind === "prod-settings") {
    const boxMinutes = {};
    BOX_SIZES.forEach((sz) => { boxMinutes[sz] = parseFloat(val(`min_${sz}`)) || 0; });
    const prepMinutes = parseFloat(val("prepMinutes")) || 0;
    const packMinutes = parseFloat(val("packMinutes")) || 0;
    const dailyHours = parseFloat(val("dailyHours")) || 0;
    const jornadaInicio = val("jornadaInicio") || "08:00";
    const jornadaFin = val("jornadaFin") || "17:00";
    const descansoMin = parseFloat(val("descansoMin")) || 0;
    const efficiencyByPeople = {};
    [1, 2, 3, 4, 5, 6, 7, 8].forEach((n) => { efficiencyByPeople[n] = Math.min(100, Math.max(1, parseFloat(val(`eff_${n}`)) || 100)); });
    await persist("app_settings", { id: "production_settings", value: { boxMinutes, prepMinutes, packMinutes, dailyHours, jornadaInicio, jornadaFin, descansoMin, efficiencyByPeople } });
    closeModal(); toast("Configuración de producción actualizada"); renderApp();
  } else if (kind === "sim-pedido") {
    const numero = val("numero");
    const cliente = val("cliente");
    const fechaEntrega = val("fechaEntrega");
    const size = val("size") || "estandar";
    const quantity = parseFloat(val("quantity"));
    if (!numero || !cliente || !quantity || quantity <= 0) { toast("Completá número, cliente y una cantidad válida", "warn"); return; }
    if (!simuladorCode) simuladorCode = `TP-${String(++simuladorCounter).padStart(3, "0")}`;
    const existingId = form.dataset.id;
    if (existingId) {
      const idx = simuladorPedidos.findIndex((p) => p.id === existingId);
      if (idx >= 0) simuladorPedidos[idx] = { ...simuladorPedidos[idx], numero, cliente, fechaEntrega, size, quantity };
    } else {
      simuladorPedidos.push({ id: uid("simp"), numero, cliente, fechaEntrega, size, quantity });
    }
    closeModal(); toast(existingId ? "Pedido actualizado" : "Pedido agregado a la tanda"); renderApp();
  } else if (kind === "prod-real-time") {
    const o = getById("production_orders", form.dataset.id);
    if (!o) return;
    const actualMinutes = parseFloat(val("actualMinutes"));
    if (isNaN(actualMinutes) || actualMinutes < 0) { toast("Ingresá un tiempo válido", "warn"); return; }
    await persist("production_orders", { ...o, actualMinutes });
    closeModal(); toast("Tiempo real registrado"); renderApp();
  } else if (kind === "gerencia-objetivos") {
    const cumplimiento = parseFloat(val("cumplimiento"));
    const utilizacion = parseFloat(val("utilizacion"));
    const entregasATiempo = parseFloat(val("entregasATiempo"));
    const productividadRaw = val("productividad");
    const productividad = productividadRaw === "" ? null : parseFloat(productividadRaw);
    await persist("app_settings", { id: "gerencia_objetivos", value: {
      cumplimiento: isNaN(cumplimiento) ? 95 : cumplimiento,
      utilizacion: isNaN(utilizacion) ? 80 : utilizacion,
      entregasATiempo: isNaN(entregasATiempo) ? 95 : entregasATiempo,
      productividad: (productividad != null && !isNaN(productividad)) ? productividad : null,
    } });
    closeModal(); toast("Objetivos actualizados"); renderApp();
  } else if (kind === "exp-dispatch") {
    const orderId = form.dataset.orderId;
    const existing = dispatchDetail(orderId);
    const numOrNull = (k) => { const v = val(k); return v === "" ? null : parseFloat(v); };
    const boxesVal = val("boxesCount");
    const rec = {
      id: existing?.id || uid("dsp"), orderId,
      boxesCount: boxesVal === "" ? null : parseInt(boxesVal, 10),
      boxType: val("boxType") || null,
      weightKg: numOrNull("weightKg"), volumeM3: numOrNull("volumeM3"), orderValue: numOrNull("orderValue"),
      receptionSchedule: val("receptionSchedule") || null, notes: val("notes"),
      updatedAt: nowISO(),
    };
    await persist("dispatch_details", rec);
    closeModal(); toast("Datos de despacho guardados"); renderApp();
  } else if (kind === "exp-rate") {
    const transportId = form.dataset.transportId;
    const existing = transportRate(transportId);
    const numVal = (k) => parseFloat(val(k)) || 0;
    const rec = { id: existing?.id || uid("trt"), transportId, fixedAmount: numVal("fixedAmount"), perKm: numVal("perKm"), perBox: numVal("perBox"), perKg: numVal("perKg"), percent: numVal("percent"), notes: val("notes"), updatedAt: nowISO() };
    await persist("transport_rates", rec);
    closeModal(); toast("Tarifa guardada"); renderApp();
  } else if (kind === "zona") {
    const editing = !!form.dataset.id;
    const existing = editing ? getById("logistics_zones", form.dataset.id) : null;
    const numVal2 = (k) => parseFloat(val(k)) || 0;
    const rec = {
      id: form.dataset.id || uid("zona"),
      name: val("name"),
      color: existing?.color || ZONE_PALETTE[state.logistics_zones.length % ZONE_PALETTE.length],
      provinces: fd.getAll("provinces"),
      fixedAmount: numVal2("fixedAmount"), perKm: numVal2("perKm"), perBox: numVal2("perBox"), perKg: numVal2("perKg"), percent: numVal2("percent"),
      notes: val("notes"), updatedAt: nowISO(),
    };
    await persist("logistics_zones", rec);
    mapZoneEditing = null;
    toast(editing ? "Zona actualizada" : "Zona creada"); renderApp();
  } else if (kind === "exp-config") {
    const cfg = expedicionConfig();
    await persist("app_settings", { id: "expedicion_config", value: {
      origenLocationId: val("origenLocationId") || null,
      criterios: { costo: parseFloat(val("critCosto")) || 0, tiempo: parseFloat(val("critTiempo")) || 0, cumplimiento: parseFloat(val("critCumplimiento")) || 0 },
      canalPreferido: val("canalPreferido") || "whatsapp",
      plantillas: { whatsapp: val("plantillaWhatsapp") || cfg.plantillas.whatsapp, email: val("plantillaEmail") || cfg.plantillas.email, sms: val("plantillaSms") || cfg.plantillas.sms },
    } });
    closeModal(); toast("Configuración de Expedición actualizada"); renderApp();
  } else if (kind === "exp-despachar") {
    const orderId = form.dataset.orderId;
    if (val("docsListas") !== "on") { toast("Confirmá que la documentación está disponible", "warn"); return; }
    await confirmarDespacho(orderId);
    closeModal();
  } else if (kind === "of-new") {
    try {
      const boxConfigId = val("boxConfigId");
      const cantidadPlanificada = parseFloat(val("cantidadPlanificada")) || 0;
      const rec = await createManufacturingOrder({
        boxConfigId, cantidadPlanificada,
        fechaPlanificacion: val("fechaPlanificacion") || null, fechaPrevista: val("fechaPrevista") || null,
        almacenOrigenId: val("almacenOrigenId") || null, almacenIntermedioId: val("almacenIntermedioId") || null,
        notes: val("notes"),
      });
      closeModal(); toast(`OF ${rec.numero} creada`); location.hash = `#/of_produccion/${rec.id}`;
    } catch (e) {
      toast(e.message || "No se pudo crear la OF", "warn");
    }
  } else if (kind === "of-consumo") {
    if (ofScanBusy) return;
    ofScanBusy = true;
    const ofId = form.dataset.id;
    const codigo = val("codigo");
    const cantidad = parseFloat(val("cantidad")) || 0;
    try {
      const result = await registrarConsumoOF(ofId, codigo, cantidad);
      ofScanMessages[ofId] = { type: "ok", text: `${result.cantidad} × ${result.product.name} registrado` };
      toast("Consumo registrado");
    } catch (e) {
      ofScanMessages[ofId] = { type: "err", text: e.message || "No se pudo registrar el consumo" };
      toast(e.message || "No se pudo registrar el consumo", "warn");
    } finally {
      ofScanBusy = false;
      renderMainOnly();
    }
  } else if (kind === "of-avance") {
    const ofId = form.dataset.id;
    const cantidad = parseFloat(val("cantidad")) || 0;
    try {
      await registrarAvanceProduccion(ofId, cantidad);
    } catch (e) {
      toast(e.message || "No se pudo registrar el avance", "warn");
    }
  } else if (kind === "of-reemplazo-original") {
    const ofId = form.dataset.id;
    const of = getById("manufacturing_orders", ofId);
    const codigo = val("codigo");
    delete ofReplacementErrors[ofId];
    try {
      const product = findProductByScanCode(codigo);
      if (!product) throw new Error(`Código no reconocido: "${codigo}"`);
      const row = ofNeedsRows(of).find((r) => r.productId === product.id && r.estado !== "sustituido");
      if (!row) throw new Error(`"${product.name}" no es un componente pendiente de esta OF`);
      if (!(row.pendiente > 0)) throw new Error(`"${product.name}" no tiene cantidad pendiente para reemplazar`);
      ofReplacementState[ofId] = { step: "substitute", originalProductId: product.id, originalName: product.name, cantidad: row.pendiente };
    } catch (e) {
      ofReplacementErrors[ofId] = e.message || "No se pudo identificar el producto original";
    }
    renderMainOnly();
  } else if (kind === "of-reemplazo-sustituto-1") {
    const ofId = form.dataset.id;
    const codigo = val("codigo");
    const motivo = val("motivo");
    const st = ofReplacementState[ofId];
    delete ofReplacementErrors[ofId];
    try {
      if (!st || st.step !== "substitute") throw new Error("Reiniciá el flujo de reemplazo");
      if (!motivo) throw new Error("El motivo es obligatorio");
      const product = findProductByScanCode(codigo);
      if (!product) throw new Error(`Código no reconocido: "${codigo}"`);
      if (product.id === st.originalProductId) throw new Error("El sustituto no puede ser el mismo producto original");
      ofReplacementState[ofId] = { ...st, step: "confirm", substituteProductId: product.id, substituteName: product.name, substituteCode: codigo, motivo };
    } catch (e) {
      ofReplacementErrors[ofId] = e.message || "No se pudo identificar el producto sustituto";
    }
    renderMainOnly();
  } else if (kind === "of-reemplazo-sustituto-2") {
    const ofId = form.dataset.id;
    const codigo = val("codigo");
    const st = ofReplacementState[ofId];
    delete ofReplacementErrors[ofId];
    if (!st || st.step !== "confirm") {
      ofReplacementErrors[ofId] = "Reiniciá el flujo de reemplazo";
    } else if (codigo !== st.substituteCode) {
      ofReplacementState[ofId] = { ...st, step: "substitute" };
      ofReplacementErrors[ofId] = "El segundo escaneo no coincide con el primero. Volvé a escanear el sustituto.";
    } else {
      try {
        await confirmarReemplazoOF(ofId);
        return;
      } catch (e) {
        ofReplacementErrors[ofId] = e.message || "No se pudo confirmar el reemplazo";
      }
    }
    renderMainOnly();
  } else if (kind === "of-buscar-codigo") {
    const codigo = val("codigo").trim();
    const of = state.manufacturing_orders.find((o) => o.codigoBarras === codigo || o.numero === codigo);
    if (of) location.hash = `#/of_produccion/${of.id}`;
    else toast(`No se encontró ninguna OF con el código "${codigo}"`, "warn");
  }
}

/* ---------------------------------------------------------------------------
   21. EXPEDICIÓN — centro de decisión operativa de despacho
   ---------------------------------------------------------------------------
   No crea un sistema paralelo: reutiliza pedidos (orders / ORDER_FLOW ya
   existente, sin tocarlo), clientes, ubicaciones (para origen/destino y
   distancia real) y transportistas. Sólo agrega 4 tablas nuevas (ver
   schema.sql): dispatch_details (datos físicos del pedido), transport_rates
   (tarifa configurable por transportista), transport_selections (decisión
   del operador, con trazabilidad completa) y client_notifications (aviso al
   cliente — idempotente, sin envíos reales todavía).
   ------------------------------------------------------------------------- */
/* --- 21.1 Etapa derivada (no se guarda; se calcula sobre orders.status) ---
   La lógica pura vive en domain/expedicion.js (expedicionStageFromStatus);
   este wrapper sólo le busca el dato que le falta (si el pedido ya tiene
   una selección de transporte vigente) a partir del `state` local. */
const EXPEDICION_STAGE_META = {
  preparando:           { label: "Preparando",              cls: "st-blue" },
  listo:                { label: "Listo",                   cls: "st-violet" },
  pendiente_transporte: { label: "Pendiente de transporte",  cls: "st-yellow" },
  despachado:           { label: "Despachado",               cls: "st-orange" },
  en_transito:          { label: "En tránsito",              cls: "st-orange" },
  entregado:            { label: "Entregado",                cls: "st-green" },
  incidencia:           { label: "Incidencia",               cls: "st-red" },
  cancelado:            { label: "Cancelado",                cls: "st-gray" },
};
function expedicionStage(o) {
  return expedicionStageFromStatus(o.status, !!latestSelection(o.id));
}

/* --- 21.2 Configuración de Expedición (app_settings: "expedicion_config") --- */
function expedicionConfig() {
  const row = getById("app_settings", "expedicion_config");
  const v = row?.value || {};
  return {
    origenLocationId: v.origenLocationId || null,
    criterios: { costo: 40, tiempo: 30, cumplimiento: 30, ...(v.criterios || {}) },
    canalPreferido: v.canalPreferido || "whatsapp",
    plantillas: {
      whatsapp: "Hola [NOMBRE], tu pedido #[PEDIDO] fue despachado con [TRANSPORTISTA] ([CAJAS] cajas). Fecha estimada de entrega: [FECHA].",
      email: "Hola [NOMBRE],\n\nTe confirmamos que tu pedido #[PEDIDO] fue despachado con [TRANSPORTISTA] ([CAJAS] cajas).\nFecha estimada de entrega: [FECHA].\n\nSaludos, Logística Perona.",
      sms: "Pedido #[PEDIDO] despachado con [TRANSPORTISTA]. Entrega estimada: [FECHA].",
      ...(v.plantillas || {}),
    },
  };
}
function expedicionOrigin() {
  const cfg = expedicionConfig();
  let loc = cfg.origenLocationId ? getById("locations", cfg.origenLocationId) : null;
  if (!loc) loc = state.locations.find((l) => l.type === "deposito" && l.lat != null && l.lng != null) || null;
  return loc && loc.lat != null && loc.lng != null ? loc : null;
}
function kmForOrder(o) {
  const origin = expedicionOrigin();
  const dest = getById("locations", o.locationId);
  if (!origin || !dest || dest.lat == null || dest.lng == null) return null;
  return haversineKm(origin.lat, origin.lng, dest.lat, dest.lng);
}

/* --- 21.3 Datos físicos del despacho y decisión de transporte (1 a 1 / historial) --- */
function dispatchDetail(orderId) { return state.dispatch_details.find((d) => d.orderId === orderId) || null; }
function transportRate(transportId) { return state.transport_rates.find((r) => r.transportId === transportId) || null; }
function transportSelectionsForOrder(orderId) {
  return state.transport_selections.filter((s) => s.orderId === orderId).slice().sort((a, b) => new Date(b.selectedAt) - new Date(a.selectedAt));
}
function latestSelection(orderId) { return transportSelectionsForOrder(orderId)[0] || null; }

/* --- 21.4 Historial real de un transportista (nunca inventado: si no hay
   al menos 3 envíos con datos, se marca explícitamente "sin historial") --- */
function transportHistoryStats(transportId) {
  const shipments = state.orders.filter((o) => o.transportId === transportId && o.dispatchDate);
  const delivered = shipments.filter((o) => o.status === "entregado" && o.actualDeliveryDate);
  const durations = delivered.map((o) => (new Date(o.actualDeliveryDate) - new Date(o.dispatchDate)) / 36e5).filter((h) => h > 0);
  const onTime = delivered.filter((o) => o.expectedDate && o.actualDeliveryDate <= o.expectedDate).length;
  const shipmentIds = shipments.map((o) => o.id);
  const incidents = state.incidents.filter((i) => i.relatedType === "order" && shipmentIds.includes(i.relatedId));
  return {
    envios: shipments.length,
    entregados: delivered.length,
    avgDurationHours: durations.length >= 3 ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    onTimePct: delivered.length >= 3 ? Math.round((onTime / delivered.length) * 100) : null,
    incidentes: incidents.length,
  };
}
function transportCostStats(transportId) {
  const selections = state.transport_selections.filter((s) => s.transportId === transportId && s.estimatedCost != null);
  if (!selections.length) return { count: 0, total: null, avg: null, avgPerBox: null };
  const total = selections.reduce((a, s) => a + s.estimatedCost, 0);
  const perBox = selections.map((s) => { const dd = dispatchDetail(s.orderId); return dd?.boxesCount ? s.estimatedCost / dd.boxesCount : null; }).filter((v) => v != null);
  return { count: selections.length, total, avg: total / selections.length, avgPerBox: perBox.length ? perBox.reduce((a, b) => a + b, 0) / perBox.length : null };
}

/* --- 21.5 Costo estimado de una alternativa (fórmula configurable, ver
   schema.sql) — lógica pura movida a domain/expedicion.js (transportRateCost) --- */

/* --- 21.6 Comparador: alternativas de transporte para un pedido --- */
function expedicionAlternativas(o) {
  const dd = dispatchDetail(o.id);
  const km = kmForOrder(o);
  return state.transports.map((t) => {
    const cost = transportRateCost(transportRate(t.id), dd, km);
    const hist = transportHistoryStats(t.id);
    return {
      transport: t, km, costo: cost.total, sinTarifa: cost.missingRate,
      tiempoHoras: hist.avgDurationHours, cumplimientoPct: hist.onTimePct,
      muestras: hist.envios, insuficienteHistorial: hist.envios < 3,
    };
  });
}
/* --- 21.7 Requieren atención (dashboard + badge del menú) --- */
function expedicionRequierenAtencion() {
  return state.orders.filter((o) => {
    if (["entregado", "cancelado"].includes(o.status)) return false;
    if (o.status === "incidencia") return true;
    const stage = expedicionStage(o);
    if (stage === "pendiente_transporte") return true;
    if (stage === "listo" && !dispatchDetail(o.id)?.boxesCount) return true;
    return false;
  });
}
/* --- 21.8 Vista: Centro de expedición (dashboard del operador) --- */
let expedicionTab = "centro"; // "centro" | "costos"
let expedicionAnalisisAbierto = {};

function expedicionOrderCard(o) {
  const stage = EXPEDICION_STAGE_META[expedicionStage(o)];
  const dd = dispatchDetail(o.id);
  const sel = latestSelection(o.id);
  const transport = sel ? getById("transports", sel.transportId) : null;
  return `<a href="#/expedicion/${o.id}" class="order-card">
    <div class="order-card-top"><span class="order-num">#${esc(o.number)}</span>${priorityBadge(o.priority)}</div>
    <div class="order-card-customer">${esc(o.customerName)}</div>
    <div class="order-card-addr">📍 ${esc(o.address || "")}</div>
    <div class="order-card-bottom">${statusBadge(stage)}${dd?.boxesCount ? `<span class="badge st-gray">📦 ${dd.boxesCount}</span>` : ""}${transport ? `<span class="badge st-blue">🚚 ${esc(transport.name)}</span>` : ""}</div>
  </a>`;
}

function viewExpedicion() {
  if (expedicionTab === "costos") return viewExpedicionCostos();
  const preparando = state.orders.filter((o) => expedicionStage(o) === "preparando");
  const listos = state.orders.filter((o) => ["listo", "pendiente_transporte"].includes(expedicionStage(o)));
  const despachadosHoy = state.orders.filter((o) => o.status === "despachado" && (o.dispatchDate || "").slice(0, 10) === todayISO());
  const enTransito = state.orders.filter((o) => o.status === "en_camino");
  const conProblemas = state.orders.filter((o) => o.status === "incidencia");
  const entregasHoy = state.orders.filter((o) => o.expectedDate === todayISO() && !["entregado", "cancelado"].includes(o.status));
  const atencion = expedicionRequierenAtencion();
  const mensajesPendientes = state.client_notifications.filter((n) => n.status === "pendiente").length;
  const mensajesEnviados = state.client_notifications.filter((n) => ["enviado", "entregado"].includes(n.status)).length;

  return `<div class="view-list exp-view">
    <div class="list-toolbar">
      <div class="chip-row" style="margin:0">
        <button class="chip ${expedicionTab === "centro" ? "active" : ""}" data-exp-tab="centro">🚚 Centro de expedición</button>
        <button class="chip ${expedicionTab === "costos" ? "active" : ""}" data-exp-tab="costos">💰 Costos y transportistas</button>
      </div>
      <button class="btn btn-ghost" data-action="open-modal" data-modal="exp-config">⚙️ Criterios y plantillas</button>
    </div>

    <div class="kpi-grid">
      ${kpiCard(preparando.length, "Preparando", "📦", "kpi-blue", 0)}
      ${kpiCard(listos.length, "Listos para despachar", "🟣", "kpi-violet", 40)}
      ${kpiCard(despachadosHoy.length, "Despachados hoy", "🚚", "kpi-orange", 80)}
      ${kpiCard(conProblemas.length, "Con problemas", "⚠️", "kpi-red", 120)}
      ${kpiCard(mensajesEnviados.length, "Mensajes enviados", "✅", "kpi-green", 160)}
      ${kpiCard(mensajesPendientes.length, "Mensajes pendientes", "📩", "kpi-yellow", 200)}
    </div>

    ${atencion.length ? `<div class="panel">
      <div class="panel-head"><h3>⚠️ Requieren atención</h3></div>
      <div class="card-grid">${atencion.map(expedicionOrderCard).join("")}</div>
    </div>` : ""}

    <div class="panel">
      <div class="panel-head"><h3>Listos para despachar (${listos.length})</h3></div>
      ${listos.length ? `<div class="card-grid">${listos.map(expedicionOrderCard).join("")}</div>` : emptyState("📦", "Nada listo todavía", "Los pedidos aparecen aquí cuando pasan a Preparado / Controlado en Pedidos.")}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>En tránsito (${enTransito.length})</h3></div>
      ${enTransito.length ? `<div class="card-grid">${enTransito.map(expedicionOrderCard).join("")}</div>` : emptyState("🚚", "Nada en tránsito", "")}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Entregas programadas hoy (${entregasHoy.length})</h3></div>
      ${entregasHoy.length ? `<div class="card-grid">${entregasHoy.map(expedicionOrderCard).join("")}</div>` : emptyState("📅", "Sin entregas para hoy", "")}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Transportistas disponibles</h3></div>
      ${state.transports.length ? `<div class="card-grid">${state.transports.map((t) => `<a href="#/transporte/${t.id}" class="order-card"><div class="order-card-top"><span class="order-num">${esc(t.name)}</span></div><div class="order-card-addr">${vehicleBadges(t) || "Sin tipo de vehículo cargado"}</div></a>`).join("")}</div>` : emptyState("🚚", "Sin transportistas cargados", "", `<a href="#/transporte" class="btn btn-primary">Ir a Transporte</a>`)}
    </div>
  </div>`;
}

/* --- 21.9 Vista: ficha del pedido en Expedición (comparador + decisión + despacho + comunicación) --- */
function expedicionComStatusBadge(status) {
  const meta = { pendiente: { label: "Pendiente", cls: "st-yellow" }, enviando: { label: "Enviando", cls: "st-blue" }, enviado: { label: "Enviado", cls: "st-violet" }, entregado: { label: "Entregado", cls: "st-green" }, error: { label: "Error", cls: "st-red" } }[status] || { label: status, cls: "st-gray" };
  return statusBadge(meta);
}
function expedicionComparadorHTML(o, weights) {
  const alternativas = expedicionPuntuar(expedicionAlternativas(o), weights);
  if (!alternativas.length) return emptyState("🚚", "Sin transportistas cargados", "Cargá al menos un transportista para poder comparar.", `<a href="#/transporte" class="btn btn-primary">Ir a Transporte</a>`);
  const origin = expedicionOrigin();
  return `
    ${!origin ? `<div class="hint" style="margin-bottom:10px">📍 No hay un depósito con coordenadas configurado como origen — la distancia y el costo por km no se pueden calcular todavía. Configuralo en "⚙️ Criterios y plantillas".</div>` : ""}
    <div class="table-scroll">
    <table class="mini-table exp-comp-table">
      <thead><tr><th>Transportista</th><th>Costo</th><th>Tiempo est.</th><th>Cumplimiento</th><th>Distancia</th><th>Puntaje</th><th>Observaciones</th><th></th></tr></thead>
      <tbody>
        ${alternativas.map((a) => `<tr>
          <td><b>${esc(a.transport.name)}</b><br>${vehicleBadges(a.transport)}</td>
          <td>${a.sinTarifa ? `<span class="hint">Sin tarifa configurada</span>` : fmtMoney(a.costo)}</td>
          <td>${a.tiempoHoras != null ? a.tiempoHoras.toFixed(1) + " h" : `<span class="hint">${a.insuficienteHistorial ? "Sin historial suficiente" : "—"}</span>`}</td>
          <td>${a.cumplimientoPct != null ? a.cumplimientoPct + "% a tiempo" : `<span class="hint">${a.insuficienteHistorial ? "Sin historial suficiente" : "—"}</span>`}</td>
          <td>${a.km != null ? a.km.toFixed(0) + " km" : "—"}</td>
          <td>${a.score != null ? `<b>${a.score.toFixed(0)}</b><span class="hint"> (${a.basis}/3)</span>` : `<span class="hint">Sin datos</span>`}</td>
          <td>${a.muestras} envío${a.muestras === 1 ? "" : "s"} previo${a.muestras === 1 ? "" : "s"}${a.sinTarifa ? ` · <button type="button" class="link-more" style="background:none;border:none;cursor:pointer;padding:0;" data-action="open-modal" data-modal="exp-rate" data-id="${a.transport.id}">configurar tarifa</button>` : ""}</td>
          <td><button class="btn btn-primary btn-sm" data-action="exp-seleccionar" data-order-id="${o.id}" data-transport-id="${a.transport.id}">Seleccionar</button></td>
        </tr>`).join("")}
      </tbody>
    </table>
    </div>
    <div class="hint" style="margin-top:8px">El puntaje combina costo, tiempo y cumplimiento según los criterios configurados (costo ${weights.costo}% · tiempo ${weights.tiempo}% · cumplimiento ${weights.cumplimiento}%), recalculado sólo con los criterios que cada transportista realmente tiene disponibles — nunca se elige un transporte automáticamente, la decisión final es siempre del operador.</div>
  `;
}
function viewExpedicionFicha(id) {
  const o = getById("orders", id);
  if (!o) return emptyState("🚚", "Pedido no encontrado", "Puede haber sido eliminado.");
  const dd = dispatchDetail(o.id);
  const sel = latestSelection(o.id);
  const transport = sel ? getById("transports", sel.transportId) : getById("transports", o.transportId);
  const stage = EXPEDICION_STAGE_META[expedicionStage(o)];
  const cfg = expedicionConfig();
  const checklist = expedicionChecklist(o, dd, sel);
  const checklistOk = checklist.every((c) => c.ok);
  const puedeDespachar = checklistOk && !["despachado", "en_camino", "entregado", "cancelado", "incidencia"].includes(o.status);
  const notifs = state.client_notifications.filter((n) => n.orderId === o.id).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return `<div class="detail-view exp-ficha">
    <div class="detail-head">
      <div>
        <a href="#/expedicion" class="back-link">← Expedición</a>
        <h2>PEDIDO #${esc(o.number)}</h2>
        <div class="detail-sub">${esc(o.customerName)} · ${statusBadge(stage)}</div>
      </div>
      <div class="detail-actions">
        ${o.status !== "entregado" && o.status !== "cancelado" ? `<button class="btn btn-secondary" data-action="order-incident" data-id="${o.id}">⚠️ Registrar incidencia</button>` : ""}
        ${puedeDespachar ? `<button class="btn btn-primary" data-action="open-modal" data-modal="exp-despachar" data-id="${o.id}">🚚 DESPACHAR PEDIDO</button>` : ""}
      </div>
    </div>

    <div class="detail-grid">
      <div class="panel">
        <div class="panel-head"><h3>Ficha del pedido</h3></div>
        <div class="kv"><span>Cliente</span><b>${esc(o.customerName)}</b></div>
        <div class="kv"><span>Dirección</span><b>${esc(o.address)}</b></div>
        <div class="kv"><span>Localidad</span><b>${esc(getById("locations", o.locationId)?.city || "—")}</b></div>
        <div class="kv"><span>Fecha requerida</span><b>${fmtDate(o.expectedDate)} ${o.expectedTime ? "· " + o.expectedTime : ""}</b></div>
        <div class="kv"><span>Prioridad</span>${priorityBadge(o.priority)}</div>
        <div class="kv"><span>Cantidad de cajas</span><b>${dd?.boxesCount ?? "—"}</b></div>
        <div class="kv"><span>Tipo de caja</span><b>${esc(dd?.boxType || "—")}</b></div>
        <div class="kv"><span>Peso estimado</span><b>${dd?.weightKg != null ? dd.weightKg + " kg" : "—"}</b></div>
        <div class="kv"><span>Volumen estimado</span><b>${dd?.volumeM3 != null ? dd.volumeM3 + " m³" : "—"}</b></div>
        <div class="kv"><span>Valor del pedido</span><b>${dd?.orderValue != null ? fmtMoney(dd.orderValue) : "—"}</b></div>
        <div class="kv"><span>Horario de recepción</span><b>${esc(dd?.receptionSchedule || "—")}</b></div>
        ${dd?.notes ? `<div class="kv-notes"><span>Observaciones</span><p>${esc(dd.notes)}</p></div>` : ""}
        <div class="form-actions" style="justify-content:flex-start;margin-top:10px">
          <button class="btn btn-ghost btn-sm" data-action="open-modal" data-modal="exp-dispatch" data-id="${o.id}">✏️ ${dd ? "Editar" : "Completar"} datos de despacho</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Decisión de transporte</h3></div>
        ${sel ? `
          <div class="kv"><span>Transportista</span><b>${esc(transport?.name || "—")}</b></div>
          <div class="kv"><span>Vehículo</span><b>${esc(VEHICLE_TYPES[sel.vehicleType]?.label || "—")}</b></div>
          <div class="kv"><span>Costo estimado</span><b>${fmtMoney(sel.estimatedCost)}</b></div>
          ${dd?.orderValue && sel.estimatedCost != null ? `<div class="kv"><span>% del valor del pedido</span><b>${((sel.estimatedCost / dd.orderValue) * 100).toFixed(1)}%</b></div>` : ""}
          <div class="kv"><span>Tiempo estimado</span><b>${sel.estimatedTimeHours != null ? sel.estimatedTimeHours.toFixed(1) + " h" : "Sin historial suficiente"}</b></div>
          <div class="kv"><span>Entrega estimada</span><b>${sel.estimatedDeliveryDate ? fmtDate(sel.estimatedDeliveryDate) : "—"}</b></div>
          <div class="kv"><span>Elegido por</span><b>${esc(sel.selectedBy || "—")}</b></div>
          <div class="kv"><span>Fecha de decisión</span><b>${fmtDateTime(sel.selectedAt)}</b></div>
          ${sel.dispatchNumber ? `<div class="kv"><span>N° de despacho</span><b>${esc(sel.dispatchNumber)}</b></div>` : ""}
        ` : emptyState("🚚", "Sin transporte seleccionado", "Analizá las opciones y elegí un transportista más abajo.")}
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Checklist de despacho</h3></div>
        <ul class="checklist">${checklist.map((c) => `<li class="${c.ok ? "ok" : "pending"}">${c.ok ? "✅" : "⬜"} ${esc(c.label)}</li>`).join("")}</ul>
        ${!checklistOk ? `<div class="hint">Completá todos los puntos para poder despachar el pedido.</div>` : ""}
      </div>

      <div class="panel span2">
        <div class="panel-head">
          <h3>💡 Análisis de transporte</h3>
          <button class="btn btn-secondary btn-sm" data-action="exp-analizar" data-id="${o.id}">${expedicionAnalisisAbierto[o.id] ? "Ocultar" : "Analizar transporte"}</button>
        </div>
        ${expedicionAnalisisAbierto[o.id] ? expedicionComparadorHTML(o, cfg.criterios) : `<div class="hint">Tocá "Analizar transporte" para comparar costo, tiempo, cumplimiento y distancia entre todos los transportistas cargados, con datos reales de historial cuando existan.</div>`}
      </div>

      <div class="panel span2">
        <div class="panel-head"><h3>📩 Comunicación con el cliente</h3></div>
        ${notifs.length ? `<table class="mini-table"><thead><tr><th>Fecha</th><th>Canal</th><th>Evento</th><th>Estado</th><th></th></tr></thead>
          <tbody>${notifs.map((n) => `<tr>
            <td>${fmtDateTime(n.createdAt)}</td>
            <td>${esc(n.channel)}</td>
            <td>${esc(n.eventKey)}</td>
            <td>${expedicionComStatusBadge(n.status)}${n.status === "error" && n.errorReason ? ` <span class="hint">${esc(n.errorReason)}</span>` : ""}</td>
            <td>${n.status === "pendiente" ? `<button class="btn btn-ghost btn-sm" data-action="exp-marcar-enviado" data-id="${n.id}">Marcar como enviado manualmente</button>` : ""}</td>
          </tr>`).join("")}</tbody>
        </table>` : emptyState("📩", "Sin comunicaciones todavía", "Se genera automáticamente un aviso (sin enviarlo) apenas el pedido pasa a Despachado.")}
      </div>
    </div>
  </div>`;
}

/* --- 21.10 Vista: Costos y transportistas (para gerencia, dentro de Expedición) --- */
function viewExpedicionCostos() {
  const selections = state.transport_selections.filter((s) => s.estimatedCost != null);
  const totalCosto = selections.reduce((a, s) => a + s.estimatedCost, 0);
  const avgCosto = selections.length ? totalCosto / selections.length : null;
  const boxesTotal = selections.reduce((a, s) => a + (dispatchDetail(s.orderId)?.boxesCount || 0), 0);
  const avgCostoPorCaja = boxesTotal ? totalCosto / boxesTotal : null;
  const porTransportista = state.transports.map((t) => ({ transport: t, stats: transportCostStats(t.id), hist: transportHistoryStats(t.id) })).filter((r) => r.stats.count > 0);

  const porZona = {};
  selections.forEach((s) => {
    const o = getById("orders", s.orderId);
    const loc = o ? getById("locations", o.locationId) : null;
    const zona = loc?.city || "Sin localidad";
    if (!porZona[zona]) porZona[zona] = { costo: 0, pedidos: 0, cajas: 0, transportistas: new Set() };
    porZona[zona].costo += s.estimatedCost;
    porZona[zona].pedidos += 1;
    porZona[zona].cajas += dispatchDetail(s.orderId)?.boxesCount || 0;
    if (s.transportId) porZona[zona].transportistas.add(s.transportId);
  });

  const porMes = {};
  selections.forEach((s) => { const mes = (s.selectedAt || s.createdAt || "").slice(0, 7); if (mes) porMes[mes] = (porMes[mes] || 0) + s.estimatedCost; });
  const meses = Object.keys(porMes).sort();

  return `<div class="view-list exp-view">
    <div class="list-toolbar">
      <div class="chip-row" style="margin:0">
        <button class="chip ${expedicionTab === "centro" ? "active" : ""}" data-exp-tab="centro">🚚 Centro de expedición</button>
        <button class="chip ${expedicionTab === "costos" ? "active" : ""}" data-exp-tab="costos">💰 Costos y transportistas</button>
      </div>
    </div>

    <div class="kpi-grid">
      ${kpiCard(selections.length, "Despachos con costo registrado", "🚚", "kpi-blue", 0)}
      ${kpiCard(avgCosto != null ? Math.round(avgCosto) : "—", "Costo promedio por pedido", "💰", "kpi-violet", 40)}
      ${kpiCard(avgCostoPorCaja != null ? Math.round(avgCostoPorCaja) : "—", "Costo promedio por caja", "📦", "kpi-orange", 80)}
      ${kpiCard(Math.round(totalCosto), "Costo total de transporte", "💵", "kpi-red", 120)}
    </div>
    ${!selections.length ? `<div class="hint">Sin datos disponibles todavía: esta tabla se completa a medida que se seleccionan transportistas y se despachan pedidos desde Expedición.</div>` : ""}

    <div class="panel">
      <div class="panel-head"><h3>Historial por transportista</h3></div>
      ${porTransportista.length ? `<div class="table-scroll"><table class="mini-table"><thead><tr><th>Transportista</th><th>Envíos</th><th>Costo total</th><th>Costo promedio</th><th>Costo/caja</th><th>Tiempo promedio</th><th>Cumplimiento</th><th>Incidencias</th></tr></thead>
        <tbody>${porTransportista.map((r) => `<tr>
          <td><a href="#/transporte/${r.transport.id}" class="link-more">${esc(r.transport.name)}</a></td>
          <td>${r.stats.count}</td>
          <td>${fmtMoney(r.stats.total)}</td>
          <td>${fmtMoney(r.stats.avg)}</td>
          <td>${r.stats.avgPerBox != null ? fmtMoney(r.stats.avgPerBox) : "—"}</td>
          <td>${r.hist.avgDurationHours != null ? r.hist.avgDurationHours.toFixed(1) + " h" : `<span class="hint">Sin historial suficiente</span>`}</td>
          <td>${r.hist.onTimePct != null ? r.hist.onTimePct + "%" : `<span class="hint">Sin historial suficiente</span>`}</td>
          <td>${r.hist.incidentes}</td>
        </tr>`).join("")}</tbody>
      </table></div>` : emptyState("💰", "Sin historial todavía", "")}
      <div class="hint" style="margin-top:8px">Nunca se marca automáticamente a un transportista como "el mejor": esta tabla muestra los datos reales para que la comparación la haga quien decide.</div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Costo por zona</h3></div>
      ${Object.keys(porZona).length ? `<div class="table-scroll"><table class="mini-table"><thead><tr><th>Localidad</th><th>Pedidos</th><th>Cajas</th><th>Costo promedio</th><th>Transportistas usados</th></tr></thead>
        <tbody>${Object.entries(porZona).sort((a, b) => b[1].costo - a[1].costo).map(([zona, z]) => `<tr><td>${esc(zona)}</td><td>${z.pedidos}</td><td>${z.cajas}</td><td>${fmtMoney(z.costo / z.pedidos)}</td><td>${z.transportistas.size}</td></tr>`).join("")}</tbody>
      </table></div>` : emptyState("📍", "Sin datos por zona todavía", "")}
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Evolución mensual</h3></div>
      ${meses.length ? `<div class="stat-row">${meses.map((m) => `<div class="stat-box"><b>${fmtMoney(porMes[m])}</b><span>${m}</span></div>`).join("")}</div>` : emptyState("📉", "Sin evolución suficiente todavía", "")}
    </div>
  </div>`;
}

/* --- 21.11 Acciones: seleccionar transporte, despachar, comunicación --- */
async function seleccionarTransporte(orderId, transportId) {
  const o = getById("orders", orderId);
  const t = getById("transports", transportId);
  if (!o || !t) return;
  const dd = dispatchDetail(orderId);
  const km = kmForOrder(o);
  const cost = transportRateCost(transportRate(transportId), dd, km);
  const hist = transportHistoryStats(transportId);
  const vehicleType = Array.isArray(t.vehicleTypes) && t.vehicleTypes[0] ? t.vehicleTypes[0] : null;
  const estimatedDeliveryDate = hist.avgDurationHours != null ? new Date(Date.now() + hist.avgDurationHours * 36e5).toISOString().slice(0, 10) : null;
  const rec = {
    id: uid("tsel"), orderId, transportId, vehicleType,
    estimatedCost: cost.total, estimatedKm: km, estimatedTimeHours: hist.avgDurationHours, estimatedDeliveryDate,
    dispatchNumber: null, selectedAt: nowISO(), selectedBy: state.session?.user?.email || "Operador",
    criteriaSnapshot: expedicionConfig().criterios, notes: "",
  };
  await persist("transport_selections", rec);
  await persist("orders", { ...o, transportId });
  toast(`Transporte seleccionado: ${t.name}`);
  renderApp();
}
function expedicionRenderMensaje(template, o, dd, transport) {
  const loc = getById("locations", o.locationId);
  return (template || "")
    .replaceAll("[NOMBRE]", o.customerName || "")
    .replaceAll("[PEDIDO]", o.number || "")
    .replaceAll("[TRANSPORTISTA]", transport?.name || "—")
    .replaceAll("[CAJAS]", dd?.boxesCount != null ? String(dd.boxesCount) : "—")
    .replaceAll("[FECHA]", o.expectedDate ? fmtDate(o.expectedDate) : "—")
    .replaceAll("[LOCALIDAD]", loc?.city || "");
}
/** Idempotente: event_key (único, con constraint en la base) garantiza que
    un mismo evento nunca genere dos avisos, aunque se vuelva a llamar. No
    envía nada real — sólo prepara el mensaje y lo deja en "pendiente". */
async function ensureDispatchNotification(o) {
  const eventKey = `PEDIDO-${o.number}-DESPACHADO`;
  if (state.client_notifications.some((n) => n.eventKey === eventKey)) return;
  const cfg = expedicionConfig();
  const dd = dispatchDetail(o.id);
  const sel = latestSelection(o.id);
  const transport = sel ? getById("transports", sel.transportId) : getById("transports", o.transportId);
  const channel = cfg.canalPreferido;
  const rendered = expedicionRenderMensaje(cfg.plantillas[channel] || cfg.plantillas.whatsapp, o, dd, transport);
  const rec = { id: uid("cnt"), orderId: o.id, eventKey, channel, templateUsed: channel, messageRendered: rendered, status: "pendiente", errorReason: null, updatedAt: nowISO() };
  try {
    await persist("client_notifications", rec);
  } catch (e) {
    // Un choque de event_key (carrera entre pestañas) es exactamente la
    // idempotencia funcionando: no se resuelve creando otro aviso.
    console.warn("Aviso de despacho no creado (probable duplicado ya existente):", e.message);
  }
}
async function marcarNotificacionEnviada(id) {
  const n = getById("client_notifications", id);
  if (!n) return;
  await persist("client_notifications", { ...n, status: "enviado", updatedAt: nowISO() });
  toast("Aviso marcado como enviado manualmente — no se realizó ningún envío automático real.");
  renderApp();
}
async function confirmarDespacho(orderId) {
  const o = getById("orders", orderId);
  if (!o) return;
  const sel = latestSelection(orderId);
  const dispatchNumber = `DESP-${o.number}-${Date.now().toString(36).toUpperCase()}`;
  if (sel) await persist("transport_selections", { ...sel, dispatchNumber });
  const transportName = sel ? (getById("transports", sel.transportId)?.name || "transporte asignado") : "transporte sin registrar";
  await changeOrderStatus(orderId, "despachado", `Despachado con ${transportName} · N° ${dispatchNumber}`);
}

/* ---------------------------------------------------------------------------
   22. LOGIN
   ------------------------------------------------------------------------- */
let loginMode = "signin"; // "signin" | "signup"
let loginError = "";
let loginBusy = false;

function renderLogin() {
  return `
  <div class="login-screen">
    <div class="login-card">
      <div class="brand-mark login-mark" style="width:44px;height:44px;font-size:15px;border-radius:12px;">LP</div>
      <div class="login-title">LOGÍSTICA <span class="accent-text">PERONA</span></div>
      <div class="login-sub">Tu centro de control logístico</div>
      <form id="login-form">
        <input class="input" type="email" name="email" placeholder="Email" autocomplete="username" required />
        <input class="input" type="password" name="password" placeholder="Contraseña" autocomplete="${loginMode === "signup" ? "new-password" : "current-password"}" minlength="6" required />
        ${loginError ? `<div class="login-error">${esc(loginError)}</div>` : ""}
        <button type="submit" class="btn btn-primary btn-block" ${loginBusy ? "disabled" : ""}>${loginBusy ? "Un momento…" : loginMode === "signup" ? "Crear mi cuenta" : "Ingresar"}</button>
      </form>
      <button type="button" class="login-switch" data-action="login-switch">${loginMode === "signup" ? "¿Ya tenés cuenta? Ingresar" : "¿Primera vez? Crear mi cuenta"}</button>
      <div class="login-hint">Acceso personal · datos cargados y actualizados manualmente</div>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------------------
   23. RENDER PRINCIPAL
   ------------------------------------------------------------------------- */
function renderMain() {
  const r = state.route;
  if (r.view === "dashboard") return viewDashboard();
  if (r.view === "gerencia") return viewGerencia();
  if (r.view === "mapa") return viewMapaLogistico();
  if (r.view === "pedidos") return r.id === "nuevo" ? orderForm(null) : r.id ? (r.sub === "editar" ? orderForm(r.id) : orderDetail(r.id)) : viewPedidos();
  if (r.view === "compras") return r.id === "nueva" ? poForm(null) : r.id ? (r.sub === "editar" ? poForm(r.id) : poDetail(r.id)) : viewCompras();
  if (r.view === "transporte") return r.id ? viewTransporteDetail(r.id) : viewTransporte();
  if (r.view === "expedicion") return r.id ? viewExpedicionFicha(r.id) : viewExpedicion();
  if (r.view === "ubicaciones") return viewUbicaciones();
  if (r.view === "proveedores") return r.id ? viewProveedorDetail(r.id) : viewProveedores();
  if (r.view === "inventario") return viewInventario();
  if (r.view === "producto") return viewInventarioProductoDetail(r.id);
  if (r.view === "produccion") return r.id ? viewProduccionOrderDetail(r.id) : viewProduccion();
  if (r.view === "of_produccion") return r.id ? (r.sub === "imprimir" ? viewOfImprimir(r.id) : viewOfDetail(r.id)) : viewOfProduccion();
  if (r.view === "incidencias") return r.id === "nueva" ? incidentForm() : r.id ? incidentDetail(r.id) : viewIncidencias();
  if (r.view === "tareas") return viewTareas();
  if (r.view === "reportes") return viewReportes();
  if (r.view === "config") return viewConfig();
  return emptyState("🤔", "Página no encontrada", "");
}

function renderApp() {
  const app = $("#app");
  if (!state.auth) {
    app.innerHTML = renderLogin();
    bindLoginEvents();
    return;
  }
  if (!state.ready) {
    app.innerHTML = `<div class="boot-screen"><div class="boot-mark" style="font-family:var(--font-display);font-weight:800;font-size:15px;">LP</div><div class="boot-text">Cargando Logística Perona…</div></div>`;
    return;
  }
  state.route = parseHash();
  app.innerHTML = `
    ${renderSidebar()}
    <div class="main-col">
      ${renderTopbar()}
      <main class="app-main" id="app-main">${renderMain()}</main>
    </div>
    <div id="toast-host" class="toast-host"></div>
    <div id="modal-host" class="modal-host hidden"></div>
  `;
  $$(".kpi-value, .kpi-hero-value, .kpi-hero-sub [data-count]").forEach((el) => animateCount(el, parseInt(el.dataset.count, 10)));
  bindGlobalEvents();
  mountMapsIfPresent();
}

/* ---------------------------------------------------------------------------
   24. EVENTOS (delegación sobre document, se bindea una sola vez)
   ------------------------------------------------------------------------- */
let eventsBound = false;
function bindLoginEvents() {
  const f = $("#login-form");
  if (f) f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const email = fd.get("email").toString().trim();
    const password = fd.get("password").toString();
    loginError = ""; loginBusy = true; renderApp();
    try {
      if (loginMode === "signup") {
        const session = await signUp(email, password);
        if (!session) {
          loginBusy = false;
          loginError = "Cuenta creada. Si tu proyecto de Supabase pide confirmar el email, revisá tu casilla y después ingresá.";
          renderApp();
          return;
        }
      } else {
        await signIn(email, password);
      }
      // state.auth se activa solo vía onAuthStateChange (ver boot())
    } catch (err) {
      loginBusy = false;
      loginError = err.message === "Invalid login credentials" ? "Email o contraseña incorrectos." : (err.message || "No se pudo iniciar sesión.");
      renderApp();
    }
  });
  const switchBtn = $('[data-action="login-switch"]');
  if (switchBtn) switchBtn.addEventListener("click", () => { loginMode = loginMode === "signup" ? "signin" : "signup"; loginError = ""; renderApp(); });
}

function bindGlobalEvents() {
  if (eventsBound) return;
  eventsBound = true;

  document.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) { $("#sidebar")?.classList.remove("open"); }

    const toggleMenu = e.target.closest('[data-action="toggle-menu"]');
    if (toggleMenu) { $("#sidebar")?.classList.toggle("open"); return; }

    const logoutBtn = e.target.closest('[data-action="logout"]');
    if (logoutBtn) { signOut(); return; }

    const mapLevelBtn = e.target.closest("[data-map-level]");
    if (mapLevelBtn) { mapLevel = mapLevelBtn.dataset.mapLevel; renderMainOnly(); return; }
    const mapToggleFilters = e.target.closest('[data-action="map-toggle-filters"]');
    if (mapToggleFilters) { mapFiltersOpen = !mapFiltersOpen; renderMainOnly(); return; }
    const mapClearFilters = e.target.closest('[data-action="map-clear-filters"]');
    if (mapClearFilters) { mapGeoFilters = { provincia: "", ciudad: "", estadoPedido: "", transportistaId: "", vehiculo: "", carga: "", tiempo: "todos", tiempoDesde: "", tiempoHasta: "", costoMin: "", costoMax: "" }; renderMainOnly(); return; }
    const mapLayerToggle = e.target.closest("[data-map-layer]");
    if (mapLayerToggle) { mapLayerToggles[mapLayerToggle.dataset.mapLayer] = mapLayerToggle.checked; renderMainOnly(); return; }
    const mapClearSel = e.target.closest('[data-action="map-clear-selection"]');
    if (mapClearSel) { mapSelection = null; mapCoverageRadiusKm = null; renderMainOnly(); return; }
    const mapSelectNode = e.target.closest('[data-action="map-select-node"]');
    if (mapSelectNode) { mapSelection = { type: "location", id: mapSelectNode.dataset.id }; renderMainOnly(); return; }
    const mapSelectCliente = e.target.closest('[data-action="map-select-cliente"]');
    if (mapSelectCliente) { mapSelection = { type: "cliente", id: mapSelectCliente.dataset.id }; renderMainOnly(); return; }
    const mapCompararBtn = e.target.closest('[data-action="map-comparar-transporte"]');
    if (mapCompararBtn) { expedicionAnalisisAbierto[mapCompararBtn.dataset.id] = true; return; } // deja navegar el <a>, sólo pre-abre el comparador
    const mapRadiusBtn = e.target.closest("[data-map-radius]");
    if (mapRadiusBtn) { const r = parseInt(mapRadiusBtn.dataset.mapRadius, 10); mapCoverageRadiusKm = r === 0 ? null : r; renderMainOnly(); return; }
    const mapSearchResultBtn = e.target.closest("[data-map-search-result]");
    if (mapSearchResultBtn) { const r = mapSearchResults(mapSearchQuery)[parseInt(mapSearchResultBtn.dataset.mapSearchResult, 10)]; if (r) { r.action(); mapSearchQuery = ""; mapPlacesSuggestions = []; } return; }
    const mapSearchPlaceBtn = e.target.closest("[data-map-search-place]");
    if (mapSearchPlaceBtn) {
      const placeId = mapSearchPlaceBtn.dataset.mapSearchPlace;
      (async () => {
        const p = await getPlaceById(placeId);
        if (p) {
          mapSelection = { type: "place", lat: p.lat, lng: p.lng, label: p.label };
          focusLogisticsMap("mapa-geo", p.lat, p.lng, 15);
        } else {
          toast("No se pudo resolver esa dirección", "warn");
        }
        mapSearchQuery = ""; mapPlacesSuggestions = [];
        renderMainOnly();
      })();
      return;
    }
    const mapZoneNewBtn = e.target.closest('[data-action="map-zone-new"]');
    if (mapZoneNewBtn) { mapZoneEditing = "new"; mapSelection = null; renderMainOnly(); return; }
    const mapZoneEditBtn = e.target.closest('[data-action="map-zone-edit"]');
    if (mapZoneEditBtn) { mapZoneEditing = mapZoneEditBtn.dataset.id; renderMainOnly(); return; }
    const mapZoneCancelBtn = e.target.closest('[data-action="map-zone-cancel"]');
    if (mapZoneCancelBtn) { mapZoneEditing = null; renderMainOnly(); return; }
    const mapZoneDeleteBtn = e.target.closest('[data-action="map-zone-delete"]');
    if (mapZoneDeleteBtn) {
      if (confirm("¿Eliminar esta zona tarifaria? No afecta ningún pedido ni transportista, sólo esta configuración.")) {
        const id = mapZoneDeleteBtn.dataset.id;
        removeRecord("logistics_zones", id).then(() => {
          if (mapSelection?.type === "zone" && mapSelection.id === id) mapSelection = null;
          if (mapZoneEditing === id) mapZoneEditing = null;
          toast("Zona eliminada"); renderApp();
        });
      }
      return;
    }
    const mapZoneSelectBtn = e.target.closest('[data-action="map-zone-select"]');
    if (mapZoneSelectBtn) { mapSelection = { type: "zone", id: mapZoneSelectBtn.dataset.id }; mapZoneEditing = null; renderMainOnly(); return; }

    const planClearBtn = e.target.closest('[data-action="plan-clear-field"]');
    if (planClearBtn) { planClearField(planClearBtn.dataset.which); renderMainOnly(); return; }
    const planSelectLoc = e.target.closest('[data-action="plan-select-loc"]');
    if (planSelectLoc) {
      const which = planSelectLoc.dataset.which, loc = getById("locations", planSelectLoc.dataset.id);
      if (loc) {
        if (which === "origen") { mapOrigenDestino.origenId = loc.id; mapOrigenDestino.origenPoint = null; }
        else { mapOrigenDestino.destinoId = loc.id; mapOrigenDestino.destinoPoint = null; }
        mapPlanQuery[which] = loc.name; mapRouteResult = null; mapRouteError = "";
      }
      renderMainOnly(); return;
    }
    const planSelectPlace = e.target.closest('[data-action="plan-select-place"]');
    if (planSelectPlace) {
      const which = planSelectPlace.dataset.which, placeId = planSelectPlace.dataset.placeId;
      (async () => {
        const p = await getPlaceById(placeId);
        if (p) {
          if (which === "origen") { mapOrigenDestino.origenPoint = p; mapOrigenDestino.origenId = ""; }
          else { mapOrigenDestino.destinoPoint = p; mapOrigenDestino.destinoId = ""; }
          mapPlanQuery[which] = p.label; mapRouteResult = null; mapRouteError = "";
        } else {
          toast("No se pudo resolver esa dirección", "warn");
        }
        renderMainOnly();
      })();
      return;
    }
    const planUseAsBtn = e.target.closest('[data-action="plan-use-as"]');
    if (planUseAsBtn) {
      const which = planUseAsBtn.dataset.which, lat = parseFloat(planUseAsBtn.dataset.lat), lng = parseFloat(planUseAsBtn.dataset.lng), label = planUseAsBtn.dataset.label || "";
      const point = { lat, lng, label };
      if (which === "origen") { mapOrigenDestino.origenPoint = point; mapOrigenDestino.origenId = ""; }
      else { mapOrigenDestino.destinoPoint = point; mapOrigenDestino.destinoId = ""; }
      mapPlanQuery[which] = label; mapRouteResult = null; mapRouteError = "";
      toast(`Cargado como ${which === "origen" ? "origen" : "destino"} en Planificar recorrido`);
      renderMainOnly();
      return;
    }
    const planCalcularBtn = e.target.closest('[data-action="plan-calcular"]');
    if (planCalcularBtn && !planCalcularBtn.disabled) {
      const origen = planResolvedPoint("origen"), destino = planResolvedPoint("destino");
      if (origen && destino) {
        mapRouteBusy = true; mapRouteResult = null; mapRouteError = ""; renderMainOnly();
        (async () => {
          const route = await calculateRoute({ lat: origen.lat, lng: origen.lng }, { lat: destino.lat, lng: destino.lng });
          mapRouteBusy = false;
          if (route) { mapRouteResult = route; }
          else { mapRouteResult = null; mapRouteError = googleMapsKeyConfigured() ? "No se pudo calcular una ruta real por calles para este tramo." : "No hay una clave de Google Maps configurada todavía, así que no se puede calcular una ruta real por calles."; }
          renderMainOnly();
        })();
      }
      return;
    }

    const streetViewBtn = e.target.closest('[data-action="map-street-view"]');
    if (streetViewBtn) {
      const lat = parseFloat(streetViewBtn.dataset.lat), lng = parseFloat(streetViewBtn.dataset.lng);
      if (!isNaN(lat) && !isNaN(lng)) openStreetViewModal(lat, lng, streetViewBtn.dataset.label || "");
      return;
    }
    const comoLlegarBtn = e.target.closest('[data-action="map-como-llegar"]');
    if (comoLlegarBtn) {
      const locId = comoLlegarBtn.dataset.locationId;
      const loc = locId ? getById("locations", locId) : null;
      if (loc && typeof loc.lat === "number") {
        mapOrigenDestino.destinoId = loc.id; mapOrigenDestino.destinoPoint = null;
        mapPlanQuery.destino = loc.name; mapRouteResult = null; mapRouteError = "";
        mapSelection = null;
        toast("Destino cargado en Planificar recorrido — elegí el origen");
        renderMainOnly();
      }
      return;
    }

    const pedStatus = e.target.closest("[data-pedidos-status]");
    if (pedStatus) { pedidosFilter.status = pedStatus.dataset.pedidosStatus; renderApp(); return; }
    const pedDate = e.target.closest("[data-pedidos-date]");
    if (pedDate) { pedidosFilter.date = pedDate.dataset.pedidosDate; renderApp(); return; }
    const comStatus = e.target.closest("[data-compras-status]");
    if (comStatus) { comprasFilter.status = comStatus.dataset.comprasStatus; renderApp(); return; }
    const comDate = e.target.closest("[data-compras-date]");
    if (comDate) { comprasFilter.date = comDate.dataset.comprasDate; renderApp(); return; }
    const traVehicle = e.target.closest("[data-transporte-vehicle]");
    if (traVehicle) { transporteFilter.vehicle = traVehicle.dataset.transporteVehicle; renderApp(); return; }
    const incStatus = e.target.closest("[data-incidencias-status]");
    if (incStatus) { incidenciasFilter = incStatus.dataset.incidenciasStatus; renderApp(); return; }
    const tarStatus = e.target.closest("[data-tareas-status]");
    if (tarStatus) { tareasFilter = tarStatus.dataset.tareasStatus; renderApp(); return; }

    const agendaToggle = e.target.closest("[data-agenda-toggle]");
    if (agendaToggle) { cycleTaskStatus(agendaToggle.dataset.agendaToggle); return; }
    const taskCycle = e.target.closest('[data-action="task-cycle"]');
    if (taskCycle) { cycleTaskStatus(taskCycle.dataset.id); return; }

    const advOrder = e.target.closest('[data-action="order-advance"]');
    if (advOrder) { const o = getById("orders", advOrder.dataset.id); const next = ORDER_FLOW[ORDER_FLOW.indexOf(o.status) + 1]; if (next) changeOrderStatus(o.id, next); return; }
    const advPo = e.target.closest('[data-action="po-advance"]');
    if (advPo) { const p = getById("purchase_orders", advPo.dataset.id); const next = PO_FLOW[PO_FLOW.indexOf(p.status) + 1]; if (next) changePoStatus(p.id, next); return; }
    const advInc = e.target.closest('[data-action="incident-advance"]');
    if (advInc) { const i = getById("incidents", advInc.dataset.id); const next = INCIDENT_FLOW[INCIDENT_FLOW.indexOf(i.status) + 1]; if (next) changeIncidentStatus(i.id, next); return; }

    const orderIncident = e.target.closest('[data-action="order-incident"]');
    if (orderIncident) { createIncidentFromDetail("order", orderIncident.dataset.id); return; }
    const poIncident = e.target.closest('[data-action="po-incident"]');
    if (poIncident) { createIncidentFromDetail("po", poIncident.dataset.id); return; }

    const orderEdit = e.target.closest('[data-action="order-edit"]');
    if (orderEdit) { location.hash = `#/pedidos/${orderEdit.dataset.id}/editar`; return; }
    const poEdit = e.target.closest('[data-action="po-edit"]');
    if (poEdit) { location.hash = `#/compras/${poEdit.dataset.id}/editar`; return; }

    const resolveBtn = e.target.closest('[data-action="incident-resolve"]');
    if (resolveBtn) {
      const id = resolveBtn.dataset.id;
      const ta = $("#incident-resolution-" + id);
      const i = getById("incidents", id);
      i.resolution = ta ? ta.value : "";
      persist("incidents", i).then(() => { toast("Resolución guardada"); renderApp(); });
      return;
    }

    const openModalBtn = e.target.closest("[data-action='open-modal']");
    if (openModalBtn) { openModal(openModalBtn.dataset.modal, { id: openModalBtn.dataset.id || null, productId: openModalBtn.dataset.productId || null, size: openModalBtn.dataset.size || null, type: openModalBtn.dataset.type || null }); return; }
    const closeModalBtn = e.target.closest("[data-action='close-modal']");
    if (closeModalBtn && !e.target.closest("[data-stop]")) { closeModal(); return; }

    const invTabBtn = e.target.closest("[data-inv-tab]");
    if (invTabBtn) { inventarioTab = invTabBtn.dataset.invTab; renderApp(); return; }

    const invQuickDias = e.target.closest("[data-inv-quick-dias]");
    if (invQuickDias) { inventarioLotesFilter = { producto: "", categoria: "", proveedor: "", deposito: "", estado: "", dias: invQuickDias.dataset.invQuickDias }; inventarioTab = "lotes"; renderApp(); return; }
    const invQuickEstado = e.target.closest("[data-inv-quick-estado]");
    if (invQuickEstado) { inventarioLotesFilter = { producto: "", categoria: "", proveedor: "", deposito: "", estado: invQuickEstado.dataset.invQuickEstado, dias: "" }; inventarioTab = "lotes"; renderApp(); return; }
    const invLotesClear = e.target.closest('[data-action="inv-lotes-clear"]');
    if (invLotesClear) { inventarioLotesFilter = { producto: "", categoria: "", proveedor: "", deposito: "", estado: "", dias: "" }; renderApp(); return; }

    const unblockBtn = e.target.closest('[data-action="inv-lot-unblock"]');
    if (unblockBtn) {
      const lot = getById("inventory_lots", unblockBtn.dataset.id);
      if (lot && confirm("¿Desbloquear este lote?")) {
        persist("inventory_lots", { ...lot, bloqueado: false, motivoBloqueo: "" }).then(() =>
          registerMovement({ productId: lot.productId, lotId: lot.id, type: "desbloqueo", quantity: 0 })
        ).then(() => { toast("Lote desbloqueado"); renderApp(); });
      }
      return;
    }
    const delLotLoc = e.target.closest('[data-action="lot-location-delete"]');
    if (delLotLoc) {
      if (confirm("¿Quitar esta ubicación del lote?")) removeRecord("lot_locations", delLotLoc.dataset.id).then(() => { closeModal(); renderApp(); });
      return;
    }

    const delInvSupplier = e.target.closest('[data-action="inv-supplier-delete"]');
    if (delInvSupplier) {
      if (confirm("¿Eliminar este proveedor? Los productos asociados quedan sin proveedor asignado.")) {
        removeRecord("inv_suppliers", delInvSupplier.dataset.id).then(() => {
          state.products.forEach((p) => { if (p.supplierId === delInvSupplier.dataset.id) p.supplierId = null; });
          closeModal(); toast("Proveedor eliminado"); renderApp();
        });
      }
      return;
    }
    const delInvProduct = e.target.closest('[data-action="inv-product-delete"]');
    if (delInvProduct) {
      if (confirm("¿Eliminar este producto y todos sus lotes cargados?")) {
        const id = delInvProduct.dataset.id;
        removeRecord("products", id).then(() => {
          state.inventory_lots = state.inventory_lots.filter((l) => l.productId !== id);
          closeModal(); toast("Producto eliminado"); location.hash = "#/inventario";
        });
      }
      return;
    }
    const delInvLot = e.target.closest('[data-action="inv-lot-delete"]');
    if (delInvLot) {
      if (confirm("¿Eliminar este lote?")) {
        removeRecord("inventory_lots", delInvLot.dataset.id).then(() => { closeModal(); toast("Lote eliminado"); renderApp(); });
      }
      return;
    }

    const invExportBtn = e.target.closest('[data-action="inv-export-productos"]');
    if (invExportBtn) { exportInventarioProductosExcel(); return; }

    const expTabBtn = e.target.closest("[data-exp-tab]");
    if (expTabBtn) { expedicionTab = expTabBtn.dataset.expTab; renderApp(); return; }
    const expAnalizarBtn = e.target.closest('[data-action="exp-analizar"]');
    if (expAnalizarBtn) { const id = expAnalizarBtn.dataset.id; expedicionAnalisisAbierto[id] = !expedicionAnalisisAbierto[id]; renderMainOnly(); return; }
    const expSeleccionarBtn = e.target.closest('[data-action="exp-seleccionar"]');
    if (expSeleccionarBtn) { seleccionarTransporte(expSeleccionarBtn.dataset.orderId, expSeleccionarBtn.dataset.transportId); return; }
    const expMarcarEnviadoBtn = e.target.closest('[data-action="exp-marcar-enviado"]');
    if (expMarcarEnviadoBtn) { marcarNotificacionEnviada(expMarcarEnviadoBtn.dataset.id); return; }

    const gerPeriodoBtn = e.target.closest("[data-ger-periodo]");
    if (gerPeriodoBtn) { gerenciaPeriodo = gerPeriodoBtn.dataset.gerPeriodo; renderApp(); return; }
    const gerAlertCard = e.target.closest("[data-ger-alert-href]");
    if (gerAlertCard) { location.hash = gerAlertCard.dataset.gerAlertHref; return; }

    const prodTabBtn = e.target.closest("[data-prod-tab]");
    if (prodTabBtn) { produccionTab = prodTabBtn.dataset.prodTab; renderApp(); return; }
    const prodConfigSizeBtn = e.target.closest("[data-prod-config-size]");
    if (prodConfigSizeBtn) { produccionConfigSize = prodConfigSizeBtn.dataset.prodConfigSize; renderApp(); return; }
    const delProdConfigItem = e.target.closest('[data-action="prod-config-item-delete"]');
    if (delProdConfigItem) {
      if (confirm("¿Quitar este producto de la caja?")) {
        removeRecord("box_config_items", delProdConfigItem.dataset.id).then(() => { closeModal(); toast("Producto quitado de la caja"); renderApp(); });
      }
      return;
    }
    const ofPlanificarBtn = e.target.closest('[data-action="of-planificar"]');
    if (ofPlanificarBtn) {
      (async () => {
        try { await setOfEstado(ofPlanificarBtn.dataset.id, "PLANIFICADA"); } catch (e) { toast(e.message || "No se pudo planificar la OF", "warn"); }
      })();
      return;
    }
    const ofReservarBtn = e.target.closest('[data-action="of-reservar"]');
    if (ofReservarBtn) {
      (async () => {
        try { await reservarStockOF(ofReservarBtn.dataset.id); } catch (e) { toast(e.message || "No se pudo reservar stock", "warn"); }
      })();
      return;
    }
    const ofPausarBtn = e.target.closest('[data-action="of-pausar"]');
    if (ofPausarBtn) {
      const motivo = prompt("Motivo de la pausa:");
      if (!motivo) return;
      (async () => {
        try { await setOfEstado(ofPausarBtn.dataset.id, "PAUSADA", { motivo }); } catch (e) { toast(e.message || "No se pudo pausar la OF", "warn"); }
      })();
      return;
    }
    const ofBloquearBtn = e.target.closest('[data-action="of-bloquear"]');
    if (ofBloquearBtn) {
      const motivo = prompt("Motivo del bloqueo:");
      if (!motivo) return;
      (async () => {
        try { await setOfEstado(ofBloquearBtn.dataset.id, "BLOQUEADA", { motivo }); } catch (e) { toast(e.message || "No se pudo bloquear la OF", "warn"); }
      })();
      return;
    }
    // Simplificación de esta fase: "Reanudar"/"Desbloquear" siempre vuelven a
    // PLANIFICADA en vez de reconstruir el estado previo exacto (que podía
    // ser RESERVADA o EN_PRODUCCION) — eso queda para una fase posterior.
    const ofReanudarBtn = e.target.closest('[data-action="of-reanudar"]');
    if (ofReanudarBtn) {
      (async () => {
        try { await setOfEstado(ofReanudarBtn.dataset.id, "PLANIFICADA"); } catch (e) { toast(e.message || "No se pudo reanudar la OF", "warn"); }
      })();
      return;
    }
    const ofDesbloquearBtn = e.target.closest('[data-action="of-desbloquear"]');
    if (ofDesbloquearBtn) {
      (async () => {
        try { await setOfEstado(ofDesbloquearBtn.dataset.id, "PLANIFICADA"); } catch (e) { toast(e.message || "No se pudo desbloquear la OF", "warn"); }
      })();
      return;
    }
    const ofCancelarBtn = e.target.closest('[data-action="of-cancelar"]');
    if (ofCancelarBtn) {
      if (confirm("¿Cancelar esta OF? Las reservas activas deberán liberarse por separado.")) {
        (async () => {
          try { await setOfEstado(ofCancelarBtn.dataset.id, "CANCELADA"); } catch (e) { toast(e.message || "No se pudo cancelar la OF", "warn"); }
        })();
      }
      return;
    }
    const ofLiberarReservaBtn = e.target.closest('[data-action="of-liberar-reserva"]');
    if (ofLiberarReservaBtn) {
      const motivo = prompt("Motivo de la liberación (opcional):");
      if (motivo === null) return;
      (async () => {
        try { await liberarReservaOF(ofLiberarReservaBtn.dataset.id, motivo || ""); } catch (e) { toast(e.message || "No se pudo liberar la reserva", "warn"); }
      })();
      return;
    }
    const ofReemplazoCancelarBtn = e.target.closest('[data-action="of-reemplazo-cancelar"]');
    if (ofReemplazoCancelarBtn) {
      const ofId = ofReemplazoCancelarBtn.dataset.id;
      delete ofReplacementState[ofId];
      delete ofReplacementErrors[ofId];
      renderMainOnly();
      return;
    }
    const ofCerrarBtn = e.target.closest('[data-action="of-cerrar"]');
    if (ofCerrarBtn) {
      (async () => {
        try { await cerrarOF(ofCerrarBtn.dataset.id); } catch (e) { toast(e.message || "No se pudo cerrar la OF", "warn"); }
      })();
      return;
    }
    const ofImprimirBtn = e.target.closest('[data-action="of-imprimir-ahora"]');
    if (ofImprimirBtn) { window.print(); return; }
    const ofListTabBtn = e.target.closest("[data-of-tab]");
    if (ofListTabBtn) { ofListTab = ofListTabBtn.dataset.ofTab; renderMainOnly(); return; }
    const ofHoyFilterBtn = e.target.closest("[data-of-hoy-filter]");
    if (ofHoyFilterBtn) { ofHoyFilter = ofHoyFilterBtn.dataset.ofHoyFilter; renderMainOnly(); return; }
    const ofScanCameraBtn = e.target.closest('[data-action="of-scan-camera"]');
    if (ofScanCameraBtn) {
      const ofId = ofScanCameraBtn.dataset.id;
      openCameraScan({
        onResult: (code) => {
          const input = document.getElementById("of-scan-input");
          if (input) { input.value = code; input.closest("form")?.requestSubmit(); }
        },
        onClose: (reason) => {
          if (reason === "unsupported") toast("Tu navegador no soporta lectura por cámara. Usá un lector USB/Bluetooth o escribí el código manualmente.", "warn");
          if (reason === "permission_denied") toast("No se pudo acceder a la cámara (permiso denegado).", "warn");
        },
      });
      return;
    }
    const prodLineAddBtn = e.target.closest('[data-action="prod-line-add"]');
    if (prodLineAddBtn) {
      produccionPlan.lines.push({ id: uid("pline"), size: produccionNextUnusedSize(), quantity: 10 });
      renderMainOnly(); return;
    }
    const prodLineRemoveBtn = e.target.closest('[data-action="prod-line-remove"]');
    if (prodLineRemoveBtn) {
      produccionPlan.lines = produccionPlan.lines.filter((l) => l.id !== prodLineRemoveBtn.dataset.id);
      if (!produccionPlan.lines.length) produccionPlan.lines.push({ id: uid("pline"), size: "estandar", quantity: 10 });
      renderMainOnly(); return;
    }
    const prodConfirmBtn = e.target.closest('[data-action="prod-confirm"]');
    if (prodConfirmBtn && !prodConfirmBtn.disabled) { confirmProduction(); return; }
    const prodAdvanceBtn = e.target.closest('[data-action="prod-advance"]');
    if (prodAdvanceBtn) { advanceProductionStatus(prodAdvanceBtn.dataset.id); return; }
    const prodCancelBtn = e.target.closest('[data-action="prod-cancel"]');
    if (prodCancelBtn) {
      if (confirm("¿Cancelar esta orden de producción? El stock ya descontado al confirmarla no se revierte automáticamente.")) {
        cancelProductionOrder(prodCancelBtn.dataset.id);
      }
      return;
    }
    const simResetBtn = e.target.closest('[data-action="sim-reset"]');
    if (simResetBtn) {
      simuladorPedidos = []; simuladorCode = null; simuladorPeople = 2; simuladorStart = null;
      toast("Simulación reiniciada"); renderApp();
      return;
    }
    const delSimPedido = e.target.closest('[data-action="sim-pedido-delete"]');
    if (delSimPedido) {
      simuladorPedidos = simuladorPedidos.filter((p) => p.id !== delSimPedido.dataset.id);
      if (!simuladorPedidos.length) simuladorCode = null;
      closeModal(); toast("Pedido quitado de la tanda"); renderApp();
      return;
    }

    const importConfirm = e.target.closest("#import-orders-confirm");
    if (importConfirm) {
      if (!importOrdersParsed || !importOrdersParsed.rows.length || importOrdersRunning) return;
      importOrdersRunning = true;
      importConfirm.disabled = true;
      importConfirm.textContent = "Importando…";
      (async () => {
        const { rows, fileName } = importOrdersParsed;
        const result = await runImportOrders(rows, fileName);
        importOrdersRunning = false;
        importOrdersParsed = null;
        closeModal();
        toast(`Importación completa: ${result.created} nuevo(s), ${result.updated} actualizado(s)${result.failed ? `, ${result.failed} con error` : ""}`);
        renderApp();
      })();
      return;
    }

    const geocodeBtn = e.target.closest('[data-action="geocode-address"]');
    if (geocodeBtn) {
      (async () => {
        const addrInput = $("#loc-address");
        const query = addrInput ? addrInput.value.trim() : "";
        if (!query) { toast("Escribí una dirección primero", "warn"); return; }
        geocodeBtn.disabled = true; geocodeBtn.textContent = "Buscando…";
        try {
          const results = await geocodeAddress(query);
          if (!results.length) { toast("No se encontró esa dirección", "warn"); return; }
          const { lat, lng } = results[0];
          $("#loc-lat").value = lat; $("#loc-lng").value = lng;
          $("#loc-picker-wrap").hidden = false;
          mountPickerMap("mapa-picker", lat, lng, (nlat, nlng) => { $("#loc-lat").value = nlat; $("#loc-lng").value = nlng; });
        } catch (err) {
          toast("No se pudo buscar la dirección", "warn");
        } finally {
          geocodeBtn.disabled = false; geocodeBtn.textContent = "📍 Buscar en el mapa";
        }
      })();
      return;
    }

    const exportBtn = e.target.closest('[data-action="export-data"]');
    if (exportBtn) {
      const dump = {}; COLLECTIONS.forEach((c) => (dump[c] = state[c]));
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "logistica-perona-datos.json";
      document.body.appendChild(a); a.click(); a.remove();
      toast("Datos exportados"); return;
    }
    const resetBtn = e.target.closest('[data-action="reset-demo"]');
    if (resetBtn) {
      if (!confirm("¿Cargar datos de ejemplo? Se van a sumar a lo que ya tengas cargado (no borra nada existente).")) return;
      const seed = remapSeedIds(buildSeed());
      (async () => {
        for (const col of COLLECTIONS) { for (const rec of seed[col]) await persist(col, rec); }
        toast("Datos de ejemplo cargados"); renderApp();
      })();
      return;
    }
    const clearBtn = e.target.closest('[data-action="clear-data"]');
    if (clearBtn) {
      if (!confirm("¿Vaciar TODOS los datos (pedidos, OC, clientes, proveedores, ubicaciones, transportes, incidencias y tareas)? Esta acción no se puede deshacer.")) return;
      (async () => {
        for (const col of COLLECTIONS) {
          const ids = state[col].map((r) => r.id);
          for (const id of ids) await removeRecord(col, id);
        }
        toast("Todos los datos fueron eliminados"); renderApp();
      })();
      return;
    }

    if (!e.target.closest(".topbar-search")) { $("#search-results")?.classList.add("hidden"); }
    const resultItem = e.target.closest(".search-result-item");
    if (resultItem) { $("#search-results")?.classList.add("hidden"); $("#global-search").value = ""; }
  });

  document.addEventListener("change", (e) => {
    const importFile = e.target.closest("#import-orders-file");
    if (importFile) {
      (async () => {
        const file = importFile.files && importFile.files[0];
        const preview = $("#import-orders-preview");
        const confirmBtn = $("#import-orders-confirm");
        if (!file) return;
        if (confirmBtn) confirmBtn.disabled = true;
        if (preview) preview.innerHTML = `<p class="hint">Leyendo archivo…</p>`;
        try {
          const buf = await file.arrayBuffer();
          const wb = XLSXStyle.read(buf, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rawRows = XLSXStyle.utils.sheet_to_json(ws, { defval: "" });
          const { rows, errors } = parseImportOrdersRows(rawRows);
          importOrdersParsed = { rows, errors, fileName: file.name };
          const stats = buildImportOrdersPreview(rows);
          if (preview) preview.innerHTML = importOrdersPreviewHTML(stats, errors, file.name);
          if (confirmBtn) confirmBtn.disabled = rows.length === 0;
        } catch (err) {
          importOrdersParsed = null;
          if (preview) preview.innerHTML = `<p class="hint">No se pudo leer el archivo: ${esc(err.message || String(err))}</p>`;
        }
      })();
      return;
    }

    const geoProvincia = e.target.closest("#geo-f-provincia");
    if (geoProvincia) { mapGeoFilters.provincia = geoProvincia.value; mapGeoFilters.ciudad = ""; renderMainOnly(); return; }
    const geoCiudad = e.target.closest("#geo-f-ciudad");
    if (geoCiudad) { mapGeoFilters.ciudad = geoCiudad.value; renderMainOnly(); return; }
    const geoEstado = e.target.closest("#geo-f-estado");
    if (geoEstado) { mapGeoFilters.estadoPedido = geoEstado.value; renderMainOnly(); return; }
    const geoTransportista = e.target.closest("#geo-f-transportista");
    if (geoTransportista) { mapGeoFilters.transportistaId = geoTransportista.value; renderMainOnly(); return; }
    const geoVehiculo = e.target.closest("#geo-f-vehiculo");
    if (geoVehiculo) { mapGeoFilters.vehiculo = geoVehiculo.value; renderMainOnly(); return; }
    const geoCarga = e.target.closest("#geo-f-carga");
    if (geoCarga) { mapGeoFilters.carga = geoCarga.value; renderMainOnly(); return; }
    const geoTiempo = e.target.closest("#geo-f-tiempo");
    if (geoTiempo) { mapGeoFilters.tiempo = geoTiempo.value; renderMainOnly(); return; }
    const geoDesde = e.target.closest("#geo-f-desde");
    if (geoDesde) { mapGeoFilters.tiempoDesde = geoDesde.value; renderMainOnly(); return; }
    const geoHasta = e.target.closest("#geo-f-hasta");
    if (geoHasta) { mapGeoFilters.tiempoHasta = geoHasta.value; renderMainOnly(); return; }
    const geoCostoMin = e.target.closest("#geo-f-costo-min");
    if (geoCostoMin) { mapGeoFilters.costoMin = geoCostoMin.value; renderMainOnly(); return; }
    const geoCostoMax = e.target.closest("#geo-f-costo-max");
    if (geoCostoMax) { mapGeoFilters.costoMax = geoCostoMax.value; renderMainOnly(); return; }
    const geoHeatVar = e.target.closest("#geo-heat-var");
    if (geoHeatVar) { mapHeatVariable = geoHeatVar.value; renderMainOnly(); return; }

    const lotesProducto = e.target.closest("#inv-lotes-producto");
    if (lotesProducto) { inventarioLotesFilter.producto = lotesProducto.value; renderMainOnly(); return; }
    const lotesCategoria = e.target.closest("#inv-lotes-categoria");
    if (lotesCategoria) { inventarioLotesFilter.categoria = lotesCategoria.value; renderMainOnly(); return; }
    const lotesProveedor = e.target.closest("#inv-lotes-proveedor");
    if (lotesProveedor) { inventarioLotesFilter.proveedor = lotesProveedor.value; renderMainOnly(); return; }
    const lotesDeposito = e.target.closest("#inv-lotes-deposito");
    if (lotesDeposito) { inventarioLotesFilter.deposito = lotesDeposito.value; renderMainOnly(); return; }
    const lotesEstado = e.target.closest("#inv-lotes-estado");
    if (lotesEstado) { inventarioLotesFilter.estado = lotesEstado.value; renderMainOnly(); return; }
    const gerFromInput = e.target.closest("#ger-from");
    if (gerFromInput) { gerenciaCustomFrom = gerFromInput.value; renderMainOnly(); return; }
    const gerToInput = e.target.closest("#ger-to");
    if (gerToInput) { gerenciaCustomTo = gerToInput.value; renderMainOnly(); return; }
    const prodLineSizeSel = e.target.closest("[data-prod-line-size]");
    if (prodLineSizeSel) {
      const line = produccionPlan.lines.find((l) => l.id === prodLineSizeSel.dataset.prodLineSize);
      if (line) line.size = prodLineSizeSel.value;
      renderMainOnly(); return;
    }
    const simPeopleSel = e.target.closest("#sim-people");
    if (simPeopleSel) { simuladorPeople = parseInt(simPeopleSel.value, 10) || 1; renderMainOnly(); return; }
    const simStartInput = e.target.closest("#sim-start");
    if (simStartInput) { simuladorStart = simStartInput.value || null; renderMainOnly(); return; }
    const simSourceSel = e.target.closest("#sim-pedido-source");
    if (simSourceSel) {
      const o = getById("orders", simSourceSel.value);
      if (o) {
        const form = simSourceSel.closest("form");
        const numInput = form.querySelector('[name="numero"]');
        const cliInput = form.querySelector('[name="cliente"]');
        const fechaInput = form.querySelector('[name="fechaEntrega"]');
        if (numInput) numInput.value = o.number || "";
        if (cliInput) cliInput.value = o.customerName || "";
        if (fechaInput) fechaInput.value = o.expectedDate || "";
      }
      return;
    }

    const sel = e.target.closest('[data-action="order-set-status"]');
    if (sel) { changeOrderStatus(sel.dataset.id, sel.value); return; }
    const selPo = e.target.closest('[data-action="po-set-status"]');
    if (selPo) { changePoStatus(selPo.dataset.id, selPo.value); return; }
    const relType = e.target.closest("#incident-reltype");
    if (relType) {
      const relIdSel = $("#incident-relid");
      const kind = relType.value;
      let options = [`<option value="">—</option>`];
      if (kind === "order") options = options.concat(state.orders.map((o) => `<option value="${o.id}">#${o.number} · ${esc(o.customerName)}</option>`));
      if (kind === "purchase_order") options = options.concat(state.purchase_orders.map((p) => `<option value="${p.id}">OC #${p.number} · ${esc(p.supplierName)}</option>`));
      if (kind === "supplier") options = options.concat(state.suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`));
      if (kind === "transport") options = options.concat(state.transports.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`));
      relIdSel.innerHTML = options.join("");
      return;
    }
  });

  document.addEventListener("submit", (e) => {
    const form = e.target.closest("form[data-form]");
    if (form) { e.preventDefault(); handleFormSubmit(form); }
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "geo-search") {
      mapSearchQuery = e.target.value;
      const q = e.target.value.trim();
      if (q.length >= 3 && googleMapsKeyConfigured()) fetchGlobalMapPlaces(q); else mapPlacesSuggestions = [];
      debounceRender();
    }
    if (e.target.id === "geo-plan-origen" || e.target.id === "geo-plan-destino") {
      const which = e.target.id === "geo-plan-origen" ? "origen" : "destino";
      mapPlanQuery[which] = e.target.value;
      if (which === "origen") { mapOrigenDestino.origenId = ""; mapOrigenDestino.origenPoint = null; }
      else { mapOrigenDestino.destinoId = ""; mapOrigenDestino.destinoPoint = null; }
      mapRouteResult = null; mapRouteError = "";
      const q = e.target.value.trim();
      if (q.length >= 3 && googleMapsKeyConfigured()) fetchPlanPlaces(which, q); else mapPlanSuggestions[which] = [];
      debounceRender();
    }
    if (e.target.id === "pedidos-q") { pedidosFilter.q = e.target.value; debounceRender(); }
    if (e.target.id === "compras-q") { comprasFilter.q = e.target.value; debounceRender(); }
    if (e.target.id === "transporte-q") { transporteFilter.q = e.target.value; debounceRender(); }
    if (e.target.id === "proveedores-q") { proveedoresFilter.q = e.target.value; debounceRender(); }
    if (e.target.id === "inv-search") { inventarioSearch = e.target.value; debounceRender(); }
    if (e.target.id === "inv-traza-search") { inventarioTrazaQuery = e.target.value; debounceRender(); }
    if (e.target.matches("[data-prod-line-qty]")) {
      const line = produccionPlan.lines.find((l) => l.id === e.target.dataset.prodLineQty);
      if (line) line.quantity = e.target.value;
      debounceRender();
    }
    if (e.target.id === "global-search") {
      const q = e.target.value;
      const box = $("#search-results");
      if (!q.trim()) { box.classList.add("hidden"); box.innerHTML = ""; return; }
      const res = globalSearch(q);
      box.innerHTML = res.length ? res.map((r) => `<a href="${r.href}" class="search-result-item"><span class="sr-icon">${r.icon}</span><div><div class="sr-title">${esc(r.title)}</div><div class="sr-sub">${esc(r.kind)} · ${esc(r.sub || "")}</div></div></a>`).join("") : `<div class="search-empty">Sin resultados para "${esc(q)}"</div>`;
      box.classList.remove("hidden");
    }
  });
}

let renderTimer = null;
function debounceRender() { clearTimeout(renderTimer); renderTimer = setTimeout(() => renderMainOnly(), 220); }
function renderMainOnly() {
  const el = $("#app-main");
  if (!el) return;
  const active = document.activeElement;
  const activeId = active && active.id;
  const selStart = active && "selectionStart" in active ? active.selectionStart : null;
  el.innerHTML = renderMain();
  if (activeId) {
    const restored = document.getElementById(activeId);
    if (restored) { restored.focus(); if (selStart !== null) { try { restored.setSelectionRange(selStart, selStart); } catch {} } }
  }
  el.querySelectorAll(".kpi-value, .kpi-hero-value, .kpi-hero-sub [data-count]").forEach((cel) => animateCount(cel, parseInt(cel.dataset.count, 10)));
  mountMapsIfPresent();
}

/* ---------------------------------------------------------------------------
   25. PRODUCCIÓN — ÓRDENES DE FABRICACIÓN (OF)
   ---------------------------------------------------------------------------
   Módulo nuevo y separado del flujo simple de Producción (14.6/14.7), que
   sigue intacto y sin tocar. Reutiliza box_configs/box_config_items como la
   "LDP maestra" (se versiona al crear cada OF, para que cambios futuros en
   la receta no alteren OFs ya creadas), locations (type "deposito") como
   almacenes, y el mismo mecanismo de auditoría por movimiento que ya usa
   Inventario. La reserva de stock es atómica del lado del servidor
   (fn_reservar_produccion, ver migration_of_rpc.sql) para que dos OF
   simultáneas nunca puedan sobre-reservar el mismo stock.
   ------------------------------------------------------------------------- */
const OF_ESTADOS = {
  BORRADOR: { label: "Borrador", cls: "st-gray" },
  PLANIFICADA: { label: "Planificada", cls: "st-blue" },
  RESERVADA: { label: "Reservada", cls: "st-violet" },
  EN_PRODUCCION: { label: "En producción", cls: "st-blue" },
  PAUSADA: { label: "Pausada", cls: "st-yellow" },
  BLOQUEADA: { label: "Bloqueada", cls: "st-red" },
  OBSERVADA: { label: "Observada", cls: "st-orange" },
  COMPLETADA: { label: "Completada", cls: "st-green" },
  CANCELADA: { label: "Cancelada", cls: "st-gray" },
};

function depositoLocations() {
  return state.locations.filter((l) => l.type === "deposito");
}

/** Tamaños de caja que tienen una receta (box_config + items) configurada —
 * sólo esos se pueden elegir como "producto final" de una OF nueva. */
function ofFinalProductOptions() {
  return BOX_SIZES.map((size) => {
    const config = boxConfigForSize(size);
    const items = config ? boxConfigItems(config.id) : [];
    return { size, config, items };
  }).filter((opt) => opt.config && opt.items.length > 0);
}

/** Congela la receta actual (box_config_items) de un box_config en una nueva
 * versión de LDP (ldp_versions + ldp_version_items), para que la OF que la
 * use quede fija aunque después se edite la receta maestra. */
async function createLdpVersionSnapshot(boxConfigId) {
  const items = boxConfigItems(boxConfigId);
  if (!items.length) throw new Error("La receta de esta caja no tiene productos configurados");
  const boxConfig = getById("box_configs", boxConfigId);
  const nextVersion = Math.max(0, ...state.ldp_versions.filter((v) => v.boxConfigId === boxConfigId).map((v) => v.version)) + 1;
  const usuario = state.session?.user?.email || "Operador";
  const ldpVersion = {
    id: uid("ldpv"),
    boxConfigId,
    version: nextVersion,
    snapshotSize: boxConfig?.size || null,
    snapshotName: boxConfig?.name || boxSizeLabel(boxConfig?.size),
    createdBy: usuario,
  };
  await persist("ldp_versions", ldpVersion);
  for (const item of items) {
    const product = getById("products", item.productId);
    await persist("ldp_version_items", {
      id: uid("ldpi"),
      ldpVersionId: ldpVersion.id,
      productId: item.productId,
      codigoInterno: product?.sku || null,
      nombre: product?.name || null,
      ean13: product?.ean13 || null,
      unidad: product?.unit || null,
      cantidadRequerida: item.quantity,
      estado: "activo",
    });
  }
  return ldpVersion;
}

/** Crea una OF: valida cantidad, versiona la LDP del producto final elegido,
 * y genera un número único con reintentos acotados ante una colisión real
 * de la restricción unique de `numero` (dos usuarios creando a la vez). */
async function createManufacturingOrder(opts) {
  const { boxConfigId, cantidadPlanificada, fechaPlanificacion, fechaPrevista, almacenOrigenId, almacenIntermedioId, notes } = opts;
  if (!(cantidadPlanificada > 0)) throw new Error("La cantidad planificada debe ser mayor a 0");
  const ldpVersion = await createLdpVersionSnapshot(boxConfigId);
  const usuario = state.session?.user?.email || "Operador";
  let saved = null, lastErr = null;
  for (let attempt = 0; attempt < 8 && !saved; attempt++) {
    const numero = `OF-${String(state.manufacturing_orders.length + 1 + attempt).padStart(5, "0")}`;
    const rec = {
      id: uid("of"), numero, boxConfigId, ldpVersionId: ldpVersion.id,
      cantidadPlanificada, cantidadProducida: 0, estado: "BORRADOR",
      fechaCreacion: nowISO(), fechaPlanificacion: fechaPlanificacion || null, fechaPrevista: fechaPrevista || null,
      fechaInicio: null, fechaCierre: null, createdBy: usuario, usuarioResponsable: usuario,
      almacenOrigenId: almacenOrigenId || null, almacenIntermedioId: almacenIntermedioId || null,
      motivoPausa: null, motivoBloqueo: null, codigoBarras: numero, notes: notes || "",
    };
    try {
      const savedRec = await saveRecord("manufacturing_orders", rec);
      state.manufacturing_orders.push(savedRec);
      saved = savedRec;
    } catch (e) { lastErr = e; }
  }
  if (!saved) throw lastErr || new Error("No se pudo generar un número de OF único, reintentá");
  await persist("production_audit_log", {
    id: uid("aud"), manufacturingOrderId: saved.id, productId: null, operacion: "creacion", usuario,
    infoAnterior: null, infoNueva: { numero: saved.numero, boxConfigId, cantidadPlanificada, ldpVersionId: ldpVersion.id }, notas: "",
  });
  return saved;
}

/** Calcula, por producto de la LDP versionada de una OF: lo necesario, lo
 * disponible (stock libre no reservado por OTRA OF), lo reservado NETO para
 * esta OF (reserva bruta menos lo ya consumido — así la tabla no muestra
 * "reservado" algo que ya se consumió), lo consumido, lo pendiente y el
 * faltante real, más un estado resumen. */
/** Calcula, por producto de la LDP versionada de una OF: lo necesario, lo
 * disponible (stock libre no reservado por OTRA OF), lo reservado NETO para
 * esta OF (reserva bruta menos lo ya consumido), lo consumido, lo pendiente
 * y el faltante real, más un estado resumen. Si un componente de la LDP fue
 * reemplazado (production_substitutions activa para esta OF), su fila queda
 * marcada "sustituido" (con necesario cubierto, nada pendiente) y se agrega
 * una fila extra para el producto sustituto, consumible igual que cualquier
 * otro componente — así registrarConsumoOF() no necesita saber nada de
 * sustituciones, sólo busca por productId en estas filas. */
function ofNeedsRows(of) {
  const items = state.ldp_version_items.filter((i) => i.ldpVersionId === of.ldpVersionId);
  const activeSubs = state.production_substitutions.filter((s) => s.manufacturingOrderId === of.id);
  const rows = [];
  for (const item of items) {
    const sub = activeSubs.find((s) => s.productoOriginalId === item.productId);
    const necesario = item.cantidadRequerida * of.cantidadPlanificada;
    if (sub) {
      rows.push({
        productId: item.productId, nombre: item.nombre, codigoInterno: item.codigoInterno, ean13: item.ean13,
        necesario, disponible: 0, reservadoOF: necesario, consumido: necesario, pendiente: 0, faltante: 0,
        estado: "sustituido", sustituidoPor: sub.productoSustitutoId,
      });
      continue;
    }
    const reservadoBruto = state.production_reservations
      .filter((r) => r.manufacturingOrderId === of.id && r.productId === item.productId && r.estado === "RESERVADO")
      .reduce((s, r) => s + (r.cantidad || 0), 0);
    const consumido = state.production_consumptions
      .filter((c) => c.manufacturingOrderId === of.id && c.productId === item.productId && c.tipo === "consumo")
      .reduce((s, c) => s + (c.cantidad || 0), 0);
    const reservadoOF = Math.max(0, reservadoBruto - consumido);
    const otrasReservas = state.production_reservations
      .filter((r) => r.productId === item.productId && r.estado === "RESERVADO" && r.manufacturingOrderId !== of.id)
      .reduce((s, r) => s + (r.cantidad || 0), 0);
    const disponible = Math.max(0, productTotalQty(item.productId) - otrasReservas);
    const pendiente = Math.max(0, necesario - consumido);
    const faltante = Math.max(0, pendiente - reservadoOF - disponible);
    const estado = consumido >= necesario ? "completo" : (reservadoOF + disponible >= pendiente ? "reservable" : "faltante");
    rows.push({
      productId: item.productId, nombre: item.nombre, codigoInterno: item.codigoInterno, ean13: item.ean13,
      necesario, disponible, reservadoOF, consumido, pendiente, faltante, estado,
    });
  }
  for (const sub of activeSubs) {
    const necesario = sub.cantidad;
    const consumido = state.production_consumptions
      .filter((c) => c.manufacturingOrderId === of.id && c.productId === sub.productoSustitutoId && c.tipo === "consumo")
      .reduce((s, c) => s + (c.cantidad || 0), 0);
    const reservadoBruto = state.production_reservations
      .filter((r) => r.manufacturingOrderId === of.id && r.productId === sub.productoSustitutoId && r.estado === "RESERVADO")
      .reduce((s, r) => s + (r.cantidad || 0), 0);
    const reservadoOF = Math.max(0, reservadoBruto - consumido);
    const otrasReservas = state.production_reservations
      .filter((r) => r.productId === sub.productoSustitutoId && r.estado === "RESERVADO" && r.manufacturingOrderId !== of.id)
      .reduce((s, r) => s + (r.cantidad || 0), 0);
    const disponible = Math.max(0, productTotalQty(sub.productoSustitutoId) - otrasReservas);
    const pendiente = Math.max(0, necesario - consumido);
    const faltante = Math.max(0, pendiente - reservadoOF - disponible);
    const estado = consumido >= necesario ? "completo" : (reservadoOF + disponible >= pendiente ? "reservable" : "faltante");
    const p = getById("products", sub.productoSustitutoId);
    rows.push({
      productId: sub.productoSustitutoId, nombre: (p?.name || "—") + " (reemplazo)", codigoInterno: p?.sku || null, ean13: sub.eanSustituto,
      necesario, disponible, reservadoOF, consumido, pendiente, faltante, estado, esSustituto: true,
    });
  }
  return rows;
}

/** Reserva stock para una OF llamando al RPC atómico del servidor
 * (fn_reservar_produccion) línea por línea, secuencialmente — nunca en
 * paralelo, para no saturar la DB y para poder atribuir un error a un
 * producto puntual. */
async function reservarStockOF(ofId) {
  const of = getById("manufacturing_orders", ofId);
  if (!of) return;
  const rows = ofNeedsRows(of).filter((r) => r.necesario - r.reservadoOF > 0);
  for (const row of rows) {
    await callRpc("fn_reservar_produccion", {
      p_manufacturing_order_id: of.id, p_product_id: row.productId, p_ean13: row.ean13 || null,
      p_cantidad: row.necesario - row.reservadoOF, p_almacen_id: of.almacenOrigenId || null,
      p_usuario: state.session?.user?.email || "Operador",
    });
  }
  const fresh = await loadAll();
  state.production_reservations = fresh.production_reservations;
  state.production_audit_log = fresh.production_audit_log;

  const completo = ofNeedsRows(of).every((r) => r.faltante === 0);
  if (completo) {
    await persist("manufacturing_orders", { ...of, estado: "RESERVADA" });
    toast("Stock reservado por completo");
  } else {
    toast("Reserva parcial: quedan faltantes, ver tabla", "warn");
  }
  renderApp();
}

/** Libera (cancela) una reserva existente vía RPC — nunca la borra, la
 * marca LIBERADA en el servidor para mantener la auditoría. */
async function liberarReservaOF(reservationId, motivo) {
  await callRpc("fn_liberar_reserva_produccion", {
    p_reservation_id: reservationId, p_usuario: state.session?.user?.email || "Operador", p_motivo: motivo || "",
  });
  const fresh = await loadAll();
  state.production_reservations = fresh.production_reservations;
  state.production_audit_log = fresh.production_audit_log;
  toast("Reserva liberada");
  renderApp();
}

/** Cambia el estado de una OF (transiciones simples: planificar, pausar,
 * bloquear, reanudar/desbloquear → PLANIFICADA, cancelar) dejando registro
 * en la auditoría. */
async function setOfEstado(ofId, nuevoEstado, opts = {}) {
  const of = getById("manufacturing_orders", ofId);
  if (!of) return;
  if ((nuevoEstado === "PAUSADA" || nuevoEstado === "BLOQUEADA") && !opts.motivo) throw new Error("Se requiere un motivo");
  const estadoAnterior = of.estado;
  const rec = { ...of, estado: nuevoEstado };
  if (nuevoEstado === "PAUSADA") rec.motivoPausa = opts.motivo;
  if (nuevoEstado === "BLOQUEADA") rec.motivoBloqueo = opts.motivo;
  if (nuevoEstado !== "PAUSADA") rec.motivoPausa = null;
  if (nuevoEstado !== "BLOQUEADA") rec.motivoBloqueo = null;
  await persist("manufacturing_orders", rec);
  await persist("production_audit_log", {
    id: uid("aud"), manufacturingOrderId: of.id, productId: null, operacion: "cambio_estado",
    usuario: state.session?.user?.email || "Operador", infoAnterior: { estado: estadoAnterior }, infoNueva: { estado: nuevoEstado }, notas: opts.motivo || "",
  });
  toast(`OF ${of.numero}: ${OF_ESTADOS[nuevoEstado]?.label || nuevoEstado}`);
  renderApp();
}

let ofListTab = "hoy"; // "hoy" | "todas"
let ofHoyFilter = "hoy"; // "hoy" | "manana" | "proximas" | "en_produccion" | "bloqueadas" | "completadas"
const OF_HOY_FILTERS = [
  { key: "hoy", label: "Hoy" },
  { key: "manana", label: "Mañana" },
  { key: "proximas", label: "Próximas" },
  { key: "en_produccion", label: "En producción" },
  { key: "bloqueadas", label: "Bloqueadas" },
  { key: "completadas", label: "Completadas" },
];

/** KPIs del panel "Producción Hoy": OF de hoy, cajas que faltan producir
 * hoy, OF en producción, bloqueadas, completadas hoy, OF con algún
 * componente realmente faltante (ni reservado ni disponible alcanza), y
 * cuántos productos distintos tienen stock reservado para producción en
 * este momento. */
function ofDashboardStats() {
  const orders = state.manufacturing_orders;
  const today = todayISO();
  const fecha = (o) => (o.fechaPlanificacion || o.fechaCreacion || "").slice(0, 10);
  const hoyOrders = orders.filter((o) => fecha(o) === today);
  const cajasAProducir = hoyOrders.reduce((s, o) => s + Math.max(0, (o.cantidadPlanificada || 0) - (o.cantidadProducida || 0)), 0);
  const enProduccion = orders.filter((o) => o.estado === "EN_PRODUCCION").length;
  const bloqueadas = orders.filter((o) => o.estado === "BLOQUEADA").length;
  const completadasHoy = orders.filter((o) => o.estado === "COMPLETADA" && (o.fechaCierre || "").slice(0, 10) === today).length;
  const conFaltantes = orders.filter((o) => !["COMPLETADA", "CANCELADA"].includes(o.estado) && ofNeedsRows(o).some((r) => r.faltante > 0)).length;
  const productosReservados = new Set(state.production_reservations.filter((r) => r.estado === "RESERVADO").map((r) => r.productId)).size;
  return { ofHoy: hoyOrders.length, cajasAProducir, enProduccion, bloqueadas, completadasHoy, conFaltantes, productosReservados };
}

function ofHoyFilteredOrders() {
  const orders = state.manufacturing_orders;
  const today = todayISO();
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);
  const fecha = (o) => (o.fechaPlanificacion || o.fechaCreacion || "").slice(0, 10);
  if (ofHoyFilter === "hoy") return orders.filter((o) => fecha(o) === today);
  if (ofHoyFilter === "manana") return orders.filter((o) => fecha(o) === tomorrow);
  if (ofHoyFilter === "proximas") return orders.filter((o) => fecha(o) > today);
  if (ofHoyFilter === "en_produccion") return orders.filter((o) => o.estado === "EN_PRODUCCION");
  if (ofHoyFilter === "bloqueadas") return orders.filter((o) => o.estado === "BLOQUEADA");
  if (ofHoyFilter === "completadas") return orders.filter((o) => o.estado === "COMPLETADA");
  return orders;
}

/** Panel "Producción Hoy": KPIs operativos del día + filtros rápidos.
 * Clickear una OF de la tabla abre su detalle (mismo link que en "Todas"). */
function viewOfHoy() {
  const stats = ofDashboardStats();
  const filtered = [...ofHoyFilteredOrders()].sort((a, b) => new Date(b.fechaCreacion || 0) - new Date(a.fechaCreacion || 0));
  return `
    <div class="kpi-grid kpi-grid-compact" style="margin-bottom:16px">
      ${kpiCard(stats.ofHoy, "OF de hoy", "📅", "kpi-blue", 0)}
      ${kpiCard(stats.cajasAProducir, "Cajas a producir hoy", "📦", "kpi-violet", 40)}
      ${kpiCard(stats.enProduccion, "OF en producción", "⚙", "kpi-blue", 80)}
      ${kpiCard(stats.bloqueadas, "OF bloqueadas", "⛔", stats.bloqueadas ? "kpi-red" : "kpi-blue", 120)}
      ${kpiCard(stats.completadasHoy, "OF completadas hoy", "✅", "kpi-blue", 160)}
      ${kpiCard(stats.conFaltantes, "OF con faltantes", "⚠", stats.conFaltantes ? "kpi-orange" : "kpi-blue", 200)}
      ${kpiCard(stats.productosReservados, "Productos reservados", "🔒", "kpi-blue", 240)}
    </div>
    <div class="chip-row">
      ${OF_HOY_FILTERS.map((f) => `<button class="chip ${ofHoyFilter === f.key ? "active" : ""}" data-of-hoy-filter="${f.key}">${esc(f.label)}</button>`).join("")}
    </div>
    <div class="panel" style="margin-top:12px">
      <div style="overflow-x:auto"><table class="mini-table">
        <thead><tr><th>Número</th><th>Producto final</th><th style="text-align:right">Planificada</th><th style="text-align:right">Producida</th><th>Estado</th><th>Fecha planificación</th></tr></thead>
        <tbody>${filtered.length ? filtered.map((o) => {
          const cfg = getById("box_configs", o.boxConfigId);
          const productoFinal = cfg ? `${esc(boxSizeLabel(cfg.size))}${cfg.name ? " — " + esc(cfg.name) : ""}` : "—";
          return `<tr>
            <td><a href="#/of_produccion/${o.id}" class="link-more">${esc(o.numero)}</a></td>
            <td>${productoFinal}</td>
            <td style="text-align:right">${o.cantidadPlanificada}</td>
            <td style="text-align:right">${o.cantidadProducida}</td>
            <td>${statusBadge(OF_ESTADOS[o.estado])}</td>
            <td>${o.fechaPlanificacion ? fmtDate(o.fechaPlanificacion) : "—"}</td>
          </tr>`;
        }).join("") : `<tr><td colspan="6"><div class="hint">Sin OF para este filtro.</div></td></tr>`}</tbody>
      </table></div>
    </div>
  `;
}

function viewOfProduccion() {
  const orders = state.manufacturing_orders;
  if (!orders.length) {
    return `<div class="view-list">
      <div class="list-toolbar"><h3 class="muted-title">Órdenes de Fabricación</h3><button class="btn btn-primary" data-action="open-modal" data-modal="of-new">+ Nueva OF</button></div>
      ${emptyState("🏭", "Sin órdenes de fabricación", "Creá tu primera OF para planificar producción con reserva de stock y trazabilidad completa.", '<button class="btn btn-primary" data-action="open-modal" data-modal="of-new">+ Nueva OF</button>')}
    </div>`;
  }
  const enCurso = orders.filter((o) => ["RESERVADA", "EN_PRODUCCION"].includes(o.estado)).length;
  const bloqueadas = orders.filter((o) => o.estado === "BLOQUEADA").length;
  const completadasHoy = orders.filter((o) => o.estado === "COMPLETADA" && (o.fechaCierre || "").slice(0, 10) === todayISO()).length;
  const sorted = [...orders].sort((a, b) => new Date(b.fechaCreacion || 0) - new Date(a.fechaCreacion || 0));
  return `<div class="view-list">
    <div class="list-toolbar"><h3 class="muted-title">Órdenes de Fabricación</h3><button class="btn btn-primary" data-action="open-modal" data-modal="of-new">+ Nueva OF</button></div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><h3>🔎 Identificar OF por código de barras</h3></div>
      <form data-form="of-buscar-codigo" class="form-grid" style="align-items:end">
        <label class="span2">Escaneá el código de la OF (o escribilo)<input class="input" name="codigo" id="of-buscar-input" autocomplete="off" /></label>
        <div><button type="submit" class="btn btn-secondary">Buscar</button></div>
      </form>
    </div>
    <div class="chip-row" style="margin-bottom:16px">
      <button class="chip ${ofListTab === "hoy" ? "active" : ""}" data-of-tab="hoy">Producción Hoy</button>
      <button class="chip ${ofListTab === "todas" ? "active" : ""}" data-of-tab="todas">Todas las OF (${orders.length})</button>
    </div>
    ${ofListTab === "hoy" ? viewOfHoy() : `
    <div class="kpi-grid kpi-grid-compact" style="margin-bottom:16px">
      ${kpiCard(orders.length, "OF totales", "🏭", "kpi-blue", 0)}
      ${kpiCard(enCurso, "En producción / reservadas", "⚙", "kpi-violet", 40)}
      ${kpiCard(bloqueadas, "Bloqueadas", "⛔", bloqueadas ? "kpi-red" : "kpi-blue", 80)}
      ${kpiCard(completadasHoy, "Completadas hoy", "✅", "kpi-blue", 120)}
    </div>
    <div class="panel">
      <div style="overflow-x:auto"><table class="mini-table">
        <thead><tr><th>Número</th><th>Producto final</th><th style="text-align:right">Cant. planificada</th><th style="text-align:right">Cant. producida</th><th>Estado</th><th>Fecha creación</th></tr></thead>
        <tbody>${sorted.map((o) => {
          const cfg = getById("box_configs", o.boxConfigId);
          const productoFinal = cfg ? `${esc(boxSizeLabel(cfg.size))}${cfg.name ? " — " + esc(cfg.name) : ""}` : "—";
          return `<tr>
            <td><a href="#/of_produccion/${o.id}" class="link-more">${esc(o.numero)}</a></td>
            <td>${productoFinal}</td>
            <td style="text-align:right">${o.cantidadPlanificada}</td>
            <td style="text-align:right">${o.cantidadProducida}</td>
            <td>${statusBadge(OF_ESTADOS[o.estado])}</td>
            <td>${fmtDateTime(o.fechaCreacion)}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
    </div>`}
  </div>`;
}

function viewOfDetail(id) {
  const of = getById("manufacturing_orders", id);
  if (!of) return emptyState("🤔", "OF no encontrada", "");
  const cfg = getById("box_configs", of.boxConfigId);
  const ldpVersion = getById("ldp_versions", of.ldpVersionId);
  const productoFinal = cfg ? `${esc(boxSizeLabel(cfg.size))}${cfg.name ? " — " + esc(cfg.name) : ""}` : "—";
  const rows = ofNeedsRows(of);
  const reservas = state.production_reservations.filter((r) => r.manufacturingOrderId === of.id && r.estado === "RESERVADO");
  const auditoria = state.production_audit_log.filter((a) => a.manufacturingOrderId === of.id)
    .sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));
  const NEED_ESTADO_META = {
    completo: { label: "✓ Completo", cls: "st-green" },
    reservable: { label: "Reservable", cls: "st-blue" },
    faltante: { label: "⚠ Faltante", cls: "st-red" },
    sustituido: { label: "Sustituido", cls: "st-orange" },
  };
  const closingCheck = ofClosingCheck(of);
  const substituciones = state.production_substitutions.filter((s) => s.manufacturingOrderId === of.id);
  const actions = [];
  if (of.estado === "BORRADOR") actions.push(`<button class="btn btn-primary" data-action="of-planificar" data-id="${of.id}">Planificar</button>`);
  if (of.estado === "PLANIFICADA") actions.push(`<button class="btn btn-primary" data-action="of-reservar" data-id="${of.id}">Reservar stock</button>`);
  if (["PLANIFICADA", "RESERVADA", "EN_PRODUCCION"].includes(of.estado)) {
    actions.push(`<button class="btn btn-secondary" data-action="of-pausar" data-id="${of.id}">Pausar</button>`);
    actions.push(`<button class="btn btn-secondary" data-action="of-bloquear" data-id="${of.id}">Bloquear</button>`);
  }
  if (of.estado === "PAUSADA") actions.push(`<button class="btn btn-primary" data-action="of-reanudar" data-id="${of.id}">Reanudar</button>`);
  if (of.estado === "BLOQUEADA") actions.push(`<button class="btn btn-primary" data-action="of-desbloquear" data-id="${of.id}">Desbloquear</button>`);
  if (!["COMPLETADA", "CANCELADA"].includes(of.estado)) actions.push(`<button class="btn btn-ghost" data-action="of-cancelar" data-id="${of.id}">Cancelar OF</button>`);
  if (!["COMPLETADA", "CANCELADA"].includes(of.estado) && closingCheck.ready) actions.push(`<button class="btn btn-primary" data-action="of-cerrar" data-id="${of.id}">🟢 Cerrar OF</button>`);
  actions.push(`<a href="#/of_produccion/${of.id}/imprimir" class="btn btn-ghost">🖨️ Imprimir</a>`);
  return `
  <div class="detail-view">
    <div class="detail-head">
      <div><a href="#/of_produccion" class="back-link">← Órdenes de Fabricación</a><h2>${esc(of.numero)}</h2>
        <div class="detail-sub">${productoFinal} ${statusBadge(OF_ESTADOS[of.estado])}</div>
      </div>
      <div class="detail-actions">${actions.join("")}</div>
    </div>
    <div class="detail-grid">
      <div class="panel">
        <div class="panel-head"><h3>Resumen</h3></div>
        <div class="stat-row wrap">
          <div class="stat-box"><b>${of.cantidadPlanificada}</b><span>Planificada</span></div>
          <div class="stat-box"><b>${of.cantidadProducida}</b><span>Producida</span></div>
          <div class="stat-box"><b>${ldpVersion ? "Versión " + ldpVersion.version : "—"}</b><span>LDP</span></div>
        </div>
        ${["RESERVADA", "EN_PRODUCCION"].includes(of.estado) ? `
        <form data-form="of-avance" data-id="${of.id}" class="form-grid" style="margin:10px 0;align-items:end">
          <label>Registrar avance (cajas terminadas)<input class="input" type="number" name="cantidad" min="1" step="1" placeholder="ej: 5" /></label>
          <div><button type="submit" class="btn btn-secondary">Registrar avance</button></div>
        </form>` : ""}
        <div class="kv"><span>Almacén origen</span><b>${of.almacenOrigenId ? esc(locName(of.almacenOrigenId)) : "—"}</b></div>
        <div class="kv"><span>Almacén intermedio</span><b>${of.almacenIntermedioId ? esc(locName(of.almacenIntermedioId)) : "—"}</b></div>
        ${of.notes ? `<div class="kv-notes"><span>Notas</span><p>${esc(of.notes)}</p></div>` : ""}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Fechas</h3></div>
        <div class="kv"><span>Creación</span><b>${fmtDateTime(of.fechaCreacion)}</b></div>
        <div class="kv"><span>Planificación</span><b>${of.fechaPlanificacion ? fmtDate(of.fechaPlanificacion) : "—"}</b></div>
        <div class="kv"><span>Prevista</span><b>${of.fechaPrevista ? fmtDate(of.fechaPrevista) : "—"}</b></div>
        <div class="kv"><span>Inicio</span><b>${of.fechaInicio ? fmtDateTime(of.fechaInicio) : "—"}</b></div>
        <div class="kv"><span>Cierre</span><b>${of.fechaCierre ? fmtDateTime(of.fechaCierre) : "—"}</b></div>
      </div>
      <div class="panel span2">
        <div class="panel-head"><h3>Necesidad de materiales</h3></div>
        ${["RESERVADA", "EN_PRODUCCION"].includes(of.estado) ? viewOfScanPanel(of) : ""}
        ${["RESERVADA", "EN_PRODUCCION"].includes(of.estado) ? viewOfReplacementPanel(of) : ""}
        <div style="overflow-x:auto"><table class="mini-table">
          <thead><tr><th>Producto</th><th>EAN-13</th><th style="text-align:right">Necesario</th><th style="text-align:right">Disponible</th><th style="text-align:right">Reservado</th><th style="text-align:right">Consumido</th><th style="text-align:right">Faltante</th><th>Estado</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${esc(r.nombre || "—")}</td>
            <td>${esc(r.ean13 || "—")}</td>
            <td style="text-align:right">${r.necesario}</td>
            <td style="text-align:right">${r.disponible}</td>
            <td style="text-align:right">${r.reservadoOF}</td>
            <td style="text-align:right">${r.consumido}</td>
            <td style="text-align:right">${r.faltante}</td>
            <td>${statusBadge(NEED_ESTADO_META[r.estado])}</td>
          </tr>`).join("")}</tbody>
        </table></div>
      </div>
      <div class="panel span2">
        <div class="panel-head"><h3>Reservas activas</h3></div>
        ${reservas.length ? `<div style="overflow-x:auto"><table class="mini-table">
          <thead><tr><th>Producto</th><th style="text-align:right">Cantidad</th><th>Almacén</th><th>Usuario</th><th>Fecha</th><th></th></tr></thead>
          <tbody>${reservas.map((r) => {
            const p = getById("products", r.productId);
            return `<tr>
              <td>${esc(p?.name || "—")}</td>
              <td style="text-align:right">${r.cantidad}</td>
              <td>${r.almacenId ? esc(locName(r.almacenId)) : "—"}</td>
              <td>${esc(r.usuario || "—")}</td>
              <td>${fmtDateTime(r.fecha)}</td>
              <td><button class="btn btn-ghost btn-sm" data-action="of-liberar-reserva" data-id="${r.id}">Liberar</button></td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>` : `<div class="hint">Sin reservas activas.</div>`}
      </div>
      ${substituciones.length ? `<div class="panel span2">
        <div class="panel-head"><h3>Reemplazos realizados</h3></div>
        <div style="overflow-x:auto"><table class="mini-table">
          <thead><tr><th>Original</th><th>Sustituto</th><th style="text-align:right">Cantidad</th><th>Motivo</th><th>Usuario</th><th>Fecha</th></tr></thead>
          <tbody>${substituciones.map((s) => {
            const po = getById("products", s.productoOriginalId), ps = getById("products", s.productoSustitutoId);
            return `<tr>
              <td>${esc(po?.name || "—")}</td>
              <td>${esc(ps?.name || "—")}</td>
              <td style="text-align:right">${s.cantidad}</td>
              <td>${esc(s.motivo || "—")}</td>
              <td>${esc(s.usuario || "—")}</td>
              <td>${fmtDateTime(s.fecha)}</td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>
      </div>` : ""}
      ${!["COMPLETADA", "CANCELADA"].includes(of.estado) ? `<div class="panel span2">
        <div class="panel-head"><h3>Cierre de OF</h3></div>
        ${closingCheck.ready
          ? `<div class="hint" style="font-weight:700;color:var(--green,#2e7d32)">🟢 OF LISTA PARA CERRAR</div>`
          : `<div class="hint" style="font-weight:700;color:var(--red,#c0392b)">🔴 OF NO PUEDE CERRARSE<ul style="margin:6px 0 0 18px">${closingCheck.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`}
      </div>` : ""}
      <div class="panel span2">
        <div class="panel-head"><h3>Historial / auditoría</h3></div>
        ${auditoria.length ? `<div style="overflow-x:auto"><table class="mini-table">
          <thead><tr><th>Operación</th><th>Usuario</th><th>Fecha</th><th>Notas</th></tr></thead>
          <tbody>${auditoria.map((a) => `<tr>
            <td>${esc(a.operacion)}</td>
            <td>${esc(a.usuario || "—")}</td>
            <td>${fmtDateTime(a.fecha)}</td>
            <td>${esc(a.notas || "—")}</td>
          </tr>`).join("")}</tbody>
        </table></div>` : `<div class="hint">Sin movimientos registrados.</div>`}
      </div>
    </div>
  </div>`;
}

/** Busca un producto por EAN-13 (prioridad) o por SKU — ambos son válidos
 * para escanear, ya que no todos los productos van a tener EAN-13 cargado
 * todavía. */
/** Vista de impresión de una OF — de sólo lectura (no llama a persist() ni
 * a ningún RPC en ningún momento: reimprimir nunca crea una OF nueva ni
 * modifica stock). Pensada para window.print() nativo del navegador, en A4
 * y legible en blanco y negro. El identificador de la OF se imprime como
 * texto grande y con espaciado (no como gráfico de código de barras: eso
 * requeriría una librería externa que este entorno no puede instalar por
 * ahora) — sigue siendo utilizable con el buscador de OF por código. */
function viewOfImprimir(id) {
  const of = getById("manufacturing_orders", id);
  if (!of) return emptyState("🤔", "OF no encontrada", "");
  const cfg = getById("box_configs", of.boxConfigId);
  const ldpVersion = getById("ldp_versions", of.ldpVersionId);
  const productoFinal = cfg ? `${esc(boxSizeLabel(cfg.size))}${cfg.name ? " — " + esc(cfg.name) : ""}` : "—";
  const rows = ofNeedsRows(of);
  return `
    <div class="no-print" style="margin-bottom:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <a href="#/of_produccion/${of.id}" class="back-link">← Volver a la OF</a>
      <button type="button" class="btn btn-primary" data-action="of-imprimir-ahora">🖨️ Imprimir / Guardar como PDF</button>
    </div>
    <div class="print-of">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:14px">
        <div>
          <div style="font-size:20px;font-weight:800">LOGÍSTICA PERONA</div>
          <div style="font-size:13px">Orden de Fabricación</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:28px;font-weight:800;letter-spacing:3px;font-family:monospace">${esc(of.numero)}</div>
          <div style="font-size:12px">${statusBadge(OF_ESTADOS[of.estado])}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;margin-bottom:14px;font-size:13px">
        <div><b>Producto final:</b> ${productoFinal}</div>
        <div><b>Versión de LDP:</b> ${ldpVersion ? "Versión " + ldpVersion.version : "—"}</div>
        <div><b>Cantidad planificada:</b> ${of.cantidadPlanificada}</div>
        <div><b>Cantidad producida:</b> ${of.cantidadProducida}</div>
        <div><b>Fecha de creación:</b> ${fmtDateTime(of.fechaCreacion)}</div>
        <div><b>Fecha prevista:</b> ${of.fechaPrevista ? fmtDate(of.fechaPrevista) : "—"}</div>
        <div><b>Almacén origen:</b> ${of.almacenOrigenId ? esc(locName(of.almacenOrigenId)) : "—"}</div>
        <div><b>Almacén intermedio:</b> ${of.almacenIntermedioId ? esc(locName(of.almacenIntermedioId)) : "—"}</div>
      </div>
      <table class="mini-table" style="width:100%;border-collapse:collapse">
        <thead><tr><th>Componente</th><th>EAN-13 / código</th><th style="text-align:right">Necesario</th><th style="text-align:right">Reservado</th><th style="text-align:right">Consumido</th><th style="text-align:right">Pendiente</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.nombre || "—")}${r.esSustituto ? " *" : ""}</td>
          <td>${esc(r.ean13 || r.codigoInterno || "—")}</td>
          <td style="text-align:right">${r.necesario}</td>
          <td style="text-align:right">${r.reservadoOF}</td>
          <td style="text-align:right">${r.consumido}</td>
          <td style="text-align:right">${r.pendiente}</td>
        </tr>`).join("")}</tbody>
      </table>
      ${rows.some((r) => r.esSustituto) ? `<div style="font-size:11px;margin-top:6px">* Producto de reemplazo (ver historial en el detalle de la OF).</div>` : ""}
      ${of.notes ? `<div style="margin-top:12px;font-size:12px"><b>Notas:</b> ${esc(of.notes)}</div>` : ""}
      <div style="margin-top:20px;font-size:11px;color:#666">Impreso: ${fmtDateTime(nowISO())} · Documento de sólo lectura — reimprimir no modifica la OF ni el stock.</div>
    </div>
  `;
}

function findProductByScanCode(code) {
  const c = (code || "").trim();
  if (!c) return null;
  return state.products.find((p) => p.ean13 && p.ean13 === c) || state.products.find((p) => p.sku && p.sku === c) || null;
}

/** Último resultado de un escaneo por OF (para mostrar un banner bien
 * visible, no sólo un toast que puede pasar desapercibido durante un
 * escaneo rápido). Se pisa en cada escaneo nuevo de esa OF. */
let ofScanMessages = {};
let ofScanBusy = false;

/** Registra el consumo real de un componente contra una OF: valida que el
 * código escaneado corresponda a un producto conocido, que ese producto
 * pertenezca a la LDP de esta OF (si no, bloquea — nunca auto-registra ni
 * asume un reemplazo), que la cantidad no exceda lo pendiente, y que haya
 * stock físico real en los lotes (FEFO) para cubrirla. Si cualquier
 * validación falla, no se escribe nada — "no silent errors". Si todo pasa,
 * descuenta los lotes, registra el movimiento de stock (mismo mecanismo que
 * ya usa Inventario), dos registros de trazabilidad (production_consumptions
 * y production_audit_log) y pasa la OF a EN_PRODUCCION si todavía estaba en
 * RESERVADA. */
async function registrarConsumoOF(ofId, codigoEscaneado, cantidad) {
  const of = getById("manufacturing_orders", ofId);
  if (!of) throw new Error("OF no encontrada");
  if (!["RESERVADA", "EN_PRODUCCION"].includes(of.estado)) throw new Error("La OF debe estar Reservada o En producción para registrar consumo");
  const product = findProductByScanCode(codigoEscaneado);
  if (!product) throw new Error(`Código no reconocido: "${codigoEscaneado}"`);
  const row = ofNeedsRows(of).find((r) => r.productId === product.id);
  if (!row) throw new Error(`"${product.name}" no pertenece a la receta de esta OF. Si es un reemplazo, usá el panel "Reemplazo de componente" más abajo.`);
  if (!(cantidad > 0)) throw new Error("Cantidad inválida");
  if (cantidad > row.pendiente + 0.0001) throw new Error(`Excede lo pendiente de "${product.name}": pendiente ${row.pendiente}, se intentó consumir ${cantidad}`);
  const { alloc, remaining } = fefoAllocate(product.id, cantidad);
  if (remaining > 0) throw new Error(`Stock insuficiente en lotes físicos de "${product.name}": faltan ${remaining} de ${cantidad}. No se registró nada.`);

  const usuario = state.session?.user?.email || "Operador";
  const dispositivo = detectDeviceLabel();
  const operationUid = uid("opscan");

  if (of.estado === "RESERVADA") {
    await persist("manufacturing_orders", { ...of, estado: "EN_PRODUCCION", fechaInicio: of.fechaInicio || nowISO() });
  }
  for (const a of alloc) {
    const previousQty = a.lot.quantity;
    const newQty = previousQty - a.qty;
    await persist("inventory_lots", { ...a.lot, quantity: newQty });
    const mov = await registerMovement({
      productId: product.id, lotId: a.lot.id, type: "consumo_of", quantity: a.qty, previousQty, newQty,
      reason: `Consumo OF ${of.numero}`, relatedDocument: of.numero,
    });
    await persist("production_consumptions", {
      id: uid("cons"), manufacturingOrderId: of.id, productId: product.id, lotId: a.lot.id, cantidad: a.qty, tipo: "consumo",
      usuario, dispositivo, operationUid: alloc.length > 1 ? `${operationUid}-${a.lot.id}` : operationUid, stockMovementId: mov.id,
    });
  }
  await persist("production_audit_log", {
    id: uid("aud"), manufacturingOrderId: of.id, productId: product.id, operacion: "consumo", usuario,
    infoAnterior: null, infoNueva: { cantidad, codigo: codigoEscaneado, lotes: alloc.map((a) => ({ lotId: a.lot.id, qty: a.qty })) }, notas: "",
  });
  return { product, cantidad };
}

/** Registra avance de producción (cajas realmente terminadas) — soporta
 * producción parcial: se puede ir marcando de a poco y retomar más tarde.
 * NO cierra ni completa la OF automáticamente (eso es una fase posterior,
 * con validación de faltantes) — sólo acumula cantidadProducida. */
async function registrarAvanceProduccion(ofId, cantidad) {
  const of = getById("manufacturing_orders", ofId);
  if (!of) throw new Error("OF no encontrada");
  if (!(cantidad > 0)) throw new Error("Cantidad inválida");
  const nuevaProducida = (of.cantidadProducida || 0) + cantidad;
  if (nuevaProducida > of.cantidadPlanificada + 0.0001) throw new Error(`Excede lo planificado (${of.cantidadPlanificada})`);
  const usuario = state.session?.user?.email || "Operador";
  await persist("manufacturing_orders", { ...of, cantidadProducida: nuevaProducida });
  await persist("production_audit_log", {
    id: uid("aud"), manufacturingOrderId: of.id, productId: null, operacion: "avance_produccion", usuario,
    infoAnterior: { cantidadProducida: of.cantidadProducida }, infoNueva: { cantidadProducida: nuevaProducida }, notas: "",
  });
  toast(`Avance registrado: ${nuevaProducida}/${of.cantidadPlanificada}`);
  renderApp();
}

/** Estado del asistente de reemplazo (REEMPLAZO), por OF — un objeto en
 * memoria (no se persiste) porque es un flujo transitorio de varios pasos
 * con doble escaneo obligatorio; sólo se escribe a la base una vez
 * confirmado (confirmarReemplazoOF). */
let ofReplacementState = {};
let ofReplacementErrors = {};

/** Confirma un reemplazo ya pasado por el doble escaneo: libera (nunca
 * borra) la reserva activa del producto original para esta OF, reserva el
 * sustituto por la misma cantidad, y deja un registro inmutable en
 * production_substitutions + production_audit_log con trazabilidad
 * completa (original, sustituto, cantidad, usuario, motivo, doble escaneo
 * confirmado). */
async function confirmarReemplazoOF(ofId) {
  const st = ofReplacementState[ofId];
  if (!st || st.step !== "confirm") throw new Error("Flujo de reemplazo incompleto");
  const of = getById("manufacturing_orders", ofId);
  if (!of) throw new Error("OF no encontrada");
  const originalProduct = getById("products", st.originalProductId);
  const substituteProduct = getById("products", st.substituteProductId);
  if (!originalProduct || !substituteProduct) throw new Error("Producto no encontrado");
  const usuario = state.session?.user?.email || "Operador";

  const reservasOriginal = state.production_reservations.filter(
    (r) => r.manufacturingOrderId === of.id && r.productId === st.originalProductId && r.estado === "RESERVADO"
  );
  let reservaOriginalId = null;
  for (const r of reservasOriginal) {
    await callRpc("fn_liberar_reserva_produccion", { p_reservation_id: r.id, p_usuario: usuario, p_motivo: `Reemplazo por ${substituteProduct.name}` });
    reservaOriginalId = r.id;
  }

  const resResult = await callRpc("fn_reservar_produccion", {
    p_manufacturing_order_id: of.id, p_product_id: st.substituteProductId, p_ean13: substituteProduct.ean13 || null,
    p_cantidad: st.cantidad, p_almacen_id: of.almacenOrigenId || null, p_usuario: usuario,
  });

  await persist("production_substitutions", {
    id: uid("sub"), manufacturingOrderId: of.id,
    productoOriginalId: st.originalProductId, eanOriginal: originalProduct.ean13 || null,
    productoSustitutoId: st.substituteProductId, eanSustituto: substituteProduct.ean13 || null,
    cantidad: st.cantidad, usuario, motivo: st.motivo || "", confirmadoDobleEscaneo: true,
    reservaOriginalId, reservaSustitutoId: (resResult && resResult.reservationId) || null,
  });
  await persist("production_audit_log", {
    id: uid("aud"), manufacturingOrderId: of.id, productId: st.substituteProductId, operacion: "reemplazo", usuario,
    infoAnterior: { productoOriginalId: st.originalProductId, nombre: originalProduct.name },
    infoNueva: { productoSustitutoId: st.substituteProductId, nombre: substituteProduct.name, cantidad: st.cantidad },
    notas: st.motivo || "",
  });

  const fresh = await loadAll();
  state.production_reservations = fresh.production_reservations;
  state.production_substitutions = fresh.production_substitutions;
  state.production_audit_log = fresh.production_audit_log;

  delete ofReplacementState[ofId];
  toast(`Reemplazo confirmado: ${originalProduct.name} → ${substituteProduct.name}`);
  renderApp();
}

/** Panel del asistente de reemplazo (3 pasos): 1) identificar el producto
 * original a reemplazar (debe ser un componente pendiente de esta OF y no
 * estar ya sustituido), 2) escanear el sustituto + motivo obligatorio
 * (primer escaneo), 3) volver a escanear el mismo sustituto para confirmar
 * (segundo escaneo obligatorio) — si no coincide exactamente con el primero,
 * error y vuelve al paso 2, nunca continúa con una discrepancia. */
function viewOfReplacementPanel(of) {
  const st = ofReplacementState[of.id];
  const err = ofReplacementErrors[of.id];
  const errHtml = err ? `<div class="hint" style="font-weight:700;color:var(--red,#c0392b);margin-bottom:8px">🔴 ${esc(err)}</div>` : "";
  if (!st) {
    return `<div class="panel" style="margin:10px 0;background:var(--surface-2,#f7f7f7)">
      <div class="panel-head"><h3>🔁 Reemplazo de componente</h3></div>
      ${errHtml}
      <div class="hint" style="margin-bottom:10px">Usá esto sólo si falta stock de un componente y necesitás sustituirlo por otro. Requiere confirmar el sustituto con doble escaneo.</div>
      <form data-form="of-reemplazo-original" data-id="${of.id}" class="form-grid" style="align-items:end">
        <label class="span2">Escaneá o escribí el código del producto ORIGINAL a reemplazar<input class="input" name="codigo" autocomplete="off" /></label>
        <div><button type="submit" class="btn btn-secondary">Identificar original</button></div>
      </form>
    </div>`;
  }
  if (st.step === "substitute") {
    return `<div class="panel" style="margin:10px 0;background:var(--surface-2,#f7f7f7)">
      <div class="panel-head"><h3>🔁 Reemplazo de componente</h3><button type="button" class="btn btn-ghost btn-sm" data-action="of-reemplazo-cancelar" data-id="${of.id}">Cancelar</button></div>
      ${errHtml}
      <div class="hint" style="margin-bottom:10px">Original: <b>${esc(st.originalName)}</b> · Cantidad a reemplazar: <b>${st.cantidad}</b></div>
      <form data-form="of-reemplazo-sustituto-1" data-id="${of.id}" class="form-grid" style="align-items:end">
        <label class="span2">Escaneá o escribí el código del producto SUSTITUTO<input class="input" name="codigo" autocomplete="off" /></label>
        <label class="span2">Motivo del reemplazo<input class="input" name="motivo" required /></label>
        <div><button type="submit" class="btn btn-secondary">Primer escaneo</button></div>
      </form>
    </div>`;
  }
  if (st.step === "confirm") {
    return `<div class="panel" style="margin:10px 0;background:var(--surface-2,#f7f7f7)">
      <div class="panel-head"><h3>🔁 Reemplazo de componente</h3><button type="button" class="btn btn-ghost btn-sm" data-action="of-reemplazo-cancelar" data-id="${of.id}">Cancelar</button></div>
      ${errHtml}
      <div class="hint" style="margin-bottom:10px">Original: <b>${esc(st.originalName)}</b> → Sustituto: <b>${esc(st.substituteName)}</b> · Cantidad: <b>${st.cantidad}</b></div>
      <div class="hint" style="margin-bottom:10px;font-weight:700">Escaneá de nuevo el mismo código del sustituto para confirmar (doble escaneo obligatorio).</div>
      <form data-form="of-reemplazo-sustituto-2" data-id="${of.id}" class="form-grid" style="align-items:end">
        <label class="span2">Segundo escaneo del SUSTITUTO<input class="input" name="codigo" autocomplete="off" /></label>
        <div><button type="submit" class="btn btn-primary">Confirmar reemplazo</button></div>
      </form>
    </div>`;
  }
  return "";
}

/** Evalúa si una OF puede cerrarse: sin componentes pendientes (ni el
 * original de algo reemplazado, que ya cuenta como cubierto, ni el
 * sustituto), con algún avance de producción registrado, y sin estar
 * bloqueada ni ya cerrada/cancelada. Devuelve las razones exactas cuando
 * no puede, para mostrarlas en el detalle de la OF — nunca un cierre
 * silencioso ni una razón genérica. */
function ofClosingCheck(of) {
  const rows = ofNeedsRows(of);
  const reasons = [];
  if (["COMPLETADA", "CANCELADA"].includes(of.estado)) {
    reasons.push("La OF ya está cerrada o cancelada");
    return { ready: false, reasons };
  }
  const pendientes = rows.filter((r) => r.pendiente > 0);
  if (pendientes.length) reasons.push(`Faltan componentes por consumir: ${pendientes.map((r) => r.nombre).join(", ")}`);
  if (!(of.cantidadProducida > 0)) reasons.push("Todavía no se registró ningún avance de producción");
  if (of.estado === "BLOQUEADA") reasons.push("La OF está bloqueada — desbloqueala primero");
  return { ready: reasons.length === 0, reasons };
}

/** Cierra formalmente una OF — sólo si ofClosingCheck() da luz verde;
 * nunca cierra "a la fuerza" ni con faltantes. */
async function cerrarOF(ofId) {
  const of = getById("manufacturing_orders", ofId);
  if (!of) throw new Error("OF no encontrada");
  const check = ofClosingCheck(of);
  if (!check.ready) throw new Error("La OF no puede cerrarse: " + check.reasons.join("; "));
  const usuario = state.session?.user?.email || "Operador";
  const estadoAnterior = of.estado;
  await persist("manufacturing_orders", { ...of, estado: "COMPLETADA", fechaCierre: nowISO() });
  await persist("production_audit_log", {
    id: uid("aud"), manufacturingOrderId: of.id, productId: null, operacion: "cierre", usuario,
    infoAnterior: { estado: estadoAnterior }, infoNueva: { estado: "COMPLETADA" }, notas: "",
  });
  toast(`OF ${of.numero} cerrada`);
  renderApp();
}

/** Panel de escaneo/consumo embebido en viewOfDetail — el <input> de texto
 * es el "escáner universal": cualquier lector USB/Bluetooth o colector
 * Android que emule teclado escribe el código ahí mismo y termina con
 * Enter, lo que envía el <form> de forma nativa (ver el listener global de
 * submit, ya existente, no se toca). La cámara es un agregado opcional
 * sólo si el navegador la soporta. */
function viewOfScanPanel(of) {
  const msg = ofScanMessages[of.id];
  const camSupported = cameraScanSupported();
  return `
    ${msg ? `<div class="hint" style="font-weight:700;color:${msg.type === "err" ? "var(--red, #c0392b)" : "var(--green, #2e7d32)"};margin-bottom:8px">${msg.type === "err" ? "🔴" : "🟢"} ${esc(msg.text)}</div>` : ""}
    <form data-form="of-consumo" data-id="${of.id}" class="form-grid" style="align-items:end;margin-bottom:14px">
      <label class="span2">Escanear o escribir código (EAN-13 / SKU)<input class="input" id="of-scan-input" name="codigo" autocomplete="off" autofocus /></label>
      <label>Cantidad<input class="input" type="number" name="cantidad" min="0.01" step="any" value="1" /></label>
      <div style="display:flex;gap:8px">
        <button type="submit" class="btn btn-primary">Registrar consumo</button>
        ${camSupported ? `<button type="button" class="btn btn-secondary" data-action="of-scan-camera" data-id="${of.id}">📷 Cámara</button>` : ""}
      </div>
    </form>`;
}

/* ---------------------------------------------------------------------------
   26. INICIO
   ------------------------------------------------------------------------- */
async function boot() {
  state.route = parseHash();
  renderApp();

  const session = await getSession();
  state.auth = !!session;
  state.session = session;
  if (session) { initStore(); } else { renderApp(); }

  onAuthStateChange((newSession) => {
    const wasAuth = state.auth;
    state.auth = !!newSession;
    state.session = newSession;
    loginBusy = false;
    if (state.auth && !wasAuth) { initStore(); }
    if (!state.auth && wasAuth) { teardownStore(); }
    renderApp();
  });
}
document.addEventListener("DOMContentLoaded", boot);


