import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Question } from "./scraper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Bank is bundled with the app (static data). Allow override via PDR_BANK_PATH for the
// dump-bank script, but in production we always read it from the app directory so the
// bot doesn't depend on the (empty) persistent volume.
const APP_BANK_PATH = resolve(__dirname, "..", "pdr-bank.json");
const BANK_PATH = process.env.PDR_BANK_PATH ?? APP_BANK_PATH;
const BANK_DIR = dirname(BANK_PATH);

interface BankFile {
  sections: Record<string, Question[]>;
  explanations: Record<string, string>;
  updatedAt?: string;
}

let cache: BankFile | undefined;

function loadBank(): BankFile {
  if (cache) return cache;
  if (!existsSync(BANK_PATH)) {
    cache = { sections: {}, explanations: {} };
    return cache;
  }

  try {
    const raw = readFileSync(BANK_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BankFile>;
    cache = {
      sections: parsed.sections ?? {},
      explanations: parsed.explanations ?? {},
      updatedAt: parsed.updatedAt,
    };
  } catch (error) {
    console.warn(`Failed to read PDR bank at ${BANK_PATH}:`, (error as Error).message);
    cache = { sections: {}, explanations: {} };
  }

  return cache;
}

function persist(): void {
  if (!cache) return;
  cache.updatedAt = new Date().toISOString();
  if (!existsSync(BANK_DIR)) mkdirSync(BANK_DIR, { recursive: true });
  writeFileSync(BANK_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

export function getBankedSection(sectionId: number): Question[] | undefined {
  const bank = loadBank();
  const stored = bank.sections[String(sectionId)];
  return stored && stored.length > 0 ? stored : undefined;
}

export function setBankedSection(sectionId: number, questions: Question[]): void {
  if (questions.length === 0) return;
  const bank = loadBank();
  bank.sections[String(sectionId)] = questions;
  persist();
}

export function getBankedExplanation(questionId: string): string | undefined {
  const bank = loadBank();
  return bank.explanations[questionId];
}

export function setBankedExplanation(questionId: string, explanation: string): void {
  if (!explanation) return;
  const bank = loadBank();
  bank.explanations[questionId] = explanation;
  persist();
}

export function getBankStats(): { sections: number; questions: number; explanations: number; path: string } {
  const bank = loadBank();
  const sectionIds = Object.keys(bank.sections);
  const questions = sectionIds.reduce((sum, id) => sum + bank.sections[id]!.length, 0);
  return {
    sections: sectionIds.length,
    questions,
    explanations: Object.keys(bank.explanations).length,
    path: BANK_PATH,
  };
}
