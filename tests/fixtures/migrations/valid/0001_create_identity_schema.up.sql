-- migration: 0001_create_identity_schema
-- direction: up
-- owner: kernel_identity

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_identity;

CREATE TABLE IF NOT EXISTS kernel_identity.person (
  id         uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS person_created_at_idx ON kernel_identity.person (created_at);

COMMIT;
