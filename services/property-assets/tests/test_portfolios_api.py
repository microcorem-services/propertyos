from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app import authorization, config
from app.authorization import (
    get_authorization_workload_token,
)
from app.main import app, get_portfolio_session
from app.workload_token import WorkloadTokenError


ORGANIZATION_ID = uuid4()
USER_TOKEN = "fictional.header.signature"
WORKLOAD_TOKEN = "fictional.workload.signature"
SERVICE_URL = "https://organization-access.example.test"
DECISION_PATH = "/internal/v1/authorization/decisions"
PORTFOLIO_READ_OPERATION = "property-assets.portfolios.read"


def valid_decision(*, organization_id=ORGANIZATION_ID, **changes):
    payload = {
        "organization_id": str(organization_id),
        "operation": PORTFOLIO_READ_OPERATION,
        "allowed": True,
    }
    payload.update(changes)
    return httpx.Response(200, json=payload)


class FakeSession:
    def __init__(self, portfolios=None, error=None):
        self.portfolios = portfolios or []
        self.error = error
        self.statements = []

    def scalars(self, statement):
        self.statements.append(statement)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(all=lambda: self.portfolios)

    def scalar(self, statement):
        self.statements.append(statement)
        if self.error is not None:
            raise self.error
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
def portfolios_client(monkeypatch):
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_URL", SERVICE_URL)
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_CONNECT_TIMEOUT_SECONDS", "1.5")
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_READ_TIMEOUT_SECONDS", "2.5")
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP", False)

    session = FakeSession()

    def provide_session():
        yield session

    def provide_workload_token():
        return WORKLOAD_TOKEN

    monkeypatch.setitem(app.dependency_overrides, get_portfolio_session, provide_session)
    monkeypatch.setitem(
        app.dependency_overrides,
        get_authorization_workload_token,
        provide_workload_token,
    )
    with TestClient(app) as client:
        yield client, session


def get_request_headers(token=USER_TOKEN):
    return {"Authorization": f"Bearer {token}"}


def test_authorized_request_returns_minimal_typed_portfolio_fields(
    monkeypatch, portfolios_client
):
    client, session = portfolios_client
    now = datetime.now(UTC)
    portfolio = SimpleNamespace(
        id=uuid4(),
        organization_id=ORGANIZATION_ID,
        name="Fictional Portfolio",
        status="active",
        created_at=now,
        updated_at=now,
    )
    session.portfolios = [portfolio]
    requests = []

    def post(url, **kwargs):
        requests.append((url, kwargs))
        return valid_decision()

    monkeypatch.setattr(authorization.httpx, "post", post)
    response = client.get(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": str(portfolio.id),
            "organization_id": str(ORGANIZATION_ID),
            "name": "Fictional Portfolio",
            "status": "active",
            "created_at": now.isoformat().replace("+00:00", "Z"),
            "updated_at": now.isoformat().replace("+00:00", "Z"),
        }
    ]
    assert len(session.statements) == 1
    assert str(session.statements[0]) == (
        "SELECT portfolios.id, portfolios.organization_id, portfolios.name, "
        "portfolios.status, portfolios.created_at, portfolios.updated_at \n"
        "FROM portfolios \nWHERE portfolios.organization_id = :organization_id_1"
    )
    url, request = requests[0]
    assert url == SERVICE_URL + DECISION_PATH
    assert request["json"] == {
        "organization_id": str(ORGANIZATION_ID),
        "operation": PORTFOLIO_READ_OPERATION,
    }
    assert request["headers"]["Authorization"] == f"Bearer {USER_TOKEN}"
    assert request["headers"]["X-Service-Authorization"] == (
        f"Bearer {WORKLOAD_TOKEN}"
    )
    assert request["timeout"].connect == 1.5
    assert request["timeout"].read == 2.5


def test_authorized_portfolio_detail_is_scoped_to_id_and_authorized_organization(
    monkeypatch, portfolios_client
):
    client, session = portfolios_client
    now = datetime.now(UTC)
    portfolio = SimpleNamespace(
        id=uuid4(),
        organization_id=ORGANIZATION_ID,
        name="Fictional Portfolio",
        status="active",
        created_at=now,
        updated_at=now,
    )
    session.portfolios = [portfolio]
    monkeypatch.setattr(authorization.httpx, "post", lambda *args, **kwargs: valid_decision())

    response = client.get(
        f"/api/v1/portfolios/{portfolio.id}",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "id": str(portfolio.id),
        "organization_id": str(ORGANIZATION_ID),
        "name": "Fictional Portfolio",
        "status": "active",
        "created_at": now.isoformat().replace("+00:00", "Z"),
        "updated_at": now.isoformat().replace("+00:00", "Z"),
    }
    assert len(session.statements) == 1
    assert "portfolios.id = :id_1" in str(session.statements[0])
    assert "portfolios.organization_id = :organization_id_1" in str(
        session.statements[0]
    )


def test_portfolio_from_another_organization_is_indistinguishable_from_missing(
    monkeypatch, portfolios_client
):
    client, session = portfolios_client
    other_organization_portfolio = SimpleNamespace(
        id=uuid4(),
        organization_id=uuid4(),
        name="Private Portfolio",
        status="active",
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    session.portfolios = [other_organization_portfolio]
    monkeypatch.setattr(authorization.httpx, "post", lambda *args, **kwargs: valid_decision())
    response = client.get(
        f"/api/v1/portfolios/{other_organization_portfolio.id}",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Portfolio not found"
    assert len(session.statements) == 1


def test_invalid_portfolio_id_is_rejected_before_database_query(
    portfolios_client, monkeypatch
):
    client, session = portfolios_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *args, **kwargs: valid_decision(),
    )
    response = client.get(
        "/api/v1/portfolios/not-a-uuid",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )
    assert response.status_code == 422
    assert session.statements == []


def test_portfolio_detail_requires_organization_authorization(
    monkeypatch, portfolios_client
):
    client, session = portfolios_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *args, **kwargs: httpx.Response(403),
    )
    response = client.get(
        f"/api/v1/portfolios/{uuid4()}",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"
    assert session.statements == []


def test_portfolio_detail_database_error_is_sanitized(monkeypatch, portfolios_client):
    client, session = portfolios_client
    session.error = OperationalError(
        "SELECT portfolios",
        {},
        Exception("fictional database failure secret"),
    )
    monkeypatch.setattr(authorization.httpx, "post", lambda *args, **kwargs: valid_decision())
    response = client.get(
        f"/api/v1/portfolios/{uuid4()}",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )
    assert response.status_code == 503
    assert "fictional database failure secret" not in response.text


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": ""},
        {"Authorization": "Basic something"},
        {"Authorization": "Bearer"},
        {"Authorization": "Bearer not-a-jwt"},
        {"Authorization": "Bearer token with-spaces"},
        {"Authorization": "Bearer token\twith-tab"},
    ],
)
def test_missing_or_malformed_user_bearer_is_sanitized_401(
    monkeypatch, portfolios_client, headers
):
    client, session = portfolios_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *args, **kwargs: pytest.fail("upstream must not be called"),
    )

    response = client.get(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=headers,
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
    assert session.statements == []


def test_duplicate_authorization_headers_are_rejected(portfolios_client):
    client, _ = portfolios_client
    response = client.get(
        "/api/v1/portfolios?organization_id=" + str(ORGANIZATION_ID),
        headers=[
            ("Authorization", "Bearer first-token"),
            ("Authorization", "Bearer second-token"),
        ],
    )

    assert response.status_code == 401


def test_missing_workload_configuration_fails_closed(
    monkeypatch, portfolios_client
):
    client, session = portfolios_client

    def unavailable_workload_token():
        raise WorkloadTokenError("Workload token provider configuration is incomplete")

    monkeypatch.delitem(
        app.dependency_overrides,
        get_authorization_workload_token,
    )
    monkeypatch.setattr(
        authorization,
        "get_workload_access_token",
        unavailable_workload_token,
    )
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *args, **kwargs: pytest.fail("upstream must not be called"),
    )
    response = client.get(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "authorization_unavailable"
    assert session.statements == []


@pytest.mark.parametrize(
    ("status_code", "expected_status"),
    [(401, 401), (403, 403), (500, 503), (503, 503), (422, 503)],
)
def test_upstream_statuses_map_only_definitive_denials(
    monkeypatch, portfolios_client, status_code, expected_status
):
    client, session = portfolios_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *args, **kwargs: httpx.Response(status_code),
    )

    response = client.get(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )

    assert response.status_code == expected_status
    assert session.statements == []


def test_timeout_and_transport_failure_map_to_sanitized_503(
    monkeypatch, portfolios_client
):
    client, session = portfolios_client

    def timeout(*args, **kwargs):
        raise httpx.ReadTimeout("request timed out")

    monkeypatch.setattr(authorization.httpx, "post", timeout)
    response = client.get(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )

    assert response.status_code == 503
    assert session.statements == []


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {"organization_id": str(ORGANIZATION_ID), "operation": PORTFOLIO_READ_OPERATION},
        {
            "organization_id": str(ORGANIZATION_ID),
            "operation": PORTFOLIO_READ_OPERATION,
            "allowed": 1,
        },
        {
            "organization_id": str(uuid4()),
            "operation": PORTFOLIO_READ_OPERATION,
            "allowed": True,
        },
        {
            "organization_id": str(ORGANIZATION_ID),
            "operation": "property-assets.portfolios.write",
            "allowed": True,
        },
        {
            "organization_id": str(ORGANIZATION_ID),
            "operation": PORTFOLIO_READ_OPERATION,
            "allowed": True,
            "membership": "extra",
        },
    ],
)
def test_malformed_or_mismatched_decision_fails_closed(
    monkeypatch, portfolios_client, payload
):
    client, session = portfolios_client
    response_payload = httpx.Response(200, json=payload)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *args, **kwargs: response_payload,
    )

    response = client.get(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )

    assert response.status_code == 503
    assert session.statements == []


def test_malformed_json_decision_fails_closed(monkeypatch, portfolios_client):
    client, session = portfolios_client
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *args, **kwargs: httpx.Response(200, content=b"not-json"),
    )

    response = client.get(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )

    assert response.status_code == 503
    assert session.statements == []


def test_authorized_empty_listing_returns_empty_array(monkeypatch, portfolios_client):
    client, session = portfolios_client
    monkeypatch.setattr(authorization.httpx, "post", lambda *args, **kwargs: valid_decision())

    response = client.get(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )

    assert response.status_code == 200
    assert response.json() == []
    assert len(session.statements) == 1


def test_database_failure_is_sanitized_503(monkeypatch, portfolios_client):
    client, session = portfolios_client
    session.error = OperationalError(
        "SELECT portfolios",
        {},
        Exception("fictional database failure secret"),
    )
    monkeypatch.setattr(authorization.httpx, "post", lambda *args, **kwargs: valid_decision())

    response = client.get(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )

    assert response.status_code == 503
    assert "fictional database failure secret" not in response.text


@pytest.mark.parametrize(
    "service_url",
    [
        "http://organization-access.example.test",
        "http://127.0.0.1:8101",
        "https://user:password@organization-access.example.test",
    ],
)
def test_internal_service_url_must_be_secure_or_explicit_loopback(
    monkeypatch, portfolios_client, service_url
):
    client, session = portfolios_client
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_URL", service_url)
    monkeypatch.setattr(config, "ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP", False)
    monkeypatch.setattr(
        authorization.httpx,
        "post",
        lambda *args, **kwargs: pytest.fail("invalid URL must not be requested"),
    )
    response = client.get(
        "/api/v1/portfolios",
        params={"organization_id": str(ORGANIZATION_ID)},
        headers=get_request_headers(),
    )

    assert response.status_code == 503
    assert session.statements == []
