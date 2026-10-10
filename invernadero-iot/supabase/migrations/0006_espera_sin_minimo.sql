-- La espera entre riegos puede ser 0 (sin espera). Antes el mínimo era 60 s.
do $$
declare
  c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'iot.thresholds'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%pump_wait_s%';
  if c is not null then
    execute format('alter table iot.thresholds drop constraint %I', c);
  end if;
  alter table iot.thresholds
    add constraint thresholds_pump_wait_s_check check (pump_wait_s between 0 and 3600);
end $$;
