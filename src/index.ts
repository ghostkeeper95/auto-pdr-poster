import "dotenv/config";
import { fetchSectionQuestions, fetchQuestionExplanation } from "./scraper.js";
import { sendQuizToTelegram, sendExplanationComment, getLinkedChatId, drainPendingUpdates, waitForAutoForward } from "./telegram.js";
import { isPosted, markPosted, getPostedCount } from "./state.js";
import { summarizeExplanation } from "./ai.js";

const TOTAL_SECTIONS = 71;
const QUESTIONS_PER_RUN = 5;
const DELAY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PostResult {
  posted: number;
  updateOffset: number;
}

export async function postQuestions(count: number, externalOffset?: number): Promise<PostResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const aiApiKey = process.env.GEMINI_API_KEY;

  if (!botToken || !chatId) {
    throw new Error(
      "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment variables",
    );
  }

  console.log(`Total posted so far: ${getPostedCount()}`);

  const discussionChatId = await getLinkedChatId(botToken, chatId);
  if (discussionChatId) {
    console.log(`Discussion group found: ${discussionChatId}`);
  } else {
    console.warn("No linked discussion group found — explanations will be skipped");
  }

  let updateOffset = externalOffset ?? (discussionChatId
    ? await drainPendingUpdates(botToken)
    : 0);

  let posted = 0;
  const exhaustedSections = new Set<number>();

  while (posted < count) {
    const availableSections: number[] = [];
    for (let i = 1; i <= TOTAL_SECTIONS; i++) {
      if (!exhaustedSections.has(i)) availableSections.push(i);
    }

    if (availableSections.length === 0) {
      console.log("All questions have been posted!");
      break;
    }

    const sectionId =
      availableSections[Math.floor(Math.random() * availableSections.length)];
    console.log(`Fetching section ${sectionId}...`);
    const questions = await fetchSectionQuestions(sectionId);
    const unposted = questions.filter((q) => !isPosted(q.id));

    if (unposted.length === 0) {
      exhaustedSections.add(sectionId);
      continue;
    }

    const question = unposted[Math.floor(Math.random() * unposted.length)];
    console.log(`Posting question ${question.id}...`);

    try {
      const pollMessageId = await sendQuizToTelegram(botToken, chatId, question);
      markPosted(question.id);
      posted++;
      console.log(`Posted ${question.id} (${posted}/${count})`);

      if (pollMessageId && discussionChatId) {
        const autoForward = await waitForAutoForward(
          botToken,
          pollMessageId,
          updateOffset,
        );

        if (autoForward) {
          updateOffset = autoForward.nextOffset;
          const explanation = await fetchQuestionExplanation(question.id);

          if (explanation) {
            let explanationText = explanation;
            if (aiApiKey) {
              explanationText = await summarizeExplanation(
                aiApiKey,
                explanationText,
              );
            }
            await sendExplanationComment(
              botToken,
              autoForward.chatId,
              autoForward.messageId,
              explanationText,
            );
            console.log(`Sent explanation for ${question.id}`);
          }
        } else {
          console.warn(`Could not find auto-forwarded message for ${question.id}`);
        }
      }
    } catch (err) {
      console.error(`Failed to post ${question.id}:`, err);
    }

    if (posted < count) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`Done! Posted ${posted} questions this run.`);
  return { posted, updateOffset };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = Number(process.env.QUESTIONS_PER_RUN ?? QUESTIONS_PER_RUN);
  postQuestions(count).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
