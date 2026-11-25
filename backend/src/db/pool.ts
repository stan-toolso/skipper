import pg from 'pg';
import { config } from '../config.js';
import { log } from '../log.js';

// 20 connexions (10 par défaut) : une liste de plusieurs centaines d'objets lance ses chargements groupés en parallèle,
// et deux instances (bleu/vert) restent sous le max_connections de 100 de PostgreSQL.
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

pool.on('error', (err) => {
  log.error('[db] erreur inattendue sur un client inactif', err);
});

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;
