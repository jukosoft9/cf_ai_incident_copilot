// Pure logic with no Cloudflare dependencies, so it can be unit tested directly.
import type { UIMessage } from "ai";
import { z } from "zod";

export const TriageSchema = z.object({
  title: z.string().min(1),
  engine: z.string().min(1),
  severity: z.enum(["SEV1", "SEV2", "SEV3", "SEV4"]),
  summary: z.string().min(1),
  impact: z.string().min(1),
  missingEvidence: z.array(z.string()),
});
export type Triage = z.infer<typeof TriageSchema>;

export const DiagnosisSchema = z.object({
  hypotheses: z
    .array(
      z.object({
        cause: z.string().min(1),
        confidence: z.enum(["low", "medium", "high"]),
        supportingEvidence: z.string().min(1),
        verifyWith: z.string().min(1),
      }),
    )
    .min(1)
    .max(3),
  remediation: z.object({
    summary: z.string().min(1),
    commands: z.array(z.string()),
    risk: z.string().min(1),
    rollback: z.string().min(1),
  }),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

/**
 * Parses model output into a validated object. Llama can wrap JSON in prose or
 * code fences, so take the outermost braces. Anything still invalid throws, and
 * because this runs inside step.do(), the Workflow retries the model call.
 */
export function parseModelJson<T>(text: string, schema: z.ZodType<T>): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Model response contained no JSON object");
  }
  return schema.parse(JSON.parse(text.slice(start, end + 1)));
}

function messageText(message: UIMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * Builds the evidence for an investigation from what the user wrote, newest
 * first, keeping the newest characters. Assistant replies are left out so the
 * model's earlier guesses can't come back as if they were facts.
 */
export function evidenceFromMessages(
  messages: UIMessage[],
  maxChars: number,
): string {
  const text = messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .join("\n\n");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

/**
 * Keeps the newest messages that fit in a character budget. Llama 3.3 on Workers
 * AI has a 24,000-token context window, and one pasted log could exceed it. If
 * the newest message alone is too long, it is cut down rather than dropped.
 */
export function recentWithinBudget(
  messages: UIMessage[],
  maxChars: number,
): UIMessage[] {
  const kept: UIMessage[] = [];
  let remaining = maxChars;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const length = messageText(message).length;

    if (length <= remaining) {
      kept.unshift(message);
      remaining -= length;
    } else {
      if (kept.length === 0) {
        const text = messageText(message).slice(-maxChars);
        kept.unshift({ ...message, parts: [{ type: "text", text }] });
      }
      break;
    }
  }
  return kept;
}
