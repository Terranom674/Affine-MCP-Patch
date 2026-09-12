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

// 1. Verify the upstream source semantically. This deliberately does not care
// about the AFFiNE version number.
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const providerIndexes = map.sources
  .map((source, index) => ({ source, index }))
  .filter(({ source }) => source.endsWith('plugins/copilot/mcp/provider.ts'));

if (providerIndexes.length !== 1) {
  fail(`Expected exactly one MCP provider source, found ${providerIndexes.length}.`);
}

const providerSource = map.sourcesContent?.[providerIndexes[0].index] || '';
const requiredMarkers = [
  'McpAccessMode.READ_WRITE',
  'env.namespaces.canary',
  "name: 'create_document'",
  "name: 'update_document'",
  "name: 'update_document_meta'"
];

for (const marker of requiredMarkers) {
  if (!providerSource.includes(marker)) {
    fail(`Upstream MCP structure changed; missing source marker: ${marker}`);
  }
}

const gateSourcePattern = /accessMode\s*===\s*McpAccessMode\.READ_WRITE\s*&&\s*\(\s*env\.dev\s*\|\|\s*env\.namespaces\.canary\s*\)/m;
const sourceGateMatches = providerSource.match(new RegExp(gateSourcePattern.source, 'gm')) || [];

if (sourceGateMatches.length !== 1) {
  fail(`Expected exactly one known MCP write gate in source, found ${sourceGateMatches.length}.`);
}

// 2. Patch ONLY the compiled MCP write condition.
const originalBundle = fs.readFileSync(bundlePath, 'utf8');

for (const marker of ['create_document', 'update_document', 'update_document_meta']) {
  if (!originalBundle.includes(marker)) {
    fail(`Compiled bundle does not contain expected tool marker: ${marker}`);
  }
}

// Bundlers may compile imported objects as namespaced member chains, e.g.
// prisma_client.McpAccessMode.READ_WRITE and env_module.env.namespaces.canary.
// Accept those ordinary representation changes, but still require exactly one
// complete gate with the same accessMode/env pair.
const ident = '[A-Za-z_$][\\w$]*';
const chain = `${ident}(?:\\.${ident})*`;
const compiledGate = new RegExp(
  `(${chain})\\s*===\\s*(${chain})\\.READ_WRITE\\s*&&\\s*\\(\\s*(${chain})\\.dev\\s*\\|\\|\\s*\\3\\.namespaces\\.canary\\s*\\)`,
  'g'
);
const matches = [...originalBundle.matchAll(compiledGate)];

if (matches.length !== 1) {
  const canaryPos = originalBundle.indexOf('.namespaces.canary');
  const context = canaryPos >= 0
    ? originalBundle.slice(Math.max(0, canaryPos - 220), Math.min(originalBundle.length, canaryPos + 220))
    : 'no .namespaces.canary marker in bundle';
  fail(`Could not identify one unique compiled MCP write gate; found ${matches.length}. Context: ${context}`);
}

const match = matches[0];
const originalGate = match[0];
const replacementGate = `${match[1]}===${match[2]}.READ_WRITE&&(${match[3]}.dev||${match[3]}.namespaces.canary||process.env.AFFINE_MCP_WRITE_ENABLED==="true")`;

if (originalGate === replacementGate) {
  fail('Refusing no-op patch.');
}

const patchedBundle =
  originalBundle.slice(0, match.index) +
  replacementGate +
  originalBundle.slice(match.index + originalGate.length);

// 3. Hard verification: reconstruct the only allowed change and require the
// resulting bundle to match it byte-for-byte. This guarantees that this script
// changes nothing in AFFiNE except the single MCP write condition.
const expectedBundle = originalBundle.replace(originalGate, replacementGate);
if (patchedBundle !== expectedBundle) {
  fail('Patch verification failed: bundle contains changes outside the MCP write condition.');
}

const reverseCheck = patchedBundle.replace(replacementGate, originalGate);
if (reverseCheck !== originalBundle) {
  fail('Patch verification failed: patch is not exactly reversible to the upstream bundle.');
}

const replacementOccurrences = patchedBundle.split(replacementGate).length - 1;
if (replacementOccurrences !== 1) {
  fail(`Patch verification failed: patched write condition occurs ${replacementOccurrences} times.`);
}

for (const marker of ['create_document', 'update_document', 'update_document_meta']) {
  if (!patchedBundle.includes(marker)) {
    fail(`Patch verification failed: tool marker disappeared: ${marker}`);
  }
}

fs.writeFileSync(bundlePath, patchedBundle);
console.log('[AFFiNE MCP Patch] Applied exactly one change: MCP READ_WRITE condition extended with AFFINE_MCP_WRITE_ENABLED.');
