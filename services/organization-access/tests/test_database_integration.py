import ipaddress
import os
import re
import subprocess
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import Engine, URL
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

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
