# Discord Setup for LettaBot

This guide walks you through setting up Discord as a channel for LettaBot.

## Overview

LettaBot connects to Discord using a **Bot Application** with the Gateway API:
- No public URL required (uses WebSocket connection)
- Works behind firewalls
- Real-time bidirectional communication
- Guild-only (no DMs)

## Prerequisites

- A Discord server where you have permission to add bots
- LettaBot installed and configured with at least `LETTA_API_KEY`

## Step 1: Create a Discord Application

1. Go to **https://discord.com/developers/applications**
2. Click **"New Application"**
3. Enter a name (e.g., `LettaBot`)
4. Click **"Create"**

## Step 2: Create the Bot

1. In the left sidebar, click **"Bot"**
2. Click **"Reset Token"** (or "Add Bot" if this is new)
3. **Copy the token** - this is your `DISCORD_BOT_TOKEN`

   > **Important**: You can only see this token once. If you lose it, you'll need to reset it.

## Step 3: Enable Message Content Intent

This is required for the bot to read message content.

1. Still in the **"Bot"** section
2. Scroll down to **"Privileged Gateway Intents"**
3. Enable **"MESSAGE CONTENT INTENT"**
4. Click **"Save Changes"**

## Step 4: Generate Invite URL

1. In the left sidebar, go to **"OAuth2"** → **"URL Generator"**
2. Under **"Scopes"**, select:
   - `bot`
3. Under **"Bot Permissions"**, select:
   - `Send Messages`
   - `Read Message History`
   - `View Channels`
4. Copy the generated URL at the bottom

Or use this URL template (replace `YOUR_CLIENT_ID`):
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=68608&scope=bot
```

> **Tip**: Your Client ID is in **"General Information"** or in the URL when viewing your app.

## Step 5: Add Bot to Your Server

1. Open the invite URL from Step 4 in your browser
2. Select the server you want to add the bot to
3. Click **"Authorize"**
4. Complete the CAPTCHA if prompted

You should see `[Bot Name] has joined the server` in Discord.

## Step 6: Copy Guild and Channel IDs

LettaBot only responds in a single server (guild) and uses a **primary channel** where it replies to everything.

1. In Discord, go to **User Settings → Advanced → Developer Mode** and enable it
2. Right-click your server name → **Copy Server ID** (this is your `guildId`)
3. Right-click the primary channel → **Copy Channel ID** (this is your `channelId`)

## Step 7: Configure LettaBot

Run the onboarding wizard and select Discord:

```bash
lettabot onboard
```

Or add directly to your `lettabot.yaml`:

```yaml
channels:
  discord:
    enabled: true
    token: "your-bot-token-here"
    guildId: "123456789012345678"
    channelId: "123456789012345678"
```

## Step 8: Start LettaBot

```bash
lettabot server
```

You should see:
```
Registered channel: Discord
[Discord] Connecting...
[Discord] Bot logged in as YourBot#1234
[Discord] Guild: 123456789012345678
[Discord] Primary channel: 123456789012345678
```

## Step 9: Test the Integration

### In a Server Channel
1. Go to your **primary channel**
2. Type `hello!` (no mention needed)
3. The bot should respond

### In Other Channels
1. Go to another channel in the same server
2. Type `@YourBot hello!` or reply to a bot message
3. The bot should respond

### Direct Message
DMs are disabled. The bot will not respond to direct messages.

## Message Routing

- **Primary channel** (`channelId`): bot replies to all messages
- **Other channels in the same guild**: bot replies only when mentioned or when replying to the bot
- **Other guilds or DMs**: ignored

## Adding Reactions

LettaBot can react to messages using the `lettabot-react` CLI:

```bash
# React to the most recent message
lettabot-react add --emoji ":eyes:"

# React to a specific message
lettabot-react add --emoji ":thumbsup:" --channel discord --chat 123456789 --message 987654321
```

## Troubleshooting

### Bot shows as offline

1. Make sure LettaBot is running (`lettabot server`)
2. Check for errors in the console
3. Verify your bot token is correct

### Bot doesn't respond to messages

1. **Check MESSAGE CONTENT INTENT** is enabled:
   - Discord Developer Portal → Your App → Bot → Privileged Gateway Intents
   - Toggle ON "MESSAGE CONTENT INTENT"

2. **Check bot has permissions** in the channel:
   - Server Settings → Roles → Your Bot's Role
   - Or check channel-specific permissions

3. **Check routing rules**:
   - Primary channel replies to all messages
   - Other channels require @mention or reply to the bot

### "0 Servers" in Developer Portal

The bot hasn't been invited to any servers yet. Use the invite URL from Step 4.

### Bot can't DM users

DMs are disabled by design. Use the primary channel or mention the bot in other channels.

### Rate limiting

If the bot stops responding temporarily, it may be rate-limited by Discord. Wait a few minutes and try again. Avoid sending many messages in quick succession.

## Security Notes

- **Bot tokens** should be kept secret - never commit them to git
- The bot can only see messages in channels it has access to
- DMs are disabled

## Cross-Channel Memory

Since LettaBot uses a single agent across all channels:
- Messages you send on Discord continue the same conversation as Telegram/Slack
- The agent remembers context from all channels
- You can start a conversation on Telegram and continue it on Discord

## Next Steps

- [Slack Setup](./slack-setup.md)
- [WhatsApp Setup](./whatsapp-setup.md)
- [Signal Setup](./signal-setup.md)
