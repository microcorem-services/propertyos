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
from app.models import Portfolio, PortfolioAuditEvent

ORGANIZATION_ID = uuid4()
OTHER_ORGANIZATION_ID = uuid4()
ACTOR_ID = uuid4()
PORTFOLIO_ID = uuid4()
USER_TOKEN = "fictional.header.signature"
WORKLOAD_TOKEN = "fictional.workload.signature"
SERVICE_URL = "https://organization-access.example.test"


class FakeSession:
    def __init__(self, portfolios=None, fail_on_flush=None):
        self.portfolios = list(portfolios or [])
        self.audit_events = []
        self.statements = []
        self.fail_on_flush = fail_on_flush
        self.flush_count = 0
        self.pending = []

    @contextmanager
    def begin(self):
        portfolio_values = [
            (portfolio, portfolio.name, portfolio.status, portfolio.updated_at)
            for portfolio in self.portfolios
        ]
        portfolio_count = len(self.portfolios)
        audit_count = len(self.audit_events)
        pending = list(self.pending)
        try:
            yield self
        except Exception:
            for portfolio, name, status, updated_at in portfolio_values:
                portfolio.name = name
                portfolio.status = status
                portfolio.updated_at = updated_at
            del self.portfolios[portfolio_count:]
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
                "INSERT portfolio audit",
                {},
                Exception("fictional database detail"),
            )
        now = datetime.now(UTC)
        for entity in list(self.pending):
            if isinstance(entity, Portfolio):
                entity.id = entity.id or uuid4()
                entity.created_at = entity.created_at or now
                entity.updated_at = entity.updated_at or now
                if entity not in self.portfolios:
                    self.portfolios.append(entity)
            elif isinstance(entity, PortfolioAuditEvent):
                entity.id = entity.id or uuid4()
                entity.occurred_at = entity.occurred_at or now
                self.audit_events.append(entity)
            self.pending.remove(entity)

    def scalar(self, statement):
        self.statements.append(statement)
        params = statement.compile().params
        portfolio_id = params["id_1"]
        organization_id = params["organization_id_1"]
        return next(
            (
                portfolio
                for portfolio in self.portfolios
                if portfolio.id == portfolio_id
                and portfolio.organization_id == organization_id
            ),
            None,
        )


@pytest.fixture
def write_client(monkeypatch):
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


def test_authorized_creation_records_actor_and_allowed_fields_atomically(
    monkeypatch, write_client
):
    client, session = write_client
    requested = []

    def decide(url, **kwargs):
        requested.append(kwargs["json"]["operation"])
        return valid_decision(kwargs["json"]["operation"])

    monkeypatch.setattr(authorization.httpx, "post", decide)
    response = client.post(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"name": "North Estate"},
    )

    assert response.status_code == 201
    created = response.json()
    assert created["organization_id"] == str(ORGANIZATION_ID)
    assert created["name"] == "North Estate"
    assert created["status"] == "active"
    assert requested == ["property-assets.portfolios.create"]
    assert len(session.portfolios) == 1
    assert len(session.audit_events) == 1
    event = session.audit_events[0]
    assert event.organization_id == ORGANIZATION_ID
    assert event.portfolio_id == session.portfolios[0].id
    assert event.operation == "property-assets.portfolios.create"
    assert event.actor_id == ACTOR_ID
    assert event.changed_fields == ["name", "status"]


def test_authorized_update_scopes_to_organization_and_audits_changed_fields(
    monkeypatch, write_client
):
    client, session = write_client
    portfolio = Portfolio(
        id=PORTFOLIO_ID,
        organization_id=ORGANIZATION_ID,
        name="Old name",
        status="active",
        **now(),
    )
    session.portfolios.append(portfolio)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )

    response = client.patch(
        f"/api/v1/portfolios/{PORTFOLIO_ID}",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"name": "Updated estate"},
    )

    assert response.status_code == 200
    assert response.json()["name"] == "Updated estate"
    assert len(session.statements) == 1
    assert "portfolios.id = :id_1" in str(session.statements[0])
    assert "portfolios.organization_id = :organization_id_1" in str(
        session.statements[0]
    )
    assert len(session.audit_events) == 1
    assert session.audit_events[0].operation == "property-assets.portfolios.update"
    assert session.audit_events[0].actor_id == ACTOR_ID
    assert session.audit_events[0].changed_fields == ["name"]


def test_read_only_member_is_denied_write_before_registry_database_access(
    monkeypatch, write_client
):
    client, session = write_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *args, **kwargs: httpx.Response(403),
    )

    response = client.post(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"name": "Private portfolio"},
    )

    assert response.status_code == 403
    assert session.statements == []
    assert session.portfolios == []
    assert session.audit_events == []


def test_cross_organization_update_is_indistinguishable_from_missing(
    monkeypatch, write_client
):
    client, session = write_client
    session.portfolios.append(
        Portfolio(
            id=PORTFOLIO_ID,
            organization_id=OTHER_ORGANIZATION_ID,
            name="Private portfolio",
            status="active",
            **now(),
        )
    )
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )

    response = client.patch(
        f"/api/v1/portfolios/{PORTFOLIO_ID}",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"name": "Attacker edit"},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Portfolio not found"
    assert session.portfolios[0].name == "Private portfolio"
    assert session.audit_events == []


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("post", "/api/v1/portfolios", {"name": "   "}),
        (
            "post",
            "/api/v1/portfolios",
            {"name": "Protected", "organization_id": str(OTHER_ORGANIZATION_ID)},
        ),
        ("patch", f"/api/v1/portfolios/{PORTFOLIO_ID}", {"id": str(uuid4())}),
        ("patch", f"/api/v1/portfolios/{PORTFOLIO_ID}", {"status": "pending"}),
        ("patch", f"/api/v1/portfolios/{PORTFOLIO_ID}", {}),
    ],
)
def test_invalid_and_protected_fields_are_rejected_safely(
    monkeypatch, write_client, method, path, payload
):
    client, session = write_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    response = getattr(client, method)(
        path,
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json=payload,
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid request."}
    assert str(OTHER_ORGANIZATION_ID) not in response.text
    assert session.portfolios == []
    assert session.audit_events == []


def test_invalid_ids_and_authorization_service_failure_fail_closed(
    monkeypatch, write_client
):
    client, session = write_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )
    response = client.patch(
        "/api/v1/portfolios/not-a-uuid",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"name": "New name"},
    )
    assert response.status_code == 422
    assert session.statements == []

    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            httpx.ConnectError("fictional private service detail")
        ),
    )
    failure = client.post(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"name": "North Estate"},
    )
    assert failure.status_code == 503
    assert "fictional private service detail" not in failure.text
    assert session.portfolios == []


def test_audit_insert_failure_rolls_back_portfolio_mutation(
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
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"name": "North Estate"},
    )

    assert response.status_code == 503
    assert "fictional database detail" not in response.text
    assert session.portfolios == []
    assert session.audit_events == []


def test_update_audit_failure_rolls_back_portfolio_changes(
    monkeypatch, write_client
):
    client, session = write_client
    portfolio = Portfolio(
        id=PORTFOLIO_ID,
        organization_id=ORGANIZATION_ID,
        name="Original name",
        status="active",
        **now(),
    )
    original_updated_at = portfolio.updated_at
    session.portfolios.append(portfolio)
    session.fail_on_flush = 1
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda url, **kwargs: valid_decision(kwargs["json"]["operation"]),
    )

    response = client.patch(
        f"/api/v1/portfolios/{PORTFOLIO_ID}",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
        json={"name": "Changed name"},
    )

    assert response.status_code == 503
    assert "fictional database detail" not in response.text
    assert portfolio.name == "Original name"
    assert portfolio.updated_at == original_updated_at
    assert session.audit_events == []


def test_permissions_require_read_and_report_independent_write_decisions(
    monkeypatch, write_client
):
    client, _ = write_client
    operations = []

    def decide(url, **kwargs):
        operation = kwargs["json"]["operation"]
        operations.append(operation)
        if operation == "property-assets.portfolios.create":
            return httpx.Response(403)
        return valid_decision(operation)

    monkeypatch.setattr(authorization.httpx, "post", decide)
    response = client.get(
        "/api/v1/portfolio-write-permissions",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
    )

    assert response.status_code == 200
    assert response.json() == {"can_create": False, "can_update": True}
    assert operations == [
        "property-assets.portfolios.read",
        "property-assets.portfolios.create",
        "property-assets.portfolios.update",
    ]


def test_permission_lookup_rejects_read_denial(monkeypatch, write_client):
    client, _ = write_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *args, **kwargs: httpx.Response(403),
    )
    response = client.get(
        "/api/v1/portfolio-write-permissions",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=request_headers(),
    )
    assert response.status_code == 403
