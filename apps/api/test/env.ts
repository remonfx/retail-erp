process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://rc_app:rc_app_dev_password@localhost:5432/rc_test';
process.env.DATABASE_OWNER_URL = process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://postgres:postgres@localhost:5432/rc_test';
process.env.VITEST = '1';
