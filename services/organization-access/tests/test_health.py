from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from fastapi.testclient import TestClient

from app import database
from app.main import app


def test_health_endpoint():
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "organization-access"}


def test_application_starts_and_serves_health():
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200


def test_ready_endpoint_checks_database(monkeypatch):
    test_engine = create_engine("sqlite://")
    monkeypatch.setattr(database, "engine", test_engine)

    with TestClient(app) as client:
        response = client.get("/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "organization-access"}

    test_engine.dispose()


def test_ready_endpoint_reports_unavailable_database(monkeypatch):
    class UnavailableEngine:
        def connect(self):
            raise OperationalError("SELECT 1", {}, OSError("database unavailable"))

    monkeypatch.setattr(database, "engine", UnavailableEngine())

    with TestClient(app) as client:
        health_response = client.get("/health")
        response = client.get("/ready")

    assert health_response.status_code == 200
    assert response.status_code == 503
    assert response.json() == {"detail": "Database unavailable"}


def test_ready_endpoint_reports_missing_database_configuration(monkeypatch):
    monkeypatch.setattr(database, "engine", None)

    with TestClient(app) as client:
        response = client.get("/ready")

    assert response.status_code == 503
    assert response.json() == {"detail": "Database unavailable"}