

// --- CONFIG ---
const CMS_SHEET_ID = '1qKokdpkUosrOl_2iJM_lYLmynpXigyvlgdN-ajPmGcs';
// PASTE YOUR /exec LINK HERE ONCE YOU HAVE IT
const AMS_WEBHOOK_URL = 'PASTE_YOUR_EXEC_LINK_HERE'; 

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(request, env, ctx, url); }
      catch (e) { return json({ error: e.message }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  // --- FETCH LESSON CONTENT FROM GOOGLE SHEET ---
  if (path === '/api/lesson' && method === 'GET') {
    const lessonId = url.searchParams.get('id');
    if (!lessonId) return json({ error: 'Missing Lesson ID' }, 400);
    
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${CMS_SHEET_ID}/export?format=csv&sheet=${lessonId}`;
    try {
      const res = await fetch(sheetUrl);
      if (!res.ok) return json({ error: 'Lesson not found in sheet' }, 404);
      const csv = await res.text();
      const rows = await parseCSV(csv);
      return json(rows.slice(1)); // Return rows without header
    } catch (e) {
      return json({ error: 'Failed to fetch lesson' }, 500);
    }
  }

  // --- PASSWORD CHANGE ---
  if (path === '/api/change-password' && method === 'POST') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const { currentPassword, newPassword } = await request.json();
    if (!newPassword || String(newPassword).length < 8) return json({ error: 'New password must be at least 8 characters.' }, 400);
    const user = await env.DB.prepare('SELECT password FROM users WHERE id = ?').bind(userId).first();
    if (!user || user.password !== await hashPassword(currentPassword || '')) return json({ error: 'Current password is incorrect.' }, 401);
    const newHash = await hashPassword(newPassword);
    await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?').bind(newHash, userId).run();
    return json({ success: true });
  }

  // --- ADMIN PASSWORD RESET ---
  if (path === '/api/admin/reset-password' && method === 'POST') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const { user_id, new_password } = await request.json();
    if (!new_password || String(new_password).length < 8) return json({ error: 'New password must be at least 8 characters.' }, 400);
    const newHash = await hashPassword(new_password);
    await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?').bind(newHash, user_id).run();
    return json({ success: true });
  }

  // --- AUTH ---
  if (path === '/api/signup' && method === 'POST') {
    const { name, email, password } = await request.json();
    if (!email || !password || String(password).length < 8) return json({ error: 'Email and a password of 8+ characters required.' }, 400);
    const hash = await hashPassword(password);
    const maxMember = await env.DB.prepare('SELECT MAX(member_number) as max_num FROM users').first();
    const nextMemberNumber = Math.max(103, (maxMember.max_num || 0) + 1);
    try {
      await env.DB.prepare("INSERT INTO users (email, password, name, is_admin, member_number, created_at) VALUES (?, ?, ?, 0, ?, datetime('now'))").bind(email.toLowerCase(), hash, name, nextMemberNumber).run();
    } catch (e) { return json({ error: 'That email is already registered.' }, 409); }
    const user = await env.DB.prepare('SELECT id, name, is_admin, member_number FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    const token = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, user.id).run();
    return json({ token, name: user.name, is_admin: user.is_admin, member_number: user.member_number });
  }

  if (path === '/api/login' && method === 'POST') {
    const { email, password } = await request.json();
    const user = await env.DB.prepare('SELECT id, password, name, is_admin, member_number, banned FROM users WHERE email = ?').bind((email || '').toLowerCase()).first();
    if (!user || user.password !== await hashPassword(password || '')) return json({ error: 'Invalid email or password.' }, 401);
    if (user.banned) return json({ error: 'This account has been banned.' }, 403);
    const token = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, user.id).run();
    return json({ token, name: user.name, is_admin: user.is_admin, member_number: user.member_number });
  }

  // --- PROGRESS ---
  if (path === '/api/progress') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in again.' }, 401);
    if (method === 'GET') {
      const res = await env.DB.prepare('SELECT item_id, completed, note, type FROM progress WHERE user_id = ?').bind(userId).all();
      return json(res.results);
    }
    if (method === 'POST') {
      const body = await request.json();
      const progress = body.progress || [];
      const lessonId = body.lesson; // Capture the lesson ID
      
      for (const item of progress) {
        await env.DB.prepare("INSERT OR REPLACE INTO progress (user_id, item_id, completed, note, type, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").bind(userId, item.item_id, item.completed ? 1 : 0, item.note || '', item.type || 'answer').run();
      }
      
      // Sync to AMS (Google Sheet)
      if (AMS_WEBHOOK_URL && AMS_WEBHOOK_URL !== 'PASTE_YOUR_EXEC_LINK_HERE' && lessonId) {
        const user = await env.DB.prepare('SELECT email, name, member_number FROM users WHERE id = ?').bind(userId).first();
        ctx.waitUntil(fetch(AMS_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            lesson: lessonId,
            email: user.email,
            name: user.name,
            member_number: user.member_number,
            progress: progress
          })
        }).catch(e => console.error('AMS Sync failed', e)));
      }
      
      return json({ success: true });
    }
  }

  // --- ADMIN ---
  if (path === '/api/admin/pending' && method === 'GET') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const res = await env.DB.prepare(`SELECT u.id, u.name, u.email, u.member_number, u.created_at FROM users u LEFT JOIN offer_access oa ON u.id = oa.user_id WHERE oa.user_id IS NULL AND u.is_admin = 0 AND u.banned = 0 ORDER BY u.created_at ASC`).all();
    return json(res.results);
  }
  if (path === '/api/admin/approve' && method === 'POST') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const { user_id } = await request.json();
    await env.DB.prepare('INSERT OR IGNORE INTO offer_access (user_id, offer) VALUES (?, ?)').bind(user_id, 'IYS Course').run();
    return json({ success: true });
  }
  if (path === '/api/admin/notifications' && method === 'GET') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const reports = await env.DB.prepare('SELECT COUNT(*) as c FROM reports WHERE resolved = 0').first();
    return json({ reports: reports.c });
  }
  if (path === '/api/my-offers' && method === 'GET') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const res = await env.DB.prepare('SELECT offer FROM offer_access WHERE user_id = ?').bind(userId).all();
    return json(res.results.map(r => r.offer));
  }
  if (path === '/api/admin/access' && method === 'GET') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const res = await env.DB.prepare('SELECT user_id, offer FROM offer_access').all();
    return json(res.results);
  }
  if (path === '/api/admin/access' && method === 'POST') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const { user_id, offer, granted } = await request.json();
    if (granted) await env.DB.prepare('INSERT OR IGNORE INTO offer_access (user_id, offer) VALUES (?, ?)').bind(user_id, offer).run();
    else await env.DB.prepare('DELETE FROM offer_access WHERE user_id = ? AND offer = ?').bind(user_id, offer).run();
    return json({ success: true });
  }
  if (path === '/api/admin/set-admin' && method === 'POST') {
    const adminId = await requireAdmin(request, env);
    if (!adminId) return json({ error: 'Forbidden' }, 403);
    const { user_id, is_admin } = await request.json();
    if (Number(user_id) === Number(adminId) && !is_admin) return json({ error: 'You cannot remove your own admin status.' }, 400);
    await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ?').bind(is_admin ? 1 : 0, user_id).run();
    return json({ success: true });
  }  
  if (path === '/api/admin/stats' && method === 'GET') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const users = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
    const posts = await env.DB.prepare('SELECT COUNT(*) as c FROM posts WHERE parent_id IS NULL').first();
    const reports = await env.DB.prepare('SELECT COUNT(*) as c FROM reports').first();
    const mod1 = await env.DB.prepare("SELECT COUNT(DISTINCT user_id) as c FROM progress WHERE item_id LIKE 'l01-%' AND completed = 1").first();
    return json({ users: users.c, posts: posts.c, reports: reports.c, mod1: mod1.c });
  }
  if (path === '/api/admin/reports' && method === 'GET') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const res = await env.DB.prepare(`SELECT r.id, r.reason, r.created_at, r.resolved, p.content as post_content, p.id as post_id, p.user_id, u.name as reporter_name, au.name as reported_user_name, au.is_admin as reported_user_is_admin FROM reports r LEFT JOIN posts p ON r.post_id = p.id LEFT JOIN users u ON r.reporter_id = u.id LEFT JOIN users au ON p.user_id = au.id ORDER BY r.resolved ASC, r.created_at DESC LIMIT 50`).all();
    return json(res.results);
  }
  if (path === '/api/admin/reports/resolve' && method === 'POST') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const { report_id, resolved } = await request.json();
    await env.DB.prepare('UPDATE reports SET resolved = ? WHERE id = ?').bind(resolved ? 1 : 0, report_id).run();
    return json({ success: true });
  }
  if (path === '/api/admin/reports/delete' && method === 'POST') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const { report_id } = await request.json();
    await env.DB.prepare('DELETE FROM reports WHERE id = ?').bind(report_id).run();
    return json({ success: true });
  }
  if (path === '/api/admin/users' && method === 'GET') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const res = await env.DB.prepare('SELECT id, name, email, member_number, is_admin, banned, created_at FROM users ORDER BY member_number ASC').all();
    return json(res.results);
  }
  if (path === '/api/admin/analytics' && method === 'GET') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const totalUsers = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
    const activeLearners = await env.DB.prepare('SELECT COUNT(DISTINCT user_id) as c FROM progress').first();
    const elite = await env.DB.prepare("SELECT COUNT(DISTINCT user_id) as c FROM progress WHERE completed = 1").first();
    const eliteRate = totalUsers.c > 0 ? Math.round((elite.c / totalUsers.c) * 100) : 0;
    const totalPosts = await env.DB.prepare('SELECT COUNT(*) as c FROM posts WHERE parent_id IS NULL').first();
    const engagement = totalUsers.c > 0 ? (totalPosts.c / totalUsers.c).toFixed(1) : 0;
    const totalReports = await env.DB.prepare('SELECT COUNT(*) as c FROM reports').first();
    const healthRatio = totalPosts.c > 0 ? (totalReports.c / totalPosts.c).toFixed(2) : 0;
    return json({ totalUsers: totalUsers.c, activeLearners: activeLearners.c, eliteRate: eliteRate, engagement: engagement, healthRatio: healthRatio });
  }

  return json({ error: 'Not found.' }, 404);
}

async function requireAdmin(request, env) {
  const userId = await auth(request, env);
  if (!userId) return null;
  const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id = ?').bind(userId).first();
  if (!user || !user.is_admin) return null;
  return userId;
}

async function auth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const s = await env.DB.prepare('SELECT user_id FROM sessions WHERE token = ?').bind(token).first();
  return s ? s.user_id : null;
}

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function parseCSV(text) {
  const rows = []; let currentRow = []; let currentCell = ''; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) { currentRow.push(currentCell); currentCell = ''; }
    else if ((char === '\n' || char === '\r') && !inQuotes) { if (currentCell !== '' || currentRow.length > 0) { currentRow.push(currentCell); rows.push(currentRow); } currentRow = []; currentCell = ''; if (char === '\r' && text[i+1] === '\n') i++; }
    else currentCell += char;
  }
  if (currentCell !== '' || currentRow.length > 0) { currentRow.push(currentCell); rows.push(currentRow); }
  return rows;
}
