// Types shared by the Worker and the browser. Type-only imports, so no server
// code ends up in the client bundle.
import type { Diagnosis, Triage } from "./analysis";

export type Phase =
  | "idle"
  | "triage"
  | "diagnosis"
  | "awaiting_approval"
  | "postmortem"
  | "resolved"
  | "rejected"
  | "timed_out"
  | "failed";

/** Phases where a Workflow instance is still in charge of the incident. */
export const ACTIVE_PHASES: readonly Phase[] = [
  "triage",
  "diagnosis",
  "awaiting_approval",
  "postmortem",
];

/** Small and current, because every change rewrites it and syncs it to clients. */
export type IncidentState = {
  phase: Phase;
  instanceId?: string;
  triage?: Triage;
  diagnosis?: Diagnosis;
  decisionNote?: string;
  postmortem?: string;
  error?: string;
  /** Bumped on each timeline write, which tells clients to fetch the timeline. */
  timelineRevision: number;
};

export const INITIAL_STATE: IncidentState = {
  phase: "idle",
  timelineRevision: 0,
};

export type TimelineEntry = {
  id: string;
  at: number;
  message: string;
};
