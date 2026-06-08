// Brevo contact sync. Brevo bills by sends, not contacts, so holding unlimited
// free signups costs nothing. Transactional email (2FA, magic links) goes
// through a separate transactional sender, not this path.

import { optionalEnv } from './env.ts';

const BREVO_CONTACTS_URL = 'https://api.brevo.com/v3/contacts';

export interface BrevoContact {
  email: string;
  name?: string;
  consent: boolean;
  attributes?: Record<string, unknown>;
}

/**
 * Upsert a contact in Brevo. Returns true if synced, false if skipped because
 * no API key is configured (local / code-only environments).
 */
export async function syncContact(contact: BrevoContact): Promise<boolean> {
  const apiKey = optionalEnv('BREVO_API_KEY');
  if (!apiKey) return false;

  const res = await fetch(BREVO_CONTACTS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      email: contact.email,
      attributes: {
        ...(contact.name ? { FIRSTNAME: contact.name } : {}),
        ...contact.attributes,
        MARKETING_CONSENT: contact.consent,
      },
      updateEnabled: true, // idempotent upsert on email
    }),
  });

  // Brevo returns 201 (created) or 204 (updated). Treat 4xx other than dupes
  // as a soft failure: the row is already persisted locally and can re-sync.
  return res.ok || res.status === 204;
}
