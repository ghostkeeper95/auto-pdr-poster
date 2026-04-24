import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Question } from "./scraper.js";

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
  promoHtml?: string;
  promoText?: string;
  promoEntities?: Array<{
    type: string;
    offset: number;
    length: number;
    url?: string;
    language?: string;
    custom_emoji_id?: string;
    user?: { id: number };
  }>;
  showSource?: boolean;
  createdAt: string;
  status: "draft" | "posted" | "rejected";
}

export interface PendingNewsHeadline {
  id: number;
  source: string;
  title: string;
  url: string;
  publishedAt: string;
  createdAt: string;
}

export interface TestDraft {
  id: number;
  question: Question;
  explanation?: string;
  promoHtml?: string;
  promoText?: string;
  promoEntities?: Array<{
    type: string;
    offset: number;
    length: number;
    url?: string;
    language?: string;
    custom_emoji_id?: string;
    user?: { id: number };
  }>;
  createdAt: string;
  status: "draft" | "posted" | "rejected";
}

export interface ForwardDraft {
  id: number;
  sourceChatId: number;
  sourceMessageId: number;
  createdAt: string;
  status: "draft" | "posted" | "rejected";
}

export interface ScheduledPost {
  id: number;
  kind: "news" | "test" | "forward";
  targetId: number;
  runAt: string;
  createdAt: string;
  status: "pending" | "sent" | "failed" | "cancelled";
  lastError?: string;
}

export interface AdminSession {
  userId: number;
  mode:
    | "edit_news_title"
    | "edit_news_body"
    | "edit_news_promo"
    | "edit_test_promo"
    | "edit_promo_template"
    | "schedule_news"
    | "schedule_test"
    | "schedule_forward";
  targetId: number;
  createdAt: string;
}

export interface PromoTemplate {
  slot: 1 | 2 | 3;
  label: string;
  html: string;
  text?: string;
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
    url?: string;
    language?: string;
    custom_emoji_id?: string;
    user?: { id: number };
  }>;
  updatedAt: string;
}

interface State {
  postedIds: string[];
  lastSection: number;
  lastQuestionIndex: number;
  newsDrafts: NewsDraft[];
  pendingNewsHeadlines: PendingNewsHeadline[];
  nextPendingNewsId: number;
  testDrafts: TestDraft[];
  nextTestDraftId: number;
  forwardDrafts: ForwardDraft[];
  nextForwardDraftId: number;
  scheduledPosts: ScheduledPost[];
  nextScheduledPostId: number;
  adminSessions: Record<string, AdminSession>;
  promoTemplates: PromoTemplate[];
}

function loadState(): State {
  if (!existsSync(STATE_PATH)) {
    return {
      postedIds: [],
      lastSection: 1,
      lastQuestionIndex: 0,
      newsDrafts: [],
      pendingNewsHeadlines: [],
      nextPendingNewsId: 1,
      testDrafts: [],
      nextTestDraftId: 1,
      forwardDrafts: [],
      nextForwardDraftId: 1,
      scheduledPosts: [],
      nextScheduledPostId: 1,
      adminSessions: {},
      promoTemplates: [],
    };
  }

  const raw = readFileSync(STATE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as Partial<State>;

  return {
    postedIds: parsed.postedIds ?? [],
    lastSection: parsed.lastSection ?? 1,
    lastQuestionIndex: parsed.lastQuestionIndex ?? 0,
    newsDrafts: parsed.newsDrafts ?? [],
    pendingNewsHeadlines: parsed.pendingNewsHeadlines ?? [],
    nextPendingNewsId: parsed.nextPendingNewsId ?? 1,
    testDrafts: parsed.testDrafts ?? [],
    nextTestDraftId: parsed.nextTestDraftId ?? 1,
    forwardDrafts: parsed.forwardDrafts ?? [],
    nextForwardDraftId: parsed.nextForwardDraftId ?? 1,
    scheduledPosts: parsed.scheduledPosts ?? [],
    nextScheduledPostId: parsed.nextScheduledPostId ?? 1,
    adminSessions: parsed.adminSessions ?? {},
    promoTemplates: parsed.promoTemplates ?? [],
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

export function getAllNewsDrafts(): NewsDraft[] {
  const state = loadState();
  return state.newsDrafts;
}

export function getNewsDraftById(id: number): NewsDraft | undefined {
  const state = loadState();
  return state.newsDrafts.find((draft) => draft.id === id);
}

export function getNewsDraftByUrl(url: string): NewsDraft | undefined {
  const state = loadState();
  return state.newsDrafts.find((draft) => draft.url === url);
}

export function updateNewsDraftStatus(id: number, status: NewsDraft["status"]): NewsDraft | undefined {
  const state = loadState();
  const draft = state.newsDrafts.find((item) => item.id === id);
  if (!draft) return undefined;
  draft.status = status;
  saveState(state);
  return draft;
}

export function updateNewsDraft(
  id: number,
  updates: Partial<Pick<NewsDraft, "title" | "excerpt" | "imageUrl" | "renderedBody" | "stockImageUrl" | "promoHtml" | "promoText" | "promoEntities" | "showSource">>,
): void {
  const state = loadState();
  const draft = state.newsDrafts.find((item) => item.id === id);
  if (!draft) return;
  Object.assign(draft, updates);
  saveState(state);
}

export function refreshNewsDraft(
  id: number,
  updates: Partial<Pick<NewsDraft, "title" | "excerpt" | "publishedAt" | "imageUrl" | "renderedBody" | "stockImageUrl">>,
): NewsDraft | undefined {
  const state = loadState();
  const draft = state.newsDrafts.find((item) => item.id === id);
  if (!draft) return undefined;

  if (Object.prototype.hasOwnProperty.call(updates, "title") && updates.title !== undefined) {
    draft.title = updates.title;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "excerpt") && updates.excerpt !== undefined) {
    draft.excerpt = updates.excerpt;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "publishedAt") && updates.publishedAt !== undefined) {
    draft.publishedAt = updates.publishedAt;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "imageUrl")) {
    draft.imageUrl = updates.imageUrl;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "renderedBody")) {
    draft.renderedBody = updates.renderedBody;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "stockImageUrl")) {
    draft.stockImageUrl = updates.stockImageUrl;
  }

  saveState(state);
  return draft;
}

export function replacePendingNewsHeadlines(
  headlines: Array<Omit<PendingNewsHeadline, "id" | "createdAt">>,
): PendingNewsHeadline[] {
  const state = loadState();
  const createdAt = new Date().toISOString();
  const created = headlines.map((headline, index) => ({
    ...headline,
    id: state.nextPendingNewsId + index,
    createdAt,
  }));

  state.pendingNewsHeadlines = created;
  state.nextPendingNewsId += created.length;
  saveState(state);
  return created;
}

export function getPendingNewsHeadlines(): PendingNewsHeadline[] {
  const state = loadState();
  return state.pendingNewsHeadlines;
}

export function getPendingNewsHeadlineById(id: number): PendingNewsHeadline | undefined {
  const state = loadState();
  return state.pendingNewsHeadlines.find((headline) => headline.id === id);
}

export function removePendingNewsHeadline(id: number): PendingNewsHeadline | undefined {
  const state = loadState();
  const index = state.pendingNewsHeadlines.findIndex((headline) => headline.id === id);
  if (index === -1) return undefined;
  const [removed] = state.pendingNewsHeadlines.splice(index, 1);
  saveState(state);
  return removed;
}

export function clearNewsDrafts(status: NewsDraft["status"] = "draft"): number {
  const state = loadState();
  const before = state.newsDrafts.length;
  state.newsDrafts = state.newsDrafts.filter((draft) => draft.status !== status);
  const removed = before - state.newsDrafts.length;
  saveState(state);
  return removed;
}

export function clearPendingNewsHeadlines(): number {
  const state = loadState();
  const removed = state.pendingNewsHeadlines.length;
  state.pendingNewsHeadlines = [];
  saveState(state);
  return removed;
}

export function saveTestDraft(question: Question, explanation?: string): TestDraft | undefined {
  const state = loadState();
  const exists = state.testDrafts.find((draft) => draft.question.id === question.id);
  if (exists) return undefined;

  const draft: TestDraft = {
    id: state.nextTestDraftId,
    question,
    explanation,
    createdAt: new Date().toISOString(),
    status: "draft",
  };

  state.testDrafts.push(draft);
  state.nextTestDraftId += 1;
  saveState(state);
  return draft;
}

export function getTestDrafts(status: TestDraft["status"] = "draft"): TestDraft[] {
  const state = loadState();
  return state.testDrafts.filter((draft) => draft.status === status);
}

export function getAllTestDrafts(): TestDraft[] {
  const state = loadState();
  return state.testDrafts;
}

export function getTestDraftById(id: number): TestDraft | undefined {
  const state = loadState();
  return state.testDrafts.find((draft) => draft.id === id);
}

export function updateTestDraft(
  id: number,
  updates: Partial<Pick<TestDraft, "question" | "explanation" | "promoHtml" | "promoText" | "promoEntities">>,
): TestDraft | undefined {
  const state = loadState();
  const draft = state.testDrafts.find((item) => item.id === id);
  if (!draft) return undefined;
  Object.assign(draft, updates);
  saveState(state);
  return draft;
}

export function updateTestDraftStatus(id: number, status: TestDraft["status"]): TestDraft | undefined {
  const state = loadState();
  const draft = state.testDrafts.find((item) => item.id === id);
  if (!draft) return undefined;
  draft.status = status;
  saveState(state);
  return draft;
}

export function clearTestDrafts(status: TestDraft["status"] = "draft"): number {
  const state = loadState();
  const before = state.testDrafts.length;
  state.testDrafts = state.testDrafts.filter((draft) => draft.status !== status);
  const removed = before - state.testDrafts.length;
  saveState(state);
  return removed;
}

export function saveForwardDraft(sourceChatId: number, sourceMessageId: number): ForwardDraft {
  const state = loadState();
  const existing = state.forwardDrafts.find(
    (draft) => draft.sourceChatId === sourceChatId && draft.sourceMessageId === sourceMessageId,
  );
  if (existing) return existing;

  const draft: ForwardDraft = {
    id: state.nextForwardDraftId,
    sourceChatId,
    sourceMessageId,
    createdAt: new Date().toISOString(),
    status: "draft",
  };

  state.forwardDrafts.push(draft);
  state.nextForwardDraftId += 1;
  saveState(state);
  return draft;
}

export function getForwardDrafts(status: ForwardDraft["status"] = "draft"): ForwardDraft[] {
  const state = loadState();
  return state.forwardDrafts.filter((draft) => draft.status === status);
}

export function getForwardDraftById(id: number): ForwardDraft | undefined {
  const state = loadState();
  return state.forwardDrafts.find((draft) => draft.id === id);
}

export function updateForwardDraftStatus(id: number, status: ForwardDraft["status"]): ForwardDraft | undefined {
  const state = loadState();
  const draft = state.forwardDrafts.find((item) => item.id === id);
  if (!draft) return undefined;
  draft.status = status;
  saveState(state);
  return draft;
}

export function clearForwardDrafts(status: ForwardDraft["status"] = "draft"): number {
  const state = loadState();
  const before = state.forwardDrafts.length;
  state.forwardDrafts = state.forwardDrafts.filter((draft) => draft.status !== status);
  const removed = before - state.forwardDrafts.length;
  saveState(state);
  return removed;
}

export function schedulePost(kind: ScheduledPost["kind"], targetId: number, runAt: string): ScheduledPost {
  const state = loadState();
  const scheduled: ScheduledPost = {
    id: state.nextScheduledPostId,
    kind,
    targetId,
    runAt,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  state.scheduledPosts.push(scheduled);
  state.nextScheduledPostId += 1;
  saveState(state);
  return scheduled;
}

export function getScheduledPosts(status?: ScheduledPost["status"]): ScheduledPost[] {
  const state = loadState();
  if (!status) return state.scheduledPosts;
  return state.scheduledPosts.filter((item) => item.status === status);
}

export function getScheduledPostById(id: number): ScheduledPost | undefined {
  const state = loadState();
  return state.scheduledPosts.find((item) => item.id === id);
}

export function updateScheduledPost(
  id: number,
  updates: Partial<Pick<ScheduledPost, "runAt" | "status" | "lastError">>,
): ScheduledPost | undefined {
  const state = loadState();
  const scheduled = state.scheduledPosts.find((item) => item.id === id);
  if (!scheduled) return undefined;
  Object.assign(scheduled, updates);
  saveState(state);
  return scheduled;
}

export function cancelScheduledPost(id: number): ScheduledPost | undefined {
  return updateScheduledPost(id, { status: "cancelled" });
}

export function getAdminSession(userId: number): AdminSession | undefined {
  const state = loadState();
  return state.adminSessions[String(userId)];
}

export function setAdminSession(session: AdminSession): void {
  const state = loadState();
  state.adminSessions[String(session.userId)] = session;
  saveState(state);
}

export function clearAdminSession(userId: number): void {
  const state = loadState();
  delete state.adminSessions[String(userId)];
  saveState(state);
}

export function getPromoTemplates(): PromoTemplate[] {
  return loadState().promoTemplates.slice().sort((a, b) => a.slot - b.slot);
}

export function getPromoTemplate(slot: 1 | 2 | 3): PromoTemplate | undefined {
  return loadState().promoTemplates.find((item) => item.slot === slot);
}

export function savePromoTemplate(
  slot: 1 | 2 | 3,
  label: string,
  html: string,
  options?: { text?: string; entities?: PromoTemplate["entities"] },
): PromoTemplate {
  const state = loadState();
  const existing = state.promoTemplates.find((item) => item.slot === slot);
  const template: PromoTemplate = {
    slot,
    label,
    html,
    text: options?.text,
    entities: options?.entities,
    updatedAt: new Date().toISOString(),
  };
  if (existing) {
    Object.assign(existing, template);
  } else {
    state.promoTemplates.push(template);
  }
  saveState(state);
  return template;
}

export function deletePromoTemplate(slot: 1 | 2 | 3): void {
  const state = loadState();
  state.promoTemplates = state.promoTemplates.filter((item) => item.slot !== slot);
  saveState(state);
}