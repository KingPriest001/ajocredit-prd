# AJOCREDIT Postgres (local)

## Stack
- Engine: real PostgreSQL via PGlite (`@electric-sql/pglite`, data in `api/.pglite-data/` — gitignored, survives restarts)
- `docker-compose.yml` — same schema via Postgres 15 image when Docker Desktop is available (optional)
- `db/init.sql` — full V1 schema (mirrors `api/prisma/schema.prisma` + Functional Spec enums) + seed (Bola / AJ-4821 / cycle 1 / ledger / score / dispute / notifications / referrals)

## Run
1. `cd api && npm install` (first time)
2. `node server.js` (or `PORT=4000 node server.js`) — seeds on boot, idempotent
3. Check: `http://localhost:4000/health` → `{"ok":true,"db":"up"}`

## Endpoints
`GET /api/score/:ajId` · `GET /api/groups/:id/health` · `GET /api/groups/:id/ledger` · `POST /api/contributions` (fee enforced: <₦10k 1.5% · ₦10k–100k 1.0% · >₦100k 0.75%) · `GET /api/notifications/:u` · `GET /api/referrals/:u` · `GET /api/passport/:ajId`

The prototype calls the API when reachable (localhost) and silently keeps mock data otherwise — nothing breaks offline or on Netlify.
