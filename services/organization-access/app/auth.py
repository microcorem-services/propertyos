from dataclasses import dataclass
from functools import lru_cache
from urllib.parse import urlsplit

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientError, PyJWTError

from app import config


class AuthenticationConfigurationError(RuntimeError):
    pass


class AuthenticationFailure(Exception):
    pass


@dataclass(frozen=True)
class AuthenticatedPrincipal:
    subject: str
    client_id: str
    scopes: frozenset[str]


bearer_scheme = HTTPBearer(auto_error=False)


def _configured_identity() -> tuple[str, str, str]:
    issuer = config.COGNITO_ISSUER
    region = config.COGNITO_USER_POOL_REGION
    client_id = config.COGNITO_APP_CLIENT_ID
    required_scope = config.COGNITO_REQUIRED_SCOPE
    if not all((issuer, region, client_id, required_scope)):
        raise AuthenticationConfigurationError(
            "Cognito issuer, region, client ID, and required scope must be configured"
        )

    parsed_issuer = urlsplit(issuer)
    cognito_hosts = {
        f"cognito-idp.{region}.amazonaws.com",
        f"cognito-idp.{region}.amazonaws.com.cn",
    }
    if (
        parsed_issuer.scheme != "https"
        or parsed_issuer.hostname not in cognito_hosts
        or parsed_issuer.username is not None
        or parsed_issuer.password is not None
        or parsed_issuer.port is not None
        or parsed_issuer.query
        or parsed_issuer.fragment
        or not parsed_issuer.path.strip("/")
        or "/" in parsed_issuer.path.strip("/")
    ):
        raise AuthenticationConfigurationError(
            "Cognito issuer is not a valid regional user-pool issuer"
        )

    return issuer.rstrip("/"), client_id, required_scope


@lru_cache(maxsize=4)
def _jwks_client(issuer: str) -> PyJWKClient:
    return PyJWKClient(
        f"{issuer}/.well-known/jwks.json",
        timeout=5,
        cache_keys=True,
    )


def get_jwks_client() -> PyJWKClient:
    issuer, _, _ = _configured_identity()
    return _jwks_client(issuer)


def verify_access_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> AuthenticatedPrincipal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise AuthenticationFailure

    try:
        issuer, expected_client_id, required_scope = _configured_identity()
        signing_key = get_jwks_client().get_signing_key_from_jwt(credentials.credentials)
        claims = jwt.decode(
            credentials.credentials,
            signing_key.key,
            algorithms=["RS256"],
            issuer=issuer,
            options={
                "require": [
                    "exp",
                    "iat",
                    "iss",
                    "sub",
                    "token_use",
                    "client_id",
                    "scope",
                ],
                "verify_aud": False,
            },
        )
    except AuthenticationConfigurationError:
        raise
    except (PyJWKClientError, PyJWTError, ValueError, TypeError) as error:
        raise AuthenticationFailure from error

    subject = claims.get("sub")
    client_id = claims.get("client_id")
    token_use = claims.get("token_use")
    scope_claim = claims.get("scope")
    if (
        not isinstance(subject, str)
        or not subject
        or token_use != "access"
        or client_id != expected_client_id
        or not isinstance(scope_claim, str)
    ):
        raise AuthenticationFailure

    scopes = frozenset(scope_claim.split())
    if required_scope not in scopes:
        raise AuthenticationFailure

    return AuthenticatedPrincipal(
        subject=subject,
        client_id=client_id,
        scopes=scopes,
    )
