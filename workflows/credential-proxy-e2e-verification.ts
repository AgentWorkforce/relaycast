import { workflow } from '@relayflows/core';

const CLOUD = process.env.CLOUD_REPO ?? `${process.env.HOME}/Projects/AgentWorkforce/cloud`;

await workflow('credential-proxy-e2e-verification')
  .description('Verify the credential-proxy service endpoint wiring contract end-to-end.')
  .pattern('dag')
  .channel('wf-credential-proxy-e2e')
  .maxConcurrency(4)
  .timeout(5 * 60 * 1000)

  .step('verify-service-config', {
    type: 'deterministic',
    command: [
      `cd ${CLOUD}`,
      `rg -q 'export const configuredCredentialProxyUrl' infra/service-config.ts`,
      `rg -q 'export const configuredCredentialProxyToken' infra/service-config.ts`,
      `rg -q 'resolveEnvOverride\\(\"RELAY_LLM_PROXY\", \"RELAY_LLM_PROXY_URL\", \"CREDENTIAL_PROXY_URL\"\\)' infra/service-config.ts`,
      `rg -q 'resolveEnvOverride\\(\"CREDENTIAL_PROXY_TOKEN\", \"RELAY_LLM_PROXY_TOKEN\"\\)' infra/service-config.ts`,
      `rg -q 'serviceApiHostname\\(\"relayllm\\.dev\"\\)' infra/service-config.ts`,
      `echo 'SERVICE_CONFIG_OK'`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  })

  .step('verify-infra-injection', {
    type: 'deterministic',
    command: [
      `cd ${CLOUD}`,
      `rg -q 'RELAY_LLM_PROXY: configuredCredentialProxyUrl' infra/web.ts`,
      `rg -q 'RELAY_LLM_PROXY_URL: configuredCredentialProxyUrl' infra/web.ts`,
      `rg -q 'CREDENTIAL_PROXY_TOKEN: configuredCredentialProxyToken' infra/web.ts`,
      `rg -q 'RELAY_LLM_PROXY_TOKEN: configuredCredentialProxyToken' infra/web.ts`,
      `rg -q 'serviceApiHostname\\(\"relayllm\\.dev\"\\)' infra/credential-proxy.ts`,
      `rg -q 'name: \"INTERNAL_SECRET\"' infra/credential-proxy.ts`,
      `rg -q 'name: \"CREDENTIAL_ENCRYPTION_KEY\"' infra/credential-proxy.ts`,
      `echo 'INFRA_INJECTION_OK'`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  })

  .step('verify-runtime-propagation', {
    type: 'deterministic',
    dependsOn: ['verify-service-config', 'verify-infra-injection'],
    command: [
      `cd ${CLOUD}`,
      `rg -q 'const INTERNAL_ENV_KEYS = new Set\\(\\[' packages/core/src/bootstrap/script-generator.ts`,
      `rg -q 'const forwardedEnvKeys = \\[' packages/core/src/bootstrap/script-generator.ts`,
      `rg -q \"'RELAY_LLM_PROXY'\" packages/core/src/bootstrap/script-generator.ts`,
      `rg -q \"'RELAY_LLM_PROXY_URL'\" packages/core/src/bootstrap/script-generator.ts`,
      `rg -q \"'OPENAI_BASE_URL'\" packages/core/src/bootstrap/script-generator.ts`,
      `rg -q \"'ANTHROPIC_BASE_URL'\" packages/core/src/bootstrap/script-generator.ts`,
      `rg -q \"'GOOGLE_API_BASE'\" packages/core/src/bootstrap/script-generator.ts`,
      `rg -q \"'OPENAI_API_BASE'\" packages/core/src/bootstrap/script-generator.ts`,
      `rg -q \"'CREDENTIAL_PROXY_TOKEN'\" packages/core/src/bootstrap/script-generator.ts`,
      `rg -q \"'RELAY_LLM_PROXY_TOKEN'\" packages/core/src/bootstrap/script-generator.ts`,
      `rg -q 'export function resolveCredentialProxyConfig' packages/core/src/bootstrap/launcher.ts`,
      `rg -q 'export function applyCredentialProxyEnv' packages/core/src/bootstrap/launcher.ts`,
      "rg -q 'env\\.OPENAI_BASE_URL = `\\$\\{credentialProxyUrl\\}/openai/v1`' packages/core/src/bootstrap/launcher.ts",
      "rg -q 'env\\.ANTHROPIC_BASE_URL = `\\$\\{credentialProxyUrl\\}/anthropic`' packages/core/src/bootstrap/launcher.ts",
      "rg -q 'env\\.GOOGLE_API_BASE = `\\$\\{credentialProxyUrl\\}/google`' packages/core/src/bootstrap/launcher.ts",
      `rg -q 'env\\.OPENAI_API_BASE = env\\.OPENAI_BASE_URL' packages/core/src/bootstrap/launcher.ts`,
      `echo 'RUNTIME_PROPAGATION_OK'`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  })

  .step('verify-no-hardcoded-defaults', {
    type: 'deterministic',
    dependsOn: ['verify-service-config', 'verify-infra-injection'],
    command: [
      `cd ${CLOUD}`,
      `if rg -n 'api\\.relayfile\\.dev|api\\.relayauth\\.dev|api\\.relayllm\\.dev' packages/web --glob '!**/node_modules/**' --glob '!**/.next/**'; then exit 1; fi`,
      `echo 'NO_HARDCODED_DEFAULTS_OK'`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  })

  .step('contract-summary', {
    type: 'deterministic',
    dependsOn: ['verify-runtime-propagation', 'verify-no-hardcoded-defaults'],
    command: [
      `echo '=== Credential Proxy E2E Contract Verified ==='`,
      `echo '1. service-config.ts exports configuredCredentialProxyUrl and configuredCredentialProxyToken'`,
      `echo '2. infra/web.ts injects the credential-proxy URL and token env vars'`,
      `echo '3. infra/credential-proxy.ts deploys the worker with required secret bindings'`,
      `echo '4. script-generator.ts preserves credential-proxy env keys for sandbox runtime'`,
      `echo '5. launcher.ts resolves proxy config and derives provider base URLs'`,
      `echo '6. packages/web contains no hardcoded relay service host defaults'`,
      `echo 'E2E_VERIFICATION_PASS'`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  })

  .onError('fail')
  .run({ cwd: CLOUD });
