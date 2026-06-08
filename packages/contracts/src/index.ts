/**
 * @yaycay/contracts - the shared handshake.
 *
 * Re-exports the canonical content model and the v0.1 DTOs. The OpenAPI spec
 * (`openapi.yaml`) and the JSON schema (`schemas/trip-content.schema.json`) are
 * shipped in the package root and resolvable via the package `exports` map.
 */

/** Semantic version of this contract. Clients pin a range, e.g. `^0.1.0`. */
export const CONTRACT_VERSION = '0.1.0';

export * from './trip-content.js';
export * from './dto.js';
