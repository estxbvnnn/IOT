-- Rol «superadmin»: cuenta de pruebas con todos los permisos del administrador y sin las salvaguardas de
-- proceso del servidor (confirmación en dos pasos del riego, tope de duración, bloqueo por orden en curso).
-- Solo amplía la lista de roles válidos; no toca datos.
do $$
declare
  c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'iot.app_users'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%role%';  -- Postgres guarda «in (...)» como «= any (array[...])»
  if c is not null then
    execute format('alter table iot.app_users drop constraint %I', c);
  end if;
  alter table iot.app_users
    add constraint app_users_role_check
    check (role in ('owner','admin','agronomist','operator','technician','superadmin'));
end $$;
