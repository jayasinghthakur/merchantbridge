# M6 — Docs, demo, deploy

1. README: what it is, 2-minute quickstart (self-client), architecture diagram (Mermaid), tool table, can/cannot summary,
   rate-limit design, security notes, screenshots of the dashboard, roadmap. Written for the Razorpay reviewer first.
2. `docs/DEMO.md`: a 5-minute demo script — connect, ask 5 questions in Claude Desktop/Agent Studio, trigger a 429 with a
   load script and show the governor + dashboard reacting, show a refused write.
3. Dockerfiles for gateway, mcp-server, dashboard; `infra/fly.toml` (or Railway) with Postgres + Redis; deploy steps.
4. Final pass: run `/review`, fix findings; ensure `pnpm lint typecheck test evals` green; tag `v0.1.0`.
5. Write `docs/adr/` entries for the 5 most important decisions if missing.
