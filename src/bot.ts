import "dotenv/config";
import { extractImageKeywords, formatNewsPost, shortenNewsPost } from "./ai.js";
import { searchStockImage } from "./images.js";
import { postQuestions } from "./index.js";
import { buildBrandedImageUrl, fetchLatestPdrNews, resolveNewsImageUrl } from "./news.js";
import { getNewsDraftById, getNewsDrafts, saveNewsDrafts, updateNewsDraft, updateNewsDraftStatus } from "./state.js";
import { getNewsCaptionBodyLimit, sendNewsToTelegram } from "./telegram.js";

const TELEGRAM_API = "https://api.telegram.org";

interface BotUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; username?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; username?: string };
    message?: {
      message_id: number;
      chat: { id: number };
    };
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

async function answerCallbackQuery(botToken: string, callbackQueryId: string, text?: string): Promise<void> {
  await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
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

function parseNewsFindCommand(text: string): number | null {
  const match = text.match(/^\/news_find(?:@\w+)?(?:\s+(\d+))?$/);
  if (!match) return null;
  return Math.min(Number(match[1] ?? 10), 10);
}

function parseDraftIdCommand(text: string, command: string): number | null {
  const match = text.match(new RegExp(`^/${command}(?:@\\w+)?\\s+(\\d+)$`));
  if (!match) return null;
  return Number(match[1]);
}

function formatDraftList(): string {
  const drafts = getNewsDrafts("draft");
  if (drafts.length === 0) {
    return "Чернеток поки немає. Використовуй /news_find";
  }

  return [
    "🗂 Чернетки новин:",
    ...drafts.slice(0, 10).map((draft) => `${draft.id}. ${draft.title} (${draft.publishedAt})`),
  ].join("\n");
}

function getChannelHandle(): string | undefined {
  const raw = process.env.CHANNEL_HANDLE?.trim();
  if (!raw) return undefined;
  return raw.startsWith("@") ? raw : `@${raw}`;
}

function buildSubscribeCta(channelHandle?: string): string | undefined {
  if (!channelHandle) return undefined;

  return `🔔 Не пропускай важливе для водіїв: ${channelHandle}`;
}

function buildPublishReplyMarkup(draftId: number) {
  return {
    inline_keyboard: [
      [{ text: "Опублікувати", callback_data: `publish_draft:${draftId}` }],
    ],
  };
}

function parseDraftAction(data: string | undefined, action: string): number | null {
  if (!data) return null;
  const match = data.match(new RegExp(`^${action}:(\\d+)$`));
  if (!match) return null;
  return Number(match[1]);
}

async function ensureRenderedBody(
  draftId: number,
  title: string,
  excerpt: string,
  options?: { previewLabel?: string; subscribeCta?: string; url?: string },
): Promise<string> {
  const draft = getNewsDraftById(draftId);
  if (draft?.renderedBody) return draft.renderedBody;

  const aiApiKey = process.env.GEMINI_API_KEY;
  if (!aiApiKey) {
    updateNewsDraft(draftId, { renderedBody: excerpt });
    return excerpt;
  }

  const maxLength = getNewsCaptionBodyLimit({
    title,
    url: options?.url ?? draft?.url ?? "https://example.com",
    previewLabel: options?.previewLabel,
    subscribeCta: options?.subscribeCta,
  });

  let body = await formatNewsPost(aiApiKey, title, excerpt, maxLength);
  if (body.length > maxLength) {
    body = await shortenNewsPost(aiApiKey, title, body, maxLength);
  }

  updateNewsDraft(draftId, { renderedBody: body });
  return body;
}

async function ensureStockImage(draftId: number, title: string): Promise<string | undefined> {
  const draft = getNewsDraftById(draftId);
  if (draft?.stockImageUrl) return draft.stockImageUrl;

  const pexelsKey = process.env.PEXELS_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!pexelsKey || !geminiKey) return undefined;

  const keywords = await extractImageKeywords(geminiKey, title);
  console.log(`Image keywords for draft ${draftId}: ${keywords}`);
  const stockImageUrl = await searchStockImage(pexelsKey, keywords);
  if (stockImageUrl) {
    updateNewsDraft(draftId, { stockImageUrl });
  }
  return stockImageUrl;
}

async function resolvePreferredDraftImage(draftId: number, title: string, url: string, imageUrl?: string): Promise<string | undefined> {
  const originalImageUrl = resolveNewsImageUrl(url, imageUrl);
  if (originalImageUrl) {
    return originalImageUrl;
  }

  return ensureStockImage(draftId, title);
}

async function publishDraft(botToken: string, draftId: number): Promise<string> {
  const draft = getNewsDraftById(draftId);
  const channelChatId = process.env.TELEGRAM_CHAT_ID;

  if (!draft) {
    throw new Error("Чернетку не знайдено.");
  }

  if (!channelChatId) {
    throw new Error("Відсутній TELEGRAM_CHAT_ID.");
  }

  const channelHandle = getChannelHandle();
  const subscribeCta = buildSubscribeCta(channelHandle);
  const body = await ensureRenderedBody(draftId, draft.title, draft.excerpt, {
    subscribeCta,
    url: draft.url,
  });
  const imageUrl = await resolvePreferredDraftImage(draftId, draft.title, draft.url, draft.imageUrl);

  await sendNewsToTelegram(botToken, channelChatId, {
    title: draft.title,
    body,
    url: draft.url,
    imageUrl,
    fallbackImageUrl: buildBrandedImageUrl(draft.title),
    channelHandle,
    subscribeCta,
  });

  updateNewsDraftStatus(draftId, "posted");
  return `✅ Чернетку ${draftId} опубліковано.`;
}

function isCommand(text: string): boolean {
  return text.startsWith("/");
}

async function denyAccess(botToken: string, chatId: number, userId: number): Promise<void> {
  console.warn(`Unauthorized bot access attempt from user ${userId}`);
  await sendMessage(botToken, chatId, "⛔ Доступ заборонено.");
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

  if (!isCommand(text)) {
    return offset;
  }

  console.log(`Received command from ${userId}: ${text}`);

  if (!adminIds.has(userId)) {
    await denyAccess(botToken, chatId, userId);
    return offset;
  }

  if (text === "/start") {
    await sendMessage(
      botToken,
      chatId,
      [
        "PDR Auto Poster Bot 🚗",
        "",
        "/post [N] - запостити тести",
        "/news_find [N] - знайти новини і зберегти в чернетки",
        "/drafts - список чернеток",
        "/draft ID - перегляд чернетки",
        "/draft_post ID - опублікувати чернетку",
        "/draft_reject ID - відхилити чернетку",
      ].join("\n"),
    );
    return offset;
  }

  if (text === "/drafts") {
    await sendMessage(botToken, chatId, formatDraftList());
    return offset;
  }

  const newsLimit = parseNewsFindCommand(text);
  if (newsLimit !== null) {
    await sendMessage(botToken, chatId, `🔎 Шукаю до ${newsLimit} новин...`);

    try {
      const items = await fetchLatestPdrNews(newsLimit);
      const saved = saveNewsDrafts(items);

      if (saved.length === 0) {
        await sendMessage(botToken, chatId, "Нових чернеток не знайшов. Можливо, все вже збережено.");
      } else {
        await sendMessage(
          botToken,
          chatId,
          [
            `✅ Збережено ${saved.length} чернеток:`,
            ...saved.map((draft) => `${draft.id}. ${draft.title}`),
          ].join("\n"),
        );
      }
    } catch (err) {
      console.error("News fetch error:", err);
      await sendMessage(botToken, chatId, "❌ Не вдалося отримати новини.");
    }

    return offset;
  }

  const previewDraftId = parseDraftIdCommand(text, "draft");
  if (previewDraftId !== null) {
    const draft = getNewsDraftById(previewDraftId);
    if (!draft) {
      await sendMessage(botToken, chatId, "Чернетку не знайдено.");
      return offset;
    }

    await sendMessage(botToken, chatId, "⏳ Генерую прев'ю...");
    const channelHandle = getChannelHandle();
    const subscribeCta = buildSubscribeCta(channelHandle);
    const body = await ensureRenderedBody(previewDraftId, draft.title, draft.excerpt, {
      previewLabel: "ПРЕВ'Ю",
      subscribeCta,
      url: draft.url,
    });
    const imageUrl = await resolvePreferredDraftImage(previewDraftId, draft.title, draft.url, draft.imageUrl);
    await sendNewsToTelegram(botToken, String(chatId), {
      title: draft.title,
      body,
      url: draft.url,
      imageUrl,
      fallbackImageUrl: buildBrandedImageUrl(draft.title),
      channelHandle,
      previewLabel: "ПРЕВ'Ю",
      subscribeCta,
      replyMarkup: buildPublishReplyMarkup(previewDraftId),
    });
    return offset;
  }

  const rejectDraftId = parseDraftIdCommand(text, "draft_reject");
  if (rejectDraftId !== null) {
    const draft = updateNewsDraftStatus(rejectDraftId, "rejected");
    await sendMessage(botToken, chatId, draft ? `🗑 Чернетку ${draft.id} відхилено.` : "Чернетку не знайдено.");
    return offset;
  }

  const postDraftId = parseDraftIdCommand(text, "draft_post");
  if (postDraftId !== null) {
    try {
      await sendMessage(botToken, chatId, await publishDraft(botToken, postDraftId));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Помилка публікації.";
      await sendMessage(botToken, chatId, `❌ ${errorMessage}`);
    }
    return offset;
  }

  const count = parsePostCommand(text);
  if (count === null) {
    await sendMessage(botToken, chatId, "Невідома команда. Використовуй /start");
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

async function handleCallbackQuery(
  botToken: string,
  callbackQuery: NonNullable<BotUpdate["callback_query"]>,
  adminIds: Set<number>,
): Promise<void> {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message?.chat.id;

  if (!adminIds.has(userId)) {
    if (chatId) {
      await denyAccess(botToken, chatId, userId);
    }
    await answerCallbackQuery(botToken, callbackQuery.id, "Доступ заборонено.");
    return;
  }

  const publishDraftId = parseDraftAction(callbackQuery.data, "publish_draft");
  if (publishDraftId !== null) {
    try {
      const result = await publishDraft(botToken, publishDraftId);
      await answerCallbackQuery(botToken, callbackQuery.id, "Опубліковано");
      if (chatId) {
        await sendMessage(botToken, chatId, result);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Помилка публікації.";
      await answerCallbackQuery(botToken, callbackQuery.id, errorMessage);
      if (chatId) {
        await sendMessage(botToken, chatId, `❌ ${errorMessage}`);
      }
    }
    return;
  }

  await answerCallbackQuery(botToken, callbackQuery.id, "Невідома дія.");
}

async function bot(): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const adminIds = getAdminIds();
  if (adminIds.size === 0) throw new Error("Missing ADMIN_USER_IDS in .env");

  console.log(`Bot started. Admin IDs: ${[...adminIds].join(", ")}`);
  console.log("Listening for commands...");

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

        if (update.callback_query) {
          await handleCallbackQuery(botToken, update.callback_query, adminIds);
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
