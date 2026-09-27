# app (PWA — Next.js, Capacitor-ready)

**Status:** scaffold pending Node 20 (not installed in this env — see blocker below).

Planned structure:
- `/app` Next.js 14 App Router PWA (routes: `/`, `/pots/[id]`, `/pay`, `/score`, `/you`, `/disputes`)
- Service worker + IndexedDB outbox (contribute/dispute/vote queue)
- Design tokens from `IMPLEMENTATION-PLAN-DETAILED.md` Phase 1
- Live prototype today: `../prototype/index.html` (zero-install click-through)

TODO (needs Node): `npx create-next-app@14`, add `next-pwa`, implement 5 tabs from prototype, push/SMS hooks.
