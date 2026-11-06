// 4.13 擴充工具箱: the small programs OCTA writes next to some tools when it installs them, so a bot can do the common
// thing with one command (the tools' own commands still work too).
//   rembg          → `rembg 原圖 輸出` / `rembg 資料夾 輸出資料夾` (Python, run with that tool's own venv; the u2net model
//                    OCTA already downloaded and checked — no other model is fetched)
//   octa-subtitle  → speech → .srt with whisper.cpp, then a copy of the video with the subtitles (soft, or --burn);
//                    run with OCTA's own Node, finds ffmpeg in OCTA's toolbox

export const REMBG_PY = `# OCTA 4.13: background removal with rembg (the u2net model OCTA downloaded and checked)
import sys
from pathlib import Path

EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp'}

def main(argv):
    if len(argv) != 2 or argv[0] in ('-h', '--help'):
        print('用法：rembg 原圖.jpg 去背.png   或   rembg 原圖資料夾 輸出資料夾（整批）')
        return 0 if argv[:1] in (['-h'], ['--help']) else 2
    from rembg import new_session, remove
    session = new_session('u2net')
    src, dst = Path(argv[0]), Path(argv[1])
    if src.is_dir():
        dst.mkdir(parents=True, exist_ok=True)
        files = [f for f in sorted(src.iterdir()) if f.suffix.lower() in EXTS]
        for f in files:
            out = dst / (f.stem + '.png')
            out.write_bytes(remove(f.read_bytes(), session=session))
            print(out)
        print(f'完成：{len(files)} 張')
        return 0
    if not src.exists():
        print(f'找不到 {src}')
        return 1
    if dst.suffix.lower() not in ('.png', '.webp'):
        dst = dst.with_suffix('.png')
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(remove(src.read_bytes(), session=session))
    print(dst)
    return 0

sys.exit(main(sys.argv[1:]))
`;

// placeholders filled at install time: __TOOLS__ (OCTA's tools folder), __WHISPER__ (the whisper.cpp folder)
export const SUBTITLE_MJS = `// OCTA 4.13 octa-subtitle: speech → subtitles with whisper.cpp, then a copy of the video with them (ffmpeg)
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
const TOOLS = __TOOLS__, WHISPER = __WHISPER__, WIN = process.platform === 'win32', X = WIN ? '.exe' : '';
const a = process.argv.slice(2);
const flag = n => { const i = a.indexOf(n); if (i < 0) return false; a.splice(i, 1); return true; };
const opt = (n, d) => { const i = a.indexOf(n); if (i < 0 || i + 1 >= a.length) return d; const v = a[i + 1]; a.splice(i, 2); return v; };
const burn = flag('--burn'), textOnly = flag('--text');
const lang = opt('--lang', 'auto'), size = opt('--model', 'base');
if (!a[0] || a[0] === '-h' || a[0] === '--help') {
  console.log('用法：octa-subtitle 影片或錄音 [--lang zh|en|ja|auto] [--burn] [--text] [--model base|small]');
  process.exit(a[0] ? 0 : 2);
}
const input = resolve(a[0]);
if (!existsSync(input)) { console.error('找不到 ' + input); process.exit(1); }
const onPath = b => { for (const d of String(process.env.PATH || process.env.Path || '').split(WIN ? ';' : ':')) { const p = join(d, b + X); if (d && existsSync(p)) return p; } return ''; };
let ffmpeg = '';
try { const r = JSON.parse(readFileSync(join(TOOLS, 'installed.json'), 'utf8')).ffmpeg; if (r?.ok) ffmpeg = join(TOOLS, r.binDir, 'ffmpeg' + X); } catch { }
if (!ffmpeg || !existsSync(ffmpeg)) ffmpeg = onPath('ffmpeg');
if (!ffmpeg) { console.error('需要 ffmpeg（在回覆最後寫「🧰安裝：ffmpeg」）'); process.exit(1); }
let model = join(WHISPER, 'models', 'ggml-' + size + '.bin');
if (!existsSync(model)) model = join(WHISPER, 'models', 'ggml-base.bin');
if (!existsSync(model)) { console.error('還沒有 whisper 模型（重新安裝 whisper.cpp）'); process.exit(1); }
const cli = [join(WHISPER, 'Release', 'whisper-cli' + X), join(WHISPER, 'whisper-bin-ubuntu-x64', 'whisper-cli'), onPath('whisper-cli')].find(p => p && existsSync(p));
if (!cli) { console.error('找不到 whisper-cli'); process.exit(1); }
const tmp = mkdtempSync(join(tmpdir(), 'octa-sub-'));
const run = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 << 20 }); if (r.status !== 0) throw new Error(String(r.stderr || r.error || '').slice(-800)); return String(r.stdout || ''); };
try {
  const wav = join(tmp, 'audio.wav');
  run(ffmpeg, ['-y', '-v', 'error', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  const base = join(dirname(input), basename(input, extname(input)));
  const args = ['-m', model, '-f', wav, '-l', lang, '-of', base, '-np', textOnly ? '-otxt' : '-osrt'];
  if (lang === 'zh') args.push('--prompt', '以下是繁體中文的句子。');
  run(cli, args);
  const out = base + (textOnly ? '.txt' : '.srt');
  console.log(out);
  let video = false;
  try { video = / Video: /.test(String(spawnSync(ffmpeg, ['-hide_banner', '-i', input], { windowsHide: true }).stderr || '')); } catch { }
  const mp4 = base + '-字幕.mp4';
  if (textOnly || !video) { /* audio or transcript only: done */ }
  else if (burn) {
    // the subtitles filter reads a path: a plain name in a temporary folder avoids Windows drive-letter escaping
    copyFileSync(out, join(tmp, 'sub.srt'));
    const font = WIN ? 'Microsoft JhengHei' : 'Noto Sans CJK TC';
    run(ffmpeg, ['-y', '-v', 'error', '-i', input, '-vf', "subtitles=sub.srt:force_style='FontName=" + font + "'", '-c:a', 'copy', mp4], tmp);
  } else run(ffmpeg, ['-y', '-v', 'error', '-i', input, '-i', out, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', mp4]);
  if (!textOnly && video) console.log(mp4);
} catch (e) { console.error('沒做成：' + e.message); process.exitCode = 1; }
finally { rmSync(tmp, { recursive: true, force: true }); }
`;
