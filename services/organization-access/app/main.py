from uuid import UUID

from app.auth import (
    AuthenticatedPrincipal,
    AuthenticatedWorkload,
    AuthenticationConfigurationError,
    AuthenticationFailure,
    verify_access_token,
    verify_workload_access_token,
)
from app.authorization import (
    AuthorizationDenied,
    AuthorizationServiceUnavailable,
    AuthorizedMembership,
    authorize_organization_membership,
    get_authorization_session,
    list_user_organizations,
    require_organization_membership,
)
from app.config import SERVICE_NAME
from app.models import MembershipRole, Organization, OrganizationStatus
from app.schemas import (
    APIErrorResponse,
    InternalAuthorizationDecisionRequest,
    InternalAuthorizationDecisionResponse,
    OrganizationChooserPageResponse,
    OrganizationResponse,
)
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import database

API_V1_PREFIX = "/api/v1"
_organization_membership_dependency = require_organization_membership()

app = FastAPI(title="BOWERA Organization & Access", version="0.1.0")
api_router = APIRouter(prefix=API_V1_PREFIX)
internal_router = APIRouter(prefix="/internal/v1/authorization/decisions")


@app.exception_handler(AuthenticationFailure)
async def authentication_failure_handler(
    request: Request, error: AuthenticationFailure
) -> JSONResponse:
    response = APIErrorResponse(
        error={"code": "unauthorized", "message": "Authentication required"}
    )
    return JSONResponse(
        status_code=401,
        content=response.model_dump(mode="json"),
        headers={"WWW-Authenticate": "Bearer"},
    )


@app.exception_handler(AuthenticationConfigurationError)
async def authentication_configuration_error_handler(
    request: Request, error: AuthenticationConfigurationError
) -> JSONResponse:
    response = APIErrorResponse(
        error={
            "code": "authentication_unavailable",
            "message": "Authentication verification is not configured",
        }
    )
    return JSONResponse(status_code=503, content=response.model_dump(mode="json"))


@app.exception_handler(AuthorizationDenied)
async def authorization_denied_handler(
    request: Request, error: AuthorizationDenied
) -> JSONResponse:
    response = APIErrorResponse(
        error={"code": "forbidden", "message": "Organization access denied"}
    )
    return JSONResponse(status_code=403, content=response.model_dump(mode="json"))


@app.exception_handler(AuthorizationServiceUnavailable)
async def authorization_service_unavailable_handler(
    request: Request, error: AuthorizationServiceUnavailable
) -> JSONResponse:
    response = APIErrorResponse(
        error={
            "code": "service_unavailable",
            "message": "Authorization service unavailable",
        }
    )
    return JSONResponse(status_code=503, content=response.model_dump(mode="json"))


@app.get("/health")
def health():
    return {"status": "ok", "service": SERVICE_NAME}


@app.get("/ready")
def readiness():
    if database.engine is None:
        raise HTTPException(status_code=503, detail="Database unavailable")

    try:
        with database.engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError as error:
        raise HTTPException(status_code=503, detail="Database unavailable") from error

    return {"status": "ok", "service": SERVICE_NAME}


def permitted_roles_for_operation(
    operation: str,
) -> set[MembershipRole] | None:
    if operation.endswith(".read"):
        return None
    return {MembershipRole.OWNER, MembershipRole.ADMIN}


@api_router.get(
    "/organizations/{organization_id}",
    response_model=OrganizationResponse,
)
def get_organization(
    organization_id: UUID,
    _membership: AuthorizedMembership = Depends(_organization_membership_dependency),
    session: Session = Depends(get_authorization_session),
) -> Organization:
    if _membership.organization_id != organization_id:
        raise AuthorizationDenied

    try:
        organization = session.scalar(
            select(Organization).where(
                Organization.id == organization_id,
                Organization.status == OrganizationStatus.ACTIVE.value,
            )
        )
    except SQLAlchemyError as error:
        raise AuthorizationServiceUnavailable from error

    if organization is None:
        raise AuthorizationDenied

    return organization


@api_router.get(
    "/users/me/organizations",
    response_model=OrganizationChooserPageResponse,
)
def get_my_organizations(
    request: Request,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=512),
    principal: AuthenticatedPrincipal = Depends(verify_access_token),
    session: Session = Depends(get_authorization_session),
) -> OrganizationChooserPageResponse:
    if set(request.query_params.keys()) - {"limit", "cursor"}:
        raise HTTPException(status_code=422, detail="Unsupported query parameter.")
    try:
        page = list_user_organizations(
            principal,
            session,
            limit=limit,
            cursor=cursor,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail="Invalid organization cursor.",
        ) from error

    return OrganizationChooserPageResponse(
        organizations=[
            {"id": organization.id, "name": organization.name}
            for organization in page.organizations
        ],
        next_cursor=page.next_cursor,
    )


@internal_router.post(
    "",
    response_model=InternalAuthorizationDecisionResponse,
)
def decide_internal_authorization(
    decision: InternalAuthorizationDecisionRequest,
    _workload: AuthenticatedWorkload = Depends(verify_workload_access_token),
    principal: AuthenticatedPrincipal = Depends(verify_access_token),
    session: Session = Depends(get_authorization_session),
) -> InternalAuthorizationDecisionResponse:
    authorized = authorize_organization_membership(
        decision.organization_id,
        principal,
        session,
        permitted_roles=permitted_roles_for_operation(decision.operation),
    )
    return InternalAuthorizationDecisionResponse(
        organization_id=authorized.organization_id,
        operation=decision.operation,
        allowed=True,
        actor_id=authorized.user_id,
    )


app.include_router(api_router)
app.include_router(internal_router)