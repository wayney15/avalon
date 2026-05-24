import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizePredefinedSentences } from "../../../packages/shared/src/predefined-chat";
import { PREDEFINED_CHAT_SENTENCES } from "./predefined-chat";

describe("PREDEFINED_CHAT_SENTENCES", () => {
  it("stays synchronized with the web sentence asset", () => {
    const sentenceFilePath = path.resolve(process.cwd(), "apps/web/asset/sentence.txt");
    const sentenceFileContents = readFileSync(sentenceFilePath, "utf8");

    expect(PREDEFINED_CHAT_SENTENCES).toEqual(
      normalizePredefinedSentences(sentenceFileContents)
    );
  });
});
