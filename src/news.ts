import * as cheerio from "cheerio";

const PDR_NEWS_URL = "https://pdrtest.com/news";
const PDR_BASE_URL = "https://pdrtest.com";
const UKRNET_AUTO_URL = "https://www.ukr.net/news/auto.html";
const UKRNET_BASE_URL = "https://www.ukr.net";
const HSC_FEED_URL = "https://hsc.gov.ua/feed/";
const HSC_BASE_URL = "https://hsc.gov.ua";
const MMR_FEED_URL = "https://mmr.net.ua/feed";
const MMR_BASE_URL = "https://mmr.net.ua";
const AUTOGEEK_FEED_URL = "https://autogeek.com.ua/feed/";
const AUTOGEEK_BASE_URL = "https://autogeek.com.ua";

const NEWS_REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Accept-Language": "uk,en-US;q=0.9,en;q=0.8",
};

const UKRAINIAN_MONTHS: Record<string, number> = {
  "січня": 0,
  "лютого": 1,
  "березня": 2,
  "квітня": 3,
  "травня": 4,
  "червня": 5,
  "липня": 6,
  "серпня": 7,
  "вересня": 8,
  "жовтня": 9,
  "листопада": 10,
  "грудня": 11,
};

type NewsSource = "pdrtest" | "hsc" | "mmr" | "autogeek";

interface RssSourceConfig {
  source: Exclude<NewsSource, "pdrtest">;
  feedUrl: string;
  baseUrl: string;
  skipPrefixes?: string[];
}

export interface NewsCandidate {
  source: string;
  title: string;
  excerpt: string;
  url: string;
  publishedAt: string;
  imageUrl?: string;
}

export interface NewsHeadline {
  source: string;
  title: string;
  url: string;
  publishedAt: string;
}

export function buildBrandedImageUrl(title: string): string {
  const shortTitle = truncate(title, 72);
  const text = encodeURIComponent(["PDR UA", "Новини для водіїв", shortTitle].join("\n"));
  return `https://dummyimage.com/1200x630/0f172a/f8fafc.png&text=${text}`;
}

export function resolveNewsImageUrl(url: string, imageUrl?: string): string | undefined {
  if (imageUrl && !imageUrl.startsWith("data:")) {
    return imageUrl;
  }

  if (
    url.startsWith(HSC_BASE_URL)
    || url.startsWith(MMR_BASE_URL)
    || url.startsWith(AUTOGEEK_BASE_URL)
  ) {
    return undefined;
  }

  const articleId = url.match(/\/(\d+)-[^/]+\.html$/)?.[1];
  if (!articleId) {
    return undefined;
  }

  return `${PDR_BASE_URL}/news/news-${articleId}.jpg`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function stripHtml(text: string): string {
  return normalizeWhitespace(text.replace(/<[^>]+>/g, " ").replace(/&#8230;|&hellip;/g, "..."));
}

function cleanSourceLabel(text: string): string {
  return normalizeWhitespace(text).replace(/^\((.*)\)$/, "$1");
}

function normalizeArticleTitle(text: string): string {
  return normalizeWhitespace(text)
    .replace(/\s+[|–-]\s+(новини|ua\s?motors|uamotors|autogeek|mmr|автоцентр|oboz\.ua|фокус).*$/i, "")
    .trim();
}

function stripTrailingSourceDomain(text: string): string {
  return normalizeWhitespace(text).replace(/\s+[a-z0-9-]+\.[a-z]{2,}(?:\s*)$/i, "").trim();
}

function isUsefulArticleParagraph(text: string): boolean {
  if (text.length < 45) return false;

  return ![
    /^фото:/i,
    /^відео:/i,
    /^колаж:/i,
    /^джерело:/i,
    /^читайте також/i,
    /^підписуй/i,
    /^реклама/i,
    /^матеріали з позначками/i,
    /^наш seo-партнер/i,
    /^mmr\.net\.ua/i,
    /^©/i,
  ].some((pattern) => pattern.test(text));
}

function collectParagraphs($: cheerio.CheerioAPI, selectors: string[]): string[] {
  const unique = new Set<string>();

  for (const selector of selectors) {
    const paragraphs = $(selector)
      .map((_i, el) => normalizeWhitespace($(el).text()))
      .get()
      .filter(isUsefulArticleParagraph);

    if (paragraphs.length >= 2) {
      const result: string[] = [];
      for (const paragraph of paragraphs) {
        if (unique.has(paragraph)) continue;
        unique.add(paragraph);
        result.push(paragraph);
      }
      return result;
    }
  }

  return [];
}

function collectParagraphsWithMinimum(
  $: cheerio.CheerioAPI,
  selectors: string[],
  minimumCount: number,
): string[] {
  const unique = new Set<string>();

  for (const selector of selectors) {
    const paragraphs = $(selector)
      .map((_i, el) => stripTrailingSourceDomain(normalizeWhitespace($(el).text())))
      .get()
      .filter(isUsefulArticleParagraph);

    if (paragraphs.length >= minimumCount) {
      const result: string[] = [];
      for (const paragraph of paragraphs) {
        if (unique.has(paragraph)) continue;
        unique.add(paragraph);
        result.push(paragraph);
      }
      return result;
    }
  }

  return [];
}

function formatCurrentDatePrefix(): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = String(now.getFullYear());
  return `${day}.${month}.${year}`;
}

async function fetchNewsPage(url: string): Promise<string> {
  const response = await fetch(url, { headers: NEWS_REQUEST_HEADERS });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, "’")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#8230;/g, "...");
}

function parseDateValue(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return timestamp;
  }

  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  const ukrainianMatch = normalized.match(/(\d{1,2})\s+([а-яіїєґ']+)\s+(\d{4})(?:\s*(?:,|о)?\s*(\d{1,2}):(\d{2}))?/i);
  if (ukrainianMatch) {
    const [, dayRaw, monthRaw, yearRaw, hourRaw, minuteRaw] = ukrainianMatch;
    const monthIndex = UKRAINIAN_MONTHS[monthRaw];
    if (monthIndex !== undefined) {
      const day = Number(dayRaw);
      const year = Number(yearRaw);
      const hour = Number(hourRaw ?? 0);
      const minute = Number(minuteRaw ?? 0);
      return new Date(year, monthIndex, day, hour, minute).getTime();
    }
  }

  const numericMatch = normalized.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*,?\s*(\d{1,2}):(\d{2}))?/);
  if (numericMatch) {
    const [, dayRaw, monthRaw, yearRaw, hourRaw, minuteRaw] = numericMatch;
    return new Date(
      Number(yearRaw),
      Number(monthRaw) - 1,
      Number(dayRaw),
      Number(hourRaw ?? 0),
      Number(minuteRaw ?? 0),
    ).getTime();
  }

  return 0;
}

function sortByPublishedAt(items: NewsCandidate[]): NewsCandidate[] {
  return [...items].sort((left, right) => parseDateValue(right.publishedAt) - parseDateValue(left.publishedAt));
}

function extractArticleUrls(html: string, limit: number): string[] {
  const matches = html.match(/\/news\/[a-z0-9-_/]+\.html/gi) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const match of matches) {
    const url = new URL(match, PDR_BASE_URL).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= limit) break;
  }

  return urls;
}

function extractPublishedAt(pageText: string): string {
  const match = pageText.match(/\d{1,2}\s+[а-яіїєґ]+\s+\d{4},\s+\d{2}:\d{2}/i);
  return match?.[0] ?? "Невідома дата";
}

function extractExcerpt($: cheerio.CheerioAPI, skipPrefixes: string[] = []): string {
  const paragraphs = $("p")
    .map((_i, el) => normalizeWhitespace($(el).text()))
    .get()
    .filter((text) => text.length >= 40)
    .filter((text) => !text.startsWith("Copyright"))
    .filter((text) => !text.startsWith("Контакти"))
    .filter((text) => !text.startsWith("ПДР Тест Центр - це"))
    .filter((text) => !skipPrefixes.some((prefix) => text.startsWith(prefix)));

  return truncate(paragraphs.join("\n\n"), 4000);
}

function extractImageUrl($: cheerio.CheerioAPI, articleUrl: string, baseUrl: string): string | undefined {
  const candidates = [
    $("meta[property='og:image']").attr("content"),
    $("meta[name='twitter:image']").attr("content"),
    $("img[src*='/news/']").first().attr("src"),
    $("img[src*='news-']").first().attr("src"),
    $("img").first().attr("src"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (candidate.startsWith("data:")) continue;
    const normalized = new URL(candidate, baseUrl).toString();
    const lowered = normalized.toLowerCase();
    if (lowered.endsWith(".svg") || lowered.includes("/svg/") || lowered.includes("logo")) {
      continue;
    }
    return normalized;
  }

  return resolveNewsImageUrl(articleUrl);
}

async function fetchNewsCandidate(url: string): Promise<NewsCandidate | undefined> {
  let html: string;
  try {
    html = await fetchNewsPage(url);
  } catch (error) {
    console.warn(`Failed to fetch news article ${url}:`, error);
    return undefined;
  }

  const $ = cheerio.load(html);
  const title = normalizeWhitespace($("h1").first().text());
  const pageText = normalizeWhitespace($.root().text());
  const excerpt = extractExcerpt($);

  if (!title || !excerpt) {
    return undefined;
  }

  return {
    source: "pdrtest",
    title,
    excerpt,
    url,
    publishedAt: extractPublishedAt(pageText),
    imageUrl: extractImageUrl($, url, PDR_BASE_URL),
  };
}

function extractGenericExcerpt($: cheerio.CheerioAPI): string {
  const directBodyParagraphs = collectParagraphsWithMinimum($, [
    "#content > .post > p",
    "#content .post > p",
    ".post > p",
  ], 1);
  if (directBodyParagraphs.length > 0) {
    return truncate(directBodyParagraphs.slice(0, 6).join("\n\n"), 4000);
  }

  const bodyParagraphs = collectParagraphs($, [
    ".article__content p",
    ".entry-content p",
    ".post-content p",
    ".article-content p",
    ".article p",
    "article p",
    ".news-text p",
    "main article p",
    "main p",
    "p",
  ]);
  if (bodyParagraphs.length > 0) {
    return truncate(bodyParagraphs.slice(0, 6).join("\n\n"), 4000);
  }

  const metaDescription = normalizeWhitespace(
    $("meta[property='og:description']").attr("content")
    || $("meta[name='description']").attr("content")
    || "",
  );
  if (metaDescription.length >= 80) {
    return truncate(metaDescription, 4000);
  }

  return "";
}

function resolveOriginalArticleUrl($: cheerio.CheerioAPI, articleUrl: string): string | undefined {
  const link = $("#content .post a[href*='goto/'], .post a[href*='goto/']").first().attr("href");
  if (!link) {
    return undefined;
  }

  try {
    const absolute = new URL(link, articleUrl).toString();
    const marker = "/goto/";
    const index = absolute.indexOf(marker);
    if (index === -1) {
      return absolute;
    }

    return decodeURIComponent(absolute.slice(index + marker.length));
  } catch {
    return undefined;
  }
}

export async function fetchLatestNewsHeadlines(limit: number): Promise<NewsHeadline[]> {
  const html = await fetchNewsPage(UKRNET_AUTO_URL);
  const $ = cheerio.load(html);
  const currentDatePrefix = formatCurrentDatePrefix();
  const seen = new Set<string>();
  const items: NewsHeadline[] = [];

  $("section.im").each((_index, element) => {
    if (items.length >= limit) {
      return false;
    }

    const section = $(element);
    const link = section.find("a.im-tl_a").first();
    const sourceLink = section.find("a.im-pr_a").first();
    const title = normalizeWhitespace(link.text());
    const href = link.attr("href");
    const source = cleanSourceLabel(sourceLink.text()) || "Ukr.net";
    const publishedTime = normalizeWhitespace(section.find("time.im-tm").first().text());
    const publishedAt = /^\d{1,2}:\d{2}$/.test(publishedTime)
      ? `${currentDatePrefix}, ${publishedTime}`
      : publishedTime || "Невідомий час";

    if (!title || !href) {
      return;
    }

    const url = new URL(href, UKRNET_BASE_URL).toString();
    if (seen.has(url)) {
      return;
    }

    seen.add(url);
    items.push({
      source,
      title,
      url,
      publishedAt,
    });
  });

  return items;
}

export async function fetchNewsDraftFromHeadline(headline: NewsHeadline): Promise<NewsCandidate | undefined> {
  try {
    const html = await fetchNewsPage(headline.url);
    const $ = cheerio.load(html);

    let finalUrl = headline.url;
    let final$ = $;
    let pageTitle = normalizeArticleTitle(
      $("h1").first().text()
      || $("meta[property='og:title']").attr("content")
      || headline.title,
    );
    let excerpt = extractGenericExcerpt($);

    const originalArticleUrl = resolveOriginalArticleUrl($, headline.url);
    const shouldFollowOriginal = Boolean(
      originalArticleUrl
      && excerpt
      && excerpt.length < 260
      && new URL(headline.url).hostname.includes("newsyou.info"),
    );

    if (shouldFollowOriginal && originalArticleUrl) {
      try {
        const originalHtml = await fetchNewsPage(originalArticleUrl);
        final$ = cheerio.load(originalHtml);
        finalUrl = originalArticleUrl;
        pageTitle = normalizeArticleTitle(
          final$("h1").first().text()
          || final$("meta[property='og:title']").attr("content")
          || headline.title,
        );
        excerpt = extractGenericExcerpt(final$);
      } catch (error) {
        console.warn(`Failed to fetch original source for ${headline.url}:`, error);
      }
    }

    const imageBaseUrl = new URL(finalUrl).origin;
    const imageUrl = extractImageUrl(final$, finalUrl, imageBaseUrl);

    if (!pageTitle || !excerpt) {
      return undefined;
    }

    return {
      source: headline.source,
      title: pageTitle,
      excerpt,
      url: finalUrl,
      publishedAt: headline.publishedAt,
      imageUrl,
    };
  } catch (error) {
    console.warn(`Failed to build draft from headline ${headline.url}:`, error);
    return undefined;
  }
}

interface FeedEntry {
  source: Exclude<NewsSource, "pdrtest">;
  title: string;
  url: string;
  publishedAt: string;
  excerpt?: string;
  content?: string;
  imageUrl?: string;
}

function sanitizeFeedContent(text: string): string {
  return truncate(
    stripHtml(text)
      .replace(/\bThe post\b[\s\S]*$/i, "")
      .replace(/\bfirst appeared on\b[\s\S]*$/i, "")
      .replace(/\bMore\b\s*$/i, "")
      .replace(/Джерело матеріалу[\s\S]*$/i, "")
      .trim(),
    4000,
  );
}

function extractRssEntries(
  xml: string,
  baseUrl: string,
  source: Exclude<NewsSource, "pdrtest">,
  limit: number,
): FeedEntry[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

  return items.slice(0, limit).map((item) => {
    const pick = (tag: string) => decodeXml(item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ?? "");
    const pickAttr = (tagPattern: string, attribute: string) => decodeXml(
      item.match(new RegExp(`<${tagPattern}[^>]*${attribute}="([^"]+)"[^>]*>`, "i"))?.[1] ?? "",
    );
    const title = stripHtml(pick("title"));
    const link = stripHtml(pick("link"));
    const pubDate = stripHtml(pick("pubDate"));
    const description = sanitizeFeedContent(pick("description"));
    const content = sanitizeFeedContent(pick("content:encoded"));
    const imageUrl = stripHtml(pickAttr("enclosure", "url")) || stripHtml(pickAttr("media:content", "url"));

    return {
      source,
      title,
      url: new URL(link, baseUrl).toString(),
      publishedAt: pubDate,
      excerpt: description,
      content,
      imageUrl,
    };
  }).filter((item) => item.title && item.url);
}

async function fetchFeedEntries(
  feedUrl: string,
  baseUrl: string,
  source: Exclude<NewsSource, "pdrtest">,
  limit: number,
): Promise<FeedEntry[]> {
  const response = await fetch(feedUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch RSS feed ${feedUrl}: ${response.status}`);
  }

  const xml = await response.text();
  return extractRssEntries(xml, baseUrl, source, limit);
}

async function fetchRssNewsCandidate(entry: FeedEntry, config: RssSourceConfig): Promise<NewsCandidate | undefined> {
  const response = await fetch(entry.url);
  if (!response.ok) {
    console.warn(`Failed to fetch ${config.source} article ${entry.url}: ${response.status}`);
    const fallbackExcerpt = entry.content || entry.excerpt;
    return fallbackExcerpt
      ? {
          source: config.source,
          title: entry.title,
          excerpt: truncate(fallbackExcerpt, 4000),
          url: entry.url,
          publishedAt: entry.publishedAt,
          imageUrl: entry.imageUrl,
        }
      : undefined;
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const title = normalizeWhitespace($("h1").first().text()) || entry.title;
  const excerpt = extractExcerpt($, config.skipPrefixes ?? []);
  const publishedAt = normalizeWhitespace($("time").first().text()) || entry.publishedAt;
  const imageUrl = extractImageUrl($, entry.url, config.baseUrl) ?? entry.imageUrl;
  const fallbackExcerpt = entry.content || entry.excerpt;

  if (!title || !(excerpt || fallbackExcerpt)) {
    return undefined;
  }

  return {
    source: config.source,
    title,
    excerpt: excerpt || truncate(fallbackExcerpt ?? "", 4000),
    url: entry.url,
    publishedAt,
    imageUrl,
  };
}

async function fetchRssSourceNews(config: RssSourceConfig, limit: number): Promise<NewsCandidate[]> {
  const entries = await fetchFeedEntries(config.feedUrl, config.baseUrl, config.source, limit * 2);
  const items: NewsCandidate[] = [];

  for (const entry of entries) {
    const item = await fetchRssNewsCandidate(entry, config);
    if (!item) continue;
    items.push(item);
    if (items.length >= limit) break;
  }

  return items;
}

export async function fetchLatestPdrNews(limit: number): Promise<NewsCandidate[]> {
  const response = await fetch(PDR_NEWS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch news listing: ${response.status}`);
  }

  const html = await response.text();
  const urls = extractArticleUrls(html, limit * 3);
  const pdrItems: NewsCandidate[] = [];

  for (const url of urls) {
    const item = await fetchNewsCandidate(url);
    if (!item) continue;
    pdrItems.push(item);
    if (pdrItems.length >= limit) break;
  }

  const rssSourceConfigs: RssSourceConfig[] = [
    {
      source: "hsc",
      feedUrl: HSC_FEED_URL,
      baseUrl: HSC_BASE_URL,
      skipPrefixes: ["Читайте також", "За матеріалами", "Детальніше"],
    },
    {
      source: "mmr",
      feedUrl: MMR_FEED_URL,
      baseUrl: MMR_BASE_URL,
      skipPrefixes: ["Читайте також", "За темою", "Джерело матеріалу"],
    },
    {
      source: "autogeek",
      feedUrl: AUTOGEEK_FEED_URL,
      baseUrl: AUTOGEEK_BASE_URL,
      skipPrefixes: ["Нагадаємо", "Читайте також", "Детальніше"],
    },
  ];

  const rssGroups = await Promise.all(
    rssSourceConfigs.map(async (config) => {
      try {
        return await fetchRssSourceNews(config, limit);
      } catch (error) {
        console.warn(`Failed to fetch source ${config.source}:`, error);
        return [] as NewsCandidate[];
      }
    }),
  );

  return sortByPublishedAt([
    ...pdrItems,
    ...rssGroups.flat(),
  ]).slice(0, limit);
}

export function formatNewsDraftPreview(title: string, excerpt: string, publishedAt: string, url: string): string {
  return [
    `📰 ${title}`,
    "",
    excerpt,
    "",
    `Дата: ${publishedAt}`,
    `Джерело: ${url}`,
  ].join("\n");
}