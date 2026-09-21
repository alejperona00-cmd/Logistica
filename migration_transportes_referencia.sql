-- ============================================================================
-- LOGÍSTICA PERONA — columnas de referencia rápida para transportes
-- Migración ADITIVA: sólo agrega columnas nuevas a `transports`. No toca datos
-- existentes, no renombra ni borra nada. Se puede volver a ejecutar sin
-- problema (todo usa IF NOT EXISTS).
-- Pegar y ejecutar completo en: Supabase → SQL Editor → New query → Run
-- ============================================================================

-- origin_coverage: cobertura de la zona de origen/retiro (ej. "CABA / GBA").
--   No reemplaza a province/city (la ciudad puntual) — es una descripción más
--   amplia, tal como viene en la planilla de referencia.
alter table transports add column if not exists origin_coverage text;

-- route_numbers: rutas/autovías nacionales o provinciales que recorre
--   (ej. "Ruta 9 / Ruta 7 / Ruta 3 / Ruta 14"). No existía ningún campo para
--   esto — `routes` guarda pares origen-destino geográficos, no números de ruta.
alter table transports add column if not exists route_numbers text;

-- delivery_time: tiempo de entrega de referencia (ej. "24 a 96 hs").
alter table transports add column if not exists delivery_time text;

-- cost_reference: costo aproximado de referencia (ej. "$6.500 - $45.000").
--   Es sólo texto informativo — la tarifa estructurada y calculable sigue
--   siendo `transport_rates`, que no se toca.
alter table transports add column if not exists cost_reference text;
