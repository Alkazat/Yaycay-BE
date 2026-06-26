/**
 * @alkazat/contracts - the shared handshake.
 *
 * Re-exports the canonical content model, the v0.1 client DTOs, the v0.2
 * admin-scoped DTOs, and the v0.3 AI surfaces (planning chat + ingestion). The
 * OpenAPI spec (`openapi.yaml`) and the JSON schema
 * (`schemas/trip-content.schema.json`) are shipped in the package root and
 * resolvable via the package `exports` map.
 */

/** Semantic version of this contract. Clients pin a range, e.g. `^0.5.0`. */
export const CONTRACT_VERSION = '0.35.0';

export * from './trip-content.js';
export * from './dto.js';
export * from './admin.js';
export * from './mcp-surface.js';
