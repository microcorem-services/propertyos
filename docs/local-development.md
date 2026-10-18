# Local Microservices Development

M0.1 adds two independent FastAPI health-only service skeletons. Their database URLs are configured, and Compose starts separate local PostgreSQL instances, but neither service currently connects to its database or persists domain data. No Cognito authentication, authorization, organisation isolation, event messaging, or AWS deployment is implemented. Do not use real customer data.

## Prerequisites

- Docker Desktop (or a compatible Docker Engine) with Compose v2 running
- Python 3.12 or newer for tests and running services outside Docker
- Node.js 22 or newer for the existing Next.js application

## Configure local Compose

From the repository root:

```bash
cp infra/local/.env.example infra/local/.env
```

Set both database passwords in `infra/local/.env` before starting Compose. Generate local-only values, for example, with `openssl rand -hex 24`; do not commit `.env` or paste its values into logs. The checked-in example contains no credentials. Service and database host ports can be changed independently in this file.

## Start services

From the repository root, start just one service and its own database:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml up --build organization-access
```

In a second terminal, the other service can be started independently:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml up --build property-assets
```

Or start both:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml up --build
```

The default health URLs are `http://localhost:8101/health` and `http://localhost:8102/health`. Default PostgreSQL host ports are 55431 and 55432. Database ports bind to loopback only. Each service has its own database container, user, database name, and named volume.

## Stop services and data

Stop containers and remove the Compose network while retaining database volumes:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml down
```

To stop one service and its database, use `docker compose ... stop organization-access` or `stop property-assets`. Do not add `-v` to `down` unless you explicitly intend to permanently remove both local database volumes and their data.

## Test service skeletons

Each test suite runs independently. Create and populate a Python virtual environment only when needed:

```bash
cd services/organization-access
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q
```

Run the equivalent commands from `services/property-assets`. Tests use FastAPI's test client and do not require Docker or PostgreSQL.

## Run a service without Compose

From the respective service directory, install its runtime dependencies in a local virtual environment, then run:

```bash
SERVICE_PORT=8101 uvicorn app.main:app --host 127.0.0.1 --port 8101
```

Use a different `SERVICE_PORT` and `--port` for the property-assets service (default 8102). At this milestone the health-only services do not open database connections, so they can start without PostgreSQL.

## Existing Phase 2 application

The Next.js app and original FastAPI/PostgreSQL backend remain at the repository root and in `backend/`. They are not moved or replaced by these service skeletons. Continue to use the existing README instructions for the Phase 2 UI and backend. The Next.js frontend still calls the original backend; the new services are not wired into it yet.