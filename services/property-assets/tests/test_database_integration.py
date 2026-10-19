import ipaddress
import os
import re
import subprocess
import uuid
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.engine import Engine, URL, make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import (
    Building,
    BuildingStatus,
    Portfolio,
    PortfolioStatus,
    Site,
    SiteStatus,
    Unit,
    UnitStatus,
)


SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SERVICE_ROOT.parents[1]
LOCAL_ENV_FILE = REPOSITORY_ROOT / "infra" / "local" / ".env"
EXPECTED_DATABASE = "bowera_property_assets"


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


def _run_alembic(schema_url: str, *arguments: str) -> None:
    environment = os.environ.copy()
    environment["DATABASE_URL"] = schema_url
    try:
        result = subprocess.run(
            [
                str(SERVICE_ROOT / ".venv" / "bin" / "alembic"),
                "-c",
                "alembic.ini",
                *arguments,
            ],
            cwd=SERVICE_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Alembic command timed out in the disposable test schema") from error

    if result.returncode:
        output = (result.stdout + result.stderr).replace(
            schema_url,
            make_url(schema_url).render_as_string(hide_password=True),
        )
        raise RuntimeError(
            "Alembic command failed in the disposable schema "
            f"(exit code {result.returncode}):\n{output[-4000:]}"
        )


@pytest.fixture(scope="session")
def integration_database():
    local_config = _read_local_environment()
    if local_config.get("PROPERTY_ASSETS_DB_NAME") != EXPECTED_DATABASE:
        raise RuntimeError(
            "Refusing integration tests: local database name must be "
            f"{EXPECTED_DATABASE}"
        )

    username = local_config.get("PROPERTY_ASSETS_DB_USER")
    password = local_config.get("PROPERTY_ASSETS_DB_PASSWORD")
    if not username or not password:
        raise RuntimeError(
            "Refusing integration tests: dedicated local database credentials are incomplete"
        )

    try:
        port = int(local_config.get("PROPERTY_ASSETS_DB_PORT", "55432"))
    except ValueError as error:
        raise RuntimeError(
            "Refusing integration tests: local database port is invalid"
        ) from error

    database_url = URL.create(
        "postgresql+psycopg",
        username=username,
        password=password,
        host="127.0.0.1",
        port=port,
        database=EXPECTED_DATABASE,
    )
    engine = create_engine(database_url, connect_args={"connect_timeout": 5})
    schema_name = f"m05c3_test_{uuid.uuid4().hex}"
    if not re.fullmatch(r"m05c3_test_[0-9a-f]{32}", schema_name):
        engine.dispose()
        raise RuntimeError("Refusing integration tests: invalid generated schema name")

    schema_created = False
    schema_engine = None
    try:
        with engine.begin() as connection:
            database_name, role, address, server_port = connection.execute(
                text(
                    "SELECT current_database(), current_user, "
                    "inet_server_addr()::text, inet_server_port()"
                )
            ).one()
            if (
                database_name != EXPECTED_DATABASE
                or role != username
                or server_port != 5432
                or address is None
                or not ipaddress.ip_interface(address).ip.is_private
            ):
                raise RuntimeError(
                    "Refusing integration tests: connected PostgreSQL identity is "
                    "not the dedicated local Property & Asset Registry database"
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
        rendered_schema_url = schema_url.render_as_string(hide_password=False)
        _run_alembic(
            rendered_schema_url,
            "upgrade",
            "head",
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

        yield schema_engine, rendered_schema_url
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
def session(integration_database):
    engine, _ = integration_database
    with engine.connect() as connection:
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


def test_portfolio_can_be_created_and_retrieved(session: Session):
    organization_id = uuid.uuid4()
    portfolio = Portfolio(
        organization_id=organization_id,
        name="Fictional test portfolio",
        status=PortfolioStatus.ACTIVE.value,
    )
    session.add(portfolio)
    session.flush()
    session.expire_all()

    retrieved = session.scalar(
        select(Portfolio).where(Portfolio.id == portfolio.id)
    )

    assert retrieved is not None
    assert retrieved.organization_id == organization_id
    assert retrieved.name == "Fictional test portfolio"
    assert retrieved.status == PortfolioStatus.ACTIVE.value
    assert isinstance(retrieved.id, uuid.UUID)


@pytest.mark.parametrize(
    "values",
    [
        {"organization_id": uuid.uuid4(), "name": None, "status": "active"},
        {"organization_id": None, "name": "Required organization", "status": "active"},
        {"organization_id": uuid.uuid4(), "name": "Required status", "status": None},
    ],
)
def test_portfolio_required_fields_are_enforced(session: Session, values):
    with pytest.raises(IntegrityError):
        session.execute(Portfolio.__table__.insert().values(**values))
        session.flush()


@pytest.mark.parametrize("name", ["", "   "])
def test_portfolio_name_must_not_be_empty(session: Session, name: str):
    session.add(
        Portfolio(
            organization_id=uuid.uuid4(),
            name=name,
            status=PortfolioStatus.ACTIVE.value,
        )
    )

    with pytest.raises(IntegrityError):
        session.flush()


@pytest.mark.parametrize(
    "status",
    [PortfolioStatus.ACTIVE.value, PortfolioStatus.INACTIVE.value],
)
def test_portfolio_valid_status_is_stored(session: Session, status: str):
    portfolio = Portfolio(
        organization_id=uuid.uuid4(),
        name=f"Fictional {status} portfolio",
        status=status,
    )
    session.add(portfolio)
    session.flush()
    session.refresh(portfolio)

    assert portfolio.status == status


def test_portfolio_invalid_status_is_rejected(session: Session):
    session.add(
        Portfolio(
            organization_id=uuid.uuid4(),
            name="Invalid status portfolio",
            status="archived",
        )
    )

    with pytest.raises(IntegrityError):
        session.flush()


def test_organization_id_is_an_isolated_identifier(session: Session):
    portfolio = Portfolio(
        organization_id=uuid.uuid4(),
        name="No cross-service foreign key",
        status=PortfolioStatus.ACTIVE.value,
    )
    session.add(portfolio)
    session.flush()

    assert portfolio.organization_id is not None
    assert not [
        foreign_key
        for foreign_key in Portfolio.__table__.c.organization_id.foreign_keys
    ]


def test_initial_migration_can_upgrade_and_downgrade(integration_database):
    engine, schema_url = integration_database

    with engine.connect() as connection:
        assert {"portfolios", "sites", "buildings", "units"} <= set(
            inspect(connection).get_table_names()
        )
        assert connection.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar_one() == "0004_units"

    _run_alembic(schema_url, "downgrade", "0003_buildings")
    with engine.connect() as connection:
        table_names = set(inspect(connection).get_table_names())
        assert "portfolios" in table_names
        assert "sites" in table_names
        assert "buildings" in table_names
        assert "units" not in table_names
        assert connection.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar_one() == "0003_buildings"

    _run_alembic(schema_url, "upgrade", "head")
    with engine.connect() as connection:
        assert {"portfolios", "sites", "buildings", "units"} <= set(
            inspect(connection).get_table_names()
        )
        assert connection.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar_one() == "0004_units"


def test_site_can_be_created_with_its_portfolio(session: Session):
    organization_id = uuid.uuid4()
    portfolio = Portfolio(
        organization_id=organization_id,
        name="Fictional Site Portfolio",
        status=PortfolioStatus.ACTIVE.value,
    )
    session.add(portfolio)
    session.flush()
    site = Site(
        organization_id=organization_id,
        portfolio_id=portfolio.id,
        name="Fictional Site",
        address="1 Example Street, Exampleton",
        status=SiteStatus.ACTIVE.value,
    )
    session.add(site)
    session.flush()
    session.expire_all()

    retrieved = session.get(Site, site.id)

    assert retrieved is not None
    assert isinstance(retrieved.id, uuid.UUID)
    assert retrieved.organization_id == organization_id
    assert retrieved.portfolio_id == portfolio.id
    assert retrieved.portfolio.id == portfolio.id
    assert retrieved.name == "Fictional Site"
    assert retrieved.address == "1 Example Street, Exampleton"
    assert retrieved.status == SiteStatus.ACTIVE.value
    assert retrieved.created_at.utcoffset().total_seconds() == 0
    assert retrieved.updated_at.utcoffset().total_seconds() == 0


def test_site_can_omit_optional_address(session: Session):
    portfolio = Portfolio(
        organization_id=uuid.uuid4(),
        name="Portfolio Without Address",
        status=PortfolioStatus.ACTIVE.value,
    )
    session.add(portfolio)
    session.flush()
    site = Site(
        organization_id=portfolio.organization_id,
        portfolio_id=portfolio.id,
        name="Addressless Site",
        status=SiteStatus.ACTIVE.value,
    )
    session.add(site)
    session.flush()

    assert site.address is None


@pytest.mark.parametrize("name", ["", "   "])
def test_site_name_must_not_be_empty(session: Session, name: str):
    portfolio = Portfolio(
        organization_id=uuid.uuid4(),
        name="Non-empty Site Name Portfolio",
        status=PortfolioStatus.ACTIVE.value,
    )
    session.add(portfolio)
    session.flush()

    with pytest.raises(IntegrityError):
        session.execute(
            Site.__table__.insert().values(
                organization_id=portfolio.organization_id,
                portfolio_id=portfolio.id,
                name=name,
                status=SiteStatus.ACTIVE.value,
            )
        )
        session.flush()


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("organization_id", None),
        ("portfolio_id", None),
        ("name", None),
        ("status", None),
    ],
)
def test_site_required_fields_are_enforced(
    session: Session,
    field_name: str,
    value,
):
    portfolio = Portfolio(
        organization_id=uuid.uuid4(),
        name="Required Fields Portfolio",
        status=PortfolioStatus.ACTIVE.value,
    )
    session.add(portfolio)
    session.flush()
    values = {
        "organization_id": portfolio.organization_id,
        "portfolio_id": portfolio.id,
        "name": "Required Fields Site",
        "status": SiteStatus.ACTIVE.value,
    }
    values[field_name] = value

    with pytest.raises(IntegrityError):
        session.execute(Site.__table__.insert().values(**values))
        session.flush()


def test_site_rejects_invalid_status(session: Session):
    portfolio = Portfolio(
        organization_id=uuid.uuid4(),
        name="Site Status Portfolio",
        status=PortfolioStatus.ACTIVE.value,
    )
    session.add(portfolio)
    session.flush()

    with pytest.raises(IntegrityError):
        session.execute(
            Site.__table__.insert().values(
                organization_id=portfolio.organization_id,
                portfolio_id=portfolio.id,
                name="Invalid Status Site",
                status="archived",
            )
        )
        session.flush()


def test_site_rejects_nonexistent_portfolio(session: Session):
    with pytest.raises(IntegrityError):
        session.execute(
            Site.__table__.insert().values(
                organization_id=uuid.uuid4(),
                portfolio_id=uuid.uuid4(),
                name="Missing Portfolio Site",
                status=SiteStatus.ACTIVE.value,
            )
        )
        session.flush()


def test_site_rejects_portfolio_from_another_organization(session: Session):
    portfolio = Portfolio(
        organization_id=uuid.uuid4(),
        name="Portfolio Organization One",
        status=PortfolioStatus.ACTIVE.value,
    )
    session.add(portfolio)
    session.flush()

    with pytest.raises(IntegrityError):
        session.execute(
            Site.__table__.insert().values(
                organization_id=uuid.uuid4(),
                portfolio_id=portfolio.id,
                name="Cross Organization Site",
                status=SiteStatus.ACTIVE.value,
            )
        )
        session.flush()


def _create_site(session: Session, organization_id: uuid.UUID) -> Site:
    portfolio = Portfolio(
        organization_id=organization_id,
        name="Fictional Building Test Portfolio",
        status=PortfolioStatus.ACTIVE.value,
    )
    site = Site(
        organization_id=organization_id,
        portfolio=portfolio,
        name="Fictional Building Test Site",
        status=SiteStatus.ACTIVE.value,
    )
    session.add(site)
    session.flush()
    return site


def test_building_can_be_created_with_its_site(session: Session):
    organization_id = uuid.uuid4()
    site = _create_site(session, organization_id)
    building = Building(
        organization_id=organization_id,
        site_id=site.id,
        name="Fictional Building",
        building_code="BLDG-001",
        address="2 Example Road, Exampleton",
        status=BuildingStatus.ACTIVE.value,
    )
    session.add(building)
    session.flush()
    session.expire_all()

    retrieved = session.get(Building, building.id)

    assert retrieved is not None
    assert isinstance(retrieved.id, uuid.UUID)
    assert retrieved.organization_id == organization_id
    assert retrieved.site_id == site.id
    assert retrieved.site.id == site.id
    assert retrieved.name == "Fictional Building"
    assert retrieved.building_code == "BLDG-001"
    assert retrieved.address == "2 Example Road, Exampleton"
    assert retrieved.status == BuildingStatus.ACTIVE.value
    assert retrieved.created_at.utcoffset().total_seconds() == 0
    assert retrieved.updated_at.utcoffset().total_seconds() == 0


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("organization_id", None),
        ("site_id", None),
        ("name", None),
        ("status", None),
    ],
)
def test_building_required_fields_are_enforced(
    session: Session,
    field_name: str,
    value,
):
    site = _create_site(session, uuid.uuid4())
    values = {
        "organization_id": site.organization_id,
        "site_id": site.id,
        "name": "Required Fields Building",
        "status": BuildingStatus.ACTIVE.value,
    }
    values[field_name] = value

    with pytest.raises(IntegrityError):
        session.execute(Building.__table__.insert().values(**values))
        session.flush()


@pytest.mark.parametrize("name", ["", "   "])
def test_building_name_must_not_be_empty(session: Session, name: str):
    site = _create_site(session, uuid.uuid4())

    with pytest.raises(IntegrityError):
        session.execute(
            Building.__table__.insert().values(
                organization_id=site.organization_id,
                site_id=site.id,
                name=name,
                status=BuildingStatus.ACTIVE.value,
            )
        )
        session.flush()


def test_building_rejects_invalid_status(session: Session):
    site = _create_site(session, uuid.uuid4())

    with pytest.raises(IntegrityError):
        session.execute(
            Building.__table__.insert().values(
                organization_id=site.organization_id,
                site_id=site.id,
                name="Invalid Status Building",
                status="archived",
            )
        )
        session.flush()


def test_building_rejects_missing_site(session: Session):
    with pytest.raises(IntegrityError):
        session.execute(
            Building.__table__.insert().values(
                organization_id=uuid.uuid4(),
                site_id=uuid.uuid4(),
                name="Missing Site Building",
                status=BuildingStatus.ACTIVE.value,
            )
        )
        session.flush()


def test_building_rejects_site_from_another_organization(session: Session):
    site = _create_site(session, uuid.uuid4())
    other_organization_id = uuid.uuid4()

    with pytest.raises(IntegrityError):
        session.execute(
            Building.__table__.insert().values(
                organization_id=other_organization_id,
                site_id=site.id,
                name="Cross Organization Building",
                status=BuildingStatus.ACTIVE.value,
            )
        )
        session.flush()


def _create_building(session: Session, organization_id: uuid.UUID) -> Building:
    site = _create_site(session, organization_id)
    building = Building(
        organization_id=organization_id,
        site=site,
        name="Fictional Unit Test Building",
        status=BuildingStatus.ACTIVE.value,
    )
    session.add(building)
    session.flush()
    return building


def test_unit_can_be_created_with_decimal_area(session: Session):
    organization_id = uuid.uuid4()
    building = _create_building(session, organization_id)
    unit = Unit(
        organization_id=organization_id,
        building_id=building.id,
        name="Fictional Unit 101",
        unit_code="101",
        floor="1",
        area_sqm=Decimal("42.75"),
        status=UnitStatus.ACTIVE.value,
    )
    session.add(unit)
    session.flush()
    session.expire_all()

    retrieved = session.get(Unit, unit.id)

    assert retrieved is not None
    assert isinstance(retrieved.id, uuid.UUID)
    assert retrieved.organization_id == organization_id
    assert retrieved.building_id == building.id
    assert retrieved.building.id == building.id
    assert retrieved.name == "Fictional Unit 101"
    assert retrieved.unit_code == "101"
    assert retrieved.floor == "1"
    assert retrieved.area_sqm == Decimal("42.75")
    assert isinstance(retrieved.area_sqm, Decimal)
    assert retrieved.status == UnitStatus.ACTIVE.value
    assert retrieved.created_at.utcoffset().total_seconds() == 0
    assert retrieved.updated_at.utcoffset().total_seconds() == 0


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("organization_id", None),
        ("building_id", None),
        ("name", None),
        ("status", None),
    ],
)
def test_unit_required_fields_are_enforced(
    session: Session,
    field_name: str,
    value,
):
    building = _create_building(session, uuid.uuid4())
    values = {
        "organization_id": building.organization_id,
        "building_id": building.id,
        "name": "Required Fields Unit",
        "status": UnitStatus.ACTIVE.value,
    }
    values[field_name] = value

    with pytest.raises(IntegrityError):
        session.execute(Unit.__table__.insert().values(**values))
        session.flush()


@pytest.mark.parametrize("name", ["", "   "])
def test_unit_name_must_not_be_empty(session: Session, name: str):
    building = _create_building(session, uuid.uuid4())

    with pytest.raises(IntegrityError):
        session.execute(
            Unit.__table__.insert().values(
                organization_id=building.organization_id,
                building_id=building.id,
                name=name,
                status=UnitStatus.ACTIVE.value,
            )
        )
        session.flush()


def test_unit_rejects_invalid_status(session: Session):
    building = _create_building(session, uuid.uuid4())

    with pytest.raises(IntegrityError):
        session.execute(
            Unit.__table__.insert().values(
                organization_id=building.organization_id,
                building_id=building.id,
                name="Invalid Status Unit",
                status="archived",
            )
        )
        session.flush()


@pytest.mark.parametrize("area_sqm", [Decimal("0"), Decimal("-0.01")])
def test_unit_rejects_non_positive_area(session: Session, area_sqm: Decimal):
    building = _create_building(session, uuid.uuid4())

    with pytest.raises(IntegrityError):
        session.execute(
            Unit.__table__.insert().values(
                organization_id=building.organization_id,
                building_id=building.id,
                name="Invalid Area Unit",
                area_sqm=area_sqm,
                status=UnitStatus.ACTIVE.value,
            )
        )
        session.flush()


def test_unit_allows_missing_optional_area(session: Session):
    building = _create_building(session, uuid.uuid4())
    unit = Unit(
        organization_id=building.organization_id,
        building_id=building.id,
        name="Unit Without Area",
        status=UnitStatus.ACTIVE.value,
    )
    session.add(unit)
    session.flush()

    assert unit.area_sqm is None


def test_unit_rejects_missing_building(session: Session):
    with pytest.raises(IntegrityError):
        session.execute(
            Unit.__table__.insert().values(
                organization_id=uuid.uuid4(),
                building_id=uuid.uuid4(),
                name="Missing Building Unit",
                status=UnitStatus.ACTIVE.value,
            )
        )
        session.flush()


def test_unit_rejects_building_from_another_organization(session: Session):
    building = _create_building(session, uuid.uuid4())

    with pytest.raises(IntegrityError):
        session.execute(
            Unit.__table__.insert().values(
                organization_id=uuid.uuid4(),
                building_id=building.id,
                name="Cross Organization Unit",
                status=UnitStatus.ACTIVE.value,
            )
        )
        session.flush()
