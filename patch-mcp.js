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
  fail('Expected exactly one READ_WRITE credential creation guard in source.');
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
  const sourceMatches = map.sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => source.endsWith(sourceSuffix));
  if (sourceMatches.length !== 1) {
    fail(`Source-map locator: expected one ${sourceSuffix}, found ${sourceMatches.length}.`);
  }
  const sourceIndex = sourceMatches[0].index;
  const source = map.sourcesContent?.[sourceIndex] || '';
  const pos = source.indexOf(needle);
  if (pos < 0) fail(`Source-map locator: needle not found in ${sourceSuffix}: ${needle}`);
  const before = source.slice(0, pos);
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
    const segments = mappingLines[generatedLine].split(',');
    for (const segment of segments) {
      if (!segment) continue;
      const values = decodeVlq(segment);
      generatedColumn += values[0];
      if (values.length >= 4) {
        previousSource += values[1];
        previousOriginalLine += values[2];
        previousOriginalColumn += values[3];
        if (values.length >= 5) previousName += values[4];
        if (previousSource === sourceIndex) {
          const distance = Math.abs(previousOriginalLine - originalLine) * 100000 + Math.abs(previousOriginalColumn - originalColumn);
          if (!best || distance < best.distance) {
            best = { generatedLine, generatedColumn, distance };
          }
        }
      }
    }
  }

  if (!best) fail(`Source-map locator: no generated mapping found for ${sourceSuffix}.`);
  const lineStarts = [0];
  for (let i = 0; i < patchedBundle.length; i++) {
    if (patchedBundle.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  if (best.generatedLine >= lineStarts.length) fail('Source-map locator: generated line exceeds bundle length.');
  return lineStarts[best.generatedLine] + best.generatedColumn;
}

// Locate PermissionService's authorization call through the source map without
// assuming the source-level DI property is named "runtime". Only the stable
// method name is used as the source anchor; the generated receiver is then
// discovered next to that mapping.
const permissionRuntimeOffset = generatedOffsetForOriginal(
  'core/permission/service.ts',
  '.authorizePermissionV1'
);
const permissionWindowStart = Math.max(0, permissionRuntimeOffset - 1200);
const permissionWindowEnd = Math.min(patchedBundle.length, permissionRuntimeOffset + 1200);
const permissionWindow = patchedBundle.slice(permissionWindowStart, permissionWindowEnd);
const permissionCandidates = [...permissionWindow.matchAll(/((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.authorizePermissionV1\(/g)];
if (permissionCandidates.length < 1) {
  fail('PermissionService runtime capture: no authorizePermissionV1 receiver near source-map location.');
}
let permissionCandidate = null;
let permissionDistance = Infinity;
for (const candidate of permissionCandidates) {
  const absoluteIndex = permissionWindowStart + candidate.index;
  const distance = Math.abs(absoluteIndex - permissionRuntimeOffset);
  if (distance < permissionDistance) {
    permissionDistance = distance;
    permissionCandidate = { match: candidate, absoluteIndex };
  }
}
if (!permissionCandidate || permissionDistance > 1200) {
  fail('PermissionService runtime capture: nearest authorizePermissionV1 receiver is outside expected source-map window.');
}
const permissionOriginal = permissionCandidate.match[0];
const permissionReceiver = permissionCandidate.match[1];
const permissionReplacement = `(globalThis.__affineMcpBackendRuntime=${permissionReceiver}).authorizePermissionV1(`;
applyExactAt(
  permissionCandidate.absoluteIndex,
  permissionOriginal,
  permissionReplacement,
  'permission service backend runtime capture'
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
execute:async(__affineMcpArgs,__affineMcpOptions)=>{if(__affineMcpOptions&&__affineMcpOptions.signal&&__affineMcpOptions.signal.aborted)return{isError:true,content:[{type:\"text\",text:\"Request aborted.\"}]};let __affineMcpDocId=__affineMcpArgs&&__affineMcpArgs.docId;if(typeof __affineMcpDocId!==\"string\"||!__affineMcpDocId)return{isError:true,content:[{type:\"text\",text:\"Invalid arguments: docId is required\"}]};try{await this.ac.user(${userVar}).workspace(${workspaceVar}).doc(__affineMcpDocId).assert(${JSON.stringify(permission)});let __affineMcpRuntime=globalThis.__affineMcpBackendRuntime;if(!__affineMcpRuntime||typeof __affineMcpRuntime.executeDomainCommandV1!==\"function\")throw new Error(\"AFFiNE backend runtime is unavailable\");let __affineMcpResult=await __affineMcpRuntime.executeDomainCommandV1({command:\"apply_doc_lifecycle\",actorUserId:${userVar},workspaceId:${workspaceVar},docId:__affineMcpDocId,lifecycle:${JSON.stringify(lifecycle)}});return{content:[{type:\"text\",text:JSON.stringify({success:true,docId:__affineMcpDocId,lifecycle:${JSON.stringify(lifecycle)},result:__affineMcpResult})}]}}catch(__affineMcpError){return{isError:true,content:[{type:\"text\",text:${JSON.stringify(`Failed to ${lifecycle} document: `)}+(__affineMcpError instanceof Error?__affineMcpError.message:String(__affineMcpError))}]}}}
}`;

const injected = `;${toolsVar}.push(${[
  lifecycleTool('trash_document', 'Trash Document', 'trash', 'Doc.Trash', 'Move a document to the AFFiNE trash using AFFiNE native document lifecycle handling.'),
  lifecycleTool('restore_document', 'Restore Document', 'restore', 'Doc.Restore', 'Restore a document from the AFFiNE trash using AFFiNE native document lifecycle handling.'),
  lifecycleTool('delete_document', 'Delete Document', 'delete', 'Doc.Delete', 'Permanently delete a document using AFFiNE native document lifecycle handling. This cannot be undone.'),
].join(',')})`;
applyExactAt(pushIndex, pushCall, pushCall + injected, 'document lifecycle tools');

for (const marker of [
  'create_document',
  'update_document',
  'update_document_meta',
  'trash_document',
  'restore_document',
  'delete_document',
  'apply_doc_lifecycle',
  '__affineMcpBackendRuntime',
  'Doc.Trash',
  'Doc.Restore',
  'Doc.Delete'
]) {
  if (!patchedBundle.includes(marker)) {
    fail(`Tool marker disappeared: ${marker}`);
  }
}

fs.writeFileSync(bundlePath, patchedBundle);
console.log('[AFFiNE MCP Patch] Enabled READ_WRITE and native trash/restore/delete tools through source-map-located PermissionService runtime.');
