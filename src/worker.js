import { createBot } from "./bot.js";

export class AiRateLimiter {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const { key } = await request.json();
    if (!key) return new Response("Missing key", { status: 400 });
    const now = Date.now();
    const windowMs = 5 * 60 * 1000;
    const result = await this.storage.transaction(async transaction => {
      const recent = ((await transaction.get(key)) || []).filter(timestamp => timestamp > now - windowMs);
      if (recent.length >= 3) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) };
      }
      recent.push(now);
      await transaction.put(key, recent);
      return { allowed: true, remaining: 3 - recent.length };
    });
    return Response.json(result);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      const ready = Boolean(env.TELEGRAM_BOT_TOKEN && env.WEBHOOK_SECRET);
      return Response.json({ status: ready ? "ok" : "unconfigured", aiEnabled: Boolean(env.AI_API_KEY || env.GROQ_API_KEY) }, { status: ready ? 200 : 503 });
    }
    if (path !== "/telegram/webhook") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (!env.TELEGRAM_BOT_TOKEN || !env.WEBHOOK_SECRET) return new Response("Not configured", { status: 503 });
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      const reader = request.body?.getReader();
      if (!reader) return new Response("Missing body", { status: 400 });
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          return new Response("Payload too large", { status: 413 });
        }
        chunks.push(value);
      }
      update = JSON.parse(await new Blob(chunks).text());
      if (!Number.isInteger(update?.update_id)) throw new Error("Invalid update");
    } catch {
      return new Response("Invalid update", { status: 400 });
    }

    try {
      const bot = createBot(env);
      if (update.message) await bot.handleMessage(update.message);
      if (update.callback_query) await bot.handleCallbackQuery(update.callback_query);
      return new Response("ok");
    } catch (error) {
      console.error("Webhook processing failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        updateId: update.update_id,
        chatId: update.message?.chat?.id || update.callback_query?.message?.chat?.id,
        messageId: update.message?.message_id || update.callback_query?.message?.message_id
      });
      return new Response("Processing failed", { status: 500 });
    }
  }
};
