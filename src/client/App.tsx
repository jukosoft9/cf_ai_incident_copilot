import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { IncidentAgent } from "../agent";
import {
  ACTIVE_PHASES,
  INITIAL_STATE,
  type IncidentState,
  type Phase,
  type TimelineEntry,
} from "../shared";
import { SAMPLES } from "./samples";

const PHASE_LABELS: Record<Phase, string> = {
  idle: "Not started",
  triage: "Triaging…",
  diagnosis: "Diagnosing…",
  awaiting_approval: "Waiting for your decision",
  postmortem: "Writing postmortem…",
  resolved: "Postmortem ready",
  rejected: "Remediation rejected",
  timed_out: "Timed out waiting for a decision",
  failed: "Failed",
};

/** Each incident is its own Durable Object, addressed by the ?incident= value. */
function incidentIdFromUrl(): string {
  const url = new URL(window.location.href);
  let id = url.searchParams.get("incident");
  if (!id) {
    id = crypto.randomUUID().slice(0, 8);
    url.searchParams.set("incident", id);
    window.history.replaceState(null, "", url);
  }
  return id;
}

export function App() {
  const [incidentId] = useState(incidentIdFromUrl);
  const [state, setState] = useState<IncidentState>(INITIAL_STATE);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [actionError, setActionError] = useState<string>();

  const agent = useAgent<IncidentAgent, IncidentState>({
    agent: "IncidentAgent",
    name: incidentId,
    onStateUpdate: (next) => setState(next),
  });

  // The timeline lives in SQL rather than in state, so fetch it when it changes.
  useEffect(() => {
    if (state.timelineRevision === 0) return;
    agent.stub.getTimeline().then(setTimeline, () => {});
  }, [state.timelineRevision]);

  // An error from an earlier action no longer applies once the phase has moved on.
  useEffect(() => setActionError(undefined), [state.phase]);

  async function run(action: () => Promise<unknown>) {
    setActionError(undefined);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="app">
      <header>
        <h1>Incident Copilot</h1>
        <span className="incident-id">Incident {incidentId}</span>
        <a className="new-incident" href={window.location.pathname}>
          New incident
        </a>
      </header>
      <main>
        <Chat agent={agent} />
        <Investigation
          state={state}
          timeline={timeline}
          actionError={actionError}
          onStart={() => run(() => agent.stub.startInvestigation())}
          onApprove={(note) => run(() => agent.stub.approveRemediation(note))}
          onReject={(note) => run(() => agent.stub.rejectRemediation(note))}
        />
      </main>
    </div>
  );
}

function Chat({
  agent,
}: {
  agent: ReturnType<typeof useAgent<IncidentAgent, IncidentState>>;
}) {
  const { messages, sendMessage, status, error } = useAgentChat({ agent });
  const [draft, setDraft] = useState("");
  const busy = status === "submitted" || status === "streaming";
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    sendMessage({ text: draft });
    setDraft("");
  }

  return (
    <section className="chat" aria-label="Chat">
      <div className="messages" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty">
            <p>
              Describe the incident and paste any logs or diagnostic output. To
              try it out, load a sample and send it:
            </p>
            <div className="samples">
              {SAMPLES.map((sample) => (
                <button
                  key={sample.label}
                  type="button"
                  className="secondary"
                  onClick={() => setDraft(sample.text)}
                >
                  {sample.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            {message.parts.map((part, index) =>
              part.type === "text" ? <span key={index}>{part.text}</span> : null,
            )}
          </div>
        ))}
        {error && <p className="error">Chat error: {error.message}</p>}
        <div ref={messagesEnd} />
      </div>
      <form onSubmit={submit}>
        <label htmlFor="composer" className="visually-hidden">
          Message
        </label>
        <textarea
          id="composer"
          rows={draft.includes("\n") ? 8 : 2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="What's happening?"
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}

function Investigation({
  state,
  timeline,
  actionError,
  onStart,
  onApprove,
  onReject,
}: {
  state: IncidentState;
  timeline: TimelineEntry[];
  actionError?: string;
  onStart: () => void;
  onApprove: (note: string) => void;
  onReject: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const { phase, triage, diagnosis, postmortem } = state;
  const running = ACTIVE_PHASES.includes(phase);

  return (
    <aside className="investigation" aria-label="Investigation">
      <div className="panel-heading">
        <h2>Investigation</h2>
        <span className={`phase phase-${phase}`}>{PHASE_LABELS[phase]}</span>
      </div>

      {!running && (
        <button type="button" onClick={onStart}>
          {phase === "idle" ? "Start investigation" : "Investigate again"}
        </button>
      )}
      {actionError && <p className="error">{actionError}</p>}
      {state.error && <p className="error">{state.error}</p>}

      {triage && (
        <section>
          <h3>
            <span className="severity">{triage.severity}</span> {triage.title}
          </h3>
          <p className="meta">{triage.engine}</p>
          <p>{triage.summary}</p>
          <p>
            <strong>Impact:</strong> {triage.impact}
          </p>
          {triage.missingEvidence.length > 0 && (
            <>
              <h4>Evidence that would help</h4>
              <ul>
                {triage.missingEvidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {diagnosis && (
        <section>
          <h3>Hypotheses</h3>
          <ol>
            {diagnosis.hypotheses.map((hypothesis) => (
              <li key={hypothesis.cause}>
                <strong>{hypothesis.cause}</strong> ({hypothesis.confidence})
                <p>{hypothesis.supportingEvidence}</p>
                <code className="block">{hypothesis.verifyWith}</code>
              </li>
            ))}
          </ol>

          <h3>Proposed remediation</h3>
          <p>{diagnosis.remediation.summary}</p>
          {diagnosis.remediation.commands.map((command) => (
            <code className="block" key={command}>
              {command}
            </code>
          ))}
          <p>
            <strong>Risk:</strong> {diagnosis.remediation.risk}
          </p>
          <p>
            <strong>Rollback:</strong> {diagnosis.remediation.rollback}
          </p>
        </section>
      )}

      {phase === "awaiting_approval" && (
        <section className="decision">
          <h3>Your decision</h3>
          <p className="meta">
            This records your decision. Nothing is run against any database.
          </p>
          <label htmlFor="note">Note (optional)</label>
          <textarea
            id="note"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="decision-buttons">
            <button type="button" onClick={() => onApprove(note)}>
              Approve
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => onReject(note)}
            >
              Reject
            </button>
          </div>
        </section>
      )}

      {phase === "rejected" && (
        <p className="meta">
          {state.decisionNote
            ? `Your note: ${state.decisionNote}. `
            : ""}
          Add what you've learned in the chat, then investigate again.
        </p>
      )}

      {postmortem && (
        <section>
          <h3>Draft postmortem</h3>
          <pre className="postmortem">{postmortem}</pre>
        </section>
      )}

      {timeline.length > 0 && (
        <section>
          <h3>Timeline</h3>
          <ul className="timeline">
            {timeline.map((entry) => (
              <li key={entry.id}>
                <time>{new Date(entry.at).toLocaleTimeString()}</time>{" "}
                {entry.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
