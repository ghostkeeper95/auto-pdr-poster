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
): Promise<number | undefined> {
  const correctIndex = question.answers.findIndex((a) => a.truth);
  const options = question.answers.map((a) => a.answer);

  await sendPhoto(botToken, chatId, question);
  return sendPoll(botToken, chatId, question, options, correctIndex);
}

const MAX_OPTION_LENGTH = 100;

function formatCaption(question: Question): string {
  const hasLongOptions = question.answers.some((a) => a.answer.length > MAX_OPTION_LENGTH);

  let caption = `📋 *${escapeMarkdown(question.id)}*\n*${escapeMarkdown(question.question)}*`;

  if (hasLongOptions) {
    const optionsList = question.answers
      .map((a, i) => `*${String.fromCharCode(65 + i)}\\.* ${escapeMarkdown(a.answer)}`)
      .join("\n\n");
    caption += `\n\n${optionsList}`;
  }

  return caption;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function sendPhoto(
  botToken: string,
  chatId: string,
  question: Question,
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/sendPhoto`;
  const caption = formatCaption(question);

  if (question.image) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: question.image,
        caption,
        parse_mode: "MarkdownV2",
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
  form.append("parse_mode", "MarkdownV2");

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

export async function sendExplanationComment(
  botToken: string,
  chatId: number | string,
  replyToMessageId: number,
  explanation: string,
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;

  const escapedText = explanation
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

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
