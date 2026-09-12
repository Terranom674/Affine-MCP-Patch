const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const manifest = JSON.parse(
  fs.readFileSync('/opt/affine-mcp-patch/versions.json', 'utf8')
);

const cfg = manifest[version];
if (!cfg) {
  throw new Error(`Unsupported AFFiNE version: ${version}`);
}

const bundlePath = path.resolve(root, cfg.bundle);
const mapPath = path.resolve(root, cfg.sourceMap);

if (!fs.existsSync(bundlePath) || !fs.existsSync(mapPath)) {
  throw new Error('Expected AFFiNE bundle or source map is missing.');
}

const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const providerIndex = map.sources.findIndex(s =>
  s.endsWith('plugins/copilot/mcp/provider.ts')
);

if (providerIndex < 0) {
  throw new Error('AFFiNE MCP provider source was not found in source map.');
}

const providerSource = map.sourcesContent?.[providerIndex] || '';
const expectedSource = [
  'accessMode === McpAccessMode.READ_WRITE',
  '(env.dev || env.namespaces.canary)',
  "name: 'create_document'",
  "name: 'update_document'",
  "name: 'update_document_meta'"
];

for (const marker of expectedSource) {
  if (!providerSource.includes(marker)) {
    throw new Error(`Expected MCP source marker missing: ${marker}`);
  }
}

const bundle = fs.readFileSync(bundlePath, 'utf8');
const bundleSha256 = crypto.createHash('sha256').update(bundle).digest('hex');

if (cfg.status !== 'ready') {
  console.error('AFFiNE MCP patch is intentionally NOT applied yet.');
  console.error(`AFFiNE version: ${version}`);
  console.error(`main.js sha256: ${bundleSha256}`);
  console.error('Capture the exact compiled MCP condition and add it to versions.json first.');
  process.exit(42);
}

if (!cfg.search || !cfg.replace || !cfg.bundleSha256) {
  throw new Error('Ready version entry is incomplete.');
}

if (bundleSha256 !== cfg.bundleSha256) {
  throw new Error(
    `Bundle hash mismatch for AFFiNE ${version}. Expected ${cfg.bundleSha256}, got ${bundleSha256}`
  );
}

const occurrences = bundle.split(cfg.search).length - 1;
if (occurrences !== 1) {
  throw new Error(`Patch signature occurrence count is ${occurrences}, expected exactly 1.`);
}

const patched = bundle.replace(cfg.search, cfg.replace);
fs.writeFileSync(bundlePath, patched);

if (!patched.includes(cfg.replace)) {
  throw new Error('Patch verification failed.');
}

console.log(`AFFiNE ${version}: MCP patch applied successfully.`);
