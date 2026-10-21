# Local Microservices Development

Organization & Access and Property & Asset Registry have independent PostgreSQL databases. Lease Management adds a third database and validates Unit references through the authenticated Registry API. These local services are development foundations; do not use real customer data.

## Prerequisites

- Docker Desktop (or a compatible Docker Engine) with Compose v2 running
- Python 3.12 or newer for tests and running services outside Docker
- Node.js 22 or newer for the existing Next.js application

## Configure local Compose

From the repository root:

```bash
cp infra/local/.env.example infra/local/.env
```

Set all three database passwords in `infra/local/.env` before starting Compose. To exercise authenticated Lease Management requests, configure the workload client values required by Cognito as well. Generate local-only values, for example, with `openssl rand -hex 24`; do not commit `.env` or paste its values into logs. The checked-in example contains no credentials. Service and database host ports can be changed independently in this file.

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

The default health URLs are `http://localhost:8101/health` and `http://localhost:8102/health`. Organization & Access readiness, including its PostgreSQL connectivity check, is at `http://localhost:8101/ready`. Default PostgreSQL host ports are 55431 and 55432. Database ports bind to loopback only. Each service has its own database container, user, database name, and named volume.

Lease Management is available at `http://localhost:8103`; its readiness check is `http://localhost:8103/ready`. Its PostgreSQL port defaults to 55433 and uses a separate named volume. To start it with its own database and its service dependencies:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml up --build lease-management
```

The local Compose network enables HTTP only for internal service-to-service calls. Production configurations must use HTTPS and properly scoped workload credentials.

## Stop services and data

Stop containers and remove the Compose network while retaining all database volumes:

```bash
docker compose --env-file infra/local/.env -f infra/local/compose.yaml down
```

To stop one service and its database, use `docker compose ... stop organization-access`, `stop property-assets`, or `stop lease-management`. Do not add `-v` to `down` unless you explicitly intend to permanently remove local database volumes and their data.

## Test service skeletons

Each test suite runs independently. Create and populate a Python virtual environment only when needed:

```bash
cd services/organization-access
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q
```

Run the equivalent commands from `services/property-assets`. Tests use FastAPI's test client. Organization & Access database checks use SQLite and simulated connection failure, so its tests do not require Docker or PostgreSQL.

Lease Management tests run from `services/lease-management` with its `requirements-dev.txt`. They use SQLite and mock the Organization & Access and Registry boundaries; no live tokens, services, or Docker are required.

## Run a service without Compose

From the respective service directory, install its runtime dependencies in a local virtual environment, then run:

```bash
SERVICE_PORT=8101 uvicorn app.main:app --host 127.0.0.1 --port 8101
```

Use a different `SERVICE_PORT` and `--port` for the Property & Asset Registry (default 8102) or Lease Management (default 8103). `/health` is an application liveness check; `/ready` requires the service's own configured database. Lease API operations also require valid workload credentials and reachable Organization & Access and Property & Asset Registry APIs. Unit deactivation checks active or draft lease references through Lease Management and fails closed when that service is unavailable. Lease Management's Alembic migration must be run manually against a developer-controlled database; Compose does not apply migrations automatically.

## Existing Phase 2 application

The Next.js app and original FastAPI/PostgreSQL backend remain at the repository root and in `backend/`. They are not moved or replaced by these service foundations. Continue to use the existing README instructions for the Phase 2 UI and backend. The M0.9-B lease interface uses a same-origin BFF route to connect to Lease Management; the rest of the existing Phase 2 behavior is unchanged.

## Lease Management browser interface

The Next.js app includes the M0.9-B lease register and create, view, and update
screens. To connect a locally running Next.js app to the local Lease Management
service, set these server-side variables in the Next.js process environment
(for example, in the ignored root `.env.local` file):

```dotenv
LEASE_MANAGEMENT_URL=http://127.0.0.1:8103
LEASE_MANAGEMENT_ALLOW_INSECURE_LOCAL_HTTP=true
LEASE_MANAGEMENT_TIMEOUT_MS=3000
```

The insecure HTTP setting is for loopback development only; production requires
HTTPS. The browser calls only same-origin `/api/leases` routes. The Next.js BFF
uses the existing authenticated session; Lease Management independently checks
organization permissions and uses its configured workload identity for its
service-to-service calls. The local Lease service, database, Cognito workload
configuration, Organization & Access, and Property & Asset Registry must be
running and configured for authenticated read/write operations. Never put
workload credentials in client-side variables such as `NEXT_PUBLIC_*`.