(function(){
  const DB = window.__SEED__;
  const me = {id:'11111111-1111-1111-1111-111111111111', email:'kk@x'};
  let listeners=[];
  function q(table){
    let op='select', payload=null, filt=null, single=false;
    const api = {
      select(){ return api; }, order(){ return api; },
      insert(r){ op='insert'; payload=r; return api; },
      update(r){ op='update'; payload=r; return api; },
      upsert(r){ op='upsert'; payload=r; return api; },
      delete(){ op='delete'; return api; },
      eq(k,v){ filt=[k,v]; return api; }, maybeSingle(){ single=true; return api; },
      then(res, rej){
        const rows = DB[table] = DB[table] || [];
        let data;
        if(op==='select'){ data = JSON.parse(JSON.stringify(filt ? rows.filter(r=>r[filt[0]]===filt[1]) : rows)); if(single) data = data[0]||null; }
        if(op==='insert'){ const r=Object.assign({id:crypto.randomUUID(), updated_at:new Date().toISOString(), updated_by:me.id}, payload); rows.push(r); data=[r]; }
        if(op==='update'){ data=[]; rows.forEach(r=>{ if(r[filt[0]]===filt[1]){ Object.assign(r,payload,{updated_at:new Date().toISOString(),updated_by:me.id}); data.push(JSON.parse(JSON.stringify(r))); }}); }
        if(op==='delete'){ DB[table]=rows.filter(r=>r[filt[0]]!==filt[1]); data=[]; }
        if(op==='upsert'){ payload.forEach(p=>{const i=rows.findIndex(r=>r.id===p.id); if(i>=0) rows[i]=p; else rows.push(p);}); data=payload; }
        return Promise.resolve({data, error:null}).then(res, rej);
      }
    };
    return api;
  }
  window.supabase = { createClient(){ return {
    from: q,
    rpc(name){ const r=(DB.calendar_feed||[])[0]; if(r){ r.token=crypto.randomUUID().replace(/-/g,'')+crypto.randomUUID().replace(/-/g,''); } return Promise.resolve({data:r&&r.token, error:null}); },
    auth: {
      onAuthStateChange(cb){ listeners.push(cb); setTimeout(()=>cb('INITIAL_SESSION', window.__LOGGED_IN__ ? {user:me} : null),0); return {data:{subscription:{unsubscribe(){}}}}; },
      async signInWithPassword(){ listeners.forEach(cb=>cb('SIGNED_IN',{user:me})); return {error:null}; },
      async signOut(){ listeners.forEach(cb=>cb('SIGNED_OUT',null)); return {error:null}; },
      async resetPasswordForEmail(){ return {error:null}; }, async updateUser(){ return {error:null}; }
    },
    channel(){ const c={on(){return c;}, subscribe(cb){ setTimeout(()=>cb('SUBSCRIBED'),0); return c;}}; return c; },
    removeChannel(){}
  };}};
})();
