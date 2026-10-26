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
// Reads times like "6:00 PM", "5:30 pm", "11:59 PM ET", or ranges like "1:00-6:00 PM". Returns 24h start/end (end may be null).
function parseTime(txt: unknown): { sh: number; sm: number; eh: number | null; em: number } | null {
  if (typeof txt !== 'string') return null;
  const to24 = (h: number, ap: string) => (ap.toLowerCase() === 'p' ? (h % 12) + 12 : h % 12);
  const r = txt.match(/(\d{1,2})(?::(\d\d))?\s*([ap])?\.?\s?m?\.?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d\d))?\s*([ap])\.?\s?m/i);
  if (r) {
    const eh = to24(+r[4], r[6]);
    let sh = to24(+r[1], r[3] || r[6]);
    if (!r[3] && sh > eh) sh -= 12;
    return { sh, sm: +(r[2] || 0), eh, em: +(r[5] || 0) };
  }
  const m = txt.match(/(\d{1,2})(?::(\d\d))?\s*([ap])\.?\s?m/i);
  return m ? { sh: to24(+m[1], m[3]), sm: +(m[2] || 0), eh: null, em: 0 } : null;
}
const hhmm = (h: number, m: number) => String(h).padStart(2, '0') + String(m).padStart(2, '0') + '00';
const VTZ = ['BEGIN:VTIMEZONE', 'TZID:America/Detroit',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE'];

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token') || '';
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const feed = await sb.from('calendar_feed').select('token').eq('id', 1).maybeSingle();
  if (feed.error || !feed.data || !token || !sameToken(token, feed.data.token)) {
    return new Response('Not found', { status: 404 });
  }

  const [tasks, colleges, sch, visits] = await Promise.all([
    sb.from('tasks').select('id,title,due_date,due_time,owner,status,source_url,college_id,is_event').not('due_date', 'is', null),
    sb.from('colleges').select('id,name,deadline,deadline_time,status,source_url'),
    sb.from('scholarships').select('id,name,deadline,deadline_time,status,link').not('deadline', 'is', null),
    sb.from('visits').select('id,college_id,visit_date,kind').not('visit_date', 'is', null),
  ]);
  const err = [tasks, colleges, sch, visits].find((r) => r.error);
  if (err) return new Response('Feed unavailable', { status: 503 });

  const cname = new Map((colleges.data || []).map((c) => [c.id, c.name]));
  // time: set only for events with a clock time, which become timed entries; everything else stays all-day.
  type Ev = { uid: string; date: string; summary: string; desc: string[]; time?: string | null };
  const ev: Ev[] = [];
  for (const t of tasks.data || []) {
    if (['Submitted', 'Done', 'Not needed'].includes(t.status)) continue;
    const timed = t.is_event && parseTime(t.due_time);
    ev.push({ uid: `task-${t.id}`, date: t.due_date, time: timed ? t.due_time : null,
      summary: t.title + (!timed && t.due_time ? ` (due ${t.due_time})` : ''),
      desc: [t.due_time ? 'Due ' + t.due_time : '', 'Owner: ' + t.owner, t.college_id ? 'College: ' + (cname.get(t.college_id) || '') : '', isUrl(t.source_url) ? t.source_url : ''] });
  }
  for (const c of colleges.data || []) {
    if (!c.deadline || COLLEGE_DONE.includes(c.status)) continue;
    ev.push({ uid: `college-${c.id}`, date: c.deadline, summary: 'DEADLINE: ' + c.name + (c.deadline_time ? ` (${c.deadline_time})` : ''),
      desc: [c.deadline_time ? 'Due ' + c.deadline_time : '', 'Status: ' + c.status, isUrl(c.source_url) ? c.source_url : ''] });
  }
  for (const s of sch.data || []) {
    if (!['Planning', 'In progress'].includes(s.status)) continue;
    ev.push({ uid: `sch-${s.id}`, date: s.deadline, summary: 'Scholarship: ' + s.name + (s.deadline_time ? ` (due ${s.deadline_time})` : ''),
      desc: [s.deadline_time ? 'Due ' + s.deadline_time : '', isUrl(s.link) ? s.link : ''] });
  }
  const t0 = today();
  for (const v of visits.data || []) {
    if (v.visit_date < t0) continue;
    ev.push({ uid: `visit-${v.id}`, date: v.visit_date, summary: 'Visit: ' + (cname.get(v.college_id) || 'College') + ' · ' + v.kind, desc: [] });
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lily College Plan//Feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Lily College Plan', 'X-WR-TIMEZONE:' + TZ, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H', ...VTZ];
  for (const e of ev) {
    const desc = e.desc.filter(Boolean).concat('Open the plan: ' + APP_URL).join('\n');
    const d = e.date.replace(/-/g, '');
    const pt = e.time ? parseTime(e.time) : null;
    let when: string[];
    if (pt) {
      // Timed event in Detroit time; one hour long unless the time gave an end.
      let eh = pt.eh ?? pt.sh + 1, em = pt.eh === null ? pt.sm : pt.em;
      if (eh > 23) { eh = 23; em = 59; }
      when = [`DTSTART;TZID=${TZ}:${d}T${hhmm(pt.sh, pt.sm)}`, `DTEND;TZID=${TZ}:${d}T${hhmm(eh, em)}`];
    } else {
      when = [`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${nextDay(e.date).replace(/-/g, '')}`];
    }
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@college-plan`, `DTSTAMP:${stamp}`, ...when,
      fold('SUMMARY:' + esc(e.summary)), fold('DESCRIPTION:' + esc(desc)), fold('URL:' + APP_URL), pt ? 'TRANSP:OPAQUE' : 'TRANSP:TRANSPARENT',
      // All-day items remind at 9 AM the day before; timed events remind 2 hours ahead.
      'BEGIN:VALARM', 'ACTION:DISPLAY', fold('DESCRIPTION:' + esc(e.summary)), pt ? 'TRIGGER:-PT2H' : 'TRIGGER:-PT15H', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'inline; filename="lily-college-plan.ics"' },
  });
});
