import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { markdownToTelegramHtml, splitTelegramMarkdown } from "../src/bot.js";

const env = { TELEGRAM_BOT_TOKEN: "test", WEBHOOK_SECRET: "test-secret", SPAM_TERMS: "spam" };
function request(body, secret = env.WEBHOOK_SECRET) {
  return new Request("https://example.com/telegram/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body
  });
}

test("webhook rejects unauthorized, malformed, and oversized requests", async () => {
  assert.equal((await worker.fetch(request("{}", "wrong"), env)).status, 403);
  assert.equal((await worker.fetch(request("invalid"), env)).status, 400);
  assert.equal((await worker.fetch(request("{}"), env)).status, 400);
  assert.equal((await worker.fetch(request("x".repeat(1024 * 1024 + 1)), env)).status, 413);
  assert.equal((await worker.fetch(request("{}"), {})).status, 503);
});

test("health, routing, and empty updates do not call Telegram", async () => {
  assert.equal((await worker.fetch(new Request("https://example.com/health"), env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://example.com/health"), {})).status, 503);
  assert.equal((await worker.fetch(new Request("https://example.com/missing"), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://example.com/telegram/webhook"), env)).status, 405);
  assert.equal((await worker.fetch(request('{"update_id":0}'), env)).status, 200);
});

test("shared bot handles help and moderation; failed delivery returns retryable error", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ method: url.split("/").pop(), body: JSON.parse(options.body) });
    return Response.json({ ok: true, result: true });
  });
  const update = text => JSON.stringify({ update_id: 1, message: { chat: { id: 123 }, message_id: 7, text } });
  assert.equal((await worker.fetch(request(update("/help")), env)).status, 200);
  assert.equal(calls[0].method, "sendMessage");
  assert.equal(calls[0].body.chat_id, 123);
  assert.deepEqual(calls[0].body.reply_parameters, {
    message_id: 7,
    allow_sending_without_reply: true
  });
  assert.match(calls[0].body.text, /Online assistant status: down/);
  assert.equal((await worker.fetch(request(update("spam")), env)).status, 200);
  assert.deepEqual(calls.slice(1).map(call => call.method), ["deleteMessage", "sendMessage"]);
  t.mock.method(console, "error", () => {});
  globalThis.fetch = async () => Response.json({ ok: false, description: "Temporary failure" }, { status: 500 });
  assert.equal((await worker.fetch(request(update("/help")), env)).status, 500);
});

test("CFA material menu guides users from level to provider using local material data", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ method: url.split("/").pop(), body: JSON.parse(options.body) });
    return Response.json({ ok: true, result: true });
  });
  const message = JSON.stringify({ update_id: 30, message: { chat: { id: 123 }, message_id: 30, text: "/cfamaterial" } });
  const level = JSON.stringify({ update_id: 31, callback_query: { id: "level-click", data: "cfa_material:level1", message: { chat: { id: 123 }, message_id: 31 } } });
  const provider = JSON.stringify({ update_id: 32, callback_query: { id: "provider-click", data: "cfa_material:level1:schweser", message: { chat: { id: 123 }, message_id: 32 } } });

  assert.equal((await worker.fetch(request(message), env)).status, 200);
  assert.equal(calls[0].method, "sendMessage");
  assert.equal(calls[0].body.text, "Which CFA level are you preparing for?");
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard.map(row => row[0].text), ["Level I", "Level II", "Level III"]);

  assert.equal((await worker.fetch(request(level), env)).status, 200);
  assert.deepEqual(calls.slice(1).map(call => call.method), ["answerCallbackQuery", "sendMessage"]);
  assert.deepEqual(calls[2].body.reply_markup.inline_keyboard.map(row => row[0].text), ["Schweser", "CFA Institute", "Everything"]);

  assert.equal((await worker.fetch(request(provider), env)).status, 200);
  assert.deepEqual(calls.slice(3).map(call => call.method), ["answerCallbackQuery", "sendMessage"]);
  assert.match(calls[4].body.text, /Level I — Schweser material/);
});

test("FRM material menu offers Levels I and II with all providers", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ method: url.split("/").pop(), body: JSON.parse(options.body) });
    return Response.json({ ok: true, result: true });
  });
  const update = JSON.stringify({ update_id: 33, message: { chat: { id: 123 }, message_id: 33, text: "/frmmaterial" } });
  assert.equal((await worker.fetch(request(update), env)).status, 200);
  assert.equal(calls[0].body.text, "Which FRM level are you preparing for?");
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard.map(row => row[0].text), ["Level I", "Level II"]);
});

test("Gemini answers slash and plain ask messages", async (t) => {
  const telegramMessages = [];
  const aiRequests = [];
  let temporaryFailures = 1;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      aiRequests.push({ url: String(url), body: JSON.parse(options.body) });
      if (temporaryFailures-- > 0) {
        return Response.json({ error: { message: "Service Unavailable" } }, { status: 503 });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: "**Gemini** *reply*" }] } }] });
    }
    telegramMessages.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: true });
  });
  const aiEnv = { ...env, AI_API_KEY: "gemini-key" };
  const update = (id, text) => JSON.stringify({ update_id: id, message: { chat: { id: 123 }, message_id: id, text } });

  assert.equal((await worker.fetch(request(update(2, "/ask Explain Workers")), aiEnv)).status, 200);
  assert.equal((await worker.fetch(request(update(3, "ask Explain webhooks")), aiEnv)).status, 200);
  assert.equal(aiRequests.length, 3);
  assert.match(aiRequests[0].url, /v1beta\/models\/gemini-3\.7-flash:generateContent$/);
  assert.equal(aiRequests[0].body.contents[0].parts[0].text, "Explain Workers");
  const replies = telegramMessages.filter(message => message.parse_mode === "HTML");
  assert.deepEqual(replies.map(message => message.text), ["<b>Gemini</b> <i>reply</i>", "<b>Gemini</b> <i>reply</i>"]);
  assert.deepEqual(replies.map(message => message.parse_mode), ["HTML", "HTML"]);
});

test("Gemini Markdown is converted to safe Telegram HTML", () => {
  const markdown = [
    "# Summary <important>",
    "**Bold**, *italic*, __also bold__, _also italic_, and ~~removed~~.",
    "- Item with `x < y`",
    "[Telegram](https://telegram.org/?a=1&b=2)",
    "```js\nconst value = '<tag>';\n```"
  ].join("\n");
  const html = markdownToTelegramHtml(markdown);

  assert.match(html, /^<b>Summary &lt;important&gt;<\/b>/);
  assert.match(html, /<b>Bold<\/b>, <i>italic<\/i>/);
  assert.match(html, /<b>also bold<\/b>, <i>also italic<\/i>/);
  assert.match(html, /<s>removed<\/s>/);
  assert.match(html, /• Item with <code>x &lt; y<\/code>/);
  assert.match(html, /<a href="https:\/\/telegram\.org\/\?a=1&amp;b=2">Telegram<\/a>/);
  assert.match(html, /<pre>const value = '&lt;tag&gt;';<\/pre>/);
});

test("long AI answers are preserved as Telegram-sized chunks", () => {
  const markdown = Array.from({ length: 12 }, (_, index) => `## Section ${index + 1}\n${"A useful explanation. ".repeat(300)}`).join("\n");
  const chunks = splitTelegramMarkdown(markdown);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), markdown);
  assert.ok(chunks.every(chunk => markdownToTelegramHtml(chunk).length <= 4096));
  assert.doesNotMatch(markdownToTelegramHtml(markdown), /\[Response shortened\]/);
});

test("AI keywords trigger Gemini and enforce three requests per user", async (t) => {
  const telegramMessages = [];
  const aiRequests = [];
  const usage = new Map();
  const limiter = {
    getByName() {
      return {
        async fetch(_url, options) {
          const { key } = JSON.parse(options.body);
          const count = usage.get(key) || 0;
          if (count >= 3) return Response.json({ allowed: false, retryAfterSeconds: 240 });
          usage.set(key, count + 1);
          return Response.json({ allowed: true, remaining: 2 - count });
        }
      };
    }
  };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      aiRequests.push(JSON.parse(options.body));
      return Response.json({ candidates: [{ content: { parts: [{ text: "Helpful reply" }] } }] });
    }
    telegramMessages.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: true });
  });
  const aiEnv = { ...env, AI_API_KEY: "gemini-key", AI_RATE_LIMITER: limiter };
  const update = (id, text) => JSON.stringify({
    update_id: id,
    message: { chat: { id: 123 }, from: { id: 456 }, message_id: id, text }
  });

  assert.equal((await worker.fetch(request(update(10, "Can anyone explain duration?")), aiEnv)).status, 200);
  assert.equal((await worker.fetch(request(update(11, "Please suggest a study plan")), aiEnv)).status, 200);
  assert.equal((await worker.fetch(request(update(12, "Share useful practice questions")), aiEnv)).status, 200);
  assert.equal((await worker.fetch(request(update(13, "Guide me through this reading")), aiEnv)).status, 200);
  assert.equal((await worker.fetch(request(update(14, "A shareholder voted today")), aiEnv)).status, 200);

  assert.equal(aiRequests.length, 3);
  assert.equal(aiRequests[0].contents[0].parts[0].text, "Can anyone explain duration?");
  const rateLimitMessages = telegramMessages.filter(message => /used your 3 AI requests/.test(message.text));
  assert.equal(rateLimitMessages.length, 1);
});

test("test mode bypasses the persistent AI rate limiter", async (t) => {
  let limiterCalls = 0;
  let aiCalls = 0;
  const testEnv = {
    ...env,
    AI_API_KEY: "gemini-key",
    TEST_MODE: "true",
    AI_RATE_LIMITER: {
      getByName() {
        return { async fetch() { limiterCalls += 1; return Response.json({ allowed: false, retryAfterSeconds: 300 }); } };
      }
    }
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      aiCalls += 1;
      return Response.json({ candidates: [{ content: { parts: [{ text: "Test reply" }] } }] });
    }
    return Response.json({ ok: true, result: true });
  });
  for (let id = 20; id < 25; id += 1) {
    const update = JSON.stringify({ update_id: id, message: { chat: { id: 123 }, from: { id: 999 }, message_id: id, text: "please suggest a topic" } });
    assert.equal((await worker.fetch(request(update), testEnv)).status, 200);
  }
  assert.equal(aiCalls, 5);
  assert.equal(limiterCalls, 0);
});

test("new members receive onboarding and rules", async (t) => {
  const messages = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    messages.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: true });
  });
  const update = JSON.stringify({
    update_id: 4,
    message: {
      chat: { id: 123 },
      message_id: 9,
      new_chat_members: [{ first_name: "Asha" }]
    }
  });

  assert.equal((await worker.fetch(request(update), env)).status, 200);
  assert.match(messages[0].text, /Welcome, Asha/);
  assert.match(messages[0].text, /\/ask /);
  assert.match(messages[0].text, /Community rules/);
});
