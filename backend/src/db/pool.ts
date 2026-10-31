import pg from 'pg';
import { config } from '../config.js';
import { log } from '../log.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  log.error('[db] erreur inattendue sur un client inactif', err);
});

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;
