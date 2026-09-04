// =============================================================================
// db.js — the single Postgres connection pool and Prisma client.
// =============================================================================
//
// There used to be two independent pools: one in routes/catalogRoutes.js and one
// in services/dbService.js. Each defaults to 10 connections, so the service
// quietly held up to twice the connections it needed against the same database,
// and only one of them had timeouts configured. Postgres connection limits are
// a shared resource - on a small managed instance that is a real ceiling.
//
// Everything now shares this one pool, with explicit limits.
//
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  // Without these a slow database holds connections open indefinitely and gives
  // no signal when the pool is exhausted - the request simply hangs.
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECT_MS || 10000)
});

pool.on('error', (err) => {
  // An idle client erroring must not take the process down.
  console.error('[db] idle client error:', err.message);
});

const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

/** Release everything on shutdown. Safe to call more than once. */
let closed = false;
async function close() {
  if (closed) return;
  closed = true;
  try { await prisma.$disconnect(); } catch (e) { console.warn('[db] prisma disconnect:', e.message); }
  try { await pool.end(); } catch (e) { console.warn('[db] pool end:', e.message); }
}

module.exports = { pool, prisma, close };
