

<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IYS — Admin</title>
<style>
  :root{--navy:#00459A;--magenta:#D600D6;--bg:#f0f2f5;--card:#fff;--muted:#5b6b7f;--red:#c62828;}
  *{box-sizing:border-box;margin:0;padding:0;font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif;}
  body{background:var(--bg);color:var(--navy);padding:24px;}
  header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid var(--magenta);padding-bottom:14px;margin-bottom:22px;}
  header h1{font-size:1.5rem;} header h1 span{color:var(--magenta);}
  .pill{background:#fff;color:var(--navy);border:2px solid var(--navy);border-radius:999px;padding:8px 18px;font-weight:700;text-decoration:none;}
  h2{margin:26px 0 10px;font-size:1.15rem;}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:12px 0 8px;}
  .card{background:var(--card);border-radius:10px;padding:16px;box-shadow:0 2px 6px rgba(0,20,60,.08);}
  .card b{font-size:1.6rem;display:block;margin-bottom:4px;} .card span{color:var(--muted);font-size:.85rem;}
  .row{background:var(--card);border-radius:10px;padding:12px 14px;margin-bottom:10px;box-shadow:0 2px 6px rgba(0,20,60,.08);display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;}
  .muted{color:var(--muted);font-size:.9rem;}
  button{cursor:pointer;border:none;border-radius:8px;padding:8px 14px;font-weight:700;font-size:.85rem;}
  .btn-magenta{background:var(--magenta);color:#fff;} .btn-navy{background:var(--navy);color:#fff;}
  .btn-ghost{background:#fff;color:var(--navy);border:2px solid var(--navy);} .btn-red{background:var(--red);color:#fff;}
  .badge{background:var(--navy);color:#fff;border-radius:6px;padding:2px 8px;font-size:.7rem;font-weight:700;margin-left:6px;}
  .badge.m{background:var(--magenta);} .badge.r{background:var(--red);}
  label.chk{display:flex;gap:6px;align-items:center;font-size:.82rem;color:var(--muted);font-weight:600;}
  #login{max-width:360px;margin:10vh auto;background:#fff;padding:26px;border-radius:12px;box-shadow:0 4px 14px rgba(0,20,60,.12);}
  #login h1{margin-bottom:14px;} #login h1 span{color:var(--magenta);}
  input{width:100%;padding:10px;margin:6px 0 12px;border:2px solid #dfe6ee;border-radius:8px;font-size:.95rem;}
  .hidden{display:none;} .post-ex{background:#f5f7fa;border-radius:8px;padding:8px 10px;margin:6px 0;font-size:.85rem;color:var(--muted);max-width:520px;}
</style>
</head>
<body>

<div id="login" class="hidden">
  <h1>IYS <span>Admin</span></h1>
  <input id="li-email" type="email" placeholder="Email">
  <input id="li-pass" type="password" placeholder="Password">
  <button class="btn-navy" onclick="doLogin()">Log in</button>
  <p id="li-err" class="muted" style="margin-top:10px;"></p>
</div>

<div id="dash" class="hidden">
  <header>
    <h1>IYS <span>Admin</span></h1>
    <a class="pill" href="/">&#8592; Back to site</a>
  </header>
  <h2 style="margin-top:0;font-size:1.6rem;">Admin Dashboard</h2>
  <div class="cards" id="stats"></div>
  <h2>Pending Approvals</h2><div id="pending"></div>
  <h2>Analytics</h2><div class="cards" id="analytics"></div>
  <h2>Classmates (Admin + Offer Access)</h2><div id="members"></div>
  <h2>Reports</h2><div id="reports"></div>
</div>

<script>
const KEYS=['iys_token','token','pc_token','pitchcamp_token'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let TOKEN='';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,opts={}){
  return fetch(path,{method:opts.method||'GET',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:opts.body?JSON.stringify(opts.body):undefined});
}
async function probe(t){try{const r=await fetch('/api/me',{headers:{'Authorization':'Bearer '+t}});return r.ok;}catch(e){return false;}}
async function findToken(){
  for(const k of KEYS){const v=localStorage.getItem(k);if(v&&UUID.test(v)&&await probe(v))return v;}
  for(let i=0;i<localStorage.length;i++){const v=localStorage.getItem(localStorage.key(i));if(v&&UUID.test(v)&&await probe(v))return v;}
  return '';
}
function showLogin(msg){$('login').classList.remove('hidden');$('dash').classList.add('hidden');$('li-err').textContent=msg||'';}
async function boot(){
  TOKEN=await findToken();
  if(!TOKEN){showLogin('');return;}
  const me=await api('/api/me');
  if(me.status===404||me.status===405){showLogin('Admin check failed: the deployed worker.js is missing /api/me. Save the updated worker.js and run wrangler deploy.');return;}
  if(!me.ok){TOKEN='';showLogin('Your session expired — log in below.');return;}
  const meJ=await me.json();
  if(!meJ.is_admin){showLogin('This account does not have admin access.');return;}
  $('login').classList.add('hidden');$('dash').classList.remove('hidden');loadAll();
}
async function doLogin(){
  const r=await api('/api/login',{method:'POST',body:{email:$('li-email').value,password:$('li-pass').value}});
  const j=await r.json();
  if(!r.ok){showLogin(j.error||'Login failed.');return;}
  TOKEN=j.token;KEYS.forEach(k=>localStorage.setItem(k,j.token));boot();
}
async function act(path,body){const r=await api(path,{method:'POST',body});if(!r.ok){const j=await r.json();alert(j.error||'Action failed.');}loadAll();}
async function loadAll(){
  const [stats,pending,analytics,users,access,reports]=await Promise.all([
    api('/api/admin/stats').then(r=>r.json()),api('/api/admin/pending').then(r=>r.json()),
    api('/api/admin/analytics').then(r=>r.json()),api('/api/admin/users').then(r=>r.json()),
    api('/api/admin/access').then(r=>r.json()),api('/api/admin/reports').then(r=>r.json())]);
  $('stats').innerHTML=
    `<div class="card"><b>${stats.users||0}</b><span>Members</span></div>
     <div class="card"><b>${stats.posts||0}</b><span>Posts</span></div>
     <div class="card"><b>${stats.reports||0}</b><span>Reports</span></div>
     <div class="card"><b>${stats.mod1||0}</b><span>Module 1 completed</span></div>`;
  $('analytics').innerHTML=
    `<div class="card"><b>${analytics.totalUsers||0}</b><span>Total users</span></div>
     <div class="card"><b>${analytics.activeLearners||0}</b><span>Active learners</span></div>
     <div class="card"><b>${analytics.eliteRate||0}%</b><span>Completion rate</span></div>
     <div class="card"><b>${analytics.engagement||0}</b><span>Engagement</span></div>
     <div class="card"><b>${analytics.healthRatio||0}</b><span>Health ratio</span></div>`;
  $('pending').innerHTML=(pending||[]).length?pending.map(u=>
    `<div class="row"><div><b>#${esc(u.member_number)} ${esc(u.name)}</b> <span class="muted">${esc(u.email)} &middot; joined ${esc((u.created_at||'').slice(0,10))}</span></div>
     <button class="btn-magenta" onclick="act('/api/admin/approve',{user_id:${u.id}})">Approve</button></div>`).join('')
    :'<p class="muted">No pending applications. 🎉</p>';
  const offerMap={};(access||[]).forEach(a=>{(offerMap[a.user_id]=offerMap[a.user_id]||[]).push(a.offer);});
  $('members').innerHTML=(users||[]).map(u=>{
    const offers=offerMap[u.id]||[];
    return `<div class="row"><div><b>#${esc(u.member_number)} ${esc(u.name)}</b>
      ${u.is_admin?'<span class="badge m">ADMIN</span>':''}${u.is_paid?'<span class="badge">PAID</span>':''}${u.banned?'<span class="badge r">BANNED</span>':''}
      <div class="muted">${esc(u.email)}</div></div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
        <label class="chk"><input type="checkbox" ${u.is_admin?'checked':''} onchange="act('/api/admin/set-admin',{user_id:${u.id},is_admin:this.checked?1:0})"> Admin</label>
        <label class="chk"><input type="checkbox" ${offers.includes('IYS Course')?'checked':''} onchange="act('/api/admin/access',{user_id:${u.id},offer:'IYS Course',granted:this.checked})"> IYS Course</label>
        <button class="btn-ghost" onclick="resetPw(${u.id})">Reset PW</button>
        ${u.banned?'':'<button class="btn-red" onclick="banUser('+u.id+')">Ban</button>'}
      </div></div>`;}).join('')||'<p class="muted">No members yet.</p>';
  $('reports').innerHTML=(reports||[]).length?reports.map(r=>
    `<div class="row" style="display:block;"><div class="muted">${esc(r.reporter_name||'?')} reported ${esc(r.reported_user_name||'?')} &middot; ${esc((r.created_at||'').slice(0,10))} ${r.resolved?'<span class="badge">RESOLVED</span>':''}</div>
     <div class="post-ex">${esc(r.post_content||'(post deleted)')}</div>
     <div class="muted" style="margin-bottom:8px;">Reason: ${esc(r.reason||'—')}</div>
     <div style="display:flex;gap:8px;flex-wrap:wrap;">
       <button class="btn-navy" onclick="act('/api/admin/reports/resolve',{report_id:${r.id},resolved:${r.resolved?0:1}})">${r.resolved?'Reopen':'Resolve'}</button>
       ${r.post_id?`<button class="btn-red" onclick="act('/api/posts/delete',{post_id:${r.post_id}})">Delete post</button>`:''}
       <button class="btn-ghost" onclick="act('/api/admin/reports/delete',{report_id:${r.id}})">Delete report</button>
     </div></div>`).join('')
    :'<p class="muted">No reports. 🎉</p>';
}
async function resetPw(id){const pw=prompt('New password for this member (8+ characters):');if(!pw)return;act('/api/admin/reset-password',{user_id:id,new_password:pw});}
async function banUser(id){if(!confirm('Ban this member? They will no longer be able to log in.'))return;act('/api/users/ban',{user_id:id});}
boot();
</script>
</body>
</html>
