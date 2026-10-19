import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt import PyJWKClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import auth, config
from app.authorization import get_authorization_session
from app.main import app
from app.models import (
    Base,
    Membership,
    MembershipStatus,
    Organization,
    OrganizationStatus,
    User,
)


ISSUER = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_testpool"
CLIENT_ID = "fictional-cognito-client"
REQUIRED_SCOPE = "organization-access/read"
ENDPOINT = "/api/v1/users/me/organizations"


@pytest.fixture
def api_client(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": "organization-test-key", "use": "sig", "alg": "RS256"})
    jwks_client = PyJWKClient(f"{ISSUER}/.well-known/jwks.json", timeout=5)
    monkeypatch.setattr(jwks_client, "fetch_data", lambda: {"keys": [jwk]})
    monkeypatch.setattr(auth, "get_jwks_client", lambda: jwks_client)
    monkeypatch.setattr(config, "COGNITO_ISSUER", ISSUER)
    monkeypatch.setattr(config, "COGNITO_USER_POOL_REGION", "eu-west-1")
    monkeypatch.setattr(config, "COGNITO_APP_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(config, "COGNITO_REQUIRED_SCOPE", REQUIRED_SCOPE)

    def provide_session():
        with Session(engine) as session:
            yield session

    monkeypatch.setitem(
        app.dependency_overrides,
        get_authorization_session,
        provide_session,
    )
    try:
        with TestClient(app) as client:
            yield client, engine, private_key
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def make_access_token(private_key, subject="fictional-subject", **claims):
    now = datetime.now(UTC)
    token_claims = {
        "iss": ISSUER,
        "sub": subject,
        "client_id": CLIENT_ID,
        "token_use": "access",
        "scope": f"{REQUIRED_SCOPE} openid",
        "iat": now,
        "exp": now + timedelta(minutes=5),
    }
    token_claims.update(claims)
    return jwt.encode(
        token_claims,
        private_key,
        algorithm="RS256",
        headers={"kid": "organization-test-key"},
    )


def authenticated_headers(private_key, subject="fictional-subject"):
    token = make_access_token(private_key, subject=subject)
    return {"Authorization": f"Bearer {token}"}


def add_membership(
    engine,
    *,
    subject="fictional-subject",
    name="Fictional Organization",
    membership_status=MembershipStatus.ACTIVE.value,
    organization_status=OrganizationStatus.ACTIVE.value,
):
    organization = Organization(
        id=uuid4(),
        name=name,
        status=organization_status,
    )
    with Session(engine) as session:
        user = session.query(User).filter_by(external_subject=subject).one_or_none()
        if user is None:
            user = User(external_subject=subject)
            session.add(user)
        session.add(organization)
        session.flush()
        session.add(
            Membership(
                organization_id=organization.id,
                user_id=user.id,
                role="member",
                status=membership_status,
            )
        )
        session.commit()
        return SimpleNamespace(id=organization.id, name=organization.name)


def test_returns_one_active_organization_with_only_chooser_fields(api_client):
    client, engine, private_key = api_client
    organization = add_membership(engine)

    response = client.get(ENDPOINT, headers=authenticated_headers(private_key))

    assert response.status_code == 200
    assert response.json() == {
        "organizations": [{"id": str(organization.id), "name": organization.name}],
        "next_cursor": None,
    }
    assert set(response.json()["organizations"][0]) == {"id", "name"}


def test_returns_multiple_active_organizations_in_deterministic_order(api_client):
    client, engine, private_key = api_client
    organizations = [
        add_membership(engine, name=name)
        for name in ("Zulu", "Alpha", "Same", "Same", "Middle")
    ]

    response = client.get(ENDPOINT, headers=authenticated_headers(private_key))

    assert response.status_code == 200
    assert response.json()["organizations"] == [
        {"id": str(organization.id), "name": organization.name}
        for organization in sorted(organizations, key=lambda item: (item.name, item.id))
    ]


def test_returns_empty_list_when_user_has_no_memberships(api_client):
    client, _engine, private_key = api_client

    response = client.get(ENDPOINT, headers=authenticated_headers(private_key))

    assert response.status_code == 200
    assert response.json() == {"organizations": [], "next_cursor": None}


def test_excludes_invited_suspended_and_inactive_memberships(api_client):
    client, engine, private_key = api_client
    add_membership(engine, name="Active")
    add_membership(
        engine,
        name="Invited",
        membership_status=MembershipStatus.INVITED.value,
    )
    add_membership(
        engine,
        name="Suspended membership",
        membership_status=MembershipStatus.SUSPENDED.value,
    )
    add_membership(
        engine,
        name="Inactive organization",
        organization_status=OrganizationStatus.SUSPENDED.value,
    )

    response = client.get(ENDPOINT, headers=authenticated_headers(private_key))

    assert response.status_code == 200
    assert [item["name"] for item in response.json()["organizations"]] == ["Active"]


def test_membership_listing_isolated_to_verified_token_subject(api_client):
    client, engine, private_key = api_client
    own = add_membership(engine, subject="user-one", name="Own Organization")
    add_membership(engine, subject="user-two", name="Other Organization")

    response = client.get(
        ENDPOINT,
        headers=authenticated_headers(private_key, subject="user-one"),
    )

    assert response.status_code == 200
    assert response.json()["organizations"] == [
        {"id": str(own.id), "name": own.name}
    ]


@pytest.mark.parametrize(
    ("headers", "expected_status"),
    [
        ({}, 401),
        ({"Authorization": "Bearer invalid-token"}, 401),
    ],
)
def test_missing_or_invalid_tokens_are_rejected(api_client, headers, expected_status):
    client, _engine, _private_key = api_client

    response = client.get(ENDPOINT, headers=headers)

    assert response.status_code == expected_status
    assert response.json()["error"]["code"] == "unauthorized"


def test_pagination_is_bounded_stable_and_complete(api_client):
    client, engine, private_key = api_client
    expected = [
        add_membership(engine, name=f"Organization {index:03d}")
        for index in range(105)
    ]
    headers = authenticated_headers(private_key)

    first_page = client.get(ENDPOINT, params={"limit": 100}, headers=headers)
    assert first_page.status_code == 200
    assert len(first_page.json()["organizations"]) == 100
    assert isinstance(first_page.json()["next_cursor"], str)

    second_page = client.get(
        ENDPOINT,
        params={"limit": 100, "cursor": first_page.json()["next_cursor"]},
        headers=headers,
    )
    assert second_page.status_code == 200
    assert len(second_page.json()["organizations"]) == 5
    assert second_page.json()["next_cursor"] is None

    returned = (
        first_page.json()["organizations"] + second_page.json()["organizations"]
    )
    assert returned == [
        {"id": str(organization.id), "name": organization.name}
        for organization in sorted(expected, key=lambda item: (item.name, item.id))
    ]


@pytest.mark.parametrize(
    "params",
    [
        {"limit": 0},
        {"limit": 101},
        {"cursor": "not-a-valid-cursor"},
    ],
)
def test_invalid_page_parameters_are_rejected(api_client, params):
    client, _engine, private_key = api_client

    response = client.get(
        ENDPOINT,
        params=params,
        headers=authenticated_headers(private_key),
    )

    assert response.status_code == 422


@pytest.mark.parametrize("parameter", ["user_id", "subject", "role", "membership"])
def test_client_supplied_identity_or_membership_parameters_are_rejected(
    api_client,
    parameter,
):
    client, _engine, private_key = api_client

    response = client.get(
        ENDPOINT,
        params={parameter: "attacker-controlled-value"},
        headers=authenticated_headers(private_key),
    )

    assert response.status_code == 422


def test_database_failure_returns_sanitized_service_unavailable(api_client, monkeypatch):
    client, _engine, private_key = api_client

    class FailingSession:
        def execute(self, _statement):
            raise RuntimeError("sensitive database details")

    def provide_failing_session():
        yield FailingSession()

    monkeypatch.setitem(
        app.dependency_overrides,
        get_authorization_session,
        provide_failing_session,
    )
    response = client.get(
        ENDPOINT,
        headers=authenticated_headers(private_key),
    )

    assert response.status_code == 503
    assert response.json() == {
        "error": {
            "code": "service_unavailable",
            "message": "Authorization service unavailable",
        }
    }
    assert "sensitive database details" not in response.text
