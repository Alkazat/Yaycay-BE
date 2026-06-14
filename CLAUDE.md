# CLAUDE.md

## Communication preferences

### Technical / engineering-led instructions
When giving instructions for technical, engineering-led tasks (setup, configuration, deployment, integrations, infra, etc.):

- **Provide a downloadable `.md` file as the handoff.** Write the step-by-step instructions to a Markdown file and surface it as a downloadable artifact rather than dumping all steps inline in chat.
- **Deep-link every step to the exact page** on the relevant third-party service — not the generic homepage. Link directly to the specific screen where the action happens, e.g.:
  - GitHub → the specific repo's Settings / Secrets / Actions page
  - Vercel → the project's Environment Variables / Deployments page
  - Supabase → the project's SQL Editor / Auth / Database settings page
  - Brevo → the specific template editor / SMTP & API keys page
- When a deep-link needs an org/project/repo slug that isn't known, use the canonical path and clearly mark where to substitute the user's own identifier.
