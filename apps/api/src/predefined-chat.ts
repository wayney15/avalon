import { normalizePredefinedSentences } from "../../../packages/shared/src/predefined-chat";

// Keep this source synchronized with apps/web/asset/sentence.txt.
const PREDEFINED_CHAT_SENTENCES_TEXT = `
我真没招了
66666
真聪明啊你
清醒一点啊，我求你了
`;

export const PREDEFINED_CHAT_SENTENCES = normalizePredefinedSentences(
  PREDEFINED_CHAT_SENTENCES_TEXT
);

export function isPredefinedChatSentence(sentence: string): boolean {
  return PREDEFINED_CHAT_SENTENCES.includes(sentence.trim());
}
