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
const originalBundle = fs.readFileSync(bundlePath, 'utf8');
let patchedBundle = originalBundle;
const changes = [];

function sourceEntryEndingWith(suffix) {
  const matches = map.sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => source.endsWith(suffix));
  if (matches.length !== 1) {
    fail(`Expected exactly one ${suffix}, found ${matches.length}.`);
  }
  return {
    ...matches[0],
    content: map.sourcesContent?.[matches[0].index] || '',
  };
}

function sourceEndingWith(suffix) {
  return sourceEntryEndingWith(suffix).content;
}

const providerSource = sourceEndingWith('plugins/copilot/mcp/provider.ts');
const resolverSource = sourceEndingWith('plugins/copilot/mcp/resolver.ts');
const writerSource = sourceEndingWith('core/doc/writer.ts');
const workspaceAdapterSource = sourceEndingWith('core/doc/adapters/workspace.ts');
const docModelSource = sourceEndingWith('models/doc.ts');

for (const marker of [
  'McpAccessMode.READ_WRITE',
  'env.namespaces.canary',
  "name: 'create_document'",
  "name: 'update_document'",
  "name: 'update_document_meta'",
  "assert('Workspace.Read')",
  'await this.writer.updateDocMeta('
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
  'this.storage.getDoc(workspaceId, workspaceId)',
  'this.storage.pushDocUpdates('
]) {
  if (!writerSource.includes(marker)) {
    fail(`DocWriter structure changed; missing marker: ${marker}`);
  }
}
if (!workspaceAdapterSource.includes('this.models.doc.exists(workspaceId, docId)')) {
  fail('Workspace adapter structure changed; Models receiver marker is missing.');
}
if (!docModelSource.includes('this.db.snapshot.deleteMany(ident)')) {
  fail('DocModel structure changed; database receiver marker is missing.');
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeVlq(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = BASE64.indexOf(ch);
    if (digit < 0) fail(`Invalid source-map VLQ character: ${ch}`);
    const continuation = digit & 32;
    value += (digit & 31) << shift;
    if (continuation) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    value >>= 1;
    values.push(negative ? -value : value);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) fail('Unterminated source-map VLQ segment.');
  return values;
}

function generatedOffsetForOriginal(sourceSuffix, needle) {
  const entry = sourceEntryEndingWith(sourceSuffix);
  const pos = entry.content.indexOf(needle);
  if (pos < 0) {
    fail(`Source-map locator: needle not found in ${sourceSuffix}: ${needle}`);
  }
  const before = entry.content.slice(0, pos);
  const originalLine = (before.match(/\n/g) || []).length;
  const lastNl = before.lastIndexOf('\n');
  const originalColumn = pos - (lastNl + 1);

  let previousSource = 0;
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;
  let previousName = 0;
  let best = null;
  const mappingLines = map.mappings.split(';');

  for (let generatedLine = 0; generatedLine < mappingLines.length; generatedLine++) {
    let generatedColumn = 0;
    for (const segment of mappingLines[generatedLine].split(',')) {
      if (!segment) continue;
      const values = decodeVlq(segment);
      generatedColumn += values[0];
      if (values.length < 4) continue;
      previousSource += values[1];
      previousOriginalLine += values[2];
      previousOriginalColumn += values[3];
      if (values.length >= 5) previousName += values[4];
      if (previousSource !== entry.index) continue;
      const distance =
        Math.abs(previousOriginalLine - originalLine) * 100000 +
        Math.abs(previousOriginalColumn - originalColumn);
      if (!best || distance < best.distance) {
        best = { generatedLine, generatedColumn, distance };
      }
    }
  }

  if (!best) {
    fail(`Source-map locator: no generated mapping found for ${sourceSuffix}.`);
  }
  const lineStarts = [0];
  for (let i = 0; i < originalBundle.length; i++) {
    if (originalBundle.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  if (best.generatedLine >= lineStarts.length) {
    fail('Source-map locator: generated line exceeds bundle length.');
  }
  return lineStarts[best.generatedLine] + best.generatedColumn;
}

function nearestMatch(sourceSuffix, needle, regex, label, radius = 5000) {
  const offset = generatedOffsetForOriginal(sourceSuffix, needle);
  const start = Math.max(0, offset - radius);
  const end = Math.min(originalBundle.length, offset + radius);
  const window = originalBundle.slice(start, end);
  const matches = [...window.matchAll(regex)];
  if (matches.length < 1) {
    fail(`${label}: no compiled match near source-map location.`);
  }
  let best = null;
  for (const match of matches) {
    const absoluteIndex = start + match.index;
    const distance = Math.abs(absoluteIndex - offset);
    if (!best || distance < best.distance) {
      best = { match, absoluteIndex, distance };
    }
  }
  if (!best || best.distance > radius) {
    fail(`${label}: nearest compiled match is outside expected window.`);
  }
  return best.match;
}

const writerProp = nearestMatch(
  'plugins/copilot/mcp/provider.ts',
  'await this.writer.updateDocMeta(',
  /this\.([A-Za-z_$][\w$]*)\.updateDocMeta\(/g,
  'MCP writer property'
)[1];
const storageProp = nearestMatch(
  'core/doc/writer.ts',
  'this.storage.getDoc(workspaceId, workspaceId)',
  /this\.([A-Za-z_$][\w$]*)\.getDoc\(/g,
  'DocWriter storage property'
)[1];
const modelsProp = nearestMatch(
  'core/doc/adapters/workspace.ts',
  'this.models.doc.exists(workspaceId, docId)',
  /this\.([A-Za-z_$][\w$]*)\.doc\.exists\(/g,
  'Workspace adapter Models property'
)[1];
const dbProp = nearestMatch(
  'models/doc.ts',
  'this.db.snapshot.deleteMany(ident)',
  /this\.([A-Za-z_$][\w$]*)\.snapshot\.deleteMany\(/g,
  'DocModel database property'
)[1];

function applyUnique(regex, replacer, label) {
  const matches = [...patchedBundle.matchAll(regex)];
  if (matches.length !== 1) {
    fail(`${label}: expected exactly one compiled match, found ${matches.length}.`);
  }
  const match = matches[0];
  const original = match[0];
  const replacement = typeof replacer === 'function' ? replacer(match) : replacer;
  if (!replacement || replacement === original) {
    fail(`${label}: refusing no-op patch.`);
  }
  patchedBundle =
    patchedBundle.slice(0, match.index) +
    replacement +
    patchedBundle.slice(match.index + original.length);
  changes.push({ label, original, replacement });
}

function applyExactAt(index, original, replacement, label) {
  if (index < 0 || patchedBundle.slice(index, index + original.length) !== original) {
    fail(`${label}: target fragment changed before patching.`);
  }
  if (!replacement || replacement === original) {
    fail(`${label}: refusing no-op patch.`);
  }
  patchedBundle =
    patchedBundle.slice(0, index) +
    replacement +
    patchedBundle.slice(index + original.length);
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

const lifecycleTool = (name, title, lifecycle, permission, description) => `{
name:${JSON.stringify(name)},
title:${JSON.stringify(title)},
description:${JSON.stringify(description)},
inputSchema:{type:\"object\",properties:{docId:{type:\"string\",description:\"The document ID\"}},required:[\"docId\"],additionalProperties:false},
execute:async(__affineMcpArgs,__affineMcpOptions)=>{if(__affineMcpOptions&&__affineMcpOptions.signal&&__affineMcpOptions.signal.aborted)return{isError:true,content:[{type:\"text\",text:\"Request aborted.\"}]};let __affineMcpDocId=__affineMcpArgs&&__affineMcpArgs.docId;if(typeof __affineMcpDocId!==\"string\"||!__affineMcpDocId)return{isError:true,content:[{type:\"text\",text:\"Invalid arguments: docId is required\"}]};try{if(__affineMcpDocId===${workspaceVar})throw new Error(\"Cannot change lifecycle of workspace root document\");await this.ac.user(${userVar}).workspace(${workspaceVar}).doc(__affineMcpDocId).assert(${JSON.stringify(permission)});let __affineMcpWriter=this.${writerProp};let __affineMcpStorage=__affineMcpWriter&&__affineMcpWriter.${storageProp};if(!__affineMcpStorage||typeof __affineMcpStorage.getDoc!==\"function\"||typeof __affineMcpStorage.pushDocUpdates!==\"function\")throw new Error(\"AFFiNE workspace storage is unavailable\");let __affineMcpRoot=await __affineMcpStorage.getDoc(${workspaceVar},${workspaceVar});if(!__affineMcpRoot||!__affineMcpRoot.bin)throw new Error(\"Workspace root document not found\");let __affineMcpY=require(\"yjs\");let __affineMcpYDoc=new __affineMcpY.Doc();let __affineMcpRootBin=Buffer.isBuffer(__affineMcpRoot.bin)?__affineMcpRoot.bin:Buffer.from(__affineMcpRoot.bin.buffer,__affineMcpRoot.bin.byteOffset,__affineMcpRoot.bin.byteLength);__affineMcpY.applyUpdate(__affineMcpYDoc,__affineMcpRootBin);let __affineMcpState=__affineMcpY.encodeStateVector(__affineMcpYDoc);let __affineMcpMeta=__affineMcpYDoc.getMap(\"meta\");let __affineMcpPages=__affineMcpMeta.get(\"pages\");if(!__affineMcpPages||typeof __affineMcpPages.get!==\"function\"||typeof __affineMcpPages.delete!==\"function\")throw new Error(\"Workspace root pages are unavailable\");let __affineMcpIndex=-1;for(let __affineMcpI=0;__affineMcpI<__affineMcpPages.length;__affineMcpI++){let __affineMcpPage=__affineMcpPages.get(__affineMcpI);if(__affineMcpPage&&typeof __affineMcpPage.get===\"function\"&&__affineMcpPage.get(\"id\")===__affineMcpDocId){__affineMcpIndex=__affineMcpI;break}}if(__affineMcpIndex<0)throw new Error(\"Document not found in workspace root\");let __affineMcpPage=__affineMcpPages.get(__affineMcpIndex);if(${JSON.stringify(lifecycle)}===\"trash\"){if(typeof __affineMcpPage.set!==\"function\")throw new Error(\"Document metadata is invalid\");__affineMcpPage.set(\"trash\",true);__affineMcpPage.set(\"trashDate\",Date.now())}else if(${JSON.stringify(lifecycle)}===\"restore\"){if(typeof __affineMcpPage.set!==\"function\")throw new Error(\"Document metadata is invalid\");__affineMcpPage.set(\"trash\",false);if(typeof __affineMcpPage.delete===\"function\")__affineMcpPage.delete(\"trashDate\")}else{__affineMcpPages.delete(__affineMcpIndex,1)}let __affineMcpDelta=__affineMcpY.encodeStateAsUpdate(__affineMcpYDoc,__affineMcpState);let __affineMcpTimestamp=await __affineMcpStorage.pushDocUpdates(${workspaceVar},${workspaceVar},[__affineMcpDelta],${userVar});if(typeof __affineMcpWriter.emitDocUpdatesPushed===\"function\")__affineMcpWriter.emitDocUpdatesPushed({spaceId:${workspaceVar},docId:${workspaceVar},updates:[__affineMcpDelta],timestamp:__affineMcpTimestamp,editor:${userVar}});if(${JSON.stringify(lifecycle)}===\"delete\"){let __affineMcpModels=__affineMcpStorage.${modelsProp};if(!__affineMcpModels||!__affineMcpModels.doc)throw new Error(\"AFFiNE models are unavailable\");let __affineMcpDb=__affineMcpModels.doc.${dbProp};if(!__affineMcpDb)throw new Error(\"AFFiNE database handle is unavailable\");await __affineMcpDb.reply.deleteMany({where:{workspaceId:${workspaceVar},docId:__affineMcpDocId}});await __affineMcpDb.comment.deleteMany({where:{workspaceId:${workspaceVar},docId:__affineMcpDocId}});await __affineMcpModels.doc.delete(${workspaceVar},__affineMcpDocId);await __affineMcpDb.docGrant.deleteMany({where:{workspaceId:${workspaceVar},docId:__affineMcpDocId}});await __affineMcpDb.docAccessPolicy.deleteMany({where:{workspaceId:${workspaceVar},docId:__affineMcpDocId}});await __affineMcpDb.workspaceDoc.deleteMany({where:{workspaceId:${workspaceVar},docId:__affineMcpDocId}})}return{content:[{type:\"text\",text:JSON.stringify({success:true,docId:__affineMcpDocId,lifecycle:${JSON.stringify(lifecycle)}})}]}}catch(__affineMcpError){return{isError:true,content:[{type:\"text\",text:${JSON.stringify(`Failed to ${lifecycle} document: `)}+(__affineMcpError instanceof Error?__affineMcpError.message:String(__affineMcpError))}]}}}
}`;

const injected = `;${toolsVar}.push(${[
  lifecycleTool('trash_document', 'Trash Document', 'trash', 'Doc.Trash', 'Move a document to the AFFiNE trash.'),
  lifecycleTool('restore_document', 'Restore Document', 'restore', 'Doc.Restore', 'Restore a document from the AFFiNE trash.'),
  lifecycleTool('delete_document', 'Delete Document', 'delete', 'Doc.Delete', 'Permanently delete a document. This cannot be undone.'),
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
  'Doc.Trash',
  'Doc.Restore',
  'Doc.Delete',
  'Workspace root pages are unavailable'
]) {
  if (!patchedBundle.includes(marker)) {
    fail(`Tool marker disappeared: ${marker}`);
  }
}

fs.writeFileSync(bundlePath, patchedBundle);
console.log(`[AFFiNE MCP Patch] Enabled READ_WRITE and Stable-compatible lifecycle tools (writer=${writerProp}, storage=${storageProp}, models=${modelsProp}, db=${dbProp}).`);
