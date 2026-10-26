# Lily's College Plan: setup and deployment

This is a private, mobile-friendly dashboard for Kevin and Lily. Each of you signs in with your own account, and you both see the same data. A change on one phone shows up on the other within about a second.

- **Website**: plain HTML and JavaScript in `site/`, with no build step. It's hosted free on **GitHub Pages** with HTTPS.
- **Database and logins**: **Supabase** (free tier). The SQL is in `supabase/`.
- **Security**: the database itself blocks every account that isn't on the family list. Hiding buttons in the app is not what keeps data private. The public "anon" key in `config.js` can't read anything unless the person is signed in *and* their account is a family member.

Setup takes about 30 minutes. Only you hold the GitHub and Supabase accounts. Lily gets a login to *your* app and doesn't need an account with either service.

> **Using Claude Code on your Mac?** Start with `HANDOFF.md` instead. Claude Code can do most of these steps for you.

---

## Part A: Database (Supabase)

1. **Create the project.** Go to https://supabase.com, sign up with kknaffla@gmail.com, and click **New project**.
   - Name: `college-plan`. Choose a strong database password and store it in your password manager. The app never uses it.
   - Region: **East US**. Plan: **Free**.
   - Wait about 2 minutes for it to finish provisioning.
2. **Create the tables.** In the left sidebar, open **SQL Editor** and click **New query**. Paste all of `supabase/schema.sql` and click **Run**. Then open another new query, paste all of `supabase/seed.sql`, and click **Run**. You should see "Success. No rows returned" both times.
3. **Copy the connection values.** Open **Project Settings → API** (on newer dashboards, **Project Settings → API Keys** and **Data API**). Copy:
   - the **Project URL** (`https://xxxx.supabase.co`)
   - the **anon / public** key (also called the *publishable* key)

   Open `site/config.js` in a text editor and paste the two values over the placeholders. **Don't use the `service_role` / secret key anywhere.**
4. **Lock down sign-ups.** Open **Authentication → Sign In / Providers** (or **Authentication → Settings** on older dashboards) and turn **Allow new users to sign up** **OFF**. Email provider stays **ON**. After this, only accounts you create can sign in.
5. **Create the two accounts.** Open **Authentication → Users → Add user → Create new user**.
   - Your account: your email, a password, and **Auto Confirm User** checked.
   - Lily's account: her email, a temporary password, and **Auto Confirm User** checked.

   Then go back to **SQL Editor**, edit the two emails below, and run it. Until this step is done, either account can sign in but will see nothing.
   ```sql
   insert into public.members (user_id, display_name, role)
   select id, 'Kevin', 'parent'  from auth.users where email = 'kknaffla@gmail.com'
   union all
   select id, 'Lily',  'student' from auth.users where email = 'LILY-EMAIL-HERE';
   select * from public.members;   -- should list 2 rows
   ```
6. **Turn on live sync.** Open **Database → Publications → supabase_realtime** and confirm that `colleges`, `tasks`, `scholarships` and `profile_facts` are switched on. `schema.sql` does this already, so this is just a check.

## Part B: Website (GitHub Pages)

7. On GitHub, click **+ → New repository**. Name it `college-plan` and set it to **Public**. Free GitHub Pages requires a public repo. That's acceptable here because the repo holds only website code and no family data. Check **Add a README** and click **Create**.
   - Upload **only the files inside `site/`**. Don't upload the `supabase/` folder, because `seed.sql` contains Lily's profile details.
8. In the repo, click **Add file → Upload files** and drag in every file from `site/`: `index.html`, `app.js`, `styles.css`, `config.js`, `manifest.webmanifest`, `icon.svg`, `icon-180.png`, `icon-192.png`, `icon-512.png`. Then click **Commit changes**.
9. Open **Settings → Pages**. Under **Source**, choose **Deploy from a branch**, pick branch `main`, folder `/ (root)`, and click **Save**. After 1–2 minutes the site is live at `https://YOUR-GITHUB-NAME.github.io/college-plan/`.
10. Back in Supabase, open **Authentication → URL Configuration**:
    - Set **Site URL** to the GitHub Pages address above.
    - Add the same address under **Redirect URLs**.

    This makes "Forgot password" emails link back to your site.

## Part C: Phones

11. Open the site in Safari on each iPhone and sign in. Then tap **Share → Add to Home Screen**. It opens full-screen like an app.
12. Lily changes her temporary password with **Forgot password?** on the sign-in screen. She gets an email link and sets a new password.

---

## Parent quick start (one page)

| To… | Do this |
|---|---|
| **See what matters now** | **Home** shows overdue items, what's due in the next 7 days, the next three actions, a progress card for each college, pending scholarships and recent changes. |
| **Update a task** | Change the status dropdown on any task card, or tick its checklist steps. Tap the task title to edit everything, including owner, date, blocker and notes. |
| **Flag a blocker** | Edit the task and fill in **Blocked by**. It turns red on This Week. |
| **Add a scholarship** | **Scholarships → + Scholarship**. Add the official link and the date you verified it. |
| **Verify a deadline** | Open the official page and confirm the date. Then edit the college, task or scholarship and set **Date verified**. The yellow "Unverified — confirm with school" label disappears. |
| **Record a submission** | Set the task to **Submitted**. Edit the college and fill in **Submitted on** plus a receipt note (confirmation number, or where the PDF is saved). |
| **Back up** | **More → Backup & export → Download JSON backup**. Do this weekly. CSV buttons open in Excel. |
| **Restore** | **More → Backup & export → choose the JSON file**. It overwrites matching rows and deletes nothing. |
| **Add another family member** | Repeat step 5 for that person. |
| **Remove access** | Supabase → **Authentication → Users → delete the user**. Their membership is removed automatically. |

**Troubleshooting**
- **"Almost there… hasn't been added to the family workspace."** The account exists but step 5's `insert into members` wasn't run for that email.
- **"Setup needed."** `config.js` still has the placeholders, or the new version isn't uploaded yet.
- **"Invalid login credentials."** Use **Forgot password?**, or reset the password in Supabase → Authentication → Users.
- **Changes not appearing on the other phone.** The dot in the top-right corner should be green. Pull to refresh, or switch away from the app and back; it reloads whenever it comes back into view.
- **The site stops loading after a long idle stretch.** Free Supabase projects pause after about a week with no use. Supabase emails a warning, and you can click **Restore project** in the dashboard. Daily use keeps it awake.

**Never put these in the app:** FSA IDs, passwords, SSNs, tax returns, bank or account numbers, or FAFSA records. Track the *status* here and do the forms on StudentAid.gov and the College Board site.

---

## Test checklist

These were run before handoff: the database rules on a local PostgreSQL copy of the schema, and the screens in a headless browser using mock data. The ones marked ☐ need to be run once on the live site.

- [x] Schema and seed install cleanly and can be re-run without duplicating data (9 colleges, 26 tasks, 5 scholarships, 15 profile facts).
- [x] **Permission isolation**: a signed-in account that isn't a family member sees 0 rows and can't update anything. A signed-out visitor is denied outright. A family member can't add new members.
- [x] Each edit records who made it and when, set by the server.
- [x] Add a task, change a status, tick a checklist step, and edit a college.
- [x] Choosing Early Decision shows a binding-commitment warning before saving.
- [x] Deadlines sort correctly, and dates are calculated in America/Detroit time.
- [x] Phone width (390 px) and desktop both display with no sideways scrolling.
- ☐ **Separate logins**: sign in as Kevin on one device and as Lily on another.
- ☐ **Cross-device sync**: change a status on one phone and confirm it updates on the other within a couple of seconds.
- ☐ **Refresh persistence**: refresh, then sign out and back in, and confirm the change is still there.
- ☐ **Export**: download a JSON backup, then restore it.

## Updating the site later

Edit a file and upload it again in GitHub (**Add file → Upload files**, using the same name). Pages redeploys in about a minute. Data changes are made in the app, not in GitHub.

## Optional later enhancements (not needed now)

- Email or text reminders the day before a due date (Supabase scheduled function)
- Calendar feed (.ics) of deadlines
- Links to essay drafts in Google Drive or OneDrive on each task
- Net-price comparison table once aid offers arrive in the spring
- Custom categories and a progress chart over time
