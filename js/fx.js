/* ─────────────────────────────────────────────
   Aurora — ambient FX canvas
   A fixed, full-viewport constellation of glowing
   nodes + connecting lines + drifting particles,
   behind the app. Pure decorative layer:
     • pauses when the tab is hidden
     • renders a single static frame under
       prefers-reduced-motion
   ───────────────────────────────────────────── */
const FX = (() => {
  let canvas = null;
  let ctx = null;
  let raf = null;
  let running = false;
  let reduced = false;
  let W = 0, H = 0, DPR = 1;

  const NODES = 70;          // constellation nodes
  const SPARKS = 36;         // drifting glow particles
  const LINK = 150;          // max px distance for a connecting line
  const SPEED = 0.22;

  let nodes = [];
  let sparks = [];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function makeNodes() {
    nodes = Array.from({ length: NODES }, () => ({
      x: rand(0, W), y: rand(0, H),
      vx: rand(-SPEED, SPEED), vy: rand(-SPEED, SPEED),
      r: rand(1, 2.4),
      hue: Math.random() < 0.5 ? 250 : 190, // violet | cyan
    }));
    sparks = Array.from({ length: SPARKS }, () => ({
      x: rand(0, W), y: rand(0, H),
      vx: rand(-0.08, 0.08), vy: rand(-0.16, -0.02),
      r: rand(0.4, 1.2),
      life: rand(0, 1),
    }));
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    makeNodes();
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);

    // constellation lines
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < LINK * LINK) {
          const alpha = (1 - Math.sqrt(d2) / LINK) * 0.16;
          ctx.strokeStyle = `rgba(140,150,255,${alpha.toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // constellation nodes
    for (const n of nodes) {
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > W) n.vx *= -1;
      if (n.y < 0 || n.y > H) n.vy *= -1;
      const glow = 0.5 + 0.5 * Math.sin(t / 900 + n.r * 7);
      ctx.fillStyle = n.hue === 250
        ? `rgba(168,85,247,${(0.5 + 0.4 * glow).toFixed(3)})`
        : `rgba(34,211,238,${(0.45 + 0.4 * glow).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // drifting sparks
    for (const s of sparks) {
      s.x += s.vx; s.y += s.vy;
      s.life += 0.004;
      if (s.life > 1 || s.y < -4 || s.x < -4 || s.x > W + 4) {
        s.x = rand(0, W); s.y = H + 4; s.life = 0;
        s.vx = rand(-0.08, 0.08); s.vy = rand(-0.16, -0.04);
      }
      const a = Math.sin(s.life * Math.PI) * 0.5;
      ctx.fillStyle = `rgba(190,200,255,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function tick(t) {
    if (!running) return;
    draw(t);
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  function start() {
    if (!canvas || !ctx || running) return;
    running = true;
    raf = requestAnimationFrame(tick);
  }

  function init() {
    canvas = document.getElementById('fxCanvas');
    if (!canvas) return false;
    ctx = canvas.getContext('2d');
    if (!ctx) return false;

    reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    resize();

    if (!reduced) {
      start();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop(); else start();
      });
    } else {
      draw(0); // single static frame
    }

    window.addEventListener('resize', () => {
      resize();
      if (reduced) draw(0);
    });
    return true;
  }

  return { init };
})();
