// daily-brief: the Knaffla Brief (formerly Lily's daily brief). Lily's college plan leads (unchanged), then Amy's plan,
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
const FROM_NAME = 'Knaffla Brief';
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

  // Short on purpose: one line per item and only the top few per section. The full lists live in each plan.
  const C = { lily: '#1d3f8f', amy: '#8a1f5c', trip: '#5b2a86', dates: '#a3361f', muted: '#6b7280', late: '#b42318' };
  const head = (t: string, link: string, c: string) => `<div style="margin:16px 0 4px;font-size:15px;font-weight:800"><a href="${link}" style="color:${c};text-decoration:none">${h(t)}</a></div>`;
  const row = (title: string, link: string, meta: string, late = false, ico = '•') => `<div style="margin:0 0 4px">${late ? '⏰' : ico} <a href="${h(link)}" style="color:#1f2a23;text-decoration:none;font-weight:600">${h(title)}</a> <span style="color:${late ? C.late : C.muted};font-size:13px">${h(meta)}</span></div>`;
  const lilyAll = [...overdue, ...dueToday, ...week, ...seniorNext.filter((i) => i.date <= addDays(today, 7))].filter((i, k, arr) => i !== top && arr.indexOf(i) === k && !(i.tag === 'Deadline' && countdown.slice(0, 4).includes(i)));
  const lily = lilyAll.slice(0, 4), lilyMore = lilyAll.length - lily.length;
  const meta = (i: Item) => i.date < today ? inDays(i.date) : (i.date === today ? 'today' : nice(i.date)) + (i.time ? ', ' + i.time : '');
  const amyTop = amy.slice(0, 2), trip = trips[0], dates = famDates.slice(0, 3);
  const wd = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const SIGNOFFS = [`Have a great ${wd}, Knafflas! 🌲`, `Go get ${wd}! 💪`, `You've got this, team! 🙌`, `Make it a good one! ☀️`, `Lake Michigan says hi! 🌊`, `Onward, Knafflas! 🚀`, `Happy ${wd}! 🎉`];
  const signoff = bdayToday.length ? 'Cake tonight? 🍰' : SIGNOFFS[daysBetween('2026-01-01', today) % SIGNOFFS.length];
  const shortDate = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2a23;font-size:15px;line-height:1.4">
  <div style="background-color:#3b2a7a;background-image:linear-gradient(135deg,#1d3f8f,#5b2a86 55%,#c2306f);color:#fff;border-radius:12px;padding:10px 14px;margin:0 0 12px;font-size:17px;font-weight:800">☀️ Knaffla Brief <span style="font-weight:600;font-size:14px;opacity:.9">· ${h(shortDate)}</span> <a href="${HOME}" style="float:right;color:#ffd86b;font-size:13px;font-weight:700;text-decoration:none;line-height:24px">Family page →</a></div>
  ${bdayToday.map((b) => `<div style="background-color:#d6336c;background-image:linear-gradient(135deg,#c2255c,#e8590c 55%,#f08c00);color:#fff;border-radius:12px;padding:10px 14px;margin:0 0 12px;font-size:18px;font-weight:800;text-align:center">🎂 Happy birthday, ${h(b.who)}! 🎉</div>`).join('')}
  ${top ? `<div style="background:#fff8e1;border-left:4px solid #f0b429;border-radius:8px;padding:8px 12px">⭐ <a href="${h(top.link)}" style="color:#1f2a23;font-weight:800;text-decoration:none">${h(top.title)}</a> <span style="color:${C.muted};font-size:13px">${h(when(top))}</span></div>` : ''}
  ${head('🎓 Lily', APP, C.lily)}${countdown.length ? `<div style="margin:0 0 6px">${countdown.slice(0, 4).map((c) => { const n = daysBetween(today, c.date); return `<span style="display:inline-block;background:${n <= 3 ? '#c2255c' : C.lily};color:#fff;border-radius:999px;padding:2px 10px;margin:0 4px 4px 0;font-size:12.5px;font-weight:700">${h(c.title.replace(' application due', ''))} · ${n === 0 ? 'today!' : n === 1 ? '1 day' : n + ' days'}</span>`; }).join('')}</div>` : ''}${lily.length ? lily.map((i) => row(i.title, i.link, meta(i), i.date < today, i.tag === 'Scholarship' ? '🏆' : i.tag === 'Deadline' ? '🎯' : i.event ? '📅' : '📝')).join('') : `<div style="color:${C.muted};font-size:14px">Nothing else this week.</div>`}${lilyMore > 0 ? `<div style="font-size:13px"><a href="${APP}#/tasks" style="color:${C.lily}">+ ${lilyMore} more</a></div>` : ''}
  ${amyTop.length ? head('📚 Amy', AMY, C.amy) + amyTop.map((t) => row(t.title, AMY, inDays(t.due_date), t.due_date < today, '📝')).join('') : ''}
  ${trip ? head('🧳 ' + trip.name, TRIPS + '#/trip/' + trip.id, C.trip) + `<div style="font-size:13px;color:${C.muted}">${h(tripInfo(trip).soon)}${tripInfo(trip).need.length ? ' · to book: ' + h(tripInfo(trip).need.join(', ')) : ' · all booked'}</div>` : ''}
  ${dates.length ? head('🗓️ Dates', HOME + 'calendar/', C.dates) + dates.map((d) => row(d.title.replace('🎂 ', ''), d.link, inDays(d.date), false, d.birthday ? '🎂' : '📌')).join('') : ''}
  <div style="margin:16px 0 0;font-size:14px;font-weight:700;color:#5b2a86">${h(signoff)}</div>
  <div style="margin:4px 0 0;font-size:12px;color:#9aa1a9">Mark things done and they drop off tomorrow.</div></div>`;

  const text = [`Knaffla Brief, ${shortDate}  ${HOME}`,
    ...bdayToday.map((b) => `HAPPY BIRTHDAY, ${b.who.toUpperCase()}!`),
    top ? `* ${top.title} (${when(top)})` : '',
    '\nLILY' + (countdown.length ? ': ' + countdown.slice(0, 4).map((c) => `${c.title.replace(' application due', '')} ${daysBetween(today, c.date)}d`).join(', ') : ''),
    ...lily.map((i) => `- ${i.title} (${meta(i)})`), lilyMore > 0 ? `+ ${lilyMore} more: ${APP}#/tasks` : '',
    amyTop.length ? '\nAMY\n' + amyTop.map((t) => `- ${t.title} (${inDays(t.due_date)})`).join('\n') : '',
    trip ? `\nTRIP: ${trip.name}, ${tripInfo(trip).soon}${tripInfo(trip).need.length ? '. To book: ' + tripInfo(trip).need.join(', ') : ''}` : '',
    dates.length ? '\nDATES\n' + dates.map((d) => `- ${d.title.replace('🎂 ', '')} (${inDays(d.date)})`).join('\n') : '',
    '\n' + signoff].filter((x) => x !== '').join('\n');
  const subject = `Knaffla Brief, ${nice(today)}: ${bdayToday.length ? '🎂 Happy birthday, ' + bdayToday.map((b) => b.who).join(' and ') + '! · ' : ''}${top ? top.title : 'nothing due this week'}`.slice(0, 120);

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
