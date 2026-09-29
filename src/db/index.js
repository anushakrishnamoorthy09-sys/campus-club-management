const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const dbPath = process.env.DB_PATH 
  ? path.resolve(process.cwd(), process.env.DB_PATH)
  : path.resolve(process.cwd(), 'campus_club_os.db');

// Create or open SQLite database connection
const db = new Database(dbPath, {
  verbose: process.env.NODE_ENV === 'development' ? null : null
});

// MANDATORY RULE: Foreign Key enforcement MUST be enabled on every connection
db.pragma('foreign_keys = ON');

module.exports = db;
