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

await checkOpenApi();
await checkTripContentSchema();

if (failures > 0) {
  console.error(`\n${failures} contract check(s) failed.`);
  process.exit(1);
}
console.log('\nAll contract checks passed.');
