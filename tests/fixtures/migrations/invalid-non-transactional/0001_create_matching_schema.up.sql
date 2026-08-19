-- migration: 0001_create_matching_schema
-- direction: up
-- owner: module_matching
--
-- No BEGIN/COMMIT: a failure partway through leaves the schema in a state no rollback describes.

CREATE SCHEMA IF NOT EXISTS module_matching;

CREATE TABLE IF NOT EXISTS module_matching.candidate (
  id uuid NOT NULL,
  CONSTRAINT candidate_pkey PRIMARY KEY (id)
);
