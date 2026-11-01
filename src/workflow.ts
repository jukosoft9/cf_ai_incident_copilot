// The investigation pipeline: triage -> diagnose -> human approval -> postmortem.
// Each completed step.do() is saved by the platform, so a restart resumes where it
// left off instead of paying for the LLM calls again.
import { createAI } from "agents/models/ai-sdk";
import {
  AgentWorkflow,
  WorkflowRejectedError,
  type AgentWorkflowEvent,
  type AgentWorkflowStep,
  type DefaultProgress,
} from "agents/workflows";
import { generateText } from "ai";
import type { z } from "zod";
import { MODEL, type IncidentAgent } from "./agent";
import { DiagnosisSchema, parseModelJson, TriageSchema } from "./analysis";
import {
  DIAGNOSIS_SYSTEM,
  diagnosisPrompt,
  POSTMORTEM_SYSTEM,
  postmortemPrompt,
  TRIAGE_SYSTEM,
  triagePrompt,
} from "./prompts";

/**
 * The evidence is copied in when the Workflow starts, so every step and retry
 * sees the same input even if the chat carries on in the meantime.
 */
export type InvestigationParams = { evidence: string };

// These retries cover both model errors and invalid JSON. Retrying is safe here
// because these steps only read and generate text. They change nothing elsewhere.
const LLM_STEP = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

export class InvestigationWorkflow extends AgentWorkflow<
  IncidentAgent,
  InvestigationParams,
  DefaultProgress,
  Env
> {
  async run(
    event: AgentWorkflowEvent<InvestigationParams>,
    step: AgentWorkflowStep,
  ) {
    const { evidence } = event.payload;
    const id = this.workflowId;

    const triage = await step.do("triage", LLM_STEP, () =>
      this.generateJson(TRIAGE_SYSTEM, triagePrompt(evidence), TriageSchema),
    );
    await step.do("record-triage", () =>
      this.agent.recordStep(
        id,
        "triage",
        { phase: "diagnosis", triage },
        `Triaged as ${triage.severity}: ${triage.title}`,
      ),
    );

    const diagnosis = await step.do("diagnose", LLM_STEP, () =>
      this.generateJson(
        DIAGNOSIS_SYSTEM,
        diagnosisPrompt(evidence, triage),
        DiagnosisSchema,
      ),
    );
    await step.do("record-diagnosis", () =>
      this.agent.recordStep(
        id,
        "diagnosis",
        { phase: "awaiting_approval", diagnosis },
        `Proposed remediation: ${diagnosis.remediation.summary}`,
      ),
    );

    // The Workflow hibernates here and uses no compute until a human decides.
    // The only way to resume it is IncidentAgent's approve and reject methods.
    let approval: { note?: string } | undefined;
    try {
      approval = await this.waitForApproval<{ note?: string }>(step, {
        timeout: this.env.APPROVAL_TIMEOUT as WorkflowSleepDuration,
      });
    } catch (error) {
      if (error instanceof WorkflowRejectedError) {
        // The Agent already recorded the rejection. There is nothing left to do.
        return { outcome: "rejected" };
      }
      // waitForEvent throws when its timeout expires.
      await step.do("record-timeout", () =>
        this.agent.recordStep(
          id,
          "timed-out",
          { phase: "timed_out" },
          "No decision before the approval timeout",
        ),
      );
      return { outcome: "timed_out" };
    }

    const postmortem = await step.do("postmortem", LLM_STEP, () =>
      this.generateText(
        POSTMORTEM_SYSTEM,
        postmortemPrompt(evidence, triage, diagnosis, approval?.note),
      ),
    );
    await step.do("record-postmortem", () =>
      this.agent.recordStep(
        id,
        "postmortem",
        { phase: "resolved", postmortem },
        "Postmortem drafted",
      ),
    );

    await step.reportComplete({ outcome: "resolved" });
    return { outcome: "resolved" };
  }

  private async generateText(system: string, prompt: string): Promise<string> {
    const ai = createAI({ binding: this.env.AI });
    const { text } = await generateText({
      model: ai(MODEL),
      system,
      prompt,
      maxOutputTokens: 1500,
    });
    return text;
  }

  private async generateJson<T>(
    system: string,
    prompt: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return parseModelJson(await this.generateText(system, prompt), schema);
  }
}
