import pg from 'pg';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://pp:pp@localhost:5432/pp',
  max: Number(process.env.PG_POOL_MAX || 10),
});

export const q = (text, params) => pool.query(text, params);

// Run fn inside a transaction with a dedicated client.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
