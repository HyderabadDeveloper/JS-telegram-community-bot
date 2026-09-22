import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

const env = { ...parseEnv(readFileSync(".env", "utf8")), ...process.env };
const action = process.argv[2];
const wrangler = "node_modules/wrangler/bin/wrangler.js";

function run(args, input) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    stdio: input ? ["pipe", "inherit", "inherit"] : "inherit",
    input,
    env: { ...process.env, ...(env.CLOUDFLARE_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } : {}), ...(env.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN } : {}) }
  });
  if (result.error || result.status !== 0) throw new Error(`Wrangler ${args[0]} failed`);
}

async function telegram(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
  return data.result;
}

try {
  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.startsWith("replace_")) throw new Error("Configure TELEGRAM_BOT_TOKEN in .env first.");
  if (action === "secrets") {
    if (!env.WEBHOOK_SECRET) {
      env.WEBHOOK_SECRET = randomBytes(32).toString("hex");
      let source = readFileSync(".env", "utf8");
      source = /^\s*WEBHOOK_SECRET=.*$/m.test(source)
        ? source.replace(/^\s*WEBHOOK_SECRET=.*$/m, `WEBHOOK_SECRET=${env.WEBHOOK_SECRET}`)
        : `${source}\nWEBHOOK_SECRET=${env.WEBHOOK_SECRET}\n`;
      writeFileSync(".env", source);
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.WEBHOOK_SECRET)) throw new Error("WEBHOOK_SECRET must contain 1-256 letters, digits, underscores, or hyphens.");
    const keys = ["TELEGRAM_BOT_TOKEN", "WEBHOOK_SECRET", "AI_API_KEY", "AI_BASE_URL", "AI_MODEL", "AI_SYSTEM_PROMPT", "AI_KEYWORDS", "TEST_MODE", "SPAM_TERMS"];
    const secrets = Object.fromEntries(keys.map(key => [key, env[key] || ""]));
    run(["secret", "bulk"], JSON.stringify(secrets));
  } else if (action === "webhook") {
    const url = new URL(process.argv[3]);
    if (url.protocol !== "https:" || url.pathname !== "/telegram/webhook" || url.search || url.hash || url.username || url.password) throw new Error("Provide the HTTPS Worker URL ending in /telegram/webhook.");
    if (!env.WEBHOOK_SECRET) throw new Error("Upload secrets first.");
    const health = await fetch(new URL("/health", url));
    if (!health.ok) throw new Error(`Worker health check failed: ${health.status}`);
    // An update without a message checks authentication without sending a Telegram message.
    const probe = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
      body: JSON.stringify({ update_id: 0 })
    });
    if (!probe.ok) throw new Error(`Worker authentication check failed: ${probe.status}`);
    await telegram("setWebhook", {
      url: url.href,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      max_connections: 1
    });
    const info = await telegram("getWebhookInfo");
    if (info.url !== url.href) throw new Error("Telegram webhook URL verification failed.");
    let source = readFileSync(".env", "utf8");
    source = /^\s*WEBHOOK_URL=.*$/m.test(source)
      ? source.replace(/^\s*WEBHOOK_URL=.*$/m, `WEBHOOK_URL=${url.href}`)
      : `${source}\nWEBHOOK_URL=${url.href}\n`;
    writeFileSync(".env", source);
    console.log(JSON.stringify({ webhook: info.url, pendingUpdates: info.pending_update_count, lastError: info.last_error_message || null }));
  } else {
    throw new Error("Usage: node scripts/cloudflare.js secrets | webhook https://worker.example/telegram/webhook");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
