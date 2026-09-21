-- ============================================================================
-- LOGÍSTICA PERONA — zonas tarifarias configurables (nivel Táctico del Centro
-- Geoespacial). Migración ADITIVA: sólo crea una tabla nueva. No toca ninguna
-- tabla ni dato existente. Se puede volver a ejecutar sin problema (todo usa
-- IF NOT EXISTS).
-- Pegar y ejecutar completo en: Supabase → SQL Editor → New query → Run
-- ============================================================================

-- Cada zona agrupa una o más provincias reales (las mismas strings que ya se
-- usan en locations/transports.province — no un polígono geográfico: la app
-- no tiene los límites reales de cada provincia argentina, así que no se
-- inventan) y tiene su propia tarifa de referencia, con la misma fórmula que
-- ya usa transport_rates (fijo + por_km×km + por_caja×cajas + por_kg×kg +
-- porcentaje×valor/100) para no crear un segundo modelo de costo distinto.
-- Es un concepto totalmente nuevo e independiente: no modifica ni reemplaza
-- transport_rates (tarifa por transportista) ni transports.zone (cobertura
-- de destino en texto libre).
create table if not exists logistics_zones (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text,
  provinces text[] not null default '{}',
  fixed_amount double precision not null default 0,
  per_km double precision not null default 0,
  per_box double precision not null default 0,
  per_kg double precision not null default 0,
  percent double precision not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Seguridad: mismo criterio que el resto de la app (cualquier usuario
-- logueado puede leer y escribir todo).
alter table logistics_zones enable row level security;
drop policy if exists "authenticated_all" on logistics_zones;
create policy "authenticated_all" on logistics_zones for all to authenticated using (true) with check (true);

-- Realtime (opcional, mismo patrón ya usado en schema.sql — el chequeo
-- "if not exists" evita el error "already member of publication" si se
-- vuelve a correr esta migración).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'logistics_zones'
  ) then
    execute 'alter publication supabase_realtime add table logistics_zones';
  end if;
end $$;
