// The agent loop: prompt -> JSON tool calls -> results -> final answer.
import { DEFAULT_PROMPT } from './config.js';
import { callTool, TOOL_META } from './tools.js';

export const stripThinking = (text) =>
  String(text)
    .replace(/<\|?think\|?>[\s\S]*?<\/\|?think\|?>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();

/** Pull the first balanced JSON object out of a model reply. */
export function extractJson(raw) {
  if (!raw) return null;
  const text = stripThinking(raw)
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          try {
            return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1').replace(/(\w+)\s*:/g, '"$1":').replace(/""/g, '"'));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

const NOTE_TRIGGER = /remember|note|save|my name|i prefer|i like|i use|don't forget|do not forget|keep this/i;

export class Agent {
  /**
   * @param engine  Engine instance
   * @param getSettings () => settings
   * @param handlers {onToken, onThink, onTool, onStatus, onFinal, onError, onNote}
   */
  constructor(engine, getSettings, handlers = {}) {
    this.engine = engine;
    this.getSettings = getSettings;
    this.h = handlers;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    this.engine.stop();
  }

  /**
   * Run one user turn.
   * @param history [{role:'user'|'assistant', content:string}]
   * @returns {final, steps, messages}
   */
  async run(history) {
    const settings = this.getSettings();
    const messages = [{ role: 'system', content: DEFAULT_PROMPT }, ...history];
    const steps = [];
    let noted = false;
    let nudged = false;

    for (let step = 0; step < settings.maxSteps; step++) {
      if (this.cancelled) break;

      this.h.onStatus?.(`thinking · step ${step + 1} of ${settings.maxSteps}`);
      let raw = '';
      const text = await this.engine.chat(messages, {
        maxTokens: settings.maxTokens,
        temperature: settings.temperature,
        thinking: settings.thinking,
        onToken: (chunk) => {
          raw += chunk;
          this.h.onToken?.(chunk, raw);
        },
      });

      const parsed = extractJson(text);

      // No JSON at all: treat the plain reply as the answer.
      if (!parsed) {
        messages.push({ role: 'assistant', content: text });
        return { final: stripThinking(text) || '(empty reply)', steps, messages };
      }

      if (typeof parsed.final === 'string') {
        notesGuard: {
          if (!noted && !nudged && NOTE_TRIGGER.test(history[history.length - 1]?.content || '')) {
            nudged = true;
            messages.push({ role: 'assistant', content: text });
            messages.push({
              role: 'user',
              content:
                'SYSTEM: you did not save a note. The user shared something worth keeping. Call note_save now, then repeat your final answer.',
            });
            break notesGuard;
          }
          return { final: parsed.final, steps, messages };
        }
        continue;
      }

      const toolName = parsed.tool || parsed.name || parsed.action;
      const toolArgs = parsed.args || parsed.arguments || parsed.parameters || {};

      if (toolName && TOOL_META[toolName]) {
        const meta = TOOL_META[toolName];
        this.h.onStatus?.(`${meta.label.toLowerCase()}…`);
        const id = 'tool_' + steps.length;
        this.h.onTool?.({ id, name: toolName, args: toolArgs, state: 'run', meta });

        let result;
        try {
          result = await callTool(toolName, toolArgs, settings);
        } catch (e) {
          result = { text: 'error: ' + (e.message || String(e)) };
        }

        if (toolName === 'note_save') noted = true;
        if (result.event === 'notes') this.h.onNote?.();

        const failed = String(result.text).startsWith('error');
        steps.push({
          name: toolName,
          args: toolArgs,
          result: result.text,
          data: result.data,
          launch: result.launch,
          state: failed ? 'err' : 'ok',
          meta,
          output: result.text,
        });
        this.h.onTool?.({
          id,
          name: toolName,
          args: toolArgs,
          state: failed ? 'err' : 'ok',
          meta,
          output: result.text,
          launch: result.launch,
        });

        messages.push({ role: 'assistant', content: JSON.stringify({ tool: toolName, args: toolArgs }) });
        messages.push({
          role: 'user',
          content: `TOOL RESULT ${toolName}:\n${String(result.text).slice(0, 2200)}`,
        });
        continue;
      }

      // Unknown tool or stray JSON: ask once more with a hint, then give up gracefully.
      if (step < settings.maxSteps - 1) {
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: `SYSTEM: "${toolName || 'unknown'}" is not a tool. Available tools: ${Object.keys(TOOL_META).join(', ')}. Reply with one JSON object.`,
        });
        continue;
      }
    }

    if (this.cancelled) return { final: '', steps, messages, cancelled: true };

    return {
      final:
        steps.length
          ? `I stopped after ${steps.length} tool step${steps.length === 1 ? '' : 's'} without a clean answer. Ask me again, or narrow the task.`
          : 'I ran out of steps without an answer. Try a shorter request.',
      steps,
      messages,
    };
  }
}
