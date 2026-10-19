from datetime import datetime
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
