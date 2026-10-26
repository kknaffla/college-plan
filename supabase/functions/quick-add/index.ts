// quick-add: turns text shared from an iPhone (Shortcut › Get Contents of URL, POST JSON {"text": ...}) into a task.
// URL: https://<project>.supabase.co/functions/v1/quick-add?key=<key from public.quick_add>
// Deploy with JWT verification OFF (Shortcuts can't send a login); the key is the gate.
// parseQuick is kept identical to the copy in site/app.js.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const TZ = 'America/Detroit';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const reply = (msg: string, status = 200) => new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// Reads pasted or shared text (an email, a note) and guesses a task: title, earliest upcoming date, time, link, category, college.
const QP_MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseQuick(text: any, today: string): any {
  const raw = String(text || '').replace(/\r/g, '').trim().slice(0, 8000);
  const lines = raw.split('\n').map((l: string) => l.trim()).filter(Boolean);
  const HDR = /^(from|to|cc|bcc|sent|date|reply-to)\s*:/i;
  const SKIP = (l: string) => HDR.test(l) || /^-+\s*(forwarded|original) message/i.test(l) || /^on .+ wrote:$/i.test(l) || /^begin forwarded message/i.test(l);
  const subj = lines.find((l: string) => /^subject\s*:/i.test(l));
  let title = subj ? subj.replace(/^subject\s*:\s*/i, '') : (lines.find((l: string) => !SKIP(l)) || '');
  title = title.replace(/^((re|fwd?|fw)\s*:\s*)+/i, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (title.length > 120) title = title.slice(0, 117).replace(/\s+\S*$/, '') + '…';
  const um = raw.match(/https?:\/\/[^\s<>"')\]]+/i);
  const url = um ? um[0].replace(/[.,;:]+$/, '') : null;
  const body = lines.filter((l: string) => !SKIP(l)).join('\n');
  const ty = +today.slice(0, 4);
  const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  const withYear = (y: number, m: number, d: number) => { if (y) return iso(y < 100 ? 2000 + y : y, m, d); const a = iso(ty, m, d); return a && a < today ? iso(ty + 1, m, d) : a; };
  const found: (string | null)[] = [];
  let mm: any;
  const reIso = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
  while ((mm = reIso.exec(body))) found.push(iso(+mm[1], +mm[2], +mm[3]));
  const reMon = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(20\d\d))?/gi;
  while ((mm = reMon.exec(body))) found.push(withYear(mm[3] ? +mm[3] : 0, QP_MON[mm[1].slice(0, 3).toLowerCase()], +mm[2]));
  const reNum = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g;
  while ((mm = reNum.exec(body))) found.push(withYear(mm[3] ? +mm[3] : 0, +mm[1], +mm[2]));
  const dates = found.filter((d): d is string => !!d && d >= today).sort();
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

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply('Use POST.', 405);
  const key = new URL(req.url).searchParams.get('key') || req.headers.get('x-key') || '';
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const k = await sb.from('quick_add').select('token').eq('id', 1).maybeSingle();
  if (k.error || !k.data || !key || !sameToken(key, k.data.token)) return reply('Not found', 404);

  let text = '';
  const ct = req.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) { const j: any = await req.json(); text = String(j?.text ?? j?.input ?? ''); }
    else if (ct.includes('form')) { const f = await req.formData(); text = String(f.get('text') ?? ''); }
    else text = await req.text();
  } catch (_e) { text = ''; }
  text = text.trim();
  if (!text) return reply('Nothing to add. Share some text and try again.', 400);

  const q = parseQuick(text, today());
  let college_id: string | null = null;
  if (q.college) {
    const c = await sb.from('colleges').select('id').eq('name', q.college).maybeSingle();
    college_id = c.data?.id ?? null;
  }
  const ins = await sb.from('tasks').insert({
    title: q.title, due_date: q.due_date, due_time: q.due_time, source_url: q.source_url, category: q.category,
    college_id, owner: 'Both', status: 'Not started', priority: 2, checklist: [],
    notes: 'Added from iPhone Share. Check the title, date, and owner.\n\n' + q.notes,
  }).select('id').single();
  if (ins.error) return reply('Could not add it: ' + ins.error.message, 500);
  return reply(`Added to College Plan: ${q.title}${q.due_date ? ' (due ' + q.due_date + (q.due_time ? ' ' + q.due_time : '') + ')' : ' (no date found)'}`);
});
