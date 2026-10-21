import os
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from decimal import Decimal
from threading import Barrier
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import selectinload, sessionmaker

from app import database, main
from app.models import (
    Invoice,
    InvoiceAuditEvent,
    InvoiceLine,
    Lease,
    PaymentAllocation,
)
from app.schemas import PaymentCreateRequest
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
    schema = f"c3_financial_test_{uuid4().hex}"
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


def seed_financial_records(factory):
    organization_id = uuid4()
    lease_id = uuid4()
    invoice_id = uuid4()
    with factory.begin() as session:
        lease = Lease(
            id=lease_id,
            organization_id=organization_id,
            lease_reference=f"PAY-{lease_id}",
            start_date=date(2025, 1, 1),
            expiry_date=date(2030, 12, 31),
            break_date=None,
            rent_amount=Decimal("100.00"),
            currency="GBP",
            payment_frequency="monthly",
            status="active",
        )
        invoice = Invoice(
            id=invoice_id,
            organization_id=organization_id,
            lease_id=lease_id,
            invoice_number=f"INV-{invoice_id}",
            issue_date=date(2025, 1, 1),
            due_date=date(2025, 1, 31),
            currency="GBP",
            subtotal=Decimal("100.00"),
            total=Decimal("100.00"),
            status="draft",
        )
        invoice.lines.append(
            InvoiceLine(
                organization_id=organization_id,
                description="Scheduled charge",
                quantity=Decimal("1.000"),
                unit_amount=Decimal("100.00"),
                line_total=Decimal("100.00"),
            )
        )
        session.add(lease)
        session.flush()
        session.add(invoice)
    return organization_id, lease_id, invoice_id


def test_concurrent_payment_allocations_cannot_overpay_invoice(
    postgres_session_factory,
):
    organization_id, _, invoice_id = seed_financial_records(postgres_session_factory)
    with postgres_session_factory.begin() as session:
        invoice = session.get(Invoice, invoice_id)
        invoice.status = "issued"
        invoice.issued_at = datetime.now(timezone.utc)
        invoice.audit_events.append(
            InvoiceAuditEvent(
                organization_id=organization_id,
                actor_id=uuid4(),
                event_type="issued",
                changed_fields=["status"],
            )
        )

    gate = Barrier(2, timeout=5)
    authorization = AuthorizedOrganization(organization_id, uuid4())

    def record_payment(_):
        with postgres_session_factory() as session:
            connection_pid = session.scalar(select(func.pg_backend_pid()))
            payload = PaymentCreateRequest(
                idempotency_key=uuid4(),
                reference=f"PAY-{uuid4()}",
                received_on=date(2025, 2, 1),
                currency="GBP",
                amount=Decimal("70.00"),
                method_description="Manual receipt record",
                allocations=[{"invoice_id": invoice_id, "amount": "70.00"}],
            )
            gate.wait()
            try:
                main.create_payment(
                    organization_id,
                    payload,
                    authorization,
                    session,
                )
                return connection_pid, 201
            except HTTPException as error:
                return connection_pid, error.status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(record_payment, range(2)))
    assert len({pid for pid, _ in results}) == 2
    assert sorted(status for _, status in results) == [201, 409]
    with postgres_session_factory() as session:
        allocated = session.scalar(
            select(func.sum(PaymentAllocation.amount)).where(
                PaymentAllocation.invoice_id == invoice_id,
                PaymentAllocation.organization_id == organization_id,
            )
        )
        assert allocated == Decimal("70.00")


def test_concurrent_identical_payment_retries_return_the_same_payment(
    postgres_session_factory,
):
    organization_id, _, invoice_id = seed_financial_records(postgres_session_factory)
    with postgres_session_factory.begin() as session:
        invoice = session.get(Invoice, invoice_id)
        invoice.status = "issued"
        invoice.issued_at = datetime.now(timezone.utc)
        invoice.audit_events.append(
            InvoiceAuditEvent(
                organization_id=organization_id,
                actor_id=uuid4(),
                event_type="issued",
                changed_fields=["status"],
            )
        )

    gate = Barrier(2, timeout=5)
    authorization = AuthorizedOrganization(organization_id, uuid4())
    idempotency_key = uuid4()

    def record_payment(_):
        with postgres_session_factory() as session:
            connection_pid = session.scalar(select(func.pg_backend_pid()))
            payload = PaymentCreateRequest(
                idempotency_key=idempotency_key,
                reference="PAY-IDEMPOTENT",
                received_on=date(2025, 2, 1),
                currency="GBP",
                amount=Decimal("70.00"),
                method_description="Manual receipt record",
                allocations=[{"invoice_id": invoice_id, "amount": "70.00"}],
            )
            gate.wait()
            result = main.create_payment(
                organization_id,
                payload,
                authorization,
                session,
            )
            return connection_pid, result.id

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(record_payment, range(2)))
    assert len({pid for pid, _ in results}) == 2
    assert results[0][1] == results[1][1]
    with postgres_session_factory() as session:
        assert session.scalar(select(func.count(Payment.id))) == 1
        allocated = session.scalar(
            select(func.sum(PaymentAllocation.amount)).where(
                PaymentAllocation.invoice_id == invoice_id,
                PaymentAllocation.organization_id == organization_id,
            )
        )
        assert allocated == Decimal("70.00")


def test_concurrent_invoice_issue_transitions_only_once(postgres_session_factory):
    organization_id, _, invoice_id = seed_financial_records(postgres_session_factory)
    gate = Barrier(2, timeout=5)
    authorization = AuthorizedOrganization(organization_id, uuid4())

    def issue(_):
        with postgres_session_factory() as session:
            connection_pid = session.scalar(select(func.pg_backend_pid()))
            gate.wait()
            try:
                main.issue_invoice(
                    organization_id,
                    invoice_id,
                    authorization,
                    session,
                )
                return connection_pid, 200
            except HTTPException as error:
                return connection_pid, error.status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(issue, range(2)))
    assert len({pid for pid, _ in results}) == 2
    assert sorted(status for _, status in results) == [200, 409]
    with postgres_session_factory() as session:
        invoice = session.scalar(
            select(Invoice)
            .options(selectinload(Invoice.audit_events))
            .where(Invoice.id == invoice_id)
        )
        assert invoice.status == "issued"
        assert len([event for event in invoice.audit_events if event.event_type == "issued"]) == 1
