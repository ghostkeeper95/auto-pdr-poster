const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODELS = ["openai/gpt-4o-mini", "openrouter/auto"];

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
    .slice(0, 4);

  const body = paragraphs.join("\n\n").trim();
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
  return result ?? explanation;
}

export async function formatNewsPost(
  apiKey: string | undefined,
  title: string,
  excerpt: string,
  maxLength?: number,
): Promise<string> {
  const targetLength = maxLength ? `до ${maxLength} символів` : "600-1200 символів";
  const prompt = `Ти редагуєш новину в короткий, щільний Telegram-пост для каналу про водіїв в Україні.

Правила:
- Пиши українською, коротко, предметно, без води.
- Спирайся тільки на факти з наданого матеріалу. Нічого не вигадуй і не узагальнюй понад текст.
- Довжина: ${targetLength}.
- У першому абзаці одразу дай суть новини, без розгону.
- Обов'язково включи 2-4 конкретні факти з тексту: дати, цифри, строки, прізвища, назви органів, умови, наслідки.
- Якщо в тексті є лише один конкретний факт, не роздувай пост загальними міркуваннями.
- Виділяй ключові факти подвійними зірочками: **ось так**.
- Структура: 2-4 короткі абзаци або 1 абзац + короткий список.
- Можна використовувати маркований список (• ) для переліку фактів.
- Пояснюй, чому це важливо для водія, тільки якщо це прямо випливає з фактажу.
- Заборонені фрази-пустушки: "це важливо знати", "варто стежити", "щоб бути в курсі", "автомобільна індустрія розвивається", "обговоримо у коментарях?" без конкретного контексту.
- У фіналі можна дати 1 коротке запитання або висновок, але тільки прив'язаний до фактів новини.
- Без хештегів. Без дати. Без сирих URL.
- Не дублюй заголовок в тексті поста.
- Текст має бути завершеним: без обірваних думок, без "далі", без натяку на продовження.
- Якщо матеріал схожий на короткий тизер і фактів мало, поверни максимально чесний короткий пост без вигаданих деталей.

Поверни тільки готовий текст, без заголовків на кшталт "Ось пост".

Заголовок:
${title}

Матеріал:
${excerpt}`;

  const result = await generateAiText(apiKey, prompt, {
    maxTokens: Math.min(1200, Math.max(350, Math.ceil((maxLength ?? 900) / 2))),
    temperature: 0.25,
  });
  return result ?? buildFallbackNewsPost(excerpt, maxLength);
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

  const result = await generateAiText(apiKey, prompt, { maxTokens: Math.max(220, Math.ceil(maxLength / 2)), temperature: 0.15 });
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
