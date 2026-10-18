from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Property
from app.schemas import DashboardStats, PropertyCreate, PropertyRead, PropertyUpdate

app = FastAPI(title="PropertyOS API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
def health():
    return {"status": "ok", "service": "propertyos-api"}


@app.get("/properties", response_model=list[PropertyRead])
def list_properties(db: Session = Depends(get_db)):
    return db.scalars(select(Property).order_by(Property.name)).all()


@app.post("/properties", response_model=PropertyRead, status_code=201)
def create_property(payload: PropertyCreate, db: Session = Depends(get_db)):
    property_record = Property(**payload.model_dump())
    db.add(property_record)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="Property could not be saved") from error
    db.refresh(property_record)
    return property_record


@app.get("/properties/{property_id}", response_model=PropertyRead)
def get_property(property_id: str, db: Session = Depends(get_db)):
    property_record = db.get(Property, property_id)
    if property_record is None:
        raise HTTPException(status_code=404, detail="Property not found")
    return property_record


@app.put("/properties/{property_id}", response_model=PropertyRead)
def update_property(property_id: str, payload: PropertyUpdate, db: Session = Depends(get_db)):
    property_record = db.get(Property, property_id)
    if property_record is None:
        raise HTTPException(status_code=404, detail="Property not found")
    for field, value in payload.model_dump().items():
        setattr(property_record, field, value)
    db.commit()
    db.refresh(property_record)
    return property_record


@app.delete("/properties/{property_id}", status_code=204)
def delete_property(property_id: str, db: Session = Depends(get_db)):
    property_record = db.get(Property, property_id)
    if property_record is None:
        raise HTTPException(status_code=404, detail="Property not found")
    db.delete(property_record)
    db.commit()
    return Response(status_code=204)


@app.get("/dashboard/stats", response_model=DashboardStats)
def dashboard_stats(db: Session = Depends(get_db)):
    property_count, total_units, occupied_units = db.execute(
        select(
            func.count(Property.id),
            func.coalesce(func.sum(Property.units), 0),
            func.coalesce(func.sum(Property.occupied), 0),
        )
    ).one()
    occupancy_percent = round(occupied_units / total_units * 100) if total_units else 0
    return DashboardStats(
        properties=property_count,
        total_units=total_units,
        occupied_units=occupied_units,
        occupancy_percent=occupancy_percent,
    )
