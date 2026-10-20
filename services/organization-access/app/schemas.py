from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.models import MembershipRole, MembershipStatus, OrganizationStatus


class APIResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class OrganizationResponse(APIResponse):
    id: UUID
    name: str
    status: OrganizationStatus
    created_at: datetime
    updated_at: datetime


class OrganizationChooserItemResponse(APIResponse):
    id: UUID
    name: str


class OrganizationChooserPageResponse(APIResponse):
    organizations: list[OrganizationChooserItemResponse]
    next_cursor: str | None


class UserResponse(APIResponse):
    id: UUID
    external_subject: str
    created_at: datetime


class MembershipResponse(APIResponse):
    id: UUID
    organization_id: UUID
    user_id: UUID
    role: MembershipRole
    status: MembershipStatus
    created_at: datetime


class APIErrorDetail(BaseModel):
    code: str
    message: str


class APIErrorResponse(BaseModel):
    error: APIErrorDetail


class InternalAuthorizationDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    organization_id: UUID
    operation: Literal[
        "property-assets.portfolios.read",
        "property-assets.portfolios.create",
        "property-assets.portfolios.update",
        "property-assets.sites.create",
        "property-assets.sites.update",
        "property-assets.buildings.create",
        "property-assets.buildings.update",
        "property-assets.units.create",
        "property-assets.units.update",
    ]


class InternalAuthorizationDecisionResponse(BaseModel):
    organization_id: UUID
    operation: Literal[
        "property-assets.portfolios.read",
        "property-assets.portfolios.create",
        "property-assets.portfolios.update",
        "property-assets.sites.create",
        "property-assets.sites.update",
        "property-assets.buildings.create",
        "property-assets.buildings.update",
        "property-assets.units.create",
        "property-assets.units.update",
    ]
    allowed: Literal[True]
    actor_id: UUID
