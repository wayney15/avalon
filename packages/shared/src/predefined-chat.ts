export function normalizePredefinedSentences(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}
