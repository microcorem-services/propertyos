from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app import authorization, config
from app.authorization import get_authorization_workload_token
from app.main import app, get_portfolio_session
from app.models import Building, Site, Unit

ORGANIZATION_ID = uuid4()
ACTOR_ID = uuid4()
PORTFOLIO_ID = uuid4()
SITE_ID = uuid4()
BUILDING_ID = uuid4()
UNIT_ID = uuid4()
USER_TOKEN = "fictional.header.signature"
WORKLOAD_TOKEN = "fictional.workload.signature"
SERVICE_URL = "https://organization-access.example.test"
PORTFOLIO_READ_OPERATION = "property-assets.portfolios.read"


def valid_decision():
    return httpx.Response(
        200,
        json={
            "organization_id": str(ORGANIZATION_ID),
            "operation": PORTFOLIO_READ_OPERATION,
            "allowed": True,
            "actor_id": str(ACTOR_ID),
        },
    )


class FakeSession:
    def __init__(self):
        self.scalar_result = None
        self.scalars_result = []
        self.error = None
        self.statements = []

    def scalar(self, statement):
        self.statements.append(statement)
        if self.error is not None:
            raise self.error
        return self.scalar_result

    def scalars(self, statement):
        self.statements.append(statement)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(all=lambda: self.scalars_result)


@pytest.fixture
def assets_client(monkeypatch):
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_URL", SERVICE_URL)
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_CONNECT_TIMEOUT_SECONDS", "1.5")
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_READ_TIMEOUT_SECONDS", "2.5")
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP", False)
    session = FakeSession()

    def provide_session():
        yield session

    monkeypatch.setitem(
        app.dependency_overrides,
        get_portfolio_session,
        provide_session,
    )
    monkeypatch.setitem(
        app.dependency_overrides,
        get_authorization_workload_token,
        lambda: WORKLOAD_TOKEN,
    )
    with TestClient(app) as client:
        yield client, session


def get_request_headers():
    return {"Authorization": f"Bearer {USER_TOKEN}"}


def timestamps():
    now = datetime.now(UTC)
    return {"created_at": now, "updated_at": now}


def hierarchy_url(suffix):
    return (
        f"/api/v1/portfolios/{PORTFOLIO_ID}/sites/{SITE_ID}"
        f"{suffix}?organization_id={ORGANIZATION_ID}"
    )


def test_site_listing_is_authorized_and_returns_only_site_contract(
    monkeypatch, assets_client
):
    client, session = assets_client
    site = Site(
        id=SITE_ID,
        organization_id=ORGANIZATION_ID,
        portfolio_id=PORTFOLIO_ID,
        name="North Grounds",
        address="Example Road",
        status="active",
        **timestamps(),
    )
    session.scalar_result = PORTFOLIO_ID
    session.scalars_result = [site]
    calls = []

    def authorize(url, **kwargs):
        calls.append((url, kwargs))
        return valid_decision()

    monkeypatch.setattr(authorization.httpx, "post", authorize)
    response = client.get(
        f"/api/v1/portfolios/{PORTFOLIO_ID}/sites",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )

    assert response.status_code == 200
    assert response.json()[0] == {
        "id": str(SITE_ID),
        "organization_id": str(ORGANIZATION_ID),
        "portfolio_id": str(PORTFOLIO_ID),
        "name": "North Grounds",
        "address": "Example Road",
        "status": "active",
        "created_at": site.created_at.isoformat().replace("+00:00", "Z"),
        "updated_at": site.updated_at.isoformat().replace("+00:00", "Z"),
    }
    assert len(session.statements) == 2
    statement = str(session.statements[1])
    assert "portfolios.id = :id_1" in str(session.statements[0])
    assert "sites.portfolio_id = :portfolio_id_1" in statement
    assert "sites.organization_id = :organization_id_1" in statement
    assert calls[0][1]["json"] == {
        "organization_id": str(ORGANIZATION_ID),
        "operation": PORTFOLIO_READ_OPERATION,
    }


def test_site_detail_is_scoped_to_portfolio_and_organization(
    monkeypatch, assets_client
):
    client, session = assets_client
    session.scalar_result = Site(
        id=SITE_ID,
        organization_id=ORGANIZATION_ID,
        portfolio_id=PORTFOLIO_ID,
        name="North Grounds",
        address=None,
        status="active",
        **timestamps(),
    )
    monkeypatch.setattr(authorization.httpx, "post", lambda *a, **k: valid_decision())

    response = client.get(
        hierarchy_url(""),
        headers=get_request_headers(),
    )

    assert response.status_code == 200
    assert response.json()["id"] == str(SITE_ID)
    statement = str(session.statements[0])
    assert "sites.id = :id_1" in statement
    assert "sites.portfolio_id = :portfolio_id_1" in statement
    assert "sites.organization_id = :organization_id_1" in statement


def test_building_list_enforces_site_portfolio_and_organization(
    monkeypatch, assets_client
):
    client, session = assets_client
    building = Building(
        id=BUILDING_ID,
        organization_id=ORGANIZATION_ID,
        site_id=SITE_ID,
        name="Main House",
        building_code="MH",
        address=None,
        status="active",
        **timestamps(),
    )
    session.scalar_result = SITE_ID
    session.scalars_result = [building]
    monkeypatch.setattr(authorization.httpx, "post", lambda *a, **k: valid_decision())

    response = client.get(
        hierarchy_url("/buildings"),
        headers=get_request_headers(),
    )

    assert response.status_code == 200
    assert response.json()[0]["building_code"] == "MH"
    statement = str(session.statements[1])
    assert "JOIN sites ON buildings.site_id = sites.id" in statement
    assert "sites.portfolio_id = :portfolio_id_1" in statement
    assert "sites.id = :id_1" in statement
    assert "buildings.organization_id = :organization_id_2" in statement


def test_building_detail_returns_not_found_for_wrong_parent(monkeypatch, assets_client):
    client, session = assets_client
    session.scalar_result = None
    monkeypatch.setattr(authorization.httpx, "post", lambda *a, **k: valid_decision())

    response = client.get(
        hierarchy_url(f"/buildings/{BUILDING_ID}"),
        headers=get_request_headers(),
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Asset not found"
    statement = str(session.statements[0])
    assert "buildings.site_id = :site_id_1" in statement
    assert "sites.portfolio_id = :portfolio_id_1" in statement


def test_unit_listing_enforces_complete_parent_chain(monkeypatch, assets_client):
    client, session = assets_client
    unit = Unit(
        id=UNIT_ID,
        organization_id=ORGANIZATION_ID,
        building_id=BUILDING_ID,
        name="Suite 4",
        unit_code="S4",
        floor="4",
        area_sqm=Decimal("42.50"),
        status="active",
        **timestamps(),
    )
    session.scalar_result = BUILDING_ID
    session.scalars_result = [unit]
    monkeypatch.setattr(authorization.httpx, "post", lambda *a, **k: valid_decision())

    response = client.get(
        hierarchy_url(f"/buildings/{BUILDING_ID}/units"),
        headers=get_request_headers(),
    )

    assert response.status_code == 200
    assert response.json()[0]["area_sqm"] == "42.50"
    statement = str(session.statements[1])
    assert "JOIN buildings ON units.building_id = buildings.id" in statement
    assert "JOIN sites ON buildings.site_id = sites.id" in statement
    assert "units.building_id = :building_id_1" in statement
    assert "buildings.site_id = :site_id_1" in statement
    assert "sites.portfolio_id = :portfolio_id_1" in statement


def test_unit_detail_is_scoped_to_unit_building_site_portfolio_and_organization(
    monkeypatch, assets_client
):
    client, session = assets_client
    session.scalar_result = Unit(
        id=UNIT_ID,
        organization_id=ORGANIZATION_ID,
        building_id=BUILDING_ID,
        name="Suite 4",
        unit_code=None,
        floor=None,
        area_sqm=None,
        status="inactive",
        **timestamps(),
    )
    monkeypatch.setattr(authorization.httpx, "post", lambda *a, **k: valid_decision())

    response = client.get(
        hierarchy_url(f"/buildings/{BUILDING_ID}/units/{UNIT_ID}"),
        headers=get_request_headers(),
    )

    assert response.status_code == 200
    assert response.json()["area_sqm"] is None
    statement = str(session.statements[0])
    assert "units.id = :id_1" in statement
    assert "units.building_id = :building_id_1" in statement
    assert "buildings.site_id = :site_id_1" in statement
    assert "sites.portfolio_id = :portfolio_id_1" in statement
    assert "units.organization_id = :organization_id_1" in statement


def test_invalid_hierarchy_ids_are_rejected(assets_client, monkeypatch):
    client, session = assets_client
    monkeypatch.setattr(authorization.httpx, "post", lambda *a, **k: valid_decision())
    response = client.get(
        f"/api/v1/portfolios/not-a-uuid/sites/{SITE_ID}"
        f"?organization_id={ORGANIZATION_ID}",
        headers=get_request_headers(),
    )
    assert response.status_code == 422
    assert session.statements == []


def test_hierarchy_authorization_denial_precedes_database_access(
    monkeypatch, assets_client
):
    client, session = assets_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *a, **k: httpx.Response(403),
    )
    response = client.get(
        hierarchy_url("/buildings"),
        headers=get_request_headers(),
    )
    assert response.status_code == 403
    assert session.statements == []


def test_missing_assets_and_database_errors_are_sanitized(monkeypatch, assets_client):
    client, session = assets_client
    monkeypatch.setattr(authorization.httpx, "post", lambda *a, **k: valid_decision())
    response = client.get(
        hierarchy_url(""),
        headers=get_request_headers(),
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Asset not found"

    session.error = OperationalError(
        "SELECT sites",
        {},
        Exception("fictional database secret"),
    )
    failure = client.get(
        f"/api/v1/portfolios/{PORTFOLIO_ID}/sites"
        f"?organization_id={ORGANIZATION_ID}",
        headers=get_request_headers(),
    )
    assert failure.status_code == 503
    assert "fictional database secret" not in failure.text


def test_missing_or_out_of_scope_collection_parents_return_not_found(
    monkeypatch, assets_client
):
    client, session = assets_client
    monkeypatch.setattr(authorization.httpx, "post", lambda *a, **k: valid_decision())
    for url in [
        f"/api/v1/portfolios/{PORTFOLIO_ID}/sites?organization_id={ORGANIZATION_ID}",
        hierarchy_url("/buildings"),
        hierarchy_url(f"/buildings/{BUILDING_ID}/units"),
    ]:
        session.scalar_result = None
        session.statements.clear()
        response = client.get(url, headers=get_request_headers())
        assert response.status_code == 404
        assert response.json()["detail"] == "Asset not found"
        assert len(session.statements) == 1
