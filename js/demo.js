// Demo engine: scripted model output so the agent loop, tools and UI can be
// tested without a 1 GB download. Open the app with ?demo=1 to use it.
// It never pretends to be LFM3 — the model chip reads "Demo loop".
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DemoEngine {
  constructor() {
    this.ready = true;
    this.config = { label: 'Demo loop', id: 'demo' };
    this.stopping = null;
  }

  async unload() {
    this.ready = false;
  }

  async load() {
    this.ready = true;
    return { config: this.config, device: 'scripted' };
  }

  stop() {
    this.stopping = 'stop';
  }

  async chat(messages, { onToken = () => {} } = {}) {
    const toolResults = messages.filter(
      (m) => m.role === 'user' && String(m.content).startsWith('TOOL RESULT')
    );
    const last = messages[messages.length - 1];
    const asked = String(messages.findLast?.((m) => m.role === 'user')?.content || '');

    let reply;
    const count = toolResults.length;
    if (count === 0) {
      reply = JSON.stringify({
        tool: 'web_search',
        args: { query: asked.slice(0, 80) || 'Liquid AI LFM3' },
      });
    } else if (count === 1) {
      reply = JSON.stringify({
        tool: 'note_save',
        args: {
          title: 'Demo note from the agent loop',
          body: 'This note was written by the scripted demo engine to prove the tool pipeline works.',
          tags: ['demo'],
        },
      });
    } else if (count === 2 && /code/i.test(asked)) {
      reply = JSON.stringify({
        tool: 'code_run',
        args: { code: 'console.log("fib", [1,1,2,3,5,8,13].join(", "))' },
      });
    } else {
      reply = JSON.stringify({
        final:
          'Demo loop finished. Every step above was real: the search hit live endpoints, the note went into this device\'s storage, and any code ran in the sandbox. Load a model to get actual LFM3 answers.',
      });
    }

    // Stream it in small chunks so the UI behaves like real generation.
    for (let i = 0; i < reply.length; i += 6) {
      if (this.stopping === 'stop') break;
      const chunk = reply.slice(i, i + 6);
      onToken(chunk);
      await sleep(12);
    }
    void last;
    return reply;
  }
}
