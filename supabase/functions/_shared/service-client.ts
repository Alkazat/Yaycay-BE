// Service-role Supabase client for the customer edge functions. Customer
// requests run as the caller (see user-client.ts) so RLS enforces ownership;
// this client is used only for the few server-side writes RLS deliberately
// withholds from the `authenticated` role - notably appending to `ai_jobs`,
// whose only client policy is owner-select. Secrets are server-side only.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { requireEnv } from './env.ts';

let cached: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (!cached) {
    cached = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    });
  }
  return cached;
}
