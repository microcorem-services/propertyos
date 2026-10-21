from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, selectinload

from app import config, database
from app.models import Lease, LeaseAuditEvent, LeaseParty, LeaseUnit
from app.schemas import (
    LeaseAuditEventResponse,
    LeaseCreateRequest,
    LeasePartyResponse,
    LeaseResponse,
    LeaseUnitInput,
    LeaseUnitResponse,
    LeaseUpdateRequest,
)
from app.security import (
    AuthorizedOrganization,
    ServiceDependencyUnavailable,
    UnitReference,
    UnitReferenceInvalid,
    get_create_authorization,
    get_read_authorization,
    get_update_authorization,
    get_user_token,
    validate_unit_reference,
)

API_V1_PREFIX = "/api/v1"
app = FastAPI(title="BOWERA Lease Management")


def _database_session():
    try:
        yield from database.get_db()
    except database.DatabaseNotConfiguredError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Lease service temporarily unavailable",
        ) from None


def _raise_database_unavailable() -> None:
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Lease service temporarily unavailable",
    ) from None


@app.get("/health")
def health():
    return {"status": "ok", "service": config.SERVICE_NAME}


@app.get("/ready")
def readiness():
    if database.engine is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    try:
        with database.engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="Database unavailable") from None
    return {"status": "ok", "service": config.SERVICE_NAME}


@app.get(
    "/internal/v1/organizations/{organization_id}/units/{unit_id}/retirement-check"
)
def check_unit_retirement(
    organization_id: UUID,
    unit_id: UUID,
    authorization: AuthorizedOrganization = Depends(get_read_authorization),
    session: Session = Depends(_database_session),
) -> dict[str, UUID | bool]:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        referenced = (
            session.scalar(
                select(LeaseUnit.id)
                .join(
                    Lease,
                    (Lease.id == LeaseUnit.lease_id)
                    & (Lease.organization_id == LeaseUnit.organization_id),
                )
                .where(
                    LeaseUnit.organization_id == organization_id,
                    LeaseUnit.unit_id == unit_id,
                    Lease.status.in_(("draft", "active")),
                )
                .limit(1)
            )
            is not None
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    return {
        "organization_id": organization_id,
        "unit_id": unit_id,
        "referenced": referenced,
    }


def _unit_reference(unit: LeaseUnitInput | LeaseUnit) -> UnitReference:
    return UnitReference(
        portfolio_id=unit.portfolio_id,
        site_id=unit.site_id,
        building_id=unit.building_id,
        unit_id=unit.unit_id,
    )


def _verify_units(
    organization_id: UUID,
    units: list[LeaseUnitInput | LeaseUnit],
    user_token: str,
    *,
    stale_is_conflict: bool = False,
) -> None:
    for unit in units:
        try:
            validate_unit_reference(organization_id, _unit_reference(unit), user_token)
        except UnitReferenceInvalid:
            raise HTTPException(
                status_code=(
                    status.HTTP_409_CONFLICT
                    if stale_is_conflict
                    else status.HTTP_422_UNPROCESSABLE_CONTENT
                ),
                detail=(
                    "A referenced Unit is no longer available"
                    if stale_is_conflict
                    else "A referenced Unit is invalid or inactive"
                ),
            ) from None
        except ServiceDependencyUnavailable:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Property Registry unavailable",
            ) from None


def _party_models(organization_id: UUID, lease_id: UUID, parties) -> list[LeaseParty]:
    return [
        LeaseParty(
            id=uuid4(),
            organization_id=organization_id,
            lease_id=lease_id,
            legal_name=party.legal_name,
            role=party.role,
            party_type=party.party_type,
        )
        for party in parties
    ]


def _unit_models(organization_id: UUID, lease_id: UUID, units) -> list[LeaseUnit]:
    return [
        LeaseUnit(
            id=uuid4(),
            organization_id=organization_id,
            lease_id=lease_id,
            portfolio_id=unit.portfolio_id,
            site_id=unit.site_id,
            building_id=unit.building_id,
            unit_id=unit.unit_id,
        )
        for unit in units
    ]


def _response(lease: Lease) -> LeaseResponse:
    return LeaseResponse(
        id=lease.id,
        organization_id=lease.organization_id,
        lease_reference=lease.lease_reference,
        start_date=lease.start_date,
        expiry_date=lease.expiry_date,
        break_date=lease.break_date,
        rent_amount=f"{Decimal(lease.rent_amount):.2f}",
        currency=lease.currency,
        payment_frequency=lease.payment_frequency,
        status=lease.status,
        units=[
            LeaseUnitResponse(
                portfolio_id=unit.portfolio_id,
                site_id=unit.site_id,
                building_id=unit.building_id,
                unit_id=unit.unit_id,
                verified_status="active",
            )
            for unit in lease.units
        ],
        parties=[
            LeasePartyResponse(
                id=party.id,
                legal_name=party.legal_name,
                role=party.role,
                party_type=party.party_type,
            )
            for party in lease.parties
        ],
        audit_events=[
            LeaseAuditEventResponse(
                actor_id=event.actor_id,
                event_type=event.event_type,
                changed_fields=event.changed_fields,
                occurred_at=event.occurred_at,
            )
            for event in sorted(lease.audit_events, key=lambda event: event.occurred_at)
        ],
        created_at=lease.created_at,
        updated_at=lease.updated_at,
    )


@app.post(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/leases",
    response_model=LeaseResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_lease(
    organization_id: UUID,
    payload: LeaseCreateRequest,
    authorization: AuthorizedOrganization = Depends(get_create_authorization),
    user_token: str = Depends(get_user_token),
    session: Session = Depends(_database_session),
) -> LeaseResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    _verify_units(organization_id, payload.units, user_token)
    lease = Lease(
        id=uuid4(),
        organization_id=organization_id,
        lease_reference=payload.lease_reference,
        start_date=payload.start_date,
        expiry_date=payload.expiry_date,
        break_date=payload.break_date,
        rent_amount=payload.rent_amount,
        currency=payload.currency,
        payment_frequency=payload.payment_frequency,
        status=payload.status,
    )
    lease.parties = _party_models(organization_id, lease.id, payload.parties)
    lease.units = _unit_models(organization_id, lease.id, payload.units)
    session.add(lease)
    try:
        session.flush()
        audit_event = LeaseAuditEvent(
            organization_id=organization_id,
            lease_id=lease.id,
            actor_id=authorization.actor_id,
            event_type="created",
            changed_fields=[
                "lease_reference",
                "start_date",
                "expiry_date",
                "break_date",
                "rent_amount",
                "currency",
                "payment_frequency",
                "status",
                "units",
                "parties",
            ],
        )
        lease.audit_events.append(audit_event)
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Lease reference already exists or lease data conflicts",
        ) from None
    except SQLAlchemyError:
        session.rollback()
        _raise_database_unavailable()
    return _response(lease)


@app.get(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/leases/{{lease_id}}",
    response_model=LeaseResponse,
)
def get_lease(
    organization_id: UUID,
    lease_id: UUID,
    authorization: AuthorizedOrganization = Depends(get_read_authorization),
    user_token: str = Depends(get_user_token),
    session: Session = Depends(_database_session),
) -> LeaseResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        lease = session.scalar(
            select(Lease)
            .options(
                selectinload(Lease.units),
                selectinload(Lease.parties),
                selectinload(Lease.audit_events),
            )
            .where(Lease.id == lease_id, Lease.organization_id == organization_id)
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    if lease is None:
        raise HTTPException(status_code=404, detail="Lease not found")
    _verify_units(organization_id, lease.units, user_token, stale_is_conflict=True)
    return _response(lease)


@app.patch(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/leases/{{lease_id}}",
    response_model=LeaseResponse,
)
def update_lease(
    organization_id: UUID,
    lease_id: UUID,
    payload: LeaseUpdateRequest,
    authorization: AuthorizedOrganization = Depends(get_update_authorization),
    user_token: str = Depends(get_user_token),
    session: Session = Depends(_database_session),
) -> LeaseResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        lease = session.scalar(
            select(Lease)
            .options(
                selectinload(Lease.units),
                selectinload(Lease.parties),
                selectinload(Lease.audit_events),
            )
            .where(Lease.id == lease_id, Lease.organization_id == organization_id)
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    if lease is None:
        raise HTTPException(status_code=404, detail="Lease not found")

    updates = {field: getattr(payload, field) for field in payload.model_fields_set}
    merged_start = updates.get("start_date", lease.start_date)
    merged_expiry = updates.get("expiry_date", lease.expiry_date)
    merged_break = updates.get("break_date", lease.break_date)
    if merged_expiry < merged_start or (
        merged_break is not None and not merged_start <= merged_break <= merged_expiry
    ):
        raise HTTPException(status_code=422, detail="Lease dates are inconsistent")
    if "units" in updates:
        _verify_units(organization_id, updates["units"], user_token)
    elif updates.get("status") != "terminated":
        _verify_units(organization_id, lease.units, user_token)

    changed_fields = list(updates)
    try:
        for field in (
            "lease_reference",
            "start_date",
            "expiry_date",
            "break_date",
            "rent_amount",
            "currency",
            "payment_frequency",
            "status",
        ):
            if field in updates:
                setattr(lease, field, updates[field])
        if "units" in updates:
            lease.units = _unit_models(organization_id, lease.id, updates["units"])
        if "parties" in updates:
            lease.parties = _party_models(organization_id, lease.id, updates["parties"])
        audit_event = LeaseAuditEvent(
            organization_id=organization_id,
            lease_id=lease.id,
            actor_id=authorization.actor_id,
            event_type="updated",
            changed_fields=changed_fields,
        )
        lease.audit_events.append(audit_event)
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Lease reference already exists or lease data conflicts",
        ) from None
    except SQLAlchemyError:
        session.rollback()
        _raise_database_unavailable()
    return _response(lease)
