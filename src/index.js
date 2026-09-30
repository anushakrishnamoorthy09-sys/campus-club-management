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

// Explicit server error handler for EADDRINUSE
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or run: netstat -ano | findstr :${PORT}`);
    process.exit(1);
  } else {
    console.error('[SERVER ERROR] Unexpected server error:', err);
    process.exit(1);
  }
});

// Handle graceful shutdown for SIGINT and SIGTERM
const gracefulShutdown = (signal) => {
  console.log(`\n[SERVER] Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    try {
      db.close();
      console.log('[DB] Connection closed cleanly.');
    } catch (e) {
      console.error('[DB ERROR] Error closing database:', e);
    }
    process.exit(0);
  });
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
