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


class RentScheduleStatus(StrEnum):
    DRAFT = "draft"
    ACTIVE = "active"


class ChargeCategory(StrEnum):
    BASE_RENT = "base_rent"
    SERVICE_CHARGE = "service_charge"
    BUILDING_MAINTENANCE = "building_maintenance"
    INSURANCE_CONTRIBUTION = "insurance_contribution"
    SHARED_FACILITIES = "shared_facilities"
    OTHER_PROPERTY_CHARGE = "other_property_charge"


class PropertyExpenseCategory(StrEnum):
    UTILITIES = "utilities"
    MAINTENANCE = "maintenance"
    INSURANCE = "insurance"
    REPAIRS = "repairs"
    CLEANING = "cleaning"
    SECURITY = "security"
    SHARED_FACILITIES = "shared_facilities"
    OTHER = "other"


class ExpenseRecoverability(StrEnum):
    RECOVERABLE = "recoverable"
    NON_RECOVERABLE = "non_recoverable"


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
            "event_type IN ('created', 'updated', 'rent_schedule_created', "
            "'rent_schedule_updated', 'rent_schedule_activated', "
            "'rent_schedule_generated', 'charge_created', 'charge_updated', "
            "'charge_activated', 'charge_generated')",
            name="ck_lease_audit_event_type",
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
    event_type: Mapped[str] = mapped_column(String(30), nullable=False)
    changed_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    lease: Mapped[Lease] = relationship(back_populates="audit_events")


class RentSchedule(Base):
    __tablename__ = "rent_schedules"
    __table_args__ = (
        ForeignKeyConstraint(
            ["lease_id", "organization_id"],
            ["leases.id", "leases.organization_id"],
            name="fk_rent_schedules_lease_organization",
        ),
        UniqueConstraint(
            "id", "organization_id", name="uq_rent_schedules_id_organization"
        ),
        CheckConstraint(
            "charge_category IN ('base_rent', 'service_charge', "
            "'building_maintenance', 'insurance_contribution', "
            "'shared_facilities', 'other_property_charge')",
            name="ck_rent_schedules_category",
        ),
        CheckConstraint(
            "length(trim(description)) > 0", name="ck_rent_schedules_description"
        ),
        CheckConstraint(
            "amount_per_period > 0", name="ck_rent_schedules_amount_positive"
        ),
        CheckConstraint(
            "payment_frequency IN ('monthly', 'quarterly', 'annually')",
            name="ck_rent_schedules_frequency",
        ),
        CheckConstraint("due_day BETWEEN 1 AND 31", name="ck_rent_schedules_due_day"),
        CheckConstraint(
            "short_month_rule = 'clamp_to_month_end'",
            name="ck_rent_schedules_short_month_rule",
        ),
        CheckConstraint(
            "status IN ('draft', 'active')", name="ck_rent_schedules_status"
        ),
        CheckConstraint("end_date >= start_date", name="ck_rent_schedules_dates"),
        Index(
            "ix_rent_schedules_organization_lease",
            "organization_id",
            "lease_id",
            "status",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    lease_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    charge_category: Mapped[str] = mapped_column(
        String(40), nullable=False, default="base_rent"
    )
    description: Mapped[str] = mapped_column(
        String(250), nullable=False, default="Base rent"
    )
    amount_per_period: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    payment_frequency: Mapped[str] = mapped_column(String(20), nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    due_day: Mapped[int] = mapped_column(nullable=False)
    short_month_rule: Mapped[str] = mapped_column(
        String(32), nullable=False, default="clamp_to_month_end"
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=RentScheduleStatus.DRAFT.value
    )
    manual_review_reasons: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    installments: Mapped[list["RentInstallment"]] = relationship(
        back_populates="schedule", cascade="all, delete-orphan"
    )


class RentInstallment(Base):
    __tablename__ = "rent_installments"
    __table_args__ = (
        ForeignKeyConstraint(
            ["schedule_id", "organization_id"],
            ["rent_schedules.id", "rent_schedules.organization_id"],
            name="fk_rent_installments_schedule_organization",
        ),
        UniqueConstraint(
            "organization_id",
            "schedule_id",
            "due_date",
            name="uq_rent_installments_schedule_due_date",
        ),
        UniqueConstraint(
            "id", "organization_id", name="uq_rent_installments_id_organization"
        ),
        CheckConstraint("amount > 0", name="ck_rent_installments_amount_positive"),
        CheckConstraint(
            "currency IN ('GBP', 'EUR', 'USD')",
            name="ck_rent_installments_currency",
        ),
        CheckConstraint("status = 'expected'", name="ck_rent_installments_status"),
        Index(
            "ix_rent_installments_organization_due_date",
            "organization_id",
            "due_date",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    schedule_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    due_date: Mapped[date] = mapped_column(Date, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="expected")
    schedule: Mapped[RentSchedule] = relationship(back_populates="installments")


class PropertyExpense(Base):
    __tablename__ = "property_expenses"
    __table_args__ = (
        UniqueConstraint(
            "id", "organization_id", name="uq_property_expenses_id_organization"
        ),
        CheckConstraint(
            "asset_level IN ('portfolio', 'site', 'building', 'unit')",
            name="ck_property_expenses_asset_level",
        ),
        CheckConstraint(
            "category IN ('utilities', 'maintenance', 'insurance', 'repairs', "
            "'cleaning', 'security', 'shared_facilities', 'other')",
            name="ck_property_expenses_category",
        ),
        CheckConstraint(
            "length(trim(description)) > 0", name="ck_property_expenses_description"
        ),
        CheckConstraint("amount > 0", name="ck_property_expenses_amount_positive"),
        CheckConstraint(
            "currency IN ('GBP', 'EUR', 'USD')", name="ck_property_expenses_currency"
        ),
        CheckConstraint(
            "recoverability IN ('recoverable', 'non_recoverable')",
            name="ck_property_expenses_recoverability",
        ),
        CheckConstraint(
            "(asset_level = 'portfolio' AND site_id IS NULL "
            "AND building_id IS NULL AND unit_id IS NULL) OR "
            "(asset_level = 'site' AND site_id IS NOT NULL "
            "AND building_id IS NULL AND unit_id IS NULL) OR "
            "(asset_level = 'building' AND site_id IS NOT NULL "
            "AND building_id IS NOT NULL AND unit_id IS NULL) OR "
            "(asset_level = 'unit' AND site_id IS NOT NULL "
            "AND building_id IS NOT NULL AND unit_id IS NOT NULL)",
            name="ck_property_expenses_asset_hierarchy",
        ),
        UniqueConstraint(
            "organization_id",
            "idempotency_key",
            name="uq_property_expenses_idempotency",
        ),
        Index(
            "ix_property_expenses_organization_date",
            "organization_id",
            "expense_date",
        ),
        Index(
            "ix_property_expenses_organization_asset_date",
            "organization_id",
            "asset_level",
            "portfolio_id",
            "site_id",
            "building_id",
            "unit_id",
            "expense_date",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    idempotency_key: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    request_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    asset_level: Mapped[str] = mapped_column(String(20), nullable=False)
    portfolio_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    site_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    building_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    unit_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    description: Mapped[str] = mapped_column(String(250), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    expense_date: Mapped[date] = mapped_column(Date, nullable=False)
    recoverability: Mapped[str] = mapped_column(String(20), nullable=False)
    manual_review_reasons: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    audit_events: Mapped[list["PropertyExpenseAuditEvent"]] = relationship(
        back_populates="expense", cascade="all, delete-orphan"
    )


class PropertyExpenseAuditEvent(Base):
    __tablename__ = "property_expense_audit_events"
    __table_args__ = (
        ForeignKeyConstraint(
            ["expense_id", "organization_id"],
            ["property_expenses.id", "property_expenses.organization_id"],
            name="fk_property_expense_audit_expense_organization",
        ),
        CheckConstraint(
            "event_type IN ('created', 'updated')",
            name="ck_property_expense_audit_event_type",
        ),
        Index(
            "ix_property_expense_audit_organization_expense_occurred",
            "organization_id",
            "expense_id",
            "occurred_at",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    expense_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    actor_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    event_type: Mapped[str] = mapped_column(String(20), nullable=False)
    changed_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expense: Mapped[PropertyExpense] = relationship(back_populates="audit_events")


class Invoice(Base):
    __tablename__ = "invoices"
    __table_args__ = (
        ForeignKeyConstraint(
            ["lease_id", "organization_id"],
            ["leases.id", "leases.organization_id"],
            name="fk_invoices_lease_organization",
        ),
        UniqueConstraint("id", "organization_id", name="uq_invoices_id_organization"),
        UniqueConstraint(
            "organization_id", "invoice_number", name="uq_invoices_organization_number"
        ),
        CheckConstraint(
            "length(trim(invoice_number)) > 0", name="ck_invoices_number"
        ),
        CheckConstraint(
            "currency IN ('GBP', 'EUR', 'USD')", name="ck_invoices_currency"
        ),
        CheckConstraint("due_date >= issue_date", name="ck_invoices_dates"),
        CheckConstraint(
            "status IN ('draft', 'issued')", name="ck_invoices_status"
        ),
        CheckConstraint("subtotal >= 0 AND total >= 0", name="ck_invoices_totals"),
        Index("ix_invoices_organization_status_due", "organization_id", "status", "due_date"),
        Index("ix_invoices_organization_lease", "organization_id", "lease_id"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    lease_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    invoice_number: Mapped[str] = mapped_column(String(100), nullable=False)
    issue_date: Mapped[date] = mapped_column(Date, nullable=False)
    due_date: Mapped[date] = mapped_column(Date, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    subtotal: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    total: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    lines: Mapped[list["InvoiceLine"]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan"
    )
    audit_events: Mapped[list["InvoiceAuditEvent"]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan"
    )
    allocations: Mapped[list["PaymentAllocation"]] = relationship(
        back_populates="invoice", overlaps="payment,allocations"
    )


class InvoiceLine(Base):
    __tablename__ = "invoice_lines"
    __table_args__ = (
        ForeignKeyConstraint(
            ["invoice_id", "organization_id"],
            ["invoices.id", "invoices.organization_id"],
            name="fk_invoice_lines_invoice_organization",
        ),
        ForeignKeyConstraint(
            ["source_installment_id", "organization_id"],
            ["rent_installments.id", "rent_installments.organization_id"],
            name="fk_invoice_lines_installment_organization",
        ),
        UniqueConstraint(
            "source_installment_id", name="uq_invoice_lines_source_installment"
        ),
        CheckConstraint("length(trim(description)) > 0", name="ck_invoice_lines_description"),
        CheckConstraint("quantity > 0", name="ck_invoice_lines_quantity"),
        CheckConstraint("unit_amount >= 0", name="ck_invoice_lines_unit_amount"),
        CheckConstraint("line_total >= 0", name="ck_invoice_lines_total"),
        Index("ix_invoice_lines_organization_invoice", "organization_id", "invoice_id"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    invoice_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    source_installment_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    description: Mapped[str] = mapped_column(String(250), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    unit_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    line_total: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    invoice: Mapped[Invoice] = relationship(back_populates="lines")


class InvoiceAuditEvent(Base):
    __tablename__ = "invoice_audit_events"
    __table_args__ = (
        ForeignKeyConstraint(
            ["invoice_id", "organization_id"],
            ["invoices.id", "invoices.organization_id"],
            name="fk_invoice_audit_invoice_organization",
        ),
        CheckConstraint(
            "event_type IN ('created', 'updated', 'issued')",
            name="ck_invoice_audit_event_type",
        ),
        Index(
            "ix_invoice_audit_organization_invoice_occurred",
            "organization_id",
            "invoice_id",
            "occurred_at",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    invoice_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    actor_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    event_type: Mapped[str] = mapped_column(String(20), nullable=False)
    changed_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    invoice: Mapped[Invoice] = relationship(back_populates="audit_events")


class Payment(Base):
    __tablename__ = "payments"
    __table_args__ = (
        UniqueConstraint("id", "organization_id", name="uq_payments_id_organization"),
        UniqueConstraint(
            "organization_id", "idempotency_key", name="uq_payments_idempotency"
        ),
        CheckConstraint("length(trim(reference)) > 0", name="ck_payments_reference"),
        CheckConstraint(
            "length(trim(method_description)) > 0", name="ck_payments_method"
        ),
        CheckConstraint("amount > 0", name="ck_payments_amount"),
        CheckConstraint(
            "currency IN ('GBP', 'EUR', 'USD')", name="ck_payments_currency"
        ),
        Index("ix_payments_organization_received", "organization_id", "received_on"),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    idempotency_key: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    request_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    reference: Mapped[str] = mapped_column(String(100), nullable=False)
    received_on: Mapped[date] = mapped_column(Date, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    method_description: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    allocations: Mapped[list["PaymentAllocation"]] = relationship(
        back_populates="payment",
        cascade="all, delete-orphan",
        overlaps="invoice,allocations",
    )
    audit_events: Mapped[list["PaymentAuditEvent"]] = relationship(
        back_populates="payment", cascade="all, delete-orphan"
    )


class PaymentAllocation(Base):
    __tablename__ = "payment_allocations"
    __table_args__ = (
        ForeignKeyConstraint(
            ["payment_id", "organization_id"],
            ["payments.id", "payments.organization_id"],
            name="fk_payment_allocations_payment_organization",
        ),
        ForeignKeyConstraint(
            ["invoice_id", "organization_id"],
            ["invoices.id", "invoices.organization_id"],
            name="fk_payment_allocations_invoice_organization",
        ),
        UniqueConstraint(
            "payment_id", "invoice_id", name="uq_payment_allocations_payment_invoice"
        ),
        CheckConstraint("amount > 0", name="ck_payment_allocations_amount"),
        Index(
            "ix_payment_allocations_organization_invoice",
            "organization_id",
            "invoice_id",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    payment_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    invoice_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    payment: Mapped[Payment] = relationship(
        back_populates="allocations", overlaps="invoice,allocations"
    )
    invoice: Mapped[Invoice] = relationship(
        back_populates="allocations", overlaps="payment,allocations"
    )


class PaymentAuditEvent(Base):
    __tablename__ = "payment_audit_events"
    __table_args__ = (
        ForeignKeyConstraint(
            ["payment_id", "organization_id"],
            ["payments.id", "payments.organization_id"],
            name="fk_payment_audit_payment_organization",
        ),
        CheckConstraint(
            "event_type = 'recorded'", name="ck_payment_audit_event_type"
        ),
        Index(
            "ix_payment_audit_organization_payment_occurred",
            "organization_id",
            "payment_id",
            "occurred_at",
        ),
    )

    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid4
    )
    organization_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    payment_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    actor_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    event_type: Mapped[str] = mapped_column(String(20), nullable=False)
    changed_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    payment: Mapped[Payment] = relationship(back_populates="audit_events")
