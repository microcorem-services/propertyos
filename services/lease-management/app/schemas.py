from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class APIModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class LeaseUnitInput(APIModel):
    portfolio_id: UUID
    site_id: UUID
    building_id: UUID
    unit_id: UUID


class LeasePartyInput(APIModel):
    legal_name: str = Field(min_length=1, max_length=250)
    role: Literal["landlord", "tenant", "guarantor"]
    party_type: Literal["individual", "organization"]


def validate_parties(parties: list[LeasePartyInput]) -> list[LeasePartyInput]:
    if not any(party.role == "tenant" for party in parties):
        raise ValueError("At least one tenant is required.")
    if not any(party.role == "landlord" for party in parties):
        raise ValueError("At least one landlord is required.")
    return parties


def reject_float_rent(value):
    if isinstance(value, float):
        raise ValueError("Rent must be supplied as a decimal string or integer.")
    return value


class LeaseCreateRequest(APIModel):
    lease_reference: str = Field(min_length=1, max_length=100)
    start_date: date
    expiry_date: date
    break_date: date | None = None
    rent_amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    currency: Literal["GBP", "EUR", "USD"]
    payment_frequency: Literal["monthly", "quarterly", "annually"]
    status: Literal["draft", "active", "expired", "terminated"] = "draft"
    units: list[LeaseUnitInput] = Field(min_length=1, max_length=50)
    parties: list[LeasePartyInput] = Field(min_length=2, max_length=100)

    _rent_must_not_be_float = field_validator("rent_amount", mode="before")(
        reject_float_rent
    )

    @field_validator("parties")
    @classmethod
    def require_landlord_and_tenant(cls, value):
        return validate_parties(value)

    @model_validator(mode="after")
    def validate_contract_dates_and_units(self):
        if self.expiry_date < self.start_date:
            raise ValueError("Expiry date must not precede start date.")
        if self.break_date is not None and not (
            self.start_date <= self.break_date <= self.expiry_date
        ):
            raise ValueError("Break date must fall within the lease term.")
        if len({unit.unit_id for unit in self.units}) != len(self.units):
            raise ValueError("A Unit may only be listed once.")
        return self


class LeaseUpdateRequest(APIModel):
    lease_reference: str | None = Field(default=None, min_length=1, max_length=100)
    start_date: date | None = None
    expiry_date: date | None = None
    break_date: date | None = None
    rent_amount: Decimal | None = Field(
        default=None, gt=0, max_digits=14, decimal_places=2
    )
    currency: Literal["GBP", "EUR", "USD"] | None = None
    payment_frequency: Literal["monthly", "quarterly", "annually"] | None = None
    status: Literal["draft", "active", "expired", "terminated"] | None = None
    units: list[LeaseUnitInput] | None = Field(
        default=None, min_length=1, max_length=50
    )
    parties: list[LeasePartyInput] | None = Field(
        default=None, min_length=2, max_length=100
    )

    _rent_must_not_be_float = field_validator("rent_amount", mode="before")(
        reject_float_rent
    )

    @field_validator(
        "lease_reference",
        "start_date",
        "expiry_date",
        "rent_amount",
        "currency",
        "payment_frequency",
        "status",
        "units",
        "parties",
    )
    @classmethod
    def reject_null_for_non_nullable_fields(cls, value):
        if value is None:
            raise ValueError("This field cannot be null.")
        return value

    @field_validator("parties")
    @classmethod
    def require_landlord_and_tenant(cls, value):
        return validate_parties(value)

    @model_validator(mode="after")
    def require_fields_and_validate_dates(self):
        if not self.model_fields_set:
            raise ValueError("At least one field must be updated.")
        if self.start_date is not None and self.expiry_date is not None:
            if self.expiry_date < self.start_date:
                raise ValueError("Expiry date must not precede start date.")
        if (
            self.break_date is not None
            and self.start_date is not None
            and self.expiry_date is not None
            and not self.start_date <= self.break_date <= self.expiry_date
        ):
            raise ValueError("Break date must fall within the lease term.")
        if self.units is not None and len({unit.unit_id for unit in self.units}) != len(
            self.units
        ):
            raise ValueError("A Unit may only be listed once.")
        return self


class RentScheduleCreateRequest(APIModel):
    charge_category: Literal[
        "base_rent",
        "service_charge",
        "building_maintenance",
        "insurance_contribution",
        "shared_facilities",
        "other_property_charge",
    ] = "base_rent"
    description: str = Field(default="Base rent", min_length=1, max_length=250)
    amount_per_period: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    payment_frequency: Literal["monthly", "quarterly", "annually"]
    start_date: date
    end_date: date
    due_day: int = Field(ge=1, le=31)
    short_month_rule: Literal["clamp_to_month_end"] = "clamp_to_month_end"
    status: Literal["draft", "active"] = "draft"

    _amount_must_not_be_float = field_validator("amount_per_period", mode="before")(
        reject_float_rent
    )

    @model_validator(mode="after")
    def validate_schedule_dates(self):
        if self.end_date < self.start_date:
            raise ValueError("Schedule end date must not precede its start date.")
        return self


class RentScheduleUpdateRequest(APIModel):
    charge_category: Literal[
        "base_rent",
        "service_charge",
        "building_maintenance",
        "insurance_contribution",
        "shared_facilities",
        "other_property_charge",
    ] | None = None
    description: str | None = Field(default=None, min_length=1, max_length=250)
    amount_per_period: Decimal | None = Field(
        default=None, gt=0, max_digits=14, decimal_places=2
    )
    payment_frequency: Literal["monthly", "quarterly", "annually"] | None = None
    start_date: date | None = None
    end_date: date | None = None
    due_day: int | None = Field(default=None, ge=1, le=31)
    short_month_rule: Literal["clamp_to_month_end"] | None = None
    status: Literal["draft", "active"] | None = None

    _amount_must_not_be_float = field_validator("amount_per_period", mode="before")(
        reject_float_rent
    )

    @field_validator(
        "amount_per_period",
        "charge_category",
        "description",
        "payment_frequency",
        "start_date",
        "end_date",
        "due_day",
        "short_month_rule",
        "status",
    )
    @classmethod
    def reject_null_for_non_nullable_fields(cls, value):
        if value is None:
            raise ValueError("This field cannot be null.")
        return value

    @model_validator(mode="after")
    def require_fields_and_validate_dates(self):
        if not self.model_fields_set:
            raise ValueError("At least one field must be updated.")
        if (
            self.start_date is not None
            and self.end_date is not None
            and self.end_date < self.start_date
        ):
            raise ValueError("Schedule end date must not precede its start date.")
        return self


class LeasePartyResponse(BaseModel):
    id: UUID
    legal_name: str
    role: str
    party_type: str


class LeaseUnitResponse(BaseModel):
    portfolio_id: UUID
    site_id: UUID
    building_id: UUID
    unit_id: UUID
    verified_status: Literal["active", "unavailable"]


class LeaseAuditEventResponse(BaseModel):
    actor_id: UUID
    event_type: Literal[
        "created",
        "updated",
        "rent_schedule_created",
        "rent_schedule_updated",
        "rent_schedule_activated",
        "rent_schedule_generated",
        "charge_created",
        "charge_updated",
        "charge_activated",
        "charge_generated",
    ]
    changed_fields: list[str]
    occurred_at: datetime


class RentInstallmentResponse(BaseModel):
    id: UUID
    due_date: date
    amount: str
    currency: Literal["GBP", "EUR", "USD"]
    status: Literal["expected"]


class RentScheduleResponse(BaseModel):
    id: UUID
    organization_id: UUID
    lease_id: UUID
    charge_category: Literal[
        "base_rent",
        "service_charge",
        "building_maintenance",
        "insurance_contribution",
        "shared_facilities",
        "other_property_charge",
    ]
    description: str
    amount_per_period: str
    currency: Literal["GBP", "EUR", "USD"]
    payment_frequency: Literal["monthly", "quarterly", "annually"]
    start_date: date
    end_date: date
    due_day: int
    short_month_rule: Literal["clamp_to_month_end"]
    status: Literal["draft", "active"]
    manual_review_reasons: list[
        Literal["commencement_not_on_due_date", "end_not_on_period_boundary"]
    ]
    installments: list[RentInstallmentResponse]
    created_at: datetime
    updated_at: datetime


class PropertyExpenseCreateRequest(APIModel):
    idempotency_key: UUID
    asset_level: Literal["portfolio", "site", "building", "unit"]
    portfolio_id: UUID
    site_id: UUID | None = None
    building_id: UUID | None = None
    unit_id: UUID | None = None
    category: Literal[
        "utilities",
        "maintenance",
        "insurance",
        "repairs",
        "cleaning",
        "security",
        "shared_facilities",
        "other",
    ]
    description: str = Field(min_length=1, max_length=250)
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    currency: Literal["GBP", "EUR", "USD"]
    expense_date: date
    recoverability: Literal["recoverable", "non_recoverable"]

    _amount_must_not_be_float = field_validator("amount", mode="before")(
        reject_float_rent
    )

    @model_validator(mode="after")
    def validate_asset_hierarchy(self):
        expected = {
            "portfolio": (False, False, False),
            "site": (True, False, False),
            "building": (True, True, False),
            "unit": (True, True, True),
        }[self.asset_level]
        actual = (
            self.site_id is not None,
            self.building_id is not None,
            self.unit_id is not None,
        )
        if actual != expected:
            raise ValueError("Asset identifiers must match the selected asset level.")
        return self


class PropertyExpenseUpdateRequest(APIModel):
    category: Literal[
        "utilities",
        "maintenance",
        "insurance",
        "repairs",
        "cleaning",
        "security",
        "shared_facilities",
        "other",
    ] | None = None
    description: str | None = Field(default=None, min_length=1, max_length=250)
    amount: Decimal | None = Field(
        default=None, gt=0, max_digits=14, decimal_places=2
    )
    currency: Literal["GBP", "EUR", "USD"] | None = None
    expense_date: date | None = None
    recoverability: Literal["recoverable", "non_recoverable"] | None = None

    _amount_must_not_be_float = field_validator("amount", mode="before")(
        reject_float_rent
    )

    @field_validator(
        "category",
        "description",
        "amount",
        "currency",
        "expense_date",
        "recoverability",
    )
    @classmethod
    def reject_null_for_non_nullable_fields(cls, value):
        if value is None:
            raise ValueError("This field cannot be null.")
        return value

    @model_validator(mode="after")
    def require_fields(self):
        if not self.model_fields_set:
            raise ValueError("At least one field must be updated.")
        return self


class PropertyExpenseAuditEventResponse(BaseModel):
    actor_id: UUID
    event_type: Literal["created", "updated"]
    changed_fields: list[str]
    occurred_at: datetime


class PropertyExpenseResponse(BaseModel):
    id: UUID
    organization_id: UUID
    asset_level: Literal["portfolio", "site", "building", "unit"]
    portfolio_id: UUID
    site_id: UUID | None
    building_id: UUID | None
    unit_id: UUID | None
    category: Literal[
        "utilities",
        "maintenance",
        "insurance",
        "repairs",
        "cleaning",
        "security",
        "shared_facilities",
        "other",
    ]
    description: str
    amount: str
    currency: Literal["GBP", "EUR", "USD"]
    expense_date: date
    recoverability: Literal["recoverable", "non_recoverable"]
    manual_review_reasons: list[
        Literal["allocation_not_configured", "recovery_terms_not_verified"]
    ]
    audit_events: list[PropertyExpenseAuditEventResponse]
    created_at: datetime
    updated_at: datetime


class LeaseSummaryUnitResponse(BaseModel):
    portfolio_id: UUID
    site_id: UUID
    building_id: UUID
    unit_id: UUID


class LeaseSummaryResponse(BaseModel):
    id: UUID
    organization_id: UUID
    lease_reference: str
    start_date: date
    expiry_date: date
    break_date: date | None
    rent_amount: str
    currency: str
    payment_frequency: str
    status: str
    units: list[LeaseSummaryUnitResponse]
    parties: list[LeasePartyResponse]
    created_at: datetime
    updated_at: datetime


class LeaseListResponse(BaseModel):
    items: list[LeaseSummaryResponse]
    total: int
    limit: int
    offset: int


class LeaseResponse(BaseModel):
    id: UUID
    organization_id: UUID
    lease_reference: str
    start_date: date
    expiry_date: date
    break_date: date | None
    rent_amount: str
    currency: str
    payment_frequency: str
    status: str
    units: list[LeaseUnitResponse]
    parties: list[LeasePartyResponse]
    audit_events: list[LeaseAuditEventResponse]
    created_at: datetime
    updated_at: datetime


class InvoiceLineInput(APIModel):
    description: str = Field(min_length=1, max_length=250)
    quantity: Decimal = Field(gt=0, max_digits=12, decimal_places=3)
    unit_amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    source_installment_id: UUID | None = None

    _quantity_must_not_be_float = field_validator("quantity", mode="before")(
        reject_float_rent
    )
    _amount_must_not_be_float = field_validator("unit_amount", mode="before")(
        reject_float_rent
    )


class InvoiceCreateRequest(APIModel):
    lease_id: UUID
    invoice_number: str = Field(min_length=1, max_length=100)
    issue_date: date
    due_date: date
    currency: Literal["GBP", "EUR", "USD"]
    lines: list[InvoiceLineInput] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_invoice(self):
        if self.due_date < self.issue_date:
            raise ValueError("Due date must not precede invoice issue date.")
        if len(
            [
                line.source_installment_id
                for line in self.lines
                if line.source_installment_id is not None
            ]
        ) != len(
            {
                line.source_installment_id
                for line in self.lines
                if line.source_installment_id is not None
            }
        ):
            raise ValueError("A scheduled instalment may only appear once.")
        return self


class InvoiceUpdateRequest(APIModel):
    invoice_number: str | None = Field(default=None, min_length=1, max_length=100)
    issue_date: date | None = None
    due_date: date | None = None
    lines: list[InvoiceLineInput] | None = Field(default=None, min_length=1, max_length=100)

    @field_validator("invoice_number", "issue_date", "due_date", "lines")
    @classmethod
    def reject_null_for_supplied_fields(cls, value):
        if value is None:
            raise ValueError("This field cannot be null.")
        return value

    @model_validator(mode="after")
    def validate_invoice(self):
        if not self.model_fields_set:
            raise ValueError("At least one field must be updated.")
        if (
            self.issue_date is not None
            and self.due_date is not None
            and self.due_date < self.issue_date
        ):
            raise ValueError("Due date must not precede invoice issue date.")
        if self.lines is not None:
            source_ids = [
                line.source_installment_id
                for line in self.lines
                if line.source_installment_id is not None
            ]
            if len(source_ids) != len(set(source_ids)):
                raise ValueError("A scheduled instalment may only appear once.")
        return self


class InvoiceIssueRequest(APIModel):
    pass


class PaymentAllocationInput(APIModel):
    invoice_id: UUID
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)

    _amount_must_not_be_float = field_validator("amount", mode="before")(
        reject_float_rent
    )


class PaymentCreateRequest(APIModel):
    idempotency_key: UUID
    reference: str = Field(min_length=1, max_length=100)
    received_on: date
    currency: Literal["GBP", "EUR", "USD"]
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    method_description: str = Field(min_length=1, max_length=100)
    allocations: list[PaymentAllocationInput] = Field(min_length=1, max_length=50)

    _amount_must_not_be_float = field_validator("amount", mode="before")(
        reject_float_rent
    )

    @model_validator(mode="after")
    def validate_allocations(self):
        if sum((item.amount for item in self.allocations), Decimal("0")) > self.amount:
            raise ValueError("Allocations cannot exceed the recorded payment amount.")
        invoice_ids = [item.invoice_id for item in self.allocations]
        if len(invoice_ids) != len(set(invoice_ids)):
            raise ValueError("Each invoice may only be allocated once per payment.")
        return self


class InvoiceLineResponse(BaseModel):
    id: UUID
    description: str
    quantity: str
    unit_amount: str
    line_total: str
    source_installment_id: UUID | None


class InvoiceAuditEventResponse(BaseModel):
    actor_id: UUID
    event_type: Literal["created", "updated", "issued"]
    changed_fields: list[str]
    occurred_at: datetime


class InvoiceResponse(BaseModel):
    id: UUID
    organization_id: UUID
    lease_id: UUID
    lease_reference: str
    invoice_number: str
    issue_date: date
    due_date: date
    currency: Literal["GBP", "EUR", "USD"]
    subtotal: str
    total: str
    allocated_amount: str
    outstanding_balance: str
    status: Literal["draft", "issued"]
    receivable_status: Literal["draft", "due", "overdue", "paid"]
    issued_at: datetime | None
    lines: list[InvoiceLineResponse]
    audit_events: list[InvoiceAuditEventResponse]
    created_at: datetime
    updated_at: datetime


class EligibleInstallmentResponse(BaseModel):
    id: UUID
    lease_id: UUID
    schedule_id: UUID
    description: str
    charge_category: str
    due_date: date
    amount: str
    currency: Literal["GBP", "EUR", "USD"]


class PaymentAllocationResponse(BaseModel):
    invoice_id: UUID
    invoice_number: str
    amount: str


class PaymentAuditEventResponse(BaseModel):
    actor_id: UUID
    event_type: Literal["recorded"]
    changed_fields: list[str]
    occurred_at: datetime


class PaymentResponse(BaseModel):
    id: UUID
    organization_id: UUID
    reference: str
    received_on: date
    currency: Literal["GBP", "EUR", "USD"]
    amount: str
    method_description: str
    allocations: list[PaymentAllocationResponse]
    audit_events: list[PaymentAuditEventResponse]
    created_at: datetime


class LeaseReceivablesResponse(BaseModel):
    lease_id: UUID
    lease_reference: str
    currency: Literal["GBP", "EUR", "USD"]
    issued_total: str
    allocated_total: str
    outstanding_total: str
    overdue_total: str
    invoices: list[InvoiceResponse]
