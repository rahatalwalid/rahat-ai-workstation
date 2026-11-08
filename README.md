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

> **About "video editing"**: like Grok and Claude, this workstation **analyzes and discusses video** (upload ≤ 30 MB, ask questions about it — works best with Gemini models). Frame-accurate cutting/encoding isn't possible on Cloudflare's serverless platform (no ffmpeg); trim your clips with any local tool first, then upload.

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
| **Chats** | Stream answers, attach files with 📎, switch agent/model in the header |
| **Image Studio** | Prompt → generate. Attach a **reference image** to edit/transform an existing picture. Download or “Save to library” (stores it in B2). |
| **Agents** | Create unlimited personas; tick “default” to make one the standard |
| **Settings** | Default chat + image model, storage usage stats |

## Free-tier limits to know

| Service | Free allowance | Notes |
| --- | --- | --- |
| Cloudflare Workers | 100k req/day | Plenty for personal use |
| Cloudflare D1 | 5 GB storage, 5M row reads/day | Chats are small |
| Backblaze B2 | 10 GB storage, free egress up to 3× storage/month | Check your dashboard |
| OpenRouter | Pay per token | Use `:free` model IDs or add $5 credit |

**Model payload cap:** files are sent to AI models inline; the worker refuses to inline anything larger than ~8 MB from the bucket (the model APIs themselves cap request size). Images are fine — they're downscaled in your browser first. For video, prefer clips of a few MB.

## Troubleshooting

- **`B2 authorize failed`** — wrong `B2_KEY_ID`/`B2_APP_KEY`, or the key wasn't scoped to the bucket.
- **`Upload did not reach storage`** — the presigned PUT failed; make sure the app key has Write access and hasn't expired (re-create it without an expiry).
- **Setup page already gone / want to reset the owner** — you can't create a second account by design. To start over: `npx wrangler d1 execute rahat-ai-db --remote --command "DELETE FROM users; DELETE FROM sessions;"` (chats stay).
- **402 from image generation** — your OpenRouter account needs credit for the chosen image model; try a different one in the Studio.
- **Model not in the list** — the list loads live from OpenRouter; you can also type any model ID into an agent's "Model" field.

## License

MIT — free to use, modify and share. © 2026 Rahat
