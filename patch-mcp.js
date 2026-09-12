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

// Do not patch if upstream already permits READ_WRITE without the dev/canary
// restriction. In that case this project is no longer needed for this gate.
const gateSourcePattern = /accessMode\s*===\s*McpAccessMode\.READ_WRITE\s*&&\s*\(\s*env\.dev\s*\|\|\s*env\.namespaces\.canary\s*\)/m;
const sourceGateMatches = providerSource.match(new RegExp(gateSourcePattern.source, 'gm')) || [];

if (sourceGateMatches.length === 0) {
  fail('The known dev/canary MCP write gate is no longer present. Review upstream before building.');
}
if (sourceGateMatches.length !== 1) {
  fail(`Expected one MCP write gate in source, found ${sourceGateMatches.length}.`);
}

// 2. Patch the compiled bundle. Webpack/minification may rename the object that
// carries env, so the pattern intentionally keys off the stable property names
// and the READ_WRITE branch shape rather than a version/hash.
let bundle = fs.readFileSync(bundlePath, 'utf8');

// The write tools must all be present in the same bundle before touching it.
for (const marker of ['create_document', 'update_document', 'update_document_meta']) {
  if (!bundle.includes(marker)) {
    fail(`Compiled bundle does not contain expected tool marker: ${marker}`);
  }
}

// Candidate condition: <accessMode>===<enum>.READ_WRITE && (<env>.dev || <env>.namespaces.canary)
// Identifiers are intentionally generic to survive ordinary minification/name changes.
const compiledGate = /([A-Za-z_$][\w$]*)===([A-Za-z_$][\w$]*)\.READ_WRITE&&\(([A-Za-z_$][\w$]*)\.dev\|\|\3\.namespaces\.canary\)/g;
const matches = [...bundle.matchAll(compiledGate)];

if (matches.length !== 1) {
  fail(`Could not identify one unique compiled MCP write gate; found ${matches.length}. Upstream likely changed.`);
}

const match = matches[0];
const original = match[0];
const replacement = `${match[1]}===${match[2]}.READ_WRITE`;

bundle = bundle.slice(0, match.index) + replacement + bundle.slice(match.index + original.length);

// 3. Verify that only the intended gate disappeared and tool markers remain.
if (bundle.includes(original)) {
  fail('Patch verification failed: original write gate still present.');
}
for (const marker of ['create_document', 'update_document', 'update_document_meta']) {
  if (!bundle.includes(marker)) {
    fail(`Patch verification failed: tool marker disappeared: ${marker}`);
  }
}

fs.writeFileSync(bundlePath, bundle);
console.log('[AFFiNE MCP Patch] MCP READ_WRITE gate patched successfully.');
