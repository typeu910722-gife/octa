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
//
// 4.13 擴充工具箱 (off by default; checked 2026-11-06). Nothing below is offered, installed or told to a bot until the
// person turns it on. No upstream checksum files exist for the GitHub ones, so the SHA-256 was computed from the official
// release download (each downloaded twice, the same); Hugging Face files use the SHA-256 Hugging Face itself publishes.
//   Real-ESRGAN     xinntao/Real-ESRGAN release v0.2.5.0, realesrgan-ncnn-vulkan-20220424-{windows,ubuntu,macos}.zip (models inside)
//   whisper.cpp     ggml-org/whisper.cpp release v1.9.2: whisper-bin-x64.zip, whisper-bin-ubuntu-x64.tar.gz;
//                   models ggml-base.bin / ggml-small.bin from huggingface.co/ggerganov/whisper.cpp (LFS SHA-256)
//   auto-editor     WyattBlue/auto-editor release 31.8.0 single binaries (Windows x64, Linux x64, macOS arm64)
//   rembg           PyPI rembg[cpu]==2.0.86 into its own uv venv (uv resolves with --exclude-newer PIP_AS_OF);
//                   u2net.onnx from the rembg release v0.0.0 (rembg itself also checks its MD5)
//   Pillow/OpenCV   PyPI pillow==13.0.0, opencv-python-headless==5.0.0.93, numpy==2.5.4 into their own uv venv
//   ComfyUI         comfyanonymous/ComfyUI release v0.44.0 Windows portable (NVIDIA; cu130 default, cu126 for drivers < 580);
//                   models: Comfy-Org/Flux-1-Schnell (Apache-2.0), stabilityai/stable-diffusion-xl-base-1.0 (OpenRAIL++-M),
//                   Comfy-Org/Wan-2.1 (Apache-2.0) — Hugging Face LFS SHA-256. Core only: custom nodes are never installed.
//   Left out: SoX (last Windows build 2015, ffmpeg does the same audio work); LTX-Video (its own non-standard license).

export const TOOLS_VERSION = '2026-11-06';
const GH = 'https://github.com';
const HF = 'https://huggingface.co';
export const COMFY_DIR = 'ComfyUI_windows_portable';
const COMFY_MODELS = `${COMFY_DIR}/ComfyUI/models`;
// uv resolves the extra Python tools as they were on this day (their own dependencies too): same install every time
export const PIP_AS_OF = '2026-11-01T00:00:00Z';
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
  // 4.13 擴充工具箱 (extra: true): only offered when the person turns 「擴充工具箱」 on (設定 → 技能與工具); default off.
  {
    id: 'realesrgan', extra: true, label: 'Real-ESRGAN', what: '圖片放大 2–4 倍並補回細節（照片、插圖都可以；用顯示卡，任何品牌）', bins: ['realesrgan-ncnn-vulkan'], license: 'BSD-3-Clause', source: `${GH}/xinntao/Real-ESRGAN`,
    hint: 'realesrgan-ncnn-vulkan -i 原圖.jpg -o 放大.png -s 4 -n realesrgan-x4plus（插圖、動畫用 -n realesr-animevideov3；-i、-o 給資料夾就整批放大）',
    builds: {
      'win-x64': { url: `${GH}/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip`, sha256: 'abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d', size: 45474481, version: '0.2.5.0', unpack: 'zip', bin: '' },
      'linux-x64': { url: `${GH}/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip`, sha256: 'e5aa6eb131234b87c0c51f82b89390f5e3e642b7b70f2b9bbe95b6a285a40c96', size: 46931474, version: '0.2.5.0', unpack: 'zip', bin: '', exec: ['realesrgan-ncnn-vulkan'] },
      'mac-x64': { url: `${GH}/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip`, sha256: 'e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a', size: 51817124, version: '0.2.5.0', unpack: 'zip', bin: '', exec: ['realesrgan-ncnn-vulkan'] }
    }
  },
  {
    id: 'rembg', extra: true, label: 'rembg', what: '圖片去背（人像、商品都可以，只用 CPU）', bins: ['rembg'], license: 'MIT', source: 'https://github.com/danielgatis/rembg',
    via: 'uv-venv', needs: ['uv'], version: '2.0.86', pip: ['rembg[cpu]==2.0.86'], size: 150e6, helper: 'rembg', env: { U2NET_HOME: 'models' },
    hint: 'rembg 原圖.jpg 去背.png（輸出透明背景 PNG；給資料夾就整批去背：rembg 原圖資料夾 輸出資料夾）',
    packs: {
      u2net: { label: 'u2net 去背模型', default: true, license: 'Apache-2.0', files: [{ url: `${GH}/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx`, sha256: '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491', size: 175997641, to: 'models/u2net.onnx' }] }
    }
  },
  {
    id: 'whisper', extra: true, label: 'whisper.cpp', what: '把影片或錄音轉成文字、做字幕（在自己電腦上跑，不上傳）', bins: ['whisper-cli', 'octa-subtitle'], license: 'MIT', source: `${GH}/ggml-org/whisper.cpp`,
    needs: ['ffmpeg'], helper: 'subtitle',
    hint: 'octa-subtitle 影片.mp4（做 .srt 和一個帶字幕的影片；--burn 把字幕燒進畫面、--lang zh、--text 只要逐字稿、--model small 比較準）',
    builds: {
      'win-x64': { url: `${GH}/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip`, sha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a', size: 8194445, version: '1.9.2', unpack: 'zip', bin: 'Release' },
      'linux-x64': { url: `${GH}/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-ubuntu-x64.tar.gz`, sha256: '46811a3ecf584307480a220b9ef5ff81b7b22dc41577cbc274ce3afc61f753b1', size: 9497583, version: '1.9.2', unpack: 'tar', bin: 'whisper-bin-ubuntu-x64' }
    },
    otherwise: { mac: 'brew install whisper-cpp' },
    // models: the official ggml conversions on Hugging Face (SHA-256 = the file's LFS id that Hugging Face publishes)
    packs: {
      base: { label: 'base 模型（多國語言）', default: true, license: 'MIT', files: [{ url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', size: 147951465, to: 'models/ggml-base.bin' }] },
      small: { label: 'small 模型（比較準、比較慢）', license: 'MIT', files: [{ url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-small.bin`, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', size: 487601967, to: 'models/ggml-small.bin' }] }
    }
  },
  {
    id: 'auto-editor', extra: true, label: 'auto-editor', what: '自動剪掉影片裡沒有聲音的空白片段', bins: ['auto-editor'], license: 'Unlicense', source: `${GH}/WyattBlue/auto-editor`,
    hint: 'auto-editor 影片.mp4 -o 剪好.mp4 --no-open（--margin 0.3s 保留前後一點、--edit audio:threshold=4% 調整多小聲算空白）',
    builds: {
      'win-x64': { url: `${GH}/WyattBlue/auto-editor/releases/download/31.8.0/auto-editor-windows-x86_64.exe`, sha256: 'ff86b58c84f8ceccd5b4069543405e545851923c056363171fe955e72a785ce4', size: 45473280, version: '31.8.0', unpack: 'file', file: 'auto-editor.exe', bin: '' },
      'linux-x64': { url: `${GH}/WyattBlue/auto-editor/releases/download/31.8.0/auto-editor-linux-x86_64`, sha256: 'ab6da1fb01019505eea416b948d053b4d5918778ddaeea9955b90bafd8227713', size: 47913368, version: '31.8.0', unpack: 'file', file: 'auto-editor', bin: '' },
      'mac-arm64': { url: `${GH}/WyattBlue/auto-editor/releases/download/31.8.0/auto-editor-macos-arm64`, sha256: '7be4c88c71f5143a0fb5388edfa53cfa39365f674b36c1ae56556a3baba22649', size: 33106120, version: '31.8.0', unpack: 'file', file: 'auto-editor', bin: '' }
    },
    otherwise: { mac: 'brew install auto-editor' }
  },
  {
    id: 'pyimage', extra: true, label: 'Python 圖片套件（Pillow、OpenCV）', what: '用 Python 程式批次處理圖片：縮圖、裁切、浮水印、調色、轉檔', bins: ['python'], license: 'MIT-CMU / Apache-2.0', source: 'https://pypi.org/project/pillow/',
    via: 'uv-venv', needs: ['uv'], version: 'Pillow 13.0.0 · OpenCV 5.0.0.93', pip: ['pillow==13.0.0', 'opencv-python-headless==5.0.0.93', 'numpy==2.5.4'], size: 75e6,
    hint: 'python 程式.py（程式裡 from PIL import Image、import cv2；這個 python 已經裝好這兩個套件）'
  },
  // ComfyUI: only on a computer with an NVIDIA GPU (Windows portable build, core only: no custom nodes), started by OCTA
  // on a local port when a picture or video is asked for, stopped after a while. Big: the person confirms the size first.
  {
    id: 'comfyui', extra: true, big: true, needsGpu: 'nvidia', label: 'ComfyUI（本機產生圖片影片）', what: '用自己的 NVIDIA 顯示卡產生圖片和影片，不用付 API 費用', bins: [], license: 'GPL-3.0', source: `${GH}/comfyanonymous/ComfyUI`,
    via: 'comfyui',
    builds: {
      // the default portable build needs an NVIDIA driver from the CUDA 13 era (580+); older drivers get the cu126 build
      'win-x64': { url: `${GH}/comfyanonymous/ComfyUI/releases/download/v0.44.0/ComfyUI_windows_portable_nvidia.7z`, sha256: '7170c2db49c182a81adcc051e80234f99dd891656fb200737f87797876348f96', size: 2054382457, version: '0.44.0', unpack: '7z', bin: '', minDriver: 580 },
      'win-x64-cu126': { url: `${GH}/comfyanonymous/ComfyUI/releases/download/v0.44.0/ComfyUI_windows_portable_nvidia_cu126.7z`, sha256: 'a26cf84f043b3d9fbf0d53296f57d7190482c339caf1b3b5cfda5149d454be9f', size: 1945636677, version: '0.44.0 (CUDA 12.6)', unpack: '7z', bin: '' }
    },
    otherwise: { linux: '照官方說明安裝（git clone + pip），OCTA 只自動安裝 Windows 版', mac: '照官方說明安裝（Apple 晶片），OCTA 只自動安裝 Windows 版' },
    // model packs: official Hugging Face repos (Comfy-Org = ComfyUI's own repackaging), SHA-256 = Hugging Face's LFS id
    packs: {
      'flux-schnell': { label: 'FLUX.1 schnell（圖片，快又好）', kind: 'image', minVram: 12, license: 'Apache-2.0', source: `${HF}/Comfy-Org/Flux-1-Schnell`, workflow: 'flux',
        files: [{ url: `${HF}/Comfy-Org/Flux-1-Schnell/resolve/main/flux1-schnell-fp8.safetensors`, sha256: 'ead426278b49030e9da5df862994f25ce94ab2ee4df38b556ddddb3db093bf72', size: 17236328572, to: `${COMFY_MODELS}/checkpoints/flux1-schnell-fp8.safetensors` }] },
      sdxl: { label: 'Stable Diffusion XL 1.0（圖片，顯示卡記憶體小也能用）', kind: 'image', minVram: 6, license: 'CreativeML OpenRAIL++-M', source: `${HF}/stabilityai/stable-diffusion-xl-base-1.0`, workflow: 'sdxl',
        files: [{ url: `${HF}/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors`, sha256: '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b', size: 6938078334, to: `${COMFY_MODELS}/checkpoints/sd_xl_base_1.0.safetensors` }] },
      'wan-1.3b': { label: 'Wan 2.1 文字轉影片 1.3B（約 2 秒短片）', kind: 'video', minVram: 12, license: 'Apache-2.0', source: `${HF}/Comfy-Org/Wan-2.1`, workflow: 'wan',
        files: [
          { url: `${HF}/Comfy-Org/Wan-2.1/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors`, sha256: 'be531024cd9018cb5b48c40cfbb6a6191645b1c792eb8bf4f8c1c6e10f924dc5', size: 2838303560, to: `${COMFY_MODELS}/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors` },
          { url: `${HF}/Comfy-Org/Wan-2.1/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`, sha256: 'c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68', size: 6735906897, to: `${COMFY_MODELS}/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` },
          { url: `${HF}/Comfy-Org/Wan-2.1/resolve/main/split_files/vae/wan_2.1_vae.safetensors`, sha256: '2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b', size: 253815318, to: `${COMFY_MODELS}/vae/wan_2.1_vae.safetensors` }
        ] }
    }
  }
];
const ALIAS = {
  ffprobe: 'ffmpeg', magick: 'imagemagick', 'image magick': 'imagemagick', python3: 'python', py: 'python', nodejs: 'node', 'node.js': 'node', ytdlp: 'yt-dlp', 'yt_dlp': 'yt-dlp', uvx: 'uv',
  'real-esrgan': 'realesrgan', esrgan: 'realesrgan', 'realesrgan-ncnn-vulkan': 'realesrgan', 'whisper.cpp': 'whisper', 'whisper-cli': 'whisper', whispercpp: 'whisper', 'octa-subtitle': 'whisper',
  autoeditor: 'auto-editor', 'auto_editor': 'auto-editor', pillow: 'pyimage', pil: 'pyimage', opencv: 'pyimage', cv2: 'pyimage', comfy: 'comfyui'
};
// extra: whether 擴充工具箱 is on — off, its tools are not in the catalog at all (4.12 as it was)
export const catalogItem = (id, extra = true) => {
  const k = String(id || '').trim().toLowerCase();
  const t = CATALOG.find(x => x.id === (ALIAS[k] || k)) || null;
  return t && t.extra && !extra ? null : t;
};
export const extraItems = () => CATALOG.filter(t => t.extra);
export const platformKey = (platform = process.platform, arch = process.arch) =>
  `${platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
// what this computer can do with a catalog item: 'download' | 'uv-python' | 'uv-venv' | 'bundled' | 'manual' (with how)
// gpu: { driver } — ComfyUI's newest build needs a recent NVIDIA driver; an older one gets the CUDA 12.6 build
export function buildFor(item, key = platformKey(), gpu = null) {
  if (!item) return { way: 'none' };
  if (item.later) return { way: 'later' };
  if (item.via === 'bundled') return { way: 'bundled' };
  if (item.via === 'uv-python') return { way: 'uv-python' };
  if (item.via === 'uv-venv') return { way: 'uv-venv', version: item.version, size: item.size || 0 };
  let b = item.builds?.[key] || (key.endsWith('arm64') && key.startsWith('mac') ? item.builds?.['mac-x64'] : null);
  if (b?.minDriver && gpu?.driver && +gpu.driver < b.minDriver && item.builds[key + '-cu126']) b = item.builds[key + '-cu126'];
  if (b) return { way: 'download', ...b };
  const os = key.split('-')[0];
  return { way: 'manual', how: item.otherwise?.[os] || '' };
}
// model packs of an item, and the ones a computer with this much graphics memory (GB) can run
export const packList = item => Object.entries(item?.packs || {}).map(([id, p]) => ({ id, ...p, size: p.files.reduce((n, f) => n + f.size, 0) }));
export function packFits(p, vram) {
  return !p.minVram || (+vram || 0) >= p.minVram;
}
// what to download with a tool when nothing was picked: its default packs; ComfyUI: the best image model this card runs
export function defaultPacks(item, vram = 0) {
  const all = packList(item);
  if (item?.id === 'comfyui') {
    const img = all.filter(p => p.kind === 'image' && packFits(p, vram)).sort((a, b) => (b.minVram || 0) - (a.minVram || 0))[0];
    return img ? [img.id] : [];
  }
  return all.filter(p => p.default).map(p => p.id);
}
// how much one install downloads: the program plus its packs
export function downloadSize(item, key = platformKey(), packs = null, gpu = null) {
  const b = buildFor(item, key, gpu);
  const ids = packs || defaultPacks(item, gpu?.vram);
  return (b.size || 0) + packList(item).filter(p => ids.includes(p.id)).reduce((n, p) => n + p.size, 0);
}
export const BIG_BYTES = 1_000_000_000; // bigger than this: the person confirms the size first
// the catalog as the settings page shows it (no URLs needed there, but the source and version are)
// opts: { extra (擴充工具箱 on), gpuInfo: { name, vram (GB), driver } }
export function catalogView(key = platformKey(), gpu = false, opts = {}) {
  return CATALOG.filter(t => (!t.extra || opts.extra) && (!t.needsGpu || gpu)).map(t => {
    const b = buildFor(t, key, opts.gpuInfo);
    const v = { id: t.id, label: t.label, what: t.what, license: t.license, source: t.source, later: !!t.later, way: b.way, version: b.version || t.version || '', size: b.size || t.size || 0, sha256: b.sha256 || '', how: b.how || '' };
    if (!t.extra) return v;
    const vram = opts.gpuInfo?.vram || 0;
    const rec = defaultPacks(t, vram);
    return {
      ...v, extra: true, hint: t.hint || '', big: !!t.big, needs: t.needs || [],
      packs: packList(t).map(p => ({ id: p.id, label: p.label, kind: p.kind || '', size: p.size, license: p.license, source: p.source || '', minVram: p.minVram || 0, fits: packFits(p, vram), pick: rec.includes(p.id) })),
      total: downloadSize(t, key, rec, opts.gpuInfo)
    };
  });
}
// what a bot is told about 擴充工具箱 (only when it is on): name, what for, how to use, whether it is here already
export function extraForBots(key, gpu, installed = {}) {
  return extraItems()
    .filter(t => (!t.needsGpu || gpu) && ['download', 'uv-venv'].includes(buildFor(t, key).way))
    .map(t => ({ id: t.id, label: t.label, what: t.what, hint: t.hint || '', installed: !!installed[t.id]?.ok, big: !!t.big }));
}

// ---------- off-catalog: what the bot or the person asked for, parsed (installed only after approval) ----------
// npm:套件[@版本] · pip:套件[==版本] · mcp:npm套件[@版本] · github:擁有者/專案[@標籤][:檔名]
export function parseToolAsk(s, extra = true) {
  const t = String(s || '').trim().replace(/^[「『"]|[」』"]$/g, '');
  let m;
  if ((m = t.match(/^npm[:：]\s*((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@([\w.^~-]+))?$/i))) return { type: 'npm', pkg: m[1].toLowerCase(), version: m[2] || '' };
  if ((m = t.match(/^(?:pip|pypi)[:：]\s*([A-Za-z0-9][\w.-]*)(?:==([\w.]+))?$/))) return { type: 'pip', pkg: m[1], version: m[2] || '' };
  if ((m = t.match(/^mcp[:：]\s*(?:npm[:：])?((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@([\w.^~-]+))?$/i))) return { type: 'mcp', pkg: m[1].toLowerCase(), version: m[2] || '' };
  if ((m = t.match(/^(?:github|gh)[:：]\s*([\w.-]+\/[\w.-]+)(?:@([\w.-]+))?(?:[:：]([\w.+-]+))?$/i))) return { type: 'github', repo: m[1], tag: m[2] || '', asset: m[3] || '' };
  const c = catalogItem(t, extra);
  if (c) return { type: 'catalog', id: c.id };
  // a tool with model packs: whisper:small, comfyui:wan-1.3b
  if ((m = t.match(/^([\w.-]+)[:：]\s*([\w.-]+)$/))) {
    const it = catalogItem(m[1], extra);
    if (it?.packs?.[m[2].toLowerCase()]) return { type: 'catalog', id: it.id, packs: [m[2].toLowerCase()] };
  }
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
