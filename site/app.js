/* Lily's College Plan — single-page app (no build step).
   Data lives in Supabase; row-level security keeps it family-only. */
(function () {
  'use strict';

  const APP_VERSION = '2026.10.27-4'; // keep in sync with the ?v= tags in index.html
  const CFG = window.APP_CONFIG || {};
  const TZ = CFG.TIME_ZONE || 'America/Detroit';
  const WEEK_START = CFG.WEEK_START || '2026-10-25';
  const WEEK_END = CFG.WEEK_END || '2026-11-01';
  const $app = document.getElementById('app');
  const $sheet = document.getElementById('sheet');

  const TASK_STATUS = ['Not started', 'In progress', 'Waiting on others', 'Submitted', 'Done', 'Not needed'];
  const CLOSED = new Set(['Submitted', 'Done', 'Not needed']);
  const counts = (t) => t.status !== 'Not needed';
  const COLLEGE_STATUS = ['Researching', 'Planning', 'In progress', 'Submitted', 'Complete', 'Admitted', 'Waitlisted', 'Denied', 'Not applying'];
  const SCH_STATUS = ['Researching', 'Planning', 'In progress', 'Submitted', 'Awarded', 'Not awarded', 'Not pursuing'];
  const CATEGORIES = ['Admissions', 'School materials', 'Essays', 'Scholarship', 'Financial aid', 'Research', 'Other'];
  const OWNERS = ['Lily', 'Parent', 'Both'];
  const PLANS = ['EA', 'ED', 'RD', 'Rolling', 'Undecided'];
  const TABLES = ['colleges', 'tasks', 'scholarships', 'profile_facts', 'visits', 'aid_offers', 'student_profile', 'activities', 'honors', 'essays', 'recommenders', 'documents'];
  const TABLE_ORDER = { colleges: ['priority', 'name'], profile_facts: ['sort'], activities: ['sort'], honors: ['sort'] };
  const ACT_TYPES = ['Academic', 'Art', 'Athletics: Club', 'Athletics: JV/Varsity', 'Career Oriented', 'Community Service (Volunteer)', 'Computer/Technology', 'Cultural', 'Dance', 'Debate/Speech', 'Environmental', 'Family Responsibilities', 'Foreign Exchange', 'Foreign Language', 'Internship', 'Journalism/Publication', 'Junior R.O.T.C.', 'LGBT', 'Music: Instrumental', 'Music: Vocal', 'Religious', 'Research', 'Robotics', 'School Spirit', 'Science/Math', 'Social Justice', 'Student Govt./Politics', 'Theater/Drama', 'Work (Paid)', 'Other Club/Activity'];
  const GRADES = ['9', '10', '11', '12', 'Post-graduate'];
  const ESSAY_STATUS = ['Not started', 'Brainstorming', 'Drafting', 'Revising', 'Final', 'Submitted'];
  const REC_STATUS = ['To ask', 'Asked', 'Agreed', 'Submitted', 'Thanked'];
  const DOC_CATS = ['Essays', 'Transcripts & scores', 'Resume & activities', 'Awards & certificates', 'Recommendations', 'Application receipts', 'Admission letters', 'Scholarships', 'Visits & photos', 'Other'];
  const DOC_ICON = { Essays: '✎', 'Transcripts & scores': '▤', 'Resume & activities': '☰', 'Awards & certificates': '★', Recommendations: '✉', 'Application receipts': '✓', 'Admission letters': '🎓', Scholarships: '$', 'Visits & photos': '📍', Other: '•' };
  // File names that suggest financial records, which this app must never store.
  const FINANCIAL_NAME = /\b(tax(es)?|1040|w-?2|w-?9|1099|fafsa|css[ _-]?profile|ssn|social[ _-]?security|bank|routing|pay[ _-]?stub|irs|idoc)\b/i;
  const VISIT_KINDS = ['Campus tour', 'Admitted-student day', 'Info session', 'Virtual', 'Interview', 'Other'];
  const SCH_ACTIVE = ['Planning', 'In progress'];
  const COLLEGE_DONE = ['Submitted', 'Complete', 'Admitted', 'Waitlisted', 'Denied', 'Not applying'];

  const state = { session: null, me: null, members: [], loaded: false };
  TABLES.forEach((t) => { state[t] = []; });
  let sb = null;
  let channel = null;

  // ------------------------------------------------------------ helpers
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
  // Outside links render as tappable pills: label, site name, and an arrow so it's clear they leave the app.
  const siteOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const link = (u, label) => (safeUrl(u) ? `<a class="ext" href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}">${esc(label || 'Open')}<span class="dom">${esc(siteOf(u))}</span><span class="arr" aria-hidden="true">↗</span></a>` : '');
  const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const fmtDate = (iso, opts) => (iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', Object.assign({ weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }, opts || {})) : '');
  const daysUntil = (iso) => Math.round((new Date(iso + 'T12:00:00Z') - new Date(todayISO() + 'T12:00:00Z')) / 86400000);
  const ago = (ts) => {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ });
  };
  const who = (uid) => (state.members.find((m) => m.user_id === uid) || {}).display_name || 'Someone';
  const whoName = who;
  const collegeName = (id) => (state.colleges.find((c) => c.id === id) || {}).name || '';
  const isOpen = (t) => !CLOSED.has(t.status);
  const byDue = (a, b) => (a.due_date || '9999') .localeCompare(b.due_date || '9999') || (a.priority - b.priority) || a.title.localeCompare(b.title);
  const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
  const money = (v) => (v < 0 ? '−$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US');
  const stars = (n) => (n ? '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n) : '');
  const applyingColleges = () => state.colleges.filter((c) => c.status !== 'Not applying' && (c.priority <= 4 || !['Researching'].includes(c.status)));

  // The configured week while it lasts; afterwards a rolling 7 days from today.
  function weekWindow() {
    const t = todayISO();
    if (t >= WEEK_START && t <= WEEK_END) return { start: WEEK_START, end: WEEK_END, rolling: false };
    return { start: t, end: addDays(t, 6), rolling: true };
  }

  // Every dated item in one list: tasks, college deadlines, scholarship deadlines, visits.
  // active = something the family still has to act on by that date.
  function allEvents() {
    const ev = [];
    state.tasks.forEach((t) => { if (t.due_date) ev.push({ kind: 'task', date: t.due_date, time: t.due_time, id: t.id, title: t.title, owner: t.owner, active: isOpen(t), row: t }); });
    state.colleges.forEach((c) => { if (c.deadline && c.status !== 'Not applying') ev.push({ kind: 'college', date: c.deadline, time: c.deadline_time, id: c.id, title: c.name + ' deadline', active: !COLLEGE_DONE.includes(c.status), row: c }); });
    state.scholarships.forEach((s) => { if (s.deadline && !['Not pursuing', 'Not awarded'].includes(s.status)) ev.push({ kind: 'sch', date: s.deadline, time: s.deadline_time, id: s.id, title: s.name, active: SCH_ACTIVE.includes(s.status), row: s }); });
    state.visits.forEach((v) => { if (v.visit_date) ev.push({ kind: 'visit', date: v.visit_date, id: v.id, title: (collegeName(v.college_id) || 'Visit') + ' · ' + v.kind, active: v.visit_date >= todayISO(), row: v }); });
    return ev.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  }
  const EV_ICON = { task: '✓', college: '<svg class="ico sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9.5 12 5l9 4.5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/></svg>', sch: '$', visit: '•' };
  // Compact one-line row for non-task deadlines (tasks keep their full card).
  function evRow(e) {
    const href = e.kind === 'college' ? `#/college/${e.id}` : e.kind === 'sch' ? '#/scholarships' : '#/visits';
    const src = e.kind === 'college' ? e.row.source_url : e.kind === 'sch' ? e.row.link : null;
    return `<div class="card evrow ev-${e.kind} ${e.active ? '' : 'muted'}">
      <span class="evic" aria-hidden="true">${EV_ICON[e.kind]}</span>
      <div class="body"><a href="${href}" class="title">${esc(e.title)}</a>
        <div class="meta">${dueChip(e.date, e.time, !e.active)}${e.kind === 'sch' ? statusChip(e.row.status) : ''}${e.kind === 'college' ? statusChip(e.row.status) : ''}${safeUrl(src) ? link(src, 'Official source') : ''}</div></div>
    </div>`;
  }
  function ring(pct, label, center) {
    const r = 26, c = 2 * Math.PI * r;
    pct = Math.max(0, Math.min(100, pct || 0));
    return `<svg class="ring" viewBox="0 0 64 64" role="img" aria-label="${esc(label)}"><circle cx="32" cy="32" r="${r}" class="ring-bg"/><circle cx="32" cy="32" r="${r}" class="ring-fg" stroke-dasharray="${(c * pct / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 32 32)"/><text x="32" y="37" text-anchor="middle">${esc(center == null ? pct + '%' : center)}</text></svg>`;
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function dueChip(iso, time, closed) {
    if (!iso) return '<span class="chip">No date</span>';
    const d = daysUntil(iso);
    const label = fmtDate(iso) + (time ? ' ' + esc(time) : '');
    if (closed) return `<span class="chip">${label}</span>`;
    if (d < 0) return `<span class="chip bad">Overdue · ${label}</span>`;
    if (d === 0) return `<span class="chip bad">Today${time ? ' ' + esc(time) : ''}</span>`;
    if (d <= 2) return `<span class="chip warn">${label}</span>`;
    return `<span class="chip">${label}</span>`;
  }
  function statusChip(s) {
    const cls = { Done: 'good', Submitted: 'good', Complete: 'good', Admitted: 'good', Awarded: 'good', 'Waiting on others': 'warn', 'In progress': 'info', Denied: 'bad', 'Not awarded': 'bad' }[s] || '';
    return `<span class="chip ${cls}">${esc(s)}</span>`;
  }
  function sourceLine(url, verified) {
    const v = verified ? `Verified ${fmtDate(verified, { weekday: undefined })}` : '<span class="unv">Unverified — confirm with school</span>';
    return `<div class="src muted">${v}${safeUrl(url) ? ' ' + link(url, 'Official source') : ''}</div>`;
  }

  // ------------------------------------------------------------ data
  async function loadAll() {
    const results = await Promise.all([sb.from('members').select('*')].concat(TABLES.map((t) => {
      let q = sb.from(t).select('*');
      (TABLE_ORDER[t] || []).forEach((c) => { q = q.order(c); });
      return q;
    })));
    const err = results.find((r) => r.error);
    if (err) throw err.error;
    state.members = results[0].data || [];
    TABLES.forEach((t, i) => { state[t] = results[i + 1].data || []; });
    state.me = state.members.find((m) => m.user_id === state.session.user.id) || null;
    state.loaded = true;
  }

  let reloadTimer = null;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      try { await loadAll(); if (!$sheet.open) render(); } catch (e) { console.error(e); }
    }, 250);
  }

  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('family-sync');
    TABLES.forEach((t) => channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, scheduleReload));
    channel.subscribe((status) => { state.syncStatus = status; if (state.me && !$sheet.open) chrome(true); });
  }

  async function save(table, row, id) {
    const clean = Object.assign({}, row);
    delete clean.updated_at; delete clean.updated_by; delete clean.id;
    const q = id ? sb.from(table).update(clean).eq('id', id).select() : sb.from(table).insert(clean).select();
    const { data, error } = await q;
    if (error) { toast('Save failed: ' + error.message); throw error; }
    if (!data || !data.length) { toast('Save was blocked — check that your account is in the family workspace.'); throw new Error('blocked'); }
    const saved = data[0];
    const list = state[table];
    const i = list.findIndex((r) => r.id === saved.id);
    if (i >= 0) list[i] = saved; else list.push(saved);
    return saved;
  }
  async function remove(table, id) {
    const { error } = await sb.from(table).delete().eq('id', id);
    if (error) { toast('Delete failed: ' + error.message); throw error; }
    state[table] = state[table].filter((r) => r.id !== id);
  }

  // Reads pasted or shared text (an email, a note) and guesses a task: title, earliest upcoming date, time, link, category, college.
  const QP_MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function parseQuick(text, today) {
    const raw = String(text || '').replace(/\r/g, '').trim().slice(0, 8000);
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const HDR = /^(from|to|cc|bcc|sent|date|reply-to)\s*:/i;
    const SKIP = (l) => HDR.test(l) || /^-+\s*(forwarded|original) message/i.test(l) || /^on .+ wrote:$/i.test(l) || /^begin forwarded message/i.test(l);
    const subj = lines.find((l) => /^subject\s*:/i.test(l));
    let title = subj ? subj.replace(/^subject\s*:\s*/i, '') : (lines.find((l) => !SKIP(l)) || '');
    title = title.replace(/^((re|fwd?|fw)\s*:\s*)+/i, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    if (title.length > 120) title = title.slice(0, 117).replace(/\s+\S*$/, '') + '…';
    const um = raw.match(/https?:\/\/[^\s<>"')\]]+/i);
    const url = um ? um[0].replace(/[.,;:]+$/, '') : null;
    const body = lines.filter((l) => !SKIP(l)).join('\n');
    const ty = +today.slice(0, 4);
    const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
    const withYear = (y, m, d) => { if (y) return iso(y < 100 ? 2000 + y : y, m, d); const a = iso(ty, m, d); return a && a < today ? iso(ty + 1, m, d) : a; };
    const found = [];
    let mm;
    const reIso = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
    while ((mm = reIso.exec(body))) found.push(iso(+mm[1], +mm[2], +mm[3]));
    const reMon = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(20\d\d))?/gi;
    while ((mm = reMon.exec(body))) found.push(withYear(mm[3] ? +mm[3] : 0, QP_MON[mm[1].slice(0, 3).toLowerCase()], +mm[2]));
    const reNum = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g;
    while ((mm = reNum.exec(body))) found.push(withYear(mm[3] ? +mm[3] : 0, +mm[1], +mm[2]));
    const dates = found.filter((d) => d && d >= today).sort();
    if (!dates.length) {
      const wd = body.match(/\b(sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)day\b/i);
      if (wd) {
        const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(wd[1].slice(0, 3).toLowerCase());
        const t0 = new Date(today + 'T12:00:00Z');
        const ahead = ((want - t0.getUTCDay() + 7) % 7) || 7;
        t0.setUTCDate(t0.getUTCDate() + ahead);
        dates.push(t0.toISOString().slice(0, 10));
      }
    }
    const tm = body.match(/\b(\d{1,2})(?::(\d\d))?\s*([ap])\.?\s?m\b\.?/i);
    const time = tm && dates.length ? `${+tm[1]}:${tm[2] || '00'} ${tm[3].toUpperCase()}M` : null;
    const low = raw.toLowerCase();
    const category = /scholarship/.test(low) ? 'Scholarship'
      : /fafsa|css profile|financial aid|fsa id|net price/.test(low) ? 'Financial aid'
      : /essay|supplement|portfolio|slideroom/.test(low) ? 'Essays'
      : /transcript|counselor|recommendation|school report/.test(low) ? 'School materials'
      : /deadline|application|admission|apply/.test(low) ? 'Admissions' : 'Other';
    const college = /michigan state|\bmsu\b|broad college/i.test(raw) ? 'Michigan State University'
      : /michigan tech|\bmtu\b/i.test(raw) ? 'Michigan Technological University'
      : /northern michigan|\bnmu\b/i.test(raw) ? 'Northern Michigan University'
      : /university of michigan|\bu-m\b|\bumich\b|\bross\b|ann arbor/i.test(raw) ? 'University of Michigan' : null;
    return { title: title || 'New item', due_date: dates[0] || null, due_time: time, source_url: url, category, college, notes: raw };
  }

  function openQuickAdd() {
    const canPaste = !!(navigator.clipboard && navigator.clipboard.readText);
    $sheet.innerHTML = `<form method="dialog" id="qaForm">
      <h2 style="margin-top:0">Paste to add</h2>
      <p class="small">Paste an email, a text, or a note. The app fills in a new task for you to check: title, date, time, link, college. Dated tasks show on the calendar.</p>
      <label class="f" for="qaText">Text<textarea id="qaText" rows="8" placeholder="Paste here"></textarea></label>
      <div class="actions">${canPaste ? '<button type="button" id="qaPaste">Paste from clipboard</button>' : '<div></div>'}
        <div class="row"><button type="button" id="qaCancel">Cancel</button><button type="submit" class="primary" id="qaNext">Next</button></div></div>
    </form>`;
    const ta = $sheet.querySelector('#qaText');
    $sheet.querySelector('#qaCancel').onclick = () => $sheet.close();
    if (canPaste) $sheet.querySelector('#qaPaste').onclick = async () => { try { ta.value = await navigator.clipboard.readText(); } catch (e) { toast('Tap the box and paste instead'); ta.focus(); } };
    $sheet.querySelector('#qaForm').onsubmit = (e) => {
      e.preventDefault();
      if (!ta.value.trim()) { toast('Paste some text first'); return; }
      const q = parseQuick(ta.value, todayISO());
      const col = q.college ? state.colleges.find((c) => c.name === q.college) : null;
      $sheet.close();
      editTask(null, { title: q.title, due_date: q.due_date, due_time: q.due_time, source_url: q.source_url, category: q.category, college_id: col ? col.id : null, notes: q.notes, owner: state.me && state.me.role === 'parent' ? 'Parent' : 'Lily' });
      toast(q.due_date ? 'Check the date, then Save' : 'No date found. Add one to put it on the calendar');
    };
    if (!$sheet.open) $sheet.showModal();
    ta.focus();
  }

  async function openShareSetup() {
    const { data, error } = await sb.from('quick_add').select('token').eq('id', 1).maybeSingle();
    if (error || !data) { toast('Could not load the sharing link.'); return; }
    const url = `${CFG.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/quick-add?key=${encodeURIComponent(data.token)}`;
    $sheet.innerHTML = `<form method="dialog">
      <h2 style="margin-top:0">Add from iPhone Share</h2>
      <p class="small">Build a one-time Shortcut. Then select text in Mail, Messages, Notes, or Safari, tap <b>Share</b>, and choose <b>Add to College Plan</b>. It becomes a task owned by Both, ready for you to check.</p>
      <label class="f">Your private link<input id="shUrl" readonly value="${esc(url)}"></label>
      <p><button type="button" class="primary" id="shCopy">Copy link</button></p>
      <ol class="small steps">
        <li>Copy the link above. Open the <b>Shortcuts</b> app and tap <b>+</b>.</li>
        <li>Name it <b>Add to College Plan</b>. Tap the <b>ⓘ</b> (or the name › Details) and turn on <b>Show in Share Sheet</b>.</li>
        <li>At the top it says <b>Receive Any input from Share Sheet</b>. Tap <b>Any</b> and keep <b>Text</b>, <b>Rich text</b>, <b>URLs</b>, and <b>Safari web pages</b>. Set <b>If there’s no input</b> to <b>Ask For Text</b>.</li>
        <li>Add the action <b>Get Contents of URL</b>. Paste the link as the URL. Tap the arrow: Method <b>POST</b>, Request Body <b>JSON</b>, add a <b>Text</b> field named <code>text</code>, and set its value to <b>Shortcut Input</b>.</li>
        <li>Add the action <b>Show Notification</b> and set it to <b>Contents of URL</b>, so you see what was added.</li>
        <li>Test it: select a sentence with a date in Notes, Share › <b>Add to College Plan</b>. Then check All tasks.</li>
      </ol>
      <p class="small muted">Anyone with this link can add tasks, so keep it in the family. Reset makes the old link stop working (update the Shortcut after).</p>
      <div class="actions"><button type="button" class="danger" id="shReset">Reset link</button><button type="button" class="primary" id="shClose">Done</button></div>
    </form>`;
    $sheet.querySelector('#shClose').onclick = () => $sheet.close();
    $sheet.querySelector('#shCopy').onclick = async () => {
      const el = $sheet.querySelector('#shUrl');
      try { await navigator.clipboard.writeText(el.value); toast('Link copied'); } catch (e) { el.select(); toast('Select the link and copy it'); }
    };
    $sheet.querySelector('#shReset').onclick = async () => {
      if (!window.confirm('Reset the sharing link? Shortcuts using the old link will stop working until you paste the new one.')) return;
      const r = await sb.rpc('rotate_quick_add_key');
      if (r.error) { toast('Reset failed: ' + r.error.message); return; }
      toast('New link created'); openShareSetup();
    };
    if (!$sheet.open) $sheet.showModal();
  }

  // ------------------------------------------------------------ task rendering
  function taskCard(t, opts) {
    opts = opts || {};
    const closed = !isOpen(t);
    const cl = Array.isArray(t.checklist) ? t.checklist : [];
    const doneCount = cl.filter((c) => c.done).length;
    const col = t.college_id ? collegeName(t.college_id) : '';
    return `<div class="card task ${closed ? 'done' : ''}" data-task="${t.id}">
      <div class="body">
        <div class="title" data-edit-task="${t.id}">${esc(t.title)}</div>
        <div class="meta">
          ${dueChip(t.due_date, t.due_time, closed)}
          <button type="button" class="chip owner-${esc(t.owner)} ownbtn" data-owner="${t.id}" title="Tap to reassign" aria-label="Owner ${esc(t.owner)}, tap to reassign">${esc(t.owner)} ⇄</button>
          ${col && !opts.hideCollege ? `<span class="chip">${esc(col)}</span>` : ''}
          ${cl.length ? `<span class="chip">${doneCount}/${cl.length} steps</span>` : ''}
          <select class="status" data-status="${t.id}" aria-label="Status">
            ${TASK_STATUS.map((s) => `<option ${s === t.status ? 'selected' : ''}>${s === 'Not needed' && t.status !== s ? 'Not needed…' : s}</option>`).join('')}
            <option disabled>──────</option>
            <option value="__remove">Remove task…</option>
          </select>
        </div>
        ${t.blocker ? `<div class="blocker">⚠ Blocked: ${esc(t.blocker)}</div>` : ''}
        ${opts.expand && cl.length ? `<ul class="checklist">${cl.map((c, i) => `<li class="${c.done ? 'd' : ''}"><input type="checkbox" data-check="${t.id}" data-i="${i}" ${c.done ? 'checked' : ''} id="c-${t.id}-${i}"><label for="c-${t.id}-${i}"><span>${esc(c.text)}</span></label></li>`).join('')}</ul>` : ''}
        ${opts.expand && t.notes ? `<div class="small muted pre" style="margin-top:6px">${esc(t.notes)}</div>` : ''}
        ${opts.expand && (t.source_url || t.due_date) ? sourceLine(t.source_url, t.verified_on) : ''}
        ${t.updated_at ? `<div class="small muted" style="margin-top:4px">Updated ${ago(t.updated_at)}${t.updated_by ? ' by ' + esc(who(t.updated_by)) : ''}</div>` : ''}
      </div>
    </div>`;
  }

  function wireTasks(root) {
    root.querySelectorAll('[data-status]').forEach((sel) => sel.addEventListener('change', async () => {
      const t = state.tasks.find((x) => x.id === sel.dataset.status);
      const v = sel.value.replace('…', '');
      if (v === '__remove') {
        if (!window.confirm(`Remove "${t.title}" permanently?\n\nThis can't be undone. To keep a record instead, choose "Not needed".`)) { sel.value = t.status; return; }
        try { await remove('tasks', t.id); toast('Task removed'); render(); } catch (e) { sel.value = t.status; }
        return;
      }
      if (v === 'Not needed' && !window.confirm(`Mark "${t.title}" as not needed?\n\nIt leaves Home, the calendar, and progress. Find it again under All tasks › Not needed.`)) { sel.value = t.status; return; }
      try { await save('tasks', { status: v }, t.id); toast('Status: ' + v); render(); } catch (e) { sel.value = t.status; }
    }));
    root.querySelectorAll('[data-check]').forEach((cb) => cb.addEventListener('change', async () => {
      const t = state.tasks.find((x) => x.id === cb.dataset.check);
      const cl = (t.checklist || []).map((c) => Object.assign({}, c));
      cl[+cb.dataset.i].done = cb.checked;
      try { await save('tasks', { checklist: cl }, t.id); render(); } catch (e) { cb.checked = !cb.checked; }
    }));
    root.querySelectorAll('[data-edit-task]').forEach((el) => el.addEventListener('click', () => editTask(el.dataset.editTask)));
    root.querySelectorAll('[data-owner]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const t = state.tasks.find((x) => x.id === b.dataset.owner); if (!t) return;
      const next = OWNERS[(OWNERS.indexOf(t.owner) + 1) % OWNERS.length];
      try { await save('tasks', { owner: next }, t.id); toast(`Reassigned to ${next}`); render(); } catch (err) { /* toast shown */ }
    }));
  }

  // ------------------------------------------------------------ views
  // ------------------------------------------------------------ home
  const APP_PARTS = [['application', 'App', 'Application'], ['essays', 'Essays', 'Essays'], ['recs', 'Recs', 'Recommendations'], ['transcript', 'Transc.', 'Transcript'], ['scores', 'Tests', 'Test scores'], ['fee', 'Fee', 'Fee']];
  const TRACK_NAME = { 'University of Michigan': 'U-M', 'Michigan State University': 'MSU', 'Michigan Technological University': 'MTU', 'Northern Michigan University': 'NMU' };
  const PART_STATES = ['missing', 'progress', 'done', 'na'];
  const PART_LABEL = { missing: 'Missing', progress: 'In progress', done: 'Done', na: 'Not needed' };
  const PART_MARK = { missing: '', progress: '◐', done: '✓', na: '—' };
  // Home always opens on All; the Lily / Me choice lasts until the page is refreshed.
  let homeWhoChoice = 'Everyone';
  function homeWho() { return homeWhoChoice; }
  function viewDashboard() {
    const today = todayISO();
    const who = homeWho();
    const mine = (t) => who === 'Everyone' || t.owner === who || t.owner === 'Both';
    const open = state.tasks.filter(isOpen).filter(mine).sort(byDue);
    const overdue = open.filter((t) => t.due_date && t.due_date < today);
    const dueToday = open.filter((t) => t.due_date === today);
    const w = weekWindow();
    const weekAll = state.tasks.filter(mine).filter(counts).filter((t) => t.due_date && t.due_date >= w.start && t.due_date <= w.end);
    const weekDone = weekAll.filter((t) => !isOpen(t)).length;
    const otherActive = allEvents().filter((e) => e.kind !== 'task' && e.kind !== 'visit' && e.active);
    const otherOverdue = otherActive.filter((e) => e.date < today);
    const countdown = otherActive.filter((e) => e.date >= today).slice(0, 4);
    // Today: overdue first, then due today, then the next items so there are always up to 3 actions.
    const todayList = overdue.concat(dueToday);
    const focus = (todayList.length ? todayList : open).slice(0, 3);
    const moreToday = Math.max(0, todayList.length - focus.length);
    // Next 7 days strip.
    const days = []; for (let i = 0; i < 7; i++) days.push(addDays(today, i));
    const evs = allEvents().filter((e) => e.active && (e.kind !== 'task' || mine(e.row)));
    // Waiting on others: tasks marked waiting/blocked, plus recommenders who agreed but haven't submitted.
    const waiting = state.tasks.filter(isOpen).filter((t) => t.status === 'Waiting on others' || (t.blocker && t.blocker.trim()))
      .map((t) => ({ title: t.title, on: t.blocker || 'Others', since: t.updated_at, task: t.id }))
      .concat(state.recommenders.filter((r) => ['Asked', 'Agreed'].includes(r.status)).map((r) => ({ title: (r.for_what || 'Recommendation'), on: r.name || r.role, since: r.asked_on ? r.asked_on + 'T12:00:00Z' : r.updated_at, rec: r.id })));
    const applying = state.colleges.filter((c) => c.priority <= 4 && c.status !== 'Not applying').sort((a, b) => a.priority - b.priority);
    const schNext = state.scholarships.filter((s) => SCH_ACTIVE.includes(s.status) && s.deadline && s.deadline >= today).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 3);
    const localOpen = state.scholarships.filter((s) => scopeOf(s) === 'Local' && ['Researching', 'Planning', 'In progress'].includes(s.status)).length;
    const awarded = state.scholarships.filter((s) => s.status === 'Awarded').length;
    const recent = [].concat(
      state.tasks.map((r) => ({ t: r.updated_at, by: r.updated_by, label: r.title, kind: 'task', status: r.status })),
      state.colleges.map((r) => ({ t: r.updated_at, by: r.updated_by, label: r.name, kind: 'college', status: r.status })),
      state.scholarships.map((r) => ({ t: r.updated_at, by: r.updated_by, label: r.name, kind: 'scholarship', status: r.status }))
    ).filter((r) => r.by).sort((a, b) => (b.t || '').localeCompare(a.t || '')).slice(0, 3);
    const nOver = overdue.length + otherOverdue.length;
    const ready = readiness();
    return `
      <div class="spread"><h1>Hi${state.me ? ', ' + esc(state.me.display_name) : ''}</h1>
        <div class="seg" role="tablist" aria-label="Whose tasks">${[['Lily', 'Lily'], ['Parent', state.me && state.me.role === 'parent' ? 'Me' : 'Parent'], ['Everyone', 'All']].map(([k, l]) => `<button type="button" data-who="${k}" class="${who === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div></div>
      <div class="stats three">
        <button type="button" class="card stat ${nOver ? 'bad' : ''}" data-scrollto="today"><div class="n">${nOver}</div><div class="l">Overdue</div></button>
        <a class="card stat" href="#/week"><div class="n">${weekDone}<small>/${weekAll.length}</small></div><div class="l">Done this week</div><div class="bar"><i style="width:${weekAll.length ? Math.round((weekDone / weekAll.length) * 100) : 0}%"></i></div></a>
        <a class="card stat" href="#/tasks" data-ownerfilter="${who === 'Everyone' ? 'All' : who}"><div class="n">${open.length}</div><div class="l">Open ${who === 'Everyone' ? 'tasks' : 'for ' + (who === 'Parent' ? 'Parent' : 'Lily')}</div></a>
      </div>

      ${countdown.length ? `<div class="countdown">${countdown.map((e) => { const d = daysUntil(e.date); return `<a class="card cd ${d <= 3 ? 'hot' : d <= 10 ? 'warm' : ''}" href="${e.kind === 'college' ? '#/college/' + e.id : '#/scholarships'}"><div class="cdn">${d === 0 ? 'Today' : d}</div><div class="cdl">${d === 0 ? '' : d === 1 ? 'day' : 'days'}</div><div class="cdt">${EV_ICON[e.kind]} ${esc(e.kind === 'college' ? (SHORT_NAME[e.row.name] || e.row.name) + ' deadline' : e.title)}</div><div class="small muted">${fmtDate(e.date)}${e.time ? ' · ' + esc(e.time) : ''}</div></a>`; }).join('')}</div>` : ''}

      <h2 id="today">Today</h2>
      <div class="card todaycard">
        ${focus.length ? focus.map((t) => taskCard(t, { expand: true })).join('') : '<p class="muted">Nothing due. 🎉</p>'}
        ${moreToday ? `<p class="small"><a href="#/tasks">+ ${moreToday} more overdue or due today →</a></p>` : ''}
        ${otherOverdue.length ? otherOverdue.map(evRow).join('') : ''}
      </div>
      <div class="weekstrip">${days.map((d) => { const n = evs.filter((e) => e.date === d).length; const hot = evs.some((e) => e.date === d && e.kind !== 'task'); return `<a href="#/calendar" data-jumpday="${d}" class="ws ${d === today ? 'today' : ''} ${hot ? 'hot' : ''}"><span class="wd">${fmtDate(d, { weekday: 'short', month: undefined, day: undefined })}</span><b>${new Date(d + 'T12:00:00Z').getUTCDate()}</b><span class="dots">${'•'.repeat(Math.min(n, 4))}${n > 4 ? '+' : ''}</span></a>`; }).join('')}</div>

      <div class="spread"><h2>Applications</h2><span class="small muted" style="margin-top:1.6rem">Tap a box to update</span></div>
      <div class="card tracker">
        <div class="trow thead"><span></span>${APP_PARTS.map(([, l, full]) => `<span title="${esc(full)}"><i class="sm">${l}</i><i class="lg">${full}</i></span>`).join('')}</div>
        ${applying.map((c) => { const parts = c.app_parts || {}; const done = APP_PARTS.filter(([k]) => ['done', 'na'].includes(parts[k])).length; return `<div class="trow">
          <a class="tname" href="#/college/${c.id}"><b><i class="sm">${esc(TRACK_NAME[c.name] || c.name)}</i><i class="lg">${esc(SHORT_NAME[c.name] || c.name)}</i></b><small>${c.deadline ? fmtDate(c.deadline, { weekday: undefined }) : esc(c.plan)} · ${done}/6</small></a>
          ${APP_PARTS.map(([k, , full]) => { const v = parts[k] || 'missing'; return `<button type="button" class="tcell st-${v}" data-part="${c.id}|${k}" title="${esc(full)}: ${PART_LABEL[v]}" aria-label="${esc(c.name)} ${esc(full)}: ${PART_LABEL[v]}">${PART_MARK[v]}</button>`; }).join('')}
        </div>`; }).join('')}
        <div class="tlegend small muted"><span><i class="tcell st-done">✓</i>Done</span><span><i class="tcell st-progress">◐</i>In progress</span><span><i class="tcell st-missing"></i>Missing</span><span><i class="tcell st-na">—</i>Not needed</span></div>
      </div>

      ${waiting.length ? `<h2>Waiting on others</h2><div class="card">${waiting.map((x) => `<div class="wrow" ${x.task ? `data-edit-task="${x.task}"` : `data-rec="${x.rec}"`}><div><b>${esc(x.on)}</b><div class="small">${esc(x.title)}</div></div><span class="chip warn">${x.since ? 'since ' + ago(x.since) : 'waiting'}</span></div>`).join('')}</div>` : ''}

      <div class="spread"><h2>Scholarships</h2><a href="#/scholarships" class="small" style="margin-top:1.6rem">All →</a></div>
      <div class="card">
        <div class="row" style="margin-bottom:6px"><button type="button" class="chip sc-local" data-scopejump="Local">★ ${localOpen} local to work on</button>${awarded ? `<span class="chip good">${awarded} awarded</span>` : ''}</div>
        ${schNext.length ? schNext.map((s) => `<div class="wrow" data-sch="${s.id}"><div><b>${esc(s.name)}</b><div class="small muted">${scopeChip(s)} ${esc(s.amount || '')}</div></div>${dueChip(s.deadline, s.deadline_time, false)}</div>`).join('') : '<p class="muted small">No upcoming deadlines.</p>'}
      </div>

      <div class="spread"><h2>Lily’s readiness</h2><a href="#/profile" class="small" style="margin-top:1.6rem">Profile →</a></div>
      <div class="readyrings">${ready.map((r) => `<a class="card rcell" href="#/profile" data-ptabjump="${r.tab}">${ring(Math.round((r.done / r.total) * 100), r.k + ' ' + r.center, r.center)}<div class="rl">${esc(r.k)}</div><div class="small muted">${esc(r.sub)}</div></a>`).join('')}</div>

      ${recent.length ? `<details class="recent"><summary>Recent changes</summary><ul class="feed">${recent.map((r) => `<li><b>${esc(who === 'x' ? '' : whoName(r.by))}</b> updated ${esc(r.kind)} “${esc(r.label)}” — ${esc(r.status)} <span class="muted">· ${ago(r.t)}</span></li>`).join('')}</ul></details>` : ''}
    `;
  }
  async function cyclePart(cid, key) {
    const c = state.colleges.find((x) => x.id === cid); if (!c) return;
    const parts = Object.assign({}, c.app_parts || {});
    const cur = parts[key] || 'missing';
    parts[key] = PART_STATES[(PART_STATES.indexOf(cur) + 1) % PART_STATES.length];
    try { await save('colleges', { app_parts: parts }, cid); toast(`${SHORT_NAME[c.name] || c.name} · ${APP_PARTS.find(([k]) => k === key)[2]}: ${PART_LABEL[parts[key]]}`); render(); } catch (e) { /* toast shown */ }
  }

  function collegeProgress(c) {
    const ts = state.tasks.filter((t) => t.college_id === c.id && counts(t));
    const d = ts.filter((t) => !isOpen(t)).length;
    return { total: ts.length, done: d, pct: ts.length ? Math.round((d / ts.length) * 100) : 0 };
  }
  function collegeCard(c) {
    const p = collegeProgress(c);
    return `<a class="card" href="#/college/${c.id}">
      <div class="spread"><h3>${esc(c.name)}</h3>${statusChip(c.status)}</div>
      <div class="small muted">${esc(c.program || '')}</div>
      <div class="row" style="margin-top:8px">
        <span class="chip ${c.plan === 'ED' ? 'bad' : 'info'}">${esc(c.plan)}${c.plan === 'ED' ? ' · binding' : ''}</span>
        ${c.deadline ? dueChip(c.deadline, c.deadline_time, ['Submitted', 'Complete', 'Admitted'].includes(c.status)) : '<span class="chip">No deadline set</span>'}
        ${c.deadline && !c.verified_on ? '<span class="chip warn">Unverified</span>' : ''}
      </div>
      <div class="bar"><i style="width:${p.pct}%"></i></div>
      <div class="small muted">${p.done}/${p.total} tasks done</div>
    </a>`;
  }

  const calToggle = (on) => `<div class="seg" role="tablist"><a href="#/calendar" class="${on === 'month' ? 'on' : ''}">Month</a><a href="#/week" class="${on === 'week' ? 'on' : ''}">Week</a></div>`;

  function viewWeek() {
    const today = todayISO();
    const w = weekWindow();
    const days = [];
    for (let d = w.start; d <= w.end; d = addDays(d, 1)) days.push(d);
    const inWeek = state.tasks.filter((t) => t.due_date && t.due_date >= w.start && t.due_date <= w.end).sort(byDue);
    const others = allEvents().filter((e) => e.kind !== 'task' && e.date >= w.start && e.date <= w.end);
    const blocked = inWeek.filter((t) => t.blocker && isOpen(t));
    const [filter] = [sessionGet('weekOwner') || 'All'];
    const show = (t) => filter === 'All' || t.owner === filter || t.owner === 'Both';
    return `
      <div class="spread"><h1>${w.rolling ? 'Next 7 days' : 'This week'}</h1>${calToggle('week')}</div>
      <p class="muted small">${fmtDate(w.start)} – ${fmtDate(w.end)} · dates are ${esc(TZ.replace('_', ' '))} time</p>
      <div class="filters">
        <select id="weekOwner">${['All', 'Lily', 'Parent'].map((o) => `<option ${o === filter ? 'selected' : ''}>${o}</option>`).join('')}</select>
        <button id="quickAdd">Paste to add</button>
        <button class="primary" id="addTask">+ Task</button>
      </div>
      ${blocked.length ? `<div class="alert bad"><b>${blocked.length} blocked:</b> ${blocked.map((t) => esc(t.title)).join('; ')}</div>` : ''}
      ${days.map((d) => {
        const list = inWeek.filter((t) => t.due_date === d && show(t));
        const ev = others.filter((e) => e.date === d);
        return `<div class="daylabel ${d === today ? 'today' : ''}">${fmtDate(d)}</div>
          ${ev.map(evRow).join('')}${list.length ? list.map((t) => taskCard(t, { expand: true })).join('') : (ev.length ? '' : '<p class="muted small">Nothing scheduled.</p>')}`;
      }).join('')}
    `;
  }

  // ------------------------------------------------------------ calendar
  function viewCalendar() {
    const today = todayISO();
    const ym = sessionGet('calM') || today.slice(0, 7);
    const [y, mo] = ym.split('-').map(Number);
    const first = `${ym}-01`;
    const lead = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    const nDays = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const ev = allEvents();
    const byDay = {};
    ev.forEach((e) => { (byDay[e.date] = byDay[e.date] || []).push(e); });
    let sel = sessionGet('calD');
    if (!sel || sel.slice(0, 7) !== ym) sel = today.slice(0, 7) === ym ? today : first;
    const monthName = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<div class="cday blank" aria-hidden="true"></div>');
    for (let d = 1; d <= nDays; d++) {
      const iso = `${ym}-${String(d).padStart(2, '0')}`;
      const list = byDay[iso] || [];
      const dow = (lead + d - 1) % 7;
      const hot = list.some((e) => e.active && e.date < today);
      cells.push(`<button type="button" class="cday ${iso === today ? 'today' : ''} ${iso === sel ? 'sel' : ''} ${dow === 0 || dow === 6 ? 'wkend' : ''} ${iso < today ? 'past' : ''}" data-day="${iso}" aria-label="${fmtDate(iso)}, ${list.length} item${list.length === 1 ? '' : 's'}">
        <span class="dn">${d}</span>
        <span class="evs">${list.slice(0, 3).map((e) => `<i class="ev ev-${e.kind} ${e.kind === 'task' ? 'owner-' + esc(e.owner) : ''} ${e.active ? '' : 'off'}">${esc(e.title)}</i>`).join('')}${list.length > 3 ? `<i class="ev more">+${list.length - 3}</i>` : ''}</span>
        ${hot ? '<span class="flag" aria-hidden="true"></span>' : ''}
      </button>`);
    }
    while (cells.length % 7) cells.push('<div class="cday blank" aria-hidden="true"></div>');
    // One continuous agenda of every dated item, past and future. Tapping a day only
    // jumps to it; everything before and after stays in the list.
    const agendaDays = Object.keys(byDay);
    if (!agendaDays.includes(sel)) agendaDays.push(sel);
    agendaDays.sort();
    const monthLabel = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
    const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    const agendaItem = (e) => (e.kind === 'task' ? taskCard(e.row, { expand: true }) : evRow(e));
    return `
      <div class="spread"><h1>Calendar</h1>${calToggle('month')}</div>
      <div class="wallcal">
        <div class="rings" aria-hidden="true"><i></i><i></i></div>
        <div class="wchead">
          <button type="button" class="calnav" data-calnav="${prev}" aria-label="Previous month">‹</button>
          <div class="wctitle"><div class="wcm">${esc(monthName)}</div><div class="wcy">${y}</div></div>
          <button type="button" class="calnav" data-calnav="${next}" aria-label="Next month">›</button>
        </div>
        <div class="wcdow">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div>${d}</div>`).join('')}</div>
        <div class="wcgrid">${cells.join('')}</div>
      </div>
      <div class="legend small">
        <span><i class="dot ev-task owner-Lily"></i>Lily</span><span><i class="dot ev-task owner-Parent"></i>Parent</span><span><i class="dot ev-task owner-Both"></i>Both</span>
        <span><i class="dot ev-college"></i>College deadline</span><span><i class="dot ev-sch"></i>Scholarship</span><span><i class="dot ev-visit"></i>Visit</span>
      </div>
      <div class="row" style="margin:10px 0 0">
        ${ym !== today.slice(0, 7) ? `<button type="button" data-calnav="${today.slice(0, 7)}">Today</button>` : ''}
        <button type="button" id="quickAdd">Paste to add</button>
        <button type="button" class="primary" id="subBtn">Subscribe in iPhone Calendar</button>
      </div>
      <h2>Everything, by date</h2>
      <p class="small muted">Tap a day above to jump to it. Finished items stay in the list, grayed out.</p>
      ${agendaDays.map((d, i) => {
        const list = byDay[d] || [];
        const newMonth = i === 0 || d.slice(0, 7) !== agendaDays[i - 1].slice(0, 7);
        return `${newMonth ? `<div class="agmonth" id="agm-${d.slice(0, 7)}">${esc(monthLabel(d))}</div>` : ''}<div class="agday ${d === sel ? 'sel' : ''} ${d === today ? 'today' : ''} ${d < today ? 'past' : ''}" id="ag-${d}">
          <div class="aghead"><span>${fmtDate(d, { weekday: 'long', month: 'long' })}${d === today ? ' <i class="tag">Today</i>' : ''}</span><button type="button" class="link" data-tomonth>↑ Month</button></div>
          ${list.length ? list.map(agendaItem).join('') : '<p class="muted small">Nothing on this day.</p>'}
        </div>`;
      }).join('')}
    `;
  }

  // Scroll the agenda so a day's heading sits just under the sticky top bar.
  // Measured after two animation frames so Safari has finished laying out the new list.
  function jumpToDay(day) {
    const go = () => {
      const el = document.getElementById('ag-' + day);
      if (!el) return;
      const bar = document.getElementById('topbar');
      const offset = (bar && !bar.hidden ? bar.getBoundingClientRect().height : 0) + 8;
      window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.pageYOffset - offset));
    };
    go();                                              // immediately
    requestAnimationFrame(() => requestAnimationFrame(go)); // after layout settles (Safari)
    setTimeout(go, 120);                               // fallback if frames are paused
  }

  // Live subscription: the calendar-feed Edge Function serves open deadlines to anyone holding
  // the private key in public.calendar_feed (readable only by family members).
  async function openSubscribe() {
    const { data, error } = await sb.from('calendar_feed').select('token,rotated_at').eq('id', 1).maybeSingle();
    if (error || !data) { toast('Could not load the calendar link.'); return; }
    const https = `${CFG.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/calendar-feed?token=${encodeURIComponent(data.token)}`;
    const webcal = https.replace(/^https:/, 'webcal:');
    $sheet.innerHTML = `<form method="dialog" id="subForm">
      <h2 style="margin-top:0">Live calendar feed</h2>
      <p class="small">Subscribe once and every deadline, task, and visit stays current on your phone. Changes in the app show up the next time Calendar refreshes.</p>
      <p><a class="btn primary" href="${esc(webcal)}">Subscribe on this device</a></p>
      <ol class="small steps">
        <li>Tap <b>Subscribe on this device</b>, then <b>Subscribe</b>.</li>
        <li>Set <b>Location</b> to <b>iCloud</b> so it appears on all your Apple devices.</li>
        <li>Turn <b>Remove Alerts</b> off to keep the 9 AM day-before reminders.</li>
        <li>Optional: Settings › Calendar › Accounts › Subscribed Calendars to check it.</li>
      </ol>
      <label class="f">Link for Google Calendar or another app<input id="subUrl" readonly value="${esc(https)}"></label>
      <p class="small muted">Anyone with this link can see the deadlines, so share it only with family. Reset makes the old link stop working.</p>
      <div class="actions"><button type="button" class="danger" id="subReset">Reset link</button>
        <div class="row"><button type="button" id="subCopy">Copy link</button><button type="button" id="subClose" class="primary">Done</button></div></div>
    </form>`;
    $sheet.querySelector('#subClose').onclick = () => $sheet.close();
    $sheet.querySelector('#subCopy').onclick = async () => {
      const el = $sheet.querySelector('#subUrl');
      try { await navigator.clipboard.writeText(el.value); toast('Link copied'); } catch (e) { el.select(); toast('Select the link and copy it'); }
    };
    $sheet.querySelector('#subReset').onclick = async () => {
      if (!window.confirm('Reset the calendar link? Phones subscribed with the old link will stop updating until they subscribe again.')) return;
      const r = await sb.rpc('rotate_calendar_token');
      if (r.error) { toast('Reset failed: ' + r.error.message); return; }
      toast('New link created'); openSubscribe();
    };
    if (!$sheet.open) $sheet.showModal();
  }


  function viewColleges() {
    const list = state.colleges.slice().sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    return `<div class="spread"><h1>Colleges</h1><div class="row"><a class="btn primary" href="#/compare">Compare</a><button id="addCollege">+ Add</button></div></div>
      <div class="grid">${list.map(collegeCard).join('')}</div>`;
  }

  function viewCollege(id) {
    const c = state.colleges.find((x) => x.id === id);
    if (!c) return '<p>College not found. <a href="#/colleges">Back</a></p>';
    const ts = state.tasks.filter((t) => t.college_id === id).sort(byDue);
    const groups = CATEGORIES.map((cat) => [cat, ts.filter((t) => t.category === cat)]).filter(([, l]) => l.length);
    const sch = state.scholarships.filter((s) => s.college_id === id);
    const vis = state.visits.filter((v) => v.college_id === id).sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || ''));
    const off = bestOffer(id);
    const om = off ? offerMath(off) : null;
    const p = collegeProgress(c);
    return `
      <p><a href="#/colleges">← Colleges</a></p>
      <div class="spread"><div><h1 style="margin-bottom:.2rem">${esc(c.name)}</h1><div class="muted">${esc(c.program || '')}</div></div>
        <button id="editCollege" data-id="${c.id}">Edit</button></div>
      <div class="card" style="margin-top:12px">
        <div class="row">${statusChip(c.status)}<span class="chip ${c.plan === 'ED' ? 'bad' : 'info'}">${esc(c.plan)}${c.plan === 'ED' ? ' · BINDING' : ''}</span>
          ${c.deadline ? dueChip(c.deadline, c.deadline_time, ['Submitted', 'Complete', 'Admitted'].includes(c.status)) : ''}</div>
        <div class="bar"><i style="width:${p.pct}%"></i></div><div class="small muted">${p.done}/${p.total} tasks done</div>
        ${c.route ? `<p class="small"><b>Route:</b> ${esc(c.route)}</p>` : ''}
        ${c.deadline ? sourceLine(c.source_url, c.verified_on) : (safeUrl(c.source_url) ? `<div class="src">${link(c.source_url, 'Official site')}</div>` : '')}
        <div class="row" style="margin-top:10px">${safeUrl(c.app_url) ? `<a class="btn primary" href="${esc(c.app_url)}" target="_blank" rel="noopener">Open application portal</a>` : ''}</div>
        ${c.notes ? `<p class="small pre">${esc(c.notes)}</p>` : ''}
        <p class="small"><b>Submission receipt:</b> ${c.submitted_on ? 'Submitted ' + fmtDate(c.submitted_on) : 'Not submitted yet'}${c.receipt_note ? ' — ' + esc(c.receipt_note) : ''}</p>
      </div>
      <div class="spread"><h2>Tasks</h2><button class="primary" id="addTask" data-college="${c.id}" style="margin-top:1rem">+ Task</button></div>
      ${groups.length ? groups.map(([cat, l]) => `<h3 class="muted small" style="margin:1rem 0 .4rem;text-transform:uppercase;letter-spacing:.05em">${esc(cat)}</h3>${l.map((t) => taskCard(t, { expand: true, hideCollege: true })).join('')}`).join('') : '<p class="muted small">No tasks yet.</p>'}
      ${factsSection(c)}
      ${sch.length ? `<h2>Scholarships</h2>${sch.map(schCard).join('')}` : ''}
      <div class="spread"><h2>Visits</h2><button id="addVisit" data-college="${c.id}" style="margin-top:1rem">+ Visit</button></div>
      ${vis.length ? vis.map(visitCard).join('') : '<p class="muted small">No visits logged.</p>'}
      <div class="spread"><h2>Documents</h2><button id="addDoc" data-college="${c.id}" style="margin-top:1rem">+ Upload</button></div>
      ${state.documents.filter((d) => d.college_id === c.id).map(docCard).join('') || '<p class="muted small">No documents for this college yet.</p>'}
      <div class="spread"><h2>Cost</h2><a href="#/money" class="small" style="margin-top:1.6rem">Compare all →</a></div>
      ${off ? `<div class="card small"><b>${esc(off.kind)}:</b> cost ${money(om.coa)} − grants &amp; scholarships ${money(om.free)} = <b>net ${money(om.net)}</b>/yr${om.loans ? ` · loans offered ${money(om.loans)}` : ''}</div>` : `<p class="muted small">No estimate yet. <button type="button" class="link" data-offer-new="${c.id}">Add one</button></p>`}
    `;
  }

  // Scope: where the award comes from. Local first — smallest applicant pools.
  const SCOPES = [
    { k: 'Local', cls: 'sc-local', hint: 'Manistique & U.P. — best odds' },
    { k: 'State & regional', cls: 'sc-state', hint: 'Michigan & Upper Midwest' },
    { k: 'College', cls: 'sc-college', hint: 'From her colleges' },
    { k: 'National', cls: 'sc-nat', hint: 'Biggest pools' }
  ];
  const scopeOf = (s) => s.scope || (s.college_id ? 'College' : 'Unsorted');
  const scopeChip = (s) => { const sc = SCOPES.find((x) => x.k === scopeOf(s)); return `<span class="chip ${sc ? sc.cls : ''}">${esc(scopeOf(s))}</span>`; };

  function schCard(s) {
    return `<div class="card" data-sch="${s.id}" style="cursor:pointer">
      <div class="spread"><div><h3>${esc(s.name)}</h3><div class="small muted">${esc(s.sponsor || '')}</div></div>${statusChip(s.status)}</div>
      <div class="row" style="margin-top:6px">${scopeChip(s)}${s.deadline ? dueChip(s.deadline, s.deadline_time, !['Researching', 'Planning', 'In progress'].includes(s.status)) : '<span class="chip">No deadline</span>'}
        ${s.renewable ? '<span class="chip info">Renewable</span>' : ''}</div>
      ${s.amount ? `<div class="small" style="margin-top:6px"><b>Amount:</b> ${esc(s.amount)} <span class="muted">(not guaranteed)</span></div>` : ''}
      ${s.next_action ? `<div class="small"><b>Next:</b> ${esc(s.next_action)}</div>` : ''}
      ${s.deadline ? sourceLine(s.link, s.verified_on) : (safeUrl(s.link) ? `<div class="src">${link(s.link, 'Details')}</div>` : '')}
    </div>`;
  }

  function viewScholarships() {
    const q = (sessionGet('schQ') || '').toLowerCase();
    const st = sessionGet('schS') || 'Active';
    let list = state.scholarships.slice().sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    if (st === 'Active') list = list.filter((s) => ['Researching', 'Planning', 'In progress'].includes(s.status));
    else if (st !== 'All') list = list.filter((s) => s.status === st);
    if (q) list = list.filter((s) => [s.name, s.sponsor, s.eligibility, s.requirements, s.notes, collegeName(s.college_id)].join(' ').toLowerCase().includes(q));
    const scope = sessionGet('schScope') || 'All';
    const counts = Object.fromEntries(SCOPES.map((x) => [x.k, list.filter((s) => scopeOf(s) === x.k).length]));
    const groups = SCOPES.map((x) => x.k).concat(['Unsorted']).filter((k) => scope === 'All' || k === scope)
      .map((k) => [k, list.filter((s) => scopeOf(s) === k)]).filter(([, l]) => l.length);
    return `<div class="spread"><h1>Scholarships</h1><button class="primary" id="addSch">+ Add</button></div>
      <div class="scopes">
        <button type="button" data-scope="All" class="scope-all ${scope === 'All' ? 'on' : ''}"><b>${list.length}</b><span>All</span></button>
        ${SCOPES.map((x) => `<button type="button" data-scope="${esc(x.k)}" class="${x.cls} ${scope === x.k ? 'on' : ''}"><b>${counts[x.k]}</b><span><i class="lg">${esc(x.k)}</i><i class="sm">${esc(x.k === 'State & regional' ? 'State' : x.k)}</i></span><small>${esc(x.hint)}</small></button>`).join('')}
      </div>
      <p class="small scopenote">★ <b>Local</b> awards have the smallest applicant pools — Lily’s best odds. Tap a tile to filter; <b>All</b> shows everything.</p>
      <div class="filters">
        <input id="schQ" placeholder="Search" value="${esc(sessionGet('schQ') || '')}">
        <select id="schS">${['Active', 'All'].concat(SCH_STATUS).map((o) => `<option ${o === st ? 'selected' : ''}>${o}</option>`).join('')}</select>
      </div>
      <p class="muted small">Amounts and eligibility are what sponsors publish — nothing here is a promise of an award.</p>
      ${groups.length ? groups.map(([k, l]) => { const sc = SCOPES.find((x) => x.k === k); return `<h2 class="scopehead ${sc ? sc.cls : ''}">${esc(k)} <span class="muted small">${l.length}${sc ? ' · ' + esc(sc.hint) : ''}</span></h2>${l.map(schCard).join('')}`; }).join('') : '<p class="muted">No matches.</p>'}`;
  }

  function viewAid() {
    const aid = state.tasks.filter((t) => t.category === 'Financial aid').sort(byDue);
    const gl = [
      ['StudentAid.gov account (FSA ID)', 'A login for federal student aid. Lily and one parent each create their OWN account. Creating it is not the same as filing the FAFSA.'],
      ['FAFSA', 'Free Application for Federal Student Aid — federal grants, loans, work-study; many colleges use it too. 2027–28 FAFSA uses 2025 tax information. Filed at StudentAid.gov.'],
      ['CSS Profile', 'College Board form used by U-M and many private colleges for their own aid. More detailed than FAFSA (business, real estate, home equity can count differently).'],
      ['College Board account', 'The login used for the CSS Profile (and SAT). Separate from StudentAid.gov.'],
      ['IDOC', 'College Board service for uploading tax documents some CSS Profile schools request after you file. Only do it if a school asks.'],
      ['Early Action (EA)', 'Apply early, hear early. NOT binding — you can compare offers and aid until May 1.'],
      ['Early Decision (ED)', 'BINDING: if admitted you must attend and withdraw other applications. Not the family’s plan while comparing affordability.'],
      ['Regular Decision (RD)', 'Standard nonbinding deadline (U-M: Feb 1).'],
      ['Rolling admission', 'Applications reviewed as they arrive; earlier is better for scholarships and housing.'],
      ['Net price', 'Cost minus grants and scholarships. Loans are not discounts.']
    ];
    return `<h1>Financial aid</h1>
      <div class="alert">Never type FSA IDs, passwords, SSNs, tax returns, or bank numbers into this app. Track status here; do the forms on the official sites.</div>
      <div class="row"><a class="btn" href="https://studentaid.gov/" target="_blank" rel="noopener">StudentAid.gov</a>
        <a class="btn" href="https://cssprofile.collegeboard.org/" target="_blank" rel="noopener">CSS Profile</a>
        <a class="btn" href="https://admissions.umich.edu/apply/first-year-applicants/requirements-deadlines" target="_blank" rel="noopener">U-M aid dates</a></div>
      <div class="spread"><h2>Forms checklist</h2><button class="primary" id="addTask" data-category="Financial aid" style="margin-top:1rem">+ Task</button></div>
      ${aid.map((t) => taskCard(t, { expand: true })).join('') || '<p class="muted small">No aid tasks yet.</p>'}
      <h2>Glossary</h2>
      <div class="card"><table class="gl">${gl.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</table></div>`;
  }

  // ------------------------------------------------------------ visits
  function visitCard(v) {
    const upcoming = v.visit_date && v.visit_date >= todayISO();
    return `<div class="card visit" data-visit="${v.id}" style="cursor:pointer">
      <div class="spread"><div><h3>${esc(collegeName(v.college_id) || 'College not set')}</h3>
        <div class="row" style="margin-top:4px">${v.visit_date ? `<span class="chip ${upcoming ? 'info' : ''}">${upcoming ? 'Upcoming · ' : ''}${fmtDate(v.visit_date)}</span>` : '<span class="chip">No date</span>'}<span class="chip">${esc(v.kind)}</span>${v.who ? `<span class="chip">${esc(v.who)}</span>` : ''}</div></div>
        ${v.rating ? `<div class="stars" aria-label="${v.rating} of 5">${stars(v.rating)}</div>` : ''}</div>
      ${v.impressions ? `<p class="small pre" style="margin:8px 0 0">${esc(v.impressions)}</p>` : ''}
      ${v.pros || v.cons ? `<div class="pc">${v.pros ? `<div><b class="good-t">Liked</b><div class="small pre">${esc(v.pros)}</div></div>` : ''}${v.cons ? `<div><b class="bad-t">Concerns</b><div class="small pre">${esc(v.cons)}</div></div>` : ''}</div>` : ''}
    </div>`;
  }
  function viewVisits() {
    const t = todayISO();
    const up = state.visits.filter((v) => v.visit_date && v.visit_date >= t).sort((a, b) => a.visit_date.localeCompare(b.visit_date));
    const past = state.visits.filter((v) => !v.visit_date || v.visit_date < t).sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || ''));
    const rated = applyingColleges().map((c) => { const vs = state.visits.filter((v) => v.college_id === c.id && v.rating); return { c, n: vs.length, avg: vs.length ? vs.reduce((s, v) => s + v.rating, 0) / vs.length : 0 }; }).filter((r) => r.n);
    return `<div class="spread"><h1>Visits</h1><button class="primary" id="addVisit">+ Visit</button></div>
      <p class="muted small">Plan tours and admitted-student days, then capture Lily's impressions while they're fresh.</p>
      ${rated.length ? `<div class="card"><h3>How the campuses felt</h3>${rated.sort((a, b) => b.avg - a.avg).map((r) => `<div class="hbar"><span class="hl">${esc(r.c.name)}</span><span class="ht"><i style="width:${(r.avg / 5) * 100}%"></i></span><span class="hv">${r.avg.toFixed(1)}★</span></div>`).join('')}</div>` : ''}
      <h2>Upcoming</h2>${up.length ? up.map(visitCard).join('') : '<p class="muted small">No visits planned yet.</p>'}
      <h2>Past visits</h2>${past.length ? past.map(visitCard).join('') : '<p class="muted small">None logged yet.</p>'}`;
  }
  function editVisit(id, defaults) {
    const row = id ? state.visits.find((v) => v.id === id) : Object.assign({ kind: 'Campus tour', who: 'Lily' }, defaults || {});
    openEditor({
      title: id ? 'Edit visit' : 'New visit', table: 'visits', row,
      fields: [
        { pair: [{ k: 'college_id', l: 'College', t: 'select', o: collegeOpts() }, { k: 'visit_date', l: 'Date', t: 'date' }] },
        { pair: [{ k: 'kind', l: 'Type', t: 'select', o: VISIT_KINDS }, { k: 'who', l: 'Who went', p: 'Lily, Kevin…' }] },
        { k: 'rating', l: 'Lily’s rating', t: 'select', o: [['', '— not rated —'], ['5', '★★★★★ Loved it'], ['4', '★★★★ Really liked'], ['3', '★★★ It was fine'], ['2', '★★ Not sure'], ['1', '★ Not for me']] },
        { k: 'impressions', l: 'Impressions (in Lily’s words)', t: 'textarea' },
        { k: 'pros', l: 'What she liked', t: 'textarea' },
        { k: 'cons', l: 'Concerns', t: 'textarea' },
        { k: 'notes', l: 'Logistics / people met / follow-ups', t: 'textarea' }
      ],
      beforeSave: (out) => { out.rating = out.rating ? Number(out.rating) : null; return true; }
    });
  }

  // ------------------------------------------------------------ aid offers
  // Prefer an official offer over a calculator estimate for each college.
  function bestOffer(cid) {
    const rows = state.aid_offers.filter((o) => o.college_id === cid);
    return rows.find((o) => o.kind === 'Offer') || rows.find((o) => o.kind === 'Estimate') || null;
  }
  function offerMath(o) {
    const coa = num(o.cost_of_attendance), free = num(o.grants) + num(o.scholarships), loans = num(o.loans), ws = num(o.work_study);
    const net = coa - free;
    return { coa, free, loans, ws, net, oop: Math.max(0, net - loans - ws) };
  }
  function viewOffers() {
    const cols = applyingColleges();
    const rows = cols.map((c) => ({ c, o: bestOffer(c.id) })).map((r) => Object.assign(r, r.o ? offerMath(r.o) : {}));
    const have = rows.filter((r) => r.o && r.coa > 0).sort((a, b) => a.net - b.net);
    const max = Math.max(1, ...have.map((r) => r.coa));
    const pctW = (v) => ((Math.max(0, v) / max) * 100).toFixed(2) + '%';
    const wonList = state.scholarships.filter((s) => s.status === 'Awarded');
    return `<div class="spread"><h1>Cost &amp; offers</h1></div>
      <div class="alert">Calculator estimates are not offers, and loans are not discounts. Enter totals only, never tax or bank details.</div>
      ${have.length ? `<div class="card">
        <h3>Net price per year (lowest first)</h3>
        <div class="legend small" style="margin:6px 0 10px"><span><i class="dot seg-free"></i>Grants + scholarships</span><span><i class="dot seg-loan"></i>Loans</span><span><i class="dot seg-ws"></i>Work-study</span><span><i class="dot seg-oop"></i>Family pays</span></div>
        ${have.map((r) => `<div class="offer">
          <div class="spread small"><b>${esc(r.c.name)}</b><span><b>${money(r.net)}</b> net · <span class="chip ${r.o.kind === 'Offer' ? 'good' : 'warn'}">${r.o.kind}</span></span></div>
          <div class="stack" style="width:${pctW(r.coa)}" role="img" aria-label="${esc(r.c.name)}: cost ${money(r.coa)}, grants and scholarships ${money(r.free)}, loans ${money(r.loans)}, work-study ${money(r.ws)}, family pays ${money(r.oop)}">
            <i class="seg-free" style="width:${((r.free / r.coa) * 100).toFixed(2)}%"></i><i class="seg-loan" style="width:${((Math.min(r.loans, Math.max(0, r.net)) / r.coa) * 100).toFixed(2)}%"></i><i class="seg-ws" style="width:${((Math.min(r.ws, Math.max(0, r.net - r.loans)) / r.coa) * 100).toFixed(2)}%"></i><i class="seg-oop" style="width:${((r.oop / r.coa) * 100).toFixed(2)}%"></i>
          </div>
          <div class="small muted">Cost ${money(r.coa)} · four years at this rate ≈ ${money(r.net * 4)}${r.o.renewable_note ? ' · ' + esc(r.o.renewable_note) : ''}</div>
        </div>`).join('')}
      </div>` : '<p class="muted">No estimates yet. Run each college’s net price calculator, then enter the result below.</p>'}
      <h2>By college</h2>
      <div class="card tablewrap"><table class="otable">
        <thead><tr><th>College</th><th>Type</th><th>Cost</th><th>Grants</th><th>Scholar&shy;ships</th><th>Net price</th><th>Loans</th><th>Family pays</th><th></th></tr></thead>
        <tbody>${rows.map((r) => r.o ? `<tr><td>${esc(r.c.name)}</td><td>${esc(r.o.kind)}</td><td>${money(r.coa)}</td><td>${money(num(r.o.grants))}</td><td>${money(num(r.o.scholarships))}</td><td><b>${money(r.net)}</b></td><td>${money(r.loans)}</td><td>${money(r.oop)}</td><td><button type="button" data-offer="${r.o.id}">Edit</button></td></tr>`
          : `<tr><td>${esc(r.c.name)}</td><td colspan="7" class="muted">Nothing entered</td><td><button type="button" class="primary" data-offer-new="${r.c.id}">Add</button></td></tr>`).join('')}</tbody>
      </table></div>
      <p class="small muted">Each college can hold one estimate and one official offer; the official offer wins in the chart.</p>
      <h2>Outside scholarships won</h2>
      ${wonList.length ? wonList.map(schCard).join('') : '<p class="muted small">None yet. Mark a scholarship “Awarded” and it appears here.</p>'}`;
  }
  function editOffer(id, defaults) {
    const row = id ? state.aid_offers.find((o) => o.id === id) : Object.assign({ kind: 'Estimate', academic_year: '2027-28' }, defaults || {});
    openEditor({
      title: id ? 'Edit cost / offer' : 'New cost estimate or offer', table: 'aid_offers', row,
      fields: [
        { pair: [{ k: 'college_id', l: 'College', t: 'select', o: applyingColleges().map((c) => [c.id, c.name]) }, { k: 'kind', l: 'Type', t: 'select', o: [['Estimate', 'Estimate (net price calculator)'], ['Offer', 'Official aid offer']] }] },
        { pair: [{ k: 'cost_of_attendance', l: 'Cost of attendance / yr ($)', t: 'number' }, { k: 'academic_year', l: 'Year' }] },
        { pair: [{ k: 'grants', l: 'Grants / yr ($)', t: 'number' }, { k: 'scholarships', l: 'Scholarships / yr ($)', t: 'number' }] },
        { pair: [{ k: 'loans', l: 'Loans offered / yr ($)', t: 'number' }, { k: 'work_study', l: 'Work-study / yr ($)', t: 'number' }] },
        { pair: [{ k: 'received_on', l: 'Received / run on', t: 'date' }, { k: 'renewable_note', l: 'Renewal terms', p: 'e.g. 3.0 GPA to renew' }] },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ],
      beforeSave: (out, old) => {
        if (!out.college_id) { toast('Pick a college.'); return false; }
        const dup = state.aid_offers.find((o) => o.college_id === out.college_id && o.kind === out.kind && o.id !== old.id);
        if (dup) { toast(`${collegeName(out.college_id)} already has an ${out.kind.toLowerCase()} — edit that one instead.`); return false; }
        return true;
      }
    });
  }

  // ------------------------------------------------------------ profile
  const sp = () => state.student_profile[0] || {};
  function profileTiles(p) {
    if (Array.isArray(p.tiles)) return p.tiles;
    return [['GPA (weighted)', p.gpa_weighted], ['GPA (unweighted)', p.gpa_unweighted], ['SAT', p.sat], ['Class rank', p.class_rank], ['Dual-enrollment', p.dual_credits]].map(([label, value]) => ({ label, value: value || '' }));
  }
  const sortedActs = () => state.activities.slice().sort((a, b) => a.sort - b.sort || String(a.organization).localeCompare(String(b.organization)));
  const sortedHonors = () => state.honors.slice().sort((a, b) => a.sort - b.sort);
  const actHours = (a) => Math.round(num(a.hours_per_week) * num(a.weeks_per_year));
  // One compact pill: "Grades 10–12", "Grades 9, 11", "Grades 11–12 + PG".
  function gradeLabel(g) {
    const parts = String(g || '').split(',').map((x) => x.trim()).filter(Boolean);
    const nums = parts.filter((x) => /^\d+$/.test(x)).map(Number).sort((a, b) => a - b);
    const pg = parts.includes('Post-graduate');
    let txt = '';
    if (nums.length) {
      const run = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
      txt = nums.length === 1 ? `Grade ${nums[0]}` : run ? `Grades ${nums[0]}–${nums[nums.length - 1]}` : `Grades ${nums.join(', ')}`;
    }
    if (pg) txt = txt ? txt + ' + PG' : 'Post-graduate';
    return txt;
  }
  const gradeChips = (g) => { const t = gradeLabel(g); return t ? `<span class="chip">${esc(t)}</span>` : '<span class="chip warn">Grades?</span>'; };
  function readiness() {
    const acts = sortedActs(), top = acts.slice(0, 10);
    const described = top.filter((a) => a.description && a.description.trim()).length;
    const essays = state.essays, eDone = essays.filter((e) => ['Final', 'Submitted'].includes(e.status)).length;
    const recs = state.recommenders, rDone = recs.filter((r) => ['Submitted', 'Thanked'].includes(r.status)).length;
    const honors = state.honors.length;
    return [
      { k: 'Activities', done: described, total: Math.min(10, acts.length) || 10, center: `${described}/${Math.min(10, acts.length) || 10}`, sub: 'described', tab: 'activities' },
      { k: 'Honors', done: Math.min(honors, 5), total: 5, center: `${Math.min(honors, 5)}/5`, sub: 'listed', tab: 'honors' },
      { k: 'Essays', done: eDone, total: essays.length || 1, center: `${eDone}/${essays.length}`, sub: 'final', tab: 'essays' },
      { k: 'Recs', done: rDone, total: recs.length || 1, center: `${rDone}/${recs.length}`, sub: 'submitted', tab: 'recs' }
    ];
  }
  function viewProfile() {
    const p = sp();
    const tab = sessionGet('profTab') || 'activities';
    const applying = applyingColleges().filter((c) => c.priority <= 4);
    const stat = (label, v) => `<div class="pstat"><div class="pv">${v ? esc(v) : '<span class="muted">—</span>'}</div><div class="pl">${esc(label)}</div></div>`;
    const tabs = [['activities', 'Activities'], ['honors', 'Honors'], ['essays', 'Essays'], ['recs', 'Recommenders'], ['story', 'Story bank']];
    const body = { activities: profActivities, honors: profHonors, essays: profEssays, recs: profRecs, story: profStory }[tab] || profActivities;
    return `
      <div class="phero card">
        <div class="pava" aria-hidden="true">${esc((p.student_name || 'L').slice(0, 1))}</div>
        <div class="pmain">
          <div class="spread"><h1 style="margin:0">${esc(p.student_name || 'Lily')}</h1><button type="button" id="editMain">Edit</button></div>
          <div class="muted small">${esc([p.high_school, p.city].filter(Boolean).join(' · '))}${p.grad_year ? ' · Class of ' + esc(p.grad_year) : ''}</div>
          ${p.intended_major ? `<div class="small" style="margin-top:4px"><b>Intended:</b> ${esc(p.intended_major)}</div>` : ''}
          ${p.headline ? `<p class="phead">“${esc(p.headline)}”</p>` : ''}
          <div class="row" style="margin-top:6px">${applying.map((c) => `<a class="chip info" href="#/college/${c.id}">${esc(c.name)}</a>`).join('')}</div>
        </div>
      </div>
      <div class="card pstats">
        ${profileTiles(p).map((t) => stat(t.label, t.value)).join('')}
        <div class="pver spread">${p.stats_verified ? '<span class="chip good">Numbers verified</span>' : '<span class="chip warn">Numbers unverified — check the transcript</span>'}<button type="button" class="link" id="editTiles">Edit tiles</button></div>
      </div>
      <div class="readyrings">${readiness().map((r) => `<button type="button" class="card rcell ${tab === r.tab ? 'on' : ''}" data-ptab="${r.tab}">${ring(Math.round((r.done / r.total) * 100), r.k + ' ' + r.center + ' ' + r.sub, r.center)}<div class="rl">${esc(r.k)}</div><div class="small muted">${esc(r.sub)}</div></button>`).join('')}</div>
      <div class="row" style="margin:12px 0"><a class="btn primary" href="#/brag">Brag sheet (print / PDF)</a><a class="btn" href="#/docs">Documents</a></div>
      <div class="seg wide" role="tablist">${tabs.map(([k, l]) => `<button type="button" data-ptab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${body()}`;
  }
  function profActivities() {
    const acts = sortedActs();
    const maxH = Math.max(1, ...acts.map(actHours));
    return `<div class="spread"><h2>Activities <span class="muted small">(Common App allows 10)</span></h2><button class="primary" id="addAct" style="margin-top:1rem">+ Add</button></div>
      <p class="small muted">Order them by importance — the top 10 go on the Common App. Descriptions are Lily’s words, 150 characters max.</p>
      ${acts.some(actHours) ? `<div class="card"><h3>Time invested (hours per year)</h3>${acts.filter(actHours).sort((a, b) => actHours(b) - actHours(a)).map((a) => `<div class="hbar"><span class="hl">${esc(a.organization || a.position || 'Activity')}</span><span class="ht"><i class="acc" style="width:${(actHours(a) / maxH) * 100}%"></i></span><span class="hv">${actHours(a).toLocaleString()}</span></div>`).join('')}</div>` : ''}
      ${acts.map((a, i) => { const len = (a.description || '').length; return `<div class="card act ${i >= 10 ? 'extra' : ''}">
        <div class="arank"><b>${i + 1}</b><button type="button" class="mv" data-move="activities|${a.id}|-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>▲</button><button type="button" class="mv" data-move="activities|${a.id}|1" aria-label="Move down" ${i === acts.length - 1 ? 'disabled' : ''}>▼</button></div>
        <div class="body" data-act="${a.id}">
          <div class="spread"><div><div class="title">${esc(a.position || 'Role?')}${a.organization ? ' · ' + esc(a.organization) : ''}</div>
            <div class="meta">${i < 10 ? '<span class="chip good">On Common App</span>' : '<span class="chip">Extra — brag sheet</span>'}${a.activity_type ? `<span class="chip">${esc(a.activity_type)}</span>` : ''}${gradeChips(a.grades)}${a.timing ? `<span class="chip">${esc(a.timing)}</span>` : ''}</div></div></div>
          ${a.description ? `<p class="adesc">${esc(a.description)}</p>` : '<p class="adesc muted">Add Lily’s 150-character description.</p>'}
          <div class="abar"><i style="width:${Math.min(100, (len / 150) * 100)}%" class="${len > 140 ? 'near' : ''}"></i></div>
          <div class="small muted">${len}/150 characters${a.hours_per_week || a.weeks_per_year ? ` · ${num(a.hours_per_week)} hr/wk × ${num(a.weeks_per_year)} wk = <b>${actHours(a).toLocaleString()} hrs/yr</b>` : ' · hours not set'}${a.continue_college ? ' · continuing in college' : ''}</div>
        </div></div>`; }).join('') || '<p class="muted">No activities yet.</p>'}`;
  }
  function profHonors() {
    const hs = sortedHonors();
    return `<div class="spread"><h2>Honors <span class="muted small">(Common App allows 5)</span></h2><button class="primary" id="addHonor" style="margin-top:1rem">+ Add</button></div>
      ${hs.map((h, i) => `<div class="card act ${i >= 5 ? 'extra' : ''}">
        <div class="arank"><b>${i + 1}</b><button type="button" class="mv" data-move="honors|${h.id}|-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>▲</button><button type="button" class="mv" data-move="honors|${h.id}|1" aria-label="Move down" ${i === hs.length - 1 ? 'disabled' : ''}>▼</button></div>
        <div class="body" data-honor="${h.id}"><div class="title">★ ${esc(h.title)}</div>
          <div class="meta">${h.level ? `<span class="chip info">${esc(h.level)}</span>` : '<span class="chip warn">Level?</span>'}${gradeChips(h.grades)}${h.verified ? '<span class="chip good">Verified</span>' : ''}</div>
          ${h.notes ? `<div class="small muted" style="margin-top:6px">${esc(h.notes)}</div>` : ''}</div></div>`).join('') || '<p class="muted">No honors yet.</p>'}`;
  }
  function profEssays() {
    const es = state.essays.slice().sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.title.localeCompare(b.title));
    const counts = ESSAY_STATUS.map((st) => [st, es.filter((e) => e.status === st).length]);
    return `<div class="spread"><h2>Essays</h2><button class="primary" id="addEssay" style="margin-top:1rem">+ Add</button></div>
      <div class="pipe">${counts.map(([st, n]) => `<div class="pp ${n ? 'has' : ''}"><b>${n}</b><span>${esc(st)}</span></div>`).join('')}</div>
      <p class="small muted">Drafts live in Lily’s own Google Docs or Word files — link them here. This app never writes essay text.</p>
      ${es.map((e) => { const pct = e.word_limit && e.word_count ? Math.min(100, (e.word_count / e.word_limit) * 100) : 0; return `<div class="card" data-essay="${e.id}" style="cursor:pointer">
        <div class="spread"><div><h3>${esc(e.title)}</h3><div class="meta row">${e.college_id ? `<span class="chip">${esc(collegeName(e.college_id))}</span>` : '<span class="chip">Common App</span>'}${e.due_date ? dueChip(e.due_date, null, ['Final', 'Submitted'].includes(e.status)) : ''}</div></div><span class="chip ${e.status === 'Submitted' || e.status === 'Final' ? 'good' : e.status === 'Not started' ? '' : 'info'}">${esc(e.status)}</span></div>
        <div class="abar"><i style="width:${pct}%" class="${e.word_count > e.word_limit ? 'over' : ''}"></i></div>
        <div class="small muted">${e.word_count ? e.word_count + ' words' : 'No word count yet'}${e.word_limit ? ' of ' + e.word_limit + ' max' : ' · limit not confirmed'}</div>
        ${safeUrl(e.draft_url) ? `<div style="margin-top:8px"><a class="btn" href="${esc(e.draft_url)}" target="_blank" rel="noopener">Open draft</a></div>` : ''}
      </div>`; }).join('') || '<p class="muted">No essays yet.</p>'}`;
  }
  function profRecs() {
    return `<div class="spread"><h2>Recommenders</h2><button class="primary" id="addRec" style="margin-top:1rem">+ Add</button></div>
      ${state.recommenders.map((r) => { const i = REC_STATUS.indexOf(r.status); return `<div class="card" data-rec="${r.id}" style="cursor:pointer">
        <div class="spread"><div><h3>${esc(r.name || r.role + ' (name TBD)')}</h3><div class="small muted">${esc([r.role, r.subject].filter(Boolean).join(' · '))}${r.for_what ? ' — ' + esc(r.for_what) : ''}</div></div>${r.asked_on ? `<span class="chip">Asked ${fmtDate(r.asked_on)}</span>` : ''}</div>
        <div class="steps5">${REC_STATUS.map((st, k) => `<span class="${k <= i ? 'on' : ''}"><i></i>${esc(st)}</span>`).join('')}</div>
      </div>`; }).join('') || '<p class="muted">No recommenders yet.</p>'}`;
  }
  function profStory() {
    const sections = [...new Set(state.profile_facts.map((f) => f.section))];
    return `<div class="spread"><h2>Story bank</h2><button class="primary" id="addFact" style="margin-top:1rem">+ Add</button></div>
      <p class="muted small">Raw facts and moments for essays and interviews. Check anything unverified before it goes on an application.</p>
      ${sections.map((s) => `<h3 class="muted small" style="margin:1rem 0 .4rem;text-transform:uppercase;letter-spacing:.05em">${esc(s)}</h3>${state.profile_facts.filter((f) => f.section === s).map((f) => `
        <div class="card" data-fact="${f.id}" style="cursor:pointer">
          <div class="spread"><div>${esc(f.fact)}</div>${f.verified ? '<span class="chip good">Verified</span>' : '<span class="chip warn">Unverified</span>'}</div>
          ${f.notes ? `<div class="small muted" style="margin-top:4px">${esc(f.notes)}</div>` : ''}
        </div>`).join('')}`).join('')}`;
  }
  function viewBrag() {
    const p = sp(), acts = sortedActs(), hs = sortedHonors();
    const stats = profileTiles(p).filter((t) => t.label && t.value).map((t) => [t.label, t.value]);
    return `<div class="noprint row" style="margin-bottom:12px"><a href="#/profile">← Profile</a><button class="primary" id="printBtn">Print / Save as PDF</button></div>
      <div class="brag">
        <header><h1>${esc(p.student_name || 'Lily')}</h1><div>${esc([p.high_school, p.city].filter(Boolean).join(' · '))}${p.grad_year ? ' · Class of ' + esc(p.grad_year) : ''}${p.intended_major ? ' · Intended: ' + esc(p.intended_major) : ''}</div>
          ${p.headline ? `<p class="bh">${esc(p.headline)}</p>` : ''}</header>
        ${stats.length ? `<section><h2>Academics</h2><div class="bstats">${stats.map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>${p.stats_verified ? '' : '<p class="bnote">Figures to be confirmed against the official transcript.</p>'}</section>` : ''}
        <section><h2>Activities &amp; leadership</h2>${acts.map((a) => `<div class="bitem"><div class="bt"><b>${esc(a.position || '')}${a.organization ? ', ' + esc(a.organization) : ''}</b><span>${esc(gradeLabel(a.grades))}${actHours(a) ? ' · ' + actHours(a).toLocaleString() + ' hrs/yr' : ''}</span></div>${a.description ? `<div>${esc(a.description)}</div>` : ''}</div>`).join('')}</section>
        ${hs.length ? `<section><h2>Honors</h2>${hs.map((h) => `<div class="bitem"><div class="bt"><b>${esc(h.title)}</b><span>${esc([h.level, gradeLabel(h.grades)].filter(Boolean).join(' · '))}</span></div></div>`).join('')}</section>` : ''}
      </div>`;
  }
  function editMain() {
    const row = sp().id ? sp() : {};
    openEditor({
      title: 'Student snapshot', table: 'student_profile', row, noDelete: true,
      fields: [
        { pair: [{ k: 'student_name', l: 'Name' }, { k: 'grad_year', l: 'Class of', t: 'number' }] },
        { pair: [{ k: 'high_school', l: 'High school' }, { k: 'city', l: 'City' }] },
        { k: 'intended_major', l: 'Intended major' },
        { k: 'headline', l: 'One-line headline (her words)', max: 150 },
        { k: 'stats_verified', l: 'Numbers checked against the official transcript', t: 'bool' },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ]
    });
  }
  // Number tiles: free-form label/value pairs Lily or Kevin can add, remove, rename, and reorder.
  function editTiles() {
    let tiles = profileTiles(sp()).map((t) => ({ label: t.label || '', value: t.value || '' }));
    const draw = () => {
      $sheet.innerHTML = `<form method="dialog" id="tileForm">
        <h2 style="margin-top:0">Number tiles</h2>
        <p class="small muted">Add the numbers that tell Lily’s story — e.g. AP courses, volunteer hours, college credits. Leave a value blank to show “—”.</p>
        ${tiles.map((t, i) => `<div class="tilerow">
          <input name="l${i}" value="${esc(t.label)}" placeholder="Label (e.g. AP courses)" maxlength="28" aria-label="Tile ${i + 1} label">
          <input name="v${i}" value="${esc(t.value)}" placeholder="Value" maxlength="40" aria-label="Tile ${i + 1} value">
          <button type="button" class="mv" data-tup="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" class="mv" data-tdn="${i}" aria-label="Move down" ${i === tiles.length - 1 ? 'disabled' : ''}>▼</button>
          <button type="button" class="danger mv" data-tdel="${i}" aria-label="Remove tile">✕</button>
        </div>`).join('')}
        <p><button type="button" id="tileAdd" ${tiles.length >= 12 ? 'disabled' : ''}>+ Add tile</button></p>
        <div class="actions"><div></div><div class="row"><button type="button" id="tileCancel">Cancel</button><button type="submit" class="primary">Save</button></div></div>
      </form>`;
      const form = $sheet.querySelector('form');
      const grab = () => { tiles = tiles.map((_, i) => ({ label: form.elements['l' + i].value.trim(), value: form.elements['v' + i].value.trim() })); };
      $sheet.querySelector('#tileCancel').onclick = () => $sheet.close();
      $sheet.querySelector('#tileAdd').onclick = () => { grab(); tiles.push({ label: '', value: '' }); draw(); const last = $sheet.querySelector(`[name="l${tiles.length - 1}"]`); if (last) last.focus(); };
      $sheet.querySelectorAll('[data-tdel]').forEach((b) => b.onclick = () => { grab(); tiles.splice(+b.dataset.tdel, 1); draw(); });
      $sheet.querySelectorAll('[data-tup]').forEach((b) => b.onclick = () => { grab(); const i = +b.dataset.tup; [tiles[i - 1], tiles[i]] = [tiles[i], tiles[i - 1]]; draw(); });
      $sheet.querySelectorAll('[data-tdn]').forEach((b) => b.onclick = () => { grab(); const i = +b.dataset.tdn; [tiles[i + 1], tiles[i]] = [tiles[i], tiles[i + 1]]; draw(); });
      form.onsubmit = async (ev) => {
        ev.preventDefault(); grab();
        const clean = tiles.filter((t) => t.label);
        try { await save('student_profile', { tiles: clean }, sp().id || null); $sheet.close(); toast('Tiles saved'); render(); } catch (e) { /* toast shown */ }
      };
    };
    draw();
    if (!$sheet.open) $sheet.showModal();
  }

  function editActivity(id) {
    const row = id ? state.activities.find((a) => a.id === id) : { sort: (Math.max(0, ...state.activities.map((a) => a.sort)) + 10) };
    openEditor({
      title: id ? 'Edit activity' : 'New activity', table: 'activities', row,
      fields: [
        { k: 'activity_type', l: 'Activity type', t: 'select', o: [['', '— choose —']].concat(ACT_TYPES) },
        { k: 'position', l: 'Position / leadership', max: 50, p: 'e.g. President' },
        { k: 'organization', l: 'Organization name', max: 100 },
        { k: 'description', l: 'Description — Lily’s words (accomplishments, recognition)', t: 'textarea', max: 150 },
        { k: 'grades', l: 'Participation grade levels', t: 'multi', o: GRADES },
        { k: 'timing', l: 'Timing', t: 'select', o: [['', '—'], 'School year', 'School breaks', 'All year'] },
        { pair: [{ k: 'hours_per_week', l: 'Hours per week', t: 'number' }, { k: 'weeks_per_year', l: 'Weeks per year', t: 'number' }] },
        { k: 'continue_college', l: 'Intends to continue in college', t: 'bool' },
        { k: 'verified', l: 'Details verified', t: 'bool' },
        { k: 'notes', l: 'Notes (not on the application)', t: 'textarea' }
      ]
    });
  }
  function editHonor(id) {
    const row = id ? state.honors.find((h) => h.id === id) : { sort: (Math.max(0, ...state.honors.map((h) => h.sort)) + 10) };
    openEditor({
      title: id ? 'Edit honor' : 'New honor', table: 'honors', row,
      fields: [
        { k: 'title', l: 'Honor title', req: true, max: 100 },
        { k: 'grades', l: 'Grade levels', t: 'multi', o: GRADES },
        { k: 'level', l: 'Level of recognition', t: 'select', o: [['', '—'], 'School', 'State/Regional', 'National', 'International'] },
        { k: 'verified', l: 'Verified', t: 'bool' },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ]
    });
  }
  function editEssay(id) {
    const row = id ? state.essays.find((e) => e.id === id) : { status: 'Not started' };
    openEditor({
      title: id ? 'Edit essay' : 'New essay', table: 'essays', row,
      fields: [
        { k: 'title', l: 'Essay', req: true },
        { pair: [{ k: 'college_id', l: 'College', t: 'select', o: [['', 'Common App / all']].concat(state.colleges.map((c) => [c.id, c.name])) }, { k: 'status', l: 'Status', t: 'select', o: ESSAY_STATUS }] },
        { k: 'prompt', l: 'Prompt (copy from the official page)', t: 'textarea' },
        { pair: [{ k: 'word_limit', l: 'Word limit', t: 'number' }, { k: 'word_count', l: 'Current word count', t: 'number' }] },
        { k: 'due_date', l: 'Due', t: 'date' },
        { k: 'draft_url', l: 'Link to Lily’s draft (Google Doc / OneDrive)', t: 'url' },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ]
    });
  }
  function editRec(id) {
    const row = id ? state.recommenders.find((r) => r.id === id) : { role: 'Teacher', status: 'To ask' };
    openEditor({
      title: id ? 'Edit recommender' : 'New recommender', table: 'recommenders', row,
      fields: [
        { pair: [{ k: 'name', l: 'Name' }, { k: 'role', l: 'Role', t: 'select', o: ['Teacher', 'Counselor', 'Coach', 'Employer', 'Other'] }] },
        { pair: [{ k: 'subject', l: 'Subject / context' }, { k: 'asked_on', l: 'Asked on', t: 'date' }] },
        { k: 'for_what', l: 'For (colleges / scholarships)' },
        { k: 'status', l: 'Status', t: 'select', o: REC_STATUS },
        { k: 'notes', l: 'Notes (brag sheet sent? thank-you?)', t: 'textarea' }
      ]
    });
  }
  async function moveItem(table, id, dir) {
    const list = (table === 'activities' ? sortedActs() : sortedHonors());
    const i = list.findIndex((x) => x.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    // Renumber cleanly, then swap the two neighbours.
    const order = list.map((x) => x.id); [order[i], order[j]] = [order[j], order[i]];
    const changes = order.map((xid, k) => ({ xid, sort: (k + 1) * 10 })).filter(({ xid, sort }) => (state[table].find((x) => x.id === xid) || {}).sort !== sort);
    try { for (const c of changes) await save(table, { sort: c.sort }, c.xid); render(); } catch (e) { /* toast shown */ }
  }

  // ------------------------------------------------------------ documents
  function fmtSize(b) { b = num(b); return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b > 1024 ? Math.round(b / 1024) + ' KB' : b + ' B'; }
  function viewDocs() {
    const cat = sessionGet('docCat') || 'All';
    const list = state.documents.filter((d) => cat === 'All' || d.category === cat).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    const counts = Object.fromEntries(DOC_CATS.map((c) => [c, state.documents.filter((d) => d.category === c).length]));
    return `<div class="spread"><h1>Documents</h1><div class="row"><button id="addLink">+ Link</button><button class="primary" id="addDoc">+ Upload</button></div></div>
      <div class="alert">One private place for the process. <b>No financial records</b> — tax returns, FAFSA/CSS data, bank or ID numbers stay on the official sites.</div>
      <div class="doccats">${['All'].concat(DOC_CATS).map((c) => `<button type="button" data-doccat="${esc(c)}" class="${c === cat ? 'on' : ''}">${c === 'All' ? 'All' : DOC_ICON[c] + ' ' + esc(c)} <span>${c === 'All' ? state.documents.length : counts[c]}</span></button>`).join('')}</div>
      ${list.map(docCard).join('') || '<p class="muted">Nothing here yet. Upload a PDF or photo, or add a link to a Google Doc.</p>'}`;
  }
  function docCard(d) {
    return `<div class="card doc">
      <div class="dicon" aria-hidden="true">${DOC_ICON[d.category] || '•'}</div>
      <div class="body"><div class="title">${esc(d.title)}</div>
        <div class="meta"><span class="chip">${esc(d.category)}</span>${d.college_id ? `<span class="chip info">${esc(collegeName(d.college_id))}</span>` : ''}${d.file_path ? `<span class="chip">${esc((d.file_name || '').split('.').pop().toUpperCase() || 'FILE')} · ${fmtSize(d.size_bytes)}</span>` : '<span class="chip">Link</span>'}<span class="small muted">${d.updated_at ? ago(d.updated_at) : ''}${d.updated_by ? ' by ' + esc(who(d.updated_by)) : ''}</span></div>
        ${d.notes ? `<div class="small muted" style="margin-top:4px">${esc(d.notes)}</div>` : ''}
        <div class="row" style="margin-top:8px"><button type="button" class="primary" data-docopen="${d.id}">Open</button><button type="button" data-docedit="${d.id}">Edit</button></div>
      </div></div>`;
  }
  function openDocUpload(defaults) {
    defaults = defaults || {};
    $sheet.innerHTML = `<form method="dialog" id="upForm">
      <h2 style="margin-top:0">Upload a document</h2>
      <div class="alert">No tax returns, FAFSA/CSS data, bank statements, or ID numbers.</div>
      <label class="f">File (PDF, photo, Word — up to 25 MB)<input type="file" name="file" required accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.doc,.docx,.pptx,.txt,image/*,application/pdf"></label>
      <label class="f">Title<input name="title" required placeholder="e.g. Unofficial transcript, fall 2026"></label>
      <div class="two"><label class="f">Category<select name="category">${DOC_CATS.map((c) => `<option ${c === (defaults.category || 'Other') ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label class="f">College<select name="college_id">${collegeOpts().map(([v, l]) => `<option value="${esc(v)}" ${v === (defaults.college_id || '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>
      <label class="f">Notes<textarea name="notes"></textarea></label>
      <div class="actions"><div></div><div class="row"><button type="button" id="upCancel">Cancel</button><button type="submit" class="primary" id="upGo">Upload</button></div></div>
    </form>`;
    const form = $sheet.querySelector('form');
    form.file.addEventListener('change', () => { const f = form.file.files[0]; if (f && !form.title.value) form.title.value = f.name.replace(/\.[^.]+$/, ''); });
    $sheet.querySelector('#upCancel').onclick = () => $sheet.close();
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = form.file.files[0]; if (!f) return;
      const title = form.title.value.trim();
      if (FINANCIAL_NAME.test(f.name) || FINANCIAL_NAME.test(title)) { toast('That looks like a financial record. Keep it on the official site, not here.'); return; }
      if (f.size > 26214400) { toast('File is over 25 MB.'); return; }
      const btn = $sheet.querySelector('#upGo'); btn.disabled = true; btn.textContent = 'Uploading…';
      const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
      const path = `${form.category.value.replace(/[^A-Za-z]+/g, '-').toLowerCase()}/${Date.now()}-${safe}`;
      const up = await sb.storage.from('documents').upload(path, f, { contentType: f.type || 'application/octet-stream', upsert: false });
      if (up.error) { btn.disabled = false; btn.textContent = 'Upload'; toast('Upload failed: ' + up.error.message); return; }
      try {
        await save('documents', { title, category: form.category.value, college_id: form.college_id.value || null, notes: form.notes.value.trim() || null, file_path: path, file_name: f.name, mime_type: f.type || null, size_bytes: f.size });
        $sheet.close(); toast('Uploaded'); render();
      } catch (e) { await sb.storage.from('documents').remove([path]); btn.disabled = false; btn.textContent = 'Upload'; }
    };
    $sheet.showModal();
  }
  function editDoc(id, defaults) {
    const row = id ? state.documents.find((d) => d.id === id) : Object.assign({ category: 'Essays' }, defaults || {});
    openEditor({
      title: id ? 'Edit document' : 'Add a link', table: 'documents', row,
      fields: [
        { k: 'title', l: 'Title', req: true },
        { pair: [{ k: 'category', l: 'Category', t: 'select', o: DOC_CATS }, { k: 'college_id', l: 'College', t: 'select', o: collegeOpts() }] },
        row.file_path ? { k: 'file_name', l: 'File name (stored)', p: '' } : { k: 'link_url', l: 'Link (Google Doc, OneDrive…)', t: 'url', req: true },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ],
      beforeSave: (out) => {
        if (FINANCIAL_NAME.test(out.title || '') || FINANCIAL_NAME.test(out.file_name || '')) { toast('That looks like a financial record. Keep it on the official site, not here.'); return false; }
        if (!row.file_path && !safeUrl(out.link_url)) { toast('Enter a link that starts with https://'); return false; }
        return true;
      },
      onDelete: row.file_path ? async () => { await sb.storage.from('documents').remove([row.file_path]); } : null
    });
  }
  async function openDoc(id) {
    const d = state.documents.find((x) => x.id === id); if (!d) return;
    if (!d.file_path) { if (safeUrl(d.link_url)) window.open(d.link_url, '_blank', 'noopener'); return; }
    const w = window.open('', '_blank'); // open synchronously so iPhone doesn't block it as a pop-up
    const r = await sb.storage.from('documents').createSignedUrl(d.file_path, 60);
    if (r.error || !r.data) { if (w) w.close(); toast('Could not open: ' + ((r.error && r.error.message) || 'unknown error')); return; }
    if (w) w.location.href = r.data.signedUrl; else location.href = r.data.signedUrl;
  }

  // ------------------------------------------------------------ compare
  // Official facts live in colleges.facts (see migration 008). Picker, income band, and weights are
  // per-device conveniences kept in localStorage — nothing personal is sent to the database.
  const INCOME_BANDS = [['0-30000', '$0–30k'], ['30001-48000', '$30–48k'], ['48001-75000', '$48–75k'], ['75001-110000', '$75–110k'], ['110001-plus', '$110k+']];
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  const F = (c) => (c && c.facts) || {};
  const pct1 = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
  const usd = (v) => (v == null || v === '' ? '—' : money(Number(v)));
  const visitAvg = (cid) => { const vs = state.visits.filter((v) => v.college_id === cid && v.rating); return vs.length ? vs.reduce((s, v) => s + v.rating, 0) / vs.length : null; };
  function netFor(c, band) {
    const off = bestOffer(c.id);
    if (off && num(off.cost_of_attendance)) return { v: offerMath(off).net, src: off.kind === 'Offer' ? 'your offer' : 'your estimate' };
    const v = (F(c).net_price_by_income || {})[band];
    if (v != null) return { v: Number(v), src: 'Scorecard' };
    const a = (F(c).stats || {}).avg_net_price_all;
    return a != null ? { v: Number(a), src: 'Scorecard avg' } : { v: null, src: '' };
  }
  function viewCompare() {
    const all = state.colleges.slice().sort((a, b) => a.priority - b.priority);
    const defaults = all.filter((c) => c.priority <= 4 && c.status !== 'Not applying').map((c) => c.id);
    let picked = lsGet('cmpPick', defaults).filter((id) => all.some((c) => c.id === id));
    if (!picked.length) picked = defaults;
    const band = lsGet('cmpBand', '48001-75000');
    const W = Object.assign({ cost: 3, outcomes: 3, close: 2, feel: 2, size: 0 }, lsGet('cmpW', {}));
    const cols = picked.map((id) => all.find((c) => c.id === id));
    const hasFacts = cols.some((c) => Object.keys(F(c)).length);
    // Fit score: each factor normalized 0..1 across the picked colleges, then weighted.
    const norm = (vals, higherBetter) => { const xs = vals.filter((v) => v != null); if (!xs.length) return vals.map(() => 0.5); const lo = Math.min(...xs), hi = Math.max(...xs); return vals.map((v) => (v == null ? 0.5 : hi === lo ? 1 : higherBetter ? (v - lo) / (hi - lo) : (hi - v) / (hi - lo))); };
    const nets = cols.map((c) => netFor(c, band).v);
    const outs = cols.map((c) => { const s = F(c).stats || {}; const g = s.grad_rate_6yr, e = s.median_earnings_10yr; return g == null && e == null ? null : (g || 0) * 100 + (e || 0) / 1000; });
    const drive = cols.map((c) => (F(c).stats || {}).drive_hours ?? null);
    const feel = cols.map((c) => visitAvg(c.id));
    const sizes = cols.map((c) => (F(c).stats || {}).undergrad_enrollment ?? null);
    const nCost = norm(nets, false), nOut = norm(outs, true), nClose = norm(drive, false), nFeel = norm(feel, true);
    const nSize = W.size === 0 ? cols.map(() => 0.5) : norm(sizes, W.size > 0);
    const wsum = W.cost + W.outcomes + W.close + W.feel + Math.abs(W.size) || 1;
    const scores = cols.map((c, i) => Math.round(((W.cost * nCost[i] + W.outcomes * nOut[i] + W.close * nClose[i] + W.feel * nFeel[i] + Math.abs(W.size) * nSize[i]) / wsum) * 100));
    const ranked = cols.map((c, i) => ({ c, s: scores[i] })).sort((a, b) => b.s - a.s);
    const short = (c) => TRACK_NAME[c.name] || SHORT_NAME[c.name] || c.name;
    const bars = (label, vals, fmt, higherBetter, note) => {
      const xs = vals.filter((v) => v != null); const max = xs.length ? Math.max(...xs) : 1;
      const best = xs.length ? (higherBetter ? Math.max(...xs) : Math.min(...xs)) : null;
      return `<div class="cmprow"><div class="cmplabel">${esc(label)}${note ? `<small>${esc(note)}</small>` : ''}</div>${cols.map((c, i) => { const v = vals[i]; return `<div class="cmpbar"><span class="cn">${esc(short(c))}</span><span class="ct"><i style="width:${v == null ? 0 : Math.max(4, (v / max) * 100)}%" class="${v != null && v === best ? 'best' : ''}"></i></span><span class="cv">${v == null ? '—' : esc(fmt(v))}</span></div>`; }).join('')}</div>`;
    };
    const text = (label, get) => `<div class="cmptext"><div class="cmplabel">${esc(label)}</div><div class="cmpcols" style="--n:${cols.length}">${cols.map((c) => `<div><b>${esc(short(c))}</b><div class="small">${get(c) || '<span class="muted">—</span>'}</div></div>`).join('')}</div></div>`;
    const list = (a) => (Array.isArray(a) && a.length ? '<ul class="tight">' + a.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>' : '');
    return `<div class="spread"><h1>Compare</h1></div>
      <p class="small muted">Pick 2–4 colleges. Your picks, income range, and weights stay on this device only.</p>
      <div class="pickrow">${all.filter((c) => defaults.includes(c.id) || picked.includes(c.id)).map((c) => `<button type="button" class="pick2 ${picked.includes(c.id) ? 'on' : ''}" data-cmppick="${c.id}">${esc(short(c))}</button>`).join('')}</div>
      ${all.some((c) => !defaults.includes(c.id) && !picked.includes(c.id)) ? `<details class="others"><summary class="small">Other colleges</summary><div class="pickrow">${all.filter((c) => !defaults.includes(c.id) && !picked.includes(c.id)).map((c) => `<button type="button" class="pick2" data-cmppick="${c.id}">${esc(short(c))}</button>`).join('')}</div></details>` : ''}
      ${hasFacts ? '' : '<div class="alert">Official facts are being loaded. Charts fill in automatically once they’re added.</div>'}
      <div class="card">
        <h3>What matters most?</h3>
        <div class="sliders">
          ${[['cost', 'Low net price'], ['outcomes', 'Graduation & earnings'], ['close', 'Close to home'], ['feel', 'How visits felt']].map(([k, l]) => `<label class="sl"><span>${l}</span><input type="range" min="0" max="5" step="1" value="${W[k]}" data-w="${k}" aria-label="${l} weight"><b>${W[k]}</b></label>`).join('')}
          <label class="sl"><span>Size</span><input type="range" min="-3" max="3" step="1" value="${W.size}" data-w="size" aria-label="Size preference"><b>${W.size === 0 ? 'Any' : W.size < 0 ? 'Smaller' : 'Larger'}</b></label>
        </div>
        <div class="fit">${ranked.map((r, i) => `<div class="fitrow"><span class="fr">${i + 1}</span><span class="fn">${esc(short(r.c))}</span><span class="ft"><i style="width:${r.s}%"></i></span><span class="fv">${r.s}</span></div>`).join('')}</div>
        <p class="small muted" style="margin:6px 0 0">Fit score 0–100 compares only the colleges picked. Missing data counts as middle-of-the-pack.</p>
      </div>
      <div class="card">
        <div class="spread"><h3>Net price per year</h3><label class="small">Family income <select id="cmpBand">${INCOME_BANDS.map(([k, l]) => `<option value="${k}" ${k === band ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
        ${bars('Net price', nets, (v) => money(v), false, 'what families in this income range paid after grants (your own estimate or offer is used when entered)')}
        <div class="small muted">${cols.map((c) => { const n = netFor(c, band); return n.v == null ? '' : `${esc(short(c))}: ${esc(n.src)}`; }).filter(Boolean).join(' · ')}</div>
      </div>
      <div class="card">
        ${bars('Cost of attendance (in-state)', cols.map((c) => (F(c).stats || {}).in_state_cost_of_attendance ?? null), (v) => money(v), false)}
        ${bars('Graduation rate (6 yr)', cols.map((c) => (F(c).stats || {}).grad_rate_6yr ?? null), pct1, true)}
        ${bars('Median earnings, 10 yrs after entry', cols.map((c) => (F(c).stats || {}).median_earnings_10yr ?? null), (v) => money(v), true)}
        ${bars('Admit rate', cols.map((c) => (F(c).stats || {}).admit_rate ?? null), pct1, true, 'higher = easier to get in')}
        ${bars('Undergraduates', sizes, (v) => Number(v).toLocaleString('en-US'), true, 'campus size')}
        ${bars('Drive from Manistique', drive, (v) => v + ' hr', false)}
        ${bars('Lily’s visit rating', feel, (v) => v.toFixed(1) + '★', true)}
      </div>
      <div class="card">
        <h3>Business school</h3>
        ${text('How first-years get in', (c) => esc((F(c).business || {}).admission_model || ''))}
        ${text('Culture & feel', (c) => esc((F(c).business || {}).academic_feel || ''))}
        ${text('Outcomes', (c) => esc((F(c).business || {}).recruiting_and_outcomes || ''))}
        ${text('Signature programs', (c) => list((F(c).business || {}).signature_programs))}
      </div>
      <div class="card">
        <h3>Housing &amp; campus life</h3>
        ${text('First-year housing', (c) => esc([(F(c).housing || {}).first_year_requirement, (F(c).housing || {}).room_and_board].filter(Boolean).join(' · ')))}
        ${text('Business living community', (c) => esc((F(c).housing || {}).business_living_community || ''))}
        ${text('Setting', (c) => esc((F(c).campus || {}).setting || ''))}
        ${text('Athletics', (c) => esc((F(c).campus || {}).athletics || ''))}
        ${text('Traditions & identity', (c) => list((F(c).campus || {}).traditions))}
      </div>
      <p class="small muted">Sources: College Scorecard, NCES, and each college’s official pages — see each college’s page for links and data years.</p>`;
  }
  function factsSection(c) {
    const f = F(c); if (!Object.keys(f).length) return '';
    const b = f.business || {}, h = f.housing || {}, p = f.campus || {}, s = f.stats || {};
    const li = (a) => (Array.isArray(a) && a.length ? '<ul class="tight">' + a.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>' : '');
    const kv = (k, v) => (v == null || v === '' ? '' : `<div class="kv"><span>${esc(k)}</span><b>${typeof v === 'string' ? esc(v) : v}</b></div>`);
    return `<h2>Key facts</h2>
      <div class="card kvgrid">
        ${kv('Undergraduates', s.undergrad_enrollment != null ? Number(s.undergrad_enrollment).toLocaleString('en-US') : null)}${kv('Admit rate', s.admit_rate != null ? pct1(s.admit_rate) : null)}
        ${kv('6-yr graduation', s.grad_rate_6yr != null ? pct1(s.grad_rate_6yr) : null)}${kv('Cost of attendance (in-state)', s.in_state_cost_of_attendance != null ? usd(s.in_state_cost_of_attendance) : null)}
        ${kv('Avg net price', s.avg_net_price_all != null ? usd(s.avg_net_price_all) : null)}${kv('Median earnings (10 yr)', s.median_earnings_10yr != null ? usd(s.median_earnings_10yr) : null)}
        ${kv('Drive from Manistique', s.drive_hours != null ? `${s.drive_hours} hr${s.drive_miles ? ' · ' + s.drive_miles + ' mi' : ''}` : null)}${kv('Student–faculty', s.student_faculty_ratio || null)}
      </div>
      <h2>Culture &amp; housing</h2>
      <div class="card">
        <h3>${esc(b.school || 'Business school')}</h3>
        ${b.admission_model ? `<p class="small"><b>Getting in:</b> ${esc(b.admission_model)}</p>` : ''}
        ${b.class_size ? `<p class="small"><b>Size:</b> ${esc(b.class_size)}</p>` : ''}
        ${b.academic_feel ? `<p class="small"><b>Feel:</b> ${esc(b.academic_feel)}</p>` : ''}
        ${b.recruiting_and_outcomes ? `<p class="small"><b>Outcomes:</b> ${esc(b.recruiting_and_outcomes)}</p>` : ''}
        ${b.how_it_fits_campus ? `<p class="small"><b>On campus:</b> ${esc(b.how_it_fits_campus)}</p>` : ''}
        ${b.signature_programs && b.signature_programs.length ? `<div class="small"><b>Signature programs</b>${li(b.signature_programs)}</div>` : ''}
        ${b.business_clubs && b.business_clubs.length ? `<div class="small"><b>Business clubs</b>${li(b.business_clubs)}</div>` : ''}
      </div>
      <div class="card">
        <h3>Housing</h3>
        ${h.first_year_requirement ? `<p class="small"><b>First year:</b> ${esc(h.first_year_requirement)}</p>` : ''}
        ${h.room_and_board ? `<p class="small"><b>Room &amp; board:</b> ${esc(h.room_and_board)}</p>` : ''}
        ${h.business_living_community ? `<p class="small"><b>Business community:</b> ${esc(h.business_living_community)}</p>` : ''}
        ${h.application_opens ? `<p class="small"><b>Applying for housing:</b> ${esc(h.application_opens)}</p>` : ''}
        ${h.residence_options && h.residence_options.length ? `<div class="small"><b>Options</b>${li(h.residence_options)}</div>` : ''}
        ${h.notes ? `<p class="small muted">${esc(h.notes)}</p>` : ''}
      </div>
      <div class="card">
        <h3>Campus life</h3>
        ${[['Setting', p.setting], ['From Michigan', p.pct_in_state], ['Student orgs', p.student_orgs], ['Greek life', p.greek_life], ['Athletics', p.athletics], ['Winter', p.climate_note]].filter(([, v]) => v).map(([k, v]) => `<p class="small"><b>${k}:</b> ${esc(v)}</p>`).join('')}
        ${p.traditions && p.traditions.length ? `<div class="small"><b>Traditions &amp; identity</b>${li(p.traditions)}</div>` : ''}
      </div>
      ${Array.isArray(f.sources) && f.sources.length ? `<div class="src">${f.sources.map((x) => link(x.url, x.label + (x.year ? ' (' + x.year + ')' : ''))).join('')}</div><p class="small muted">Facts as of ${esc(f.as_of || '')}. Check official pages before relying on a number.</p>` : ''}`;
  }

  function currentTheme() { try { return localStorage.getItem('theme') || 'auto'; } catch (e) { return 'auto'; } }
  function applyTheme(t) {
    try { if (t === 'auto') localStorage.removeItem('theme'); else localStorage.setItem('theme', t); } catch (e) { /* private mode */ }
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  }

  function viewMoney() {
    const h = location.hash;
    const tab = h === '#/aid' ? 'aid' : h === '#/offers' ? 'offers' : (sessionGet('moneyTab') || 'offers');
    sessionSet('moneyTab', tab);
    const inner = (tab === 'aid' ? viewAid() : viewOffers()).replace(/<h1>[\s\S]*?<\/h1>/, '');
    return `<div class="spread"><h1>Money</h1></div>
      <div class="seg wide" role="tablist" style="margin-bottom:12px"><button type="button" data-mtab="offers" class="${tab === 'offers' ? 'on' : ''}">Cost &amp; offers</button><button type="button" data-mtab="aid" class="${tab === 'aid' ? 'on' : ''}">Aid forms</button></div>
      ${inner}`;
  }

  function viewMore() {
    return `<h1>More</h1>
      <div class="card list-links menu-links" style="padding-top:0;padding-bottom:0">
        <a href="#/money">${icon('money')}<span>Money <small>cost, offers, aid forms</small></span></a>
        <a href="#/docs">${icon('docs')}<span>Documents <small>transcripts, essays, letters</small></span></a>
        <a href="#/compare">${icon('colleges')}<span>Compare colleges <small>side by side, fit score</small></span></a>
        <a href="#/week">${icon('calendar')}<span>This week</span></a>
        <a href="#/tasks">${icon('home')}<span>All tasks</span></a>
        <a href="#/more" id="shareSetup">${icon('calendar')}<span>Add from iPhone Share <small>send texts and emails to the app</small></span></a>
        <a href="#/visits">${icon('colleges')}<span>Campus visits</span></a>
        <a href="#/brag">${icon('profile')}<span>Brag sheet</span></a>
        <a href="#/admin">${icon('more')}<span>Backup &amp; export</span></a>
      </div>
      <h2>Appearance</h2>
      <div class="seg wide themeseg" role="radiogroup" aria-label="Appearance">${[['auto', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" role="radio" aria-checked="${currentTheme() === k}" data-theme-pick="${k}" class="${currentTheme() === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <p class="small muted">Saved on this device only, so everyone can choose their own.</p>
      <p class="small muted" style="margin-top:16px">Signed in as ${esc(state.session.user.email)}${state.me ? ' (' + esc(state.me.role) + ')' : ''}</p>
      <button id="signOut">Sign out</button>
      <p class="small muted" style="margin-top:16px">App version ${APP_VERSION}</p>`;
  }

  function viewAllTasks() {
    const q = (sessionGet('tQ') || '').toLowerCase();
    const st = sessionGet('tS') || 'Open';
    const own = sessionGet('tO') || 'All';
    let list = state.tasks.slice().sort(byDue);
    if (st === 'Open') list = list.filter(isOpen); else if (st !== 'All') list = list.filter((t) => t.status === st);
    if (own !== 'All') list = list.filter((t) => t.owner === own);
    if (q) list = list.filter((t) => [t.title, t.notes, collegeName(t.college_id), t.category].join(' ').toLowerCase().includes(q));
    return `<div class="spread"><h1>All tasks</h1><div class="row"><button id="quickAdd">Paste to add</button><button class="primary" id="addTask">+ Task</button></div></div>
      <div class="filters">
        <input id="tQ" placeholder="Search" value="${esc(sessionGet('tQ') || '')}">
        <select id="tS">${['Open', 'All'].concat(TASK_STATUS).map((o) => `<option ${o === st ? 'selected' : ''}>${o}</option>`).join('')}</select>
        <select id="tO">${['All'].concat(OWNERS).map((o) => `<option ${o === own ? 'selected' : ''}>${o}</option>`).join('')}</select>
      </div>
      <p class="small muted">${list.length} tasks, sorted by due date</p>
      ${list.map((t) => taskCard(t)).join('')}`;
  }

  function viewAdmin() {
    return `<h1>Backup &amp; export</h1>
      <div class="card">
        <h3>Export</h3>
        <p class="small muted">Download everything as one JSON backup, or each table as CSV for Excel.</p>
        <div class="row"><button class="primary" id="expJson">Download JSON backup</button>
        ${TABLES.map((t) => `<button data-csv="${t}">${t.replace('_', ' ')} CSV</button>`).join('')}</div>
      </div>
      <div class="card">
        <h3>Restore from backup</h3>
        <p class="small muted">Loads a JSON backup made by this app. Rows with the same ID are overwritten; nothing is deleted.</p>
        <input type="file" id="restoreFile" accept="application/json,.json">
      </div>
      <div class="card">
        <h3>Edit data</h3>
        <p class="small">Add, edit, or delete from each page: tap a task title, a college's <b>Edit</b> button, a scholarship card, or a profile fact. Each form has a Delete button.</p>
      </div>`;
  }

  // ------------------------------------------------------------ editors
  function field(f, val) {
    const id = 'f_' + f.k;
    const v = val == null ? '' : val;
    const lbl = `<label class="f" for="${id}">${esc(f.l)}`;
    if (f.t === 'select') return `${lbl}<select id="${id}" name="${f.k}">${f.o.map((o) => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select></label>`;
    const max = f.max ? ` maxlength="${f.max}" data-max="${f.max}"` : '';
    if (f.t === 'multi') {
      const on = String(v).split(',').map((x) => x.trim());
      return `<fieldset class="f multi"><legend>${esc(f.l)}</legend>${f.o.map((o) => `<label class="pick"><input type="checkbox" name="${f.k}" value="${esc(o)}" ${on.includes(o) ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</fieldset>`;
    }
    if (f.t === 'textarea') return `${lbl}<textarea id="${id}" name="${f.k}" placeholder="${esc(f.p || '')}"${max}>${esc(v)}</textarea></label>`;
    if (f.t === 'bool') return `<label class="f row" for="${id}"><input type="checkbox" id="${id}" name="${f.k}" ${v ? 'checked' : ''}> ${esc(f.l)}</label>`;
    return `${lbl}<input id="${id}" name="${f.k}" type="${f.t || 'text'}" value="${esc(v)}" placeholder="${esc(f.p || '')}" ${f.req ? 'required' : ''}${f.t === 'number' ? ' step="any" inputmode="decimal"' : ''}${max}></label>`;
  }
  const collegeOpts = () => [['', '— none —']].concat(state.colleges.map((c) => [c.id, c.name]));

  function openEditor(opts) {
    const { title, fields, row, table, onSaved, beforeSave } = opts;
    $sheet.innerHTML = `<form method="dialog" id="edForm">
      <h2 style="margin-top:0">${esc(title)}</h2>
      ${fields.map((f) => (f.pair ? `<div class="two">${f.pair.map((p) => field(p, row[p.k])).join('')}</div>` : field(f, f.k === '_checklist' ? (row.checklist || []).map((c) => (c.done ? '[x] ' : '[ ] ') + c.text).join('\n') : row[f.k]))).join('')}
      <div class="actions">
        <div>${row.id && !opts.noDelete ? '<button type="button" class="danger" id="edDel">Delete</button>' : ''}</div>
        <div class="row"><button type="button" id="edCancel">Cancel</button><button type="submit" class="primary">Save</button></div>
      </div></form>`;
    const flat = fields.flatMap((f) => f.pair || [f]);
    const form = $sheet.querySelector('form');
    $sheet.querySelector('#edCancel').onclick = () => $sheet.close();
    if (row.id && !opts.noDelete) $sheet.querySelector('#edDel').onclick = async () => {
      if (!window.confirm('Delete this permanently?')) return;
      try { if (opts.onDelete) await opts.onDelete(); await remove(table, row.id); $sheet.close(); toast('Deleted'); if (opts.onDeleted) opts.onDeleted(); else render(); } catch (e) { /* toast shown */ }
    };
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const out = {};
      flat.forEach((f) => {
        if (f.t === 'multi') { const v = [...form.querySelectorAll(`input[name="${f.k}"]:checked`)].map((x) => x.value).join(', '); out[f.k] = v || null; return; }
        const el = form.elements[f.k];
        if (f.t === 'bool') { out[f.k] = el.checked; return; }
        let v = el.value.trim();
        if (f.k === '_checklist') {
          out.checklist = v ? v.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
            const m = l.match(/^\[( |x|X)\]\s*(.*)$/);
            return m ? { text: m[2], done: m[1].toLowerCase() === 'x' } : { text: l.replace(/^[-*•]\s*/, ''), done: false };
          }) : [];
          return;
        }
        if (f.t === 'number') v = v === '' ? null : Number(v);
        out[f.k] = v === '' ? null : v;
      });
      if (beforeSave && beforeSave(out, row) === false) return;
      try { const saved = await save(table, out, row.id); $sheet.close(); toast('Saved'); onSaved ? onSaved(saved) : render(); } catch (e) { /* toast shown */ }
    };
    // Live character counters for fields with Common App limits.
    form.querySelectorAll('[data-max]').forEach((el) => {
      const c = document.createElement('span'); c.className = 'cnt'; el.insertAdjacentElement('afterend', c);
      const up = () => { const n = el.value.length, m = +el.dataset.max; c.textContent = `${n} / ${m}`; c.classList.toggle('near', n >= m * 0.9); };
      up(); el.addEventListener('input', up);
    });
    $sheet.showModal();
    const first = form.querySelector('input,select,textarea'); if (first && !row.id) first.focus();
  }

  function editTask(id, defaults) {
    const row = id ? state.tasks.find((t) => t.id === id) : Object.assign({ status: 'Not started', owner: 'Lily', category: 'Admissions', priority: 2, checklist: [] }, defaults || {});
    openEditor({
      title: id ? 'Edit task' : 'New task', table: 'tasks', row,
      fields: [
        { k: 'title', l: 'Task', req: true },
        { pair: [{ k: 'owner', l: 'Owner', t: 'select', o: OWNERS }, { k: 'status', l: 'Status', t: 'select', o: TASK_STATUS }] },
        { pair: [{ k: 'due_date', l: 'Due date', t: 'date' }, { k: 'due_time', l: 'Time (ET)', p: 'e.g. 11:59 PM' }] },
        { pair: [{ k: 'college_id', l: 'College', t: 'select', o: collegeOpts() }, { k: 'category', l: 'Category', t: 'select', o: CATEGORIES }] },
        { k: 'priority', l: 'Priority (1 = highest)', t: 'number' },
        { k: '_checklist', l: 'Checklist (one step per line; start with [x] if done)', t: 'textarea' },
        { k: 'blocker', l: 'Blocked by (leave empty if not blocked)' },
        { k: 'notes', l: 'Notes', t: 'textarea' },
        { pair: [{ k: 'source_url', l: 'Official source link', t: 'url' }, { k: 'verified_on', l: 'Date verified', t: 'date' }] }
      ]
    });
  }

  function editCollege(id) {
    const row = id ? state.colleges.find((c) => c.id === id) : { status: 'Researching', plan: 'Undecided', priority: 5 };
    openEditor({
      title: id ? 'Edit college' : 'New college', table: 'colleges', row,
      fields: [
        { k: 'name', l: 'College', req: true },
        { k: 'program', l: 'Business school / program' },
        { k: 'route', l: 'Application route', p: 'Common App, school portal…' },
        { pair: [{ k: 'plan', l: 'Plan', t: 'select', o: PLANS.map((p) => [p, p === 'ED' ? 'ED (binding)' : p]) }, { k: 'status', l: 'Status', t: 'select', o: COLLEGE_STATUS }] },
        { pair: [{ k: 'deadline', l: 'Deadline', t: 'date' }, { k: 'deadline_time', l: 'Time (ET)' }] },
        { pair: [{ k: 'source_url', l: 'Official deadline source', t: 'url' }, { k: 'verified_on', l: 'Date verified', t: 'date' }] },
        { k: 'app_url', l: 'Application portal link', t: 'url' },
        { pair: [{ k: 'submitted_on', l: 'Submitted on', t: 'date' }, { k: 'priority', l: 'Priority', t: 'number' }] },
        { k: 'receipt_note', l: 'Receipt / confirmation note', p: 'Confirmation # or where the PDF is saved' },
        { k: 'notes', l: 'Notes (essays, recommendations, transcripts, aid)', t: 'textarea' }
      ],
      beforeSave: (out, old) => {
        if (out.plan === 'ED' && old.plan !== 'ED') {
          return window.confirm('Early Decision is BINDING: if admitted, Lily must attend and withdraw all other applications, before comparing financial aid offers. Mark this plan as ED?');
        }
        return true;
      },
      onDeleted: () => { location.hash = '#/colleges'; render(); }
    });
  }

  function editSch(id) {
    const row = id ? state.scholarships.find((s) => s.id === id) : { status: 'Researching' };
    openEditor({
      title: id ? 'Edit scholarship' : 'New scholarship', table: 'scholarships', row,
      fields: [
        { k: 'name', l: 'Scholarship', req: true },
        { pair: [{ k: 'sponsor', l: 'Sponsor' }, { k: 'college_id', l: 'College (if school-specific)', t: 'select', o: collegeOpts() }] },
        { pair: [{ k: 'scope', l: 'Where it’s from', t: 'select', o: [['', '— choose —']].concat(SCOPES.map((x) => x.k)) }, { k: 'status', l: 'Status', t: 'select', o: SCH_STATUS }] },
        { k: 'amount', l: 'Amount (if published)' },
        { pair: [{ k: 'deadline', l: 'Deadline', t: 'date' }, { k: 'deadline_time', l: 'Time (ET)' }] },
        { k: 'renewable', l: 'Renewable', t: 'bool' },
        { k: 'eligibility', l: 'Eligibility', t: 'textarea' },
        { k: 'requirements', l: 'Essays / portfolio / interview requirements', t: 'textarea' },
        { k: 'next_action', l: 'Next action' },
        { pair: [{ k: 'link', l: 'Official link', t: 'url' }, { k: 'verified_on', l: 'Date verified', t: 'date' }] },
        { k: 'notes', l: 'Notes', t: 'textarea' }
      ]
    });
  }

  function editFact(id) {
    const row = id ? state.profile_facts.find((f) => f.id === id) : { section: 'Activities', verified: false, sort: 500 };
    openEditor({
      title: id ? 'Edit fact' : 'New fact', table: 'profile_facts', row,
      fields: [
        { k: 'section', l: 'Section', req: true, p: 'Academics, Leadership, Activities, Work…' },
        { k: 'fact', l: 'Fact', t: 'textarea' },
        { k: 'verified', l: 'Verified', t: 'bool' },
        { k: 'notes', l: 'Notes / what to check' },
        { k: 'sort', l: 'Sort order', t: 'number' }
      ]
    });
  }

  // ------------------------------------------------------------ export / restore
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function toCSV(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const cell = (v) => { v = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return [cols.join(',')].concat(rows.map((r) => cols.map((c) => cell(r[c])).join(','))).join('\n');
  }
  async function restore(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { toast('That file is not valid JSON.'); return; }
    if (!data || !TABLES.some((t) => Array.isArray(data[t]))) { toast('Not a backup from this app.'); return; }
    const counts = TABLES.map((t) => `${(data[t] || []).length} ${t.replace('_', ' ')}`).join(', ');
    if (!window.confirm(`Restore ${counts}? Matching rows will be overwritten.`)) return;
    for (const t of TABLES) {
      const rows = (data[t] || []).map((r) => { const c = Object.assign({}, r); delete c.updated_at; delete c.updated_by; return c; });
      if (!rows.length) continue;
      const { error } = await sb.from(t).upsert(rows);
      if (error) { toast(`Restore stopped at ${t}: ${error.message}`); return; }
    }
    await loadAll(); render(); toast('Restore complete');
  }

  // ------------------------------------------------------------ routing / chrome
  const store = {};
  function sessionGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return store[k]; } }
  function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { store[k] = v; } }

  // One consistent line-icon set (24px grid, stroke = currentColor).
  const ICON = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><path d="M8 13h2M14 13h2M8 16.5h2"/>',
    colleges: '<path d="M3 9.5 12 5l9 4.5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/>',
    scholarships: '<circle cx="12" cy="9" r="5.5"/><path d="M12 6.5v5M10.3 7.8c0-.8.8-1.3 1.7-1.3s1.7.5 1.7 1.2c0 1.6-3.4.9-3.4 2.5 0 .7.8 1.3 1.7 1.3s1.7-.5 1.7-1.3"/><path d="m8.5 13.5-1.5 7 5-2.5 5 2.5-1.5-7"/>',
    profile: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20c.8-4 3.8-6 7.5-6s6.7 2 7.5 6"/>',
    money: '<rect x="3" y="6.5" width="18" height="12" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.3"/>',
    docs: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5V8h4"/><path d="M9.5 12h6M9.5 15.5h6"/>',
    more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>'
  };
  const icon = (k) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  // Ordered by how often each page is used.
  const NAV = [['#/', 'Home', 'home'], ['#/calendar', 'Calendar', 'calendar'], ['#/colleges', 'Colleges', 'colleges'], ['#/scholarships', 'Scholarships', 'scholarships'], ['#/profile', 'Profile', 'profile']];
  const TOPNAV = NAV.concat([['#/money', 'Money', 'money'], ['#/docs', 'Documents', 'docs'], ['#/more', 'More', 'more']]);
  const PAGE_TITLE = { '#/': 'Home', '#/calendar': 'Calendar', '#/week': 'This week', '#/colleges': 'Colleges', '#/scholarships': 'Scholarships', '#/profile': 'Profile', '#/brag': 'Brag sheet', '#/money': 'Money', '#/offers': 'Money', '#/aid': 'Money', '#/docs': 'Documents', '#/compare': 'Compare', '#/visits': 'Visits', '#/tasks': 'All tasks', '#/admin': 'Backup', '#/more': 'More' };
  const SHORT_NAME = { 'University of Michigan': 'U-M', 'Michigan State University': 'MSU', 'Michigan Technological University': 'Michigan Tech', 'Northern Michigan University': 'NMU' };
  function navBase(h) {
    if (h.startsWith('#/college/')) return '#/colleges';
    if (h === '#/week') return '#/calendar';
    if (h === '#/brag') return '#/profile';
    if (h === '#/offers' || h === '#/aid') return '#/money';
    if (h === '#/compare') return '#/colleges';
    if (['#/visits', '#/tasks', '#/admin'].includes(h)) return '#/more';
    return h;
  }
  function nextDeadlineChip() {
    const t = todayISO();
    const e = allEvents().find((x) => x.kind !== 'task' && x.kind !== 'visit' && x.active && x.date >= t);
    if (!e) return '';
    const d = daysUntil(e.date);
    const name = e.kind === 'college' ? (SHORT_NAME[e.row.name] || e.row.name) : e.title;
    return `<a class="nextchip ${d <= 3 ? 'hot' : d <= 10 ? 'warm' : ''}" href="#/calendar" title="Next deadline: ${esc(e.title)}, ${fmtDate(e.date)}"><span class="nc-name">${esc(name)}</span><b>${d === 0 ? 'today' : d + 'd'}</b></a>`;
  }

  function chrome(show) {
    const top = document.getElementById('topbar'); const tab = document.getElementById('tabbar');
    top.hidden = !show; tab.hidden = !show;
    if (!show) return;
    const h = location.hash || '#/';
    const base = navBase(h);
    const title = h.startsWith('#/college/') ? (SHORT_NAME[collegeName(h.slice(10))] || collegeName(h.slice(10)) || 'College') : (PAGE_TITLE[h] || 'Home');
    const live = state.syncStatus === 'SUBSCRIBED', off = ['CLOSED', 'CHANNEL_ERROR', 'TIMED_OUT'].includes(state.syncStatus);
    top.innerHTML = `
      <a href="#/" class="brand">${icon('colleges')}<span>College Plan</span></a>
      <span class="pagetitle">${esc(title)}</span>
      <nav class="topnav" aria-label="Main">${TOPNAV.map(([href, l, ic]) => `<a href="${href}" class="${href === base ? 'on' : ''}" ${href === base ? 'aria-current="page"' : ''} title="${l}" aria-label="${l}">${icon(ic)}<span>${l}</span></a>`).join('')}</nav>
      <span class="tb-right">${nextDeadlineChip()}
        <span class="syncwrap ${live ? 'live' : off ? 'off' : ''}" title="${live ? 'Live: changes sync between devices' : off ? 'Offline: reconnecting' : 'Connecting'}"><span class="sync" id="sync"></span><span class="synclbl">${live ? 'Live' : off ? 'Offline' : '…'}</span></span>
        <a class="menubtn ${base === '#/more' || base === '#/money' || base === '#/docs' ? 'on' : ''}" href="#/more" aria-label="Menu">${icon('menu')}</a></span>`;
    tab.innerHTML = NAV.map(([href, l, ic]) => `<a href="${href}" class="${href === base ? 'on' : ''}" ${href === base ? 'aria-current="page"' : ''}>${icon(ic)}<span>${l}</span></a>`).join('');
  }

  function render() {
    if (!state.session) return viewLogin();
    if (!state.loaded) return;
    if (!state.me) {
      chrome(false);
      $app.innerHTML = `<div class="login card"><h1>Almost there</h1>
        <p>You're signed in as <b>${esc(state.session.user.email)}</b>, but this account hasn't been added to the family workspace yet.</p>
        <p class="small muted">Ask the parent to add you (README step 5), then reload.</p>
        <button id="signOut">Sign out</button></div>`;
      document.getElementById('signOut').onclick = signOut;
      return;
    }
    chrome(true);
    const h = location.hash || '#/';
    const calJump = sessionGet('calJump');
    if (h === '#/calendar' && render._last !== '#/calendar' && !calJump) { sessionSet('calM', ''); sessionSet('calD', ''); }
    let html;
    if (h.startsWith('#/college/')) html = viewCollege(h.slice(10));
    else html = ({ '#/week': viewWeek, '#/calendar': viewCalendar, '#/colleges': viewColleges, '#/scholarships': viewScholarships, '#/aid': viewMoney, '#/money': viewMoney, '#/profile': viewProfile, '#/more': viewMore, '#/admin': viewAdmin, '#/tasks': viewAllTasks, '#/visits': viewVisits, '#/offers': viewMoney, '#/docs': viewDocs, '#/compare': viewCompare, '#/brag': viewBrag }[h] || viewDashboard)();
    const scroll = window.scrollY;
    $app.innerHTML = html;
    if (render._last === h) window.scrollTo(0, scroll); else window.scrollTo(0, 0);
    render._last = h;
    wire();
    if (h === '#/calendar' && calJump) { sessionSet('calJump', ''); jumpToDay(calJump); }
  }

  function wire() {
    wireTasks($app);
    const on = (sel, fn) => { const el = $app.querySelector(sel); if (el) el.addEventListener('click', fn); };
    on('#addTask', (e) => editTask(null, { college_id: e.currentTarget.dataset.college || null, category: e.currentTarget.dataset.category || (e.currentTarget.dataset.college ? 'Admissions' : 'Admissions') }));
    on('#addCollege', () => editCollege(null));
    on('#editCollege', (e) => editCollege(e.currentTarget.dataset.id));
    on('#addSch', () => editSch(null));
    on('#addFact', () => editFact(null));
    on('#addVisit', (e) => editVisit(null, { college_id: e.currentTarget.dataset.college || null }));
    on('#subBtn', () => openSubscribe());
    on('#quickAdd', () => openQuickAdd());
    on('#shareSetup', (e) => { e.preventDefault(); openShareSetup(); });
    on('#editMain', () => editMain());
    on('#editTiles', () => editTiles());
    $app.querySelectorAll('[data-scrollto]').forEach((b) => b.addEventListener('click', () => { const el = document.getElementById(b.dataset.scrollto); if (el) el.scrollIntoView({ block: 'start' }); }));
    $app.querySelectorAll('[data-cmppick]').forEach((b) => b.addEventListener('click', () => {
      const all = state.colleges.slice().sort((x, y) => x.priority - y.priority);
      let cur = lsGet('cmpPick', all.filter((c) => c.priority <= 4 && c.status !== 'Not applying').map((c) => c.id));
      const id = b.dataset.cmppick;
      if (cur.includes(id)) { if (cur.length <= 2) { toast('Keep at least 2 colleges.'); return; } cur = cur.filter((x) => x !== id); }
      else { if (cur.length >= 4) { toast('Up to 4 at a time — remove one first.'); return; } cur = cur.concat(id); }
      lsSet('cmpPick', cur); render();
    }));
    const band = $app.querySelector('#cmpBand'); if (band) band.addEventListener('change', () => { lsSet('cmpBand', band.value); render(); });
    $app.querySelectorAll('[data-w]').forEach((r) => {
      r.addEventListener('input', () => { const lbl = r.nextElementSibling; lbl.textContent = r.dataset.w === 'size' ? (+r.value === 0 ? 'Any' : +r.value < 0 ? 'Smaller' : 'Larger') : r.value; });
      r.addEventListener('change', () => { const W = lsGet('cmpW', {}); W[r.dataset.w] = +r.value; lsSet('cmpW', W); render(); });
    });
    $app.querySelectorAll('[data-theme-pick]').forEach((b) => b.addEventListener('click', () => { applyTheme(b.dataset.themePick); render(); }));
    $app.querySelectorAll('[data-who]').forEach((b) => b.addEventListener('click', () => { homeWhoChoice = b.dataset.who; render(); }));
    $app.querySelectorAll('[data-part]').forEach((b) => b.addEventListener('click', () => { const [cid, k] = b.dataset.part.split('|'); cyclePart(cid, k); }));
    $app.querySelectorAll('[data-ownerfilter]').forEach((a) => a.addEventListener('click', () => { sessionSet('tO', a.dataset.ownerfilter); sessionSet('tS', 'Open'); }));
    $app.querySelectorAll('[data-scopejump]').forEach((b) => b.addEventListener('click', () => { sessionSet('schScope', b.dataset.scopejump); location.hash = '#/scholarships'; }));
    $app.querySelectorAll('[data-ptabjump]').forEach((a) => a.addEventListener('click', () => sessionSet('profTab', a.dataset.ptabjump)));
    $app.querySelectorAll('[data-jumpday]').forEach((a) => a.addEventListener('click', () => { const d = a.dataset.jumpday; sessionSet('calM', d.slice(0, 7)); sessionSet('calD', d); sessionSet('calJump', d); }));
    $app.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => { sessionSet('schScope', b.dataset.scope); render(); }));
    $app.querySelectorAll('[data-mtab]').forEach((b) => b.addEventListener('click', () => { sessionSet('moneyTab', b.dataset.mtab); if (location.hash !== '#/money') location.hash = '#/money'; else render(); }));
    on('#addAct', () => editActivity(null));
    on('#addHonor', () => editHonor(null));
    on('#addEssay', () => editEssay(null));
    on('#addRec', () => editRec(null));
    on('#printBtn', () => window.print());
    on('#addDoc', (e) => openDocUpload({ college_id: e.currentTarget.dataset.college || '' }));
    on('#addLink', () => editDoc(null));
    $app.querySelectorAll('[data-ptab]').forEach((b) => b.addEventListener('click', () => { sessionSet('profTab', b.dataset.ptab); render(); }));
    $app.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => editActivity(el.dataset.act)));
    $app.querySelectorAll('[data-honor]').forEach((el) => el.addEventListener('click', () => editHonor(el.dataset.honor)));
    $app.querySelectorAll('[data-essay]').forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('a')) return; editEssay(el.dataset.essay); }));
    $app.querySelectorAll('[data-rec]').forEach((el) => el.addEventListener('click', () => editRec(el.dataset.rec)));
    $app.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const [t, id, d] = b.dataset.move.split('|'); moveItem(t, id, +d); }));
    $app.querySelectorAll('[data-doccat]').forEach((b) => b.addEventListener('click', () => { sessionSet('docCat', b.dataset.doccat); render(); }));
    $app.querySelectorAll('[data-docopen]').forEach((b) => b.addEventListener('click', () => openDoc(b.dataset.docopen)));
    $app.querySelectorAll('[data-docedit]').forEach((b) => b.addEventListener('click', () => editDoc(b.dataset.docedit)));
    $app.querySelectorAll('[data-tomonth]').forEach((b) => b.addEventListener('click', () => window.scrollTo(0, 0)));
    $app.querySelectorAll('[data-calnav]').forEach((b) => b.addEventListener('click', () => { sessionSet('calM', b.dataset.calnav); sessionSet('calD', ''); render(); }));
    $app.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
      const day = b.dataset.day;
      sessionSet('calD', day); render();
      jumpToDay(day);
    }));
    $app.querySelectorAll('[data-visit]').forEach((el) => el.addEventListener('click', () => editVisit(el.dataset.visit)));
    $app.querySelectorAll('[data-offer]').forEach((b) => b.addEventListener('click', () => editOffer(b.dataset.offer)));
    $app.querySelectorAll('[data-offer-new]').forEach((b) => b.addEventListener('click', () => editOffer(null, { college_id: b.dataset.offerNew })));
    on('#signOut', signOut);
    on('#expJson', () => {
      const data = { app: 'lily-college-dashboard', exported_at: new Date().toISOString() };
      TABLES.forEach((t) => { data[t] = state[t]; });
      download(`college-backup-${todayISO()}.json`, JSON.stringify(data, null, 2), 'application/json');
    });
    $app.querySelectorAll('[data-csv]').forEach((b) => b.addEventListener('click', () => download(`${b.dataset.csv}-${todayISO()}.csv`, toCSV(state[b.dataset.csv]), 'text/csv')));
    const rf = $app.querySelector('#restoreFile'); if (rf) rf.addEventListener('change', () => rf.files[0] && restore(rf.files[0]));
    $app.querySelectorAll('[data-sch]').forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('a')) return; editSch(el.dataset.sch); }));
    $app.querySelectorAll('[data-fact]').forEach((el) => el.addEventListener('click', () => editFact(el.dataset.fact)));
    const bindFilter = (id, key) => { const el = $app.querySelector('#' + id); if (!el) return; el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => { sessionSet(key, el.value); clearTimeout(bindFilter.t); bindFilter.t = setTimeout(() => { render(); const again = $app.querySelector('#' + id); if (again && el.tagName === 'INPUT') { again.focus(); again.setSelectionRange(again.value.length, again.value.length); } }, el.tagName === 'INPUT' ? 250 : 0); }); };
    bindFilter('weekOwner', 'weekOwner'); bindFilter('schQ', 'schQ'); bindFilter('schS', 'schS');
    bindFilter('tQ', 'tQ'); bindFilter('tS', 'tS'); bindFilter('tO', 'tO');
  }

  // ------------------------------------------------------------ auth
  function viewLogin(mode) {
    chrome(false);
    if (mode === 'recover') {
      $app.innerHTML = `<form class="login card" id="pwForm"><h1>Set a new password</h1>
        <label class="f">New password<input type="password" name="pw" minlength="8" required autocomplete="new-password"></label>
        <button class="primary" type="submit">Save password</button></form>`;
      document.getElementById('pwForm').onsubmit = async (e) => {
        e.preventDefault();
        const { error } = await sb.auth.updateUser({ password: e.target.pw.value });
        if (error) toast(error.message); else { toast('Password saved'); location.hash = '#/'; start(); }
      };
      return;
    }
    $app.innerHTML = `<form class="login card" id="loginForm">
      <h1>College Plan</h1>
      <p class="muted small">Private family workspace. Accounts are created by the parent.</p>
      <div id="loginMsg"></div>
      <label class="f">Email<input type="email" name="email" required autocomplete="username"></label>
      <label class="f">Password<input type="password" name="pw" required autocomplete="current-password"></label>
      <div class="spread"><button class="primary" type="submit">Sign in</button><button type="button" class="link" id="forgot">Forgot password?</button></div>
    </form>`;
    const form = document.getElementById('loginForm');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      const { error } = await sb.auth.signInWithPassword({ email: form.email.value.trim(), password: form.pw.value });
      btn.disabled = false;
      if (error) document.getElementById('loginMsg').innerHTML = `<div class="alert bad">${esc(error.message)}</div>`;
    };
    document.getElementById('forgot').onclick = async () => {
      const email = form.email.value.trim();
      if (!email) { document.getElementById('loginMsg').innerHTML = '<div class="alert">Type your email first, then tap Forgot password.</div>'; return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      document.getElementById('loginMsg').innerHTML = error ? `<div class="alert bad">${esc(error.message)}</div>` : '<div class="alert">If that email has an account, a reset link is on its way.</div>';
    };
  }

  async function signOut() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    await sb.auth.signOut();
  }

  async function start() {
    try {
      await loadAll();
      subscribe();
    } catch (e) {
      console.error(e);
      $app.innerHTML = `<div class="login card"><h1>Can't load data</h1><p class="small">${esc(e.message || e)}</p><button id="retry" class="primary">Try again</button> <button id="signOut">Sign out</button></div>`;
      document.getElementById('retry').onclick = start;
      document.getElementById('signOut').onclick = signOut;
      return;
    }
    render();
  }

  function boot() {
    if (!window.supabase || !CFG.SUPABASE_URL || /YOUR-PROJECT/.test(CFG.SUPABASE_URL)) {
      $app.innerHTML = '<div class="login card"><h1>Setup needed</h1><p>Fill in <code>config.js</code> with your Supabase URL and anon key (README step 3).</p></div>';
      return;
    }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    let recovering = false;
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') { recovering = true; state.session = session; viewLogin('recover'); return; }
      const prev = state.session && state.session.user.id;
      state.session = session;
      if (!session) { state.loaded = false; state.me = null; viewLogin(); return; }
      if (recovering) return;
      if (event === 'SIGNED_IN' && prev === session.user.id && state.loaded) return; // token refresh / tab refocus
      if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
      setTimeout(start, 0);
    });
    window.addEventListener('hashchange', render);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.me) scheduleReload(); });
  }

  boot();
})();
