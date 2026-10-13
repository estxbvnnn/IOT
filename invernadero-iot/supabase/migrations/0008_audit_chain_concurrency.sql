-- =====================================================================
--  Migración 0008: la cadena de hashes de la bitácora soporta escrituras CONCURRENTES
-- =====================================================================
--  Defecto (migración 0001): el trigger toma `pg_advisory_xact_lock` y luego busca el «último registro» con `order by id desc`,
--  pero el id (columna identity) se asigna ANTES de ejecutar el trigger. Con dos transacciones simultáneas A (id 311) y B (id 312):
--  si B obtiene el bloqueo primero, A después ve como «último» a B (312 > 311) y la cadena se bifurca (311 y el siguiente cuelgan
--  del mismo padre). `verify_audit_chain()` recorre por id y acusa una alteración que no existe. Se vio al presentarse 10 nodos a
--  la vez («device.first_seen» en el mismo milisegundo).
--  Corrección: el id se asigna DENTRO del bloqueo (con una secuencia propia), de modo que el orden de los ids es el orden real de la
--  cadena. Si el INSERT trae un id explícito (> 0), se respeta: así la copia a Supabase y el arranque inicial conservan los ids.
--  Los registros ya escritos no se tocan (si una cadena ya estaba bifurcada, esa marca histórica queda: es un hecho, no se reescribe).
--  Idempotente.
-- =====================================================================

do $$
declare
  v_next bigint;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'iot' and table_name = 'audit_log' and column_name = 'id' and is_identity = 'YES') then
    select coalesce(max(id), 0) + 1 into v_next from iot.audit_log;
    alter table iot.audit_log alter column id drop identity;                       -- elimina la secuencia implícita
    execute format('create sequence if not exists iot.audit_log_id_seq as bigint start with %s owned by iot.audit_log.id', v_next);
    alter table iot.audit_log alter column id set default 0;                       -- 0 = «lo asigna el trigger dentro del bloqueo»
  end if;
end
$$;

create or replace function iot.audit_log_chain() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_prev bytea;
begin
  -- Serializa las inserciones para que la cadena no se bifurque (bloqueo válido también con el pooler).
  perform pg_advisory_xact_lock(hashtextextended('iot.audit_log', 0));
  -- El id se toma AQUÍ, ya dentro del bloqueo: orden de ids = orden de la cadena. Un id explícito (> 0) se conserva.
  if new.id is null or new.id = 0 then
    new.id := nextval('iot.audit_log_id_seq');
  end if;
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

revoke all on function iot.audit_log_chain() from public, anon, authenticated;
