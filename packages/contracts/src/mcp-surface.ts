/**
 * MCP surface manifest - the single source of truth for the BYO-AI MCP contract
 * shared across BE, FE, and ADMIN.
 *
 * This is the "hard contract": CI validates the live implementation against these
 * lists (BE: packages/contracts/scripts/validate.mjs parses the edge functions;
 * every repo: the mcp-guard workflow flags PRs that touch MCP surfaces). Any edit
 * here is, by definition, an MCP implication - follow docs MCP-CHANGE-PROTOCOL.md
 * (intent, context, data, scopes, tools, auth, cross-repo propagation).
 */

/** Tools the MCP endpoint exposes (must match mcp/index.ts TOOLS). */
export const MCP_TOOLS = [
  'get_trip_brief',
  'set_trip_brief',
  'get_trip',
  'list_days',
  'add_moment',
  'add_activity',
  'update_activity',
  'move_activity',
  'set_packing_list',
  'import_reservation',
  'optimise_day',
] as const;

/**
 * Tool-name scopes minted into a per-trip connector token (must match the
 * connectors function DEFAULT_SCOPES). Every entry must also be an MCP tool.
 */
export const CONNECTOR_DEFAULT_SCOPES = [
  'get_trip_brief',
  'set_trip_brief',
  'get_trip',
  'list_days',
  'add_activity',
  'update_activity',
  'move_activity',
  'add_moment',
  'set_packing_list',
  'import_reservation',
  'optimise_day',
] as const;

/** OAuth scope vocabulary. `active` is enforced today; `reserved` is planned. */
export const MCP_OAUTH_SCOPES = {
  active: ['yaycay.read', 'yaycay.plan'],
  reserved: ['yaycay.book', 'yaycay.journal'],
} as const;

/** Columns of public.trip_intent (must match _shared/trip-intent.ts INTENT_FIELDS). */
export const TRIP_INTENT_FIELDS = [
  'pace',
  'budget',
  'travellers',
  'interests',
  'must_do',
  'avoid',
  'notes',
  'constraints',
] as const;

/** Tables that carry MCP state; a schema change to any of these is an MCP implication. */
export const MCP_TABLES = [
  'oauth_clients',
  'oauth_codes',
  'oauth_grants',
  'connectors',
  'trip_intent',
  'trip_content',
] as const;

export type McpTool = (typeof MCP_TOOLS)[number];
export type McpActiveScope = (typeof MCP_OAUTH_SCOPES.active)[number];
export type McpReservedScope = (typeof MCP_OAUTH_SCOPES.reserved)[number];
export type McpScope = McpActiveScope | McpReservedScope;
export type TripIntentField = (typeof TRIP_INTENT_FIELDS)[number];
export type McpTable = (typeof MCP_TABLES)[number];
