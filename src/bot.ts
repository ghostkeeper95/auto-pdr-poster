import "dotenv/config";
import { extractImageKeywords, formatNewsPost, shortenNewsPost } from "./ai.js";
import { searchStockImage } from "./images.js";
import { postQuestions } from "./index.js";
import { buildBrandedImageUrl, fetchLatestNewsHeadlines, fetchNewsDraftFromHeadline, resolveNewsImageUrl } from "./news.js";
import { getAllNewsDrafts, getNewsDraftById, getNewsDrafts, getPendingNewsHeadlineById, refreshNewsDraft, removePendingNewsHeadline, replacePendingNewsHeadlines, saveNewsDrafts, updateNewsDraft, updateNewsDraftStatus } from "./state.js";
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

async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  options?: { replyMarkup?: unknown; disableWebPagePreview?: boolean },
): Promise<void> {
  await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: options?.disableWebPagePreview,
      reply_markup: options?.replyMarkup,
    }),
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
  return Math.min(Number(match[1] ?? 10), 20);
}

function parseDraftIdCommand(text: string, command: string): number | null {
  const match = text.match(new RegExp(`^/${command}(?:@\\w+)?\\s+(\\d+)$`));
  if (!match) return null;
  return Number(match[1]);
}

function formatSourceLabel(source: string): string {
  switch (source) {
    case "pdrtest":
      return "PDRTest";
    case "hsc":
      return "ГСЦ МВС";
    case "mmr":
      return "MMR";
    case "autogeek":
      return "Autogeek";
    default:
      return source;
  }
}

function parsePublishedAtValue(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return timestamp;
  }

  const monthMap: Record<string, number> = {
    "січня": 0,
    "лютого": 1,
    "березня": 2,
    "квітня": 3,
    "травня": 4,
    "червня": 5,
    "липня": 6,
    "серпня": 7,
    "вересня": 8,
    "жовтня": 9,
    "листопада": 10,
    "грудня": 11,
  };

  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  const timeOnlyMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnlyMatch) {
    const [, hourRaw, minuteRaw] = timeOnlyMatch;
    const now = new Date();
    now.setHours(Number(hourRaw), Number(minuteRaw), 0, 0);
    return now.getTime();
  }

  const numericMatch = normalized.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*,?\s*(\d{1,2}):(\d{2}))?/);
  if (numericMatch) {
    const [, dayRaw, monthRaw, yearRaw, hourRaw, minuteRaw] = numericMatch;
    return new Date(
      Number(yearRaw),
      Number(monthRaw) - 1,
      Number(dayRaw),
      Number(hourRaw ?? 0),
      Number(minuteRaw ?? 0),
    ).getTime();
  }

  const match = normalized.match(/(\d{1,2})\s+([а-яіїєґ']+)\s+(\d{4})(?:\s*(?:,|о)?\s*(\d{1,2}):(\d{2}))?/i);
  if (!match) {
    return 0;
  }

  const [, dayRaw, monthRaw, yearRaw, hourRaw, minuteRaw] = match;
  const monthIndex = monthMap[monthRaw];
  if (monthIndex === undefined) {
    return 0;
  }

  return new Date(
    Number(yearRaw),
    monthIndex,
    Number(dayRaw),
    Number(hourRaw ?? 0),
    Number(minuteRaw ?? 0),
  ).getTime();
}

function getDraftSortValue(draft: { publishedAt: string; createdAt: string }): number {
  const publishedAt = parsePublishedAtValue(draft.publishedAt);
  if (publishedAt > 0) {
    return publishedAt;
  }

  const createdAt = Date.parse(draft.createdAt);
  return Number.isNaN(createdAt) ? 0 : createdAt;
}

function formatDraftList(): string {
  const drafts = getNewsDrafts("draft")
    .sort((left, right) => getDraftSortValue(right) - getDraftSortValue(left));
  if (drafts.length === 0) {
    return "Чернеток поки немає. Використовуй /news_find";
  }

  return [
    "🗂 Чернетки новин:",
    ...drafts.slice(0, 10).map((draft) => `${draft.id}. [${formatSourceLabel(draft.source)} | ${draft.publishedAt}] ${draft.title}`),
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

function buildHeadlineReplyMarkup(headlineId: number, url: string) {
  return {
    inline_keyboard: [
      [
        { text: "Відкрити", url },
        { text: "Зберегти в draft", callback_data: `save_headline:${headlineId}` },
      ],
      [
        { text: "Пропустити", callback_data: `skip_headline:${headlineId}` },
      ],
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
  const hasAiProvider = Boolean(aiApiKey || process.env.OPENROUTER_API_KEY);
  if (!hasAiProvider) {
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
  const hasAiProvider = Boolean(geminiKey || process.env.OPENROUTER_API_KEY);
  if (!pexelsKey || !hasAiProvider) return undefined;

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

async function saveHeadlineAsDraft(headlineId: number): Promise<string> {
  const headline = getPendingNewsHeadlineById(headlineId);
  if (!headline) {
    throw new Error("Цей заголовок уже неактуальний. Запусти /news_find ще раз.");
  }

  const item = await fetchNewsDraftFromHeadline(headline);
  if (!item) {
    throw new Error("Не вдалося витягнути текст статті для чернетки.");
  }

  const saved = saveNewsDrafts([item]);
  removePendingNewsHeadline(headlineId);

  if (saved.length === 0) {
    return "Ця стаття вже є в чернетках або вже оброблялася раніше.";
  }

  const draft = saved[0];
  return `✅ Збережено в чернетки: ${draft.id}. [${formatSourceLabel(draft.source)} | ${draft.publishedAt}] ${draft.title}`;
}

async function refreshDraftPreviewCache(draftId: number): Promise<string> {
  const draft = getNewsDraftById(draftId);
  if (!draft) {
    throw new Error("Чернетку не знайдено.");
  }

  const refreshed = await fetchNewsDraftFromHeadline({
    source: draft.source,
    title: draft.title,
    url: draft.url,
    publishedAt: draft.publishedAt,
  });

  if (!refreshed) {
    throw new Error("Не вдалося оновити матеріал із джерела.");
  }

  refreshNewsDraft(draftId, {
    title: refreshed.title,
    excerpt: refreshed.excerpt,
    publishedAt: refreshed.publishedAt,
    imageUrl: refreshed.imageUrl,
    renderedBody: undefined,
    stockImageUrl: undefined,
  });

  return `♻️ Чернетку ${draftId} оновлено з джерела. Тепер /draft ${draftId} згенерує нове прев'ю.`;
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
        "/news_find [N] - показати заголовки новин для відбору",
        "/drafts - список чернеток",
        "/draft ID - перегляд чернетки",
        "/draft_refresh ID - оновити чернетку з джерела і скинути кеш прев'ю",
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
    await sendMessage(botToken, chatId, `🔎 Забираю до ${newsLimit} заголовків з Ukr.net...`);

    try {
      const knownUrls = new Set(getAllNewsDrafts().map((draft) => draft.url));
      const items = await fetchLatestNewsHeadlines(newsLimit * 2);
      const pending = replacePendingNewsHeadlines(
        items
          .filter((item) => !knownUrls.has(item.url))
          .slice(0, newsLimit),
      );

      if (pending.length === 0) {
        await sendMessage(botToken, chatId, "Нічого нового для відбору не знайшов. Можливо, ти вже все цінне забрав у draft.");
      } else {
        await sendMessage(
          botToken,
          chatId,
          [
            `Знайшов ${pending.length} кандидатів.`,
            "Тисни `Відкрити`, швидко оцінюй, і зберігай тільки те, що реально хочеш відкласти в draft.",
            "Усе, що не забереш, при наступному /news_find буде замінене новим списком.",
          ].join("\n"),
        );

        for (const [index, headline] of pending.entries()) {
          await sendMessage(
            botToken,
            chatId,
            [
              `${index + 1}. [${formatSourceLabel(headline.source)} | ${headline.publishedAt}] ${headline.title}`,
              headline.url,
            ].join("\n"),
            {
              replyMarkup: buildHeadlineReplyMarkup(headline.id, headline.url),
              disableWebPagePreview: true,
            },
          );
        }
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

  const refreshDraftId = parseDraftIdCommand(text, "draft_refresh");
  if (refreshDraftId !== null) {
    try {
      await sendMessage(botToken, chatId, "⏳ Оновлюю чернетку з джерела і скидаю кеш прев'ю...");
      await sendMessage(botToken, chatId, await refreshDraftPreviewCache(refreshDraftId));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Помилка оновлення чернетки.";
      await sendMessage(botToken, chatId, `❌ ${errorMessage}`);
    }
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

  const saveHeadlineId = parseDraftAction(callbackQuery.data, "save_headline");
  if (saveHeadlineId !== null) {
    try {
      const result = await saveHeadlineAsDraft(saveHeadlineId);
      await answerCallbackQuery(botToken, callbackQuery.id, "Збережено");
      if (chatId) {
        await sendMessage(botToken, chatId, result);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Помилка збереження.";
      await answerCallbackQuery(botToken, callbackQuery.id, errorMessage);
      if (chatId) {
        await sendMessage(botToken, chatId, `❌ ${errorMessage}`);
      }
    }
    return;
  }

  const skipHeadlineId = parseDraftAction(callbackQuery.data, "skip_headline");
  if (skipHeadlineId !== null) {
    const removed = removePendingNewsHeadline(skipHeadlineId);
    await answerCallbackQuery(botToken, callbackQuery.id, removed ? "Пропущено" : "Уже неактуально");
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
