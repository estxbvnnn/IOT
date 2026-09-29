import type postgres from 'postgres'

/**
 * Conexión a la base. Los servicios reciben un `Db` (conexión normal, transacción o savepoint)
 * en lugar de importar un singleton: así se pueden probar dentro de una transacción con rollback.
 */
export type Db = postgres.Sql<{}>

/** Fila cruda devuelta por postgres.js. */
export type Row = postgres.Row

/**
 * Ejecuta `fn` de forma atómica.
 *  - con una conexión normal abre una transacción (BEGIN … COMMIT);
 *  - si ya se está dentro de una transacción, abre un savepoint (así las funciones que
 *    necesitan atomicidad se pueden componer y probar con rollback).
 */
export async function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const anyDb = db as unknown as { begin?: unknown; savepoint?: unknown }
  if (typeof anyDb.begin === 'function') {
    return (db.begin((tx) => fn(tx as unknown as Db)) as Promise<T>)
  }
  const inTx = db as unknown as postgres.TransactionSql<{}>
  return (inTx.savepoint((tx) => fn(tx as unknown as Db)) as Promise<T>)
}
