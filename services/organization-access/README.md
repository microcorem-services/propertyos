# Organization & Access Service

The service exposes `/health` as a lightweight liveness check and `/ready` as a database readiness check. Set `DATABASE_URL` to a synchronous PostgreSQL SQLAlchemy URL such as `postgresql+psycopg://user:password@host:5432/database`. The local Compose configuration supplies this URL automatically.

The SQLAlchemy engine is created from configuration when the service imports, but does not open a database connection until `/ready` checks it with `SELECT 1` or a database session is requested. `/health` does not depend on the database. `/ready` returns `503 Service Unavailable` when `DATABASE_URL` is missing or PostgreSQL cannot be reached.

Database sessions are provided by the `get_db` dependency in `app/database.py`. SQLAlchemy metadata in `app/models.py` defines organizations, users, and their memberships; it does not create tables. Each membership references one organization and user. Users have a unique external identity subject, and an organization-user pair can have at most one membership.

Organization status values are `active` and `suspended`. Membership roles are `owner`, `admin`, and `member`; membership statuses are `invited`, `active`, and `suspended`. These values are stored as strings and checked by database constraints, but do not implement authorization. Timestamps use timezone-aware columns with UTC defaults.

Authentication, authorization, audit events, and public CRUD endpoints are not implemented.

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