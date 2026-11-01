import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  evidenceFromMessages,
  parseModelJson,
  recentWithinBudget,
  TriageSchema,
} from "../src/analysis";

const triage = {
  title: "Connection exhaustion",
  engine: "PostgreSQL 15",
  severity: "SEV2",
  summary: "Clients can't connect.",
  impact: "Checkout is failing.",
  missingEvidence: [],
};

function message(role: UIMessage["role"], text: string): UIMessage {
  return { id: crypto.randomUUID(), role, parts: [{ type: "text", text }] };
}

describe("parseModelJson", () => {
  it("parses plain JSON", () => {
    expect(parseModelJson(JSON.stringify(triage), TriageSchema)).toEqual(triage);
  });

  it("ignores code fences and surrounding prose", () => {
    const text = `Here you go:\n\`\`\`json\n${JSON.stringify(triage)}\n\`\`\`\nDone.`;
    expect(parseModelJson(text, TriageSchema)).toEqual(triage);
  });

  it("throws when there is no JSON, so the Workflow step retries", () => {
    expect(() => parseModelJson("I can't help", TriageSchema)).toThrow();
  });

  it("throws when a field breaks the schema", () => {
    const bad = JSON.stringify({ ...triage, severity: "CRITICAL" });
    expect(() => parseModelJson(bad, TriageSchema)).toThrow();
  });
});

describe("evidenceFromMessages", () => {
  it("uses only what the user wrote", () => {
    const evidence = evidenceFromMessages(
      [message("user", "real log"), message("assistant", "my guess")],
      100,
    );
    expect(evidence).toBe("real log");
  });

  it("keeps the newest characters when over the limit", () => {
    const evidence = evidenceFromMessages(
      [message("user", "old"), message("user", "newest")],
      6,
    );
    expect(evidence).toBe("newest");
  });
});

describe("recentWithinBudget", () => {
  it("drops the oldest messages first and keeps order", () => {
    const messages = [
      message("user", "aaaa"),
      message("assistant", "bbbb"),
      message("user", "cccc"),
    ];
    expect(recentWithinBudget(messages, 8)).toEqual(messages.slice(1));
  });

  it("cuts down an oversized newest message instead of dropping it", () => {
    const [kept] = recentWithinBudget([message("user", "abcdefgh")], 3);
    expect(kept.parts).toEqual([{ type: "text", text: "fgh" }]);
  });
});
