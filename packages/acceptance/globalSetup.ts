import { acceptanceEnv } from "./helpers/env";

export default async function globalSetup() {
  void acceptanceEnv().baseUrl;
}
