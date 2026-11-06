import pg from 'pg';
import { migrate } from '../src/migrate.js';

export default async function setup() {
  const owner = process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://postgres:postgres@localhost:5432/rc_test';
  const c = new pg.Client({ connectionString: owner });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;');
  await c.end();
  await migrate(owner, () => undefined);
}
