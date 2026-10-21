import ipaddress
import json
import math
import re
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from fastapi import HTTPException, Request, status

from app import config

_JWT_ACCESS_TOKEN = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
_AUTHORIZATION_PATH = "/internal/v1/authorization/decisions"
_workload_token_lock = threading.Lock()
_workload_token: str | None = None
_workload_token_refresh_at = 0.0


@dataclass(frozen=True)
class AuthorizedOrganization:
    organization_id: UUID
    actor_id: UUID


@dataclass(frozen=True)
class UnitReference:
    portfolio_id: UUID
    site_id: UUID
    building_id: UUID
    unit_id: UUID


class UnitReferenceInvalid(Exception):
    pass


class ServiceDependencyUnavailable(Exception):
    pass


def get_user_token(request: Request) -> str:
    headers = request.headers.getlist("authorization")
    if len(headers) != 1:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    scheme, separator, token = headers[0].partition(" ")
    if (
        scheme.lower() != "bearer"
        or not separator
        or not token
        or token.strip() != token
        or _JWT_ACCESS_TOKEN.fullmatch(token) is None
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token


def _service_url(base_url: str, allow_local_http: bool, path: str) -> str:
    try:
        parsed = urlsplit(base_url)
        hostname = parsed.hostname
    except (TypeError, ValueError):
        raise ServiceDependencyUnavailable from None
    if (
        hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise ServiceDependencyUnavailable
    if parsed.scheme == "https":
        return f"{base_url.rstrip('/')}{path}"
    if parsed.scheme != "http" or not allow_local_http:
        raise ServiceDependencyUnavailable
    try:
        loopback = ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        loopback = hostname.lower() == "localhost"
    if not loopback and hostname not in {
        "organization-access",
        "property-assets",
    }:
        raise ServiceDependencyUnavailable
    return f"{base_url.rstrip('/')}{path}"


def _timeouts(connect_setting: str, read_setting: str) -> httpx.Timeout:
    try:
        connect_timeout = float(connect_setting)
        read_timeout = float(read_setting)
    except (TypeError, ValueError):
        raise ServiceDependencyUnavailable from None
    if (
        not math.isfinite(connect_timeout)
        or connect_timeout <= 0
        or not math.isfinite(read_timeout)
        or read_timeout <= 0
    ):
        raise ServiceDependencyUnavailable
    return httpx.Timeout(
        connect=connect_timeout,
        read=read_timeout,
        write=read_timeout,
        pool=connect_timeout,
    )


def get_workload_token() -> str:
    global _workload_token, _workload_token_refresh_at
    with _workload_token_lock:
        now = time.monotonic()
        if _workload_token is not None and now < _workload_token_refresh_at:
            return _workload_token
        return _request_workload_token(now)


def _request_workload_token(now: float) -> str:
    global _workload_token, _workload_token_refresh_at
    try:
        parsed = urlsplit(config.COGNITO_TOKEN_ENDPOINT_URL)
        hostname = parsed.hostname
        if (
            hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or not parsed.path
        ):
            raise ServiceDependencyUnavailable
        if parsed.scheme == "https":
            url = config.COGNITO_TOKEN_ENDPOINT_URL
        elif parsed.scheme == "http" and config.COGNITO_ALLOW_INSECURE_TOKEN_ENDPOINT:
            try:
                loopback = ipaddress.ip_address(hostname).is_loopback
            except ValueError:
                loopback = hostname.lower() == "localhost"
            if not loopback:
                raise ServiceDependencyUnavailable
            url = config.COGNITO_TOKEN_ENDPOINT_URL
        else:
            raise ServiceDependencyUnavailable
        timeout = _timeouts(
            config.COGNITO_TOKEN_CONNECT_TIMEOUT_SECONDS,
            config.COGNITO_TOKEN_READ_TIMEOUT_SECONDS,
        )
        if (
            not config.COGNITO_WORKLOAD_CLIENT_ID
            or not config.COGNITO_WORKLOAD_CLIENT_SECRET
            or not config.COGNITO_WORKLOAD_REQUIRED_SCOPE
        ):
            raise ServiceDependencyUnavailable
        response = httpx.post(
            url,
            data={
                "grant_type": "client_credentials",
                "scope": config.COGNITO_WORKLOAD_REQUIRED_SCOPE,
            },
            auth=(
                config.COGNITO_WORKLOAD_CLIENT_ID,
                config.COGNITO_WORKLOAD_CLIENT_SECRET,
            ),
            headers={"Accept": "application/json"},
            timeout=timeout,
            follow_redirects=False,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, UnicodeError, ValueError, ServiceDependencyUnavailable):
        raise ServiceDependencyUnavailable from None
    if not isinstance(payload, dict):
        raise ServiceDependencyUnavailable
    token = payload.get("access_token")
    token_type = payload.get("token_type")
    expires_in = payload.get("expires_in")
    if (
        not isinstance(token, str)
        or not token.strip()
        or token != token.strip()
        or not isinstance(token_type, str)
        or token_type.lower() != "bearer"
        or isinstance(expires_in, bool)
        or not isinstance(expires_in, int)
        or expires_in <= 0
    ):
        raise ServiceDependencyUnavailable
    _workload_token = token
    _workload_token_refresh_at = now + max(
        0, expires_in - min(30, max(1, expires_in * 0.1))
    )
    return token


def authorize_organization(
    organization_id: UUID, operation: str, user_token: str, workload_token: str
) -> AuthorizedOrganization:
    try:
        url = _service_url(
            config.ORGANIZATION_ACCESS_URL,
            config.ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP,
            _AUTHORIZATION_PATH,
        )
        timeout = _timeouts(
            config.ORGANIZATION_ACCESS_CONNECT_TIMEOUT_SECONDS,
            config.ORGANIZATION_ACCESS_READ_TIMEOUT_SECONDS,
        )
        response = httpx.post(
            url,
            json={"organization_id": str(organization_id), "operation": operation},
            headers={
                "Authorization": f"Bearer {user_token}",
                "X-Service-Authorization": f"Bearer {workload_token}",
                "Accept": "application/json",
            },
            timeout=timeout,
            follow_redirects=False,
        )
    except (httpx.HTTPError, ServiceDependencyUnavailable):
        raise ServiceDependencyUnavailable from None
    if response.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if response.status_code == 403:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Access denied"
        )
    if response.status_code != 200:
        raise ServiceDependencyUnavailable
    try:
        decision = response.json()
        if not isinstance(decision, dict) or set(decision) != {
            "organization_id",
            "operation",
            "allowed",
            "actor_id",
        }:
            raise ValueError
        returned_organization = UUID(decision["organization_id"])
        actor_id = UUID(decision["actor_id"])
    except (json.JSONDecodeError, UnicodeError, ValueError, TypeError):
        raise ServiceDependencyUnavailable from None
    if (
        returned_organization != organization_id
        or decision["operation"] != operation
        or decision["allowed"] is not True
    ):
        raise ServiceDependencyUnavailable
    return AuthorizedOrganization(organization_id, actor_id)


def authorize_request(
    organization_id: UUID, operation: str, user_token: str
) -> AuthorizedOrganization:
    try:
        workload_token = get_workload_token()
        return authorize_organization(
            organization_id, operation, user_token, workload_token
        )
    except ServiceDependencyUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authorization service unavailable",
        ) from None


def get_read_authorization(
    organization_id: UUID, request: Request
) -> AuthorizedOrganization:
    return authorize_request(
        organization_id, "lease-management.leases.read", get_user_token(request)
    )


def get_create_authorization(
    organization_id: UUID, request: Request
) -> AuthorizedOrganization:
    return authorize_request(
        organization_id, "lease-management.leases.create", get_user_token(request)
    )


def get_update_authorization(
    organization_id: UUID, request: Request
) -> AuthorizedOrganization:
    return authorize_request(
        organization_id, "lease-management.leases.update", get_user_token(request)
    )


def validate_unit_reference(
    organization_id: UUID, reference: UnitReference, user_token: str
) -> str:
    path = (
        f"/api/v1/portfolios/{reference.portfolio_id}/sites/{reference.site_id}"
        f"/buildings/{reference.building_id}/units/{reference.unit_id}"
    )
    try:
        url = _service_url(
            config.PROPERTY_ASSETS_REGISTRY_URL,
            config.PROPERTY_ASSETS_ALLOW_INSECURE_LOCAL_HTTP,
            path,
        )
        timeout = _timeouts(
            config.PROPERTY_ASSETS_CONNECT_TIMEOUT_SECONDS,
            config.PROPERTY_ASSETS_READ_TIMEOUT_SECONDS,
        )
        workload_token = get_workload_token()
        response = httpx.get(
            url,
            params={"organization_id": str(organization_id)},
            headers={
                "Authorization": f"Bearer {user_token}",
                "X-Service-Authorization": f"Bearer {workload_token}",
                "Accept": "application/json",
            },
            timeout=timeout,
            follow_redirects=False,
        )
    except (httpx.HTTPError, ServiceDependencyUnavailable):
        raise ServiceDependencyUnavailable from None
    if response.status_code == 404:
        raise UnitReferenceInvalid
    if response.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if response.status_code == 403:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Access denied"
        )
    if response.status_code != 200:
        raise ServiceDependencyUnavailable
    try:
        record = response.json()
        if not isinstance(record, dict):
            raise ValueError
        matches = (
            UUID(record["id"]) == reference.unit_id
            and UUID(record["organization_id"]) == organization_id
            and UUID(record["building_id"]) == reference.building_id
        )
        unit_status = record["status"]
    except (json.JSONDecodeError, UnicodeError, ValueError, TypeError, KeyError):
        raise ServiceDependencyUnavailable from None
    if not matches or unit_status != "active":
        raise UnitReferenceInvalid
    return unit_status
