// 4.12 工具箱: machine tools the skills and bots need, installed into OCTA's own folder (<data>/tools/<id>), no admin
// rights, and put on the PATH of the bots they are given to. The catalog below is vetted: each download is a fixed
// version from the official (or officially linked) place, checked against the SHA-256 written here — those install
// without asking. Anything else (an npm / pip package, a GitHub release binary, an MCP server) needs the approval card.
//
// Where the checksums come from (checked 2026-11-06):
//   ffmpeg (Windows)  gyan.dev essentials build 9.0.2 (linked from ffmpeg.org), GitHub mirror GyanD/codexffmpeg;
//                     SHA-256 = the one gyan.dev publishes (ffmpeg-release-essentials.zip.sha256), and the download matches
//   ffmpeg (Linux)    John Van Sickle static build 7.0.2 (linked from ffmpeg.org); SHA-256 computed from the download
//   ImageMagick       GitHub release 7.1.2-35 (ImageMagick/ImageMagick): Windows portable .7z, Linux AppImage; computed
//   yt-dlp            GitHub release 2026.10.26: the SHA2-256SUMS file of that release
//   uv                GitHub release 0.13.7 (astral-sh/uv): the release's sha256.sum
//   Python            `uv python install 3.12` (uv checks python-build-standalone's own hashes)
// macOS ffmpeg / ImageMagick: no checksummed portable build reachable here → the catalog says to use Homebrew.

export const TOOLS_VERSION = '2026-11-06';
const GH = 'https://github.com';
export const CATALOG = [
  {
    id: 'ffmpeg', label: 'FFmpeg', what: '影片、聲音轉檔剪接', bins: ['ffmpeg', 'ffprobe'], license: 'GPL-3.0', source: 'https://ffmpeg.org/download.html',
    builds: {
      'win-x64': { url: `${GH}/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip`, sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba', size: 114768076, version: '9.0.2', unpack: 'zip', bin: 'ffmpeg-9.0.2-essentials_build/bin' },
      'linux-x64': { url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-7.0.2-amd64-static.tar.xz', alt: ['https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-7.0.2-amd64-static.tar.xz'], sha256: 'abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67', size: 41888096, version: '7.0.2', unpack: 'tar', bin: 'ffmpeg-7.0.2-amd64-static' }
    },
    otherwise: { mac: 'brew install ffmpeg' }
  },
  {
    id: 'imagemagick', label: 'ImageMagick', what: '圖片縮放、裁切、轉檔、加字', bins: ['magick'], license: 'ImageMagick', source: 'https://imagemagick.org/script/download.php',
    builds: {
      'win-x64': { url: `${GH}/ImageMagick/ImageMagick/releases/download/7.1.2-35/ImageMagick-7.1.2-35-portable-Q16-x64.7z`, sha256: 'e7c629f3530ccb9d4918a15f0e928254feda28e84a7fa794b25873d152c075c1', size: 12106737, version: '7.1.2-35', unpack: '7z', bin: '' },
      'linux-x64': { url: `${GH}/ImageMagick/ImageMagick/releases/download/7.1.2-35/ImageMagick-7.1.2-35-gcc-x86_64.AppImage`, sha256: 'f111044ed06b68cfb478df724c5a32d35145afa21073242f888d234a2f8cc002', size: 33352184, version: '7.1.2-35', unpack: 'file', file: 'magick', bin: '' }
    },
    otherwise: { mac: 'brew install imagemagick' }
  },
  {
    id: 'yt-dlp', label: 'yt-dlp', what: '下載網路影片（只用在你有權使用的影片）', bins: ['yt-dlp'], license: 'Unlicense', source: `${GH}/yt-dlp/yt-dlp`,
    builds: {
      'win-x64': { url: `${GH}/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe`, sha256: 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d', version: '2026.10.26', unpack: 'file', file: 'yt-dlp.exe', bin: '' },
      'mac-x64': { url: `${GH}/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_macos`, sha256: '0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa', version: '2026.10.26', unpack: 'file', file: 'yt-dlp', bin: '' },
      'mac-arm64': { url: `${GH}/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_macos`, sha256: '0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa', version: '2026.10.26', unpack: 'file', file: 'yt-dlp', bin: '' },
      'linux-x64': { url: `${GH}/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux`, sha256: '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795', version: '2026.10.26', unpack: 'file', file: 'yt-dlp', bin: '' }
    }
  },
  {
    id: 'uv', label: 'uv', what: 'Python 套件與 Python 本身的管理工具', bins: ['uv', 'uvx'], license: 'MIT / Apache-2.0', source: `${GH}/astral-sh/uv`,
    builds: {
      'win-x64': { url: `${GH}/astral-sh/uv/releases/download/0.13.7/uv-x86_64-pc-windows-msvc.zip`, sha256: '0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021', version: '0.13.7', unpack: 'zip', bin: '' },
      'win-arm64': { url: `${GH}/astral-sh/uv/releases/download/0.13.7/uv-aarch64-pc-windows-msvc.zip`, sha256: '505d9e65e7692bac3ddf98c66754aa26c5050c409c184af30a881a0a72cc85e3', version: '0.13.7', unpack: 'zip', bin: '' },
      'mac-x64': { url: `${GH}/astral-sh/uv/releases/download/0.13.7/uv-x86_64-apple-darwin.tar.gz`, sha256: '20c47e4c1f630b8abaff8c291fa9b9aa300fef92c4fbff95adf198b55287cda7', version: '0.13.7', unpack: 'tar', bin: 'uv-x86_64-apple-darwin' },
      'mac-arm64': { url: `${GH}/astral-sh/uv/releases/download/0.13.7/uv-aarch64-apple-darwin.tar.gz`, sha256: '81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731', version: '0.13.7', unpack: 'tar', bin: 'uv-aarch64-apple-darwin' },
      'linux-x64': { url: `${GH}/astral-sh/uv/releases/download/0.13.7/uv-x86_64-unknown-linux-gnu.tar.gz`, sha256: 'c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83', version: '0.13.7', unpack: 'tar', bin: 'uv-x86_64-unknown-linux-gnu' },
      'linux-arm64': { url: `${GH}/astral-sh/uv/releases/download/0.13.7/uv-aarch64-unknown-linux-gnu.tar.gz`, sha256: '71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc', version: '0.13.7', unpack: 'tar', bin: 'uv-aarch64-unknown-linux-gnu' }
    }
  },
  // Python itself: uv installs a standalone build into OCTA's tools folder (uv verifies those downloads)
  { id: 'python', label: 'Python 3.12', what: '執行 Python 程式（很多技能的程式是 Python）', bins: ['python', 'python3'], license: 'PSF', source: 'https://github.com/astral-sh/python-build-standalone', needs: ['uv'], via: 'uv-python', version: '3.12' },
  // Node.js comes with OCTA (the desktop app's own Node): only put on the PATH
  { id: 'node', label: 'Node.js', what: '執行 JavaScript 程式', bins: ['node'], license: 'MIT', source: 'https://nodejs.org', via: 'bundled' },
  // later: local image/video generation. Offered only when an NVIDIA GPU is found; not installable yet.
  // Hook for a future version: ComfyUI portable (github.com/comfyanonymous/ComfyUI releases, "ComfyUI_windows_portable_nvidia.7z"),
  // checksum pinned like the others, started as a local server, and a 🎨 provider 'comfyui' in desktop/lib/gen.mjs.
  { id: 'comfyui', label: 'ComfyUI（本機產生圖片影片）', what: '用自己的顯示卡產生圖片影片，不用付 API 費用', bins: [], license: 'GPL-3.0', source: 'https://github.com/comfyanonymous/ComfyUI', later: true, needsGpu: 'nvidia' }
];
const ALIAS = { ffprobe: 'ffmpeg', magick: 'imagemagick', 'image magick': 'imagemagick', python3: 'python', py: 'python', nodejs: 'node', 'node.js': 'node', ytdlp: 'yt-dlp', 'yt_dlp': 'yt-dlp', uvx: 'uv' };
export const catalogItem = id => {
  const k = String(id || '').trim().toLowerCase();
  return CATALOG.find(t => t.id === (ALIAS[k] || k)) || null;
};
export const platformKey = (platform = process.platform, arch = process.arch) =>
  `${platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
// what this computer can do with a catalog item: 'download' | 'uv-python' | 'bundled' | 'manual' (with how) | 'later'
export function buildFor(item, key = platformKey()) {
  if (!item) return { way: 'none' };
  if (item.later) return { way: 'later' };
  if (item.via === 'bundled') return { way: 'bundled' };
  if (item.via === 'uv-python') return { way: 'uv-python' };
  const b = item.builds?.[key] || (key.endsWith('arm64') && key.startsWith('mac') ? item.builds?.['mac-x64'] : null);
  if (b) return { way: 'download', ...b };
  const os = key.split('-')[0];
  return { way: 'manual', how: item.otherwise?.[os] || '' };
}
// the catalog as the settings page shows it (no URLs needed there, but the source and version are)
export function catalogView(key = platformKey(), gpu = false) {
  return CATALOG.filter(t => !t.needsGpu || gpu).map(t => {
    const b = buildFor(t, key);
    return { id: t.id, label: t.label, what: t.what, license: t.license, source: t.source, later: !!t.later, way: b.way, version: b.version || t.version || '', size: b.size || 0, sha256: b.sha256 || '', how: b.how || '' };
  });
}

// ---------- off-catalog: what the bot or the person asked for, parsed (installed only after approval) ----------
// npm:套件[@版本] · pip:套件[==版本] · mcp:npm套件[@版本] · github:擁有者/專案[@標籤][:檔名]
export function parseToolAsk(s) {
  const t = String(s || '').trim().replace(/^[「『"]|[」』"]$/g, '');
  let m;
  if ((m = t.match(/^npm[:：]\s*((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@([\w.^~-]+))?$/i))) return { type: 'npm', pkg: m[1].toLowerCase(), version: m[2] || '' };
  if ((m = t.match(/^(?:pip|pypi)[:：]\s*([A-Za-z0-9][\w.-]*)(?:==([\w.]+))?$/))) return { type: 'pip', pkg: m[1], version: m[2] || '' };
  if ((m = t.match(/^mcp[:：]\s*(?:npm[:：])?((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@([\w.^~-]+))?$/i))) return { type: 'mcp', pkg: m[1].toLowerCase(), version: m[2] || '' };
  if ((m = t.match(/^(?:github|gh)[:：]\s*([\w.-]+\/[\w.-]+)(?:@([\w.-]+))?(?:[:：]([\w.+-]+))?$/i))) return { type: 'github', repo: m[1], tag: m[2] || '', asset: m[3] || '' };
  const c = catalogItem(t);
  if (c) return { type: 'catalog', id: c.id };
  return null;
}
export const toolKey = a => (a.type === 'catalog' ? a.id : a.type === 'github' ? `github:${a.repo}` : `${a.type}:${a.pkg}`);
// a name the PATH / MCP config can use
export const mcpName = pkg => String(pkg || '').replace(/^@/, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'tool';
// which GitHub release asset fits this computer
export function pickAsset(assets, key = platformKey()) {
  const [os, arch] = key.split('-');
  const osRe = os === 'win' ? /(windows|win(32|64)?|\.exe$|msvc)/i : os === 'mac' ? /(darwin|macos|apple|osx)/i : /linux/i;
  const archRe = arch === 'arm64' ? /(arm64|aarch64)/i : /(x86_64|amd64|x64|win64)/i;
  const ok = (assets || []).filter(a => osRe.test(a.name) && !/\.(sha256|sig|asc|txt|sbom|json)$/i.test(a.name) && /\.(zip|tar\.gz|tgz|tar\.xz|exe)$|^[^.]+$/i.test(a.name));
  return ok.find(a => archRe.test(a.name)) || ok.find(a => !/(arm|aarch|i686|386)/i.test(a.name)) || null;
}
export const TOOL_LIMIT_BYTES = 400_000_000;
