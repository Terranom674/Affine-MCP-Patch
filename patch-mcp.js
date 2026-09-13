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
const docModelSource = sourceEndingWith('models/doc.ts');

for (const marker of [
  'McpAccessMode.READ_WRITE',
  'env.namespaces.canary',
  "name: 'create_document'",
  "name: 'update_document'",
  "name: 'update_document_meta'",
  "assert('Workspace.Read')"
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
  'PgWorkspaceDocStorageAdapter',
  'pushDocUpdates(',
  'getDoc(workspaceId, workspaceId)',
  'emitDocUpdatesPushed'
]) {
  if (!writerSource.includes(marker)) {
    fail(`DocWriter structure changed; missing marker: ${marker}`);
  }
}

for (const marker of [
  'async delete(workspaceId: string, docId: string)',
  'snapshot.deleteMany',
  'update.deleteMany',
  'snapshotHistory.deleteMany'
]) {
  if (!docModelSource.includes(marker)) {
    fail(`DocModel structure changed; missing marker: ${marker}`);
  }
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

const metaMarker = 'update_document_meta';
const metaPositions = [];
for (let pos = patchedBundle.indexOf(metaMarker); pos !== -1; pos = patchedBundle.indexOf(metaMarker, pos + 1)) {
  metaPositions.push(pos);
}
if (metaPositions.length !== 1) {
  fail(`document lifecycle tools: expected one ${metaMarker} marker in compiled bundle, found ${metaPositions.length}.`);
}
const markerPos = metaPositions[0];

const contextStart = Math.max(0, markerPos - 20000);
const contextChunk = patchedBundle.slice(contextStart, markerPos);
const contextMatches = [...contextChunk.matchAll(/\.user\(([^()]+)\)\.workspace\(([^()]+)\)\.assert\((['\"])Workspace\.Read\3\)/g)];
if (contextMatches.length !== 1) {
  fail(`document lifecycle tools: expected one compiled Workspace.Read context before ${metaMarker}, found ${contextMatches.length}.`);
}
const userVar = contextMatches[0][1].trim();
const workspaceVar = contextMatches[0][2].trim();
if (!new RegExp(`^${ident}$`).test(userVar) || !new RegExp(`^${ident}$`).test(workspaceVar)) {
  fail(`document lifecycle tools: unexpected user/workspace expressions: ${userVar} / ${workspaceVar}`);
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

// Stable 0.27.x does not expose the newer native apply_doc_lifecycle runtime command.
// Backport lifecycle semantics directly through the server's existing stable services:
// - mutate root meta.pages with Yjs through DocWriter's existing storage path
// - permanently remove document data through stable DocModel.delete + related models
const lifecyclePrelude = `
let __affineMcpY;try{__affineMcpY=require(\"yjs\")}catch(__affineMcpYError){throw new Error(\"AFFiNE stable lifecycle backport requires yjs\")}
let __affineMcpWriter=this.writer;
if(!__affineMcpWriter||!__affineMcpWriter.storage)throw new Error(\"AFFiNE DocWriter storage is unavailable\");
let __affineMcpModels=__affineMcpWriter.storage.models;
if(!__affineMcpModels||!__affineMcpModels.doc)throw new Error(\"AFFiNE Models are unavailable\");
let __affineMcpRoot=await __affineMcpWriter.storage.getDoc(${workspaceVar},${workspaceVar});
if(!__affineMcpRoot||!__affineMcpRoot.bin)throw new Error(\"Workspace root document is unavailable\");
let __affineMcpRootBin=Buffer.isBuffer(__affineMcpRoot.bin)?__affineMcpRoot.bin:Buffer.from(__affineMcpRoot.bin.buffer,__affineMcpRoot.bin.byteOffset,__affineMcpRoot.bin.byteLength);
let __affineMcpYDoc=new __affineMcpY.Doc();__affineMcpY.applyUpdate(__affineMcpYDoc,__affineMcpRootBin);
let __affineMcpMeta=__affineMcpYDoc.getMap(\"meta\");let __affineMcpPages=__affineMcpMeta.get(\"pages\");
if(!__affineMcpPages||typeof __affineMcpPages.toArray!==\"function\")throw new Error(\"Workspace root meta.pages is unavailable\");
let __affineMcpPageIndex=-1;let __affineMcpPage=null;let __affineMcpPageItems=__affineMcpPages.toArray();
for(let __affineMcpI=0;__affineMcpI<__affineMcpPageItems.length;__affineMcpI++){let __affineMcpCandidate=__affineMcpPageItems[__affineMcpI];let __affineMcpCandidateId=__affineMcpCandidate&&typeof __affineMcpCandidate.get===\"function\"?__affineMcpCandidate.get(\"id\"):__affineMcpCandidate&&__affineMcpCandidate.id;if(__affineMcpCandidateId===__affineMcpDocId){__affineMcpPageIndex=__affineMcpI;__affineMcpPage=__affineMcpCandidate;break}}
if(__affineMcpPageIndex<0||!__affineMcpPage)throw new Error(\"Document is not registered in workspace root\");
`;

const mutateRoot = mutation => `${lifecyclePrelude}
let __affineMcpStateVector=__affineMcpY.encodeStateVector(__affineMcpYDoc);
${mutation}
let __affineMcpRootUpdate=__affineMcpY.encodeStateAsUpdate(__affineMcpYDoc,__affineMcpStateVector);
let __affineMcpTimestamp=await __affineMcpWriter.storage.pushDocUpdates(${workspaceVar},${workspaceVar},[__affineMcpRootUpdate],${userVar});
if(typeof __affineMcpWriter.emitDocUpdatesPushed===\"function\")__affineMcpWriter.emitDocUpdatesPushed({spaceId:${workspaceVar},docId:${workspaceVar},updates:[__affineMcpRootUpdate],timestamp:__affineMcpTimestamp,editor:${userVar}});
`;

const lifecycleTool = (name, title, permission, description, body) => `{
name:${JSON.stringify(name)},
title:${JSON.stringify(title)},
description:${JSON.stringify(description)},
inputSchema:{type:\"object\",properties:{docId:{type:\"string\",description:\"The document ID\"}},required:[\"docId\"],additionalProperties:false},
execute:async(__affineMcpArgs,__affineMcpOptions)=>{if(__affineMcpOptions&&__affineMcpOptions.signal&&__affineMcpOptions.signal.aborted)return{isError:true,content:[{type:\"text\",text:\"Request aborted.\"}]};let __affineMcpDocId=__affineMcpArgs&&__affineMcpArgs.docId;if(typeof __affineMcpDocId!==\"string\"||!__affineMcpDocId)return{isError:true,content:[{type:\"text\",text:\"Invalid arguments: docId is required\"}]};if(__affineMcpDocId===${workspaceVar})return{isError:true,content:[{type:\"text\",text:\"Workspace root document cannot be lifecycle-managed\"}]};try{await this.ac.user(${userVar}).workspace(${workspaceVar}).doc(__affineMcpDocId).assert(${JSON.stringify(permission)});${body}return{content:[{type:\"text\",text:JSON.stringify({success:true,docId:__affineMcpDocId})}]}}catch(__affineMcpError){return{isError:true,content:[{type:\"text\",text:${JSON.stringify(`Failed to ${name.replace('_document','')} document: `)}+(__affineMcpError instanceof Error?__affineMcpError.message:String(__affineMcpError))}]}}}
}`;

const trashBody = mutateRoot(`if(typeof __affineMcpPage.set!==\"function\")throw new Error(\"Workspace root page entry is not mutable\");__affineMcpPage.set(\"trash\",true);__affineMcpPage.set(\"trashDate\",Date.now());`);
const restoreBody = mutateRoot(`if(typeof __affineMcpPage.set!==\"function\")throw new Error(\"Workspace root page entry is not mutable\");__affineMcpPage.set(\"trash\",false);if(typeof __affineMcpPage.delete===\"function\")__affineMcpPage.delete(\"trashDate\");else __affineMcpPage.set(\"trashDate\",undefined);`);
const deleteBody = `${mutateRoot(`__affineMcpPages.delete(__affineMcpPageIndex,1);`)}
await __affineMcpModels.comment.db.reply.deleteMany({where:{workspaceId:${workspaceVar},docId:__affineMcpDocId}});
await __affineMcpModels.comment.db.comment.deleteMany({where:{workspaceId:${workspaceVar},docId:__affineMcpDocId}});
await __affineMcpModels.docGrant.db.docGrant.deleteMany({where:{workspaceId:${workspaceVar},docId:__affineMcpDocId}});
await __affineMcpModels.docAccessPolicy.db.docAccessPolicy.deleteMany({where:{workspaceId:${workspaceVar},docId:__affineMcpDocId}});
await __affineMcpModels.doc.db.workspaceDoc.deleteMany({where:{workspaceId:${workspaceVar},docId:__affineMcpDocId}});
await __affineMcpModels.doc.delete(${workspaceVar},__affineMcpDocId);
`;

const injected = `;${toolsVar}.push(${[
  lifecycleTool('trash_document', 'Trash Document', 'Doc.Trash', 'Move a document to the AFFiNE trash using the Stable document metadata format.', trashBody),
  lifecycleTool('restore_document', 'Restore Document', 'Doc.Restore', 'Restore a document from the AFFiNE trash using the Stable document metadata format.', restoreBody),
  lifecycleTool('delete_document', 'Delete Document', 'Doc.Delete', 'Permanently delete a document and its Stable server-side document data. This cannot be undone.', deleteBody),
].join(',')})`;
applyExactAt(pushIndex, pushCall, pushCall + injected, 'document lifecycle tools');

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
  'trashDate',
  'Doc.Trash',
  'Doc.Restore',
  'Doc.Delete'
]) {
  if (!patchedBundle.includes(marker)) {
    fail(`Tool marker disappeared: ${marker}`);
  }
}

fs.writeFileSync(bundlePath, patchedBundle);
console.log('[AFFiNE MCP Patch] Enabled READ_WRITE and Stable trash/restore/delete lifecycle tools.');
