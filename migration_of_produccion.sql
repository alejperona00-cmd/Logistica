-- ============================================================================
-- LOGÍSTICA PERONA — Producción: Órdenes de Fabricación (OF), fase 1 (esquema)
-- Migración ADITIVA: sólo agrega una columna y 7 tablas nuevas. NO borra,
-- reemplaza ni reinicializa ningún dato existente — `products`, `box_configs`,
-- `box_config_items` y `production_orders` (el flujo de producción simple ya
-- existente) siguen intactos y se reutilizan por id; `production_orders` NO
-- se toca ni se reemplaza, este es un flujo nuevo y más completo que convive
-- con él. Se puede volver a ejecutar sin problema (todo usa IF NOT EXISTS).
-- Pegar y ejecutar completo en: Supabase → SQL Editor → New query → Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) PRODUCTS: ean13 opcional para escaneo por código de barras. Nullable y
--    aditivo — products.sku sigue siendo el código interno, no se reemplaza.
-- ---------------------------------------------------------------------------
alter table products add column if not exists ean13 text;

-- ---------------------------------------------------------------------------
-- 2) LDP_VERSIONS: snapshot versionado de la lista de picking (LDP) de una
--    receta de caja (box_config) en el momento en que se generó una OF —
--    para que cambios futuros en box_config_items no alteren OFs ya creadas.
-- ---------------------------------------------------------------------------
create table if not exists ldp_versions (
  id uuid primary key default gen_random_uuid(),
  box_config_id uuid references box_configs(id) on delete set null,
  version integer not null,
  snapshot_size text,
  snapshot_name text,
  created_at timestamptz not null default now(),
  created_by text
);

-- ---------------------------------------------------------------------------
-- 3) LDP_VERSION_ITEMS: líneas de esa LDP versionada (uno por producto),
--    con copia de código/nombre/EAN al momento del snapshot.
-- ---------------------------------------------------------------------------
create table if not exists ldp_version_items (
  id uuid primary key default gen_random_uuid(),
  ldp_version_id uuid references ldp_versions(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  codigo_interno text,
  nombre text,
  ean13 text,
  unidad text,
  cantidad_requerida double precision not null default 0,
  estado text not null default 'activo',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4) MANUFACTURING_ORDERS: Órdenes de Fabricación (OF) — flujo nuevo, más
--    rico que production_orders (estados, almacenes de origen/intermedio,
--    trazabilidad de pausa/bloqueo, código de barras propio de la OF).
-- ---------------------------------------------------------------------------
create table if not exists manufacturing_orders (
  id uuid primary key default gen_random_uuid(),
  numero text not null unique,
  box_config_id uuid references box_configs(id) on delete set null,
  ldp_version_id uuid references ldp_versions(id) on delete set null,
  cantidad_planificada double precision not null default 0,
  cantidad_producida double precision not null default 0,
  estado text not null default 'BORRADOR',
  fecha_creacion timestamptz not null default now(),
  fecha_planificacion date,
  fecha_prevista date,
  fecha_inicio timestamptz,
  fecha_cierre timestamptz,
  created_by text,
  usuario_responsable text,
  almacen_origen_id uuid references locations(id) on delete set null,
  almacen_intermedio_id uuid references locations(id) on delete set null,
  motivo_pausa text,
  motivo_bloqueo text,
  codigo_barras text unique,
  notes text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5) PRODUCTION_RESERVATIONS: reservas de stock hechas contra una OF (previo
--    al consumo real), por producto y almacén.
-- ---------------------------------------------------------------------------
create table if not exists production_reservations (
  id uuid primary key default gen_random_uuid(),
  manufacturing_order_id uuid references manufacturing_orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  ean13 text,
  cantidad double precision not null default 0,
  estado text not null default 'RESERVADO',
  almacen_id uuid references locations(id) on delete set null,
  usuario text,
  fecha timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 6) PRODUCTION_CONSUMPTIONS: consumo real de stock contra una OF, con
--    lote de origen y enlace al stock_movement generado (mismo mecanismo de
--    trazabilidad que ya usa Inventario). operation_uid es único para poder
--    hacer el registro idempotente ante reintentos/doble escaneo.
-- ---------------------------------------------------------------------------
create table if not exists production_consumptions (
  id uuid primary key default gen_random_uuid(),
  manufacturing_order_id uuid references manufacturing_orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  lot_id uuid references inventory_lots(id) on delete set null,
  cantidad double precision not null default 0,
  tipo text not null default 'consumo',
  usuario text,
  dispositivo text,
  operation_uid text unique,
  stock_movement_id uuid references stock_movements(id) on delete set null,
  fecha timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 7) PRODUCTION_SUBSTITUTIONS: sustitución de un producto por otro dentro de
--    una OF (ej. falta de stock del original), con doble escaneo de
--    confirmación y enlace a las reservas involucradas.
-- ---------------------------------------------------------------------------
create table if not exists production_substitutions (
  id uuid primary key default gen_random_uuid(),
  manufacturing_order_id uuid references manufacturing_orders(id) on delete cascade,
  producto_original_id uuid references products(id) on delete set null,
  ean_original text,
  producto_sustituto_id uuid references products(id) on delete set null,
  ean_sustituto text,
  cantidad double precision not null default 0,
  usuario text,
  fecha timestamptz not null default now(),
  motivo text,
  confirmado_doble_escaneo boolean not null default false,
  reserva_original_id uuid references production_reservations(id) on delete set null,
  reserva_sustituto_id uuid references production_reservations(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 8) PRODUCTION_AUDIT_LOG: auditoría inmutable de operaciones sobre una OF
--    (quién, cuándo, qué operación, estado anterior/nuevo en jsonb).
-- ---------------------------------------------------------------------------
create table if not exists production_audit_log (
  id uuid primary key default gen_random_uuid(),
  manufacturing_order_id uuid references manufacturing_orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  operacion text not null,
  usuario text,
  fecha timestamptz not null default now(),
  info_anterior jsonb,
  info_nueva jsonb,
  notas text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 9) Seguridad para las tablas nuevas (mismo esquema que ya usa el resto de
--    la base: cualquier usuario autenticado puede leer y escribir). Esto NO
--    modifica las policies de ninguna tabla existente.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array['ldp_versions','ldp_version_items','manufacturing_orders','production_reservations','production_consumptions','production_substitutions','production_audit_log'])
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists "authenticated_all" on %I;', t);
    execute format(
      'create policy "authenticated_all" on %I for all to authenticated using (true) with check (true);',
      t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 10) Tiempo real para las tablas nuevas (si tenés la app abierta en dos
--     pestañas, los cambios se reflejan solos). El chequeo "if not exists"
--     permite volver a correr este archivo sin error.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array['ldp_versions','ldp_version_items','manufacturing_orders','production_reservations','production_consumptions','production_substitutions','production_audit_log'])
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I;', t);
    end if;
  end loop;
end $$;
