from datetime import UTC, datetime, timedelta
import json

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from jwt import PyJWKClient

from app import auth, config
from app.auth import AuthenticatedPrincipal, AuthenticationFailure, verify_access_token
from app.main import authentication_failure_handler


ISSUER = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_testpool"
CLIENT_ID = "fictional-cognito-client"
REQUIRED_SCOPE = "organization-access/read"


@pytest.fixture(scope="module")
def signing_keys():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    wrong_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, wrong_private_key


@pytest.fixture
def auth_client(monkeypatch, signing_keys):
    private_key, _ = signing_keys
    monkeypatch.setattr(config, "COGNITO_ISSUER", ISSUER)
    monkeypatch.setattr(config, "COGNITO_USER_POOL_REGION", "eu-west-1")
    monkeypatch.setattr(config, "COGNITO_APP_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(config, "COGNITO_REQUIRED_SCOPE", REQUIRED_SCOPE)

    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": "local-test-key", "use": "sig", "alg": "RS256"})
    jwks_client = PyJWKClient(f"{ISSUER}/.well-known/jwks.json", timeout=5)
    monkeypatch.setattr(jwks_client, "fetch_data", lambda: {"keys": [jwk]})
    monkeypatch.setattr(auth, "get_jwks_client", lambda: jwks_client)
    test_app = FastAPI()
    test_app.add_exception_handler(
        AuthenticationFailure, authentication_failure_handler
    )

    @test_app.get("/protected")
    def protected(principal: AuthenticatedPrincipal = Depends(verify_access_token)):
        return {
            "subject": principal.subject,
            "client_id": principal.client_id,
            "scopes": sorted(principal.scopes),
        }

    return TestClient(test_app)


def make_token(signing_key, **overrides):
    now = datetime.now(UTC)
    claims = {
        "iss": ISSUER,
        "sub": "fictional-subject",
        "client_id": CLIENT_ID,
        "token_use": "access",
        "scope": f"{REQUIRED_SCOPE} openid",
        "iat": now,
        "exp": now + timedelta(minutes=5),
    }
    claims.update(overrides)
    return jwt.encode(
        claims,
        signing_key,
        algorithm="RS256",
        headers={"kid": "local-test-key"},
    )


def assert_unauthorized(response):
    assert response.status_code == 401
    assert response.json() == {
        "error": {
            "code": "unauthorized",
            "message": "Authentication required",
        }
    }
    assert response.headers["www-authenticate"] == "Bearer"


def test_valid_scoped_access_token_returns_principal(auth_client, signing_keys):
    token = make_token(signing_keys[0])

    response = auth_client.get(
        "/protected",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "subject": "fictional-subject",
        "client_id": CLIENT_ID,
        "scopes": ["openid", REQUIRED_SCOPE],
    }


@pytest.mark.parametrize("authorization", [None, "Basic not-a-bearer", "Bearer"])
def test_missing_or_malformed_credentials_return_uniform_401(
    auth_client, authorization
):
    headers = {} if authorization is None else {"Authorization": authorization}

    assert_unauthorized(auth_client.get("/protected", headers=headers))


def test_malformed_token_returns_uniform_401(auth_client):
    assert_unauthorized(
        auth_client.get(
            "/protected",
            headers={"Authorization": "Bearer not.a.jwt"},
        )
    )


def test_expired_token_returns_uniform_401(auth_client, signing_keys):
    expired = datetime.now(UTC) - timedelta(minutes=5)
    token = make_token(signing_keys[0], exp=expired, iat=expired - timedelta(minutes=5))

    assert_unauthorized(
        auth_client.get("/protected", headers={"Authorization": f"Bearer {token}"})
    )


def test_incorrect_signature_returns_uniform_401(auth_client, signing_keys):
    token = make_token(signing_keys[1])

    assert_unauthorized(
        auth_client.get("/protected", headers={"Authorization": f"Bearer {token}"})
    )


@pytest.mark.parametrize(
    "claims",
    [
        {"iss": "https://attacker.invalid/pool"},
        {"token_use": "id"},
        {"client_id": "different-client"},
        {"scope": "openid"},
    ],
)
def test_wrong_issuer_token_type_client_or_scope_returns_401(
    auth_client, signing_keys, claims
):
    token = make_token(signing_keys[0], **claims)

    assert_unauthorized(
        auth_client.get("/protected", headers={"Authorization": f"Bearer {token}"})
    )


def test_token_missing_required_claim_returns_401(auth_client, signing_keys):
    token = make_token(signing_keys[0])
    unsigned_claims = jwt.decode(
        token,
        options={"verify_signature": False},
    )
    del unsigned_claims["scope"]
    token_without_scope = jwt.encode(
        unsigned_claims,
        signing_keys[0],
        algorithm="RS256",
        headers={"kid": "local-test-key"},
    )

    assert_unauthorized(
        auth_client.get(
            "/protected",
            headers={"Authorization": f"Bearer {token_without_scope}"},
        )
    )


def test_issuer_region_mismatch_fails_closed(monkeypatch):
    monkeypatch.setattr(config, "COGNITO_ISSUER", ISSUER)
    monkeypatch.setattr(config, "COGNITO_USER_POOL_REGION", "us-east-1")
    monkeypatch.setattr(config, "COGNITO_APP_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(config, "COGNITO_REQUIRED_SCOPE", REQUIRED_SCOPE)

    with pytest.raises(auth.AuthenticationConfigurationError):
        auth.get_jwks_client()
