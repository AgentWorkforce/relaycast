import { Daytona } from "@daytonaio/sdk";
const d = new Daytona();
const sb = await d.create({ language: "typescript", autoStopInterval: 15 });
const home = await sb.getUserHomeDir();
const ssh = await sb.createSshAccess(15);
console.log(`Sandbox: ${sb.id}`);
console.log(`SSH: ${ssh.sshCommand}`);
console.log(`\nRun:\n  ${ssh.sshCommand}`);
