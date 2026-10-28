# Privacy and security notes

## What is stored, where

Uploaded files live in `DATA_DIR` on the machine running the app; the profile, extracted CV text, saved jobs and the rest live in your Supabase Postgres database (row-level security on, so the public API key sees nothing). Together:
tailored CV/letter versions, applications, notifications, settings, an audit log. Email credentials are stored only if you
configure email, encrypted with `APP_SECRET`. No website passwords are ever stored: the app never logs into job sites for you.
Only what the app needs is collected (no date of birth, national ID, photo, etc.); fields such as salary expectation or visa
status are optional and stay empty unless you enter them.

## What leaves your machine, and when

| Destination | What | When |
|---|---|---|
| Anthropic (Claude API) | Relevant profile fields + job text (CV pre-fill: extracted CV text) | Only after you consent, only when you use an AI feature |
| Job-source APIs | Search keywords and city names | When a search runs. Never your CV or profile |
| Email provider | Notification title/body (job titles, links) | Only if you enable email |
| An employer site | Your CV/letter | Only when **you** submit, or when you start browser assistance and then submit |

Consent can be withdrawn at any time (Settings → Privacy) and AI calls are then refused. A test guarantees no AI request is
made without consent.

## Controls

- **Access:** `APP_PASSWORD` (constant-time compare, lockout after 10 failures/15 min). The server refuses to listen on a
  network address without a password. Loopback by default.
- **Uploads:** extension allow-list, size limit, content must match the type, random stored names, parsing time/size caps,
  `nosniff` + `attachment` on downloads, stored paths are re-checked to stay inside the upload directory, short-lived (5 min)
  signed links.
- **Secrets:** API keys and credentials stay server-side, never sent to the browser; stored credentials are encrypted and
  write-only. The Content-Security-Policy allows only same-origin scripts and styles.
- **Spreadsheet safety:** CSV export neutralises formula injection from job-supplied text.
- **Applying:** the app never submits without your explicit action; browser assistance never solves CAPTCHAs, logs in, or
  ticks consent boxes; sensitive answers come only from answers you saved; automatic submission exists only as a gated
  pipeline with no real adapters. See the README.
- **Audit trail:** every state-changing request and scheduler run is recorded (what, when, who), never request bodies, CV
  text or credentials. Application events (status changes, submission attempts and outcomes) are kept per application.
- **Your data:** download everything as JSON (credentials excluded) or delete everything (typed confirmation; removes the
  database content, uploaded files, credentials and the audit log).

## Limits you should know about

- Truthfulness checks reduce but cannot eliminate invented claims. Read every CV and letter before sending.
- Single-user: there is no per-row isolation between people because there is only one. Run one instance per person.
- Basic auth is only as safe as the HTTPS in front of it.
- Anything sent to the AI provider is subject to that provider's terms.
