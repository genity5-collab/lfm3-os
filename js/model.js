// The inference engine: Transformers.js + WebGPU, streaming tokens.
import { MODELS } from './config.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

export function describeDevice() {
  const lines = [];
  const gpu = !!navigator.gpu;
  lines.push('webgpu: ' + (gpu ? 'available' : 'missing'));
  if (navigator.deviceMemory) lines.push('device memory: ~' + navigator.deviceMemory + ' GB');
  lines.push('hardware threads: ' + (navigator.hardwareConcurrency || '?'));
  lines.push('cache storage: ' + ('caches' in self ? 'yes' : 'no'));
  lines.push('ua: ' + (navigator.userAgentData?.platform || navigator.platform || 'unknown') + ' · ' + (/Mobi/.test(navigator.userAgent) ? 'mobile' : 'desktop'));
  return lines.join('\n');
}

/** Ask for a real WebGPU adapter; a browser can expose navigator.gpu without one. */
export async function probeDevice() {
  if (!navigator.gpu) return { webgpu: false, reason: 'no WebGPU in this browser' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { webgpu: false, reason: 'no GPU adapter available' };
    const info = adapter.info || {};
    return {
      webgpu: true,
      reason: 'webgpu adapter',
      detail: [info.vendor, info.architecture, info.description].filter(Boolean).join(' '),
    };
  } catch (e) {
    return { webgpu: false, reason: 'adapter failed: ' + (e.message || e) };
  }
}

export class Engine {
  constructor() {
    this.lib = null;
    this.pipe = null;
    this.config = null;
    this.stopping = null;
    this.generating = false;
  }

  get ready() {
    return !!this.pipe;
  }

  get label() {
    return this.config ? this.config.label : 'no model';
  }

  async unload() {
    try {
      if (this.stopping) this.stopping.interrupt();
    } catch {
      /* ignore */
    }
    try {
      if (this.pipe?.dispose) await this.pipe.dispose();
    } catch {
      /* ignore */
    }
    this.pipe = null;
    this.config = null;
  }

  /**
   * Load a model. Downloads weights once, then the browser cache serves them.
   * onProgress({phase, percent, file, loaded, total})
   */
  async load(modelKey, { onProgress = () => {}, onPhase = () => {} } = {}) {
    const config = MODELS.find((m) => m.id === modelKey) || MODELS[0];
    await this.unload();

    onPhase('loading runtime');
    const lib = await import(/* @vite-ignore */ CDN);
    this.lib = lib;
    lib.env.allowLocalModels = false;
    lib.env.useBrowserCache = true;
    lib.env.logLevel = 'error';

    onPhase('testing GPU');
    const probe = await probeDevice();
    const webgpu = probe.webgpu;
    const device = webgpu ? 'webgpu' : 'wasm';
    // WASM cannot run fp16/fp16 kernels well: drop to q4 there.
    const dtype = webgpu ? config.dtype : 'q4';
    if (!webgpu) onPhase('no GPU adapter - falling back to WASM (slow)');

    const files = new Map();
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, { loaded: p.loaded || 0, total: p.total });
        let loaded = 0;
        let total = 0;
        files.forEach((f) => {
          loaded += Math.min(f.loaded, f.total);
          total += f.total;
        });
        onProgress({
          percent: total ? Math.round((loaded / total) * 100) : 0,
          file: p.file,
          loaded,
          total,
        });
      } else if (p.status === 'done' && p.file) {
        onProgress({ percent: 100, file: p.file, loaded: p.total || 0, total: p.total || 0 });
      } else if (p.status === 'initiate') {
        onPhase('fetching weights');
      }
    };

    onPhase(webgpu ? 'starting WebGPU' : 'starting WASM (slow)');
    let pipe;
    try {
      pipe = await lib.pipeline(config.task, config.hf, { device, dtype, progress_callback });
    } catch (e) {
      if (!webgpu) throw e;
      onPhase('WebGPU failed (' + (e.message || e) + ') - retrying on WASM');
      pipe = await lib.pipeline(config.task, config.hf, {
        device: 'wasm',
        dtype: 'q4',
        progress_callback,
      });
    }

    this.pipe = pipe;
    this.config = config;
    this.stopping = new lib.InterruptableStoppingCriteria();
    onPhase('ready');
    return { config, device };
  }

  /**
   * One model turn. Returns the raw text the model produced.
   * Streaming tokens arrive through onToken.
   */
  async chat(messages, { onToken = () => {}, maxTokens = 288, temperature = 0.3, thinking = true } = {}) {
    if (!this.pipe) throw new Error('Model is not loaded yet.');
    const tokenizer = this.pipe.tokenizer;
    const lib = this.lib;

    let prompt;
    try {
      prompt = tokenizer.apply_chat_template(messages, {
        add_generation_prompt: true,
        tokenize: false,
        enable_thinking: thinking,
      });
    } catch {
      // Template without the thinking switch: fall back to the plain call.
      prompt = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, tokenize: false });
    }

    let acc = '';
    const streamer = new lib.TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunk) => {
        acc += chunk;
        onToken(chunk);
      },
    });

    this.generating = true;
    try {
      await this.pipe(prompt, {
        max_new_tokens: maxTokens,
        do_sample: temperature > 0,
        temperature: Math.max(0.01, temperature),
        top_p: 0.9,
        repetition_penalty: 1.04,
        streamer,
        stopping_criteria: this.stopping,
      });
    } finally {
      this.generating = false;
      try {
        this.stopping.reset();
      } catch {
        /* ignore */
      }
    }
    return acc;
  }

  stop() {
    try {
      this.stopping?.interrupt();
    } catch {
      /* ignore */
    }
  }
}
