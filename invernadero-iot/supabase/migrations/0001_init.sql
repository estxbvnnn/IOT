-- =====================================================================
--  SISTEMA IoT DE INVERNADEROS · esquema de base de datos (Supabase / PostgreSQL 17)
--  Migración 0001: tablas, restricciones, bitácora inmutable y permisos
-- =====================================================================
--  Decisiones de seguridad (informe, secciones 12.2 a 12.4):
--   * Todo vive en el esquema PRIVADO «iot». Supabase solo expone «public» por su
--     API REST/GraphQL, de modo que estos datos no son alcanzables con la clave
--     pública (anon) aunque alguien la conozca.
--   * Aun así, cada tabla tiene RLS activado, sin permisos para anon/authenticated
--     y con una única política que autoriza al rol de la aplicación (defensa en profundidad).
--   * La aplicación NO usa el rol «postgres». Usa «iot_app», con permisos mínimos.
--     En particular, sobre la bitácora solo puede SELECT e INSERT: no puede modificar
--     ni borrar registros, y un trigger encadena hashes SHA-256 para detectar
--     manipulaciones hechas por otra vía («bitácora inmutable», tabla 10).
--   * El token de cada nodo se guarda como SHA-256, nunca en claro.
--  Este script es idempotente: puede ejecutarse más de una vez sin efectos dañinos.
-- =====================================================================

create schema if not exists iot;

-- pgcrypto ya viene instalada en Supabase (esquema «extensions»); se usa digest().
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
--  Rol de la aplicación (sin contraseña aquí: la fija scripts/db-migrate.ts)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'iot_app') then
    create role iot_app nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
  end if;
end
$$;

-- Permite a «postgres» hacer SET ROLE iot_app (solo para verificar permisos en las pruebas).
-- No es obligatorio: si Supabase lo restringe, la migración continúa.
do $$
begin
  execute 'grant iot_app to postgres with inherit false, set true';
exception when others then
  raise notice 'No se pudo otorgar SET ROLE iot_app a postgres (%): se omiten las pruebas de permisos', sqlerrm;
end
$$;

-- ---------------------------------------------------------------------
--  Predio y configuración
-- ---------------------------------------------------------------------
create table if not exists iot.site_settings (
  id              smallint primary key default 1 check (id = 1),   -- fila única
  site_name       text        not null default 'Predio agrícola · 10 invernaderos',
  width_m         numeric(6,1) not null default 100,
  height_m        numeric(6,1) not null default 100,
  substation_x_m  numeric(6,1) not null default 50,               -- mástil central (gateway + anemómetro)
  substation_y_m  numeric(6,1) not null default 50,
  wind_warn_ms    numeric(4,1) not null default 15,               -- aviso: cerrar ventilaciones
  wind_crit_ms    numeric(4,1) not null default 25,               -- crítico: proteger la estructura
  updated_at      timestamptz not null default now()
);

create table if not exists iot.greenhouses (
  id          smallint primary key check (id between 1 and 99),
  code        text not null unique,                                -- I1 … I10
  name        text not null,
  crop        text,
  x_m         numeric(6,2) not null,                               -- posición en el predio (figura 2 del informe)
  y_m         numeric(6,2) not null,
  area_m2     numeric(8,2),
  flow_lph    numeric(8,2) not null default 100 check (flow_lph > 0),  -- caudal para estimar el agua usada
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  Usuarios, roles, sesiones (informe, tabla 11)
-- ---------------------------------------------------------------------
create table if not exists iot.app_users (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null check (email = lower(email) and length(email) between 5 and 254),
  name                  text not null check (length(name) between 2 and 120),
  role                  text not null check (role in ('owner','admin','agronomist','operator','technician')),
  password_hash         text not null,                              -- scrypt$N$r$p$salt$hash
  totp_secret_enc       text,                                       -- AES-256-GCM (base64), null = sin 2FA
  totp_last_step        bigint,                                     -- evita reutilizar un código TOTP
  is_active             boolean not null default true,
  failed_logins         smallint not null default 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  must_change_password  boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists app_users_email_key on iot.app_users (email);

create table if not exists iot.user_greenhouses (
  user_id        uuid     not null references iot.app_users(id) on delete cascade,
  greenhouse_id  smallint not null references iot.greenhouses(id) on delete cascade,
  primary key (user_id, greenhouse_id)
);

create table if not exists iot.sessions (
  id              bytea primary key,                                -- SHA-256 del token de la cookie
  user_id         uuid not null references iot.app_users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  expires_at      timestamptz not null,                             -- vencimiento absoluto
  idle_timeout_s  integer not null check (idle_timeout_s between 60 and 86400),
  mfa_verified    boolean not null default false,
  ip              text,
  user_agent      text
);
create index if not exists sessions_user_idx on iot.sessions (user_id);
create index if not exists sessions_expires_idx on iot.sessions (expires_at);

-- ---------------------------------------------------------------------
--  Nodos (un ESP32 por invernadero + el nodo del mástil con el anemómetro)
-- ---------------------------------------------------------------------
create table if not exists iot.nodes (
  id                smallint generated always as identity primary key,
  kind              text not null check (kind in ('greenhouse','mast')),
  greenhouse_id     smallint references iot.greenhouses(id) on delete restrict,
  label             text not null,
  token_hash        bytea not null unique,                          -- SHA-256 del token Bearer del nodo
  token_prefix      text  not null,                                 -- 6 primeros caracteres (identificación, no secreto)
  token_rotated_at  timestamptz not null default now(),
  enabled           boolean not null default true,
  cal_dry           smallint not null default 1023 check (cal_dry between 1 and 1023),  -- lectura en aire   → 0 %
  cal_wet           smallint not null default 0    check (cal_wet between 0 and 1022),   -- lectura en agua   → 100 %
  created_at        timestamptz not null default now(),
  constraint nodes_kind_greenhouse check ((kind = 'greenhouse') = (greenhouse_id is not null)),
  constraint nodes_cal_order check (cal_wet < cal_dry)
);
create unique index if not exists nodes_one_per_greenhouse on iot.nodes (greenhouse_id) where greenhouse_id is not null;

-- Estado más reciente de cada nodo (una fila por nodo; el panel principal lee solo esto).
create table if not exists iot.node_state (
  node_id        smallint primary key references iot.nodes(id) on delete cascade,
  ts             timestamptz,                                       -- última trama aceptada
  fw_version     text,
  boot_id        bigint,
  last_seq       bigint,
  uptime_s       bigint,
  temp_c         real,
  hum_air        real,
  soil_raw       smallint,
  soil_pct       real,
  light_lux      real,
  wind_ms        real,
  pump_on        boolean,
  pump_state     text,                                              -- idle | riego | espera | bloq_temp | bloq_sensor | saturado
  pump_run_s     integer,
  cooldown_s     integer,
  rssi           smallint,
  snr            real,
  faults         text[] not null default '{}',
  cfg_version    integer                                            -- versión de cfg entregada al nodo
);

-- Umbrales por invernadero: los ajusta el agrónomo y viajan al nodo dentro de «cfg».
create table if not exists iot.thresholds (
  greenhouse_id  smallint primary key references iot.greenhouses(id) on delete cascade,
  soil_on        smallint not null default 700 check (soil_on  between 2 and 1023),    -- regar si lectura >= (banda SECO de la imagen)
  soil_off       smallint not null default 500 check (soil_off between 1 and 1022),    -- dejar de regar si lectura <=
  soil_sat       smallint not null default 300 check (soil_sat between 0 and 1021),    -- SATURADO si lectura <
  temp_max       numeric(4,1) not null default 40 check (temp_max between 30 and 60),  -- no iniciar riego sobre esta temperatura
  temp_heat      numeric(4,1) not null default 35,                                     -- alerta de calor
  temp_cold      numeric(4,1) not null default 5,                                      -- alerta de frío
  temp_frost     numeric(4,1) not null default 2,                                      -- alerta de helada (crítica)
  hum_air_min    numeric(4,1) not null default 30 check (hum_air_min between 0 and 100),
  hum_air_max    numeric(4,1) not null default 90 check (hum_air_max between 0 and 100),
  pump_max_s     smallint not null default 30  check (pump_max_s  between 5 and 120),
  pump_wait_s    integer  not null default 300 check (pump_wait_s between 60 and 3600),
  interval_s     integer  not null default 300 check (interval_s  between 5 and 3600),
  version        integer  not null default 1,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references iot.app_users(id) on delete set null,
  constraint thresholds_soil_order check (soil_sat < soil_off and soil_off < soil_on),
  constraint thresholds_temp_order check (temp_frost < temp_cold and temp_cold < temp_heat and temp_heat <= temp_max),
  constraint thresholds_hum_order  check (hum_air_min < hum_air_max)
);

-- ---------------------------------------------------------------------
--  Telemetría
-- ---------------------------------------------------------------------
create table if not exists iot.readings (
  id             bigint generated always as identity primary key,
  node_id        smallint not null references iot.nodes(id) on delete cascade,
  greenhouse_id  smallint references iot.greenhouses(id) on delete cascade,
  ts             timestamptz not null default now(),
  temp_c         real  check (temp_c   between -40 and 80),
  hum_air        real  check (hum_air  between 0 and 100),
  soil_raw       smallint check (soil_raw between 0 and 1023),
  soil_pct       real  check (soil_pct between 0 and 100),
  light_lux      real  check (light_lux between 0 and 65535),
  wind_ms        real  check (wind_ms  between 0 and 60),
  pump_on        boolean,
  rssi           smallint,
  snr            real,
  seq            bigint,
  faults         text[] not null default '{}'
);
create index if not exists readings_gh_ts_idx   on iot.readings (greenhouse_id, ts desc);
create index if not exists readings_node_ts_idx on iot.readings (node_id, ts desc);
create index if not exists readings_ts_idx      on iot.readings (ts);

-- Promedios horarios: el informe conserva los datos crudos 90 días y luego solo promedios (tabla 12).
create table if not exists iot.readings_hourly (
  node_id        smallint not null references iot.nodes(id) on delete cascade,
  greenhouse_id  smallint,
  hour           timestamptz not null,
  n              integer not null,
  temp_avg       real, temp_min real, temp_max real,
  hum_air_avg    real,
  soil_raw_avg   real,
  soil_pct_avg   real,
  light_avg      real,
  wind_avg       real, wind_max real,
  pump_on_frac   real,
  primary key (node_id, hour)
);

create table if not exists iot.irrigation_events (
  id              bigint generated always as identity primary key,
  node_id         smallint not null references iot.nodes(id) on delete cascade,
  greenhouse_id   smallint not null references iot.greenhouses(id) on delete cascade,
  started_at      timestamptz not null,
  ended_at        timestamptz,
  duration_s      integer check (duration_s >= 0),
  trigger         text not null check (trigger in ('auto','manual','schedule')),
  end_reason      text check (end_reason in ('objetivo','tiempo_max','orden','seguridad','saturado','desconocido')),
  command_id      uuid,
  soil_raw_start  smallint,
  soil_raw_end    smallint,
  water_l         real
);
create index if not exists irrigation_gh_start_idx on iot.irrigation_events (greenhouse_id, started_at desc);
create unique index if not exists irrigation_one_open_per_node on iot.irrigation_events (node_id) where ended_at is null;

-- ---------------------------------------------------------------------
--  Órdenes de riego (confirmación en dos pasos: solicitud + reingreso de contraseña)
-- ---------------------------------------------------------------------
create table if not exists iot.commands (
  id                  uuid primary key default gen_random_uuid(),
  greenhouse_id       smallint not null references iot.greenhouses(id) on delete cascade,
  node_id             smallint not null references iot.nodes(id) on delete cascade,
  type                text not null check (type in ('irrigate','stop')),
  duration_s          smallint check (duration_s between 5 and 120),
  source              text not null default 'manual' check (source in ('manual','schedule')),
  status              text not null default 'awaiting_confirmation'
                        check (status in ('awaiting_confirmation','queued','delivered','executed','rejected','expired','cancelled')),
  requested_by        uuid references iot.app_users(id) on delete set null,
  confirmed_by        uuid references iot.app_users(id) on delete set null,
  created_at          timestamptz not null default now(),
  confirm_expires_at  timestamptz,                                  -- plazo para confirmar (paso 2)
  confirmed_at        timestamptz,
  expires_at          timestamptz,                                  -- plazo para que el nodo la retire
  delivered_at        timestamptz,
  acked_at            timestamptz,
  result_detail       text,
  constraint commands_irrigate_duration check ((type = 'irrigate') = (duration_s is not null))
);
create index if not exists commands_node_status_idx on iot.commands (node_id, status) where status in ('queued','delivered');
create index if not exists commands_gh_created_idx  on iot.commands (greenhouse_id, created_at desc);

-- Calendarios de riego que programa el agrónomo (se evalúan al llegar cada trama del nodo).
create table if not exists iot.schedules (
  id             uuid primary key default gen_random_uuid(),
  greenhouse_id  smallint not null references iot.greenhouses(id) on delete cascade,
  label          text not null default '',
  days           smallint[] not null check (days <@ array[0,1,2,3,4,5,6]::smallint[] and cardinality(days) between 1 and 7),  -- 0 = domingo
  time_local     time not null,                                     -- hora local del predio (America/Santiago)
  duration_s     smallint not null check (duration_s between 5 and 120),
  enabled        boolean not null default true,
  last_run_date  date,                                              -- fecha local de la última ejecución
  created_by     uuid references iot.app_users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists schedules_gh_idx on iot.schedules (greenhouse_id);

-- ---------------------------------------------------------------------
--  Alertas
-- ---------------------------------------------------------------------
create table if not exists iot.alerts (
  id               bigint generated always as identity primary key,
  greenhouse_id    smallint references iot.greenhouses(id) on delete cascade,   -- null = alerta del predio (viento)
  node_id          smallint references iot.nodes(id) on delete cascade,
  type             text not null,
  severity         text not null check (severity in ('info','warning','critical')),
  status           text not null default 'open' check (status in ('open','acknowledged','resolved')),
  message          text not null,
  detail           jsonb not null default '{}'::jsonb,
  opened_at        timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  occurrences      integer not null default 1,
  acknowledged_at  timestamptz,
  acknowledged_by  uuid references iot.app_users(id) on delete set null,
  resolved_at      timestamptz,
  resolved_reason  text check (resolved_reason in ('auto','manual'))
);
-- A lo más una alerta activa por tipo y sector (evita inundar al operador con repeticiones).
create unique index if not exists alerts_one_active_idx
  on iot.alerts ((coalesce(greenhouse_id, 0)), type) where status <> 'resolved';
create index if not exists alerts_status_idx on iot.alerts (status, opened_at desc);

-- ---------------------------------------------------------------------
--  Bitácora de auditoría inmutable, con hash encadenado
-- ---------------------------------------------------------------------
create table if not exists iot.audit_log (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null default clock_timestamp(),
  actor_id     uuid,                                                -- null = sistema o dispositivo
  actor_label  text not null,                                       -- correo, «nodo:I3» o «sistema»
  actor_role   text,
  action       text not null,                                       -- p. ej. auth.login, command.request
  target       text,                                                -- p. ej. greenhouse:3
  detail       jsonb not null default '{}'::jsonb,
  ip           text,
  prev_hash    bytea,
  hash         bytea not null
);
create index if not exists audit_ts_idx     on iot.audit_log (ts desc);
create index if not exists audit_action_idx on iot.audit_log (action, ts desc);

-- Encadena cada registro con el anterior: hash = SHA-256(prev_hash ‖ campos del registro).
create or replace function iot.audit_log_chain() returns trigger
language plpgsql
set search_path = pg_catalog, extensions
as $$
declare
  v_prev bytea;
begin
  -- Serializa las inserciones para que la cadena no se bifurque (bloqueo válido también con el pooler).
  perform pg_advisory_xact_lock(hashtextextended('iot.audit_log', 0));
  select a.hash into v_prev from iot.audit_log a order by a.id desc limit 1;
  new.prev_hash := v_prev;
  new.hash := digest(
    coalesce(v_prev, '\x'::bytea)
    || convert_to(concat_ws('|', new.id::text, extract(epoch from new.ts)::text, coalesce(new.actor_id::text, ''),
                            new.actor_label, coalesce(new.actor_role, ''), new.action,
                            coalesce(new.target, ''), new.detail::text, coalesce(new.ip, '')), 'UTF8'),
    'sha256');
  return new;
end
$$;

drop trigger if exists audit_log_chain_trg on iot.audit_log;
create trigger audit_log_chain_trg before insert on iot.audit_log
  for each row execute function iot.audit_log_chain();

-- Rechaza UPDATE/DELETE/TRUNCATE incluso si alguien con permisos lo intenta.
create or replace function iot.audit_log_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'La bitácora de auditoría es inmutable (% no permitido)', tg_op using errcode = '42501';
end
$$;

drop trigger if exists audit_log_no_update_trg on iot.audit_log;
create trigger audit_log_no_update_trg before update or delete on iot.audit_log
  for each row execute function iot.audit_log_immutable();

drop trigger if exists audit_log_no_truncate_trg on iot.audit_log;
create trigger audit_log_no_truncate_trg before truncate on iot.audit_log
  for each statement execute function iot.audit_log_immutable();

-- Recorre la cadena y devuelve el primer registro cuyo hash no coincide (null = íntegra).
create or replace function iot.verify_audit_chain()
returns table (checked bigint, first_broken_id bigint)
language plpgsql stable
set search_path = pg_catalog, extensions
as $$
declare
  r record;
  v_prev bytea := null;
  v_calc bytea;
  v_count bigint := 0;
begin
  for r in select * from iot.audit_log order by id loop
    v_count := v_count + 1;
    v_calc := digest(
      coalesce(v_prev, '\x'::bytea)
      || convert_to(concat_ws('|', r.id::text, extract(epoch from r.ts)::text, coalesce(r.actor_id::text, ''),
                              r.actor_label, coalesce(r.actor_role, ''), r.action,
                              coalesce(r.target, ''), r.detail::text, coalesce(r.ip, '')), 'UTF8'),
      'sha256');
    if r.prev_hash is distinct from v_prev or r.hash is distinct from v_calc then
      return query select v_count, r.id;
      return;
    end if;
    v_prev := r.hash;
  end loop;
  return query select v_count, null::bigint;
end
$$;

-- ---------------------------------------------------------------------
--  Retención (tabla 12): promedios horarios y borrado de crudos con más de N días.
--  Solo el administrador de la base la ejecuta (npm run db:retention o pg_cron).
-- ---------------------------------------------------------------------
create or replace function iot.compact_readings(retain interval default interval '90 days')
returns table (hours_written bigint, raw_deleted bigint)
language plpgsql
as $$
declare
  v_cut timestamptz := date_trunc('hour', now() - retain);
  v_w bigint;
  v_d bigint;
begin
  insert into iot.readings_hourly as h (node_id, greenhouse_id, hour, n, temp_avg, temp_min, temp_max, hum_air_avg,
                                        soil_raw_avg, soil_pct_avg, light_avg, wind_avg, wind_max, pump_on_frac)
  select r.node_id, max(r.greenhouse_id), date_trunc('hour', r.ts), count(*),
         avg(r.temp_c), min(r.temp_c), max(r.temp_c), avg(r.hum_air),
         avg(r.soil_raw), avg(r.soil_pct), avg(r.light_lux), avg(r.wind_ms), max(r.wind_ms),
         avg(case when r.pump_on then 1.0 else 0.0 end)
    from iot.readings r
   where r.ts < v_cut
   group by r.node_id, date_trunc('hour', r.ts)
  on conflict (node_id, hour) do nothing;
  get diagnostics v_w = row_count;

  delete from iot.readings where ts < v_cut;
  get diagnostics v_d = row_count;
  return query select v_w, v_d;
end
$$;

-- ---------------------------------------------------------------------
--  Permisos: RLS activado en todo + mínimo privilegio para iot_app
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['site_settings','greenhouses','app_users','user_greenhouses','sessions','nodes','node_state',
                           'thresholds','readings','readings_hourly','irrigation_events','commands','schedules',
                           'alerts','audit_log']
  loop
    execute format('alter table iot.%I enable row level security', t);
    execute format('revoke all on iot.%I from public, anon, authenticated', t);
    execute format('drop policy if exists app_all on iot.%I', t);
    execute format('create policy app_all on iot.%I for all to iot_app using (true) with check (true)', t);
  end loop;
end
$$;

revoke all on schema iot from public, anon, authenticated;
grant usage on schema iot to iot_app;

-- Lectura general; escritura solo donde la aplicación la necesita.
grant select on all tables in schema iot to iot_app;
grant insert, update                 on iot.site_settings, iot.greenhouses, iot.thresholds, iot.node_state to iot_app;
grant insert, update                 on iot.nodes, iot.app_users, iot.irrigation_events, iot.commands, iot.alerts to iot_app;
grant insert, update, delete         on iot.sessions, iot.user_greenhouses, iot.schedules to iot_app;
grant insert                         on iot.readings, iot.audit_log to iot_app;       -- la bitácora es solo-agregar
-- readings_hourly y la retención las gestiona el administrador de la base (no la aplicación).

grant usage on all sequences in schema iot to iot_app;

-- Las funciones nacen con EXECUTE para PUBLIC: se cierra y se abre solo lo necesario.
revoke all on function iot.audit_log_chain()      from public, anon, authenticated;
revoke all on function iot.audit_log_immutable()  from public, anon, authenticated;
revoke all on function iot.verify_audit_chain()   from public, anon, authenticated;
revoke all on function iot.compact_readings(interval) from public, anon, authenticated;
grant execute on function iot.verify_audit_chain() to iot_app;

comment on schema iot is 'Sistema IoT de invernaderos (INACAP · Seguridad IoT). Esquema privado: no exponer en la API de Supabase.';
comment on table iot.audit_log is 'Bitácora inmutable con hash SHA-256 encadenado. iot_app solo puede SELECT e INSERT.';
