import os
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from decimal import Decimal
from threading import Barrier, BrokenBarrierError
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app import database, main
from app.models import Lease, RentSchedule
from app.schemas import RentScheduleCreateRequest, RentScheduleUpdateRequest
from app.security import AuthorizedOrganization


@pytest.fixture()
def postgres_session_factory() -> Generator[sessionmaker, None, None]:
    database_url = os.getenv("LEASE_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("LEASE_TEST_DATABASE_URL is not configured")

    url = make_url(database_url)
    if url.get_backend_name() != "postgresql":
        pytest.fail("LEASE_TEST_DATABASE_URL must point to PostgreSQL")
    url = url.set(drivername="postgresql+psycopg")

    admin_engine = database.create_engine(url)
    schema = f"c2_schedule_test_{uuid4().hex}"
    scoped_engine = None
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        scoped_engine = database.create_engine(
            url,
            connect_args={"options": f"-csearch_path={schema}"},
            pool_size=4,
            max_overflow=0,
        )
        database.Base.metadata.create_all(scoped_engine)
        yield sessionmaker(bind=scoped_engine, expire_on_commit=False)
    finally:
        if scoped_engine is not None:
            scoped_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()


@pytest.mark.parametrize("write_mode", ["create", "activate"])
def test_concurrent_active_overlapping_schedules_serialize_on_lease_row(
    postgres_session_factory, monkeypatch, write_mode
):
    organization_id = uuid4()
    lease_id = uuid4()
    with postgres_session_factory.begin() as session:
        session.add(
            Lease(
                id=lease_id,
                organization_id=organization_id,
                lease_reference=f"CONCURRENCY-{lease_id}",
                start_date=date(2026, 1, 1),
                expiry_date=date(2031, 12, 31),
                break_date=None,
                rent_amount=Decimal("1000.00"),
                currency="GBP",
                payment_frequency="monthly",
                status="active",
            )
        )
        schedule_ids = [uuid4(), uuid4()]
        if write_mode == "activate":
            session.add_all(
                RentSchedule(
                    id=schedule_id,
                    organization_id=organization_id,
                    lease_id=lease_id,
                    charge_category="service_charge",
                    description="Draft service charge",
                    amount_per_period=Decimal("125.00"),
                    payment_frequency="monthly",
                    start_date=date(2026, 4, 1),
                    end_date=date(2026, 6, 30),
                    due_day=1,
                    short_month_rule="clamp_to_month_end",
                    status="draft",
                    manual_review_reasons=[],
                )
                for schedule_id in schedule_ids
            )

    original_conflict_check = main._active_schedule_conflict
    simultaneous_checks = Barrier(2, timeout=1)

    def synchronize_conflict_checks(session, schedule, **kwargs):
        conflict = original_conflict_check(session, schedule, **kwargs)
        if not conflict:
            try:
                simultaneous_checks.wait()
            except BrokenBarrierError:
                pass
        return conflict

    monkeypatch.setattr(
        main, "_active_schedule_conflict", synchronize_conflict_checks
    )
    start_requests = Barrier(2, timeout=5)
    authorization = AuthorizedOrganization(
        organization_id=organization_id,
        actor_id=uuid4(),
    )

    def write_schedule(index):
        with postgres_session_factory() as session:
            connection_pid = session.scalar(select(func.pg_backend_pid()))
            start_requests.wait()
            try:
                if write_mode == "create":
                    main.create_rent_schedule(
                        organization_id,
                        lease_id,
                        RentScheduleCreateRequest(
                            charge_category="service_charge",
                            description="Concurrent service charge",
                            amount_per_period="125.00",
                            payment_frequency="monthly",
                            start_date=date(2026, 4, 1),
                            end_date=date(2026, 6, 30),
                            due_day=1,
                            short_month_rule="clamp_to_month_end",
                            status="active",
                        ),
                        authorization,
                        session,
                    )
                    return connection_pid, 201
                main.update_rent_schedule(
                    organization_id,
                    lease_id,
                    schedule_ids[index],
                    RentScheduleUpdateRequest(status="active"),
                    authorization,
                    session,
                )
                return connection_pid, 200
            except HTTPException as error:
                return connection_pid, error.status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(write_schedule, range(2)))

    assert len({connection_pid for connection_pid, _ in results}) == 2
    success_status = 201 if write_mode == "create" else 200
    assert sorted(status for _, status in results) == [success_status, 409]
    with postgres_session_factory() as session:
        assert (
            session.scalar(
                select(func.count(RentSchedule.id)).where(
                    RentSchedule.organization_id == organization_id,
                    RentSchedule.lease_id == lease_id,
                    RentSchedule.charge_category == "service_charge",
                    RentSchedule.status == "active",
                )
            )
            == 1
        )
