from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from typing import Any
from urllib.parse import urlsplit

import jwt
from fastapi import Depends, Header
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


@dataclass(frozen=True)
class AuthenticatedWorkload:
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

    issuer, expected_client_id, required_scope = _configured_identity()
    claims = _decode_access_token(credentials.credentials, issuer)

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


def _configured_workload_identity() -> tuple[str, str, str]:
    issuer, user_client_id, _ = _configured_identity()
    workload_client_id = config.COGNITO_WORKLOAD_CLIENT_ID
    required_scope = config.COGNITO_WORKLOAD_REQUIRED_SCOPE
    if not workload_client_id or not required_scope:
        raise AuthenticationConfigurationError(
            "Cognito workload client ID and required scope must be configured"
        )
    if workload_client_id == user_client_id:
        raise AuthenticationConfigurationError(
            "Cognito user and workload clients must be distinct"
        )
    return issuer, workload_client_id, required_scope


def verify_workload_access_token(
    authorization: str | None = Header(
        default=None,
        alias="X-Service-Authorization",
    ),
) -> AuthenticatedWorkload:
    if authorization is None:
        raise AuthenticationFailure
    scheme, separator, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not separator or not token.strip():
        raise AuthenticationFailure

    issuer, expected_client_id, required_scope = _configured_workload_identity()
    claims = _decode_access_token(token.strip(), issuer, require_subject=False)

    client_id = claims.get("client_id")
    scope_claim = claims.get("scope")
    if (
        claims.get("token_use") != "access"
        or client_id != expected_client_id
        or not isinstance(scope_claim, str)
    ):
        raise AuthenticationFailure

    scopes = frozenset(scope_claim.split())
    if required_scope not in scopes:
        raise AuthenticationFailure

    return AuthenticatedWorkload(client_id=client_id, scopes=scopes)


def _decode_access_token(
    token: str,
    issuer: str,
    *,
    require_subject: bool = True,
) -> Mapping[str, Any]:
    try:
        signing_key = get_jwks_client().get_signing_key_from_jwt(token)
        required_claims = ["exp", "iat", "iss", "token_use", "client_id", "scope"]
        if require_subject:
            required_claims.append("sub")
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=issuer,
            options={
                "require": required_claims,
                "verify_aud": False,
            },
        )
    except AuthenticationConfigurationError:
        raise
    except (PyJWKClientError, PyJWTError, ValueError, TypeError) as error:
        raise AuthenticationFailure from error
    return claims
