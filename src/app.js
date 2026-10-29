const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { errorHandler, notFound } = require('./lib/errors');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const leadsRoutes = require('./routes/leads');
const clientsRoutes = require('./routes/clients');
const projectsRoutes = require('./routes/projects');
const invoicesRoutes = require('./routes/invoices');
const paymentsRoutes = require('./routes/payments');
const expensesRoutes = require('./routes/expenses');
const salariesRoutes = require('./routes/salaries');
const notificationsRoutes = require('./routes/notifications');
const messagesRoutes = require('./routes/messages');
const reportsRoutes = require('./routes/reports');
const queryRoutes = require('./routes/query');
const healthRoutes = require('./routes/health');
const siteAnalyticsRoutes = require('./routes/siteAnalytics');
const adminHealthRoutes = require('./routes/adminHealth');
const settingsRoutes = require('./routes/settings');
const salesRoutes = require('./routes/sales');
const emailsRoutes = require('./routes/emails');
const directorRoutes = require('./routes/director');
const tasksRoutes = require('./routes/tasks');
const developerRoutes = require('./routes/developer');
const financeRoutes = require('./routes/finance');
const hrRoutes = require('./routes/hr');
const pmRoutes = require('./routes/pm');
const adminRoutes = require('./routes/admin');
const clientPortalRoutes = require('./routes/client');
const searchRoutes = require('./routes/search');
const exportRoutes = require('./routes/export');
const inviteRoutes = require('./routes/invites');
const leaveRoutes = require('./routes/leave');
const assignmentRoutes = require('./routes/assignments');
const auditRoutes = require('./routes/audit');
const opsRoutes = require('./routes/ops');
const salaryFundingRoutes = require('./routes/salaryFunding');
const adminInboxRoutes = require('./routes/adminInbox');
const attendanceRoutes = require('./routes/attendance');
const approvalsRoutes = require('./routes/approvals');
const jarvisRoutes = require('./routes/jarvis');
const { fileAccess } = require('./middleware/fileAccess');
const meetingsRoutes = require('./routes/meetings');

/** Allowed browser origins: CORS_ORIGINS (comma separated), else the public URL; localhost in development. */
const allowedOrigins = (process.env.CORS_ORIGINS || process.env.PUBLIC_APP_URL || 'https://cresos.cresdynamics.com,https://crm.cresdynamics.com')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);
function corsOrigin(origin, cb) {
  if (!origin) return cb(null, true); // same-origin requests and server-to-server calls
  const ok =
    allowedOrigins.includes(origin.replace(/\/+$/, '')) ||
    (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return cb(null, ok);
}

function createApp() {
  const app = express();
  const publicDir = path.join(__dirname, '..', 'public');
  const uploadsDir = path.join(__dirname, '..', 'uploads');

  // Content-Security-Policy: scripts only from this site (no inline, no eval),
  // so injected markup cannot run code even if a bug lets it through.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      crossOriginEmbedderPolicy: false,
    })
  );
  // CORS: only our own site(s) may call the API from a browser.
  app.use(cors({ origin: corsOrigin, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  // Brand assets must load in downloaded invoice HTML / email clients
  app.use(
    '/brand',
    express.static(path.join(publicDir, 'brand'), {
      setHeaders(res) {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
      },
    })
  );

  // Per-domain API groups
  app.use('/api/health', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/leads', leadsRoutes);
  app.use('/api/clients', clientsRoutes);
  app.use('/api/projects', projectsRoutes);
  app.use('/api/invoices', invoicesRoutes);
  app.use('/api/payments', paymentsRoutes);
  app.use('/api/expenses', expensesRoutes);
  app.use('/api/salaries/funding', salaryFundingRoutes);
  app.use('/api/salaries', salariesRoutes);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/messages', messagesRoutes);
  app.use('/api/reports', reportsRoutes);
  app.use('/api/query', queryRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/sales', salesRoutes);
  app.use('/api/analytics', siteAnalyticsRoutes);
  app.use('/api/admin/health', adminHealthRoutes);
  app.use('/api/emails', emailsRoutes);
  app.use('/api/director', directorRoutes);
  app.use('/api/tasks', tasksRoutes);
  app.use('/api/developer', developerRoutes);
  app.use('/api/finance', financeRoutes);
  app.use('/api/hr', hrRoutes);
  app.use('/api/pm', pmRoutes);
  app.use('/api/admin/inbox', adminInboxRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/client', clientPortalRoutes);
  app.use('/api/search', searchRoutes);
  app.use('/api/export', exportRoutes);
  app.use('/api/invites', inviteRoutes);
  app.use('/api/leave', leaveRoutes);
  app.use('/api/assignments', assignmentRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/ops', opsRoutes);
  app.use('/api/attendance', attendanceRoutes);
  app.use('/api/approvals', approvalsRoutes);
  app.use('/api/jarvis', jarvisRoutes);
  app.use('/api/meetings', meetingsRoutes);

  // Uploaded files need a signed-in user (file cookie set at sign-in; see fileAccess).
  app.use('/uploads', fileAccess, express.static(uploadsDir, { fallthrough: false }));

  // Shared shell faces (Step 2)
  app.get('/', (_req, res) => res.redirect('/login'));
  app.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));
  app.get('/dashboard', (_req, res) => res.sendFile(path.join(publicDir, 'app.html')));
  app.get(['/meetings', '/meeting/:id'], (_req, res) => res.sendFile(path.join(publicDir, 'meeting.html')));
  app.get('/inbox', (_req, res) => res.sendFile(path.join(publicDir, 'inbox.html')));
  app.get('/app', (_req, res) => res.redirect('/dashboard'));

  app.use(
    express.static(publicDir, {
      setHeaders(res, filePath) {
        if (/\.(js|css|html)$/i.test(filePath)) {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
      },
    })
  );

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
