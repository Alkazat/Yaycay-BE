// POST /signup/capture - lead capture + Brevo sync.
// Used by the Website funnel and the FE demo. Upserts a marketing_contacts row
// with consent state and syncs to Brevo. Idempotent on email. Public.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { error, handlePreflight, json } from '../_shared/http.ts';
import { requireEnv } from '../_shared/env.ts';
import { syncContact } from '../_shared/brevo.ts';

interface CaptureInput {
  email: string;
  name?: string;
  source?: string;
  consent: boolean;
  attributes?: Record<string, unknown>;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function validate(
  body: unknown,
): { ok: true; input: CaptureInput } | { ok: false; details: string[] } {
  const details: string[] = [];
  const b = (body ?? {}) as Record<string, unknown>;

  if (typeof b.email !== 'string' || !EMAIL_RE.test(b.email)) {
    details.push('a valid email is required');
  }
  if (typeof b.consent !== 'boolean') {
    details.push('consent (boolean) is required');
  }
  if (details.length > 0) return { ok: false, details };

  return {
    ok: true,
    input: {
      email: (b.email as string).trim().toLowerCase(),
      name: typeof b.name === 'string' ? b.name : undefined,
      source: typeof b.source === 'string' ? b.source : undefined,
      consent: b.consent as boolean,
      attributes:
        b.attributes && typeof b.attributes === 'object'
          ? (b.attributes as Record<string, unknown>)
          : undefined,
    },
  };
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return error('method_not_allowed', 'Use POST.', 405);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error('invalid_json', 'Request body must be JSON.', 422);
  }

  const checked = validate(body);
  if (!checked.ok) {
    return error('validation_error', 'Request failed validation.', 422, checked.details);
  }
  const input = checked.input;

  const supabase = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );

  // Detect create vs update for an honest response status.
  const { data: existing } = await supabase
    .from('marketing_contacts')
    .select('id')
    .eq('email', input.email)
    .maybeSingle();

  const synced = await syncContact({
    email: input.email,
    name: input.name,
    consent: input.consent,
    attributes: input.attributes,
  });

  const { data: upserted, error: dbError } = await supabase
    .from('marketing_contacts')
    .upsert(
      {
        email: input.email,
        name: input.name ?? null,
        source: input.source ?? null,
        consent: input.consent,
        attributes: input.attributes ?? {},
        brevo_synced_at: synced ? new Date().toISOString() : null,
      },
      { onConflict: 'email' },
    )
    .select('id')
    .single();

  if (dbError || !upserted) {
    return error('persist_failed', 'Could not save the contact.', 500);
  }

  return json(
    {
      contact_id: upserted.id,
      status: existing ? 'updated' : 'created',
      synced_to_brevo: synced,
    },
    200,
  );
});
