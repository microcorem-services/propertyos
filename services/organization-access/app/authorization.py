import base64
import binascii
import json
import re
from collections.abc import Collection, Generator
from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends, Path
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app import database
from app.auth import AuthenticatedPrincipal, verify_access_token
from app.models import (
    Membership,
    MembershipRole,
    MembershipStatus,
    Organization,
    OrganizationStatus,
    User,
)


class AuthorizationDenied(Exception):
    pass


class AuthorizationServiceUnavailable(Exception):
    pass


@dataclass(frozen=True)
class AuthorizedMembership:
    organization_id: UUID
    user_id: UUID
    role: MembershipRole


@dataclass(frozen=True)
class OrganizationChooserItem:
    id: UUID
    name: str


@dataclass(frozen=True)
class OrganizationChooserPage:
    organizations: list[OrganizationChooserItem]
    next_cursor: str | None


ORGANIZATION_PAGE_MAX_SIZE = 100
_CURSOR_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,512}$")


def get_authorization_session() -> Generator[Session, None, None]:
    try:
        yield from database.get_db()
    except Exception as error:
        raise AuthorizationServiceUnavailable from error


def require_organization_membership(
    permitted_roles: Collection[MembershipRole] | None = None,
):
    allowed_roles = (
        None if permitted_roles is None else frozenset(permitted_roles)
    )
    if allowed_roles is not None and not all(
        isinstance(role, MembershipRole) for role in allowed_roles
    ):
        raise ValueError("permitted_roles must contain MembershipRole values")

    def dependency(
        organization_id: UUID = Path(...),
        principal: AuthenticatedPrincipal = Depends(verify_access_token),
        session: Session = Depends(get_authorization_session),
    ) -> AuthorizedMembership:
        return authorize_organization_membership(
            organization_id,
            principal,
            session,
            allowed_roles,
        )

    return dependency


def authorize_organization_membership(
    organization_id: UUID,
    principal: AuthenticatedPrincipal,
    session: Session,
    permitted_roles: Collection[MembershipRole] | None = None,
) -> AuthorizedMembership:
    statement = (
        select(Membership, Organization)
        .join(Organization, Membership.organization_id == Organization.id)
        .join(User, Membership.user_id == User.id)
        .where(
            User.external_subject == principal.subject,
            Organization.id == organization_id,
            Organization.status == OrganizationStatus.ACTIVE.value,
            Membership.organization_id == organization_id,
            Membership.status == MembershipStatus.ACTIVE.value,
        )
    )

    try:
        row = session.execute(statement).one_or_none()
    except Exception as error:
        raise AuthorizationServiceUnavailable from error

    if row is None:
        raise AuthorizationDenied

    membership, _organization = row
    try:
        role = MembershipRole(membership.role)
    except ValueError as error:
        raise AuthorizationDenied from error

    allowed_roles = (
        None if permitted_roles is None else frozenset(permitted_roles)
    )
    if allowed_roles is not None and role not in allowed_roles:
        raise AuthorizationDenied

    return AuthorizedMembership(
        organization_id=membership.organization_id,
        user_id=membership.user_id,
        role=role,
    )


def _decode_organization_cursor(cursor: str) -> tuple[str, UUID]:
    if _CURSOR_PATTERN.fullmatch(cursor) is None:
        raise ValueError("Invalid organization cursor.")
    try:
        encoded = cursor.encode("ascii")
        payload = base64.b64decode(
            encoded + b"=" * (-len(encoded) % 4),
            altchars=b"-_",
            validate=True,
        )
        decoded = json.loads(payload)
        if (
            not isinstance(decoded, dict)
            or set(decoded) != {"id", "name"}
            or not isinstance(decoded["name"], str)
            or len(decoded["name"]) > 200
            or not isinstance(decoded["id"], str)
        ):
            raise ValueError("Invalid organization cursor.")
        return decoded["name"], UUID(decoded["id"])
    except (binascii.Error, UnicodeError, json.JSONDecodeError, TypeError) as error:
        raise ValueError("Invalid organization cursor.") from error


def _encode_organization_cursor(name: str, organization_id: UUID) -> str:
    payload = json.dumps(
        {"id": str(organization_id), "name": name},
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def list_user_organizations(
    principal: AuthenticatedPrincipal,
    session: Session,
    *,
    limit: int,
    cursor: str | None = None,
) -> OrganizationChooserPage:
    if not 1 <= limit <= ORGANIZATION_PAGE_MAX_SIZE:
        raise ValueError("Organization page size is out of range.")

    statement = (
        select(Organization.id, Organization.name)
        .join(Membership, Membership.organization_id == Organization.id)
        .join(User, User.id == Membership.user_id)
        .where(
            User.external_subject == principal.subject,
            Organization.status == OrganizationStatus.ACTIVE.value,
            Membership.status == MembershipStatus.ACTIVE.value,
        )
    )
    if cursor is not None:
        last_name, last_id = _decode_organization_cursor(cursor)
        statement = statement.where(
            or_(
                Organization.name > last_name,
                and_(
                    Organization.name == last_name,
                    Organization.id > last_id,
                ),
            )
        )

    statement = (
        statement.order_by(Organization.name.asc(), Organization.id.asc())
        .limit(limit + 1)
    )
    try:
        rows = session.execute(statement).all()
    except Exception as error:
        raise AuthorizationServiceUnavailable from error

    has_more = len(rows) > limit
    page_rows = rows[:limit]
    organizations = [
        OrganizationChooserItem(id=organization_id, name=name)
        for organization_id, name in page_rows
    ]
    next_cursor = (
        _encode_organization_cursor(page_rows[-1][1], page_rows[-1][0])
        if has_more
        else None
    )
    return OrganizationChooserPage(
        organizations=organizations,
        next_cursor=next_cursor,
    )
