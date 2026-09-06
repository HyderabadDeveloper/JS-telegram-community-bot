# Telegram Community Bot

A dependency-free Node.js Telegram group bot that:

- Welcomes new members with configurable community guidelines.
- Removes messages containing configured spam terms.
- Responds to `/help` and `/guidelines`.
- Optionally answers `/ask your question` through an OpenAI-compatible AI API.
- Exposes `GET /health` for deployment health checks.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Add the bot to your group and promote it to an administrator with permission to delete messages.
3. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN`.
4. If AI help is wanted, set `AI_API_KEY` and adjust `AI_BASE_URL`/`AI_MODEL`.
5. Run `npm start`.

By default the bot uses Telegram long polling. Keep `.env` private.

## Webhook setup

Deploy the bot behind a public HTTPS endpoint that forwards requests to its HTTP port (3000 by default). For local development, use an HTTPS tunnel to that port.

Set these values in `.env`:

```dotenv
WEBHOOK_URL=https://your-domain.example/telegram/webhook
WEBHOOK_SECRET=replace_with_a_random_secret
PORT=3000
```

Generate a secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

Restart with `npm start`. The bot registers the webhook with Telegram after its HTTP server starts, verifies the secret on incoming requests, and handles messages without polling. The public URL must forward the same path to the bot. `/health` remains available.

Leave `WEBHOOK_URL` empty and restart to return to polling; startup removes the registered webhook without discarding pending updates. Run only one instance of this bot when switching modes.

Webhook requests are acknowledged after processing. Telegram can retry failed deliveries, so actions may repeat after a failure or restart; this simple bot does not store processed update IDs.
