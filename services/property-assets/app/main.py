from collections.abc import Generator
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import and_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import database
from app.authorization import (
    AuthorizationDependencyUnavailable,
    AuthorizedOrganization,
    OrganizationAccessDenied,
    UserAuthenticationRequired,
    get_authorized_organization,
)
from app.config import SERVICE_NAME
from app.models import Building, Portfolio, Site, Unit
from app.schemas import (
    BuildingResponse,
    PortfolioResponse,
    SiteResponse,
    UnitResponse,
)

app = FastAPI(title="BOWERA Property & Asset Registry", version="0.1.0")
api_router = APIRouter(prefix="/api/v1")
app.include_router(api_router)


class PropertyDatabaseUnavailable(Exception):
    pass


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