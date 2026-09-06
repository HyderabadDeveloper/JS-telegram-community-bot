import http from "node:http";
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

const apiBase = `https://api.telegram.org/bot${token}`;
const spamTerms = (process.env.SPAM_TERMS || "")
  .split(",")
  .map((term) => term.trim().toLowerCase())
  .filter(Boolean);
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
  webhookPath = url.pathname;
}
let offset = 0;
let stopping = false;

const guidelines = [
  "Welcome! Please introduce yourself and help keep this a friendly space.",
  "Share useful, relevant information and be respectful of different viewpoints.",
  "No spam, scams, unsolicited promotions, or repeated messages.",
  "When sharing someone else's work, credit the original source.",
  "If you need help, ask a clear question. Community members and I will do our best to help."
].join("\n");

async function telegram(method, body = {}) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description || response.statusText}`);
  }
  return result.result;
}

async function sendMessage(chatId, text, replyToMessageId) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {})
  });
}

function messageText(message) {
  return `${message.text || ""} ${message.caption || ""}`.trim();
}

function containsSpam(text) {
  const normalized = text.toLowerCase();
  return spamTerms.some((term) => normalized.includes(term));
}

async function moderate(message) {
  try {
    await telegram("deleteMessage", {
      chat_id: message.chat.id,
      message_id: message.message_id
    });
    await sendMessage(
      message.chat.id,
      "This message was removed because it looks like spam. Please keep promotions and unsolicited links out of the group.",
      undefined
    );
  } catch (error) {
    console.error("Moderation action failed:", error.message);
  }
}

async function askAi(question) {
  const response = await fetch(`${process.env.AI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.AI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: process.env.AI_SYSTEM_PROMPT || "You are a concise, friendly community assistant."
        },
        { role: "user", content: question }
      ]
    })
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message || response.statusText);
  }
  return result.choices?.[0]?.message?.content?.trim() || "I could not find an answer right now.";
}

async function handleMessage(message) {
  if (message.new_chat_members?.length) {
    await sendMessage(message.chat.id, guidelines);
    return;
  }

  const text = messageText(message);
  if (!text) return;

  if (containsSpam(text)) {
    await moderate(message);
    return;
  }

  const command = text.split(/\s+/, 1)[0].toLowerCase().split("@", 1)[0];
  if (command === "/guidelines") {
    await sendMessage(message.chat.id, guidelines, message.message_id);
    return;
  }

  if (command === "/start" || command === "/help") {
    await sendMessage(
      message.chat.id,
      `${aiEnabled ? "Ask me a question by replying with /ask followed by your question." : "AI help is not configured yet."}\nUse /guidelines to see the group guidelines.`,
      message.message_id
    );
    return;
  }

  if (aiEnabled && command === "/ask") {
    const question = text.replace(/^\S+\s*/, "").trim();
    if (!question) {
      await sendMessage(message.chat.id, "Please add a question after /ask.", message.message_id);
      return;
    }
    try {
      await sendMessage(message.chat.id, await askAi(question), message.message_id);
    } catch (error) {
      console.error("AI request failed:", error.message);
      await sendMessage(message.chat.id, "I cannot reach the AI service right now. Please try again later.", message.message_id);
    }
  }
}

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
