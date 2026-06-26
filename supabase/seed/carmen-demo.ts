// Carmen-family demo seed (marketing screenshots + trip economics demo).
//
// Creates ONE stable, idempotent, logged-in-able demo customer:
// Carmen (parent_carer), Savy (explorer_plus, age 13), Tay (explorer, age 8),
// and Lenny (little, age 5, tree-nut allergy / anaphylaxis / EpiPen).
// A 12-day Singapore trip starting 2026-06-26, tier=ours, status=ready.
// Also populates the four trip-economics tables introduced in 0036:
//   trip_profile_challenges (24 rows: Savy×12 + Tay×12)
//   trip_budget (1 row, SGD/AUD, rate 1.10)
//   trip_costs (20 line items, SGD amounts)
//   trip_reward_config (1 trip-default row, star_value=3, star_target=36)
//
// Ages: Savy 13, Tay 8, Lenny 5 (assumed from prototype explorer content
// referencing "older explorer who gets explorer_plus content"). Adjust
// PROFILE_SAVY_AGE etc. if exact ages are later confirmed.
//
// Run (against staging or prod), from the repo root:
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
//   DEMO_CARMEN_PASSWORD=<vault password> \
//   DEMO_CARMEN_PIN=<4-digit pin> \
//   deno run --allow-env --allow-net supabase/seed/carmen-demo.ts
//
// Idempotent: re-running upserts the same fixed ids, never duplicates.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import content from './carmen-singapore.trip-content.json' with { type: 'json' };
import economics from './carmen-singapore.economics.json' with { type: 'json' };

// --- Fixed identifiers so re-runs upsert rather than duplicate -------------
// Carmen block: 08bf4275-...-00{10..13} mirrors the trip id prefix.
const TRIP_ID = '08bf4275-1a45-4862-96df-ee5e0e83393b'; // from trip-content JSON
const PROFILE_PARENT = '08bf4275-1a45-4862-96df-ee5e0e830010';
const PROFILE_SAVY = '08bf4275-1a45-4862-96df-ee5e0e830011';
const PROFILE_TAY = '08bf4275-1a45-4862-96df-ee5e0e830012';
const PROFILE_LENNY = '08bf4275-1a45-4862-96df-ee5e0e830013';
const PURCHASE_ID = '08bf4275-1a45-4862-96df-ee5e0e830020';

const EMAIL = Deno.env.get('DEMO_CARMEN_EMAIL') ?? 'demo.carmen@yaycay.example';
const PASSWORD = Deno.env.get('DEMO_CARMEN_PASSWORD') ?? 'Carmen-Demo-2026!';
const PIN = Deno.env.get('DEMO_CARMEN_PIN') ?? '1357';

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

  if (!Deno.env.get('DEMO_CARMEN_PASSWORD') || !Deno.env.get('DEMO_CARMEN_PIN')) {
    console.warn(
      'WARNING: using default demo password/PIN. Set DEMO_CARMEN_PASSWORD and ' +
        'DEMO_CARMEN_PIN (and record them in the team vault) for the real seed.',
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
  // identity schema — so update in place rather than upsert.
  {
    const { error } = await admin
      .schema('identity')
      .from('accounts')
      .update({ is_demo: true, name: 'Carmen family' })
      .eq('user_id', userId);
    if (error) throw error;
  }

  // 3. Profiles: parent_carer (PIN holder) + three children.
  //    Modes (explorer_mode enum: 'little' | 'explorer' | 'explorer_plus'):
  //      Savy age 13 → 'explorer_plus' (highest; gets the deeper variant content)
  //      Tay  age  8 → 'explorer'
  //      Lenny age 5 → 'little'
  const pinHash = await hashPin(PIN);
  const profiles = [
    {
      id: PROFILE_PARENT,
      user_id: userId,
      name: 'Carmen',
      type: 'parent_carer',
      mode: null,
      age: null,
      interests: [],
      dietary: [],
      medical: [],
      pin_hash: pinHash,
    },
    {
      id: PROFILE_SAVY,
      user_id: userId,
      name: 'Savy',
      type: 'child',
      mode: 'explorer_plus',
      age: 13,
      interests: ['history', 'science', 'trivia', 'economics'],
      dietary: [],
      medical: [],
      pin_hash: null,
    },
    {
      id: PROFILE_TAY,
      user_id: userId,
      name: 'Tay',
      type: 'child',
      mode: 'explorer',
      age: 8,
      interests: ['animals', 'challenges', 'sport'],
      dietary: [],
      medical: [],
      pin_hash: null,
    },
    {
      id: PROFILE_LENNY,
      user_id: userId,
      name: 'Lenny',
      type: 'child',
      mode: 'little',
      age: 5,
      interests: ['animals', 'games'],
      dietary: ['tree nuts'],
      medical: ['Tree-nut allergy (anaphylaxis) — carry EpiPen at ALL times'],
      pin_hash: null,
    },
  ];
  {
    const { error } = await admin.from('child_profiles').upsert(profiles, { onConflict: 'id' });
    if (error) throw error;
  }
  console.log(`profiles: ${profiles.map((p) => p.name).join(', ')} (PIN set on Carmen)`);

  // 4. Trip: in-progress 12-day Singapore trip, paid "ours", retention NULL.
  //    start_date = 2026-06-26 = today; status='ready' (packed, day 1 active).
  //    currency SGD per the trip-content JSON.
  {
    const { error } = await admin.from('trips').upsert(
      {
        id: TRIP_ID,
        user_id: userId,
        destination: 'Singapore',
        start_date: '2026-06-26',
        end_date: '2026-07-08',
        timezone: 'Asia/Singapore',
        currency: 'SGD',
        tier: 'ours',
        status: 'ready',
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
        stripe_session_id: 'seed_carmen_demo',
      },
      { onConflict: 'id' },
    );
    if (error) throw error;
  }

  // -------------------------------------------------------------------------
  // 7. ECONOMICS (new in 0036_trip_economics.sql)
  // -------------------------------------------------------------------------

  // 7a. trip_profile_challenges: 12 rows for Savy + 12 rows for Tay = 24 total.
  //     Lenny earns stars via games — no challenge rows for little mode.
  //     icon/tag from economics JSON are for reference only: no DB column exists.
  //     Unique constraint: (trip_id, profile_id, day, node_ref).
  type ChallengeEntry = {
    day: string;
    node_ref: string;
    kind: string;
    prompt: string;
    answer: string;
    stars: number;
  };

  const savyChallenges: ChallengeEntry[] = (
    economics.challenges.savy as Array<ChallengeEntry & { icon: string; tag: string }>
  ).map(({ icon: _icon, tag: _tag, ...rest }) => rest);

  const tayChallenges: ChallengeEntry[] = (
    economics.challenges.tay as Array<ChallengeEntry & { icon: string; tag: string }>
  ).map(({ icon: _icon, tag: _tag, ...rest }) => rest);

  const challengeRows = [
    ...savyChallenges.map((c) => ({
      trip_id: TRIP_ID,
      user_id: userId,
      profile_id: PROFILE_SAVY,
      day: c.day,
      node_ref: c.node_ref,
      kind: c.kind,
      prompt: c.prompt,
      answer: c.answer,
      options: [] as string[],
      stars: c.stars,
    })),
    ...tayChallenges.map((c) => ({
      trip_id: TRIP_ID,
      user_id: userId,
      profile_id: PROFILE_TAY,
      day: c.day,
      node_ref: c.node_ref,
      kind: c.kind,
      prompt: c.prompt,
      answer: c.answer,
      options: [] as string[],
      stars: c.stars,
    })),
  ];
  {
    const { error } = await admin
      .from('trip_profile_challenges')
      .upsert(challengeRows, { onConflict: 'trip_id,profile_id,day,node_ref' });
    if (error) throw error;
  }
  console.log(`trip_profile_challenges: ${challengeRows.length} rows (Savy×12 + Tay×12)`);

  // 7b. trip_budget: one row per trip (trip_id is PK).
  {
    const b = economics.budget;
    const { error } = await admin.from('trip_budget').upsert(
      {
        trip_id: TRIP_ID,
        user_id: userId,
        base_currency: b.base_currency,
        home_currency: b.home_currency,
        exchange_rate: b.exchange_rate,
        rate_as_of: b.rate_as_of,
        cash_budget: b.cash_budget,
        daily_cash_budget: b.daily_cash_budget,
      },
      { onConflict: 'trip_id' },
    );
    if (error) throw error;
  }
  console.log(`trip_budget: 1 row (SGD cash_budget=${economics.budget.cash_budget}, rate=1.10)`);

  // 7c. trip_costs: 20 line items.
  //     Unique constraint: (trip_id, day, node_ref, label).
  type CostEntry = {
    day: string;
    node_ref: string;
    label: string;
    amount_base: number | null;
    amount_home: number | null;
    currency_base: string;
    currency_home: string;
    paid: boolean;
    notes: string;
  };

  const costRows = (economics.costs as CostEntry[]).map((c) => ({
    trip_id: TRIP_ID,
    user_id: userId,
    day: c.day,
    node_ref: c.node_ref,
    label: c.label,
    amount_base: c.amount_base,
    amount_home: c.amount_home,
    currency_base: c.currency_base,
    currency_home: c.currency_home,
    paid: c.paid,
    notes: c.notes || null,
  }));
  {
    const { error } = await admin
      .from('trip_costs')
      .upsert(costRows, { onConflict: 'trip_id,day,node_ref,label' });
    if (error) throw error;
  }
  console.log(`trip_costs: ${costRows.length} rows`);

  // 7d. trip_reward_config: one trip-default row (profile_id = NULL).
  //     Partial-unique index: (trip_id) where profile_id is null.
  //     Supabase upsert with partial index: use ignoreDuplicates=false + explicit
  //     onConflict targeting the index expression is not supported via the client,
  //     so we delete-then-insert for the default row (safe: idempotent on re-run).
  {
    const r = economics.reward;
    await admin.from('trip_reward_config').delete().eq('trip_id', TRIP_ID).is('profile_id', null);
    const { error } = await admin.from('trip_reward_config').insert({
      trip_id: TRIP_ID,
      user_id: userId,
      profile_id: null,
      star_value: r.star_value,
      currency: r.currency,
      star_target: r.star_target,
      star_budget: r.star_budget,
    });
    if (error) throw error;
  }
  console.log(
    `trip_reward_config: 1 trip-default row (star_value=${economics.reward.star_value} SGD, target=${economics.reward.star_target}, budget=${economics.reward.star_budget} SGD)`,
  );

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\nCarmen demo seed complete.');
  console.log(`  login: ${EMAIL}`);
  console.log('  trip: Singapore (12 days, d1=2026-06-26, status=ready, tier=ours)');
  console.log('  grown-ups PIN set on Carmen');
  console.log('  account flagged is_demo=true; trip retention is NULL (disposal-safe)');
  console.log('  Savy mode=explorer_plus (age 13), Tay mode=explorer (age 8),');
  console.log('  Lenny mode=little (age 5, tree-nut allergy + EpiPen)');
  console.log('  economics: 24 challenges, 1 budget row, 20 cost items, 1 reward config');
}

main().catch((err) => {
  console.error('seed failed:', err);
  Deno.exit(1);
});
