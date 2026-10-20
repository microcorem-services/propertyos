# Property & Asset Registry Service

The service exposes `/health` and owns its PostgreSQL database, SQLAlchemy metadata, and Alembic migrations. Its schema contains the portfolio, site, building, and unit tables. The published Phase 2 property API remains in `backend/`.

## Internal workload token provider

`app/workload_token.py` provides OAuth 2.0 `client_credentials` tokens for trusted calls to Organization & Access. Configure these environment variables at deployment time:

- `COGNITO_TOKEN_ENDPOINT_URL`: the Cognito managed-login OAuth token endpoint URL.
- `COGNITO_WORKLOAD_CLIENT_ID` and `COGNITO_WORKLOAD_CLIENT_SECRET`: credentials for the dedicated Property & Asset Registry workload app client. Do not commit or log the secret.
- `COGNITO_WORKLOAD_REQUIRED_SCOPE`: the service scope registered for this workload and required by Organization & Access.
- `COGNITO_TOKEN_CONNECT_TIMEOUT_SECONDS` and `COGNITO_TOKEN_READ_TIMEOUT_SECONDS`: positive HTTP timeouts in seconds (defaults: 2 and 3).
- `COGNITO_ALLOW_INSECURE_TOKEN_ENDPOINT`: defaults to false. Set to `true` only for local testing; plain HTTP is then still restricted to `localhost` or a loopback IP address.

Production token endpoints must use HTTPS. The provider sends a Basic client-authentication header and a form-encoded `grant_type=client_credentials` request with the required scope. It validates the bearer token response and caches the access token only in process memory until shortly before expiry; it does not persist credentials or tokens. Missing configuration, request failures, and malformed responses fail closed with a sanitized `WorkloadTokenError`. No real workload credentials or AWS resources are included in this repository. Provision the dedicated Cognito app client, secret and allowed scope separately before enabling service-to-service calls.

## Protected portfolio listing

`GET /api/v1/portfolios?organization_id=<UUID>` requires `Authorization: Bearer <user-access-token>`. The service forwards that token alongside a separate token from the workload-token provider to `POST /internal/v1/authorization/decisions` in Organization & Access, requesting `property-assets.portfolios.read`. It accepts access only when the response explicitly matches the requested organization and operation and sets `allowed` to `true`. Organization & Access remains the sole authority for membership; Property & Asset Registry never queries its database.

Configure `ORGANIZATION_ACCESS_URL` as the Organization & Access base URL. `ORGANIZATION_ACCESS_CONNECT_TIMEOUT_SECONDS` and `ORGANIZATION_ACCESS_READ_TIMEOUT_SECONDS` are positive bounded timeouts in seconds (defaults: 2 and 3). HTTPS is required except when `ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP=true`; even then, HTTP is limited to `localhost` or a loopback IP. Missing configuration, unexpected service responses, and transport failures return sanitized `503`; invalid user credentials return `401`, and an explicit authorization denial returns `403`. Portfolio queries include the authorized `organization_id` predicate.

## Protected portfolio detail

`GET /api/v1/portfolios/{portfolio_id}?organization_id=<UUID>` uses the same user bearer token, workload token, and `property-assets.portfolios.read` organization decision as listing. The path ID and query organization ID are selectors, not proof of access. The service verifies that Organization & Access authorized the requested organization and retrieves the portfolio using both `id` and the authorized `organization_id`. A missing portfolio and a portfolio belonging to another organization both return the same `404` response. Successful responses use the same minimal `PortfolioResponse` contract as the list endpoint.

## Portfolio writes and audit trail

The Registry exposes `POST /api/v1/portfolios?organization_id=<UUID>` and `PATCH /api/v1/portfolios/{portfolio_id}?organization_id=<UUID>`. Each request independently asks Organization & Access for the matching `property-assets.portfolios.create` or `property-assets.portfolios.update` decision. Active owners and admins may write; active members remain read-only. The client may change only `name` and `status`; unknown, ownership, audit, and system fields are rejected. Updates match both portfolio ID and authorized organization ID, so a cross-organization target is indistinguishable from a missing portfolio.

The Registry owns `portfolio_audit_events`. Successful mutations and their audit rows are written in one database transaction. Each row contains organization ID, portfolio ID, operation, trusted `actor_id` returned by Organization & Access, timestamp, and the names of permitted changed fields. Field values, credentials, and bearer tokens are not recorded. Apply the current Registry Alembic head before using write routes.

The same-origin Next.js BFF provides `GET /api/portfolio-write-permissions?organizationId=<UUID>`, `POST /api/portfolios?organizationId=<UUID>`, and `PATCH /api/portfolios/{portfolioId}?organizationId=<UUID>`. Its cookie-authenticated write handlers require the request `Origin` to exactly match `APP_ORIGIN`; they keep Cognito tokens server-side, restrict upstream destinations to the configured Registry origin, bound request size and time, reject redirects, and return no-store sanitized responses.

## Site writes and audit trail

The Registry exposes `POST /api/v1/sites?organization_id=<UUID>` and `PATCH /api/v1/sites/{site_id}?organization_id=<UUID>`. Site creation requires a `portfolio_id` belonging to the authorized organization; updates cannot change the portfolio or organization. Only `name`, `address`, and `status` are editable. Organization & Access grants `property-assets.sites.create` and `property-assets.sites.update` only to active owners and admins; each Registry mutation independently requests its matching decision.

Successful mutations and their `site_audit_events` rows share one transaction. Audit rows include organization, site, operation, trusted actor ID, timestamp, and permitted changed-field names, but no field values, credentials, or tokens. Apply migration `0006_site_audit` before enabling these routes. The Next.js BFF exposes `GET /api/site-write-permissions?organizationId=<UUID>`, `POST /api/sites?organizationId=<UUID>&portfolioId=<UUID>`, and `PATCH /api/sites/{siteId}?organizationId=<UUID>&portfolioId=<UUID>`; write protections match the portfolio BFF.

## Building writes and audit trail

The Registry exposes `POST /api/v1/buildings?organization_id=<UUID>` and `PATCH /api/v1/buildings/{building_id}?organization_id=<UUID>&portfolio_id=<UUID>&site_id=<UUID>`. Creation includes the portfolio and site IDs in its validated body. Both operations independently request `property-assets.buildings.create` or `property-assets.buildings.update` from Organization & Access; only active owners and admins may write. Creation verifies that the site belongs to the supplied portfolio and authorized organization. Updates verify the building's complete parent path and cannot move it to another site or organization. Only `name`, `building_code`, `address`, and `status` are editable; protected and unknown fields are rejected.

Successful mutations and their `building_audit_events` rows share one database transaction. Audit rows record organization, building, operation, trusted actor ID, timestamp, and permitted changed-field names without field values, credentials, or tokens. Apply migration `0007_building_audit` before enabling these routes. The Next.js BFF exposes `GET /api/building-write-permissions?organizationId=<UUID>`, `POST /api/buildings?organizationId=<UUID>&portfolioId=<UUID>&siteId=<UUID>`, and `PATCH /api/buildings/{buildingId}?organizationId=<UUID>&portfolioId=<UUID>&siteId=<UUID>`. It reuses the server-side session, Origin/CSRF checks, Registry origin restriction, timeout, redirect protection, strict response parsing, and no-store behavior of the site write endpoints.

## Protected property hierarchy

The following read-only endpoints use the same user authentication and `property-assets.portfolios.read` organization decision:

- `GET /api/v1/portfolios/{portfolio_id}/sites?organization_id=<UUID>`
- `GET /api/v1/portfolios/{portfolio_id}/sites/{site_id}?organization_id=<UUID>`
- `GET /api/v1/portfolios/{portfolio_id}/sites/{site_id}/buildings?organization_id=<UUID>`
- `GET /api/v1/portfolios/{portfolio_id}/sites/{site_id}/buildings/{building_id}?organization_id=<UUID>`
- `GET /api/v1/portfolios/{portfolio_id}/sites/{site_id}/buildings/{building_id}/units?organization_id=<UUID>`
- `GET /api/v1/portfolios/{portfolio_id}/sites/{site_id}/buildings/{building_id}/units/{unit_id}?organization_id=<UUID>`

Every query is scoped to the authorized organization and supplied parent IDs. Building and unit queries join only Registry-owned tables to verify the full parent chain. Missing and out-of-scope assets return the same `404`. Responses use explicit schemas and contain only fields defined by the Registry models. Organization & Access remains the membership authority; no cross-service database queries are made.

## Database setup

Set `DATABASE_URL` to a synchronous PostgreSQL SQLAlchemy URL for the dedicated Property & Asset Registry database. The local Compose configuration uses the separate `bowera_property_assets` database and `property-assets-data` volume. Do not configure this service with the Phase 2 or Organization & Access database.

The engine is constructed lazily from `DATABASE_URL`: importing the application does not establish a database connection. Database sessions are provided by `get_db` in `app/database.py`.

`Portfolio.organization_id` is a required UUID and indexed cross-service identifier. It intentionally has no foreign key to Organization & Access. The model does not itself enforce tenant authorization.

## Migrations

Apply the initial migration to the dedicated local database from the repository root:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml run --build --rm property-assets alembic upgrade head
```

Inspect the current revision and migration history:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml run --rm property-assets alembic current
docker compose --env-file infra/local/.env -f infra/local/compose.yaml run --rm property-assets alembic history
```

The migration chain creates the portfolio, site, building, and unit tables. It can be reversed with `alembic downgrade base`; this drops the Registry schema and should only be used against an explicitly selected disposable database/schema or when intentionally removing the service schema.

## Tests

The PostgreSQL integration tests require the dedicated local service database. They verify its identity, create a uniquely named disposable schema, apply the service migration there, and remove only that schema after the run.

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml up -d property-assets-db
cd services/property-assets
.venv/bin/python -m pytest -q
```

Stop the test database container afterward while retaining its named volume:

```bash
docker compose --env-file ../../infra/local/.env -f ../../infra/local/compose.yaml stop property-assets-db
```

See [local development](../../docs/local-development.md) for Docker Compose and test commands.
