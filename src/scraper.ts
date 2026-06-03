import * as cheerio from "cheerio";
import {
  getBankedExplanation,
  getBankedSection,
  setBankedExplanation,
  setBankedSection,
} from "./bank.js";

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
  imageUrls: string[];
  explanation: string;
  sourceUrl: string;
}

const BASE_URL = "https://pdrtest.com";
const IMAGE_BASE_URL = "https://bucket.pdrtest.com/pics";
const GREEN_WAY_BASE_URL = "https://green-way.com.ua";
const GREEN_WAY_API_URL = "https://api.green-way.com.ua/";

const PDR_BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const pdrCookieJar = new Map<string, string>();

function buildCookieHeader(): string | undefined {
  if (pdrCookieJar.size === 0) return undefined;
  return Array.from(pdrCookieJar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function rememberCookiesFromResponse(response: Response): void {
  const setCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  const cookies = setCookie ?? (() => {
    const single = response.headers.get("set-cookie");
    return single ? [single] : [];
  })();

  for (const raw of cookies) {
    const [pair] = raw.split(";");
    if (!pair) continue;
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (name) pdrCookieJar.set(name, value);
  }
}

function isChallengeResponse(response: Response): boolean {
  return response.headers.get("x-vercel-mitigated") === "challenge"
    || response.headers.has("x-vercel-challenge-token");
}

async function fetchPdr(url: string, attempt = 0): Promise<Response> {
  const headers: Record<string, string> = { ...PDR_BROWSER_HEADERS, Referer: `${BASE_URL}/` };
  const cookie = buildCookieHeader();
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(url, { headers, redirect: "follow" });
  rememberCookiesFromResponse(response);

  const transient = response.status === 429 || response.status >= 500 || isChallengeResponse(response);
  if (transient && attempt < 3) {
    const delayMs = 800 * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fetchPdr(url, attempt + 1);
  }

  return response;
}

const sectionQuestionsCache = new Map<number, Question[]>();

const GREEN_WAY_ROZDIL_BY_PDR_SECTION: Record<string, number> = {
  "33.1": 34,
  "33.2": 35,
  "33.3": 36,
  "33.4": 37,
  "33.5": 38,
  "33.6": 39,
  "33.7": 40,
};

const GREEN_WAY_FALLBACK_ROZDIL_IDS = [34, 35, 36, 37, 38, 39, 40] as const;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLookupSignNumber(signNumber: string): string | undefined {
  const match = signNumber.match(/\d+(?:\.\d+)+/);
  return match?.[0];
}

function getCandidateGreenWayRozdilIds(section?: string): number[] {
  const mapped = section ? GREEN_WAY_ROZDIL_BY_PDR_SECTION[section] : undefined;
  return mapped
    ? [mapped, ...GREEN_WAY_FALLBACK_ROZDIL_IDS.filter((value) => value !== mapped)]
    : [...GREEN_WAY_FALLBACK_ROZDIL_IDS];
}

async function resolveGreenWayParagraphId(
  lookupSignNumber: string,
  rozdilId: number,
): Promise<string | undefined> {
  const pageUrl = `${GREEN_WAY_BASE_URL}/uk/dovidniki/pdr-slider/rozdil-${rozdilId}`;
  const response = await fetch(pageUrl);
  if (!response.ok) {
    return undefined;
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const signRegex = new RegExp(`^${escapeRegex(lookupSignNumber)}(?:\\b|\\s|«|"|”)`);

  let paragraphId: string | undefined;

  $("li.numbers[data-id]").each((_idx, element) => {
    if (paragraphId) {
      return;
    }

    const label = normalizeText($(element).text());
    if (!label || !signRegex.test(label)) {
      return;
    }

    const foundId = normalizeText($(element).attr("data-id") ?? "");
    if (/^\d+$/.test(foundId)) {
      paragraphId = foundId;
    }
  });

  return paragraphId;
}

async function fetchGreenWayParagraphHtml(paragraphId: string): Promise<string | undefined> {
  const payload = {
    paragraphIds: paragraphId,
    locale: "uk",
  };

  const body = new URLSearchParams();
  body.set("method", "getHtmlParagraphsById");
  body.set("data", JSON.stringify(payload));

  const response = await fetch(GREEN_WAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    return undefined;
  }

  const json = await response.json() as {
    success?: {
      paragraphs?: Record<string, string>;
    };
  };

  return json.success?.paragraphs?.[paragraphId];
}

function extractGreenWayExpertCommentFromHtml(paragraphHtml: string): string | undefined {
  const $ = cheerio.load(paragraphHtml);

  const expertBlock = $(".info-pdd.expert")
    .filter((_idx, element) => {
      const $block = $(element);
      if ($block.hasClass("history")) {
        return false;
      }

      const heading = normalizeText($block.find(".info-text").first().text()).toLowerCase();
      return heading.includes("коментар експерта");
    })
    .first();

  if (expertBlock.length === 0) {
    return undefined;
  }

  const paragraphs = expertBlock.find(".comment_question p")
    .map((_idx, element) => normalizeText($(element).text()))
    .get()
    .filter(Boolean);

  const uniqueParagraphs = Array.from(new Set(paragraphs));
  if (uniqueParagraphs.length === 0) {
    return undefined;
  }

  return uniqueParagraphs.join("\n\n").trim();
}

export async function fetchGreenWayExpertComment(
  signNumber: string,
  section?: string,
): Promise<string | undefined> {
  const lookupSignNumber = extractLookupSignNumber(signNumber);
  if (!lookupSignNumber) {
    return undefined;
  }

  const candidateRozdilIds = getCandidateGreenWayRozdilIds(section);

  for (const rozdilId of candidateRozdilIds) {
    try {
      const paragraphId = await resolveGreenWayParagraphId(lookupSignNumber, rozdilId);
      if (!paragraphId) {
        continue;
      }

      const paragraphHtml = await fetchGreenWayParagraphHtml(paragraphId);
      if (!paragraphHtml) {
        continue;
      }

      const expertComment = extractGreenWayExpertCommentFromHtml(paragraphHtml);
      if (expertComment) {
        return expertComment;
      }
    } catch (error) {
      console.warn(`Failed to fetch Green Way expert comment for ${lookupSignNumber} in rozdil-${rozdilId}`, error);
    }
  }

  return undefined;
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

    const headingParts = heading.split(/\s-\s/).map(normalizeText).filter(Boolean);
    const isSignCode = (value: string) => /^\d+(?:\.\d+)+$/.test(value);

    let signNumber = "";
    let signTitle = "";

    // Handle ranges like: "6.7.1 - 6.7.7 - Автозаправні / електрозарядні станції"
    if (headingParts.length >= 3 && isSignCode(headingParts[0]!) && isSignCode(headingParts[1]!)) {
      signNumber = `${headingParts[0]} - ${headingParts[1]}`;
      signTitle = headingParts.slice(2).join(" - ");
    } else {
      const splitIndex = heading.indexOf("-");
      signNumber = normalizeText(heading.slice(0, splitIndex));
      signTitle = normalizeText(heading.slice(splitIndex + 1));
    }

    if (!signNumber || !signTitle) return;

    const topImages = $item.children("div").first().find("img[src*='/signs/']")
      .map((_i, el) => normalizeText($(el).attr("src") ?? ""))
      .get()
      .filter(Boolean);
    const uniqueTopImages = Array.from(new Set(topImages));

    const fallbackImage = normalizeText($item.find("img[src*='/signs/']").first().attr("src") ?? "");
    const imageUrls = uniqueTopImages.length > 0 ? uniqueTopImages : (fallbackImage ? [fallbackImage] : []);
    if (imageUrls.length === 0) return;
    const mainImage = imageUrls[0]!;

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
      imageUrls,
      explanation,
      sourceUrl: url,
    });
  });

  return items;
}

export async function fetchSectionQuestions(
  sectionId: number,
): Promise<Question[]> {
  const banked = getBankedSection(sectionId);
  if (banked) return banked;

  const cached = sectionQuestionsCache.get(sectionId);
  if (cached) return cached;

  const url = `${BASE_URL}/questions/${sectionId}`;
  const response = await fetchPdr(url);

  if (!response.ok || isChallengeResponse(response)) {
    const reason = isChallengeResponse(response) ? "bot-challenge" : String(response.status);
    throw new Error(`Failed to fetch section ${sectionId}: ${reason}`);
  }

  const html = await response.text();
  const parsed = parseQuestions(html, sectionId);
  if (parsed.length > 0) {
    sectionQuestionsCache.set(sectionId, parsed);
    setBankedSection(sectionId, parsed);
  }
  return parsed;
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
  const banked = getBankedExplanation(questionId);
  if (banked) return banked;

  const url = `${BASE_URL}/question/${questionId}`;
  const response = await fetchPdr(url);

  if (!response.ok || isChallengeResponse(response)) {
    const reason = isChallengeResponse(response) ? "bot-challenge" : String(response.status);
    console.warn(`Failed to fetch question ${questionId}: ${reason}`);
    return undefined;
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const paragraphs: string[] = [];
  $(`[id="body-${questionId}"]`).find("p").each((_i, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });

  const explanation = paragraphs.length > 0 ? paragraphs.join("\n\n") : undefined;
  if (explanation) setBankedExplanation(questionId, explanation);
  return explanation;
}

export function parseQuestionsHtml(html: string, sectionId: number): Question[] {
  return parseQuestions(html, sectionId);
}

export function parseExplanationHtml(html: string, questionId: string): string | undefined {
  const $ = cheerio.load(html);
  const paragraphs: string[] = [];
  $(`[id="body-${questionId}"]`).find("p").each((_i, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });
  return paragraphs.length > 0 ? paragraphs.join("\n\n") : undefined;
}
