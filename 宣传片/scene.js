'use strict';
/*
 * 《夙与愿》宣传片画面。
 * renderFrame(t, frame) 按秒绘制一帧，结果只取决于 t，不依赖真实时间，
 * 所以可以多进程分段渲染再拼接。节拍、文字和事件全部来自 timeline.json。
 */

const TL = window.TIMELINE;
const W = TL.width, H = TL.height, BEAT = 60 / TL.bpm;
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const tb = b => b * BEAT;

// ------------------------------------------------------------ 数学

const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const inv = (a, b, x) => clamp((x - a) / (b - a));
const eOut = t => 1 - Math.pow(1 - t, 3);
const eIn = t => t * t * t;
const eInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const backOut = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const pad2 = n => String(n).padStart(2, '0');

function hash(...a) {
  let h = 2166136261 >>> 0;
  for (const v of a) { h ^= Math.round(v * 997) | 0; h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// [b0, b1] 内可见，前后各淡入淡出 fi、fo 拍
function win(b, b0, b1, fi = .3, fo = .3) {
  if (b < b0 || b > b1) return 0;
  return Math.min(fi > 0 ? inv(b0, b0 + fi, b) : 1, fo > 0 ? inv(b1, b1 - fo, b) : 1);
}

// ------------------------------------------------------------ 配色与字体

const C = {
  bone: '#ece6d9', dim: '#9b9486', faint: '#4d4943', red: '#d3193a', blood: '#7a0918',
  gold: '#d8b064', silver: '#c9ced6',
};
const SERIF = '"Noto Serif SC", serif';
const SANS = '"Noto Sans SC", sans-serif';
const CINZEL = 'Cinzel, "Noto Serif SC", serif';
const font = (size, weight = 400, fam = SERIF) => `${weight} ${size}px ${fam}`;

// ------------------------------------------------------------ 文字

function text(str, x, y, o = {}) {
  ctx.save();
  ctx.font = font(o.size || 40, o.weight || 400, o.fam || SERIF);
  const align = o.align || 'center';
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = (o.ls || 0) + 'px';
  ctx.globalAlpha *= o.alpha ?? 1;
  if (o.glow) { ctx.shadowColor = o.glowColor || o.color || C.bone; ctx.shadowBlur = o.glow; }
  ctx.fillStyle = o.color || C.bone;
  ctx.fillText(str, x + (align === 'center' ? (o.ls || 0) / 2 : 0), y);
  ctx.restore();
}

function measure(str, size, weight = 400, fam = SERIF, ls = 0) {
  ctx.save();
  ctx.font = font(size, weight, fam);
  ctx.letterSpacing = ls + 'px';
  const w = ctx.measureText(str).width - ls;
  ctx.restore();
  return w;
}

// 逐字显现，p 为整体进度 0..1
function revealText(str, x, y, p, o = {}) {
  if (p <= 0) return;
  ctx.save();
  const size = o.size || 40, ls = o.ls || 0;
  ctx.font = font(size, o.weight || 400, o.fam || SERIF);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const chars = [...str];
  const ws = chars.map(c => ctx.measureText(c).width);
  const total = ws.reduce((a, c) => a + c, 0) + ls * (chars.length - 1);
  const align = o.align || 'center';
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const soft = o.soft ?? .35, n = chars.length, base = (o.alpha ?? 1) * ctx.globalAlpha;
  if (o.glow) { ctx.shadowColor = o.glowColor || o.color || C.bone; ctx.shadowBlur = o.glow; }
  ctx.fillStyle = o.color || C.bone;
  for (let i = 0; i < n; i++) {
    const st = n > 1 ? i / (n - 1) * (1 - soft) : 0;
    const a = clamp((p - st) / soft);
    if (a > 0) {
      ctx.globalAlpha = base * a;
      ctx.fillText(chars[i], cx, y + (1 - eOut(a)) * (o.rise ?? 12));
    }
    cx += ws[i] + ls;
  }
  ctx.restore();
  return total;
}

function wrapText(str, x, y, maxW, size, lineH, color, alpha = 1) {
  ctx.save();
  ctx.font = font(size, 400, SERIF);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.globalAlpha *= alpha;
  let line = '', yy = y;
  for (const ch of str) {
    if (ctx.measureText(line + ch).width > maxW && line) {
      ctx.fillText(line, x, yy);
      line = '';
      yy += lineH;
    }
    line += ch;
  }
  if (line) ctx.fillText(line, x, yy);
  ctx.restore();
}

// ------------------------------------------------------------ 馆内字形（谁都没见过，谁读都懂）

const glyphCache = new Map();
function glyphStrokes(seed) {
  if (glyphCache.has(seed)) return glyphCache.get(seed);
  const r = rng(seed * 7919 + 17);
  const q = () => Math.round(r() * 4) / 4;
  const st = [];
  const m = r();
  if (m < .4) st.push({ t: 'l', a: [.5, 0], b: [.5, 1] });
  else if (m < .65) { const s = r() * TAU; st.push({ t: 'a', c: [.5, .5], r: .4, s, e: s + Math.PI * (1 + r()) }); }
  else st.push({ t: 'l', a: [0, .3 + r() * .4], b: [1, .3 + r() * .4] });
  const k = 2 + Math.floor(r() * 3);
  for (let i = 0; i < k; i++) {
    const v = r();
    if (v < .55) {
      const a = [q(), q()], b = [q(), q()];
      if (a[0] !== b[0] || a[1] !== b[1]) st.push({ t: 'l', a, b });
    } else if (v < .82) {
      const s = r() * TAU;
      st.push({ t: 'a', c: [q(), q()], r: .12 + r() * .16, s, e: s + Math.PI * (.6 + r() * 1.2) });
    } else st.push({ t: 'd', c: [q(), q()] });
  }
  glyphCache.set(seed, st);
  return st;
}

function drawGlyph(seed, x, y, size, color, alpha = 1, lw = 5) {
  if (alpha <= 0) return;
  const st = glyphStrokes(seed);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size, size);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw / size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of st) {
    ctx.beginPath();
    if (s.t === 'l') { ctx.moveTo(...s.a); ctx.lineTo(...s.b); ctx.stroke(); }
    else if (s.t === 'a') { ctx.arc(s.c[0], s.c[1], s.r, s.s, s.e); ctx.stroke(); }
    else { ctx.arc(s.c[0], s.c[1], lw * .9 / size, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}

// ------------------------------------------------------------ 预生成素材

const grains = [];
for (let i = 0; i < 8; i++) {
  const c = document.createElement('canvas');
  c.width = W / 2; c.height = H / 2;
  const g = c.getContext('2d');
  const id = g.createImageData(c.width, c.height);
  const r = rng(1000 + i);
  for (let p = 0; p < id.data.length; p += 4) {
    const v = 128 + (r() - .5) * 255;
    id.data[p] = id.data[p + 1] = id.data[p + 2] = v;
    id.data[p + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  grains.push(c);
}

const vignette = (() => {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(W / 2, H / 2, H * .32, W / 2, H / 2, H * 1.05);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(1, 'rgba(0,0,0,.8)');
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  return c;
})();

const tmpA = document.createElement('canvas'); tmpA.width = W; tmpA.height = H;
const tA = tmpA.getContext('2d');
const tmpB = document.createElement('canvas'); tmpB.width = W; tmpB.height = H;
const tB = tmpB.getContext('2d');

// 洋馆平面示意（调查段落的背景）
const PLAN = (() => {
  const r = rng(77), rooms = [];
  (function split(x, y, w, h, d) {
    if (d > 4 || w < 180 || h < 140 || (d > 2 && r() < .25)) { rooms.push([x, y, w, h]); return; }
    if (w > h) { const k = w * (.3 + r() * .4); split(x, y, k, h, d + 1); split(x + k, y, w - k, h, d + 1); }
    else { const k = h * (.3 + r() * .4); split(x, y, w, k, d + 1); split(x, y + k, w, h - k, d + 1); }
  })(0, 0, 2700, 1600, 0);
  return rooms;
})();

// 俯视的人形：头朝左。衣物版没有头，按原姿势塌落、略扁
function limbs(cloth) {
  const k = cloth ? 1.18 : 1;
  return [
    { a: [-170, 0], b: [90, 10], w: 105 * k },
    { a: [-150, -35], b: [-90, -150], w: 40 * k }, { a: [-90, -150], b: [-10, -205], w: 34 * k },
    { a: [-150, 40], b: [-60, 120], w: 40 * k }, { a: [-60, 120], b: [-95, 215], w: 34 * k },
    { a: [80, -20], b: [262, -62], w: 50 * k }, { a: [262, -62], b: [432, -30], w: 42 * k },
    { a: [80, 35], b: [250, 92], w: 50 * k }, { a: [250, 92], b: [402, 162], w: 42 * k },
  ];
}
function makeSilhouette(cloth) {
  const c = document.createElement('canvas');
  c.width = 1000; c.height = 600;
  const g = c.getContext('2d');
  g.translate(500, 300);
  if (cloth) g.scale(1.02, .86);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const L = limbs(cloth);
  const all = (extra, col) => {
    g.strokeStyle = col; g.fillStyle = col;
    for (const l of L) {
      g.lineWidth = l.w + extra;
      g.beginPath(); g.moveTo(...l.a); g.lineTo(...l.b); g.stroke();
    }
    if (!cloth) { g.beginPath(); g.arc(-248, -4, 50 + extra / 2, 0, TAU); g.fill(); }
  };
  all(9, '#fff');
  g.globalCompositeOperation = 'destination-out';
  all(0, '#000');
  if (cloth) {
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.lineWidth = 2.5;
    const r = rng(41);
    for (let i = 0; i < 26; i++) {
      const l = L[Math.floor(r() * L.length)], u = r();
      const x = lerp(l.a[0], l.b[0], u), y = lerp(l.a[1], l.b[1], u);
      const an = r() * TAU, len = 12 + r() * 26;
      g.beginPath(); g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(an + 1) * len * .6, y + Math.sin(an + 1) * len * .6, x + Math.cos(an) * len, y + Math.sin(an) * len);
      g.stroke();
    }
  }
  return c;
}
const BODY = makeSilhouette(false);
const CLOTH = makeSilhouette(true);
const BODY_PTS = (() => {
  const r = rng(9), pts = [];
  for (const l of limbs(false)) {
    const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1], len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len;
    for (let i = 0; i < len / 6; i++) {
      const u = r(), side = r() < .5 ? -1 : 1;
      const x = l.a[0] + dx * u + nx * side * (l.w / 2 + 4), y = l.a[1] + dy * u + ny * side * (l.w / 2 + 4);
      pts.push({ x, y, d: (x + 450) / 900 * .55 + r() * .45, vx: r() - .5, vy: r() });
    }
  }
  for (let i = 0; i < 90; i++) {
    const an = r() * TAU;
    pts.push({ x: -248 + Math.cos(an) * 54, y: -4 + Math.sin(an) * 54, d: r() * .4, vx: r() - .5, vy: r() });
  }
  return pts;
})();

// 黑钻石封墙的切面
const FACETS = (() => {
  const r = rng(5150), cols = 9, rows = 13, pts = [];
  for (let j = 0; j <= rows; j++) {
    pts.push([]);
    for (let i = 0; i <= cols; i++) {
      const edge = i === 0 || j === 0 || i === cols || j === rows;
      pts[j].push([i / cols + (edge ? 0 : (r() - .5) * .07), j / rows + (edge ? 0 : (r() - .5) * .05)]);
    }
  }
  const tris = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const a = pts[j][i], b = pts[j][i + 1], c = pts[j + 1][i + 1], d = pts[j + 1][i];
    const pair = r() < .5 ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
    for (const t of pair) tris.push({ p: t, s: 8 + r() * 26, k: r(), cx: (t[0][0] + t[1][0] + t[2][0]) / 3, cy: (t[0][1] + t[1][1] + t[2][1]) / 3 });
  }
  return tris;
})();

const CARD_TEXT = {
  '法官': '每次普通投票期间，法官可秘密指定一名角色，使其本轮总票数增加一票。指定对象可以与法官本人的票选对象不同。',
  '典狱长': '受命者视为同时拥有此身份。仅一次，典狱长可随时指定馆内一扇门，使门扇按原方向强行闭合并锁住一小时。期间无论以何种方式均无法开启；一小时后，门自动弹开。',
};
const FLIP_NUMERALS = ['VI', 'VII', 'IX', 'VIII', 'V', 'XIII', 'XIV', 'XV'];

// ------------------------------------------------------------ 冲击：抖动与闪光

const IMPACTS = [ // [拍, 幅度 px, 衰减拍]
  [8, 6, .8], [32, 5, .6], [42.2, 7, .5], [56, 14, .8], [60, 10, .6], [68, 26, .9], [72, 24, 1],
  [84, 18, .9], [105, 22, 1], [121.5, 8, 1.2], [132, 16, 1.2],
];
const FLASHES = [ // [拍, rgb, 强度, 衰减拍]
  [8, '255,250,235', .32, .6], [56, '211,25,58', .45, .8], [60, '255,250,235', .2, .4],
  [68, '255,250,235', .7, .5], [72, '211,25,58', .6, 1.0], [84, '255,250,235', .5, .7],
  [105, '211,25,58', .55, .9], [132, '255,240,210', .5, 1.0],
];
TL.debate.forEach(d => IMPACTS.push([d.b, 4, .3]));
for (let i = 0; i < TL.names.slowCount; i++) {
  const b = TL.names.b + i * TL.names.slow;
  IMPACTS.push([b, 7, .3]);
  FLASHES.push([b, '211,25,58', .16, .35]);
}
const GLITCH = [[56, 56.5, .6], [72, 72.35, .5], [82, 84, .22], [104, 105.25, 1], [116, 120, .18], [132, 132.25, .35]];

function shakeAt(b) {
  let x = 0, y = 0;
  for (const [b0, amp, dec] of IMPACTS) {
    if (b < b0 || b > b0 + dec * 5) continue;
    const k = amp * Math.exp(-(b - b0) / dec * 2.2);
    const f = Math.floor(b * 40);
    x += (hash(f, b0, 1) - .5) * 2 * k;
    y += (hash(f, b0, 2) - .5) * 2 * k;
  }
  return { x, y };
}

function drawFlashes(b) {
  for (const [b0, col, a, dec] of FLASHES) {
    if (b < b0 || b > b0 + dec * 4) continue;
    ctx.fillStyle = `rgba(${col},${a * Math.exp(-(b - b0) / dec * 3)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function glitchAmt(b) {
  let g = 0;
  for (const [a, c, s] of GLITCH) {
    if (b >= a && b < c) g = Math.max(g, s * (hash(Math.floor(b * 16), 3) > .35 ? 1 : .15));
  }
  return g;
}

// ------------------------------------------------------------ 通用部件

function hud(label, value, alpha, col = C.bone, fam = CINZEL) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = col;
  ctx.fillRect(82, 72, 3, 88);
  ctx.restore();
  text(label, 104, 92, { size: 24, align: 'left', color: C.dim, ls: 8, alpha });
  text(value, 102, 138, { size: 44, align: 'left', fam, weight: 700, color: col, ls: 4, alpha });
}

function spot(x, y, r, a, col = '236,230,217') {
  if (a <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${col},${.14 * a})`);
  g.addColorStop(1, `rgba(${col},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}

function redVignette(k) {
  if (k <= 0) return;
  const g = ctx.createRadialGradient(W / 2, H / 2, H * .2, W / 2, H / 2, H * .95);
  g.addColorStop(0, 'rgba(120,8,24,0)');
  g.addColorStop(1, `rgba(150,10,30,${k})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function dust(b, alpha, col = '236,230,217', count = 70, seed = 5) {
  if (alpha <= 0) return;
  const r = rng(seed), t = tb(b);
  ctx.save();
  ctx.fillStyle = `rgb(${col})`;
  for (let i = 0; i < count; i++) {
    const x0 = r() * W, y0 = r() * H, sp = 4 + r() * 10, ph = r() * TAU, sz = .6 + r() * 1.8, a = .15 + r() * .5;
    const x = ((x0 + Math.sin(t * .2 + ph) * 30 + t * sp * .6) % W + W) % W;
    const y = ((y0 - t * sp) % H + H) % H;
    ctx.globalAlpha = alpha * a * (.6 + .4 * Math.sin(t * 1.3 + ph));
    ctx.beginPath();
    ctx.arc(x, y, sz, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function almond(x, y, w, h) {
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  ctx.quadraticCurveTo(x, y - h * 2, x + w / 2, y);
  ctx.quadraticCurveTo(x, y + h * 1.6, x - w / 2, y);
  ctx.closePath();
}

// 一只眼睛。open 0..1
function eye(x, y, w, open, o = {}) {
  const a = (o.alpha ?? 1);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.lineWidth = Math.max(1.2, w * .055);
  ctx.strokeStyle = o.line || 'rgba(236,230,217,.85)';
  if (open > .03) {
    const h = w * .42 * open;
    almond(x, y, w, h);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = o.white || 'rgba(236,230,217,.92)';
    ctx.fillRect(x - w, y - w, 2 * w, 2 * w);
    const ir = w * .23, ix = x + (o.look || 0) * w * .15, iy = y - h * .1;
    ctx.fillStyle = o.iris || '#2a2a33';
    ctx.beginPath(); ctx.arc(ix, iy, ir, 0, TAU); ctx.fill();
    ctx.fillStyle = '#050505';
    if (o.slit) { ctx.beginPath(); ctx.ellipse(ix, iy, ir * .18, ir * .9, 0, 0, TAU); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(ix, iy, ir * (o.pupil || .5), 0, TAU); ctx.fill(); }
    ctx.restore();
    almond(x, y, w, h);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y);
    ctx.quadraticCurveTo(x, y + w * .16, x + w / 2, y);
    ctx.stroke();
  }
  ctx.restore();
}

function blink(i, b) {
  const ph = (b + hash(i, 7) * 5.3) % 5.3;
  return ph < .14 ? Math.abs(ph - .07) / .07 : 1;
}

// ------------------------------------------------------------ 穹顶议事厅（俯视，一号席在正北，顺时针）

const SEAT_ANG = i => -Math.PI / 2 + (i - 1) * TAU / 15;
function proj(T, r, a) {
  return [T.cx + Math.cos(a + (T.rot || 0)) * r * T.scale, T.cy + Math.sin(a + (T.rot || 0)) * r * T.scale * (T.squash ?? 1)];
}

function moodCols(m) {
  if (m === 'red') return { rib: '170,22,44', glow: '225,40,62', table: ['#2c1517', '#120809'], disk: '#0b0506', chand: '255,120,120' };
  if (m === 'gold') return { rib: '200,160,90', glow: '240,200,120', table: ['#3b392b', '#17160f'], disk: '#0b0a07', chand: '255,220,150' };
  return { rib: '52,80,170', glow: '255,222,175', table: ['#33483f', '#131c19'], disk: '#07090a', chand: '210,225,255' };
}

function drawTable(T) {
  const M = moodCols(T.mood);
  const sc = T.scale, sq = T.squash ?? 1;
  ctx.save();
  ctx.globalAlpha *= T.alpha ?? 1;
  if (ctx.globalAlpha <= 0) { ctx.restore(); return; }

  // 深蓝钻石肋线，从穹顶中心放射
  for (let i = 0; i < 30; i++) {
    const a = i / 30 * TAU + (T.ribRot || 0);
    const [x1, y1] = proj(T, 240, a), [x2, y2] = proj(T, 1500, a);
    const g = ctx.createLinearGradient(x1, y1, x2, y2);
    const al = (i % 2 ? .2 : .38) * (T.ribAlpha ?? 1);
    g.addColorStop(0, `rgba(${M.rib},${al})`);
    g.addColorStop(1, `rgba(${M.rib},0)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = i % 2 ? 1 : 2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.strokeStyle = `rgba(${M.rib},.16)`;
  ctx.lineWidth = 1;
  for (const r of [520, 690, 900, 1150]) {
    ctx.beginPath(); ctx.ellipse(T.cx, T.cy, r * sc, r * sc * sq, 0, 0, TAU); ctx.stroke();
  }
  // 墨玉圆盘
  ctx.beginPath(); ctx.ellipse(T.cx, T.cy, 380 * sc, 380 * sc * sq, 0, 0, TAU);
  ctx.fillStyle = M.disk; ctx.fill();
  ctx.strokeStyle = `rgba(${M.rib},.5)`; ctx.lineWidth = 1.5; ctx.stroke();
  // 青白玉圆桌
  const tg = ctx.createRadialGradient(T.cx, T.cy - 40 * sc * sq, 20, T.cx, T.cy, 225 * sc);
  tg.addColorStop(0, M.table[0]);
  tg.addColorStop(1, M.table[1]);
  ctx.beginPath(); ctx.ellipse(T.cx, T.cy, 225 * sc, 225 * sc * sq, 0, 0, TAU);
  ctx.fillStyle = tg; ctx.fill();
  ctx.strokeStyle = 'rgba(220,230,225,.35)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(T.cx, T.cy, 212 * sc, 212 * sc * sq, 0, 0, TAU);
  ctx.strokeStyle = 'rgba(220,230,225,.12)'; ctx.lineWidth = 1; ctx.stroke();
  // 水晶灯
  const ch = T.chand ?? 1;
  if (ch > 0) {
    const g = ctx.createRadialGradient(T.cx, T.cy, 0, T.cx, T.cy, 160 * sc);
    g.addColorStop(0, `rgba(${M.chand},${Math.min(1, .5 * ch)})`);
    g.addColorStop(.4, `rgba(${M.chand},${Math.min(1, .12 * ch)})`);
    g.addColorStop(1, `rgba(${M.chand},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(T.cx, T.cy, 160 * sc, 160 * sc * sq, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(${M.chand},${Math.min(1, .5 * ch)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * TAU + (T.rot || 0) * 2, r = i % 2 ? 24 : 60;
      const x = T.cx + Math.cos(a) * r * sc, y = T.cy + Math.sin(a) * r * sc * sq;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.stroke();
  }

  for (let i = 1; i <= 15; i++) {
    const a = SEAT_ANG(i);
    const [nx, ny] = proj(T, 200, a);
    if (T.numbers !== false) text(String(i), nx, ny, { size: Math.round(19 * Math.max(.85, sc)), fam: CINZEL, weight: 700, color: C.silver, alpha: .7 });
    const [x, y] = proj(T, 300, a);
    const lit = T.glow ? T.glow[i - 1] : 0;
    if (lit > 0) {
      const rr = 92 * sc * Math.max(1, lit);
      const gr = ctx.createRadialGradient(x, y, 0, x, y, rr);
      const gc = (T.seatCol && T.seatCol[i - 1]) || M.glow;
      gr.addColorStop(0, `rgba(${gc},${Math.min(.9, .3 * lit)})`);
      gr.addColorStop(1, `rgba(${gc},0)`);
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
    }
    // 乌木椅，暗蓝真丝坐垫
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sc, sc * sq);
    ctx.rotate(a + (T.rot || 0));
    ctx.fillStyle = '#120c0a';
    ctx.beginPath(); ctx.roundRect(-26, -28, 52, 56, 10); ctx.fill();
    ctx.fillStyle = '#1c2b57';
    ctx.beginPath(); ctx.roundRect(-20, -21, 36, 42, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(200,190,170,.28)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 40, -.9, .9); ctx.stroke();
    ctx.restore();

    if (T.eyes) {
      const o = T.eyes[i - 1] * blink(i, T.b ?? 0);
      const red = T.redEye && T.redEye[i - 1];
      eye(x, y - 2, 44 * Math.max(.8, sc), o, {
        alpha: .95, iris: red ? C.red : '#2a2a33', slit: !!red,
        line: red ? 'rgba(211,25,58,.9)' : undefined, look: Math.sin((T.b ?? 0) * .7 + i) * .8,
      });
    }
    if (T.crossed === i) {
      const k = T.crossK ?? 1, s = 34 * sc;
      ctx.save();
      ctx.strokeStyle = C.red; ctx.lineWidth = 6; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - s, y - s); ctx.lineTo(x - s + 2 * s * Math.min(1, k * 2), y - s + 2 * s * Math.min(1, k * 2));
      if (k > .5) { const k2 = (k - .5) * 2; ctx.moveTo(x + s, y - s); ctx.lineTo(x + s - 2 * s * k2, y - s + 2 * s * k2); }
      ctx.stroke();
      ctx.restore();
    }
    if (T.names) {
      const [lx, ly] = proj(T, 412, a);
      const na = T.nameAlpha ?? 1;
      if (T.names[i - 1]) text(T.names[i - 1], lx, ly, { size: 25, weight: 500, color: C.bone, alpha: na * .85 });
      if ((T.redact ?? 0) > 0) {
        const bw = (54 + hash(i, 4) * 80) * eOut(T.redact);
        ctx.save();
        ctx.globalAlpha *= T.redact;
        ctx.fillStyle = C.bone;
        ctx.fillRect(lx - bw / 2, ly - 13, bw, 26);
        ctx.restore();
      }
    }
  }
  ctx.restore();
}

function allOpen() { return Array(15).fill(1); }

// ------------------------------------------------------------ 身份卡（63×88）

const CARD_W = 444, CARD_H = 620;

function cardFace(name, label, desc, numeral) {
  const w = CARD_W, h = CARD_H, ink = '#16130f';
  const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
  g.addColorStop(0, '#f0eadd');
  g.addColorStop(1, '#d6cdb9');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, 16); ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(-w / 2 + 20, -h / 2 + 20, w - 40, h - 40, 6); ctx.stroke();
  ctx.lineWidth = .8;
  ctx.beginPath(); ctx.roundRect(-w / 2 + 28, -h / 2 + 28, w - 56, h - 56, 4); ctx.stroke();
  ctx.fillStyle = ink;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = sx * (w / 2 - 28), y = sy * (h / 2 - 28);
    ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); ctx.closePath(); ctx.fill();
  }
  text(label, 0, -h / 2 + 72, { size: 24, color: ink, ls: 14, weight: 700 });
  text(numeral, 0, -h / 2 + 110, { size: 22, fam: CINZEL, color: ink, alpha: .7, weight: 700 });
  const n = [...name].length;
  const size = Math.min(92, (w - 96) / (n + (n - 1) * .14));
  text(name, 0, desc ? -50 : -10, { size, weight: 900, color: '#0e0c0a', ls: size * .14 });
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-90, desc ? 22 : 62); ctx.lineTo(90, desc ? 22 : 62); ctx.stroke();
  if (desc) wrapText(desc, -(w - 120) / 2, 64, w - 120, 19, 31, ink, .9);
  else {
    ctx.fillStyle = 'rgba(22,19,15,.28)';
    const r = rng(n * 31 + name.charCodeAt(0));
    for (let i = 0; i < 6; i++) ctx.fillRect(-(w - 130) / 2, 100 + i * 30, (w - 130) * (i === 5 ? .4 + r() * .3 : .85 + r() * .15), 9);
  }
}

function drawCard(c) {
  const th = clamp(c.flip) * Math.PI, sx = Math.cos(th);
  ctx.save();
  ctx.globalAlpha *= c.alpha ?? 1;
  ctx.translate(c.x, c.y);
  ctx.rotate(c.rot || 0);
  ctx.scale(c.s, c.s);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.75)';
  ctx.shadowBlur = 60;
  ctx.shadowOffsetY = 24;
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.roundRect(-CARD_W / 2 * Math.abs(sx), -CARD_H / 2, CARD_W * Math.abs(sx), CARD_H, 16); ctx.fill();
  ctx.restore();
  ctx.scale(Math.max(.002, Math.abs(sx)), 1);
  if (sx >= 0) cardFace(c.front, '正位', c.frontDesc, c.numeral);
  else { ctx.rotate(Math.PI); cardFace(c.back, '逆位', c.backDesc, c.numeral); }
  const sheen = Math.sin(th);
  if (sheen > .02) {
    const g = ctx.createLinearGradient(-CARD_W / 2, 0, CARD_W / 2, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(.5, `rgba(255,255,255,${.55 * sheen})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 16); ctx.fill();
  }
  ctx.restore();
}

// ------------------------------------------------------------ 字幕（timeline.texts）

function broadcast(tx, b) {
  const chars = [...tx.text], n = chars.length;
  const dur = Math.min(n / 14, (tx.until - tx.b) * BEAT * .6);
  const el = tb(b) - tb(tx.b);
  const shown = el < 0 ? 0 : Math.min(n, Math.floor(el / dur * n) + 1);
  const fo = win(b, tx.b, tx.until, 0, .3);
  const y = 116, size = 34, ls = 3;
  const fullW = measure(tx.text, size, 500, SANS, ls);
  const x0 = 960 - fullW / 2;
  ctx.save();
  ctx.globalAlpha *= fo;
  const lw = Math.min(1, el / .25) * (fullW + 140);
  ctx.strokeStyle = 'rgba(201,206,214,.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(960 - lw / 2, y - 44); ctx.lineTo(960 + lw / 2, y - 44);
  ctx.moveTo(960 - lw / 2, y + 44); ctx.lineTo(960 + lw / 2, y + 44);
  ctx.stroke();
  ctx.restore();
  const s = chars.slice(0, shown).join('');
  text(s, x0, y, { size, weight: 500, fam: SANS, ls, align: 'left', color: C.silver, alpha: fo });
  if (shown < n || Math.floor(tb(b) * 3) % 2 === 0) {
    const w = s ? measure(s, size, 500, SANS, ls) + ls : 0;
    ctx.save();
    ctx.globalAlpha *= fo * .8;
    ctx.fillStyle = C.silver;
    ctx.fillRect(x0 + w + 6, y - 17, 13, 34);
    ctx.restore();
  }
}

function capBand(a) {
  if (a <= 0) return;
  const g = ctx.createLinearGradient(0, 860, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${.6 * a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 860, W, H - 860);
}

function drawTexts(b) {
  for (const tx of TL.texts) {
    if (b < tx.b || b > tx.until) continue;
    const el = tb(b) - tb(tx.b);
    const fo = win(b, tx.b, tx.until, 0, .35);
    const n = [...tx.text].length;
    switch (tx.style) {
      case 'narr':
        revealText(tx.text, 960, tx.y || 540, el / Math.min(1.6, n * .07), { size: 48, ls: 6, alpha: fo, rise: 14 });
        break;
      case 'cap':
        if (!tx.y) capBand(fo);
        revealText(tx.text, 960, tx.y || 962, el / Math.min(.9, n * .045), { size: 38, ls: 4, alpha: fo, rise: 8 });
        break;
      case 'capRed':
        revealText(tx.text, 960, tx.y || 962, el / .45, { size: 46, weight: 700, ls: 6, color: C.red, alpha: fo, glow: 20 });
        break;
      case 'small':
        revealText(tx.text, 960, tx.y || 640, el / Math.min(1.2, n * .06), { size: 28, ls: 6, color: C.dim, alpha: fo });
        break;
      case 'side':
        revealText(tx.text, 200, 440, el / .7, { size: 54, weight: 700, ls: 6, align: 'left', alpha: fo });
        break;
      case 'side2':
        revealText(tx.text, 200, 534, el / 1.0, { size: 36, ls: 4, align: 'left', color: C.dim, alpha: fo });
        break;
      case 'mid':
        revealText(tx.text, 960, tx.y || 540, el / Math.min(1, n * .05), { size: 50, ls: 6, alpha: fo, glow: 16, glowColor: 'rgba(0,0,0,.95)' });
        break;
      case 'big': {
        const y = tx.y || 520;
        const w = revealText(tx.text, 960, y, el / .9, { size: 62, weight: 700, ls: 8, alpha: fo, glow: 20, glowColor: 'rgba(0,0,0,.95)' }) || 0;
        const k = eOut(inv(.4, 1.4, el));
        ctx.save();
        ctx.globalAlpha *= fo;
        ctx.fillStyle = C.red;
        ctx.fillRect(960 - w / 2 * k, y + 52, w * k, 3);
        ctx.restore();
        break;
      }
      case 'gold':
        revealText(tx.text, 960, tx.y || 950, el / 1.2, { size: 60, weight: 700, ls: 12, color: C.gold, alpha: fo, glow: 34, glowColor: 'rgba(216,176,100,.7)' });
        break;
      case 'bcast':
        broadcast(tx, b);
        break;
    }
  }
}

// ------------------------------------------------------------ 场景

function sceneClock(b) {
  if (b > 16) return;
  let a = eOut(inv(0, 2.5, b));
  if (b > 8.6) a *= lerp(1, .13, eInOut(inv(8.6, 10.6, b)));
  a *= inv(16, 14.5, b);
  const cx = 960, cy = 500, R = 320;
  if (a > 0) {
    const k = Math.min(8, Math.floor(b));
    const e = b >= 9 ? 1 : backOut(clamp((b - k) / .15));
    const sec = 51 + k + e;
    const tsec = 59 * 60 + sec;
    const hAng = ((16 + tsec / 3600) % 12) / 12 * TAU - Math.PI / 2;
    const mAng = tsec / 3600 * TAU - Math.PI / 2;
    const sAng = sec / 60 * TAU - Math.PI / 2;
    ctx.save();
    ctx.globalAlpha = a;
    const pulse = b >= 8 ? 1 + .025 * Math.exp(-(b - 8) * 2.5) : 1;
    ctx.translate(cx, cy);
    ctx.scale(pulse, pulse);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, 'rgba(30,26,22,.95)');
    g.addColorStop(1, 'rgba(10,8,8,.98)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.strokeStyle = C.bone;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.stroke();
    ctx.globalAlpha = a * .45;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, R + 16, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, R - 20, 0, TAU); ctx.stroke();
    ctx.globalAlpha = a;
    for (let i = 0; i < 60; i++) {
      const an = i / 60 * TAU, big = i % 5 === 0, r1 = R - 26, r2 = r1 - (big ? 24 : 10);
      ctx.lineWidth = big ? 3 : 1.2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(an) * r1, Math.sin(an) * r1);
      ctx.lineTo(Math.cos(an) * r2, Math.sin(an) * r2);
      ctx.stroke();
    }
    ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'].forEach((s, i) => {
      const an = i / 12 * TAU - Math.PI / 2;
      text(s, Math.cos(an) * (R - 92), Math.sin(an) * (R - 92), { size: 36, fam: CINZEL, weight: 700 });
    });
    const hand = (ang, len, w, col, tail) => {
      ctx.save();
      ctx.rotate(ang);
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-tail, 0); ctx.lineTo(len, 0); ctx.stroke();
      ctx.restore();
    };
    hand(hAng, R * .5, 10, C.bone, 30);
    hand(mAng, R * .78, 6, C.bone, 40);
    hand(sAng, R * .86, 2.5, C.red, 60);
    ctx.fillStyle = C.red;
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.fill();
    ctx.restore();
  }
  // 钟声：一圈圈扩散的环
  if (b >= 8) {
    for (let k = 0; k < 3; k++) {
      const p = (b - 8 - k * .4) / 3;
      if (p < 0 || p > 1) continue;
      ctx.save();
      ctx.globalAlpha = (1 - p) * .5;
      ctx.strokeStyle = C.bone;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, R + p * 900, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }
  const ta = win(b, 8.05, 12.5, .4, .8);
  if (ta > 0) {
    text('第一日', 960, 900, { size: 28, ls: 16, color: C.dim, alpha: ta });
    text('17:00', 960, 962, { size: 62, fam: CINZEL, weight: 700, ls: 10, alpha: ta });
  }
}

function sceneTable(b) {
  if (b < 15.5 || b > 40.5) return;
  let a = eOut(inv(15.5, 17, b));
  if (b > 32) a *= lerp(1, .14, eInOut(inv(32, 33, b)));
  a *= inv(40.0, 39.6, b);
  const T = {
    cx: 960, cy: 495, scale: lerp(.8, .9, eInOut(inv(16, 32, b))), rot: (b - 16) * .004, alpha: a, mood: 'calm',
    ribRot: -(b - 16) * .002, b, eyes: [], glow: [],
  };
  for (let i = 1; i <= 15; i++) {
    const wg = TL.wakeGroups.find(g => g.seats.includes(i));
    const o = eOut(inv(wg.b + .05, wg.b + .75, b));
    T.eyes.push(o);
    T.glow.push(o);
  }
  if (b >= 24) {
    T.names = [];
    for (let i = 1; i <= 15; i++) {
      T.names.push(b < 28 + i * .03 ? TL.pool[Math.floor(hash(i, Math.floor(tb(b) * 14)) * TL.pool.length)] : null);
    }
    const out = inv(32.6, 32, b);
    T.nameAlpha = inv(24, 24.6, b) * out;
    T.redact = inv(28, 28.6, b) * out;
  }
  drawTable(T);
  let clock = '17:00';
  for (const g of TL.wakeGroups) if (b >= g.b) clock = g.clock;
  hud('第一日', clock, win(b, 15.8, 31.6, .6, .6));
}

function sceneHost(b) {
  if (b < 32 || b > 40) return;
  const a = win(b, 32, 40, .4, .3);
  ctx.save();
  ctx.globalAlpha = a * .6;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(236,230,217,.2)');
  g.addColorStop(1, 'rgba(236,230,217,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(880, 0); ctx.lineTo(1040, 0); ctx.lineTo(1560, H); ctx.lineTo(360, H); ctx.closePath(); ctx.fill();
  ctx.restore();
  TL.hostLines.forEach((h, li) => {
    const la = win(b, h.b - .6, h.until, .4, .4);
    if (la <= 0) return;
    const chars = [...h.text], n = chars.length, size = 64, step = Math.min(84, 1500 / n);
    const x0 = 960 - (n - 1) * step / 2, y = 480;
    chars.forEach((c, i) => {
      const x = x0 + i * step;
      const bd = h.b + (h.decodeEnd - h.b) * (i + 1) / n;
      const ap = clamp((b - (h.b - .6 + i * .025)) / .3);
      if (b < bd - .3) drawGlyph(li * 100 + i + 1, x, y, size * .88, C.bone, la * ap, 4.5);
      else if (b < bd) drawGlyph(Math.floor(hash(i, li, Math.floor(tb(b) * 24)) * 99999), x, y, size * .88, C.bone, la, 4.5);
      else {
        const k = clamp((b - bd) / .35);
        drawGlyph(li * 100 + i + 1, x, y, size * .88 * (1 + k * .5), C.bone, la * (1 - k) * .55, 4.5);
        text(c, x, y, { size, weight: 600, alpha: la * Math.min(1, k * 1.6), glow: 26 * (1 - k) + 2, glowColor: 'rgba(255,250,235,.9)' });
      }
    });
  });
}

function sceneCard(b) {
  if (b < 39.8 || b > 48.3) return;
  const fc = TL.firstCard;
  const a = win(b, 39.8, 48.3, .3, .4);
  spot(1250, 540, 560, a);
  const pin = backOut(clamp((b - fc.inB) / .7));
  let y = lerp(1450, 540, pin);
  let rot = lerp(-.35, .035, pin) + Math.sin(tb(b) * .9) * .012;
  if (b > 47.5) { const k = eIn(inv(47.5, 48.2, b)); y += k * 900; rot += k * .4; }
  const flip = eInOut(clamp((b - fc.flipB) / .45));
  drawCard({ x: 1250, y, s: .98, rot, flip, front: fc.front, back: fc.back, frontDesc: CARD_TEXT[fc.front], backDesc: CARD_TEXT[fc.back], numeral: 'I', alpha: a });
}

function sceneFlips(b) {
  if (b < 47.8 || b > 56.3) return;
  const fl = TL.flipCards, n = fl.length;
  const out = eIn(inv(55.5, 56.1, b));
  fl.forEach(([f, k], i) => {
    const b0 = TL.flipStartB + i;
    if (b < b0 - .05) return;
    const pin = backOut(clamp((b - b0) / .35));
    const x = 960 + (i - (n - 1) / 2) * 212;
    const y = lerp(-420, 500, pin) + out * 900 * (.6 + hash(i) * .8);
    const rot = (i % 2 ? .035 : -.035) + out * (hash(i, 3) - .5) * 1.2;
    const flip = eInOut(clamp((b - b0 - .5) / .3));
    drawCard({ x, y, s: .5, rot, flip, front: f, back: k, numeral: FLIP_NUMERALS[i] });
  });
}

function sceneCommission(b) {
  if (b < 56 || b > 60.1) return;
  const a = win(b, 56, 60.1, .05, .15);
  const cx = 960, cy = 470, R = 330;
  const x = inv(56, 58.2, b);
  const pos = (15 * 3 + 13) * (1 - Math.pow(1 - x, 3));
  const hi = Math.floor(pos) % 15, done = b >= 58.2;
  for (let i = 0; i < 15; i++) {
    const an = SEAT_ANG(i + 1), px = cx + Math.cos(an) * R, py = cy + Math.sin(an) * R;
    const isHi = i === hi;
    let al = isHi ? 1 : .35;
    if (done && !isHi) al = lerp(.35, .1, inv(58.2, 59, b));
    ctx.save();
    ctx.globalAlpha = a * al;
    ctx.fillStyle = isHi ? C.red : C.bone;
    if (isHi) { ctx.shadowColor = C.red; ctx.shadowBlur = 28; }
    const rad = isHi ? 11 * (done ? 1 + .25 * Math.sin(tb(b) * 8) : 1) : 7;
    ctx.beginPath(); ctx.arc(px, py, rad, 0, TAU); ctx.fill();
    ctx.restore();
    text(String(i + 1), cx + Math.cos(an) * (R + 40), cy + Math.sin(an) * (R + 40), { size: 18, fam: CINZEL, color: C.dim, alpha: a * .6 });
  }
  const k = clamp((b - 56) / .25);
  ctx.save();
  ctx.translate(cx, cy);
  const s = lerp(1.35, 1, eOut(k));
  ctx.scale(s, s);
  text('受命者', 0, 0, { size: 150, weight: 900, color: C.red, ls: 28, alpha: a * k, glow: 40, glowColor: 'rgba(211,25,58,.6)' });
  ctx.restore();
}

function monoDigits(str, x, y, size, col, alpha, glow) {
  const cell = size * .74, colon = size * .38;
  let w = 0;
  for (const c of str) w += c === ':' ? colon : cell;
  let cx = x - w / 2;
  for (const c of str) {
    const cw = c === ':' ? colon : cell;
    text(c, cx + cw / 2, y, { size, fam: CINZEL, weight: 700, color: col, alpha, glow, glowColor: col });
    cx += cw;
  }
}

function sceneCountdown(b) {
  if (b < 60 || b >= 64) return;
  const x = b - 60;
  const rem = Math.max(0, 86400 - (600 * x + 1200 * x * x * x));
  const str = `${pad2(Math.floor(rem / 3600))}:${pad2(Math.floor(rem % 3600 / 60))}:${pad2(Math.floor(rem % 60))}`;
  const k = clamp(x / .2);
  const red = b >= 62.4;
  ctx.save();
  ctx.translate(960, 470);
  const s = lerp(1.25, 1, eOut(k));
  ctx.scale(s, s);
  monoDigits(str, 0, 0, 190, red ? C.red : C.bone, k, red ? 34 : 8);
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = k * .5;
  ctx.strokeStyle = red ? C.red : C.bone;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(500, 345); ctx.lineTo(1420, 345); ctx.moveTo(500, 600); ctx.lineTo(1420, 600); ctx.stroke();
  ctx.restore();
}

const HALL = b => ({ cx: 960, cy: 495, scale: .9, rot: .064, mood: 'calm', ribRot: -.03, b, eyes: allOpen(), glow: Array(15).fill(.7) });

function sceneBlackout(b) {
  if (b < 64 || b > 68.1) return;
  let lights = 1;
  if (b >= 66) {
    const k = b - 66;
    lights = k < .08 ? .2 : k < .16 ? .9 : k < .22 ? .1 : k < .3 ? .5 : 0;
  }
  if (lights > 0) drawTable({ ...HALL(b), alpha: .32 * lights * inv(64, 64.4, b) });
  for (const hb of [66, 67]) {
    const p = b - hb;
    if (p >= 0 && p < 1) redVignette(Math.exp(-p * 4) * .25);
  }
  if (b > 66.6) {
    const bl = Math.abs(b - 67.75) < .08 ? Math.abs(b - 67.75) / .08 : 1;
    const o = eOut(inv(66.6, 67.4, b)) * bl;
    const ea = inv(66.6, 67, b) * inv(68.15, 67.95, b);
    const opt = { alpha: ea * .85, white: 'rgba(196,208,198,.85)', iris: '#1b2720', pupil: .86, line: 'rgba(196,208,198,.5)' };
    eye(870, 520, 130, o, { ...opt, look: .5 });
    eye(1050, 520, 130, o, { ...opt, look: .5 });
  }
}

function sceneDoor(b) {
  if (b < 67.6 || b > 72) return;
  const a = win(b, 67.6, 72, .25, .2);
  const cx = 960, cy = 600, dw = 420, dh = 680, x0 = cx - dw / 2, y0 = cy - dh / 2;
  const ang = b < 67.85 ? 1.25 : b < 68 ? 1.25 * (1 - eIn(inv(67.85, 68, b))) : 0;
  ctx.save();
  ctx.globalAlpha = a;
  if (ang > .01) { ctx.fillStyle = 'rgba(236,230,217,.16)'; ctx.fillRect(x0, y0, dw, dh); }
  ctx.strokeStyle = 'rgba(236,230,217,.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(x0 - 16, y0 - 16, dw + 32, dh + 16);
  const wv = dw * Math.cos(ang), depth = Math.sin(ang) * 70;
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x0 + wv, y0 - depth); ctx.lineTo(x0 + wv, y0 + dh + depth); ctx.lineTo(x0, y0 + dh);
  ctx.closePath();
  const lg = ctx.createLinearGradient(x0, 0, x0 + Math.max(wv, 1), 0);
  lg.addColorStop(0, '#1d1411');
  lg.addColorStop(1, '#2c1e18');
  ctx.fillStyle = lg;
  ctx.fill();
  ctx.strokeStyle = 'rgba(236,230,217,.5)';
  ctx.lineWidth = 2;
  ctx.stroke();
  if (ang < .3) {
    const c = Math.cos(ang);
    ctx.strokeStyle = 'rgba(236,230,217,.22)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + 50 * c, y0 + 60, (dw - 100) * c, dh * .38);
    ctx.strokeRect(x0 + 50 * c, y0 + 60 + dh * .38 + 40, (dw - 100) * c, dh * .38);
  }
  if (b >= 68) {
    const k = inv(68.05, 68.6, b), kx = x0 + dw - 56, ky = cy + 10;
    ctx.shadowColor = C.red;
    ctx.shadowBlur = 30 * k;
    ctx.fillStyle = `rgba(211,25,58,${.9 * k})`;
    ctx.beginPath(); ctx.arc(kx, ky - 8, 9, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.moveTo(kx - 6, ky - 4); ctx.lineTo(kx + 6, ky - 4); ctx.lineTo(kx + 3, ky + 20); ctx.lineTo(kx - 3, ky + 20); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgba(211,25,58,${.6 * k})`;
    ctx.fillRect(x0 + dw - 2, y0, 3, dh);
  }
  ctx.restore();
  // 撞击扬起的灰尘
  if (b >= 68 && b < 69.6) {
    const r = rng(68), p = (b - 68) / 1.6;
    ctx.save();
    for (let i = 0; i < 70; i++) {
      const sy = y0 + r() * dh, sp = 120 + r() * 380, an = (r() - .5) * 1.6, sz = 1 + r() * 2.5;
      const d = sp * eOut(p);
      ctx.globalAlpha = a * (1 - p) * .8;
      ctx.fillStyle = C.bone;
      ctx.fillRect(x0 + dw + Math.cos(an) * d, sy + Math.sin(an) * d + p * p * 60, sz, sz);
    }
    ctx.restore();
  }
  if (b >= 68.5) {
    const rem = Math.max(0, 3600 - (tb(b) - tb(68.5)));
    monoDigits(`${pad2(Math.floor(rem / 3600))}:${pad2(Math.floor(rem % 3600 / 60))}:${pad2(Math.floor(rem % 60))}`, 960, 1010, 34, C.red, a * inv(68.5, 68.9, b), 12);
  }
}

const SPLAT = (() => {
  const r = rng(72), s = [];
  for (let i = 0; i < 46; i++) { const an = r() * TAU, d = Math.pow(r(), 2) * 260; s.push({ an, d, rad: 20 + (1 - d / 260) * 70 * r() }); }
  for (let i = 0; i < 70; i++) { const an = r() * TAU, d = 260 + r() * 520; s.push({ an, d, rad: 3 + r() * 12, streak: r() < .45 }); }
  return s;
})();

function sceneBody(b) {
  if (b < 72 || b >= 76) return;
  const a = win(b, 72, 76, 0, .2);
  const g = ctx.createRadialGradient(960, 540, 0, 960, 540, 900);
  g.addColorStop(0, `rgba(120,8,24,${.55 * a})`);
  g.addColorStop(1, 'rgba(120,8,24,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const p = eOut(clamp((b - 72) / .12));
  ctx.save();
  ctx.globalAlpha = a * .92;
  ctx.fillStyle = '#7d0a1c';
  for (const s of SPLAT) {
    const x = 960 + Math.cos(s.an) * s.d * p, y = 540 + Math.sin(s.an) * s.d * p * .7;
    ctx.beginPath();
    if (s.streak) ctx.ellipse(x, y, s.rad * 3, s.rad * .6, s.an, 0, TAU);
    else ctx.arc(x, y, s.rad * p, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  const k = clamp((b - 72) / .15);
  ctx.save();
  ctx.translate(960, 540);
  const s = lerp(1.6, 1, eOut(k));
  ctx.scale(s, s);
  text('发现尸体。', 0, 0, { size: 180, weight: 900, ls: 24, color: C.bone, alpha: a * k, glow: 40, glowColor: 'rgba(211,25,58,.95)' });
  ctx.restore();
  hud('调查', '120:00', win(b, 74, 76, .3, 0), C.bone);
}

function sceneInvestigate(b) {
  if (b < 76 || b >= 84) return;
  const a = win(b, 76, 84, .05, .08), el = tb(b) - tb(76);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(-380 - el * 45, -260 - el * 16);
  ctx.strokeStyle = 'rgba(80,110,200,.5)';
  ctx.lineWidth = 1.5;
  PLAN.forEach(([x, y, w, h], i) => {
    ctx.strokeRect(x + 6, y + 6, w - 12, h - 12);
    if (i % 3 === 0) text(String(i % 15 + 1), x + w / 2, y + h / 2, { size: 18, fam: CINZEL, color: 'rgba(110,140,220,.5)' });
  });
  ctx.restore();
  const sy = (el * 520) % (H + 300) - 150;
  const sg = ctx.createLinearGradient(0, sy - 80, 0, sy + 80);
  sg.addColorStop(0, 'rgba(120,150,255,0)');
  sg.addColorStop(.5, `rgba(120,150,255,${.1 * a})`);
  sg.addColorStop(1, 'rgba(120,150,255,0)');
  ctx.fillStyle = sg;
  ctx.fillRect(0, sy - 80, W, 160);
  const rem = Math.max(0, Math.round(7200 * (1 - eIn(inv(76, 84.3, b)) * .98)));
  hud('调查', `${Math.floor(rem / 60)}:${pad2(rem % 60)}`, a);
  const c1 = TL.clues1, P1 = [[480, 320], [1440, 300], [560, 780], [1380, 770]];
  c1.words.forEach((w, i) => {
    const b0 = c1.b + i * c1.step;
    if (b < b0) return;
    const k = clamp((b - b0) / .15);
    const al = (b < 78 ? lerp(1, .5, inv(b0 + .3, b0 + .8, b)) : .5 * inv(78.6, 78, b)) * a;
    ctx.save();
    ctx.translate(...P1[i]);
    const s = lerp(1.5, 1, eOut(k));
    ctx.scale(s, s);
    text('「' + w + '」', 0, 0, { size: 60, weight: 700, ls: 4, alpha: al * k });
    ctx.restore();
  });
  const c2 = TL.clues2;
  c2.words.forEach((w, i) => {
    const b0 = c2.b + i * c2.step;
    const al = win(b, b0, b0 + .55, .02, .4) * a;
    if (al <= 0) return;
    const r = rng(300 + i);
    text(w, 300 + r() * 1320, 230 + r() * 600, { size: 44 + r() * 30, weight: 700, alpha: al, color: i % 3 === 0 ? C.red : C.bone, ls: 4 });
  });
}

function sceneTrialOpen(b) {
  if (b < 84 || b > 88.2) return;
  const k = clamp((b - 84) / .15), ta = win(b, 84, 85.7, 0, .5);
  if (ta > 0) {
    ctx.save();
    ctx.translate(960, 520);
    const s = lerp(1.5, 1, eOut(k)) * (1 + (b - 84) * .03);
    ctx.scale(s, s);
    text('开庭', 0, 0, { size: 250, weight: 900, ls: 90, alpha: ta * k, glow: 50, glowColor: 'rgba(211,25,58,.7)' });
    ctx.restore();
  }
  const ba = win(b, 85.2, 88.2, .4, .3);
  if (ba > 0) {
    const dis = inv(85.8, 87.3, b);
    ctx.save();
    ctx.translate(960, 500);
    ctx.globalAlpha = ba * (1 - dis) * .95;
    ctx.drawImage(BODY, -500, -300);
    ctx.globalAlpha = ba * eOut(inv(86.3, 87.6, b)) * .75;
    ctx.drawImage(CLOTH, -500, -300 + 14);
    ctx.fillStyle = C.bone;
    for (const p of BODY_PTS) {
      const t0 = 85.8 + p.d * 1.4;
      if (b < t0) continue;
      const u = (b - t0) / 1.1;
      if (u > 1) continue;
      ctx.globalAlpha = ba * (1 - u) * .9;
      ctx.fillRect(p.x + p.vx * u * 50, p.y - u * (70 + p.vy * 110), 2.4, 2.4);
    }
    ctx.restore();
  }
}

function trialTable(b) {
  return {
    cx: 960, cy: 560, scale: 1.08, squash: .56, rot: Math.sin(tb(b) * .15) * .03, mood: 'red', alpha: 1,
    ribRot: tb(b) * .01, b, eyes: allOpen(), glow: Array(15).fill(.35),
  };
}

function bubble(T, d, b, al) {
  const an = SEAT_ANG(d.seat);
  const [sx, sy] = proj(T, 300, an);
  const bx0 = T.cx + Math.cos(an + T.rot) * 640 * T.scale, by0 = T.cy + Math.sin(an + T.rot) * 365;
  const w = measure(d.text, 32, 500) + 92, h = 66;
  const bx = clamp(bx0 - w / 2, 40, W - 40 - w), by = clamp(by0 - h / 2, 180, 960 - h);
  const k = backOut(clamp((b - d.b) / .25));
  ctx.save();
  ctx.globalAlpha *= al;
  ctx.strokeStyle = 'rgba(211,25,58,.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(lerp(sx, bx + w / 2, k), lerp(sy, by + h / 2, k)); ctx.stroke();
  ctx.translate(bx + w / 2, by + h / 2);
  ctx.scale(k, k);
  ctx.fillStyle = 'rgba(8,5,6,.9)';
  ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, 4); ctx.fill();
  ctx.strokeStyle = 'rgba(236,230,217,.25)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = C.red;
  ctx.fillRect(-w / 2, -h / 2, 6, h);
  text(String(d.seat), -w / 2 + 34, 0, { size: 26, fam: CINZEL, weight: 700, color: C.red });
  text(d.text, -w / 2 + 64, 2, { size: 32, weight: 500, align: 'left' });
  ctx.restore();
}

function sceneDebate(b) {
  if (b < 87.8 || b > 96.2) return;
  const a = win(b, 87.8, 96.2, .3, .2);
  const T = trialTable(b);
  T.alpha = a;
  for (const d of TL.debate) if (b >= d.b && b < d.b + 1) T.glow[d.seat - 1] = 1;
  drawTable(T);
  hud('庭审', '辩论', a, C.red, SERIF);
  TL.debate.forEach((d, i) => {
    if (b < d.b) return;
    const newer = TL.debate[i + 1] && b >= TL.debate[i + 1].b;
    bubble(T, d, b, a * (newer ? .36 : 1));
  });
}

function voteState(b) {
  const v = TL.votes, counts = {}, last = {};
  v.targets.forEach((tgt, i) => {
    const b0 = v.b + i * v.step;
    if (b >= b0) { counts[tgt] = (counts[tgt] || 0) + 1; last[tgt] = b0; }
  });
  const glitching = {};
  for (const hm of TL.hiddenMods) {
    if (b >= hm.b) { counts[hm.seat] = (counts[hm.seat] || 0) + hm.delta; last[hm.seat] = hm.b; }
    else if (b >= hm.b - .3) glitching[hm.seat] = true;
  }
  return { counts, last, glitching };
}

function sceneVote(b) {
  if (b < 96 || b > 104.3) return;
  const a = win(b, 96, 104.3, .1, .3);
  const T = trialTable(b);
  T.alpha = a;
  T.glow = Array(15).fill(.28);
  drawTable(T);
  hud('庭审', '投票', a, C.red, SERIF);
  const v = TL.votes;
  v.targets.forEach((tgt, i) => {
    const b0 = v.b + i * v.step;
    if (b < b0) return;
    const k = eOut(clamp((b - b0) / .22));
    const [x1, y1] = proj(T, 300, SEAT_ANG(i + 1)), [x2, y2] = proj(T, 300, SEAT_ANG(tgt));
    const cx = lerp((x1 + x2) / 2, T.cx, .55), cy = lerp((y1 + y2) / 2, T.cy, .55);
    ctx.save();
    ctx.globalAlpha = a * (b - b0 < .4 ? .9 : .38);
    ctx.strokeStyle = C.red;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let s = 0; s <= 24; s++) {
      const u = s / 24 * k;
      const x = (1 - u) * (1 - u) * x1 + 2 * (1 - u) * u * cx + u * u * x2;
      const y = (1 - u) * (1 - u) * y1 + 2 * (1 - u) * u * cy + u * u * y2;
      if (s) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  });
  const { counts, last, glitching } = voteState(b);
  const seats = new Set([...Object.keys(counts).map(Number), ...Object.keys(glitching).map(Number)]);
  for (const seat of seats) {
    const [x, y] = proj(T, 300, SEAT_ANG(seat));
    const pop = 1 + .45 * Math.exp(-(b - (last[seat] ?? -9)) * 7);
    const doomed = seat === TL.verdictSeat && b >= 103;
    let label = String(counts[seat] ?? 0);
    if (glitching[seat]) label = String(Math.floor(hash(seat, Math.floor(tb(b) * 30)) * 10));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(x, y - 78);
    ctx.scale(pop, pop);
    ctx.fillStyle = doomed ? C.red : 'rgba(10,6,7,.92)';
    if (doomed) { ctx.shadowColor = C.red; ctx.shadowBlur = 30 + 10 * Math.sin(tb(b) * 9); }
    ctx.beginPath(); ctx.arc(0, 0, 30, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = glitching[seat] ? C.silver : C.red;
    ctx.lineWidth = 2;
    ctx.stroke();
    text(label, 0, 2, { size: 32, fam: CINZEL, weight: 700, color: C.bone });
    ctx.restore();
  }
}

function sceneVerdict(b) {
  if (b < 104 || b > 108.2) return;
  const a = win(b, 104, 108.2, 0, .3);
  const vb = TL.verdictB;
  const T = trialTable(b);
  T.alpha = .25 * a;
  T.glow = Array(15).fill(.2);
  T.crossed = TL.verdictSeat;
  T.crossK = inv(vb + .2, vb + .7, b);
  if (b >= vb) T.eyes[TL.verdictSeat - 1] = 1 - inv(vb, vb + .4, b);
  drawTable(T);
  let word = '判定错误。', col = C.red;
  if (b < vb) {
    const ok = hash(Math.floor((b - 104) * 8), 5) > .45;
    word = ok ? '判定正确。' : '判定错误。';
    col = ok ? C.bone : C.red;
  }
  const k = b >= vb ? clamp((b - vb) / .12) : 1;
  const s = b >= vb ? lerp(1.4, 1, eOut(k)) : 1 + (hash(Math.floor(b * 16), 2) - .5) * .06;
  ctx.save();
  ctx.translate(960, 520);
  ctx.scale(s, s);
  text(word, 0, 0, { size: 170, weight: 900, ls: 20, color: col, alpha: a, glow: 30, glowColor: col });
  ctx.restore();
}

function sceneEscape(b) {
  if (b < 108 || b >= 112) return;
  const a = win(b, 108, 112, .2, .2);
  const z = eInOut(inv(108, 112, b));
  const sc = lerp(.9, 1.3, z), an = SEAT_ANG(14);
  const T = {
    cx: 960 - Math.cos(an) * 300 * sc * z * .85, cy: 470 - Math.sin(an) * 300 * sc * z * .85,
    scale: sc, rot: 0, mood: 'red', alpha: a * .55, b, ribRot: 0,
    eyes: allOpen(), glow: Array(15).fill(.15), crossed: TL.verdictSeat, crossK: 1,
    redEye: Array(15).fill(false),
  };
  T.eyes[TL.verdictSeat - 1] = 0;
  T.glow[13] = .2 + .9 * inv(109.5, 110.2, b);
  T.redEye[13] = b >= 109.5;
  drawTable(T);
}

function sceneNames(b) {
  if (b < 112 || b > 120.05) return;
  const nm = TL.names, el = tb(b) - tb(112);
  ctx.save();
  for (let i = 0; i < 24; i++) {
    const an = i / 24 * TAU + el * .35;
    ctx.strokeStyle = `rgba(170,22,44,${i % 2 ? .18 : .32})`;
    ctx.lineWidth = i % 2 ? 1 : 2;
    ctx.beginPath(); ctx.moveTo(960 + Math.cos(an) * 120, 480 + Math.sin(an) * 120); ctx.lineTo(960 + Math.cos(an) * 1400, 480 + Math.sin(an) * 1400); ctx.stroke();
  }
  ctx.restore();
  for (let i = 0; i < nm.list.length; i++) {
    let b0, b1, x, y, size;
    if (i < nm.slowCount) { b0 = nm.b + i * nm.slow; b1 = b0 + nm.slow; x = 960; y = 470; size = 140; }
    else {
      const j = i - nm.slowCount, r = rng(500 + i);
      b0 = nm.b + nm.slowCount * nm.slow + j * nm.fast; b1 = b0 + .9;
      x = 300 + r() * 1320; y = 210 + r() * 560; size = 64 + r() * 34;
    }
    if (b < b0 || b > b1) continue;
    const k = clamp((b - b0) / .1);
    const al = i < nm.slowCount ? inv(b1, b1 - .08, b) : win(b, b0, b1, .02, .6);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((hash(i, 9) - .5) * .08);
    const s = lerp(1.25, 1, eOut(k));
    ctx.scale(s, s);
    text(nm.list[i], 0, 0, { size, weight: 900, ls: size * .08, color: i % 4 === 3 ? C.red : C.bone, alpha: al * k, glow: 20, glowColor: 'rgba(211,25,58,.6)' });
    ctx.restore();
  }
}

function sceneWall(b) {
  if (b < 120 || b >= 124) return;
  const a = win(b, 120, 124, .2, .3);
  const cx = 960, cy = 500, lw = 270, dh = 700, top = cy - dh / 2;
  const op = eInOut(inv(120.2, 121.5, b)), ang = op * 1.35;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.beginPath(); ctx.rect(cx - lw, top, 2 * lw, dh); ctx.clip();
  const sweep = lerp(-.4, 1.4, inv(121.5, 123.3, b));
  for (const f of FACETS) {
    const gl = b >= 121.5 ? Math.exp(-Math.pow((f.cx + f.cy * .4 - sweep) / .12, 2)) * f.k : 0;
    const v = Math.round(f.s + gl * 90);
    ctx.fillStyle = `rgb(${v},${v},${v + 8})`;
    ctx.beginPath();
    f.p.forEach(([u, w], i) => { const x = cx - lw + u * 2 * lw, y = top + w * dh; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = `rgba(150,150,175,${.12 + gl * .5})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = a;
  ctx.strokeStyle = 'rgba(236,230,217,.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(cx - lw - 18, top - 18, 2 * lw + 36, dh + 18);
  for (const side of [-1, 1]) {
    const hx = cx + side * lw, wv = lw * Math.cos(ang), depth = Math.sin(ang) * 80;
    const fx = hx - side * wv;
    ctx.beginPath();
    ctx.moveTo(hx, top); ctx.lineTo(fx, top - depth); ctx.lineTo(fx, top + dh + depth); ctx.lineTo(hx, top + dh);
    ctx.closePath();
    ctx.fillStyle = '#1e1512';
    ctx.fill();
    ctx.strokeStyle = 'rgba(236,230,217,.45)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

function sceneWish(b) {
  if (b < 124 || b >= 132) return;
  const a = win(b, 124, 132, .5, .25);
  const so = TL.seatOff, gold = b >= 128;
  const T = {
    cx: 960, cy: 470, scale: lerp(.86, 1.0, eInOut(inv(124, 132, b))), rot: -(b - 124) * .006, alpha: a,
    mood: gold ? 'gold' : 'calm', ribRot: 0, b, eyes: [], glow: [], seatCol: [],
    chand: lerp(.6, 1.6, inv(128, 130, b)),
  };
  for (let i = 1; i <= 15; i++) {
    const idx = so.order.indexOf(i);
    let o = 1, g = 1;
    if (idx >= 0) { const k = clamp((b - so.times[idx]) / .35); o = 1 - eOut(k); g = 1 - k; }
    T.eyes.push(o);
    T.glow.push(g);
    T.seatCol.push(i === so.survivor && gold ? '240,200,120' : null);
  }
  if (gold) T.glow[so.survivor - 1] = 1 + 1.6 * eOut(inv(128, 129.5, b));
  drawTable(T);
  if (gold) {
    ctx.save();
    ctx.globalAlpha = a * inv(128, 129.2, b) * .5;
    for (let i = 0; i < 18; i++) {
      const an = i / 18 * TAU + tb(b) * .05;
      const g = ctx.createLinearGradient(T.cx, T.cy, T.cx + Math.cos(an) * 900, T.cy + Math.sin(an) * 900);
      g.addColorStop(0, 'rgba(240,200,120,.35)');
      g.addColorStop(1, 'rgba(240,200,120,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(T.cx, T.cy);
      ctx.lineTo(T.cx + Math.cos(an - .04) * 1200, T.cy + Math.sin(an - .04) * 1200);
      ctx.lineTo(T.cx + Math.cos(an + .04) * 1200, T.cy + Math.sin(an + .04) * 1200);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

function sceneTitle(b) {
  const tt = TL.title;
  if (b < tt.b - .1) return;
  const a = inv(TL.totalBeats, tt.fadeB, b);
  const cx = 960, cy = 470;
  ctx.save();
  ctx.globalAlpha = a * .5 * eOut(inv(tt.b, tt.b + 1, b));
  ctx.strokeStyle = C.gold;
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(cx, cy, 400, 0, TAU); ctx.stroke();
  ctx.globalAlpha *= .5;
  ctx.beginPath(); ctx.arc(cx, cy, 372, 0, TAU); ctx.stroke();
  ctx.globalAlpha /= .5;
  for (let i = 1; i <= 15; i++) {
    const an = SEAT_ANG(i) + (b - tt.b) * .012;
    ctx.lineWidth = i === 1 ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(an) * 372, cy + Math.sin(an) * 372);
    ctx.lineTo(cx + Math.cos(an) * (i === 1 ? 430 : 418), cy + Math.sin(an) * (i === 1 ? 430 : 418));
    ctx.stroke();
  }
  ctx.restore();
  if (b >= tt.b) {
    const r = rng(132), el = b - tt.b;
    ctx.save();
    ctx.fillStyle = C.gold;
    for (let i = 0; i < 110; i++) {
      const an = r() * TAU, sp = 150 + r() * 650, life = 1.5 + r() * 3;
      if (el > life) continue;
      const d = sp * (1 - Math.exp(-el * 1.6));
      ctx.globalAlpha = a * (1 - el / life) * .9;
      ctx.fillRect(cx + Math.cos(an) * d, cy + Math.sin(an) * d * .8 + el * el * 6, 2.2, 2.2);
    }
    ctx.restore();
  }
  const k = clamp((b - tt.b) / .2);
  ctx.save();
  ctx.translate(cx, cy);
  const s = lerp(1.15, 1, eOut(k)) * (1 + Math.max(0, b - tt.b) * .004);
  ctx.scale(s, s);
  const grad = ctx.createLinearGradient(0, -110, 0, 110);
  grad.addColorStop(0, '#f4e2b2');
  grad.addColorStop(.5, '#ece6d9');
  grad.addColorStop(1, '#b8914d');
  text(tt.text, 0, 0, { size: 220, weight: 900, ls: 40, color: grad, alpha: a * k, glow: 40, glowColor: 'rgba(216,176,100,.45)' });
  ctx.restore();
  revealText(tt.tag, 960, 962, (tb(b) - tb(tt.tagB)) / 1.4, { size: 36, ls: 16, color: C.dim, alpha: a });
}

// ------------------------------------------------------------ 后期：色差、颗粒、暗角

function applyGlitch(amt, frame) {
  const px = Math.round(6 + amt * 18);
  tA.globalCompositeOperation = 'copy';
  tA.drawImage(cv, 0, 0);
  tB.globalCompositeOperation = 'copy';
  tB.drawImage(tmpA, 0, 0);
  tB.globalCompositeOperation = 'multiply';
  tB.fillStyle = '#ff0000';
  tB.fillRect(0, 0, W, H);
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(tmpB, px, 0);
  tB.globalCompositeOperation = 'copy';
  tB.drawImage(tmpA, 0, 0);
  tB.globalCompositeOperation = 'multiply';
  tB.fillStyle = '#00ffff';
  tB.fillRect(0, 0, W, H);
  ctx.drawImage(tmpB, -px, 0);
  ctx.globalCompositeOperation = 'source-over';
  const r = rng(frame * 31 + 7), n = Math.floor(3 + amt * 8);
  for (let i = 0; i < n; i++) {
    const y = r() * H, h = 8 + r() * 60 * amt, dx = (r() - .5) * 140 * amt;
    ctx.drawImage(tmpA, 0, y, W, h, dx, y, W, h);
  }
  ctx.restore();
}

function post(b, frame) {
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = .14;
  ctx.drawImage(grains[frame % 8], 0, 0, W, H);
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = .022;
  ctx.drawImage(grains[(frame + 3) % 8], 0, 0, W, H);
  ctx.restore();
  ctx.drawImage(vignette, 0, 0);
  const fl = (hash(frame, 9) - .5) * .05;
  if (fl > 0) { ctx.fillStyle = `rgba(0,0,0,${fl})`; ctx.fillRect(0, 0, W, H); }
}

// ------------------------------------------------------------ 主入口

const SCENES = [
  sceneClock, sceneTable, sceneHost, sceneCard, sceneFlips, sceneCommission, sceneCountdown,
  sceneBlackout, sceneDoor, sceneBody, sceneInvestigate, sceneTrialOpen, sceneDebate, sceneVote,
  sceneVerdict, sceneEscape, sceneNames, sceneWall, sceneWish, sceneTitle,
];

function renderFrame(t, frame = Math.round(t * TL.fps)) {
  const b = t / BEAT;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = '#050407';
  ctx.fillRect(0, 0, W, H);
  const sh = shakeAt(b);
  ctx.save();
  ctx.translate(sh.x, sh.y);
  dust(b, .55 * win(b, 8, 32, 2, 2), '236,230,217', 70, 5);
  dust(b, .5 * win(b, 124, 140, 1, 3), b >= 128 ? '216,176,100' : '236,230,217', 60, 11);
  for (const s of SCENES) s(b);
  ctx.restore();
  const g = glitchAmt(b);
  if (g > .05) applyGlitch(g, frame);
  ctx.save();
  ctx.translate(sh.x, sh.y);
  drawTexts(b);
  ctx.restore();
  drawFlashes(b);
  post(b, frame);
}

const EXTRA_TEXT = '0123456789:·「」■—…，。？！第一日庭审辩论投票调查正位逆位受命者发现尸体开庭判定正确错误XIVLC'
  + Object.values(CARD_TEXT).join('') + 'IIIIVVIIIXXIIXIIIXIVXV';

window.renderFrame = renderFrame;
window.sceneReady = (async () => {
  const all = JSON.stringify(TL) + EXTRA_TEXT;
  const specs = [[400, SERIF], [500, SERIF], [600, SERIF], [700, SERIF], [900, SERIF], [500, SANS], [400, CINZEL], [700, CINZEL]];
  await Promise.all(specs.map(([w, f]) => document.fonts.load(`${w} 40px ${f}`, all)));
  await document.fonts.ready;
  return true;
})();
