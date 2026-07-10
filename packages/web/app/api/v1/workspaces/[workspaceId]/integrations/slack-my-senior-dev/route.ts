import { createIntegrationRouteHandlers } from "@/lib/integrations/integration-route-handler";

export const { GET, POST, DELETE } = createIntegrationRouteHandlers("slack-my-senior-dev");
