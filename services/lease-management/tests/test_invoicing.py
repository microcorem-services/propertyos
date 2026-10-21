from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import select

from app.models import Invoice, InvoiceAuditEvent, Payment
from app.security import AuthorizedOrganization


def authorize(client, organization_id, *, authorized_id=None):
    actor_id = uuid4()
    decision = AuthorizedOrganization(
        organization_id=authorized_id or organization_id,
        actor_id=actor_id,
    )
    from app import main

    for dependency in (
        main.get_create_authorization,
        main.get_read_authorization,
        main.get_update_authorization,
    ):
        client.app.dependency_overrides[dependency] = lambda decision=decision: decision
    return actor_id


def make_lease(client, organization_id, registry_ok):
    authorize(client, organization_id)
    payload = {
        "lease_reference": f"INV-{uuid4().hex[:8]}",
        "start_date": "2025-01-01",
        "expiry_date": "2030-12-31",
        "break_date": None,
        "rent_amount": "1000.00",
        "currency": "GBP",
        "payment_frequency": "monthly",
        "status": "active",
        "units": [
            {
                "portfolio_id": str(uuid4()),
                "site_id": str(uuid4()),
                "building_id": str(uuid4()),
                "unit_id": str(uuid4()),
            }
        ],
        "parties": [
            {"legal_name": "Owner Ltd", "role": "landlord", "party_type": "organization"},
            {"legal_name": "Tenant Ltd", "role": "tenant", "party_type": "organization"},
        ],
    }
    response = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=payload,
        headers={"Authorization": "header.payload.signature"},
    )
    assert response.status_code == 201
    return response.json()


def invoice_payload(lease_id, invoice_number="INV-TEST-001", **overrides):
    return {
        "lease_id": lease_id,
        "invoice_number": invoice_number,
        "issue_date": "2026-01-01",
        "due_date": "2026-01-31",
        "currency": "GBP",
        "lines": [
            {
                "description": "Professional services",
                "quantity": "1.125",
                "unit_amount": "12.34",
            }
        ],
        **overrides,
    }


def payment_payload(invoice_id, *, amount="10.00", allocation="10.00", **overrides):
    return {
        "idempotency_key": str(uuid4()),
        "reference": f"RECEIPT-{uuid4().hex[:8]}",
        "received_on": "2026-02-01",
        "currency": "GBP",
        "amount": amount,
        "method_description": "Manual bank transfer reference supplied by user",
        "allocations": [{"invoice_id": invoice_id, "amount": allocation}],
        **overrides,
    }


def create_invoice(client, organization_id, lease_id, *, status="issued"):
    response = client.post(
        f"/api/v1/organizations/{organization_id}/invoices",
        json=invoice_payload(lease_id),
    )
    assert response.status_code == 201, response.text
    invoice = response.json()
    assert invoice["total"] == "13.88"
    if status == "issued":
        response = client.post(
            f"/api/v1/organizations/{organization_id}/invoices/{invoice['id']}/issue",
            json={},
        )
        assert response.status_code == 200, response.text
        invoice = response.json()
    return invoice


def test_invoice_draft_rounding_issue_immutability_and_organization_isolation(
    client, db_factory, registry_ok
):
    organization_id = uuid4()
    lease = make_lease(client, organization_id, registry_ok)
    actor_id = authorize(client, organization_id)
    created = client.post(
        f"/api/v1/organizations/{organization_id}/invoices",
        json=invoice_payload(lease["id"]),
    )
    assert created.status_code == 201, created.text
    invoice = created.json()
    assert invoice["subtotal"] == "13.88"
    assert invoice["total"] == "13.88"
    assert invoice["lines"][0]["quantity"] == "1.125"
    assert invoice["lines"][0]["line_total"] == "13.88"
    assert invoice["audit_events"][0]["event_type"] == "created"
    assert invoice["receivable_status"] == "draft"

    updated = client.patch(
        f"/api/v1/organizations/{organization_id}/invoices/{invoice['id']}",
        json={"invoice_number": "INV-UPDATED"},
    )
    assert updated.status_code == 200
    assert updated.json()["invoice_number"] == "INV-UPDATED"
    issued = client.post(
        f"/api/v1/organizations/{organization_id}/invoices/{invoice['id']}/issue",
        json={},
    )
    assert issued.status_code == 200
    assert issued.json()["status"] == "issued"
    assert issued.json()["audit_events"][-1]["event_type"] == "issued"
    assert (
        client.patch(
            f"/api/v1/organizations/{organization_id}/invoices/{invoice['id']}",
            json={"invoice_number": "MUTATED"},
        ).status_code
        == 409
    )

    other_organization = uuid4()
    authorize(client, other_organization)
    hidden = client.get(
        f"/api/v1/organizations/{other_organization}/invoices/{invoice['id']}"
    )
    assert hidden.status_code == 404
    with db_factory() as session:
        stored = session.scalar(
            select(Invoice).where(Invoice.id == UUID(invoice["id"]))
        )
        assert stored.total == Decimal("13.88")
        assert [
            event.event_type for event in session.scalars(
                select(InvoiceAuditEvent).where(
                    InvoiceAuditEvent.invoice_id == stored.id
                )
            )
        ] == ["created", "updated", "issued"]


def test_invoice_number_is_unique_per_organization(client, registry_ok):
    organization_id = uuid4()
    lease = make_lease(client, organization_id, registry_ok)
    authorize(client, organization_id)
    payload = invoice_payload(lease["id"], invoice_number="DUPLICATE")
    assert client.post(
        f"/api/v1/organizations/{organization_id}/invoices", json=payload
    ).status_code == 201
    assert client.post(
        f"/api/v1/organizations/{organization_id}/invoices", json=payload
    ).status_code == 409


def test_source_installment_is_reserved_and_not_double_invoiced(client, registry_ok):
    organization_id = uuid4()
    lease = make_lease(client, organization_id, registry_ok)
    authorize(client, organization_id)
    base = f"/api/v1/organizations/{organization_id}/leases/{lease['id']}"
    schedule_payload = {
        "charge_category": "service_charge",
        "description": "Quarterly service charge",
        "amount_per_period": "250.00",
        "payment_frequency": "quarterly",
        "start_date": "2026-01-01",
        "end_date": "2026-12-31",
        "due_day": 1,
        "short_month_rule": "clamp_to_month_end",
        "status": "active",
    }
    schedule_response = client.post(
        f"{base}/rent-schedules", json=schedule_payload
    )
    assert schedule_response.status_code == 201, schedule_response.text
    schedule = schedule_response.json()
    installments = client.get(f"{base}/rent-schedules").json()[0]["installments"]
    selected = installments[0]
    lines = [
        {
            "description": "Quarterly service charge",
            "quantity": "1",
            "unit_amount": selected["amount"],
            "source_installment_id": selected["id"],
        }
    ]
    first = client.post(
        f"/api/v1/organizations/{organization_id}/invoices",
        json=invoice_payload(lease["id"], lines=lines),
    )
    assert first.status_code == 201, first.text
    duplicate = client.post(
        f"/api/v1/organizations/{organization_id}/invoices",
        json=invoice_payload(lease["id"], invoice_number="INV-OTHER", lines=lines),
    )
    assert duplicate.status_code == 409
    eligible = client.get(f"{base}/eligible-installments")
    assert eligible.status_code == 200
    assert selected["id"] not in {item["id"] for item in eligible.json()}
    assert schedule["status"] == "active"


def test_payment_partial_balance_overpayment_idempotency_currency_and_audit(
    client, db_factory, registry_ok
):
    organization_id = uuid4()
    lease = make_lease(client, organization_id, registry_ok)
    authorize(client, organization_id)
    invoice = create_invoice(client, organization_id, lease["id"])
    url = f"/api/v1/organizations/{organization_id}/payments"
    payload = payment_payload(invoice["id"], amount="4.00", allocation="4.00")
    first = client.post(url, json=payload)
    assert first.status_code == 201, first.text
    payment = first.json()
    assert payment["amount"] == "4.00"
    assert payment["audit_events"][0]["event_type"] == "recorded"
    repeated = client.post(url, json=payload)
    assert repeated.status_code == 201
    assert repeated.json()["id"] == payment["id"]
    detail = client.get(
        f"/api/v1/organizations/{organization_id}/invoices/{invoice['id']}"
    ).json()
    assert detail["outstanding_balance"] == "9.88"
    assert detail["allocated_amount"] == "4.00"
    overpay = payment_payload(invoice["id"], amount="10.00", allocation="10.00")
    assert client.post(url, json=overpay).status_code == 409
    with db_factory() as session:
        assert session.scalar(
            select(Payment).where(Payment.id == UUID(payment["id"]))
        )


def test_payment_allocation_and_lease_receivables(client, registry_ok):
    organization_id = uuid4()
    lease = make_lease(client, organization_id, registry_ok)
    authorize(client, organization_id)
    invoice = create_invoice(client, organization_id, lease["id"])
    payment_url = f"/api/v1/organizations/{organization_id}/payments"
    payload = payment_payload(invoice["id"], amount="5.00", allocation="5.00")
    response = client.post(payment_url, json=payload)
    assert response.status_code == 201, response.text
    detail = client.get(
        f"/api/v1/organizations/{organization_id}/invoices/{invoice['id']}"
    ).json()
    assert detail["allocated_amount"] == "5.00"
    assert detail["outstanding_balance"] == "8.88"
    assert detail["receivable_status"] == "overdue"
    receivables = client.get(
        f"/api/v1/organizations/{organization_id}/leases/{lease['id']}/receivables"
    ).json()
    assert receivables["issued_total"] == "13.88"
    assert receivables["allocated_total"] == "5.00"
    assert receivables["outstanding_total"] == "8.88"
    assert receivables["overdue_total"] == "8.88"
    assert len(receivables["invoices"]) == 1

    overpayment = payment_payload(
        invoice["id"], amount="9.00", allocation="9.00"
    )
    assert client.post(payment_url, json=overpayment).status_code == 409
    mismatch = payment_payload(
        invoice["id"], amount="1.00", allocation="1.00", currency="USD"
    )
    assert client.post(payment_url, json=mismatch).status_code == 422


def test_receivable_filter_is_applied_before_invoice_pagination(client, registry_ok):
    organization_id = uuid4()
    lease = make_lease(client, organization_id, registry_ok)
    authorize(client, organization_id)
    overdue = create_invoice(client, organization_id, lease["id"])
    future = client.post(
        f"/api/v1/organizations/{organization_id}/invoices",
        json=invoice_payload(
            lease["id"],
            invoice_number="INV-FUTURE",
            issue_date="2098-01-01",
            due_date="2098-01-31",
        ),
    )
    assert future.status_code == 201, future.text
    future = client.post(
        f"/api/v1/organizations/{organization_id}/invoices/{future.json()['id']}/issue",
        json={},
    )
    assert future.status_code == 200, future.text

    filtered = client.get(
        f"/api/v1/organizations/{organization_id}/invoices",
        params={"receivable_status": "overdue", "limit": 1, "offset": 0},
    )
    assert filtered.status_code == 200, filtered.text
    assert [invoice["id"] for invoice in filtered.json()] == [overdue["id"]]


def test_cross_organization_authorization_is_denied(client, registry_ok):
    organization_id = uuid4()
    lease = make_lease(client, organization_id, registry_ok)
    authorize(client, organization_id, authorized_id=uuid4())
    response = client.post(
        f"/api/v1/organizations/{organization_id}/invoices",
        json=invoice_payload(lease["id"]),
    )
    assert response.status_code == 403
