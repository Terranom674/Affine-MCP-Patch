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
const runtimeSource = sourceEndingWith('core/backend-runtime/provider.ts');

for (const marker of [
  'McpAccessMode.READ_WRITE',
  'env.namespaces.canary',
  "name: 'create_document'",
  "name: 'update_document'",
  "name: 'update_document_meta'"
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

if (!runtimeSource.includes('executeDomainCommandV1')) {
  fail('BackendRuntimeProvider structure changed; executeDomainCommandV1 is missing.');
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

// 1) Provider: expose write tools when the explicit env switch is true.
applyUnique(
  new RegExp(`(${chain})\\s*===\\s*(${chain})\\.READ_WRITE\\s*&&\\s*\\(\\s*(${chain})\\.dev\\s*\\|\\|\\s*\\3\\.namespaces\\.canary\\s*\\)`, 'g'),
  m => `${m[1]}===${m[2]}.READ_WRITE&&(${m[3]}.dev||${m[3]}.namespaces.canary||process.env.AFFINE_MCP_WRITE_ENABLED===\"true\")`,
  'provider write gate'
);

// 2) GraphQL capability flag: report READ_WRITE as available under the same switch.
applyUnique(
  /mcpCredentialReadWriteAvailable\(\)\{return env\.dev\|\|env\.namespaces\.canary\}/g,
  'mcpCredentialReadWriteAvailable(){return env.dev||env.namespaces.canary||process.env.AFFINE_MCP_WRITE_ENABLED===\"true\"}',
  'resolver availability gate'
);

// 3) GraphQL credential creation guard: do not reject READ_WRITE when switch is true.
applyUnique(
  new RegExp(`(\\.accessMode\\s*===\\s*${chain}\\.READ_WRITE\\s*&&\\s*!env\\.dev\\s*&&\\s*!env\\.namespaces\\.canary)`, 'g'),
  m => `${m[1]}&&process.env.AFFINE_MCP_WRITE_ENABLED!==\"true\"`,
  'resolver credential creation gate'
);

// 4) Capture the already-instantiated global BackendRuntimeProvider deterministically.
// BackendRuntimeModule is @Global() upstream; this adds no alternate runtime and
// does not walk private object graphs. It only keeps the real Nest instance that
// AFFiNE itself creates so MCP lifecycle tools can call the same domain command
// as the native sync gateway.
const runtimeMethodMatches = [...patchedBundle.matchAll(/async\s+executeDomainCommandV1\([^)]*\)\{/g)];
if (runtimeMethodMatches.length !== 1) {
  fail(`backend runtime capture: expected one executeDomainCommandV1 method, found ${runtimeMethodMatches.length}.`);
}
const runtimeMethodIndex = runtimeMethodMatches[0].index;
const runtimeClassIndex = patchedBundle.lastIndexOf('class ', runtimeMethodIndex);
if (runtimeClassIndex < 0) {
  fail('backend runtime capture: could not locate containing class.');
}
const runtimeConstructorMatches = [...patchedBundle.slice(runtimeClassIndex, runtimeMethodIndex).matchAll(/constructor\([^)]*\)\{/g)];
if (runtimeConstructorMatches.length !== 1) {
  fail(`backend runtime capture: expected one constructor before executeDomainCommandV1, found ${runtimeConstructorMatches.length}.`);
}
const runtimeCtor = runtimeConstructorMatches[0];
const runtimeCtorIndex = runtimeClassIndex + runtimeCtor.index;
applyExactAt(
  runtimeCtorIndex,
  runtimeCtor[0],
  `${runtimeCtor[0]}globalThis.__affineMcpBackendRuntime=this;`,
  'backend runtime capture'
);

// 5) AFFiNE upstream does not publish lifecycle tools in WorkspaceMcpProvider.
// Add exactly trash/restore/delete inside the existing READ_WRITE branch. The
// authenticated MCP context already supplies userId/workspaceId and permissions.
const metaMarker = 'update_document_meta';
const metaPositions = [];
for (let pos = patchedBundle.indexOf(metaMarker); pos !== -1; pos = patchedBundle.indexOf(metaMarker, pos + 1)) {
  metaPositions.push(pos);
}
if (metaPositions.length !== 1) {
  fail(`document lifecycle tools: expected one ${metaMarker} marker in compiled bundle, found ${metaPositions.length}.`);
}
const markerPos = metaPositions[0];

const forMatches = [...patchedBundle.slice(0, markerPos).matchAll(/async\s+for\(([^)]*)\)\{/g)];
if (!forMatches.length) {
  fail('document lifecycle tools: could not locate compiled WorkspaceMcpProvider.for signature.');
}
const forMatch = forMatches[forMatches.length - 1];
const rawParams = forMatch[1].split(',').map(value => value.trim());
const userVar = (rawParams[0] || '').match(/^([A-Za-z_$][\w$]*)/)?.[1];
const workspaceVar = (rawParams[1] || '').match(/^([A-Za-z_$][\w$]*)/)?.[1];
if (!userVar || !workspaceVar) {
  fail('document lifecycle tools: could not resolve user/workspace variables from compiled provider signature.');
}

const searchEnd = Math.min(patchedBundle.length, markerPos + 10000);
const tail = patchedBundle.slice(markerPos, searchEnd);
const pushCandidates = [...tail.matchAll(/([A-Za-z_$][\w$]*)\.push\(([^()]{1,500})\)/g)]
  .filter(match => {
    const args = match[2].split(',').map(value => value.trim());
    return args.length === 3 && args.every(value => /^[A-Za-z_$][\w$]*$/.test(value));
  });
if (pushCandidates.length < 1) {
  fail('document lifecycle tools: could not locate compiled write-tool push call.');
}
const pushMatch = pushCandidates[0];
const toolsVar = pushMatch[1];
const pushIndex = markerPos + pushMatch.index;
const pushCall = pushMatch[0];

const lifecycleTool = (name, title, lifecycle, permission, description) => `{
name:${JSON.stringify(name)},
title:${JSON.stringify(title)},
description:${JSON.stringify(description)},
inputSchema:{type:\"object\",properties:{docId:{type:\"string\",description:\"The document ID\"}},required:[\"docId\"],additionalProperties:false},
execute:async(e,t)=>{if(t&&t.signal&&t.signal.aborted)return{isError:true,content:[{type:\"text\",text:\"Request aborted.\"}]};let n=e&&e.docId;if(typeof n!==\"string\"||!n)return{isError:true,content:[{type:\"text\",text:\"Invalid arguments: docId is required\"}]};try{await this.ac.user(${userVar}).workspace(${workspaceVar}).doc(n).assert(${JSON.stringify(permission)});let u=globalThis.__affineMcpBackendRuntime;if(!u||typeof u.executeDomainCommandV1!==\"function\")throw new Error(\"AFFiNE BackendRuntimeProvider is not initialized\");let r=await u.executeDomainCommandV1({command:\"apply_doc_lifecycle\",actorUserId:${userVar},workspaceId:${workspaceVar},docId:n,lifecycle:${JSON.stringify(lifecycle)}});return{content:[{type:\"text\",text:JSON.stringify({success:true,docId:n,lifecycle:${JSON.stringify(lifecycle)},result:r})}]}}catch(e){return{isError:true,content:[{type:\"text\",text:${JSON.stringify(`Failed to ${lifecycle} document: `)}+(e instanceof Error?e.message:String(e))}]}}}
}`;

const injected = `;${toolsVar}.push(${[
  lifecycleTool('trash_document', 'Trash Document', 'trash', 'Doc.Trash', 'Move a document to the AFFiNE trash using AFFiNE native document lifecycle handling.'),
  lifecycleTool('restore_document', 'Restore Document', 'restore', 'Doc.Restore', 'Restore a document from the AFFiNE trash using AFFiNE native document lifecycle handling.'),
  lifecycleTool('delete_document', 'Delete Document', 'delete', 'Doc.Delete', 'Permanently delete a document using AFFiNE native document lifecycle handling. This cannot be undone.'),
].join(',')})`;
applyExactAt(pushIndex, pushCall, pushCall + injected, 'document lifecycle tools');

// Hard verification: only explicitly recorded substitutions are allowed.
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
  'trash_document',
  'restore_document',
  'delete_document',
  'apply_doc_lifecycle',
  'Doc.Trash',
  'Doc.Restore',
  'Doc.Delete',
  '__affineMcpBackendRuntime'
]) {
  if (!patchedBundle.includes(marker)) {
    fail(`Tool marker disappeared: ${marker}`);
  }
}

fs.writeFileSync(bundlePath, patchedBundle);
console.log('[AFFiNE MCP Patch] Enabled READ_WRITE and native trash/restore/delete tools through the authenticated MCP context.');
