const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

async function generateGeminiText(apiKey: string, prompt: string): Promise<string | undefined> {
  for (const model of MODELS) {
    const res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
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

export async function summarizeExplanation(
  apiKey: string,
  explanation: string,
): Promise<string> {
  const prompt = `Ти — помічник з підготовки до іспиту з ПДР України. Скороти це пояснення до короткого тексту (3-5 речень). Обов'язково збережи:
- Яка правильна відповідь і чому
- Посилання на конкретні пункти ПДР (якщо є)

Не додавай вступних фраз типу "Це питання стосується...". Одразу переходь до суті. Пиши українською.

Пояснення:
${explanation}`;

  const result = await generateGeminiText(apiKey, prompt);
  return result ?? explanation;
}

export async function formatNewsPost(
  apiKey: string,
  title: string,
  excerpt: string,
  maxLength?: number,
): Promise<string> {
  const targetLength = maxLength ? `до ${maxLength} символів` : "600-1200 символів";
  const prompt = `Ти готуєш інформативний пост для Telegram-каналу про водіїв та ПДР в Україні.

Правила:
- Перепиши матеріал у формат корисного Telegram-поста українською.
- Тон: впевнений, фактичний, без води.
- Довжина: ${targetLength}.
- Зберігай ключові факти: номери законів, цифри, суми, конкретні зміни.
- Виділяй ключові факти подвійними зірочками: **ось так**.
- Використай 1-2 емодзі: лише в першому або останньому рядку.
- Структуруй пост: 3-5 коротких абзаців.
- Можна використовувати маркований список (• ) для переліку фактів.
- Поясни, чому це важливо для водія.
- В кінці — 1 короткий рядок для обговорення в коментарях.
- Без хештегів. Без дати. Без сирих URL.
- Не дублюй заголовок в тексті поста.
- Текст має бути завершеним: без обірваних думок, без "далі", без натяку на продовження.
- Не вигадуй фактів, спирайся лише на наданий текст.

Поверни тільки готовий текст, без заголовків на кшталт "Ось пост".

Заголовок:
${title}

Матеріал:
${excerpt}`;

  const result = await generateGeminiText(apiKey, prompt);
  return result ?? excerpt;
}

export async function shortenNewsPost(
  apiKey: string,
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

  const result = await generateGeminiText(apiKey, prompt);
  return result ?? post;
}

export async function extractImageKeywords(
  apiKey: string,
  title: string,
): Promise<string> {
  const prompt = `Extract 2-3 English keywords for stock photo search from this Ukrainian article title. Return ONLY the keywords separated by spaces, nothing else.

Title: ${title}`;

  const result = await generateGeminiText(apiKey, prompt);
  return result ?? "driving road car";
}
