from collections.abc import Generator
from uuid import uuid4

import pytest
from app.main import _database_session, app
from app.security import (
    AuthorizedOrganization,
    get_create_authorization,
    get_read_authorization,
    get_update_authorization,
    get_user_token,
)
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import database


@pytest.fixture()
def db_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _record):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    database.Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    yield factory
    database.Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture()
def client(db_factory) -> Generator[TestClient, None, None]:
    def session_dependency():
        session: Session = db_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides.clear()
    app.dependency_overrides[_database_session] = session_dependency
    app.dependency_overrides[get_user_token] = lambda: "header.payload.signature"
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def authorize(client: TestClient, organization_id, *, authorized_id=None):
    actor_id = uuid4()
    result = AuthorizedOrganization(
        organization_id=authorized_id or organization_id,
        actor_id=actor_id,
    )
    for dependency in (
        get_create_authorization,
        get_read_authorization,
        get_update_authorization,
    ):
        client.app.dependency_overrides[dependency] = lambda result=result: result
    return actor_id


@pytest.fixture()
def registry_ok(monkeypatch):
    from app import main

    def valid_unit(organization_id, reference, user_token):
        assert organization_id
        assert user_token == "header.payload.signature"
        return "active"

    monkeypatch.setattr(main, "validate_unit_reference", valid_unit)
