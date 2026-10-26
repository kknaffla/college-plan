# Handoff: moving this project to Claude Code on your Mac

## 1. Put the folder on your Mac
Unzip `college-plan-handoff.zip` into `~/Projects/college-plan` (any location works).

## 2. One-time tools (skip anything you already have)
```bash
xcode-select --install          # git; skip if already installed
brew install gh                 # GitHub CLI   (Homebrew: https://brew.sh)
gh auth login                   # choose GitHub.com → HTTPS → log in with browser
```
If Claude Code isn't installed yet, follow the install steps at https://docs.claude.com/en/docs/claude-code, then sign in with your Claude account.

## 3. Start Claude Code in the project folder
```bash
cd ~/Projects/college-plan
claude
```
Claude Code reads `CLAUDE.md` automatically, so it starts with the full context.

## 4. Paste this as your first message

> Read CLAUDE.md and README.md. Then deploy this app with me, step by step, doing as much as you can from the terminal:
> 1. `git init`, confirm `.gitignore` excludes `supabase/seed.sql` and `tests/fixtures/`, and make the first commit.
> 2. Create a **public** GitHub repo named `college-plan` with `gh`, push, and enable GitHub Pages serving the `site/` folder (use a GitHub Actions Pages workflow, or a `gh-pages` branch containing only `site/`). Give me the live URL.
> 3. Walk me through creating the Supabase project in the browser (I'll click; you tell me exactly what). Then help me run `supabase/schema.sql` and `supabase/seed.sql`, put the URL and anon key in `site/config.js`, disable public sign-ups, set the Site URL and Redirect URL to the Pages address, create my login and Lily's, and insert both into `members`.
> 4. Commit and push the updated `config.js`, then help me run the ☐ items in the README test checklist on two devices.
> Stop and ask me only for things that need my login or a decision.

## 5. Day-to-day after that
Open Terminal, `cd ~/Projects/college-plan`, run `claude`, and ask in plain English. For example:
- "Add a Western Michigan scholarship due Dec 1, unverified."
- "MSU confirmed Nov 1 EA. Verify it on their site and mark it verified."
- "Add a page comparing net price once offers come in."

Claude Code edits the files, tests them, commits and pushes, and the site updates in about a minute. **Day-to-day data changes, such as statuses, new tasks and scholarships, are made in the app itself.** Use Claude Code only for changes to how the app works.

## What's in the folder
| Path | What it is | In the public repo? |
|---|---|---|
| `CLAUDE.md` | Project brief for Claude Code | yes |
| `HANDOFF.md` | This file | yes |
| `README.md` | Setup guide, parent quick start, test checklist | yes |
| `site/` | The website | yes |
| `supabase/schema.sql` | Tables and security rules | yes (no personal data) |
| `supabase/seed.sql` | Starting data, including Lily's profile | **no** (gitignored) |
| `tests/` | Mock-data UI test and database security test | yes, except `tests/fixtures/` |
