from collections.abc import Generator
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import and_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import database
from app.authorization import (
    AuthorizationDependencyUnavailable,
    AuthorizedOrganization,
    CREATE_BUILDING_OPERATION,
    CREATE_OPERATION,
    CREATE_SITE_OPERATION,
    CREATE_UNIT_OPERATION,
    OrganizationAccessDenied,
    UPDATE_OPERATION,
    UPDATE_BUILDING_OPERATION,
    UPDATE_SITE_OPERATION,
    UPDATE_UNIT_OPERATION,
    UserAuthenticationRequired,
    get_authorization_workload_token,
    get_authorized_organization,
    get_building_write_permissions,
    get_portfolio_write_permissions,
    get_site_write_permissions,
    get_unit_write_permissions,
    get_user_bearer_token,
    write_authorization,
)
from app.config import SERVICE_NAME
from app.models import (
    BuildingAuditEvent,
    Building,
    Portfolio,
    PortfolioAuditEvent,
    Site,
    SiteAuditEvent,
    Unit,
    UnitAuditEvent,
)
from app.schemas import (
    BuildingUpdateRequest,
    BuildingResponse,
    BuildingWritePermissionsResponse,
    BuildingWriteRequest,
    PortfolioResponse,
    PortfolioUpdateRequest,
    PortfolioWritePermissionsResponse,
    PortfolioWriteRequest,
    SiteUpdateRequest,
    SiteResponse,
    SiteWritePermissionsResponse,
    SiteWriteRequest,
    UnitResponse,
    UnitUpdateRequest,
    UnitWritePermissionsResponse,
    UnitWriteRequest,
)

app = FastAPI(title="BOWERA Property & Asset Registry", version="0.1.0")
api_router = APIRouter(prefix="/api/v1")
app.include_router(api_router)


class PropertyDatabaseUnavailable(Exception):
    pass


_create_portfolio_authorization = write_authorization(CREATE_OPERATION)
_update_portfolio_authorization = write_authorization(UPDATE_OPERATION)
_create_site_authorization = write_authorization(CREATE_SITE_OPERATION)
_update_site_authorization = write_authorization(UPDATE_SITE_OPERATION)
_create_building_authorization = write_authorization(CREATE_BUILDING_OPERATION)
_update_building_authorization = write_authorization(UPDATE_BUILDING_OPERATION)
_create_unit_authorization = write_authorization(CREATE_UNIT_OPERATION)
_update_unit_authorization = write_authorization(UPDATE_UNIT_OPERATION)


def get_portfolio_session() -> Generator[Session, None, None]:
    if database.SessionLocal is None:
        raise PropertyDatabaseUnavailable
    try:
        with database.SessionLocal() as session:
            yield session
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None


@app.exception_handler(UserAuthenticationRequired)
async def user_authentication_required_handler(
    request: Request, error: UserAuthenticationRequired
) -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={
            "error": {
                "code": "unauthorized",
                "message": "Authentication required",
            }
        },
        headers={"WWW-Authenticate": "Bearer"},
    )


@app.exception_handler(OrganizationAccessDenied)
async def organization_access_denied_handler(
    request: Request, error: OrganizationAccessDenied
) -> JSONResponse:
    return JSONResponse(
        status_code=403,
        content={
            "error": {
                "code": "forbidden",
                "message": "Organization access denied",
            }
        },
    )


@app.exception_handler(AuthorizationDependencyUnavailable)
async def authorization_dependency_unavailable_handler(
    request: Request, error: AuthorizationDependencyUnavailable
) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": {
                "code": "authorization_unavailable",
                "message": "Authorization service unavailable",
            }
        },
    )


@app.exception_handler(PropertyDatabaseUnavailable)
async def database_not_configured_handler(
    request: Request, error: PropertyDatabaseUnavailable
) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": {
                "code": "service_unavailable",
                "message": "Property service unavailable",
            }
        },
    )


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(
    request: Request, error: RequestValidationError
) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"detail": "Invalid request."},
    )


@app.get("/health")
def health():
    return {"status": "ok", "service": SERVICE_NAME}


@api_router.get("/portfolios", response_model=list[PortfolioResponse])
def list_portfolios(
    organization_id: UUID,
    _authorization: AuthorizedOrganization = Depends(get_authorized_organization),
    session: Session = Depends(get_portfolio_session),
):
    if _authorization.organization_id != organization_id:
        raise AuthorizationDependencyUnavailable

    try:
        portfolios = session.scalars(
            select(Portfolio).where(
                Portfolio.organization_id == _authorization.organization_id
            )
        ).all()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None

    return portfolios


@api_router.get("/portfolios/{portfolio_id}", response_model=PortfolioResponse)
def get_portfolio(
    portfolio_id: UUID,
    organization_id: UUID,
    _authorization: AuthorizedOrganization = Depends(get_authorized_organization),
    session: Session = Depends(get_portfolio_session),
):
    if _authorization.organization_id != organization_id:
        raise AuthorizationDependencyUnavailable

    try:
        portfolio = session.scalar(
            select(Portfolio).where(
                Portfolio.id == portfolio_id,
                Portfolio.organization_id == _authorization.organization_id,
            )
        )
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None

    if portfolio is None:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    return portfolio


@api_router.get(
    "/portfolio-write-permissions",
    response_model=PortfolioWritePermissionsResponse,
)
def portfolio_write_permissions(
    organization_id: UUID = Query(...),
    user_token: str = Depends(get_user_bearer_token),
    workload_token: str = Depends(get_authorization_workload_token),
):
    return get_portfolio_write_permissions(
        organization_id,
        user_token,
        workload_token,
    )


@api_router.get(
    "/site-write-permissions",
    response_model=SiteWritePermissionsResponse,
)
def site_write_permissions(
    organization_id: UUID = Query(...),
    user_token: str = Depends(get_user_bearer_token),
    workload_token: str = Depends(get_authorization_workload_token),
):
    return get_site_write_permissions(
        organization_id,
        user_token,
        workload_token,
    )


@api_router.get(
    "/building-write-permissions",
    response_model=BuildingWritePermissionsResponse,
)
def building_write_permissions(
    organization_id: UUID = Query(...),
    user_token: str = Depends(get_user_bearer_token),
    workload_token: str = Depends(get_authorization_workload_token),
):
    return get_building_write_permissions(
        organization_id,
        user_token,
        workload_token,
    )


@api_router.get(
    "/unit-write-permissions",
    response_model=UnitWritePermissionsResponse,
)
def unit_write_permissions(
    organization_id: UUID = Query(...),
    user_token: str = Depends(get_user_bearer_token),
    workload_token: str = Depends(get_authorization_workload_token),
):
    return get_unit_write_permissions(organization_id, user_token, workload_token)


@api_router.post(
    "/portfolios",
    response_model=PortfolioResponse,
    status_code=201,
)
def create_portfolio(
    payload: PortfolioWriteRequest,
    _authorization: AuthorizedOrganization = Depends(
        _create_portfolio_authorization
    ),
    session: Session = Depends(get_portfolio_session),
) -> Portfolio:
    try:
        with session.begin():
            portfolio = Portfolio(
                organization_id=_authorization.organization_id,
                name=payload.name,
                status=payload.status,
            )
            session.add(portfolio)
            session.flush()
            session.add(
                PortfolioAuditEvent(
                    organization_id=_authorization.organization_id,
                    portfolio_id=portfolio.id,
                    operation=CREATE_OPERATION,
                    actor_id=_authorization.actor_id,
                    changed_fields=["name", "status"],
                )
            )
            session.flush()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None
    return portfolio


@api_router.patch(
    "/portfolios/{portfolio_id}",
    response_model=PortfolioResponse,
)
def update_portfolio(
    portfolio_id: UUID,
    payload: PortfolioUpdateRequest,
    _authorization: AuthorizedOrganization = Depends(
        _update_portfolio_authorization
    ),
    session: Session = Depends(get_portfolio_session),
) -> Portfolio:
    updates = payload.model_dump(exclude_unset=True)
    try:
        with session.begin():
            portfolio = session.scalar(
                select(Portfolio).where(
                    Portfolio.id == portfolio_id,
                    Portfolio.organization_id == _authorization.organization_id,
                )
            )
            if portfolio is None:
                raise HTTPException(status_code=404, detail="Portfolio not found")

            changed_fields = sorted(
                field
                for field, value in updates.items()
                if value != getattr(portfolio, field)
            )
            for field, value in updates.items():
                setattr(portfolio, field, value)
            portfolio.updated_at = datetime.now(UTC)
            session.add(
                PortfolioAuditEvent(
                    organization_id=_authorization.organization_id,
                    portfolio_id=portfolio.id,
                    operation=UPDATE_OPERATION,
                    actor_id=_authorization.actor_id,
                    changed_fields=changed_fields,
                )
            )
            session.flush()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None
    return portfolio


@api_router.post(
    "/sites",
    response_model=SiteResponse,
    status_code=201,
)
def create_site(
    payload: SiteWriteRequest,
    _authorization: AuthorizedOrganization = Depends(_create_site_authorization),
    session: Session = Depends(get_portfolio_session),
) -> Site:
    try:
        with session.begin():
            portfolio_exists = session.scalar(
                select(Portfolio.id).where(
                    Portfolio.id == payload.portfolio_id,
                    Portfolio.organization_id == _authorization.organization_id,
                )
            )
            if portfolio_exists is None:
                raise HTTPException(status_code=404, detail="Asset not found")

            site = Site(
                organization_id=_authorization.organization_id,
                portfolio_id=payload.portfolio_id,
                name=payload.name,
                address=payload.address,
                status=payload.status,
            )
            session.add(site)
            session.flush()
            session.add(
                SiteAuditEvent(
                    organization_id=_authorization.organization_id,
                    site_id=site.id,
                    operation=CREATE_SITE_OPERATION,
                    actor_id=_authorization.actor_id,
                    changed_fields=["address", "name", "status"],
                )
            )
            session.flush()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None
    return site


@api_router.patch(
    "/sites/{site_id}",
    response_model=SiteResponse,
)
def update_site(
    site_id: UUID,
    payload: SiteUpdateRequest,
    _authorization: AuthorizedOrganization = Depends(_update_site_authorization),
    session: Session = Depends(get_portfolio_session),
) -> Site:
    updates = payload.model_dump(exclude_unset=True)
    try:
        with session.begin():
            site = session.scalar(
                select(Site).where(
                    Site.id == site_id,
                    Site.organization_id == _authorization.organization_id,
                )
            )
            if site is None:
                raise HTTPException(status_code=404, detail="Asset not found")

            changed_fields = sorted(
                field
                for field, value in updates.items()
                if value != getattr(site, field)
            )
            for field, value in updates.items():
                setattr(site, field, value)
            site.updated_at = datetime.now(UTC)
            session.add(
                SiteAuditEvent(
                    organization_id=_authorization.organization_id,
                    site_id=site.id,
                    operation=UPDATE_SITE_OPERATION,
                    actor_id=_authorization.actor_id,
                    changed_fields=changed_fields,
                )
            )
            session.flush()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None
    return site


@api_router.post(
    "/buildings",
    response_model=BuildingResponse,
    status_code=201,
)
def create_building(
    payload: BuildingWriteRequest,
    _authorization: AuthorizedOrganization = Depends(
        _create_building_authorization
    ),
    session: Session = Depends(get_portfolio_session),
) -> Building:
    try:
        with session.begin():
            parent_exists = session.scalar(
                select(Site.id)
                .join(
                    Portfolio,
                    and_(
                        Site.portfolio_id == Portfolio.id,
                        Site.organization_id == Portfolio.organization_id,
                    ),
                )
                .where(
                    Site.id == payload.site_id,
                    Site.portfolio_id == payload.portfolio_id,
                    Site.organization_id == _authorization.organization_id,
                    Portfolio.id == payload.portfolio_id,
                    Portfolio.organization_id == _authorization.organization_id,
                )
            )
            if parent_exists is None:
                raise HTTPException(status_code=404, detail="Asset not found")

            building = Building(
                organization_id=_authorization.organization_id,
                site_id=payload.site_id,
                name=payload.name,
                building_code=payload.building_code,
                address=payload.address,
                status=payload.status,
            )
            session.add(building)
            session.flush()
            session.add(
                BuildingAuditEvent(
                    organization_id=_authorization.organization_id,
                    building_id=building.id,
                    operation=CREATE_BUILDING_OPERATION,
                    actor_id=_authorization.actor_id,
                    changed_fields=[
                        "address",
                        "building_code",
                        "name",
                        "status",
                    ],
                )
            )
            session.flush()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None
    return building


@api_router.patch(
    "/buildings/{building_id}",
    response_model=BuildingResponse,
)
def update_building(
    building_id: UUID,
    portfolio_id: UUID,
    site_id: UUID,
    payload: BuildingUpdateRequest,
    _authorization: AuthorizedOrganization = Depends(
        _update_building_authorization
    ),
    session: Session = Depends(get_portfolio_session),
) -> Building:
    updates = payload.model_dump(exclude_unset=True)
    try:
        with session.begin():
            building = session.scalar(
                select(Building)
                .join(
                    Site,
                    and_(
                        Building.site_id == Site.id,
                        Building.organization_id == Site.organization_id,
                    ),
                )
                .join(
                    Portfolio,
                    and_(
                        Site.portfolio_id == Portfolio.id,
                        Site.organization_id == Portfolio.organization_id,
                    ),
                )
                .where(
                    Building.id == building_id,
                    Building.site_id == site_id,
                    Building.organization_id == _authorization.organization_id,
                    Site.id == site_id,
                    Site.portfolio_id == portfolio_id,
                    Site.organization_id == _authorization.organization_id,
                    Portfolio.id == portfolio_id,
                    Portfolio.organization_id == _authorization.organization_id,
                )
            )
            if building is None:
                raise HTTPException(status_code=404, detail="Asset not found")

            changed_fields = sorted(
                field
                for field, value in updates.items()
                if value != getattr(building, field)
            )
            for field, value in updates.items():
                setattr(building, field, value)
            building.updated_at = datetime.now(UTC)
            session.add(
                BuildingAuditEvent(
                    organization_id=_authorization.organization_id,
                    building_id=building.id,
                    operation=UPDATE_BUILDING_OPERATION,
                    actor_id=_authorization.actor_id,
                    changed_fields=changed_fields,
                )
            )
            session.flush()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None
    return building


@api_router.post("/units", response_model=UnitResponse, status_code=201)
def create_unit(
    payload: UnitWriteRequest,
    _authorization: AuthorizedOrganization = Depends(_create_unit_authorization),
    session: Session = Depends(get_portfolio_session),
) -> Unit:
    try:
        with session.begin():
            parent_exists = session.scalar(
                select(Building.id)
                .join(
                    Site,
                    and_(
                        Building.site_id == Site.id,
                        Building.organization_id == Site.organization_id,
                    ),
                )
                .join(
                    Portfolio,
                    and_(
                        Site.portfolio_id == Portfolio.id,
                        Site.organization_id == Portfolio.organization_id,
                    ),
                )
                .where(
                    Building.id == payload.building_id,
                    Building.site_id == payload.site_id,
                    Building.organization_id == _authorization.organization_id,
                    Site.id == payload.site_id,
                    Site.portfolio_id == payload.portfolio_id,
                    Site.organization_id == _authorization.organization_id,
                    Portfolio.id == payload.portfolio_id,
                    Portfolio.organization_id == _authorization.organization_id,
                )
            )
            if parent_exists is None:
                raise HTTPException(status_code=404, detail="Asset not found")

            unit = Unit(
                organization_id=_authorization.organization_id,
                building_id=payload.building_id,
                name=payload.name,
                unit_code=payload.unit_code,
                floor=payload.floor,
                area_sqm=payload.area_sqm,
                status=payload.status,
            )
            session.add(unit)
            session.flush()
            session.add(
                UnitAuditEvent(
                    organization_id=_authorization.organization_id,
                    unit_id=unit.id,
                    operation=CREATE_UNIT_OPERATION,
                    actor_id=_authorization.actor_id,
                    changed_fields=[
                        "area_sqm",
                        "floor",
                        "name",
                        "status",
                        "unit_code",
                    ],
                )
            )
            session.flush()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None
    return unit


@api_router.patch("/units/{unit_id}", response_model=UnitResponse)
def update_unit(
    unit_id: UUID,
    portfolio_id: UUID,
    site_id: UUID,
    building_id: UUID,
    payload: UnitUpdateRequest,
    _authorization: AuthorizedOrganization = Depends(_update_unit_authorization),
    session: Session = Depends(get_portfolio_session),
) -> Unit:
    updates = payload.model_dump(exclude_unset=True)
    try:
        with session.begin():
            unit = session.scalar(
                select(Unit)
                .join(
                    Building,
                    and_(
                        Unit.building_id == Building.id,
                        Unit.organization_id == Building.organization_id,
                    ),
                )
                .join(
                    Site,
                    and_(
                        Building.site_id == Site.id,
                        Building.organization_id == Site.organization_id,
                    ),
                )
                .join(
                    Portfolio,
                    and_(
                        Site.portfolio_id == Portfolio.id,
                        Site.organization_id == Portfolio.organization_id,
                    ),
                )
                .where(
                    Unit.id == unit_id,
                    Unit.building_id == building_id,
                    Unit.organization_id == _authorization.organization_id,
                    Building.id == building_id,
                    Building.site_id == site_id,
                    Building.organization_id == _authorization.organization_id,
                    Site.id == site_id,
                    Site.portfolio_id == portfolio_id,
                    Site.organization_id == _authorization.organization_id,
                    Portfolio.id == portfolio_id,
                    Portfolio.organization_id == _authorization.organization_id,
                )
            )
            if unit is None:
                raise HTTPException(status_code=404, detail="Asset not found")

            changed_fields = sorted(
                field
                for field, value in updates.items()
                if value != getattr(unit, field)
            )
            for field, value in updates.items():
                setattr(unit, field, value)
            unit.updated_at = datetime.now(UTC)
            session.add(
                UnitAuditEvent(
                    organization_id=_authorization.organization_id,
                    unit_id=unit.id,
                    operation=UPDATE_UNIT_OPERATION,
                    actor_id=_authorization.actor_id,
                    changed_fields=changed_fields,
                )
            )
            session.flush()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None
    return unit


@api_router.get(
    "/portfolios/{portfolio_id}/sites",
    response_model=list[SiteResponse],
)
def list_sites(
    portfolio_id: UUID,
    organization_id: UUID,
    _authorization: AuthorizedOrganization = Depends(get_authorized_organization),
    session: Session = Depends(get_portfolio_session),
):
    if _authorization.organization_id != organization_id:
        raise AuthorizationDependencyUnavailable

    try:
        portfolio_exists = session.scalar(
            select(Portfolio.id).where(
                Portfolio.id == portfolio_id,
                Portfolio.organization_id == _authorization.organization_id,
            )
        )
        if portfolio_exists is None:
            raise HTTPException(status_code=404, detail="Asset not found")
        return session.scalars(
            select(Site).where(
                Site.portfolio_id == portfolio_id,
                Site.organization_id == _authorization.organization_id,
            )
        ).all()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None


@api_router.get(
    "/portfolios/{portfolio_id}/sites/{site_id}",
    response_model=SiteResponse,
)
def get_site(
    portfolio_id: UUID,
    site_id: UUID,
    organization_id: UUID,
    _authorization: AuthorizedOrganization = Depends(get_authorized_organization),
    session: Session = Depends(get_portfolio_session),
):
    if _authorization.organization_id != organization_id:
        raise AuthorizationDependencyUnavailable

    try:
        site = session.scalar(
            select(Site).where(
                Site.id == site_id,
                Site.portfolio_id == portfolio_id,
                Site.organization_id == _authorization.organization_id,
            )
        )
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None

    if site is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    return site


@api_router.get(
    "/portfolios/{portfolio_id}/sites/{site_id}/buildings",
    response_model=list[BuildingResponse],
)
def list_buildings(
    portfolio_id: UUID,
    site_id: UUID,
    organization_id: UUID,
    _authorization: AuthorizedOrganization = Depends(get_authorized_organization),
    session: Session = Depends(get_portfolio_session),
):
    if _authorization.organization_id != organization_id:
        raise AuthorizationDependencyUnavailable

    try:
        site_exists = session.scalar(
            select(Site.id).where(
                Site.id == site_id,
                Site.portfolio_id == portfolio_id,
                Site.organization_id == _authorization.organization_id,
            )
        )
        if site_exists is None:
            raise HTTPException(status_code=404, detail="Asset not found")
        return session.scalars(
            select(Building)
            .join(
                Site,
                and_(
                    Building.site_id == Site.id,
                    Building.organization_id == Site.organization_id,
                ),
            )
            .where(
                Site.id == site_id,
                Site.portfolio_id == portfolio_id,
                Site.organization_id == _authorization.organization_id,
                Building.organization_id == _authorization.organization_id,
            )
        ).all()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None


@api_router.get(
    "/portfolios/{portfolio_id}/sites/{site_id}/buildings/{building_id}",
    response_model=BuildingResponse,
)
def get_building(
    portfolio_id: UUID,
    site_id: UUID,
    building_id: UUID,
    organization_id: UUID,
    _authorization: AuthorizedOrganization = Depends(get_authorized_organization),
    session: Session = Depends(get_portfolio_session),
):
    if _authorization.organization_id != organization_id:
        raise AuthorizationDependencyUnavailable

    try:
        building = session.scalar(
            select(Building)
            .join(
                Site,
                and_(
                    Building.site_id == Site.id,
                    Building.organization_id == Site.organization_id,
                ),
            )
            .where(
                Building.id == building_id,
                Building.site_id == site_id,
                Site.id == site_id,
                Site.portfolio_id == portfolio_id,
                Site.organization_id == _authorization.organization_id,
                Building.organization_id == _authorization.organization_id,
            )
        )
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None

    if building is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    return building


@api_router.get(
    "/portfolios/{portfolio_id}/sites/{site_id}/buildings/{building_id}/units",
    response_model=list[UnitResponse],
)
def list_units(
    portfolio_id: UUID,
    site_id: UUID,
    building_id: UUID,
    organization_id: UUID,
    _authorization: AuthorizedOrganization = Depends(get_authorized_organization),
    session: Session = Depends(get_portfolio_session),
):
    if _authorization.organization_id != organization_id:
        raise AuthorizationDependencyUnavailable

    try:
        building_exists = session.scalar(
            select(Building.id)
            .join(
                Site,
                and_(
                    Building.site_id == Site.id,
                    Building.organization_id == Site.organization_id,
                ),
            )
            .where(
                Building.id == building_id,
                Building.site_id == site_id,
                Building.organization_id == _authorization.organization_id,
                Site.id == site_id,
                Site.portfolio_id == portfolio_id,
                Site.organization_id == _authorization.organization_id,
            )
        )
        if building_exists is None:
            raise HTTPException(status_code=404, detail="Asset not found")
        return session.scalars(
            select(Unit)
            .join(
                Building,
                and_(
                    Unit.building_id == Building.id,
                    Unit.organization_id == Building.organization_id,
                ),
            )
            .join(
                Site,
                and_(
                    Building.site_id == Site.id,
                    Building.organization_id == Site.organization_id,
                ),
            )
            .where(
                Unit.building_id == building_id,
                Unit.organization_id == _authorization.organization_id,
                Building.site_id == site_id,
                Site.id == site_id,
                Site.portfolio_id == portfolio_id,
                Site.organization_id == _authorization.organization_id,
            )
        ).all()
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None


@api_router.get(
    "/portfolios/{portfolio_id}/sites/{site_id}/buildings/{building_id}/units/{unit_id}",
    response_model=UnitResponse,
)
def get_unit(
    portfolio_id: UUID,
    site_id: UUID,
    building_id: UUID,
    unit_id: UUID,
    organization_id: UUID,
    _authorization: AuthorizedOrganization = Depends(get_authorized_organization),
    session: Session = Depends(get_portfolio_session),
):
    if _authorization.organization_id != organization_id:
        raise AuthorizationDependencyUnavailable

    try:
        unit = session.scalar(
            select(Unit)
            .join(
                Building,
                and_(
                    Unit.building_id == Building.id,
                    Unit.organization_id == Building.organization_id,
                ),
            )
            .join(
                Site,
                and_(
                    Building.site_id == Site.id,
                    Building.organization_id == Site.organization_id,
                ),
            )
            .where(
                Unit.id == unit_id,
                Unit.building_id == building_id,
                Unit.organization_id == _authorization.organization_id,
                Building.site_id == site_id,
                Site.id == site_id,
                Site.portfolio_id == portfolio_id,
                Site.organization_id == _authorization.organization_id,
            )
        )
    except SQLAlchemyError:
        raise PropertyDatabaseUnavailable from None

    if unit is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    return unit