export function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function shellQuote(value: string): string {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function writeNodeScriptCommand(scriptBase64: string, scriptPath: string): string {
  return "printf %s " + shellQuote(scriptBase64) + " | base64 -d > " + shellQuote(scriptPath);
}

export function renderScriptRuntimeSource(): string {
  return [
    "const MATERIALIZE_SCRIPT_B64 = Buffer.from(MATERIALIZE_SCRIPT, 'utf8').toString('base64');",
    "const CREATE_PROXY_PR_SCRIPT_B64 = Buffer.from(CREATE_PROXY_PR_SCRIPT, 'utf8').toString('base64');",
    "",
    "function shellQuote(value) {",
    "  return \"'\" + String(value).replace(/'/g, \"'\\\\''\") + \"'\";",
    "}",
    "",
    "function writeNodeScriptCommand(scriptBase64, scriptPath) {",
    "  return 'printf %s ' + shellQuote(scriptBase64) + ' | base64 -d > ' + shellQuote(scriptPath);",
    "}",
  ].join("\n");
}
