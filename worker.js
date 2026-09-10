

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

  if (path === '/api/migrate' && method === 'GET') {
    const results = [];
    const statements = [
      "ALTER TABLE users ADD COLUMN user_number INTEGER",
      "ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0",
      "ALTER TABLE progress ADD COLUMN type TEXT DEFAULT 'answer'",
      "CREATE TABLE IF NOT EXISTS offer_access (user_id INTEGER, offer TEXT, PRIMARY KEY(user_id, offer))"
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

  if (path === '/api/signup' && method === 'POST') {
    const { name, email, password } = await request.json();
    if (!email || !password || String(password).length < 8)
      return json({ error: 'Email and password (8+ chars) required.' }, 400);
    const hash = await hashPassword(password);
    const maxUser = await env.DB.prepare('SELECT MAX(user_number) as max_num FROM users').first();
    const nextUserNumber = Math.max(102, (maxUser.max_num || 0) + 1);
    try {
      await env.DB.prepare("INSERT INTO users (email, password, name, user_number, created_at) VALUES (?, ?, ?, ?, datetime('now'))").bind(email.toLowerCase(), hash, name, nextUserNumber).run();
    } catch (e) { return json({ error: 'That email is already registered.' }, 409); }
    const user = await env.DB.prepare('SELECT id, name, user_number FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    const token = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, user.id).run();
    return json({ token, name: user.name, user_number: user.user_number, is_admin: 0 });
  }

  if (path === '/api/login' && method === 'POST') {
    const { email, password } = await request.json();
    const user = await env.DB.prepare('SELECT id, password, name, user_number, is_admin, banned FROM users WHERE email = ?').bind((email || '').toLowerCase()).first();
    if (!user || user.password !== await hashPassword(password || '')) return json({ error: 'Invalid email or password.' }, 401);
    if (user.banned) return json({ error: 'This account has been banned.' }, 403);
    const token = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, user.id).run();
    return json({ token, name: user.name, user_number: user.user_number, is_admin: user.is_admin });
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

  if (path === '/api/progress') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in again.' }, 401);

    if (method === 'GET') {
      const res = await env.DB.prepare('SELECT item_id, completed, note, type FROM progress WHERE user_id = ?').bind(userId).all();
      return json(res.results);
    }

    if (method === 'POST') {
      const { progress, lesson } = await request.json();
      for (const item of (progress || [])) {
        await env.DB.prepare("INSERT OR REPLACE INTO progress (user_id, item_id, completed, note, type, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
          .bind(userId, item.item_id, item.completed ? 1 : 0, item.note || '', item.type || 'answer').run();
      }
      if (env.AMS_WEBHOOK_URL) {
        const user = await env.DB.prepare('SELECT email, name, user_number FROM users WHERE id = ?').bind(userId).first();
        ctx.waitUntil(syncSheet(env.AMS_WEBHOOK_URL, user.email, user.name, user.user_number, lesson, progress || []));
      }
      return json({ success: true });
    }
  }

  if (path === '/api/my-offers' && method === 'GET') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const res = await env.DB.prepare('SELECT offer FROM offer_access WHERE user_id = ?').bind(userId).all();
    return json(res.results.map(r => r.offer));
  }

  if (path === '/api/posts' && method === 'GET') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const posts = await env.DB.prepare(`
      SELECT p.*, u.name as user_name, u.id as user_id,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?) as user_liked
      FROM posts p JOIN users u ON p.user_id = u.id
      WHERE p.parent_id IS NULL AND u.banned = 0
      ORDER BY p.pinned DESC, p.created_at DESC LIMIT 50
    `).bind(userId).all();
    for (let post of posts.results) {
      post.replies = await env.DB.prepare(`
        SELECT p.*, u.name as user_name, u.id as user_id,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?) as user_liked
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id = ? AND u.banned = 0
        ORDER BY p.created_at ASC
      `).bind(userId, post.id).all();
    }
    return json(posts.results);
  }

  if (path === '/api/posts' && method === 'POST') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const { content, parent_id } = await request.json();
    if (!content) return json({ error: 'Post cannot be empty.' }, 400);
    const res = await env.DB.prepare('INSERT INTO posts (user_id, content, parent_id) VALUES (?, ?, ?)').bind(userId, content, parent_id || null).run();
    return json({ id: res.meta.last_row_id });
  }

  if (path === '/api/posts/delete' && method === 'POST') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id = ?').bind(userId).first();
    if (!user || !user.is_admin) return json({ error: 'Admin only.' }, 403);
    const { post_id } = await request.json();
    await env.DB.prepare('DELETE FROM posts WHERE id = ? OR parent_id = ?').bind(post_id, post_id).run();
    return json({ success: true });
  }

  if (path === '/api/posts/pin' && method === 'POST') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id = ?').bind(userId).first();
    if (!user || !user.is_admin) return json({ error: 'Admin only.' }, 403);
    const { post_id } = await request.json();
    await env.DB.prepare('UPDATE posts SET pinned = NOT pinned WHERE id = ?').bind(post_id).run();
    return json({ success: true });
  }

  if (path === '/api/users/ban' && method === 'POST') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const user = await env.DB.prepare('SELECT is_admin FROM users WHERE id = ?').bind(userId).first();
    if (!user || !user.is_admin) return json({ error: 'Admin only.' }, 403);
    const { user_id } = await request.json();
    await env.DB.prepare('UPDATE users SET banned = 1 WHERE id = ?').bind(user_id).run();
    return json({ success: true });
  }

  if (path === '/api/reports' && method === 'POST') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const { post_id, reason } = await request.json();
    await env.DB.prepare('INSERT INTO reports (post_id, reporter_id, reason) VALUES (?, ?, ?)').bind(post_id, userId, reason || '').run();
    return json({ success: true });
  }

  if (path === '/api/likes' && method === 'POST') {
    const userId = await auth(request, env);
    if (!userId) return json({ error: 'Please log in.' }, 401);
    const { post_id } = await request.json();
    try {
      await env.DB.prepare('INSERT INTO likes (post_id, user_id) VALUES (?, ?)').bind(post_id, userId).run();
      return json({ liked: true });
    } catch (e) {
      await env.DB.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').bind(post_id, userId).run();
      return json({ liked: false });
    }
  }

  return json({ error: 'Not found.' }, 404);
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
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ email, name, user_number, lesson, progress }),
      redirect: 'follow'
    });
    const text = await res.text();
    console.log('AMS sync response:', text);
  } catch (e) { 
    console.error('AMS sync failed:', e); 
  }
}
