---
title: MerchantBridge API
colorFrom: green
colorTo: green
sdk: docker
app_port: 8787
pinned: false
short_description: Read-only MCP connector for Zoho Inventory
tags:
  - mcp
  - model-context-protocol
  - zoho-inventory
---

# MerchantBridge API

The API half of [MerchantBridge](https://github.com/jayasinghthakur/merchantbridge): a private, Agent Studio-style
connector that lets AI agents read a merchant's Zoho Inventory over MCP (read-only by construction). Independent
work; not affiliated with Razorpay or Zoho.

- **Web app** (playground, tool explorer, docs): @WEB_URL@
- **Source, docs and setup:** https://github.com/jayasinghthakur/merchantbridge
- **Public demo MCP endpoint** (no auth, fake "Chai & Co (DEMO)" data): `/mcp/demo` on this Space's app URL, e.g.
  `claude mcp add --transport http mb-demo https://<owner>-<space>.hf.space/mcp/demo`
- **Health:** `/health/live`, `/health/ready`

This Space is generated. Every push to `main` that touches the API runs the GitHub workflow
`.github/workflows/deploy-hf-space.yml`, which assembles this repository (the root `Dockerfile` is
`apps/api/Dockerfile`, plus the pnpm workspace files the image needs) and **force-pushes** it here. Edits made
directly in this Space are overwritten by the next deploy; change the GitHub repository instead
(`deploy/hf-space/README.md` is this card).

The container listens on port 8787 (`app_port` above, and the image's `PORT`). Configuration comes from this Space's
variables and secrets; the list is in `docs/deploy.md` in the GitHub repository.
