from collections.abc import Collection, Generator
from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends, Path
from sqlalchemy import select
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

        if allowed_roles is not None and role not in allowed_roles:
            raise AuthorizationDenied

        return AuthorizedMembership(
            organization_id=membership.organization_id,
            user_id=membership.user_id,
            role=role,
        )

    return dependency
