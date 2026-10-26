/* Lily's College Plan — single-page app (no build step).
   Data lives in Supabase; row-level security keeps it family-only. */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const TZ = CFG.TIME_ZONE || 'America/Detroit';
  const WEEK_START = CFG.WEEK_START || '2026-10-25';
  const WEEK_END = CFG.WEEK_END || '2026-11-01';
  const $app = document.getElementById('app');
  const $sheet = document.getElementById('sheet');

  const TASK_STATUS = ['Not started', 'In progress', 'Waiting on others', 'Submitted', 'Done'];
  const CLOSED = new Set(['Submitted', 'Done']);
  const COLLEGE_STATUS = ['Researching', 'Planning', 'In progress', 'Submitted', 'Complete', 'Admitted', 'Waitlisted', 'Denied', 'Not applying'];
  const SCH_STATUS = ['Researching', 'Planning', 'In progress', 'Submitted', 'Awarded', 'Not awarded', 'Not pursuing'];
  const CATEGORIES = ['Admissions', 'School materials', 'Essays', 'Scholarship', 'Financial aid', 'Research', 'Other'];
  const OWNERS = ['Lily', 'Parent', 'Both'];
  const PLANS = ['EA', 'ED', 'RD', 'Rolling', 'Undecided'];
  const TABLES = ['colleges', 'tasks', 'scholarships', 'profile_facts', 'visits', 'aid_offers'];
  const VISIT_KINDS = ['Campus tour', 'Admitted-student day', 'Info session', 'Virtual', 'Interview', 'Other'];
  const SCH_ACTIVE = ['Planning', 'In progress'];
  const COLLEGE_DONE = ['Submitted', 'Complete', 'Admitted', 'Waitlisted', 'Denied', 'Not applying'];

  const state = { session: null, me: null, members: [], colleges: [], tasks: [], scholarships: [], profile_facts: [], visits: [], aid_offers: [], loaded: false };
  let sb = null;
  let channel = null;

  // ------------------------------------------------------------ helpers
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
  const link = (u, label) => (safeUrl(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(label || 'Open')}</a>` : '');
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
  const EV_ICON = { task: '✓', college: '🏛', sch: '$', visit: '📍' };
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
  function ring(pct, label) {
    const r = 26, c = 2 * Math.PI * r;
    return `<svg class="ring" viewBox="0 0 64 64" role="img" aria-label="${esc(label)}"><circle cx="32" cy="32" r="${r}" class="ring-bg"/><circle cx="32" cy="32" r="${r}" class="ring-fg" stroke-dasharray="${(c * pct / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 32 32)"/><text x="32" y="37" text-anchor="middle">${pct}%</text></svg>`;
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
    return `<div class="src muted">${v}${safeUrl(url) ? ' · ' + link(url, 'Official source') : ''}</div>`;
  }

  // ------------------------------------------------------------ data
  async function loadAll() {
    const results = await Promise.all([
      sb.from('members').select('*'),
      sb.from('colleges').select('*').order('priority').order('name'),
      sb.from('tasks').select('*'),
      sb.from('scholarships').select('*'),
      sb.from('profile_facts').select('*').order('sort'),
      sb.from('visits').select('*'),
      sb.from('aid_offers').select('*')
    ]);
    const err = results.find((r) => r.error);
    if (err) throw err.error;
    [state.members, state.colleges, state.tasks, state.scholarships, state.profile_facts, state.visits, state.aid_offers] = results.map((r) => r.data || []);
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
    const dot = document.getElementById('sync');
    channel = sb.channel('family-sync');
    TABLES.forEach((t) => channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, scheduleReload));
    channel.subscribe((status) => {
      dot.className = 'sync ' + (status === 'SUBSCRIBED' ? 'live' : status === 'CLOSED' || status === 'CHANNEL_ERROR' ? 'off' : '');
      dot.title = status === 'SUBSCRIBED' ? 'Live sync on' : 'Sync: ' + status;
    });
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
          <span class="chip owner-${esc(t.owner)}">${esc(t.owner)}</span>
          ${col && !opts.hideCollege ? `<span class="chip">${esc(col)}</span>` : ''}
          ${cl.length ? `<span class="chip">${doneCount}/${cl.length} steps</span>` : ''}
          <select class="status" data-status="${t.id}" aria-label="Status">
            ${TASK_STATUS.map((s) => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}
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
      try { await save('tasks', { status: sel.value }, t.id); toast('Status: ' + sel.value); render(); } catch (e) { sel.value = t.status; }
    }));
    root.querySelectorAll('[data-check]').forEach((cb) => cb.addEventListener('change', async () => {
      const t = state.tasks.find((x) => x.id === cb.dataset.check);
      const cl = (t.checklist || []).map((c) => Object.assign({}, c));
      cl[+cb.dataset.i].done = cb.checked;
      try { await save('tasks', { checklist: cl }, t.id); render(); } catch (e) { cb.checked = !cb.checked; }
    }));
    root.querySelectorAll('[data-edit-task]').forEach((el) => el.addEventListener('click', () => editTask(el.dataset.editTask)));
  }

  // ------------------------------------------------------------ views
  function viewDashboard() {
    const today = todayISO();
    const open = state.tasks.filter(isOpen).sort(byDue);
    const overdue = open.filter((t) => t.due_date && t.due_date < today);
    const soon = open.filter((t) => t.due_date && t.due_date >= today && t.due_date <= addDays(today, 7));
    // Scholarship and college deadlines the family is acting on count too.
    const otherActive = allEvents().filter((e) => e.kind !== 'task' && e.kind !== 'visit' && e.active);
    const otherOverdue = otherActive.filter((e) => e.date < today);
    const otherSoon = otherActive.filter((e) => e.date >= today && e.date <= addDays(today, 7));
    const countdown = otherActive.filter((e) => e.date >= today).slice(0, 4);
    const total = state.tasks.length;
    const doneN = total - open.length;
    const pct = total ? Math.round((doneN / total) * 100) : 0;
    const top3 = open.slice(0, 3);
    const mine = state.me ? open.filter((t) => t.owner === (state.me.role === 'student' ? 'Lily' : 'Parent') || t.owner === 'Both').length : 0;
    const activeColleges = state.colleges.filter((c) => !['Researching', 'Not applying'].includes(c.status) || c.priority <= 4);
    const schPending = state.scholarships.filter((s) => ['Planning', 'In progress', 'Researching'].includes(s.status)).sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    const recent = [].concat(
      state.tasks.map((r) => ({ t: r.updated_at, by: r.updated_by, label: r.title, kind: 'task', status: r.status })),
      state.colleges.map((r) => ({ t: r.updated_at, by: r.updated_by, label: r.name, kind: 'college', status: r.status })),
      state.scholarships.map((r) => ({ t: r.updated_at, by: r.updated_by, label: r.name, kind: 'scholarship', status: r.status }))
    ).filter((r) => r.by).sort((a, b) => (b.t || '').localeCompare(a.t || '')).slice(0, 8);

    return `
      <h1>Hi${state.me ? ', ' + esc(state.me.display_name) : ''}</h1>
      <div class="stats">
        <div class="card stat ${overdue.length + otherOverdue.length ? 'bad' : ''}"><div class="n">${overdue.length + otherOverdue.length}</div><div class="l">Overdue</div></div>
        <div class="card stat"><div class="n">${soon.length + otherSoon.length}</div><div class="l">Due in 7 days</div></div>
        <div class="card stat"><div class="n">${mine}</div><div class="l">Open for you</div></div>
        <div class="card stat ringstat">${ring(pct, pct + '% of tasks done')}<div class="l">${doneN} of ${total} tasks done</div></div>
      </div>

      ${countdown.length ? `<h2>Countdown</h2><div class="countdown">${countdown.map((e) => { const d = daysUntil(e.date); return `<a class="card cd ${d <= 3 ? 'hot' : d <= 10 ? 'warm' : ''}" href="${e.kind === 'college' ? '#/college/' + e.id : '#/scholarships'}"><div class="cdn">${d === 0 ? 'Today' : d}</div><div class="cdl">${d === 0 ? '' : d === 1 ? 'day' : 'days'}</div><div class="cdt">${EV_ICON[e.kind]} ${esc(e.title)}</div><div class="small muted">${fmtDate(e.date)}${e.time ? ' · ' + esc(e.time) : ''}</div></a>`; }).join('')}</div>` : ''}

      <h2>Next three actions</h2>
      ${top3.length ? top3.map((t) => taskCard(t, { expand: true })).join('') : '<p class="muted">Nothing open. 🎉</p>'}

      ${overdue.length + otherOverdue.length > 0 ? `<h2>Overdue (${overdue.length + otherOverdue.length})</h2>${otherOverdue.map(evRow).join('')}${overdue.filter((t) => !top3.includes(t)).map((t) => taskCard(t)).join('') || (otherOverdue.length ? '' : '<p class="muted small">Shown above.</p>')}` : ''}

      <div class="spread"><h2>Due in the next 7 days</h2><a href="#/calendar" class="small" style="margin-top:1.6rem">Calendar →</a></div>
      ${otherSoon.map(evRow).join('')}${soon.filter((t) => !top3.includes(t)).map((t) => taskCard(t)).join('') || (otherSoon.length ? '' : '<p class="muted small">Nothing else due this week.</p>')}

      <h2>Colleges</h2>
      <div class="grid">${activeColleges.map(collegeCard).join('')}</div>

      <h2>Scholarship work pending</h2>
      ${schPending.length ? schPending.slice(0, 5).map(schCard).join('') : '<p class="muted small">None pending.</p>'}
      <p><a href="#/scholarships">All scholarships →</a></p>

      <h2>Recent changes</h2>
      ${recent.length ? `<ul class="feed">${recent.map((r) => `<li><b>${esc(who(r.by))}</b> updated ${esc(r.kind)} “${esc(r.label)}” — ${esc(r.status)} <span class="muted">· ${ago(r.t)}</span></li>`).join('')}</ul>` : '<p class="muted small">No edits yet.</p>'}
    `;
  }

  function collegeProgress(c) {
    const ts = state.tasks.filter((t) => t.college_id === c.id);
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
    const dayList = byDay[sel] || [];
    const upcoming = ev.filter((e) => e.active && e.date > sel).slice(0, 6);
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
        <button type="button" id="icsBtn">Add deadlines to iPhone calendar</button>
      </div>
      <h2>${fmtDate(sel, { weekday: 'long', month: 'long' })}</h2>
      ${dayList.length ? dayList.map(agendaItem).join('') : '<p class="muted small">Nothing on this day.</p>'}
      ${upcoming.length ? `<h2>After that</h2>${upcoming.map((e) => (e.kind === 'task' ? taskCard(e.row) : evRow(e))).join('')}` : ''}
    `;
  }

  // .ics file for iPhone/Mac Calendar: all-day events, reminder at 9 AM the day before.
  function buildICS() {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const escI = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const fold = (l) => { const out = []; while (l.length > 73) { out.push(l.slice(0, 73)); l = ' ' + l.slice(73); } out.push(l); return out.join('\r\n'); };
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lily College Plan//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Lily College Plan'];
    const appUrl = location.origin + location.pathname;
    allEvents().filter((e) => e.active).forEach((e) => {
      const d = e.date.replace(/-/g, '');
      const src = e.kind === 'college' ? e.row.source_url : e.kind === 'sch' ? e.row.link : e.kind === 'task' ? e.row.source_url : null;
      const prefix = { task: '', college: 'DEADLINE: ', sch: 'Scholarship: ', visit: 'Visit: ' }[e.kind];
      const desc = [e.time ? 'Due ' + e.time : '', e.kind === 'task' ? 'Owner: ' + e.owner : '', safeUrl(src) ? src : '', 'Open the plan: ' + appUrl].filter(Boolean).join('\n');
      lines.push('BEGIN:VEVENT', `UID:${e.kind}-${e.id}@college-plan`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(e.date, 1).replace(/-/g, '')}`,
        fold('SUMMARY:' + escI(prefix + e.title)), fold('DESCRIPTION:' + escI(desc)), 'TRANSP:TRANSPARENT',
        'BEGIN:VALARM', 'ACTION:DISPLAY', fold('DESCRIPTION:' + escI(prefix + e.title)), 'TRIGGER:-PT15H', 'END:VALARM', 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  function viewColleges() {
    const list = state.colleges.slice().sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    return `<div class="spread"><h1>Colleges</h1><button class="primary" id="addCollege">+ College</button></div>
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
      ${sch.length ? `<h2>Scholarships</h2>${sch.map(schCard).join('')}` : ''}
      <div class="spread"><h2>Visits</h2><button id="addVisit" data-college="${c.id}" style="margin-top:1rem">+ Visit</button></div>
      ${vis.length ? vis.map(visitCard).join('') : '<p class="muted small">No visits logged.</p>'}
      <div class="spread"><h2>Cost</h2><a href="#/offers" class="small" style="margin-top:1.6rem">Compare all →</a></div>
      ${off ? `<div class="card small"><b>${esc(off.kind)}:</b> cost ${money(om.coa)} − grants &amp; scholarships ${money(om.free)} = <b>net ${money(om.net)}</b>/yr${om.loans ? ` · loans offered ${money(om.loans)}` : ''}</div>` : `<p class="muted small">No estimate yet. <button type="button" class="link" data-offer-new="${c.id}">Add one</button></p>`}
    `;
  }

  function schCard(s) {
    return `<div class="card" data-sch="${s.id}" style="cursor:pointer">
      <div class="spread"><div><h3>${esc(s.name)}</h3><div class="small muted">${esc(s.sponsor || '')}</div></div>${statusChip(s.status)}</div>
      <div class="row" style="margin-top:6px">${s.deadline ? dueChip(s.deadline, s.deadline_time, !['Researching', 'Planning', 'In progress'].includes(s.status)) : '<span class="chip">No deadline</span>'}
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
    return `<div class="spread"><h1>Scholarships</h1><button class="primary" id="addSch">+ Scholarship</button></div>
      <p class="muted small">Amounts and eligibility are what sponsors publish — nothing here is a promise of an award.</p>
      <div class="filters">
        <input id="schQ" placeholder="Search" value="${esc(sessionGet('schQ') || '')}">
        <select id="schS">${['Active', 'All'].concat(SCH_STATUS).map((o) => `<option ${o === st ? 'selected' : ''}>${o}</option>`).join('')}</select>
      </div>
      ${list.length ? list.map(schCard).join('') : '<p class="muted">No matches.</p>'}`;
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

  function viewProfile() {
    const sections = [...new Set(state.profile_facts.map((f) => f.section))];
    return `<div class="spread"><h1>Lily’s profile</h1><button class="primary" id="addFact">+ Fact</button></div>
      <p class="muted small">Facts for essays and activity lists. Anything not marked verified should be checked before it goes on an application.</p>
      ${sections.map((s) => `<h2>${esc(s)}</h2>${state.profile_facts.filter((f) => f.section === s).map((f) => `
        <div class="card" data-fact="${f.id}" style="cursor:pointer">
          <div class="spread"><div>${esc(f.fact)}</div>${f.verified ? '<span class="chip good">Verified</span>' : '<span class="chip warn">Unverified</span>'}</div>
          ${f.notes ? `<div class="small muted" style="margin-top:4px">${esc(f.notes)}</div>` : ''}
        </div>`).join('')}`).join('')}`;
  }

  function viewMore() {
    return `<h1>More</h1>
      <div class="card list-links" style="padding-top:0;padding-bottom:0">
        <a href="#/week">This week</a>
        <a href="#/offers">Cost &amp; offers</a>
        <a href="#/visits">Campus visits</a>
        <a href="#/aid">Financial aid</a>
        <a href="#/profile">Lily’s profile</a>
        <a href="#/tasks">All tasks</a>
        <a href="#/admin">Backup &amp; export</a>
      </div>
      <p class="small muted" style="margin-top:16px">Signed in as ${esc(state.session.user.email)}${state.me ? ' (' + esc(state.me.role) + ')' : ''}</p>
      <button id="signOut">Sign out</button>`;
  }

  function viewAllTasks() {
    const q = (sessionGet('tQ') || '').toLowerCase();
    const st = sessionGet('tS') || 'Open';
    const own = sessionGet('tO') || 'All';
    let list = state.tasks.slice().sort(byDue);
    if (st === 'Open') list = list.filter(isOpen); else if (st !== 'All') list = list.filter((t) => t.status === st);
    if (own !== 'All') list = list.filter((t) => t.owner === own);
    if (q) list = list.filter((t) => [t.title, t.notes, collegeName(t.college_id), t.category].join(' ').toLowerCase().includes(q));
    return `<div class="spread"><h1>All tasks</h1><button class="primary" id="addTask">+ Task</button></div>
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
    if (f.t === 'textarea') return `${lbl}<textarea id="${id}" name="${f.k}" placeholder="${esc(f.p || '')}">${esc(v)}</textarea></label>`;
    if (f.t === 'bool') return `<label class="f row" for="${id}"><input type="checkbox" id="${id}" name="${f.k}" ${v ? 'checked' : ''}> ${esc(f.l)}</label>`;
    return `${lbl}<input id="${id}" name="${f.k}" type="${f.t || 'text'}" value="${esc(v)}" placeholder="${esc(f.p || '')}" ${f.req ? 'required' : ''}${f.t === 'number' ? ' step="any" inputmode="decimal"' : ''}></label>`;
  }
  const collegeOpts = () => [['', '— none —']].concat(state.colleges.map((c) => [c.id, c.name]));

  function openEditor(opts) {
    const { title, fields, row, table, onSaved, beforeSave } = opts;
    $sheet.innerHTML = `<form method="dialog" id="edForm">
      <h2 style="margin-top:0">${esc(title)}</h2>
      ${fields.map((f) => (f.pair ? `<div class="two">${f.pair.map((p) => field(p, row[p.k])).join('')}</div>` : field(f, f.k === '_checklist' ? (row.checklist || []).map((c) => (c.done ? '[x] ' : '[ ] ') + c.text).join('\n') : row[f.k]))).join('')}
      <div class="actions">
        <div>${row.id ? '<button type="button" class="danger" id="edDel">Delete</button>' : ''}</div>
        <div class="row"><button type="button" id="edCancel">Cancel</button><button type="submit" class="primary">Save</button></div>
      </div></form>`;
    const flat = fields.flatMap((f) => f.pair || [f]);
    const form = $sheet.querySelector('form');
    $sheet.querySelector('#edCancel').onclick = () => $sheet.close();
    if (row.id) $sheet.querySelector('#edDel').onclick = async () => {
      if (!window.confirm('Delete this permanently?')) return;
      try { await remove(table, row.id); $sheet.close(); toast('Deleted'); if (opts.onDeleted) opts.onDeleted(); else render(); } catch (e) { /* toast shown */ }
    };
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const out = {};
      flat.forEach((f) => {
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
        { pair: [{ k: 'status', l: 'Status', t: 'select', o: SCH_STATUS }, { k: 'amount', l: 'Amount (if published)' }] },
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

  const NAV = [['#/', 'Home', '⌂'], ['#/calendar', 'Calendar', '▦'], ['#/colleges', 'Colleges', '🏛'], ['#/scholarships', 'Scholarships', '$'], ['#/more', 'More', '⋯']];
  const TOPNAV = [['#/', 'Home'], ['#/calendar', 'Calendar'], ['#/colleges', 'Colleges'], ['#/scholarships', 'Scholarships'], ['#/offers', 'Cost'], ['#/visits', 'Visits'], ['#/aid', 'Financial aid'], ['#/tasks', 'All tasks'], ['#/profile', 'Profile'], ['#/more', 'More']];

  function chrome(show) {
    const top = document.getElementById('topbar'); const tab = document.getElementById('tabbar');
    top.hidden = !show; tab.hidden = !show;
    if (!show) return;
    const h = location.hash || '#/';
    const base = h.startsWith('#/college/') ? '#/colleges' : h === '#/week' ? '#/calendar' : ['#/aid', '#/profile', '#/admin', '#/tasks', '#/visits', '#/offers'].includes(h) ? '#/more' : h;
    tab.innerHTML = NAV.map(([href, l, ic]) => `<a href="${href}" class="${href === base ? 'on' : ''}"><span class="ic" aria-hidden="true">${ic}</span>${l}</a>`).join('');
    const tbase = h.startsWith('#/college/') ? '#/colleges' : h === '#/week' ? '#/calendar' : h;
    document.getElementById('topnav').innerHTML = TOPNAV.map(([href, l]) => `<a href="${href}" class="${href === tbase ? 'on' : ''}">${l}</a>`).join('');
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
    let html;
    if (h.startsWith('#/college/')) html = viewCollege(h.slice(10));
    else html = ({ '#/week': viewWeek, '#/calendar': viewCalendar, '#/colleges': viewColleges, '#/scholarships': viewScholarships, '#/aid': viewAid, '#/profile': viewProfile, '#/more': viewMore, '#/admin': viewAdmin, '#/tasks': viewAllTasks, '#/visits': viewVisits, '#/offers': viewOffers }[h] || viewDashboard)();
    const scroll = window.scrollY;
    $app.innerHTML = html;
    if (render._last === h) window.scrollTo(0, scroll); else window.scrollTo(0, 0);
    render._last = h;
    wire();
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
    on('#icsBtn', () => { download('lily-college-plan.ics', buildICS(), 'text/calendar'); toast('Calendar file downloaded — open it to add the dates.'); });
    $app.querySelectorAll('[data-calnav]').forEach((b) => b.addEventListener('click', () => { sessionSet('calM', b.dataset.calnav); sessionSet('calD', ''); render(); }));
    $app.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => { sessionSet('calD', b.dataset.day); render(); }));
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
