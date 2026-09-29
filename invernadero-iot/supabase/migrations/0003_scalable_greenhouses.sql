-- =====================================================================
--  Migración 0003: invernaderos ESCALABLES
-- =====================================================================
--  Hasta ahora el sistema asumía 10 invernaderos (identificador 1..99, código «I<n>»). Desde esta
--  migración la cantidad no es fija: el administrador da de alta, edita y da de baja invernaderos
--  desde el panel, y el predio (tamaño, subestación, estanque) es configurable.
--
--   * El identificador ya no tiene tope de 99 (smallint admite hasta 32 767).
--   * «Baja lógica»: un invernadero dado de baja conserva TODO su historial (lecturas, riegos,
--     alertas, bitácora) pero deja de aparecer en el panel y su nodo queda deshabilitado. Nada se
--     borra: el rol de la aplicación no tiene DELETE y la bitácora es inmutable.
--   * El código (I1, I2, …) sigue siendo la referencia legible (URL, CSV, tablas). Ahora puede
--     ser cualquier texto corto y único (sin distinguir mayúsculas), p. ej. «Tomates-Norte».
--
--  Es idempotente y se ejecuta dentro de una transacción (scripts/db-migrate.ts).
-- =====================================================================

-- ---------------------------------------------------------------------
--  Invernaderos: sin límite de 99
-- ---------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'iot.greenhouses'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%(id <= 99)%'
  loop
    execute format('alter table iot.greenhouses drop constraint %I', c.conname);
  end loop;
end
$$;

alter table iot.greenhouses drop constraint if exists greenhouses_id_positive;
alter table iot.greenhouses add constraint greenhouses_id_positive check (id > 0);

-- ---------------------------------------------------------------------
--  Baja lógica
-- ---------------------------------------------------------------------
alter table iot.greenhouses add column if not exists archived_at timestamptz;   -- null = activo

comment on column iot.greenhouses.archived_at is
  'Baja lógica: null = activo. El historial se conserva y el nodo queda deshabilitado; se puede reactivar.';

-- ---------------------------------------------------------------------
--  Código legible: formato y unicidad sin distinguir mayúsculas (va en la URL y en el CSV)
-- ---------------------------------------------------------------------
alter table iot.greenhouses drop constraint if exists greenhouses_code_format;
alter table iot.greenhouses add constraint greenhouses_code_format
  check (code ~ '^[A-Za-z][A-Za-z0-9_-]{0,15}$');

create unique index if not exists greenhouses_code_lower_key on iot.greenhouses (lower(code));

-- Datos básicos con límites razonables (defensa en profundidad: la aplicación ya valida lo mismo).
alter table iot.greenhouses drop constraint if exists greenhouses_fields_check;
alter table iot.greenhouses add constraint greenhouses_fields_check check (
      char_length(name) between 1 and 80
  and (crop is null or char_length(crop) between 1 and 60)
  and x_m >= 0 and y_m >= 0
  and (area_m2 is null or area_m2 > 0)
);

-- ---------------------------------------------------------------------
--  Predio configurable: nombre neutro, estanque opcional y tamaños con límites
-- ---------------------------------------------------------------------
alter table iot.site_settings alter column site_name set default 'Predio agrícola';
update iot.site_settings set site_name = 'Predio agrícola' where site_name = 'Predio agrícola · 10 invernaderos';

alter table iot.site_settings add column if not exists tank_x_m numeric(6,1);   -- estanque de agua (opcional)
alter table iot.site_settings add column if not exists tank_y_m numeric(6,1);
-- El predio original del informe tiene el estanque en (76, 56): se conserva como valor inicial.
update iot.site_settings set tank_x_m = 76, tank_y_m = 56
 where id = 1 and tank_x_m is null and tank_y_m is null;

alter table iot.site_settings drop constraint if exists site_settings_dims_check;
alter table iot.site_settings add constraint site_settings_dims_check check (
      char_length(site_name) between 1 and 80
  and width_m  between 20 and 5000
  and height_m between 20 and 5000
  and substation_x_m between 0 and width_m
  and substation_y_m between 0 and height_m
  and (tank_x_m is null) = (tank_y_m is null)
  and (tank_x_m is null or (tank_x_m between 0 and width_m and tank_y_m between 0 and height_m))
);
