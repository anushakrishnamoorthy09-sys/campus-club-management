const fs = require('fs');
const path = require('path');
const db = require('./index');

function initSchema() {
  const schemaPath = path.resolve(process.cwd(), 'db', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found at ${schemaPath}`);
  }

  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  // Disable FK constraints during drop phase
  db.pragma('foreign_keys = OFF');

  // Drop all existing triggers, indexes, views, and tables for clean reset
  const objects = db.prepare(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
  ).all();

  for (const obj of objects) {
    try {
      if (obj.type === 'trigger') {
        db.exec(`DROP TRIGGER IF EXISTS "${obj.name}"`);
      } else if (obj.type === 'view') {
        db.exec(`DROP VIEW IF EXISTS "${obj.name}"`);
      } else if (obj.type === 'table') {
        db.exec(`DROP TABLE IF EXISTS "${obj.name}"`);
      }
    } catch (e) {
      // Ignore cleanup warnings
    }
  }

  // Re-enable mandatory foreign keys
  db.pragma('foreign_keys = ON');

  // Execute clean DDL schema
  db.exec(schemaSql);
  console.log('[DB] Database schema successfully initialized from db/schema.sql');
}

module.exports = { initSchema };

if (require.main === module) {
  initSchema();
}
