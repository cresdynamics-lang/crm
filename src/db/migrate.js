const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function applySql(client, label, sql) {
  await client.query(sql);
  console.log(`[migrate] applied ${label}`);
}

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const migrationsDir = path.join(__dirname, 'migrations');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applySql(client, 'schema.sql', sql);

    if (fs.existsSync(migrationsDir)) {
      const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files) {
        const migrationSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await applySql(client, `migrations/${file}`, migrationSql);
      }
    }

    await client.query('COMMIT');
    console.log('[migrate] schema applied successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] failed:', err.message);
    process.exitCode = 1;
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrate().catch(() => process.exit(1));
}

module.exports = { migrate };
