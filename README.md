# Telegram Community Bot

A dependency-free Node.js Telegram group bot that:

- Welcomes new members with configurable community guidelines.
- Removes messages containing configured spam terms.
- Welcomes new members with an introduction, bot instructions, and community rules.
- Responds to `/help`, `/rules`, `/guidelines`, and interactive `/cfamaterial` and `/frmmaterial` menus.
- Optionally answers `/ask your question` or `ask your question` through Gemini.
- Exposes `GET /health` for deployment health checks.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Add the bot to your group and promote it to an administrator with permission to delete messages.
3. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN`.
4. To enable Gemini, create a key in [Google AI Studio](https://aistudio.google.com/app/apikey), set it as `AI_API_KEY`, and use the Gemini values from `.env.example`.
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

## Cloudflare Workers (Wrangler)

Requires Node.js 22 or newer for the deployment tools. The Worker uses `src/worker.js`; the local Node server remains in `src/index.js`. Both share `src/bot.js`.

1. Run `npm install` and `npx wrangler login`.
2. Run `npm test` and `npm run deploy:check`.
3. Run `npm run deploy` to create/update `telegram-community-bot`.
4. Run `npm run secrets:upload` to upload the bot settings from `.env` as encrypted Worker secrets. A webhook secret is generated if absent. Credentials are passed through stdin, not command arguments.
5. Run `npm run webhook:set -- https://telegram-community-bot.YOUR-SUBDOMAIN.workers.dev/telegram/webhook` using the URL Wrangler prints. This checks health and authentication, registers the webhook (including inline-button clicks), and saves the URL in `.env`.

Cloudflare supplies HTTPS; no tunnel or `PORT` setting is needed in production. Stop any locally running bot before switching. Do not run `npm start` while the Cloudflare deployment handles your bot; use `npm run dev:worker` for local Worker development. On Windows, use `npm.cmd` and `npx.cmd` if PowerShell blocks the `.ps1` launchers.

After code changes, run `npm run deploy`. If a change adds a Telegram update type, such as inline-button clicks, also rerun `npm run webhook:set -- <url>`. After changing bot settings in `.env`, run `npm run secrets:upload`; if you change the webhook secret, also rerun `npm run webhook:set -- <url>`.

## Gemini assistant

Set these values in `.env`:

```dotenv
AI_API_KEY=your_gemini_api_key
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
AI_MODEL=gemini-3.7-flash
```

Upload the settings with `npm run secrets:upload`. Users can then send `/ask What is Cloudflare?` or `ask What is Cloudflare?`. Never commit the API key.

Messages containing a whole-word match for `share`, `suggest`, `send`, `guide`, or `anyone` are also sent to Gemini. Configure the comma-separated list with `AI_KEYWORDS`. Each Telegram user can invoke Gemini up to three times in any rolling five-minute window; `/ask`, plain `ask`, and keyword triggers share the same limit.

Set `TEST_MODE=true` to bypass the Gemini rate limit while testing. Set it back to `false` and run `npm run secrets:upload` before normal use. Test mode affects every user of the deployed bot while enabled.
