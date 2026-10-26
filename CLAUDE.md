# CLAUDE.md: Lily's College Plan

Claude Code reads this file automatically. It gives you the context to keep working on this project.

## What this is
This is a private college-application dashboard for **Kevin (parent)** and his daughter **Lily** (high school senior, Manistique, MI). It covers applications for Fall 2027 entry. Kevin and Lily have separate logins, share one dataset, sync live between iPhones and computers, and can add it to the iPhone Home Screen.

- **Priority:** U-M Ross BBA, Early Action. The deadline is **Nov 1, 2026**, and the Ross portfolio goes through SlideRoom. Next come MSU Broad (EA, Nov 1) and Michigan Tech (Nov 1 admission, with the Leading Scholar scholarship due Nov 15). NMU is rolling admission; the family decided not to pursue Presidential Scholars this cycle.
- **Rule: the dashboard must never delay the actual applications.** Prefer small, safe changes.
- Kevin is a career CFO/controller. Give him short answers and variances, not narration.

## Architecture
- `site/` is a static single-page app with **no build step**: `index.html`, `app.js` (vanilla JS with hash routing), `styles.css`, `config.js`, the manifest, and the icons.
  - It loads `@supabase/supabase-js@2.45.4` as a UMD build from jsdelivr.
  - `config.js` holds the Supabase URL and the **anon/publishable** key. That key is designed to be public. **Never put the `service_role` key anywhere in `site/`.**
- `supabase/schema.sql` defines the tables `members`, `colleges`, `tasks`, `scholarships`, `profile_facts`, `visits` and `aid_offers` (the last two added by `migrations/001_visits_and_aid_offers.sql`).
  - The RLS function `is_member()` controls access. Only rows in `members` can read or write, and the app can't add members.
  - A trigger `stamp_row()` sets `updated_at` and `updated_by`.
  - The tables are published to realtime. The file is idempotent and safe to re-run.
- `supabase/seed.sql` holds the starting data from the family's action plan. It is **gitignored** because it contains Lily's personal profile details.
- **Hosting:** GitHub Pages serves `site/` over HTTPS at https://kknaffla.github.io/college-plan/ (repo `kknaffla/college-plan`). Pages builds from the `gh-pages` branch, which holds only `site/`. After committing a change to `site/` on `main`, deploy with `git push origin main && git subtree push --prefix site origin gh-pages`. The gh CLI lives at `~/.local/bin/gh`; its token lacks the `workflow` scope, so don't add GitHub Actions workflows without `gh auth refresh -s workflow`. Free Pages requires a **public** repo, so the repo must contain no family data: keep `seed.sql` and `tests/fixtures/` out of it.
- **Auth:** Supabase email + password. **Public sign-ups are disabled.** Kevin creates the users in the Supabase dashboard, then inserts them into `members` (README step 5). Password resets redirect back to the Pages URL.
- **Dates:** dates are stored as `date` and times as text ("8:00 AM"). The time zone is America/Detroit. `todayISO()` in `app.js` uses Intl with that time zone.
- **This Week window:** `WEEK_START` / `WEEK_END` in `config.js` (Oct 25 – Nov 1, 2026); after that window the Week view rolls to the next 7 days from today.
- **Pages:** Home (countdown, progress ring, deadlines from tasks + colleges + scholarships), Calendar (wall-calendar month view + Week toggle, .ics export with day-before alerts), Colleges, Scholarships, Cost & offers (net-price chart; estimate vs official offer per college), Visits (log with star ratings), Financial aid, All tasks, Profile, Backup.
- **Applying to:** U-M, MSU, Michigan Tech, NMU. Don't add scholarships limited to other colleges.
- **Local test without Node:** serve `site/` with a stub `config.js` and `tests/mock-supabase.js` + `tests/fixtures/seed.json` in place of the CDN script (same approach as `tests/ui-test.js`).

## Content and accuracy rules (from the build brief)
- Every deadline shows its official source link and a "verified on" date. If `verified_on` is null, the app shows **"Unverified — confirm with school."** Verify against the official page before setting `verified_on`.
- **Early Decision is binding.** The app warns before a college's plan is set to ED. The family chose nonbinding EA for U-M.
- Adding a college to the Common App does **not** submit anything. Submission and receipt are tracked separately: `submitted_on` and `receipt_note` on each college.
- Don't assume dual-enrollment or MTA credits satisfy Ross requirements. Credit evaluation is still pending.
- FAFSA is not the same as creating a StudentAid.gov account (FSA ID), and the CSS Profile is not the same as a College Board login. Keep them distinct.
- **Never store** FSA IDs, passwords, SSNs, tax returns, bank or account numbers, or FAFSA records. Never overstate admission chances or scholarship awards.
- Essays must be in Lily's own voice. Don't ghostwrite them.

## Status as of Oct 25, 2026
- ✅ Code complete. The schema, seed and RLS were tested on local Postgres:
  - A non-member sees 0 rows and can't update.
  - Anon is denied.
  - A member can't add members.
- ✅ The UI was tested headless with a mocked Supabase client at phone (390 px) and desktop widths: status change, checklist, add task, ED warning, no horizontal overflow, no JS errors.
- ✅ Deployed Oct 25, 2026. Supabase project `qienshgabtzngzerjkrl`; members Kevin (parent) and Lily (student).
- ✅ Oct 26: added calendar, visits, cost & offers, .ics export; migration 001 applied.
- ⬜ Live two-device sync hasn't been tested yet (it needs the real Supabase project).
- ⬜ MSU dates aren't verified: their deadlines page showed no dates when it was checked.

## Commands
- Run locally: `npm run serve`, then open http://localhost:8000. It needs real values in `config.js`; otherwise it shows "Setup needed."
- UI test with mock data: `npm i && npx playwright install chromium && npm run test:ui`. Screenshots go to `tests/out/`.
- DB/RLS test needs a throwaway local Postgres:
  `psql -f tests/db-stub.sql -f supabase/schema.sql -f supabase/seed.sql -f tests/rls-test.sql`
- Supabase CLI (optional): `brew install supabase/tap/supabase`, then `supabase link` and `supabase db query` (or paste the SQL into the dashboard's SQL Editor).

## Conventions
- Keep it dependency-free: vanilla JS, no framework, no build. Escape all user text with `esc()`, and only render http(s) links through `safeUrl()`.
- Schema changes go in a new numbered file, `supabase/migrations/NNN_description.sql`, written to be idempotent. Update `schema.sql` to match.
- After any change, run `node --check site/app.js` and the UI test.
- Commit messages: short and imperative.

## Later ideas (only when asked)
- Email reminders the day before a deadline
- An .ics calendar feed
- Links to essay drafts
- A net-price comparison table once aid offers arrive
- A progress chart
