from datetime import datetime
from decimal import Decimal
from uuid import UUID

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models import (
    BuildingStatus,
    PortfolioStatus,
    SiteStatus,
    UnitStatus,
)


class PortfolioWriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=200)
    status: Literal["active", "inactive"] = "active"


class PortfolioUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=200)
    status: Literal["active", "inactive"] | None = None

    @field_validator("name", "status")
    @classmethod
    def reject_null_values(cls, value):
        if value is None:
            raise ValueError("Fields cannot be null.")
        return value

    @model_validator(mode="after")
    def require_editable_fields(self):
        if not self.model_fields_set:
            raise ValueError("At least one editable field is required.")
        return self


class SiteWriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    portfolio_id: UUID
    name: str = Field(min_length=1, max_length=200)
    address: str | None = Field(default=None, max_length=1000)
    status: Literal["active", "inactive"] = "active"


class SiteUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=200)
    address: str | None = Field(default=None, max_length=1000)
    status: Literal["active", "inactive"] | None = None

    @field_validator("name", "status")
    @classmethod
    def reject_null_values(cls, value):
        if value is None:
            raise ValueError("Fields cannot be null.")
        return value

    @model_validator(mode="after")
    def require_editable_fields(self):
        if not self.model_fields_set:
            raise ValueError("At least one editable field is required.")
        return self


class PortfolioResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    name: str
    status: PortfolioStatus
    created_at: datetime
    updated_at: datetime


class PortfolioWritePermissionsResponse(BaseModel):
    can_create: bool
    can_update: bool


class SiteWritePermissionsResponse(BaseModel):
    can_create: bool
    can_update: bool


class SiteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    portfolio_id: UUID
    name: str
    address: str | None
    status: SiteStatus
    created_at: datetime
    updated_at: datetime


class BuildingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    site_id: UUID
    name: str
    building_code: str | None
    address: str | None
    status: BuildingStatus
    created_at: datetime
    updated_at: datetime


class UnitResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    building_id: UUID
    name: str
    unit_code: str | None
    floor: str | None
    area_sqm: Decimal | None
    status: UnitStatus
    created_at: datetime
    updated_at: datetime
