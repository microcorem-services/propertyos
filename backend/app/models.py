from uuid import uuid4

from sqlalchemy import CheckConstraint, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Property(Base):
    __tablename__ = "properties"
    __table_args__ = (
        CheckConstraint("units > 0", name="ck_properties_units_positive"),
        CheckConstraint("occupied >= 0 AND occupied <= units", name="ck_properties_occupancy"),
        CheckConstraint(
            "status IN ('Operational', 'Review', 'Maintenance')",
            name="ck_properties_status",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    location: Mapped[str] = mapped_column(String(120), nullable=False)
    units: Mapped[int] = mapped_column(Integer, nullable=False)
    occupied: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)