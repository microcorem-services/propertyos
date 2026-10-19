import ipaddress
import os
import re
import subprocess
import uuid
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import Engine, URL
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

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
    authorization_denied_handler,
    authorization_service_unavailable_handler,
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
