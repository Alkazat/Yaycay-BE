/**
 * Request/response DTOs for the v0.1 HTTP surface. These mirror the schemas
 * in `openapi.yaml`. Clients import these rather than redeclaring shapes.
 */

import type { Activity, Booking, Day, Moment, TripContent } from './trip-content.js';

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
  mode?: 'little' | 'explorer' | 'explorer_plus';
  interests?: string[];
  /** Dietary flags surfaced to adults as safety notes. */
  dietary?: string[];
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
