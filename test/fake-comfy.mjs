// A stand-in for ComfyUI's HTTP API (4.13 tests): started by OCTA's runner exactly like the real one (its run command
// plus --listen 127.0.0.1 --port N), answers /system_stats, /prompt, /history/<id> and /view. The workflow it got is
// written to FAKE_COMFY_LOG so the test can check what OCTA sent.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
const a = process.argv.slice(2);
const port = +a[a.indexOf('--port') + 1];
const host = a[a.indexOf('--listen') + 1];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const jobs = {};
let n = 0;
createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (u.pathname === '/system_stats') return send(200, { system: { os: 'fake' }, args: a });
  if (u.pathname === '/prompt' && req.method === 'POST') {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b);
      if (process.env.FAKE_COMFY_LOG) appendFileSync(process.env.FAKE_COMFY_LOG, JSON.stringify(body.prompt) + '\n');
      const id = 'p' + ++n;
      const video = Object.values(body.prompt).some(x => x.class_type === 'SaveWEBM');
      jobs[id] = { at: Date.now(), file: video ? 'octa_00001_.webm' : 'octa_00001_.png' };
      send(200, { prompt_id: id, number: n });
    });
    return;
  }
  const h = u.pathname.match(/^\/history\/(\w+)$/);
  if (h) {
    const j = jobs[h[1]];
    if (!j || Date.now() - j.at < 300) return send(200, {});   // still working the first moments
    return send(200, { [h[1]]: { outputs: { 9: { images: [{ filename: j.file, subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true } } });
  }
  if (u.pathname === '/view') return u.searchParams.get('filename')?.endsWith('.webm') ? send(200, Buffer.from('WEBMDATA'), 'video/webm') : send(200, PNG, 'image/png');
  send(404, { error: 'not found' });
}).listen(port, host);
