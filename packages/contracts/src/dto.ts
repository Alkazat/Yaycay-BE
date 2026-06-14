/**
 * Request/response DTOs for the v0.1 HTTP surface. These mirror the schemas
 * in `openapi.yaml`. Clients import these rather than redeclaring shapes.
 */

import type { Activity, Booking, Day, ExplorerMode, Moment, TripContent } from './trip-content.js';

/** How a trip was bought; drives entitlement and the AI path. */
export type Tier = 'free' | 'byo' | 'ours';

export type TripStatus = 'draft' | 'planning' | 'ready' | 'holidaying' | 'complete' | 'archived';

export interface Trip {
  id: string;
  destination: string;
  start_date?: string;
  end_date?: string;
  timezone?: string;
  currency?: string;
  tier: Tier;
  status: TripStatus;
  /** When trip data is scheduled for disposal unless a keep-token extends it. */
  retention_expires_at?: string;
  created_at?: string;
}

/**
 * The list view of a trip (`GET /trips` -> `{ trips: TripSummary[] }`). Adds the
 * two derived fields the FE list needs on top of the stored trip columns:
 * `day_count` (number of days in the content) and `data_kept` (whether the trip
 * data is still retained, i.e. not past its disposal date).
 */
export interface TripSummary {
  id: string;
  destination: string;
  start_date?: string;
  end_date?: string;
  timezone?: string;
  currency?: string;
  tier: Tier;
  status: TripStatus;
  retention_expires_at?: string;
  /** Number of days currently planned in the trip content. */
  day_count: number;
  /** False once the trip is past its retention/disposal date. */
  data_kept: boolean;
  created_at?: string;
}

export interface ListTripsResponse {
  trips: TripSummary[];
}

export interface CreateTripRequest {
  destination: string;
  start_date?: string;
  end_date?: string;
  timezone?: string;
  currency?: string;
}

export interface DemoChildProfile {
  name: string;
  age?: number;
  /** Explorer mode used to pick the variant block. */
  mode?: 'little' | 'standard' | 'explorer' | 'explorer_plus';
  interests?: string[];
  /** Dietary flags surfaced to adults as safety notes. */
  dietary?: string[];
  /** Medical flags surfaced to adults as safety callouts. */
  medical?: string[];
}

export interface DemoGenerateDayRequest {
  destination: string;
  /** Optional day to theme the plan around. */
  date?: string;
  child: DemoChildProfile;
}

export interface DemoGenerateDayResponse {
  day: Day;
  /** A short teaser of the grown-ups guide. */
  grownups_teaser: string;
  /** Whether a live model produced this or the deterministic fallback did. */
  generated_by?: 'ai' | 'fallback';
}

export interface SignupCaptureRequest {
  email: string;
  name?: string;
  /** Funnel source, e.g. `website-demo` or `fe-demo`. */
  source?: string;
  /** Marketing consent state captured at signup. */
  consent: boolean;
  /** Optional free-form attributes synced to Brevo. */
  attributes?: Record<string, unknown>;
}

export interface SignupCaptureResponse {
  contact_id: string;
  status: 'created' | 'updated';
  synced_to_brevo?: boolean;
}

export interface TwoFactorVerifyRequest {
  code: string;
}

export interface TwoFactorVerifyResponse {
  verified: boolean;
}

// ===== Account (v0.18): the signed-in owner's own account ===================

/**
 * The authenticated owner's account (the parent row, distinct from the per-child
 * `ChildProfile`s). Returned by `GET /account`. Email and tier are server-owned;
 * only the secondary (recovery) email is consumer-mutable (see `AccountUpdate`).
 */
export interface AccountSummary {
  /** Login email (server-owned; changed via the auth flow, not here). */
  email: string;
  /** Secondary email used for password recovery; null when unset. */
  secondary_email: string | null;
  /** The account's best entitlement, derived from purchases. */
  tier: Tier;
  /** Entitlement role. Consumers are always `user`. */
  role: 'user' | 'admin';
  /** Whether the account has enrolled an MFA factor. */
  two_factor_enrolled: boolean;
  /** When a data-deletion was requested, if ever; null otherwise. */
  deletion_requested_at: string | null;
  /** Account creation timestamp (ISO 8601). */
  created_at: string;
}

/** Body for `PATCH /account`. Send `secondary_email: null` to clear it. */
export interface AccountUpdate {
  secondary_email?: string | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: string[];
  };
}

// ===== AI surfaces (v0.3): planning chat + ingestion ========================

/**
 * A structured edit the AI harness emits. Applied to the current trip content,
 * re-validated against the schema, then persisted. The op vocabulary is shared
 * with the BYO-AI MCP tools, so one apply path serves our-AI and BYO-AI writes.
 */
export type PatchOp =
  | { op: 'add_day'; day: Day }
  | { op: 'set_day_summary'; day_id: string; summary: string }
  | { op: 'add_moment'; day_id: string; moment: Moment }
  | { op: 'add_activity'; day_id: string; moment_id: string; activity: Activity }
  | { op: 'update_activity'; activity_id: string; set: Partial<Omit<Activity, 'id'>> }
  | { op: 'move_activity'; activity_id: string; to_moment_id: string }
  | { op: 'set_booking'; activity_id: string; booking: Booking };

export interface TripContentPatch {
  ops: PatchOp[];
  /** Short human-readable note on what changed. */
  note?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Request body for `POST /trips/{tripId}/plan/chat` (use-our-AI, tier=ours). */
export interface PlanChatRequest {
  messages: ChatMessage[];
}

/**
 * The chat response is a `text/event-stream`. Each SSE `data:` frame is one of
 * these JSON objects; the stream ends with a literal `data: [DONE]`.
 */
export type PlanChatEvent =
  | { start: true; generated_by: 'ai' | 'fallback' }
  | { delta: string }
  | { done: true; job_id: string | null }
  | { error: string };

/** A photo of a receipt/booking/ticket for the vision model. */
export interface IngestImage {
  /** e.g. `image/jpeg`, `image/png`. */
  media_type: string;
  /** base64-encoded image bytes (no `data:` prefix). */
  data: string;
}

/** Request body for `POST /trips/{tripId}/ingest` (paid: byo or ours). */
export interface IngestRequest {
  /** A note, pasted confirmation, or OCR text. One of text/image is required. */
  text?: string;
  image?: IngestImage;
  /** Optional targeting hint. */
  hint?: { day_id?: string; moment_id?: string };
}

export interface IngestResponse {
  applied: boolean;
  /** The ai_jobs ledger id for this ingestion (counts to the daily cap). */
  job_id: string | null;
  generated_by: 'ai' | 'fallback';
  /** The patch the harness produced. */
  patch: TripContentPatch;
  /** The full trip content after applying the patch. */
  content: TripContent;
}

// ===== Commerce (v0.5): Stripe Checkout =====================================

/** Request body for `POST /checkout/session`. */
export interface CheckoutSessionRequest {
  /** The Stripe price id of a known, active catalogue product. */
  price_id: string;
  /** Optional trip the purchased tier applies to. */
  trip_id?: string;
  /** Optional affiliate discount/attribution code (from the /go/<slug> funnel). */
  code?: string;
  /** Redirect targets; fall back to server defaults when omitted. */
  success_url?: string;
  cancel_url?: string;
}

export interface CheckoutSessionResponse {
  /** The Stripe-hosted Checkout URL to redirect the customer to. */
  url: string;
  /** The Stripe Checkout Session id. */
  session_id: string;
}

// ===== Journal + media (v0.6) ==============================================

export interface JournalEntry {
  id: string;
  trip_id: string;
  /** Optional child profile this entry is tagged to. */
  profile_id?: string | null;
  /** The content day this entry is scoped to (TripContent.days[].id, e.g. `d_2`); null = trip-level. */
  day_id?: string | null;
  body: string;
  /** Short mood label the FE maps to its mood picker. */
  mood?: string | null;
  /** A 1-5 star rating of the day/moment. */
  stars?: number | null;
  /** media_ref ids from `/media/sign-upload`, resolved to signed URLs on read. */
  media_ref: string[];
  created_at: string;
}

/** Request body for `POST /trips/{tripId}/journal` (paid: byo or ours). */
export interface JournalEntryInput {
  body?: string;
  profile_id?: string;
  /** The content day this entry is scoped to (e.g. `d_2`). */
  day_id?: string;
  /** Short mood label. */
  mood?: string;
  /** A 1-5 star rating. */
  stars?: number;
  media_ref?: string[];
}

export interface JournalListResponse {
  entries: JournalEntry[];
}

/** Request body for `POST /media/sign-upload` (paid: byo or ours). */
export interface SignUploadRequest {
  /** The trip the media belongs to (must be a paid trip the caller owns). */
  trip_id: string;
  content_type?: string;
}

export interface SignUploadResponse {
  /** Stable reference stored in journal entries / trip content. */
  media_ref: string;
  /** Storage object path (owner-prefixed). */
  path: string;
  /** Short-lived signed URL to PUT the file to. */
  upload_url: string;
  /** Upload token for the signed URL. */
  token: string;
}

// ===== BYO-AI MCP (v0.6) ===================================================

export type ConnectorStatus = 'active' | 'revoked';

export interface Connector {
  id: string;
  trip_id: string;
  label?: string | null;
  scopes: string[];
  status: ConnectorStatus;
  last_used_at?: string | null;
  created_at: string;
}

export interface ConnectorsListResponse {
  connectors: Connector[];
}

/** Request body for `POST /connectors/byo-ai` (tier=byo). */
export interface ByoConnectorRequest {
  trip_id: string;
  label?: string;
}

export interface ByoConnectorResponse {
  connector_id: string;
  /** The scoped MCP token to add to the parent's own AI as a connector. */
  token: string;
  /** The MCP endpoint URL the token authenticates against. */
  mcp_url: string;
}

// ===== Profiles + progress (v0.9) ==========================================

/** Who a profile belongs to. `child` → Explorers view; `guardian` → Grown-ups (PIN-gated). */
export type ProfileType = 'child' | 'guardian';

/** A profile on the account. Gates the per-profile experience (type, mode, journal, stars). */
export interface ChildProfile {
  id: string;
  name: string;
  avatar?: string | null;
  age?: number | null;
  /** Voice / age band. Child bands: little|explorer|explorer_plus; `standard` is the guardian voice. */
  mode?: ExplorerMode | null;
  /** Who the profile is. Defaults to `child`. */
  type: ProfileType;
  /** Whether a guardian PIN is configured. Read-only; the PIN itself is never returned. */
  pin_set: boolean;
  interests: string[];
  /** Dietary flags surfaced to adults as content safety notes. */
  dietary: string[];
  /** Medical flags surfaced to adults as content safety callouts. */
  medical: string[];
  created_at: string;
  updated_at: string;
}

export interface ChildProfilesResponse {
  profiles: ChildProfile[];
}

/** Request body for `POST /profiles` (create) and `PATCH /profiles/{id}` (update). */
export interface ChildProfileInput {
  /** Required on create; optional on update. */
  name?: string;
  avatar?: string | null;
  age?: number | null;
  mode?: ExplorerMode | null;
  /** Defaults to `child` on create. */
  type?: ProfileType;
  interests?: string[];
  dietary?: string[];
  medical?: string[];
}

/** Request body for `POST /profiles/{id}/pin` and `POST /profiles/{id}/pin/verify`. */
export interface PinRequest {
  /** A 4-digit PIN. */
  pin: string;
}

/** Response for `POST /profiles/{id}/pin/verify`. */
export interface PinVerifyResponse {
  verified: boolean;
}

/** Per-profile state for a trip: which items are done and the active mode. */
export interface TripProgress {
  /** The child this progress belongs to; null for an unscoped/household row. */
  profile_id: string | null;
  active_mode?: ExplorerMode | null;
  /** Ids of content items (activities, challenges) marked done. */
  done_items: string[];
  updated_at: string;
}

export interface TripProgressResponse {
  progress: TripProgress[];
}

/** Request body for `PATCH /trips/{tripId}/progress`. */
export interface ProgressUpdateRequest {
  profile_id: string;
  active_mode?: ExplorerMode;
  /** Full replacement of the done set. */
  done_items?: string[];
  /** Incremental: add these item ids to the done set. */
  mark_done?: string[];
  /** Incremental: remove these item ids from the done set. */
  mark_undone?: string[];
}

// ===== Rewards + packing + grown-ups checklist (v0.11) =====================

/** One append-only star award. Claims are idempotent per child / day / source. */
export interface StarLedgerEntry {
  id: string;
  profile_id: string;
  /** What earned the stars, e.g. `challenge:<id>`, `star_challenge`, `game:<id>`. */
  source: string;
  /** Per-day scoping (`''` when not day-specific). */
  day: string;
  stars: number;
  created_at: string;
}

/** A child's running star total. */
export interface StarBalance {
  profile_id: string;
  stars: number;
}

/** Response for `GET /trips/{tripId}/stars`. */
export interface StarsResponse {
  balances: StarBalance[];
  entries: StarLedgerEntry[];
}

/** Request body for `POST /trips/{tripId}/stars/claim`. */
export interface StarClaimRequest {
  profile_id: string;
  source: string;
  /** Per-day scoping; omit for a non-day achievement. */
  day?: string;
  /** Stars to award (1-10); defaults to 1. */
  stars?: number;
}

export interface StarClaimResponse {
  /** False when this (child, day, source) was already claimed (idempotent no-op). */
  claimed: boolean;
  entry: StarLedgerEntry;
  /** The child's new total. */
  balance: number;
}

/**
 * Packing is a per-trip document: lists (a `family` list + one per child,
 * addressed by `id`) contain sections, which contain items. BE seeds the
 * list/section skeleton on first touch; the FE adds items into it. Every read
 * and every mutation returns the whole collection.
 */
export interface PackingItem {
  id: string;
  label: string;
  qty?: number;
  checked: boolean;
}

export interface PackingSection {
  id: string;
  label: string;
  items: PackingItem[];
}

export interface PackingList {
  /** A child profile id, or the literal `"family"`. */
  id: string;
  label: string;
  sections: PackingSection[];
}

/** Response for `GET /trips/{tripId}/packing` and every `PATCH`. */
export interface PackingResponse {
  lists: PackingList[];
}

/**
 * Request body for `PATCH /trips/{tripId}/packing`. A discriminated union on
 * `action`; the response is always the full `PackingResponse`.
 */
export type PackingPatchRequest =
  | { action: 'tick'; list_id: string; item_id: string; checked: boolean }
  | { action: 'add'; list_id: string; section_id: string; label: string; qty?: number }
  | { action: 'delete'; list_id: string; item_id: string }
  | { action: 'reset' };

/** A persisted grown-ups checklist tick, keyed by the FE's item id. */
export interface ChecklistItem {
  item: string;
  checked: boolean;
  updated_at: string;
}

export interface ChecklistResponse {
  items: ChecklistItem[];
}

/**
 * Request body for `PATCH /trips/{tripId}/grownups/checklist`. Pass a single
 * `{ item, checked }` or a batch via `items`.
 */
export interface ChecklistUpdateRequest {
  item?: string;
  checked?: boolean;
  items?: Array<{ item: string; checked: boolean }>;
}
