import * as cheerio from "cheerio";

const PDR_NEWS_URL = "https://pdrtest.com/news";
const PDR_BASE_URL = "https://pdrtest.com";
const HSC_FEED_URL = "https://hsc.gov.ua/feed/";
const HSC_BASE_URL = "https://hsc.gov.ua";
const MMR_FEED_URL = "https://mmr.net.ua/feed";
const MMR_BASE_URL = "https://mmr.net.ua";
const AUTOGEEK_FEED_URL = "https://autogeek.com.ua/feed/";
const AUTOGEEK_BASE_URL = "https://autogeek.com.ua";

type NewsSource = "pdrtest" | "hsc" | "mmr" | "autogeek";

interface RssSourceConfig {
  source: Exclude<NewsSource, "pdrtest">;
  feedUrl: string;
  baseUrl: string;
  skipPrefixes?: string[];
}

export interface NewsCandidate {
  source: NewsSource;
  title: string;
  excerpt: string;
  url: string;
  publishedAt: string;
  imageUrl?: string;
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
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortByPublishedAt(items: NewsCandidate[]): NewsCandidate[] {
  return [...items].sort((left, right) => parseDateValue(right.publishedAt) - parseDateValue(left.publishedAt));
}

function interleaveNewsSources(groups: NewsCandidate[][], limit: number): NewsCandidate[] {
  const queues = groups.map((group) => [...group]);
  const merged: NewsCandidate[] = [];

  while (merged.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const item = queue.shift();
      if (!item) continue;
      merged.push(item);
      if (merged.length >= limit) break;
    }
  }

  return merged;
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
    return new URL(candidate, baseUrl).toString();
  }

  return resolveNewsImageUrl(articleUrl);
}

async function fetchNewsCandidate(url: string): Promise<NewsCandidate | undefined> {
  const response = await fetch(url);
  if (!response.ok) {
    console.warn(`Failed to fetch news article ${url}: ${response.status}`);
    return undefined;
  }

  const html = await response.text();
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

  return interleaveNewsSources([
    sortByPublishedAt(pdrItems),
    ...rssGroups.map((group) => sortByPublishedAt(group)),
  ], limit);
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