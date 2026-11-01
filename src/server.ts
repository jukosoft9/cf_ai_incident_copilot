// Worker entry point. Static files are served by the assets binding. /agents/*
// reaches this code and is routed to the Durable Object for that incident.
import { routeAgentRequest } from "agents";

export { IncidentAgent } from "./agent";
export { InvestigationWorkflow } from "./workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
