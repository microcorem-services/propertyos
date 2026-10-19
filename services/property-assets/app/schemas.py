from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.models import (
    BuildingStatus,
    PortfolioStatus,
    SiteStatus,
    UnitStatus,
)


class PortfolioResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    name: str
    status: PortfolioStatus
    created_at: datetime
    updated_at: datetime


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
