/**
 * Admin-scoped DTOs for the `/admin/*` surface (contract v0.2).
 *
 * Authored from the Admin thread's contract change request. The Admin app
 * mirrors these verbatim until it pins `@alkazat/contracts@^0.2.0` and deletes
 * its local `src/lib/contracts/types.ts` stand-ins.
 *
 * Auth for every `/admin/*` endpoint: a Supabase JWT with `role=admin` and AAL2
 * (verified MFA). Non-admin or non-MFA callers get `403`.
 */

import type { Tier, ProfileType } from './dto.js';
import type { ActivityKind, Day, Moment, Activity } from './trip-content.js';

export type { ActivityKind };

/**
 * Naming aliases for the canonical content model (model-context section 5).
 * The Admin thread refers to these as Trip*; BE's canonical names are
 * Day/Moment/Activity (used by FE too). Exported so Admin can import either.
 */
export type TripDay = Day;
export type TripMoment = Moment;
export type TripActivity = Activity;

export type Role = 'user' | 'admin';

/** Decoded admin session state (from the Supabase JWT). */
export interface AdminSession {
  userId: string;
  email: string;
  role: Role;
  mfaVerified: boolean;
}

/** An account in the isolated identity store, as surfaced to admin management. */
export interface AdminAccount {
  userId: string;
  email: string;
  role: Role;
  createdAt?: string;
}

export interface AdminAccountsResponse {
  items: AdminAccount[];
}

/**
 * Request body for `POST /admin/admins`: set an account's role by email
 * (promote to `admin`, or demote to `user`). The account must already exist
 * (provisioned on the person's first sign-in); an unknown email is a 404.
 */
export interface AdminPromoteRequest {
  email: string;
  role: Role;
}

/**
 * Child profile as surfaced to admin inspection screens. Named `AdminChildProfile`
 * to leave the canonical `ChildProfile` (the customer surface, `GET /profiles`)
 * unambiguous - same precedent as `AdminTripSummary`.
 */
export interface AdminChildProfile {
  id: string;
  name: string;
  age: number;
  /** Who the profile is (child → Explorers; parent_carer → Grown-ups). */
  type: ProfileType;
  /** Whether a parent/carer PIN is configured (read-only; the PIN is never returned). */
  pin_set: boolean;
  interests: string[];
  /** Medical flags surfaced to adults as safety callouts. */
  medical?: string[];
}

/** An audited admin action (actor, action, target, when). */
export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string;
  at: string;
  details?: string;
}

/** Alias of {@link Tier} under the name the Admin thread uses. */
export type TripTier = Tier;

export type AiModel = 'claude-sonnet' | 'claude-opus' | 'gemini' | 'openai';

export type AiJobKind = 'generation' | 'ingestion' | 'chat';

export type AiJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** RFC 9457 problem+json. Every `/admin/*` error uses this shape. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

/** Cursor-based pagination envelope: `?cursor=&limit=` -> `{ items, nextCursor }`. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Prompt {
  id: string;
  task: string;
  title: string;
  body: string;
  model: AiModel;
  version: number;
  active: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface CreatePromptRequest {
  task: string;
  title: string;
  body: string;
  model: AiModel;
}

export interface CreatePromptVersionRequest {
  title: string;
  body: string;
  model: AiModel;
}

export interface ModelRoute {
  task: string;
  defaultModel: AiModel;
  override?: AiModel;
}

export interface SetModelRouteRequest {
  defaultModel: AiModel;
  override?: AiModel | null;
}

export interface AiJob {
  id: string;
  tripId: string;
  kind: AiJobKind;
  status: AiJobStatus;
  model: AiModel;
  promptVersion: number;
  createdAt: string;
  error?: string;
}

/** Daily-cap usage for a trip (cap ~10 AI updates/day). */
export interface JobCapUsage {
  tripId: string;
  date: string;
  used: number;
  limit: number;
  remaining: number;
}

/** Admin-scoped trip list row (off-domain view, camelCase). Distinct from the
 * customer-facing `TripSummary` in dto.ts. */
export interface AdminTripSummary {
  id: string;
  destination: string;
  ownerEmail: string;
  tier: TripTier;
  status: string;
  startDate: string;
  endDate: string;
  retentionExpiresAt: string | null;
}

export interface CustomerSummary {
  userId: string;
  email: string;
  tier: TripTier | null;
  retentionExpiresAt: string | null;
  deletionRequested: boolean;
}

/**
 * Admin-initiated onboarding of a customer. Identity is invite-only (magic-link
 * + mandatory 2FA, no admin-set passwords), so this provisions a pending account
 * and emails a sign-in link; the person completes setup (2FA) on first sign-in.
 * Idempotent on email: re-inviting an existing account resends the link.
 */
export interface InviteCustomerInput {
  email: string;
  /** Optional, to greet them by name in the invite email. */
  name?: string;
}

/**
 * What a catalogue product confers on purchase: a trip `tier` entitlement, or a
 * `keep`-token that extends a trip's data retention by `extendsMonths`.
 */
export type ProductKind = 'tier' | 'keep';

export interface ProductSummary {
  priceId: string;
  name: string;
  amountUsd: number;
  /** What the product grants: a tier entitlement, or a keep-token. */
  kind: ProductKind;
  /** For `kind: 'tier'`, the tier granted on purchase (byo or ours). */
  tier?: TripTier;
  /** For `kind: 'keep'`, months of retention a purchase adds. */
  extendsMonths?: number | null;
  /** Inactive products are hidden from the customer catalogue but kept for history. */
  active: boolean;
  /**
   * Stripe mode: true = live, false = test. The catalogue is already scoped to the
   * deployment's mode, so all rows in one response share a value; surfaced so Admin
   * can show a Live/Test badge as a safety net.
   */
  livemode?: boolean;
}

/** Request body for `POST /admin/products` (admin). */
export interface CreateProductRequest {
  /** The Stripe price id this catalogue row maps to. */
  priceId: string;
  name: string;
  amountUsd: number;
  /** Defaults to `tier` when omitted. */
  kind?: ProductKind;
  /** Required for `kind: 'tier'`; the tier granted on purchase. */
  tier?: TripTier;
  /** Required for `kind: 'keep'`; positive months of retention a purchase adds. */
  extendsMonths?: number;
  /** Defaults to true. */
  active?: boolean;
}

/** Request body for `PATCH /admin/products/{priceId}` (admin). All fields optional. */
export interface UpdateProductRequest {
  name?: string;
  amountUsd?: number;
  kind?: ProductKind;
  tier?: TripTier | null;
  extendsMonths?: number | null;
  active?: boolean;
}

export interface PurchaseSummary {
  id: string;
  ownerEmail: string;
  priceId: string;
  tier: TripTier | null;
  amountUsd: number;
  /** The affiliate code applied at checkout, if any. */
  discountCode?: string | null;
  /** The discount the code applied, in USD. */
  discountUsd?: number | null;
  createdAt: string;
}

// ===== Affiliate / influencer program (v0.16) ==============================

export type AffiliateStatus = 'active' | 'paused';

/** An influencer in the affiliate program. */
export interface Affiliate {
  id: string;
  name: string;
  email: string;
  /** Social handle, e.g. "@sunnytravels". */
  handle: string;
  /** Discount + attribution code, e.g. "SUNNY15". */
  code: string;
  discountPercent: number;
  commissionPercent: number;
  /** Website /go/<slug>. */
  landingSlug: string;
  status: AffiliateStatus;
  /** Set when the affiliate has been archived (soft-deleted); null otherwise. */
  archivedAt?: string | null;
  createdAt: string;
}

/** Request body for `POST /admin/affiliates`. `code`/`landingSlug` are hints; BE owns uniqueness. */
export interface CreateAffiliateInput {
  name: string;
  email: string;
  handle: string;
  discountPercent: number;
  commissionPercent: number;
  code?: string;
  landingSlug?: string;
}

/**
 * Request body for `PUT /admin/affiliates/{code}` (edit). All fields optional;
 * only provided fields change. `discountPercent` and `code` are fixed after
 * creation (the Stripe coupon/promotion code are immutable) — archive and
 * recreate to change them.
 */
export interface UpdateAffiliateInput {
  name?: string;
  email?: string;
  handle?: string;
  commissionPercent?: number;
  landingSlug?: string;
}

/** One purchase attributed to an affiliate code (from the Stripe webhook). */
export interface AffiliateRedemption {
  purchaseId: string;
  ownerEmail: string;
  priceId: string;
  /** List price before the discount. */
  grossUsd: number;
  /** Discount the code applied. */
  discountUsd: number;
  /** What the customer actually paid. */
  netUsd: number;
  createdAt: string;
}

export interface AffiliatePage {
  items: Affiliate[];
  nextCursor: string | null;
}

export interface AffiliateRedemptionPage {
  items: AffiliateRedemption[];
  nextCursor: string | null;
}

/** Request body for `POST /admin/affiliates/{code}/report`. Period is [start, end). */
export interface AffiliateReportRequest {
  periodStart: string;
  periodEnd: string;
}

export type ContentReviewStatus = 'pending' | 'approved' | 'edited';

export interface ContentReviewItem {
  tripId: string;
  destination: string;
  status: ContentReviewStatus;
  generatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

// ===== Data deletion console (v0.20) =======================================

/**
 * An account that has requested deletion, with its data footprint and grace
 * status. `eligible` is true once `eligibleAt` (requestedAt + 30-day grace) has
 * passed; `execute` is blocked before then unless forced.
 */
export interface DeletionRequest {
  userId: string;
  email: string;
  /** When deletion was first requested (ISO 8601). */
  requestedAt: string;
  /** Whole days since the request. */
  ageDays: number;
  /** When the request becomes eligible to execute without a force override. */
  eligibleAt: string;
  /** True once the grace period has elapsed. */
  eligible: boolean;
  /** Best entitlement across the account's trips. */
  tier: string | null;
  /** Counts of what an execute would erase (journal/profiles cascade from trips). */
  trips: number;
  media: number;
  /** Purchases survive (anonymized) for financial records; shown for context. */
  purchases: number;
}

export interface DeletionRequestPage {
  items: DeletionRequest[];
  nextCursor: string | null;
}

/**
 * Body for `POST /admin/deletion-requests/{userId}/execute`. `email` must match
 * the account's email (confirm-by-typing). `force` overrides the grace period.
 */
export interface ExecuteDeletionRequest {
  email: string;
  force?: boolean;
}

/** Result of an execute: the hard delete completed. */
export interface DeletionResult {
  deleted: true;
  userId: string;
  email: string;
  footprint: { tier: string | null; trips: number; media: number; purchases: number };
}

/** Result of a cancel: the request was cleared. */
export interface CancelDeletionResult {
  userId: string;
  email: string;
  cancelled: true;
}

// ===== BYO-AI MCP connectors (admin ops view) (v0.22) ======================

export type ConnectorScope = 'yaycay.read' | 'yaycay.plan';

/**
 * An OAuth grant behind a parent's connected assistant, as the admin ops view
 * sees it (a row of `oauth_grants`). `id` is the grant id used to revoke.
 */
export interface AdminConnector {
  id: string;
  userId: string;
  ownerEmail: string;
  /** Human label, e.g. "Claude (claude.ai)". */
  assistant: string;
  /** OAuth client id (RFC 7591 dynamic registration). */
  clientId: string;
  scopes: ConnectorScope[];
  status: 'active' | 'revoked';
  createdAt: string;
  /** Last tool call on this grant; null if never used. */
  lastUsedAt: string | null;
}

export interface AdminConnectorPage {
  items: AdminConnector[];
  nextCursor: string | null;
}

// ===== Admin support sessions / "view-as" (v0.24) ==========================
//
// A support session is a time-boxed, reason-gated, audited record of an admin
// inspecting ONE customer's data. It is an oversight record, NOT a credential:
// no customer login link, access/refresh token, or auth cookie is ever issued.
// The admin inspects data through the existing AAL2-gated /admin/* read path;
// the session scopes, logs, time-boxes, and surfaces that access. Acting as the
// customer (writes) is out of scope by design.

/** The only support mode today: inspect customer data, never act as them. */
export type SupportSessionMode = 'read_only';

/** How an active session ended: an admin closed it, or its TTL elapsed. */
export type SupportSessionEndReason = 'manual' | 'expired';

export interface SupportSession {
  id: string;
  /** The admin who opened the session. */
  actorId: string;
  actorEmail: string | null;
  /** The customer being inspected. */
  targetUserId: string;
  targetEmail: string | null;
  /** Mandatory justification (e.g. a ticket reference); audited. */
  reason: string;
  mode: SupportSessionMode;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedReason: SupportSessionEndReason | null;
  /** Derived server-side: not ended and not past `expiresAt`. */
  active: boolean;
}

/**
 * Body for `POST /admin/support-sessions`. Identify the customer by id or email
 * (one is required). `reason` is mandatory and audited. `ttlMinutes` is clamped
 * server-side (default 30, max 120). Opening a session while one is already
 * open for the same admin is a `409`.
 */
export interface StartSupportSessionRequest {
  targetUserId?: string;
  targetEmail?: string;
  reason: string;
  ttlMinutes?: number;
}

export interface SupportSessionPage {
  items: SupportSession[];
  nextCursor: string | null;
}

/**
 * Read-only snapshot of a customer's footprint for an active support session.
 * Aggregates what the admin customer/trip read endpoints already expose; every
 * fetch is audited against the session. Returned only to the admin who owns the
 * session, and only while it is active (expired sessions return `410`).
 */
export interface SupportSessionSnapshot {
  session: SupportSession;
  customer: CustomerSummary;
  profiles: AdminChildProfile[];
  trips: AdminTripSummary[];
}
