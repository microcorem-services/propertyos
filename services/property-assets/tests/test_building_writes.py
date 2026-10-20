from contextlib import contextmanager
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app import authorization, config
from app.authorization import get_authorization_workload_token
from app.main import app, get_portfolio_session
from app.models import (
    Building,
    BuildingAuditEvent,
    Portfolio,
    Site,
)

ORGANIZATION_ID = uuid4()
OTHER_ORGANIZATION_ID = uuid4()
ACTOR_ID = uuid4()
PORTFOLIO_ID = uuid4()
SITE_ID = uuid4()
BUILDING_ID = uuid4()
USER_TOKEN = "fictional.header.signature"
WORKLOAD_TOKEN = "fictional.workload.signature"
SERVICE_URL = "https://organization-access.example.test"


class FakeSession:
    def __init__(self, portfolios, sites, buildings=None, fail_on_flush=None):
        self.portfolios = list(portfolios)
        self.sites = list(sites)
        self.buildings = list(buildings or [])
        self.audit_events = []
        self.fail_on_flush = fail_on_flush
        self.flush_count = 0
        self.pending = []

    @contextmanager
    def begin(self):
        building_values = [
            (
                building,
                building.name,
                building.building_code,
                building.address,
                building.status,
                building.updated_at,
            )
            for building in self.buildings
        ]
        building_count = len(self.buildings)
        audit_count = len(self.audit_events)
        pending = list(self.pending)
        try:
            yield self
        except Exception:
            for building, name, code, address, status, updated_at in building_values:
                building.name = name
                building.building_code = code
                building.address = address
                building.status = status
                building.updated_at = updated_at
            del self.buildings[building_count:]
            del self.audit_events[audit_count:]
            self.pending = pending
            raise
        else:
            self.pending.clear()

    def add(self, entity):
        self.pending.append(entity)

    def flush(self):
        self.flush_count += 1
        if self.fail_on_flush == self.flush_count:
            raise OperationalError(
                "INSERT building audit",
                {},
                Exception("fictional database detail"),
            )
        current_time = datetime.now(UTC)
        for entity in list(self.pending):
            if isinstance(entity, Building):
                entity.id = entity.id or uuid4()
                entity.created_at = entity.created_at or current_time
                entity.updated_at = entity.updated_at or current_time
                if entity not in self.buildings:
                    self.buildings.append(entity)
            elif isinstance(entity, BuildingAuditEvent):
                entity.id = entity.id or uuid4()
                entity.occurred_at = entity.occurred_at or current_time
                self.audit_events.append(entity)
            self.pending.remove(entity)

    def scalar(self, statement):
        params = set(statement.compile().params.values())
        statement_text = str(statement)
        if "FROM buildings JOIN sites" in statement_text:
            return next(
                (
                    building
                    for building in self.buildings
                    if building.id in params
                    and building.site_id in params
                    and building.organization_id in params
                    and any(
                        site.id == building.site_id
                        and site.organization_id == building.organization_id
                        and site.portfolio_id in params
                        for site in self.sites
                    )
                ),
                None,
            )
        return next(
            (
                site.id
                for site in self.sites
                if site.id in params
                and site.portfolio_id in params
                and site.organization_id in params
                and any(
                    portfolio.id == site.portfolio_id
                    and portfolio.organization_id == site.organization_id
                    for portfolio in self.portfolios
                )
            ),
            None,
        )


def make_client(monkeypatch, *, building=None, fail_on_flush=None):
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_URL", SERVICE_URL)
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_CONNECT_TIMEOUT_SECONDS", "1.5")
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_READ_TIMEOUT_SECONDS", "2.5")
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP", False)
    portfolio = Portfolio(
        id=PORTFOLIO_ID,
        organization_id=ORGANIZATION_ID,
        name="Fictional Estate",
        status="active",
    )
    site = Site(
        id=SITE_ID,
        organization_id=ORGANIZATION_ID,
        portfolio_id=PORTFOLIO_ID,
        name="Fictional Site",
        status="active",
    )
    session = FakeSession(
        portfolios=[portfolio],
        sites=[site],
        buildings=[building] if building else [],
        fail_on_flush=fail_on_flush,
    )

    def provide_session():
        yield session

    monkeypatch.setitem(app.dependency_overrides, get_portfolio_session, provide_session)
    monkeypatch.setitem(
        app.dependency_overrides,
        get_authorization_workload_token,
        lambda: WORKLOAD_TOKEN,
    )
    client = TestClient(app)
    return client, session


@pytest.fixture(autouse=True)
def clear_dependency_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def valid_decision(operation, *, allowed=True):
    return httpx.Response(
        200,
        json={
            "organization_id": str(ORGANIZATION_ID),
            "operation": operation,
            "allowed": allowed,
            "actor_id": str(ACTOR_ID),
        },
    )


def request_headers():
    return {"Authorization": "Bearer " + USER_TOKEN}


def existing_building():
    timestamp = datetime.now(UTC)
    return Building(
        id=BUILDING_ID,
        organization_id=ORGANIZATION_ID,
        site_id=SITE_ID,
        name="North House",
        building_code="NH-1",
        address="Fictional Lane",
        status="active",
        created_at=timestamp,
        updated_at=timestamp,
    )


def test_authorized_building_creation_audits_actor_and_editable_fields(monkeypatch):
    client, session = make_client(monkeypatch)
    requested = []
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: (
            requested.append(kwargs["json"]["operation"])
            or valid_decision(kwargs["json"]["operation"])
        ),
    )
    response = client.post(
        "/api/v1/buildings",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
            "name": "  North House  ",
            "building_code": " NH-1 ",
            "address": "Fictional Lane",
        },
    )
    assert response.status_code == 201
    assert response.json()["name"] == "North House"
    assert response.json()["site_id"] == str(SITE_ID)
    assert requested == ["property-assets.buildings.create"]
    assert len(session.buildings) == len(session.audit_events) == 1
    event = session.audit_events[0]
    assert event.organization_id == ORGANIZATION_ID
    assert event.building_id == session.buildings[0].id
    assert event.operation == "property-assets.buildings.create"
    assert event.actor_id == ACTOR_ID
    assert event.changed_fields == ["address", "building_code", "name", "status"]


def test_creation_rejects_a_site_outside_parent_portfolio(monkeypatch):
    client, session = make_client(monkeypatch)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    response = client.post(
        "/api/v1/buildings",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={
            "portfolio_id": str(uuid4()),
            "site_id": str(SITE_ID),
            "name": "Not created",
        },
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "Asset not found"}
    assert session.buildings == []
    assert session.audit_events == []


def test_creation_rejects_a_site_owned_by_another_organization(monkeypatch):
    client, session = make_client(monkeypatch)
    session.sites[0].organization_id = OTHER_ORGANIZATION_ID
    session.portfolios[0].organization_id = OTHER_ORGANIZATION_ID
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    response = client.post(
        "/api/v1/buildings",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
            "name": "Not created",
        },
    )
    assert response.status_code == 404
    assert session.buildings == []
    assert session.audit_events == []


def test_read_only_member_is_denied_building_write(monkeypatch):
    client, session = make_client(monkeypatch)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: httpx.Response(403),
    )
    response = client.post(
        "/api/v1/buildings",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
            "name": "Not created",
        },
    )
    assert response.status_code == 403
    assert session.buildings == []
    assert session.audit_events == []


def test_building_update_is_parent_scoped_and_audited(monkeypatch):
    building = existing_building()
    client, session = make_client(monkeypatch, building=building)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    response = client.patch(
        f"/api/v1/buildings/{BUILDING_ID}",
        params={
            "organization_id": str(ORGANIZATION_ID),
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
        },
        headers=request_headers(),
        json={"address": None, "name": "North House East"},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "North House East"
    assert response.json()["address"] is None
    assert building.site_id == SITE_ID
    assert len(session.audit_events) == 1
    assert session.audit_events[0].changed_fields == ["address", "name"]


@pytest.mark.parametrize(
    "protected_fields",
    [
        {"organization_id": str(OTHER_ORGANIZATION_ID)},
        {"site_id": str(uuid4())},
        {"id": str(uuid4())},
        {"created_at": "2026-01-01T00:00:00Z"},
    ],
)
def test_building_update_rejects_protected_fields(monkeypatch, protected_fields):
    client, session = make_client(monkeypatch, building=existing_building())
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    response = client.patch(
        f"/api/v1/buildings/{BUILDING_ID}",
        params={
            "organization_id": str(ORGANIZATION_ID),
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
        },
        headers=request_headers(),
        json=protected_fields,
    )
    assert response.status_code == 422
    assert session.audit_events == []


def test_update_rejects_mismatched_site_and_invalid_identifier(monkeypatch):
    client, session = make_client(monkeypatch, building=existing_building())
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    wrong_parent = client.patch(
        f"/api/v1/buildings/{BUILDING_ID}",
        params={
            "organization_id": str(ORGANIZATION_ID),
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(uuid4()),
        },
        headers=request_headers(),
        json={"name": "Should not update"},
    )
    wrong_portfolio = client.patch(
        f"/api/v1/buildings/{BUILDING_ID}",
        params={
            "organization_id": str(ORGANIZATION_ID),
            "portfolio_id": str(uuid4()),
            "site_id": str(SITE_ID),
        },
        headers=request_headers(),
        json={"name": "Should not update"},
    )
    invalid_id = client.patch(
        "/api/v1/buildings/not-a-uuid",
        params={
            "organization_id": str(ORGANIZATION_ID),
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
        },
        headers=request_headers(),
        json={"name": "Should not update"},
    )
    assert wrong_parent.status_code == 404
    assert wrong_portfolio.status_code == 404
    assert invalid_id.status_code == 422
    assert building_value(session, "name") == "North House"
    assert session.audit_events == []


def test_update_hides_a_building_owned_by_another_organization(monkeypatch):
    foreign_building = existing_building()
    foreign_building.organization_id = OTHER_ORGANIZATION_ID
    client, session = make_client(monkeypatch, building=foreign_building)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    response = client.patch(
        f"/api/v1/buildings/{BUILDING_ID}",
        params={
            "organization_id": str(ORGANIZATION_ID),
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
        },
        headers=request_headers(),
        json={"name": "Should not update"},
    )
    assert response.status_code == 404
    assert foreign_building.name == "North House"
    assert session.audit_events == []


def test_audit_failure_rolls_back_building_creation(monkeypatch):
    client, session = make_client(monkeypatch, fail_on_flush=2)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    response = client.post(
        "/api/v1/buildings",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
            "name": "Rollback House",
        },
    )
    assert response.status_code == 503
    assert session.buildings == []
    assert session.audit_events == []
    assert "fictional database detail" not in response.text


def test_audit_failure_rolls_back_building_update(monkeypatch):
    building = existing_building()
    client, session = make_client(
        monkeypatch,
        building=building,
        fail_on_flush=1,
    )
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    response = client.patch(
        f"/api/v1/buildings/{BUILDING_ID}",
        params={
            "organization_id": str(ORGANIZATION_ID),
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
        },
        headers=request_headers(),
        json={"name": "Transaction must roll back"},
    )
    assert response.status_code == 503
    assert building.name == "North House"
    assert session.audit_events == []
    assert "fictional database detail" not in response.text


def building_value(session, field):
    return getattr(session.buildings[0], field)
