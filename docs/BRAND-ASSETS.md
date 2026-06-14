# Brand assets — Yaycay-BE (API · email · OG)

> **Canonical spec:** the design system's `BRAND-ASSETS.md` (vendored with the brand in
> `Yaycay-FE/vendor/yaycay-ds/`). BE has no UI, but it **emits brand** — transactional email
> (Brevo) and any server-rendered share/OG images — so it must use the canonical marks, not
> re-exports. **For families making memories.**

Email/OG-ready PNG masters are vendored under `assets/brand/`:
`yaycay-lockup.png`, `yaycay-wordmark.png`, `yaycay-app-icon.png`, `yaycay-glyph.png`.

## Which mark, which slot (BE)

| Surface | Use | Notes |
|---|---|---|
| Transactional email header (welcome, receipt) | **lockup** | full brand for the moments that matter; transparent PNG on a cream/sky band |
| Lighter email header / footer | **wordmark** | quieter than the lockup |
| Open Graph / share image generated server-side (1200×630) | **lockup** | centre it, leave clear space |
| Favicon embedded in a server-rendered page (if any) | **glyph** | tiny-safe, no text |

## The rules that bite here
- **Host, don't inline-redraw.** Serve the PNG from a stable URL (or attach via `cid:`); never
  re-render "Yaycay"/"Yay!" as live HTML/SVG text in an email — clients mangle fonts. Use the file.
- Always set descriptive `alt` text: `alt="Yaycay"` (or `"Yaycay — for families making memories"`
  for the lockup).
- Square slot ⇒ glyph/app icon; full-brand surface ⇒ lockup. Never the wide lockup in a square.
- Don't recolour or restyle the marks; the palette is sampled from them (`tokens/colors.css`:
  sky `#2A96D8`, royal `#0A4C8B`, cream `#FBF7EC`).
- **Never reword the tagline** in subject lines or copy: *For families making memories.*
