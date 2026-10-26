const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path'); const http = require('http');
const ROOT = path.join(__dirname, '..', 'site'); const FIX = path.join(__dirname, 'fixtures'); const SP = path.join(__dirname, 'out'); fs.mkdirSync(SP, { recursive: true });
const srv = http.createServer((req,res)=>{ let p = req.url.split('?')[0]; if(p==='/') p='/index.html';
  if(p==='/config.js'){ res.setHeader('content-type','text/javascript'); return res.end(`window.APP_CONFIG={SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'x',TIME_ZONE:'America/Detroit',WEEK_START:'2026-10-25',WEEK_END:'2026-11-01'};`); }
  try { const b=fs.readFileSync(path.join(ROOT,p)); res.setHeader('content-type', p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.svg')?'image/svg+xml':'text/html'); res.end(b);} catch(e){res.statusCode=404;res.end();} }).listen(8123);
(async () => {
  const b = await chromium.launch();
  const errors=[];
  for (const [name, vp] of [['phone',{width:390,height:844}],['desktop',{width:1280,height:900}]]) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', e=>errors.push(name+': '+e.message)); p.on('console', m=>{ if(m.type()==='error') errors.push(name+' console: '+m.text()); });
    await p.route('**/supabase.min.js', r => r.fulfill({ contentType:'text/javascript', body: `window.__SEED__=${fs.readFileSync(FIX+'/seed.json','utf8')};window.__LOGGED_IN__=${name==='desktop'};` + fs.readFileSync(path.join(__dirname,'mock-supabase.js'),'utf8') }));
    await p.clock.install({ time: new Date('2026-10-26T14:00:00Z') });
    await p.goto('http://localhost:8123/');
    await p.waitForTimeout(400);
    if (name==='phone') {
      await p.screenshot({ path: `${SP}/ui-${name}-login.png` });
      await p.fill('input[name=email]','kk@x'); await p.fill('input[name=pw]','x'); await p.click('button[type=submit]');
      await p.waitForTimeout(400);
    }
    await p.screenshot({ path: `${SP}/ui-${name}-home.png`, fullPage: true });
    const sw = await p.evaluate(()=>document.documentElement.scrollWidth); console.log(name,'scrollWidth',sw);
    // status change
    const sel = p.locator('select.status').first(); await sel.selectOption('In progress'); await p.waitForTimeout(200);
    // week
    await p.goto('http://localhost:8123/#/week'); await p.waitForTimeout(300);
    const cb = p.locator('.checklist input').first(); await cb.check(); await p.waitForTimeout(200);
    console.log(name,'checked persisted', await p.evaluate(()=>document.querySelector('.checklist input').checked));
    await p.screenshot({ path: `${SP}/ui-${name}-week.png`, fullPage: true });
    // college detail + ED warning
    await p.goto('http://localhost:8123/#/college/00000000-0000-4000-a000-000000000001'); await p.waitForTimeout(300);
    await p.screenshot({ path: `${SP}/ui-${name}-college.png`, fullPage: true });
    let dlg=null; p.on('dialog', async d=>{ dlg=d.message(); await d.dismiss(); });
    await p.click('#editCollege'); await p.selectOption('#f_plan','ED'); await p.click('#edForm button[type=submit]'); await p.waitForTimeout(200);
    console.log(name,'ED warning:', !!dlg, 'sheet still open:', await p.evaluate(()=>document.getElementById('sheet').open));
    await p.click('#edCancel');
    // add task
    await p.goto('http://localhost:8123/#/tasks'); await p.waitForTimeout(200);
    await p.click('#addTask'); await p.fill('#f_title','Test task'); await p.fill('#f_due_date','2026-10-27'); await p.fill('#f__checklist','[x] one\ntwo');
    await p.screenshot({ path: `${SP}/ui-${name}-editor.png` });
    await p.click('#edForm button[type=submit]'); await p.waitForTimeout(300);
    console.log(name,'task added', await p.locator('text=Test task').count());
    for (const r of ['calendar','visits','offers','scholarships','aid','profile','admin','more']) { await p.goto('http://localhost:8123/#/'+r); await p.waitForTimeout(250); await p.screenshot({ path: `${SP}/ui-${name}-${r}.png`, fullPage: true }); const w = await p.evaluate(()=>document.documentElement.scrollWidth); if (w>vp.width) console.log('OVERFLOW',name,r,w); }
    await ctx.close();
  }
  console.log('errors:', errors);
  await b.close(); srv.close();
})();
