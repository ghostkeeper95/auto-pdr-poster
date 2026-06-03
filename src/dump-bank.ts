import "dotenv/config";
import { setBankedSection, setBankedExplanation, setBankedSignTheory, getBankStats } from "./bank.js";
import { parseQuestionsHtml, parseExplanationHtml, parseRoadSignTheoryHtml } from "./scraper.js";

const TOTAL_SECTIONS = 71;
const BASE_URL = "https://pdrtest.com";
const ROAD_SIGN_THEORY_SECTIONS = ["33.1", "33.2", "33.3", "33.4", "33.5", "33.6", "33.7"] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TRANSIENT_ERROR_PATTERNS = [
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NETWORK_CHANGED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_TIMED_OUT",
  "ERR_EMPTY_RESPONSE",
  "ERR_SOCKET_NOT_CONNECTED",
  "ERR_HTTP2_PROTOCOL_ERROR",
  "Timeout",
  "Target closed",
  "Navigation failed",
];

function isTransientError(error: unknown): boolean {
  const message = (error as Error)?.message ?? "";
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

async function gotoWithRetry(
  page: any,
  url: string,
  attempts = 4,
): Promise<any> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientError(error)) throw error;
      const backoff = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      console.warn(
        `  goto ${url} failed (attempt ${attempt}/${attempts}): ${(error as Error).message}. Retrying in ${backoff}ms...`,
      );
      await sleep(backoff);
    }
  }
  throw lastError;
}

interface CliOptions {
  withExplanations: boolean;
  withSignTheory: boolean;
  questionsOnly: boolean;
  signTheoryOnly: boolean;
  sections?: number[];
  headed: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    withExplanations: true,
    withSignTheory: true,
    questionsOnly: false,
    signTheoryOnly: false,
    headed: false,
  };
  for (const arg of argv) {
    if (arg === "--no-explanations") options.withExplanations = false;
    else if (arg === "--no-sign-theory") options.withSignTheory = false;
    else if (arg === "--questions-only") options.questionsOnly = true;
    else if (arg === "--sign-theory-only") options.signTheoryOnly = true;
    else if (arg === "--headed") options.headed = true;
    else if (arg.startsWith("--sections=")) {
      options.sections = arg
        .slice("--sections=".length)
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let playwright: { chromium: { launch: (opts: { headless: boolean }) => Promise<any> } };
  try {
    const modulePath = "playwright";
    playwright = await import(modulePath);
  } catch {
    console.error(
      "Playwright is not installed. Run:\n  npm i -D playwright\n  npx playwright install chromium",
    );
    process.exit(1);
  }

  const browser = await playwright.chromium.launch({ headless: !options.headed });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    locale: "uk-UA",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // Warm-up: відвідати головну, щоб реальний браузер виконав Vercel challenge і отримав cookie.
  console.log("Warming up...");
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(5_000);

  const sectionIds = options.sections ?? Array.from({ length: TOTAL_SECTIONS }, (_, i) => i + 1);

  const shouldDumpQuestions = !options.signTheoryOnly;
  const shouldDumpSignTheory = !options.questionsOnly && options.withSignTheory;

  if (shouldDumpQuestions) {
    for (const sectionId of sectionIds) {
    const url = `${BASE_URL}/questions/${sectionId}`;
    try {
      const response = await gotoWithRetry(page, url);
      if (!response || !response.ok()) {
        console.warn(`Section ${sectionId}: HTTP ${response?.status() ?? "no-response"}, skipping`);
        continue;
      }

      const html = await page.content();
      const questions = parseQuestionsHtml(html, sectionId);
      if (questions.length === 0) {
        console.warn(`Section ${sectionId}: parsed 0 questions, skipping`);
        continue;
      }

      setBankedSection(sectionId, questions);
      console.log(`Section ${sectionId}: saved ${questions.length} questions`);

      if (options.withExplanations) {
        for (const question of questions) {
          const qUrl = `${BASE_URL}/question/${question.id}`;
          try {
            const qResponse = await gotoWithRetry(page, qUrl);
            if (!qResponse || !qResponse.ok()) continue;
            const qHtml = await page.content();
            const explanation = parseExplanationHtml(qHtml, question.id);
            if (explanation) setBankedExplanation(question.id, explanation);
          } catch (error) {
            console.warn(`  Q ${question.id}: ${(error as Error).message}`);
          }
          await sleep(400);
        }
      }
    } catch (error) {
      console.warn(`Section ${sectionId}: ${(error as Error).message}`);
    }
    await sleep(800);
    }
  }

  if (shouldDumpSignTheory) {
    for (const theorySection of ROAD_SIGN_THEORY_SECTIONS) {
      const url = `${BASE_URL}/driver/rules/section/${theorySection}`;
      try {
        const response = await gotoWithRetry(page, url);
        if (!response || !response.ok()) {
          console.warn(`Sign theory ${theorySection}: HTTP ${response?.status() ?? "no-response"}, skipping`);
          continue;
        }
        const html = await page.content();
        const items = parseRoadSignTheoryHtml(html, theorySection);
        if (items.length === 0) {
          console.warn(`Sign theory ${theorySection}: parsed 0 items, skipping`);
          continue;
        }
        setBankedSignTheory(theorySection, items);
        console.log(`Sign theory ${theorySection}: saved ${items.length} items`);
      } catch (error) {
        console.warn(`Sign theory ${theorySection}: ${(error as Error).message}`);
      }
      await sleep(800);
    }
  }

  await browser.close();
  const stats = getBankStats();
  console.log(
    `Done. Bank now has ${stats.questions} questions across ${stats.sections} sections, ${stats.explanations} explanations, ${stats.signTheoryItems} sign theory items across ${stats.signTheorySections} sign sections. File: ${stats.path}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
