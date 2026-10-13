-- =====================================================================
--  Migración 0007: claves de API y estado de la sincronización con Supabase
--  Solo se usa en la base LOCAL de la Raspberry Pi (la copia en Supabase no la necesita).
-- =====================================================================
--  * iot.api_keys: claves para consumir la API REST (/api/v1) sin iniciar sesión. Cada clave pertenece a un
--    usuario y actúa con SU rol y alcance (mismos permisos que en la interfaz). Se guarda solo el SHA-256.
--  * iot.sync_state: hasta qué punto se copió cada tabla a Supabase (lo usa el servicio «sync»).
--  Idempotente.
-- =====================================================================

create table if not exists iot.api_keys (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(name) between 1 and 80),
  user_id       uuid not null references iot.app_users(id) on delete cascade,
  token_hash    bytea not null unique,                     -- SHA-256 de la clave; la clave en claro se muestra una sola vez
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz                                -- null = vigente
);
create index if not exists api_keys_user_idx on iot.api_keys (user_id);

create table if not exists iot.sync_state (
  name         text primary key,                           -- tabla copiada (p. ej. 'readings')
  last_id      bigint not null default 0,                  -- último id copiado (tablas de solo agregar)
  last_run_at  timestamptz,
  last_ok_at   timestamptz,
  last_error   text
);

do $$
declare
  t text;
begin
  foreach t in array array['api_keys','sync_state']
  loop
    execute format('alter table iot.%I enable row level security', t);
    execute format('revoke all on iot.%I from public, anon, authenticated', t);
    execute format('drop policy if exists app_all on iot.%I', t);
    execute format('create policy app_all on iot.%I for all to iot_app using (true) with check (true)', t);
  end loop;
end
$$;

grant select, insert, update on iot.api_keys, iot.sync_state to iot_app;   -- sin DELETE: una clave se revoca, no se borra

comment on table iot.api_keys is 'Claves de la API REST /api/v1: cada una actúa con el rol y alcance de su usuario. Solo se guarda el SHA-256.';
comment on table iot.sync_state is 'Avance de la copia a Supabase por tabla (servicio sync de la Raspberry Pi).';
