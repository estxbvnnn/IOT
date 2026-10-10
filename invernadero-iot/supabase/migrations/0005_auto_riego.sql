-- Riego automático activable/desactivable por invernadero.
-- true (por defecto) = el nodo riega solo según los umbrales; false = el nodo NO inicia riegos automáticos
-- (el riego manual, los calendarios y «detener» siguen funcionando). Viaja al nodo en «cfg.auto».
alter table iot.thresholds add column if not exists auto_enabled boolean not null default true;
