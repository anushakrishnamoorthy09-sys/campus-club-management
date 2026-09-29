require('dotenv').config();
const app = require('./app');
const db = require('./db/index');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`CAMPUSCLUBOS SERVER STARTED SUCCESSFULLY`);
  console.log(`URL: http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Database Path: ${process.env.DB_PATH || 'campus_club_os.db'}`);
  console.log('====================================================');
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[SERVER] Shutting down gracefully...');
  server.close(() => {
    try {
      db.close();
      console.log('[DB] Connection closed.');
    } catch (e) {
      console.error('[DB ERROR] Error closing database:', e);
    }
    process.exit(0);
  });
});
