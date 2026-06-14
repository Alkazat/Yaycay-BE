// Brevo contact sync. Brevo bills by sends, not contacts, so holding unlimited
// free signups costs nothing. Transactional email (2FA, magic links) goes
// through a separate transactional sender, not this path.

import { optionalEnv } from './env.ts';

const BREVO_CONTACTS_URL = 'https://api.brevo.com/v3/contacts';
const BREVO_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email';

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

export interface TransactionalEmail {
  to: string;
  subject: string;
  html: string;
  /** Sender; falls back to BREVO_SENDER_EMAIL / a default. */
  fromEmail?: string;
  fromName?: string;
}

/**
 * Send a transactional email via Brevo. Returns true if sent, false if skipped
 * because no API key is configured. Throws on a hard Brevo error so callers can
 * surface it.
 */
export async function sendEmail(email: TransactionalEmail): Promise<boolean> {
  const apiKey = optionalEnv('BREVO_API_KEY');
  if (!apiKey) return false;

  const fromEmail = email.fromEmail ?? optionalEnv('BREVO_SENDER_EMAIL') ?? 'no-reply@yaycay.ai';
  const res = await fetch(BREVO_EMAIL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      sender: { email: fromEmail, name: email.fromName ?? 'Yaycay' },
      to: [{ email: email.to }],
      subject: email.subject,
      htmlContent: email.html,
    }),
  });
  if (!res.ok) throw new Error(`Brevo send failed: ${res.status} ${await res.text()}`);
  return true;
}
