// One IncidentAgent (a Durable Object) exists per incident. It owns the incident's
// memory, serves the chat, and is the only thing that can change incident state.
import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable, type Connection } from "agents";
import { createAI } from "agents/models/ai-sdk";
import { convertToModelMessages, streamText } from "ai";
import { evidenceFromMessages, recentWithinBudget } from "./analysis";
import { chatSystemPrompt } from "./prompts";
import {
  ACTIVE_PHASES,
  INITIAL_STATE,
  type IncidentState,
  type TimelineEntry,
} from "./shared";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Roughly 4 characters per token, leaving room in the 24,000-token window for
// the system prompt and the response.
const MAX_CHAT_CHARS = 48_000;
const MAX_EVIDENCE_CHARS = 40_000;

export class IncidentAgent extends AIChatAgent<Env, IncidentState> {
  initialState = INITIAL_STATE;

  async onStart() {
    // The timeline has its own table because state is rewritten in full on every
    // change, so it should stay small. The table is append-only.
    this.sql`CREATE TABLE IF NOT EXISTS timeline (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      message TEXT NOT NULL
    )`;
  }

  /** Browsers receive state but can't write it. Only server code changes it. */
  validateStateChange(_next: IncidentState, source: Connection | "server") {
    if (source !== "server") {
      throw new Error("Incident state is read-only for clients");
    }
  }

  async onChatMessage(
    _onFinish: unknown,
    options?: { abortSignal?: AbortSignal },
  ) {
    const ai = createAI({ binding: this.env.AI });
    const result = streamText({
      model: ai(MODEL),
      system: chatSystemPrompt(this.state),
      messages: await convertToModelMessages(
        recentWithinBudget(this.messages, MAX_CHAT_CHARS),
      ),
      maxOutputTokens: 800,
      abortSignal: options?.abortSignal,
    });
    return result.toUIMessageStreamResponse();
  }

  // ---- Called by the browser ------------------------------------------------

  @callable()
  async startInvestigation(): Promise<string> {
    if (ACTIVE_PHASES.includes(this.state.phase)) {
      throw new Error("An investigation is already running");
    }
    const evidence = evidenceFromMessages(this.messages, MAX_EVIDENCE_CHARS);
    if (!evidence.trim()) {
      throw new Error("Describe the incident in the chat first");
    }

    const instanceId = crypto.randomUUID();
    // State is written before the first await. A Durable Object runs this code
    // without interleaving, so a double click can't start two investigations.
    this.applyChange(
      instanceId,
      "started",
      {
        phase: "triage",
        instanceId,
        // Clear the previous run's results, so they can't be mistaken for this one's.
        triage: undefined,
        diagnosis: undefined,
        decisionNote: undefined,
        postmortem: undefined,
        error: undefined,
      },
      "Investigation started",
    );

    try {
      await this.runWorkflow(
        "INVESTIGATION_WORKFLOW",
        { evidence },
        { id: instanceId },
      );
    } catch (error) {
      this.fail(instanceId, error);
      throw error;
    }
    return instanceId;
  }

  @callable()
  async approveRemediation(note?: string) {
    const instanceId = this.requireAwaitingApproval();
    const decisionNote = note?.trim() || undefined;
    this.applyChange(
      instanceId,
      "approved",
      { phase: "postmortem", decisionNote },
      "Remediation approved",
    );
    await this.approveWorkflow(instanceId, {
      metadata: { note: decisionNote },
    });
  }

  @callable()
  async rejectRemediation(note?: string) {
    const instanceId = this.requireAwaitingApproval();
    const decisionNote = note?.trim() || undefined;
    this.applyChange(
      instanceId,
      "rejected",
      { phase: "rejected", decisionNote },
      "Remediation rejected",
    );
    await this.rejectWorkflow(instanceId, { reason: decisionNote });
  }

  @callable()
  getTimeline(): TimelineEntry[] {
    return this.sql<TimelineEntry>`
      SELECT id, at, message FROM timeline ORDER BY at, id`;
  }

  // ---- Called by the Workflow over RPC (no @callable, so not by browsers) ----

  /**
   * Saves one step's result. A Workflow step can run again if it fails after this
   * write commits, so the write is idempotent: the timeline row has a fixed key,
   * and the same state patch can safely be applied twice.
   */
  async recordStep(
    instanceId: string,
    key: string,
    patch: Partial<IncidentState>,
    message: string,
  ) {
    this.applyChange(instanceId, key, patch, message);
  }

  // ---- Workflow lifecycle callbacks from the SDK ------------------------------

  async onWorkflowError(
    _workflowName: string,
    instanceId: string,
    error: string,
  ) {
    // The SDK also reports a human rejection through this callback. That is a
    // decision and not a failure, so leave the recorded phase alone.
    if (this.state.phase === "rejected") return;
    this.fail(instanceId, error);
  }

  // ---- Internals --------------------------------------------------------------

  private requireAwaitingApproval(): string {
    const { phase, instanceId } = this.state;
    if (phase !== "awaiting_approval" || !instanceId) {
      throw new Error("Nothing is awaiting approval");
    }
    return instanceId;
  }

  private fail(instanceId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.applyChange(
      instanceId,
      "failed",
      { phase: "failed", error: message },
      `Investigation failed: ${message}`,
    );
  }

  private applyChange(
    instanceId: string,
    key: string,
    patch: Partial<IncidentState>,
    message: string,
  ) {
    // Ignore a late write from an older investigation. Starting a new one sets
    // instanceId in its patch, which is why that patch is allowed through.
    if (patch.instanceId !== instanceId && this.state.instanceId !== instanceId) {
      return;
    }
    this.sql`INSERT OR IGNORE INTO timeline (id, at, message)
      VALUES (${`${instanceId}:${key}`}, ${Date.now()}, ${message})`;
    this.setState({
      ...this.state,
      ...patch,
      timelineRevision: this.state.timelineRevision + 1,
    });
  }
}
