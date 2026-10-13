// Count tagged page arrivals independently of immutable first-touch attribution.
(() => {
  const params=new URLSearchParams(window.location.search);
  if (['utm_campaign','utm_source','utm_medium'].some(key=>params.getAll(key).length!==1)) return;
  const campaign=params.get('utm_campaign'), source=params.get('utm_source'), medium=params.get('utm_medium');
  if (!['ugc-instagram-01','ugc-instagram-02'].includes(campaign)) return;
  if (!((source==='instagram' && medium==='social') || (source==='manychat-instagram' && medium==='dm'))) return;
  if (!window.crypto?.randomUUID) return;
  const eventId=window.crypto.randomUUID();
  const send=()=>fetch('/api/ugc-visit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId,campaign,source,medium}),credentials:'omit',keepalive:true}).catch(()=>{});
  // Prerender/prefetch must not count as a viewed arrival.
  if (document.visibilityState==='visible') send();
  else document.addEventListener('visibilitychange',function visible(){if(document.visibilityState==='visible'){document.removeEventListener('visibilitychange',visible);send();}});
})();
