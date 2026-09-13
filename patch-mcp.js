const fs = require('fs');
const path = require('path');

const root = process.cwd();
const bundlePath = path.resolve(root, './dist/main.js');
const mapPath = path.resolve(root, './dist/main.js.map');

function fail(message) {
  throw new Error(`[AFFiNE MCP Patch] ${message}`);
}

if (!fs.existsSync(bundlePath) || !fs.existsSync(mapPath)) {
  fail('Expected ./dist/main.js and ./dist/main.js.map were not found.');
}

const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

function sourceEndingWith(suffix) {
  const matches = map.sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => source.endsWith(suffix));
  if (matches.length !== 1) {
    fail(`Expected exactly one ${suffix}, found ${matches.length}.`);
  }
  return map.sourcesContent?.[matches[0].index] || '';
}

const providerSource = sourceEndingWith('plugins/copilot/mcp/provider.ts');
const resolverSource = sourceEndingWith('plugins/copilot/mcp/resolver.ts');
const gatewaySource = sourceEndingWith('core/sync/gateway.ts');

for (const marker of [
  'McpAccessMode.READ_WRITE',
  'env.namespaces.canary',
  "name: 'create_document'",
  "name: 'update_document'",
  "name: 'update_document_meta'",
  "assert('Workspace.Read')",
  'tools.push(createDocument, updateDocument, updateDocumentMeta)'
]) {
  if (!providerSource.includes(marker)) {
    fail(`Provider structure changed; missing marker: ${marker}`);
  }
}

for (const marker of [
  'mcpCredentialReadWriteAvailable()',
  "throw new BadRequestException('MCP write tools are not available')",
  'input.accessMode === McpAccessMode.READ_WRITE'
]) {
  if (!resolverSource.includes(marker)) {
    fail(`Resolver structure changed; missing marker: ${marker}`);
  }
}

for (const marker of [
  'BackendRuntimeProvider',
  'private readonly runtime: BackendRuntimeProvider',
  'executeDomainCommandV1',
  "command: 'apply_doc_lifecycle'",
  "lifecycle: 'trash' | 'restore' | 'delete'"
]) {
  if (!gatewaySource.includes(marker)) {
    fail(`AFFiNE native lifecycle runtime is unavailable; missing gateway marker: ${marker}`);
  }
}

const providerGateSource = /accessMode\s*===\s*McpAccessMode\.READ_WRITE\s*&&\s*\(\s*env\.dev\s*\|\|\s*env\.namespaces\.canary\s*\)/gm;
if ((providerSource.match(providerGateSource) || []).length !== 1) {
  fail('Expected exactly one provider READ_WRITE gate in source.');
}

const availabilitySource = /mcpCredentialReadWriteAvailable\(\)\s*\{\s*return\s+env\.dev\s*\|\|\s*env\.namespaces\.canary;?\s*\}/gm;
if ((resolverSource.match(availabilitySource) || []).length !== 1) {
  fail('Expected exactly one READ_WRITE availability gate in resolver source.');
}

const creationGuardSource = /input\.accessMode\s*===\s*McpAccessMode\.READ_WRITE\s*&&\s*!env\.dev\s*&&\s*!env\.namespaces\.canary/gm;
if ((resolverSource.match(creationGuardSource) || []).length !== 1) {
  fail('Expected exactly one READ_WRITE credential creation guard in resolver source.');
}

const originalBundle = fs.readFileSync(bundlePath, 'utf8');
let patchedBundle = originalBundle;
const changes = [];

function applyUnique(regex, replacer, label) {
  const matches = [...patchedBundle.matchAll(regex)];
  if (matches.length !== 1) {
    fail(`${label}: expected exactly one compiled match, found ${matches.length}.`);
  }
  const m = matches[0];
  const original = m[0];
  const replacement = typeof replacer === 'function' ? replacer(m) : replacer;
  if (!replacement || replacement === original) {
    fail(`${label}: refusing no-op patch.`);
  }
  const index = m.index;
  patchedBundle = patchedBundle.slice(0, index) + replacement + patchedBundle.slice(index + original.length);
  changes.push({ label, original, replacement });
}

function applyExactAt(index, original, replacement, label) {
  if (index < 0 || patchedBundle.slice(index, index + original.length) !== original) {
    fail(`${label}: target fragment changed before patching.`);
  }
  if (!replacement || replacement === original) {
    fail(`${label}: refusing no-op patch.`);
  }
  patchedBundle = patchedBundle.slice(0, index) + replacement + patchedBundle.slice(index + original.length);
  changes.push({ label, original, replacement });
}

const ident = '[A-Za-z_$][\\w$]*';
const chain = `${ident}(?:\\.${ident})*`;

// 1) Existing WRITE gates only.
applyUnique(
  new RegExp(`(${chain})\\s*===\\s*(${chain})\\.READ_WRITE\\s*&&\\s*\\(\\s*(${chain})\\.dev\\s*\\|\\|\\s*\\3\\.namespaces\\.canary\\s*\\)`, 'g'),
  m => `${m[1]}===${m[2]}.READ_WRITE&&(${m[3]}.dev||${m[3]}.namespaces.canary||process.env.AFFINE_MCP_WRITE_ENABLED===\"true\")`,
  'provider write gate'
);

applyUnique(
  /mcpCredentialReadWriteAvailable\(\)\{return env\.dev\|\|env\.namespaces\.canary\}/g,
  'mcpCredentialReadWriteAvailable(){return env.dev||env.namespaces.canary||process.env.AFFINE_MCP_WRITE_ENABLED===\"true\"}',
  'resolver availability gate'
);

applyUnique(
  new RegExp(`(\\.accessMode\\s*===\\s*${chain}\\.READ_WRITE\\s*&&\\s*!env\\.dev\\s*&&\\s*!env\\.namespaces\\.canary)`, 'g'),
  m => `${m[1]}&&process.env.AFFINE_MCP_WRITE_ENABLED!==\"true\"`,
  'resolver credential creation gate'
);

// 2) Find AFFiNE's own lifecycle runtime in SpaceSyncGateway.
const lifecycleCalls = [...patchedBundle.matchAll(/(this\.[A-Za-z_$][\w$]*)\.executeDomainCommandV1\(\{command:[\"']apply_doc_lifecycle[\"']/g)];
if (lifecycleCalls.length !== 1) {
  fail(`AFFiNE lifecycle runtime: expected exactly one apply_doc_lifecycle call, found ${lifecycleCalls.length}.`);
}
const runtimeExpr = lifecycleCalls[0][1];
const runtimeProp = runtimeExpr.slice('this.'.length);
const lifecyclePos = lifecycleCalls[0].index;
const constructorStart = patchedBundle.lastIndexOf('constructor(', lifecyclePos);
if (constructorStart < 0 || lifecyclePos - constructorStart > 50000) {
  fail('AFFiNE lifecycle runtime: gateway constructor could not be located safely.');
}
const constructorEnd = patchedBundle.indexOf('}', constructorStart);
if (constructorEnd < 0 || constructorEnd > lifecyclePos) {
  fail('AFFiNE lifecycle runtime: gateway constructor boundary is ambiguous.');
}
const constructorChunk = patchedBundle.slice(constructorStart, constructorEnd + 1);
const runtimeAssignmentRegex = new RegExp(`this\\.${runtimeProp}=(${ident})`, 'g');
const runtimeAssignments = [...constructorChunk.matchAll(runtimeAssignmentRegex)];
if (runtimeAssignments.length !== 1) {
  fail(`AFFiNE lifecycle runtime: expected one constructor assignment for ${runtimeExpr}, found ${runtimeAssignments.length}.`);
}
const runtimeAssignment = runtimeAssignments[0][0];
const runtimeParam = runtimeAssignments[0][1];
const runtimeAssignmentIndex = constructorStart + runtimeAssignments[0].index;
applyExactAt(
  runtimeAssignmentIndex,
  runtimeAssignment,
  `${runtimeAssignment},globalThis.__AFFINE_MCP_BACKEND_RUNTIME__=${runtimeExpr}`,
  'capture AFFiNE lifecycle runtime'
);

// 3) Locate the authenticated MCP workspace context and the native write-tool push.
const metaMarker = 'update_document_meta';
const metaPositions = [];
for (let pos = patchedBundle.indexOf(metaMarker); pos !== -1; pos = patchedBundle.indexOf(metaMarker, pos + 1)) {
  metaPositions.push(pos);
}
if (metaPositions.length !== 1) {
  fail(`delete_document: expected one ${metaMarker} marker in compiled bundle, found ${metaPositions.length}.`);
}
const markerPos = metaPositions[0];
const contextStart = Math.max(0, markerPos - 20000);
const contextChunk = patchedBundle.slice(contextStart, markerPos);
const contextMatches = [...contextChunk.matchAll(/\.user\(([^()]+)\)\.workspace\(([^()]+)\)\.assert\(([\"'])Workspace\.Read\3\)/g)];
if (contextMatches.length !== 1) {
  fail(`delete_document: expected one compiled Workspace.Read context before ${metaMarker}, found ${contextMatches.length}.`);
}
const userVar = contextMatches[0][1].trim();
const workspaceVar = contextMatches[0][2].trim();
if (!new RegExp(`^${ident}$`).test(userVar) || !new RegExp(`^${ident}$`).test(workspaceVar)) {
  fail(`delete_document: unexpected user/workspace expressions: ${userVar} / ${workspaceVar}`);
}

const searchEnd = Math.min(patchedBundle.length, markerPos + 10000);
const tail = patchedBundle.slice(markerPos, searchEnd);
const pushCandidates = [...tail.matchAll(/([A-Za-z_$][\w$]*)\.push\(([^()]{1,500})\)/g)]
  .filter(match => {
    const args = match[2].split(',').map(value => value.trim());
    return args.length === 3 && args.every(value => /^[A-Za-z_$][\w$]*$/.test(value));
  });
if (pushCandidates.length !== 1) {
  fail(`delete_document: expected exactly one compiled three-tool push call, found ${pushCandidates.length}.`);
}
const pushMatch = pushCandidates[0];
const toolsVar = pushMatch[1];
const pushIndex = markerPos + pushMatch.index;
const pushCall = pushMatch[0];

// 4) Add only an MCP adapter. AFFiNE itself performs the lifecycle delete.
const deleteTool = `{
name:\"delete_document\",
title:\"Delete Document\",
description:\"Permanently delete a document using AFFiNE's native document lifecycle. This cannot be undone.\",
inputSchema:{type:\"object\",properties:{docId:{type:\"string\",description:\"The ID of the document to delete\"}},required:[\"docId\"],additionalProperties:false},
execute:async(__affineMcpArgs,__affineMcpOptions)=>{if(__affineMcpOptions&&__affineMcpOptions.signal&&__affineMcpOptions.signal.aborted)return{isError:true,content:[{type:\"text\",text:\"Request aborted.\"}]};let __affineMcpDocId=__affineMcpArgs&&__affineMcpArgs.docId;if(typeof __affineMcpDocId!==\"string\"||!__affineMcpDocId)return{isError:true,content:[{type:\"text\",text:\"Invalid arguments: docId is required\"}]};if(__affineMcpDocId===${workspaceVar})return{isError:true,content:[{type:\"text\",text:\"Workspace root document cannot be deleted\"}]};try{let __affineMcpAccessible=await this.ac.user(${userVar}).workspace(${workspaceVar}).doc(__affineMcpDocId).can(\"Doc.Delete\");if(!__affineMcpAccessible)return{isError:true,content:[{type:\"text\",text:\"Doc with id \"+__affineMcpDocId+\" not found.\"}]};if(__affineMcpOptions&&__affineMcpOptions.signal&&__affineMcpOptions.signal.aborted)return{isError:true,content:[{type:\"text\",text:\"Request aborted.\"}]};let __affineMcpRuntime=globalThis.__AFFINE_MCP_BACKEND_RUNTIME__;if(!__affineMcpRuntime||typeof __affineMcpRuntime.executeDomainCommandV1!==\"function\")throw new Error(\"AFFiNE native lifecycle runtime is unavailable\");await __affineMcpRuntime.executeDomainCommandV1({command:\"apply_doc_lifecycle\",actorUserId:${userVar},workspaceId:${workspaceVar},docId:__affineMcpDocId,lifecycle:\"delete\"});return{content:[{type:\"text\",text:JSON.stringify({success:true,docId:__affineMcpDocId,message:\"Document deleted successfully by AFFiNE lifecycle\"})}]}}catch(__affineMcpError){return{isError:true,content:[{type:\"text\",text:\"Failed to delete document: \"+(__affineMcpError instanceof Error?__affineMcpError.message:String(__affineMcpError))}]}}}
}`;

applyExactAt(pushIndex, pushCall, `${pushCall};${toolsVar}.push(${deleteTool})`, 'delete_document adapter');

// 5) Hard verification. Nothing outside the recorded changes may differ.
let reconstructed = originalBundle;
for (const change of changes) {
  const count = reconstructed.split(change.original).length - 1;
  if (count !== 1) {
    fail(`${change.label}: original fragment is not uniquely reconstructable.`);
  }
  reconstructed = reconstructed.replace(change.original, change.replacement);
}
if (reconstructed !== patchedBundle) {
  fail('Bundle contains changes outside the recorded MCP patches.');
}

let reversed = patchedBundle;
for (const change of [...changes].reverse()) {
  const count = reversed.split(change.replacement).length - 1;
  if (count !== 1) {
    fail(`${change.label}: patched fragment is not uniquely reversible.`);
  }
  reversed = reversed.replace(change.replacement, change.original);
}
if (reversed !== originalBundle) {
  fail('Patch is not exactly reversible to the upstream bundle.');
}

for (const marker of [
  'create_document',
  'update_document',
  'update_document_meta',
  'delete_document',
  'Doc.Delete',
  'apply_doc_lifecycle',
  '__AFFINE_MCP_BACKEND_RUNTIME__'
]) {
  if (!patchedBundle.includes(marker)) {
    fail(`Required marker disappeared: ${marker}`);
  }
}

fs.writeFileSync(bundlePath, patchedBundle);
console.log('[AFFiNE MCP Patch] Enabled MCP WRITE gates and added delete_document as a fail-closed adapter to AFFiNE apply_doc_lifecycle.');
