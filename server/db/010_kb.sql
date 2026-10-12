-- Knowledge base (workstream KB, migrations 010-019).
-- Codes, articles, playbooks and glossary are global reference data (no tenant).
-- The payer directory is tenant/client scoped. Every row records the dataset
-- version it was loaded from; kb_sources keeps each version's hash and provenance.

CREATE TABLE kb_sources (
  dataset TEXT NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL,
  title TEXT NOT NULL, source TEXT NOT NULL, source_url TEXT, retrieved_at TEXT NOT NULL,
  method TEXT NOT NULL, entry_count INTEGER NOT NULL, coverage TEXT NOT NULL, license TEXT NOT NULL,
  file TEXT NOT NULL, loaded_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (dataset, version)
);

CREATE TABLE kb_codes (
  code_type TEXT NOT NULL CHECK (code_type IN ('carc','rarc','group','claim_status_category','claim_status')),
  code TEXT NOT NULL, dataset TEXT NOT NULL, dataset_version INTEGER NOT NULL,
  description TEXT, description_status TEXT NOT NULL, description_source TEXT,
  start_date TEXT, last_modified_date TEXT, stop_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('current','to_be_deactivated','deactivated','unverified')),
  source_url TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (code_type, code)
);

CREATE TABLE kb_articles (
  article_id TEXT PRIMARY KEY, dataset_version INTEGER NOT NULL, title TEXT NOT NULL,
  summary TEXT NOT NULL, applicability TEXT NOT NULL, review_status TEXT NOT NULL, body TEXT NOT NULL
);

CREATE TABLE kb_playbooks (
  scenario_id TEXT PRIMARY KEY, dataset_version INTEGER NOT NULL, title TEXT NOT NULL,
  review_status TEXT NOT NULL, body TEXT NOT NULL
);

CREATE TABLE kb_glossary (
  term_id TEXT PRIMARY KEY, dataset_version INTEGER NOT NULL, term TEXT NOT NULL,
  definition TEXT NOT NULL, body TEXT NOT NULL
);

CREATE TABLE kb_payers (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, payer_id TEXT NOT NULL,
  dataset_version INTEGER NOT NULL, name TEXT NOT NULL, synthetic INTEGER NOT NULL CHECK (synthetic = 1),
  body TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, payer_id)
);

-- Plain search index used when FTS5 is unavailable; the FTS5 table (kb_fts) is
-- created at load time when the SQLite build supports it.
CREATE TABLE kb_search (
  kind TEXT NOT NULL, ref TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);
