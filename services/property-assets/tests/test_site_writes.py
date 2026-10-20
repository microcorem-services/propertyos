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
from app.models import Portfolio, Site, SiteAuditEvent

ORGANIZATION_ID = uuid4()
OTHER_ORGANIZATION_ID = uuid4()
ACTOR_ID = uuid4()
PORTFOLIO_ID = uuid4()
SITE_ID = uuid4()
USER_TOKEN = "fictional.header.signature"
WORKLOAD_TOKEN = "fictional.workload.signature"
SERVICE_URL = "https://organization-access.example.test"


class FakeSession:
    def __init__(self, portfolios=None, sites=None, fail_on_flush=None):
        self.portfolios = list(portfolios or [])
        self.sites = list(sites or [])
        self.audit_events = []
        self.statements = []
        self.fail_on_flush = fail_on_flush
        self.flush_count = 0
        self.pending = []

    @contextmanager
    def begin(self):
        site_values = [
            (site, site.name, site.address, site.status, site.updated_at)
            for site in self.sites
        ]
        site_count = len(self.sites)
        audit_count = len(self.audit_events)
        pending = list(self.pending)
        try:
            yield self
        except Exception:
            for site, name, address, status, updated_at in site_values:
                site.name = name
                site.address = address
                site.status = status
                site.updated_at = updated_at
            del self.sites[site_count:]
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
                "INSERT site audit",
                {},
                Exception("fictional database detail"),
            )
        now = datetime.now(UTC)
        for entity in list(self.pending):
            if isinstance(entity, Site):
                entity.id = entity.id or uuid4()
                entity.created_at = entity.created_at or now
                entity.updated_at = entity.updated_at or now
                if entity not in self.sites:
                    self.sites.append(entity)
            elif isinstance(entity, SiteAuditEvent):
                entity.id = entity.id or uuid4()
                entity.occurred_at = entity.occurred_at or now
                self.audit_events.append(entity)
            self.pending.remove(entity)

    def scalar(self, statement):
        self.statements.append(statement)
        params = statement.compile().params
        identifier = params["id_1"]
        organization_id = params["organization_id_1"]
        if "FROM portfolios" in str(statement):
            return next(
                (
                    portfolio.id
                    for portfolio in self.portfolios
                    if portfolio.id == identifier
                    and portfolio.organization_id == organization_id
                ),
                None,
            )
        return next(
            (
                site
                for site in self.sites
                if site.id == identifier
                and site.organization_id == organization_id
            ),
            None,
        )


@pytest.fixture
def write_client(monkeypatch):
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
    session = FakeSession(portfolios=[portfolio])

    def provide_session():
        yield session

    monkeypatch.setitem(app.dependency_overrides, get_portfolio_session, provide_session)
    monkeypatch.setitem(
        app.dependency_overrides,
        get_authorization_workload_token,
        lambda: WORKLOAD_TOKEN,
    )
    with TestClient(app) as client:
        yield client, session


def valid_decision(operation, *, organization_id=ORGANIZATION_ID, actor_id=ACTOR_ID):
    return httpx.Response(
        200,
        json={
            "organization_id": str(organization_id),
            "operation": operation,
            "allowed": True,
            "actor_id": str(actor_id),
        },
    )


def request_headers():
    return {"Authorization": "Bearer " + USER_TOKEN}


def now():
    value = datetime.now(UTC)
    return {"created_at": value, "updated_at": value}


def test_authorized_site_creation_audits_trusted_actor_and_fields(
    monkeypatch, write_client
):
    client, session = write_client
    requested = []

    def decide(url, **kwargs):
        requested.append(kwargs["json"]["operation"])
        return valid_decision(kwargs["json"]["operation"])

    monkeypatch.setattr(authorization.httpx, "post", decide)
    response = client.post(
        "/api/v1/sites",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={
            "portfolio_id": str(PORTFOLIO_ID),
            "name": "North Grounds",
            "address": "  Fictional Lane  ",
        },
    )

    assert response.status_code == 201
    created = response.json()
    assert created["organization_id"] == str(ORGANIZATION_ID)
    assert created["portfolio_id"] == str(PORTFOLIO_ID)
    assert created["address"] == "Fictional Lane"
    assert requested == ["property-assets.sites.create"]
    assert len(session.sites) == 1
    assert len(session.audit_events) == 1
    event = session.audit_events[0]
    assert event.organization_id == ORGANIZATION_ID
    assert event.site_id == session.sites[0].id
    assert event.operation == "property-assets.sites.create"
    assert event.actor_id == ACTOR_ID
    assert event.changed_fields == ["address", "name", "status"]


def test_creation_rejects_a_portfolio_outside_the_authorized_organization(
    monkeypatch, write_client
):
    client, session = write_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    session.portfolios.clear()
    session.portfolios.append(
        Portfolio(
            id=PORTFOLIO_ID,
            organization_id=OTHER_ORGANIZATION_ID,
            name="Other estate",
            status="active",
        )
    )

    response = client.post(
        "/api/v1/sites",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"portfolio_id": str(PORTFOLIO_ID), "name": "North Grounds"},
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Asset not found"}
    assert session.sites == []
    assert session.audit_events == []


def test_authorized_update_scopes_site_and_audits_address_clear(
    monkeypatch, write_client
):
    client, session = write_client
    site = Site(
        id=SITE_ID,
        organization_id=ORGANIZATION_ID,
        portfolio_id=PORTFOLIO_ID,
        name="North Grounds",
        address="Fictional Lane",
        status="active",
        **now(),
    )
    session.sites.append(site)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )

    response = client.patch(
        f"/api/v1/sites/{SITE_ID}",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"address": None},
    )

    assert response.status_code == 200
    assert response.json()["address"] is None
    assert session.sites[0].portfolio_id == PORTFOLIO_ID
    assert len(session.audit_events) == 1
    assert session.audit_events[0].operation == "property-assets.sites.update"
    assert session.audit_events[0].actor_id == ACTOR_ID
    assert session.audit_events[0].changed_fields == ["address"]
    assert "sites.id = :id_1" in str(session.statements[0])
    assert "sites.organization_id = :organization_id_1" in str(session.statements[0])


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (f"/api/v1/sites/{SITE_ID}", {"portfolio_id": str(PORTFOLIO_ID)}),
        (f"/api/v1/sites/{SITE_ID}", {"organization_id": str(ORGANIZATION_ID)}),
        (f"/api/v1/sites/{SITE_ID}", {"id": str(SITE_ID)}),
        (f"/api/v1/sites/{SITE_ID}", {}),
        ("/api/v1/sites/not-a-uuid", {"name": "Name"}),
        ("/api/v1/sites", {"portfolio_id": "not-a-uuid", "name": "Name"}),
        (
            "/api/v1/sites",
            {
                "portfolio_id": str(PORTFOLIO_ID),
                "name": "Name",
                "organization_id": str(ORGANIZATION_ID),
            },
        ),
        (
            "/api/v1/sites",
            {
                "portfolio_id": str(PORTFOLIO_ID),
                "name": "Name",
                "id": str(SITE_ID),
            },
        ),
        (
            "/api/v1/sites",
            {
                "portfolio_id": str(PORTFOLIO_ID),
                "name": "Name",
                "unknown": "value",
            },
        ),
        ("/api/v1/sites", {"portfolio_id": str(PORTFOLIO_ID), "name": "  "}),
        ("/api/v1/sites", {"portfolio_id": str(PORTFOLIO_ID), "name": "x" * 201}),
    ],
)
def test_invalid_identifiers_empty_and_protected_payloads_are_rejected(
    monkeypatch, write_client, path, body
):
    client, session = write_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    if path == "/api/v1/sites" and "portfolio_id" in body:
        response = client.post(
            path,
            params={"organization_id": str(ORGANIZATION_ID)},
            headers=request_headers(),
            json=body,
        )
    else:
        response = client.patch(
            path,
            params={"organization_id": str(ORGANIZATION_ID)},
            headers=request_headers(),
            json=body,
        )

    assert response.status_code == 422
    assert session.sites == []
    assert session.audit_events == []


def test_read_only_member_is_denied_and_cross_organization_site_is_not_found(
    monkeypatch, write_client
):
    client, session = write_client
    response = httpx.Response(403)
    monkeypatch.setattr(authorization.httpx, "post", lambda url, **kwargs: response)
    denied = client.post(
        "/api/v1/sites",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"portfolio_id": str(PORTFOLIO_ID), "name": "North Grounds"},
    )
    assert denied.status_code == 403
    assert session.statements == []

    site = Site(
        id=SITE_ID,
        organization_id=OTHER_ORGANIZATION_ID,
        portfolio_id=PORTFOLIO_ID,
        name="Other grounds",
        status="active",
        **now(),
    )
    session.sites.append(site)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    missing = client.patch(
        f"/api/v1/sites/{SITE_ID}",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"name": "Attempted change"},
    )
    assert missing.status_code == 404
    assert session.sites[0].name == "Other grounds"
    assert session.audit_events == []


def test_authorization_service_failure_fails_closed_before_database_access(
    monkeypatch, write_client
):
    client, session = write_client

    def unavailable(*args, **kwargs):
        raise httpx.ConnectError("fictional internal service error")

    monkeypatch.setattr(authorization.httpx, "post", unavailable)
    response = client.patch(
        f"/api/v1/sites/{SITE_ID}",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"name": "Attempted change"},
    )

    assert response.status_code == 503
    assert session.statements == []


def test_audit_failure_rolls_back_site_write_and_returns_sanitized_error(
    monkeypatch, write_client
):
    client, session = write_client
    session.fail_on_flush = 2
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )

    response = client.post(
        "/api/v1/sites",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"portfolio_id": str(PORTFOLIO_ID), "name": "North Grounds"},
    )

    assert response.status_code == 503
    assert "fictional database detail" not in response.text
    assert session.sites == []
    assert session.audit_events == []


def test_failed_update_audit_rolls_back_site_changes(
    monkeypatch, write_client
):
    client, session = write_client
    site = Site(
        id=SITE_ID,
        organization_id=ORGANIZATION_ID,
        portfolio_id=PORTFOLIO_ID,
        name="North Grounds",
        address=None,
        status="active",
        **now(),
    )
    session.sites.append(site)
    session.fail_on_flush = 1
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )

    response = client.patch(
        f"/api/v1/sites/{SITE_ID}",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"name": "Updated grounds"},
    )

    assert response.status_code == 503
    assert session.sites[0].name == "North Grounds"
    assert session.audit_events == []
