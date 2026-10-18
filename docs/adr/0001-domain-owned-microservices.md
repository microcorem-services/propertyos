# ADR-0001: Domain-Owned Microservices

- Status: Accepted for architecture; M0.1 implementation is scaffolding only
- Date: 2026-10-18
- Decision owners: Microcorem product and engineering

## Context

BOWERA is intended for UK commercial property owners, councils, and property management organisations. The published Phase 2 application is a Next.js frontend and a single FastAPI property API with PostgreSQL persistence. It has no production authentication, authorization, or organisation isolation. The approved target is independently deployable FastAPI services, PostgreSQL, Docker, future AWS ECS Fargate, Amazon Cognito, and AWS messaging where asynchronous communication is appropriate.

## Decision

Use domain-owned microservices with explicit API, configuration, dependency, container, test, and data ownership boundaries. Implement Organization & Access and Property & Asset Registry as the first backend services. Keep the existing frontend and Phase 2 backend in place until replacements pass compatibility and regression tests.

Each service will own its schema, migrations, credentials, and writes. Local development starts with separate PostgreSQL containers, databases, users, and volumes. Production topology and RDS cluster placement remain subject to security, availability, and cost review. No service may query another service's database.

Use authenticated synchronous APIs for operations requiring an immediate result. Introduce versioned events through an outbox and EventBridge/SQS only when a real cross-service workflow needs asynchronous delivery. Consumers must be idempotent and support retries and dead-letter handling.

Amazon Cognito is the preferred identity provider. Authentication does not imply organisation membership or authorization. Services must validate identity and enforce organisation-scoped, object-level policy before handling real tenant data. M0.1 does not implement or claim any of these controls.

## Consequences

The design enables separate ownership and deployment but increases infrastructure cost, operational burden, failure modes, data consistency work, and contract/version management. Limit early implementation to two services and add domains only as their ownership and deployment needs become clear.

The current Phase 2 UI and API remain functional during M0.1. The new property-assets service is a health-only skeleton; it does not replace, proxy, or migrate Phase 2 data. No AWS resources or deployment are part of this decision's first milestone.

## M0.1 scope

Create service skeletons, service-specific configuration/dependencies/Dockerfiles/tests, local Compose with separate PostgreSQL databases and users, independent ports/start commands, and documentation. Authentication, domain persistence, event transport, CI/CD, AWS infrastructure, and moving the existing application are explicitly deferred.

## Revisit when

Review the decision if service boundaries cause excessive distributed transactions, if an operationally simpler deployment better serves the initial scale, or if validated council/security requirements require different isolation or hosting boundaries.