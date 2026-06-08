/**
 * Request/response DTOs for the v0.1 HTTP surface. These mirror the schemas
 * in `openapi.yaml`. Clients import these rather than redeclaring shapes.
 */

import type { Day } from './trip-content.js';

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
