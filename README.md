# Microcorem PropertyOS

A local demonstration of a property asset management application.

## Implementation status

Phase 2 provides a searchable and sortable properties table; create, view, edit, and delete workflows; FastAPI CRUD endpoints; PostgreSQL persistence through SQLAlchemy; an Alembic schema migration; and portfolio statistics calculated from stored records. The app starts with an empty portfolio. An optional command seeds fictional demonstration records.

This is not production-ready: the Cognito login foundation is not yet connected to the Phase 2 application, and application authorization, tenant isolation, audit history, operational monitoring, backups, and deployment are not implemented. Do not enter real customer or confidential information.

## Microservices workspace (M0.1)

The initial Organization & Access and Property & Asset Registry FastAPI service skeletons are under `services/`. They currently expose health endpoints only. Docker Compose provides independent local PostgreSQL containers and configurable ports; no service persistence, authentication, authorization, tenant isolation, AWS resources, or deployment is implemented yet. The existing Phase 2 frontend and backend remain in place and are not yet connected to the new services.

See [local development](docs/local-development.md) for service startup and test instructions, and [ADR-0001](docs/adr/0001-domain-owned-microservices.md) for the accepted architecture decision.

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

## Next.js server-side session foundation

The App Router has a server-only session abstraction in `src/lib/auth/`. It creates cryptographically random opaque identifiers, stores only a SHA-256 digest as the session-store key, rotates identifiers atomically, and enforces an eight-hour absolute lifetime and a thirty-minute sliding idle lifetime by default. Production cookies use the `__Host-propertyos_session` name with `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`. Local development uses a non-Secure cookie unless `SESSION_COOKIE_SECURE=true` is set; production cannot disable `Secure`.

The Cognito login/callback foundation and a same-origin `GET /api/organizations` BFF route are implemented; portfolio BFF routes are not yet provided. The organization route reads the opaque session cookie server-side, validates the session and access-token expiry, and forwards the access token only to Organization & Access. Configure `ORGANIZATION_ACCESS_URL` as a private server-side HTTPS service origin. `ORGANIZATION_ACCESS_TIMEOUT_MS` defaults to 3000 and is capped at 10000. For local development only, `ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP=true` permits HTTP to loopback addresses. Do not use `NEXT_PUBLIC_` variables for service URLs or credentials. The BFF enforces no-store behavior and validates the bounded organization-list response.

`SessionStore` is an interface, and `src/lib/auth/dynamodb-session-store.ts` provides a DynamoDB adapter. Configure it with `configureSessionStore(createConfiguredDynamoDbSessionStore())` before using `getSessionManager`. Missing table/region configuration and DynamoDB failures are surfaced; there is no process-local production fallback. Store Cognito tokens only in server-side session data and never log them or put them in the cookie.

Session unit tests use an in-memory store defined only in the test file.

### Cognito OIDC login prerequisites

The App Router exposes `GET /api/auth/login`, `GET /api/auth/callback`, and same-origin `POST /api/auth/logout`. Set `COGNITO_ISSUER` to the exact HTTPS issuer URL for the Cognito user pool, `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, `COGNITO_CALLBACK_URL` to the exact registered callback (for example `https://app.example/api/auth/callback`), and `APP_ORIGIN` to the app origin (for example `https://app.example`). `COGNITO_SCOPES` is optional and defaults to `openid`; configure the OIDC scopes required by the user-token flow, including the scope expected by Organization & Access. Keep the client secret in server-side secret management. The app client must allow the authorization-code grant, use the callback URL exactly, and be configured for PKCE S256. No implicit flow is used. The OIDC discovery and token requests have five-second timeouts.

Login transactions are stored in DynamoDB for at most ten minutes and bound to an HttpOnly, SameSite=Lax transaction cookie; state, nonce, and PKCE verifier remain server-side. The callback validates state and PKCE through `openid-client`, validates the ID token issuer, audience and nonce, consumes the transaction once before exchanging the code, and establishes an authenticated session, rotating an existing session when present. Local logout is POST-only and requires an exact same-origin `Origin`; it revokes the local session and clears its cookie. Cognito Hosted UI logout/revocation is not performed by this endpoint; configure Cognito logout URLs and add token revocation/hosted logout separately if required.

The DynamoDB table and IAM role prerequisites above also apply to login transactions and authenticated sessions. No Cognito app client, callback URL, secret, AWS table, IAM permission, or hosted logout resource is provisioned by this code.

### DynamoDB session table prerequisites

The adapter expects a table with one string partition key named `sessionKey` and no sort key. Authenticated sessions are limited in code to an eight-hour maximum absolute lifetime; login transactions live for ten minutes. Session items include the SHA-256 `familyKey`; rotation retains a token-free `rotated` predecessor record through the family's absolute expiry plus a 60-second TTL margin, so a logout racing rotation can still identify the family. Explicit revocation requires the addressed record to remain active in the same atomic transaction that writes a `revoked#<familyKey>` marker and removes the record. If rotation wins first, stale-cookie logout reports a conflict and does not revoke the descendant; if logout wins first, the marker prevents rotation. Marker TTL is rounded up to whole Unix-epoch seconds and includes a 60-second retention margin. Deployment hosts must synchronize clocks to UTC within 30 seconds of the DynamoDB service clock; this is a deployment requirement, and the margin exceeds the permitted skew. Do not run hosts outside this clock bound. The retention policy assumes DynamoDB TTL removes items only after the configured epoch-second expiry; TTL deletion is asynchronous, so items can persist longer. Record cleanup deletes only the addressed key and never revokes the family. Enable DynamoDB TTL on the numeric `expiresAt` attribute; session and marker TTL values are cleanup hints only. Application-level absolute/idle expiry and atomic conditions enforce authorization independently of TTL deletion.

Set `SESSION_DYNAMODB_TABLE` and `AWS_REGION` in the server environment. `SESSION_IDLE_TTL_SECONDS` defaults to 1800 and must match the session manager's idle TTL. The SDK uses its standard IAM credential provider chain (for example, the workload's task/pod/instance role); do not configure static access keys. Grant the role only `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem`, and `dynamodb:TransactWriteItems` on this table. Enable DynamoDB server-side encryption at rest (AWS-owned or customer-managed KMS key) and use TLS in transit. Provisioning, table creation, TTL enablement, IAM roles/policies, and KMS configuration are deployment prerequisites and are not performed by this code change.