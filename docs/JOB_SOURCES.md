# Job sources

## Supported (official APIs)

| Source | Key | Covers | Notes |
|---|---|---|---|
| **Remotive** | none | Remote jobs | Region-restricted postings are dropped; "Worldwide"/MENA/Asia/Pakistan/Saudi remain. Not Saudi-specific. |
| **Jooble** | `JOOBLE_API_KEY` ([free](https://jooble.org/api/about)) | Saudi listings by city | Aggregator; descriptions are often short snippets, so sponsorship/skills detection sees less text. |
| **JSearch** (RapidAPI) | `RAPIDAPI_KEY` | Google-for-Jobs index | Paid tiers; watch your quota. |

Each can be checked in **Settings → Integration status**, with a **Test** button that runs a sample query and records the
outcome. A source is shown as *Failing* only after a real failed attempt, and *Working* only after a real success.

Quotas, pricing and response formats belong to those providers and can change. The mappings are covered by sample-payload
tests, not live tests.

## Unsupported on purpose

LinkedIn, Bayt, Indeed, Glassdoor, GulfTalent, Naukrigulf, Monster, and similar sites forbid scraping and automated
form-filling in their terms. This app does not scrape them, and refuses browser assistance on them. For a posting you
found there: **Jobs → Add job (URL / paste)** and apply by hand. Imports fetch only the single URL you give (refusing
private-network addresses) and read structured data (`JobPosting`) when present.

## What every job is normalised to

City (English/Arabic names), employment type, work mode, experience level, salary if published, posted date, closing date if
provided, **sponsorship and relocation**, skills. Sponsorship is **Not specified** unless the text explicitly says
otherwise, and negative statements ("no visa sponsorship", "must hold iqama") win over positive wording. For remote jobs,
eligibility for candidates in Pakistan / relocating to KSA is derived from the stated location restriction.

## De-duplication

The same employer + title + city (or the same listing URL) arriving from different sources is stored once: the later copy is
kept as a hidden duplicate, its extra details (salary, closing date) merge into the first, and it never triggers a second
notification. Jobs you import yourself are never hidden. Same-source reposts are kept (they may be separate openings).

## Adding a connector

Create `src/providers/<id>.js` exporting `{ id, label, enabled(), search({ keyword, city, remote }) }`, where `search`
returns records built with `buildJob(...)` from `src/normalize.js`, and register it in `src/providers/index.js`. Use only
APIs whose terms allow your use; add a sample-payload test. `remoteOnly: true` marks sources that only carry remote jobs.


## Bayt, GulfTalent, NaukriGulf and Sabbar

These sites have no public jobs API and their terms forbid automated collection, so the app does **not** scrape them (they are
also on the browser-automation block list). On the Jobs page, **Also search Bayt, GulfTalent, NaukriGulf and Sabbar** opens a
Google search limited to each site, in a new tab, for one of your job titles and the selected city. Only the title and city are
sent (to Google); nothing from your CV. When you find a job, copy its link or text into **Add a job I found**: it is then scored
against your CV like any other job. Jooble (Settings → Find jobs in Saudi Arabia and Pakistan) already aggregates many Saudi listings through
an official API and is the practical way to get Saudi jobs listed automatically.
