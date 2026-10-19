# Property & Asset Registry Service

The service exposes `/health` and owns its PostgreSQL database, SQLAlchemy metadata, and Alembic migrations. Its initial schema contains the `portfolios` table. The published Phase 2 property API remains in `backend/`.

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

The migration can be reversed with `alembic downgrade base`; this drops the `portfolios` table and should only be used against an explicitly selected disposable database/schema or when intentionally removing the service schema.

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
