// Branded transactional-email scaffolding.
//
// No transactional sender is wired yet (see brevo.ts: 2FA / magic-link /
// welcome email goes through a separate transactional path). When that lands,
// wrap the message body with `renderBrandedEmail` so every send is on-brand:
// the box-art lockup header, cream canvas, royal-outlined CTA, and the sacred
// tagline footer. Pure and side-effect free (Deno-friendly). See
// docs/BRAND-ASSETS.md.

/** Public origin that serves the brand assets (the marketing site). */
const DEFAULT_ASSETS_BASE = 'https://yaycay.ai';
const TAGLINE = 'For families making memories.'; // never reword

export interface BrandedEmailOptions {
  /** Visible hero line, e.g. "Your magic link". */
  title: string;
  /** Inner HTML for the message body (already trusted/escaped by the caller). */
  bodyHtml: string;
  /** Hidden inbox-preview line. */
  preheader?: string;
  /** Optional single call-to-action button. */
  cta?: { label: string; href: string };
  /** Origin serving `/brand/*` assets. Defaults to the marketing site. */
  assetsBase?: string;
}

/**
 * Wrap a message in the Yaycay transactional-email shell and return a full HTML
 * document with inline, email-client-safe styles (table layout, brand colours
 * sampled from the logo). The lockup is referenced by URL so it renders in any
 * client without attachments.
 */
export function renderBrandedEmail(opts: BrandedEmailOptions): string {
  const base = (opts.assetsBase ?? DEFAULT_ASSETS_BASE).replace(/\/$/, '');
  const lockup = `${base}/brand/yaycay-logo.png`;
  const preheader = opts.preheader ?? '';
  const cta = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
         <tr><td style="border-radius:14px;background:#2a96d8;box-shadow:0 4px 0 #073d72;">
           <a href="${opts.cta.href}" style="display:inline-block;padding:14px 28px;font-family:'Nunito',Arial,sans-serif;font-weight:800;font-size:16px;color:#04223f;text-decoration:none;">${opts.cta.label}</a>
         </td></tr>
       </table>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${opts.title}</title></head>
<body style="margin:0;padding:0;background:#fbf7ec;">
  <span style="display:none!important;opacity:0;color:#fbf7ec;height:0;width:0;overflow:hidden;">${preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf7ec;padding:28px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:92%;">
        <tr><td align="center" style="padding:8px 0 20px;">
          <img src="${lockup}" width="220" alt="Yaycay" style="display:block;border:0;width:220px;max-width:60%;height:auto;"/>
        </td></tr>
        <tr><td style="background:#ffffff;border:2px solid #073d72;border-radius:20px;padding:32px;">
          <h1 style="margin:0 0 12px;font-family:'Fredoka','Nunito',Arial,sans-serif;font-weight:600;font-size:26px;color:#073d72;">${opts.title}</h1>
          <div style="font-family:'Nunito',Arial,sans-serif;font-size:16px;line-height:1.6;color:#1c2733;">${opts.bodyHtml}</div>
          ${cta}
        </td></tr>
        <tr><td align="center" style="padding:20px 8px;font-family:'Nunito',Arial,sans-serif;font-size:13px;color:#6f695d;">
          <strong style="color:#0a4c8b;">${TAGLINE}</strong><br/>
          &copy; ${new Date().getFullYear()} Yaycay &middot; yaycay.ai
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
