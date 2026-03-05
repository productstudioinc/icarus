# Discord Bot Minimal Setup (Chat SDK + Redis)

This project now uses:

- `@chat-adapter/discord` (Chat SDK Discord adapter)
- `@chat-adapter/state-redis` (state + subscriptions)
- Redis for persistent bot state

## 1) Start local infrastructure with Docker

From the repo root:

```bash
docker compose up -d redis mom-sandbox
```

This gives you:

- `redis` on `localhost:6379`
- `mom-sandbox` container with `./data` mounted at `/workspace`

## 2) Create and configure Discord app

1. Go to <https://discord.com/developers/applications>
2. Create a new application
3. In **General Information**, copy:
   - **Application ID** → `DISCORD_APPLICATION_ID`
   - **Public Key** → `DISCORD_PUBLIC_KEY`
4. In **Bot**, reset/copy token:
   - **Token** → `DISCORD_BOT_TOKEN`
5. Enable **Message Content Intent** under privileged gateway intents

## 3) Invite bot to your server

In **OAuth2 → URL Generator**:

- Scopes: `bot`, `applications.commands`
- Permissions:
  - Send Messages
  - Send Messages in Threads
  - Create Public Threads
  - Read Message History
  - Add Reactions
  - Attach Files

Open the generated URL and add the bot to your server.

## 4) Configure webhook URL in Discord

In **General Information** set:

- **Interactions Endpoint URL**: `https://<your-domain>/api/webhooks/discord`

For local testing, run a tunnel (e.g. ngrok/cloudflared) and use that URL.

## 5) Environment variables

Set these before starting mom:

```bash
export DISCORD_BOT_TOKEN=...
export DISCORD_PUBLIC_KEY=...
export DISCORD_APPLICATION_ID=...
export REDIS_URL=redis://localhost:6379
export DISCORD_WEBHOOK_URL=https://<your-domain>/api/webhooks/discord
```

Optional Anthropic key if you don't use linked OAuth auth file:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## 6) Run mom

```bash
npm run dev
```

Behavior:

- In server channels, mention the bot and it will process the message.
- It adds 👀 while working and removes it when done.
- DMs are isolated per user session.
