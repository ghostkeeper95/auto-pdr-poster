const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
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

  return explanation;
}
