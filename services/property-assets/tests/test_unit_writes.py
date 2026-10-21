from contextlib import contextmanager
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
from app.authorization import get_authorization_workload_token
from app.main import app, get_portfolio_session
from app.models import (
    Building,
    Portfolio,
    Site,
    Unit,
    UnitAuditEvent,
)
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app import authorization, config
from app import main as property_main

ORGANIZATION_ID = uuid4()
OTHER_ORGANIZATION_ID = uuid4()
ACTOR_ID = uuid4()
PORTFOLIO_ID = uuid4()
SITE_ID = uuid4()
BUILDING_ID = uuid4()
UNIT_ID = uuid4()
USER_TOKEN = "fictional.header.signature"
WORKLOAD_TOKEN = "fictional.workload.signature"
SERVICE_URL = "https://organization-access.example.test"


class FakeSession:
    def __init__(self, portfolio, site, building, unit=None, fail_on_flush=None):
        self.portfolio = portfolio
        self.site = site
        self.building = building
        self.units = [unit] if unit else []
        self.audit_events = []
        self.pending = []
        self.fail_on_flush = fail_on_flush
        self.flush_count = 0

    @contextmanager
    def begin(self):
        unit_values = [
            (
                unit,
                unit.name,
                unit.unit_code,
                unit.floor,
                unit.area_sqm,
                unit.status,
                unit.updated_at,
            )
            for unit in self.units
        ]
        unit_count = len(self.units)
        audit_count = len(self.audit_events)
        pending = list(self.pending)
        try:
            yield self
        except Exception:
            for unit, name, code, floor, area, status, updated_at in unit_values:
                unit.name = name
                unit.unit_code = code
                unit.floor = floor
                unit.area_sqm = area
                unit.status = status
                unit.updated_at = updated_at
            del self.units[unit_count:]
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
                "INSERT unit audit", {}, Exception("fictional database detail")
            )
        now = datetime.now(UTC)
        for entity in list(self.pending):
            if isinstance(entity, Unit):
                entity.id = entity.id or uuid4()
                entity.created_at = entity.created_at or now
                entity.updated_at = entity.updated_at or now
                if entity not in self.units:
                    self.units.append(entity)
            elif isinstance(entity, UnitAuditEvent):
                entity.id = entity.id or uuid4()
                entity.occurred_at = entity.occurred_at or now
                self.audit_events.append(entity)
            self.pending.remove(entity)

    def scalar(self, statement):
        params = set(statement.compile().params.values())
        statement_text = str(statement)
        if "FROM units JOIN buildings" in statement_text:
            return next(
                (
                    unit
                    for unit in self.units
                    if unit.id in params
                    and unit.building_id == self.building.id
                    and unit.organization_id == ORGANIZATION_ID
                    and self.building.id in params
                    and self.building.site_id == self.site.id
                    and self.site.portfolio_id in params
                    and self.site.organization_id == self.portfolio.organization_id
                    and self.site.organization_id == ORGANIZATION_ID
                ),
                None,
            )
        return next(
            (
                self.building.id
                for _ in [None]
                if self.building.id in params
                and self.building.site_id == self.site.id
                and self.site.id in params
                and self.site.portfolio_id == self.portfolio.id
                and self.portfolio.id in params
                and self.portfolio.organization_id == ORGANIZATION_ID
                and self.site.organization_id == ORGANIZATION_ID
                and self.building.organization_id == ORGANIZATION_ID
            ),
            None,
        )


def make_client(monkeypatch, *, unit=None, fail_on_flush=None):
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
    building = Building(
        id=BUILDING_ID,
        organization_id=ORGANIZATION_ID,
        site_id=SITE_ID,
        name="Fictional Building",
        status="active",
    )
    session = FakeSession(portfolio, site, building, unit, fail_on_flush)

    def provide_session():
        yield session

    monkeypatch.setitem(app.dependency_overrides, get_portfolio_session, provide_session)
    monkeypatch.setitem(
        app.dependency_overrides,
        get_authorization_workload_token,
        lambda: WORKLOAD_TOKEN,
    )
    return TestClient(app), session


@pytest.fixture(autouse=True)
def clear_dependency_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def valid_decision(operation):
    return httpx.Response(
        200,
        json={
            "organization_id": str(ORGANIZATION_ID),
            "operation": operation,
            "allowed": True,
            "actor_id": str(ACTOR_ID),
        },
    )


def request_headers():
    return {"Authorization": f"Bearer {USER_TOKEN}"}


def existing_unit():
    now = datetime.now(UTC)
    return Unit(
        id=UNIT_ID,
        organization_id=ORGANIZATION_ID,
        building_id=BUILDING_ID,
        name="Suite 4",
        unit_code="S-4",
        floor="4",
        area_sqm=Decimal("75.50"),
        status="active",
        created_at=now,
        updated_at=now,
    )


def parent_params():
    return {
        "organization_id": str(ORGANIZATION_ID),
        "portfolio_id": str(PORTFOLIO_ID),
        "site_id": str(SITE_ID),
        "building_id": str(BUILDING_ID),
    }


def test_authorized_unit_creation_writes_audit_with_actor(monkeypatch):
    client, session = make_client(monkeypatch)
    requested = []
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: requested.append(kwargs["json"]["operation"])
        or valid_decision(kwargs["json"]["operation"]),
    )
    response = client.post(
        "/api/v1/units",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
            "building_id": str(BUILDING_ID),
            "name": " Suite 4 ",
            "unit_code": " S-4 ",
            "floor": "4",
            "area_sqm": "75.50",
        },
    )
    assert response.status_code == 201
    assert response.json()["name"] == "Suite 4"
    assert response.json()["building_id"] == str(BUILDING_ID)
    assert requested == ["property-assets.units.create"]
    assert len(session.units) == len(session.audit_events) == 1
    event = session.audit_events[0]
    assert event.organization_id == ORGANIZATION_ID
    assert event.unit_id == session.units[0].id
    assert event.operation == "property-assets.units.create"
    assert event.actor_id == ACTOR_ID
    assert event.changed_fields == [
        "area_sqm",
        "floor",
        "name",
        "status",
        "unit_code",
    ]


def test_unit_update_is_scoped_and_audited(monkeypatch):
    unit = existing_unit()
    client, session = make_client(monkeypatch, unit=unit)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    response = client.patch(
        f"/api/v1/units/{UNIT_ID}",
        params=parent_params(),
        headers=request_headers(),
        json={"name": "Suite 4 East", "area_sqm": None},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Suite 4 East"
    assert unit.area_sqm is None
    assert len(session.audit_events) == 1
    assert session.audit_events[0].changed_fields == ["area_sqm", "name"]
    assert session.audit_events[0].operation == "property-assets.units.update"


def test_referenced_unit_cannot_be_deactivated(monkeypatch):
    unit = existing_unit()
    client, session = make_client(monkeypatch, unit=unit)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    retirement_checks = []

    def referenced(*args):
        retirement_checks.append(args)
        raise authorization.UnitHasActiveLease

    monkeypatch.setattr(
        property_main,
        "ensure_unit_can_be_deactivated",
        referenced,
    )

    response = client.patch(
        f"/api/v1/units/{UNIT_ID}",
        params=parent_params(),
        headers=request_headers(),
        json={"status": "inactive"},
    )

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == (
        "Unit is referenced by a lease and cannot be deactivated"
    )
    assert unit.status == "active"
    assert session.audit_events == []
    assert retirement_checks == [
        (ORGANIZATION_ID, UNIT_ID, USER_TOKEN, WORKLOAD_TOKEN)
    ]


def test_unreferenced_unit_can_be_deactivated_and_audited(monkeypatch):
    unit = existing_unit()
    client, session = make_client(monkeypatch, unit=unit)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    checked = []
    monkeypatch.setattr(
        property_main,
        "ensure_unit_can_be_deactivated",
        lambda *args: checked.append(args),
    )

    response = client.patch(
        f"/api/v1/units/{UNIT_ID}",
        params=parent_params(),
        headers=request_headers(),
        json={"status": "inactive"},
    )

    assert response.status_code == 200
    assert unit.status == "inactive"
    assert checked == [(ORGANIZATION_ID, UNIT_ID, USER_TOKEN, WORKLOAD_TOKEN)]
    assert session.audit_events[0].changed_fields == ["status"]


def test_lease_management_outage_blocks_unit_deactivation(monkeypatch):
    unit = existing_unit()
    client, session = make_client(monkeypatch, unit=unit)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    monkeypatch.setattr(
        property_main,
        "ensure_unit_can_be_deactivated",
        lambda *_args: (_ for _ in ()).throw(
            authorization.LeaseManagementDependencyUnavailable
        ),
    )

    response = client.patch(
        f"/api/v1/units/{UNIT_ID}",
        params=parent_params(),
        headers=request_headers(),
        json={"status": "inactive"},
    )

    assert response.status_code == 503, response.text
    assert response.json()["detail"] == "Lease Management service unavailable"
    assert unit.status == "active"
    assert session.audit_events == []


def test_retirement_check_client_sends_both_credentials_and_validates_result(
    monkeypatch,
):
    monkeypatch.setattr(
        config, "LEASE_MANAGEMENT_URL", "https://lease-management.example.test"
    )
    responses = []

    def available(url, **kwargs):
        responses.append((url, kwargs))
        return httpx.Response(
            200,
            json={
                "organization_id": str(ORGANIZATION_ID),
                "unit_id": str(UNIT_ID),
                "referenced": False,
            },
        )

    monkeypatch.setattr(authorization.httpx, "get", available)
    authorization.ensure_unit_can_be_deactivated(
        ORGANIZATION_ID, UNIT_ID, USER_TOKEN, WORKLOAD_TOKEN
    )
    url, kwargs = responses[0]
    assert url.endswith(
        f"/internal/v1/organizations/{ORGANIZATION_ID}/units/{UNIT_ID}/retirement-check"
    )
    assert kwargs["params"] == {"organization_id": str(ORGANIZATION_ID)}
    assert kwargs["headers"]["Authorization"] == f"Bearer {USER_TOKEN}"
    assert kwargs["headers"]["X-Service-Authorization"] == (
        f"Bearer {WORKLOAD_TOKEN}"
    )
    assert kwargs["follow_redirects"] is False


def test_retirement_check_client_fails_closed_on_wrong_identity_or_service_error(
    monkeypatch,
):
    monkeypatch.setattr(
        config, "LEASE_MANAGEMENT_URL", "https://lease-management.example.test"
    )
    monkeypatch.setattr(
        authorization.httpx,
        "get",
        lambda *_args, **_kwargs: httpx.Response(
            200,
            json={
                "organization_id": str(OTHER_ORGANIZATION_ID),
                "unit_id": str(UNIT_ID),
                "referenced": False,
            },
        ),
    )
    with pytest.raises(authorization.LeaseManagementDependencyUnavailable):
        authorization.ensure_unit_can_be_deactivated(
            ORGANIZATION_ID, UNIT_ID, USER_TOKEN, WORKLOAD_TOKEN
        )

    monkeypatch.setattr(
        authorization.httpx,
        "get",
        lambda *_args, **_kwargs: httpx.Response(
            200,
            json={
                "organization_id": str(ORGANIZATION_ID),
                "unit_id": str(UNIT_ID),
                "referenced": True,
            },
        ),
    )
    with pytest.raises(authorization.UnitHasActiveLease):
        authorization.ensure_unit_can_be_deactivated(
            ORGANIZATION_ID, UNIT_ID, USER_TOKEN, WORKLOAD_TOKEN
        )

    monkeypatch.setattr(
        authorization.httpx,
        "get",
        lambda *_args, **_kwargs: httpx.Response(503),
    )
    with pytest.raises(authorization.LeaseManagementDependencyUnavailable):
        authorization.ensure_unit_can_be_deactivated(
            ORGANIZATION_ID, UNIT_ID, USER_TOKEN, WORKLOAD_TOKEN
        )


def test_unit_writes_reject_denial_wrong_parent_and_protected_fields(monkeypatch):
    client, session = make_client(monkeypatch)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: httpx.Response(403),
    )
    payload = {
        "portfolio_id": str(PORTFOLIO_ID),
        "site_id": str(SITE_ID),
        "building_id": str(BUILDING_ID),
        "name": "No write",
    }
    denied = client.post(
        "/api/v1/units",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json=payload,
    )
    assert denied.status_code == 403
    assert session.units == session.audit_events == []

    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    wrong_parent = client.post(
        "/api/v1/units",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={**payload, "portfolio_id": str(uuid4())},
    )
    assert wrong_parent.status_code == 404
    protected = client.post(
        "/api/v1/units",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={**payload, "organization_id": str(OTHER_ORGANIZATION_ID)},
    )
    malformed = client.patch(
        f"/api/v1/units/{UNIT_ID}",
        params=parent_params(),
        headers=request_headers(),
        json={"area_sqm": 0},
    )
    invalid_id = client.patch(
        "/api/v1/units/not-a-uuid",
        params=parent_params(),
        headers=request_headers(),
        json={"name": "Invalid"},
    )
    assert protected.status_code == 422
    assert malformed.status_code == 422
    assert invalid_id.status_code == 422
    assert session.units == session.audit_events == []


def test_unit_write_cannot_cross_organization_or_parent_building(monkeypatch):
    client, session = make_client(monkeypatch)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    unit_payload = {
        "portfolio_id": str(PORTFOLIO_ID),
        "site_id": str(SITE_ID),
        "building_id": str(BUILDING_ID),
        "name": "Not created",
    }
    session.building.organization_id = OTHER_ORGANIZATION_ID
    cross_org_create = client.post(
        "/api/v1/units",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json=unit_payload,
    )
    session.building.organization_id = ORGANIZATION_ID
    session.site.portfolio_id = uuid4()
    wrong_hierarchy = client.post(
        "/api/v1/units",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json=unit_payload,
    )
    session.site.portfolio_id = PORTFOLIO_ID
    session.units.append(
        Unit(
            id=UNIT_ID,
            organization_id=OTHER_ORGANIZATION_ID,
            building_id=BUILDING_ID,
            name="Other organisation unit",
            status="active",
        )
    )
    cross_org_update = client.patch(
        f"/api/v1/units/{UNIT_ID}",
        params=parent_params(),
        headers=request_headers(),
        json={"name": "Must stay hidden"},
    )
    assert cross_org_create.status_code == 404
    assert wrong_hierarchy.status_code == 404
    assert cross_org_update.status_code == 404
    assert session.audit_events == []


def test_missing_unit_and_unavailable_authorization_fail_closed(monkeypatch):
    client, session = make_client(monkeypatch)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    missing = client.patch(
        f"/api/v1/units/{UNIT_ID}",
        params=parent_params(),
        headers=request_headers(),
        json={"name": "Not present"},
    )
    assert missing.status_code == 404

    def unavailable_authorization(url, **kwargs):
        raise httpx.ConnectError("fictional authorization outage")

    monkeypatch.setattr(authorization.httpx, "post", unavailable_authorization)
    unavailable = client.post(
        "/api/v1/units",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
            "building_id": str(BUILDING_ID),
            "name": "Not authorized",
        },
    )
    assert unavailable.status_code == 503
    assert "fictional authorization outage" not in unavailable.text
    assert session.units == session.audit_events == []


def test_unit_audit_failure_rolls_back_the_mutation(monkeypatch):
    client, session = make_client(monkeypatch, fail_on_flush=2)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    response = client.post(
        "/api/v1/units",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={
            "portfolio_id": str(PORTFOLIO_ID),
            "site_id": str(SITE_ID),
            "building_id": str(BUILDING_ID),
            "name": "Rolled back",
        },
    )
    assert response.status_code == 503
    assert session.units == session.audit_events == []
