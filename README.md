# 👑 Rahat AI Workstation

A **private, single-owner AI workstation** — your own Grok/Claude-style assistant running entirely on your Cloudflare account, with files on your own Backblaze B2 bucket and AI from your own OpenRouter key. No one else can use it.

![stack](https://img.shields.io/badge/Cloudflare-Workers-orange) ![stack](https://img.shields.io/badge/Cloudflare-D1-blue) ![stack](https://img.shields.io/badge/Backblaze-B2-red) ![stack](https://img.shields.io/badge/AI-OpenRouter-purple) ![license](https://img.shields.io/badge/license-MIT-green)

## Features

- **💬 Streaming chat** — Grok-style dark UI, full chat history, rename/delete conversations
- **📎 Multimodal attachments** — send **images (≤ 10 MB)**, **PDFs, audio, video (≤ 30 MB)** to models like Gemini. Images are auto-downscaled in your browser before being sent to the model; originals stay in your bucket.
- **🎨 Image Studio** — generate images (OpenRouter Image API) and **edit existing images** by attaching a reference image. Download or save results to your library.
- **🤖 Agents** — build custom AI personas (name, emoji, system prompt, model, temperature). Ships with three: **Rahat — CEO** (default chief-of-staff persona), **Strategist**, and **Engineer**.
- **🔐 Owner-only access** — one-time setup creates a single owner account (email + password, PBKDF2-hashed); sessions are HttpOnly cookies. Optional setup code blocks anyone else from claiming the instance.
- **🗄️ Your data, your accounts** — every chat lives in **your** D1 database; every file in **your** private B2 bucket (served via short-lived presigned URLs).
- **💸 Free-tier friendly** — Cloudflare Workers free plan, D1 free tier, B2 free tier (10 GB storage). Only OpenRouter usage costs money, and you can pick `:free` models.

> **About "video editing"**: like Grok and Claude, this workstation **analyzes and discusses video** (upload ≤ 30 MB, ask questions about it — works best with Gemini models). And since v2.1 it can also **make and edit videos** — see the Video Studio below (all rendering happens in your browser, because Cloudflare's serverless platform has no ffmpeg).

## What's new in v2.2 — parity with Claude & GLM (researched)

A feature audit against **Claude** (claude.ai) and **Z.ai / GLM-5.3-Flash** found four tools both products share that the workstation lacked. All four are now built:

- **🔬 Deep Research mode** — toggle it in the chat header (next to ⚡ Auto). The agent gets up to 12 tool rounds (instead of 6) and instructions to cover 3–5 independent sources, cross-check conflicting claims and cite every key claim with links — the equivalent of Claude's *Research* and Z.ai's *Deep Think*. Slower, but much deeper.
- **🎙 Voice input** — a mic button appears in the composer (browsers with speech recognition; Chrome/Android/desktop Chrome). Talk, and your words are typed into the prompt — like Claude's voice mode.
- **🐍 Python Lab** — Claude and Z.ai both ship a Python sandbox; Cloudflare's server can't run Python, so this runs **real Python in the browser** (Pyodide/WebAssembly, downloaded once ~10 MB from a CDN). Paste code the agent wrote and press ▶ Run — prints, math, JSON, no compiling. The agent now knows to deliver Python as runnable code artifacts.
- **⬇ Word export** — artifacts (reports, markdown, code) can now be downloaded as `.doc` files that open in Word, Google Docs and WPS — the lightweight version of Claude's file creation, since the serverless platform can't build real `.docx/.pptx/.xlsx`.

## What's new in v2.1 — the Video Studio

- **🎬 Motion Graphics maker** — six templates (intro title, lower third, logo reveal, promo card, countdown, outro/subscribe): type your text, pick colors/size/duration, preview live, then **render a real video file** (MP4 on most browsers, WebM otherwise) — downloaded instantly, optional background music.
- **📝 2D Animation programs** — the agent has a new `make_video_program` tool: ask in chat (*"make a 2D animation of a rocket launching"*) and it writes a JSON animation program as an artifact; open it and press Render. You can also hand-edit the JSON (canvas scenes, keyframes with easing).
- **✂️ Raw video editing** — load several clips, **trim** start/end, **reorder**, mute, add music, and export the cut as one video. Everything renders client-side on canvas + MediaRecorder (no server ffmpeg needed). Export runs in real time, so a 30-second cut takes ~30 seconds.

## What's new in v2 — the autonomous agent

The workstation is now a real agent with a tool belt (Claude/GLM-style abilities), and **you never pick models again**:

- **⚡ Auto model routing** — chat requests go to `openrouter/auto`: OpenRouter reads the whole conversation and picks the best available model itself. Provider **fallbacks** (`gemini-2.5-flash` → `gpt-5-mini` → `deepseek-v3.1`) transparently retry when a model is rate-limited or down — no more hitting one model's limits.
- **🔍 Web search** — the agent searches the live web (OpenRouter `web` plugin) and cites sources for anything current.
- **🌐 Read pages** — it fetches and reads any URL before commenting on it.
- **⚙️ Run code** — a JavaScript sandbox for exact math, data crunching and logic checks (sync JS, no network).
- **🎨 Generate images from chat** — "make me a logo…" works right in the conversation; the image appears in the bubble and is saved.
- **🧩 Artifacts** — long-form work (full runnable websites, reports, code files) is delivered as artifacts: live HTML preview, download, and **one-tap PDF export** via the print dialog. Everything the agent builds is listed in the **Artifacts** view.
- **🧠 Permanent memory** — say "remember that…" in chat; durable facts are stored and injected into every future conversation. Manage them in Settings.
- **🔌 Connections** — paste an API token for **Netlify, Vercel, or any REST API** (Connections view) and then just ask: *"deploy my website to Netlify"*, *"check my Vercel deployments"*. The agent calls the API on your behalf via `api_request`. Tokens live only in your private D1.
- **🔊 Read aloud** — every reply has a speak button (browser TTS).
- **Live activity timeline** — you see each tool call as it happens (search → read page → build artifact) and in chat history afterwards.

## Architecture

```
Browser (public/ — static, no build step)
   │  same-origin fetch
   ▼
Cloudflare Worker (src/worker.js)  ──►  OpenRouter  (chat SSE / Image API)
   │            │
   │            └──►  D1  (users, sessions, chats, messages, agents, settings)
   │
   └──►  Backblaze B2 (S3 API, presigned PUT/GET/DELETE — browser uploads directly)
```

## Prerequisites

- A [Cloudflare](https://dash.cloudflare.com) account (free)
- A [Backblaze](https://www.backblaze.com) account (free tier: 10 GB storage)
- An [OpenRouter](https://openrouter.ai/settings/keys) API key
- Node.js 18+ on your machine

## Setup

### 1. Backblaze B2 — private bucket + key

1. In the Backblaze web app, go to **B2 Cloud Storage → Buckets → Create a Bucket**.
2. Name it (e.g. `rahat-ai-files`), set **Private**, and create it.
3. Go to **Application Keys → Add a New Application Key**:
   - Name: `rahat-ai`
   - **Allow access to Bucket(s): select only your bucket** (limit the scope!)
   - Type: Read and Write
4. Copy the **keyID** and **applicationKey** (shown only once) — you'll need `B2_KEY_ID` and `B2_APP_KEY`.

*(CORS is not required: the app serves files through same-origin 302 redirects to presigned URLs, which works for `<img>`, `<video>`, `<a>` downloads without any bucket CORS configuration.)*

### 2. Cloudflare D1 — fresh database

You said you'll delete your current D1 — do that (or keep it), then:

```bash
npm install
npx wrangler login
npx wrangler d1 create rahat-ai-db
```

Copy the `database_id` from the output into `wrangler.jsonc` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`). Then apply the schema:

```bash
npm run db:init        # runs: wrangler d1 execute rahat-ai-db --remote --file=./schema.sql
```

If you ever want to wipe and re-create everything: delete the D1 database in the dashboard, re-run `d1 create` + update `wrangler.jsonc` + re-run `npm run db:init`.

### 3. Secrets

Set these once (they're stored encrypted in Cloudflare, never in git):

```bash
npx wrangler secret put OPENROUTER_API_KEY   # your OpenRouter key
npx wrangler secret put B2_KEY_ID            # Backblaze keyID
npx wrangler secret put B2_APP_KEY           # Backblaze applicationKey
npx wrangler secret put B2_BUCKET_NAME       # e.g. rahat-ai-files
npx wrangler secret put SETUP_CODE           # optional but recommended: any random string
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill the same values.

### 4. Deploy

```bash
npm run deploy       # wrangler deploy
```

Open the URL it prints (e.g. `https://rahat-ai.<your-subdomain>.workers.dev`). You'll see the **one-time setup** page — create the owner account (your email + a password of at least 8 characters + your setup code). After that the setup page disappears forever and only you can log in.

### 5. Put it on GitHub

```bash
git init
git add .
git commit -m "Rahat AI Workstation — private AI workstation on Cloudflare"
git branch -M main
# create an empty repo on github.com first (or with: gh repo create rahat-ai-workstation --public --source=. --push)
git remote add origin https://github.com/<your-username>/rahat-ai-workstation.git
git push -u origin main
```

Secrets are **not** in the repo (they're Cloudflare-encrypted), so pushing is safe even for a public repo. Optional: in the Cloudflare dashboard, go to **Workers & Pages → your worker → Settings → Build → Connect to Git** to make every `git push` auto-deploy.

### 6. Custom domain (optional)

Workers dashboard → your worker → **Settings → Domains & Routes → Add** → Custom Domain. Free, automatic TLS.

## Daily use

| Where | What |
| --- | --- |
| **Chats** | Stream answers, attach files with 📎, switch agent in the header, toggle 🔬 **Research** for deep multi-source answers, tap 🎙 to dictate. Model is always Auto. |
| **Python Lab** | Paste any Python and press ▶ Run — real Python in your browser (Pyodide), variables persist between runs. |
| **Image Studio** | Prompt → generate. Attach a **reference image** to edit/transform an existing picture. Download or “Save to library” (stores it in B2). |
| **Video Studio** | ✨ Motion graphics templates, 📝 2D animation programs (ask the agent in chat!), ✂️ trim/reorder/mute your raw clips and export with music. |
| **Artifacts** | Everything the agent built: websites (live preview), reports, code, images, video programs. Open → view, ⬇ download, 🖨 export PDF. |
| **Connections** | Add Netlify / Vercel / any REST API (name + base URL + `Bearer <token>` auth header). Then ask the agent to use it in chat. |
| **Agents** | Create unlimited personas; tick “default” to make one the standard |
| **Settings** | Usage stats + the agent's permanent memory list |

## Free-tier limits to know

| Service | Free allowance | Notes |
| --- | --- | --- |
| Cloudflare Workers | 100k req/day | Plenty for personal use |
| Cloudflare D1 | 5 GB storage, 5M row reads/day | Chats are small |
| Backblaze B2 | 10 GB storage, free egress up to 3× storage/month | Check your dashboard |
| OpenRouter | Pay per token | Use `:free` model IDs or add $5 credit |

**Model payload cap:** files are sent to AI models inline; the worker refuses to inline anything larger than ~8 MB from the bucket (the model APIs themselves cap request size). Images are fine — they're downscaled in your browser first. For video, prefer clips of a few MB.

## Troubleshooting

- **`B2 authorize failed`** — the error now tells you which case it is: *missing variables* (add `B2_KEY_ID`/`B2_APP_KEY`/`B2_BUCKET_NAME` in Worker → Settings → Variables and Secrets) or a *rejected key pair* (keyID and applicationKey must come from the same Application Key; re-create the key if you lost the original; no spaces/quotes when pasting).
- **`Upload did not reach storage`** — the presigned PUT failed; make sure the app key has Write access and hasn't expired (re-create it without an expiry).
- **Setup page already gone / want to reset the owner** — you can't create a second account by design. To start over: `npx wrangler d1 execute rahat-ai-db --remote --command "DELETE FROM users; DELETE FROM sessions;"` (chats stay).
- **402 from OpenRouter** — image generation and web search consume credit on your OpenRouter account; add credit at openrouter.ai/credits.
- **A tool fails with "Connection … not found"** — add the service in Connections first (exact name), then ask again.
- **`refusing to allow a GitHub App to create or update workflow … without 'workflows' permission`** — the zip contained `.github/workflows/unpack.yml`, and GitHub never lets an Action's own token push workflow-file changes. Fix: upload a zip built **without** the `.github` folder (v2.1 zips already exclude it; the unpack script also strips `.github` on its side). Nothing else to change.
- **Upgrading from v1 / v2.0** — nothing to do: new tables (artifacts, memories, connections), the `tool_log` column and the v2.1 `video-program` artifact type are created/migrated automatically on the first request after deploy.
- **Video Studio renders nothing / no video file** — your browser lacks MediaRecorder canvas capture (rare). Use Chrome/Edge/Safari 16+; on Android Chrome the output is WebM, on most desktops MP4.
- **Rendered video has no audio** — check the clip isn't muted and music was selected *before* pressing Render; browser security requires the sound sources to be picked during the same user interaction.

## License

MIT — free to use, modify and share. © 2026 Rahat
