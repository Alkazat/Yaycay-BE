/**
 * Contract self-check: parse + dereference the OpenAPI spec, and compile the
 * trip-content JSON schema. Run in CI so a malformed contract never publishes.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let failures = 0;

async function checkOpenApi() {
  const path = join(root, 'openapi.yaml');
  try {
    const api = await SwaggerParser.validate(path);
    const paths = Object.keys(api.paths ?? {}).length;
    console.log(`ok  openapi.yaml -> ${api.info.title} v${api.info.version} (${paths} paths)`);
  } catch (err) {
    failures += 1;
    console.error(`ERR openapi.yaml -> ${err.message}`);
  }
}

async function checkTripContentSchema() {
  const path = join(root, 'schemas', 'trip-content.schema.json');
  try {
    const schema = JSON.parse(await readFile(path, 'utf8'));
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    ajv.compile(schema);
    console.log(`ok  trip-content.schema.json -> compiles (${schema.$id})`);
  } catch (err) {
    failures += 1;
    console.error(`ERR trip-content.schema.json -> ${err.message}`);
  }
}

// ----- MCP surface drift (the hard contract) -------------------------------
// src/mcp-surface.ts is the single source of truth for the MCP tool names,
// connector default scopes, and trip_intent fields. Parse it and the live
// edge-function sources and fail on drift, so the MCP contract cannot change in
// the code without updating the shared manifest (and vice versa). See
// docs/handoff/MCP-CHANGE-PROTOCOL.md.
const repoRoot = join(root, '..', '..');

// Slice a top-level array literal: from `startMarker` to the next line-initial
// `]` (inner inline arrays like `enum: [...]` never start a line, so they are
// not mistaken for the closer).
function arrayBlock(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i === -1) return null;
  const from = i + startMarker.length;
  const end = src.indexOf('\n]', from);
  if (end === -1) return null;
  return src.slice(from, end);
}

const TOKEN = /['"]([a-z0-9_.]+)['"]/g;
const NAME = /name:\s*['"]([a-z0-9_.]+)['"]/g;

// Every quoted token in a pure string-array block.
function quotedList(src, startMarker) {
  const block = arrayBlock(src, startMarker);
  if (block === null) return null;
  return [...block.matchAll(TOKEN)].map((m) => m[1]);
}

// Just the `name: '...'` values in a block (for the TOOLS array, whose entries
// also carry quoted type/enum tokens we must ignore).
function nameList(src, startMarker) {
  const block = arrayBlock(src, startMarker);
  if (block === null) return null;
  return [...block.matchAll(NAME)].map((m) => m[1]);
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

function compare(label, manifest, live) {
  if (manifest === null || live === null) {
    failures += 1;
    console.error(`ERR mcp-surface -> could not locate ${label} (manifest or live source)`);
    return;
  }
  if (sameSet(manifest, live)) {
    console.log(`ok  mcp-surface -> ${label} matches the manifest (${manifest.length})`);
    return;
  }
  failures += 1;
  const missing = manifest.filter((x) => !live.includes(x));
  const extra = live.filter((x) => !manifest.includes(x));
  console.error(
    `ERR mcp-surface -> ${label} drifted from src/mcp-surface.ts` +
      (missing.length ? `; in manifest, missing from code: ${missing.join(', ')}` : '') +
      (extra.length ? `; in code, missing from manifest: ${extra.join(', ')}` : '') +
      ' (update the manifest and the code together; see MCP-CHANGE-PROTOCOL.md)',
  );
}

async function checkMcpSurface() {
  try {
    const manifest = await readFile(join(root, 'src', 'mcp-surface.ts'), 'utf8');
    const fns = join(repoRoot, 'supabase', 'functions');
    const mcpSrc = await readFile(join(fns, 'mcp', 'index.ts'), 'utf8');
    const connSrc = await readFile(join(fns, 'connectors', 'index.ts'), 'utf8');
    const intentSrc = await readFile(join(fns, '_shared', 'trip-intent.ts'), 'utf8');

    const mTools = quotedList(manifest, 'MCP_TOOLS = [');
    const mScopes = quotedList(manifest, 'CONNECTOR_DEFAULT_SCOPES = [');
    const mIntent = quotedList(manifest, 'TRIP_INTENT_FIELDS = [');

    compare('MCP_TOOLS', mTools, nameList(mcpSrc, 'const TOOLS: ToolDef[] = ['));
    compare('CONNECTOR_DEFAULT_SCOPES', mScopes, quotedList(connSrc, 'const DEFAULT_SCOPES = ['));
    compare('TRIP_INTENT_FIELDS', mIntent, quotedList(intentSrc, 'INTENT_FIELDS = ['));

    // Invariant: every connector default scope is a real MCP tool.
    if (mTools && mScopes) {
      const orphans = mScopes.filter((s) => !mTools.includes(s));
      if (orphans.length) {
        failures += 1;
        console.error(
          `ERR mcp-surface -> connector scopes are not MCP tools: ${orphans.join(', ')}`,
        );
      }
    }
  } catch (err) {
    failures += 1;
    console.error(`ERR mcp-surface -> ${err.message}`);
  }
}

await checkOpenApi();
await checkTripContentSchema();
await checkMcpSurface();

if (failures > 0) {
  console.error(`\n${failures} contract check(s) failed.`);
  process.exit(1);
}
console.log('\nAll contract checks passed.');
