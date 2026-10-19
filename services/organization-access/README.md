# Organization & Access Service

The service exposes `/health` as a lightweight liveness check and `/ready` as a database readiness check. Set `DATABASE_URL` to a synchronous PostgreSQL SQLAlchemy URL such as `postgresql+psycopg://user:password@host:5432/database`. The local Compose configuration supplies this URL automatically.

The SQLAlchemy engine is created from configuration when the service imports, but does not open a database connection until `/ready` checks it with `SELECT 1` or a database session is requested. `/health` does not depend on the database. `/ready` returns `503 Service Unavailable` when `DATABASE_URL` is missing or PostgreSQL cannot be reached.

Database sessions are provided by the `get_db` dependency in `app/database.py`. SQLAlchemy metadata in `app/models.py` defines organizations, users, and their memberships; it does not create tables. Each membership references one organization and user. Users have a unique external identity subject, and an organization-user pair can have at most one membership.

Organization status values are `active` and `suspended`. Membership roles are `owner`, `admin`, and `member`; membership statuses are `invited`, `active`, and `suspended`. These values are stored as strings and checked by database constraints, but do not implement authorization. Timestamps use timezone-aware columns with UTC defaults.

Audit events and public CRUD endpoints are not implemented.

## API foundation and future routes

Versioned API routes use `/api/v1`. `/health` and `/ready` remain unversioned operational endpoints.

Pydantic response schemas define the current organization, user, and membership response shapes. API errors use an `error` object containing a stable `code` and human-readable `message`. These schemas do not expose data by themselves.

### Protected organization detail

`GET /api/v1/organizations/{organization_id}` returns the public organization fields `id`, `name`, `status`, `created_at`, and `updated_at`. The caller must provide a valid Cognito access token and have an active membership in the explicitly requested active organization. Invalid UUIDs return `422`; authentication failures return `401`; missing, inactive, or mismatched memberships return a generic `403`; database failures return a sanitized `503`. The response excludes users, memberships, and internal database details.

Other proposed read-only endpoints, to be added only with authentication and authorization:

- `GET /api/v1/organizations` — requires an authenticated identity and organization-scoped authorization.
- `GET /api/v1/users/me` — require authentication and may return only the caller's own user profile.
- `GET /api/v1/organizations/{organization_id}/memberships` — require authentication plus authorization to view membership data for that organization.

There are no create, update, or delete endpoints. No unauthenticated caller may retrieve organization, user, or membership records. Authentication, membership checks, and any role-based policy must be implemented and reviewed before additional routes are exposed.

## Cognito access-token verification foundation

The reusable `verify_access_token` dependency in `app/auth.py` verifies Cognito JWT access tokens using the regional issuer's JWKS. Configure `COGNITO_ISSUER`, `COGNITO_USER_POOL_REGION`, `COGNITO_APP_CLIENT_ID`, and `COGNITO_REQUIRED_SCOPE` in the service environment. The issuer must be the HTTPS issuer URL for that region's Cognito user pool; its hostname is checked against the configured region. The client ID is matched against the access token's Cognito `client_id` claim, and the configured scope must be present in its space-delimited `scope` claim.

Verification accepts RS256 only and validates the signature, issuer, expiry, required token claims, `token_use=access`, client ID, and required scope. It does not accept Cognito ID tokens or grant access based on authentication alone. Missing, malformed, expired, incorrectly signed, wrong-issuer, wrong-client, and insufficient-scope tokens receive the same `401` error envelope. JWKS retrieval is lazy and uses a five-second timeout. Missing or invalid server configuration fails closed with `503`; no placeholder identity is created.

The expected deployment boundary is a Next.js BFF using Authorization Code with PKCE, which forwards the Cognito access token to this API. This service does not implement login, token issuance, browser token storage, or the BFF. Token verification alone does not grant organization or tenant access; protected organization routes also require a separate membership authorization check.

## Organization membership authorization foundation

`require_organization_membership()` in `app/authorization.py` is the reusable authorization dependency for future organization-scoped routes. Routes must supply an explicit `organization_id` path parameter; the dependency obtains identity only from `verify_access_token`, resolves the token's `sub` to `users.external_subject`, and checks that the organization and matching membership are active. Callers may supply an explicit set of permitted `MembershipRole` values for an operation; no administrator role is granted by default.

Successful authorization returns only an `AuthorizedMembership` context. Missing users or memberships, suspended records, and role mismatches return the same `403` response. Database lookup/configuration failures return a sanitized `503` and never grant access. Authentication proves the Cognito identity; membership authorization separately limits that identity to an active, explicitly requested organization. These helpers do not manage memberships.

## Internal portfolio-read authorization decision

`POST /internal/v1/authorization/decisions` is an internal service endpoint. It accepts only an `organization_id` UUID and the operation `property-assets.portfolios.read`. The caller must present both a user Cognito access token in `Authorization: Bearer ...` and a separate workload Cognito access token in `X-Service-Authorization: Bearer ...`.

The user token is verified with the existing user-pool issuer, `COGNITO_APP_CLIENT_ID`, and `COGNITO_REQUIRED_SCOPE`; its verified `sub` is the only user identity used for membership lookup. The workload token is independently verified against the same configured Cognito issuer/JWKS, but must have the distinct `COGNITO_WORKLOAD_CLIENT_ID`, `COGNITO_WORKLOAD_REQUIRED_SCOPE`, and `token_use=access`. User and workload client IDs must differ. Do not forward the user token as the workload credential or trust caller-supplied user IDs or roles.

An active user membership in an active organization receives a minimal decision containing only the organization ID, operation, and `allowed: true`. Missing or invalid credentials return a generic `401`, inactive or absent membership returns a generic `403`, invalid request fields or unsupported operations return `422`, and missing verifier configuration or database failures fail closed with a sanitized `503`. No membership records or personal information are returned. The service caller must be restricted to a trusted network/service boundary; this endpoint does not itself provision workload credentials.

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