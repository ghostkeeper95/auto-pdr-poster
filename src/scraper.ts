import * as cheerio from "cheerio";

export interface Answer {
  answer: string;
  truth: boolean;
}

export interface Question {
  id: string;
  section: number;
  question: string;
  answers: Answer[];
  image: string | false;
  explanation?: string;
}

const BASE_URL = "https://pdrtest.com";
const IMAGE_BASE_URL = "https://bucket.pdrtest.com/pics";

export async function fetchSectionQuestions(
  sectionId: number,
): Promise<Question[]> {
  const url = `${BASE_URL}/questions/${sectionId}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch section ${sectionId}: ${response.status}`);
  }

  const html = await response.text();
  return parseQuestions(html, sectionId);
}

function parseQuestions(html: string, sectionId: number): Question[] {
  const $ = cheerio.load(html);
  const questions: Question[] = [];

  const imageMap = extractImageMap(html);

  $("div.row.g-4.position-relative").each((_i, row) => {
    const $row = $(row);

    const linkEl = $row.find("h3 a").first();
    const href = linkEl.attr("href") ?? "";
    const questionId = href.replace("/question/", "");
    if (!questionId) return;

    const questionText = linkEl
      .contents()
      .filter((_i, el) => el.type === "text" && $(el).text().trim() !== ".")
      .last()
      .text()
      .trim();

    const answers: Answer[] = [];
    $row.find("span.btn").each((_j, span) => {
      const $span = $(span);
      const className = $span.attr("class") ?? "";
      answers.push({
        answer: $span.text().trim(),
        truth: className.includes("btn-green"),
      });
    });

    const imageCode = imageMap.get(questionId);
    const image: string | false = imageCode
      ? `${IMAGE_BASE_URL}/${imageCode}.webp`
      : false;

    if (questionText && answers.length > 0) {
      questions.push({
        id: questionId,
        section: sectionId,
        question: questionText,
        answers,
        image,
      });
    }
  });

  return questions;
}

function extractImageMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const regex =
    /\\"id\\":\\"([\d.]+)\\",\\"section\\":\d+,(?:\\"position\\":\\"[\d]+\\",)?\\"image\\":\\"(\d+)\\"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    map.set(match[1], match[2]);
  }
  return map;
}

export async function fetchQuestionExplanation(
  questionId: string,
): Promise<string | undefined> {
  const url = `${BASE_URL}/question/${questionId}`;
  const response = await fetch(url);

  if (!response.ok) {
    console.warn(`Failed to fetch question ${questionId}: ${response.status}`);
    return undefined;
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const paragraphs: string[] = [];
  $(`[id="body-${questionId}"]`).find("p").each((_i, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });

  return paragraphs.length > 0 ? paragraphs.join("\n\n") : undefined;
}
