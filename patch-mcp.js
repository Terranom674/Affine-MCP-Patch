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
const writerSource = sourceEndingWith('core/doc/writer.ts');
const gatewaySource = sourceEndingWith('core/sync/gateway.ts');
const workspaceAdapterSource = sourceEndingWith('core/doc/adapters/workspace.ts');

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
  'private readonly storage: PgWorkspaceDocStorageAdapter',
  'this.storage.getDoc(workspaceId, workspaceId)',
  'this.storage.pushDocUpdates(',
  'private emitDocUpdatesPushed('
]) {
  if (!writerSource.includes(marker)) {
    fail(`DocWriter structure changed; missing marker: ${marker}`);
  }
}

for (const marker of [
  "@SubscribeMessage('space:delete-doc')",
  "'Doc.Delete'",
  'await adapter.delete(spaceId, docId)'
]) {
  if (!gatewaySource.includes(marker)) {
    fail(`Stable delete path changed; missing gateway marker: ${marker}`);
  }
}

for (const marker of [
  'async deleteDoc(_workspaceId: string, _docId: string)',
  'return;'
]) {
  if (!workspaceAdapterSource.includes(marker)) {
    fail(`Workspace delete adapter changed; missing marker: ${marker}`);
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

// Existing MCP READ_WRITE gates.
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

// Locate the authenticated MCP workspace context and native write-tool push.
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

// AFFiNE stable permanent-delete semantics:
// WorkspaceImpl.removeDoc -> WorkspaceMetaImpl.removeDocMeta + DocImpl.remove.
// That means removing the page from root meta.pages and the legacy subdoc from root spaces.
// No custom database cleanup is performed because stable AFFiNE itself does not do that here.
const deleteTool = `{
name:\"delete_document\",
title:\"Delete Document\",
description:\"Permanently delete a document using AFFiNE stable's own removeDoc semantics. This cannot be undone.\",
inputSchema:{type:\"object\",properties:{docId:{type:\"string\",description:\"The ID of the document to delete\"}},required:[\"docId\"],additionalProperties:false},
execute:async(__affineMcpArgs,__affineMcpOptions)=>{if(__affineMcpOptions&&__affineMcpOptions.signal&&__affineMcpOptions.signal.aborted)return{isError:true,content:[{type:\"text\",text:\"Request aborted.\"}]};let __affineMcpDocId=__affineMcpArgs&&__affineMcpArgs.docId;if(typeof __affineMcpDocId!==\"string\"||!__affineMcpDocId)return{isError:true,content:[{type:\"text\",text:\"Invalid arguments: docId is required\"}]};if(__affineMcpDocId===${workspaceVar})return{isError:true,content:[{type:\"text\",text:\"Workspace root document cannot be deleted\"}]};try{let __affineMcpAccessible=await this.ac.user(${userVar}).workspace(${workspaceVar}).doc(__affineMcpDocId).can(\"Doc.Delete\");if(!__affineMcpAccessible)return{isError:true,content:[{type:\"text\",text:\"Doc with id \"+__affineMcpDocId+\" not found.\"}]};if(__affineMcpOptions&&__affineMcpOptions.signal&&__affineMcpOptions.signal.aborted)return{isError:true,content:[{type:\"text\",text:\"Request aborted.\"}]};let __affineMcpWriter=this.writer;if(!__affineMcpWriter||!__affineMcpWriter.storage||typeof __affineMcpWriter.storage.getDoc!==\"function\"||typeof __affineMcpWriter.storage.pushDocUpdates!==\"function\")throw new Error(\"AFFiNE DocWriter storage is unavailable\");let __affineMcpRoot=await __affineMcpWriter.storage.getDoc(${workspaceVar},${workspaceVar});if(!__affineMcpRoot||!__affineMcpRoot.bin)throw new Error(\"Workspace root document is unavailable\");let __affineMcpY=require(\"/opt/affine-mcp-patch/node_modules/yjs\");let __affineMcpRootBin=Buffer.isBuffer(__affineMcpRoot.bin)?__affineMcpRoot.bin:Buffer.from(__affineMcpRoot.bin.buffer,__affineMcpRoot.bin.byteOffset,__affineMcpRoot.bin.byteLength);let __affineMcpYDoc=new __affineMcpY.Doc();__affineMcpY.applyUpdate(__affineMcpYDoc,__affineMcpRootBin);let __affineMcpMeta=__affineMcpYDoc.getMap(\"meta\");let __affineMcpPages=__affineMcpMeta.get(\"pages\");if(!__affineMcpPages||typeof __affineMcpPages.toArray!==\"function\"||typeof __affineMcpPages.delete!==\"function\")throw new Error(\"AFFiNE workspace meta.pages is unavailable\");let __affineMcpItems=__affineMcpPages.toArray();let __affineMcpIndex=-1;for(let __affineMcpI=0;__affineMcpI<__affineMcpItems.length;__affineMcpI++){let __affineMcpItem=__affineMcpItems[__affineMcpI];let __affineMcpItemId=__affineMcpItem&&typeof __affineMcpItem.get===\"function\"?__affineMcpItem.get(\"id\"):__affineMcpItem&&__affineMcpItem.id;if(__affineMcpItemId===__affineMcpDocId){__affineMcpIndex=__affineMcpI;break}}if(__affineMcpIndex<0)return{isError:true,content:[{type:\"text\",text:\"Doc with id \"+__affineMcpDocId+\" not found.\"}]};let __affineMcpState=__affineMcpY.encodeStateVector(__affineMcpYDoc);__affineMcpYDoc.transact(()=>{__affineMcpPages.delete(__affineMcpIndex,1);let __affineMcpSpaces=__affineMcpYDoc.getMap(\"spaces\");if(__affineMcpSpaces&&typeof __affineMcpSpaces.delete===\"function\")__affineMcpSpaces.delete(__affineMcpDocId)},__affineMcpYDoc.clientID);let __affineMcpUpdate=__affineMcpY.encodeStateAsUpdate(__affineMcpYDoc,__affineMcpState);if(!__affineMcpUpdate||__affineMcpUpdate.length===0)throw new Error(\"AFFiNE removeDoc produced no root update\");if(__affineMcpOptions&&__affineMcpOptions.signal&&__affineMcpOptions.signal.aborted)return{isError:true,content:[{type:\"text\",text:\"Request aborted.\"}]};let __affineMcpTimestamp=await __affineMcpWriter.storage.pushDocUpdates(${workspaceVar},${workspaceVar},[__affineMcpUpdate],${userVar});if(typeof __affineMcpWriter.emitDocUpdatesPushed===\"function\")__affineMcpWriter.emitDocUpdatesPushed({spaceId:${workspaceVar},docId:${workspaceVar},updates:[__affineMcpUpdate],timestamp:__affineMcpTimestamp,editor:${userVar}});return{content:[{type:\"text\",text:JSON.stringify({success:true,docId:__affineMcpDocId,message:\"Document deleted using AFFiNE stable removeDoc semantics\"})}]}}catch(__affineMcpError){return{isError:true,content:[{type:\"text\",text:\"Failed to delete document: \"+(__affineMcpError instanceof Error?__affineMcpError.message:String(__affineMcpError))}]}}}
}`;

applyExactAt(pushIndex, pushCall, `${pushCall};${toolsVar}.push(${deleteTool})`, 'delete_document adapter');

// Hard verification. Nothing outside the recorded changes may differ.
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
  '/opt/affine-mcp-patch/node_modules/yjs',
  'meta.pages',
  'removeDoc'
]) {
  if (!patchedBundle.includes(marker)) {
    fail(`Required marker disappeared: ${marker}`);
  }
}

fs.writeFileSync(bundlePath, patchedBundle);
console.log('[AFFiNE MCP Patch] Enabled MCP WRITE gates and added delete_document using AFFiNE stable removeDoc semantics.');
