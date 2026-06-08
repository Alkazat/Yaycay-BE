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

import type { Tier } from './dto.js';
import type { ActivityKind } from './trip-content.js';

export type { ActivityKind };

export type Role = 'user' | 'admin';

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

export interface TripSummary {
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

export interface ProductSummary {
  priceId: string;
  name: string;
  amountUsd: number;
}

export interface PurchaseSummary {
  id: string;
  ownerEmail: string;
  priceId: string;
  tier: TripTier | null;
  amountUsd: number;
  createdAt: string;
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
