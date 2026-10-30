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
- **Navigation:** phone tabs Home · Calendar · Colleges · Scholarships · Profile; top bar shows page title, next-deadline chip, Live dot, ☰ menu (More). Desktop bar adds Money (Cost & offers + Aid forms tabs at `#/money`; `#/offers` and `#/aid` still work) and Documents. Line icons in `ICON` in app.js.
- **Pages:** Home (countdown, progress ring, deadlines from tasks + colleges + scholarships), Calendar (wall-calendar month view + Week toggle; one running list of every dated item (past and future, month dividers) under the calendar; tapping a day jumps to it; Subscribe button for the live feed), Colleges, Scholarships (Pursuing · Deciding · Not pursuing tabs from status: Planning/In progress/Submitted = pursuing, Researching = deciding; one list sorted by deadline with "Due in the next 14 days" first, month headers, no-date and a collapsed passed section; one-tap Pursue / Skip; scope is a filter, not grouping), Cost & offers (net-price chart; estimate vs official offer per college), Visits (log with star ratings), Financial aid, All tasks, Profile, Backup.
- **Live calendar feed:** Edge Function `supabase/functions/calendar-feed` serves an iCalendar feed gated by the key in `public.calendar_feed` (migration 002; members read it, `rotate_calendar_token()` resets it). The function must have **Verify JWT turned off** in Supabase (calendar apps can't send a login); it uses the built-in service-role env var server-side only. The Calendar page's Subscribe button shows the webcal link. Deploy function changes by pasting the file into Supabase → Edge Functions → calendar-feed → Code.
- **Profile builder (migration 003):** `student_profile` (one row), `activities` (Common App fields; 50/100/150-char limits enforced in DB and editor; top 10 by `sort` go on the Common App), `honors` (5), `essays` (status + word counts + link to Lily's own draft; never store or write essay text), `recommenders`. Brag sheet at `#/brag` prints to PDF.
- **Documents vault (migration 004):** private Storage bucket `documents` (25 MB, PDF/images/Word) + `public.documents` metadata; members-only policies; opened via 60-second signed URLs. No financial records: there is no financial category and file names matching tax/1040/W-2/FAFSA/CSS/SSN/bank etc. are refused. Note `schema.sql` now references `storage.*`, so the local Postgres test needs a storage stub or should skip 004.
- **College facts (migration 008):** `colleges.facts` jsonb = {as_of, stats, net_price_by_income, business, housing, campus, sources}. Source of truth is `supabase/data/college_facts.json` (public data); regenerate `supabase/data/load_college_facts.sql` and run it in the SQL Editor (Supabase's 'UPDATE without WHERE' warning is a false alarm on these). Compare page `#/compare` (picker 2-4, income band, weight sliders, fit score; per-device localStorage). College pages show Key facts + Culture & housing (Ross covered separately as a school within a school). Known gaps: NMU 10-yr median earnings and MTU $0-30k net price (Scorecard DEMO_KEY rate limit).
- **Appearance:** per-device Auto/Light/Dark in More; stored in localStorage 'theme', applied by an inline script in index.html; dark CSS rules exist under both `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and `:root[data-theme="dark"]`. Add new dark rules in both forms.
- **Ignore / remove tasks (migration 009):** each task's status menu has "Not needed…" (kept, hidden from Home, calendar, feed and progress; restore via All tasks › Not needed) and "Remove task…" (permanent). Both ask for confirmation. The calendar-feed function skips 'Not needed'.
- **Paste to add / iPhone Share (migration 010):** `parseQuick()` turns pasted or shared text into a task draft (title from Subject or first line, earliest upcoming date incl. weekday names, time, first link, category and college by keyword). In the app, "Paste to add" (All tasks, This week, Calendar) opens a prefilled New task form. The Edge Function `supabase/functions/quick-add` (Verify JWT OFF; gated by the key in `public.quick_add`, rotated by `rotate_quick_add_key()`) accepts POST JSON {text} from an iPhone Shortcut and inserts a task owned by Both. Keep both copies of `parseQuick` identical. Setup steps are in More › Add from iPhone Share.
- **Daily brief (migrations 011, 012, 021):** Edge Function `supabase/functions/daily-brief` emails the 7 AM Knaffla Brief to the whole family: weather for Manistique, Crooked Lake (the cottage, Germfask forecast) and a fun place (or the trip destination) with what to wear, moon phase and an on-this-day fact, Lily's focus college (brief_settings.lily_focus) with its open items, the top 3 tasks (never the word "overdue"; past-due says "focus on"), the next trip, coming-up dates, 3 headlines plus 1 Up North, 2 entertainment, "where the stars are" (brief_settings.stars), music news, new releases and "On tour" lines for followed artists (music_artists, music_follows; migration 023; nearest shows first, from news since no free tour-date API is open), then a "fun zone" of colorful cards: the daily quiz (Open Trivia DB, answer revealed on /calendar/#answer=…) every day, Game day (ESPN public scoreboard: Michigan, MSU, Tech, NMU, Lions, Red Wings, Tigers, Pistons; rivalry games lead) when our teams play, plus two rotating cards from: dad joke, word of the day (built-in SAT list), on-this-day fact, dinner table question (built-in list), xkcd, countdowns (holidays + birthdays), where the stars are. Sources: Open-Meteo, Google News RSS, iTunes Search, no keys. Earlier shape: Lily's college section first (most important item, countdown, due today, overdue, next 7 days, deep links), then Amy's next 2 weeks, trips in the next 30 days, and family dates (`public.family_dates` birthdays, seeded from a gitignored file, plus the election). It never includes money from knaffla.assistant@gmail.com via Gmail SMTP port 465. Secrets GMAIL_USER and GMAIL_APP_PASSWORD (Kevin sets them). Settings row `public.daily_brief` (recipients, test_recipient, send_hour, enabled, last_sent_on; no grants, service role only). pg_cron calls it at 11:00 and 12:00 UTC; it sends only at 7 AM Detroit once per day. Never commit recipient addresses. Deep links: `#/day/YYYY-MM-DD`, `#/task/<id>`.
- **Senior year (migration 013):** task category 'Senior year' plus `student_profile.grad_date/grad_time/grad_place`. Page `#/senior` (More › Senior year): graduation countdown, Lily's grad party task (title contains "grad party" and "Lily") with its checklist, coming up, date-not-posted, done. Home shows a graduation countdown card when grad_date is set. Senior items are ordinary tasks, so they appear on the calendar, feed, brief, and sweeps.
- **Scope filter and events (migration 014):** All · College · 🎓 Senior switch (`scopeBar()`, localStorage 'scope', per device) on Home, Calendar, All tasks. `tasks.is_event`: events (concerts, meetings, exams, games) are open only until their date, never overdue, and excluded from progress `counts()`. Senior tasks show a 🎓 Senior chip and a dashed 🎓 calendar pill. Daily brief puts college first and adds a "Senior year (next 2 weeks)" section. Activities (swim, golf, drama, Glee, band) go in Senior year as milestones only, prefixed like "Swim: ..."; routine schedules belong in the school's own calendar feeds.
- **Application fees (migration 015):** `colleges.app_fee` (numeric, 0 = free) and `fee_note` (waiver / free-date note). Colleges page shows the fee total; cards show Fee $X or Free to apply. Verified Oct 27, 2026: U-M $75 (+$5 Ross SlideRoom), MSU $75, Michigan Tech and NMU free.
- **Automations (migration 016):** `public.automations` (key = scheduled-task id, cron, requested_cron, last_run_at, last_result) drives More › Automations. Daily brief time is changed in the app via `set_brief_hour(h)`, which reschedules pg_cron jobs `daily-brief-edt`/`daily-brief-est` (h+4 / h+5 UTC). The Mac jobs (`college-email-sweep`, `lily-scholarship-scan`, Claude desktop scheduled tasks) write last_run at the end of each run; the email sweep applies any requested_cron to both via update_scheduled_task. Members may update only requested_cron/requested_at.
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
- Before each deploy, bump `APP_VERSION` in `site/app.js` and the matching `?v=` tags in `site/index.html` so phones load the new files instead of cached ones.
- Commit messages: short and imperative.

## Later ideas (only when asked)
- Email reminders the day before a deadline
- An .ics calendar feed
- Links to essay drafts
- A net-price comparison table once aid offers arrive
- A progress chart
