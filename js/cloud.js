// Cloud engine: the same agent loop, but the model runs on a server so there is
// nothing to download. Three backends:
//   puter      - free, no key, no backend of your own (user-pays model)
//   groq /
//   openrouter - any OpenAI-compatible endpoint with your own key
//   custom     - your own proxy, e.g. the Cloudflare Worker in cloud/ai-worker.js
import { CLOUD_PROVIDERS } from './config.js';

let puterLoading = null;

// A hung provider request must fail loudly instead of spinning forever.
const CLOUD_TIMEOUT = 60000;

function loadPuter() {
  if (window.puter?.ai?.chat) return Promise.resolve();
  if (!puterLoading) {
    puterLoading = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'https://js.puter.com/v2/';
      tag.onload = () => resolve();
      tag.onerror = () => reject(new Error('could not load Puter, network blocked or offline'));
      document.head.appendChild(tag);
    });
  }
  return puterLoading;
}

const chunkText = (part) => {
  if (typeof part === 'string') return part;
  if (!part) return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.delta === 'string') return part.delta;
  if (typeof part.content === 'string') return part.content;
  if (typeof part.delta?.content === 'string') return part.delta.content;
  return '';
};

export class CloudEngine {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.ready = true;
    this.controller = null;
    this.aborted = false;
    this.refresh();
  }

  refresh() {
    const s = this.getSettings() || {};
    this.provider = s.cloudProvider || 'puter';
    const preset = CLOUD_PROVIDERS[this.provider] || CLOUD_PROVIDERS.puter;
    this.model = s.cloudModel || preset.defaultModel;
    this.base = (s.cloudBaseUrl || preset.base || '').replace(/\/+$/, '');
    this.key = s.cloudKey || '';
    this.config = {
      label: `${preset.short} · ${this.model}`,
      id: 'cloud',
      provider: this.provider,
    };
  }

  async load() {
    this.refresh();
    if (this.provider === 'puter') await loadPuter();
    return { config: this.config, device: 'cloud' };
  }

  async unload() {}

  stop() {
    this.aborted = true;
    try {
      this.controller?.abort();
    } catch {}
  }

  async chat(messages, { onToken = () => {}, temperature = 0.3, maxTokens = 0 } = {}) {
    this.refresh();
    this.aborted = false;
    const msgs = messages.map((m) => ({ role: m.role, content: String(m.content) }));
    // Reasoning models spend tokens thinking, so never cap cloud calls too low.
    const cap = Math.max(900, Number(maxTokens) || 0);
    const call =
      this.provider === 'puter'
        ? this.viaPuter(msgs, onToken, temperature, cap)
        : this.viaOpenAI(msgs, onToken, temperature, cap);

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.stop();
        reject(
          new Error(
            `no reply after ${CLOUD_TIMEOUT / 1000}s. A hosted model can be slow, Puter may be waiting for you to sign in, or the key/model is wrong.`
          )
        );
      }, CLOUD_TIMEOUT);
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async viaPuter(msgs, onToken, temperature, maxTokens) {
    await loadPuter();
    if (!window.puter?.ai?.chat) throw new Error('Puter did not initialise');
    const stream = await window.puter.ai.chat(msgs, {
      model: this.model,
      stream: true,
      temperature,
      max_tokens: maxTokens,
    });
    let out = '';
    for await (const part of stream) {
      if (this.aborted) break;
      const t = chunkText(part);
      if (!t) continue;
      out += t;
      onToken(t);
    }
    if (!out.trim()) throw new Error('Puter returned an empty reply');
    return out;
  }

  async viaOpenAI(msgs, onToken, temperature, maxTokens) {
    if (!this.base) throw new Error('set the base URL for this provider in Settings');
    this.controller = new AbortController();
    const res = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: msgs,
        stream: true,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: this.controller.signal,
    }).catch((e) => {
      throw new Error(`cannot reach ${this.base}: ${e.message}`);
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 240);
      throw new Error(`${res.status} ${res.statusText}${detail ? ' - ' + detail : ''}`);
    }
    if (!res.body) {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '';
      onToken(text);
      return text;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let out = '';
    let reasoning = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = json?.choices?.[0]?.delta || {};
        if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
        else if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        const t = delta.content || '';
        if (t) {
          out += t;
          onToken(t);
        }
      }
      if (this.aborted) break;
    }

    if (!out.trim()) {
      // A reasoning model can spend the whole budget thinking and emit no content.
      if (reasoning.trim()) {
        onToken(reasoning);
        return reasoning;
      }
      throw new Error('the provider returned nothing, check the model name and key');
    }
    return out;
  }
}
