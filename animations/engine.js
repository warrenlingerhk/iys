

/* IYS animation engine — player for scene files in /animations/ */
(function () {
  const A = window.IYS_ANIM = window.IYS_ANIM || { scenes: {} };
  const loading = {};

  const ICONS = {
    mirror: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="9" rx="6" ry="7"/><path d="M12 16v5M8 21h8"/></svg>',
    bubble: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v10H9l-5 4V5z"/><path d="M9 10h6"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 15a4 4 0 1 1 .5-7.9A5 5 0 0 1 17 8a3.5 3.5 0 0 1 0 7H7z"/><path d="M12 12v6m0 0l-2-2m2 2l2-2"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/></svg>',
    bridge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17h18M5 17V9m14 8V9M3 9c3 3 6 4 9 4s6-1 9-4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
    steps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4v-4h4v-4h4V8h4"/></svg>',
    flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 21V4m0 1h13l-3 4 3 4H5"/></svg>'
  };

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function reduced() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function iconFor(ic) {
    if (typeof ic === 'string' && ic.indexOf('<svg') === 0) return ic;
    return ICONS[ic] || ICONS.check;
  }

  function build(host, scene) {
    host.innerHTML = '';
    const card = document.createElement('div'); card.className = 'anim-card';
    card.innerHTML = '<p class="anim-title">' + esc(scene.title || '') + '</p>'
      + '<div class="anim-stage"></div>'
      + '<div class="anim-controls"><button class="btn cta small anim-play">Play</button></div>';
    const stage = card.querySelector('.anim-stage');
    const controls = card.querySelector('.anim-controls');
    (scene.steps || []).forEach(function (st) {
      const d = document.createElement('div'); d.className = 'anim-step';
      d.innerHTML = '<span class="anim-ico">' + iconFor(st.icon) + '</span><p>' + esc(st.text || '') + '</p>';
      stage.appendChild(d);
    });
    if (scene.panel) {
      const p = document.createElement('div'); p.className = 'anim-panel';
      p.innerHTML = '<div class="anim-panel-h">' + esc(scene.panel.title || '') + '</div><div class="anim-panel-b">'
        + (scene.panel.paragraphs || []).map(function (t) { return '<p>' + esc(t) + '</p>'; }).join('') + '</div>';
      stage.appendChild(p);
    }
    if (scene.end) {
      const e = document.createElement('p'); e.className = 'anim-end'; e.textContent = scene.end; stage.appendChild(e);
    }
    host.appendChild(card);

    let timers = [];
    function clearTimers() { timers.forEach(clearTimeout); timers = []; }
    function reset() {
      clearTimers();
      card.querySelectorAll('.anim-step').forEach(function (el) { el.classList.remove('show'); });
      const pn = card.querySelector('.anim-panel'); if (pn) pn.classList.remove('show');
      card.querySelectorAll('.anim-panel-b p').forEach(function (el) { el.classList.remove('show'); });
      const en = card.querySelector('.anim-end'); if (en) en.classList.remove('show');
    }
    function wire() {
      const b = controls.querySelector('.anim-play');
      if (b) b.onclick = play;
    }
    function revealAll() {
      reset();
      card.querySelectorAll('.anim-step').forEach(function (el) { el.classList.add('show'); });
      const pn = card.querySelector('.anim-panel'); if (pn) pn.classList.add('show');
      card.querySelectorAll('.anim-panel-b p').forEach(function (el) { el.classList.add('show'); });
      const en = card.querySelector('.anim-end'); if (en) en.classList.add('show');
      controls.innerHTML = '<button class="btn ghost small anim-play">Replay</button>';
      wire();
    }
    function play() {
      reset();
      if (reduced()) { revealAll(); return; }
      const steps = Array.from(card.querySelectorAll('.anim-step'));
      const paras = Array.from(card.querySelectorAll('.anim-panel-b p'));
      const panel = card.querySelector('.anim-panel');
      const end = card.querySelector('.anim-end');
      let t = 300;
      controls.innerHTML = '<span style="color:var(--slate);font-weight:700;font-size:.9rem">Playing…</span>';
      steps.forEach(function (el) { timers.push(setTimeout(function () { el.classList.add('show'); }, t)); t += 1500; });
      if (panel) { timers.push(setTimeout(function () { panel.classList.add('show'); }, t)); t += 700; }
      paras.forEach(function (el) { timers.push(setTimeout(function () { el.classList.add('show'); }, t)); t += 1200; });
      if (end) { timers.push(setTimeout(function () { el.classList.add('show'); }, t)); t += 600; }
      timers.push(setTimeout(function () {
        controls.innerHTML = '<button class="btn ghost small anim-play">Replay</button>';
        wire();
      }, t));
    }
    wire();
  }

  function missing(host, id) {
    host.innerHTML = '<div class="anim-missing">Animation "' + esc(id) + '" is not available yet.</div>';
  }

  A.mount = function (host, id) {
    if (!host || !id) return;
    if (A.scenes[id]) { build(host, A.scenes[id]); return; }
    host.innerHTML = '<div class="anim-missing">Loading animation…</div>';
    if (!loading[id]) {
      loading[id] = new Promise(function (resolve) {
        const s = document.createElement('script');
        s.src = '/animations/' + id + '.js';
        s.onload = function () { resolve(!!A.scenes[id]); };
        s.onerror = function () { resolve(false); };
        document.head.appendChild(s);
      });
    }
    loading[id].then(function (ok) {
      if (ok && A.scenes[id]) build(host, A.scenes[id]); else if (!ok) missing(host, id);
    });
  };
})();
