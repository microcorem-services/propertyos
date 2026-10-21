# Lease Management

Lease Management is an independent BOWERA service with its own PostgreSQL database. It stores organization-scoped leases, legal parties, Unit references, and audit events. It never reads or writes the Property & Asset Registry database.

## Local setup

Create the local environment file from `infra/local/.env.example`, set all three database passwords, and configure the Cognito workload client values used by the existing internal service calls. Run only this service and its dependencies:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml up --build lease-management
```

The service listens on `http://localhost:8103`. `/health` is a liveness check; `/ready` executes `SELECT 1` against the Lease Management database. Apply the service migration only to a developer-controlled local database:

```bash
cd services/lease-management
DATABASE_URL='postgresql+psycopg://...' alembic upgrade head
```

Tests use an in-memory SQLite database and mocked service boundaries; they do not require Docker, credentials, or network access.

## API foundation

- `POST /api/v1/organizations/{organization_id}/leases`
- `GET /api/v1/organizations/{organization_id}/leases` (bounded register, search, status filtering, sorting, and pagination)
- `GET /api/v1/organizations/{organization_id}/lease-permissions`
- `GET /api/v1/organizations/{organization_id}/leases/{lease_id}`
- `PATCH /api/v1/organizations/{organization_id}/leases/{lease_id}`
- `GET /api/v1/organizations/{organization_id}/leases/{lease_id}/rent-schedules`
- `POST /api/v1/organizations/{organization_id}/leases/{lease_id}/rent-schedules`
- `PATCH /api/v1/organizations/{organization_id}/leases/{lease_id}/rent-schedules/{schedule_id}`
- `POST /api/v1/organizations/{organization_id}/leases/{lease_id}/rent-schedules/{schedule_id}/generate`

The organization identifier in the route is only a lookup scope. Every request requires the existing Organization & Access authorization decision. Active members may read; owners and admins may create or update. Lease lookups always include `organization_id`, so a lease in a different organization is returned as not found.

The API records rent using `Decimal` and PostgreSQL `NUMERIC(14, 2)`, requires one landlord and one or more tenants, supports multiple Units and joint tenants, and restricts currencies to GBP, EUR, and USD. The currency allowlist is an initial product decision, not a statement about tender requirements.

Each supplied Unit includes its Registry hierarchy identifiers. Before a create or changed Unit association, and when reading a lease, the service makes a bounded authenticated request to the Property & Asset Registry and checks that the Unit is active and that the returned Unit, organization, and building identities match. If a formerly valid Unit is now unavailable, the detail response marks it `unavailable` without disclosing a reason, so an authorised user can terminate the lease or replace its Unit association. Registry service failures still fail closed. Current Unit paths and identifiers are kept as organization-scoped references; there is deliberately no cross-service foreign key.

The Registry also asks the authenticated Lease Management API before deactivating a Unit; it refuses deactivation while any draft or active lease references that Unit and fails closed if Lease Management is unavailable. The Registry currently has no Unit deletion API. A stale lease can still be terminated to release the reference. These checks and lease-side revalidation detect stale references, but they cannot prevent a concurrent lease creation and Unit deactivation race. Eliminating that race requires a cross-service reservation/retirement protocol with compensation and reconciliation; this milestone does not claim an atomic cross-service guarantee.

Every successful create or update writes an audit event in the same PostgreSQL transaction as its lease, party, and Unit-reference changes. A failed transaction rolls back both domain changes and the audit event.

Rent schedules use the Lease Management database and the existing lease read/update authorization decisions. A schedule stores a fixed decimal amount per instalment, inherits currency from its lease, and generates expected instalments for monthly, quarterly, or annual frequency. Due days unavailable in a month are clamped to that month's final calendar day. Installment generation is repeatable and protected by an organization/schedule/due-date unique constraint. Draft schedules can be edited; active schedules cannot be edited, and active schedules with the same lease and charge category cannot have overlapping date ranges. Schedule writes serialize on the owning Lease row.

Schedules must remain within the recorded Lease term. Boundary periods that do not align with due dates are flagged for manual review; the service never calculates a prorated amount. Only the `base_rent` charge category is implemented. The service does not collect payments, reconcile accounts, infer legal obligations, or apply rent-review rules.

## Scope and tender evidence

No Oxford City Council OCC001059 tender specification was found in the local repository during this milestone. The model and API below are proposed BOWERA product capabilities; none should be represented as verified tender requirements.

Implemented: organization-scoped lease references, term dates and optional break date, bounded lifecycle status, decimal rent and currency, payment frequency, landlord/tenant/guarantor records, multiple Unit associations, joint tenants, create/read/update, and transactional audit history.

Deferred: payment schedules and reconciliation, indexation and rent reviews, break/renewal notices, document storage, contact details, global party identity resolution, event publication, automated expiry transitions, and the Registry Unit reservation protocol needed to eliminate concurrent change races.
