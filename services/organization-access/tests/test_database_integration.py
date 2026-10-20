import ipaddress
import json
import os
import re
import subprocess
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from jwt import PyJWKClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import Engine, URL
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app import auth, config
from app import database
from app.auth import AuthenticatedPrincipal, verify_access_token
from app.authorization import (
    AuthorizationDenied,
    AuthorizationServiceUnavailable,
    AuthorizedMembership,
    get_authorization_session,
    require_organization_membership,
)
from app.main import (
    app,
    authorization_denied_handler,
    authorization_service_unavailable_handler,
    _organization_membership_dependency,
)
from app.models import (
    Membership,
    MembershipRole,
    MembershipStatus,
    Organization,
    OrganizationStatus,
    User,
)


SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SERVICE_ROOT.parents[1]
LOCAL_ENV_FILE = REPOSITORY_ROOT / "infra" / "local" / ".env"
EXPECTED_DATABASE = "bowera_org_access"
TEST_ISSUER = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_testpool"
TEST_CLIENT_ID = "fictional-cognito-client"
TEST_REQUIRED_SCOPE = "organization-access/read"


def _read_local_environment() -> dict[str, str]:
    if not LOCAL_ENV_FILE.is_file():
        raise RuntimeError(
            "Integration tests require the ignored infra/local/.env file"
        )

    values = {}
    for raw_line in LOCAL_ENV_FILE.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip("\"'")
    return values


@pytest.fixture(scope="session")
def integration_engine() -> Engine:
    local_config = _read_local_environment()
    if local_config.get("ORG_ACCESS_DB_NAME") != EXPECTED_DATABASE:
        raise RuntimeError(
            "Refusing integration tests: local database name must be "
            f"{EXPECTED_DATABASE}"
        )

    username = local_config.get("ORG_ACCESS_DB_USER")
    password = local_config.get("ORG_ACCESS_DB_PASSWORD")
    if not username or not password:
        raise RuntimeError(
            "Refusing integration tests: local database credentials are incomplete"
        )

    database_url = URL.create(
        "postgresql+psycopg",
        username=username,
        password=password,
        host="127.0.0.1",
        port=int(local_config.get("ORG_ACCESS_DB_PORT", "55431")),
        database=EXPECTED_DATABASE,
    )
    engine = create_engine(
        database_url,
        connect_args={"connect_timeout": 5},
    )
    schema_name = f"m02d_test_{uuid.uuid4().hex}"
    if not re.fullmatch(r"m02d_test_[0-9a-f]{32}", schema_name):
        engine.dispose()
        raise RuntimeError("Refusing integration tests: invalid generated schema name")

    schema_created = False
    schema_engine = None
    try:
        with engine.begin() as connection:
            database, role, address, port = connection.execute(
                text(
                    "SELECT current_database(), current_user, "
                    "inet_server_addr()::text, inet_server_port()"
                )
            ).one()
            if (
                database != EXPECTED_DATABASE
                or role != username
                or port != 5432
                or address is None
                or not ipaddress.ip_interface(address).ip.is_private
            ):
                raise RuntimeError(
                    "Refusing integration tests: connected PostgreSQL identity "
                    "is not the dedicated local Organization & Access database"
                )

            exists = connection.execute(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace "
                    "WHERE nspname = :schema_name)"
                ),
                {"schema_name": schema_name},
            ).scalar_one()
            if exists:
                raise RuntimeError(
                    "Refusing integration tests: generated schema already exists"
                )

            connection.execute(text(f'CREATE SCHEMA "{schema_name}"'))
            schema_created = True

        schema_url = database_url.set(
            query={"options": f"-csearch_path={schema_name}"}
        )
        migration_environment = os.environ.copy()
        migration_environment["DATABASE_URL"] = schema_url.render_as_string(
            hide_password=False
        )
        migration_command = [
            str(SERVICE_ROOT / ".venv" / "bin" / "alembic"),
            "-c",
            "alembic.ini",
            "upgrade",
            "head",
        ]
        try:
            migration = subprocess.run(
                migration_command,
                cwd=SERVICE_ROOT,
                env=migration_environment,
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(
                "Alembic migration timed out while initializing the disposable schema"
            ) from error

        if migration.returncode:
            output = (migration.stdout + migration.stderr).replace(
                password, "[redacted]"
            )
            raise RuntimeError(
                "Alembic migration failed for the disposable schema:\n" + output
            )

        schema_engine = create_engine(
            schema_url,
            connect_args={"connect_timeout": 5},
        )
        with schema_engine.connect() as connection:
            active_database, active_schema = connection.execute(
                text("SELECT current_database(), current_schema()")
            ).one()
            if (
                active_database != EXPECTED_DATABASE
                or active_schema != schema_name
            ):
                raise RuntimeError(
                    "Refusing integration tests: migration connection escaped "
                    "the disposable test schema"
                )

        yield schema_engine
    finally:
        if schema_engine is not None:
            schema_engine.dispose()
        try:
            if schema_created:
                with engine.begin() as connection:
                    connection.execute(text(f'DROP SCHEMA "{schema_name}" CASCADE'))
        finally:
            engine.dispose()


@pytest.fixture
def session(integration_engine: Engine):
    with integration_engine.connect() as connection:
        transaction = connection.begin()
        test_session = Session(
            bind=connection,
            join_transaction_mode="create_savepoint",
        )
        try:
            yield test_session
        finally:
            test_session.close()
            transaction.rollback()


def test_organization_can_be_inserted_and_retrieved(session: Session):
    organization = Organization(
        name="M0.2D Fictional Organization",
        status=OrganizationStatus.ACTIVE.value,
    )
    session.add(organization)
    session.flush()

    retrieved = session.scalar(
        select(Organization).where(Organization.id == organization.id)
    )

    assert retrieved is not None
    assert retrieved.name == "M0.2D Fictional Organization"
    assert retrieved.status == "active"


def test_user_can_be_inserted_and_retrieved(session: Session):
    user = User(external_subject="m02d-fictional-subject-" + uuid.uuid4().hex)
    session.add(user)
    session.flush()

    retrieved = session.scalar(select(User).where(User.id == user.id))

    assert retrieved is not None
    assert retrieved.external_subject == user.external_subject
    assert retrieved.created_at.tzinfo is not None
    assert retrieved.created_at.utcoffset().total_seconds() == 0


def test_membership_references_organization_and_user(session: Session):
    organization = Organization(
        name="M0.2D Membership Organization",
        status=OrganizationStatus.ACTIVE.value,
    )
    user = User(external_subject="m02d-membership-subject-" + uuid.uuid4().hex)
    membership = Membership(
        organization=organization,
        user=user,
        role=MembershipRole.MEMBER.value,
        status=MembershipStatus.ACTIVE.value,
    )
    session.add(membership)
    session.flush()
    session.expire_all()

    retrieved = session.scalar(
        select(Membership).where(Membership.id == membership.id)
    )

    assert retrieved is not None
    assert retrieved.organization.id == organization.id
    assert retrieved.user.id == user.id
    assert retrieved.organization_id == organization.id
    assert retrieved.user_id == user.id


def test_duplicate_external_subject_is_rejected(session: Session):
    subject = "m02d-duplicate-subject-" + uuid.uuid4().hex
    session.add(User(external_subject=subject))
    session.flush()

    session.add(User(external_subject=subject))
    with pytest.raises(IntegrityError):
        session.flush()


def test_duplicate_organization_user_membership_is_rejected(session: Session):
    organization = Organization(
        name="M0.2D Unique Membership Organization",
        status=OrganizationStatus.ACTIVE.value,
    )
    user = User(external_subject="m02d-unique-membership-" + uuid.uuid4().hex)
    session.add_all([organization, user])
    session.flush()

    session.add(
        Membership(
            organization_id=organization.id,
            user_id=user.id,
            role=MembershipRole.MEMBER.value,
            status=MembershipStatus.ACTIVE.value,
        )
    )
    session.flush()
    session.add(
        Membership(
            organization_id=organization.id,
            user_id=user.id,
            role=MembershipRole.ADMIN.value,
            status=MembershipStatus.INVITED.value,
        )
    )
    with pytest.raises(IntegrityError):
        session.flush()


def test_invalid_foreign_keys_are_rejected(session: Session):
    session.add(
        Membership(
            organization_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            role=MembershipRole.MEMBER.value,
            status=MembershipStatus.ACTIVE.value,
        )
    )

    with pytest.raises(IntegrityError):
        session.flush()


@pytest.mark.parametrize(
    ("model", "values"),
    [
        (Organization, {"name": None, "status": "active"}),
        (User, {"external_subject": None}),
        (
            Membership,
            {
                "organization_id": None,
                "user_id": uuid.uuid4(),
                "role": "member",
                "status": "active",
            },
        ),
    ],
)
def test_required_fields_are_enforced(session: Session, model, values):
    session.add(model(**values))

    with pytest.raises(IntegrityError):
        session.flush()


@pytest.mark.parametrize(
    ("model", "values"),
    [
        (Organization, {"name": "   ", "status": "active"}),
        (User, {"external_subject": "   "}),
    ],
)
def test_non_empty_checks_are_enforced(session: Session, model, values):
    session.add(model(**values))

    with pytest.raises(IntegrityError):
        session.flush()


@pytest.mark.parametrize(
    ("role", "status"),
    [
        (MembershipRole.OWNER.value, MembershipStatus.INVITED.value),
        (MembershipRole.ADMIN.value, MembershipStatus.ACTIVE.value),
        (MembershipRole.MEMBER.value, MembershipStatus.SUSPENDED.value),
    ],
)
def test_membership_role_and_status_values_are_stored(
    session: Session, role: str, status: str
):
    organization = Organization(
        name="M0.2D Roles Organization",
        status=OrganizationStatus.ACTIVE.value,
    )
    user = User(external_subject=f"m02d-role-{role}-{status}-" + uuid.uuid4().hex)
    membership = Membership(
        organization=organization,
        user=user,
        role=role,
        status=status,
    )
    session.add(membership)
    session.flush()
    session.expire_all()

    retrieved = session.get(Membership, membership.id)

    assert retrieved is not None
    assert retrieved.role == role
    assert retrieved.status == status


def test_database_timestamp_defaults_are_utc(session: Session):
    organization = Organization(
        name="M0.2D Timestamp Organization",
        status=OrganizationStatus.ACTIVE.value,
    )
    user = User(external_subject="m02d-timestamp-" + uuid.uuid4().hex)
    session.add_all([organization, user])
    session.flush()
    session.refresh(organization)
    session.refresh(user)

    for value in (
        organization.created_at,
        organization.updated_at,
        user.created_at,
    ):
        assert value.tzinfo is not None
        assert value.utcoffset().total_seconds() == 0

    assert organization.updated_at >= organization.created_at


def make_authorization_client(
    session_provider: Callable[[], Session],
    principal: AuthenticatedPrincipal,
    permitted_roles: set[MembershipRole] | None = None,
) -> TestClient:
    test_app = FastAPI()
    test_app.add_exception_handler(AuthorizationDenied, authorization_denied_handler)
    test_app.add_exception_handler(
        AuthorizationServiceUnavailable,
        authorization_service_unavailable_handler,
    )
    authorization_dependency = require_organization_membership(permitted_roles)

    @test_app.get("/organizations/{organization_id}/resource")
    def organization_resource(
        authorization: AuthorizedMembership = Depends(authorization_dependency),
    ):
        return {
            "organization_id": str(authorization.organization_id),
            "role": authorization.role.value,
        }

    test_app.dependency_overrides[verify_access_token] = lambda: principal
    test_app.dependency_overrides[get_authorization_session] = session_provider
    return TestClient(test_app)


def make_principal(subject: str = "fictional-cognito-subject"):
    return AuthenticatedPrincipal(
        subject=subject,
        client_id="fictional-client",
        scopes=frozenset({"organization-access/read"}),
    )


def create_member(
    session: Session,
    *,
    subject="fictional-cognito-subject",
    organization_status=OrganizationStatus.ACTIVE.value,
    membership_status=MembershipStatus.ACTIVE.value,
    role=MembershipRole.MEMBER.value,
):
    organization = Organization(
        name=f"Fictional Organization {uuid.uuid4()}",
        status=organization_status,
    )
    user = User(external_subject=subject)
    membership = Membership(
        organization=organization,
        user=user,
        role=role,
        status=membership_status,
    )
    session.add(membership)
    session.flush()
    return organization, user, membership


@pytest.fixture
def organization_api_client(monkeypatch, session: Session):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": "local-integration-key", "use": "sig", "alg": "RS256"})
    jwks_client = PyJWKClient(f"{TEST_ISSUER}/.well-known/jwks.json", timeout=5)
    monkeypatch.setattr(jwks_client, "fetch_data", lambda: {"keys": [jwk]})
    monkeypatch.setattr(auth, "get_jwks_client", lambda: jwks_client)
    monkeypatch.setattr(config, "COGNITO_ISSUER", TEST_ISSUER)
    monkeypatch.setattr(config, "COGNITO_USER_POOL_REGION", "eu-west-1")
    monkeypatch.setattr(config, "COGNITO_APP_CLIENT_ID", TEST_CLIENT_ID)
    monkeypatch.setattr(config, "COGNITO_REQUIRED_SCOPE", TEST_REQUIRED_SCOPE)

    def provide_session():
        yield session

    monkeypatch.setitem(
        app.dependency_overrides, get_authorization_session, provide_session
    )
    client = TestClient(app)

    def make_token(subject: str = "fictional-cognito-subject") -> str:
        now = datetime.now(UTC)
        return jwt.encode(
            {
                "iss": TEST_ISSUER,
                "sub": subject,
                "client_id": TEST_CLIENT_ID,
                "token_use": "access",
                "scope": TEST_REQUIRED_SCOPE,
                "iat": now,
                "exp": now + timedelta(minutes=5),
            },
            private_key,
            algorithm="RS256",
            headers={"kid": "local-integration-key"},
        )

    return client, make_token


@pytest.fixture
def internal_authorization_client(monkeypatch, session: Session):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": "local-internal-key", "use": "sig", "alg": "RS256"})
    jwks_client = PyJWKClient(f"{TEST_ISSUER}/.well-known/jwks.json", timeout=5)
    monkeypatch.setattr(jwks_client, "fetch_data", lambda: {"keys": [jwk]})
    monkeypatch.setattr(auth, "get_jwks_client", lambda: jwks_client)
    monkeypatch.setattr(config, "COGNITO_ISSUER", TEST_ISSUER)
    monkeypatch.setattr(config, "COGNITO_USER_POOL_REGION", "eu-west-1")
    monkeypatch.setattr(config, "COGNITO_APP_CLIENT_ID", TEST_CLIENT_ID)
    monkeypatch.setattr(config, "COGNITO_REQUIRED_SCOPE", TEST_REQUIRED_SCOPE)
    monkeypatch.setattr(config, "COGNITO_WORKLOAD_CLIENT_ID", "fictional-service-client")
    monkeypatch.setattr(
        config,
        "COGNITO_WORKLOAD_REQUIRED_SCOPE",
        "property-assets/authorization",
    )

    def provide_session():
        yield session

    monkeypatch.setitem(
        app.dependency_overrides,
        get_authorization_session,
        provide_session,
    )
    client = TestClient(app)

    def make_token(
        *,
        client_id: str = TEST_CLIENT_ID,
        scope: str = TEST_REQUIRED_SCOPE,
        token_use: str = "access",
        subject: str | None = "fictional-cognito-subject",
    ) -> str:
        now = datetime.now(UTC)
        claims = {
            "iss": TEST_ISSUER,
            "client_id": client_id,
            "token_use": token_use,
            "scope": scope,
            "iat": now,
            "exp": now + timedelta(minutes=5),
        }
        if subject is not None:
            claims["sub"] = subject
        return jwt.encode(
            claims,
            private_key,
            algorithm="RS256",
            headers={"kid": "local-internal-key"},
        )

    def request_headers(
        *,
        user_token: str | None = None,
        workload_token: str | None = None,
    ) -> dict[str, str]:
        headers = {}
        if user_token is not None:
            headers["Authorization"] = f"Bearer {user_token}"
        if workload_token is not None:
            headers["X-Service-Authorization"] = f"Bearer {workload_token}"
        return headers

    return client, make_token, request_headers


def _organization_headers(make_token: Callable[..., str], subject: str | None = None):
    token = make_token() if subject is None else make_token(subject)
    return {"Authorization": f"Bearer {token}"}


def test_organization_endpoint_returns_only_public_fields(
    session: Session, organization_api_client
):
    organization, _, _ = create_member(session)
    client, make_token = organization_api_client

    response = client.get(
        f"/api/v1/organizations/{organization.id}",
        headers=_organization_headers(make_token),
    )

    assert response.status_code == 200
    assert set(response.json()) == {
        "id",
        "name",
        "status",
        "created_at",
        "updated_at",
    }
    assert response.json()["id"] == str(organization.id)
    assert response.json()["name"] == organization.name


def test_my_organizations_endpoint_paginates_postgresql_results(
    session: Session,
    organization_api_client,
):
    subject = "pagination-fictional-cognito-subject"
    user = User(external_subject=subject)
    session.add(user)
    organizations = []
    for index in range(105):
        organization = Organization(
            name=f"Pagination Organization {index:03d}",
            status=OrganizationStatus.ACTIVE.value,
        )
        session.add(organization)
        session.flush()
        session.add(
            Membership(
                organization_id=organization.id,
                user_id=user.id,
                role=MembershipRole.MEMBER.value,
                status=MembershipStatus.ACTIVE.value,
            )
        )
        organizations.append(organization)
    session.flush()
    client, make_token = organization_api_client
    headers = _organization_headers(make_token, subject)

    first_page = client.get(
        "/api/v1/users/me/organizations",
        params={"limit": 100},
        headers=headers,
    )
    assert first_page.status_code == 200
    assert len(first_page.json()["organizations"]) == 100
    assert isinstance(first_page.json()["next_cursor"], str)

    second_page = client.get(
        "/api/v1/users/me/organizations",
        params={
            "limit": 100,
            "cursor": first_page.json()["next_cursor"],
        },
        headers=headers,
    )
    assert second_page.status_code == 200
    assert len(second_page.json()["organizations"]) == 5
    assert second_page.json()["next_cursor"] is None

    returned = (
        first_page.json()["organizations"] + second_page.json()["organizations"]
    )
    assert returned == [
        {"id": str(organization.id), "name": organization.name}
        for organization in sorted(organizations, key=lambda item: (item.name, item.id))
    ]


def test_my_organizations_endpoint_isolates_verified_subject(
    session: Session,
    organization_api_client,
):
    own_organization, _, _ = create_member(
        session,
        subject="own-fictional-cognito-subject",
    )
    create_member(
        session,
        subject="other-fictional-cognito-subject",
    )
    client, make_token = organization_api_client

    response = client.get(
        "/api/v1/users/me/organizations",
        headers=_organization_headers(
            make_token,
            "own-fictional-cognito-subject",
        ),
    )

    assert response.status_code == 200
    assert response.json() == {
        "organizations": [
            {"id": str(own_organization.id), "name": own_organization.name}
        ],
        "next_cursor": None,
    }


def test_organization_endpoint_requires_authentication(organization_api_client):
    client, _ = organization_api_client

    response = client.get(f"/api/v1/organizations/{uuid.uuid4()}")

    assert response.status_code == 401
    assert response.json() == {
        "error": {
            "code": "unauthorized",
            "message": "Authentication required",
        }
    }


def test_organization_endpoint_rejects_invalid_authentication(
    organization_api_client,
):
    client, _ = organization_api_client

    response = client.get(
        f"/api/v1/organizations/{uuid.uuid4()}",
        headers={"Authorization": "Bearer invalid-token"},
    )

    assert response.status_code == 401
    assert response.json() == {
        "error": {
            "code": "unauthorized",
            "message": "Authentication required",
        }
    }


def test_organization_endpoint_denies_user_without_membership(
    organization_api_client,
):
    client, make_token = organization_api_client

    response = client.get(
        f"/api/v1/organizations/{uuid.uuid4()}",
        headers=_organization_headers(make_token),
    )

    assert_organization_access_denied(response)


@pytest.mark.parametrize(
    ("organization_status", "membership_status"),
    [
        (OrganizationStatus.SUSPENDED.value, MembershipStatus.ACTIVE.value),
        (OrganizationStatus.ACTIVE.value, MembershipStatus.SUSPENDED.value),
    ],
)
def test_organization_endpoint_denies_inactive_organization_or_membership(
    organization_api_client,
    session: Session,
    organization_status: str,
    membership_status: str,
):
    organization, _, _ = create_member(
        session,
        organization_status=organization_status,
        membership_status=membership_status,
    )
    client, make_token = organization_api_client

    response = client.get(
        f"/api/v1/organizations/{organization.id}",
        headers=_organization_headers(make_token),
    )

    assert_organization_access_denied(response)


def test_organization_endpoint_denies_cross_organization_access(
    organization_api_client, session: Session
):
    create_member(session)
    other_organization, _, _ = create_member(
        session, subject="another-fictional-cognito-subject"
    )
    client, make_token = organization_api_client

    response = client.get(
        f"/api/v1/organizations/{other_organization.id}",
        headers=_organization_headers(make_token),
    )

    assert_organization_access_denied(response)


def test_organization_endpoint_rejects_mismatched_authorization_context(
    monkeypatch, organization_api_client, session: Session
):
    authorized_organization, _, membership = create_member(session)
    requested_organization, _, _ = create_member(
        session, subject="another-fictional-cognito-subject"
    )
    client, make_token = organization_api_client
    lookup_executed = False

    def fail_if_organization_lookup(*args, **kwargs):
        nonlocal lookup_executed
        lookup_executed = True
        pytest.fail("organization lookup must not run for mismatched authorization")

    monkeypatch.setattr(session, "scalar", fail_if_organization_lookup)
    monkeypatch.setitem(
        app.dependency_overrides,
        _organization_membership_dependency,
        lambda: AuthorizedMembership(
            organization_id=authorized_organization.id,
            user_id=membership.user_id,
            role=MembershipRole.MEMBER,
        ),
    )

    response = client.get(
        f"/api/v1/organizations/{requested_organization.id}",
        headers=_organization_headers(make_token),
    )

    assert_organization_access_denied(response)
    assert lookup_executed is False


def test_organization_endpoint_rejects_invalid_organization_id(
    organization_api_client,
):
    client, make_token = organization_api_client

    response = client.get(
        "/api/v1/organizations/not-a-uuid",
        headers=_organization_headers(make_token),
    )

    assert response.status_code == 422


def test_organization_endpoint_database_failure_returns_sanitized_503(
    monkeypatch, organization_api_client, session: Session
):
    organization, _, _ = create_member(session)
    client, make_token = organization_api_client
    secret_detail = "fictional database failure detail"

    def fail_organization_query(*args, **kwargs):
        raise OperationalError("SELECT organizations", {}, Exception(secret_detail))

    monkeypatch.setattr(session, "scalar", fail_organization_query)
    response = client.get(
        f"/api/v1/organizations/{organization.id}",
        headers=_organization_headers(make_token),
    )

    assert_authorization_service_unavailable(response, secret=secret_detail)


def test_internal_decision_requires_active_member_and_both_credentials(
    internal_authorization_client, session: Session
):
    organization, user, _ = create_member(session)
    client, make_token, request_headers = internal_authorization_client

    response = client.post(
        "/internal/v1/authorization/decisions",
        json={
            "organization_id": str(organization.id),
            "operation": "property-assets.portfolios.read",
        },
        headers=request_headers(
            user_token=make_token(),
            workload_token=make_token(
                client_id="fictional-service-client",
                scope="property-assets/authorization",
                subject=None,
            ),
        ),
    )

    assert response.status_code == 200
    assert response.json() == {
        "organization_id": str(organization.id),
        "operation": "property-assets.portfolios.read",
        "allowed": True,
        "actor_id": str(user.id),
    }


@pytest.mark.parametrize(
    ("operation", "role", "expected_status"),
    [
        ("property-assets.portfolios.read", MembershipRole.MEMBER, 200),
        ("property-assets.portfolios.create", MembershipRole.MEMBER, 403),
        ("property-assets.portfolios.update", MembershipRole.MEMBER, 403),
        ("property-assets.portfolios.create", MembershipRole.ADMIN, 200),
        ("property-assets.portfolios.update", MembershipRole.ADMIN, 200),
        ("property-assets.portfolios.create", MembershipRole.OWNER, 200),
        ("property-assets.portfolios.update", MembershipRole.OWNER, 200),
        ("property-assets.sites.create", MembershipRole.MEMBER, 403),
        ("property-assets.sites.update", MembershipRole.MEMBER, 403),
        ("property-assets.sites.create", MembershipRole.ADMIN, 200),
        ("property-assets.sites.update", MembershipRole.ADMIN, 200),
        ("property-assets.sites.create", MembershipRole.OWNER, 200),
        ("property-assets.sites.update", MembershipRole.OWNER, 200),
        ("property-assets.buildings.create", MembershipRole.MEMBER, 403),
        ("property-assets.buildings.update", MembershipRole.MEMBER, 403),
        ("property-assets.buildings.create", MembershipRole.ADMIN, 200),
        ("property-assets.buildings.update", MembershipRole.ADMIN, 200),
        ("property-assets.buildings.create", MembershipRole.OWNER, 200),
        ("property-assets.buildings.update", MembershipRole.OWNER, 200),
    ],
)
def test_internal_portfolio_operations_enforce_membership_roles(
    internal_authorization_client,
    session: Session,
    operation: str,
    role: MembershipRole,
    expected_status: int,
):
    organization, user, _ = create_member(session, role=role.value)
    client, make_token, request_headers = internal_authorization_client

    response = client.post(
        "/internal/v1/authorization/decisions",
        json={"organization_id": str(organization.id), "operation": operation},
        headers=request_headers(
            user_token=make_token(),
            workload_token=make_token(
                client_id="fictional-service-client",
                scope="property-assets/authorization",
                subject=None,
            ),
        ),
    )

    assert response.status_code == expected_status
    if expected_status == 200:
        assert response.json()["actor_id"] == str(user.id)
        assert response.json()["operation"] == operation
    else:
        assert response.json()["error"]["code"] == "forbidden"


@pytest.mark.parametrize(
    "credentials",
    [
        {},
        {"user_token": True},
        {"workload_token": True},
    ],
)
def test_internal_decision_requires_both_credentials(
    internal_authorization_client, credentials
):
    client, make_token, request_headers = internal_authorization_client
    tokens = {
        "user_token": make_token(),
        "workload_token": make_token(
            client_id="fictional-service-client",
            scope="property-assets/authorization",
            subject=None,
        ),
    }
    headers = request_headers(**{
        name: tokens[name] for name in credentials
    })

    response = client.post(
        "/internal/v1/authorization/decisions",
        json={
            "organization_id": str(uuid.uuid4()),
            "operation": "property-assets.portfolios.read",
        },
        headers=headers,
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


@pytest.mark.parametrize("invalid_credential", ["user_token", "workload_token"])
def test_internal_decision_rejects_malformed_credentials(
    internal_authorization_client, invalid_credential
):
    client, make_token, request_headers = internal_authorization_client
    user_token = make_token()
    workload_token = make_token(
        client_id="fictional-service-client",
        scope="property-assets/authorization",
        subject=None,
    )
    if invalid_credential == "user_token":
        user_token = "not-a-jwt"
    else:
        workload_token = "not-a-jwt"

    response = client.post(
        "/internal/v1/authorization/decisions",
        json={
            "organization_id": str(uuid.uuid4()),
            "operation": "property-assets.portfolios.read",
        },
        headers=request_headers(
            user_token=user_token,
            workload_token=workload_token,
        ),
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_internal_decision_rejects_user_token_as_workload_credential(
    internal_authorization_client,
):
    client, make_token, request_headers = internal_authorization_client
    user_token = make_token()
    response = client.post(
        "/internal/v1/authorization/decisions",
        json={
            "organization_id": str(uuid.uuid4()),
            "operation": "property-assets.portfolios.read",
        },
        headers=request_headers(
            user_token=user_token,
            workload_token=user_token,
        ),
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


@pytest.mark.parametrize(
    ("credential", "claims"),
    [
        ("user_token", {"client_id": "wrong-user-client"}),
        ("user_token", {"scope": "openid"}),
        ("workload_token", {"client_id": "wrong-service-client"}),
        ("workload_token", {"scope": "openid"}),
        ("workload_token", {"token_use": "id"}),
    ],
)
def test_internal_decision_rejects_wrong_client_scope_or_token_type(
    internal_authorization_client, credential, claims
):
    client, make_token, request_headers = internal_authorization_client
    default_claims = (
        {
            "client_id": TEST_CLIENT_ID,
            "scope": TEST_REQUIRED_SCOPE,
            "subject": "fictional-cognito-subject",
        }
        if credential == "user_token"
        else {
            "client_id": "fictional-service-client",
            "scope": "property-assets/authorization",
            "subject": None,
        }
    )
    default_claims.update(claims)
    token = make_token(**default_claims)
    user_token = make_token()
    workload_token = make_token(
        client_id="fictional-service-client",
        scope="property-assets/authorization",
        subject=None,
    )
    if credential == "user_token":
        user_token = token
    else:
        workload_token = token

    response = client.post(
        "/internal/v1/authorization/decisions",
        json={
            "organization_id": str(uuid.uuid4()),
            "operation": "property-assets.portfolios.read",
        },
        headers=request_headers(
            user_token=user_token,
            workload_token=workload_token,
        ),
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


@pytest.mark.parametrize(
    ("organization_status", "membership_status"),
    [
        (OrganizationStatus.SUSPENDED.value, MembershipStatus.ACTIVE.value),
        (OrganizationStatus.ACTIVE.value, MembershipStatus.SUSPENDED.value),
    ],
)
def test_internal_decision_denies_inactive_organization_or_membership(
    internal_authorization_client,
    session: Session,
    organization_status: str,
    membership_status: str,
):
    organization, _, _ = create_member(
        session,
        organization_status=organization_status,
        membership_status=membership_status,
    )
    client, make_token, request_headers = internal_authorization_client
    response = client.post(
        "/internal/v1/authorization/decisions",
        json={
            "organization_id": str(organization.id),
            "operation": "property-assets.portfolios.read",
        },
        headers=request_headers(
            user_token=make_token(),
            workload_token=make_token(
                client_id="fictional-service-client",
                scope="property-assets/authorization",
                subject=None,
            ),
        ),
    )

    assert_organization_access_denied(response)


def test_internal_decision_denies_cross_organization_access(
    internal_authorization_client, session: Session
):
    create_member(session)
    other_organization, _, _ = create_member(
        session,
        subject="another-fictional-cognito-subject",
    )
    client, make_token, request_headers = internal_authorization_client
    response = client.post(
        "/internal/v1/authorization/decisions",
        json={
            "organization_id": str(other_organization.id),
            "operation": "property-assets.portfolios.read",
        },
        headers=request_headers(
            user_token=make_token(),
            workload_token=make_token(
                client_id="fictional-service-client",
                scope="property-assets/authorization",
                subject=None,
            ),
        ),
    )

    assert_organization_access_denied(response)


def test_internal_decision_rejects_unsupported_operation(
    internal_authorization_client,
):
    client, make_token, request_headers = internal_authorization_client
    response = client.post(
        "/internal/v1/authorization/decisions",
        json={
            "organization_id": str(uuid.uuid4()),
            "operation": "property-assets.portfolios.write",
        },
        headers=request_headers(
            user_token=make_token(),
            workload_token=make_token(
                client_id="fictional-service-client",
                scope="property-assets/authorization",
                subject=None,
            ),
        ),
    )

    assert response.status_code == 422


def test_internal_decision_rejects_caller_supplied_identity_or_role(
    internal_authorization_client,
):
    client, make_token, request_headers = internal_authorization_client
    response = client.post(
        "/internal/v1/authorization/decisions",
        json={
            "organization_id": str(uuid.uuid4()),
            "operation": "property-assets.portfolios.read",
            "user_id": str(uuid.uuid4()),
            "role": "owner",
        },
        headers=request_headers(
            user_token=make_token(),
            workload_token=make_token(
                client_id="fictional-service-client",
                scope="property-assets/authorization",
                subject=None,
            ),
        ),
    )

    assert response.status_code == 422


def test_internal_decision_database_failure_returns_sanitized_503(
    monkeypatch,
    internal_authorization_client,
    session: Session,
):
    organization, _, _ = create_member(session)
    client, make_token, request_headers = internal_authorization_client
    secret_detail = "fictional internal database failure"

    def fail_query(*args, **kwargs):
        raise OperationalError("SELECT memberships", {}, Exception(secret_detail))

    monkeypatch.setattr(session, "execute", fail_query)
    response = client.post(
        "/internal/v1/authorization/decisions",
        json={
            "organization_id": str(organization.id),
            "operation": "property-assets.portfolios.read",
        },
        headers=request_headers(
            user_token=make_token(),
            workload_token=make_token(
                client_id="fictional-service-client",
                scope="property-assets/authorization",
                subject=None,
            ),
        ),
    )

    assert_authorization_service_unavailable(response, secret=secret_detail)


def assert_organization_access_denied(response):
    assert response.status_code == 403
    assert response.json() == {
        "error": {
            "code": "forbidden",
            "message": "Organization access denied",
        }
    }


def assert_authorization_service_unavailable(response, *, secret: str | None = None):
    assert response.status_code == 503
    body = response.json()
    assert body == {
        "error": {
            "code": "service_unavailable",
            "message": "Authorization service unavailable",
        }
    }
    if secret:
        assert secret not in response.text


def test_authorization_allows_matching_active_membership(session: Session):
    organization, user, membership = create_member(session)
    client = make_authorization_client(lambda: session, make_principal())

    response = client.get(
        f"/organizations/{organization.id}/resource"
    )

    assert response.status_code == 200
    assert response.json() == {
        "organization_id": str(organization.id),
        "role": MembershipRole.MEMBER.value,
    }
    assert membership.user_id == user.id


def test_authorization_denies_roles_not_explicitly_permitted(session: Session):
    organization, _, _ = create_member(session, role=MembershipRole.MEMBER.value)
    client = make_authorization_client(
        lambda: session,
        make_principal(),
        permitted_roles={MembershipRole.ADMIN, MembershipRole.OWNER},
    )

    assert_organization_access_denied(
        client.get(f"/organizations/{organization.id}/resource")
    )


@pytest.mark.parametrize(
    ("member_options", "principal_subject"),
    [
        ({}, "unknown-fictional-subject"),
        ({"subject": "another-fictional-subject"}, "fictional-cognito-subject"),
        (
            {"membership_status": MembershipStatus.SUSPENDED.value},
            "fictional-cognito-subject",
        ),
        (
            {"organization_status": OrganizationStatus.SUSPENDED.value},
            "fictional-cognito-subject",
        ),
    ],
)
def test_authorization_denies_missing_or_inactive_memberships(
    session: Session,
    member_options: dict,
    principal_subject: str,
):
    organization, _, _ = create_member(session, **member_options)
    client = make_authorization_client(
        lambda: session,
        make_principal(principal_subject),
    )

    assert_organization_access_denied(
        client.get(f"/organizations/{organization.id}/resource")
    )


def test_authorization_denies_cross_organization_attempt(session: Session):
    authorized_organization, _, _ = create_member(session)
    other_organization = Organization(
        name="Fictional Unrelated Organization",
        status=OrganizationStatus.ACTIVE.value,
    )
    session.add(other_organization)
    session.flush()
    client = make_authorization_client(lambda: session, make_principal())

    assert authorized_organization.id != other_organization.id
    assert_organization_access_denied(
        client.get(f"/organizations/{other_organization.id}/resource")
    )


@pytest.mark.parametrize(
    "failure",
    [
        OperationalError("SELECT sensitive_sql", {}, OSError("private database host")),
        TimeoutError("database pool timeout with private details"),
        RuntimeError("unexpected SQL with password=fictional-secret"),
    ],
)
def test_authorization_database_lookup_failures_return_sanitized_503(
    failure: Exception,
):
    class FailingSession:
        def execute(self, statement):
            raise failure

    client = make_authorization_client(
        lambda: FailingSession(),
        make_principal(),
    )

    response = client.get(f"/organizations/{uuid.uuid4()}/resource")

    assert_authorization_service_unavailable(
        response,
        secret=str(failure),
    )


def test_authorization_database_not_configured_returns_sanitized_503(monkeypatch):
    monkeypatch.setattr(database, "SessionLocal", None)
    test_app = FastAPI()
    test_app.add_exception_handler(
        AuthorizationServiceUnavailable,
        authorization_service_unavailable_handler,
    )
    authorization_dependency = require_organization_membership()

    @test_app.get("/organizations/{organization_id}/resource")
    def organization_resource(
        authorization: AuthorizedMembership = Depends(authorization_dependency),
    ):
        return {"organization_id": str(authorization.organization_id)}

    test_app.dependency_overrides[verify_access_token] = make_principal
    client = TestClient(test_app)

    response = client.get(f"/organizations/{uuid.uuid4()}/resource")

    assert_authorization_service_unavailable(response)


def test_invalid_organization_id_fails_before_database_lookup():
    calls = []

    def session_provider():
        class UnusedSession:
            def execute(self, statement):
                calls.append(True)
                raise AssertionError(
                    "invalid organization ID must not query the database"
                )

        yield UnusedSession()

    client = make_authorization_client(session_provider, make_principal())

    response = client.get("/organizations/not-a-uuid/resource")

    assert response.status_code == 422
    assert calls == []


def test_untrusted_user_and_role_parameters_do_not_override_token_identity(
    session: Session,
):
    organization, user, membership = create_member(session)
    client = make_authorization_client(lambda: session, make_principal())
    other_user_id = uuid.uuid4()

    response = client.get(
        f"/organizations/{organization.id}/resource",
        params={"user_id": str(other_user_id), "role": MembershipRole.OWNER.value},
    )

    assert response.status_code == 200
    assert response.json()["role"] == membership.role
    assert membership.user_id == user.id
    assert membership.user_id != other_user_id


def test_authorization_rejects_untrusted_role_configuration():
    with pytest.raises(ValueError):
        require_organization_membership({"admin"})
