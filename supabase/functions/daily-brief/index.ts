// daily-brief: emails Kevin, Janet, and Lily a short morning brief from the college plan.
// Called by pg_cron (migration 012) with the x-brief-key header from public.daily_brief.
// Sends only at send_hour America/Detroit, once per day, when enabled. POST ?test=1 sends now to test_recipient only.
// Secrets (Supabase › Edge Functions › Secrets): GMAIL_USER, GMAIL_APP_PASSWORD (a Google app password, never a real password).
// Verify JWT stays ON: the cron call sends the public anon key.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import nodemailer from 'npm:nodemailer@6.9.16';

const APP = 'https://kknaffla.github.io/college-plan/';
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

type Item = { date: string; time?: string | null; title: string; who?: string; tag: string; rank: number; link: string };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply('Use POST.', 405);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const cfgRes = await sb.from('daily_brief').select('*').eq('id', 1).maybeSingle();
  const cfg: any = cfgRes.data;
  const key = req.headers.get('x-brief-key') || '';
  if (cfgRes.error || !cfg || !key || !sameToken(key, cfg.token)) return reply('Not found', 404);

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
    sb.from('tasks').select('id,title,due_date,due_time,owner,status,priority,college_id').not('due_date', 'is', null),
    sb.from('colleges').select('id,name,deadline,deadline_time,status,plan'),
    sb.from('scholarships').select('id,name,deadline,deadline_time,status').not('deadline', 'is', null),
  ]);
  const err = [tasks, colleges, sch].find((r) => r.error);
  if (err) return reply('Could not read the plan.', 503);

  const cname = new Map((colleges.data || []).map((c: any) => [c.id, SHORT[c.name] || c.name]));
  const items: Item[] = [];
  for (const t of (tasks.data || []) as any[]) {
    if (CLOSED.includes(t.status)) continue;
    const col = t.college_id ? cname.get(t.college_id) : '';
    items.push({ date: t.due_date, time: t.due_time, title: t.title + (col && !t.title.includes(col) ? ` (${col})` : ''), who: t.owner === 'Parent' ? 'Parents' : t.owner, tag: 'Task', rank: t.priority || 3, link: APP + '#/task/' + t.id });
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
  const overdue = items.filter((i) => i.date < today && i.tag === 'Task').sort((a, b) => a.rank - b.rank || a.date.localeCompare(b.date));
  const dueToday = items.filter((i) => i.date === today).sort((a, b) => a.rank - b.rank);
  const week = items.filter((i) => i.date > today && i.date <= addDays(today, 7)).sort(byWhen);
  const top = dueToday[0] || overdue.find((i) => i.rank <= 1) || week.find((i) => i.rank <= 1) || overdue[0] || week[0] || null;
  const countdown = items.filter((i) => i.tag === 'Deadline' && i.date >= today && i.date <= addDays(today, 30)).sort(byWhen);

  const when = (i: Item) => (i.date === today ? 'Today' : nice(i.date)) + (i.time ? ', ' + i.time : '');
  const line = (i: Item, showDate = true) => `<li style="margin:0 0 8px"><a href="${h(i.link)}" style="color:#1d3b2a;font-weight:600;text-decoration:none">${h(i.title)}</a><br><span style="color:#5f6b63;font-size:13px">${showDate ? h(when(i)) : (i.time ? h(i.time) : 'Today')}${i.who ? ' · ' + h(i.who) : ''}${i.tag !== 'Task' ? ' · ' + h(i.tag) : ''}</span></li>`;
  const section = (title: string, list: Item[], showDate = true, max = 6) => list.length ? `<h3 style="font-size:15px;margin:18px 0 6px;color:#1d3b2a">${h(title)}</h3><ul style="padding-left:18px;margin:0">${list.slice(0, max).map((i) => line(i, showDate)).join('')}</ul>${list.length > max ? `<p style="font-size:13px;margin:4px 0 0"><a href="${APP}#/tasks">+ ${list.length - max} more</a></p>` : ''}` : '';
  const dateLabel = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2a23;font-size:15px;line-height:1.45">
  <p style="margin:0 0 4px;color:#5f6b63;font-size:13px">${h(dateLabel)} · <a href="${APP}" style="color:#1d3b2a">Open the college plan</a></p>
  <h2 style="margin:0 0 12px;font-size:20px">Lily's college plan: today</h2>
  ${top ? `<div style="background:#eef5ef;border-left:4px solid #2f6b45;padding:12px 14px;border-radius:6px"><div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#2f6b45;font-weight:700">Most important</div><a href="${h(top.link)}" style="font-size:17px;font-weight:700;color:#1d3b2a;text-decoration:none">${h(top.title)}</a><div style="color:#5f6b63;font-size:13px">${h(when(top))}${top.who ? ' · ' + h(top.who) : ''}</div></div>` : '<p>Nothing is due in the next week. A good day to get ahead.</p>'}
  ${countdown.length ? `<p style="margin:14px 0 0;font-size:14px">${countdown.map((c) => { const n = daysBetween(today, c.date); return `<b>${h(c.title.replace(' application due', ''))}</b> ${n === 0 ? 'due today' : `in ${n} day${n === 1 ? '' : 's'}`}`; }).join(' · ')}</p>` : ''}
  ${section('Due today', dueToday.filter((i) => i !== top), false)}
  ${section('Overdue', overdue.filter((i) => i !== top), true, 5)}
  ${section('Next 7 days', week.filter((i) => i !== top), true, 6)}
  <p style="margin:22px 0 0"><a href="${APP}" style="display:inline-block;background:#2f6b45;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open the college plan</a></p>
  <p style="color:#8a948d;font-size:12px;margin:16px 0 0">Sent at 7 AM by the college plan. Mark things done in the app and they drop off tomorrow's email.</p></div>`;

  const tline = (i: Item) => `- ${i.title} (${when(i)}${i.who ? ', ' + i.who : ''}) ${i.link}`;
  const text = [`Lily's college plan: ${dateLabel}`, `Open the app: ${APP}`, '',
    top ? `MOST IMPORTANT: ${top.title} (${when(top)})\n${top.link}` : 'Nothing due in the next week.',
    dueToday.length ? '\nDUE TODAY\n' + dueToday.filter((i) => i !== top).map(tline).join('\n') : '',
    overdue.length ? '\nOVERDUE\n' + overdue.filter((i) => i !== top).slice(0, 5).map(tline).join('\n') : '',
    week.length ? '\nNEXT 7 DAYS\n' + week.filter((i) => i !== top).slice(0, 6).map(tline).join('\n') : ''].join('\n');
  const subject = `College plan ${nice(today)}: ${top ? top.title : 'nothing due this week'}`.slice(0, 120);

  const user = Deno.env.get('GMAIL_USER'), pass = Deno.env.get('GMAIL_APP_PASSWORD');
  if (!user || !pass) return reply('Email secrets are not set yet.', 500);
  try {
    const tx = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
    await tx.sendMail({ from: `"College Plan" <${user}>`, to: to.join(', '), subject, text, html });
  } catch (e) {
    return reply('Send failed: ' + (e as Error).message, 502);
  }
  if (!test) await sb.from('daily_brief').update({ last_sent_on: today }).eq('id', 1);
  return reply(`Sent to ${to.length} ${test ? '(test)' : ''}: ${subject}`);
});
