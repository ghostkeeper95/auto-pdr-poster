import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.STATE_DIR ?? resolve(__dirname, "..");
const STATE_PATH = resolve(STATE_DIR, "state.json");

interface State {
  postedIds: string[];
  lastSection: number;
  lastQuestionIndex: number;
}

function loadState(): State {
  if (!existsSync(STATE_PATH)) {
    return { postedIds: [], lastSection: 1, lastQuestionIndex: 0 };
  }

  const raw = readFileSync(STATE_PATH, "utf-8");
  return JSON.parse(raw) as State;
}

function saveState(state: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export function isPosted(questionId: string): boolean {
  const state = loadState();
  return state.postedIds.includes(questionId);
}

export function markPosted(questionId: string): void {
  const state = loadState();
  if (!state.postedIds.includes(questionId)) {
    state.postedIds.push(questionId);
  }
  saveState(state);
}

export function getProgress(): { lastSection: number; lastQuestionIndex: number } {
  const state = loadState();
  return {
    lastSection: state.lastSection,
    lastQuestionIndex: state.lastQuestionIndex,
  };
}

export function saveProgress(section: number, questionIndex: number): void {
  const state = loadState();
  state.lastSection = section;
  state.lastQuestionIndex = questionIndex;
  saveState(state);
}

export function getPostedCount(): number {
  const state = loadState();
  return state.postedIds.length;
}
