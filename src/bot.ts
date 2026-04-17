import "dotenv/config";
import { postQuestions } from "./index.js";

const TELEGRAM_API = "https://api.telegram.org";

interface BotUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; username?: string };
    text?: string;
  };
}

interface GetUpdatesResponse {
  ok: boolean;
  result?: BotUpdate[];
}

function getAdminIds(): Set<number> {
  const raw = process.env.ADMIN_USER_IDS ?? "";
  return new Set(
    raw.split(",").map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0),
  );
}

async function sendMessage(botToken: string, chatId: number, text: string): Promise<void> {
  await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function pollUpdates(botToken: string, offset: number): Promise<{ updates: BotUpdate[]; nextOffset: number }> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset, timeout: 30 }),
  });

  const data = (await res.json()) as GetUpdatesResponse;
  const updates = data.result ?? [];
  const nextOffset = updates.length > 0
    ? updates[updates.length - 1].update_id + 1
    : offset;

  return { updates, nextOffset };
}

function parsePostCommand(text: string): number | null {
  const match = text.match(/^\/post(?:@\w+)?(?:\s+(\d+))?$/);
  if (!match) return null;
  return Math.min(Number(match[1] ?? 1), 20);
}

let isPosting = false;

async function handleCommand(
  botToken: string,
  msg: NonNullable<BotUpdate["message"]>,
  adminIds: Set<number>,
  offset: number,
): Promise<number> {
  const userId = msg.from!.id;
  const chatId = msg.chat.id;
  const text = msg.text!.trim();

  if (text === "/start") {
    await sendMessage(botToken, chatId, "PDR Auto Poster Bot 🚗\nВикористовуй /post [N] для постингу питань.");
    return offset;
  }

  const count = parsePostCommand(text);
  if (count === null) return offset;

  if (!adminIds.has(userId)) {
    await sendMessage(botToken, chatId, "⛔ Доступ заборонено.");
    return offset;
  }

  if (isPosting) {
    await sendMessage(botToken, chatId, "⏳ Постинг вже виконується, зачекай...");
    return offset;
  }

  isPosting = true;
  await sendMessage(botToken, chatId, `📤 Постинг ${count} питань...`);

  try {
    const result = await postQuestions(count, offset);
    offset = result.updateOffset;
    await sendMessage(botToken, chatId, `✅ Опубліковано ${result.posted} питань.`);
  } catch (err) {
    console.error("Posting error:", err);
    await sendMessage(botToken, chatId, "❌ Помилка при постингу.");
  } finally {
    isPosting = false;
  }

  return offset;
}

async function bot(): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const adminIds = getAdminIds();
  if (adminIds.size === 0) throw new Error("Missing ADMIN_USER_IDS in .env");

  console.log(`Bot started. Admin IDs: ${[...adminIds].join(", ")}`);
  console.log("Listening for /post commands...");

  let offset = 0;

  // Drain old updates
  const initial = await pollUpdates(botToken, offset);
  offset = initial.nextOffset;

  while (true) {
    try {
      const { updates, nextOffset } = await pollUpdates(botToken, offset);
      offset = nextOffset;

      for (const update of updates) {
        const msg = update.message;
        if (msg?.text && msg.from) {
          offset = await handleCommand(botToken, msg, adminIds, offset);
        }
      }
    } catch (err) {
      console.error("Poll error:", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

bot().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
