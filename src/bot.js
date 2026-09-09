function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const localAiUsage = new Map();

function consumeLocalAiAllowance(key, now = Date.now()) {
  const cutoff = now - 5 * 60 * 1000;
  const recent = (localAiUsage.get(key) || []).filter(timestamp => timestamp > cutoff);
  if (recent.length >= 3) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + 5 * 60 * 1000 - now) / 1000)) };
  recent.push(now);
  localAiUsage.set(key, recent);
  return { allowed: true, remaining: 3 - recent.length };
}

export function markdownToTelegramHtml(markdown) {
  const tokens = [];
  const token = html => {
    const index = tokens.push(html) - 1;
    return `\u0000${index}\u0000`;
  };
  const limited = markdown.length > 3800 ? `${markdown.slice(0, 3750).trimEnd()}\n\n[Response shortened]` : markdown;
  let text = limited.replace(/```(?:[\w.+-]+)?\s*\n?([\s\S]*?)```/g, (_match, code) => token(`<pre>${escapeHtml(code.trim())}</pre>`));
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => token(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => token(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`));
  text = escapeHtml(text);
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/^\s*[-*]\s+/gm, "• ");
  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<b><i>$1</i></b>");
  text = text.replace(/___([^_\n]+)___/g, "<b><i>$1</i></b>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  text = text.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>");
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)]);
}

export function createBot(env) {
  const apiBase = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const spamTerms = (env.SPAM_TERMS || "").split(",").map(term => term.trim().toLowerCase()).filter(Boolean);
  const aiKeywords = (env.AI_KEYWORDS || "share,suggest,send,guide,anyone").split(",").map(keyword => keyword.trim().toLowerCase()).filter(Boolean);
  const aiEnabled = Boolean(env.AI_API_KEY);
  const testMode = String(env.TEST_MODE || "").toLowerCase() === "true";

  const guidelines = [
    "Community rules", "",
    "1. Be respectful. Harassment, hate speech, and personal attacks are not allowed.",
    "2. Keep messages relevant to the community topic.",
    "3. Do not post spam, scams, repeated messages, or unsolicited promotions.",
    "4. Protect privacy. Do not share another person's private information.",
    "5. Credit the original creator when sharing someone else's work.",
    "6. Ask clear questions and share enough context for others to help.",
    "",
    "Admins may remove messages that break these rules."
  ].join("\n");

  const help = [
    "I am a Finance bot that can help answer questions about CFA and FRM topics. You can interact with me using the following commands:",
    "",
    "• Ask a question: /ask When is the next CFA Level 1 exam?",
    "• You can also write: ask what are modules covered in CFA level 2 ?",
    "• Read the community rules: /rules or /guidelines",
    "• Show this help message: /help",
    "",
    "For a useful answer, ask one clear question and include relevant details. I can make mistakes, so verify important information."
  ].join("\n");

  function welcomeMessage(members) {
    const names = members.map(member => member.first_name).filter(Boolean).join(", ");
    return [
      `Welcome${names ? `, ${names}` : ""}! to CFA & FRM Group 👋`,
      "",
      "Please introduce yourself and tell us what you are interested in.",
      "",
      help,
      "",
      "Please read the rules below:",
      guidelines
    ].join("\n");
  }
  
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
  
  async function sendMessage(chatId, text, replyToMessageId, parseMode) {
    return telegram("sendMessage", {
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
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

  function containsAiKeyword(text) {
    const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
    return aiKeywords.some(keyword => words.has(keyword));
  }

  async function consumeAiAllowance(message) {
    if (testMode) return { allowed: true, remaining: null };
    const userId = message.from?.id;
    const key = String(userId || `chat:${message.chat.id}`);
    if (!env.AI_RATE_LIMITER) return consumeLocalAiAllowance(key);
    const limiter = env.AI_RATE_LIMITER.getByName("telegram-ai-users");
    const response = await limiter.fetch("https://rate-limiter/check", {
      method: "POST",
      body: JSON.stringify({ key })
    });
    if (!response.ok) throw new Error(`Rate limiter failed: ${response.status}`);
    return response.json();
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
    const baseUrl = (env.AI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    const model = env.AI_MODEL || "gemini-3.7-flash";
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.AI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `${env.AI_SYSTEM_PROMPT || "You are a concise, friendly finance assistant."}\nFormat the answer with standard Markdown when it improves readability. Use short headings, bold key terms, italic emphasis, bullet lists, and code blocks where appropriate.` }]
        },
        contents: [{ role: "user", parts: [{ text: question }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2500 }
      })
    };

    let response;
    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, request);
      result = await response.json().catch(() => ({}));
      if (response.ok) break;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
        throw new Error(result.error?.message || `${response.status} ${response.statusText}`.trim());
      }
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }

    return result.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim()
      || "I could not find an answer right now.";
  }
  
  async function handleMessage(message) {
    if (message.new_chat_members?.length) {
      await sendMessage(message.chat.id, welcomeMessage(message.new_chat_members));
      return;
    }
  
    const text = messageText(message);
    if (!text) return;
  
    if (containsSpam(text)) {
      await moderate(message);
      return;
    }
  
    const command = text.split(/\s+/, 1)[0].toLowerCase().split("@", 1)[0];
    if (command === "/guidelines" || command === "/rules") {
      await sendMessage(message.chat.id, guidelines, message.message_id);
      return;
    }
  
    if (command === "/start" || command === "/help") {
      await sendMessage(
        message.chat.id,
        `${help}\n\n${aiEnabled ? "Online assistant status: ready." : "Online assistant status: down."}`,
        message.message_id
      );
      return;
    }
  
    const isAsk = command === "/ask" || command === "ask";
    const isKeywordTrigger = containsAiKeyword(text);
    if (aiEnabled && (isAsk || isKeywordTrigger)) {
      const question = isAsk ? text.replace(/^\S+\s*/, "").trim() : text;
      if (!question) {
        await sendMessage(message.chat.id, "Please add a question after /ask or ask.", message.message_id);
        return;
      }
      try {
        const allowance = await consumeAiAllowance(message);
        if (!allowance.allowed) {
          const minutes = Math.max(1, Math.ceil(allowance.retryAfterSeconds / 60));
          await sendMessage(message.chat.id, `You have used your 3 AI requests. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`, message.message_id);
          return;
        }
        const answer = await askAi(question);
        await sendMessage(message.chat.id, markdownToTelegramHtml(answer), message.message_id, "HTML");
      } catch (error) {
        console.error("AI request failed:", error.message);
        await sendMessage(message.chat.id, "I cannot reach the AI service right now. Please try again later.", message.message_id);
      }
    }
  }
  

  return { telegram, handleMessage };
}
