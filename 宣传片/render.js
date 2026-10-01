#!/usr/bin/env node
/*
 * 用无头 Chromium 逐帧渲染 scene.html。
 *
 *   node render.js stills 8.2 16 33.5      按“拍”导出单帧 JPEG 到 build/stills/
 *   node render.js video                   全片分段并行渲染，输出 build/video.mp4（无声）
 *
 * 需要 build/fonts/（见 fetch_fonts.sh）。环境变量 WORKERS 控制并行数。
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HERE = __dirname;
const BUILD = path.join(HERE, 'build');
const FONT_DIR = path.join(BUILD, 'fonts');
const TL = JSON.parse(fs.readFileSync(path.join(HERE, 'timeline.json'), 'utf8'));
const FPS = TL.fps;
const BEAT = 60 / TL.bpm;
const TOTAL = Math.round(TL.totalBeats * BEAT * FPS);

function serve() {
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.json': 'application/json',
  };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const file = u.startsWith('/fonts/') ? path.join(FONT_DIR, u.slice(7)) : path.join(HERE, u);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function openPage(browser, port) {
  const page = await browser.newPage({ viewport: { width: TL.width, height: TL.height }, deviceScaleFactor: 1 });
  page.on('pageerror', e => { console.error('page error:', e.message); process.exitCode = 1; });
  page.on('console', m => { if (m.type() === 'error') console.error('console:', m.text()); });
  await page.addInitScript(tl => { window.TIMELINE = tl; }, TL);
  await page.goto(`http://127.0.0.1:${port}/scene.html`);
  await page.evaluate(() => window.sceneReady);
  return page;
}

async function frame(page, i) {
  await page.evaluate(([t, f]) => window.renderFrame(t, f), [i / FPS, i]);
  return page.screenshot({ type: 'jpeg', quality: 95 });
}

async function stills(browser, port, beats) {
  const dir = path.join(BUILD, 'stills');
  fs.mkdirSync(dir, { recursive: true });
  const page = await openPage(browser, port);
  for (const b of beats) {
    const i = Math.round(b * BEAT * FPS);
    const buf = await frame(page, i);
    const out = path.join(dir, `b${String(b).padStart(6, '0')}.jpg`);
    fs.writeFileSync(out, buf);
    console.log(out);
  }
}

function encoder(out) {
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', String(FPS * 2), out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))));
  return { ff, done };
}

async function video(browser, port) {
  const workers = Number(process.env.WORKERS || 3);
  const dir = path.join(BUILD, 'chunks');
  fs.mkdirSync(dir, { recursive: true });
  const per = Math.ceil(TOTAL / workers);
  const t0 = Date.now();
  let doneFrames = 0;
  const jobs = [];
  for (let w = 0; w < workers; w++) {
    const from = w * per, to = Math.min(TOTAL, from + per);
    const out = path.join(dir, `chunk_${w}.mp4`);
    jobs.push((async () => {
      const page = await openPage(browser, port);
      const { ff, done } = encoder(out);
      for (let i = from; i < to; i++) {
        const buf = await frame(page, i);
        if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
        doneFrames++;
        if (doneFrames % 100 === 0) {
          const s = (Date.now() - t0) / 1000;
          console.log(`${doneFrames}/${TOTAL} 帧  ${s.toFixed(0)}s  约剩 ${(s / doneFrames * (TOTAL - doneFrames)).toFixed(0)}s`);
        }
      }
      ff.stdin.end();
      await done;
      await page.close();
      return out;
    })());
  }
  const outs = await Promise.all(jobs);
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, outs.map(o => `file '${o}'`).join('\n') + '\n');
  await new Promise((res, rej) => {
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', path.join(BUILD, 'video.mp4')], { stdio: 'inherit' });
    ff.on('close', c => (c === 0 ? res() : rej(new Error('concat failed'))));
  });
  console.log(`完成：${TOTAL} 帧，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s → build/video.mp4`);
}

(async () => {
  const [mode, ...args] = process.argv.slice(2);
  if (!fs.existsSync(path.join(FONT_DIR, 'local.css'))) throw new Error('缺少 build/fonts，请先运行 fetch_fonts.sh');
  const srv = await serve();
  const port = srv.address().port;
  const browser = await chromium.launch({ args: ['--disable-gpu', '--font-render-hinting=none'] });
  try {
    if (mode === 'stills') await stills(browser, port, args.map(Number));
    else if (mode === 'video') await video(browser, port);
    else throw new Error('用法：node render.js stills <拍...> | video');
  } finally {
    await browser.close();
    srv.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
