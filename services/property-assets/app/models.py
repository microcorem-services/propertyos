from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    JSON,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class PortfolioStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"


class Portfolio(Base):
    __tablename__ = "portfolios"
    __table_args__ = (
        CheckConstraint(
            "length(trim(name)) > 0",
            name="ck_portfolios_name_not_empty",
        ),
        CheckConstraint(
            "status IN ('active', 'inactive')",
            name="ck_portfolios_status",
        ),
        UniqueConstraint(
            "id",
            "organization_id",
            name="uq_portfolios_id_organization",
        ),
        Index("ix_portfolios_organization_id", "organization_id"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid4,
    )
    organization_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=PortfolioStatus.ACTIVE.value,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        server_default=func.now(),
    )

    sites: Mapped[list["Site"]] = relationship(back_populates="portfolio")


class PortfolioAuditEvent(Base):
    __tablename__ = "portfolio_audit_events"
    __table_args__ = (
        CheckConstraint(
            "operation IN ('property-assets.portfolios.create', "
            "'property-assets.portfolios.update')",
            name="ck_portfolio_audit_operation",
        ),
        Index(
            "ix_portfolio_audit_organization_portfolio",
            "organization_id",
            "portfolio_id",
        ),
        Index("ix_portfolio_audit_occurred_at", "occurred_at"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid4,
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    portfolio_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    operation: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
    changed_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False)


class SiteStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"


class Site(Base):
    __tablename__ = "sites"
    __table_args__ = (
        CheckConstraint(
            "length(trim(name)) > 0",
            name="ck_sites_name_not_empty",
        ),
        CheckConstraint(
            "status IN ('active', 'inactive')",
            name="ck_sites_status",
        ),
        ForeignKeyConstraint(
            ["portfolio_id", "organization_id"],
            ["portfolios.id", "portfolios.organization_id"],
            name="fk_sites_portfolio_organization",
        ),
        Index("ix_sites_organization_id", "organization_id"),
        Index("ix_sites_portfolio_id", "portfolio_id"),
        UniqueConstraint(
            "id",
            "organization_id",
            name="uq_sites_id_organization",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid4,
    )
    organization_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
    )
    portfolio_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=SiteStatus.ACTIVE.value,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        server_default=func.now(),
    )

    portfolio: Mapped[Portfolio] = relationship(back_populates="sites")
    buildings: Mapped[list["Building"]] = relationship(back_populates="site")


class SiteAuditEvent(Base):
    __tablename__ = "site_audit_events"
    __table_args__ = (
        CheckConstraint(
            "operation IN ('property-assets.sites.create', "
            "'property-assets.sites.update')",
            name="ck_site_audit_operation",
        ),
        Index(
            "ix_site_audit_organization_site",
            "organization_id",
            "site_id",
        ),
        Index("ix_site_audit_occurred_at", "occurred_at"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid4,
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    site_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    operation: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
    changed_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False)


class BuildingStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"


class Building(Base):
    __tablename__ = "buildings"
    __table_args__ = (
        CheckConstraint(
            "length(trim(name)) > 0",
            name="ck_buildings_name_not_empty",
        ),
        CheckConstraint(
            "status IN ('active', 'inactive')",
            name="ck_buildings_status",
        ),
        ForeignKeyConstraint(
            ["site_id", "organization_id"],
            ["sites.id", "sites.organization_id"],
            name="fk_buildings_site_organization",
        ),
        Index("ix_buildings_organization_id", "organization_id"),
        Index("ix_buildings_site_id", "site_id"),
        UniqueConstraint(
            "id",
            "organization_id",
            name="uq_buildings_id_organization",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid4,
    )
    organization_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
    )
    site_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    building_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=BuildingStatus.ACTIVE.value,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        server_default=func.now(),
    )

    site: Mapped[Site] = relationship(back_populates="buildings")
    units: Mapped[list["Unit"]] = relationship(back_populates="building")


class BuildingAuditEvent(Base):
    __tablename__ = "building_audit_events"
    __table_args__ = (
        CheckConstraint(
            "operation IN ('property-assets.buildings.create', "
            "'property-assets.buildings.update')",
            name="ck_building_audit_operation",
        ),
        Index(
            "ix_building_audit_organization_building",
            "organization_id",
            "building_id",
        ),
        Index("ix_building_audit_occurred_at", "occurred_at"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid4,
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    building_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    operation: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
    changed_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False)


class UnitStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"


class Unit(Base):
    __tablename__ = "units"
    __table_args__ = (
        CheckConstraint(
            "length(trim(name)) > 0",
            name="ck_units_name_not_empty",
        ),
        CheckConstraint(
            "status IN ('active', 'inactive')",
            name="ck_units_status",
        ),
        CheckConstraint(
            "area_sqm IS NULL OR area_sqm > 0",
            name="ck_units_area_sqm_positive",
        ),
        ForeignKeyConstraint(
            ["building_id", "organization_id"],
            ["buildings.id", "buildings.organization_id"],
            name="fk_units_building_organization",
        ),
        Index("ix_units_organization_id", "organization_id"),
        Index("ix_units_building_id", "building_id"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid4,
    )
    organization_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
    )
    building_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    unit_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    floor: Mapped[str | None] = mapped_column(String(50), nullable=True)
    area_sqm: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=UnitStatus.ACTIVE.value,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        server_default=func.now(),
    )

    building: Mapped[Building] = relationship(back_populates="units")


class UnitAuditEvent(Base):
    __tablename__ = "unit_audit_events"
    __table_args__ = (
        CheckConstraint(
            "operation IN ('property-assets.units.create', "
            "'property-assets.units.update')",
            name="ck_unit_audit_operation",
        ),
        Index("ix_unit_audit_organization_unit", "organization_id", "unit_id"),
        Index("ix_unit_audit_occurred_at", "occurred_at"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid4,
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    unit_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    operation: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
    changed_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False)
