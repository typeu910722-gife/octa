// 4.12 產生圖片／影片: the bot writes a 【產生】 block, OCTA calls the image or video service with the person's own API
// key (kept in this computer's settings, never shown to the AI), saves the result in the bot's 輸出 folder, and the
// files go out with the reply (pictures inline, videos with a player).
//
//   【產生】
//   種類：圖片 | 影片
//   服務：OpenAI | Gemini | Replicate      (optional: the first one with a key)
//   描述：要畫什麼（越具體越好）
//   檔名：海報草稿                          (optional)
//   比例：16:9                              (optional)
//   【產生完】
//
// Providers: OpenAI Images (gpt-image-1), Google Gemini API (Imagen 4 for pictures, Veo 3 for video, long-running),
// Replicate (any model, default FLUX schnell for pictures and Kling for video). Local ComfyUI: later (toolbox.mjs).

export const GEN_PROVIDERS = {
  openai: { label: 'OpenAI', kinds: ['image'], model: { image: 'gpt-image-1' }, site: 'https://platform.openai.com/api-keys',
    cost: '圖片每張約 US$0.01–0.25（看尺寸與品質）' },
  gemini: { label: 'Google Gemini', kinds: ['image', 'video'], model: { image: 'imagen-4.0-generate-001', video: 'veo-3.0-generate-001' }, site: 'https://aistudio.google.com/apikey',
    cost: '圖片每張約 US$0.02–0.06；影片每秒約 US$0.15–0.75（8 秒一段）' },
  replicate: { label: 'Replicate', kinds: ['image', 'video'], model: { image: 'black-forest-labs/flux-schnell', video: 'kwaivgi/kling-v2.1' }, site: 'https://replicate.com/account/api-tokens',
    cost: '依模型計價：圖片每張約 US$0.003–0.05；影片每段約 US$0.25–1.5' }
};
export const GEN_MAX = 4; // blocks per turn
const KIND_WORD = { 圖片: 'image', 圖: 'image', 照片: 'image', image: 'image', 影片: 'video', 視頻: 'video', 動畫: 'video', video: 'video' };

export function takeGenTasks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/【產生】\s*([\s\S]*?)\s*【產生完】/g)) {
    const body = m[1],
      f = k => ((body.match(new RegExp(`${k}[:：]\\s*([^\\n]+)`)) || [])[1] || '').trim();
    const kind = KIND_WORD[f('種類').toLowerCase()] || (/影片|video/i.test(f('種類')) ? 'video' : 'image');
    const sv = f('服務').toLowerCase();
    const provider = /openai|gpt|dall/.test(sv) ? 'openai' : /gemini|google|imagen|veo/.test(sv) ? 'gemini' : /replicate|kling|flux|runway/.test(sv) ? 'replicate' : '';
    const prompt = (body.match(/描述[:：]\s*([\s\S]*?)(?:\n\s*(?:檔名|比例|服務|種類|模型)[:：]|$)/) || [])[1]?.trim().slice(0, 4000) || '';
    if (!prompt) continue;
    out.push({ kind, provider, prompt, name: f('檔名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60), aspect: (f('比例').match(/\d+:\d+/) || [])[0] || '', model: f('模型').slice(0, 80) });
    if (out.length >= GEN_MAX) break;
  }
  return out;
}
export const stripGenTasks = text => String(text || '').replace(/【產生】[\s\S]*?【產生完】/g, '').trim();

// which provider does this: the one asked for if it has a key and can do this kind, else the first that can
export function pickProvider(task, keys) {
  const can = p => keys?.[p]?.secret && GEN_PROVIDERS[p].kinds.includes(task.kind);
  if (task.provider && can(task.provider)) return task.provider;
  return ['openai', 'gemini', 'replicate'].find(can) || '';
}
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
function redact(t, secret) {
  const s = String(t || '');
  return secret && secret.length >= 4 ? s.split(secret).join('（已隱藏）') : s;
}
async function jsonOf(r) {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { _text: t.slice(0, 300) };
  }
}
const errText = (d, r) => d?.error?.message || d?.detail || d?.error || d?._text || 'HTTP ' + r.status;
const sizeFor = aspect => (aspect === '16:9' || aspect === '3:2' ? '1536x1024' : aspect === '9:16' || aspect === '2:3' ? '1024x1536' : '1024x1024');

// one generation → { ok, files: [{ ext, mime, buf }], text }. opts: { fetchImpl, sleep, maxWaitMs, pollMs }
export async function generate(task, keys, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch,
    sleep = opts.sleep || sleepMs,
    maxWait = opts.maxWaitMs ?? 10 * 60000,
    poll = opts.pollMs ?? 5000;
  const provider = pickProvider(task, keys);
  if (!provider)
    return { ok: false, text: task.kind === 'video' ? '還沒有可以產生影片的金鑰（Google Gemini 或 Replicate）。到 設定 → 技能與工具 填上。' : '還沒有可以產生圖片的金鑰（OpenAI、Google Gemini 或 Replicate）。到 設定 → 技能與工具 填上。' };
  const key = keys[provider].secret,
    model = task.model || keys[provider].model?.[task.kind] || GEN_PROVIDERS[provider].model[task.kind];
  const t0 = Date.now();
  const download = async (url, headers = {}) => {
    const r = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error('下載結果失敗（' + r.status + '）');
    return { buf: Buffer.from(await r.arrayBuffer()), mime: (r.headers?.get?.('content-type') || '').split(';')[0] };
  };
  try {
    if (provider === 'openai') {
      const r = await fetchImpl('https://api.openai.com/v1/images/generations', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, prompt: task.prompt, n: 1, size: sizeFor(task.aspect) }), signal: AbortSignal.timeout(180000)
      });
      const d = await jsonOf(r);
      if (!r.ok) return { ok: false, provider, text: redact('OpenAI：' + errText(d, r), key) };
      const it = d.data?.[0] || {};
      if (it.b64_json) return { ok: true, provider, model, files: [{ ext: 'png', mime: 'image/png', buf: Buffer.from(it.b64_json, 'base64') }] };
      if (it.url) { const x = await download(it.url); return { ok: true, provider, model, files: [{ ext: 'png', mime: x.mime || 'image/png', buf: x.buf }] }; }
      return { ok: false, provider, text: 'OpenAI 沒有回傳圖片' };
    }
    if (provider === 'gemini') {
      const base = 'https://generativelanguage.googleapis.com/v1beta';
      const h = { 'content-type': 'application/json', 'x-goog-api-key': key };
      if (task.kind === 'image') {
        const r = await fetchImpl(`${base}/models/${model}:predict`, {
          method: 'POST', headers: h, signal: AbortSignal.timeout(180000),
          body: JSON.stringify({ instances: [{ prompt: task.prompt }], parameters: { sampleCount: 1, ...(task.aspect ? { aspectRatio: task.aspect } : {}) } })
        });
        const d = await jsonOf(r);
        if (!r.ok) return { ok: false, provider, text: redact('Gemini：' + errText(d, r), key) };
        const p = d.predictions?.[0];
        if (!p?.bytesBase64Encoded) return { ok: false, provider, text: 'Gemini 沒有回傳圖片（可能被安全規則擋下，換個描述試試）' };
        const mime = p.mimeType || 'image/png';
        return { ok: true, provider, model, files: [{ ext: mime.includes('jpeg') ? 'jpg' : 'png', mime, buf: Buffer.from(p.bytesBase64Encoded, 'base64') }] };
      }
      // Veo: a long-running operation, polled until done, then the video is downloaded with the key
      const r = await fetchImpl(`${base}/models/${model}:predictLongRunning`, {
        method: 'POST', headers: h, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ instances: [{ prompt: task.prompt }], parameters: task.aspect ? { aspectRatio: task.aspect } : {} })
      });
      let op = await jsonOf(r);
      if (!r.ok) return { ok: false, provider, text: redact('Gemini：' + errText(op, r), key) };
      while (!op.done) {
        if (Date.now() - t0 > maxWait) return { ok: false, provider, text: `影片超過 ${Math.round(maxWait / 60000)} 分鐘還沒做好，先停下（Google 那邊可能還在算，費用照算）。` };
        await sleep(poll);
        const pr = await fetchImpl(`${base}/${op.name}`, { headers: h, signal: AbortSignal.timeout(30000) });
        op = await jsonOf(pr);
        if (!pr.ok) return { ok: false, provider, text: redact('Gemini：' + errText(op, pr), key) };
      }
      if (op.error) return { ok: false, provider, text: redact('Gemini：' + (op.error.message || '影片沒做成'), key) };
      const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri || op.response?.generatedVideos?.[0]?.video?.uri;
      if (!uri) return { ok: false, provider, text: 'Gemini 沒有回傳影片（可能被安全規則擋下，換個描述試試）' };
      const x = await download(uri, { 'x-goog-api-key': key });
      return { ok: true, provider, model, files: [{ ext: 'mp4', mime: 'video/mp4', buf: x.buf }] };
    }
    // Replicate: a prediction on the model, waited for, then its output file(s) downloaded
    const h = { 'content-type': 'application/json', authorization: 'Bearer ' + key, prefer: 'wait=60' };
    const input = { prompt: task.prompt, ...(task.aspect ? { aspect_ratio: task.aspect } : {}) };
    const r = await fetchImpl(`https://api.replicate.com/v1/models/${model}/predictions`, { method: 'POST', headers: h, body: JSON.stringify({ input }), signal: AbortSignal.timeout(90000) });
    let p = await jsonOf(r);
    if (!r.ok) return { ok: false, provider, text: redact('Replicate：' + errText(p, r), key) };
    while (['starting', 'processing'].includes(p.status)) {
      if (Date.now() - t0 > maxWait) return { ok: false, provider, text: `超過 ${Math.round(maxWait / 60000)} 分鐘還沒做好，先停下（Replicate 可能還在算，費用照算）。` };
      await sleep(poll);
      const pr = await fetchImpl(p.urls?.get || `https://api.replicate.com/v1/predictions/${p.id}`, { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(30000) });
      p = await jsonOf(pr);
      if (!pr.ok) return { ok: false, provider, text: redact('Replicate：' + errText(p, pr), key) };
    }
    if (p.status !== 'succeeded') return { ok: false, provider, text: redact('Replicate：' + (p.error || p.status || '沒做成'), key) };
    const urls = (Array.isArray(p.output) ? p.output : [p.output]).filter(u => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 4);
    if (!urls.length) return { ok: false, provider, text: 'Replicate 沒有回傳檔案' };
    const files = [];
    for (const u of urls) {
      const x = await download(u);
      const ext = (u.split('?')[0].match(/\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i) || [])[1]?.toLowerCase() || (task.kind === 'video' ? 'mp4' : 'png');
      files.push({ ext: ext === 'jpeg' ? 'jpg' : ext, mime: x.mime || (task.kind === 'video' ? 'video/mp4' : 'image/' + ext), buf: x.buf });
    }
    return { ok: true, provider, model, files };
  } catch (e) {
    return { ok: false, provider, text: redact((GEN_PROVIDERS[provider]?.label || provider) + '：' + (e?.message || '失敗'), key) };
  }
}

// the two catalog skills (installed when a key is saved): how a bot asks for pictures and videos
export const GEN_SKILLS = {
  'octa-image': {
    desc: '產生圖片：使用者要畫圖、做海報、商品圖、插圖、社群貼文圖、logo 草稿時使用（generate images, posters, illustrations）。',
    words: '圖片 海報 插圖 畫 照片 image picture poster illustration logo',
    body: [
      '# 產生圖片（OCTA）',
      '',
      '用使用者自己的 API 金鑰產生圖片。你不用碰金鑰，也不要自己呼叫 API。',
      '',
      '在回覆最後寫這一段（一張圖一段，最多 4 段），OCTA 會產生圖片、存到你的「輸出」資料夾，並直接附在回覆裡：',
      '',
      '【產生】',
      '種類：圖片',
      '描述：用英文或中文具體描述畫面（主體、風格、顏色、構圖、文字）',
      '檔名：簡短的檔名',
      '比例：1:1、16:9 或 9:16（選填）',
      '【產生完】',
      '',
      '- 服務：可以加一行「服務：OpenAI」或「服務：Gemini」或「服務：Replicate」，不寫就用第一個有金鑰的。',
      '- 每張圖都要花使用者的錢（約 US$0.01–0.25），一次只做要的張數，不要自己多做。',
      '- 不要產生真人肖像冒用、商標仿冒或不雅內容。'
    ].join('\n')
  },
  'octa-video': {
    desc: '產生影片：使用者要做短影片、廣告片、動畫片段時使用（generate short videos with Veo or Replicate）。',
    words: '影片 短片 動畫 廣告片 video clip animation reels',
    body: [
      '# 產生影片（OCTA）',
      '',
      '用使用者自己的 API 金鑰產生 5–8 秒的短影片（Google Veo 或 Replicate 上的 Kling 等模型）。你不用碰金鑰，也不要自己呼叫 API。',
      '',
      '在回覆最後寫這一段，OCTA 會產生影片（要等幾分鐘）、存到你的「輸出」資料夾，並附在回覆裡：',
      '',
      '【產生】',
      '種類：影片',
      '描述：具體描述畫面、動作、鏡頭、風格',
      '檔名：簡短的檔名',
      '比例：16:9 或 9:16（選填）',
      '【產生完】',
      '',
      '- 影片很貴（每段約 US$1–6），使用者沒有明確要影片就不要做；做之前先用一句話確認描述。',
      '- 要剪接、加字幕、轉檔就用 ffmpeg（沒有就寫「🧰安裝：ffmpeg」）。'
    ].join('\n')
  }
};
export const genSkillMd = name => `---\nname: ${name}\ndescription: ${GEN_SKILLS[name].desc}\n---\n\n${GEN_SKILLS[name].body}\n`;
