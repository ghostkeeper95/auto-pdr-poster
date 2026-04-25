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

export interface RoadSignTheoryItem {
  id: string;
  section: string;
  signNumber: string;
  title: string;
  imageUrl: string;
  explanation: string;
  sourceUrl: string;
}

const BASE_URL = "https://pdrtest.com";
const IMAGE_BASE_URL = "https://bucket.pdrtest.com/pics";

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export async function fetchRoadSignTheorySection(section: string): Promise<RoadSignTheoryItem[]> {
  const url = `${BASE_URL}/driver/rules/section/${section}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch rules section ${section}: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const items: RoadSignTheoryItem[] = [];

  $("li.list-group-item").each((index, item) => {
    const $item = $(item);
    const heading = normalizeText($item.children("p").first().text());
    if (!heading || !heading.includes("-")) return;

    const splitIndex = heading.indexOf("-");
    const signNumber = normalizeText(heading.slice(0, splitIndex));
    const signTitle = normalizeText(heading.slice(splitIndex + 1));
    if (!signNumber || !signTitle) return;

    const rawImageSrc = $item.find("img[src*='/signs/']").first().attr("src")?.trim();
    if (!rawImageSrc) return;
    // Telegram doesn't support SVG; proxy through weserv.nl to get PNG
    const mainImage = rawImageSrc.endsWith(".svg")
      ? `https://images.weserv.nl/?url=${encodeURIComponent(rawImageSrc.replace("https://", ""))}&output=png&w=300`
      : rawImageSrc;

    const leadParagraphs = $item.children("p").slice(1)
      .map((_i, el) => normalizeText($(el).text()))
      .get()
      .filter(Boolean);

    const accordionParagraphs = $item.find(".accordion-body p")
      .map((_i, el) => normalizeText($(el).text()))
      .get()
      .filter(Boolean);

    const explanationParts: string[] = [];
    for (const paragraph of [...leadParagraphs, ...accordionParagraphs]) {
      if (!explanationParts.includes(paragraph)) {
        explanationParts.push(paragraph);
      }
    }

    const explanation = explanationParts.join("\n\n").trim();
    if (!explanation) return;

    items.push({
      id: `${section}:${signNumber}:${index}`,
      section,
      signNumber,
      title: signTitle,
      imageUrl: mainImage,
      explanation,
      sourceUrl: url,
    });
  });

  return items;
}

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
