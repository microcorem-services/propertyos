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
    event_type: Literal["created", "updated"]
    changed_fields: list[str]
    occurred_at: datetime


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
