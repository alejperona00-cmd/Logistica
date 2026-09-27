-- ============================================================================
-- LOGÍSTICA PERONA — esquema de base de datos para Supabase (Postgres)
-- Pegar y ejecutar completo en: Supabase → SQL Editor → New query → Run
-- ============================================================================

-- Extensión para generar UUIDs
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'otro',
  name text not null,
  address text,
  city text,
  province text,
  lat double precision,
  lng double precision,
  contact text,
  phone text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  location_id uuid references locations(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location_id uuid references locations(id) on delete set null,
  contact text,
  phone text,
  email text,
  notes text,
  usual_transports uuid[] default '{}',
  created_at timestamptz not null default now()
);

create table if not exists transports (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  name text not null,
  business_name text,
  cuit text,
  contact text,
  phone text,
  mobile text,
  whatsapp text,
  email text,
  website text,
  instagram text,
  facebook text,
  type text,
  province text,
  city text,
  address text,
  postal_code text,
  zone text,
  source text,
  verified_at date,
  vehicle_types text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  -- Datos de referencia rápida (planilla de transportes por provincia): cobertura
  -- de retiro de origen, rutas/autovías que recorre, tiempo y costo aproximado.
  -- No reemplazan a `zone` (cobertura de destino) ni a la tabla `transport_rates`
  -- (tarifas estructuradas que usa Expedición) — son sólo texto de referencia.
  origin_coverage text,
  route_numbers text,
  delivery_time text,
  cost_reference text
);

-- Rutas que recorre cada transportista (uno a muchos).
create table if not exists routes (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  transport_id uuid references transports(id) on delete cascade,
  origin_province text,
  origin_city text,
  origin_lat double precision,
  origin_lng double precision,
  destination_province text,
  destination_city text,
  destination_lat double precision,
  destination_lng double precision,
  label text,
  frequency text,
  notes text,
  source text,
  verified_at date,
  created_at timestamptz not null default now()
);

-- Inventario: proveedores de insumos (distintos de los "suppliers" de compras/logística),
-- productos y lotes de stock con vencimiento.
create table if not exists inv_suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  marca text,
  supplier_id uuid references inv_suppliers(id) on delete set null,
  unit text,
  package_size double precision,
  min_qty double precision,
  max_qty double precision,
  optimal_qty double precision,
  sku text,
  categoria text,
  maneja_lote boolean not null default true,
  maneja_vencimiento boolean not null default true,
  dias_alerta integer,
  notes text,
  created_at timestamptz not null default now()
);

-- "quantity" es la cantidad disponible actual del lote.
create table if not exists inventory_lots (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete cascade,
  quantity double precision,
  expiry_date date,
  numero_lote text,
  fecha_elaboracion date,
  cantidad_inicial double precision,
  cantidad_comprometida double precision not null default 0,
  deposito text,
  bloqueado boolean not null default false,
  motivo_bloqueo text,
  remito text,
  orden_compra text,
  fecha_recepcion date,
  costo_unitario double precision,
  notes text,
  created_at timestamptz not null default now()
);

-- Historial inmutable de movimientos de stock (nunca se borra ni se edita
-- un registro ya creado).
create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete set null,
  lot_id uuid references inventory_lots(id) on delete set null,
  type text not null,
  quantity double precision not null default 0,
  previous_qty double precision,
  new_qty double precision,
  reason text,
  related_document text,
  location text,
  created_at timestamptz not null default now()
);

-- Stock de un lote repartido en varias ubicaciones físicas.
create table if not exists lot_locations (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid references inventory_lots(id) on delete cascade,
  location_label text not null,
  quantity double precision not null default 0,
  created_at timestamptz not null default now()
);

-- Configuración editable de la app (ej: umbrales de alerta de vencimiento).
create table if not exists app_settings (
  id text primary key,
  value jsonb not null,
  created_at timestamptz not null default now()
);

-- Producción: "recetas" de caja por tamaño (box_configs + box_config_items)
-- y las órdenes de producción generadas al confirmar una producción. No
-- crean un inventario paralelo: box_config_items.product_id referencia los
-- mismos "products" de Inventario, y confirmar una producción descuenta
-- stock con el mismo mecanismo (FEFO + stock_movements) que ya usa Inventario.
create table if not exists box_configs (
  id uuid primary key default gen_random_uuid(),
  size text not null,
  name text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists box_config_items (
  id uuid primary key default gen_random_uuid(),
  box_config_id uuid references box_configs(id) on delete cascade,
  product_id uuid references products(id) on delete cascade,
  quantity double precision not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists production_orders (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  box_size text not null,
  box_config_id uuid references box_configs(id) on delete set null,
  quantity double precision not null default 0,
  items jsonb not null default '[]',
  status text not null default 'planificada',
  estimated_minutes double precision,
  actual_minutes double precision,
  started_at timestamptz,
  finished_at timestamptz,
  notes text,
  history jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Producción: Órdenes de Fabricación (OF) — LDP (lista de picking) versionada,
-- reservas de stock, consumo, sustituciones de producto y auditoría. Es un
-- flujo nuevo y más completo que convive con `production_orders` (que no se
-- toca ni se reemplaza) — pensado para producción por lote con trazabilidad
-- fina. `ean13` en products es aditivo y opcional: `sku` sigue siendo el
-- código interno.
-- ---------------------------------------------------------------------------
alter table products add column if not exists ean13 text;

create table if not exists ldp_versions (
  id uuid primary key default gen_random_uuid(),
  box_config_id uuid references box_configs(id) on delete set null,
  version integer not null,
  snapshot_size text,
  snapshot_name text,
  created_at timestamptz not null default now(),
  created_by text
);

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

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  number text not null,
  customer_id uuid references customers(id) on delete set null,
  customer_name text,
  phone text,
  address text,
  location_id uuid references locations(id) on delete set null,
  order_date date,
  expected_date date,
  expected_time text,
  priority text default 'media',
  items jsonb not null default '[]',
  notes text,
  status text not null default 'pendiente',
  transport_id uuid references transports(id) on delete set null,
  dispatch_date timestamptz,
  actual_delivery_date date,
  incident_id uuid,
  history jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  number text not null,
  supplier_id uuid references suppliers(id) on delete set null,
  supplier_name text,
  supplier_address text,
  location_id uuid references locations(id) on delete set null,
  issue_date date,
  expected_dispatch date,
  expected_arrival date,
  actual_arrival date,
  destination text,
  transport_id uuid references transports(id) on delete set null,
  items jsonb not null default '[]',
  notes text,
  status text not null default 'generada',
  history jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  date date,
  priority text default 'media',
  status text not null default 'abierta',
  responsible text,
  related_type text,
  related_id uuid,
  resolution text,
  resolution_date date,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  date date,
  time text,
  priority text default 'media',
  category text,
  status text not null default 'pendiente',
  notes text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Expedición: centro de decisión operativa de despacho. No crea un sistema
-- paralelo — reutiliza orders/customers/locations/transports ya existentes.
-- Sólo agrega estas tablas nuevas más una columna opcional en customers.
-- ---------------------------------------------------------------------------

-- Email del cliente (opcional): hoy customers no lo tiene. Nullable y
-- aditivo, no afecta ningún dato ni pantalla existente.
alter table customers add column if not exists email text;

-- Datos físicos de despacho de un pedido (cajas, peso, volumen, valor,
-- horario de recepción). Relación 1 a 1 con orders — nunca se duplica info
-- ya cargada en el pedido.
create table if not exists dispatch_details (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders(id) on delete cascade,
  boxes_count integer,
  box_type text,
  weight_kg double precision,
  volume_m3 double precision,
  order_value double precision,
  reception_schedule text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tarifa configurable por transportista (uno a uno). El costo real de cada
-- envío se calcula como: fijo + (por_km × km) + (por_caja × cajas) +
-- (por_kg × kg) + (porcentaje × valor_del_pedido / 100). Todo lo que quede
-- en 0 simplemente no participa del cálculo.
create table if not exists transport_rates (
  id uuid primary key default gen_random_uuid(),
  transport_id uuid not null unique references transports(id) on delete cascade,
  fixed_amount double precision not null default 0,
  per_km double precision not null default 0,
  per_box double precision not null default 0,
  per_kg double precision not null default 0,
  percent double precision not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Decisión del operador al comparar/elegir transporte para un pedido —
-- trazabilidad completa (quién, cuándo, con qué costo/tiempo estimado y bajo
-- qué criterios). Puede tener varias filas por pedido si se cambia de
-- decisión antes de despachar; la más reciente es la vigente.
create table if not exists transport_selections (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  transport_id uuid references transports(id) on delete set null,
  vehicle_type text,
  estimated_cost double precision,
  estimated_km double precision,
  estimated_time_hours double precision,
  estimated_delivery_date date,
  dispatch_number text,
  selected_at timestamptz not null default now(),
  selected_by text,
  criteria_snapshot jsonb,
  notes text,
  created_at timestamptz not null default now()
);

-- Historial de avisos al cliente. event_key es único a propósito: es lo que
-- garantiza que un mismo evento (ej. "PEDIDO-1042-DESPACHADO") nunca genere
-- un mensaje duplicado, ni siquiera si el estado se recalcula o la página se
-- recarga. Ningún envío real ocurre desde esta tabla todavía: el estado
-- queda en "pendiente" hasta que se conecte un canal real (WhatsApp/Email/
-- SMS) o el operador confirme manualmente que lo envió por fuera del sistema.
create table if not exists client_notifications (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  event_key text not null unique,
  channel text not null default 'whatsapp',
  template_used text,
  message_rendered text,
  status text not null default 'pendiente',
  error_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Zonas tarifarias configurables (nivel Táctico del Centro Geoespacial).
-- Cada zona agrupa una o más provincias reales (las mismas strings que ya se
-- usan en locations/transports.province — no un polígono geográfico: la app
-- no tiene los límites reales de cada provincia, así que no se inventan) y
-- tiene su propia tarifa de referencia, con la misma fórmula que ya usa
-- transport_rates (fijo + por_km×km + por_caja×cajas + por_kg×kg +
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

-- ---------------------------------------------------------------------------
-- Preparación para integraciones externas (ACQUA u otra fuente futura). No
-- conecta nada real todavía — sólo deja la base lista. `source`/`external_id`
-- en orders/customers identifican de dónde vino cada registro y evitan
-- duplicados si algún día se sincroniza dos veces el mismo pedido/cliente.
-- `commercial_status` queda separado de `status` (que sigue siendo, como
-- siempre, el estado LOGÍSTICO) para que una sincronización comercial futura
-- nunca pueda pisar en qué paso operativo está un pedido.
-- ---------------------------------------------------------------------------
alter table orders add column if not exists source text not null default 'manual';
alter table orders add column if not exists external_id text;
alter table orders add column if not exists commercial_status text;
create unique index if not exists orders_source_external_id_key
  on orders (source, external_id) where external_id is not null;

alter table customers add column if not exists source text not null default 'manual';
alter table customers add column if not exists external_id text;
create unique index if not exists customers_source_external_id_key
  on customers (source, external_id) where external_id is not null;

-- Historial de sincronizaciones (manual, CSV o, a futuro, API de ACQUA).
create table if not exists integration_sync_logs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  records_received integer not null default 0,
  records_created integer not null default 0,
  records_updated integer not null default 0,
  records_unchanged integer not null default 0,
  records_failed integer not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

-- Registros que no se pudieron importar — nunca se ocultan. Reprocesables
-- sin borrar nada (reprocessed_at se completa cuando se reintenta con éxito).
create table if not exists integration_errors (
  id uuid primary key default gen_random_uuid(),
  sync_log_id uuid references integration_sync_logs(id) on delete cascade,
  source text not null,
  entity text not null,
  external_id text,
  field text,
  message text not null,
  attempts integer not null default 1,
  status text not null default 'error',
  reprocessed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Seguridad: todo requiere estar autenticado (login real de Supabase Auth).
-- Al ser una herramienta personal, cualquier usuario logueado puede leer y
-- escribir todo. Si en el futuro sumás más de un usuario y querés separar
-- datos por persona, estas policies son el lugar para ajustarlo.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array['locations','customers','suppliers','transports','routes','inv_suppliers','products','inventory_lots','stock_movements','lot_locations','app_settings','box_configs','box_config_items','production_orders','ldp_versions','ldp_version_items','manufacturing_orders','production_reservations','production_consumptions','production_substitutions','production_audit_log','orders','purchase_orders','incidents','tasks','dispatch_details','transport_rates','transport_selections','client_notifications','logistics_zones','integration_sync_logs','integration_errors','acqua_export_batches','acqua_export_items'])
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
-- Realtime (opcional): permite que si tenés la app abierta en dos pestañas,
-- los cambios se reflejen solos sin recargar. El chequeo "if not exists"
-- hace que este bloque se pueda volver a ejecutar sin error aunque la tabla
-- ya esté sumada a la publicación (evita "already member of publication").
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array['locations','customers','suppliers','transports','routes','inv_suppliers','products','inventory_lots','stock_movements','lot_locations','app_settings','box_configs','box_config_items','production_orders','ldp_versions','ldp_version_items','manufacturing_orders','production_reservations','production_consumptions','production_substitutions','production_audit_log','orders','purchase_orders','incidents','tasks','dispatch_details','transport_rates','transport_selections','client_notifications','logistics_zones','integration_sync_logs','integration_errors','acqua_export_batches','acqua_export_items'])
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I;', t);
    end if;
  end loop;
end $$;
