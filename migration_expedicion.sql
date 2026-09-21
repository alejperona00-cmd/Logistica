-- ============================================================================
-- LOGÍSTICA PERONA — Expedición: centro de decisión operativa de despacho
-- Migración ADITIVA: sólo agrega una columna y 4 tablas nuevas. NO borra,
-- reemplaza ni reinicializa ningún dato existente (pedidos, clientes,
-- ubicaciones, transportistas siguen intactos y se reutilizan por id).
-- Se puede volver a ejecutar sin problema (todo usa IF NOT EXISTS).
-- Pegar y ejecutar completo en: Supabase → SQL Editor → New query → Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) CUSTOMERS: email opcional (hoy no existe). Nullable y aditivo: no
--    afecta ningún cliente, pedido ni pantalla ya cargada.
-- ---------------------------------------------------------------------------
alter table customers add column if not exists email text;

-- ---------------------------------------------------------------------------
-- 2) DISPATCH_DETAILS: datos físicos de despacho de un pedido (cajas, peso,
--    volumen, valor, horario de recepción). Relación 1 a 1 con orders — no
--    duplica nada del pedido, sólo agrega lo que orders no tiene hoy.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3) TRANSPORT_RATES: tarifa configurable por transportista (uno a uno).
--    Costo real = fijo + (por_km × km) + (por_caja × cajas) +
--    (por_kg × kg) + (porcentaje × valor_del_pedido / 100). Lo que quede en
--    0 no participa del cálculo — no hace falta usar todos los componentes.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4) TRANSPORT_SELECTIONS: decisión del operador al elegir transporte para
--    un pedido — trazabilidad completa (quién, cuándo, con qué costo/tiempo
--    estimado y bajo qué criterios). Puede haber varias filas por pedido si
--    se cambia la decisión antes de despachar; la más reciente es la
--    vigente (se ordena por selected_at desde la app).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5) CLIENT_NOTIFICATIONS: historial de avisos al cliente. event_key es
--    único a propósito: es lo que garantiza que un mismo evento (ej.
--    "PEDIDO-1042-DESPACHADO") nunca genere un mensaje duplicado, ni
--    siquiera si se recalcula el estado o se recarga la página. NINGÚN
--    envío real ocurre desde esta tabla: el estado queda en "pendiente"
--    hasta que se conecte un canal real (WhatsApp/Email/SMS) o el operador
--    confirme manualmente que lo envió por fuera del sistema.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6) Seguridad para las tablas nuevas (mismo esquema que ya usa el resto de
--    la base: cualquier usuario autenticado puede leer y escribir). Esto NO
--    modifica las policies de ninguna tabla existente.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array['dispatch_details','transport_rates','transport_selections','client_notifications'])
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
-- 7) Tiempo real para las tablas nuevas (si tenés la app abierta en dos
--    pestañas, los cambios se reflejan solos). El chequeo "if not exists"
--    permite volver a correr este archivo sin error.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array['dispatch_details','transport_rates','transport_selections','client_notifications'])
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I;', t);
    end if;
  end loop;
end $$;
