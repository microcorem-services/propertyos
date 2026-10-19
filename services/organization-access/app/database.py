from collections.abc import Generator

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import DATABASE_URL


class DatabaseNotConfiguredError(RuntimeError):
    pass


engine: Engine | None = (
    create_engine(DATABASE_URL, pool_pre_ping=True) if DATABASE_URL else None
)
SessionLocal = (
    sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    if engine is not None
    else None
)


def get_db() -> Generator[Session, None, None]:
    if SessionLocal is None:
        raise DatabaseNotConfiguredError("DATABASE_URL is not configured")

    with SessionLocal() as session:
        yield session
