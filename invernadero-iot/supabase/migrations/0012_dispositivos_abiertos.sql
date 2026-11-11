-- 0012 · Qué placa es cuál en el modo abierto (ACEPTAR_NODOS_NUEVOS=1)
--
-- En el modo abierto el invernadero se identifica por el NOMBRE que la placa manda dentro del mensaje cifrado («grupo-1»).
-- Si alguien cambia el nombre y vuelve a subir el firmware, ese nombre es «nuevo» y se creaba OTRO invernadero (duplicado).
-- Esta tabla recuerda qué id de chip (el «nodo-xxxxxx» de la ruta /relay) está ligado a qué nodo: si llega un nombre desconocido
-- desde un chip ya conocido, se RENOMBRA su invernadero en vez de crear uno nuevo, y el historial continúa.
-- (No se copia a ninguna parte: solo vale para ESTA Pi.)

create table if not exists iot.open_devices (
  device    text primary key,                                                -- id de chip tal como llega en la ruta: 'nodo-85bbc8'
  node_id   smallint not null references iot.nodes(id) on delete cascade,
  seen_at   timestamptz not null default now()
);

create index if not exists open_devices_node_idx on iot.open_devices (node_id);

alter table iot.open_devices enable row level security;
revoke all on iot.open_devices from public, anon, authenticated;
drop policy if exists app_all on iot.open_devices;
create policy app_all on iot.open_devices for all to iot_app using (true) with check (true);

grant select, insert, update on iot.open_devices to iot_app;

comment on table iot.open_devices is 'Modo abierto: id de chip -> nodo, para renombrar en vez de duplicar cuando una placa cambia de nombre.';
