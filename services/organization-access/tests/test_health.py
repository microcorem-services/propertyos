from fastapi.testclient import TestClient

from app.main import app


def test_health_endpoint():
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "organization-access"}


def test_application_starts_and_serves_health():
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200