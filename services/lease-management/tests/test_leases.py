from decimal import Decimal
from uuid import UUID, uuid4

from app.models import Lease, LeaseAuditEvent, LeaseParty, LeaseUnit
from app.security import AuthorizedOrganization, UnitReferenceInvalid, get_user_token
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app import main


def authorize(client, organization_id, *, authorized_id=None):
    actor_id = uuid4()
    result = AuthorizedOrganization(
        organization_id=authorized_id or organization_id,
        actor_id=actor_id,
    )
    for dependency in (
        main.get_create_authorization,
        main.get_read_authorization,
        main.get_update_authorization,
    ):
        client.app.dependency_overrides[dependency] = lambda result=result: result
    return actor_id


def lease_payload(unit_count=1):
    return {
        "lease_reference": "LEASE-2026-001",
        "start_date": "2026-04-01",
        "expiry_date": "2031-03-31",
        "break_date": "2029-03-31",
        "rent_amount": "12500.50",
        "currency": "GBP",
        "payment_frequency": "quarterly",
        "status": "active",
        "units": [
            {
                "portfolio_id": str(uuid4()),
                "site_id": str(uuid4()),
                "building_id": str(uuid4()),
                "unit_id": str(uuid4()),
            }
            for _ in range(unit_count)
        ],
        "parties": [
            {
                "legal_name": "Synthetic Property Owner Ltd",
                "role": "landlord",
                "party_type": "organization",
            },
            {
                "legal_name": "Synthetic Tenant One Ltd",
                "role": "tenant",
                "party_type": "organization",
            },
            {
                "legal_name": "Synthetic Tenant Two",
                "role": "tenant",
                "party_type": "individual",
            },
        ],
    }


def test_create_lease_persists_decimal_units_joint_tenants_and_audit(
    client, db_factory, registry_ok
):
    organization_id = uuid4()
    actor_id = authorize(client, organization_id)

    response = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(unit_count=2),
        headers={"Authorization": "Bearer header.payload.signature"},
    )

    assert response.status_code == 201
    data = response.json()
    assert data["organization_id"] == str(organization_id)
    assert data["rent_amount"] == "12500.50"
    assert len(data["units"]) == 2
    assert len([party for party in data["parties"] if party["role"] == "tenant"]) == 2
    assert len(data["audit_events"]) == 1
    assert data["audit_events"][0]["actor_id"] == str(actor_id)
    with db_factory() as session:
        lease = session.scalar(select(Lease).where(Lease.id == UUID(data["id"])))
        assert lease.rent_amount == Decimal("12500.50")
        assert session.scalar(
            select(LeaseAuditEvent).where(LeaseAuditEvent.lease_id == lease.id)
        )


def test_duplicate_reference_is_organization_scoped_conflict(
    client, db_factory, registry_ok
):
    organization_id = uuid4()
    authorize(client, organization_id)
    url = f"/api/v1/organizations/{organization_id}/leases"
    assert (
        client.post(
            url,
            json=lease_payload(),
            headers={"Authorization": "Bearer header.payload.signature"},
        ).status_code
        == 201
    )
    response = client.post(
        url,
        json=lease_payload(),
        headers={"Authorization": "Bearer header.payload.signature"},
    )

    assert response.status_code == 409
    other_organization = uuid4()
    authorize(client, other_organization)
    response = client.post(
        f"/api/v1/organizations/{other_organization}/leases",
        json=lease_payload(),
        headers={"Authorization": "Bearer header.payload.signature"},
    )
    assert response.status_code == 201
    with db_factory() as session:
        assert session.scalar(
            select(Lease).where(Lease.lease_reference == "LEASE-2026-001")
        )
        assert session.scalar(
            select(Lease).where(Lease.organization_id == other_organization)
        )


def test_list_leases_is_organization_scoped_searchable_and_paginated(
    client, registry_ok
):
    organization_id = uuid4()
    authorize(client, organization_id)
    url = f"/api/v1/organizations/{organization_id}/leases"
    headers = {"Authorization": "header.payload.signature"}

    for index in range(3):
        payload = lease_payload()
        payload["lease_reference"] = f"LEASE-2026-{index:03}"
        payload["status"] = "active" if index < 2 else "draft"
        payload["parties"][1]["legal_name"] = f"Tenant {index}"
        assert client.post(url, json=payload, headers=headers).status_code == 201

    other_organization = uuid4()
    authorize(client, other_organization)
    other_payload = lease_payload()
    other_payload["lease_reference"] = "PRIVATE-LEASE"
    assert (
        client.post(
            f"/api/v1/organizations/{other_organization}/leases",
            json=other_payload,
            headers=headers,
        ).status_code
        == 201
    )

    authorize(client, organization_id)
    response = client.get(
        f"{url}?status=active&search=Tenant&limit=1&offset=0&sort_by=lease_reference&sort_direction=asc",
        headers=headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 2
    assert data["limit"] == 1
    assert data["offset"] == 0
    assert len(data["items"]) == 1
    assert data["items"][0]["organization_id"] == str(organization_id)
    assert data["items"][0]["status"] == "active"
    assert "audit_events" not in data["items"][0]

    next_page = client.get(
        f"{url}?status=active&search=Tenant&limit=1&offset=1&sort_by=lease_reference&sort_direction=asc",
        headers=headers,
    )
    assert next_page.status_code == 200
    assert next_page.json()["items"][0]["id"] != data["items"][0]["id"]

    invalid_status = client.get(f"{url}?status=all", headers=headers)
    assert invalid_status.status_code == 422
    blank_search = client.get(f"{url}?search=%20%20", headers=headers)
    assert blank_search.status_code == 422
    oversized_page = client.get(f"{url}?limit=101", headers=headers)
    assert oversized_page.status_code == 422
    invalid_sort = client.get(f"{url}?sort_by=organization_id", headers=headers)
    assert invalid_sort.status_code == 422


def test_lease_permissions_use_authorization_decisions(client, monkeypatch):
    organization_id = uuid4()
    calls = []

    def allow_operations(org_id, operation, token):
        calls.append((org_id, operation, token))
        if operation == "lease-management.leases.update":
            from fastapi import HTTPException

            raise HTTPException(status_code=403)
        return object()

    monkeypatch.setattr(main, "authorize_request", allow_operations)
    response = client.get(
        f"/api/v1/organizations/{organization_id}/lease-permissions",
        headers={"Authorization": "header.payload.signature"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "can_read": True,
        "can_create": True,
        "can_update": False,
    }
    assert [call[1] for call in calls] == [
        "lease-management.leases.read",
        "lease-management.leases.create",
        "lease-management.leases.update",
    ]


def test_invalid_dates_precision_and_float_rent_are_rejected(client, registry_ok):
    organization_id = uuid4()
    authorize(client, organization_id)
    base_url = f"/api/v1/organizations/{organization_id}/leases"
    headers = {"Authorization": "Bearer header.payload.signature"}

    invalid_dates = lease_payload()
    invalid_dates["expiry_date"] = "2026-03-31"
    assert client.post(base_url, json=invalid_dates, headers=headers).status_code == 422
    over_precision = lease_payload()
    over_precision["rent_amount"] = "1.234"
    assert (
        client.post(base_url, json=over_precision, headers=headers).status_code == 422
    )
    float_rent = lease_payload()
    float_rent["rent_amount"] = 12.5
    assert client.post(base_url, json=float_rent, headers=headers).status_code == 422


def test_invalid_or_inactive_unit_fails_closed_without_creating_lease(
    client, db_factory, monkeypatch
):
    organization_id = uuid4()
    authorize(client, organization_id)
    monkeypatch.setattr(
        main,
        "validate_unit_reference",
        lambda *_args: (_ for _ in ()).throw(UnitReferenceInvalid()),
    )

    response = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(),
        headers={"Authorization": "Bearer header.payload.signature"},
    )

    assert response.status_code == 422
    with db_factory() as session:
        assert session.scalar(select(Lease)) is None


def test_registry_unavailable_fails_closed(client, monkeypatch):
    organization_id = uuid4()
    authorize(client, organization_id)
    monkeypatch.setattr(
        main,
        "validate_unit_reference",
        lambda *_args: (_ for _ in ()).throw(main.ServiceDependencyUnavailable()),
    )

    response = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(),
        headers={"Authorization": "Bearer header.payload.signature"},
    )
    assert response.status_code == 503
    assert response.json()["detail"] == "Property Registry unavailable"


def test_registry_stale_unit_on_read_is_marked_unavailable_and_can_be_terminated(
    client, db_factory, registry_ok, monkeypatch
):
    organization_id = uuid4()
    authorize(client, organization_id)
    headers = {"Authorization": "Bearer header.payload.signature"}
    created = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(),
        headers=headers,
    )
    assert created.status_code == 201, created.text
    created = created.json()
    monkeypatch.setattr(
        main,
        "validate_unit_reference",
        lambda *_args: (_ for _ in ()).throw(UnitReferenceInvalid()),
    )

    response = client.get(
        f"/api/v1/organizations/{organization_id}/leases/{created['id']}",
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json()["units"][0]["verified_status"] == "unavailable"
    assert "reason" not in response.json()["units"][0]

    terminated = client.patch(
        f"/api/v1/organizations/{organization_id}/leases/{created['id']}",
        json={"status": "terminated"},
        headers=headers,
    )
    assert terminated.status_code == 200
    assert terminated.json()["status"] == "terminated"


def test_internal_retirement_check_is_organization_scoped_and_blocks_active_lease(
    client, db_factory, registry_ok
):
    organization_id = uuid4()
    authorize(client, organization_id)
    headers = {"Authorization": "******"}
    created = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(),
        headers=headers,
    )
    assert created.status_code == 201, created.text
    created = created.json()
    unit_id = created["units"][0]["unit_id"]

    response = client.get(
        f"/internal/v1/organizations/{organization_id}/units/{unit_id}/retirement-check",
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json() == {
        "organization_id": str(organization_id),
        "unit_id": unit_id,
        "referenced": True,
    }
    other_organization = uuid4()
    authorize(client, other_organization)
    response = client.get(
        f"/internal/v1/organizations/{other_organization}/units/{unit_id}/retirement-check",
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["referenced"] is False
    authorize(client, organization_id)
    response = client.patch(
        f"/api/v1/organizations/{organization_id}/leases/{created['id']}",
        json={"status": "terminated"},
        headers=headers,
    )
    assert response.status_code == 200
    response = client.get(
        f"/internal/v1/organizations/{organization_id}/units/{unit_id}/retirement-check",
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["referenced"] is False


def test_termination_can_clear_a_stale_unit_reference(client, registry_ok, monkeypatch):
    organization_id = uuid4()
    authorize(client, organization_id)
    headers = {"Authorization": "******"}
    created = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(),
        headers=headers,
    ).json()
    monkeypatch.setattr(
        main,
        "validate_unit_reference",
        lambda *_args: (_ for _ in ()).throw(UnitReferenceInvalid()),
    )

    response = client.patch(
        f"/api/v1/organizations/{organization_id}/leases/{created['id']}",
        json={"status": "terminated"},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json()["status"] == "terminated"


def test_foreign_organization_lease_is_not_disclosed(client, registry_ok):
    organization_id = uuid4()
    authorize(client, organization_id)
    headers = {"Authorization": "Bearer header.payload.signature"}
    created = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(),
        headers=headers,
    ).json()
    other_organization = uuid4()
    authorize(client, other_organization)

    response = client.get(
        f"/api/v1/organizations/{other_organization}/leases/{created['id']}",
        headers=headers,
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Lease not found"


def test_authorization_result_cannot_be_replaced_by_route_organization(
    client, registry_ok
):
    organization_id = uuid4()
    authorize(client, organization_id, authorized_id=uuid4())

    response = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(),
        headers={"Authorization": "Bearer header.payload.signature"},
    )

    assert response.status_code == 403


def test_update_writes_audit_and_preserves_decimal_amount(
    client, db_factory, registry_ok
):
    organization_id = uuid4()
    actor_id = authorize(client, organization_id)
    headers = {"Authorization": "Bearer header.payload.signature"}
    created = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(),
        headers=headers,
    ).json()

    response = client.patch(
        f"/api/v1/organizations/{organization_id}/leases/{created['id']}",
        json={"rent_amount": "12800.25", "break_date": None},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json()["rent_amount"] == "12800.25"
    assert response.json()["break_date"] is None
    assert len(response.json()["audit_events"]) == 2
    assert response.json()["audit_events"][-1]["actor_id"] == str(actor_id)
    with db_factory() as session:
        lease = session.get(Lease, UUID(created["id"]))
        assert lease.rent_amount == Decimal("12800.25")
        assert session.scalar(
            select(LeaseAuditEvent).where(
                LeaseAuditEvent.lease_id == lease.id,
                LeaseAuditEvent.event_type == "updated",
            )
        )


def test_transaction_rolls_back_lease_when_audit_commit_fails(
    client, db_factory, registry_ok
):
    organization_id = uuid4()
    authorize(client, organization_id)

    def failing_session():
        session = db_factory()

        def fail_commit():
            session.rollback()
            raise SQLAlchemyError("synthetic database failure")

        session.commit = fail_commit
        try:
            yield session
        finally:
            session.close()

    client.app.dependency_overrides[main._database_session] = failing_session
    response = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(),
        headers={"Authorization": "Bearer header.payload.signature"},
    )
    assert response.status_code == 503
    with db_factory() as session:
        assert session.scalar(select(Lease)) is None


def test_missing_authentication_is_rejected(client):
    organization_id = uuid4()
    authorize(client, organization_id)
    client.app.dependency_overrides.pop(get_user_token)

    response = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(),
    )
    assert response.status_code == 401


def test_health_is_independent_of_database_and_readiness_uses_database(
    client, monkeypatch
):
    from sqlalchemy import create_engine

    monkeypatch.setattr(main.database, "engine", None)
    assert client.get("/health").status_code == 200
    assert client.get("/ready").status_code == 503

    engine = create_engine("sqlite://")
    monkeypatch.setattr(main.database, "engine", engine)
    try:
        ready = client.get("/ready")
        assert ready.status_code == 200
        assert ready.json()["service"] == "lease-management"
    finally:
        engine.dispose()


def test_multiple_units_and_party_replacement_validates_complete_lease(
    client, db_factory, registry_ok
):
    organization_id = uuid4()
    authorize(client, organization_id)
    headers = {"Authorization": "Bearer header.payload.signature"}
    created = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(unit_count=2),
        headers=headers,
    ).json()
    unit_records = lease_payload(unit_count=2)["units"]

    response = client.patch(
        f"/api/v1/organizations/{organization_id}/leases/{created['id']}",
        json={"units": unit_records},
        headers=headers,
    )

    assert response.status_code == 200
    assert len(response.json()["units"]) == 2
    with db_factory() as session:
        assert len(session.scalars(select(LeaseUnit)).all()) == 2
        assert len(session.scalars(select(LeaseParty)).all()) == 3


def test_date_merged_on_update_must_remain_valid(client, registry_ok):
    organization_id = uuid4()
    authorize(client, organization_id)
    headers = {"Authorization": "Bearer header.payload.signature"}
    created = client.post(
        f"/api/v1/organizations/{organization_id}/leases",
        json=lease_payload(),
        headers=headers,
    ).json()

    response = client.patch(
        f"/api/v1/organizations/{organization_id}/leases/{created['id']}",
        json={"expiry_date": "2026-03-31"},
        headers=headers,
    )
    assert response.status_code == 422


def test_database_constraint_and_migration_have_no_registry_foreign_key():
    from app.models import Base

    unit_targets = {
        element.target_fullname
        for element in Base.metadata.tables["lease_units"].foreign_keys
    }
    assert unit_targets == {"leases.id", "leases.organization_id"}
    assert Lease.__table__.c.rent_amount.type.precision == 14
    assert Lease.__table__.c.rent_amount.type.scale == 2
