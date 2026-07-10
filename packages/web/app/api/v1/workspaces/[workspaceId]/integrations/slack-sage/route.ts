import { createIntegrationRouteHandlers } from "@/lib/integrations/integration-route-handler";

// Legacy URL path: `/integrations/slack-sage` was the original route shape
// before the provider id was renamed to `slack`. The route is preserved so
// external callers (sage app, Ricky CLI, in-flight links) keep resolving;
// internally it operates on the canonical `slack` provider id.
export const { GET, POST, DELETE } = createIntegrationRouteHandlers("slack");
