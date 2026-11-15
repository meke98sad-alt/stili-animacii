#!/usr/bin/env node
// Необязательный рендер HTML-ролика в настоящий MP4 (H.264) — только если в среде есть Node 18+, Playwright с Chromium и ffmpeg.
// Ничего не устанавливает сам.
//   превью кадров:  node render.mjs --html ролик.html --out ./out --preview
//   полный MP4:     node render.mjs --html ролик.html --out ./out [--name video]
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const a = process.argv.slice(2), opt = {};
for (let i = 0; i < a.length; i++) { const k = a[i].replace(/^--/, ''); if (a[i + 1] && !a[i + 1].startsWith('--')) opt[k] = a[++i]; else opt[k] = true; }
if (!opt.html) { console.error('Нужен --html файл'); process.exit(1); }
const html = resolve(opt.html), out = resolve(opt.out || './out'), name = opt.name || 'video';
mkdirSync(out, { recursive: true });
const req = createRequire(join(process.cwd(), 'x.js'));
let pw; try { pw = req('playwright'); } catch { try { pw = req('playwright-core'); } catch { console.error('Нет Playwright — отдай пользователю HTML с кнопкой «Скачать видео».'); process.exit(2); } }
if (!opt.preview && spawnSync('ffmpeg', ['-version']).status !== 0) { console.error('Нет ffmpeg — отдай пользователю HTML с кнопкой «Скачать видео».'); process.exit(2); }

const b = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const pg = await b.newPage();
const errs = []; pg.on('pageerror', e => errs.push(String(e)));
await pg.goto(pathToFileURL(html).href + '?render=1');
await pg.waitForFunction('window.ready===true', null, { timeout: 60000 });
const { W, H, FPS, N, starts, durs } = await pg.evaluate(() => ({ W: CFG.W, H: CFG.H, FPS: CFG.FPS, N: TOTAL_FRAMES, starts: STARTS, durs: SCENES.map(s => s.d) }));
await pg.setViewportSize({ width: W, height: H });
const shot = async (f, opts) => { await pg.evaluate(f => renderFrame(f), f); if (errs.length) throw new Error('Ошибка JS в ролике: ' + errs[0]); return pg.locator('#stage').screenshot(opts); };

if (opt.preview) {
  const fr = [];
  starts.forEach((s, i) => [.1, .4, .9].forEach(k => fr.push(Math.min(N, Math.round((s + durs[i] * k) * FPS) + 1))));
  for (const f of fr) await shot(f, { path: join(out, `preview_${String(f).padStart(5, '0')}.png`) });
  console.log(`Превью: ${fr.length} кадров в ${out}`);
} else {
  const tmp = join(out, `.${name}.tmp.mp4`), dst = join(out, `${name}.mp4`);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let f = 1; f <= N; f++) {
    const buf = await shot(f, { type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (f % 150 === 0) console.log(`кадр ${f}/${N}`);
  }
  ff.stdin.end();
  const code = await new Promise(r => ff.on('close', r));
  if (code !== 0 || !existsSync(tmp)) { console.error('ffmpeg не собрал видео'); process.exit(1); }
  renameSync(tmp, dst);
  const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'compact', dst], { encoding: 'utf8' });
  console.log('Готово:', dst, '\n' + (p.stdout || ''));
}
await b.close();
