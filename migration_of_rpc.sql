-- ============================================================================
-- LOGÍSTICA PERONA — Producción OF, fase 2: reserva de stock atómica
-- Migración ADITIVA: sólo agrega 2 funciones nuevas (RPC). No toca ninguna
-- tabla ni dato existente. Requiere haber corrido antes migration_of_produccion.sql.
-- Pegar y ejecutar completo en: Supabase → SQL Editor → New query → Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Reserva atómica de stock para producción. Nunca permite sobre-reservar:
-- usa un lock consultivo por producto (pg_advisory_xact_lock) para serializar
-- reservas concurrentes de distintas OF sobre el mismo producto — sólo una
-- reserva a la vez puede calcular "cuánto hay libre" por producto, así que
-- dos OF simultáneas jamás pueden reservar el mismo stock dos veces. Reserva
-- como máximo el stock realmente libre (físico no bloqueado, menos ya
-- reservado por cualquier OF activa), nunca más de lo pedido ni más de lo
-- disponible — el resto queda como faltante (se puede reservar más después,
-- a medida que entre stock).
-- ---------------------------------------------------------------------------
create or replace function fn_reservar_produccion(
  p_manufacturing_order_id uuid,
  p_product_id uuid,
  p_ean13 text,
  p_cantidad double precision,
  p_almacen_id uuid,
  p_usuario text
) returns jsonb
language plpgsql
as $$
declare
  v_total_fisico double precision;
  v_ya_reservado double precision;
  v_disponible double precision;
  v_a_reservar double precision;
  v_reservation_id uuid;
begin
  if p_cantidad is null or p_cantidad <= 0 then
    return jsonb_build_object('reservedQty', 0, 'shortfall', 0, 'reservationId', null, 'ok', true);
  end if;

  perform pg_advisory_xact_lock(hashtext('produccion_reserva:' || p_product_id::text));

  select coalesce(sum(quantity), 0) into v_total_fisico
    from inventory_lots
    where product_id = p_product_id and bloqueado is not true;

  select coalesce(sum(cantidad), 0) into v_ya_reservado
    from production_reservations
    where product_id = p_product_id and estado = 'RESERVADO';

  v_disponible := greatest(0, v_total_fisico - v_ya_reservado);
  v_a_reservar := least(p_cantidad, v_disponible);

  if v_a_reservar > 0 then
    insert into production_reservations
      (manufacturing_order_id, product_id, ean13, cantidad, estado, almacen_id, usuario)
    values
      (p_manufacturing_order_id, p_product_id, p_ean13, v_a_reservar, 'RESERVADO', p_almacen_id, p_usuario)
    returning id into v_reservation_id;

    insert into production_audit_log
      (manufacturing_order_id, product_id, operacion, usuario, info_nueva)
    values
      (p_manufacturing_order_id, p_product_id, 'reserva', p_usuario,
       jsonb_build_object('cantidad', v_a_reservar, 'almacenId', p_almacen_id));
  end if;

  return jsonb_build_object(
    'reservedQty', v_a_reservar,
    'shortfall', p_cantidad - v_a_reservar,
    'reservationId', v_reservation_id,
    'ok', true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Libera (cancela) una reserva existente — usada al pausar/cancelar una OF o
-- al reemplazar un producto. Nunca borra el registro: lo marca LIBERADA para
-- mantener trazabilidad completa (auditoría inmutable).
-- ---------------------------------------------------------------------------
create or replace function fn_liberar_reserva_produccion(
  p_reservation_id uuid,
  p_usuario text,
  p_motivo text
) returns jsonb
language plpgsql
as $$
declare
  v_row production_reservations%rowtype;
begin
  select * into v_row from production_reservations where id = p_reservation_id and estado = 'RESERVADO';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Reserva no encontrada o ya liberada');
  end if;

  update production_reservations set estado = 'LIBERADA' where id = p_reservation_id;

  insert into production_audit_log
    (manufacturing_order_id, product_id, operacion, usuario, info_anterior, notas)
  values
    (v_row.manufacturing_order_id, v_row.product_id, 'liberacion_reserva', p_usuario,
     jsonb_build_object('cantidad', v_row.cantidad, 'reservationId', p_reservation_id), p_motivo);

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function fn_reservar_produccion(uuid, uuid, text, double precision, uuid, text) to authenticated;
grant execute on function fn_liberar_reserva_produccion(uuid, text, text) to authenticated;
