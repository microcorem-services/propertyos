# Organization & Access Service

The service exposes `/health` as a lightweight liveness check and `/ready` as a database readiness check. Set `DATABASE_URL` to a synchronous PostgreSQL SQLAlchemy URL such as `postgresql+psycopg://user:password@host:5432/database`. The local Compose configuration supplies this URL automatically.

The SQLAlchemy engine is created from configuration when the service imports, but does not open a database connection until `/ready` checks it with `SELECT 1` or a database session is requested. `/health` does not depend on the database. `/ready` returns `503 Service Unavailable` when `DATABASE_URL` is missing or PostgreSQL cannot be reached.

Database sessions are provided by the `get_db` dependency in `app/database.py`. SQLAlchemy metadata in `app/models.py` defines organizations, users, and their memberships; it does not create tables. Each membership references one organization and user. Users have a unique external identity subject, and an organization-user pair can have at most one membership.

Organization status values are `active` and `suspended`. Membership roles are `owner`, `admin`, and `member`; membership statuses are `invited`, `active`, and `suspended`. These values are stored as strings and checked by database constraints, but do not implement authorization. Timestamps use timezone-aware columns with UTC defaults.

Authentication, authorization, audit events, and public CRUD endpoints are not implemented.

## API foundation and future routes

Versioned API routes will use `/api/v1`. The prefix is reserved in the application, but there are currently no database-backed API routes. `/health` and `/ready` remain unversioned operational endpoints.

Pydantic response schemas define the current organization, user, and membership response shapes. API errors are intended to use an `error` object containing a stable `code` and human-readable `message`. These schemas do not expose data by themselves.

Proposed read-only endpoints, to be added only with authentication and authorization:

- `GET /api/v1/organizations` and `GET /api/v1/organizations/{organization_id}` — require an authenticated identity and organization-scoped authorization.
- `GET /api/v1/users/me` — require authentication and may return only the caller's own user profile.
- `GET /api/v1/organizations/{organization_id}/memberships` — require authentication plus authorization to view membership data for that organization.

There are no create, update, or delete endpoints. No unauthenticated caller may retrieve organization, user, or membership records. Authentication, membership checks, and role-based policy must be implemented and reviewed before any of these routes are exposed.

## Cognito access-token verification foundation

The reusable `verify_access_token` dependency in `app/auth.py` verifies Cognito JWT access tokens using the regional issuer's JWKS. Configure `COGNITO_ISSUER`, `COGNITO_USER_POOL_REGION`, `COGNITO_APP_CLIENT_ID`, and `COGNITO_REQUIRED_SCOPE` in the service environment. The issuer must be the HTTPS issuer URL for that region's Cognito user pool; its hostname is checked against the configured region. The client ID is matched against the access token's Cognito `client_id` claim, and the configured scope must be present in its space-delimited `scope` claim.

Verification accepts RS256 only and validates the signature, issuer, expiry, required token claims, `token_use=access`, client ID, and required scope. It does not accept Cognito ID tokens or grant access based on authentication alone. Missing, malformed, expired, incorrectly signed, wrong-issuer, wrong-client, and insufficient-scope tokens receive the same `401` error envelope. JWKS retrieval is lazy and uses a five-second timeout. Missing or invalid server configuration fails closed with `503`; no placeholder identity is created.

The expected deployment boundary is a Next.js BFF using Authorization Code with PKCE, which forwards the Cognito access token to this API. This milestone does not implement login, token issuance, browser token storage, the BFF, or organization authorization. A verified identity still has no organization or tenant access until a separate authorization layer checks it.

## Organization membership authorization foundation

`require_organization_membership()` in `app/authorization.py` is the reusable authorization dependency for future organization-scoped routes. Routes must supply an explicit `organization_id` path parameter; the dependency obtains identity only from `verify_access_token`, resolves the token's `sub` to `users.external_subject`, and checks that the organization and matching membership are active. Callers may supply an explicit set of permitted `MembershipRole` values for an operation; no administrator role is granted by default.

Successful authorization returns only an `AuthorizedMembership` context. Missing users or memberships, suspended records, role mismatches, and database lookup/configuration failures return the same `403` response and reveal no organization data. Authentication proves the Cognito identity; membership authorization separately limits that identity to an active, explicitly requested organization. These helpers do not expose endpoints or manage memberships.

## Database migrations

The service owns its Alembic configuration in `alembic.ini` and `migrations/`. From the repository root, use the local Compose configuration to apply migrations to the dedicated `bowera_org_access` development database:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml run --build --rm organization-access alembic upgrade head
```

Inspect the applied revision and available migration history with:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml run --rm organization-access alembic current
docker compose --env-file infra/local/.env -f infra/local/compose.yaml run --rm organization-access alembic history
```

The Compose service obtains `DATABASE_URL` from the ignored local environment file. Do not point migration commands at the Phase 2 database or production. The initial revision creates the organization, user, and membership schema; it does not create or populate application records.

## Database integration tests

The integration tests use the ignored local `infra/local/.env` configuration and require the Organization & Access PostgreSQL Compose database to be running. They verify its database and local role identity before creating a uniquely named `m02d_test_*` schema, apply the service Alembic migration to that schema, and drop only that schema after the test run. They never migrate or clean the public development schema.

From the repository root:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml up -d organization-access-db
cd services/organization-access
.venv/bin/python -m pytest -q
```

The complete suite includes the PostgreSQL integration tests. Stop the database container afterward, retaining its named volume:

```bash
docker compose --env-file ../../infra/local/.env -f ../../infra/local/compose.yaml stop organization-access-db
```

See [local development](../../docs/local-development.md) for Docker Compose and test commands.