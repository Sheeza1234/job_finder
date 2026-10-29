# Saudi Job Finder

A personal, single-user web app that finds jobs in Saudi Arabia, scores them against your **real** profile, tailors your CV
truthfully, drafts cover letters, and tracks applications. **It never submits an application without your explicit action.**

```bash
npm run install:all && cp backend/.env.example backend/.env && npm run dev   # UI http://localhost:5173, API http://127.0.0.1:3000  (Node 20+)
```

The project is two folders: `backend/` (Express API) and `frontend/` (React + TypeScript + Tailwind, builds to `frontend/dist`). `npm run dev` starts both; `npm start` builds the UI and serves everything from the backend on :3000. Deploy `frontend/` to Vercel (set the backend URL in `frontend/vercel.json`) and host `backend/` separately.

| Doc | Contents |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Local development, configuration, AI provider, email, commands, migrations |
| [docs/JOB_SOURCES.md](docs/JOB_SOURCES.md) | Supported and unsupported sources, de-duplication, adding a connector |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production guide: HTTPS, systemd, Docker, backups, upgrades |
| [docs/SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md) | What is stored, what leaves your machine, controls, limits |
| [docs/STATUS.md](docs/STATUS.md) | Phase status, requirement-to-test map, **what is not verified**, deviations |

**Honest status:** 100 automated tests pass (no network, mock AI). Not verified: real AI output quality, live job-source
APIs, a real email provider, real employer sites, and the Docker image build. See [docs/STATUS.md](docs/STATUS.md).
Mode C (automatic submission) has **no supported sites**: the safety pipeline exists and is tested with a mock, but no real
site is known to permit automated applications.

**First time?** The dashboard has a guided checklist, and **Settings → Try demo mode** loads clearly labelled sample data.
Production mode shows only your own data and the sources you configured.

## Features

| Area | What it does |
|---|---|
| Profile | **Upload your CV and the profile fills itself in** (only empty fields; undo available); you add only what is missing. Editable profile (experience, education, certifications, projects, skills, preferences) with the 13 starter categories. Upload CV (PDF/DOCX), portfolio PDF, certificates; optional AI pre-fill of the profile from your CV (as a draft you must review). |
| Job search | Pulls from official job APIs, normalises to Saudi cities (English + Arabic names), detects employment type, work mode, experience level. |
| Filters | City, title/keyword, industry, experience, salary, employment type, remote/hybrid/on-site, posted date, sponsorship, relocation, skills, employer. |
| Sponsorship | `Not specified` unless the posting **explicitly** says otherwise. Negative statements ("no visa sponsorship", "must hold iqama") take priority. |
| AI analysis | Requirement-by-requirement fit (met / partial / gap, with evidence), red flags, advice. A keyword-based estimate (`~`) is shown without AI. |
| CV tailoring | Versioned, editable, comparable, approvable; PDF + DOCX. See below. |
| Cover letter | English or Arabic, editable, DOCX export. |
| Tracking | saved → preparing → applied → interview → offer / rejected / withdrawn, with notes. |

## CV tailoring engine

Per job, **Tailor new version** reads the full posting, your profile and the AI fit analysis, then saves a *separate version* linked to that job:

- Reorders and rewords your real experience/projects by relevance; writes a job-specific summary; uses the posting's terminology only where your profile supports it.
- **What changed & why** tab: every change with its reason, keywords used (each tied to a profile skill), and **gaps** (requirements your profile doesn't show). Gaps come from the AI *and* a deterministic keyword scan, so a model omission can't hide one.
- **Preview / Edit / Compare** (against the untouched original or another version) / **Approve**. Editing re-checks every claim; editing an approved version forks a new draft.
- Only **approved** versions are used to apply. Approving a version that still has accuracy warnings requires explicit acknowledgement.
- **PDF and DOCX** export: single column, standard fonts and headings, real selectable text. Tests parse the exported files back and check their content. Drafts are named `_DRAFT`.
- The original CV, uploaded files and profile are never modified; a version freezes the profile facts it was built from.

### Truthfulness safeguards

- Prompts forbid inventing employers, titles, dates, degrees, certificates, clients, tools or figures; unsupported requirements are reported as gaps.
- The CV is built from **your** profile entries by id: employers, titles, dates and education always come from your data; the AI supplies wording and ordering only. Unknown ids are dropped.
- Skills not in your profile are removed. Numbers not in your profile, and known skills/tools named in free text (summary, bullets, letter) that your profile never mentions, are flagged.
- These checks reduce risk but cannot catch every invented claim. **Read every document before sending.**

## Application assistant

| Mode | What it does | Availability |
|---|---|---|
| **A: Manual** | Opens the listing; shows your approved CV/letter; requirement checklist derived from the posting; you apply yourself, then "I submitted it" (recorded as *self-reported*). | Always |
| **B: Browser-assisted** | Opens the page in a visible Chrome window on **your computer**, fills ordinary fields from your profile, attaches approved files, and **stops**. Shows a live "what will be submitted" table. There is no code path that clicks submit. | Needs Chrome on the machine running the app (`CHROME_PATH`); not for Docker/remote servers. Refused for LinkedIn, Indeed, Bayt, Glassdoor, GulfTalent and similar (extend with `AUTOMATION_BLOCKED_HOSTS`). |
| **C: Approved automatic submission** | Pipeline with hard gates, only through a registered adapter for a site that explicitly permits automation. | **No adapters ship.** Every real site currently falls back to a manual checklist. See `src/services/autoSubmit.js` to add one. |

Rules enforced in code for B and C: logins, CAPTCHAs and MFA are never bypassed (control returns to you); sensitive answers (salary, notice period, work authorization, visa, relocation, start date) come only from your **Saved application answers** and are otherwise reported as "needs your input"; consent/legal checkboxes are never ticked; duplicates are blocked.

Mode C additionally: re-verifies the listing is open, requires employer + title to match, requires approved CV/letter made for *this* job, validates attachment format/size, requires explicit approval (a one-time token bound to the exact content; invalidated if anything changes) unless you pre-approved that adapter, and records **applied only when the site returns a confirmation**. Unconfirmed or failed attempts are logged, never recorded as applied, and block blind retries.

## Application tracker

12 statuses (Saved, Shortlisted, CV Ready, Awaiting My Approval, Ready to Apply, Applied, Assessment, Interview, Offer, Rejected, Withdrawn, Listing Expired). Stores title, employer, location, URL, match score, CV/letter versions used, dates discovered/applied, notes, follow-up date, interview dates, recruiter details you enter, and submission confirmation (marked *self-reported* or *confirmed by the site*). Duplicate applications (same job, same URL, or same employer+title+city from another source) are blocked unless you allow them. Kanban board (drag and drop, with a dropdown fallback), table view, search, filters, sorting, follow-up-due filter, and CSV export (spreadsheet-formula-safe). "Check if listing is still open" suggests Listing Expired; it never changes status on its own.

## Dashboard, CV Studio and settings

- **Dashboard:** overview tiles (jobs discovered, high-match, shortlisted, submitted, interviews, pending follow-ups), upcoming interviews and due follow-ups, and **Recommended Jobs** cards (title, employer, location, published salary, posted date, match score, top matching skills, missing requirements, sponsorship only when the posting states it) with **View Job / Analyze Job / Tailor CV / Save Job**. Recommendations skip excluded employers/keywords, weak matches, and jobs you've already applied to.
- **CV Studio:** manage the master CV, generate tailored CVs for any job, and preview / edit / compare / approve / download (PDF or DOCX) every version, with each version's history.
- **Applications:** board and table, status updates, interview dates, follow-up dates, notes, and the CV/letter used (downloadable from the table).
- **Search Settings:** preferred titles, locations, minimum salary, experience level, employment type, work arrangement, minimum match score, excluded companies/keywords, search frequency.
- **Settings:** email provider, job-source status, privacy controls, activity log.

## Scheduled search and notifications

A background scheduler runs inside the server process (not the browser): hourly, every 6 hours, or daily at a chosen time. Its state is stored in the database, so a missed run (server down at 08:00) is made up when the server returns. It runs reminders every minute.

- **New matches:** after each run, new jobs that meet your preferences and score at least your threshold produce one notification (new listings posted in the last 24 hours are highlighted as *New*). Scores are keyword-based unless you turn on **AI screening** (top 10 candidates per run, needs consent and an API key).
- **Reminders:** follow-up date reached; N days after applying with no follow-up date; interview within 24 hours; a saved listing closing within 3 days (only when the posting provides a closing date, e.g. from a pasted URL with structured data. Most job-board APIs don't).
- Each event notifies once. In-app notifications (bell) and email can be enabled independently.
- **Discovery and applying are separate.** The scheduler only finds jobs and notifies. It has no access to the application workflows, never creates or changes an application, and a test enforces this. Applying always starts from you.
- **Email:** Resend or any SMTP server. Keys/passwords are encrypted at rest (AES-256-GCM, key from `APP_SECRET`), write-only in the UI, and refused outright if `APP_SECRET` isn't set. Emails contain job titles and links, never CV content. A delivery failure is recorded and never loses the in-app notification.

## Security and privacy

- **AI consent:** nothing is sent to the AI provider until you consent, after seeing what is sent. Consent can be withdrawn. Search sends only keywords/cities to job APIs; your CV never goes to them.
- **Uploads:** extension allow-list, size limit, content must match the file type (an `.exe` renamed `.pdf` is rejected and deleted), random stored names, parsing with a time limit and size cap. Downloads use `nosniff` and `attachment`; uploaded files can also be fetched through **signed links that expire after 5 minutes**.
- **Auth:** optional `APP_PASSWORD` (HTTP basic auth, constant-time compare) with a lockout after 10 failures per 15 minutes. The app holds no employer/job-site passwords: browser assistance never logs in for you.
- **Your data:** *Download all my data* (JSON, no credentials) and *Delete all my data* (typed confirmation; removes database content, uploaded files, credentials and the audit log).
- **Audit log:** every state-changing request and scheduler run is recorded (what, when, who: user/scheduler), never request bodies, CV text or credentials. Application events (status changes, submission attempts and outcomes) are also kept per application.
- API keys stay on the server; the browser never sees them.

## Product behaviour notes

- **Demo vs production:** production shows only your data and configured sources. Demo mode shows only clearly labelled sample listings (no apply link) and pauses searching, reminders and applying. They never mix.
- **Status page:** Settings → *Integration status* shows each integration as Working / Configured / Failing / Not configured / Unavailable, based on real outcomes, and *Production readiness* lists blocking problems.
- **Dialogs:** destructive or hard-to-reverse actions (delete data, leave demo, approve a CV with accuracy warnings, record an application as submitted, override a duplicate) use explicit confirmation dialogs; deleting all data requires typing a phrase.

## Where to look next

Setup and configuration: [docs/SETUP.md](docs/SETUP.md). Sources: [docs/JOB_SOURCES.md](docs/JOB_SOURCES.md). Deployment: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Privacy/security: [docs/SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md). Status, test map, deviations from the generic spec (Express kept instead of Next.js; the database is Supabase Postgres), and what is unverified: [docs/STATUS.md](docs/STATUS.md).

## Known limitations

- PDF export is Latin-text only (Arabic is refused with a clear message; use DOCX).
- Keyword scoring uses a built-in skill vocabulary (design, marketing, development, AI); other skills are only seen by the AI analysis, and a job whose text mentions your skills can score well despite a mismatched title. Scores marked `~` are estimates.
- The listing-open check is best effort; JS-rendered pages can look open when they aren't.
- Salary filters compare numbers as listed; currencies are not converted.
- Scanned/image-only PDFs are stored but not text-extracted (no OCR).
- Job-source APIs are third-party; quotas and formats can change and are not covered by live tests.
- Mode B field matching is heuristic. Mode C has no supported sites.
# job_finder
