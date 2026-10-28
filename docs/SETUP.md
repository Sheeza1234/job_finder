# Setup and local development

Requires **Node 20+**. Chrome/Chromium is optional (only for browser-assisted applying, Mode B).

```bash
npm install
cp .env.example .env      # then edit
npm start                 # http://127.0.0.1:3000
```

The app listens on **loopback only** by default. Open it from the same computer.

## First run

The top bar has: **Home, My profile, Jobs, My CVs, My applications, Job preferences, Settings**. Home always shows the one next step.

1. The dashboard shows a **Get started** guide. Each step is checked against your real data (it never trusts a tick-box).
2. **Upload your CV** (PDF or DOCX; **CV Studio** or **Documents**). The app reads it and **fills your Profile automatically**
   (contact details, headline, skills, experience, education, certifications, languages). A dialog lists what was filled and
   what is still missing.
3. Open **Profile**: only the missing fields are highlighted. Add them by hand, and correct anything the reading got wrong.
   Everything stays editable. Auto-fill never overwrites something you typed, and **Undo auto-fill** restores your previous
   profile exactly. Re-reading a CV later only fills empty fields.
4. Set **Search Settings**, then add jobs: fetch from a configured source, or paste a posting URL/text (**Jobs → Add job**).
5. Optional: enable AI and notifications (below).

Want to look around first? **Settings → Try demo mode** loads clearly labelled sample listings (`[DEMO]`, "(demo)", no apply
link). They are never mixed with real data and are deleted when you leave demo mode.

## Configuration

All settings are environment variables (see `.env.example`).

| Variable | Purpose |
|---|---|
| `HOST`, `PORT` | Bind address (default `127.0.0.1:3000`). A non-loopback `HOST` **requires** `APP_PASSWORD` or the app exits. |
| `APP_PASSWORD` | HTTP basic auth for everything except `/healthz`. Lockout after 10 failures per 15 minutes per IP. |
| `APP_SECRET` | 16+ chars. Encrypts stored email credentials (AES-256-GCM). Without it, credentials cannot be saved. |
| `TRUST_PROXY` | Set behind a reverse proxy so lockout sees real client IPs. |
| `DATABASE_URL` | Supabase Postgres connection string (session pooler, port 5432). Required. |
| `DATA_DIR` | Uploaded files (default `./data`). |
| `SCHEDULER` | `off` disables background jobs in this process. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | AI provider (below). |
| `JOOBLE_API_KEY`, `RAPIDAPI_KEY` | Job sources ([JOB_SOURCES.md](JOB_SOURCES.md)). |
| `CHROME_PATH`, `CHROME_ARGS` | Browser-assisted apply. |

### AI provider (Anthropic Claude)

1. Create an API key at <https://console.anthropic.com>.
2. Put it in `.env` as `ANTHROPIC_API_KEY`; optionally set `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`).
3. Restart. **Settings → Integration status → AI → Test** sends a one-word ping (no personal data).
4. The first time you use an AI feature the app shows exactly what is sent and asks for consent. Consent can be withdrawn in
   **Settings → Privacy**. Without a key, everything except AI features still works.

### Using an AI gateway (e.g. OmniRoute) instead

Set `AI_BASE_URL` (e.g. `http://127.0.0.1:20128/v1`), `AI_API_KEY` (a key **issued by the gateway**, ideally a dedicated one
for this app), `AI_PROTOCOL=openai` and `AI_MODEL` (a model id or combo your gateway serves; OmniRoute uses `provider/model`).
The gateway keeps your real provider keys. `AI_BASE_URL` must be `https://` unless it points at localhost. The consent
dialog then names the gateway as the destination, since it forwards your data to whichever providers it routes to.
`AI_PROTOCOL=anthropic` (default) with `AI_BASE_URL` pointing at a gateway's Anthropic-style endpoint is also supported
but has only been tested against mocks. Job-source keys (Jooble, RapidAPI) are not AI keys and don't go through a gateway.

You pay your AI provider for usage. Tailoring and analysis each make one request; AI screening in scheduled searches is
capped at 10 jobs per run and is off by default.

### Email notifications

**Settings → Email notifications**: choose **Resend** (API key) or **SMTP**. Requires `APP_SECRET`. Use *Send test email*.
Emails contain job titles and links, never CV content.

## Commands

```bash
npm test             # 100 tests; no network, mock AI. Browser tests need Chrome and skip otherwise
npm run migrate      # apply pending schema migrations and print status (also automatic on start)
npm run dev          # restart on file changes
```

## Database migrations

Versioned, forward-only migrations in `src/migrations.js`, recorded in `schema_migrations` and applied automatically when
the app opens the database. Databases from earlier versions are upgraded in place. To add one, append an entry to
`MIGRATIONS` (never edit an applied one).

## Layout

```
src/app.js, src/routes/     Express routes          src/migrations.js   schema + data migrations
src/services/               domain logic (profile, search, match, assistant/prompts, grounding, versions,
                            applications, scheduler, notifications, email, health, privacy, ...)
src/providers/              job-source connectors   src/demo.js         labelled sample data
public/                     no-build frontend       tests/              node --test (+ headless Chrome)
```

## How CV auto-fill works (and its limits)

- Reading experience, education and skills uses the AI provider, so it asks for your consent first. If you decline, or no AI
  is configured, the app still reads contact details and links **locally** (nothing is sent anywhere) and tells you what to
  add manually.
- Scanned/image-only PDFs have no readable text (no OCR): you'll be told to fill the profile by hand.
- Automatic reading can make mistakes. Check dates and titles, because everything the AI later writes is based on this profile.
