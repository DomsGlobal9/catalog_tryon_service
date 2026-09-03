const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const drapingRoutes = require('./routes/draping');
const discoveryRoutes = require('./modules/discovery/discovery.routes');
const { logBootStatus: logDiscoveryStatus } = require('./modules/discovery/discovery.config');
const { requireServiceKey } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 4005;

// Environment Validation
if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY || !process.env.SERVICE_API_KEY) {
  console.error("FATAL ERROR: Missing required environment variables.");
  process.exit(1);
}

// Security & Logging Middleware
app.use(helmet());
app.use(morgan('combined'));
app.use(cors());

// Health Check (Bypasses Auth)
// Kept deliberately shallow: it must NOT probe Gemini or Serper. The gateway's
// health cron marks a failing environment DISABLED, which 503s the whole slug,
// so a third-party outage here would take the entire service offline.
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Draping AI Microservice is running' });
});

// Protect all API routes with the internal API Key
app.use('/api/', requireServiceKey);

// Design Discovery — mounted BEFORE the 50mb parser so its own 32kb JSON limit
// actually applies. A keyword search has no business accepting megabytes.
app.use('/api/v1/discovery', discoveryRoutes);

// IMPORTANT: Increase payload size limit to 50MB to accept 3-slot Base64 image inputs (Lehenga/Sharara)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// API Routes
app.use('/api/v1/draping', drapingRoutes);

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'Internal Server Error', details: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Draping Catalog Service running on port ${PORT}`);
  console.log(`   - Base64 Zero-Retention Mode Enabled`);
  console.log(`   - Internal API Key Security: ENABLED`);
  console.log(`   - Health Check: http://localhost:${PORT}/health`);
  logDiscoveryStatus();
});

// Graceful Shutdown Handler
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Shutting down gracefully...`);

  // Stop accepting new connections, then actually release the database. The
  // previous version relied on process exit to clean up, which leaves the pool
  // and the Prisma client dangling through a rolling restart.
  server.close(async () => {
    console.log('Express server closed.');
    try {
      if (typeof drapingRoutes.shutdown === 'function') await drapingRoutes.shutdown();
      console.log('Database connections released.');
    } catch (err) {
      console.warn('Shutdown cleanup failed:', err.message);
    }
    process.exit(0);
  });

  // Never hang forever waiting on in-flight generations, which run 90s+.
  const FORCE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 30000);
  setTimeout(() => {
    console.warn(`Forced exit after ${FORCE_MS}ms grace period.`);
    process.exit(1);
  }, FORCE_MS).unref();
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
