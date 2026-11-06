-- 0009 · Origen y ruta de cada trama (malla ESP-NOW) + JSON ajeno
--
-- Una trama puede llegar directa (HTTP/MQTT) o reenviada por otro nodo de la malla (ESP-NOW). Se guarda:
--   transport  cómo llegó a la pasarela: 'mqtt' | 'http' | 'espnow'
--   via        id del nodo que la subió en nombre del origen (null = directa)
--   hops       saltos por radio hasta llegar a un nodo con red (0 = directa)
--   boot       número de arranque del nodo (con `seq` identifica la trama)
--   extra      campos del JSON que el dashboard no conoce, tal cual llegaron
--   raw        (node_state) el último JSON recibido completo
--
-- Las columnas se AÑADEN AL FINAL y en este orden: el servicio «sync» compara las columnas de la base local y de Supabase
-- en orden, así que esta migración debe aplicarse a LAS DOS bases (npm run db:migrate contra cada una).

alter table iot.readings
  add column if not exists boot      bigint,
  add column if not exists via       text,
  add column if not exists hops      smallint,
  add column if not exists transport text,
  add column if not exists extra     jsonb;

alter table iot.node_state
  add column if not exists via       text,
  add column if not exists hops      smallint,
  add column if not exists transport text,
  add column if not exists raw       jsonb;
