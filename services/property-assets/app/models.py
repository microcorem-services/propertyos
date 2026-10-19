from datetime import UTC, datetime
from enum import StrEnum
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    Index,
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
