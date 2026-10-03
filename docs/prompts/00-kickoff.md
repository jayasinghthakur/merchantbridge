# Kickoff prompt — paste this into Claude Code first

You are the founding engineer of MerchantBridge. Read `CLAUDE.md` and `docs/SPEC.md` fully before doing anything.

Context: this repo is both (a) my submission for Razorpay's Forward-Deployed Engineer assignment, Option 3
("private connector for a merchant tool" — I chose Zoho Inventory), and (b) the first version of a real product.
Reviewers will judge: working OAuth/API-key auth, list/get/search primitives, rate-limit handling, an MCP tool
specification, and a short doc of what the agent can and cannot do. Quality, safety and clarity matter more than breadth.

We will build in milestones M0–M6 (see SPEC "Building it with Claude Code"). Each milestone has its own prompt in
`docs/prompts/`. For now:
1. Summarize back to me, in under 15 bullets, what you will build and the non-negotiable rules.
2. List anything in the spec that is ambiguous or that you believe is wrong, with your proposed resolution.
3. Do NOT write code yet. Wait for me to send the M0 prompt.
