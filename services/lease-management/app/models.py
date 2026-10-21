from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Numeric,
    String,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class LeaseStatus(StrEnum):
    DRAFT = "draft"
    ACTIVE = "active"
    EXPIRED = "expired"
    TERMINATED = "terminated"


class PartyRole(StrEnum):
    LANDLORD = "landlord"
    TENANT = "tenant"
    GUARANTOR = "guarantor"


class PartyType(StrEnum):
    INDIVIDUAL = "individual"
    ORGANIZATION = "organization"


class Lease(Base):
    __tablename__ = "leases"
    __table_args__ = (
        UniqueConstraint(
            "organization_id",
            "lease_reference",
            name="uq_leases_organization_reference",
        ),
        UniqueConstraint("id", "organization_id", name="uq_leases_id_organization"),
        CheckConstraint(
            "length(trim(lease_reference)) > 0", name="ck_leases_reference"
        ),
        CheckConstraint("rent_amount > 0", name="ck_leases_rent_positive"),
        CheckConstraint("currency IN ('GBP', 'EUR', 'USD')", name="ck_leases_currency"),
        CheckConstraint(
            "payment_frequency IN ('monthly', 'quarterly', 'annually')",
            name="ck_leases_payment_frequency",
        ),
        CheckConstraint(
            "status IN ('draft', 'active', 'expired', 'terminated')",
            name="ck_leases_status",
        ),
        CheckConstraint("expiry_date >= start_date", name="ck_leases_dates"),
        CheckConstraint(
            "break_date IS NULL OR (break_date >= start_date "
            "AND break_date <= expiry_date)",
            name="ck_leases_break_date",
        ),
        Index("ix_leases_organization_status", "organization_id", "status"),
        Index("ix_leases_organization_expiry", "organization_id", "expiry_date"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    lease_reference: Mapped[str] = mapped_column(String(100), nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    expiry_date: Mapped[date] = mapped_column(Date, nullable=False)
    break_date: Mapped[date | None] = mapped_column(Date)
    rent_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    payment_frequency: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    parties: Mapped[list["LeaseParty"]] = relationship(
        back_populates="lease", cascade="all, delete-orphan"
    )
    units: Mapped[list["LeaseUnit"]] = relationship(
        back_populates="lease", cascade="all, delete-orphan"
    )
    audit_events: Mapped[list["LeaseAuditEvent"]] = relationship(back_populates="lease")


class LeaseParty(Base):
    __tablename__ = "lease_parties"
    __table_args__ = (
        ForeignKeyConstraint(
            ["lease_id", "organization_id"],
            ["leases.id", "leases.organization_id"],
            name="fk_lease_parties_lease_organization",
        ),
        CheckConstraint("length(trim(legal_name)) > 0", name="ck_lease_parties_name"),
        CheckConstraint(
            "role IN ('landlord', 'tenant', 'guarantor')", name="ck_lease_parties_role"
        ),
        CheckConstraint(
            "party_type IN ('individual', 'organization')",
            name="ck_lease_parties_type",
        ),
        Index("ix_lease_parties_organization_lease", "organization_id", "lease_id"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    lease_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    legal_name: Mapped[str] = mapped_column(String(250), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    party_type: Mapped[str] = mapped_column(String(20), nullable=False)
    lease: Mapped[Lease] = relationship(back_populates="parties")


class LeaseUnit(Base):
    __tablename__ = "lease_units"
    __table_args__ = (
        ForeignKeyConstraint(
            ["lease_id", "organization_id"],
            ["leases.id", "leases.organization_id"],
            name="fk_lease_units_lease_organization",
        ),
        UniqueConstraint(
            "organization_id", "lease_id", "unit_id", name="uq_lease_units_unit"
        ),
        Index("ix_lease_units_organization_unit", "organization_id", "unit_id"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    lease_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    unit_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    portfolio_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    site_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    building_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    lease: Mapped[Lease] = relationship(back_populates="units")


class LeaseAuditEvent(Base):
    __tablename__ = "lease_audit_events"
    __table_args__ = (
        ForeignKeyConstraint(
            ["lease_id", "organization_id"],
            ["leases.id", "leases.organization_id"],
            name="fk_lease_audit_lease_organization",
        ),
        CheckConstraint(
            "event_type IN ('created', 'updated')", name="ck_lease_audit_event_type"
        ),
        Index(
            "ix_lease_audit_organization_lease_occurred",
            "organization_id",
            "lease_id",
            "occurred_at",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    lease_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    actor_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    event_type: Mapped[str] = mapped_column(String(20), nullable=False)
    changed_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    lease: Mapped[Lease] = relationship(back_populates="audit_events")
