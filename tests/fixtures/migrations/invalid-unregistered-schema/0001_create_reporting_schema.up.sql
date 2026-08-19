-- migration: 0001_create_reporting_schema
-- direction: up
-- owner: module_reporting
--
-- `module_reporting` maps to no unit in platform/architecture/manifest.ts.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_reporting;

CREATE TABLE IF NOT EXISTS module_reporting.daily_totals (
  day date NOT NULL,
  CONSTRAINT daily_totals_pkey PRIMARY KEY (day)
);

COMMIT;
