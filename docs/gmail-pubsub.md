# Gmail Pub/Sub Integration

Receive email notifications and have your Letta agent process them automatically.

## Overview

```
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐    ┌─────────────┐
│   Gmail     │───▶│ Google Cloud │───▶│  LettaBot       │───▶│   Letta     │
│   Inbox     │    │   Pub/Sub    │    │  Webhook Server │    │   Agent     │
└─────────────┘    └──────────────┘    └─────────────────┘    └──────┬──────┘
                                                                      │
                                                                      ▼
                                                               ┌─────────────┐
                                                               │  Telegram   │
                                                               └─────────────┘
```

When a new email arrives:
1. Gmail sends a notification to Google Cloud Pub/Sub
2. Pub/Sub pushes the notification to LettaBot's webhook
3. LettaBot fetches the email details via Gmail API
4. The email is sent to your Letta agent for processing
5. The agent's response is delivered to you on Telegram

## Prerequisites

- Google Cloud account with billing enabled
- Gmail account you want to monitor
- LettaBot running with a public URL (for Pub/Sub push)
- `gcloud` CLI installed ([install guide](https://cloud.google.com/sdk/docs/install))

## Setup Guide

### Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Note your **Project ID** (you'll need it later)

### Step 2: Enable Required APIs

```bash
# Set your project
gcloud config set project YOUR_PROJECT_ID

# Enable Gmail and Pub/Sub APIs
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

### Step 3: Create OAuth2 Credentials

1. Go to [APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **Create Credentials** > **OAuth client ID**
3. Select **Desktop app** as the application type
4. Name it "LettaBot Gmail"
5. Download the JSON file
6. Note the **Client ID** and **Client Secret**

### Step 4: Get a Refresh Token

You need to authorize LettaBot to access your Gmail. Use this script:

```bash
# Install the Google auth library
npm install googleapis

# Run this script to get a refresh token
node -e "
const { google } = require('googleapis');
const readline = require('readline');

const oauth2Client = new google.auth.OAuth2(
  'YOUR_CLIENT_ID',
  'YOUR_CLIENT_SECRET',
  'urn:ietf:wg:oauth:2.0:oob'
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/gmail.readonly'],
});

console.log('Authorize this app by visiting:', authUrl);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Enter the code: ', async (code) => {
  const { tokens } = await oauth2Client.getToken(code);
  console.log('Refresh Token:', tokens.refresh_token);
  rl.close();
});
"
```

Save the **Refresh Token** - you'll need it for configuration.

### Step 5: Create Pub/Sub Topic and Subscription

```bash
# Create a topic for Gmail notifications
gcloud pubsub topics create lettabot-gmail

# Grant Gmail permission to publish to the topic
gcloud pubsub topics add-iam-policy-binding lettabot-gmail \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

### Step 6: Configure LettaBot

Add these to your `.env` file:

```bash
# Enable Gmail integration
GMAIL_ENABLED=true

# Webhook server port (must be accessible from internet)
GMAIL_WEBHOOK_PORT=8788

# Shared secret for validating Pub/Sub requests (generate a random string)
GMAIL_WEBHOOK_TOKEN=your_random_secret_here

# OAuth2 credentials from Step 3
GMAIL_CLIENT_ID=your_client_id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your_client_secret

# Refresh token from Step 4
GMAIL_REFRESH_TOKEN=your_refresh_token

# Your Telegram user ID (to receive email notifications)
# Find this by messaging @userinfobot on Telegram
GMAIL_TELEGRAM_USER=123456789
```

### Step 7: Expose Webhook to Internet

LettaBot's webhook server needs to be accessible from the internet for Pub/Sub to push notifications.

**Option A: Using Tailscale Funnel (recommended)**
```bash
tailscale funnel 8788
```

**Option B: Using ngrok**
```bash
ngrok http 8788
```

**Option C: Using Cloudflare Tunnel**
```bash
cloudflared tunnel --url http://localhost:8788
```

Note your public URL (e.g., `https://your-domain.ts.net` or `https://abc123.ngrok.io`).

### Step 8: Create Pub/Sub Push Subscription

```bash
# Replace with your actual public URL and token
gcloud pubsub subscriptions create lettabot-gmail-push \
  --topic=lettabot-gmail \
  --push-endpoint="https://YOUR_PUBLIC_URL/webhooks/gmail?token=YOUR_WEBHOOK_TOKEN" \
  --ack-deadline=60
```

### Step 9: Start Gmail Watch

You need to tell Gmail to send notifications to your Pub/Sub topic. This watch expires after 7 days and needs to be renewed.

**Using the Gmail API directly:**

```bash
curl -X POST \
  'https://gmail.googleapis.com/gmail/v1/users/me/watch' \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H 'Content-Type: application/json' \
  -d '{
    "topicName": "projects/YOUR_PROJECT_ID/topics/lettabot-gmail",
    "labelIds": ["INBOX"]
  }'
```

**Using a helper script:**

```javascript
// watch-gmail.js
const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

async function startWatch() {
  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: 'projects/YOUR_PROJECT_ID/topics/lettabot-gmail',
      labelIds: ['INBOX'],
    },
  });
  console.log('Watch started:', res.data);
  console.log('Expires:', new Date(parseInt(res.data.expiration)));
}

startWatch();
```

### Step 10: Start LettaBot

```bash
cd /path/to/lettabot
npm run dev
```

You should see:
```
Starting LettaBot...
Bot started as @your_bot
Gmail webhook enabled on port 8788
Gmail webhook server listening on port 8788
```

## Testing

1. Send a test email to your Gmail account
2. Check LettaBot logs for the notification
3. You should receive a Telegram message with the agent's summary

## Troubleshooting

### "Invalid token" error
- Make sure `GMAIL_WEBHOOK_TOKEN` matches the `?token=` in your Pub/Sub subscription

### No notifications received
- Verify your public URL is accessible: `curl https://YOUR_URL/health`
- Check Pub/Sub subscription for errors in Google Cloud Console
- Make sure Gmail watch is active (re-run the watch command)

### "User not authorized" error
- Ensure you granted `roles/pubsub.publisher` to `gmail-api-push@system.gserviceaccount.com`

### Watch expired
- Gmail watches expire after 7 days
- Set up a cron job to renew: `0 0 * * * node watch-gmail.js`

## Cleanup

To disable Gmail integration:

```bash
# Stop the watch
curl -X POST \
  'https://gmail.googleapis.com/gmail/v1/users/me/stop' \
  -H "Authorization: Bearer $(gcloud auth print-access-token)"

# Delete Pub/Sub resources
gcloud pubsub subscriptions delete lettabot-gmail-push
gcloud pubsub topics delete lettabot-gmail

# Remove from .env
# GMAIL_ENABLED=false
```

## Security Considerations

- Keep your `GMAIL_WEBHOOK_TOKEN` secret
- The refresh token grants read access to your Gmail - store it securely
- Consider using a service account for production deployments
- LettaBot only reads emails, it cannot send or modify them
