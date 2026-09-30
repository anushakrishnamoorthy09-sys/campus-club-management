const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const expressLayouts = require('express-ejs-layouts');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { loadUserSession, enforceProfileCompletion } = require('./middleware/auth');
const { passport } = require('./config/passport');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const clubRoutes = require('./routes/clubRoutes');
const timetableRoutes = require('./routes/timetableRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const eventRoutes = require('./routes/eventRoutes');
const facultyApprovalRoutes = require('./routes/facultyApprovalRoutes');
const adminEventRoutes = require('./routes/adminEventRoutes');
const studentRoutes = require('./routes/studentRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const certificateRoutes = require('./routes/certificateRoutes');
const badgeRoutes = require('./routes/badgeRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');

const app = express();

// Passport Initialization (session: false)
app.use(passport.initialize());

// 1. Security Headers (Helmet) with CSP configured for EJS, Tailwind CDN & Chart.js CDN
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"]
      }
    }
  })
);

// 2. Global Rate Limiter for DDoS protection
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again later.' }
});
app.use(globalLimiter);

// 3. Cookie Parser & Body Parsers
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 4. Load User Session from Stateless JWT Cookie & Enforce Complete Profile
app.use(loadUserSession);
app.use(enforceProfileCompletion);

// 5. Static Files
app.use(express.static(path.join(__dirname, 'public')));

// 6. Templating Engine (EJS + Shared Layout)
app.use(expressLayouts);
app.set('layout', 'layouts/main');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 7. Mount Authentication, Admin, Club, Timetable & Dashboard Routes
app.use('/', authRoutes);
app.use('/', adminRoutes);
app.use('/', clubRoutes);
app.use('/', timetableRoutes);
app.use('/', dashboardRoutes);
app.use('/', eventRoutes);
app.use('/', facultyApprovalRoutes);
app.use('/', adminEventRoutes);
app.use('/', studentRoutes);
app.use('/', notificationRoutes);
app.use('/', certificateRoutes);
app.use('/', badgeRoutes);
app.use('/', analyticsRoutes);

// 8. Base & Health Routes
app.get('/', (req, res) => {
  res.render('index', { title: 'CampusClubOS - Home' });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    system: 'CampusClubOS',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// 9. 404 Not Found Handler
app.use((req, res, next) => {
  res.status(404);
  if (req.accepts('html')) {
    return res.render('404', { title: '404 - Page Not Found' });
  }
  res.json({ error: 'Resource Not Found' });
});

// 10. Global Error Handler (Never leaks stack traces in production)
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  console.error(`[SYSTEM ERROR ${statusCode}]:`, err.message);

  if (statusCode === 403) {
    res.status(403);
    if (req.accepts('html')) {
      return res.render('403', { title: '403 - Forbidden' });
    }
    return res.json({ error: 'Access Forbidden' });
  }

  res.status(statusCode);

  const errorPayload = {
    message: statusCode === 500 && process.env.NODE_ENV === 'production'
      ? 'An internal server error occurred.'
      : err.message,
    error: process.env.NODE_ENV === 'production' ? null : err
  };

  if (req.accepts('html')) {
    return res.render('error', {
      title: `${statusCode} - Server Error`,
      ...errorPayload
    });
  }

  res.json(errorPayload);
});

module.exports = app;
