from sqlalchemy import func, select

from app.database import SessionLocal
from app.models import Property


DEMO_PROPERTIES = [
    {
        "name": "Riverside House",
        "location": "Oxford",
        "units": 18,
        "occupied": 16,
        "status": "Operational",
    },
    {
        "name": "Westgate Offices",
        "location": "Reading",
        "units": 12,
        "occupied": 10,
        "status": "Operational",
    },
    {
        "name": "Market Square",
        "location": "Abingdon",
        "units": 8,
        "occupied": 5,
        "status": "Review",
    },
]


def seed_demo_properties() -> int:
    with SessionLocal() as session:
        existing = session.scalar(select(func.count()).select_from(Property))
        if existing:
            return 0
        session.add_all(Property(**property_data) for property_data in DEMO_PROPERTIES)
        session.commit()
        return len(DEMO_PROPERTIES)


if __name__ == "__main__":
    inserted = seed_demo_properties()
    print(f"Inserted {inserted} fictional demo properties." if inserted else "No changes; properties already exist.")