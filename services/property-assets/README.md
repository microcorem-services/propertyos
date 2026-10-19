# Property & Asset Registry Service

The service exposes `/health` and owns its PostgreSQL database, SQLAlchemy metadata, and Alembic migrations. Its initial schema contains the `portfolios` table; no CRUD API, authentication, or authorization is implemented yet. The published Phase 2 property API remains in `backend/`.

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
