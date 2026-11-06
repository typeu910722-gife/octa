// 4.13 本機產生: the ComfyUI workflows (API format, core nodes only) for the model packs in the catalog (toolbox.mjs).
// A 【產生】 block becomes one of these: its 描述 is the prompt, 比例 picks the size, nothing else is taken from the bot.
const IMG = { '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344], '4:3': [1152, 896], '3:4': [896, 1152], '3:2': [1216, 832], '2:3': [832, 1216] };
const VID = { '16:9': [832, 480], '9:16': [480, 832], '1:1': [624, 624], '4:3': [640, 480], '3:4': [480, 640] };
// the negative prompt Wan's own examples use (it was trained with Chinese ones)
const WAN_NEG = '色調艷麗，過曝，靜態，細節模糊不清，字幕，風格，作品，畫作，畫面，靜止，整體發灰，最差質量，低質量，JPEG壓縮殘留，醜陋的，殘缺的，多餘的手指，畫得不好的手部，畫得不好的臉部，畸形的，毀容的，形態畸形的肢體，手指融合，靜止不動的畫面，雜亂的背景，三條腿，背景人很多，倒著走';
export function comfyWorkflow(kind, task, seed = 1) {
  const text = String(task.prompt || '').slice(0, 4000);
  const prefix = 'octa';
  if (kind === 'flux' || kind === 'sdxl') {
    const [w, h] = IMG[task.aspect] || IMG['1:1'];
    const flux = kind === 'flux';
    return {
      4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: flux ? 'flux1-schnell-fp8.safetensors' : 'sd_xl_base_1.0.safetensors' } },
      6: { class_type: 'CLIPTextEncode', inputs: { text, clip: ['4', 1] } },
      7: { class_type: 'CLIPTextEncode', inputs: { text: flux ? '' : 'blurry, low quality, watermark, deformed', clip: ['4', 1] } },
      5: { class_type: flux ? 'EmptySD3LatentImage' : 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } },
      3: {
        class_type: 'KSampler',
        inputs: { seed, steps: flux ? 4 : 25, cfg: flux ? 1 : 7, sampler_name: flux ? 'euler' : 'dpmpp_2m', scheduler: flux ? 'simple' : 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }
      },
      8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      9: { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['8', 0] } }
    };
  }
  if (kind === 'wan') {
    const [w, h] = VID[task.aspect] || VID['16:9'];
    return {
      37: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.1_t2v_1.3B_fp16.safetensors', weight_dtype: 'default' } },
      38: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } },
      39: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
      48: { class_type: 'ModelSamplingSD3', inputs: { shift: 8, model: ['37', 0] } },
      6: { class_type: 'CLIPTextEncode', inputs: { text, clip: ['38', 0] } },
      7: { class_type: 'CLIPTextEncode', inputs: { text: WAN_NEG, clip: ['38', 0] } },
      40: { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: w, height: h, length: 33, batch_size: 1 } },
      3: { class_type: 'KSampler', inputs: { seed, steps: 30, cfg: 6, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1, model: ['48', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['40', 0] } },
      8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['39', 0] } },
      47: { class_type: 'SaveWEBM', inputs: { images: ['8', 0], filename_prefix: prefix, codec: 'vp9', fps: 16, crf: 32 } }
    };
  }
  throw new Error('不認得這個模型的流程：' + kind);
}
