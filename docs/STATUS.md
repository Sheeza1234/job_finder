# Project status and test coverage

What is implemented, how it is verified, and what is **not** verified. Nothing below is claimed to work unless a test or
a documented manual check exercised it.

## Phases

| Phase | Scope | State |
|---|---|---|
| 1 | Architecture, access control, schema + migrations, candidate profile, CV upload | Done. Single-user; one app password (no multi-user auth, see *Deviations*). |
| 2 | Source connectors, manual URL/paste import, search, **de-duplication**, filters | Done. Three connectors (Remotive, Jooble, JSearch) tested against mocked responses only. |
| 3 | AI job analysis, match scoring, missing skills, recommendations | Done. Keyword scoring tested exactly; AI analysis tested with mock AI only. |
| 4 | CV parsing, tailored CV, cover letters, versions, editing, PDF/DOCX | Done, tested with mock AI. PDF is Latin-only. |
| 5 | Saved jobs, tracker, status history, notes, reminders | Done. |
| 6 | Browser-assisted apply with human review | Mode A and B done. B tested only on a local fixture form. **Mode C has no real adapter**: no site is known to permit automated applications. The gated pipeline is tested with a mock adapter. |
| 7 | Scheduled search, notifications, dashboard, preferences | Done. In-process scheduler; email tested against a local fake provider and a stub SMTP transport. |
| 8 | Security review, tests, deployment, docs, readiness | Done except where noted under *Not verified*. |

## Requirement to test map

| Required test area | Where |
|---|---|
| Authentication and authorization | `auth.test.js`, `dashboard.test.js` (login lockout), `quality.test.js` (**every** registered route returns 401 without credentials, except `/healthz`) |
| User data isolation | Single-user by design, so isolation means containment: `quality.test.js` (tampered file reference cannot read/delete outside the upload dir), `dashboard.test.js` (export excludes credentials, full deletion), demo/production separation in `foundation.test.js` |
| Job de-duplication | `foundation.test.js` (cross-source, URL, merge, no double notification, legacy-DB backfill) |
| Match-score calculations | `quality.test.js` (exact weighted results), `grounding.test.js` |
| CV parsing and export | `quality.test.js` (AI output normalisation, real PDF/DOCX text extraction), `versions.test.js` (PDF/DOCX parsed back and compared) |
| Truthfulness safeguards | `grounding.test.js`, `versions.test.js` |
| Missing required qualifications | `quality.test.js`, `versions.test.js` (gaps), `grounding.test.js` |
| Application status transitions | `quality.test.js` (full history), `tracker.test.js` |
| Duplicate application prevention | `tracker.test.js`, `autosubmit.test.js` |
| File upload validation | `dashboard.test.js` (content must match type), `api.test.js`, `quality.test.js` (size limit) |
| API error handling | `quality.test.js` (bad JSON, 404s, 413, provider 502/500, internals never leaked) |
| Scheduler | `scheduler.test.js`, `foundation.test.js` |
| Browser workflows in a safe environment | `assist.test.js` (headless Chrome on a local form, asserts the form is never submitted), `autosubmit.test.js` (mock adapter) |
| UI behaviour and accessibility | `ui.test.js` (headless Chrome: onboarding, demo mode, dialogs, labels, mobile overflow, error state) |

**Safety net:** `tests/setup.js` makes every test process refuse any non-loopback `fetch`, so no test can reach a real job
API, the AI provider, an employer site or an email provider, and therefore can never submit a real application.
AI is always a mock in tests.

## Not verified (be sceptical of these)

- **CV auto-fill** was exercised once against the live model with a fictional PDF (all fields correct); varied real-world CV layouts, other languages and scanned files are untested.
- **Real AI output quality.** Prompts and safeguards are tested; the model's actual tailoring/analysis has not been
  evaluated. Run it on a real job and read the result.
- **Live job-source APIs** (Remotive, Jooble, JSearch): response mapping is tested against sample payloads; quotas,
  rate limits and format changes are unknown. Use *Settings → Integration status → Test* with your keys.
- **A real email provider** (Resend/SMTP). Tested against local stand-ins.
- **Any real employer site** for Mode B. Field matching is heuristic and will miss or mis-read some forms; it never
  submits, and lists everything it did not fill.
- **Docker:** the image builds and was run: unsafe bind refused, password enforced, non-root, healthy, data persists across restart, host-network variant reaches a local OmniRoute. Not tested: a TLS reverse proxy in front, or Docker on macOS/Windows.
- **AI gateway (OmniRoute):** connectivity and error handling were verified against a running instance with a deliberately wrong key; a successful completion has **not** been verified because no gateway key was supplied (see SETUP.md). The `anthropic` protocol through a gateway is tested against mocks only.
- Windows/macOS. Developed and tested on Linux with Node 20.
- Arabic text in PDF export (unsupported by design), and right-to-left layout of the UI beyond `dir="auto"` on job text.

## Deviations from the generic spec

The repository already had an established stack (Node/Express, SQLite, vanilla JS), so it was extended rather than
rewritten as Next.js/Supabase. Consequences: no Supabase Auth/Storage/RLS and no Supabase setup instructions (they would
be inaccurate); no multi-user model; in-process scheduler instead of an external queue; an Express API instead of server
actions. Moving to Supabase would be a migration project (schema port, auth, storage, RLS policies), not a configuration.
