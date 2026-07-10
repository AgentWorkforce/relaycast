export const WORKFORCE_RUNTIME_PACKAGE = "@agentworkforce/runtime";
export const WORKFORCE_RUNTIME_VERSION = "4.0.1";
export const WORKFORCE_RUNTIME_SPEC =
  `${WORKFORCE_RUNTIME_PACKAGE}@${WORKFORCE_RUNTIME_VERSION}`;

// Exact AWS/Smithy closure required by the Daytona Node v25 runtime. Keep this
// aligned with package.json and the snapshot bake; npm range floating has
// repeatedly produced `emitWarningIfUnsupportedVersion is not a function`.
export const WORKFORCE_RUNTIME_AWS_SMITHY_SPECS = [
  "@aws-sdk/client-s3@3.1041.0",
  "@aws-sdk/client-sts@3.1037.0",
  "@aws-sdk/lib-storage@3.1037.0",
  "@smithy/smithy-client@4.12.13",
] as const;

// The crash (`emitWarningIfUnsupportedVersion is not a function`) comes from the
// copy of @smithy/smithy-client that the AWS SDK resolves, NOT the CWD-relative
// one. On the Daytona Node v25 npm tree the AWS SDK can nest its own transitive
// copy that diverges from the top-level pin. A CWD-relative check alone passes
// against the good top-level copy and lets the broken AWS-SDK-relative copy
// through, so the guard MUST validate the AWS-SDK-relative resolution too — a
// failure here forces RUNTIME_DEPS_OK=false → reinstall + dedupe.
export const WORKFORCE_RUNTIME_AWS_SMITHY_REQUIRE_CHECK = [
  "const smithy=require('@smithy/smithy-client');",
  "if(typeof smithy.emitWarningIfUnsupportedVersion!=='function'){",
  "throw new Error('@smithy/smithy-client resolved without emitWarningIfUnsupportedVersion: '+require.resolve('@smithy/smithy-client'))",
  "};",
  "const awsSmithyPath=require.resolve('@smithy/smithy-client',{paths:[require.resolve('@aws-sdk/client-s3')]});",
  "if(typeof require(awsSmithyPath).emitWarningIfUnsupportedVersion!=='function'){",
  "throw new Error('@smithy/smithy-client (aws-sdk-relative) resolved without emitWarningIfUnsupportedVersion: '+awsSmithyPath)",
  "};",
  "require('@aws-sdk/client-s3');",
  "require('@aws-sdk/client-sts');",
  "require('@aws-sdk/lib-storage');",
].join("");

export const WORKFORCE_RUNTIME_SMITHY_LOAD_CHECK = [
  WORKFORCE_RUNTIME_AWS_SMITHY_REQUIRE_CHECK,
  `import('${WORKFORCE_RUNTIME_PACKAGE}')`,
].join("");

// Non-fatal diagnostic: prints Node version, CWD-relative and AWS-SDK-relative
// @smithy/smithy-client resolution details, and enumerates all copies found
// under ./node_modules. Runs before the load check on every fire (including
// the bake-skip path) so the data lands in captured run logs even when the
// subsequent load check crashes the process.
export const WORKFORCE_RUNTIME_SMITHY_DIAGNOSTIC = [
  "(function(){",
  "try{",
  "var fs=require('fs');",
  // Walk up from a resolved path to find the package root's package.json
  "function pkgVer(p){",
  "var parts=p.split('/');",
  "for(var i=parts.length-1;i>0;i--){",
  "try{var j=JSON.parse(fs.readFileSync(parts.slice(0,i).join('/')+'/package.json','utf8'));",
  "if(j.name&&j.version)return j.version;}catch(_){}",
  "}return '?';}",
  // 1. Node version
  "console.log('[smithy-diag] node='+process.version);",
  // 2. CWD-relative resolution
  "var cwd=require.resolve('@smithy/smithy-client');",
  "var cwdMod=require('@smithy/smithy-client');",
  "console.log('[smithy-diag] cwd-resolve='+cwd+' version='+pkgVer(cwd)+' emitWarn='+typeof cwdMod.emitWarningIfUnsupportedVersion);",
  // 3. AWS-SDK-relative resolution
  "try{",
  "var awsRef=require.resolve('@aws-sdk/client-s3');",
  "var ar=require.resolve('@smithy/smithy-client',{paths:[awsRef]});",
  "var arMod=require(ar);",
  "console.log('[smithy-diag] aws-sdk-resolve='+ar+' version='+pkgVer(ar)+' emitWarn='+typeof arMod.emitWarningIfUnsupportedVersion);",
  "}catch(ae){console.log('[smithy-diag] aws-sdk-error='+(ae&&ae.message||ae));}",
  // 4. All @smithy/smithy-client copies under ./node_modules
  "try{",
  "var out=require('child_process').execSync('find ./node_modules -name package.json 2>/dev/null||true',{encoding:'utf8',timeout:5000});",
  "var copies=out.trim().split('\\n').filter(function(l){return l.indexOf('@smithy/smithy-client/package.json')>=0;});",
  "copies.forEach(function(f){var v='?';try{v=JSON.parse(fs.readFileSync(f,'utf8')).version;}catch(_){}console.log('[smithy-diag] copy: '+f+' version='+v);});",
  "if(!copies.length)console.log('[smithy-diag] no smithy-client copies found');",
  "}catch(fe){console.log('[smithy-diag] find-error='+(fe&&fe.message||fe));}",
  "}catch(e){console.log('[smithy-diag] fatal='+(e&&e.message||e));}",
  "})()",
].join("");

export function parseWorkforceRuntimePackageSpec(spec: string): {
  name: string;
  version: string;
} {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    throw new Error(`Invalid package spec: ${spec}`);
  }
  return {
    name: spec.slice(0, at),
    version: spec.slice(at + 1),
  };
}
