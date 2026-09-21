-- ============================================================================
-- LOGÍSTICA PERONA — módulo de Inventario (productos, proveedores de insumos, lotes)
-- Pegar y ejecutar completo en: Supabase → SQL Editor → New query → Run
-- Seguro de re-ejecutar: usa ON CONFLICT (id) DO NOTHING con ids fijos, no duplica.
-- ============================================================================

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
  supplier_id uuid references inv_suppliers(id) on delete set null,
  unit text,
  package_size double precision,
  min_qty double precision,
  max_qty double precision,
  optimal_qty double precision,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists inventory_lots (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete cascade,
  quantity double precision,
  expiry_date date,
  notes text,
  created_at timestamptz not null default now()
);

do $$
declare
  t text;
begin
  for t in select unnest(array['inv_suppliers','products','inventory_lots'])
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists "authenticated_all" on %I;', t);
    execute format('create policy "authenticated_all" on %I for all to authenticated using (true) with check (true);', t);
  end loop;
end $$;
alter publication supabase_realtime add table inv_suppliers, products, inventory_lots;

-- Proveedores de insumos (18)
insert into inv_suppliers (id, name) values ('3af0b80c-8c72-56b8-9994-73d4d9070c02', 'ALCARAS') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('31559f87-9322-5c49-91e2-d8b2eb12b627', 'WARA PALLAY') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('781eaaac-c86f-52ea-bad3-a7074052fca1', 'RINCON DE ARTURO') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('97ed096e-7e1b-5a8a-89e8-6afe083085ce', 'PEPPER') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('0f9f67d9-d014-5e88-b030-b5b800c08ad2', '1888') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('640dbf94-3b24-54bd-a5b5-5cb486622c8b', 'FINCA CRUZ DEL EJE') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('05c3066c-a961-5dd8-99cf-51ff5a3cf6a0', 'GIULIANA LOPEZ MAY') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('6a16c235-9165-5b6d-a666-fcce29955c20', 'MOSHO DE PAPUZ') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('f0fd7d23-e8e1-579a-b00c-0836140ee70f', 'CUESTA DE PORTEZUELO') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('ada8192d-2920-592a-ae2e-952c210804fd', 'CHAMA') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('b5e37574-be3c-5138-94a2-37eabbd7cf15', 'NUTELLA') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('e99bfc87-3141-5b2e-b3ea-9c3e0a1e0c48', 'CROWIE') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('804c81e5-5df8-53ea-8edd-f388a3bf42bd', 'EATWELL') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('0c5f9c05-e567-5a3f-ae8e-be43bd8cdc33', 'CARANEGRA') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('a095a851-8057-5aa5-9041-87b92c6c85a5', 'PLASTICICINO') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('cace5d6a-49c0-5968-963b-4637ab2092f5', 'FERRERO ROCHER') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('ce92f226-c977-541a-86f6-17dd192f8041', 'DUO SILVESTRE') on conflict (id) do nothing;
insert into inv_suppliers (id, name) values ('d7af6083-cd52-50ae-82c7-1975c240ae18', 'GREEN CROPS') on conflict (id) do nothing;

-- Productos (58) — min/max/óptimo quedan en NULL: se completan a mano en la app
insert into products (id, name, supplier_id, unit, package_size) values ('114b90c6-4dce-5227-9d3c-3cf129b7dcb6', 'Pimiento agridulce', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 300.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('90424a3a-9deb-55b0-a645-612aad44970c', 'Pimiento morron entero', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 300.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('8e12492a-ce82-5563-929f-458d250b5331', 'Tomate entero', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 780.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('1f3e6ed8-8cd1-5bc9-a356-c3ec6f48d9a5', 'Alpaca fresca', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 80.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('4eafa46d-8e11-526b-934d-1a2e47082d9a', 'Alcaparras', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 80.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('b5f789fa-a124-5f4f-bc46-45160ace28b3', 'Aceitunas rellenas', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 300.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('ff327d08-b7a6-57d6-b844-11e1efbd4bbb', 'Chutney', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 250.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('667dd51f-50d8-5649-af61-6aeb3b29a450', 'Aceitunas verdes', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 330.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('a13e6f54-3008-5b67-8d5b-2be27a51f4b8', 'Baba ganush', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 175.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('4d95c994-99e7-5f7c-8196-550e69c6a7ca', 'Pasta de ajo', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 80.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('7e99ab8c-b796-5d60-a59b-a1b4c172ed53', 'Pasta de ajo negro', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 100.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('4db1f160-2212-51b7-9875-b298010b9cd7', 'Escabeche de berenjena', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 310.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('62cf6ee6-94ce-5525-8df6-e2f49f2f5689', 'Alcaducines grillados', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 300.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('60935cd0-24d7-5de5-9e6c-7c4032596d90', 'Alcaducin al natural', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 300.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('5d4060fe-6da2-5630-8dc1-66fc5cb2570f', 'Alcaducin en aceite', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 300.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('fcbae232-7778-5380-9f5d-2f68d80cc530', 'Crema de alcaducines', '3af0b80c-8c72-56b8-9994-73d4d9070c02', 'gm', 175.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('60dfb9d0-1ee9-55ce-b85a-32dbe0317d82', 'Aceituna rellena', '31559f87-9322-5c49-91e2-d8b2eb12b627', 'gm', 220.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('d7ed26b5-8dc2-5379-9c71-113a1ee6c8fa', 'Aceitunas verdes', '31559f87-9322-5c49-91e2-d8b2eb12b627', 'gm', 330.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('ab317399-ccb4-5330-9377-71ed436109bd', 'Humus con ajo', '31559f87-9322-5c49-91e2-d8b2eb12b627', 'gm', 200.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('06a22431-7160-5721-9fa2-1fe2d869b84f', 'Esparragos', '31559f87-9322-5c49-91e2-d8b2eb12b627', 'gm', 330.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('4e543dfb-817a-5f9b-870f-0930c8656b5a', 'Humus clasico', '31559f87-9322-5c49-91e2-d8b2eb12b627', 'gm', 200.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('43145193-1099-57c0-9086-5b6b56d702ef', 'Picada mediterranea', '31559f87-9322-5c49-91e2-d8b2eb12b627', 'gm', 330.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('c8228b66-d119-5fb2-8d9a-dbe20f50bff0', 'Escabeche de carne', '781eaaac-c86f-52ea-bad3-a7074052fca1', 'gm', 480.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('02148324-615b-50a8-a981-b372641029fe', 'Escabeche de berenjena', '97ed096e-7e1b-5a8a-89e8-6afe083085ce', 'gm', 360.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('c2748feb-50ae-570b-88f8-d0f2df77bf22', 'Olivas verdes en pasta', '97ed096e-7e1b-5a8a-89e8-6afe083085ce', 'gm', 200.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('973612e6-ddb5-5c9c-a99e-ac2ff2561026', 'Olivas verdes rellenas', '97ed096e-7e1b-5a8a-89e8-6afe083085ce', 'gm', 200.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('588da378-2b90-588e-8466-e26a9dcfa6b3', 'Chucrut', '97ed096e-7e1b-5a8a-89e8-6afe083085ce', 'gm', 360.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('998684b1-8ad1-5e48-9b34-8bc6f595cecb', 'Sidra Rosé', '0f9f67d9-d014-5e88-b030-b5b800c08ad2', 'ml', 473.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('cd8ce2ac-ea9d-52a2-9120-84ce6236425e', 'Aceitunas', '640dbf94-3b24-54bd-a5b5-5cb486622c8b', 'gm', 400.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('19086d43-979a-5717-be43-5cbad63b5017', 'Pasta de aceitunas verdes', '640dbf94-3b24-54bd-a5b5-5cb486622c8b', 'gm', 180.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('07a11251-31c9-5a6f-b430-bbb30a0f789d', 'Cebolla caramelizada al malbec', '05c3066c-a961-5dd8-99cf-51ff5a3cf6a0', 'gm', 310.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('5e651b07-c387-5913-bd7c-ba5552ff871d', 'Tomates secos mqa', '05c3066c-a961-5dd8-99cf-51ff5a3cf6a0', 'gm', 220.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('5754c9ef-3c10-509d-afa5-48e3a508b3ad', 'Baba ganush', '6a16c235-9165-5b6d-a666-fcce29955c20', 'gm', 170.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('10e05206-da6b-54f1-8e7c-7a1aaf6c531f', 'Humus de higos', '6a16c235-9165-5b6d-a666-fcce29955c20', 'gm', 170.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('eea79e41-aa4b-57d1-bb82-99cb273cf6bc', 'Mamon en almibar', 'f0fd7d23-e8e1-579a-b00c-0836140ee70f', 'gm', 450.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('7a6399cb-d4bd-51da-b01c-9379360fd7d8', 'Cookie pepita', 'ada8192d-2920-592a-ae2e-952c210804fd', 'gm', 150.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('02614438-a432-51d9-8c82-1fd458c570ed', 'Cookie de chocolate', 'ada8192d-2920-592a-ae2e-952c210804fd', 'gm', 150.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('f16e19ad-2468-5bcb-96bb-c2a6a863b14f', 'Cookie de vainilla', 'ada8192d-2920-592a-ae2e-952c210804fd', 'gm', 150.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('a04f63d4-6851-506c-a82d-8b63ee1cd1ca', 'Blister chammas chocolate negro x 6', 'ada8192d-2920-592a-ae2e-952c210804fd', 'paq', 200.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('38f5bee6-12ce-5651-b53b-c9e0be32502a', 'Blister chammas chocolate blanco x6', 'ada8192d-2920-592a-ae2e-952c210804fd', 'paq', 200.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('e9ce2f67-bf59-50a0-bcc5-276189865f4a', 'Alfajor chammas chocolate blanco', 'ada8192d-2920-592a-ae2e-952c210804fd', 'und', 30.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('12d29ec7-b715-598f-9a56-ed37429d71cb', 'Caja chama chocolate negro x 6', 'ada8192d-2920-592a-ae2e-952c210804fd', 'caja', 300.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('adcf2c6d-00aa-57fb-ac7d-8964ecc3e038', 'Nutella', 'b5e37574-be3c-5138-94a2-37eabbd7cf15', 'gm', 140.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('de859a2e-4a3e-5759-a127-132e2c7f5036', 'Cerealbar', 'e99bfc87-3141-5b2e-b3ea-9c3e0a1e0c48', 'gm', 25.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('3c1ce595-9578-557f-a91d-bd29c9f093dd', 'Mix energy plus', '804c81e5-5df8-53ea-8edd-f388a3bf42bd', 'gm', 100.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('f35ca0a9-60ff-5c88-b742-e37f4658ea84', 'Ositos avena y miel', '804c81e5-5df8-53ea-8edd-f388a3bf42bd', 'gm', 100.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('4ad72308-29a4-5146-837d-03cb8d812610', 'Aritos frutados', '804c81e5-5df8-53ea-8edd-f388a3bf42bd', 'gm', 100.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('914e38b1-8049-5478-a606-af3f47066fc5', 'Dulce de leche', '0c5f9c05-e567-5a3f-ae8e-be43bd8cdc33', 'gm', 450.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('fbab2743-ec56-50b4-be6c-61869b3bc64b', 'Cookie americana sabor vainilla', 'a095a851-8057-5aa5-9041-87b92c6c85a5', 'gm', 30.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('3b27d49f-d797-5ee9-ab07-6dde2b219bc7', 'Galletita dulce tipo cookie con cacao', 'a095a851-8057-5aa5-9041-87b92c6c85a5', 'gm', 20.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('3e8ebf9e-f774-538f-8a80-696c095665ed', 'Cuadrado relleno sabor limon', 'a095a851-8057-5aa5-9041-87b92c6c85a5', 'gm', 33.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('10ee6872-3e6b-5465-a7e9-2dd30805318d', 'Ferrero rocher T3', 'cace5d6a-49c0-5968-963b-4637ab2092f5', 'paq', 37.5) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('23c65a14-5491-5227-9190-512dc1fd4194', 'Ferrero rocher T8', 'cace5d6a-49c0-5968-963b-4637ab2092f5', 'paq', 100.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('a221687f-5955-5110-8054-080f1108ea48', 'Escabeche de verdura', 'ce92f226-c977-541a-86f6-17dd192f8041', 'gm', 360.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('576bfacf-ef7d-5b84-b6ba-f12d61c29bdd', 'Escabeche de berenjena', 'ce92f226-c977-541a-86f6-17dd192f8041', 'gm', 500.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('60eb6329-d013-5668-be46-4a915859a439', 'Green crops 45gm', 'd7af6083-cd52-50ae-82c7-1975c240ae18', 'gm', 45.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('df49a34a-c073-5912-a2f5-ff8b2b14276d', 'Green crops 95 gm', 'd7af6083-cd52-50ae-82c7-1975c240ae18', 'gm', 95.0) on conflict (id) do nothing;
insert into products (id, name, supplier_id, unit, package_size) values ('e1bacdcd-1e35-5cf6-b329-0f1f76108555', 'Green crops 95gm', 'd7af6083-cd52-50ae-82c7-1975c240ae18', 'gm', 95.0) on conflict (id) do nothing;

-- Lotes / stock actual con vencimiento (61)
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('6a75c6b4-ee0b-56de-98da-3ad9135c9781', '114b90c6-4dce-5227-9d3c-3cf129b7dcb6', 3.0, '2028-04-01', 'Vencimiento origen: 04/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('7bbfbb86-03d6-5fdd-a2ab-2ed02be5c6f8', '90424a3a-9deb-55b0-a645-612aad44970c', 5.0, '2028-03-01', 'Vencimiento origen: 03/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('2f32f0f5-08be-528c-a8ad-0ec66856e39c', '8e12492a-ce82-5563-929f-458d250b5331', 12.0, '2028-05-01', 'Vencimiento origen: 05/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('b8ed52c9-997d-5f34-b94e-b3f79922436d', '1f3e6ed8-8cd1-5bc9-a356-c3ec6f48d9a5', 20.0, '2027-10-01', 'Vencimiento origen: 10/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('a1cc1b83-b56b-535e-8627-91a9f9fe7511', '4eafa46d-8e11-526b-934d-1a2e47082d9a', 6.0, '2027-10-01', 'Vencimiento origen: 10/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('99738a77-0687-54b7-93ae-ccf8eed815c3', 'b5f789fa-a124-5f4f-bc46-45160ace28b3', 16.0, '2028-04-01', 'Vencimiento origen: 04/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('e17cbe1a-8658-5775-91e1-d1723704259a', 'ff327d08-b7a6-57d6-b844-11e1efbd4bbb', 5.0, '2027-10-01', 'Vencimiento origen: 10/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('966f313c-6170-5528-acc0-df53da31022e', '667dd51f-50d8-5649-af61-6aeb3b29a450', 400.0, '2028-06-01', 'Vencimiento origen: 06/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('1ca8a053-6394-5a19-bc44-9e8d556d3890', 'a13e6f54-3008-5b67-8d5b-2be27a51f4b8', 12.0, '2028-06-01', 'Vencimiento origen: 06/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('8f607d55-21cd-509e-8a1d-1a5c089e22a9', '4d95c994-99e7-5f7c-8196-550e69c6a7ca', 136.0, '2027-11-01', 'Vencimiento origen: 11/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('e94bbabd-7bc0-5400-bef1-92ea3ad53007', '7e99ab8c-b796-5d60-a59b-a1b4c172ed53', 72.0, '2027-12-01', 'Vencimiento origen: 12/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('d6ba8ef8-ca14-5cf5-952c-fee66f387edb', '4db1f160-2212-51b7-9875-b298010b9cd7', 34.0, '2028-05-01', 'Vencimiento origen: 05/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('f5b8b2fe-3e05-54ca-8b5c-101620e5da42', '4db1f160-2212-51b7-9875-b298010b9cd7', 37.0, '2027-11-01', 'Vencimiento origen: 11/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('6da0f78f-cb73-5e7c-8171-2c6fea26d88b', '62cf6ee6-94ce-5525-8df6-e2f49f2f5689', 81.0, '2028-05-01', 'Vencimiento origen: 05/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('5911cf6f-d22d-506e-8410-8ffa4c9db604', '60935cd0-24d7-5de5-9e6c-7c4032596d90', 48.0, '2028-02-01', 'Vencimiento origen: 02/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('8213d84e-c5e7-55c0-ac0e-2446eda493d4', '60935cd0-24d7-5de5-9e6c-7c4032596d90', 33.0, '2027-11-01', 'Vencimiento origen: 11/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('5fac1212-3c9a-5ed3-9fc7-ea0f04c4d3ca', '5d4060fe-6da2-5630-8dc1-66fc5cb2570f', 16.0, '2027-09-01', 'Vencimiento origen: 09/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('73ebfe16-24ef-53a0-88bb-d484fe2248ef', 'fcbae232-7778-5380-9f5d-2f68d80cc530', 31.0, '2026-11-01', 'Vencimiento origen: 11/26') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('49ebf151-f6c5-567c-aa2c-8f61f8e84f9d', '60dfb9d0-1ee9-55ce-b85a-32dbe0317d82', 437.0, '2027-04-01', 'Vencimiento origen: 04/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('28ac131e-c9fe-5599-987a-3202cbfe2e23', 'd7ed26b5-8dc2-5379-9c71-113a1ee6c8fa', 34.0, '2027-03-01', 'Vencimiento origen: 03/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('4c3f0eba-4766-5992-8c28-2ea8f004fb15', 'ab317399-ccb4-5330-9377-71ed436109bd', 1.0, '2027-04-01', 'Vencimiento origen: 04/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('fa2c6dc6-c802-586d-a73b-a146958f082e', '06a22431-7160-5721-9fa2-1fe2d869b84f', 16.0, '2027-04-01', 'Vencimiento origen: 04/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('f8ebbc76-ae99-5808-b5c8-4138534f9ccb', '4e543dfb-817a-5f9b-870f-0930c8656b5a', 1.0, '2027-06-01', 'Vencimiento origen: 06/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('5300ac7f-1f0f-5726-b447-7162df30335d', '43145193-1099-57c0-9086-5b6b56d702ef', 6.0, '2027-05-01', 'Vencimiento origen: 05/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('a1f8c559-d416-5620-9eed-306924a4473f', 'c8228b66-d119-5fb2-8d9a-dbe20f50bff0', NULL, '2028-09-01', 'Vencimiento origen: 09/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('a0ec6ff6-2394-5d3a-adb9-7dcc9272f892', '02148324-615b-50a8-a981-b372641029fe', 48.0, '2028-03-01', 'Vencimiento origen: 03/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('77b5932e-1bc3-5e44-828d-b89241dc813d', 'c2748feb-50ae-570b-88f8-d0f2df77bf22', 4.0, '2028-06-01', 'Vencimiento origen: 06/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('f44ea0b4-3a94-5184-b608-c96503f4ca1a', '973612e6-ddb5-5c9c-a99e-ac2ff2561026', 80.0, '2027-07-01', 'Vencimiento origen: 07/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('47873cbc-c03f-5837-8cf3-a2d48195c807', '588da378-2b90-588e-8466-e26a9dcfa6b3', 12.0, '2028-02-01', 'Vencimiento origen: 02/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('93cfaf59-c614-5080-a521-de5759ff063a', '998684b1-8ad1-5e48-9b34-8bc6f595cecb', 20.0, '2027-03-01', 'Vencimiento origen: 03/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('6ba51b55-ea89-5710-baba-363f288b0606', 'cd8ce2ac-ea9d-52a2-9120-84ce6236425e', 148, '2027-06-01', 'Vencimiento origen: 06/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('3a57abb5-962a-57ce-99e8-2298de10cca4', '19086d43-979a-5717-be43-5cbad63b5017', 20.0, '2027-04-01', 'Vencimiento origen: 04/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('5feab715-f7f0-56b0-b592-12404d577349', '07a11251-31c9-5a6f-b430-bbb30a0f789d', 60.0, '2028-07-01', 'Vencimiento origen: 07/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('4e3fee5d-01be-50de-a1c9-515cb3495e2d', '07a11251-31c9-5a6f-b430-bbb30a0f789d', 46.0, '2027-11-01', 'Vencimiento origen: 11/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('0253b29f-cda2-5794-ad86-f6c5af5c6057', '5e651b07-c387-5913-bd7c-ba5552ff871d', 34.0, '2028-06-01', 'Vencimiento origen: 06/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('847efde9-6596-5438-9148-0dd0156f5267', '5754c9ef-3c10-509d-afa5-48e3a508b3ad', 60.0, '2027-12-01', 'Vencimiento origen: 12/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('27d24599-77af-52cc-8972-e2cfd6486281', '10e05206-da6b-54f1-8e7c-7a1aaf6c531f', 11.0, '2028-01-01', 'Vencimiento origen: 01/28') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('c9ed9f4b-ff62-5ff4-a5da-0bccadaa45f4', 'eea79e41-aa4b-57d1-bb82-99cb273cf6bc', 7.0, '2027-12-01', 'Vencimiento origen: 12/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('ec9cfaee-43cd-5eff-8ea1-29d5c1bdfc84', '7a6399cb-d4bd-51da-b01c-9379360fd7d8', 26.0, '2027-08-01', 'Vencimiento origen: 08/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('6e0bf726-9558-5eab-961a-a68149d4423c', '02614438-a432-51d9-8c82-1fd458c570ed', 53.0, '2027-05-01', 'Vencimiento origen: 05/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('10c7f202-3e44-5e00-a469-5f197cd672ac', 'f16e19ad-2468-5bcb-96bb-c2a6a863b14f', 58.0, '2027-05-01', 'Vencimiento origen: 05/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('33877075-1dc7-5d75-b53b-b55282001330', 'a04f63d4-6851-506c-a82d-8b63ee1cd1ca', 9.0, '2026-11-01', 'Vencimiento origen: 11/26') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('ba778661-9d11-5a8b-8c3f-4717b66fb651', '38f5bee6-12ce-5651-b53b-c9e0be32502a', 9.0, '2026-11-01', 'Vencimiento origen: 11/26') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('af0e3b3a-a4be-57b5-980c-ee3b54a35bcb', 'e9ce2f67-bf59-50a0-bcc5-276189865f4a', 12.0, '2026-11-01', 'Vencimiento origen: 11/26') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('d8150299-a3bf-5c5c-bf0c-c2cab59a9e7b', '12d29ec7-b715-598f-9a56-ed37429d71cb', 6.0, '2026-11-01', 'Vencimiento origen: 11/26') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('66da6eb1-2b99-52ec-a256-69053a0326b7', 'adcf2c6d-00aa-57fb-ac7d-8964ecc3e038', 74.0, '2027-06-01', 'Vencimiento origen: 06/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('5375155d-0aa4-577b-b3b3-6d77ed115a98', 'de859a2e-4a3e-5759-a127-132e2c7f5036', 18.0, '2027-01-01', 'Vencimiento origen: 01/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('0321f8d9-b733-56ab-ad1f-c26e57cb3737', '3c1ce595-9578-557f-a91d-bd29c9f093dd', 87.0, '2027-04-01', 'Vencimiento origen: 04/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('cae3c900-5029-5f76-8c9c-a7fdc48568a5', 'f35ca0a9-60ff-5c88-b742-e37f4658ea84', 8.0, '2027-04-01', 'Vencimiento origen: 04/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('ca706eca-c51e-5f6f-bf1a-45af3a0214ac', '4ad72308-29a4-5146-837d-03cb8d812610', 20.0, '2027-08-01', 'Vencimiento origen: 08/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('4a1ee22c-a2d2-58af-9a8c-c0893271cab4', '914e38b1-8049-5478-a606-af3f47066fc5', 20.0, '2026-12-01', 'Vencimiento origen: 12/26') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('d06adefc-bc5a-5350-a3b1-2e84cbcf5cbc', 'fbab2743-ec56-50b4-be6c-61869b3bc64b', 94, '2027-04-01', 'Vencimiento origen: 04/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('8800369d-1099-5094-a394-46c0b8729ede', '3b27d49f-d797-5ee9-ab07-6dde2b219bc7', 168.0, '2027-02-01', 'Vencimiento origen: 02/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('8640ecee-99a4-588e-b1d9-ef907a77eaac', '3e8ebf9e-f774-538f-8a80-696c095665ed', 38.0, '2026-12-01', 'Vencimiento origen: 12/26') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('a7a170d6-e2da-5065-8f6e-3ae5051619a0', '10ee6872-3e6b-5465-a7e9-2dd30805318d', 124.0, '2026-12-01', 'Vencimiento origen: 12/26') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('8b606032-51de-55a2-b7f4-a3adfe12c9c5', '23c65a14-5491-5227-9190-512dc1fd4194', 30.0, '2026-12-01', 'Vencimiento origen: 12/26') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('0c419970-50b8-5ffb-a367-8b953d902d85', 'a221687f-5955-5110-8054-080f1108ea48', 600.0, '2027-06-01', 'Vencimiento origen: 06/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('df2b3d50-22ab-5a6c-ac15-1fcddc294c58', '576bfacf-ef7d-5b84-b6ba-f12d61c29bdd', 164.0, '2027-07-01', 'Vencimiento origen: 07/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('c011dfc4-ca8c-57ce-953c-75dcb124248c', '60eb6329-d013-5668-be46-4a915859a439', 156.0, '2027-01-01', 'Vencimiento origen: 01/27') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('58f32298-4181-514c-a7ea-fbbda2cd5a53', 'df49a34a-c073-5912-a2f5-ff8b2b14276d', 60.0, '2026-10-01', 'Vencimiento origen: 10/26') on conflict (id) do nothing;
insert into inventory_lots (id, product_id, quantity, expiry_date, notes) values ('62e25027-a427-5c1c-8a68-47f5edaf22df', 'e1bacdcd-1e35-5cf6-b329-0f1f76108555', 150.0, '2026-11-01', 'Vencimiento origen: 11/26') on conflict (id) do nothing;
