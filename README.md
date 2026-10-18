# Microcorem PropertyOS

A local demonstration of a property asset management application.

## Implementation status

Phase 2 provides a searchable and sortable properties table; create, view, edit, and delete workflows; FastAPI CRUD endpoints; PostgreSQL persistence through SQLAlchemy; an Alembic schema migration; and portfolio statistics calculated from stored records. The app starts with an empty portfolio. An optional command seeds fictional demonstration records.

This is not production-ready: authentication, authorization, tenant isolation, audit history, operational monitoring, backups, and deployment are not implemented. Do not enter real customer or confidential information.

## Technology

- Next.js 15 and React 19 with TypeScript 5
- FastAPI with SQLAlchemy 2 and PostgreSQL via Psycopg 3
- Alembic migrations and pytest API tests

## Local setup

Requires Node.js 22+, Python 3.12+, and a local PostgreSQL server. Start PostgreSQL using the service manager for your installation, then create a dedicated empty development database:

```bash
createdb propertyos
```

In a terminal, configure and start the backend:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL='postgresql+psycopg:///propertyos'
alembic upgrade head
uvicorn app.main:app --reload
```

The URL above uses local PostgreSQL socket authentication. If your server requires a username, password, or TCP connection, set `DATABASE_URL` to the connection URL for this local development database. Keep credentials in your shell or a local secret manager; do not commit them or add an environment file.

In a second terminal, start the frontend:

```bash
npm install
npm run dev
```

The frontend defaults to `http://localhost:8000` for its API. Set `NEXT_PUBLIC_API_URL` before starting Next.js to use a different local API URL. Open http://localhost:3000. The API health endpoint is http://localhost:8000/health.

To optionally populate an empty database with fictional records, run after applying migrations:

```bash
cd backend
source .venv/bin/activate
export DATABASE_URL='postgresql+psycopg:///propertyos'
PYTHONPATH=. python scripts/seed_demo.py
```

The seed command does nothing when the database already contains properties. It does not delete or overwrite data.

## Tests and migrations

Run the backend tests from `backend/`. They use an isolated in-memory SQLite database and do not modify PostgreSQL data:

```bash
cd backend
source .venv/bin/activate
PYTHONPATH=. pytest -q
```

Apply future schema revisions from `backend/` with `alembic upgrade head`. The initial migration creates the `properties` table and its validation constraints. Its downgrade drops that table; back up data and review the impact before any downgrade.

Run the frontend TypeScript check with `npm run lint`, and create a production bundle with `npm run build`.

## Security and publication

Only fictional demonstration records are included in the optional seed and tests. The API currently has no authentication and only allows browser requests from localhost development origins. Do not deploy it or expose it to untrusted networks. Never commit `.env` files, credentials, real tenant information, or private corporate assets. Review files and history before publication.

This project uses AI-assisted development. Review implementation, tests, and security decisions before production use.