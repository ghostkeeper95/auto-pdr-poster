import "dotenv/config";
import * as chrono from "chrono-node";
import { Bot, InlineKeyboard } from "grammy";
import { extractImageKeywords, formatNewsPost, shortenNewsPost, summarizeExplanation } from "./ai.js";
import { searchStockImage } from "./images.js";
import { buildBrandedImageUrl, fetchLatestNewsHeadlines, fetchNewsDraftFromHeadline, resolveNewsImageUrl } from "./news.js";
import { fetchQuestionExplanation, fetchSectionQuestions, type Question } from "./scraper.js";
import {
  cancelScheduledPost,
  clearAdminSession,
  clearNewsDrafts,
  clearPendingNewsHeadlines,
  deletePromoTemplate,
  getAdminSession,
  getAllNewsDrafts,
  getAllTestDrafts,
  getForwardDraftById,
  getForwardDrafts,
  getNewsDraftById,
  getNewsDraftByUrl,
  getNewsDrafts,
  getPendingNewsHeadlineById,
  getPendingNewsHeadlines,
  getPromoTemplate,
  getPromoTemplates,
  getScheduledPosts,
  getTestDraftById,
  getTestDrafts,
  isPosted,
  markPosted,
  refreshNewsDraft,
  removePendingNewsHeadline,
  replacePendingNewsHeadlines,
  saveForwardDraft,
  saveNewsDrafts,
  savePromoTemplate,
  saveTestDraft,
  schedulePost,
  setAdminSession,
  updateForwardDraftStatus,
  updateNewsDraft,
  updateNewsDraftStatus,
  updateScheduledPost,
  updateTestDraft,
  updateTestDraftStatus,
  type AdminSession,
  type ScheduledPost,
} from "./state.js";
import { entitiesToHtml, getLinkedChatId, getNewsCaptionBodyLimit, sendExplanationComment, sendNewsToTelegram, sendQuizToTelegram, type TelegramMessageEntity } from "./telegram.js";

const TOTAL_SECTIONS = 71;
const BATCH_POST_DELAY_MS = 3000;
const SCHEDULER_INTERVAL_MS = 30_000;

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const channelChatId = process.env.TELEGRAM_CHAT_ID;

if (!botToken) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!channelChatId) throw new Error("Missing TELEGRAM_CHAT_ID");

const BOT_TOKEN = botToken;
const CHANNEL_CHAT_ID = channelChatId;

const bot = new Bot(BOT_TOKEN);
const pendingDiscussionComments = new Map<number, string>();
let isBatchPublishing = false;
let isSchedulerRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAdminIds(): Set<number> {
  const raw = process.env.ADMIN_USER_IDS ?? "";
  return new Set(
    raw.split(",").map((entry) => Number(entry.trim())).filter((value) => Number.isFinite(value) && value > 0),
  );
}

const adminIds = getAdminIds();
if (adminIds.size === 0) throw new Error("Missing ADMIN_USER_IDS in .env");

function isAdmin(userId: number | undefined): boolean {
  return typeof userId === "number" && adminIds.has(userId);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
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

function formatDateTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function parsePublishedAtValue(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) return timestamp;

  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  const timeOnlyMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnlyMatch) {
    const now = new Date();
    now.setHours(Number(timeOnlyMatch[1]), Number(timeOnlyMatch[2]), 0, 0);
    return now.getTime();
  }

  const numericMatch = normalized.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*,?\s*(\d{1,2}):(\d{2}))?/);
  if (numericMatch) {
    return new Date(
      Number(numericMatch[3]),
      Number(numericMatch[2]) - 1,
      Number(numericMatch[1]),
      Number(numericMatch[4] ?? 0),
      Number(numericMatch[5] ?? 0),
    ).getTime();
  }

  return 0;
}

function getDraftSortValue(draft: { publishedAt: string; createdAt: string }): number {
  const publishedAt = parsePublishedAtValue(draft.publishedAt);
  if (publishedAt > 0) return publishedAt;
  const createdAt = Date.parse(draft.createdAt);
  return Number.isNaN(createdAt) ? 0 : createdAt;
}

function getChannelHandle(): string | undefined {
  const raw = process.env.CHANNEL_HANDLE?.trim();
  if (!raw) return undefined;
  return raw.startsWith("@") ? raw : `@${raw}`;
}

function getMainMenuText(): string {
  return [
    "🤖 PDR Admin",
    "",
    `Новини: ${getNewsDrafts("draft").length} чернеток`,
    `Тести: ${getTestDrafts("draft").length} чернеток`,
    `Форварди: ${getForwardDrafts("draft").length} чернеток`,
    `Заплановано: ${getScheduledPosts("pending").length}`,
  ].join("\n");
}

function getMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📝 Новини", "nav:news")
    .text("🎓 Тести", "nav:tests")
    .row()
    .text("📅 Розклад", "nav:schedule")
    .text("📥 Форварди", "nav:forwards")
    .row()
    .text("📢 Промо-шаблони", "nav:promo")
    .text("↻ Оновити", "nav:main");
}

function getNewsMenuText(): string {
  return [
    "📝 Новини",
    "",
    `Чернеток: ${getNewsDrafts("draft").length}`,
    `Кандидатів: ${getPendingNewsHeadlines().length}`,
    "",
    "Шукай заголовки, роби прев'ю, редагуй текст і став у розклад.",
  ].join("\n");
}

function getNewsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔎 Знайти 20 новин", "news_find:20")
    .row()
    .text("📋 Чернетки", "news_drafts")
    .text("🧹 Очистити", "news_clear")
    .row()
    .text("⬅️ Назад", "nav:main");
}

function getTestsMenuText(): string {
  return [
    "🎓 Тести",
    "",
    `Чернеток: ${getTestDrafts("draft").length}`,
    "",
    "Створи тест-чернетку, переглянь, за потреби поправ формулювання питання і опублікуй або заплануй.",
  ].join("\n");
}

function getTestsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🆕 Новий тест", "test_generate")
    .text("📋 Чернетки", "test_drafts")
    .row()
    .text("⬅️ Назад", "nav:main");
}

function getScheduleMenuText(): string {
  const scheduled = getScheduledPosts("pending")
    .sort((left, right) => Date.parse(left.runAt) - Date.parse(right.runAt))
    .slice(0, 8);
  if (scheduled.length === 0) {
    return "📅 Розклад\n\nЗапланованих публікацій поки немає.";
  }

  return [
    "📅 Розклад",
    "",
    ...scheduled.map((item) => `#${item.id} · ${item.kind} · ${formatDateTime(item.runAt)}`),
  ].join("\n");
}

function getScheduleMenuKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const scheduled = getScheduledPosts("pending")
    .sort((left, right) => Date.parse(left.runAt) - Date.parse(right.runAt))
    .slice(0, 8);
  for (const item of scheduled) {
    keyboard.text(`❌ #${item.id} ${item.kind}`, `schedule_cancel:${item.id}`).row();
  }
  keyboard.text("⬅️ Назад", "nav:main");
  return keyboard;
}

function getForwardsMenuText(): string {
  const count = getForwardDrafts("draft").length;
  return [
    "📥 Форварди",
    "",
    count === 0
      ? "Перешли або надішли боту готовий пост, і він потрапить у цей список."
      : `Чернеток форвардів: ${count}`,
  ].join("\n");
}

function getForwardsMenuKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const draft of getForwardDrafts("draft").slice(-8).reverse()) {
    keyboard.text(`📌 Форвард #${draft.id}`, `forward_draft:${draft.id}`).row();
  }
  keyboard.text("⬅️ Назад", "nav:main");
  return keyboard;
}

function buildNewsDraftActionsKeyboard(draftId: number) {
  const draft = getNewsDraftById(draftId);
  const showSource = draft?.showSource !== false;
  return {
    inline_keyboard: [
      [
        { text: "✏️ Заголовок", callback_data: `news_edit_title:${draftId}` },
        { text: "✏️ Текст", callback_data: `news_edit_body:${draftId}` },
      ],
      [
        { text: "📢 Реклама", callback_data: `news_promo_menu:${draftId}` },
        { text: showSource ? "🔗 Джерело: вкл" : "🔗 Джерело: викл", callback_data: `news_toggle_source:${draftId}` },
      ],
      [
        { text: "♻️ Переписати", callback_data: `news_regen:${draftId}` },
        { text: "🔄 Оновити", callback_data: `news_refresh:${draftId}` },
      ],
      [
        { text: "📅 Запланувати", callback_data: `news_schedule:${draftId}` },
        { text: "🚀 Опублікувати", callback_data: `news_publish:${draftId}` },
      ],
      [
        { text: "🗑 Відхилити", callback_data: `news_reject:${draftId}` },
      ],
    ],
  };
}

function buildHeadlineReplyMarkup(headlineId: number, url: string) {
  return {
    inline_keyboard: [
      [
        { text: "Відкрити", url },
        { text: "👀 Прев'ю", callback_data: `headline_preview:${headlineId}` },
      ],
      [
        { text: "✅ В draft", callback_data: `headline_save:${headlineId}` },
        { text: "❌ Пропустити", callback_data: `headline_skip:${headlineId}` },
      ],
    ],
  };
}

function buildTestDraftActionsKeyboard(draftId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("👀 Прев'ю", `test_preview:${draftId}`)
    .text("📢 Реклама", `test_promo_menu:${draftId}`)
    .row()
    .text("📅 Запланувати", `test_schedule:${draftId}`)
    .text("🚀 Опублікувати", `test_publish:${draftId}`)
    .row()
    .text("🗑 Відхилити", `test_reject:${draftId}`)
    .text("⬅️ До тестів", "nav:tests");
}

function buildForwardDraftActionsKeyboard(draftId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("📅 Запланувати", `forward_schedule:${draftId}`)
    .text("🚀 Опублікувати", `forward_publish:${draftId}`)
    .row()
    .text("🗑 Відхилити", `forward_reject:${draftId}`)
    .text("⬅️ До форвардів", "nav:forwards");
}

function buildScheduleKeyboard(kind: ScheduledPost["kind"], targetId: number): InlineKeyboard {
  const now = new Date();
  const plusHour = new Date(now.getTime() + 60 * 60 * 1000).getTime();
  const todayEvening = new Date(now);
  todayEvening.setHours(18, 0, 0, 0);
  if (todayEvening.getTime() <= now.getTime()) {
    todayEvening.setDate(todayEvening.getDate() + 1);
  }
  const tomorrowTen = new Date(now);
  tomorrowTen.setDate(tomorrowTen.getDate() + 1);
  tomorrowTen.setHours(10, 0, 0, 0);
  const tomorrowEvening = new Date(now);
  tomorrowEvening.setDate(tomorrowEvening.getDate() + 1);
  tomorrowEvening.setHours(18, 0, 0, 0);

  return new InlineKeyboard()
    .text("Через 1 год", `schedule_pick:${kind}:${targetId}:${plusHour}`)
    .text("Сьогодні 18:00", `schedule_pick:${kind}:${targetId}:${todayEvening.getTime()}`)
    .row()
    .text("Завтра 10:00", `schedule_pick:${kind}:${targetId}:${tomorrowTen.getTime()}`)
    .text("Завтра 18:00", `schedule_pick:${kind}:${targetId}:${tomorrowEvening.getTime()}`)
    .row()
    .text("⏰ Ввести вручну", `schedule_manual:${kind}:${targetId}`);
}

function normalizeScheduleInput(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/сьогодні/g, "today")
    .replace(/завтра/g, "tomorrow")
    .replace(/через/g, "in")
    .replace(/години|година|годин|год/g, "hours")
    .replace(/хвилини|хвилина|хвилин|хв/g, "minutes")
    .replace(/дні|дня|день|днів/g, "days");
}

function parseScheduleInput(input: string): Date | undefined {
  const parsed = chrono.parseDate(normalizeScheduleInput(input), new Date(), { forwardDate: true });
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
    return undefined;
  }
  return parsed;
}

function getDiscussionForwardMessageId(message: Record<string, unknown>): number | undefined {
  const forwardOrigin = message.forward_origin;
  if (!forwardOrigin || typeof forwardOrigin !== "object") return undefined;
  const type = Reflect.get(forwardOrigin, "type");
  const messageId = Reflect.get(forwardOrigin, "message_id");
  return type === "channel" && typeof messageId === "number" ? messageId : undefined;
}

async function showMenu(
  ctx: any,
  text: string,
  keyboard: InlineKeyboard,
  options?: { parseMode?: "HTML" | "Markdown" | "MarkdownV2" },
): Promise<void> {
  const extra: Record<string, unknown> = { reply_markup: keyboard };
  if (options?.parseMode) {
    extra.parse_mode = options.parseMode;
    extra.link_preview_options = { is_disabled: true };
  }
  if (ctx.callbackQuery?.message?.message_id) {
    try {
      await ctx.editMessageText(text, extra);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("message is not modified")) {
        // ignore
      } else if (message.includes("there is no text in the message to edit") || message.includes("message can't be edited")) {
        await ctx.reply(text, extra);
      } else {
        throw error;
      }
    }
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.reply(text, extra);
}

async function showMainMenu(ctx: any): Promise<void> {
  await showMenu(ctx, getMainMenuText(), getMainMenuKeyboard());
}

async function showNewsMenu(ctx: any): Promise<void> {
  await showMenu(ctx, getNewsMenuText(), getNewsMenuKeyboard());
}

async function showTestsMenu(ctx: any): Promise<void> {
  await showMenu(ctx, getTestsMenuText(), getTestsMenuKeyboard());
}

async function showScheduleMenu(ctx: any): Promise<void> {
  await showMenu(ctx, getScheduleMenuText(), getScheduleMenuKeyboard());
}

async function showForwardsMenu(ctx: any): Promise<void> {
  await showMenu(ctx, getForwardsMenuText(), getForwardsMenuKeyboard());
}

function truncatePreview(text: string, max = 60): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function stripHtmlForPreview(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function getPromoMenuText(): string {
  const templates = getPromoTemplates();
  if (templates.length === 0) {
    return [
      "📢 Промо-шаблони",
      "",
      "Шаблонів ще немає. Збережи до 3 варіантів, щоб додавати рекламу в один клік.",
    ].join("\n");
  }
  const lines = ["📢 Промо-шаблони", ""];
  for (const slot of [1, 2, 3] as const) {
    const template = templates.find((item) => item.slot === slot);
    if (template) {
      lines.push(`${slot}. ${template.label}`);
      lines.push(`   ${truncatePreview(stripHtmlForPreview(template.html), 80)}`);
    } else {
      lines.push(`${slot}. — порожньо —`);
    }
  }
  return lines.join("\n");
}

function getPromoMenuKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const templates = getPromoTemplates();
  for (const slot of [1, 2, 3] as const) {
    const template = templates.find((item) => item.slot === slot);
    const label = template ? `✏️ ${slot}. ${truncatePreview(template.label, 20)}` : `➕ ${slot}. Додати`;
    keyboard.text(label, `promo_edit:${slot}`);
    if (template) {
      keyboard.text("🗑", `promo_delete:${slot}`);
    }
    keyboard.row();
  }
  keyboard.text("⬅️ Назад", "nav:main");
  return keyboard;
}

async function showPromoMenu(ctx: any): Promise<void> {
  await showMenu(ctx, getPromoMenuText(), getPromoMenuKeyboard());
}

function buildTestPromoPickerKeyboard(draftId: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const templates = getPromoTemplates();
  for (const template of templates) {
    keyboard.text(`📢 ${template.slot}. ${truncatePreview(template.label, 24)}`, `test_promo_apply:${draftId}:${template.slot}`).row();
  }
  keyboard.text("✍️ Ввести вручну", `test_promo_manual:${draftId}`).row();
  keyboard.text("🧹 Прибрати", `test_promo_clear:${draftId}`).row();
  keyboard.text("⬅️ До тесту", `test_draft:${draftId}`);
  return keyboard;
}

async function showTestPromoPicker(ctx: any, draftId: number): Promise<void> {
  const draft = getTestDraftById(draftId);
  if (!draft) {
    await ctx.answerCallbackQuery({ text: "Чернетку не знайдено." });
    return;
  }
  const templates = getPromoTemplates();
  const lines = [`📢 Реклама для тесту #${draftId}`, ""];
  if (templates.length === 0) {
    lines.push("Немає збережених шаблонів. Створи їх у головному меню → Промо-шаблони,");
    lines.push("або введи рекламу вручну.");
  } else {
    lines.push("Обери шаблон або введи вручну:");
    for (const template of templates) {
      lines.push(`• ${template.slot}. ${template.label}`);
    }
  }
  if (draft.promoHtml?.trim()) {
    lines.push("", "Поточна реклама:", truncatePreview(stripHtmlForPreview(draft.promoHtml), 120));
  }
  await showMenu(ctx, lines.join("\n"), buildTestPromoPickerKeyboard(draftId));
}

function buildNewsPromoPickerKeyboard(draftId: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const templates = getPromoTemplates();
  for (const template of templates) {
    keyboard.text(`📢 ${template.slot}. ${truncatePreview(template.label, 24)}`, `news_promo_apply:${draftId}:${template.slot}`).row();
  }
  keyboard.text("✍️ Ввести вручну", `news_promo_manual:${draftId}`).row();
  keyboard.text("🧹 Прибрати", `news_promo_clear:${draftId}`).row();
  keyboard.text("⬅️ До новини", `news_draft:${draftId}`);
  return keyboard;
}

async function showNewsPromoPicker(ctx: any, draftId: number): Promise<void> {
  const draft = getNewsDraftById(draftId);
  if (!draft) {
    await ctx.answerCallbackQuery({ text: "Чернетку не знайдено." });
    return;
  }
  const templates = getPromoTemplates();
  const lines = [`📢 Реклама для новини #${draftId}`, ""];
  if (templates.length === 0) {
    lines.push("Немає збережених шаблонів. Створи їх у головному меню → Промо-шаблони,");
    lines.push("або введи рекламу вручну.");
  } else {
    lines.push("Обери шаблон або введи вручну:");
    for (const template of templates) {
      lines.push(`• ${template.slot}. ${template.label}`);
    }
  }
  if (draft.promoHtml?.trim()) {
    lines.push("", "Поточна реклама:", truncatePreview(stripHtmlForPreview(draft.promoHtml), 120));
  }
  await showMenu(ctx, lines.join("\n"), buildNewsPromoPickerKeyboard(draftId));
}

async function showNewsDraftList(ctx: any): Promise<void> {
  const drafts = getNewsDrafts("draft")
    .sort((left, right) => getDraftSortValue(right) - getDraftSortValue(left))
    .slice(0, 10);
  const keyboard = new InlineKeyboard();
  for (const draft of drafts) {
    keyboard.text(truncate(`#${draft.id} ${draft.title}`, 40), `news_draft:${draft.id}`).row();
  }
  keyboard.text("⬅️ До новин", "nav:news");

  const text = drafts.length === 0
    ? "🗂 Чернеток новин поки немає."
    : [
      "🗂 Чернетки новин",
      "",
      ...drafts.map((draft) => `#${draft.id} · [${formatSourceLabel(draft.source)} | ${draft.publishedAt}] ${draft.title}`),
    ].join("\n");

  await showMenu(ctx, text, keyboard);
}

async function showTestDraftList(ctx: any): Promise<void> {
  const drafts = getTestDrafts("draft").slice(-10).reverse();
  const keyboard = new InlineKeyboard();
  for (const draft of drafts) {
    keyboard.text(truncate(`#${draft.id} ${draft.question.question}`, 40), `test_draft:${draft.id}`).row();
  }
  keyboard.text("⬅️ До тестів", "nav:tests");

  const text = drafts.length === 0
    ? "🎓 Чернеток тестів поки немає."
    : [
      "🎓 Чернетки тестів",
      "",
      ...drafts.map((draft) => `#${draft.id} · ${draft.question.question}`),
    ].join("\n");

  await showMenu(ctx, text, keyboard);
}

async function showForwardDraftCard(ctx: any, draftId: number): Promise<void> {
  const draft = getForwardDraftById(draftId);
  if (!draft) {
    await ctx.reply("❌ Чернетку форварду не знайдено.");
    return;
  }

  await showMenu(
    ctx,
    [
      `📥 Форвард #${draft.id}`,
      "",
      `Джерело: чат ${draft.sourceChatId}`,
      `Повідомлення: ${draft.sourceMessageId}`,
      "",
      "Оригінал уже є в цьому чаті. Можна публікувати або планувати.",
    ].join("\n"),
    buildForwardDraftActionsKeyboard(draftId),
  );
}

async function showNewsDraftCard(ctx: any, draftId: number): Promise<void> {
  const draft = getNewsDraftById(draftId);
  if (!draft) {
    await ctx.reply("❌ Чернетку не знайдено.");
    return;
  }

  await ctx.reply(
    [
      `📰 Чернетка #${draft.id}`,
      `[${formatSourceLabel(draft.source)} | ${draft.publishedAt}]`,
      draft.title,
      "",
      truncate(draft.renderedBody ?? draft.excerpt, 400),
    ].join("\n"),
    { reply_markup: buildNewsDraftActionsKeyboard(draftId) },
  );
}

async function showTestDraftCard(ctx: any, draftId: number): Promise<void> {
  const draft = getTestDraftById(draftId);
  if (!draft) {
    await ctx.reply("❌ Чернетку тесту не знайдено.");
    return;
  }

  const lines = [
    `🎓 Тест #${draft.id}`,
    "",
    draft.question.question,
    "",
    ...draft.question.answers.map((answer, index) => `${String.fromCharCode(65 + index)}. ${answer.answer}`),
  ];
  if (draft.promoHtml?.trim()) {
    lines.push("", "───", "📢 Реклама:", draft.promoHtml);
  }

  await showMenu(
    ctx,
    lines.join("\n"),
    buildTestDraftActionsKeyboard(draftId),
    { parseMode: "HTML" },
  );
}

async function ensureRenderedBody(
  draftId: number,
  title: string,
  excerpt: string,
  options?: { previewLabel?: string; url?: string; promoHtml?: string; showSource?: boolean },
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
    promoHtml: options?.promoHtml,
    showSource: options?.showSource,
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
  const stockImageUrl = await searchStockImage(pexelsKey, keywords);
  if (stockImageUrl) {
    updateNewsDraft(draftId, { stockImageUrl });
  }
  return stockImageUrl;
}

async function resolvePreferredDraftImage(draftId: number, title: string, url: string, imageUrl?: string): Promise<string | undefined> {
  const originalImageUrl = resolveNewsImageUrl(url, imageUrl);
  if (originalImageUrl) return originalImageUrl;
  return ensureStockImage(draftId, title);
}

async function publishNewsDraft(draftId: number): Promise<string> {
  const draft = getNewsDraftById(draftId);
  if (!draft) throw new Error("Чернетку не знайдено.");

  const channelHandle = getChannelHandle();
  const body = await ensureRenderedBody(draftId, draft.title, draft.excerpt, {
    url: draft.url,
    promoHtml: draft.promoHtml,
    showSource: draft.showSource,
  });
  const imageUrl = await resolvePreferredDraftImage(draftId, draft.title, draft.url, draft.imageUrl);

  await sendNewsToTelegram(BOT_TOKEN, CHANNEL_CHAT_ID, {
    title: draft.title,
    body,
    url: draft.url,
    imageUrl,
    fallbackImageUrl: buildBrandedImageUrl(draft.title),
    channelHandle,
    promoHtml: draft.promoHtml,
    showSource: draft.showSource,
  });

  updateNewsDraftStatus(draftId, "posted");
  for (const item of getScheduledPosts("pending")) {
    if (item.kind === "news" && item.targetId === draftId) {
      updateScheduledPost(item.id, { status: "cancelled" });
    }
  }
  return `✅ Чернетку ${draftId} опубліковано.`;
}

async function sendNewsDraftPreview(chatId: number, draftId: number): Promise<void> {
  const draft = getNewsDraftById(draftId);
  if (!draft) throw new Error("Чернетку не знайдено.");

  const channelHandle = getChannelHandle();
  const body = await ensureRenderedBody(draftId, draft.title, draft.excerpt, {
    previewLabel: "ПРЕВ'Ю",
    url: draft.url,
    promoHtml: draft.promoHtml,
    showSource: draft.showSource,
  });
  const imageUrl = await resolvePreferredDraftImage(draftId, draft.title, draft.url, draft.imageUrl);

  await sendNewsToTelegram(BOT_TOKEN, String(chatId), {
    title: draft.title,
    body,
    url: draft.url,
    imageUrl,
    fallbackImageUrl: buildBrandedImageUrl(draft.title),
    channelHandle,
    previewLabel: "ПРЕВ'Ю",
    promoHtml: draft.promoHtml,
    showSource: draft.showSource,
    replyMarkup: buildNewsDraftActionsKeyboard(draftId),
  });
}

async function createDraftFromHeadline(headlineId: number): Promise<{ draftId: number; message: string }> {
  const headline = getPendingNewsHeadlineById(headlineId);
  if (!headline) throw new Error("Цей заголовок уже неактуальний. Запусти пошук ще раз.");

  const existingDraft = getNewsDraftByUrl(headline.url);
  removePendingNewsHeadline(headlineId);
  if (existingDraft) {
    return {
      draftId: existingDraft.id,
      message: `Ця стаття вже є в чернетках: ${existingDraft.id}. [${formatSourceLabel(existingDraft.source)} | ${existingDraft.publishedAt}] ${existingDraft.title}`,
    };
  }

  const item = await fetchNewsDraftFromHeadline(headline);
  if (!item) throw new Error("Не вдалося витягнути текст статті для чернетки.");

  const saved = saveNewsDrafts([item]);
  if (saved.length === 0) {
    const currentDraft = getNewsDraftByUrl(headline.url);
    if (currentDraft) {
      return {
        draftId: currentDraft.id,
        message: `Ця стаття вже є в чернетках: ${currentDraft.id}. [${formatSourceLabel(currentDraft.source)} | ${currentDraft.publishedAt}] ${currentDraft.title}`,
      };
    }
    throw new Error("Ця стаття вже є в чернетках або вже оброблялася раніше.");
  }

  const draft = saved[0];
  return {
    draftId: draft.id,
    message: `✅ Збережено в чернетки: ${draft.id}. [${formatSourceLabel(draft.source)} | ${draft.publishedAt}] ${draft.title}`,
  };
}

async function refreshDraftPreviewCache(draftId: number): Promise<string> {
  const draft = getNewsDraftById(draftId);
  if (!draft) throw new Error("Чернетку не знайдено.");

  const refreshed = await fetchNewsDraftFromHeadline({
    source: draft.source,
    title: draft.title,
    url: draft.url,
    publishedAt: draft.publishedAt,
  });

  if (!refreshed) throw new Error("Не вдалося оновити матеріал із джерела.");

  refreshNewsDraft(draftId, {
    title: refreshed.title,
    excerpt: refreshed.excerpt,
    publishedAt: refreshed.publishedAt,
    imageUrl: refreshed.imageUrl,
    renderedBody: undefined,
    stockImageUrl: undefined,
  });

  return `♻️ Чернетку ${draftId} оновлено.`;
}

async function fetchNewsCandidates(limit: number, chatId: number): Promise<void> {
  await bot.api.sendMessage(chatId, `🔎 Забираю до ${limit} заголовків з Ukr.net...`);
  const knownUrls = new Set(getAllNewsDrafts().map((draft) => draft.url));
  const items = await fetchLatestNewsHeadlines(limit * 2);
  const pending = replacePendingNewsHeadlines(items.filter((item) => !knownUrls.has(item.url)).slice(0, limit));

  if (pending.length === 0) {
    await bot.api.sendMessage(chatId, "Нічого нового для відбору не знайшов.");
    return;
  }

  await bot.api.sendMessage(chatId, `Знайшов ${pending.length} кандидатів.`);
  for (const [index, headline] of pending.entries()) {
    await bot.api.sendMessage(
      chatId,
      [
        `${index + 1}. [${formatSourceLabel(headline.source)} | ${headline.publishedAt}] ${headline.title}`,
        headline.url,
      ].join("\n"),
      {
        link_preview_options: { is_disabled: true },
        reply_markup: buildHeadlineReplyMarkup(headline.id, headline.url),
      },
    );
  }
}

async function getDiscussionChatId(): Promise<string | undefined> {
  return getLinkedChatId(BOT_TOKEN, CHANNEL_CHAT_ID);
}

async function publishTestDraft(draftId: number, destinationChatId = CHANNEL_CHAT_ID): Promise<string> {
  const draft = getTestDraftById(draftId);
  if (!draft) throw new Error("Чернетку тесту не знайдено.");

  const messageId = await sendQuizToTelegram(BOT_TOKEN, String(destinationChatId), draft.question, {
    text: draft.promoText,
    entities: draft.promoEntities,
    html: draft.promoHtml,
  });
  if (destinationChatId === CHANNEL_CHAT_ID) {
    markPosted(draft.question.id);
    updateTestDraftStatus(draftId, "posted");
    for (const item of getScheduledPosts("pending")) {
      if (item.kind === "test" && item.targetId === draftId) {
        updateScheduledPost(item.id, { status: "cancelled" });
      }
    }
    if (messageId && draft.explanation) {
      pendingDiscussionComments.set(messageId, draft.explanation);
    }
  }

  return destinationChatId === CHANNEL_CHAT_ID
    ? `✅ Тест ${draftId} опубліковано.`
    : `👀 Прев'ю тесту ${draftId} надіслано.`;
}

async function publishForwardDraft(draftId: number): Promise<string> {
  const draft = getForwardDraftById(draftId);
  if (!draft) throw new Error("Чернетку форварду не знайдено.");

  await bot.api.copyMessage(CHANNEL_CHAT_ID, draft.sourceChatId, draft.sourceMessageId);
  updateForwardDraftStatus(draftId, "posted");
  for (const item of getScheduledPosts("pending")) {
    if (item.kind === "forward" && item.targetId === draftId) {
      updateScheduledPost(item.id, { status: "cancelled" });
    }
  }
  return `✅ Форвард ${draftId} опубліковано.`;
}

async function pickRandomQuestion(): Promise<{ question: Question; explanation?: string } | undefined> {
  const existingIds = new Set(getAllTestDrafts().map((draft) => draft.question.id));
  const exhaustedSections = new Set<number>();

  while (exhaustedSections.size < TOTAL_SECTIONS) {
    const sectionId = Math.floor(Math.random() * TOTAL_SECTIONS) + 1;
    if (exhaustedSections.has(sectionId)) continue;

    const questions = await fetchSectionQuestions(sectionId);
    const unposted = questions.filter((question) => !isPosted(question.id) && !existingIds.has(question.id));
    if (unposted.length === 0) {
      exhaustedSections.add(sectionId);
      continue;
    }

    const question = unposted[Math.floor(Math.random() * unposted.length)];
    const rawExplanation = await fetchQuestionExplanation(question.id);
    const explanation = rawExplanation
      ? await summarizeExplanation(process.env.GEMINI_API_KEY, rawExplanation).catch(() => rawExplanation)
      : undefined;
    return { question, explanation };
  }

  return undefined;
}

async function generateTestDraft() {
  const picked = await pickRandomQuestion();
  if (!picked) throw new Error("Не знайшов нових тестів для чернетки.");
  const draft = saveTestDraft(picked.question, picked.explanation);
  if (!draft) throw new Error("Цей тест уже є в чернетках.");
  return draft;
}

async function publishRandomTests(count: number): Promise<number> {
  let posted = 0;
  while (posted < count) {
    const picked = await pickRandomQuestion();
    if (!picked) break;
    const pollMessageId = await sendQuizToTelegram(BOT_TOKEN, CHANNEL_CHAT_ID, picked.question);
    markPosted(picked.question.id);
    if (pollMessageId && picked.explanation) {
      pendingDiscussionComments.set(pollMessageId, picked.explanation);
    }
    posted += 1;
    if (posted < count) {
      await sleep(BATCH_POST_DELAY_MS);
    }
  }
  return posted;
}

function parseLegacyCountCommand(text: string, command: string, defaultCount: number, max = 20): number | null {
  const match = text.match(new RegExp(`^/${command}(?:@\\w+)?(?:\\s+(\\d+))?$`));
  if (!match) return null;
  return Math.min(Number(match[1] ?? defaultCount), max);
}

function parseLegacyDraftIdCommand(text: string, command: string): number | null {
  const match = text.match(new RegExp(`^/${command}(?:@\\w+)?\\s+(\\d+)$`));
  if (!match) return null;
  return Number(match[1]);
}

function parseScheduleCallback(data: string): { kind: ScheduledPost["kind"]; targetId: number; timestamp: number } | undefined {
  const match = data.match(/^schedule_pick:(news|test|forward):(\d+):(\d+)$/);
  if (!match) return undefined;
  return { kind: match[1] as ScheduledPost["kind"], targetId: Number(match[2]), timestamp: Number(match[3]) };
}

function parseScheduleManualCallback(data: string): { kind: ScheduledPost["kind"]; targetId: number } | undefined {
  const match = data.match(/^schedule_manual:(news|test|forward):(\d+)$/);
  if (!match) return undefined;
  return { kind: match[1] as ScheduledPost["kind"], targetId: Number(match[2]) };
}

function setScheduleSession(userId: number, kind: ScheduledPost["kind"], targetId: number): void {
  const mode: AdminSession["mode"] = kind === "news"
    ? "schedule_news"
    : kind === "test"
      ? "schedule_test"
      : "schedule_forward";
  setAdminSession({ userId, mode, targetId, createdAt: new Date().toISOString() });
}

function cancelPendingSchedulesFor(kind: ScheduledPost["kind"], targetId: number): void {
  for (const item of getScheduledPosts("pending")) {
    if (item.kind === kind && item.targetId === targetId) {
      updateScheduledPost(item.id, { status: "cancelled" });
    }
  }
}

function createSchedule(kind: ScheduledPost["kind"], targetId: number, runAt: Date) {
  cancelPendingSchedulesFor(kind, targetId);
  return schedulePost(kind, targetId, runAt.toISOString());
}

async function handleSessionInput(ctx: any, text: string): Promise<boolean> {
  if (!ctx.from?.id) return false;
  const session = getAdminSession(ctx.from.id);
  if (!session) return false;

  if (text === "/cancel") {
    clearAdminSession(ctx.from.id);
    await ctx.reply("Скасовано.");
    await showMainMenu(ctx);
    return true;
  }

  switch (session.mode) {
    case "edit_news_title":
      updateNewsDraft(session.targetId, { title: text });
      clearAdminSession(ctx.from.id);
      await ctx.reply(`✅ Заголовок чернетки ${session.targetId} оновлено.`);
      await showNewsDraftCard(ctx, session.targetId);
      return true;
    case "edit_news_body":
      updateNewsDraft(session.targetId, { excerpt: text, renderedBody: text });
      clearAdminSession(ctx.from.id);
      await ctx.reply(`✅ Текст чернетки ${session.targetId} оновлено.`);
      await sendNewsDraftPreview(ctx.chat.id, session.targetId);
      return true;
    case "edit_test_promo": {
      const draft = getTestDraftById(session.targetId);
      if (!draft) {
        clearAdminSession(ctx.from.id);
        await ctx.reply("❌ Чернетку тесту не знайдено.");
        return true;
      }
      const clear = text.trim() === "—" || text.trim() === "-" || text.trim().toLowerCase() === "clear";
      if (clear) {
        updateTestDraft(session.targetId, { promoHtml: undefined, promoText: undefined, promoEntities: undefined });
        clearAdminSession(ctx.from.id);
        await ctx.reply(`🧹 Рекламу для тесту ${session.targetId} прибрано.`);
        await showTestDraftCard(ctx, session.targetId);
        return true;
      }
      const entities = (ctx.msg?.entities ?? ctx.msg?.caption_entities ?? []) as TelegramMessageEntity[];
      const rawText = (ctx.msg?.text ?? ctx.msg?.caption ?? text) as string;
      const promoHtml = entitiesToHtml(rawText, entities);
      updateTestDraft(session.targetId, { promoHtml, promoText: rawText, promoEntities: entities });
      clearAdminSession(ctx.from.id);
      await ctx.reply(`✅ Рекламу для тесту ${session.targetId} збережено.`);
      await showTestDraftCard(ctx, session.targetId);
      return true;
    }
    case "edit_news_promo": {
      const draft = getNewsDraftById(session.targetId);
      if (!draft) {
        clearAdminSession(ctx.from.id);
        await ctx.reply("❌ Чернетку новини не знайдено.");
        return true;
      }
      const clear = text.trim() === "—" || text.trim() === "-" || text.trim().toLowerCase() === "clear";
      if (clear) {
        updateNewsDraft(session.targetId, { promoHtml: undefined, promoText: undefined, promoEntities: undefined });
        clearAdminSession(ctx.from.id);
        await ctx.reply(`🧹 Рекламу для новини ${session.targetId} прибрано.`);
        await showNewsDraftCard(ctx, session.targetId);
        return true;
      }
      const entities = (ctx.msg?.entities ?? ctx.msg?.caption_entities ?? []) as TelegramMessageEntity[];
      const rawText = (ctx.msg?.text ?? ctx.msg?.caption ?? text) as string;
      const promoHtml = entitiesToHtml(rawText, entities);
      updateNewsDraft(session.targetId, { promoHtml, promoText: rawText, promoEntities: entities });
      clearAdminSession(ctx.from.id);
      await ctx.reply(`✅ Рекламу для новини ${session.targetId} збережено.`);
      await showNewsDraftCard(ctx, session.targetId);
      return true;
    }
    case "edit_promo_template": {
      const slot = session.targetId as 1 | 2 | 3;
      const clear = text.trim() === "—" || text.trim() === "-" || text.trim().toLowerCase() === "clear";
      if (clear) {
        deletePromoTemplate(slot);
        clearAdminSession(ctx.from.id);
        await ctx.reply(`🧹 Промо-шаблон #${slot} видалено.`);
        await showPromoMenu(ctx);
        return true;
      }
      const entities = (ctx.msg?.entities ?? ctx.msg?.caption_entities ?? []) as TelegramMessageEntity[];
      const rawText = (ctx.msg?.text ?? ctx.msg?.caption ?? text) as string;
      const html = entitiesToHtml(rawText, entities);
      const firstLine = rawText.split("\n")[0]?.trim() ?? "";
      const label = truncatePreview(firstLine || rawText, 40) || `Промо #${slot}`;
      savePromoTemplate(slot, label, html, { text: rawText, entities });
      clearAdminSession(ctx.from.id);
      await ctx.reply(`✅ Промо-шаблон #${slot} збережено: ${label}`);
      await showPromoMenu(ctx);
      return true;
    }
    case "schedule_news":
    case "schedule_test":
    case "schedule_forward": {
      const runAt = parseScheduleInput(text);
      if (!runAt) {
        await ctx.reply("Не зміг розпізнати час. Приклади: `завтра 18:00`, `через 2 години`, `25.04.2026 10:30`", {
          parse_mode: "Markdown",
        });
        return true;
      }

      const kind: ScheduledPost["kind"] = session.mode === "schedule_news"
        ? "news"
        : session.mode === "schedule_test"
          ? "test"
          : "forward";
      const scheduled = createSchedule(kind, session.targetId, runAt);
      clearAdminSession(ctx.from.id);
      await ctx.reply(`📅 Заплановано #${scheduled.id} на ${formatDateTime(scheduled.runAt)}.`);
      await showScheduleMenu(ctx);
      return true;
    }
    default:
      return false;
  }
}

async function handleNavCallback(ctx: any, target: string): Promise<void> {
  switch (target) {
    case "main":
      await showMainMenu(ctx);
      return;
    case "news":
      await showNewsMenu(ctx);
      return;
    case "tests":
      await showTestsMenu(ctx);
      return;
    case "schedule":
      await showScheduleMenu(ctx);
      return;
    case "forwards":
      await showForwardsMenu(ctx);
      return;
    case "promo":
      await showPromoMenu(ctx);
      return;
    default:
      await ctx.answerCallbackQuery({ text: "Невідома навігація." });
  }
}

async function handleScheduler(): Promise<void> {
  if (isSchedulerRunning) return;
  isSchedulerRunning = true;
  try {
    const dueItems = getScheduledPosts("pending")
      .filter((item) => Date.parse(item.runAt) <= Date.now())
      .sort((left, right) => Date.parse(left.runAt) - Date.parse(right.runAt));

    for (const item of dueItems) {
      try {
        if (item.kind === "news") {
          await publishNewsDraft(item.targetId);
        } else if (item.kind === "test") {
          await publishTestDraft(item.targetId);
        } else {
          await publishForwardDraft(item.targetId);
        }
        updateScheduledPost(item.id, { status: "sent", lastError: undefined });
      } catch (error) {
        updateScheduledPost(item.id, {
          status: "failed",
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    isSchedulerRunning = false;
  }
}

bot.on("callback_query:data", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.answerCallbackQuery({ text: "Доступ заборонено." });
    return;
  }

  const data = ctx.callbackQuery.data;

  if (data.startsWith("nav:")) {
    await handleNavCallback(ctx, data.slice(4));
    return;
  }

  if (data.startsWith("news_find:")) {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: "Чат не знайдено." });
      return;
    }
    await fetchNewsCandidates(Number(data.split(":")[1] ?? 20), chatId);
    return;
  }

  if (data === "news_drafts") {
    await showNewsDraftList(ctx);
    return;
  }

  if (data === "news_clear") {
    const draftCount = clearNewsDrafts("draft");
    const pendingCount = clearPendingNewsHeadlines();
    await ctx.answerCallbackQuery({ text: "Очищено" });
    await ctx.reply(`🧹 Очищено чернетки: ${draftCount}. Видалено кандидатів: ${pendingCount}.`);
    await showNewsMenu(ctx);
    return;
  }

  if (data.startsWith("news_draft:")) {
    await ctx.answerCallbackQuery();
    await showNewsDraftCard(ctx, Number(data.split(":")[1]));
    return;
  }

  if (data.startsWith("news_preview:")) {
    await ctx.answerCallbackQuery({ text: "Генерую прев'ю" });
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: "Чат не знайдено." });
      return;
    }
    await sendNewsDraftPreview(chatId, Number(data.split(":")[1]));
    return;
  }

  if (data.startsWith("news_publish:")) {
    try {
      const result = await publishNewsDraft(Number(data.split(":")[1]));
      await ctx.answerCallbackQuery({ text: "Опубліковано" });
      await ctx.reply(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: message });
      await ctx.reply(`❌ ${message}`);
    }
    return;
  }

  if (data.startsWith("news_edit_title:")) {
    const draftId = Number(data.split(":")[1]);
    setAdminSession({ userId: ctx.from.id, mode: "edit_news_title", targetId: draftId, createdAt: new Date().toISOString() });
    await ctx.answerCallbackQuery();
    await ctx.reply(`Надішли новий заголовок для чернетки ${draftId}. /cancel щоб скасувати.`);
    return;
  }

  if (data.startsWith("news_edit_body:")) {
    const draftId = Number(data.split(":")[1]);
    setAdminSession({ userId: ctx.from.id, mode: "edit_news_body", targetId: draftId, createdAt: new Date().toISOString() });
    await ctx.answerCallbackQuery();
    await ctx.reply(`Надішли новий текст для чернетки ${draftId}. /cancel щоб скасувати.`);
    return;
  }

  if (data.startsWith("news_refresh:")) {
    try {
      const result = await refreshDraftPreviewCache(Number(data.split(":")[1]));
      await ctx.answerCallbackQuery({ text: "Оновлено" });
      await ctx.reply(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: message });
      await ctx.reply(`❌ ${message}`);
    }
    return;
  }

  if (data.startsWith("news_regen:")) {
    const draftId = Number(data.split(":")[1]);
    const draft = getNewsDraftById(draftId);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: "Чернетку не знайдено." });
      return;
    }
    updateNewsDraft(draftId, { renderedBody: undefined });
    await ctx.answerCallbackQuery({ text: "Переписую через AI…" });
    const chatId = ctx.chat?.id;
    if (chatId) {
      await sendNewsDraftPreview(chatId, draftId);
    }
    return;
  }

  if (data.startsWith("news_reject:")) {
    const draftId = Number(data.split(":")[1]);
    updateNewsDraftStatus(draftId, "rejected");
    cancelPendingSchedulesFor("news", draftId);
    await ctx.answerCallbackQuery({ text: "Відхилено" });
    await ctx.reply(`🗑 Чернетку ${draftId} відхилено.`);
    return;
  }

  if (data.startsWith("news_promo_menu:")) {
    const draftId = Number(data.split(":")[1]);
    await showNewsPromoPicker(ctx, draftId);
    return;
  }

  if (data.startsWith("news_promo_apply:")) {
    const [, draftIdRaw, slotRaw] = data.split(":");
    const draftId = Number(draftIdRaw);
    const slot = Number(slotRaw) as 1 | 2 | 3;
    const template = getPromoTemplate(slot);
    if (!template) {
      await ctx.answerCallbackQuery({ text: "Шаблон порожній" });
      return;
    }
    updateNewsDraft(draftId, {
      promoHtml: template.html,
      promoText: template.text,
      promoEntities: template.entities,
    });
    await ctx.answerCallbackQuery({ text: `Застосовано: ${template.label}` });
    await showNewsDraftCard(ctx, draftId);
    return;
  }

  if (data.startsWith("news_promo_manual:")) {
    const draftId = Number(data.split(":")[1]);
    setAdminSession({ userId: ctx.from.id, mode: "edit_news_promo", targetId: draftId, createdAt: new Date().toISOString() });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `📢 Надішли текст реклами для новини ${draftId}.\n• Форматування (жирний, курсив, посилання, емодзі) зберігається.\n• Надішли «—» щоб прибрати.\n• /cancel — скасувати.`,
    );
    return;
  }

  if (data.startsWith("news_promo_clear:")) {
    const draftId = Number(data.split(":")[1]);
    updateNewsDraft(draftId, { promoHtml: undefined, promoText: undefined, promoEntities: undefined });
    await ctx.answerCallbackQuery({ text: "Прибрано" });
    await showNewsDraftCard(ctx, draftId);
    return;
  }

  if (data.startsWith("news_toggle_source:")) {
    const draftId = Number(data.split(":")[1]);
    const draft = getNewsDraftById(draftId);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: "Чернетку не знайдено." });
      return;
    }
    const next = draft.showSource === false ? true : false;
    updateNewsDraft(draftId, { showSource: next });
    await ctx.answerCallbackQuery({ text: next ? "Джерело увімкнено" : "Джерело приховано" });
    await showNewsDraftCard(ctx, draftId);
    return;
  }

  if (data.startsWith("headline_save:")) {
    try {
      const result = await createDraftFromHeadline(Number(data.split(":")[1]));
      await ctx.answerCallbackQuery({ text: "Збережено" });
      await ctx.reply(result.message);
      await showNewsDraftCard(ctx, result.draftId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: message });
      await ctx.reply(`❌ ${message}`);
    }
    return;
  }

  if (data.startsWith("headline_preview:")) {
    try {
      const result = await createDraftFromHeadline(Number(data.split(":")[1]));
      await ctx.answerCallbackQuery({ text: "Створюю прев'ю" });
      await ctx.reply(result.message);
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery({ text: "Чат не знайдено." });
        return;
      }
      await sendNewsDraftPreview(chatId, result.draftId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: message });
      await ctx.reply(`❌ ${message}`);
    }
    return;
  }

  if (data.startsWith("headline_skip:")) {
    const removed = removePendingNewsHeadline(Number(data.split(":")[1]));
    await ctx.answerCallbackQuery({ text: removed ? "Пропущено" : "Уже неактуально" });
    return;
  }

  if (data === "test_generate") {
    try {
      const draft = await generateTestDraft();
      await ctx.answerCallbackQuery({ text: "Створено" });
      await ctx.reply(`✅ Створив чернетку тесту ${draft.id}.`);
      await showTestDraftCard(ctx, draft.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: message });
      await ctx.reply(`❌ ${message}`);
    }
    return;
  }

  if (data === "test_drafts") {
    await showTestDraftList(ctx);
    return;
  }

  if (data.startsWith("test_draft:")) {
    await showTestDraftCard(ctx, Number(data.split(":")[1]));
    return;
  }

  if (data.startsWith("test_preview:")) {
    try {
      const draftId = Number(data.split(":")[1]);
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery({ text: "Чат не знайдено." });
        return;
      }
      const result = await publishTestDraft(draftId, String(chatId));
      await ctx.answerCallbackQuery({ text: "Прев'ю надіслано" });
      await ctx.reply(result, { reply_markup: buildTestDraftActionsKeyboard(draftId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: message });
      await ctx.reply(`❌ ${message}`);
    }
    return;
  }

  if (data.startsWith("test_publish:")) {
    try {
      const result = await publishTestDraft(Number(data.split(":")[1]));
      await ctx.answerCallbackQuery({ text: "Опубліковано" });
      await ctx.reply(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: message });
      await ctx.reply(`❌ ${message}`);
    }
    return;
  }

  if (data.startsWith("test_promo_menu:")) {
    const draftId = Number(data.split(":")[1]);
    await showTestPromoPicker(ctx, draftId);
    return;
  }

  if (data.startsWith("test_promo_apply:")) {
    const [, draftIdRaw, slotRaw] = data.split(":");
    const draftId = Number(draftIdRaw);
    const slot = Number(slotRaw) as 1 | 2 | 3;
    const template = getPromoTemplate(slot);
    if (!template) {
      await ctx.answerCallbackQuery({ text: "Шаблон порожній" });
      return;
    }
    updateTestDraft(draftId, {
      promoHtml: template.html,
      promoText: template.text,
      promoEntities: template.entities,
    });
    await ctx.answerCallbackQuery({ text: `Застосовано: ${template.label}` });
    await showTestDraftCard(ctx, draftId);
    return;
  }

  if (data.startsWith("test_promo_manual:")) {
    const draftId = Number(data.split(":")[1]);
    setAdminSession({ userId: ctx.from.id, mode: "edit_test_promo", targetId: draftId, createdAt: new Date().toISOString() });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `📢 Надішли текст реклами для тесту ${draftId}.\n• Форматування (жирний, курсив, посилання, емодзі) зберігається.\n• Надішли «—» щоб прибрати.\n• /cancel — скасувати.`,
    );
    return;
  }

  if (data.startsWith("test_promo_clear:")) {
    const draftId = Number(data.split(":")[1]);
    updateTestDraft(draftId, { promoHtml: undefined, promoText: undefined, promoEntities: undefined });
    await ctx.answerCallbackQuery({ text: "Прибрано" });
    await showTestDraftCard(ctx, draftId);
    return;
  }

  if (data.startsWith("promo_edit:")) {
    const slot = Number(data.split(":")[1]) as 1 | 2 | 3;
    setAdminSession({ userId: ctx.from.id, mode: "edit_promo_template", targetId: slot, createdAt: new Date().toISOString() });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `📢 Надішли текст промо-шаблона #${slot}.\n• Форматування зберігається повністю.\n• Перший рядок стане назвою шаблона, решта — тілом. Якщо рядок один — він буде і назвою, і тілом.\n• Надішли «—» щоб видалити.\n• /cancel — скасувати.`,
    );
    return;
  }

  if (data.startsWith("promo_delete:")) {
    const slot = Number(data.split(":")[1]) as 1 | 2 | 3;
    deletePromoTemplate(slot);
    await ctx.answerCallbackQuery({ text: "Видалено" });
    await showPromoMenu(ctx);
    return;
  }

  if (data.startsWith("test_reject:")) {
    const draftId = Number(data.split(":")[1]);
    updateTestDraftStatus(draftId, "rejected");
    cancelPendingSchedulesFor("test", draftId);
    await ctx.answerCallbackQuery({ text: "Відхилено" });
    await ctx.reply(`🗑 Тест ${draftId} відхилено.`);
    return;
  }

  if (data.startsWith("test_post_now:")) {
    if (isBatchPublishing) {
      await ctx.answerCallbackQuery({ text: "Постинг уже виконується" });
      return;
    }
    isBatchPublishing = true;
    try {
      const count = Number(data.split(":")[1]);
      await ctx.answerCallbackQuery({ text: "Публікую" });
      const posted = await publishRandomTests(count);
      await ctx.reply(`✅ Опубліковано ${posted} тестів.`);
    } finally {
      isBatchPublishing = false;
    }
    return;
  }

  if (data.startsWith("forward_draft:")) {
    await showForwardDraftCard(ctx, Number(data.split(":")[1]));
    return;
  }

  if (data.startsWith("forward_publish:")) {
    try {
      const result = await publishForwardDraft(Number(data.split(":")[1]));
      await ctx.answerCallbackQuery({ text: "Опубліковано" });
      await ctx.reply(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: message });
      await ctx.reply(`❌ ${message}`);
    }
    return;
  }

  if (data.startsWith("forward_reject:")) {
    const draftId = Number(data.split(":")[1]);
    updateForwardDraftStatus(draftId, "rejected");
    cancelPendingSchedulesFor("forward", draftId);
    await ctx.answerCallbackQuery({ text: "Відхилено" });
    await ctx.reply(`🗑 Форвард ${draftId} відхилено.`);
    return;
  }

  if (data.startsWith("news_schedule:")) {
    await ctx.answerCallbackQuery();
    await ctx.reply("📅 Обери час або введи вручну:", { reply_markup: buildScheduleKeyboard("news", Number(data.split(":")[1])) });
    return;
  }

  if (data.startsWith("test_schedule:")) {
    await ctx.answerCallbackQuery();
    await ctx.reply("📅 Обери час або введи вручну:", { reply_markup: buildScheduleKeyboard("test", Number(data.split(":")[1])) });
    return;
  }

  if (data.startsWith("forward_schedule:")) {
    await ctx.answerCallbackQuery();
    await ctx.reply("📅 Обери час або введи вручну:", { reply_markup: buildScheduleKeyboard("forward", Number(data.split(":")[1])) });
    return;
  }

  const schedulePick = parseScheduleCallback(data);
  if (schedulePick) {
    const scheduled = createSchedule(schedulePick.kind, schedulePick.targetId, new Date(schedulePick.timestamp));
    await ctx.answerCallbackQuery({ text: "Заплановано" });
    await ctx.reply(`📅 Заплановано #${scheduled.id} на ${formatDateTime(scheduled.runAt)}.`);
    return;
  }

  const scheduleManual = parseScheduleManualCallback(data);
  if (scheduleManual) {
    setScheduleSession(ctx.from.id, scheduleManual.kind, scheduleManual.targetId);
    await ctx.answerCallbackQuery();
    await ctx.reply("Надішли час у форматі `завтра 18:00`, `через 2 години` або `25.04.2026 10:30`. /cancel щоб скасувати.", {
      parse_mode: "Markdown",
    });
    return;
  }

  if (data.startsWith("schedule_cancel:")) {
    const item = cancelScheduledPost(Number(data.split(":")[1]));
    await ctx.answerCallbackQuery({ text: item ? "Скасовано" : "Не знайдено" });
    await showScheduleMenu(ctx);
    return;
  }

  await ctx.answerCallbackQuery({ text: "Невідома дія." });
});

bot.on("message", async (ctx) => {
  const msg = ctx.msg as unknown as Record<string, unknown> & { message_id: number; text?: string; caption?: string };

  if (msg.is_automatic_forward) {
    const originalChannelMessageId = getDiscussionForwardMessageId(msg);
    if (originalChannelMessageId) {
      const explanation = pendingDiscussionComments.get(originalChannelMessageId);
      if (explanation) {
        await sendExplanationComment(BOT_TOKEN, ctx.chat.id, msg.message_id, explanation);
        pendingDiscussionComments.delete(originalChannelMessageId);
      }
    }
    return;
  }

  if (!isAdmin(ctx.from?.id)) return;

  const text = typeof msg.text === "string" ? msg.text.trim() : undefined;
  if (text) {
    if (await handleSessionInput(ctx, text)) return;

    if (text === "/start" || text === "/menu") {
      await showMainMenu(ctx);
      return;
    }

    if (text === "/cancel") {
      clearAdminSession(ctx.from.id);
      await ctx.reply("Скасовано.");
      await showMainMenu(ctx);
      return;
    }

    if (/^\/drafts(?:@\w+)?$/.test(text)) {
      await showNewsDraftList(ctx);
      return;
    }

    if (/^\/drafts_clear(?:@\w+)?$/.test(text)) {
      const draftCount = clearNewsDrafts("draft");
      const pendingCount = clearPendingNewsHeadlines();
      await ctx.reply(`🧹 Очищено чернетки: ${draftCount}. Видалено кандидатів: ${pendingCount}.`);
      return;
    }

    const newsLimit = parseLegacyCountCommand(text, "news_find", 10);
    if (newsLimit !== null) {
      await fetchNewsCandidates(newsLimit, ctx.chat.id);
      return;
    }

    const previewDraftId = parseLegacyDraftIdCommand(text, "draft");
    if (previewDraftId !== null) {
      await sendNewsDraftPreview(ctx.chat.id, previewDraftId);
      return;
    }

    const refreshDraftId = parseLegacyDraftIdCommand(text, "draft_refresh");
    if (refreshDraftId !== null) {
      await ctx.reply(await refreshDraftPreviewCache(refreshDraftId));
      return;
    }

    const rejectDraftId = parseLegacyDraftIdCommand(text, "draft_reject");
    if (rejectDraftId !== null) {
      updateNewsDraftStatus(rejectDraftId, "rejected");
      cancelPendingSchedulesFor("news", rejectDraftId);
      await ctx.reply(`🗑 Чернетку ${rejectDraftId} відхилено.`);
      return;
    }

    const postDraftId = parseLegacyDraftIdCommand(text, "draft_post");
    if (postDraftId !== null) {
      await ctx.reply(await publishNewsDraft(postDraftId));
      return;
    }

    const postCount = parseLegacyCountCommand(text, "post", 1);
    if (postCount !== null) {
      if (isBatchPublishing) {
        await ctx.reply("⏳ Постинг уже виконується, зачекай...");
        return;
      }
      isBatchPublishing = true;
      try {
        await ctx.reply(`📤 Публікую ${postCount} тестів...`);
        const posted = await publishRandomTests(postCount);
        await ctx.reply(`✅ Опубліковано ${posted} тестів.`);
      } finally {
        isBatchPublishing = false;
      }
      return;
    }

    if (text.startsWith("/")) {
      await ctx.reply("Невідома команда. Використовуй /menu.");
      return;
    }
  }

  const hasUserContent = Boolean(
    text
    || (typeof msg.caption === "string" && msg.caption.trim())
    || Array.isArray(msg.photo)
    || msg.video
    || msg.document
    || msg.forward_origin,
  );

  if (hasUserContent) {
    const draft = saveForwardDraft(ctx.chat.id, msg.message_id);
    await ctx.reply(`📥 Збережено як форвард-чернетку #${draft.id}.`, {
      reply_markup: buildForwardDraftActionsKeyboard(draft.id),
    });
  }
});

bot.catch((error) => {
  console.error("Bot error:", error);
});

async function start(): Promise<void> {
  console.log(`Bot started. Admin IDs: ${[...adminIds].join(", ")}`);
  console.log("Listening for commands...");

  await bot.api.setMyCommands([
    { command: "start", description: "Запустити бота" },
    { command: "menu", description: "Відкрити головне меню" },
    { command: "cancel", description: "Скасувати поточне введення" },
    { command: "news_find", description: "Швидко знайти новини" },
    { command: "post", description: "Швидко опублікувати тести" },
  ]);

  const discussionChatId = await getDiscussionChatId();
  if (discussionChatId) {
    console.log(`Discussion group found: ${discussionChatId}`);
  } else {
    console.warn("No linked discussion group found — explanations for tests may be skipped");
  }

  setInterval(() => {
    handleScheduler().catch((error) => console.error("Scheduler error:", error));
  }, SCHEDULER_INTERVAL_MS);

  await bot.start({ drop_pending_updates: true });
}

start().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});