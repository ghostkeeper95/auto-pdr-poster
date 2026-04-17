import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.STATE_DIR ?? resolve(__dirname, "..");
const STATE_PATH = resolve(STATE_DIR, "state.json");

export interface NewsDraft {
  id: number;
  source: string;
  title: string;
  excerpt: string;
  url: string;
  publishedAt: string;
  imageUrl?: string;
  renderedBody?: string;
  stockImageUrl?: string;
  createdAt: string;
  status: "draft" | "posted" | "rejected";
}

interface State {
  postedIds: string[];
  lastSection: number;
  lastQuestionIndex: number;
  newsDrafts: NewsDraft[];
}

function loadState(): State {
  if (!existsSync(STATE_PATH)) {
    return { postedIds: [], lastSection: 1, lastQuestionIndex: 0, newsDrafts: [] };
  }

  const raw = readFileSync(STATE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as Partial<State>;

  return {
    postedIds: parsed.postedIds ?? [],
    lastSection: parsed.lastSection ?? 1,
    lastQuestionIndex: parsed.lastQuestionIndex ?? 0,
    newsDrafts: parsed.newsDrafts ?? [],
  };
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

export function saveNewsDrafts(
  drafts: Array<Omit<NewsDraft, "id" | "createdAt" | "status">>,
): NewsDraft[] {
  const state = loadState();
  const existingUrls = new Set(state.newsDrafts.map((draft) => draft.url));
  const nextIdBase = state.newsDrafts.reduce((maxId, draft) => Math.max(maxId, draft.id), 0);

  const created: NewsDraft[] = [];
  for (const draft of drafts) {
    if (existingUrls.has(draft.url)) continue;
    const newsDraft: NewsDraft = {
      id: nextIdBase + created.length + 1,
      createdAt: new Date().toISOString(),
      status: "draft",
      ...draft,
    };
    state.newsDrafts.push(newsDraft);
    existingUrls.add(draft.url);
    created.push(newsDraft);
  }

  saveState(state);
  return created;
}

export function getNewsDrafts(status: NewsDraft["status"] = "draft"): NewsDraft[] {
  const state = loadState();
  return state.newsDrafts.filter((draft) => draft.status === status);
}

export function getNewsDraftById(id: number): NewsDraft | undefined {
  const state = loadState();
  return state.newsDrafts.find((draft) => draft.id === id);
}

export function updateNewsDraftStatus(id: number, status: NewsDraft["status"]): NewsDraft | undefined {
  const state = loadState();
  const draft = state.newsDrafts.find((item) => item.id === id);
  if (!draft) return undefined;
  draft.status = status;
  saveState(state);
  return draft;
}

export function updateNewsDraft(id: number, updates: Partial<Pick<NewsDraft, "renderedBody" | "stockImageUrl">>): void {
  const state = loadState();
  const draft = state.newsDrafts.find((item) => item.id === id);
  if (!draft) return;
  Object.assign(draft, updates);
  saveState(state);
}
