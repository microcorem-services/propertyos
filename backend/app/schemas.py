from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


PropertyStatus = Literal["Operational", "Review", "Maintenance"]


class PropertyFields(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    location: str = Field(min_length=1, max_length=120)
    units: int = Field(ge=1, le=100000)
    occupied: int = Field(ge=0, le=100000)
    status: PropertyStatus = "Operational"

    @field_validator("name", "location")
    @classmethod
    def trim_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Must not be blank")
        return value

    @model_validator(mode="after")
    def occupancy_must_fit_units(self):
        if self.occupied > self.units:
            raise ValueError("Occupied units cannot exceed total units")
        return self


class PropertyCreate(PropertyFields):
    pass


class PropertyUpdate(PropertyFields):
    pass


class PropertyRead(PropertyFields):
    model_config = ConfigDict(from_attributes=True)

    id: str


class DashboardStats(BaseModel):
    properties: int
    total_units: int
    occupied_units: int
    occupancy_percent: int