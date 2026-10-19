from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app import database
from app.auth import AuthenticationConfigurationError, AuthenticationFailure
from app.authorization import AuthorizationDenied, AuthorizationServiceUnavailable
from app.config import SERVICE_NAME
from app.schemas import APIErrorResponse

API_V1_PREFIX = "/api/v1"

app = FastAPI(title="BOWERA Organization & Access", version="0.1.0")
api_router = APIRouter(prefix=API_V1_PREFIX)
app.include_router(api_router)


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