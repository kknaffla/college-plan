// calendar-feed: subscribable iCalendar feed of open deadlines.
// URL: https://<project>.supabase.co/functions/v1/calendar-feed?token=<key from public.calendar_feed>
// Deploy with JWT verification OFF (calendar apps can't send a login); the token is the gate.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const APP_URL = 'https://kknaffla.github.io/college-plan/';
const TZ = 'America/Detroit';
const COLLEGE_DONE = ['Submitted', 'Complete', 'Admitted', 'Waitlisted', 'Denied', 'Not applying'];

function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const nextDay = (iso: string) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const esc = (s: unknown) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = (l: string) => { const out: string[] = []; while (l.length > 73) { out.push(l.slice(0, 73)); l = ' ' + l.slice(73); } out.push(l); return out.join('\r\n'); };
const isUrl = (u: unknown) => typeof u === 'string' && /^https?:\/\//i.test(u);

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token') || '';
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const feed = await sb.from('calendar_feed').select('token').eq('id', 1).maybeSingle();
  if (feed.error || !feed.data || !token || !sameToken(token, feed.data.token)) {
    return new Response('Not found', { status: 404 });
  }

  const [tasks, colleges, sch, visits] = await Promise.all([
    sb.from('tasks').select('id,title,due_date,due_time,owner,status,source_url,college_id').not('due_date', 'is', null),
    sb.from('colleges').select('id,name,deadline,deadline_time,status,source_url'),
    sb.from('scholarships').select('id,name,deadline,deadline_time,status,link').not('deadline', 'is', null),
    sb.from('visits').select('id,college_id,visit_date,kind').not('visit_date', 'is', null),
  ]);
  const err = [tasks, colleges, sch, visits].find((r) => r.error);
  if (err) return new Response('Feed unavailable', { status: 503 });

  const cname = new Map((colleges.data || []).map((c) => [c.id, c.name]));
  type Ev = { uid: string; date: string; summary: string; desc: string[] };
  const ev: Ev[] = [];
  for (const t of tasks.data || []) {
    if (['Submitted', 'Done'].includes(t.status)) continue;
    ev.push({ uid: `task-${t.id}`, date: t.due_date, summary: t.title,
      desc: [t.due_time ? 'Due ' + t.due_time : '', 'Owner: ' + t.owner, t.college_id ? 'College: ' + (cname.get(t.college_id) || '') : '', isUrl(t.source_url) ? t.source_url : ''] });
  }
  for (const c of colleges.data || []) {
    if (!c.deadline || COLLEGE_DONE.includes(c.status)) continue;
    ev.push({ uid: `college-${c.id}`, date: c.deadline, summary: 'DEADLINE: ' + c.name,
      desc: [c.deadline_time ? 'Due ' + c.deadline_time : '', 'Status: ' + c.status, isUrl(c.source_url) ? c.source_url : ''] });
  }
  for (const s of sch.data || []) {
    if (!['Planning', 'In progress'].includes(s.status)) continue;
    ev.push({ uid: `sch-${s.id}`, date: s.deadline, summary: 'Scholarship: ' + s.name,
      desc: [s.deadline_time ? 'Due ' + s.deadline_time : '', isUrl(s.link) ? s.link : ''] });
  }
  const t0 = today();
  for (const v of visits.data || []) {
    if (v.visit_date < t0) continue;
    ev.push({ uid: `visit-${v.id}`, date: v.visit_date, summary: 'Visit: ' + (cname.get(v.college_id) || 'College') + ' · ' + v.kind, desc: [] });
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lily College Plan//Feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Lily College Plan', 'X-WR-TIMEZONE:' + TZ, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const e of ev) {
    const desc = e.desc.filter(Boolean).concat('Open the plan: ' + APP_URL).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@college-plan`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${e.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${nextDay(e.date).replace(/-/g, '')}`,
      fold('SUMMARY:' + esc(e.summary)), fold('DESCRIPTION:' + esc(desc)), fold('URL:' + APP_URL), 'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', fold('DESCRIPTION:' + esc(e.summary)), 'TRIGGER:-PT15H', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'inline; filename="lily-college-plan.ics"' },
  });
});
