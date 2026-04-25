const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODELS = ["openai/gpt-4.1-mini", "openai/gpt-4o-mini", "openrouter/auto"];

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface TextGenerationOptions {
  maxTokens?: number;
  temperature?: number;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter(Boolean);
}

function hasUnbalancedQuotes(text: string): boolean {
  const quoteCount = (text.match(/["“”«»]/g) ?? []).length;
  return quoteCount % 2 === 1;
}

function buildFallbackExplanationSummary(explanation: string): string {
  const paragraphs = explanation
    .split(/\n\s*\n/)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter(Boolean);

  const sentences = splitIntoSentences(paragraphs.join(" "));
  if (sentences.length === 0) {
    return normalizeWhitespace(explanation);
  }

  const selected: string[] = [];

  const pushSentence = (sentence: string | undefined): void => {
    if (!sentence) {
      return;
    }

    const normalized = normalizeWhitespace(sentence);
    if (!normalized || selected.includes(normalized)) {
      return;
    }

    selected.push(normalized);
  };

  pushSentence(sentences.find((sentence) => /\b(згідно з|відповідно до|пункт(ом|у)?|пдр)\b/iu.test(sentence)));
  pushSentence(sentences.find((sentence) => /\b(тобто|це означає|практично це означає)\b/iu.test(sentence)));
  pushSentence(sentences.find((sentence) => /\b(отже|вірна відповідь|правильн(ий|а) варіант|правильна відповідь)\b/iu.test(sentence)));

  if (selected.length < 2) {
    for (const sentence of sentences) {
      pushSentence(sentence);
      if (selected.length >= 3) {
        break;
      }
    }
  }

  const summary = selected.slice(0, 3).join(" ").trim();
  if (summary.length <= 650) {
    return summary;
  }

  const truncated = summary.slice(0, 649);
  const lastBoundary = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
  );

  if (lastBoundary > 300) {
    return truncated.slice(0, lastBoundary + 1).trim();
  }

  return `${truncated.trim()}…`;
}

function isWeakExplanationSummary(summary: string, explanation: string): boolean {
  const normalizedSummary = normalizeWhitespace(summary);
  const normalizedExplanation = normalizeWhitespace(explanation);
  const summarySentences = splitIntoSentences(normalizedSummary);

  if (!normalizedSummary) {
    return true;
  }

  if (hasCorruptedOutput(normalizedSummary)) {
    return true;
  }

  if (hasUnbalancedQuotes(normalizedSummary)) {
    return true;
  }

  if (/[,:;\-–]$/u.test(normalizedSummary)) {
    return true;
  }

  if (normalizedExplanation.length >= 240 && normalizedSummary.length < 110) {
    return true;
  }

  if (normalizedExplanation.length >= 240 && summarySentences.length < 2) {
    return true;
  }

  return false;
}

function getOpenRouterModels(): string[] {
  const configured = process.env.OPENROUTER_MODELS
    ?.split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  if (configured && configured.length > 0) {
    return configured;
  }

  const singleModel = process.env.OPENROUTER_MODEL?.trim();
  return singleModel ? [singleModel, ...DEFAULT_OPENROUTER_MODELS] : DEFAULT_OPENROUTER_MODELS;
}

function parseOpenRouterContent(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string | undefined {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part: { type?: string; text?: string }) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
    return text || undefined;
  }

  return undefined;
}

function buildFallbackNewsPost(excerpt: string, maxLength?: number): string {
  const paragraphs = excerpt
    .split(/\n\s*\n/)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter((paragraph) => paragraph.length > 0)
    .slice(0, 5);

  if (paragraphs.length === 0) {
    return "";
  }

  const firstParagraph = paragraphs[0];
  const detailLines = paragraphs
    .slice(1)
    .map((paragraph) => {
      const sentenceBoundary = paragraph.search(/[.!?](\s|$)/);
      const firstSentence = sentenceBoundary >= 0 ? paragraph.slice(0, sentenceBoundary + 1) : paragraph;
      return normalizeWhitespace(firstSentence);
    })
    .filter((paragraph, index, items) => paragraph.length >= 45 && items.indexOf(paragraph) === index)
    .slice(0, 3);

  const body = [
    firstParagraph,
    detailLines.length > 0 ? detailLines.map((line) => `• ${line}`).join("\n") : paragraphs.slice(1, 3).join("\n\n"),
  ].filter(Boolean).join("\n\n").trim();

  if (!maxLength || body.length <= maxLength) {
    return body;
  }

  const truncated = body.slice(0, Math.max(0, maxLength - 1));
  const sentenceBoundary = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
    truncated.lastIndexOf("\n"),
  );

  if (sentenceBoundary > Math.floor(maxLength * 0.6)) {
    return truncated.slice(0, sentenceBoundary + 1).trim();
  }

  return `${truncated.trim()}…`;
}

function countConcreteSignals(text: string): number {
  const matches = text.match(/\b\d+[\d.,]*\b|\*\*[^*]+\*\*|\b(до кінця|зокрема|через|після|заявив|заявила|міністр|уряд|закон|реформа|єс|водіїв?|авто)\b/giu);
  return matches?.length ?? 0;
}

function hasCorruptedOutput(text: string): boolean {
  if (text.includes("�")) {
    return true;
  }

  const normalized = normalizeWhitespace(text);
  // Only flag clearly pathological repetitions (same 80+ char chunk repeated 2+ times).
  const repeatedFragment = normalized.match(/(.{80,200}?)\1{2,}/u);
  return Boolean(repeatedFragment);
}

function isWeakNewsPost(post: string, excerpt: string): boolean {
  const normalizedPost = normalizeWhitespace(post);
  const normalizedExcerpt = normalizeWhitespace(excerpt);
  const sentenceCount = normalizedPost.split(/[.!?]+/).map((item) => item.trim()).filter(Boolean).length;
  const paragraphCount = post.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean).length;
  const wordCount = normalizedPost.split(/\s+/).filter(Boolean).length;
  const excerptWordCount = normalizedExcerpt.split(/\s+/).filter(Boolean).length;
  const concreteSignals = countConcreteSignals(normalizedPost);

  if (hasCorruptedOutput(post)) {
    return true;
  }

  if (normalizedPost.length < 90 || wordCount < 14) {
    return true;
  }

  if (excerptWordCount >= 60 && normalizedPost.length < 140) {
    return true;
  }

  if (excerptWordCount >= 80 && sentenceCount < 2) {
    return true;
  }

  if (excerptWordCount >= 80 && concreteSignals < 2) {
    return true;
  }

  return paragraphCount === 0;
}

function buildRescueNewsPrompt(title: string, excerpt: string, targetLength: string): string {
  return `Перепиши новину в змістовний Telegram-пост українською.

Жорсткі вимоги:
- Не можна повертати один короткий рядок або загальну фразу.
- Потрібно щонайменше 2 абзаци.
- Потрібно включити мінімум 3 конкретні деталі з тексту, якщо вони є: цифри, строки, причини, імена, дії, умови.
- Якщо новина прикладна, дай короткий перелік дій або причин.
- Не вигадуй фактів.
- Не дублюй заголовок.
- Без URL, без хештегів.
- Довжина: ${targetLength}.

Поверни тільки готовий пост.

Заголовок:
${title}

Матеріал:
${excerpt}`;
}

async function generateGeminiText(
  apiKey: string,
  prompt: string,
  options: TextGenerationOptions = {},
): Promise<string | undefined> {
  for (const model of MODELS) {
    const res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxTokens ?? 900,
        },
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as GeminiResponse;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text?.trim()) {
        console.log(`AI summary via ${model}`);
        return text.trim();
      }

      console.warn(`Gemini API returned empty content (${model})`);
      continue;
    }

    const errorBody = await res.text();
    console.warn(`Gemini API error (${model}): ${res.status}`, errorBody);
  }

  return undefined;
}

async function generateOpenRouterText(
  prompt: string,
  options: TextGenerationOptions = {},
): Promise<string | undefined> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }

  for (const model of getOpenRouterModels()) {
    const res = await fetch(OPENROUTER_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/ghostkeeper95/auto-pdr-poster",
        "X-Title": "auto-pdr-poster",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 900,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as OpenRouterResponse;
      const text = parseOpenRouterContent(data.choices?.[0]?.message?.content);
      if (text?.trim()) {
        console.log(`AI summary via ${model} on OpenRouter`);
        return text.trim();
      }

      console.warn(`OpenRouter API returned empty content (${model})`);
      continue;
    }

    const errorBody = await res.text();
    console.warn(`OpenRouter API error (${model}): ${res.status}`, errorBody);
  }

  return undefined;
}

async function generateAiText(
  geminiApiKey: string | undefined,
  prompt: string,
  options: TextGenerationOptions = {},
): Promise<string | undefined> {
  if (geminiApiKey?.trim()) {
    const geminiText = await generateGeminiText(geminiApiKey, prompt, options);
    if (geminiText) {
      return geminiText;
    }
  }

  return generateOpenRouterText(prompt, options);
}

async function generateAiTextOpenRouterFirst(
  geminiApiKey: string | undefined,
  prompt: string,
  options: TextGenerationOptions = {},
): Promise<string | undefined> {
  const openRouterText = await generateOpenRouterText(prompt, options);
  if (openRouterText) {
    return openRouterText;
  }

  if (geminiApiKey?.trim()) {
    return generateGeminiText(geminiApiKey, prompt, options);
  }

  return undefined;
}

async function generateAlternativeAiText(
  geminiApiKey: string | undefined,
  prompt: string,
  options: TextGenerationOptions = {},
): Promise<string | undefined> {
  const openRouterText = await generateOpenRouterText(prompt, options);
  if (openRouterText) {
    return openRouterText;
  }

  if (geminiApiKey?.trim()) {
    return generateGeminiText(geminiApiKey, prompt, options);
  }

  return undefined;
}

export async function summarizeExplanation(
  apiKey: string | undefined,
  explanation: string,
): Promise<string> {
  const prompt = `Ти — помічник з підготовки до іспиту з ПДР України. Скороти це пояснення до короткого тексту (3-5 речень). Обов'язково збережи:
- Яка правильна відповідь і чому
- Посилання на конкретні пункти ПДР (якщо є)

Не додавай вступних фраз типу "Це питання стосується...". Одразу переходь до суті. Пиши українською.

Пояснення:
${explanation}`;

  const result = await generateAiText(apiKey, prompt, { maxTokens: 350, temperature: 0.2 });
  if (result && !isWeakExplanationSummary(result, explanation)) {
    return result;
  }

  if (result) {
    console.warn("AI explanation summary rejected as incomplete, using deterministic fallback");
  }

  const fallbackSummary = buildFallbackExplanationSummary(explanation);
  return fallbackSummary || explanation;
}

export async function formatRoadSignExplanation(
  apiKey: string | undefined,
  signNumber: string,
  signTitle: string,
  explanation: string,
): Promise<string> {
  const prompt = `Ти готуєш роз'яснення дорожнього знаку для Telegram-рубрики "Повторення дорожніх знаків".

Знак: ${signNumber} — ${signTitle}

Напиши пояснення для звичайного водія:
- 3-5 речень, живою українською
- Поясни ЩО означає знак і В ЯКИХ СИТУАЦІЯХ він встановлюється — конкретно і зрозуміло
- Якщо є важливі винятки або нюанси дії знаку — згадай їх коротко
- НЕ перераховуй номери інших знаків — замість цього опиши їх значення словами, або взагалі опусти якщо не суттєво
- Без формату тесту, без переліків номерів знаків
- Практичний і корисний тон — щоб водій краще зрозумів правило

Поверни тільки готовий текст без заголовку.

Вихідний текст:
${explanation}`;

  const result = await generateAiText(apiKey, prompt, { maxTokens: 420, temperature: 0.25 });
  if (result && result.trim().length >= 60 && !hasCorruptedOutput(result)) {
    return result.trim();
  }

  const fallback = splitIntoSentences(normalizeWhitespace(explanation)).slice(0, 4).join(" ").trim();
  return fallback || normalizeWhitespace(explanation);
}

export async function formatNewsPost(
  apiKey: string | undefined,
  title: string,
  excerpt: string,
  maxLength?: number,
): Promise<string> {
  const targetLength = maxLength ? `до ${maxLength} символів` : "600-1200 символів";
  const prompt = `Ти редагуєш новину в Telegram-пост українською для каналу про авто й водіїв в Україні.

Стиль поста:
- Починай з емодзі, яке пасує темі, і короткого ліду (1-2 речення, що інтригують і одразу дають суть).
- Далі 1-2 абзаци з деталями: факти, цифри, умови, причини, наслідки. Конкретика з матеріалу.
- Можеш використати маркований список (• ) для переліку фактів чи кроків — 3-5 пунктів.
- У фіналі коротке резюме або риторичне питання (1 рядок), прив'язане до фактів.
- Виділяй ключові слова/фрази через **подвійні зірочки**.
- Абзаци коротні (1-3 речення), щоб легко читалося з телефона.

Жорсткі правила:
- Пиши українською, живо, але без води і канцеляриту.
- Спирайся ТІЛЬКИ на факти з матеріалу. Нічого не вигадуй. Не додавай фактів яких немає.
- Довжина: ${targetLength}.
- Не дублюй заголовок буквально в тексті.
- Без хештегів, без дат у стилі "24.04.2026", без сирих URL.
- Текст має бути завершеним — без "далі" чи натяків на продовження.
- Уникай порожніх фраз "це важливо знати", "варто стежити", "автомобільна галузь розвивається".
- Не пиши "Ось пост:" чи подібних метапояснень.

Поверни ТІЛЬКИ готовий текст поста.

Заголовок:
${title}

Матеріал:
${excerpt}`;

  const result = await generateAiTextOpenRouterFirst(apiKey, prompt, {
    maxTokens: Math.min(2048, Math.max(800, Math.ceil((maxLength ?? 900) * 2))),
    temperature: 0.3,
  });

  if (result && !isWeakNewsPost(result, excerpt)) {
    return result;
  }

  if (result) {
    console.warn("AI post rejected as too weak, requesting rescue rewrite");
  }

  const rescue = await generateAlternativeAiText(apiKey, buildRescueNewsPrompt(title, excerpt, targetLength), {
    maxTokens: Math.min(2048, Math.max(800, Math.ceil((maxLength ?? 900) * 2))),
    temperature: 0.25,
  });

  if (rescue) {
    if (isWeakNewsPost(rescue, excerpt)) {
      console.warn("AI rescue still weak, but accepting it over deterministic fallback");
    }
    return rescue;
  }

  console.warn("AI rescue returned nothing, using deterministic fallback");
  return buildFallbackNewsPost(excerpt, maxLength);
}

export async function shortenNewsPost(
  apiKey: string | undefined,
  title: string,
  post: string,
  maxLength: number,
): Promise<string> {
  const prompt = `Скороти готовий Telegram-пост українською до ${maxLength} символів.

Правила:
- Збережи головні факти, цифри, назви постанов, наказів або дат, якщо вони є критично важливими.
- Залиш текст завершеним і цілісним.
- Не обривай речення.
- Не додавай URL, хештеги чи нові факти.
- Якщо треба, скорочуй другорядні деталі, а не фінальний висновок.
- Поверни тільки готовий скорочений пост.

Заголовок:
${title}

Поточний пост:
${post}`;

  const result = await generateAiTextOpenRouterFirst(apiKey, prompt, {
    maxTokens: Math.min(2048, Math.max(600, maxLength * 2)),
    temperature: 0.2,
  });
  return result ?? buildFallbackNewsPost(post, maxLength);
}

export async function extractImageKeywords(
  apiKey: string | undefined,
  title: string,
): Promise<string> {
  const prompt = `Extract 2-3 English keywords for stock photo search from this Ukrainian article title. Return ONLY the keywords separated by spaces, nothing else.

Title: ${title}`;

  const result = await generateAiText(apiKey, prompt, { maxTokens: 40, temperature: 0 });
  return result ?? "driving road car";
}
