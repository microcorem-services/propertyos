from datetime import UTC
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKeyConstraint, Index
from sqlalchemy.sql.sqltypes import Uuid

from app.database import Base
from app.models import Portfolio, PortfolioStatus


def test_portfolio_table_and_uuid_primary_key_are_declared():
    assert set(Base.metadata.tables) == {"portfolios"}

    portfolio_id = Portfolio.__table__.c.id
    assert portfolio_id.primary_key
    assert portfolio_id.nullable is False
    assert isinstance(portfolio_id.type, Uuid)


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
