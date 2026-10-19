from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.models import PortfolioStatus


class PortfolioResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    name: str
    status: PortfolioStatus
    created_at: datetime
    updated_at: datetime
