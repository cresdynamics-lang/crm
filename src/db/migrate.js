/**
 * Database migrations.
 *
 * schema.sql is the idempotent base schema and runs every time. Files in
 * migrations/ run ONCE each, in name order, and are recorded in
 * schema_migrations with a checksum. A recorded file that has since been
 * edited is reported (never silently re-run): write a new migration instead.
 *
 *   node src/db/migrate.js            apply pending migrations
 *   node src/db/migrate.js --status   list applied / pending, change nothing
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

async function applySql(client, label, sql) {
  await client.query(sql);
  console.log(`[migrate] applied ${label}`);
}

async function migrate({ statusOnly = false } = {}) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const migrationsDir = path.join(__dirname, 'migrations');
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
    const files = fs.existsSync(migrationsDir)
      ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
      : [];

    if (statusOnly) {
      for (const f of files) {
        const sum = sha(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
        const state = !applied.has(f) ? 'PENDING' : applied.get(f) === sum ? 'applied' : 'applied (file changed since!)';
        console.log(`${state.padEnd(30)} ${f}`);
      }
      return;
    }

    await client.query('BEGIN');
    await applySql(client, 'schema.sql', fs.readFileSync(schemaPath, 'utf8'));

    let ran = 0;
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const sum = sha(sql);
      if (applied.has(file)) {
        if (applied.get(file) !== sum) {
          console.warn(`[migrate] WARNING ${file} was edited after it was applied; not re-running. Add a new migration for changes.`);
        }
        continue;
      }
      await applySql(client, `migrations/${file}`, sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, sum]);
      ran += 1;
    }

    await client.query('COMMIT');
    console.log(`[migrate] done: ${ran} new migration(s), ${files.length - ran} already applied`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate] failed:', err.message);
    process.exitCode = 1;
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrate({ statusOnly: process.argv.includes('--status') }).catch(() => process.exit(1));
}

module.exports = { migrate };
