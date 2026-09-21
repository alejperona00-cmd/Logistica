/* ============================================================================
   Dominio: geoespacial — funciones puras para el Centro Geoespacial del mapa
   (nivel Operativo del módulo Mapa). No leen `state` global ni tocan el DOM
   ni Supabase: reciben los datos ya cargados desde app.js y devuelven
   números/arrays listos para mostrar.

   Regla dura de este archivo: nunca inventar un dato geográfico ni operativo.
   Si algo no se puede calcular con datos reales, la función devuelve `null`
   (o un array vacío) y quien la llama debe mostrar "Sin datos" — nunca un
   valor estimado o de ejemplo. En particular: la app no modela vehículos
   individuales (sólo tipos de vehículo por transportista), así que cualquier
   conteo de "vehículos" reales queda explícitamente en null hasta que exista
   esa tabla.
   ========================================================================== */

/** Punto geográfico real de un pedido, a partir de su ubicación asociada.
 * Nunca inventa coordenadas: si la ubicación no existe o no tiene lat/lng,
 * devuelve null (el pedido se cuenta como "sin geolocalización" en vez de
 * ubicarlo de forma aproximada). */
export function orderGeoPoint(order, locationsById) {
  const loc = order.locationId ? locationsById.get(order.locationId) : null;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;
  return { lat: loc.lat, lng: loc.lng, precision: "exact" };
}

/** Punto base de un transportista: el origen de la primera ruta suya que
 * tenga coordenadas reales. No es su posición en tiempo real — es dónde
 * tiene base según lo que ya cargamos en `routes`. Si no tiene ninguna ruta
 * geolocalizada, devuelve null (nunca se inventa una ciudad de base). */
export function transportBasePoint(transportId, routes) {
  const r = routes.find((r) => r.transportId === transportId && typeof r.originLat === "number" && typeof r.originLng === "number");
  if (!r) return null;
  return { lat: r.originLat, lng: r.originLng, city: r.originCity, province: r.originProvince };
}

/** KPIs operativos reales del Centro Geoespacial. Todo se calcula sobre
 * pedidos/detalles de despacho/selecciones de transporte/incidencias que ya
 * existen — nada estimado. `todayISO` se recibe como parámetro (no se
 * calcula acá) para que la función siga siendo pura y testeable. */
export function computeOperationalKpis({ orders, dispatchDetails, transportSelections, incidents }, todayISO) {
  const activos = orders.filter((o) => !["entregado", "cancelado"].includes(o.status));
  const enRuta = orders.filter((o) => ["despachado", "en_camino"].includes(o.status));
  const entregasHoy = orders.filter((o) => o.status === "entregado" && o.actualDeliveryDate === todayISO);
  const dispatchByOrder = new Map(dispatchDetails.map((d) => [d.orderId, d]));
  const bultosEnTransito = enRuta.reduce((sum, o) => sum + (dispatchByOrder.get(o.id)?.boxesCount || 0), 0);
  const transportistasActivos = new Set(enRuta.map((o) => o.transportId).filter(Boolean)).size;
  // transportSelections ya viene ordenado por selectedAt desc (una vez por pedido, la última vigente).
  const selByOrder = new Map();
  transportSelections.forEach((s) => { if (!selByOrder.has(s.orderId)) selByOrder.set(s.orderId, s); });
  const costoLogistico = enRuta.reduce((sum, o) => sum + (selByOrder.get(o.id)?.estimatedCost || 0), 0);
  const incidenciasAbiertas = incidents.filter((i) => !["resuelta", "cerrada"].includes(i.status)).length;
  return {
    pedidosActivos: activos.length,
    pedidosEnRuta: enRuta.length,
    transportistasActivos,
    entregasHoy: entregasHoy.length,
    bultosEnTransito,
    costoLogistico,
    incidencias: incidenciasAbiertas,
  };
}

/** Resumen real de un nodo (una ubicación) para el popup del mapa.
 * "Vehículos disponibles/en ruta" queda en null a propósito: no existe una
 * tabla de vehículos individuales todavía — sería inventar el dato. */
export function nodeSummary(locationId, { orders, transportSelections }) {
  const pedidos = orders.filter((o) => o.locationId === locationId);
  const pendientes = pedidos.filter((o) => !["entregado", "cancelado", "en_camino", "despachado"].includes(o.status)).length;
  const enTransito = pedidos.filter((o) => ["despachado", "en_camino"].includes(o.status)).length;
  const entregados = pedidos.filter((o) => o.status === "entregado").length;
  const selByOrder = new Map();
  transportSelections.forEach((s) => { if (!selByOrder.has(s.orderId)) selByOrder.set(s.orderId, s); });
  const costoAcumulado = pedidos.reduce((sum, o) => sum + (selByOrder.get(o.id)?.estimatedCost || 0), 0);
  return {
    pedidos: pedidos.length, pendientes, enTransito, entregados, costoAcumulado,
    vehiculosDisponibles: null, vehiculosEnRuta: null,
  };
}

/** Punto geográfico real de una incidencia, resuelto a través de la entidad
 * con la que está relacionada (`relatedType`/`relatedId`). Nunca inventa una
 * ubicación: si el tipo de relación no tiene un `locationId` real (o esa
 * ubicación no tiene lat/lng cargado), devuelve null y la incidencia se
 * cuenta como "sin geolocalización" en vez de ubicarla de forma aproximada.
 *   - "order"          → locationId del pedido.
 *   - "purchase_order"  → locationId de la orden de compra (dirección del proveedor).
 *   - "supplier"        → locationId del proveedor.
 *   - "transport"       → base real del transportista (primera ruta con coordenadas).
 * Cualquier otro `relatedType`, o una relación rota (id inexistente), también
 * devuelve null. */
export function incidentGeoPoint(incident, { orders, purchaseOrders, suppliers, routes, locationsById }) {
  const byLocationId = (locId) => {
    if (!locId) return null;
    const loc = locationsById.get(locId);
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;
    return { lat: loc.lat, lng: loc.lng, precision: "exact" };
  };
  switch (incident.relatedType) {
    case "order": {
      const o = (orders || []).find((x) => x.id === incident.relatedId);
      return o ? byLocationId(o.locationId) : null;
    }
    case "purchase_order": {
      const po = (purchaseOrders || []).find((x) => x.id === incident.relatedId);
      return po ? byLocationId(po.locationId) : null;
    }
    case "supplier": {
      const s = (suppliers || []).find((x) => x.id === incident.relatedId);
      return s ? byLocationId(s.locationId) : null;
    }
    case "transport": {
      const p = transportBasePoint(incident.relatedId, routes || []);
      return p ? { lat: p.lat, lng: p.lng, precision: "aproximada" } : null;
    }
    default:
      return null;
  }
}

/** Agrupa puntos cercanos en "celdas" según el zoom actual — un clustering
 * simple por grilla, sin depender de ninguna librería externa. La celda se
 * achica a medida que se hace zoom, así los puntos se van separando (tal
 * como pediste: mostrar "+N" y separarlos al acercar). */
export function clusterPoints(points, zoom) {
  if (!points.length) return [];
  const cellDeg = 14 / Math.pow(1.85, Math.max(zoom - 3, 0));
  const buckets = new Map();
  points.forEach((p) => {
    const key = `${Math.round(p.lat / cellDeg)}:${Math.round(p.lng / cellDeg)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  });
  return Array.from(buckets.values()).map((group) => ({
    lat: group.reduce((s, p) => s + p.lat, 0) / group.length,
    lng: group.reduce((s, p) => s + p.lng, 0) / group.length,
    count: group.length,
    items: group,
  }));
}

/** Valores únicos no vacíos de un campo, para poblar selects de filtros
 * dinámicos a partir de los datos reales (nunca una lista fija hardcodeada). */
export function distinctValues(list, field) {
  return Array.from(new Set(list.map((x) => x[field]).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

/* ============================================================================
   Nivel TÁCTICO — zonas tarifarias por provincia.
   La app no tiene (ni va a inventar) los polígonos reales de los límites de
   cada provincia argentina, así que una zona no se dibuja como un área — se
   ubica en el mapa mediante la coordenada real de la capital de cada
   provincia que la integra (dato geográfico público y estable, no operativo:
   no es un pedido/costo/tiempo inventado, es simplemente dónde queda esa
   provincia). Si una provincia cargada no matchea ninguna capital conocida,
   se informa en vez de omitirse en silencio.
   ========================================================================== */
function normalizeProvinceKey(s) {
  return (s || "").toString().trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const PROVINCE_CAPITALS = {
  "caba": { city: "CABA", lat: -34.6037, lng: -58.3816 },
  "ciudad autonoma de buenos aires": { city: "CABA", lat: -34.6037, lng: -58.3816 },
  "capital federal": { city: "CABA", lat: -34.6037, lng: -58.3816 },
  "buenos aires": { city: "La Plata", lat: -34.9215, lng: -57.9545 },
  "catamarca": { city: "San Fernando del Valle de Catamarca", lat: -28.4696, lng: -65.7852 },
  "chaco": { city: "Resistencia", lat: -27.4514, lng: -58.9867 },
  "chubut": { city: "Rawson", lat: -43.3002, lng: -65.1023 },
  "cordoba": { city: "Córdoba", lat: -31.4201, lng: -64.1888 },
  "corrientes": { city: "Corrientes", lat: -27.4806, lng: -58.8341 },
  "entre rios": { city: "Paraná", lat: -31.7333, lng: -60.5238 },
  "formosa": { city: "Formosa", lat: -26.1775, lng: -58.1781 },
  "jujuy": { city: "San Salvador de Jujuy", lat: -24.1858, lng: -65.2995 },
  "la pampa": { city: "Santa Rosa", lat: -36.6167, lng: -64.2833 },
  "la rioja": { city: "La Rioja", lat: -29.4131, lng: -66.8558 },
  "mendoza": { city: "Mendoza", lat: -32.8908, lng: -68.8272 },
  "misiones": { city: "Posadas", lat: -27.3671, lng: -55.8961 },
  "neuquen": { city: "Neuquén", lat: -38.9516, lng: -68.0591 },
  "rio negro": { city: "Viedma", lat: -40.8135, lng: -62.9967 },
  "salta": { city: "Salta", lat: -24.7859, lng: -65.4117 },
  "san juan": { city: "San Juan", lat: -31.5375, lng: -68.5364 },
  "san luis": { city: "San Luis", lat: -33.295, lng: -66.3356 },
  "santa cruz": { city: "Río Gallegos", lat: -51.623, lng: -69.2168 },
  "santa fe": { city: "Santa Fe", lat: -31.6107, lng: -60.6973 },
  "santiago del estero": { city: "Santiago del Estero", lat: -27.7951, lng: -64.2615 },
  "tierra del fuego": { city: "Ushuaia", lat: -54.8019, lng: -68.303 },
  "tucuman": { city: "San Miguel de Tucumán", lat: -26.8083, lng: -65.2176 },
};

/** Coordenada real de la capital de una provincia argentina, o null si el
 * texto cargado no matchea ninguna (nunca se inventa una coordenada). */
export function provinceCapital(provinceName) {
  return PROVINCE_CAPITALS[normalizeProvinceKey(provinceName)] || null;
}

/** Un marcador real por cada (zona, provincia) ya asignada, listo para el
 * mapa de cobertura. Las provincias sin coordenada conocida se devuelven
 * aparte en `unresolved`, nunca se pierden en silencio. */
export function zoneCoverageMarkers(zones) {
  const markers = [], unresolved = [];
  (zones || []).forEach((z) => {
    (z.provinces || []).forEach((p) => {
      const cap = provinceCapital(p);
      if (!cap) { unresolved.push({ zoneId: z.id, zoneName: z.name, province: p }); return; }
      markers.push({ zoneId: z.id, zoneName: z.name, province: p, color: z.color, lat: cap.lat, lng: cap.lng, city: cap.city });
    });
  });
  return { markers, unresolved };
}
