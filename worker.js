

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

  // --- MIGRATIONS & SYNC TEST ---
  if (path === '/api/migrate' && method === 'GET') {
    const results = [];
    const statements = [
      "ALTER TABLE users ADD COLUMN user_number INTEGER",
      "ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'Approved'",
      "ALTER TABLE users ADD COLUMN last_seen DATETIME",
      "ALTER TABLE progress ADD COLUMN type TEXT DEFAULT 'answer'",
      "CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, reporter_id INTEGER, reason TEXT, resolved INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
    ];
    for (const s of statements) {
      try { await env.DB.prepare(s).run(); results.push('added: ' + s); }
      catch (e) { results.push('already there: ' + s); }
    }
    return json({ results });
  }
  if (path === '/api/sync-test' && method === 'GET') {
    if (!env.AMS_WEBHOOK_URL) return json({ var: 'MISSING - add AMS_WEBHOOK_URL under [vars] in wrangler.toml' });
    const gRes = await fetch(env.AMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        email: 'synctest@iys.test', name: 'Sync Test', user_number: '000', lesson: 'L1',
        progress: [{ item_id: 'sync-test', header_name: 'M1', format: 'module', completed: 1, note: '' }]
      })
    });
    const t = await gRes.text();
    return json({ var: 'set', status: gRes.status, google: t });
  }

  // --- AUTH ---
  if (path === '/api/signup' && method === 'POST') {
    const { name, email, password } = await request.json();
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !password || String(password).length < 8)
      return json({ error: 'Email and password (8+ chars) required.' }, 400);
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(cleanEmail).first();
    if (existing) return json({ error: 'That email is already registered. Please log in instead, or ask DrWarren or his team to reset your password.' }, 409);
    const hash = await hashPassword(password);
    const maxUser = await env.DB.prepare('SELECT MAX(user_number) as max_num FROM users').first();
    const nextUserNumber = Math.max(102, (maxUser?.max_num || 0) + 1);
    try {
      await env.DB.prepare("INSERT INTO users (email, password, name, user_number, status, created_at) VALUES (?, ?, ?, ?, 'Pending', datetime('now'))").bind(cleanEmail, hash, String(name || '').trim(), nextUserNumber).run();
    } catch (e) { return json({ error: 'Sign-up failed: ' + e.message }, 500); }
    const user = await env.DB.prepare('SELECT id, name, user_number FROM users WHERE email = ?').bind(cleanEmail).first();
    const token = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, user.id).run();
    return json({ token, name: user.name, user_number: user.user_number, is_admin: 0, status: 'Pending' });
  }
  if (path === '/api/login' && method === 'POST') {
    try {
      const { email, password } = await request.json();
      const clean = String(email || '').trim().toLowerCase();
      const user = await env.DB.prepare('SELECT id, password, name, user_number, is_admin, status FROM users WHERE email = ?').bind(clean).first();
      if (!user) return json({ error: 'No account found for this email. Please create an account first, or check the spelling. Quote this message to DrWarren or his team.' }, 404);
      if (user.password !== await hashPassword(password || '')) return json({ error: 'Incorrect password for this account. If you cannot remember it, DrWarren or his team can reset it. Quote this message to DrWarren or his team.' }, 401);
      if (user.status === 'Banned') return json({ error: 'This account has been Banned. Talk to DrWarren or his team.' }, 403);
      const token = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, user.id).run();
      return json({ token, name: user.name, user_number: user.user_number, is_admin: user.is_admin, status: user.status });
    } catch (e) { return json({ error: 'Our system hit a technical error during sign-in. Screenshot this message and send it to DrWarren or his team.' }, 500); }
  }
  if (path === '/api/change-password' && method === 'POST') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in again.' }, 401);
    const { currentPassword, newPassword } = await request.json();
    const user = await env.DB.prepare('SELECT password FROM users WHERE id = ?').bind(userId).first();
    if (!user || user.password !== await hashPassword(currentPassword || '')) return json({ error: 'Current password is incorrect.' }, 400);
    if (!newPassword || String(newPassword).length < 8) return json({ error: 'New password must be 8+ characters.' }, 400);
    await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?').bind(await hashPassword(newPassword), userId).run();
    return json({ success: true });
  }
  if (path === '/api/me' && method === 'GET') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const user = await env.DB.prepare('SELECT name, is_admin, user_number, status FROM users WHERE id = ?').bind(userId).first();
    return json(user);
  }
  if (path === '/api/heartbeat' && method === 'GET') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    try { await env.DB.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").bind(userId).run(); } catch (e) {}
    return json({ ok: true });
  }

  // --- PROGRESS ---
  if (path === '/api/progress') {
    const g = await gateUser(request, env);
    if (!g.id) return json({ error: 'Please log in again.' }, 401);
    if (g.status !== 'Approved') return json({ error: gateError(g.status) }, 403);
    if (method === 'GET') {
         const res = await env.DB.prepare(`SELECT u.id, u.name, u.email, u.user_number as member_number, u.is_admin, u.status, u.created_at, u.last_seen,
      return json(res.results);
    }
    if (method === 'POST') {
      const { progress, lesson } = await request.json();
      for (const item of (progress || [])) {
        await env.DB.prepare("INSERT OR REPLACE INTO progress (user_id, item_id, completed, note, type, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
          .bind(g.id, item.item_id, item.completed ? 1 : 0, item.note || '', item.type || 'answer').run();
      }
      if (env.AMS_WEBHOOK_URL) {
        const user = await env.DB.prepare('SELECT email, name, user_number FROM users WHERE id = ?').bind(g.id).first();
        ctx.waitUntil(syncSheet(env.AMS_WEBHOOK_URL, user.email, user.name, user.user_number, lesson, progress || []));
      }
      return json({ success: true });
    }
  }

  // --- COMMUNITY ---
  if (path === '/api/posts' && method === 'GET') {
    const g = await gateUser(request, env);
    if (!g.id) return json({ error: 'Please log in.' }, 401);
    if (g.status !== 'Approved') return json({ error: gateError(g.status) }, 403);
    const posts = await env.DB.prepare(`SELECT p.*, u.name as user_name, u.id as user_id, (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count, (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?) as user_liked FROM posts p JOIN users u ON p.user_id = u.id WHERE p.parent_id IS NULL AND u.status <> 'Banned' ORDER BY p.pinned DESC, p.created_at DESC LIMIT 50`).bind(g.id).all();
    for (let post of posts.results) {
      post.replies = await env.DB.prepare(`SELECT p.*, u.name as user_name, u.id as user_id, (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count, (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?) as user_liked FROM posts p JOIN users u ON p.user_id = u.id WHERE p.parent_id = ? AND u.status <> 'Banned' ORDER BY p.created_at ASC`).bind(g.id, post.id).all();
    }
    return json(posts.results);
  }
  if (path === '/api/posts' && method === 'POST') {
    const g = await gateUser(request, env);
    if (!g.id) return json({ error: 'Please log in.' }, 401);
    if (g.status !== 'Approved') return json({ error: gateError(g.status) }, 403);
    const { content, parent_id } = await request.json();
    if (!content) return json({ error: 'Post cannot be empty.' }, 400);
    const res = await env.DB.prepare('INSERT INTO posts (user_id, content, parent_id) VALUES (?, ?, ?)').bind(g.id, content, parent_id || null).run();
    return json({ id: res.meta.last_row_id });
  }
  if (path === '/api/posts/delete' && method === 'POST') {
    const adminId = await requireAdmin(request, env);
    if (!adminId) return json({ error: 'Admin only.' }, 403);
    const { post_id } = await request.json();
    await env.DB.prepare('DELETE FROM posts WHERE id = ? OR parent_id = ?').bind(post_id, post_id).run();
    return json({ success: true });
  }
  if (path === '/api/posts/pin' && method === 'POST') {
    const adminId = await requireAdmin(request, env);
    if (!adminId) return json({ error: 'Admin only.' }, 403);
    const { post_id } = await request.json();
    await env.DB.prepare('UPDATE posts SET pinned = NOT pinned WHERE id = ?').bind(post_id).run();
    return json({ success: true });
  }
  if (path === '/api/reports' && method === 'POST') {
    const g = await gateUser(request, env);
    if (!g.id) return json({ error: 'Please log in.' }, 401);
    if (g.status !== 'Approved') return json({ error: gateError(g.status) }, 403);
    const { post_id, reason } = await request.json();
    await env.DB.prepare('INSERT INTO reports (post_id, reporter_id, reason) VALUES (?, ?, ?)').bind(post_id, g.id, reason || '').run();
    return json({ success: true });
  }
  if (path === '/api/likes' && method === 'POST') {
    const g = await gateUser(request, env);
    if (!g.id) return json({ error: 'Please log in.' }, 401);
    if (g.status !== 'Approved') return json({ error: gateError(g.status) }, 403);
    const { post_id } = await request.json();
    try {
      await env.DB.prepare('INSERT INTO likes (post_id, user_id) VALUES (?, ?)').bind(post_id, g.id).run();
      return json({ liked: true });
    } catch (e) {
      await env.DB.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').bind(post_id, g.id).run();
      return json({ liked: false });
    }
  }

  // --- ADMIN DASHBOARD ---
  if (path === '/api/admin/stats' && method === 'GET') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const users = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
    const posts = await env.DB.prepare('SELECT COUNT(*) as c FROM posts WHERE parent_id IS NULL').first();
    const reports = await env.DB.prepare('SELECT COUNT(*) as c FROM reports WHERE resolved = 0').first();
    const active = await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE last_seen >= datetime('now', '-5 minutes')").first();
    return json({ users: users?.c || 0, posts: posts?.c || 0, reports: reports?.c || 0, active: active?.c || 0 });
  }
  if (path === '/api/admin/analytics' && method === 'GET') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const totalUsers = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
    const activeLearners = await env.DB.prepare('SELECT COUNT(DISTINCT user_id) as c FROM progress').first();
    const totalPosts = await env.DB.prepare('SELECT COUNT(*) as c FROM posts WHERE parent_id IS NULL').first();
    const totalReports = await env.DB.prepare('SELECT COUNT(*) as c FROM reports').first();
    const totalCount = totalUsers?.c || 0;
    const activeCount = activeLearners?.c || 0;
    const postsCount = totalPosts?.c || 0;
    const reportsCount = totalReports?.c || 0;
       const lessonFinishers = await env.DB.prepare("SELECT COUNT(DISTINCT user_id) as c FROM progress WHERE type = 'lesson_completion' AND completed = 1").first();
    const eliteRate = totalCount > 0 ? Math.round((lessonFinishers?.c || 0) / totalCount * 100) : 0;
    const engagement = totalCount > 0 ? (postsCount / totalCount).toFixed(1) : 0;
    const healthRatio = postsCount > 0 ? (reportsCount / postsCount).toFixed(2) : 0;
    return json({ totalUsers: totalCount, activeLearners: activeCount, eliteRate, engagement, healthRatio });
  }
  if (path === '/api/admin/users' && method === 'GET') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const res = await env.DB.prepare(`SELECT u.id, u.name, u.email, u.user_number as member_number, u.is_admin, u.status, u.created_at,
      (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) as post_count,
      (SELECT COUNT(*) FROM progress pr WHERE pr.user_id = u.id AND pr.type = 'module_completion' AND pr.completed = 1) as modules_done,
      (SELECT COUNT(*) FROM progress pr WHERE pr.user_id = u.id AND pr.type = 'lesson_completion' AND pr.completed = 1) as lessons_done
      FROM users u ORDER BY u.user_number ASC`).all();
    return json(res.results);
  }
  if (path === '/api/admin/status' && method === 'POST') {
    const adminId = await requireAdmin(request, env);
    if (!adminId) return json({ error: 'Forbidden' }, 403);
    const { user_id, status } = await request.json();
    if (!['Pending', 'Approved', 'Banned'].includes(status)) return json({ error: 'Unknown status.' }, 400);
    if (Number(user_id) === Number(adminId)) return json({ error: 'You cannot change your own status.' }, 400);
    await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, user_id).run();
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
  if (path === '/api/admin/reset-password' && method === 'POST') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const { user_id, new_password } = await request.json();
    if (!new_password || String(new_password).length < 8) return json({ error: 'Password must be 8+ characters.' }, 400);
    const hash = await hashPassword(new_password);
    await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?').bind(hash, user_id).run();
    return json({ success: true });
  }
  if (path === '/api/admin/reports' && method === 'GET') {
    if (!await requireAdmin(request, env)) return json({ error: 'Forbidden' }, 403);
    const res = await env.DB.prepare(`SELECT r.id, r.reason, r.created_at, r.resolved, p.content as post_content, p.id as post_id, p.user_id, u.name as reporter_name, au.name as reported_user_name FROM reports r LEFT JOIN posts p ON r.post_id = p.id LEFT JOIN users u ON r.reporter_id = u.id LEFT JOIN users au ON p.user_id = au.id ORDER BY r.resolved ASC, r.created_at DESC LIMIT 50`).all();
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

  return json({ error: 'Not found.' }, 404);
}

async function gateUser(request, env) {
  const userId = await auth(request, env);
  if (!userId) return { id: null, status: null };
  const u = await env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(userId).first();
  return { id: userId, status: u ? u.status : 'Approved' };
}
function gateError(status) {
  return status === 'Banned' ? 'This account has been Banned. Talk to DrWarren or his team.' : 'Your access is Pending admin approval. Talk to DrWarren or his team.';
}
async function requireAdmin(request, env) {
  const g = await gateUser(request, env);
  if (!g.id || g.status !== 'Approved') return null;
  const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id = ?').bind(g.id).first();
  if (!user || !user.is_admin) return null;
  return g.id;
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
async function syncSheet(webhookUrl, email, name, user_number, lesson, progress) {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ email, name, user_number, lesson, progress })
    });
  } catch (e) {}
}
