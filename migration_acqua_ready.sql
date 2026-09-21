-- ============================================================================
-- LOGÍSTICA PERONA — Fase B: preparación para integraciones externas (ACQUA)
-- Migración ADITIVA: sólo agrega columnas y tablas nuevas, todas sin usar
-- todavía por la interfaz. NO toca `orders.status` (que sigue siendo el
-- estado logístico de siempre), NO borra ni renombra nada, NO conecta con
-- ACQUA — sólo deja la base preparada para el día que haya un adapter real.
-- Se puede volver a ejecutar sin problema (todo usa IF NOT EXISTS).
-- Pegar y ejecutar completo en: Supabase → SQL Editor → New query → Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) ORDERS: origen del dato + identificador externo + estado comercial.
--    - source: de dónde vino el pedido. 'manual' para todo lo que ya existe
--      y todo lo que se siga cargando a mano — no requiere backfill porque
--      el default cubre las filas existentes automáticamente.
--    - external_id: el ID que le puso el sistema de origen (ej. ACQUA). Nulo
--      para todo lo actual.
--    - commercial_status: estado comercial (pending/confirmed/invoiced/
--      cancelled, futuro), separado del estado LOGÍSTICO que ya tenemos en
--      `status` (que no se toca ni se renombra). Queda null/sin usar hasta
--      que exista una fuente comercial real.
-- ---------------------------------------------------------------------------
alter table orders add column if not exists source text not null default 'manual';
alter table orders add column if not exists external_id text;
alter table orders add column if not exists commercial_status text;

-- Evita duplicados de una misma fuente externa (ej. dos veces "ACQUA-45821")
-- sin afectar en nada a los pedidos manuales, que no tienen external_id.
create unique index if not exists orders_source_external_id_key
  on orders (source, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------------
-- 2) CUSTOMERS: mismo criterio de origen + identificador externo.
-- ---------------------------------------------------------------------------
alter table customers add column if not exists source text not null default 'manual';
alter table customers add column if not exists external_id text;

create unique index if not exists customers_source_external_id_key
  on customers (source, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------------
-- 3) INTEGRATION_SYNC_LOGS: una fila por corrida de sincronización (manual,
--    CSV o, en el futuro, API de ACQUA). Nunca se pisa ni se borra.
-- ---------------------------------------------------------------------------
create table if not exists integration_sync_logs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running', -- running | ok | error
  records_received integer not null default 0,
  records_created integer not null default 0,
  records_updated integer not null default 0,
  records_unchanged integer not null default 0,
  records_failed integer not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4) INTEGRATION_ERRORS: un registro que no se pudo importar — nunca se
--    oculta un error. Pensada para poder reprocesar sin borrar nada:
--    "reprocessed_at" se completa cuando se reintenta con éxito.
-- ---------------------------------------------------------------------------
create table if not exists integration_errors (
  id uuid primary key default gen_random_uuid(),
  sync_log_id uuid references integration_sync_logs(id) on delete cascade,
  source text not null,
  entity text not null, -- ej: 'order' | 'customer'
  external_id text,
  field text,
  message text not null,
  attempts integer not null default 1,
  status text not null default 'error', -- error | reprocessed
  reprocessed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5) Seguridad y tiempo real para las tablas nuevas (mismo esquema que ya
--    usa el resto de la base). Esto NO modifica las policies de ninguna
--    tabla existente ni cambia el acceso a `orders`/`customers`.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array['integration_sync_logs','integration_errors'])
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists "authenticated_all" on %I;', t);
    execute format(
      'create policy "authenticated_all" on %I for all to authenticated using (true) with check (true);',
      t
    );
  end loop;
end $$;

do $$
declare
  t text;
begin
  for t in select unnest(array['integration_sync_logs','integration_errors'])
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I;', t);
    end if;
  end loop;
end $$;
