// POST /webhooks/stripe - Stripe event sink (public; gateway verify_jwt=false).
//
// Verifies the Stripe signature over the raw body, then on a completed checkout
// records the purchase and flips the trip's tier. Idempotent: the purchase is
// keyed on the unique stripe_session_id, so a redelivered event is a no-op.
// Writes go through the service role (RLS withholds purchase/tier writes from
// clients). Always answers 200 for verified events so Stripe stops retrying;
// only a bad signature returns 400.

import { error, json } from '../_shared/http.ts';
import { requireEnv } from '../_shared/env.ts';
import { serviceClient } from '../_shared/service-client.ts';
import { constructEvent, SignatureError, stripeConfigured } from '../_shared/stripe.ts';

const PAID_TIERS = new Set(['byo', 'ours']);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return error('method_not_allowed', 'Use POST.', 405);
  if (!stripeConfigured())
    return error('payments_unavailable', 'Payments are not configured.', 503);

  const signature = req.headers.get('stripe-signature') ?? '';
  const rawBody = await req.text();

  let event: Record<string, unknown>;
  try {
    event = await constructEvent(rawBody, signature, requireEnv('STRIPE_WEBHOOK_SECRET'));
  } catch (err) {
    if (err instanceof SignatureError) {
      return error('invalid_signature', 'Stripe signature verification failed.', 400);
    }
    console.error('stripe webhook parse error', err);
    return error('internal_error', 'Could not process the event.', 500);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event);
    }
    // Other event types are acknowledged and ignored.
    return json({ received: true }, 200);
  } catch (err) {
    console.error('stripe webhook handler error', err);
    return error('internal_error', 'Could not process the event.', 500);
  }
});

async function handleCheckoutCompleted(event: Record<string, unknown>): Promise<void> {
  const session = ((event.data as Record<string, unknown>)?.object ?? {}) as Record<
    string,
    unknown
  >;
  const sessionId = session.id as string | undefined;
  if (!sessionId) return;

  const metadata = (session.metadata ?? {}) as Record<string, string>;
  const userId = metadata.user_id || null;
  const tripId = metadata.trip_id || null;
  const kind = metadata.kind === 'keep' ? 'keep' : 'tier';
  const tier = PAID_TIERS.has(metadata.tier) ? metadata.tier : null;
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : null;
  const amountUsd = typeof session.amount_total === 'number' ? session.amount_total / 100 : null;
  const priceId = metadata.price_id || null;

  const db = serviceClient();

  // Idempotency guard: the unique stripe_session_id rejects a redelivered event.
  const { error: insErr } = await db.from('purchases').insert({
    user_id: userId,
    trip_id: tripId,
    price_id: priceId,
    tier,
    amount_usd: amountUsd,
    stripe_session_id: sessionId,
    stripe_payment_intent: paymentIntent,
  });
  if (insErr) {
    // 23505 = unique_violation: already processed, nothing more to do.
    if ((insErr as { code?: string }).code === '23505') return;
    throw new Error(insErr.message);
  }

  // First time we have seen this session: confer the entitlement.
  if (tripId && kind === 'keep') {
    await extendRetention(db, tripId, Number(metadata.extends_months));
  } else if (tripId && tier) {
    const { error: updErr } = await db.from('trips').update({ tier }).eq('id', tripId);
    if (updErr) throw new Error(updErr.message);
  }
}

/**
 * Push a trip's disposal date forward by `months`, measured from the later of
 * now and its current expiry, so a keep-token always extends retention. Mirrors
 * app.extend_trip_retention; done here over the service role to avoid exposing
 * the app schema to PostgREST.
 */
async function extendRetention(
  db: ReturnType<typeof serviceClient>,
  tripId: string,
  months: number,
): Promise<void> {
  if (!Number.isInteger(months) || months <= 0) return;
  const { data: trip, error: selErr } = await db
    .from('trips')
    .select('retention_expires_at')
    .eq('id', tripId)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  if (!trip) return;

  const now = new Date();
  const current = trip.retention_expires_at ? new Date(trip.retention_expires_at) : null;
  const from = current && current > now ? current : now;
  const next = new Date(from);
  next.setMonth(next.getMonth() + months);

  const { error: updErr } = await db
    .from('trips')
    .update({ retention_expires_at: next.toISOString() })
    .eq('id', tripId);
  if (updErr) throw new Error(updErr.message);
}
