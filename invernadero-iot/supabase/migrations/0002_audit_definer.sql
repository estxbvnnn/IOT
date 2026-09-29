-- =====================================================================
--  Migración 0002: la cadena de hashes de la bitácora debe funcionar para el rol de la app
-- =====================================================================
--  Problema detectado al probar con el rol real (iot_app): las funciones que calculan el hash usan
--  digest() de pgcrypto, que vive en el esquema «extensions», y iot_app no tiene USAGE sobre él.
--  Solución: ejecutarlas con los privilegios de su dueño (SECURITY DEFINER) en lugar de ampliar los
--  permisos de iot_app. Es seguro porque:
--    * ambas fijan su propio search_path (pg_catalog, extensions), sin depender del del llamador;
--    * el trigger solo calcula el hash de la fila que se inserta;
--    * verify_audit_chain() solo lee lo que iot_app ya puede leer (SELECT sobre la bitácora).
-- =====================================================================

alter function iot.audit_log_chain()    security definer;
alter function iot.verify_audit_chain() security definer;

-- Reafirma que nadie más puede invocarlas directamente.
revoke all on function iot.audit_log_chain()    from public, anon, authenticated;
revoke all on function iot.verify_audit_chain() from public, anon, authenticated;
grant execute on function iot.verify_audit_chain() to iot_app;
