from datetime import UTC
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.sql.sqltypes import Uuid

from app.database import Base
from app.models import (
    Building,
    BuildingStatus,
    Portfolio,
    PortfolioAuditEvent,
    PortfolioStatus,
    Site,
    SiteStatus,
    Unit,
    UnitStatus,
)


def test_portfolio_table_and_uuid_primary_key_are_declared():
    assert set(Base.metadata.tables) == {
        "portfolios",
        "portfolio_audit_events",
        "sites",
        "buildings",
        "units",
    }

    for model in (Portfolio, Site, Building, Unit):
        primary_key = model.__table__.c.id
        assert primary_key.primary_key
        assert primary_key.nullable is False
        assert isinstance(primary_key.type, Uuid)


def test_portfolio_required_fields_and_timestamps_are_utc_aware():
    for column_name in ("organization_id", "name", "status", "created_at", "updated_at"):
        assert Portfolio.__table__.c[column_name].nullable is False

    for column_name in ("created_at", "updated_at"):
        timestamp = Portfolio.__table__.c[column_name]
        assert isinstance(timestamp.type, DateTime)
        assert timestamp.type.timezone is True
        assert timestamp.default is not None
        assert timestamp.default.arg(None).utcoffset() == UTC.utcoffset(None)

    assert (
        Portfolio.__table__.c.updated_at.onupdate.arg(None).utcoffset()
        == UTC.utcoffset(None)
    )


def test_portfolio_audit_records_have_required_nonsecret_fields():
    columns = PortfolioAuditEvent.__table__.c
    assert {
        "id",
        "organization_id",
        "portfolio_id",
        "operation",
        "actor_id",
        "occurred_at",
        "changed_fields",
    } == set(columns.keys())
    assert all(not columns[name].nullable for name in columns.keys())
    assert "portfolio_audit_events" in Base.metadata.tables


def test_portfolio_organization_id_is_indexed_without_cross_service_foreign_key():
    organization_id = Portfolio.__table__.c.organization_id
    assert isinstance(organization_id.type, Uuid)
    assert any(
        tuple(column.name for column in index.columns) == ("organization_id",)
        for index in Portfolio.__table__.indexes
    )
    assert not any(
        isinstance(constraint, ForeignKeyConstraint)
        and "organization_id"
        in {column.name for column in constraint.columns}
        for constraint in Portfolio.__table__.constraints
    )


def test_portfolio_name_and_status_constraints_are_declared():
    checks = {
        constraint.name: str(constraint.sqltext)
        for constraint in Portfolio.__table__.constraints
        if isinstance(constraint, CheckConstraint)
    }
    assert checks == {
        "ck_portfolios_name_not_empty": "length(trim(name)) > 0",
        "ck_portfolios_status": "status IN ('active', 'inactive')",
    }
    assert {status.value for status in PortfolioStatus} == {"active", "inactive"}


def test_site_required_fields_and_utc_timestamps_are_declared():
    for column_name in (
        "organization_id",
        "portfolio_id",
        "name",
        "status",
        "created_at",
        "updated_at",
    ):
        assert Site.__table__.c[column_name].nullable is False

    assert Site.__table__.c.address.nullable is True
    assert isinstance(Site.__table__.c.address.type, Text)
    for column_name in ("created_at", "updated_at"):
        timestamp = Site.__table__.c[column_name]
        assert isinstance(timestamp.type, DateTime)
        assert timestamp.type.timezone is True
        assert timestamp.default is not None
        assert timestamp.default.arg(None).utcoffset() == UTC.utcoffset(None)

    assert (
        Site.__table__.c.updated_at.onupdate.arg(None).utcoffset()
        == UTC.utcoffset(None)
    )


def test_site_organization_and_portfolio_are_composite_foreign_key():
    constraints = [
        constraint
        for constraint in Site.__table__.constraints
        if isinstance(constraint, ForeignKeyConstraint)
    ]
    assert len(constraints) == 1
    assert constraints[0].name == "fk_sites_portfolio_organization"
    assert tuple(column.name for column in constraints[0].columns) == (
        "portfolio_id",
        "organization_id",
    )
    assert tuple(
        element.target_fullname for element in constraints[0].elements
    ) == ("portfolios.id", "portfolios.organization_id")

    portfolio_unique_constraints = {
        constraint.name: tuple(column.name for column in constraint.columns)
        for constraint in Portfolio.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert portfolio_unique_constraints == {
        "uq_portfolios_id_organization": ("id", "organization_id")
    }


def test_site_name_status_constraints_and_lookup_indexes_are_declared():
    checks = {
        constraint.name: str(constraint.sqltext)
        for constraint in Site.__table__.constraints
        if isinstance(constraint, CheckConstraint)
    }
    assert checks == {
        "ck_sites_name_not_empty": "length(trim(name)) > 0",
        "ck_sites_status": "status IN ('active', 'inactive')",
    }
    assert {status.value for status in SiteStatus} == {"active", "inactive"}
    indexes = {
        tuple(column.name for column in index.columns)
        for index in Site.__table__.indexes
    }
    assert ("organization_id",) in indexes
    assert ("portfolio_id",) in indexes


def test_building_required_fields_and_utc_timestamps_are_declared():
    for column_name in (
        "organization_id",
        "site_id",
        "name",
        "status",
        "created_at",
        "updated_at",
    ):
        assert Building.__table__.c[column_name].nullable is False

    assert Building.__table__.c.building_code.nullable is True
    assert Building.__table__.c.address.nullable is True
    assert isinstance(Building.__table__.c.building_code.type, String)
    assert isinstance(Building.__table__.c.address.type, Text)
    for column_name in ("created_at", "updated_at"):
        timestamp = Building.__table__.c[column_name]
        assert isinstance(timestamp.type, DateTime)
        assert timestamp.type.timezone is True
        assert timestamp.default is not None
        assert timestamp.default.arg(None).utcoffset() == UTC.utcoffset(None)

    assert (
        Building.__table__.c.updated_at.onupdate.arg(None).utcoffset()
        == UTC.utcoffset(None)
    )


def test_building_organization_site_composite_foreign_key_and_indexes():
    constraints = [
        constraint
        for constraint in Building.__table__.constraints
        if isinstance(constraint, ForeignKeyConstraint)
    ]
    assert len(constraints) == 1
    assert constraints[0].name == "fk_buildings_site_organization"
    assert tuple(column.name for column in constraints[0].columns) == (
        "site_id",
        "organization_id",
    )
    assert tuple(element.target_fullname for element in constraints[0].elements) == (
        "sites.id",
        "sites.organization_id",
    )

    site_unique_constraints = {
        constraint.name: tuple(column.name for column in constraint.columns)
        for constraint in Site.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert site_unique_constraints == {
        "uq_sites_id_organization": ("id", "organization_id")
    }

    indexes = {
        tuple(column.name for column in index.columns)
        for index in Building.__table__.indexes
    }
    assert ("organization_id",) in indexes
    assert ("site_id",) in indexes


def test_building_name_and_status_constraints_are_declared():
    checks = {
        constraint.name: str(constraint.sqltext)
        for constraint in Building.__table__.constraints
        if isinstance(constraint, CheckConstraint)
    }
    assert checks == {
        "ck_buildings_name_not_empty": "length(trim(name)) > 0",
        "ck_buildings_status": "status IN ('active', 'inactive')",
    }
    assert {status.value for status in BuildingStatus} == {"active", "inactive"}


def test_unit_required_fields_timestamps_and_numeric_area_are_declared():
    for column_name in (
        "organization_id",
        "building_id",
        "name",
        "status",
        "created_at",
        "updated_at",
    ):
        assert Unit.__table__.c[column_name].nullable is False

    assert Unit.__table__.c.unit_code.nullable is True
    assert Unit.__table__.c.floor.nullable is True
    assert Unit.__table__.c.area_sqm.nullable is True
    assert isinstance(Unit.__table__.c.area_sqm.type, Numeric)
    assert Unit.__table__.c.area_sqm.type.precision == 12
    assert Unit.__table__.c.area_sqm.type.scale == 2
    assert Unit.__table__.c.area_sqm.type.python_type is Decimal

    for column_name in ("created_at", "updated_at"):
        timestamp = Unit.__table__.c[column_name]
        assert isinstance(timestamp.type, DateTime)
        assert timestamp.type.timezone is True
        assert timestamp.default is not None
        assert timestamp.default.arg(None).utcoffset() == UTC.utcoffset(None)

    assert (
        Unit.__table__.c.updated_at.onupdate.arg(None).utcoffset()
        == UTC.utcoffset(None)
    )


def test_unit_building_organization_composite_foreign_key_and_indexes():
    constraints = [
        constraint
        for constraint in Unit.__table__.constraints
        if isinstance(constraint, ForeignKeyConstraint)
    ]
    assert len(constraints) == 1
    assert constraints[0].name == "fk_units_building_organization"
    assert tuple(column.name for column in constraints[0].columns) == (
        "building_id",
        "organization_id",
    )
    assert tuple(element.target_fullname for element in constraints[0].elements) == (
        "buildings.id",
        "buildings.organization_id",
    )

    building_unique_constraints = {
        constraint.name: tuple(column.name for column in constraint.columns)
        for constraint in Building.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert building_unique_constraints == {
        "uq_buildings_id_organization": ("id", "organization_id")
    }

    indexes = {
        tuple(column.name for column in index.columns)
        for index in Unit.__table__.indexes
    }
    assert ("organization_id",) in indexes
    assert ("building_id",) in indexes


def test_unit_name_status_and_positive_area_constraints_are_declared():
    checks = {
        constraint.name: str(constraint.sqltext)
        for constraint in Unit.__table__.constraints
        if isinstance(constraint, CheckConstraint)
    }
    assert checks == {
        "ck_units_name_not_empty": "length(trim(name)) > 0",
        "ck_units_status": "status IN ('active', 'inactive')",
        "ck_units_area_sqm_positive": "area_sqm IS NULL OR area_sqm > 0",
    }
    assert {status.value for status in UnitStatus} == {"active", "inactive"}
