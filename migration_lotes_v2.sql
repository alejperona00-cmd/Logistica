-- ============================================================================
-- LOGÍSTICA PERONA — Ampliación: gestión avanzada de lotes y vencimientos
-- Migración ADITIVA: solo agrega columnas y tablas nuevas.
-- NO borra, reemplaza ni reinicializa nada existente.
-- Pegar y ejecutar completo en: Supabase → SQL Editor → New query → Run
-- Se puede volver a ejecutar sin problema (todo usa IF NOT EXISTS).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) PRODUCTS: nuevos campos (SKU, categoría, flags, alerta configurable)
-- ---------------------------------------------------------------------------
alter table products add column if not exists sku text;
alter table products add column if not exists categoria text;
alter table products add column if not exists maneja_lote boolean not null default true;
alter table products add column if not exists maneja_vencimiento boolean not null default true;
alter table products add column if not exists dias_alerta integer;

-- ---------------------------------------------------------------------------
-- 2) INVENTORY_LOTS: nuevos campos de trazabilidad, recepción, ubicación,
--    bloqueo, costo. La columna "quantity" existente sigue siendo la cantidad
--    disponible actual (no se toca ni se renombra).
-- ---------------------------------------------------------------------------
alter table inventory_lots add column if not exists numero_lote text;
alter table inventory_lots add column if not exists fecha_elaboracion date;
alter table inventory_lots add column if not exists cantidad_inicial double precision;
alter table inventory_lots add column if not exists cantidad_comprometida double precision not null default 0;
alter table inventory_lots add column if not exists deposito text;
alter table inventory_lots add column if not exists bloqueado boolean not null default false;
alter table inventory_lots add column if not exists motivo_bloqueo text;
alter table inventory_lots add column if not exists remito text;
alter table inventory_lots add column if not exists orden_compra text;
alter table inventory_lots add column if not exists fecha_recepcion date;
alter table inventory_lots add column if not exists costo_unitario double precision;

-- Backfill seguro: para los lotes que ya existen, la "cantidad inicial" que
-- no se registró en su momento se completa con la cantidad actual. Esto NO
-- pisa ningún dato — solo llena la columna nueva donde está vacía.
update inventory_lots set cantidad_inicial = quantity where cantidad_inicial is null;

-- ---------------------------------------------------------------------------
-- 3) STOCK_MOVEMENTS: historial inmutable de movimientos de stock.
--    Nunca se borra ni se actualiza un registro ya creado desde la app.
-- ---------------------------------------------------------------------------
create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete set null,
  lot_id uuid references inventory_lots(id) on delete set null,
  type text not null, -- recepcion | salida | transferencia | ajuste_positivo | ajuste_negativo | merma | devolucion | vencimiento | bloqueo | desbloqueo
  quantity double precision not null default 0,
  previous_qty double precision,
  new_qty double precision,
  reason text,
  related_document text,
  location text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4) LOT_LOCATIONS: stock de un lote repartido en varias ubicaciones
--    (ej: Cámara 1 / Estantería A + Cámara 2 / Estantería C).
-- ---------------------------------------------------------------------------
create table if not exists lot_locations (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid references inventory_lots(id) on delete cascade,
  location_label text not null,
  quantity double precision not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5) APP_SETTINGS: configuración editable (ej: umbrales de alerta de
--    vencimiento). Usa "id" como clave para reutilizar la misma capa de
--    datos genérica (db.js) que ya usa el resto de la app.
-- ---------------------------------------------------------------------------
create table if not exists app_settings (
  id text primary key,
  value jsonb not null,
  created_at timestamptz not null default now()
);

insert into app_settings (id, value)
values ('alert_thresholds', '{"yellow":30,"orange":7}'::jsonb)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 6) Seguridad y tiempo real para las tablas nuevas (mismo esquema que ya
--    usa el resto de la base: cualquier usuario autenticado puede leer y
--    escribir). Esto NO modifica las policies de las tablas existentes más
--    allá de volver a aplicarles la misma policy que ya tenían.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array['products','inventory_lots','stock_movements','lot_locations','app_settings'])
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
  for t in select unnest(array['stock_movements','lot_locations','app_settings'])
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I;', t);
    end if;
  end loop;
end $$;
