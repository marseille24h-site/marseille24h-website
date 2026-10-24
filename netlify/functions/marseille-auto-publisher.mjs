// Marseille24h scheduled Facebook auto-publisher.
// Publishes ONLY editorially verified, approved, auto_eligible articles.
// Fail closed. No automatic retry after locking: avoids duplicate posts.
const base = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

async function db(path, options={}) {
  const r = await fetch(`${base}/rest/v1/${path}`, {
    ...options, signal: AbortSignal.timeout(12000),
    headers:{apikey:key,'Content-Type':'application/json',...options.headers}
  });
  const text=await r.text();
  if(!r.ok) throw Error(`Supabase ${r.status}: ${text.slice(0,180)}`);
  return text ? JSON.parse(text) : null;
}

export default async function handler() {
  const { FACEBOOK_PAGE_ID:pageId, FACEBOOK_PAGE_ACCESS_TOKEN:token }=process.env;
  if(!base || !key || !pageId || !token) { console.error('Auto Publisher: missing credentials'); return; }
  try {
    // The DB RPC implements the 2-post/day limit atomically in Europe/Paris time.
    // No AI-created draft can satisfy these conditions until editorial verification.
    const rows=await db('articles?status=eq.approved&auto_eligible=eq.true&facebook_post_id=is.null&verified_source_url=not.is.null&select=id,title,summary,content,source_name,source_url,verified_source_url&order=created_at.asc&limit=1');
    if(!rows?.length) { console.log('Auto Publisher: no verified approved articles'); return; }
    const a=rows[0];
    const claimed=await db('rpc/claim_auto_facebook', {
      method:'POST',body:JSON.stringify({p_article_id:a.id})
    });
    if(claimed !== true) { console.log('Auto Publisher: daily limit or article locked'); return; }
    const message=[a.title,a.summary,a.content,`Nguồn: ${a.source_name||'Báo gốc'}`,a.verified_source_url].filter(Boolean).join('\n\n');
    // Reaching this point means the article is locked as publishing.
    // NEVER reset it automatically after an uncertain Facebook result.
    let response;
    try {
      response=await fetch(`https://graph.facebook.com/v26.0/${encodeURIComponent(pageId)}/feed`, {
        method:'POST',signal:AbortSignal.timeout(12000),
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({message,published:'true'})
      });
    } catch(e) { console.error('Auto Publisher: uncertain Facebook result, inspect manually',a.id); return; }
    const result=await response.json().catch(()=>({}));
    if(!response.ok || !result.id){
      console.error('Auto Publisher: Facebook did not confirm',a.id,response.status,result.error?.code||'');
      return;
    }
    // Saving a returned Facebook Post ID must happen before the article is retried.
    const updated=await db(`articles?id=eq.${encodeURIComponent(a.id)}&status=eq.publishing&facebook_post_id=is.null`, {
      method:'PATCH',headers:{Prefer:'return=representation'},
      body:JSON.stringify({status:'published',facebook_post_id:result.id,published_at:new Date().toISOString()})
    });
    if(updated?.length!==1) {
      console.error('Auto Publisher: Facebook posted but database not confirmed',a.id,result.id);
      return;
    }
    console.log('Auto Publisher: published',a.id,result.id);
  } catch(e) { console.error('Auto Publisher:',e.message); }
}
// One scan an hour; the server-side RPC enforces 2 published attempts / Paris day.
export const config={schedule:'40 * * * *'};
