# Historical demonstration plan · Nuvomailo

> Superseded for product scope by [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md). Preserved as historical planning, not a limit on the full Nuvomailo product or evidence of implemented features.

> **Deadline:** Sunday, 18 October 2026  
> **Scope:** Demo-ready MVP using **synthetic data** — not production school email  
> **Learning focus:** TypeScript + React, with Express MVC applied directly

## Execution principles

- Implement **vertical slices** (DB/API/test/UI), not folders for their own sake.
- Finish **P0 security gates** before exposing a route to the Internet.
- Track evidence (commit, API test, screenshot or short demo) for each milestone.
- If external SMTP/DNS readiness blocks a feature, mark it blocked and demonstrate verified local tests honestly.

## Milestones

| Day | Focus | Evidence of completion |
| :--- | :--- | :--- |
| **Tue 13 Oct** | Documentation, repo, TypeScript/Express foundation | First commit; typecheck; health endpoint |
| **Wed 14 Oct** | PostgreSQL schema + login foundation | Migrations; identity tests; login flow |
| **Thu 15 Oct** | Organizations, memberships, tenant guards | Negative cross-tenant tests |
| **Fri 16 Oct** | DMS setup, domain checks, provisioning adapter | Test mailbox created; tracked job status |
| **Sat 17 Oct** | React dashboard + API integration | End-to-end admin workflow |
| **Sun 18 Oct** | Stabilization, backups, security + demo | Demo script, test report, known limitations |

This is an **ambitious target**. Actual completion must be recorded; a passing demo is not a claim of long-term mail reliability.

## Priority guide

**P0 / demo-essential:** organization authorization, domain verification, mailbox provisioning status, quota constraint, React admin views, mail client test, basic restore, tenant isolation tests.

**P1 / if time remains:** webmail integration, aliases, enhanced audit browsing, usage charts, password rotation UX.

**P2 / after deadline:** public sign-up, payments, production school rollout, HA and mail storage scaling, full custom inbox.

## Deliverable checklist

- [ ] `README.md` accurately states current implementation status.
- [ ] `docs/ARCHITECTURE.md` matches the code.
- [ ] `docs/DATABASE.md` is replaced/augmented with real migrations.
- [ ] API has authenticated and unauthorized test paths.
- [ ] Tenant A/B isolation tests pass.
- [ ] Mailbox provisioning status reflects actual DMS state.
- [ ] Test clients can authenticate over TLS for SMTP submission and IMAP.
- [ ] Mail DNS checks recorded (or documented as not yet validated).
- [ ] At least one backup restore is tested and documented.
- [ ] No secrets committed; review `git diff --cached`.
- [ ] Demo includes known limitations and next steps.

## Suggested demo storyline

1. Sign in as an org A admin.
2. Inspect org A domains and show its verification state.
3. Provision a test mailbox with 100 MB quota; observe `PENDING` then `ACTIVE` when truly confirmed.
4. Demonstrate client SMTP/IMAP test if configured.
5. Try accessing org B by modifying route parameters; show rejection.
6. Show audit trail / test report and explain limitations.

## After Sunday: testing-only VPS

Use Hostinger KVM 1 for approximately two months of **testing and validation** after the initial build. That duration is not extra development time before the Sunday deadline.

Focus: reliability, deliverability, resource monitoring, backups, security, capacity and feasibility of a school deployment. Migrate or resize infrastructure based on measurements and authorization before handling real users.
