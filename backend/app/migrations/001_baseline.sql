-- Schema for Supabase Postgres. Single-user app: `profile` holds exactly one row (id = 1).

CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE documents (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL,              -- cv | portfolio | certificate | project | other
  filename TEXT NOT NULL,
  mime TEXT,
  stored_name TEXT NOT NULL,
  text TEXT,
  is_master BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE jobs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL,
  company TEXT,
  city TEXT,
  country TEXT,
  location_text TEXT,
  description TEXT,
  employment_type TEXT,            -- full_time | part_time | contract | internship | unknown
  work_mode TEXT,                  -- remote | hybrid | onsite | unknown
  remote_eligibility TEXT,         -- worldwide | restricted | unknown (remote jobs only)
  industry TEXT,
  experience_level TEXT,           -- entry | mid | senior | lead | unknown
  salary_min DOUBLE PRECISION,
  salary_max DOUBLE PRECISION,
  salary_currency TEXT,
  posted_at TIMESTAMPTZ,
  sponsorship TEXT NOT NULL DEFAULT 'not_specified',   -- yes | no | not_specified
  relocation TEXT NOT NULL DEFAULT 'not_specified',
  skills JSONB NOT NULL DEFAULT '[]',
  fetched_at TIMESTAMPTZ NOT NULL,
  discovered_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  dedupe_key TEXT,                 -- same employer+title+city from two sources is one job
  duplicate_of INTEGER,
  UNIQUE (source, external_id)
);
CREATE INDEX idx_jobs_city ON jobs(city);
CREATE INDEX idx_jobs_posted ON jobs(posted_at);
CREATE INDEX idx_jobs_dedupe ON jobs(dedupe_key);

CREATE TABLE analyses (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  method TEXT NOT NULL,            -- heuristic | ai
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE applications (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'saved',
  notes TEXT NOT NULL DEFAULT '',
  applied_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  cv_version_id INTEGER,
  letter_version_id INTEGER,
  follow_up_date TEXT,             -- YYYY-MM-DD as typed by the user
  interview_dates JSONB NOT NULL DEFAULT '[]',
  recruiter JSONB NOT NULL DEFAULT '{}',
  confirmation TEXT,
  submission_source TEXT,          -- self_reported | site_confirmed
  submission_log JSONB NOT NULL DEFAULT '[]',
  allow_duplicate BOOLEAN NOT NULL DEFAULT false,
  checklist JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE cv_versions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  parent_id INTEGER,
  origin TEXT NOT NULL,                  -- ai | edit
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | approved
  content JSONB NOT NULL,
  changes JSONB NOT NULL DEFAULT '[]',
  gaps JSONB NOT NULL DEFAULT '[]',
  keywords JSONB NOT NULL DEFAULT '[]',
  warnings JSONB NOT NULL DEFAULT '[]',
  profile_snapshot JSONB NOT NULL,       -- facts frozen at generation; later profile edits never change an approved CV
  created_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ
);
CREATE INDEX idx_cv_job ON cv_versions(job_id);

CREATE TABLE cover_letters (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  language TEXT NOT NULL DEFAULT 'en',
  text TEXT NOT NULL,
  warnings JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ
);
CREATE INDEX idx_letter_job ON cover_letters(job_id);

CREATE TABLE settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);

CREATE TABLE notifications (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL,                    -- new_matches | follow_up | interview | expiring | system
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  dedupe_key TEXT UNIQUE,                -- the same event never notifies twice
  created_at TIMESTAMPTZ NOT NULL,
  read_at TIMESTAMPTZ,
  emailed_at TIMESTAMPTZ,
  email_error TEXT
);
CREATE INDEX idx_notif_unread ON notifications(read_at, created_at);

CREATE TABLE audit_logs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL,                   -- user | scheduler | system
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'     -- never contains CV text, credentials or request bodies
);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_at ON audit_logs(at);

-- SECURITY (Supabase): every table in `public` is reachable through Supabase's REST API with the public anon key
-- unless row-level security is on. This app talks to Postgres directly (the `postgres` role bypasses RLS), so we turn
-- RLS on with NO policies: the REST API sees nothing, and your CV and applications stay private.
ALTER TABLE profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cv_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cover_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Belt and braces: also remove table privileges from Supabase's public API roles when they exist.
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
    END IF;
  END LOOP;
END $$;
