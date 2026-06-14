// Walker-family demo seed (marketing screenshots).
//
// Creates ONE stable, idempotent, logged-in-able demo customer whose data tells
// the Singapore story from the Orchestra brief: a paying "Done for you" account,
// a parent_carer + two children (Sam/explorer, Pip/little with a tree-nut
// allergy), a completed 4-day Singapore trip (Day 2 is the hero), and Pip's
// keepsake journal page. The account is flagged is_demo and its trip has a NULL
// retention date, so the disposal sweep never touches it.
//
// Run (against staging or prod), from the repo root:
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
//   DEMO_WALKER_PASSWORD=<vault password> \
//   DEMO_WALKER_PIN=<4-digit pin> \
//   deno run --allow-env --allow-net supabase/seed/walker-demo.ts
//
// Idempotent: re-running upserts the same fixed ids, never duplicates.
//
// NOTE (gap, by design): "reopenable planning chat" and seeded companion answers
// have no back-end store - planning chat is stateless SSE streaming. Those
// screenshots depend on FE mock/fixture state, not this seed. See README.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import content from './walker-singapore.trip-content.json' with { type: 'json' };

// --- Fixed identifiers so re-runs upsert rather than duplicate -------------
const TRIP_ID = '00000000-0000-4000-a000-000000000001';
const PROFILE_PARENT = '00000000-0000-4000-a000-000000000010';
const PROFILE_SAM = '00000000-0000-4000-a000-000000000011';
const PROFILE_PIP = '00000000-0000-4000-a000-000000000012';
const PURCHASE_ID = '00000000-0000-4000-a000-000000000020';
const JOURNAL_ID = '00000000-0000-4000-a000-000000000030';

const EMAIL = Deno.env.get('DEMO_WALKER_EMAIL') ?? 'demo.walker@yaycay.example';
const PASSWORD = Deno.env.get('DEMO_WALKER_PASSWORD') ?? 'Walker-Demo-2026!';
const PIN = Deno.env.get('DEMO_WALKER_PIN') ?? '2468';

// --- PIN hashing: must match supabase/functions/profiles (PBKDF2-SHA256) ----
function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$100000$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`Missing required env ${name}`);
    Deno.exit(1);
  }
  return v;
}

async function main() {
  const url = env('SUPABASE_URL');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  if (!Deno.env.get('DEMO_WALKER_PASSWORD') || !Deno.env.get('DEMO_WALKER_PIN')) {
    console.warn(
      'WARNING: using default demo password/PIN. Set DEMO_WALKER_PASSWORD and ' +
        'DEMO_WALKER_PIN (and record them in the team vault) for the real seed.',
    );
  }

  // 1. Auth user (idempotent).
  let userId: string | null = null;
  const created = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (created.data?.user) {
    userId = created.data.user.id;
  } else {
    // Already registered: find the user id by paging the admin list.
    for (let page = 1; page <= 50 && !userId; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === EMAIL.toLowerCase());
      if (hit) userId = hit.id;
      if (data.users.length < 200) break;
    }
    if (userId) {
      // Make sure the password matches the vault on re-run.
      await admin.auth.admin.updateUserById(userId, { password: PASSWORD, email_confirm: true });
    }
  }
  if (!userId) throw new Error('Could not create or find the demo auth user.');
  console.log(`auth user: ${userId} (${EMAIL})`);

  // 2. Identity account: flag as demo. The row already exists (created by the
  // new-user trigger), and service_role has UPDATE (not INSERT) on the isolated
  // identity schema - so update in place rather than upsert.
  {
    const { error } = await admin
      .schema('identity')
      .from('accounts')
      .update({ is_demo: true })
      .eq('user_id', userId);
    if (error) throw error;
  }

  // 3. Profiles: parent_carer (PIN holder) + two children.
  const pinHash = await hashPin(PIN);
  const profiles = [
    {
      id: PROFILE_PARENT,
      user_id: userId,
      name: 'Riley Walker',
      type: 'parent_carer',
      mode: null,
      age: null,
      interests: [],
      dietary: [],
      medical: [],
      pin_hash: pinHash,
    },
    {
      id: PROFILE_SAM,
      user_id: userId,
      name: 'Sam',
      type: 'child',
      mode: 'explorer',
      age: 9,
      interests: ['engineering', 'building', 'space'],
      dietary: [],
      medical: [],
      pin_hash: null,
    },
    {
      id: PROFILE_PIP,
      user_id: userId,
      name: 'Pip',
      type: 'child',
      mode: 'little',
      age: 6,
      interests: ['animals', 'drawing'],
      dietary: ['tree nuts'],
      medical: ['Tree-nut allergy (anaphylaxis) - carry EpiPen'],
      pin_hash: null,
    },
  ];
  {
    const { error } = await admin.from('child_profiles').upsert(profiles, { onConflict: 'id' });
    if (error) throw error;
  }
  console.log(`profiles: ${profiles.map((p) => p.name).join(', ')} (PIN set on Riley)`);

  // 4. Trip: completed, paid "ours", retention NULL (disposal-safe).
  {
    const { error } = await admin.from('trips').upsert(
      {
        id: TRIP_ID,
        user_id: userId,
        destination: 'Singapore',
        start_date: '2026-05-12',
        end_date: '2026-05-15',
        timezone: 'Asia/Singapore',
        currency: 'USD',
        tier: 'ours',
        status: 'complete',
        retention_expires_at: null,
      },
      { onConflict: 'id' },
    );
    if (error) throw error;
  }

  // 5. Trip content (validated against trip-content.schema.json).
  {
    const { error } = await admin
      .from('trip_content')
      .upsert({ trip_id: TRIP_ID, user_id: userId, content }, { onConflict: 'trip_id' });
    if (error) throw error;
  }

  // 6. Purchase so the account derives the "ours" tier (no paywall banners).
  {
    const { error } = await admin.from('purchases').upsert(
      {
        id: PURCHASE_ID,
        user_id: userId,
        trip_id: TRIP_ID,
        tier: 'ours',
        amount_usd: 129,
        stripe_session_id: 'seed_walker_demo',
      },
      { onConflict: 'id' },
    );
    if (error) throw error;
  }

  // 7. Pip's keepsake journal page (Day 2).
  {
    const { error } = await admin.from('journal_entries').upsert(
      {
        id: JOURNAL_ID,
        trip_id: TRIP_ID,
        user_id: userId,
        profile_id: PROFILE_PIP,
        day_id: 'd2',
        mood: 'happy',
        body:
          'Today I saw the giant trees that are taller than buildings and walked inside the ' +
          'misty forest with a HUGE waterfall. I found a tiny frog and named him Bouncy. ' +
          'At lunch the grown-ups showed the card to the cook so my tummy stayed safe and ' +
          'I had chicken rice. Then we swam in the pool. Best day!',
        media_ref: [],
      },
      { onConflict: 'id' },
    );
    if (error) throw error;
  }

  console.log('\nWalker demo seed complete.');
  console.log(`  login: ${EMAIL}`);
  console.log('  trip: Singapore (4 days, complete, tier=ours)');
  console.log('  grown-ups PIN set on Riley Walker');
  console.log('  account flagged is_demo=true; trip retention is NULL (disposal-safe)');
}

main().catch((err) => {
  console.error('seed failed:', err);
  Deno.exit(1);
});
