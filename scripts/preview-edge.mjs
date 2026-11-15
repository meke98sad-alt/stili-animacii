#!/usr/bin/env node
// Превью кадров ролика без Playwright: headless Edge/Chrome по CDP (нужен Node 22+, ничего не ставит).
//   node preview-edge.mjs --html ролик.html --out ./out            → кадры на 10/40/90% каждой сцены
//   node preview-edge.mjs --html ролик.html --out ./out --mp4      → ещё и полный MP4 через ffmpeg
//   --frames 120,195   → только эти кадры (номера с 1)
//   --browser "путь к msedge.exe/chrome"  (по умолчанию ищет Edge, потом Chrome)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const a = process.argv.slice(2), opt = {};
for (let i = 0; i < a.length; i++) { const k = a[i].replace(/^--/, ''); if (a[i + 1] && !a[i + 1].startsWith('--')) opt[k] = a[++i]; else opt[k] = true; }
if (!opt.html) { console.error('Нужен --html файл'); process.exit(1); }
const html = resolve(opt.html), out = resolve(opt.out || './out'); mkdirSync(out, { recursive: true });
const cands = [opt.browser, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const BIN = cands.find(p => existsSync(p)); if (!BIN) { console.error('Не нашёл Edge/Chrome — укажи --browser'); process.exit(2); }
const port = 9400 + Math.floor(Math.random() * 500);
const prof = mkdtempSync(join(dirname(out), '.prof-'));
const br = spawn(BIN, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=1080,1920', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl; for (let i = 0; i < 80 && !wsUrl; i++) { await sleep(250); try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find(x => x.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl; } catch {} }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}, errs = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map(x => x.value ?? x.description).join(' ')); };
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result.result.value; };
const done = code => { try { ws.close(); br.kill(); } catch {} setTimeout(() => { try { rmSync(prof, { recursive: true, force: true }); } catch {} process.exit(code); }, 600); };
try {
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await cmd('Page.navigate', { url: pathToFileURL(html).href + '?render=1' });
  const t0 = Date.now(); while (!(await ev('window.ready===true').catch(() => false))) { if (Date.now() - t0 > 120000) throw new Error('window.ready не наступил за 120 с' + (errs[0] ? ': ' + errs[0] : '')); await sleep(300); }
  console.log(`Готов за ${((Date.now() - t0) / 1000).toFixed(1)} с (SETUP + шрифты)`);
  const info = await ev('({N:TOTAL_FRAMES,FPS:CFG.FPS,starts:STARTS,durs:SCENES.map(s=>s.d)})');
  const ms = await ev(`(()=>{const t=performance.now();for(let k=1;k<=12;k++)renderFrame(Math.round(k*TOTAL_FRAMES/13));return (performance.now()-t)/12})()`);
  console.log(`renderFrame ≈ ${ms.toFixed(0)} мс/кадр` + (ms > 1000 / info.FPS ? ` — МЕДЛЕННЕЕ ${info.FPS} к/с: запись кнопкой в браузере будет дёргаться, облегчи draw` : ' — запись в браузере успеет'));
  const grab = async (f, q) => ev(`(renderFrame(${f}),document.getElementById('stage').toDataURL('image/${q ? 'jpeg' : 'png'}'${q ? ',.92' : ''}))`);
  const fr = []; if (opt.frames) String(opt.frames).split(',').forEach(f => fr.push(+f)); else info.starts.forEach((s, i) => [.1, .4, .9].forEach(k => fr.push(Math.min(info.N, Math.round((s + info.durs[i] * k) * info.FPS) + 1))));
  for (const f of fr) { const t = Date.now(); const d = await grab(f); writeFileSync(join(out, `preview_${String(f).padStart(5, '0')}.png`), Buffer.from(d.split(',')[1], 'base64')); if (fr.indexOf(f) === 0) console.log(`кадр рисуется ~${Date.now() - t} мс`); }
  console.log(`Превью: ${fr.length} кадров в ${out}`);
  if (opt.mp4) {
    const tmp = join(out, '.video.tmp.mp4'), dst = join(out, (opt.name || 'video') + '.mp4');
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(info.FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp], { stdio: ['pipe', 'inherit', 'inherit'] });
    for (let f = 1; f <= info.N; f++) { const d = await grab(f, true); if (!ff.stdin.write(Buffer.from(d.split(',')[1], 'base64'))) await new Promise(r => ff.stdin.once('drain', r)); if (f % 150 === 0) console.log(`кадр ${f}/${info.N}`); }
    ff.stdin.end(); const code = await new Promise(r => ff.on('close', r));
    if (code !== 0) throw new Error('ffmpeg не собрал видео'); renameSync(tmp, dst);
    console.log('MP4:', dst, spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dst], { encoding: 'utf8' }).stdout.trim() + ' с');
  }
  if (errs.length) console.log('Ошибки в консоли страницы:\n' + errs.slice(0, 5).join('\n'));
  done(0);
} catch (e) { console.error(String(e.message || e)); if (errs.length) console.error(errs.slice(0, 5).join('\n')); done(1); }
