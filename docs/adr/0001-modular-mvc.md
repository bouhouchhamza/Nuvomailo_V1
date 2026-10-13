# ADR-0001 — MVC control plane with modular monolith deployment

- **Status:** Accepted for MVP
- **Date:** 13 October 2026
- **Decision makers:** Nuvomailo project team

## Context

Nuvomailo must demonstrate a multi-tenant email hosting administration platform by **18 October 2026**, on a small test VPS (1 vCPU, 4 GB RAM, 50 GB NVMe). The team prefers Express MVC and intends to learn TypeScript and React by implementing the system directly. The email engine is Docker Mailserver and is already an independent component.

## Decision

Use:

1. **React + TypeScript** for the independent browser **View**.
2. **Express + TypeScript** as an MVC-style API with thin controllers and a service layer.
3. **PostgreSQL** for application metadata, identity, tenant scope and job state.
4. **A restricted provisioning worker/adapter** for mail account actions.
5. **Docker Mailserver** for SMTP, IMAP and mailbox storage.
6. **A modular monolith** for the initial API deployment, retaining explicit module boundaries.

## Why

- Lower operational overhead on the initial VPS.
- Faster integration testing and debugging before the Sunday demo.
- Easier security review for tenant boundaries and provisioning flows.
- Clear interfaces allow selective extraction of services if observed load later justifies it.

## Considered alternatives

| Alternative | Why not now |
| :--- | :--- |
| Multiple Express microservices | More processes, deployment and network complexity with no demonstrated bottleneck |
| Server-rendered MVC (EJS) | React is an explicit product/learning requirement |
| Reimplement SMTP/IMAP | High security/standards burden; avoid unnecessary risk |
| Public SaaS launch on KVM 1 | Capacity, deliverability and safety not validated |

## Consequences

**Positive:** simpler delivery, lower baseline resources, shared codebase for services and integration tests.

**Trade-offs:** API modules share a process and may later need to be extracted; worker permissions and state reconciliation require careful design; this does not itself guarantee 500-user capacity.

## Revisit when

- Metrics show a service-specific CPU/memory bottleneck.
- Separate release cycles or isolation become essential.
- School pilot tests justify independent mail-server/storage infrastructure.
- Clear business requirements require horizontal scaling or fault isolation.
