/* ============================================================================
   Capa de datos — Supabase (reemplaza la capability "db" del artifact)
   Convierte entre camelCase (usado en toda la app) y snake_case (columnas
   de Postgres) de forma genérica, y expone las mismas operaciones que
   usaba app.js: cargar todo, guardar un registro, borrar un registro.
   ========================================================================== */
import { supabase } from "./supabaseClient.js";

export const COLLECTIONS = ["locations", "customers", "suppliers", "transports", "routes", "inv_suppliers", "products", "inventory_lots", "stock_movements", "lot_locations", "app_settings", "box_configs", "box_config_items", "production_orders", "orders", "purchase_orders", "incidents", "tasks", "dispatch_details", "transport_rates", "transport_selections", "client_notifications", "logistics_zones", "integration_sync_logs", "integration_errors"];

const camelToSnake = (k) => k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
const snakeToCamel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

export function toDbRow(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k === "id" ? "id" : camelToSnake(k)] = v;
  return out;
}
export function fromDbRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k === "id" ? "id" : snakeToCamel(k)] = v;
  return out;
}

/**
 * Trae TODAS las filas de una tabla, paginando con .range() para evitar el
 * límite por defecto de PostgREST/Supabase (1000 filas por request). Acumula
 * páginas de PAGE_SIZE filas hasta que una página vuelve incompleta.
 */
const PAGE_SIZE = 1000;
async function fetchAllRows(col) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(col)
      .select("*")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

/** Carga todas las colecciones. Devuelve { locations: [...], orders: [...], ... } */
export async function loadAll() {
  const result = {};
  await Promise.all(
    COLLECTIONS.map(async (col) => {
      try {
        const data = await fetchAllRows(col);
        result[col] = data.map(fromDbRow);
      } catch (error) {
        console.error(`[db] error cargando ${col}:`, error.message);
        result[col] = [];
      }
    })
  );
  return result;
}

/** Crea o actualiza (upsert) un registro. `rec` debe tener `id`. */
export async function saveRecord(col, rec) {
  const row = toDbRow(rec);
  const { data, error } = await supabase.from(col).upsert(row).select().single();
  if (error) throw error;
  return fromDbRow(data);
}

/** Borra un registro por id. */
export async function deleteRecord(col, id) {
  const { error } = await supabase.from(col).delete().eq("id", id);
  if (error) throw error;
}

/** Se suscribe a cambios en tiempo real de una colección (otra pestaña, etc). */
export function subscribeCollection(col, onChange) {
  const channel = supabase
    .channel(`realtime:${col}`)
    .on("postgres_changes", { event: "*", schema: "public", table: col }, () => onChange())
    .subscribe();
  return () => supabase.removeChannel(channel);
}
