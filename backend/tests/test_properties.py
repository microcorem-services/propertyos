import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app


@pytest.fixture
def client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)

    def override_get_db():
        with TestingSession() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)
    engine.dispose()


def test_property_crud_and_dashboard_stats(client):
    assert client.get("/properties").json() == []
    assert client.get("/dashboard/stats").json() == {
        "properties": 0,
        "total_units": 0,
        "occupied_units": 0,
        "occupancy_percent": 0,
    }

    created = client.post(
        "/properties",
        json={
            "name": "Riverside House",
            "location": "Oxford",
            "units": 10,
            "occupied": 7,
            "status": "Operational",
        },
    )
    assert created.status_code == 201
    property_id = created.json()["id"]
    assert client.get(f"/properties/{property_id}").json()["name"] == "Riverside House"
    assert client.get("/dashboard/stats").json() == {
        "properties": 1,
        "total_units": 10,
        "occupied_units": 7,
        "occupancy_percent": 70,
    }

    updated = client.put(
        f"/properties/{property_id}",
        json={
            "name": "Riverside House",
            "location": "Oxford",
            "units": 12,
            "occupied": 11,
            "status": "Review",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "Review"
    assert client.get("/dashboard/stats").json()["occupancy_percent"] == 92

    assert client.delete(f"/properties/{property_id}").status_code == 204
    assert client.get(f"/properties/{property_id}").status_code == 404
    assert client.get("/dashboard/stats").json()["properties"] == 0


@pytest.mark.parametrize(
    "overrides",
    [
        {"name": "   "},
        {"location": "   "},
        {"units": 0},
        {"occupied": -1},
        {"occupied": 5},
        {"status": "Unknown"},
    ],
)
def test_invalid_property_data_is_rejected(client, overrides):
    payload = {
        "name": "Westgate Offices",
        "location": "Reading",
        "units": 4,
        "occupied": 3,
        "status": "Operational",
    }
    payload.update(overrides)
    assert client.post("/properties", json=payload).status_code == 422


def test_missing_property_returns_not_found(client):
    assert client.get("/properties/missing").status_code == 404
    assert client.put(
        "/properties/missing",
        json={
            "name": "Market Square",
            "location": "Abingdon",
            "units": 8,
            "occupied": 5,
            "status": "Review",
        },
    ).status_code == 404
    assert client.delete("/properties/missing").status_code == 404