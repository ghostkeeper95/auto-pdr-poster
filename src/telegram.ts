import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Question } from "./scraper.js";

const TELEGRAM_API = "https://api.telegram.org";
const NO_IMAGE_PATH = resolve(import.meta.dirname, "..", "assets", "no_image.png");

interface TelegramResponse {
  ok: boolean;
  description?: string;
  result?: { message_id: number };
}

interface NewsTelegramPost {
  title: string;
  body: string;
  url: string;
  imageUrl?: string;
  fallbackImageUrl?: string;
  channelHandle?: string;
  previewLabel?: string;
  subscribeCta?: string;
  promoHtml?: string;
  showSource?: boolean;
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };
}

interface GetChatResponse {
  ok: boolean;
  description?: string;
  result?: { linked_chat_id?: number };
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    is_automatic_forward?: boolean;
    forward_origin?: {
      type: string;
      chat?: { id: number };
      message_id?: number;
    };
  };
}

interface GetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

export async function getLinkedChatId(
  botToken: string,
  channelChatId: string,
): Promise<string | undefined> {
  const url = `${TELEGRAM_API}/bot${botToken}/getChat`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: channelChatId }),
  });

  const result = (await res.json()) as GetChatResponse;
  if (!result.ok || !result.result?.linked_chat_id) {
    return undefined;
  }

  return String(result.result.linked_chat_id);
}

export async function sendQuizToTelegram(
  botToken: string,
  chatId: string,
  question: Question,
  promo?: { text?: string; entities?: TelegramMessageEntity[]; html?: string },
): Promise<number | undefined> {
  const correctIndex = question.answers.findIndex((a) => a.truth);
  const options = question.answers.map((a) => a.answer);

  await sendPhoto(botToken, chatId, question, promo?.html);
  return sendPoll(botToken, chatId, question, options, correctIndex);
}

const MAX_OPTION_LENGTH = 100;

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: { id: number };
  language?: string;
  custom_emoji_id?: string;
}

function entityTags(e: TelegramMessageEntity): { open: string; close: string } | null {
  switch (e.type) {
    case "bold":
      return { open: "<b>", close: "</b>" };
    case "italic":
      return { open: "<i>", close: "</i>" };
    case "underline":
      return { open: "<u>", close: "</u>" };
    case "strikethrough":
      return { open: "<s>", close: "</s>" };
    case "spoiler":
      return { open: "<tg-spoiler>", close: "</tg-spoiler>" };
    case "code":
      return { open: "<code>", close: "</code>" };
    case "pre":
      return e.language
        ? { open: `<pre><code class="language-${escapeHtml(e.language)}">`, close: "</code></pre>" }
        : { open: "<pre>", close: "</pre>" };
    case "blockquote":
      return { open: "<blockquote>", close: "</blockquote>" };
    case "expandable_blockquote":
      return { open: "<blockquote expandable>", close: "</blockquote>" };
    case "text_link":
      return e.url ? { open: `<a href="${escapeHtml(e.url)}">`, close: "</a>" } : null;
    case "text_mention":
      return e.user ? { open: `<a href="tg://user?id=${e.user.id}">`, close: "</a>" } : null;
    case "custom_emoji":
      return e.custom_emoji_id
        ? { open: `<tg-emoji emoji-id="${escapeHtml(e.custom_emoji_id)}">`, close: "</tg-emoji>" }
        : null;
    default:
      return null;
  }
}

export function entitiesToHtml(text: string, entities: TelegramMessageEntity[] = []): string {
  if (!entities || entities.length === 0) return escapeHtml(text);
  const openAt: string[][] = Array.from({ length: text.length + 1 }, () => []);
  const closeAt: string[][] = Array.from({ length: text.length + 1 }, () => []);
  const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);
  for (const e of sorted) {
    const tags = entityTags(e);
    if (!tags) continue;
    openAt[e.offset]!.push(tags.open);
    closeAt[e.offset + e.length]!.unshift(tags.close);
  }
  let out = "";
  for (let i = 0; i <= text.length; i++) {
    for (const c of closeAt[i]!) out += c;
    for (const o of openAt[i]!) out += o;
    if (i < text.length) out += escapeHtml(text[i]!);
  }
  return out;
}

function formatCaption(question: Question, promoHtml?: string): string {
  const hasLongOptions = question.answers.some((a) => a.answer.length > MAX_OPTION_LENGTH);

  let caption = `📋 <b>${escapeHtml(question.id)}</b>\n<b>${escapeHtml(question.question)}</b>`;

  if (hasLongOptions) {
    const optionsList = question.answers
      .map((a, i) => `<b>${String.fromCharCode(65 + i)}.</b> ${escapeHtml(a.answer)}`)
      .join("\n\n");
    caption += `\n\n${optionsList}`;
  }

  const trimmedPromo = promoHtml?.trim();
  if (trimmedPromo) {
    caption += `\n\n${trimmedPromo}`;
  }

  return caption;
}

async function sendPhoto(
  botToken: string,
  chatId: string,
  question: Question,
  promoHtml?: string,
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/sendPhoto`;
  const caption = formatCaption(question, promoHtml);

  if (question.image) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: question.image,
        caption,
        parse_mode: "HTML",
      }),
    });
    const result = (await res.json()) as TelegramResponse;
    if (!result.ok) {
      console.warn(`Failed to send photo: ${result.description}`);
    }
    return;
  }

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([readFileSync(NO_IMAGE_PATH)], { type: "image/png" }), "no_image.png");
  form.append("caption", caption);
  form.append("parse_mode", "HTML");

  const res = await fetch(url, { method: "POST", body: form });
  const result = (await res.json()) as TelegramResponse;
  if (!result.ok) {
    console.warn(`Failed to send fallback photo: ${result.description}`);
  }
}

const MAX_POLL_QUESTION_LENGTH = 300;

async function sendPoll(
  botToken: string,
  chatId: string,
  question: Question,
  options: string[],
  correctIndex: number,
): Promise<number | undefined> {
  const url = `${TELEGRAM_API}/bot${botToken}/sendPoll`;

  const truncatedOptions = options.map((o, i) => {
    if (o.length <= MAX_OPTION_LENGTH) return o;
    const prefix = `${String.fromCharCode(65 + i)}. `;
    const maxText = MAX_OPTION_LENGTH - prefix.length - 3; // 3 for "..."
    return `${prefix}${o.substring(0, maxText)}...`;
  });

  const pollQuestion =
    question.question.length <= MAX_POLL_QUESTION_LENGTH
      ? question.question
      : "Дайте правильну відповідь:";

  const body: Record<string, unknown> = {
    chat_id: chatId,
    question: pollQuestion,
    options: truncatedOptions,
    type: "quiz",
    correct_option_ids: [correctIndex],
    is_anonymous: true,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = (await res.json()) as TelegramResponse;
  if (!result.ok) {
    throw new Error(`Failed to send quiz poll: ${result.description}`);
  }

  return result.result?.message_id;
}

export async function sendTextMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  const result = (await res.json()) as TelegramResponse;
  if (!result.ok) {
    throw new Error(`Telegram API error: ${result.description}`);
  }
}

function convertEmphasis(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\*(.+?)\*/g, "<b>$1</b>");
}

export function getNewsCaptionBodyLimit(post: Pick<NewsTelegramPost, "title" | "url" | "previewLabel" | "subscribeCta" | "promoHtml" | "showSource">): number {
  const showSource = post.showSource !== false;
  const sourceLink = showSource ? `🔗 <a href="${post.url}">Джерело</a>` : undefined;
  const subscribeLine = post.subscribeCta ? escapeHtml(post.subscribeCta) : undefined;
  const promoLine = post.promoHtml?.trim() ? post.promoHtml.trim() : undefined;
  const suffix = [
    "",
    sourceLink,
    subscribeLine ? "" : undefined,
    subscribeLine,
    promoLine ? "" : undefined,
    promoLine,
  ].filter((line) => line !== undefined).join("\n");

  const header = [
    post.previewLabel ? `<b>${escapeHtml(post.previewLabel)}</b>` : undefined,
    `<b>${escapeHtml(post.title)}</b>`,
    "",
  ].filter((line) => line !== undefined).join("\n");

  return Math.max(220, 1024 - header.length - suffix.length - 8);
}

function formatNewsCaption(post: NewsTelegramPost): string {
  const bodyHtml = convertEmphasis(escapeHtml(post.body));
  const showSource = post.showSource !== false;
  const sourceLink = showSource ? `🔗 <a href="${post.url}">Джерело</a>` : undefined;
  const subscribeLine = post.subscribeCta ? escapeHtml(post.subscribeCta) : undefined;
  const promoLine = post.promoHtml?.trim() ? post.promoHtml.trim() : undefined;

  const suffix = [
    "",
    sourceLink,
    subscribeLine ? "" : undefined,
    subscribeLine,
    promoLine ? "" : undefined,
    promoLine,
  ].filter((l) => l !== undefined).join("\n");

  const header = [
    post.previewLabel ? `<b>${escapeHtml(post.previewLabel)}</b>` : undefined,
    `<b>${escapeHtml(post.title)}</b>`,
    "",
  ].filter((l) => l !== undefined).join("\n");

  const maxBodyLength = getNewsCaptionBodyLimit(post);

  let body = bodyHtml;
  if (body.length > maxBodyLength) {
    const lastNewline = body.lastIndexOf("\n", maxBodyLength);
    const cutAt = lastNewline > maxBodyLength * 0.5 ? lastNewline : maxBodyLength;
    body = `${body.slice(0, cutAt).trimEnd()}...`;
  }

  return [header, body, suffix].join("\n");
}

async function sendUploadedPhoto(
  botToken: string,
  chatId: string,
  caption: string,
  replyMarkup?: NewsTelegramPost["replyMarkup"],
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([readFileSync(NO_IMAGE_PATH)], { type: "image/png" }), "no_image.png");
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  if (replyMarkup) {
    form.append("reply_markup", JSON.stringify(replyMarkup));
  }

  const response = await fetch(`${TELEGRAM_API}/bot${botToken}/sendPhoto`, {
    method: "POST",
    body: form,
  });

  const result = (await response.json()) as TelegramResponse;
  if (!result.ok) {
    throw new Error(`Telegram API error: ${result.description}`);
  }
}

export async function sendNewsToTelegram(
  botToken: string,
  chatId: string,
  post: NewsTelegramPost,
): Promise<void> {
  const caption = formatNewsCaption(post);
  const candidateImages = [post.imageUrl, post.fallbackImageUrl].filter((value): value is string => Boolean(value));

  for (const imageUrl of candidateImages) {
    const response = await fetch(`${TELEGRAM_API}/bot${botToken}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: imageUrl,
        caption,
        parse_mode: "HTML",
        reply_markup: post.replyMarkup,
      }),
    });

    const result = (await response.json()) as TelegramResponse;
    if (result.ok) {
      return;
    }

    console.warn(`Failed to send news photo (${imageUrl}): ${result.description}`);
  }

  await sendUploadedPhoto(botToken, chatId, caption, post.replyMarkup);
}

export async function sendVideoToTelegram(
  botToken: string,
  chatId: string,
  videoUrl: string,
  options?: {
    caption?: string;
    promoHtml?: string;
    fallbackVideoUrl?: string;
    replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };
  },
): Promise<void> {
  const parts: string[] = [];
  if (options?.caption?.trim()) {
    parts.push(escapeHtml(options.caption.trim()));
  }
  if (options?.promoHtml?.trim()) {
    if (parts.length > 0) parts.push("");
    parts.push(options.promoHtml.trim());
  }
  const captionText = parts.join("\n");

  const downloadHeaders = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://www.tiktok.com/",
  };

  const urlsToTry = [videoUrl, options?.fallbackVideoUrl].filter((u): u is string => Boolean(u));
  let videoBuffer: ArrayBuffer | undefined;

  for (const url of urlsToTry) {
    const videoRes = await fetch(url, { headers: downloadHeaders });
    if (videoRes.ok) {
      videoBuffer = await videoRes.arrayBuffer();
      break;
    }
    console.warn(`Failed to download video from ${url}: ${videoRes.status}`);
  }

  if (!videoBuffer) {
    throw new Error("Не вдалося завантажити відео (всі варіанти вичерпано)");
  }

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("video", new Blob([videoBuffer], { type: "video/mp4" }), "video.mp4");
  form.append("parse_mode", "HTML");
  if (captionText) form.append("caption", captionText);
  if (options?.replyMarkup) form.append("reply_markup", JSON.stringify(options.replyMarkup));

  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendVideo`, {
    method: "POST",
    body: form,
  });

  const result = (await res.json()) as TelegramResponse;
  if (!result.ok) {
    throw new Error(`Telegram sendVideo error: ${result.description}`);
  }
}

export async function sendExplanationComment(
  botToken: string,
  chatId: number | string,
  replyToMessageId: number,
  explanation: string,
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;

  const escapedText = escapeHtml(explanation);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `<b>Пояснення:</b> <tg-spoiler>${escapedText}</tg-spoiler>`,
      parse_mode: "HTML",
      reply_parameters: { message_id: replyToMessageId },
    }),
  });

  const result = (await res.json()) as TelegramResponse;
  if (!result.ok) {
    console.warn(`Failed to send explanation comment: ${result.description}`);
  }
}

export async function drainPendingUpdates(botToken: string): Promise<number> {
  const url = `${TELEGRAM_API}/bot${botToken}/getUpdates`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset: -1, limit: 1 }),
  });
  const data = (await res.json()) as GetUpdatesResponse;

  if (!data.ok || !data.result?.length) {
    return 0;
  }

  const nextOffset = data.result[0].update_id + 1;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset: nextOffset, timeout: 0 }),
  });

  return nextOffset;
}

export async function waitForAutoForward(
  botToken: string,
  channelMessageId: number,
  offset: number,
): Promise<{ chatId: number; messageId: number; nextOffset: number } | undefined> {
  const url = `${TELEGRAM_API}/bot${botToken}/getUpdates`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset, timeout: 5 }),
    });
    const data = (await res.json()) as GetUpdatesResponse;

    if (!data.ok || !data.result?.length) continue;

    for (const update of data.result) {
      offset = Math.max(offset, update.update_id + 1);

      const msg = update.message;
      if (!msg) continue;

      const matchesChannelPost =
        msg.forward_origin?.type === "channel" &&
        msg.forward_origin?.message_id === channelMessageId;

      if (msg.is_automatic_forward && matchesChannelPost) {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offset, timeout: 0 }),
        });
        return { chatId: msg.chat.id, messageId: msg.message_id, nextOffset: offset };
      }
    }
  }

  return undefined;
}
