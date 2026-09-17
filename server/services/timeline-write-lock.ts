import type { PoolClient } from 'pg';

export type TimelineLockScope = 'housekeeping' | 'office' | 'logistics';

async function lockWithKey(client: PoolClient, key: string): Promise<void> {
  // Chi prende il lock deve chiudere la transazione entro questo timeout: oltre,
  // le scritture in attesa iniziano a fallire. Il timeout e volutamente corto
  // perche' chi aspetta occupa una connessione del pool, e una coda lunga
  // bloccherebbe anche le letture.
  await client.query("SET LOCAL lock_timeout = '20s'");
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
}

/**
 * Serializza le scritture della timeline per (giorno, scope).
 *
 * Senza lock due scritture concorrenti si sovrappongono: chi cancella le righe
 * del giorno non vede quelle appena inserite dall'altra transazione (snapshot
 * READ COMMITTED), quindi non le rimuove e le due scritture si sommano.
 *
 * Ogni transazione che scrive sulla timeline deve prenderlo subito dopo il BEGIN.
 * La chiave si costruisce solo da qui: chiavi diverse non si escludono a vicenda,
 * quindi duplicare il formato altrove disattiverebbe il lock in silenzio.
 */
export async function acquireTimelineWriteLock(
  client: PoolClient,
  workDate: string,
  scope: TimelineLockScope
): Promise<void> {
  const key =
    scope === 'logistics'
      ? `lg_timeline:${workDate}`
      : `daily_assignments:${workDate}:${scope}`;
  await lockWithKey(client, key);
}

/**
 * Stesso meccanismo per i containers, che vengono riscritti con lo stesso schema
 * "cancella il giorno e reinserisci".
 *
 * La chiave e separata da quella della timeline: sono tabelle diverse, e un
 * refresh dei containers non deve bloccare i salvataggi della timeline.
 */
export async function acquireContainersWriteLock(
  client: PoolClient,
  workDate: string,
  scope: 'housekeeping' | 'office'
): Promise<void> {
  await lockWithKey(client, `daily_containers:${workDate}:${scope}`);
}
