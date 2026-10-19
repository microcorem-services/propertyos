from fastapi import FastAPI
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app import database
from app.config import SERVICE_NAME

app = FastAPI(title="BOWERA Organization & Access", version="0.1.0")


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