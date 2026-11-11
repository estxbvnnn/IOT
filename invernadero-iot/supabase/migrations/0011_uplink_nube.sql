-- 0011 · Avance del envío a la nube (servicio «uplink»)
--
-- Según el diagrama del proyecto, la Raspberry Pi guarda todo en local y cada 5 s envía a la nube (AWS) las lecturas nuevas por HTTPS.
-- iot.uplink_state guarda hasta qué lectura ya se envió: si no hay internet no se pierde nada, el siguiente ciclo continúa desde ahí.
-- (No se copia a ninguna parte: es solo el cursor de ESTA Pi.)

create table if not exists iot.uplink_state (
  name         text primary key,                          -- p. ej. 'readings'
  last_id      bigint not null default 0,                 -- última lectura (iot.readings.id) enviada y confirmada
  last_ok_at   timestamptz,
  last_error   text
);

alter table iot.uplink_state enable row level security;
revoke all on iot.uplink_state from public, anon, authenticated;
drop policy if exists app_all on iot.uplink_state;
create policy app_all on iot.uplink_state for all to iot_app using (true) with check (true);

grant select, insert, update on iot.uplink_state to iot_app;

comment on table iot.uplink_state is 'Avance del envío de lecturas a la nube (servicio uplink de la Raspberry Pi).';
