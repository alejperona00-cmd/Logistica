-- ============================================================================
-- LOGÍSTICA PERONA — Integración ACQUA (Fase 1: intercambio por archivos)
-- Migración ADITIVA: sólo agrega columnas nuevas a manufacturing_orders y
-- dos tablas nuevas (acqua_export_batches / acqua_export_items). No toca
-- ninguna tabla, columna ni dato existente. No hay ningún DROP/TRUNCATE/
-- DELETE. Se puede volver a ejecutar sin problema (todo usa IF NOT EXISTS).
-- Pegar y ejecutar completo en: Supabase → SQL Editor → New query → Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) manufacturing_orders: datos de PROCEDENCIA (si la OF fue importada
--    desde ACQUA) + estado de sincronización de VUELTA a ACQUA. Los dos
--    conceptos son independientes del `estado` interno (BORRADOR..
--    COMPLETADA, que no se toca) — una OF puede estar COMPLETADA en
--    Logística Perona y seguir PENDIENTE de informar a ACQUA.
-- ---------------------------------------------------------------------------

-- Procedencia (import). external_system/external_of_id son NULL para toda
-- OF creada a mano en Logística Perona (mayoría de las existentes) — el
-- índice único de abajo sólo aplica cuando external_of_id no es NULL, así
-- que ninguna OF actual choca con nada.
alter table manufacturing_orders add column if not exists external_system text;
alter table manufacturing_orders add column if not exists external_of_id text;
alter table manufacturing_orders add column if not exists source_file text;
alter table manufacturing_orders add column if not exists imported_at timestamptz;
alter table manufacturing_orders add column if not exists import_version integer not null default 1;
alter table manufacturing_orders add column if not exists acqua_estado_origen text;
alter table manufacturing_orders add column if not exists acqua_producto_codigo text;
alter table manufacturing_orders add column if not exists acqua_producto_ean13 text;
-- Insumos que ACQUA pueda haber mandado detallados en el archivo — sólo
-- informativo/auditoría. NUNCA se usa para calcular consumo real: la LDP
-- interna (box_configs/box_config_items → ldp_versions) sigue siendo la
-- única fuente real de qué consume la caja, para no romper la trazabilidad
-- ni la reserva de stock ya implementadas.
alter table manufacturing_orders add column if not exists acqua_items_raw jsonb;

create unique index if not exists manufacturing_orders_external_key
  on manufacturing_orders (external_system, external_of_id)
  where external_of_id is not null;

-- Sincronización de VUELTA a ACQUA (independiente de `estado`). NULL hasta
-- que la OF se cierra por primera vez; a partir de ahí sigue
-- PENDIENTE → EXPORTADA (→ PROCESADA/ERROR/REQUIERE_REVISION cuando ACQUA lo
-- confirme, todavía manual en Fase 1 — no hay feedback automático de ACQUA).
alter table manufacturing_orders add column if not exists acqua_sync_status text;
alter table manufacturing_orders add column if not exists exported_at timestamptz;
alter table manufacturing_orders add column if not exists export_batch_id text;

-- ---------------------------------------------------------------------------
-- 2) ACQUA_EXPORT_BATCHES: una fila por archivo de retorno generado hacia
--    ACQUA ("Generar archivo para ACQUA"). Nunca se pisa ni se borra.
-- ---------------------------------------------------------------------------
create table if not exists acqua_export_batches (
  id uuid primary key default gen_random_uuid(),
  export_batch_id text not null unique, -- ej. "ACQUA-20260927-0001"
  generated_at timestamptz not null default now(),
  generated_by text,
  file_name text,
  format text not null default 'xlsx', -- xlsx | csv (los únicos implementados en Fase 1)
  of_count integer not null default 0,
  movement_count integer not null default 0,
  status text not null default 'GENERADO', -- GENERADO | ERROR
  notes text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3) ACQUA_EXPORT_ITEMS: el "renglón" de cada movimiento ya exportado —
--    ES el mecanismo anti-duplicación (punto 10 del pedido). La clave real
--    es (source_table, source_record_id): el id de la fila real de
--    production_consumptions/production_substitutions/manufacturing_orders
--    (cierre) que generó este renglón. El índice único de abajo hace
--    IMPOSIBLE exportar dos veces el mismo movimiento real, sin importar en
--    qué lote — para siempre, no sólo "dentro del mismo archivo".
-- ---------------------------------------------------------------------------
create table if not exists acqua_export_items (
  id uuid primary key default gen_random_uuid(),
  export_batch_id uuid references acqua_export_batches(id) on delete cascade,
  manufacturing_order_id uuid references manufacturing_orders(id) on delete set null,
  movement_type text not null, -- consumo | sustitucion | cierre
  source_table text not null,  -- production_consumptions | production_substitutions | manufacturing_orders
  source_record_id uuid not null,
  product_id uuid references products(id) on delete set null,
  ean13 text,
  cantidad_planificada double precision,
  cantidad_real double precision,
  producto_original_id uuid references products(id) on delete set null,
  producto_sustituto_id uuid references products(id) on delete set null,
  cantidad_sustituida double precision,
  unique_movement_id text not null, -- id legible que va en el archivo (ID_MOVIMIENTO)
  fecha timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists acqua_export_items_source_key
  on acqua_export_items (source_table, source_record_id);

-- ---------------------------------------------------------------------------
-- 4) Seguridad y tiempo real para las tablas nuevas (mismo esquema que ya
--    usa el resto de la base — no modifica policies de ninguna tabla
--    existente ni cambia el acceso a manufacturing_orders).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array['acqua_export_batches','acqua_export_items'])
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
  for t in select unnest(array['acqua_export_batches','acqua_export_items'])
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I;', t);
    end if;
  end loop;
end $$;
