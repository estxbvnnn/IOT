-- 0010 · Flujo de agua (L/min) medido por cada nodo
--
-- El diagrama del proyecto pide tres datos por invernadero: temperatura, humedad y flujo de agua. Se guarda el caudal instantáneo
-- (L/min) que reporta el nodo en el campo `flujo_lmin` de su JSON (sensor de pulsos tipo YF-S201).
--
-- La columna se AÑADE AL FINAL: el servicio «sync» compara las columnas de la base local y de la copia en el mismo orden,
-- así que esta migración debe aplicarse a todas las bases (npm run db:migrate contra cada una).

alter table iot.readings
  add column if not exists flow_lmin real;

alter table iot.node_state
  add column if not exists flow_lmin real;
