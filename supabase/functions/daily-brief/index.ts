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

// ---------- outside sources (free, no keys): Open-Meteo weather, Google News RSS, iTunes Search ----------
const get = async (url: string, ms = 6000) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'KnafflaBrief/1.0' } }); return r.ok ? r : null; } catch { return null; } };
const WMO: Record<number, [string, string]> = { 0: ['☀️', 'Sunny'], 1: ['🌤️', 'Mostly sunny'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Cloudy'], 45: ['🌫️', 'Fog'], 48: ['🌫️', 'Fog'], 51: ['🌦️', 'Drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌦️', 'Drizzle'], 56: ['🧊', 'Freezing drizzle'], 57: ['🧊', 'Freezing drizzle'], 61: ['🌧️', 'Rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'], 66: ['🧊', 'Freezing rain'], 67: ['🧊', 'Freezing rain'], 71: ['🌨️', 'Snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'], 80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Heavy showers'], 85: ['🌨️', 'Snow showers'], 86: ['❄️', 'Snow showers'], 95: ['⛈️', 'Thunderstorms'], 96: ['⛈️', 'Thunderstorms'], 99: ['⛈️', 'Thunderstorms'] };
type Wx = { name: string; now: number; hi: number; lo: number; feels: number; code: number; rain: number; wind: number; sunrise: string; sunset: string };
async function weather(name: string, lat: number, lon: number): Promise<Wx | null> {
  const r = await get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code&daily=temperature_2m_max,temperature_2m_min,apparent_temperature_min,precipitation_probability_max,weather_code,wind_speed_10m_max,sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=1`);
  if (!r) return null;
  try { const j: any = await r.json(); const d = j.daily;
    return { name, now: Math.round(j.current.temperature_2m), feels: Math.round(d.apparent_temperature_min[0]), hi: Math.round(d.temperature_2m_max[0]), lo: Math.round(d.temperature_2m_min[0]), code: d.weather_code[0], rain: d.precipitation_probability_max[0] ?? 0, wind: Math.round(d.wind_speed_10m_max[0]), sunrise: String(d.sunrise[0]).slice(11, 16), sunset: String(d.sunset[0]).slice(11, 16) };
  } catch { return null; }
}
async function geocode(place: string): Promise<[number, number] | null> {
  const r = await get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place.split(',')[0].trim())}&count=1&country=US`);
  if (!r) return null; try { const j: any = await r.json(); return j.results?.[0] ? [j.results[0].latitude, j.results[0].longitude] : null; } catch { return null; }
}
// What to wear, from the day's coldest "feels like", rain chance, snow and wind.
function wear(w: Wx): string {
  const f = w.feels, snow = [71, 73, 75, 77, 85, 86].includes(w.code);
  let s = f < 15 ? 'Winter coat, hat, gloves and boots 🧤' : f < 32 ? 'Warm coat, hat and gloves 🧥' : f < 45 ? 'Jacket or fleece, maybe a hat 🧢' : f < 58 ? 'Light jacket or a sweatshirt' : f < 72 ? 'T-shirt, with a layer for the morning 👕' : 'Shorts and sunscreen 🕶️';
  if (snow) s += ', snow boots ❄️'; else if (w.rain >= 50) s += ', rain jacket ☔';
  if (w.wind >= 20) s += ', windy, zip up 💨';
  return s;
}
const ampm = (hm: string) => { const [H, M] = hm.split(':').map(Number); return `${H % 12 || 12}:${String(M).padStart(2, '0')}`; };
const decode = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
type News = { title: string; source: string; link: string; date: number };
async function rss(url: string, n: number): Promise<News[]> {
  const r = await get(url); if (!r) return [];
  const x = await r.text(), out: News[] = [];
  for (const m of x.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1], t = decode((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''), l = decode((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || ''), src = decode((it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
    const d = Date.parse((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '') || 0;
    if (!t || !/^https:\/\//.test(l)) continue;
    out.push({ title: src && t.endsWith(' - ' + src) ? t.slice(0, -(src.length + 3)) : t, source: src, link: l, date: d });
    if (out.length >= n) break;
  }
  return out;
}
const GN = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
async function newRelease(artist: string, sinceISO: string): Promise<{ title: string; date: string; link: string } | null> {
  const r = await get(`https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&entity=album&limit=10&country=US`);
  if (!r) return null;
  try { const j: any = await r.json();
    const hits = (j.results || []).filter((a: any) => String(a.artistName || '').toLowerCase().includes(artist.toLowerCase()) && String(a.releaseDate || '').slice(0, 10) >= sinceISO)
      .sort((a: any, b: any) => String(b.releaseDate).localeCompare(String(a.releaseDate)));
    return hits[0] ? { title: hits[0].collectionName, date: String(hits[0].releaseDate).slice(0, 10), link: hits[0].collectionViewUrl } : null;
  } catch { return null; }
}

// Moon phase from the date alone (synodic month 29.53 days from a known new moon).
function moon(iso: string): [string, string] {
  const days = (Date.parse(iso + 'T12:00:00Z') - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
  const age = ((days % 29.530588853) + 29.530588853) % 29.530588853, pct = Math.round((1 - Math.cos(2 * Math.PI * age / 29.530588853)) / 2 * 100);
  const names: [string, string][] = [['🌑', 'New moon'], ['🌒', 'Waxing crescent'], ['🌓', 'First quarter'], ['🌔', 'Waxing gibbous'], ['🌕', 'Full moon'], ['🌖', 'Waning gibbous'], ['🌗', 'Last quarter'], ['🌘', 'Waning crescent']];
  const i = Math.round(age / 29.530588853 * 8) % 8;
  return [names[i][0], names[i][1] + (i === 0 || i === 4 ? '' : `, ${pct}% lit`)];
}
// A light "on this day" fact from Wikipedia: skips grim items, prefers older history, rotates daily.
const GRIM = /\b(kill|dead|death|dies|died|massacre|bomb|attack|war|crash|collapse|earthquake|hurricane|shoot|murder|terror|assassinat|invasion|genocide|disaster|flood|fire|explosion|sink|sank|hostage|executed|riot|plague|famine|coup)\w*/i;
async function onThisDay(iso: string): Promise<{ text: string; year: number; link: string } | null> {
  const r = await get(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`);
  if (!r) return null;
  try { const j: any = await r.json();
    const ok = (j.events || []).filter((e: any) => e.year < 2010 && e.text && e.text.length < 160 && !GRIM.test(e.text) && e.pages?.[0]?.content_urls?.desktop?.page);
    if (!ok.length) return null;
    const e = ok[daysBetween('2026-01-01', iso) % ok.length];
    return { text: e.text, year: e.year, link: e.pages[0].content_urls.desktop.page };
  } catch { return null; }
}

// Daily fun: one easy trivia question (Open Trivia DB), a dad joke, and the latest xkcd (CC BY-NC, credited).
type Quiz = { category: string; question: string; answer: string; choices: string[] };
async function trivia(iso: string): Promise<Quiz | null> {
  const r = await get('https://opentdb.com/api.php?amount=1&type=multiple&difficulty=easy&encode=url3986'); if (!r) return null;
  try { const q: any = (await r.json()).results?.[0]; if (!q) return null; const d = decodeURIComponent;
    const choices = [...q.incorrect_answers.map(d), d(q.correct_answer)]; const seed = daysBetween('2026-01-01', iso);
    for (let i = choices.length - 1; i > 0; i--) { const j = (seed * 7 + i * 13) % (i + 1); [choices[i], choices[j]] = [choices[j], choices[i]]; }
    return { category: d(q.category).replace(/^Entertainment: |^Science: /, ''), question: d(q.question), answer: d(q.correct_answer), choices };
  } catch { return null; }
}
async function dadJoke(): Promise<string> {
  const r = await fetch('https://icanhazdadjoke.com/', { headers: { accept: 'application/json', 'user-agent': 'KnafflaBrief/1.0 (family email)' }, signal: AbortSignal.timeout(6000) }).catch(() => null);
  if (!r || !r.ok) return ''; try { return String((await r.json()).joke || '').slice(0, 240); } catch { return ''; }
}
async function xkcd(): Promise<{ title: string; img: string; alt: string; link: string } | null> {
  const r = await get('https://xkcd.com/info.0.json'); if (!r) return null;
  try { const j: any = await r.json(); return j.img && /^https:\/\/imgs\.xkcd\.com\//.test(j.img) ? { title: j.safe_title, img: j.img, alt: String(j.alt || '').slice(0, 200), link: 'https://xkcd.com/' + j.num + '/' } : null; } catch { return null; }
}

// Built-in fun lists (no source needed). Word of the day leans toward SAT vocabulary.
const WORDS: [string, string, string][] = [
  ['serendipity', 'noun', 'a happy accident; finding something good without looking for it'], ['ubiquitous', 'adj.', 'found everywhere'], ['candor', 'noun', 'honest, open speech'],
  ['ephemeral', 'adj.', 'lasting a very short time'], ['tenacious', 'adj.', 'holding on; not giving up'], ['pragmatic', 'adj.', 'practical rather than idealistic'],
  ['eloquent', 'adj.', 'fluent and persuasive in speech'], ['meticulous', 'adj.', 'very careful about details'], ['benevolent', 'adj.', 'kind and generous'],
  ['ambivalent', 'adj.', 'having mixed feelings'], ['resilient', 'adj.', 'able to bounce back'], ['nostalgia', 'noun', 'a longing for the past'],
  ['juxtapose', 'verb', 'to place side by side for contrast'], ['anomaly', 'noun', 'something that departs from the normal'], ['frugal', 'adj.', 'careful with money'],
  ['gregarious', 'adj.', 'sociable; fond of company'], ['lucid', 'adj.', 'clear and easy to understand'], ['novice', 'noun', 'a beginner'],
  ['prudent', 'adj.', 'wise and careful about the future'], ['scrutinize', 'verb', 'to examine closely'], ['vivid', 'adj.', 'bright, strong, lifelike'],
  ['wary', 'adj.', 'cautious; on guard'], ['zenith', 'noun', 'the highest point'], ['brevity', 'noun', 'shortness; saying it in few words'],
  ['diligent', 'adj.', 'hardworking and careful'], ['empathy', 'noun', 'understanding how someone else feels'], ['hypothesis', 'noun', 'an idea to be tested'],
  ['integrity', 'noun', 'honesty; doing right when no one is watching'], ['keen', 'adj.', 'sharp, eager'], ['mundane', 'adj.', 'ordinary, everyday'],
  ['optimist', 'noun', 'someone who expects the best'],
];
const QUESTIONS = [
  'Best Halloween costume you ever wore?', 'If we took one more trip this year, where?', 'What song is stuck in your head right now?', 'Dream job at age 10 vs. now?',
  'What is one thing you want to learn this winter?', 'Pancakes or waffles, and defend it.', 'Best meal we have had on a trip?', 'What would you name a family boat?',
  'One rule you would add at home. One you would drop.', 'Favorite thing about Crooked Lake?', 'Which superpower helps most on a school day?', 'What is a small win from this week?',
  'Mountains or beach for spring break?', 'What would you put in a Knaffla time capsule?', 'Best concert you have been to, or want to go to?', 'A food you hated as a kid and like now?',
  'If you could have dinner with one musician, who?', 'What is the funniest thing that happened this week?', 'Favorite family tradition?', 'Snow day plan: what do we do?',
  'One place in Michigan everyone should see?', 'Hardest class right now, and one thing that would help?', 'A movie we should all watch this weekend?', 'What are you most looking forward to this month?',
  'Cabin, camper or hotel?', 'Best teacher you ever had, and why?', 'What is your go-to karaoke song?', 'What is one kind thing someone did for you lately?',
];
// Fixed countdown targets (yearly) alongside birthdays from family_dates.
const HOLIDAYS: [string, number, number][] = [['🎄 Christmas', 12, 25], ['🎆 New Year', 1, 1], ['🦃 Thanksgiving', 11, 26], ['🎃 Halloween', 10, 31], ['🇺🇸 Fourth of July', 7, 4], ['☘️ St. Patrick\'s Day', 3, 17], ['💝 Valentine\'s Day', 2, 14]];

// Game day: our teams' games today and tomorrow, and yesterday's scores, from ESPN's public scoreboard (no key).
const TEAMS = ['Michigan', 'Michigan State', 'Michigan Tech', 'Northern Michigan', 'Lions', 'Red Wings', 'Tigers', 'Pistons'];
const RIVALS = [['Michigan', 'Michigan State'], ['Michigan', 'Ohio State'], ['Lions', 'Packers'], ['Michigan Tech', 'Northern Michigan']];
type Game = { when: string; label: string; detail: string; tv: string; rivalry: boolean; final: boolean; ours: boolean };
async function games(dayISO: string): Promise<Game[]> {
  const d = dayISO.replace(/-/g, ''), out: Game[] = [];
  const feeds = [`football/college-football/scoreboard?groups=80&dates=${d}`, `football/nfl/scoreboard?dates=${d}`, `hockey/nhl/scoreboard?dates=${d}`, `basketball/mens-college-basketball/scoreboard?groups=50&dates=${d}`, `basketball/nba/scoreboard?dates=${d}`, `baseball/mlb/scoreboard?dates=${d}`];
  const res = await Promise.all(feeds.map((f) => get('https://site.api.espn.com/apis/site/v2/sports/' + f, 5000)));
  for (const r of res) { if (!r) continue;
    try { const j: any = await r.json();
      for (const e of j.events || []) { const c = e.competitions?.[0]; if (!c) continue;
        const names: string[] = c.competitors.map((x: any) => x.team.shortDisplayName);
        const ours = names.filter((n) => TEAMS.some((t) => n === t));
        if (!ours.length) continue;
        const rivalry = RIVALS.some(([a, b]) => names.includes(a) && names.includes(b));
        const final = e.status?.type?.completed === true;
        const score = final ? c.competitors.map((x: any) => `${x.team.shortDisplayName} ${x.score}`).join(', ') : '';
        const t = new Date(e.date).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).replace(':00', '');
        out.push({ when: e.date, label: names.join(' vs '), detail: final ? score : t, tv: c.broadcasts?.[0]?.names?.[0] || '', rivalry, final, ours: true });
      }
    } catch { /* skip this feed */ }
  }
  return out.sort((a, b) => a.when.localeCompare(b.when));
}

type Item = { date: string; time?: string | null; title: string; who?: string; tag: string; rank: number; link: string; senior?: boolean; event?: boolean; cid?: string };

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
  const [setRes, artRes, folRes, memRes] = await Promise.all([
    sb.from('brief_settings').select('lily_focus,places,stars').eq('id', 1).maybeSingle(),
    sb.from('music_artists').select('id,name'),
    sb.from('music_follows').select('artist_id,user_id'),
    sb.from('members').select('user_id,display_name'),
  ]);
  const settings: any = setRes.data || {};

  const cname = new Map((colleges.data || []).map((c: any) => [c.id, SHORT[c.name] || c.name]));
  const items: Item[] = [];
  for (const t of (tasks.data || []) as any[]) {
    if (CLOSED.includes(t.status)) continue;
    if (t.is_event && t.due_date < today) continue; // past events simply drop off
    const col = t.college_id ? cname.get(t.college_id) : '';
    items.push({ date: t.due_date, time: t.due_time, title: t.title + (col && !t.title.includes(col) ? ` (${col})` : ''), who: t.owner === 'Parent' ? 'Parents' : t.owner, tag: t.is_event ? 'Event' : 'Task', rank: t.priority || 3, link: APP + '#/task/' + t.id, senior: t.category === 'Senior year', event: !!t.is_event, cid: t.college_id || undefined });
  }
  for (const c of (colleges.data || []) as any[]) {
    if (!c.deadline || COLLEGE_DONE.includes(c.status)) continue;
    items.push({ date: c.deadline, time: c.deadline_time, title: `${SHORT[c.name] || c.name} application due${c.plan && c.plan !== 'Undecided' ? ' (' + c.plan + ')' : ''}`, tag: 'Deadline', rank: 0, link: APP + '#/college/' + c.id, cid: c.id });
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
  // Kevin's wording: nothing is "overdue"; past-due items are things to focus on.
  const inDays = (iso: string) => { const n = daysBetween(today, iso); return n < 0 ? 'focus on' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`; };
  const tripInfo = (t: any) => {
    const need = (t.trip_items || []).filter((x: any) => x.kind === 'Booking' && !x.done).map((x: any) => x.title);
    const span = nice(t.start_date) + (t.end_date && t.end_date !== t.start_date ? ' to ' + nice(t.end_date) : '');
    return { span, need, soon: t.start_date <= today ? 'happening now' : inDays(t.start_date) };
  };
  const when = (i: Item) => (i.date === today ? 'Today' : nice(i.date)) + (i.time ? ', ' + i.time : '');

  // ---------- outside sections: weather, headlines, music (each optional; the email still goes out without them) ----------
  const places: any[] = Array.isArray(settings.places) && settings.places.length ? settings.places : [{ name: 'Ann Arbor', lat: 42.2808, lon: -83.743 }];
  const tripSoon = trips.find((t) => t.start_date <= addDays(today, 7) && t.destination);
  const tripGeo = tripSoon ? await geocode(tripSoon.destination) : null;
  // The third card is a daydream spot that rotates daily, with a rotating tag line; near a trip it's the destination.
  const TAGS = ['Dreaming of', 'Postcard from', 'Meanwhile in', 'Someday:', 'Wish we were in', 'Road trip to', 'Checking in on'];
  const pick = places[daysBetween('2026-01-01', today) % places.length];
  const second = tripSoon && tripGeo ? { name: 'Packing for ' + tripSoon.destination, lat: tripGeo[0], lon: tripGeo[1] } : { name: `${TAGS[daysBetween('2026-01-01', today) % TAGS.length]} ${pick.name}`, lat: pick.lat, lon: pick.lon };
  const followedIds = new Set(((folRes.data || []) as any[]).map((f) => f.artist_id));
  const followers = (id: string) => ((folRes.data || []) as any[]).filter((f) => f.artist_id === id).map((f) => (((memRes.data || []) as any[]).find((m) => m.user_id === f.user_id)?.display_name || '').split(' ')[0]).filter(Boolean);
  const artists = ((artRes.data || []) as any[]).filter((a) => followedIds.has(a.id)).slice(0, 12);
  // Crooked Lake (the cottage, about 25 miles north off M-94) uses the Germfask forecast.
  const [wxHome, wxLake, wxSecond, topNews, upNews, entNews, ...musicRaw] = await Promise.all([
    weather('Manistique', 45.9575, -86.2463), weather('Crooked Lake', 46.2494, -85.926), weather(second.name, second.lat, second.lon),
    rss('https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en', 3), rss(GN('Upper Peninsula Michigan when:2d'), 1),
    rss('https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=en-US&gl=US&ceid=US:en', 2),
    ...artists.map(async (a) => ({ a, news: (await rss(GN(`"${a.name}" when:7d`), 1))[0] || null, rel: await newRelease(a.name, addDays(today, -30)),
      tour: (await rss(GN(`"${a.name}" (tour OR concert OR "live at" OR arena OR stadium OR amphitheater) when:14d`), 3)).find((n) => /\b(tour|concert|live|arena|stadium|amphitheat|festival|show)/i.test(n.title)) || null })),
  ]);
  const music = (musicRaw as any[]).filter((m) => m.news || m.rel).slice(0, 4);
  // On tour: one line per artist with tour news, nearest-sounding first (Michigan, Wisconsin, Minnesota, Chicago).
  const NEAR = /michigan|detroit|grand rapids|wisconsin|milwaukee|madison|green bay|minnesota|minneapolis|chicago|little caesars|pine knob|van andel|fiserv|soldier field|wrigley/i;
  const onTour = (musicRaw as any[]).filter((m) => m.tour && m.tour.link !== m.news?.link).sort((a, b) => (NEAR.test(b.tour.title) ? 1 : 0) - (NEAR.test(a.tour.title) ? 1 : 0)).slice(0, 3);
  const [moonIco, moonName] = moon(today);
  // Fun zone: the quiz runs every day; two more fun cards rotate through the week so each morning feels different.
  const seed = daysBetween('2026-01-01', today);
  const ROTATION = ['joke', 'word', 'fact', 'question', 'comic', 'countdown', 'stars'];
  const slot1 = ROTATION[seed % ROTATION.length], slot2 = ROTATION[(seed + 3) % ROTATION.length];
  const want = new Set([slot1, slot2]);
  const [fact, quiz, joke, comic, gToday, gTomorrow, gYesterday] = await Promise.all([want.has('fact') ? onThisDay(today) : null, trivia(today), want.has('joke') ? dadJoke() : '', want.has('comic') ? xkcd() : null, games(today), games(addDays(today, 1)), games(addDays(today, -1))]);
  // Game day shows whenever one of our teams plays today or tomorrow, or played yesterday. Rivalry games always lead.
  const gameLines = [...gYesterday.filter((g) => g.final).map((g) => ({ ...g, tag: 'Final' })), ...gToday.filter((g) => !g.final).map((g) => ({ ...g, tag: 'Today' })), ...gTomorrow.map((g) => ({ ...g, tag: 'Tomorrow' }))]
    .sort((a, b) => (b.rivalry ? 1 : 0) - (a.rivalry ? 1 : 0)).slice(0, 4);
  const word = want.has('word') ? WORDS[seed % WORDS.length] : null;
  const question = want.has('question') ? QUESTIONS[seed % QUESTIONS.length] : '';
  const countdowns = want.has('countdown') ? [...HOLIDAYS.map(([t, m, d]) => ({ title: t, date: nextYearly(m, d) })), ...dbDates.filter((d) => d.birthday).map((d) => ({ title: d.title, date: d.date }))]
    .map((c) => ({ ...c, n: daysBetween(today, c.date) })).filter((c) => c.n > 0).sort((a, b) => a.n - b.n).slice(0, 4) : [];
  // The answer hides behind a tap: a link to the family calendar page with the answer in the hash, shown on arrival.
  const revealLink = quiz ? HOME + 'calendar/#answer=' + encodeURIComponent(quiz.answer) : '';
  // Fun fact: where the stars are heading (tours, concerts, sightings) from the last 3 days of news.
  const stars: string[] = Array.isArray(settings.stars) && new Set([ROTATION[daysBetween('2026-01-01', today) % ROTATION.length], ROTATION[(daysBetween('2026-01-01', today) + 3) % ROTATION.length]]).has('stars') ? settings.stars.slice(0, 3) : [];
  const starNews = (await Promise.all(stars.map(async (n) => ({ n, it: (await rss(GN(`"${n}" (tour OR concert OR heading OR visits OR spotted OR stadium) when:3d`), 1))[0] || null })))).filter((x) => x.it);

  // ---------- Lily's focus college and the top 3 ----------
  const focusCol = ((colleges.data || []) as any[]).find((c) => settings.lily_focus && c.name === settings.lily_focus && !COLLEGE_DONE.includes(c.status));
  const focusName = focusCol ? (SHORT[focusCol.name] || focusCol.name) : '';
  const isFocus = (i: Item) => !!focusCol && (i.cid === focusCol.id || i.title.includes(focusName));
  const open = items.filter((i) => !(i.event && i.date < today) && i.date <= addDays(today, 7));
  const focusItems = open.filter((i) => isFocus(i) && i.tag !== 'Deadline').sort((a, b) => a.date.localeCompare(b.date) || a.rank - b.rank).slice(0, 3);
  const focusDays = focusCol && focusCol.deadline ? daysBetween(today, focusCol.deadline) : null;
  const amyItems: Item[] = amy.map((t) => ({ date: t.due_date, title: t.title, who: 'Amy', tag: 'Task', rank: 2, link: AMY }));
  const top3 = [...open.filter((i) => !isFocus(i) && i.tag !== 'Deadline'), ...amyItems.filter((i) => i.date <= addDays(today, 7))]
    .sort((a, b) => (a.date < today ? 0 : 1) - (b.date < today ? 0 : 1) || a.rank - b.rank || a.date.localeCompare(b.date)).slice(0, 3);
  const pills = countdown.filter((c) => !(focusCol && c.cid === focusCol.id)).slice(0, 3);
  const trip = trips[0], dates = famDates.slice(0, 2);
  const when2 = (i: Item) => i.date < today ? 'focus on' : i.date === today ? 'today' + (i.time ? ', ' + i.time : '') : nice(i.date);

  // ---------- email ----------
  const wd = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const shortDate = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const SIGNOFFS = [`Have a great ${wd}, Knafflas! 🌲`, `Go get ${wd}! 💪`, `You've got this, team! 🙌`, `Make it a good one! ☀️`, `Lake Michigan says hi! 🌊`, `Onward, Knafflas! 🚀`, `Happy ${wd}! 🎉`];
  const signoff = bdayToday.length ? 'Cake tonight? 🍰' : SIGNOFFS[daysBetween('2026-01-01', today) % SIGNOFFS.length];
  const F = 'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif';
  const sec = (emoji: string, t: string, c: string, link?: string) => `<div style="margin:18px 0 6px;font-size:16px;font-weight:800;color:${c}">${emoji} ${link ? `<a href="${h(link)}" style="color:${c};text-decoration:none">${h(t)}</a>` : h(t)}</div>`;
  const li = (ico: string, title: string, link: string, meta: string, metaColor = '#6b7280') => `<div style="margin:0 0 5px">${ico} <a href="${h(link)}" style="color:#1f2a23;text-decoration:none;font-weight:600">${h(title)}</a> <span style="color:${metaColor};font-size:13px">${h(meta)}</span></div>`;
  const wxCard = (w: Wx | null, c1: string, c2: string) => w ? `<td style="width:33%;padding:3px;vertical-align:top"><div style="background-color:${c1};background-image:linear-gradient(135deg,${c1},${c2});color:#fff;border-radius:12px;padding:9px 10px;min-height:74px">
      <div style="font-size:12px;font-weight:700;opacity:.92;line-height:1.2;min-height:29px">${h(w.name)}</div>
      <div style="font-size:24px;font-weight:800;line-height:1.1">${(WMO[w.code] || ['🌡️'])[0]} ${w.now}°</div>
      <div style="font-size:12px">${w.hi}°/${w.lo}°${w.rain >= 30 ? ` · ${w.rain}%☔` : ''}</div></div></td>` : '';
  const ico = (i: Item) => i.date < today ? '🎯' : i.tag === 'Scholarship' ? '🏆' : i.event ? '📅' : i.who === 'Amy' ? '📚' : '📝';

  const html = `<div style="${F};max-width:540px;margin:0 auto;color:#1f2a23;font-size:15px;line-height:1.4">
  <div style="background-color:#3b2a7a;background-image:linear-gradient(135deg,#1d3f8f,#5b2a86 50%,#f107a3);color:#fff;border-radius:14px;padding:12px 16px;margin:0 0 10px">
    <div style="font-size:20px;font-weight:800">☀️ Knaffla Brief</div><div style="font-size:13px;opacity:.92">${h(wd)}, ${h(shortDate.slice(5))} · <a href="${HOME}" style="color:#ffd86b;font-weight:700;text-decoration:none">Family page →</a></div></div>
  ${bdayToday.map((b) => `<div style="background-color:#d6336c;background-image:linear-gradient(135deg,#c2255c,#e8590c 55%,#f08c00);color:#fff;border-radius:14px;padding:12px 16px;margin:0 0 10px;font-size:20px;font-weight:800;text-align:center">🎈🎂 Happy birthday, ${h(b.who)}! 🎉🎁</div>`).join('')}
  ${wxHome || wxLake || wxSecond ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 -3px"><tr>${wxCard(wxHome, '#0b5f73', '#2f86c9')}${wxCard(wxLake, '#1d6b45', '#4a9a3d')}${wxCard(wxSecond, '#b4400b', '#f08c00')}</tr></table>
  ${wxHome ? `<div style="margin:6px 0 0;font-size:14px">${h((WMO[wxHome.code] || ['', ''])[1])} in town${wxLake ? `, ${h((WMO[wxLake.code] || ['', ''])[1].toLowerCase())} at the lake` : ''}. 👗 <b>Wear:</b> ${h(wear(wxHome))}</div><div style="font-size:12.5px;color:#6b7280">🌅 ${ampm(wxHome.sunrise)} AM · 🌇 ${ampm(wxHome.sunset)} PM · ${moonIco} ${h(moonName)}${tripSoon && wxSecond ? ` · For ${h(tripSoon.name)}: ${h(wear(wxSecond))}` : ''}</div>` : ''}` : ''}
  ${focusCol ? `<div style="margin:16px 0 0;background-color:#1d3f8f;background-image:linear-gradient(135deg,#00274c,#1d3f8f);color:#fff;border-radius:14px;padding:12px 16px">
    <div style="font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#ffcb05">🎯 Lily, focus on ${h(focusName)}</div>
    <div style="font-size:19px;font-weight:800;margin:2px 0 6px">${focusDays === null ? h(focusName) + ' application' : focusDays <= 0 ? 'Due today! 🙌' : focusDays === 1 ? 'Due tomorrow' : 'Due in ' + focusDays + ' days'}${focusCol.plan && focusCol.plan !== 'Undecided' ? ` <span style="font-size:13px;opacity:.85">(${h(focusCol.plan)})</span>` : ''}</div>
    ${focusItems.map((i) => `<div style="margin:0 0 4px">✅ <a href="${h(i.link)}" style="color:#fff;font-weight:600;text-decoration:none">${h(i.title.replace(' (' + focusName + ')', ''))}</a> <span style="color:#ffcb05;font-size:13px">${h(when2(i))}</span></div>`).join('') || '<div style="font-size:14px">Nothing else open for it. Nice work!</div>'}
    <div style="margin-top:6px;font-size:13px"><a href="${APP}#/college/${h(focusCol.id)}" style="color:#ffcb05;font-weight:700">Open ${h(focusName)} →</a></div></div>` : ''}
  ${top3.length || pills.length ? sec('⭐', 'Top 3 today', '#b4400b') : ''}${pills.length ? `<div style="margin:0 0 6px">${pills.map((c) => { const n = daysBetween(today, c.date); return `<span style="display:inline-block;background:${n <= 3 ? '#c2255c' : '#1d3f8f'};color:#fff;border-radius:999px;padding:2px 10px;margin:0 4px 4px 0;font-size:12.5px;font-weight:700">${h(c.title.replace(' application due', ''))} · ${n <= 0 ? 'today!' : n === 1 ? '1 day' : n + ' days'}</span>`; }).join('')}</div>` : ''}${top3.map((i) => li(ico(i), i.title, i.link, (i.who && i.who !== 'Lily' ? i.who + ' · ' : '') + when2(i), i.date < today ? '#b4400b' : '#6b7280')).join('')}
  ${trip ? sec('🧳', trip.name, '#5b2a86', TRIPS + '#/trip/' + trip.id) + `<div style="font-size:13.5px;color:#4b5563">${h(tripInfo(trip).soon)}${trip.destination ? ' · ' + h(trip.destination) : ''}${tripInfo(trip).need.length ? ' · to book: ' + h(tripInfo(trip).need.join(', ')) : ' · all booked 🎉'}</div>` : ''}
  ${dates.length ? sec('🗓️', 'Coming up', '#a3361f', HOME + 'calendar/') + dates.map((d) => li(d.birthday ? '🎂' : '📌', d.title.replace('🎂 ', ''), d.link, inDays(d.date))).join('') : ''}
  ${topNews.length || upNews.length ? sec('📰', 'Headlines', '#0b5f73') + [...topNews, ...upNews.map((n) => ({ ...n, source: (n.source || '') + ' · Up North' }))].map((n) => li('•', n.title, n.link, n.source)).join('') : ''}
  ${entNews.length ? sec('🎬', 'Entertainment', '#8a1f5c') + entNews.map((n) => li('•', n.title, n.link, n.source)).join('') : ''}
  <!-- Fun zone: each item is its own colorful card with one big emoji and a line or two; nothing more. -->
  ${quiz ? `<div style="margin:22px 0 0;background-color:#0b5f73;background-image:linear-gradient(135deg,#0b5f73,#138a6c);color:#fff;border-radius:16px;padding:14px 16px"><table role="presentation" style="border-collapse:collapse"><tr><td style="font-size:40px;line-height:1;padding-right:12px;vertical-align:top">🧠</td><td>
    <div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Daily quiz · ${h(quiz.category)}</div>
    <div style="font-size:17px;font-weight:800;margin:3px 0 8px;line-height:1.3">${h(quiz.question)}</div>
    <div style="font-size:14px">${quiz.choices.map((c, i) => `<span style="display:inline-block;background:rgba(255,255,255,.2);border-radius:999px;padding:4px 12px;margin:0 6px 6px 0;font-weight:600">${'ABCD'[i]}. ${h(c)}</span>`).join('')}</div>
    <a href="${h(revealLink)}" style="display:inline-block;margin-top:4px;background:#ffd86b;color:#0b3d4a;font-weight:800;font-size:14px;padding:8px 14px;border-radius:999px;text-decoration:none">Reveal the answer →</a></td></tr></table></div>` : ''}
  ${joke ? `<div style="margin:12px 0 0;background-color:#c2306f;background-image:linear-gradient(135deg,#8a1f5c,#d9486f);color:#fff;border-radius:16px;padding:14px 16px"><table role="presentation" style="border-collapse:collapse"><tr><td style="font-size:40px;line-height:1;padding-right:12px;vertical-align:top">😂</td><td><div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Dad joke</div><div style="font-size:16px;font-weight:700;line-height:1.35">${h(joke)}</div></td></tr></table></div>` : ''}
  ${gameLines.length ? `<div style="margin:12px 0 0;background-color:#00274c;background-image:linear-gradient(135deg,#00274c,#18453b);color:#fff;border-radius:16px;padding:14px 16px"><table role="presentation" style="border-collapse:collapse"><tr><td style="font-size:40px;line-height:1;padding-right:12px;vertical-align:top">${gameLines.some((g) => g.rivalry) ? '🔥' : '🏟️'}</td><td><div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.85">${gameLines.some((g) => g.rivalry) ? 'Rivalry week!' : 'Game day'}</div>${gameLines.map((g) => `<div style="font-size:15px;margin:3px 0 0"><b>${h(g.label)}</b>${g.rivalry ? ' 🔥' : ''} <span style="opacity:.85">· ${h(g.tag)}${g.final ? ': ' : ' '}${h(g.detail)}${g.tv && !g.final ? ' on ' + h(g.tv) : ''}</span></div>`).join('')}</td></tr></table></div>` : ''}
  ${word ? `<div style="margin:12px 0 0;background-color:#1d3f8f;background-image:linear-gradient(135deg,#1d3f8f,#2f86c9);color:#fff;border-radius:16px;padding:14px 16px"><table role="presentation" style="border-collapse:collapse"><tr><td style="font-size:40px;line-height:1;padding-right:12px;vertical-align:top">📖</td><td><div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Word of the day</div><div style="font-size:20px;font-weight:800">${h(word[0])} <span style="font-size:13px;font-weight:600;opacity:.8">${h(word[1])}</span></div><div style="font-size:15px;line-height:1.35">${h(word[2])}</div></td></tr></table></div>` : ''}
  ${question ? `<div style="margin:12px 0 0;background-color:#138a6c;background-image:linear-gradient(135deg,#0b5f73,#4a9a3d);color:#fff;border-radius:16px;padding:14px 16px"><table role="presentation" style="border-collapse:collapse"><tr><td style="font-size:40px;line-height:1;padding-right:12px;vertical-align:top">💬</td><td><div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Dinner table question</div><div style="font-size:17px;font-weight:800;line-height:1.3">${h(question)}</div></td></tr></table></div>` : ''}
  ${countdowns.length ? `<div style="margin:12px 0 0;background-color:#a3361f;background-image:linear-gradient(135deg,#a3361f,#d9762b);color:#fff;border-radius:16px;padding:14px 16px"><table role="presentation" style="border-collapse:collapse"><tr><td style="font-size:40px;line-height:1;padding-right:12px;vertical-align:top">⏳</td><td><div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Countdowns</div>${countdowns.map((c) => `<span style="display:inline-block;background:rgba(255,255,255,.2);border-radius:999px;padding:4px 12px;margin:4px 6px 0 0;font-size:14px;font-weight:700">${h(c.title)} · ${c.n} day${c.n === 1 ? '' : 's'}</span>`).join('')}</td></tr></table></div>` : ''}
  ${onTour.length ? `<div style="margin:12px 0 0;background-color:#e8590c;background-image:linear-gradient(135deg,#b4400b,#f08c00);color:#fff;border-radius:16px;padding:14px 16px"><table role="presentation" style="border-collapse:collapse"><tr><td style="font-size:40px;line-height:1;padding-right:12px;vertical-align:top">🎤</td><td><div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.85">On tour</div>${onTour.map((m) => `<div style="font-size:15px;margin:3px 0 0"><b>${h(m.a.name)}</b> ${NEAR.test(m.tour.title) ? '📍' : '🚌'} <a href="${h(m.tour.link)}" style="color:#fff;text-decoration:underline;text-decoration-color:rgba(255,255,255,.5)">${h(m.tour.title)}</a></div>`).join('')}</td></tr></table></div>` : ''}
  ${starNews.length ? `<div style="margin:12px 0 0;background-color:#c2255c;background-image:linear-gradient(135deg,#c2255c,#f107a3);color:#fff;border-radius:16px;padding:14px 16px"><table role="presentation" style="border-collapse:collapse"><tr><td style="font-size:40px;line-height:1;padding-right:12px;vertical-align:top">🌟</td><td><div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Where the stars are</div>${starNews.map((x) => `<div style="font-size:15px;margin:3px 0 0"><a href="${h(x.it!.link)}" style="color:#fff;text-decoration:underline;text-decoration-color:rgba(255,255,255,.5)">${h(x.it!.title)}</a></div>`).join('')}</td></tr></table></div>` : ''}
  ${music.length ? `<div style="margin:12px 0 0;background-color:#5b2a86;background-image:linear-gradient(135deg,#2b1055,#7b2ff7);color:#fff;border-radius:16px;padding:14px 16px"><table role="presentation" style="border-collapse:collapse"><tr><td style="font-size:40px;line-height:1;padding-right:12px;vertical-align:top">🎶</td><td><div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.85"><a href="${HOME}music/" style="color:#fff;text-decoration:none">Music we follow</a></div>${music.map((m) => `<div style="font-size:15px;margin:3px 0 0"><b>${h(m.a.name)}</b> <span style="opacity:.7;font-size:12px">${h(followers(m.a.id).join(', '))}</span>${m.rel ? `<br>💿 <a href="${h(m.rel.link)}" style="color:#fff;text-decoration:underline;text-decoration-color:rgba(255,255,255,.5)">New: ${h(m.rel.title)}</a>` : ''}${m.news && !onTour.some((t) => t.a.id === m.a.id && t.tour.link === m.news.link) ? `<br>🗞️ <a href="${h(m.news.link)}" style="color:#fff;text-decoration:underline;text-decoration-color:rgba(255,255,255,.5)">${h(m.news.title)}</a>` : ''}</div>`).join('')}</td></tr></table></div>` : artists.length ? '' : `<div style="margin:12px 0 0;background:#f3e8ff;border-radius:16px;padding:12px 16px;font-size:14px">🎶 <a href="${HOME}music/" style="color:#5b2a86;font-weight:800;text-decoration:none">Pick the music you follow →</a></div>`}
  ${comic ? `<div style="margin:12px 0 0;background:#f8fafc;border:1px solid #e5e7eb;border-radius:16px;padding:12px;text-align:center"><a href="${h(comic.link)}" style="text-decoration:none;color:#6b7280;font-size:12px"><img src="${h(comic.img)}" alt="${h(comic.alt)}" title="${h(comic.alt)}" style="max-width:100%;max-height:240px;width:auto;border-radius:8px"><br>✏️ ${h(comic.title)} · xkcd.com (CC BY-NC)</a></div>` : ''}
  ${fact ? `<div style="margin:12px 0 0;background-color:#a8640c;background-image:linear-gradient(135deg,#a8640c,#f0b429);color:#fff;border-radius:16px;padding:14px 16px"><table role="presentation" style="border-collapse:collapse"><tr><td style="font-size:40px;line-height:1;padding-right:12px;vertical-align:top">🤓</td><td><div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.85">On this day, ${fact.year}</div><div style="font-size:15px;font-weight:600;line-height:1.35">${h(fact.text)} <a href="${h(fact.link)}" style="color:#fff;font-weight:800;text-decoration:none">more →</a></div></td></tr></table></div>` : ''}
  ${(() => { const B: [string, string, string, string][] = [['🎓 Lily', APP, '#1d3f8f', '#2f86c9'], ['📚 Amy', HOME + 'amy/', '#8a1f5c', '#d9486f'], ['🧳 Trips', TRIPS, '#5b2a86', '#c2306f'], ['📅 Calendar', HOME + 'calendar/', '#a3361f', '#d9762b'], ['🎶 Music', HOME + 'music/', '#2b1055', '#f107a3'], ['🏡 Family', HOME, '#0b5f73', '#138a6c']];
    return `<table role="presentation" style="width:100%;border-collapse:separate;border-spacing:6px;margin:16px -6px 0"><tr>${B.slice(0, 3).map(([t, u, c1, c2]) => `<td style="width:33%"><a href="${u}" style="display:block;text-align:center;background-color:${c1};background-image:linear-gradient(135deg,${c1},${c2});color:#fff;font-weight:800;font-size:15px;padding:14px 6px;border-radius:14px;text-decoration:none">${t}</a></td>`).join('')}</tr><tr>${B.slice(3).map(([t, u, c1, c2]) => `<td style="width:33%"><a href="${u}" style="display:block;text-align:center;background-color:${c1};background-image:linear-gradient(135deg,${c1},${c2});color:#fff;font-weight:800;font-size:15px;padding:14px 6px;border-radius:14px;text-decoration:none">${t}</a></td>`).join('')}</tr></table>`; })()}
  <div style="margin:14px 0 0;padding:10px 14px;border-radius:12px;background:#f3e8ff;font-size:15px;font-weight:800;color:#5b2a86;text-align:center">${h(signoff)}</div></div>`;

  const text = [`KNAFFLA BRIEF, ${wd}, ${shortDate.slice(5)}  ${HOME}`,
    ...bdayToday.map((b) => `HAPPY BIRTHDAY, ${b.who.toUpperCase()}!`),
    wxHome ? `\nWEATHER: Manistique ${wxHome.now}° ${(WMO[wxHome.code] || ['', ''])[1]}, ${wxHome.hi}°/${wxHome.lo}°. Wear: ${wear(wxHome)}` : '',
    wxLake ? `Crooked Lake ${wxLake.now}° ${(WMO[wxLake.code] || ['', ''])[1]}, ${wxLake.hi}°/${wxLake.lo}°` : '',
    wxSecond ? `${wxSecond.name} ${wxSecond.now}° ${(WMO[wxSecond.code] || ['', ''])[1]}, ${wxSecond.hi}°/${wxSecond.lo}°` : '',
    focusCol ? `\nLILY, FOCUS ON ${focusName.toUpperCase()}${focusDays !== null ? ` (due ${focusDays <= 0 ? 'today' : 'in ' + focusDays + ' days'})` : ''}\n` + focusItems.map((i) => `- ${i.title} (${when2(i)})`).join('\n') : '',
    top3.length ? '\nTOP 3\n' + top3.map((i) => `- ${i.title} (${(i.who && i.who !== 'Lily' ? i.who + ', ' : '') + when2(i)})`).join('\n') : '',
    trip ? `\nTRIP: ${trip.name}, ${tripInfo(trip).soon}${tripInfo(trip).need.length ? '. To book: ' + tripInfo(trip).need.join(', ') : ''}` : '',
    dates.length ? '\nCOMING UP\n' + dates.map((d) => `- ${d.title.replace('🎂 ', '')} (${inDays(d.date)})`).join('\n') : '',
    topNews.length ? '\nHEADLINES\n' + [...topNews, ...upNews].map((n) => `- ${n.title} (${n.source}) ${n.link}`).join('\n') : '',
    entNews.length ? '\nENTERTAINMENT\n' + entNews.map((n) => `- ${n.title} (${n.source}) ${n.link}`).join('\n') : '',
    onTour.length ? '\nON TOUR\n' + onTour.map((m) => `- ${m.a.name}: ${m.tour.title} ${m.tour.link}`).join('\n') : '',
    starNews.length ? '\nWHERE THE STARS ARE\n' + starNews.map((x) => `- ${x.it!.title} ${x.it!.link}`).join('\n') : '',
    music.length ? '\nMUSIC\n' + music.map((m) => `- ${m.a.name}: ${m.rel ? 'New: ' + m.rel.title + '. ' : ''}${m.news ? m.news.title : ''}`).join('\n') : '',
    quiz ? `\nDAILY QUIZ (${quiz.category}): ${quiz.question}\n` + quiz.choices.map((c, i) => `  ${'ABCD'[i]}. ${c}`).join('\n') + `\n  Answer: ${revealLink}` : '',
    joke ? `\nDAD JOKE: ${joke}` : '',
    gameLines.length ? '\nGAME DAY\n' + gameLines.map((g) => `- ${g.label}: ${g.tag} ${g.detail}${g.tv && !g.final ? ' on ' + g.tv : ''}`).join('\n') : '',
    word ? `\nWORD OF THE DAY: ${word[0]} (${word[1]}): ${word[2]}` : '',
    question ? `\nDINNER TABLE QUESTION: ${question}` : '',
    countdowns.length ? '\nCOUNTDOWNS: ' + countdowns.map((c) => `${c.title} ${c.n}d`).join(', ') : '',
    comic ? `\nCARTOON: ${comic.title} ${comic.link}` : '',
    `\nMOON: ${moonName}`,
    fact ? `\nON THIS DAY, ${fact.year}: ${fact.text} ${fact.link}` : '',
    '\n' + signoff].filter((x) => x !== '').join('\n');
  const subject = `☀️ Knaffla Brief, ${nice(today)}: ${bdayToday.length ? '🎂 Happy birthday, ' + bdayToday.map((b) => b.who).join(' and ') + '! · ' : ''}${focusCol && focusDays !== null && focusDays <= 7 ? `${focusName} ${focusDays <= 0 ? 'due today' : 'in ' + focusDays + ' days'} · ` : ''}${wxHome ? `${(WMO[wxHome.code] || ['🌡️'])[0]} ${wxHome.hi}°` : ''}`.slice(0, 120);

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
