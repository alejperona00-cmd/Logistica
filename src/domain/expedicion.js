/* ============================================================================
   Dominio — Expedición (funciones puras, sin HTML ni acceso directo a
   Supabase/`state`). Primera porción movida fuera de app.js como parte de la
   Fase A de preparación para ACQUA: nada de lo que hay acá lee variables
   globales, así que se puede mover, testear y reutilizar sin arrastrar el
   resto de la app. El resto de las funciones de Expedición (las que sí
   necesitan `state`, como `dispatchDetail` o `transportHistoryStats`) quedan
   por ahora en app.js — moverlas es la continuación natural de esta fase,
   pero requiere decidir cómo le pasan sus datos (parámetro explícito vs.
   import circular), y eso conviene encararlo aparte para no arriesgar nada
   de golpe en una herramienta que ya está en uso real.
   ========================================================================== */

/** Formatea un monto en pesos argentinos, o "—" si no hay valor. */
export function fmtMoney(v) {
  return v != null && !isNaN(v) ? "$" + Math.round(v).toLocaleString("es-AR") : "—";
}

/** Etapa de Expedición derivada del estado del pedido (orders.status, sin
    tocarlo) y de si ya tiene una selección de transporte vigente. Pura:
    no consulta nada — recibe todo lo que necesita como parámetro. */
export function expedicionStageFromStatus(status, hasSelection) {
  if (status === "incidencia") return "incidencia";
  if (status === "cancelado") return "cancelado";
  if (status === "pendiente" || status === "preparacion") return "preparando";
  if (status === "preparado" || status === "controlado") return hasSelection ? "listo" : "pendiente_transporte";
  if (status === "despachado") return "despachado";
  if (status === "en_camino") return "en_transito";
  if (status === "entregado") return "entregado";
  return "preparando";
}

/** Distancia entre dos puntos (haversine, km). */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Costo estimado de una alternativa de transporte, según su tarifa
    (`rate`), los datos físicos del despacho (`dd`) y la distancia (`km`).
    Nunca inventa un número: si falta un dato para un componente de la
    tarifa, ese componente queda marcado como "missing" en vez de asumirse
    en 0 silenciosamente donde correspondería un dato real. */
export function transportRateCost(rate, dd, km) {
  if (!rate) return { total: null, breakdown: [], missingRate: true };
  const breakdown = [];
  let total = 0;
  if (rate.fixedAmount) { total += rate.fixedAmount; breakdown.push({ label: "Fijo", value: rate.fixedAmount }); }
  if (rate.perKm) { if (km == null) breakdown.push({ label: "Por km", missing: "sin distancia (configurá el depósito de origen)" }); else { const v = rate.perKm * km; total += v; breakdown.push({ label: `Por km (${km.toFixed(1)} km)`, value: v }); } }
  if (rate.perBox) { if (!dd?.boxesCount) breakdown.push({ label: "Por caja", missing: "sin cantidad de cajas cargada" }); else { const v = rate.perBox * dd.boxesCount; total += v; breakdown.push({ label: `Por caja (${dd.boxesCount})`, value: v }); } }
  if (rate.perKg) { if (!dd?.weightKg) breakdown.push({ label: "Por kg", missing: "sin peso cargado" }); else { const v = rate.perKg * dd.weightKg; total += v; breakdown.push({ label: `Por kg (${dd.weightKg} kg)`, value: v }); } }
  if (rate.percent) { if (!dd?.orderValue) breakdown.push({ label: "% del valor del pedido", missing: "sin valor del pedido cargado" }); else { const v = (rate.percent * dd.orderValue) / 100; total += v; breakdown.push({ label: `${rate.percent}% del valor del pedido`, value: v }); } }
  if (!breakdown.length) return { total: null, breakdown: [], missingRate: true };
  return { total, breakdown, missingRate: false };
}

/** Puntúa cada alternativa según los criterios configurados, renormalizando
    los pesos entre los criterios que esa alternativa realmente tiene datos
    (nunca se completa un criterio faltante con un supuesto). No elige por
    el usuario: sólo ordena y muestra el razonamiento completo. */
export function expedicionPuntuar(alternativas, weights) {
  const costos = alternativas.map((a) => a.costo).filter((v) => v != null);
  const tiempos = alternativas.map((a) => a.tiempoHoras).filter((v) => v != null);
  const minCosto = costos.length ? Math.min(...costos) : null, maxCosto = costos.length ? Math.max(...costos) : null;
  const minTiempo = tiempos.length ? Math.min(...tiempos) : null, maxTiempo = tiempos.length ? Math.max(...tiempos) : null;
  return alternativas.map((a) => {
    const parts = [];
    if (a.costo != null) parts.push({ w: weights.costo, score: maxCosto === minCosto ? 100 : ((maxCosto - a.costo) / (maxCosto - minCosto)) * 100 });
    if (a.tiempoHoras != null) parts.push({ w: weights.tiempo, score: maxTiempo === minTiempo ? 100 : ((maxTiempo - a.tiempoHoras) / (maxTiempo - minTiempo)) * 100 });
    if (a.cumplimientoPct != null) parts.push({ w: weights.cumplimiento, score: a.cumplimientoPct });
    const totalW = parts.reduce((s, p) => s + p.w, 0);
    const score = totalW > 0 ? parts.reduce((s, p) => s + (p.w / totalW) * p.score, 0) : null;
    return { ...a, score, basis: parts.length };
  }).sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
}

/** Checklist de despacho: todo lo que evalúa viene en los parámetros
    (pedido, datos de despacho, selección de transporte) — no consulta nada
    por su cuenta, así que se puede probar con datos de ejemplo sin Supabase. */
export function expedicionChecklist(o, dd, sel) {
  return [
    { label: "Pedido completo (productos cargados)", ok: Array.isArray(o?.items) && o.items.length > 0 },
    { label: "Transporte asignado", ok: !!sel },
    { label: "Dirección de entrega confirmada", ok: !!o?.address },
    { label: "Cajas confirmadas", ok: !!(dd && dd.boxesCount > 0) },
  ];
}
