/* Visible companion pairing, without opening Settings. */
function initCompanionPairing() {
  const style=document.createElement('style');
  style.textContent='#companion-pairing{position:relative;z-index:31;padding:12px 18px;background:var(--bg-2);border-bottom:1px solid var(--yellow);color:var(--tx-1);flex-shrink:0}#companion-pairing[hidden]{display:none}#companion-pairing p{font-size:12px;margin:5px 0 10px;color:var(--tx-2)}#companion-pairing form{display:flex;align-items:center;gap:8px;flex-wrap:wrap}#companion-pairing label{font-size:12px}#companion-pairing input{flex:1;min-width:180px;max-width:440px;padding:8px;background:var(--bg-1);color:var(--tx-1);border:1px solid var(--border);border-radius:5px}#companion-pairing button{padding:8px 12px;border:1px solid var(--border);border-radius:5px;background:var(--bg-1);color:var(--tx-1);cursor:pointer}#companion-pair-submit{background:var(--accent)!important;color:#000!important}@media(max-width:1100px){.right-panel:not(.collapsed){top:var(--companion-content-top,44px)}}';
  document.head.appendChild(style);
  const banner=document.createElement('section');
  banner.id='companion-pairing'; banner.hidden=true;
  banner.setAttribute('aria-labelledby','companion-pair-title');
  banner.innerHTML='<strong id="companion-pair-title"></strong><p id="companion-pair-message" role="status" aria-live="polite"></p><form><label for="companion-pair-token">Companion session token</label><input id="companion-pair-token" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the token printed by the companion"><button id="companion-pair-submit" type="submit">Connect companion</button><button type="button" id="companion-pair-settings">Connection settings</button></form>';
  const header=document.querySelector('header');
  if(header) header.insertAdjacentElement('afterend',banner); else document.body.prepend(banner);
  banner._resizeObserver=new ResizeObserver(()=>{
    const top=(header?.getBoundingClientRect().bottom||0)+(banner.hidden?0:banner.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--companion-content-top',top+'px');
  });
  banner._resizeObserver.observe(banner); if(header) banner._resizeObserver.observe(header);
  banner.querySelector('form').addEventListener('submit',event=>{event.preventDefault();pairCompanionFromBanner();});
  document.getElementById('companion-pair-settings').addEventListener('click',()=>openSettings());
  updateCompanionPairing(state.compToken?'checking':'missing');
}
function updateCompanionPairing(status, detail='') {
  const banner=document.getElementById('companion-pairing'); if(!banner) return;
  if(status==='connected') {
    banner.hidden=true; document.getElementById('companion-pair-token').value=''; return;
  }
  if(status==='checking' && state.compToken) return;
  banner.hidden=false;
  let title='Companion session token not set';
  let message='Start the companion server, then paste the Companion session token printed in its terminal. Shell, Git, and browser tools need this connection.';
  if(status==='unauthorized') {
    title=state.compToken?'Companion session token rejected':'Companion session token required';
    message=state.compToken?'The companion rejected the saved token. If you restarted the server, paste its new session token below.':'The companion is running but needs its session token. Paste the token printed in the companion terminal below.';
  } else if(status==='offline') {
    title='Companion server not reachable';
    message='Start the companion server and check its address: '+state.compUrl+'.'+(!state.compToken?' Then paste its session token below.':'');
  } else if(status==='error') {
    title='Companion connection needs attention'; message=detail || 'Check the companion connection settings.';
  }
  document.getElementById('companion-pair-title').textContent=title;
  document.getElementById('companion-pair-message').textContent=message;
}
async function pairCompanionFromBanner() {
  const input=document.getElementById('companion-pair-token'), button=document.getElementById('companion-pair-submit');
  const token=input.value.trim();
  if(!token) { updateCompanionPairing('missing'); input.focus(); return; }
  if(button.disabled) return;
  button.disabled=true; button.textContent='Connecting…';
  try {
    state.compToken=token;
    sessionStorage.setItem('SlopLobster_compToken:'+state.compUrl,token);
    const settings=document.getElementById('s-comp-token'); if(settings) settings.value=token;
    const connected=await checkCompanion();
    if(connected) showToast('Companion connected','ok');
  } catch(error) { updateCompanionPairing('error',error.message); }
  finally { button.disabled=false; button.textContent='Connect companion'; }
}
