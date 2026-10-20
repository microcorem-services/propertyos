from dataclasses import dataclass
import ipaddress
import json
import math
import re
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from fastapi import Depends, Query, Request

from app import config
from app.workload_token import WorkloadTokenError, get_workload_access_token


AuthorizationOperation = Literal[
    "property-assets.portfolios.read",
    "property-assets.portfolios.create",
    "property-assets.portfolios.update",
    "property-assets.sites.create",
    "property-assets.sites.update",
    "property-assets.buildings.create",
    "property-assets.buildings.update",
]
READ_OPERATION: AuthorizationOperation = "property-assets.portfolios.read"
CREATE_OPERATION: AuthorizationOperation = "property-assets.portfolios.create"
UPDATE_OPERATION: AuthorizationOperation = "property-assets.portfolios.update"
CREATE_SITE_OPERATION: AuthorizationOperation = "property-assets.sites.create"
UPDATE_SITE_OPERATION: AuthorizationOperation = "property-assets.sites.update"
CREATE_BUILDING_OPERATION: AuthorizationOperation = "property-assets.buildings.create"
UPDATE_BUILDING_OPERATION: AuthorizationOperation = "property-assets.buildings.update"
WRITE_OPERATIONS = (
    CREATE_OPERATION,
    UPDATE_OPERATION,
    CREATE_SITE_OPERATION,
    UPDATE_SITE_OPERATION,
    CREATE_BUILDING_OPERATION,
    UPDATE_BUILDING_OPERATION,
)
DECISION_PATH = "/internal/v1/authorization/decisions"
_JWT_ACCESS_TOKEN = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")


class UserAuthenticationRequired(Exception):
    pass


class OrganizationAccessDenied(Exception):
    pass


class AuthorizationDependencyUnavailable(Exception):
    pass


@dataclass(frozen=True)
class AuthorizedOrganization:
    organization_id: UUID
    actor_id: UUID


@dataclass(frozen=True)
class PortfolioWritePermissions:
    can_create: bool
    can_update: bool


@dataclass(frozen=True)
class SiteWritePermissions:
    can_create: bool
    can_update: bool


@dataclass(frozen=True)
class BuildingWritePermissions:
    can_create: bool
    can_update: bool


def get_user_bearer_token(request: Request) -> str:
    authorization_headers = request.headers.getlist("authorization")
    if len(authorization_headers) != 1:
        raise UserAuthenticationRequired

    scheme, separator, token = authorization_headers[0].partition(" ")
    if (
        scheme.lower() != "bearer"
        or not separator
        or not token
        or token.strip() != token
        or _JWT_ACCESS_TOKEN.fullmatch(token) is None
    ):
        raise UserAuthenticationRequired
    return token


def _decision_url() -> str:
    service_url = config.ORGANIZATION_ACCESS_URL
    try:
        connect_timeout = float(config.ORGANIZATION_ACCESS_CONNECT_TIMEOUT_SECONDS)
        read_timeout = float(config.ORGANIZATION_ACCESS_READ_TIMEOUT_SECONDS)
    except (TypeError, ValueError):
        raise AuthorizationDependencyUnavailable from None

    if (
        not math.isfinite(connect_timeout)
        or connect_timeout <= 0
        or not math.isfinite(read_timeout)
        or read_timeout <= 0
    ):
        raise AuthorizationDependencyUnavailable

    try:
        parsed = urlsplit(service_url)
        hostname = parsed.hostname
    except (TypeError, ValueError):
        raise AuthorizationDependencyUnavailable from None
    if (
        hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise AuthorizationDependencyUnavailable
    if parsed.scheme == "https":
        return f"{service_url.rstrip('/')}{DECISION_PATH}"
    if parsed.scheme != "http" or not config.ORGANIZATION_ACCESS_ALLOW_INSECURE_LOCAL_HTTP:
        raise AuthorizationDependencyUnavailable

    try:
        is_loopback = ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        is_loopback = hostname.lower() == "localhost"
    if not is_loopback:
        raise AuthorizationDependencyUnavailable
    return f"{service_url.rstrip('/')}{DECISION_PATH}"


def require_organization_authorization(
    organization_id: UUID,
    user_token: str,
    workload_token: str,
    operation: AuthorizationOperation = READ_OPERATION,
) -> AuthorizedOrganization:
    decision_url = _decision_url()
    try:
        connect_timeout = float(config.ORGANIZATION_ACCESS_CONNECT_TIMEOUT_SECONDS)
        read_timeout = float(config.ORGANIZATION_ACCESS_READ_TIMEOUT_SECONDS)
        response = httpx.post(
            decision_url,
            json={
                "organization_id": str(organization_id),
                "operation": operation,
            },
            headers={
                "Authorization": f"Bearer {user_token}",
                "X-Service-Authorization": f"Bearer {workload_token}",
                "Accept": "application/json",
            },
            timeout=httpx.Timeout(
                connect=connect_timeout,
                read=read_timeout,
                write=read_timeout,
                pool=connect_timeout,
            ),
        )
    except (httpx.HTTPError, ValueError):
        raise AuthorizationDependencyUnavailable from None

    if response.status_code == 401:
        raise UserAuthenticationRequired
    if response.status_code == 403:
        raise OrganizationAccessDenied
    if response.status_code != 200:
        raise AuthorizationDependencyUnavailable

    try:
        decision = response.json()
    except (json.JSONDecodeError, UnicodeError, ValueError):
        raise AuthorizationDependencyUnavailable from None
    if not isinstance(decision, dict) or set(decision) != {
        "organization_id",
        "operation",
        "allowed",
        "actor_id",
    }:
        raise AuthorizationDependencyUnavailable

    try:
        if not isinstance(decision["organization_id"], str):
            raise ValueError
        returned_organization_id = UUID(decision["organization_id"])
        if not isinstance(decision["actor_id"], str):
            raise ValueError
        actor_id = UUID(decision["actor_id"])
    except (ValueError, TypeError, AttributeError):
        raise AuthorizationDependencyUnavailable from None
    if (
        type(decision["allowed"]) is not bool
        or decision["allowed"] is not True
        or returned_organization_id != organization_id
        or decision["operation"] != operation
    ):
        raise AuthorizationDependencyUnavailable

    return AuthorizedOrganization(
        organization_id=organization_id,
        actor_id=actor_id,
    )


def get_authorization_workload_token() -> str:
    try:
        return get_workload_access_token()
    except WorkloadTokenError:
        raise AuthorizationDependencyUnavailable from None


def get_authorized_organization(
    organization_id: UUID = Query(...),
    user_token: str = Depends(get_user_bearer_token),
    workload_token: str = Depends(get_authorization_workload_token),
) -> AuthorizedOrganization:
    return require_organization_authorization(
        organization_id,
        user_token,
        workload_token,
    )


def write_authorization(operation: AuthorizationOperation):
    if operation not in WRITE_OPERATIONS:
        raise ValueError("A portfolio write operation is required.")

    def dependency(
        organization_id: UUID = Query(...),
        user_token: str = Depends(get_user_bearer_token),
        workload_token: str = Depends(get_authorization_workload_token),
    ) -> AuthorizedOrganization:
        return require_organization_authorization(
            organization_id,
            user_token,
            workload_token,
            operation,
        )

    return dependency


def get_portfolio_write_permissions(
    organization_id: UUID,
    user_token: str,
    workload_token: str,
) -> PortfolioWritePermissions:
    require_organization_authorization(
        organization_id,
        user_token,
        workload_token,
        READ_OPERATION,
    )

    def allowed(operation: AuthorizationOperation) -> bool:
        try:
            require_organization_authorization(
                organization_id,
                user_token,
                workload_token,
                operation,
            )
        except OrganizationAccessDenied:
            return False
        return True

    return PortfolioWritePermissions(
        can_create=allowed(CREATE_OPERATION),
        can_update=allowed(UPDATE_OPERATION),
    )


def get_site_write_permissions(
    organization_id: UUID,
    user_token: str,
    workload_token: str,
) -> SiteWritePermissions:
    require_organization_authorization(
        organization_id,
        user_token,
        workload_token,
        READ_OPERATION,
    )

    def allowed(operation: AuthorizationOperation) -> bool:
        try:
            require_organization_authorization(
                organization_id,
                user_token,
                workload_token,
                operation,
            )
        except OrganizationAccessDenied:
            return False
        return True

    return SiteWritePermissions(
        can_create=allowed(CREATE_SITE_OPERATION),
        can_update=allowed(UPDATE_SITE_OPERATION),
    )


def get_building_write_permissions(
    organization_id: UUID,
    user_token: str,
    workload_token: str,
) -> BuildingWritePermissions:
    require_organization_authorization(
        organization_id,
        user_token,
        workload_token,
        READ_OPERATION,
    )

    def allowed(operation: AuthorizationOperation) -> bool:
        try:
            require_organization_authorization(
                organization_id,
                user_token,
                workload_token,
                operation,
            )
        except OrganizationAccessDenied:
            return False
        return True

    return BuildingWritePermissions(
        can_create=allowed(CREATE_BUILDING_OPERATION),
        can_update=allowed(UPDATE_BUILDING_OPERATION),
    )
