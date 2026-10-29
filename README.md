# LFM3 OS

**Liquid AI's LFM3, running as a local agent inside your browser.** Load the page once, wait
for the weights to download, and you have a model that plans, calls tools, keeps notes, runs
code, reads the web and can hand you a tap-to-open link for an app on your phone.

No server does the thinking. No API key is required. The page is a static GitHub Pages site.

- **Live:** `https://genity5-collab.github.io/lfm3-os/`
- **Model:** [onnx-community/LFM3-1.7B-ONNX](https://huggingface.co/onnx-community/LFM3-1.7B-ONNX) (Liquid AI, LFM Open License v1.0)
- **Runtime:** [Transformers.js](https://github.com/huggingface/transformers.js) 4.3.2 on WebGPU

---

## What it actually does

| Capability | How it works | Honest status |
|---|---|---|
| **Talks to LFM3 locally** | ONNX weights stream from Hugging Face once, then run on your GPU through WebGPU | Works. ~1.1 GB download for 4-bit, ~3.6 GB for fp16 |
| **Notes** | Write and read only. The system prompt makes it save durable facts; notes live in `localStorage` with search and JSON export. **Deleting is a human action** — the agent has no delete tool at all | Works, agent read/write, you delete |
| **Web search** | DuckDuckGo Lite and Wikipedia fetched through a text reader proxy, so the search happens in the cloud and your phone only renders results | Works with no key; sharper with a Tavily key or your own worker |
| **Web read** | Any URL fetched as clean markdown text and trimmed to ~5k chars | Works on most pages; paywalled or JS-only pages come back thin |
| **Code** | JavaScript runs in a Web Worker with `fetch`, `WebSocket`, `indexedDB` and `importScripts` removed, 4s timeout, output piped back to the model | Works for maths, parsing, generated tables. Not a filesystem |
| **Open apps on your phone** | Deep links (`tel:`, `sms:`, `mailto:`, YouTube, Maps, WhatsApp, Spotify, Calendar). Browsers refuse scripted launches, so the agent hands you a real button | Works when the app is installed. Nothing on desktop |
| **Text a contact** | `message_contact` drafts the message and builds a `wa.me` or `sms:` link | Works through your tap; gated by the Messages permission |
| **Call a contact** | `call_contact` builds a `tel:` link once a number is known | Dial only, through your tap. Gated by the Calls permission |
| **Works offline (after first load)** | Service worker caches the shell; Transformers.js caches weights in the browser cache | Works for app + model after the first successful load |

"Live stuff" means the loop is real: token streaming, tool cards that report actual results,
a status line tied to what is happening, and a stop button that actually interrupts generation.

---

## Quick start

1. Open the Pages URL in **Chrome, Edge, Brave or Safari 26+** (anything with WebGPU).
2. Click **Download and start**. The 4-bit build is ~1.1 GB; it is cached for next time.
3. Ask something that needs a tool: *"Search what changed in LFM3 and save a note about it."*

On mobile, WebGPU support is still uneven. The app detects it and says so instead of pretending.

---

## How the agent works

LFM3 1.7B is small, so the protocol is deliberately boring: **one JSON object per turn.**

```json
{"tool":"web_search","args":{"query":"Liquid AI LFM3 release"}}
```

```json
{"final":"LFM3 shipped as an open-weight 2B-class family with text, vision, audio and omni variants."}
```

The loop (`js/agent.js`):

1. System prompt (in `js/config.js`) lists the tools, the note rule and two worked examples.
2. The model replies with JSON. The first balanced JSON object is extracted.
3. `tool` → run it, feed `TOOL RESULT <name>: …` back as a user message, loop.
4. `final` → render the answer.
5. Guard rail: if the user says "remember / save / my name is…" and the model tries to answer
   without writing a note, it gets one nudge to call `note_save` first.
6. Step budget (default 6, configurable up to 12) keeps a confused model from spinning.

Thinking traces: LFM3's chat template can emit `thinking`. The app asks the template to skip it
with `enable_thinking: false`, and if a trace appears anyway it is stored and shown collapsed.

---

## Web search without a server of your own

Three tiers, tried in order:

1. **Your own worker** — deploy `cloud/search-worker.js` to Cloudflare Workers (free) and paste
   the URL in Settings. Returns `{results:[{title,url,snippet}]}` with CORS enabled.
2. **Tavily key** — paste a key in Settings. Best quality, stored only on your device.
3. **Free chain** — DuckDuckGo Lite via `r.jina.ai` reader, then the Wikipedia search API.
   No key, no account, works from any device.

If every tier fails the agent is told the search failed, and it says so instead of inventing hits.

---

## Permissions

The agent can only do what you allow, and the check lives in the tool layer — not just in the prompt.

| Switch | Default | What it unlocks |
|---|---|---|
| Read notes | on | `note_list` |
| Write notes | on | `note_save` |
| Open apps | on | `open_app` |
| Text contacts | on | `message_contact` (WhatsApp / SMS link) |
| Call contacts | **off** | `call_contact` (dial link) |

When a tool is blocked the model receives `permission denied` and is told to point you at
Settings → Permissions instead of retrying. There is **no delete capability anywhere**: not
disabled, absent.

### What a browser genuinely cannot do

A static page cannot answer an incoming call, read your contacts, or send a message on its own.
So this build does the honest version of each: it drafts the text and hands you a link, and the
Calls switch unlocks dialling. Auto-answering calls needs a native app with call permissions
(iOS CallKit / Android Telecom) — that is a different product, not a GitHub Pages site.

## Privacy

- Weights, chats, notes and settings stay in this browser. There is no backend in this repo.
- Outbound requests only happen when you use a web tool: `r.jina.ai` (reader), `api.tavily.com`
  (if you added a key), `en.wikipedia.org`, `huggingface.co` (weights), `cdn.jsdelivr.net` (runtime).
- "Delete everything on this device" wipes sessions, notes and settings. Model weights sit in the
  browser cache, so clearing site data also removes those.

---

## Limits, stated plainly

- LFM3 1.7B is a small model. It handles 2–4 step tool tasks well and loses the thread on long
  chains. Raise the step budget and it will still sometimes circle.
- No background execution: close the tab and the agent stops. There is no scheduler.
- Deep links and downloads cannot be triggered by script. The agent prepares the link, you tap it.
- No contact reading, no auto-send, no auto-answer. Permission switches gate intent, not OS powers.
- Vision (LFM3-VL 2B), audio (LFM3-Audio) and omni builds exist and run on the same runtime, but
  they are **not wired into this UI yet** — they are on the roadmap below, not in the product.
- WASM fallback works but is slow enough to be impractical; WebGPU is the real path.

---

## Repo layout

```
index.html            app shell
css/style.css         theme and layout
js/config.js          model registry, system prompt, defaults
js/model.js           Transformers.js engine: load, stream, stop
js/agent.js           the loop, JSON extraction, note guard
js/tools.js           search, read, notes, code sandbox, deep links, messaging, clock
js/store.js           sessions, settings, notes persistence
js/app.js             UI controller
sw.js                 offline shell
cloud/search-worker.js  optional Cloudflare Worker search endpoint
nova/                 Nova AI — the from-scratch micro-model app from Phollama-OS
```

## Deploy your own copy

```bash
git clone https://github.com/<you>/lfm3-os.git
cd lfm3-os
python3 -m http.server 8080     # then open http://localhost:8080
```

GitHub Pages: **Settings → Pages → Source: Deploy from a branch → main / (root)**. No build step,
no dependencies to install — everything is loaded from CDNs as ES modules.

---

## Roadmap

- [ ] LFM3-VL 2B: screenshot and camera input (weights already published, needs an image path in the UI)
- [ ] LFM3-Audio 2B: voice in, spoken answers out
- [ ] Persistent task queue so a long job survives a refresh
- [ ] Skill files: drop a `.md` file in `skills/` and the agent can follow it

---

## Credits and licences

- **LFM3** — Liquid AI, [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-1.7B). ONNX
  conversion by the ONNX Community. This repo only loads the published weights.
- **Transformers.js** — Hugging Face, Apache-2.0.
- **Nova AI** (`nova/`) — the from-scratch transformer chatbot from
  [Phollama-OS](https://github.com/genity5-collab/Phollama-OS), included unchanged so both local
  model experiments live in one place. Nova needs no pretrained weights at all.
- This app's own code: MIT.
