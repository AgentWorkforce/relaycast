/**
 * Quick test: create a sandbox with Claude credentials mounted correctly.
 * Prints SSH command so you can verify manually.
 */
import { Daytona } from "@daytonaio/sdk";
import { CliAuth } from "../packages/core/src/cli-auth.js";

const daytona = new Daytona();
const cliAuth = new CliAuth(daytona);

// Get the credential volume
const volume = await daytona.volume.get("cli-auth-credentials");

const sandbox = await daytona.create({
  language: "typescript",
  autoStopInterval: 15,
  volumes: [{ volumeId: volume.id, mountPath: "/credentials" }],
});
const home = await sandbox.getUserHomeDir();
console.log("Sandbox:", sandbox.id);

const mounted = await cliAuth.mountToSandbox(sandbox, "anthropic", home!);
console.log("Credentials mounted:", mounted);

const check = await sandbox.process.executeCommand(
  `ls -la ${home}/.claude/ && echo "---" && cat ${home}/.claude.json`
);
console.log(check.result.trim());

const ssh = await sandbox.createSshAccess(15);
console.log("\nSSH in with:");
console.log(`  ${ssh.sshCommand}`);
console.log("\nCredentials are at ~/.claude/.credentials.json");
console.log("Try: claude -p 'say hello' --no-input");
