// daily-brief: the Knaffla Family Daily Brief. Lily's college plan leads (unchanged), then Amy's plan,
// trips coming up and family dates. One shared email to the whole family, so it never includes money.
// Called by pg_cron (migration 012) with the x-brief-key header from public.daily_brief.
// Sends only at send_hour America/Detroit, once per day, when enabled. POST ?test=1 sends now to test_recipient only.
// POST ?note=1 with {subject, text, html} sends a one-off message to the recipients.
// Secrets (Supabase › Edge Functions › Secrets): GMAIL_USER, GMAIL_APP_PASSWORD (a Google app password, never a real password).
// Verify JWT stays ON: the cron call sends the public anon key.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import nodemailer from 'npm:nodemailer@6.9.16';

const APP = 'https://kknaffla.github.io/college-plan/';
const HOME = 'https://kknaffla.github.io/';
const AMY = HOME + 'amy/#/timeline';
const TRIPS = HOME + 'trips/';
// Family dates shown when within 14 days. The yearly voter guide job updates the election.
const FAMILY_DATES = [{ date: '2026-11-03', title: 'Election Day', note: 'Polls open 7 AM to 8 PM. Mark your picks in the voter guide first.', link: HOME + 'voter/' }];
// One-time introduction to the new family page, shown only on this date.
const INTRO_ON = '2026-10-29';
const FROM_NAME = 'Knaffla Family';
const TZ = 'America/Detroit';
const CLOSED = ['Submitted', 'Done', 'Not needed'];
const COLLEGE_DONE = ['Submitted', 'Complete', 'Admitted', 'Waitlisted', 'Denied', 'Not applying'];
const SHORT: Record<string, string> = { 'University of Michigan': 'U-M', 'Michigan State University': 'MSU', 'Michigan Technological University': 'Michigan Tech', 'Northern Michigan University': 'NMU' };

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const hourNow = () => +new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()) % 24;
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
const nice = (iso: string) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const h = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const reply = (msg: string, status = 200) => new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

type Item = { date: string; time?: string | null; title: string; who?: string; tag: string; rank: number; link: string; senior?: boolean; event?: boolean };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply('Use POST.', 405);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const cfgRes = await sb.from('daily_brief').select('*').eq('id', 1).maybeSingle();
  const cfg: any = cfgRes.data;
  const key = req.headers.get('x-brief-key') || '';
  if (cfgRes.error || !cfg || !key || !sameToken(key, cfg.token)) return reply('Not found', 404);

  // ?note=1 sends a one-off message (body: {subject, text, html}) to the brief recipients, e.g. an introduction.
  if (new URL(req.url).searchParams.get('note') === '1') {
    const b: any = await req.json().catch(() => ({}));
    const list: string[] = cfg.recipients || [];
    if (!b.subject || !(b.text || b.html) || !list.length) return reply('Need subject, text or html, and recipients.', 400);
    const u = Deno.env.get('GMAIL_USER'), pw = Deno.env.get('GMAIL_APP_PASSWORD');
    if (!u || !pw) return reply('Email secrets are not set yet.', 500);
    try {
      const tx = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: u, pass: pw } });
      await tx.sendMail({ from: `"${FROM_NAME}" <${u}>`, to: list.join(', '), subject: String(b.subject), text: b.text ? String(b.text) : undefined, html: b.html ? String(b.html) : undefined });
    } catch (e) { return reply('Send failed: ' + (e as Error).message, 502); }
    return reply(`Note sent to ${list.length}: ${b.subject}`);
  }
  const test = new URL(req.url).searchParams.get('test') === '1';
  const today = ymd(new Date());
  if (!test) {
    if (!cfg.enabled) return reply('Brief is turned off.');
    if (hourNow() !== cfg.send_hour) return reply('Not send time yet.');
    if (cfg.last_sent_on === today) return reply('Already sent today.');
  }
  const to: string[] = test ? (cfg.test_recipient ? [cfg.test_recipient] : []) : (cfg.recipients || []);
  if (!to.length) return reply('No recipients set.', 400);

  const [tasks, colleges, sch] = await Promise.all([
    sb.from('tasks').select('id,title,due_date,due_time,owner,status,priority,college_id,category,is_event').not('due_date', 'is', null),
    sb.from('colleges').select('id,name,deadline,deadline_time,status,plan'),
    sb.from('scholarships').select('id,name,deadline,deadline_time,status').not('deadline', 'is', null),
  ]);
  const err = [tasks, colleges, sch].find((r) => r.error);
  if (err) return reply('Could not read the plan.', 503);
  // Family sections: if these can't be read, Lily's part still goes out.
  const [amyRes, tripRes, datesRes] = await Promise.all([
    sb.from('amy_tasks').select('title,due_date,owner,status,category').not('due_date', 'is', null).lte('due_date', addDays(today, 14)),
    sb.from('trips').select('id,name,destination,start_date,end_date,status,trip_items(title,kind,done)').not('start_date', 'is', null).gte('end_date', today).lte('start_date', addDays(today, 30)).order('start_date'),
    sb.from('family_dates').select('title,kind,month,day,on_date,note'),
  ]);

  const cname = new Map((colleges.data || []).map((c: any) => [c.id, SHORT[c.name] || c.name]));
  const items: Item[] = [];
  for (const t of (tasks.data || []) as any[]) {
    if (CLOSED.includes(t.status)) continue;
    if (t.is_event && t.due_date < today) continue; // past events simply drop off
    const col = t.college_id ? cname.get(t.college_id) : '';
    items.push({ date: t.due_date, time: t.due_time, title: t.title + (col && !t.title.includes(col) ? ` (${col})` : ''), who: t.owner === 'Parent' ? 'Parents' : t.owner, tag: t.is_event ? 'Event' : 'Task', rank: t.priority || 3, link: APP + '#/task/' + t.id, senior: t.category === 'Senior year', event: !!t.is_event });
  }
  for (const c of (colleges.data || []) as any[]) {
    if (!c.deadline || COLLEGE_DONE.includes(c.status)) continue;
    items.push({ date: c.deadline, time: c.deadline_time, title: `${SHORT[c.name] || c.name} application due${c.plan && c.plan !== 'Undecided' ? ' (' + c.plan + ')' : ''}`, tag: 'Deadline', rank: 0, link: APP + '#/college/' + c.id });
  }
  for (const s of (sch.data || []) as any[]) {
    if (!['Planning', 'In progress'].includes(s.status)) continue;
    items.push({ date: s.deadline, time: s.deadline_time, title: s.name + ' scholarship due', tag: 'Scholarship', rank: 1, link: APP + '#/scholarships' });
  }
  const byWhen = (a: Item, b: Item) => a.date.localeCompare(b.date) || a.rank - b.rank;
  // College items lead the email; senior-year items get their own short section at the end.
  const college = items.filter((i) => !i.senior);
  const seniorNext = items.filter((i) => i.senior && i.date >= today && i.date <= addDays(today, 14)).sort(byWhen);
  const overdue = college.filter((i) => i.date < today && i.tag === 'Task').sort((a, b) => a.rank - b.rank || a.date.localeCompare(b.date));
  const dueToday = college.filter((i) => i.date === today).sort((a, b) => a.rank - b.rank);
  const week = college.filter((i) => i.date > today && i.date <= addDays(today, 7)).sort(byWhen);
  const top = dueToday[0] || overdue.find((i) => i.rank <= 1) || week.find((i) => i.rank <= 1) || overdue[0] || week[0] || seniorNext[0] || null;
  const countdown = items.filter((i) => i.tag === 'Deadline' && i.date >= today && i.date <= addDays(today, 30)).sort(byWhen);

  const amy = ((amyRes.data || []) as any[]).filter((t) => !['Done', 'Not needed'].includes(t.status)).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 4);
  const trips = ((tripRes.data || []) as any[]).filter((t) => !['Done', 'Cancelled', 'Idea'].includes(t.status)).slice(0, 2);
  // Yearly dates (birthdays) land on their next occurrence; one-time dates on their day.
  const nextYearly = (m: number, d: number) => { const y = +today.slice(0, 4); const pad = (n: number) => String(n).padStart(2, '0'); const iso = `${y}-${pad(m)}-${pad(d)}`; return iso >= today ? iso : `${y + 1}-${pad(m)}-${pad(d)}`; };
  const dbDates = ((datesRes.data || []) as any[]).map((r) => ({ date: r.on_date || nextYearly(r.month, r.day), title: (r.kind === 'Birthday' ? '🎂 ' : '') + r.title, note: r.note || '', link: HOME, birthday: r.kind === 'Birthday', who: String(r.title).split("'")[0] }));
  const famDates = [...FAMILY_DATES.map((d) => ({ ...d, birthday: false, who: '' })), ...dbDates].filter((d) => d.date >= today && d.date <= addDays(today, 14)).sort((a, b) => a.date.localeCompare(b.date));
  const bdayToday = famDates.filter((d) => d.birthday && d.date === today);
  const inDays = (iso: string) => { const n = daysBetween(today, iso); return n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`; };
  const tripInfo = (t: any) => {
    const need = (t.trip_items || []).filter((x: any) => x.kind === 'Booking' && !x.done).map((x: any) => x.title);
    const span = nice(t.start_date) + (t.end_date && t.end_date !== t.start_date ? ' to ' + nice(t.end_date) : '');
    return { span, need, soon: t.start_date <= today ? 'happening now' : inDays(t.start_date) };
  };
  const when = (i: Item) => (i.date === today ? 'Today' : nice(i.date)) + (i.time ? ', ' + i.time : '');
  const line = (i: Item, showDate = true) => `<li style="margin:0 0 8px"><a href="${h(i.link)}" style="color:#1d3b2a;font-weight:600;text-decoration:none">${h(i.title)}</a><br><span style="color:#5f6b63;font-size:13px">${showDate ? h(when(i)) : (i.time ? h(i.time) : 'Today')}${i.who ? ' · ' + h(i.who) : ''}${i.tag !== 'Task' ? ' · ' + h(i.tag) : ''}</span></li>`;
  const section = (title: string, list: Item[], showDate = true, max = 6) => list.length ? `<h3 style="font-size:15px;margin:18px 0 6px;color:#1d3b2a">${h(title)}</h3><ul style="padding-left:18px;margin:0">${list.slice(0, max).map((i) => line(i, showDate)).join('')}</ul>${list.length > max ? `<p style="font-size:13px;margin:4px 0 0"><a href="${APP}#/tasks">+ ${list.length - max} more</a></p>` : ''}` : '';
  const dateLabel = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

  // Section bands use the same colors as the dashboard tiles.
  const COLOR: Record<string, [string, string]> = { lily: ['#1d3f8f', '#e6eefb'], amy: ['#8a1f5c', '#fbe7ef'], trip: ['#5b2a86', '#f1e8fa'], dates: ['#a3361f', '#fdeee4'] };
  const band = (title: string, link: string, c: string) => `<div style="margin:24px 0 10px;background:${COLOR[c][1]};border-left:5px solid ${COLOR[c][0]};border-radius:10px;padding:9px 14px"><a href="${link}" style="color:${COLOR[c][0]};text-decoration:none;font-size:17px;font-weight:800">${h(title)}</a></div>`;
  const famHead = (title: string, link: string) => band(title, link, title.includes('Amy') ? 'amy' : title.includes('Trip') ? 'trip' : 'dates');
  const INTRO_HTML = `<div style="background:#e3ecf1;border-left:4px solid #24465c;padding:12px 14px;border-radius:6px;margin:0 0 6px"><div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#24465c;font-weight:700">New: our family page</div>
    <p style="margin:6px 0">This email now covers the whole family, and Amy gets it too. Lily's college plan still comes first, then Amy's plan, trips coming up and family dates.</p>
    <p style="margin:6px 0 4px">Our family page at <a href="${HOME}" style="color:#24465c;font-weight:600">kknaffla.github.io</a> has one login for everything:</p>
    <ul style="padding-left:18px;margin:0 0 4px">
      <li><b>Your area</b> at the top shows your own pages first. Lily and Amy see both college plans and Trips.</li>
      <li><b>Colorful tiles</b> for each part: both college plans, the voter guide, savings, money and trips.</li>
      <li><b>Coming up</b> banner for our next trip, with what's still to book.</li>
      <li><b>Voter guide:</b> everyone keeps their own convictions and picks before Election Day, Nov 3.</li>
      <li><b>Money:</b> each of us sees only our own savings and charges.</li></ul>
    <p style="margin:6px 0 0;font-size:13px;color:#5f6b63">On iPhone: open the page in Safari, tap Share, then Add to Home Screen. Forgot your password? Use "Forgot password" on the sign-in screen.</p></div>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2a23;font-size:15px;line-height:1.45">
  <div style="background-color:#3b2a7a;background-image:linear-gradient(135deg,#1d3f8f 0%,#5b2a86 55%,#c2306f 100%);color:#ffffff;border-radius:14px;padding:18px 20px;margin:0 0 14px">
    <div style="font-size:13px;opacity:.9">${h(dateLabel)}</div>
    <div style="font-size:24px;font-weight:800;margin:2px 0 4px">☀️ Knaffla Family Daily Brief</div>
    <div style="font-size:13px"><a href="${HOME}" style="color:#ffd86b;font-weight:700;text-decoration:none">Open the family page →</a></div></div>
  ${bdayToday.map((b) => `<div style="background-color:#d6336c;background-image:linear-gradient(135deg,#c2255c 0%,#e8590c 55%,#f08c00 100%);color:#ffffff;border-radius:14px;padding:18px 20px;margin:0 0 14px;text-align:center">
    <div style="font-size:30px;line-height:1.2">🎈🎂🎉🎁🎈</div>
    <div style="font-size:26px;font-weight:800;margin:6px 0 2px;text-shadow:0 1px 2px rgba(0,0,0,.25)">Happy birthday, ${h(b.who)}!</div>
    <div style="font-size:15px;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.2)">From all of us at home. Have the best day! 🥳</div></div>`).join('')}
  ${today === INTRO_ON ? INTRO_HTML : ''}
  ${band('🎓 Lily\'s college plan', APP, 'lily')}
  ${top ? `<div style="background:#fff8e1;border:2px solid #ffd166;padding:12px 14px;border-radius:10px"><div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#a8640c;font-weight:800">⭐ Most important</div><a href="${h(top.link)}" style="font-size:17px;font-weight:700;color:#1d3b2a;text-decoration:none">${h(top.title)}</a><div style="color:#5f6b63;font-size:13px">${h(when(top))}${top.who ? ' · ' + h(top.who) : ''}</div></div>` : '<p>Nothing is due in the next week. A good day to get ahead.</p>'}
  ${countdown.length ? `<p style="margin:14px 0 0;font-size:14px">${countdown.map((c) => { const n = daysBetween(today, c.date); return `<b>${h(c.title.replace(' application due', ''))}</b> ${n === 0 ? 'due today' : `in ${n} day${n === 1 ? '' : 's'}`}`; }).join(' · ')}</p>` : ''}
  ${section('Due today', dueToday.filter((i) => i !== top), false)}
  ${section('Overdue', overdue.filter((i) => i !== top), true, 5)}
  ${section('Next 7 days', week.filter((i) => i !== top), true, 6)}
  ${section('🎓 Senior year (next 2 weeks)', seniorNext.filter((i) => i !== top), true, 4)}
  ${famHead('📚 Amy\'s plan (next 2 weeks)', AMY)}${amy.length ? `<ul style="padding-left:18px;margin:0">${amy.map((t) => `<li style="margin:0 0 8px"><a href="${AMY}" style="color:#1d3b2a;font-weight:600;text-decoration:none">${h(t.title)}</a><br><span style="color:#5f6b63;font-size:13px">${h(nice(t.due_date))} · ${h(inDays(t.due_date))}${t.owner ? ' · ' + h(t.owner === 'Parent' ? 'Parents' : t.owner) : ''}</span></li>`).join('')}</ul>` : '<p style="margin:0;color:#5f6b63;font-size:14px">Nothing due in the next two weeks.</p>'}
  ${trips.length ? famHead('🧳 Trips coming up', TRIPS) + trips.map((t) => { const x = tripInfo(t); return `<p style="margin:0 0 8px"><a href="${TRIPS}#/trip/${h(t.id)}" style="color:#5b2a86;font-weight:800;text-decoration:none;font-size:16px">${h(t.name)}</a> <span style="background:#5b2a86;color:#fff;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:700">${h(x.soon)}</span><br><span style="color:#5f6b63;font-size:13px">${h(x.span)}${t.destination ? ' · ' + h(t.destination) : ''}${x.need.length ? ' · Still to book: ' + h(x.need.join(', ')) : ' · Everything is booked'}</span></p>`; }).join('') : ''}
  ${famDates.length ? famHead('🗓️ Family dates', HOME) + famDates.map((d) => `<p style="margin:0 0 8px"><a href="${h(d.link)}" style="color:${d.birthday ? '#c2306f' : '#a3361f'};font-weight:700;text-decoration:none">${h(d.title)}</a> · ${h(nice(d.date))}, ${h(inDays(d.date))}${d.note ? `<br><span style="color:#5f6b63;font-size:13px">${h(d.note)}</span>` : ''}</p>`).join('') : ''}
  <p style="margin:22px 0 0"><a href="${HOME}" style="display:inline-block;background-color:#5b2a86;background-image:linear-gradient(135deg,#1d3f8f,#5b2a86 55%,#c2306f);color:#fff;padding:11px 18px;border-radius:999px;text-decoration:none;font-weight:700">🏡 Open the family page</a> <a href="${APP}" style="display:inline-block;margin-left:8px;color:#1d3b2a;padding:10px 4px;font-weight:600">Lily's college plan</a></p>
  <p style="color:#8a948d;font-size:12px;margin:16px 0 0">Knaffla Family Daily Brief, sent at 7 AM to the four of us. Mark things done in each plan and they drop off tomorrow's email. Money stays on the family page, where each of us sees only our own.</p></div>`;

  const tline = (i: Item) => `- ${i.title} (${when(i)}${i.who ? ', ' + i.who : ''}) ${i.link}`;
  const text = [`Knaffla Family Daily Brief: ${dateLabel}`, `Family page: ${HOME}`,
    bdayToday.map((b) => `\nHAPPY BIRTHDAY, ${b.who.toUpperCase()}!`).join(''),
    today === INTRO_ON ? '\nNEW: This email now covers the whole family, and Amy gets it too. Our family page at ' + HOME + ' has one login for everything: Your area shows your own pages first, colorful tiles for each part, a Coming up banner for our next trip, the voter guide with everyone\'s own picks, and money where each of us sees only our own. On iPhone: Safari, Share, Add to Home Screen.' : '',
    '\nLILY\'S COLLEGE PLAN', `Open: ${APP}`,
    top ? `MOST IMPORTANT: ${top.title} (${when(top)})\n${top.link}` : 'Nothing due in the next week.',
    dueToday.length ? '\nDUE TODAY\n' + dueToday.filter((i) => i !== top).map(tline).join('\n') : '',
    overdue.length ? '\nOVERDUE\n' + overdue.filter((i) => i !== top).slice(0, 5).map(tline).join('\n') : '',
    week.length ? '\nNEXT 7 DAYS\n' + week.filter((i) => i !== top).slice(0, 6).map(tline).join('\n') : '',
    seniorNext.length ? '\nSENIOR YEAR (NEXT 2 WEEKS)\n' + seniorNext.filter((i) => i !== top).slice(0, 4).map(tline).join('\n') : '',
    '\nAMY\'S PLAN (NEXT 2 WEEKS)\n' + (amy.length ? amy.map((t) => `- ${t.title} (${nice(t.due_date)}, ${inDays(t.due_date)})`).join('\n') : 'Nothing due in the next two weeks.') + `\n${AMY}`,
    trips.length ? '\nTRIPS COMING UP\n' + trips.map((t) => { const x = tripInfo(t); return `- ${t.name}: ${x.span}, ${x.soon}${x.need.length ? '. Still to book: ' + x.need.join(', ') : '. Everything is booked'}`; }).join('\n') + `\n${TRIPS}` : '',
    famDates.length ? '\nFAMILY DATES\n' + famDates.map((d) => `- ${d.title.replace('🎂 ', '')}: ${nice(d.date)}, ${inDays(d.date)}${d.note ? '. ' + d.note : ''}`).join('\n') : ''].join('\n');
  const subject = `Knaffla Family Daily Brief, ${nice(today)}: ${bdayToday.length ? '🎂 Happy birthday, ' + bdayToday.map((b) => b.who).join(' and ') + '! · ' : ''}${today === INTRO_ON ? 'now for the whole family · ' : ''}${top ? top.title : 'nothing due this week'}`.slice(0, 140);

  const user = Deno.env.get('GMAIL_USER'), pass = Deno.env.get('GMAIL_APP_PASSWORD');
  if (!user || !pass) return reply('Email secrets are not set yet.', 500);
  try {
    const tx = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
    await tx.sendMail({ from: `"${FROM_NAME}" <${user}>`, to: to.join(', '), subject, text, html });
  } catch (e) {
    return reply('Send failed: ' + (e as Error).message, 502);
  }
  if (!test) await sb.from('daily_brief').update({ last_sent_on: today }).eq('id', 1);
  return reply(`Sent to ${to.length} ${test ? '(test)' : ''}: ${subject}`);
});
