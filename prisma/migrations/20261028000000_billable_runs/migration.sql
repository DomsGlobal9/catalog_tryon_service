-- Billable runs: one row per fully delivered catalog / colour variant run.
-- NEW TABLE ONLY. Nothing existing is altered; no enum is created or changed
-- (kind is plain text).
--
-- This service has no Prisma migration history (its schema was pushed), so this
-- file is applied by hand, once, before the code that writes it is deployed:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261028000000_billable_runs/migration.sql
-- It is safe to run twice.

CREATE TABLE IF NOT EXISTS "se_catalog"."billable_runs" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "colour_name" TEXT,
    "colour_hex" TEXT,
    "garment_ref" TEXT,
    "views" INTEGER NOT NULL,
    "drape_job_id" TEXT,
    "gateway_request_id" TEXT,
    "delivered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billable_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "billable_runs_client_id_delivered_at_idx" ON "se_catalog"."billable_runs"("client_id", "delivered_at");

CREATE UNIQUE INDEX IF NOT EXISTS "billable_runs_client_id_request_key_key" ON "se_catalog"."billable_runs"("client_id", "request_key");
