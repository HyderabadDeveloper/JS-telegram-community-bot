import http from "node:http";
import { createBot } from "./bot.js";
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and configure it.");
}

const aiEnabled = Boolean(process.env.AI_API_KEY);
const webhookUrl = process.env.WEBHOOK_URL || "";
const webhookSecret = process.env.WEBHOOK_SECRET || "";
const port = Number(process.env.PORT || 3000);
let webhookPath;
if (webhookUrl) {
  const url = new URL(webhookUrl);
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password || url.pathname === "/health") {
    throw new Error("WEBHOOK_URL must be an HTTPS URL without credentials, query, or fragment, and cannot use /health.");
  }
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error("WEBHOOK_SECRET must contain 1-256 letters, digits, underscores, or hyphens.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Webhook mode requires PORT between 1 and 65535.");
  }
  console.log(`Webhook mode enabled. Listening on port ${port} for ${webhookUrl}`);
  webhookPath = url.pathname;
}
let offset = 0;
let stopping = false;

const { telegram, handleMessage } = createBot(process.env);

async function poll() {
  while (!stopping) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"]
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
      }
    } catch (error) {
      console.error("Polling error:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

try {
  const bot = await telegram("getMe");
  console.log(`Connected to Telegram as @${bot.username}`);
} catch (error) {
  throw new Error(`Could not connect to Telegram. Check TELEGRAM_BOT_TOKEN: ${error.message}`);
}

let server;
if (port > 0) {
  server = http.createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", aiEnabled }));
      return;
    }
    if (webhookUrl && request.url === webhookPath) {
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" });
        response.end();
        return;
      }
      if (request.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) {
        response.writeHead(403);
        response.end();
        return;
      }
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            response.writeHead(413);
            response.end();
            return;
          }
          chunks.push(chunk);
        }
        let update;
        try {
          update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!Number.isInteger(update?.update_id)) throw new Error("Invalid update");
        } catch {
          response.writeHead(400);
          response.end();
          return;
        }
        if (update.message) await handleMessage(update.message);
        response.writeHead(200);
        response.end("ok");
      } catch (error) {
        console.error("Webhook error:", error.message);
        response.writeHead(500);
        response.end();
      }
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on("error", (error) => {
    throw new Error(`Health endpoint could not start on port ${port}: ${error.message}`);
  });
  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`HTTP server listening on port ${port}`);
}

process.once("SIGINT", () => { stopping = true; server?.close(); });
process.once("SIGTERM", () => { stopping = true; server?.close(); });
console.log(`Starting Telegram community bot (AI ${aiEnabled ? "enabled" : "disabled"})`);
try {
  if (webhookUrl) {
    await telegram("setWebhook", {
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ["message"],
      max_connections: 1
    });
    console.log("Telegram webhook registered");
  } else {
    await telegram("deleteWebhook");
    await poll();
  }
} catch (error) {
  server?.close();
  throw error;
}
