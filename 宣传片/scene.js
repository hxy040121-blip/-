'use strict';
/*
 * 《夙与愿》宣传片画面。
 * renderFrame(t, frame) 按秒绘制一帧，结果只取决于 t，不依赖真实时间，
 * 所以可以多进程分段渲染再拼接。节拍、文字和事件全部来自 timeline.json。
 */

// timeline.json 里带 sec 的条目用段内相对拍数，这里统一换算成绝对拍数
const REL = ['b', 'until', 'decodeEnd', 'inB', 'flipB', 'tagB', 'fadeB', 'coinGone', 'appear', 'coinsAppear'];
const TL = (() => {
  const tl = JSON.parse(JSON.stringify(window.TIMELINE));
  const start = {}, secs = {};
  let pos = 0;
  for (const [name, len] of tl.sections) { start[name] = pos; secs[name] = [pos, pos + len]; pos += len; }
  tl.sections = secs;
  tl.totalBeats = pos;
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    if (typeof o.sec === 'string') {
      const base = start[o.sec];
      for (const k of REL) if (typeof o[k] === 'number') o[k] += base;
      if (Array.isArray(o.times)) o.times = o.times.map(t => t + base);
    }
    Object.values(o).forEach(walk);
  })(tl);
  return tl;
})();
const S = name => TL.sections[name][0];
const E = name => TL.sections[name][1];
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
  [S('intro'), 6, .8], [S('mansion') + 4, 4, .4], [S('mansion') + 8, 4, .4], [S('mansion') + 12, 4, .4],
  [S('host'), 5, .6], [TL.firstCard.flipB + .2, 7, .5], [TL.coinFlip.until, 4, .3],
  [TL.plaque.b + (TL.plaque.rows.length - 1) * TL.plaque.step + .2, 8, .5],
  [S('commission'), 14, .8], [S('countdown'), 10, .6], [S('door'), 26, .9], [S('body'), 24, 1],
  [S('trialOpen'), 18, .9], [TL.verdict.b, 22, 1], [S('wall') + 1.5, 8, 1.2], [S('title'), 16, 1.2],
];
const FLASHES = [ // [拍, rgb, 强度, 衰减拍]
  [S('intro'), '255,250,235', .32, .6], [S('commission'), '211,25,58', .45, .8], [S('countdown'), '255,250,235', .2, .4],
  [S('door'), '255,250,235', .7, .5], [S('body'), '211,25,58', .6, 1.0], [S('trialOpen'), '255,250,235', .5, .7],
  [TL.verdict.b, '211,25,58', .55, .9], [S('title'), '255,240,210', .5, 1.0],
];
TL.debate.forEach(d => IMPACTS.push([d.b, 4, .3]));
for (let i = 0; i < TL.names.slowCount; i++) {
  const b = TL.names.b + i * TL.names.slow;
  IMPACTS.push([b, 7, .3]);
  FLASHES.push([b, '211,25,58', .16, .35]);
}
const GLITCH = [
  [S('commission'), S('commission') + .5, .6], [S('body'), S('body') + .35, .5], [TL.clues2.b, E('investigate'), .22],
  [S('verdict'), TL.verdict.b + .25, 1], [S('names') + 4, E('names'), .18], [S('title'), S('title') + .25, .35],
];

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
  else cardFace(c.back, '逆位', c.backDesc, c.numeral);
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

// ------------------------------------------------------------ 逐字解码（馆内字形 → 读得懂的字）

const isWide = c => /[⺀-鿿　-〿＀-￯「」《》·—]/.test(c);

function decodeLine(str, x, y, b, b0, b1, o = {}) {
  const chars = [...str], n = chars.length, size = o.size || 30;
  const adv = chars.map(c => (isWide(c) ? size * 1.04 : size * .64));
  const total = adv.reduce((s, v) => s + v, 0);
  let cx = o.align === 'left' ? x : o.align === 'right' ? x - total : x - total / 2;
  const col = o.color || C.bone, alpha = o.alpha ?? 1, seed = o.seed || 1;
  chars.forEach((c, i) => {
    const mid = cx + adv[i] / 2;
    cx += adv[i];
    if (c === ' ' || c === '　') return;
    const bd = b0 + (b1 - b0) * (i + 1) / n;
    const ap = clamp((b - (b0 - .4 + i * .02)) / .25);
    const gs = size * (isWide(c) ? .84 : .6);
    if (b < bd - .22) drawGlyph(seed * 100 + i, mid, y, gs, col, alpha * ap, Math.max(1.6, size * .075));
    else if (b < bd) drawGlyph(Math.floor(hash(seed, i, Math.floor(tb(b) * 24)) * 99999), mid, y, gs, col, alpha, Math.max(1.6, size * .075));
    else {
      const k = clamp((b - bd) / .3);
      text(c, mid, y, { size, weight: o.weight || 500, fam: o.fam || SERIF, color: col, alpha: alpha * Math.min(1, k * 1.8), glow: o.glow ?? 16 * (1 - k), glowColor: o.glowColor || 'rgba(255,250,235,.8)' });
    }
  });
  return total;
}

// ------------------------------------------------------------ 场景

function sceneClock(b) {
  const c0 = S('clock'), bell = S('intro'), end = S('table');
  if (b > end) return;
  const x = b - c0, n = bell - c0;
  let a = eOut(inv(0, 2.5, x));
  if (b > bell + .6) a *= lerp(1, .13, eInOut(inv(bell + .6, bell + 2.6, b)));
  a *= inv(end, end - 1.5, b);
  const cx = 960, cy = 500, R = 320;
  if (a > 0) {
    const k = Math.min(n, Math.floor(x));
    const e = x >= n + 1 ? 1 : backOut(clamp((x - k) / .15));
    const sec = 59 - n + k + e;
    const tsec = 59 * 60 + sec;
    const hAng = ((16 + tsec / 3600) % 12) / 12 * TAU - Math.PI / 2;
    const mAng = tsec / 3600 * TAU - Math.PI / 2;
    const sAng = sec / 60 * TAU - Math.PI / 2;
    ctx.save();
    ctx.globalAlpha = a;
    const pulse = b >= bell ? 1 + .025 * Math.exp(-(b - bell) * 2.5) : 1;
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
  if (b >= bell) {
    for (let k = 0; k < 3; k++) {
      const p = (b - bell - k * .4) / 3;
      if (p < 0 || p > 1) continue;
      ctx.save();
      ctx.globalAlpha = (1 - p) * .5;
      ctx.strokeStyle = C.bone;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, R + p * 900, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }
  const ta = win(b, bell + .05, bell + 4.5, .4, .8);
  if (ta > 0) {
    text('第一日', 960, 900, { size: 28, ls: 16, color: C.dim, alpha: ta });
    text('17:00', 960, 962, { size: 62, fam: CINZEL, weight: 700, ls: 10, alpha: ta });
  }
}

function sceneTable(b) {
  const t0 = S('table'), t1 = E('table');
  if (b < t0 - .5 || b >= t1) return;
  const a = eOut(inv(t0 - .5, t0 + 1, b)) * inv(t1, t1 - .3, b);
  const T = {
    cx: 960, cy: 495, scale: lerp(.8, .9, eInOut(inv(t0, t1, b))), rot: (b - t0) * .004, alpha: a, mood: 'calm',
    ribRot: -(b - t0) * .002, b, eyes: [], glow: [],
  };
  for (let i = 1; i <= 15; i++) {
    const wg = TL.wakeGroups.find(g => g.seats.includes(i));
    const o = eOut(inv(wg.b + .05, wg.b + .75, b));
    T.eyes.push(o);
    T.glow.push(o);
  }
  if (b >= t0 + 8) {
    T.names = [];
    for (let i = 1; i <= 15; i++) {
      T.names.push(b < t0 + 12 + i * .03 ? TL.pool[Math.floor(hash(i, Math.floor(tb(b) * 14)) * TL.pool.length)] : null);
    }
    T.nameAlpha = inv(t0 + 8, t0 + 8.6, b);
    T.redact = inv(t0 + 12, t0 + 12.6, b);
  }
  drawTable(T);
  let clock = '17:00';
  for (const g of TL.wakeGroups) if (b >= g.b) clock = g.clock;
  hud('第一日', clock, win(b, t0 - .2, t1 - .4, .6, .6));
}

// ---------- 洋馆的异常

function windowLight(h) {
  if (h >= 5 && h < 7) return (h - 5) / 2;
  if (h >= 7 && h < 17) return 1;
  if (h >= 17 && h < 19) return 1 - (h - 17) / 2;
  return 0;
}

function vWindow(u) {
  const hour = (5 + u / 4 * 24) % 24, L = windowLight(hour);
  const wg = ctx.createLinearGradient(0, 0, 0, H);
  wg.addColorStop(0, '#0e0c0b');
  wg.addColorStop(1, '#060505');
  ctx.fillStyle = wg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(236,230,217,.05)';
  ctx.lineWidth = 2;
  for (let x = 80; x < W; x += 170) { ctx.beginPath(); ctx.moveTo(x, 600); ctx.lineTo(x, 840); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(0, 600); ctx.lineTo(W, 600); ctx.moveTo(0, 842); ctx.lineTo(W, 842); ctx.stroke();
  const x0 = 720, x1 = 1200, top = 120, bot = 800, r = (x1 - x0) / 2, mx = (x0 + x1) / 2;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x0, bot); ctx.lineTo(x0, top + r);
    ctx.arc(mx, top + r, r, Math.PI, 0);
    ctx.lineTo(x1, bot); ctx.closePath();
  };
  spot(mx, (top + bot) / 2, 760, L * 1.6, '215,226,242');
  const fg = ctx.createLinearGradient(0, top, 0, bot);
  fg.addColorStop(0, `rgba(226,233,242,${.06 + .84 * L})`);
  fg.addColorStop(1, `rgba(196,208,224,${.05 + .7 * L})`);
  path(); ctx.fillStyle = fg; ctx.fill();
  ctx.save();
  path(); ctx.clip();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha *= .12 + .2 * L;
  ctx.drawImage(grains[2], x0, top, x1 - x0, bot - top);
  ctx.restore();
  ctx.strokeStyle = '#0b0a09';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(mx, top); ctx.lineTo(mx, bot);
  ctx.moveTo(x0, top + r); ctx.lineTo(x1, top + r);
  ctx.moveTo(x0, (top + r + bot) / 2); ctx.lineTo(x1, (top + r + bot) / 2);
  ctx.stroke();
  path(); ctx.strokeStyle = 'rgba(236,230,217,.4)'; ctx.lineWidth = 3; ctx.stroke();
  // 地上的光：不偏不移，没有窗棂的影子
  const pg = ctx.createLinearGradient(0, 850, 0, H);
  pg.addColorStop(0, `rgba(215,226,242,${.26 * L})`);
  pg.addColorStop(1, 'rgba(215,226,242,0)');
  ctx.fillStyle = pg;
  ctx.beginPath(); ctx.moveTo(x0 - 10, 850); ctx.lineTo(x1 + 10, 850); ctx.lineTo(x1 + 70, H); ctx.lineTo(x0 - 70, H); ctx.closePath(); ctx.fill();
  // 墙上的钟一日走完
  const cx = 1560, cy = 290, cr = 92;
  ctx.fillStyle = 'rgba(8,7,7,.9)';
  ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(236,230,217,.6)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU); ctx.stroke();
  for (let i = 0; i < 12; i++) {
    const an = i / 12 * TAU;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(an) * (cr - 8), cy + Math.sin(an) * (cr - 8)); ctx.lineTo(cx + Math.cos(an) * (cr - 20), cy + Math.sin(an) * (cr - 20)); ctx.stroke();
  }
  const hA = (hour % 12) / 12 * TAU - Math.PI / 2, mA = (hour % 1) * TAU - Math.PI / 2;
  ctx.lineCap = 'round';
  ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(hA) * cr * .5, cy + Math.sin(hA) * cr * .5); ctx.stroke();
  ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(mA) * cr * .78, cy + Math.sin(mA) * cr * .78); ctx.stroke();
  text(`${pad2(Math.floor(hour))}:${pad2(Math.floor((hour % 1) * 60))}`, cx, cy + cr + 40, { size: 30, fam: CINZEL, weight: 700, color: C.dim });
}

function bonePath(pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

function vSkeleton(u) {
  const g = ctx.createRadialGradient(960, 520, 50, 960, 520, 1100);
  g.addColorStop(0, '#191a1e');
  g.addColorStop(1, '#050506');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 烟晶展台
  ctx.fillStyle = 'rgba(70,70,82,.5)';
  ctx.fillRect(330, 742, 1260, 22);
  ctx.fillStyle = 'rgba(30,30,38,.85)';
  ctx.fillRect(330, 764, 1260, 40);
  ctx.strokeStyle = 'rgba(200,200,220,.35)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(330, 742); ctx.lineTo(1590, 742); ctx.stroke();
  ctx.save();
  ctx.translate(960 + lerp(70, -70, u / 4), 560);
  ctx.scale(1.08, 1.08);
  ctx.strokeStyle = 'rgba(205,210,220,.55)'; ctx.lineWidth = 3;
  for (const sx of [-250, 60]) { ctx.beginPath(); ctx.moveTo(sx, -60); ctx.lineTo(sx, 168); ctx.stroke(); }
  const bone = 'rgba(230,228,216,.9)';
  ctx.strokeStyle = bone; ctx.fillStyle = bone;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(230,230,220,.35)'; ctx.shadowBlur = 14;
  // 脊柱
  const sp = s => [lerp(-380, 200, s), -70 - Math.sin(s * Math.PI) * 30];
  for (let i = 0; i < 17; i++) {
    const [x, y] = sp(i / 16);
    ctx.beginPath(); ctx.ellipse(x, y, 14, 9, 0, 0, TAU); ctx.fill();
  }
  // 十九节尾椎，逐渐收细
  for (let i = 0; i < 19; i++) {
    const s = i / 18, x = 222 + s * 430, y = -72 + s * s * 140;
    ctx.beginPath(); ctx.ellipse(x, y, 12 * (1 - s * .75), 8 * (1 - s * .7), s * .6, 0, TAU); ctx.fill();
  }
  // 颈与头骨
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.ellipse(-400 - i * 22, -62 + i * 6, 10, 8, 0, 0, TAU); ctx.fill(); }
  ctx.save();
  ctx.translate(-520, -40);
  ctx.rotate(-.12);
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.ellipse(0, 0, 82, 36, 0, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-80, 10); ctx.quadraticCurveTo(-20, 52, 60, 30); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#0b0b0d';
  ctx.beginPath(); ctx.ellipse(-22, -6, 13, 9, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(12, -10, 9, 7, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = bone; ctx.lineWidth = 2;
  for (let i = 0; i < 7; i++) { const x = -70 + i * 12; ctx.beginPath(); ctx.moveTo(x, 14 + i * 2); ctx.lineTo(x + 2, 24 + i * 2); ctx.stroke(); }
  ctx.restore();
  ctx.shadowBlur = 14;
  // 四对弧形肋骨
  ctx.lineWidth = 6;
  [-310, -230, -150, -70].forEach((x, i) => {
    const [, y] = sp((x + 380) / 580);
    for (const far of [1, 0]) {
      ctx.globalAlpha *= far ? .45 : 1;
      const dx = far ? 14 : 0;
      ctx.beginPath(); ctx.moveTo(x + dx, y + 6); ctx.quadraticCurveTo(x - 70 + dx, 30, x + 24 + dx, 92 + i * 3); ctx.stroke();
      ctx.globalAlpha /= far ? .45 : 1;
    }
  });
  // 双胸骨
  ctx.lineWidth = 11;
  bonePath([[-336, 94], [-236, 100]]);
  bonePath([[-176, 102], [-52, 98]]);
  // 前四肢（两对，每肢三指），后两肢（每肢四指）；卧姿，肢体折在身下
  const limb = (x, y, fingers, far) => {
    ctx.globalAlpha *= far ? .45 : 1;
    const dx = far ? 18 : 0;
    ctx.lineWidth = 9;
    bonePath([[x + dx, y], [x - 46 + dx, 70], [x + 34 + dx, 118]]);
    ctx.lineWidth = 3.5;
    for (let f = 0; f < fingers; f++) bonePath([[x + 34 + dx, 118], [x + 34 + dx - 34 + f * 12, 150 + (f % 2) * 4]]);
    ctx.globalAlpha /= far ? .45 : 1;
  };
  for (const [x, f] of [[-330, 3], [-196, 3], [150, 4]]) { limb(x, -60, f, true); limb(x, -60, f, false); }
  ctx.restore();
}

function vTapestry(u) {
  ctx.fillStyle = '#060607';
  ctx.fillRect(0, 0, W, H);
  const x0 = 300, x1 = 1620, y0 = 60, y1 = 990;
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, '#0f3034');
  g.addColorStop(1, '#091d20');
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
  ctx.strokeStyle = 'rgba(200,220,220,.045)';
  ctx.lineWidth = 1;
  for (let k = -H; k < W; k += 7) { ctx.beginPath(); ctx.moveTo(k, y0); ctx.lineTo(k + (y1 - y0), y1); ctx.stroke(); }
  // 星宿与铂金星轨
  const r = rng(412);
  ctx.strokeStyle = 'rgba(225,228,232,.28)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.ellipse(960, 500, 300 + i * 150, 120 + i * 60, -.15 + i * .08 + u * .01, 0, TAU);
    ctx.stroke();
  }
  for (let c = 0; c < 9; c++) {
    const cx = x0 + 80 + r() * (x1 - x0 - 160), cy = y0 + 80 + r() * 600;
    let px = cx, py = cy;
    ctx.strokeStyle = 'rgba(200,200,205,.35)';
    ctx.fillStyle = 'rgba(225,225,230,.8)';
    for (let s = 0; s < 4; s++) {
      const nx = px + (r() - .5) * 120, ny = py + (r() - .5) * 90;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(nx, ny); ctx.stroke();
      ctx.beginPath(); ctx.arc(nx, ny, 2 + r() * 2.5, 0, TAU); ctx.fill();
      px = nx; py = ny;
    }
  }
  // 花枝
  ctx.strokeStyle = 'rgba(196,176,120,.4)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 7; i++) {
    const bx = x0 + 60 + i * 200;
    ctx.beginPath(); ctx.moveTo(bx, y1 - 110); ctx.quadraticCurveTo(bx + 60, y1 - 200, bx + 30, y1 - 280); ctx.stroke();
    for (let l = 0; l < 4; l++) { ctx.beginPath(); ctx.ellipse(bx + 30 + l * 8, y1 - 150 - l * 34, 12, 5, -.6, 0, TAU); ctx.stroke(); }
  }
  // 白月升起，蓝月沉落
  const k = eInOut(u / 4);
  const moon = (x, y, col, glow) => {
    const mg = ctx.createRadialGradient(x, y, 0, x, y, 230);
    mg.addColorStop(0, `rgba(${glow},.35)`);
    mg.addColorStop(1, `rgba(${glow},0)`);
    ctx.fillStyle = mg;
    ctx.fillRect(x - 230, y - 230, 460, 460);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, 78, 0, TAU); ctx.fill();
  };
  moon(640, lerp(760, 330, k), '#f1eee4', '241,238,228');
  moon(1290, lerp(300, 740, k), '#7f9be0', '127,155,224');
  ctx.restore();
  ctx.strokeStyle = 'rgba(200,205,210,.6)';
  ctx.lineWidth = 3;
  ctx.strokeRect(x0 + 16, y0 + 16, x1 - x0 - 32, y1 - y0 - 32);
  ctx.strokeStyle = 'rgba(214,190,130,.45)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0 + 26, y0 + 26, x1 - x0 - 52, y1 - y0 - 52);
  ctx.fillStyle = '#c8ccd2';
  ctx.fillRect(x0 - 30, y0 - 14, x1 - x0 + 60, 8);
}

const PORTRAIT_ITEMS = ['星盘', '分规', '花枝', '书卷', '透镜', '羽笔', '航图', '沙漏'];
function portraitItem(i, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#c9a96a';
  ctx.fillStyle = '#c9a96a';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  switch (i) {
    case 0: ctx.arc(0, 0, 22, 0, TAU); ctx.moveTo(14, 0); ctx.arc(0, 0, 14, 0, TAU); ctx.moveTo(-22, 0); ctx.lineTo(22, 0); ctx.moveTo(0, -22); ctx.lineTo(0, 22); break;
    case 1: ctx.moveTo(0, -24); ctx.lineTo(-14, 24); ctx.moveTo(0, -24); ctx.lineTo(14, 24); ctx.moveTo(5, -24); ctx.arc(0, -24, 5, 0, TAU); break;
    case 2: ctx.moveTo(-6, 26); ctx.quadraticCurveTo(10, 0, -2, -26); for (let l = 0; l < 3; l++) { ctx.moveTo(4 + 9, 12 - l * 14); ctx.ellipse(4, 12 - l * 14, 9, 4, -.5, 0, TAU); } break;
    case 3: ctx.rect(-20, -12, 40, 24); ctx.moveTo(-14, -12); ctx.arc(-20, 0, 12, -Math.PI / 2, Math.PI / 2, true); ctx.moveTo(26, -12); ctx.arc(20, 0, 12, -Math.PI / 2, Math.PI / 2); break;
    case 4: ctx.arc(-4, -6, 16, 0, TAU); ctx.moveTo(8, 6); ctx.lineTo(22, 24); break;
    case 5: ctx.ellipse(4, -6, 7, 24, .5, 0, TAU); ctx.moveTo(-8, 18); ctx.lineTo(-16, 28); break;
    case 6: ctx.rect(-22, -16, 44, 32); for (let l = 0; l < 3; l++) { ctx.moveTo(-18, -8 + l * 9); ctx.quadraticCurveTo(0, -14 + l * 9, 18, -8 + l * 9); } break;
    case 7: ctx.moveTo(-14, -24); ctx.lineTo(14, -24); ctx.lineTo(-14, 24); ctx.lineTo(14, 24); ctx.closePath(); break;
  }
  ctx.stroke();
  ctx.restore();
}

function vPortraits(u) {
  const wg = ctx.createLinearGradient(0, 0, 0, H);
  wg.addColorStop(0, '#120c09');
  wg.addColorStop(1, '#070504');
  ctx.fillStyle = wg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(236,210,170,.04)';
  for (let x = 0; x < W; x += 46) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  const turn = eOut(inv(3, 3.35, u));
  for (let i = 0; i < 8; i++) {
    const ap = clamp((u - i * .22) / .35);
    if (ap <= 0) continue;
    const x = 960 + (i - 3.5) * 212, y = 450, w = 176, h = 302;
    ctx.save();
    ctx.globalAlpha *= ap;
    spot(x, y - 210, 240, 1.4, '255,225,180');
    ctx.fillStyle = '#21110c';
    ctx.fillRect(x - w / 2 - 12, y - h / 2 - 12, w + 24, h + 24);
    ctx.strokeStyle = 'rgba(200,165,100,.55)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - w / 2 - 4, y - h / 2 - 4, w + 8, h + 8);
    const pg = ctx.createLinearGradient(0, y - h / 2, 0, y + h / 2);
    pg.addColorStop(0, '#2e2318');
    pg.addColorStop(1, '#120d09');
    ctx.fillStyle = pg;
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x - w / 2, y - h / 2, w, h); ctx.clip();
    ctx.fillStyle = '#0b0806';
    ctx.beginPath(); ctx.ellipse(x, y + 128, 74, 70, 0, 0, TAU); ctx.fill();
    // 没有脸的头；最后一齐朝画外转来
    const dx = -(i - 3.5) * 4 * turn;
    ctx.save();
    ctx.translate(x + dx, y + 6);
    ctx.rotate(-(i - 3.5) * .035 * turn);
    const hg = ctx.createRadialGradient(-6, -12, 4, 0, 0, 44);
    hg.addColorStop(0, '#4a3d31');
    hg.addColorStop(1, '#1f1812');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.ellipse(0, 0, 32, 40, 0, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.restore();
    portraitItem(i, x, y + 104);
    ctx.restore();
  }
}

function drawPlacards(b) {
  TL.placards.forEach((p, idx) => {
    const a = win(b, p.b - .4, p.until, .3, .3);
    if (a <= 0) return;
    const woven = p.kind === 'woven';
    const size = woven ? 30 : 28;
    const x = idx === 0 ? 300 : 960, y = woven ? 930 : 905, align = idx === 0 ? 'left' : 'center';
    if (!woven) {
      const w = [...p.text].reduce((s, c) => s + (isWide(c) ? size * 1.04 : size * .64), 0) + 56;
      const bx = align === 'left' ? x - 28 : x - w / 2;
      ctx.save();
      ctx.globalAlpha *= a;
      ctx.fillStyle = 'rgba(10,10,12,.85)';
      ctx.fillRect(bx, y - 30, w, 60);
      ctx.strokeStyle = 'rgba(201,206,214,.7)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, y - 30, w, 60);
      ctx.strokeRect(bx + 5, y - 25, w - 10, 50);
      ctx.restore();
    }
    decodeLine(p.text, x, y, b, p.b, p.decodeEnd, { size, align, color: woven ? '#d9c38c' : C.silver, alpha: a, seed: 50 + idx });
  });
}

function sceneMansion(b) {
  const m = S('mansion');
  if (b < m || b >= E('mansion')) return;
  const r = b - m, v = Math.min(3, Math.floor(r / 4)), u = r - v * 4;
  const a = Math.min(inv(0, .15, u), inv(4, 3.82, u));
  ctx.save();
  ctx.globalAlpha = a;
  const z = 1 + u * .012;
  ctx.translate(960, 540); ctx.scale(z, z); ctx.translate(-960, -540);
  [vWindow, vSkeleton, vTapestry, vPortraits][v](u);
  ctx.restore();
  drawPlacards(b);
}

function sceneHost(b) {
  const h0 = S('host');
  if (b < h0 || b >= E('host')) return;
  const a = win(b, h0, E('host'), .4, .3);
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
    const chars = [...h.text], n = chars.length, size = 72, step = Math.min(96, 1500 / n);
    const x0 = 960 - (n - 1) * step / 2, y = 500;
    chars.forEach((c, i) => {
      const x = x0 + i * step;
      const bd = h.b + (h.decodeEnd - h.b) * (i + 1) / n;
      const ap = clamp((b - (h.b - .6 + i * .025)) / .3);
      if (b < bd - .3) drawGlyph(li * 100 + i + 1, x, y, size * .88, C.bone, la * ap, 5);
      else if (b < bd) drawGlyph(Math.floor(hash(i, li, Math.floor(tb(b) * 24)) * 99999), x, y, size * .88, C.bone, la, 5);
      else {
        const k = clamp((b - bd) / .35);
        drawGlyph(li * 100 + i + 1, x, y, size * .88 * (1 + k * .5), C.bone, la * (1 - k) * .55, 5);
        text(c, x, y, { size, weight: 600, alpha: la * Math.min(1, k * 1.6), glow: 26 * (1 - k) + 2, glowColor: 'rgba(255,250,235,.9)' });
      }
    });
  });
}

function sceneCard(b) {
  const c0 = S('card'), c1 = E('card');
  if (b < c0 || b >= c1 + .3) return;
  const fc = TL.firstCard;
  const a = win(b, c0, c1 + .3, .3, .4);
  spot(960, 540, 600, a);
  const pin = backOut(clamp((b - fc.inB) / .7));
  let y = lerp(1450, 540, pin);
  let rot = lerp(-.35, .03, pin) + Math.sin(tb(b) * .9) * .012;
  if (b > c1 - .5) { const k = eIn(inv(c1 - .5, c1 + .2, b)); y += k * 900; rot += k * .4; }
  const flip = eInOut(clamp((b - fc.flipB) / .45));
  drawCard({ x: 960, y, s: .98, rot, flip, front: fc.front, back: fc.back, frontDesc: CARD_TEXT[fc.front], backDesc: CARD_TEXT[fc.back], numeral: 'I', alpha: a });
}

function sceneFlips(b) {
  const f0 = S('flips');
  if (b < f0 - .2 || b > E('flips') + .3) return;
  const fl = TL.flipCards, n = fl.length;
  const out = eIn(inv(E('flips') - .5, E('flips') + .1, b));
  fl.forEach(([f, k], i) => {
    const b0 = TL.flipStart.b + i;
    if (b < b0 - .05) return;
    const pin = backOut(clamp((b - b0) / .35));
    const x = 960 + (i - (n - 1) / 2) * 212;
    const y = lerp(-420, 500, pin) + out * 900 * (.6 + hash(i) * .8);
    const rot = (i % 2 ? .035 : -.035) + out * (hash(i, 3) - .5) * 1.2;
    const flip = eInOut(clamp((b - b0 - .5) / .3));
    drawCard({ x, y, s: .5, rot, flip, front: f, back: k, numeral: FLIP_NUMERALS[i] });
  });
}

// ---------- 金币

function coinFace(x, y, r, sy, labelK, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.scale(1, Math.max(.05, sy));
  const g = ctx.createRadialGradient(-r * .3, -r * .3, r * .1, 0, 0, r);
  g.addColorStop(0, '#fbe7a6');
  g.addColorStop(.6, '#d6a845');
  g.addColorStop(1, '#8a6422');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(255,240,200,.7)';
  ctx.lineWidth = Math.max(1, r * .04);
  ctx.beginPath(); ctx.arc(0, 0, r * .86, 0, TAU); ctx.stroke();
  if (labelK !== null) {
    const sz = r * .55;
    if (labelK < 1) {
      for (let i = 0; i < 3; i++) drawGlyph(900 + i, (i - 1) * sz * .62, 0, sz * .55, '#e8ecf0', 1 - labelK, Math.max(1.5, r * .045));
    }
    if (labelK > 0) text('100', 0, 4, { size: sz, fam: CINZEL, weight: 700, color: '#eef1f4', alpha: labelK, ls: sz * .04 });
  }
  ctx.restore();
}

function coinStack(x, y, n, rx = 36) {
  const th = 5, ry = rx * .3;
  for (let i = 0; i < n; i++) {
    const yy = y - i * th;
    ctx.fillStyle = i % 2 ? '#a77c2c' : '#b88a35';
    ctx.beginPath(); ctx.ellipse(x, yy, rx, ry, 0, 0, Math.PI); ctx.lineTo(x - rx, yy - th); ctx.ellipse(x, yy - th, rx, ry, 0, Math.PI, 0, true); ctx.closePath(); ctx.fill();
  }
  coinFace(x, y - n * th, rx, .3, null);
}

function coinsTray(b, u) {
  const a = Math.min(inv(0, .2, u), inv(4, 3.85, u));
  ctx.save();
  ctx.globalAlpha = a;
  spot(960, 600, 1000, 1.3, '255,235,200');
  const tx0 = 170, tx1 = 1750, ty = 760;
  ctx.fillStyle = '#b9b2a2';
  ctx.beginPath(); ctx.roundRect(tx0, ty - 4, tx1 - tx0, 46, 22); ctx.fill();
  const jg = ctx.createLinearGradient(0, ty - 60, 0, ty + 20);
  jg.addColorStop(0, '#f3efe4');
  jg.addColorStop(1, '#d6cfbf');
  ctx.fillStyle = jg;
  ctx.beginPath(); ctx.roundRect(tx0, ty - 60, tx1 - tx0, 84, 40); ctx.fill();
  ctx.strokeStyle = '#ececf0';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = 'rgba(120,110,90,.16)';
  ctx.beginPath(); ctx.roundRect(tx0 + 22, ty - 46, tx1 - tx0 - 44, 56, 28); ctx.fill();
  const cf = TL.coinFlip;
  for (let i = 0; i < 15; i++) coinStack(960 + (i - 7) * 100, ty, i === 7 && b >= cf.b ? 9 : 10);
  if (b >= cf.b) {
    const p = inv(cf.b, cf.until, b);
    const y = lerp(ty - 55, 400, eOut(clamp(p * 1.6)));
    const r = lerp(36, 150, eOut(clamp(p * 1.4)));
    const th = (1 - Math.pow(1 - p, 3)) * 12 * Math.PI + Math.PI / 2 * (1 - p);
    const lk = b < cf.until - .15 ? 0 : clamp((b - (cf.until - .15)) / .4);
    coinFace(960, y, r, Math.abs(Math.cos(th)), Math.abs(Math.cos(th)) > .35 ? lk : 0);
    if (b >= cf.until) {
      const g = ctx.createRadialGradient(960, 400, r * .9, 960, 400, r * 1.8);
      g.addColorStop(0, `rgba(255,220,140,${.25 * Math.exp(-(b - cf.until) * 2)})`);
      g.addColorStop(1, 'rgba(255,220,140,0)');
      ctx.fillStyle = g;
      ctx.fillRect(960 - r * 2, 400 - r * 2, r * 4, r * 4);
    }
  }
  ctx.restore();
}

function coinsPlaque(b, u) {
  const a = Math.min(inv(0, .15, u), inv(4, 3.85, u));
  const pl = TL.plaque, n = pl.rows.length, rowH = 98;
  ctx.save();
  ctx.globalAlpha = a;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#3e2e23');
  g.addColorStop(1, '#22180f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha *= .5;
  ctx.drawImage(grains[5], 0, 0, W, H);
  ctx.restore();
  for (const fx of [70, W - 110]) {
    ctx.fillStyle = '#1e130c';
    ctx.fillRect(fx, 0, 40, H);
    ctx.fillStyle = '#e9e2d2';
    ctx.fillRect(fx === 70 ? fx + 40 : fx - 4, 0, 4, H);
  }
  const scroll = eInOut(u / 4);
  const y0 = 330 - scroll * ((n - 1) * rowH - 330);
  const plat = '#e7e5df';
  for (let j = -3; j < n + 4; j++) {
    const y = y0 + j * rowH;
    if (y < -60 || y > H + 60) continue;
    for (const [cx, cnt] of [[230, 5 + (j * 7 + 3) % 3], [1500, 4 + (j * 5 + 1) % 3]]) {
      for (let q = 0; q < cnt; q++) drawGlyph(700 + j * 13 + q + cx, cx + q * 40, y, 30, plat, .5, 2.4);
    }
    ctx.strokeStyle = 'rgba(231,229,223,.18)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(600, y + rowH / 2); ctx.lineTo(1330, y + rowH / 2); ctx.stroke();
    if (j < 0 || j >= n) {
      for (let q = 0; q < 6; q++) drawGlyph(800 + j * 11 + q, 650 + q * 46, y, 34, plat, .45, 2.6);
      continue;
    }
    const [name, price] = pl.rows[j];
    const bd = pl.b + j * pl.step, last = j === n - 1;
    const hk = last ? eOut(inv(bd + .2, bd + .6, b)) : 0;
    const opt = { size: last ? 46 : 42, color: last ? '#f6f3ea' : plat, alpha: 1, weight: 600, seed: 300 + j, glow: last ? 26 * hk : undefined, glowColor: 'rgba(255,245,215,.9)' };
    decodeLine(name, 640, y, b, bd - .2, bd + .12, { ...opt, align: 'left' });
    decodeLine(price, 1300, y, b, bd - .1, bd + .2, { ...opt, align: 'right', fam: CINZEL, seed: 400 + j });
    if (b >= bd + .2) {
      ctx.fillStyle = `rgba(231,229,223,${last ? .5 : .3})`;
      for (let dx = 1030; dx < 1150; dx += 14) ctx.fillRect(dx, y + 4, 4, 4);
    }
  }
  ctx.restore();
}

function drawKnife(x, y, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.shadowColor = 'rgba(0,0,0,.7)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 12;
  const bg = ctx.createLinearGradient(0, -34, 0, 34);
  bg.addColorStop(0, '#e1e4e8');
  bg.addColorStop(.55, '#a3a9b1');
  bg.addColorStop(1, '#6c727a');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(-60, -30); ctx.lineTo(300, -30); ctx.quadraticCurveTo(330, -24, 360, 0);
  ctx.quadraticCurveTo(250, 34, -60, 34); ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.strokeStyle = 'rgba(255,255,255,.75)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-50, 30); ctx.quadraticCurveTo(250, 30, 352, 2); ctx.stroke();
  ctx.fillStyle = '#c8ccd0';
  ctx.fillRect(-78, -34, 18, 70);
  ctx.fillStyle = '#1c1410';
  ctx.beginPath(); ctx.roundRect(-250, -24, 172, 50, 14); ctx.fill();
  ctx.fillStyle = '#d9dcdf';
  for (const rx of [-210, -160, -112]) { ctx.beginPath(); ctx.arc(rx, 1, 5, 0, TAU); ctx.fill(); }
  ctx.restore();
}

function woodTop(seed) {
  ctx.fillStyle = '#140d09';
  ctx.fillRect(0, 0, W, H);
  const r = rng(seed);
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 46; i++) {
    const y = r() * H, amp = 4 + r() * 10, f = .002 + r() * .004;
    ctx.strokeStyle = `rgba(90,55,35,${.12 + r() * .18})`;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 40) { const yy = y + Math.sin(x * f + i) * amp; if (x) ctx.lineTo(x, yy); else ctx.moveTo(x, yy); }
    ctx.stroke();
  }
}

// 桌面上错开摆放的一排金币，数得清枚数
function coinPile(x, y, n, r) {
  for (let c = 0; c < n; c++) {
    const cx = x + c * r * .62, cy = y - (c % 2) * r * .22 + Math.sin(c * 1.7) * 6;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.arc(cx + 6, cy + 8, r, 0, TAU); ctx.fill();
    coinFace(cx, cy, r, 1, 1);
  }
}

function coinsKnife(b, u) {
  const kn = TL.knife;
  const a = Math.min(inv(0, .08, u), inv(4, 3.8, u));
  ctx.save();
  ctx.globalAlpha = a;
  woodTop(31);
  spot(940, 520, 820, 2.4, '255,232,196');
  coinPile(560, 560, b >= kn.coinGone ? 4 : 5, 58);
  if (b >= kn.appear) drawKnife(1120, 560, -.32);
  ctx.restore();
}

function sceneCoins(b) {
  const k = S('coins');
  if (b < k || b >= E('coins')) return;
  const r = b - k;
  if (r < 4) coinsTray(b, r);
  else if (r < 8) coinsPlaque(b, r - 4);
  else coinsKnife(b, r - 8);
}

// ---------- 受命与行凶

function sceneCommission(b) {
  const s0 = S('commission'), s1 = E('commission');
  if (b < s0 || b > s1 + .1) return;
  const a = win(b, s0, s1 + .1, .05, .15);
  const cx = 960, cy = 470, R = 330;
  const x = inv(s0, s0 + 2.2, b);
  const pos = (15 * 3 + 13) * (1 - Math.pow(1 - x, 3));
  const hi = Math.floor(pos) % 15, done = b >= s0 + 2.2;
  for (let i = 0; i < 15; i++) {
    const an = SEAT_ANG(i + 1), px = cx + Math.cos(an) * R, py = cy + Math.sin(an) * R;
    const isHi = i === hi;
    let al = isHi ? 1 : .35;
    if (done && !isHi) al = lerp(.35, .1, inv(s0 + 2.2, s0 + 3, b));
    ctx.save();
    ctx.globalAlpha = a * al;
    ctx.fillStyle = isHi ? C.red : C.bone;
    if (isHi) { ctx.shadowColor = C.red; ctx.shadowBlur = 28; }
    const rad = isHi ? 11 * (done ? 1 + .25 * Math.sin(tb(b) * 8) : 1) : 7;
    ctx.beginPath(); ctx.arc(px, py, rad, 0, TAU); ctx.fill();
    ctx.restore();
    text(String(i + 1), cx + Math.cos(an) * (R + 40), cy + Math.sin(an) * (R + 40), { size: 18, fam: CINZEL, color: C.dim, alpha: a * .6 });
  }
  const k = clamp((b - s0) / .25);
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
  const s0 = S('countdown');
  if (b < s0 || b >= E('countdown')) return;
  const x = b - s0;
  const rem = Math.max(0, 86400 - (600 * x + 1200 * x * x * x));
  const str = `${pad2(Math.floor(rem / 3600))}:${pad2(Math.floor(rem % 3600 / 60))}:${pad2(Math.floor(rem % 60))}`;
  const k = clamp(x / .2);
  const red = x >= 2.4;
  ctx.save();
  ctx.translate(960, 520);
  const s = lerp(1.25, 1, eOut(k));
  ctx.scale(s, s);
  monoDigits(str, 0, 0, 200, red ? C.red : C.bone, k, red ? 34 : 8);
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = k * .5;
  ctx.strokeStyle = red ? C.red : C.bone;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(480, 385); ctx.lineTo(1440, 385); ctx.moveTo(480, 655); ctx.lineTo(1440, 655); ctx.stroke();
  ctx.restore();
}

const HALL = b => ({ cx: 960, cy: 495, scale: .9, rot: .064, mood: 'calm', ribRot: -.03, b, eyes: allOpen(), glow: Array(15).fill(.7) });

function sceneBlackout(b) {
  const s0 = S('blackout');
  if (b < s0 || b > E('blackout') + .1) return;
  const off = s0 + 2;
  let lights = 1;
  if (b >= off) {
    const k = b - off;
    lights = k < .08 ? .2 : k < .16 ? .9 : k < .22 ? .1 : k < .3 ? .5 : 0;
  }
  if (lights > 0) drawTable({ ...HALL(b), alpha: .32 * lights * inv(s0, s0 + .4, b) });
  for (const hb of [off, off + 1]) {
    const p = b - hb;
    if (p >= 0 && p < 1) redVignette(Math.exp(-p * 4) * .25);
  }
  if (b > off + .6) {
    const bl = Math.abs(b - (off + 1.75)) < .08 ? Math.abs(b - (off + 1.75)) / .08 : 1;
    const o = eOut(inv(off + .6, off + 1.4, b)) * bl;
    const ea = inv(off + .6, off + 1, b) * inv(E('blackout') + .15, E('blackout') - .05, b);
    const opt = { alpha: ea * .85, white: 'rgba(196,208,198,.85)', iris: '#1b2720', pupil: .86, line: 'rgba(196,208,198,.5)' };
    eye(870, 520, 130, o, { ...opt, look: .5 });
    eye(1050, 520, 130, o, { ...opt, look: .5 });
  }
}

function sceneDoor(b) {
  const d0 = S('door'), d1 = E('door');
  if (b < d0 - .4 || b >= d1) return;
  const a = win(b, d0 - .4, d1, .25, .2);
  const cx = 960, cy = 560, dw = 420, dh = 680, x0 = cx - dw / 2, y0 = cy - dh / 2;
  const ang = b < d0 - .15 ? 1.25 : b < d0 ? 1.25 * (1 - eIn(inv(d0 - .15, d0, b))) : 0;
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
  if (b >= d0) {
    const k = inv(d0 + .05, d0 + .6, b), kx = x0 + dw - 56, ky = cy + 10;
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
  if (b >= d0 && b < d0 + 1.6) {
    const r = rng(68), p = (b - d0) / 1.6;
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
  if (b >= d0 + .5) {
    const rem = Math.max(0, 3600 - (tb(b) - tb(d0 + .5)));
    monoDigits(`${pad2(Math.floor(rem / 3600))}:${pad2(Math.floor(rem % 3600 / 60))}:${pad2(Math.floor(rem % 60))}`, 960, 970, 34, C.red, a * inv(d0 + .5, d0 + .9, b), 12);
  }
}

const SPLAT = (() => {
  const r = rng(72), s = [];
  for (let i = 0; i < 46; i++) { const an = r() * TAU, d = Math.pow(r(), 2) * 260; s.push({ an, d, rad: 20 + (1 - d / 260) * 70 * r() }); }
  for (let i = 0; i < 70; i++) { const an = r() * TAU, d = 260 + r() * 520; s.push({ an, d, rad: 3 + r() * 12, streak: r() < .45 }); }
  return s;
})();

function sceneBody(b) {
  const s0 = S('body'), s1 = E('body');
  if (b < s0 || b >= s1) return;
  const a = win(b, s0, s1, 0, .2);
  const g = ctx.createRadialGradient(960, 540, 0, 960, 540, 900);
  g.addColorStop(0, `rgba(120,8,24,${.55 * a})`);
  g.addColorStop(1, 'rgba(120,8,24,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const p = eOut(clamp((b - s0) / .12));
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
  const k = clamp((b - s0) / .15);
  ctx.save();
  ctx.translate(960, 540);
  const s = lerp(1.6, 1, eOut(k));
  ctx.scale(s, s);
  text('发现尸体。', 0, 0, { size: 180, weight: 900, ls: 24, color: C.bone, alpha: a * k, glow: 40, glowColor: 'rgba(211,25,58,.95)' });
  ctx.restore();
  hud('调查', '120:00', win(b, s0 + 2, s1, .3, 0), C.bone);
}

function sceneInvestigate(b) {
  const s0 = S('investigate'), s1 = E('investigate');
  if (b < s0 || b >= s1) return;
  const a = win(b, s0, s1, .05, .08), el = tb(b) - tb(s0);
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
  const rem = Math.max(0, Math.round(7200 * (1 - eIn(inv(s0, s1 + .3, b)) * .98)));
  hud('调查', `${Math.floor(rem / 60)}:${pad2(rem % 60)}`, a);
  const c1 = TL.clues1, P1 = [[480, 300], [1440, 290], [560, 800], [1380, 790]];
  const midText = TL.texts.find(t => t.sec === 'investigate');
  c1.words.forEach((w, i) => {
    const b0 = c1.b + i * c1.step;
    if (b < b0) return;
    const k = clamp((b - b0) / .15);
    const fadeAt = midText ? midText.until : s1;
    const al = lerp(1, .45, inv(b0 + .3, b0 + .8, b)) * inv(fadeAt + .3, fadeAt - .2, b) * a;
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

// ---------- 庭审

function sceneTrialOpen(b) {
  const s0 = S('trialOpen'), s1 = E('trialOpen');
  if (b < s0 || b > s1 + .2) return;
  const k = clamp((b - s0) / .15), ta = win(b, s0, s0 + 1.7, 0, .5);
  if (ta > 0) {
    ctx.save();
    ctx.translate(960, 520);
    const s = lerp(1.5, 1, eOut(k)) * (1 + (b - s0) * .03);
    ctx.scale(s, s);
    text('开庭', 0, 0, { size: 250, weight: 900, ls: 90, alpha: ta * k, glow: 50, glowColor: 'rgba(211,25,58,.7)' });
    ctx.restore();
  }
  const ba = win(b, s0 + 1.2, s1 + .2, .4, .3);
  if (ba > 0) {
    const dis = inv(s0 + 1.8, s0 + 3.3, b);
    ctx.save();
    ctx.translate(960, 520);
    ctx.globalAlpha = ba * (1 - dis) * .95;
    ctx.drawImage(BODY, -500, -300);
    ctx.globalAlpha = ba * eOut(inv(s0 + 2.3, s0 + 3.6, b)) * .75;
    ctx.drawImage(CLOTH, -500, -300 + 14);
    ctx.fillStyle = C.bone;
    for (const p of BODY_PTS) {
      const t0 = s0 + 1.8 + p.d * 1.4;
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
  const w = measure(d.text, 34, 500) + 96, h = 70;
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
  text(d.text, -w / 2 + 66, 2, { size: 34, weight: 500, align: 'left' });
  ctx.restore();
}

function sceneDebate(b) {
  const s0 = S('debate'), s1 = E('debate');
  if (b < s0 - .2 || b >= s1) return;
  const a = win(b, s0 - .2, s1, .3, .15);
  const T = trialTable(b);
  T.alpha = a;
  for (const d of TL.debate) if (b >= d.b && b < d.b + 1.5) T.glow[d.seat - 1] = 1;
  drawTable(T);
  hud('庭审', '辩论', a, C.red, SERIF);
  TL.debate.forEach((d, i) => {
    if (b < d.b) return;
    const newer = TL.debate[i + 1] && b >= TL.debate[i + 1].b;
    bubble(T, d, b, a * (newer ? .4 : 1));
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
  const s0 = S('vote'), s1 = E('vote');
  if (b < s0 || b >= s1) return;
  const a = win(b, s0, s1, .1, .2);
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
  const doomAt = s1 - 1;
  for (const seat of seats) {
    const [x, y] = proj(T, 300, SEAT_ANG(seat));
    const pop = 1 + .45 * Math.exp(-(b - (last[seat] ?? -9)) * 7);
    const doomed = seat === TL.verdictSeat && b >= doomAt;
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
  const s0 = S('verdict'), s1 = E('verdict');
  if (b < s0 || b >= s1) return;
  const a = win(b, s0, s1, 0, .25);
  const vb = TL.verdict.b;
  const T = trialTable(b);
  T.alpha = .25 * a;
  T.glow = Array(15).fill(.2);
  T.crossed = TL.verdictSeat;
  T.crossK = inv(vb + .2, vb + .7, b);
  if (b >= vb) T.eyes[TL.verdictSeat - 1] = 1 - inv(vb, vb + .4, b);
  drawTable(T);
  let word = '判定错误。', col = C.red;
  if (b < vb) {
    const ok = hash(Math.floor((b - s0) * 8), 5) > .45;
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

function escapeTable(b) {
  const s0 = S('escape'), s1 = TL.escapeDesk.b;
  const a = win(b, s0, s1, .2, .15);
  const z = eInOut(inv(s0, s1, b));
  const sc = lerp(.9, 1.3, z), an = SEAT_ANG(14);
  const T = {
    cx: 960 - Math.cos(an) * 300 * sc * z * .85, cy: 520 - Math.sin(an) * 300 * sc * z * .85,
    scale: sc, rot: 0, mood: 'red', alpha: a * .6, b, ribRot: 0,
    eyes: allOpen(), glow: Array(15).fill(.15), crossed: TL.verdictSeat, crossK: 1,
    redEye: Array(15).fill(false),
  };
  T.eyes[TL.verdictSeat - 1] = 0;
  T.glow[13] = .2 + .9 * inv(s0 + 1.5, s0 + 2.2, b);
  T.redEye[13] = b >= s0 + 1.5;
  drawTable(T);
}

function escapeDesk(b) {
  const d = TL.escapeDesk, s1 = E('escape');
  const a = Math.min(inv(d.b, d.b + .12, b), inv(s1, s1 - .25, b));
  ctx.save();
  ctx.globalAlpha = a;
  woodTop(77);
  spot(900, 470, 800, 2.0, '255,226,180');
  drawCard({ x: 780, y: 540, s: .62, rot: -.12, flip: 0, front: d.card, back: '', numeral: 'VI' });
  if (b >= d.coinsAppear) coinPile(1080, 600, d.coins, 52);
  ctx.restore();
}

function sceneEscape(b) {
  const s0 = S('escape');
  if (b < s0 || b >= E('escape')) return;
  if (b < TL.escapeDesk.b) escapeTable(b);
  else escapeDesk(b);
}

function sceneNames(b) {
  const s0 = S('names'), s1 = E('names');
  if (b < s0 || b >= s1) return;
  const nm = TL.names, el = tb(b) - tb(s0);
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
  const s0 = S('wall'), s1 = E('wall');
  if (b < s0 || b >= s1) return;
  const a = win(b, s0, s1, .2, .3);
  const cx = 960, cy = 520, lw = 270, dh = 720, top = cy - dh / 2;
  const op = eInOut(inv(s0 + .2, s0 + 1.5, b)), ang = op * 1.35;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.beginPath(); ctx.rect(cx - lw, top, 2 * lw, dh); ctx.clip();
  const sweep = lerp(-.4, 1.4, inv(s0 + 1.5, s0 + 3.3, b));
  for (const f of FACETS) {
    const gl = b >= s0 + 1.5 ? Math.exp(-Math.pow((f.cx + f.cy * .4 - sweep) / .12, 2)) * f.k : 0;
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
  const s0 = S('wish'), s1 = E('wish');
  if (b < s0 || b >= s1) return;
  const a = win(b, s0, s1, .5, .25);
  const so = TL.seatOff, gold = b >= s0 + 4;
  const T = {
    cx: 960, cy: 470, scale: lerp(.86, 1.0, eInOut(inv(s0, s1, b))), rot: -(b - s0) * .006, alpha: a,
    mood: gold ? 'gold' : 'calm', ribRot: 0, b, eyes: [], glow: [], seatCol: [],
    chand: lerp(.6, 1.6, inv(s0 + 4, s0 + 6, b)),
  };
  for (let i = 1; i <= 15; i++) {
    const idx = so.order.indexOf(i);
    let o = 1, g = 1;
    if (idx >= 0) { const k = clamp((b - so.times[idx]) / .35); o = 1 - eOut(k); g = 1 - k; }
    T.eyes.push(o);
    T.glow.push(g);
    T.seatCol.push(i === so.survivor && gold ? '240,200,120' : null);
  }
  if (gold) T.glow[so.survivor - 1] = 1 + 1.6 * eOut(inv(s0 + 4, s0 + 5.5, b));
  drawTable(T);
  if (gold) {
    ctx.save();
    ctx.globalAlpha = a * inv(s0 + 4, s0 + 5.2, b) * .5;
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
  const a = inv(E('title'), tt.fadeB, b);
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
  sceneClock, sceneTable, sceneMansion, sceneHost, sceneCard, sceneFlips, sceneCoins, sceneCommission,
  sceneCountdown, sceneBlackout, sceneDoor, sceneBody, sceneInvestigate, sceneTrialOpen, sceneDebate,
  sceneVote, sceneVerdict, sceneEscape, sceneNames, sceneWall, sceneWish, sceneTitle,
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
  dust(b, .55 * win(b, S('intro'), E('table'), 2, 1), '236,230,217', 70, 5);
  dust(b, .5 * win(b, S('wish'), TL.title.fadeB, 1, 3), b >= S('wish') + 4 ? '216,176,100' : '236,230,217', 60, 11);
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
