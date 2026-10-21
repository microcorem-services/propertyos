from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, status
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, selectinload

from app import config, database
from app.models import (
    Lease,
    LeaseAuditEvent,
    LeaseParty,
    LeaseUnit,
    Invoice,
    InvoiceAuditEvent,
    InvoiceLine,
    Payment,
    PaymentAllocation,
    PaymentAuditEvent,
    PropertyExpense,
    PropertyExpenseAuditEvent,
    RentInstallment,
    RentSchedule,
    RentScheduleStatus,
)
from app.rent_schedules import generate_due_dates
from app.schemas import (
    LeaseAuditEventResponse,
    EligibleInstallmentResponse,
    InvoiceCreateRequest,
    InvoiceLineInput,
    InvoiceResponse,
    InvoiceUpdateRequest,
    LeaseReceivablesResponse,
    LeaseCreateRequest,
    LeaseListResponse,
    LeasePartyResponse,
    LeaseResponse,
    LeaseSummaryResponse,
    LeaseSummaryUnitResponse,
    LeaseUnitInput,
    LeaseUnitResponse,
    LeaseUpdateRequest,
    PropertyExpenseCreateRequest,
    PropertyExpenseResponse,
    PropertyExpenseUpdateRequest,
    PaymentCreateRequest,
    PaymentResponse,
    RentInstallmentResponse,
    RentScheduleCreateRequest,
    RentScheduleResponse,
    RentScheduleUpdateRequest,
)
from app.security import (
    AuthorizedOrganization,
    PropertyAssetReference,
    PropertyAssetReferenceInvalid,
    ServiceDependencyUnavailable,
    UnitReference,
    UnitReferenceInvalid,
    authorize_request,
    get_create_authorization,
    get_read_authorization,
    get_update_authorization,
    get_user_token,
    validate_unit_reference,
    validate_property_asset_reference,
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
    allow_unavailable: bool = False,
) -> set[UUID]:
    unavailable: set[UUID] = set()
    for unit in units:
        try:
            validate_unit_reference(organization_id, _unit_reference(unit), user_token)
        except UnitReferenceInvalid:
            if allow_unavailable:
                unavailable.add(unit.unit_id)
                continue
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="A referenced Unit is invalid or inactive",
            ) from None
        except ServiceDependencyUnavailable:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Property Registry unavailable",
            ) from None
    return unavailable


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


def _response(
    lease: Lease, unavailable_unit_ids: set[UUID] | None = None
) -> LeaseResponse:
    unavailable_unit_ids = unavailable_unit_ids or set()
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
                verified_status=(
                    "unavailable" if unit.unit_id in unavailable_unit_ids else "active"
                ),
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


def _summary_response(lease: Lease) -> LeaseSummaryResponse:
    return LeaseSummaryResponse(
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
            LeaseSummaryUnitResponse(
                portfolio_id=unit.portfolio_id,
                site_id=unit.site_id,
                building_id=unit.building_id,
                unit_id=unit.unit_id,
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
        created_at=lease.created_at,
        updated_at=lease.updated_at,
    )


def _rent_schedule_response(
    schedule: RentSchedule, currency: str
) -> RentScheduleResponse:
    return RentScheduleResponse(
        id=schedule.id,
        organization_id=schedule.organization_id,
        lease_id=schedule.lease_id,
        charge_category=schedule.charge_category,
        description=schedule.description,
        amount_per_period=f"{Decimal(schedule.amount_per_period):.2f}",
        currency=currency,
        payment_frequency=schedule.payment_frequency,
        start_date=schedule.start_date,
        end_date=schedule.end_date,
        due_day=schedule.due_day,
        short_month_rule=schedule.short_month_rule,
        status=schedule.status,
        manual_review_reasons=schedule.manual_review_reasons,
        installments=[
            RentInstallmentResponse(
                id=installment.id,
                due_date=installment.due_date,
                amount=f"{Decimal(installment.amount):.2f}",
                currency=installment.currency,
                status=installment.status,
            )
            for installment in sorted(
                schedule.installments, key=lambda item: item.due_date
            )
        ],
        created_at=schedule.created_at,
        updated_at=schedule.updated_at,
    )


def _lease_for_schedule(
    session: Session, organization_id: UUID, lease_id: UUID
) -> Lease:
    try:
        lease = session.scalar(
            select(Lease)
            .where(Lease.id == lease_id, Lease.organization_id == organization_id)
            .with_for_update()
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    if lease is None:
        raise HTTPException(status_code=404, detail="Lease not found")
    return lease


def _validate_schedule_term(lease: Lease, start_date, end_date) -> None:
    if (
        lease.status in ("expired", "terminated")
        or start_date < lease.start_date
        or end_date > lease.expiry_date
    ):
        raise HTTPException(
            status_code=422,
            detail="Rent schedule dates must fall within the current lease term",
        )


def _ensure_schedule_installments(
    session: Session, schedule: RentSchedule, lease: Lease
) -> int:
    try:
        due_dates, review_reasons = generate_due_dates(
            schedule.start_date,
            schedule.end_date,
            schedule.due_day,
            schedule.payment_frequency,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    schedule.manual_review_reasons = review_reasons
    existing_dates = set(
        session.scalars(
            select(RentInstallment.due_date).where(
                RentInstallment.organization_id == schedule.organization_id,
                RentInstallment.schedule_id == schedule.id,
            )
        )
    )
    missing = [due_date for due_date in due_dates if due_date not in existing_dates]
    schedule.installments.extend(
        RentInstallment(
            organization_id=schedule.organization_id,
            due_date=due_date,
            amount=schedule.amount_per_period,
            currency=lease.currency,
            status="expected",
        )
        for due_date in missing
    )
    return len(missing)


def _add_schedule_audit(
    lease: Lease,
    organization_id: UUID,
    actor_id: UUID,
    schedule: RentSchedule,
    event_type: str,
    changed_fields: list[str],
) -> None:
    lease.updated_at = func.now()
    lease.audit_events.append(
        LeaseAuditEvent(
            organization_id=organization_id,
            lease_id=lease.id,
            actor_id=actor_id,
            event_type=event_type,
            changed_fields=[
                f"rent_schedule:{schedule.id}",
                *changed_fields,
            ],
        )
    )


def _active_schedule_conflict(
    session: Session,
    schedule: RentSchedule,
    *,
    exclude_schedule_id: UUID | None = None,
) -> bool:
    query = select(RentSchedule.id).where(
        RentSchedule.organization_id == schedule.organization_id,
        RentSchedule.lease_id == schedule.lease_id,
        RentSchedule.charge_category == schedule.charge_category,
        RentSchedule.status == RentScheduleStatus.ACTIVE.value,
        RentSchedule.start_date <= schedule.end_date,
        RentSchedule.end_date >= schedule.start_date,
    )
    if exclude_schedule_id is not None:
        query = query.where(RentSchedule.id != exclude_schedule_id)
    try:
        return session.scalar(query.limit(1)) is not None
    except SQLAlchemyError:
        _raise_database_unavailable()


def _property_expense_response(expense: PropertyExpense) -> PropertyExpenseResponse:
    return PropertyExpenseResponse(
        id=expense.id,
        organization_id=expense.organization_id,
        asset_level=expense.asset_level,
        portfolio_id=expense.portfolio_id,
        site_id=expense.site_id,
        building_id=expense.building_id,
        unit_id=expense.unit_id,
        category=expense.category,
        description=expense.description,
        amount=f"{Decimal(expense.amount):.2f}",
        currency=expense.currency,
        expense_date=expense.expense_date,
        recoverability=expense.recoverability,
        manual_review_reasons=expense.manual_review_reasons,
        audit_events=[
            {
                "actor_id": event.actor_id,
                "event_type": event.event_type,
                "changed_fields": event.changed_fields,
                "occurred_at": event.occurred_at,
            }
            for event in sorted(expense.audit_events, key=lambda item: item.occurred_at)
        ],
        created_at=expense.created_at,
        updated_at=expense.updated_at,
    )


def _verify_property_expense_asset(
    organization_id: UUID,
    payload: PropertyExpenseCreateRequest,
    user_token: str,
) -> None:
    reference = PropertyAssetReference(
        asset_level=payload.asset_level,
        portfolio_id=payload.portfolio_id,
        site_id=payload.site_id,
        building_id=payload.building_id,
        unit_id=payload.unit_id,
    )
    try:
        validate_property_asset_reference(organization_id, reference, user_token)
    except PropertyAssetReferenceInvalid:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="The referenced property asset is invalid or inactive",
        ) from None
    except ServiceDependencyUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Property Registry unavailable",
        ) from None


def _expense_request_fingerprint(payload: PropertyExpenseCreateRequest) -> str:
    canonical = payload.model_dump(mode="json", exclude={"idempotency_key"})
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _money_text(value: Decimal) -> str:
    return f"{Decimal(value):.2f}"


def _invoice_line_values(line: InvoiceLineInput) -> tuple[Decimal, Decimal]:
    line_total = (line.quantity * line.unit_amount).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    if line_total <= 0 or line_total > Decimal("999999999999.99"):
        raise HTTPException(status_code=422, detail="Invoice line amount is out of range")
    return line.quantity, line_total


def _invoice_allocated_amount(session: Session, invoice_id: UUID, organization_id: UUID) -> Decimal:
    try:
        return Decimal(
            session.scalar(
                select(func.coalesce(func.sum(PaymentAllocation.amount), 0)).where(
                    PaymentAllocation.invoice_id == invoice_id,
                    PaymentAllocation.organization_id == organization_id,
                )
            )
            or 0
        )
    except SQLAlchemyError:
        _raise_database_unavailable()


def _invoice_response(
    session: Session,
    invoice: Invoice,
    lease: Lease,
    *,
    today: date | None = None,
) -> InvoiceResponse:
    allocated = _invoice_allocated_amount(
        session, invoice.id, invoice.organization_id
    )
    outstanding = max(Decimal("0.00"), Decimal(invoice.total) - allocated)
    if invoice.status == "draft":
        receivable_status = "draft"
    elif outstanding == 0:
        receivable_status = "paid"
    elif invoice.due_date < (today or date.today()):
        receivable_status = "overdue"
    else:
        receivable_status = "due"
    return InvoiceResponse(
        id=invoice.id,
        organization_id=invoice.organization_id,
        lease_id=invoice.lease_id,
        lease_reference=lease.lease_reference,
        invoice_number=invoice.invoice_number,
        issue_date=invoice.issue_date,
        due_date=invoice.due_date,
        currency=invoice.currency,
        subtotal=_money_text(invoice.subtotal),
        total=_money_text(invoice.total),
        allocated_amount=_money_text(allocated),
        outstanding_balance=_money_text(outstanding),
        status=invoice.status,
        receivable_status=receivable_status,
        issued_at=invoice.issued_at,
        lines=[
            {
                "id": line.id,
                "description": line.description,
                "quantity": f"{Decimal(line.quantity):.3f}",
                "unit_amount": _money_text(line.unit_amount),
                "line_total": _money_text(line.line_total),
                "source_installment_id": line.source_installment_id,
            }
            for line in invoice.lines
        ],
        audit_events=[
            {
                "actor_id": event.actor_id,
                "event_type": event.event_type,
                "changed_fields": event.changed_fields,
                "occurred_at": event.occurred_at,
            }
            for event in sorted(invoice.audit_events, key=lambda item: item.occurred_at)
        ],
        created_at=invoice.created_at,
        updated_at=invoice.updated_at,
    )


def _payment_response(session: Session, payment: Payment) -> PaymentResponse:
    allocations = list(
        session.execute(
            select(PaymentAllocation, Invoice)
            .join(
                Invoice,
                (Invoice.id == PaymentAllocation.invoice_id)
                & (Invoice.organization_id == PaymentAllocation.organization_id),
            )
            .where(
                PaymentAllocation.payment_id == payment.id,
                PaymentAllocation.organization_id == payment.organization_id,
            )
            .order_by(Invoice.invoice_number)
        )
    )
    return PaymentResponse(
        id=payment.id,
        organization_id=payment.organization_id,
        reference=payment.reference,
        received_on=payment.received_on,
        currency=payment.currency,
        amount=_money_text(payment.amount),
        method_description=payment.method_description,
        allocations=[
            {
                "invoice_id": allocation.invoice_id,
                "invoice_number": invoice.invoice_number,
                "amount": _money_text(allocation.amount),
            }
            for allocation, invoice in allocations
        ],
        audit_events=[
            {
                "actor_id": event.actor_id,
                "event_type": event.event_type,
                "changed_fields": event.changed_fields,
                "occurred_at": event.occurred_at,
            }
            for event in sorted(payment.audit_events, key=lambda item: item.occurred_at)
        ],
        created_at=payment.created_at,
    )


def _invoice_line_models(
    session: Session,
    organization_id: UUID,
    lease: Lease,
    invoice_id: UUID,
    lines: list[InvoiceLineInput],
) -> tuple[list[InvoiceLine], Decimal]:
    source_ids = [
        line.source_installment_id
        for line in lines
        if line.source_installment_id is not None
    ]
    installments: dict[UUID, tuple[RentInstallment, RentSchedule]] = {}
    if source_ids:
        try:
            rows = session.execute(
                select(RentInstallment, RentSchedule)
                .join(
                    RentSchedule,
                    (RentSchedule.id == RentInstallment.schedule_id)
                    & (RentSchedule.organization_id == RentInstallment.organization_id),
                )
                .where(
                    RentInstallment.id.in_(source_ids),
                    RentInstallment.organization_id == organization_id,
                    RentSchedule.lease_id == lease.id,
                    RentSchedule.organization_id == organization_id,
                    RentSchedule.status == "active",
                    RentInstallment.status == "expected",
                )
                .order_by(RentInstallment.id)
                .with_for_update()
            )
            installments = {
                installment.id: (installment, schedule)
                for installment, schedule in rows
            }
            if len(installments) != len(source_ids):
                raise HTTPException(
                    status_code=422,
                    detail="A selected scheduled charge is not eligible for this lease",
                )
            reserved = set(
                session.scalars(
                    select(InvoiceLine.source_installment_id).where(
                        InvoiceLine.organization_id == organization_id,
                        InvoiceLine.source_installment_id.in_(source_ids),
                        InvoiceLine.invoice_id != invoice_id,
                    )
                )
            )
        except HTTPException:
            raise
        except SQLAlchemyError:
            _raise_database_unavailable()
        if reserved:
            raise HTTPException(
                status_code=409,
                detail="A selected scheduled charge is already reserved by another invoice",
            )

    result: list[InvoiceLine] = []
    subtotal = Decimal("0.00")
    for line in lines:
        quantity, line_total = _invoice_line_values(line)
        unit_amount = line.unit_amount
        if line.source_installment_id is not None:
            installment, schedule = installments[line.source_installment_id]
            if (
                quantity != Decimal("1")
                or unit_amount != Decimal(installment.amount)
                or line.description != schedule.description
                or lease.currency != installment.currency
            ):
                raise HTTPException(
                    status_code=422,
                    detail="Scheduled charge details must match the source instalment",
                )
        result.append(
            InvoiceLine(
                organization_id=organization_id,
                invoice_id=invoice_id,
                source_installment_id=line.source_installment_id,
                description=line.description,
                quantity=quantity,
                unit_amount=unit_amount,
                line_total=line_total,
            )
        )
        subtotal += line_total
    if subtotal > Decimal("999999999999.99"):
        raise HTTPException(status_code=422, detail="Invoice total is out of range")
    return result, subtotal


def _invoice_request_fingerprint(payload: PaymentCreateRequest) -> str:
    canonical = payload.model_dump(mode="json", exclude={"idempotency_key"})
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


@app.get(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/lease-permissions",
)
def get_lease_permissions(
    organization_id: UUID,
    token: str = Depends(get_user_token),
) -> dict[str, bool]:
    try:
        authorize_request(organization_id, "lease-management.leases.read", token)
    except HTTPException as error:
        if error.status_code == status.HTTP_403_FORBIDDEN:
            return {"can_read": False, "can_create": False, "can_update": False}
        raise

    def allowed(operation: str) -> bool:
        try:
            authorize_request(organization_id, operation, token)
        except HTTPException as error:
            if error.status_code == status.HTTP_403_FORBIDDEN:
                return False
            raise
        return True

    return {
        "can_read": True,
        "can_create": allowed("lease-management.leases.create"),
        "can_update": allowed("lease-management.leases.update"),
    }


@app.get(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/property-expenses",
    response_model=list[PropertyExpenseResponse],
)
def list_property_expenses(
    organization_id: UUID,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
    asset_level: str | None = Query(default=None),
    authorization: AuthorizedOrganization = Depends(get_read_authorization),
    session: Session = Depends(_database_session),
) -> list[PropertyExpenseResponse]:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if asset_level is not None and asset_level not in {
        "portfolio",
        "site",
        "building",
        "unit",
    }:
        raise HTTPException(status_code=422, detail="Invalid asset level")
    query = (
        select(PropertyExpense)
        .options(selectinload(PropertyExpense.audit_events))
        .where(PropertyExpense.organization_id == organization_id)
        .order_by(PropertyExpense.expense_date.desc(), PropertyExpense.id)
        .limit(limit)
        .offset(offset)
    )
    if asset_level is not None:
        query = query.where(PropertyExpense.asset_level == asset_level)
    try:
        expenses = list(session.scalars(query))
    except SQLAlchemyError:
        _raise_database_unavailable()
    return [_property_expense_response(expense) for expense in expenses]


@app.post(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/property-expenses",
    response_model=PropertyExpenseResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_property_expense(
    organization_id: UUID,
    payload: PropertyExpenseCreateRequest,
    authorization: AuthorizedOrganization = Depends(get_create_authorization),
    user_token: str = Depends(get_user_token),
    session: Session = Depends(_database_session),
) -> PropertyExpenseResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    fingerprint = _expense_request_fingerprint(payload)
    try:
        existing = session.scalar(
            select(PropertyExpense)
            .options(selectinload(PropertyExpense.audit_events))
            .where(
                PropertyExpense.organization_id == organization_id,
                PropertyExpense.idempotency_key == payload.idempotency_key,
            )
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    if existing is not None:
        if existing.request_fingerprint != fingerprint:
            raise HTTPException(
                status_code=409,
                detail="Idempotency key was already used for different expense data",
            )
        return _property_expense_response(existing)

    _verify_property_expense_asset(organization_id, payload, user_token)
    review_reasons = (
        ["allocation_not_configured", "recovery_terms_not_verified"]
        if payload.recoverability == "recoverable"
        else []
    )
    expense = PropertyExpense(
        organization_id=organization_id,
        idempotency_key=payload.idempotency_key,
        request_fingerprint=fingerprint,
        asset_level=payload.asset_level,
        portfolio_id=payload.portfolio_id,
        site_id=payload.site_id,
        building_id=payload.building_id,
        unit_id=payload.unit_id,
        category=payload.category,
        description=payload.description,
        amount=payload.amount,
        currency=payload.currency,
        expense_date=payload.expense_date,
        recoverability=payload.recoverability,
        manual_review_reasons=review_reasons,
    )
    expense.audit_events.append(
        PropertyExpenseAuditEvent(
            organization_id=organization_id,
            actor_id=authorization.actor_id,
            event_type="created",
            changed_fields=[
                "asset",
                "category",
                "description",
                "amount",
                "currency",
                "expense_date",
                "recoverability",
            ],
        )
    )
    session.add(expense)
    try:
        session.commit()
        return _property_expense_response(expense)
    except IntegrityError:
        session.rollback()
        try:
            existing = session.scalar(
                select(PropertyExpense)
                .options(selectinload(PropertyExpense.audit_events))
                .where(
                    PropertyExpense.organization_id == organization_id,
                    PropertyExpense.idempotency_key == payload.idempotency_key,
                )
            )
        except SQLAlchemyError:
            _raise_database_unavailable()
        if existing is not None and existing.request_fingerprint == fingerprint:
            return _property_expense_response(existing)
        raise HTTPException(
            status_code=409, detail="Property expense conflicts with existing data"
        ) from None
    except SQLAlchemyError:
        session.rollback()
        _raise_database_unavailable()


@app.get(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/property-expenses/{{expense_id}}",
    response_model=PropertyExpenseResponse,
)
def get_property_expense(
    organization_id: UUID,
    expense_id: UUID,
    authorization: AuthorizedOrganization = Depends(get_read_authorization),
    session: Session = Depends(_database_session),
) -> PropertyExpenseResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        expense = session.scalar(
            select(PropertyExpense)
            .options(selectinload(PropertyExpense.audit_events))
            .where(
                PropertyExpense.id == expense_id,
                PropertyExpense.organization_id == organization_id,
            )
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    if expense is None:
        raise HTTPException(status_code=404, detail="Property expense not found")
    return _property_expense_response(expense)


@app.patch(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/property-expenses/{{expense_id}}",
    response_model=PropertyExpenseResponse,
)
def update_property_expense(
    organization_id: UUID,
    expense_id: UUID,
    payload: PropertyExpenseUpdateRequest,
    authorization: AuthorizedOrganization = Depends(get_update_authorization),
    session: Session = Depends(_database_session),
) -> PropertyExpenseResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        expense = session.scalar(
            select(PropertyExpense)
            .options(selectinload(PropertyExpense.audit_events))
            .where(
                PropertyExpense.id == expense_id,
                PropertyExpense.organization_id == organization_id,
            )
            .with_for_update()
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    if expense is None:
        raise HTTPException(status_code=404, detail="Property expense not found")
    updates = {field: getattr(payload, field) for field in payload.model_fields_set}
    try:
        for field, value in updates.items():
            setattr(expense, field, value)
        expense.manual_review_reasons = (
            ["allocation_not_configured", "recovery_terms_not_verified"]
            if expense.recoverability == "recoverable"
            else []
        )
        expense.audit_events.append(
            PropertyExpenseAuditEvent(
                organization_id=organization_id,
                actor_id=authorization.actor_id,
                event_type="updated",
                changed_fields=list(updates),
            )
        )
        session.commit()
        return _property_expense_response(expense)
    except SQLAlchemyError:
        session.rollback()
        _raise_database_unavailable()


@app.get(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/leases/{{lease_id}}/rent-schedules",
    response_model=list[RentScheduleResponse],
)
def list_rent_schedules(
    organization_id: UUID,
    lease_id: UUID,
    authorization: AuthorizedOrganization = Depends(get_read_authorization),
    session: Session = Depends(_database_session),
) -> list[RentScheduleResponse]:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        lease = session.scalar(
            select(Lease).where(
                Lease.id == lease_id, Lease.organization_id == organization_id
            )
        )
        if lease is None:
            raise HTTPException(status_code=404, detail="Lease not found")
        schedules = list(
            session.scalars(
                select(RentSchedule)
                .options(selectinload(RentSchedule.installments))
                .where(
                    RentSchedule.organization_id == organization_id,
                    RentSchedule.lease_id == lease_id,
                )
                .order_by(RentSchedule.start_date, RentSchedule.id)
            )
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    return [_rent_schedule_response(schedule, lease.currency) for schedule in schedules]


@app.post(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/leases/{{lease_id}}/rent-schedules",
    response_model=RentScheduleResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_rent_schedule(
    organization_id: UUID,
    lease_id: UUID,
    payload: RentScheduleCreateRequest,
    authorization: AuthorizedOrganization = Depends(get_update_authorization),
    session: Session = Depends(_database_session),
) -> RentScheduleResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    lease = _lease_for_schedule(session, organization_id, lease_id)
    _validate_schedule_term(lease, payload.start_date, payload.end_date)
    if payload.status == RentScheduleStatus.ACTIVE.value:
        if lease.status != "active":
            raise HTTPException(
                status_code=422,
                detail="Only an active lease can have an active rent schedule",
            )
    schedule = RentSchedule(
        organization_id=organization_id,
        lease_id=lease.id,
        charge_category=payload.charge_category,
        description=payload.description,
        amount_per_period=payload.amount_per_period,
        payment_frequency=payload.payment_frequency,
        start_date=payload.start_date,
        end_date=payload.end_date,
        due_day=payload.due_day,
        short_month_rule=payload.short_month_rule,
        status=payload.status,
        manual_review_reasons=[],
    )
    if schedule.status == RentScheduleStatus.ACTIVE.value and _active_schedule_conflict(
        session, schedule
    ):
        raise HTTPException(
            status_code=409,
            detail="An active rent schedule already overlaps this date range",
        )
    try:
        session.add(schedule)
        session.flush()
        _ensure_schedule_installments(session, schedule, lease)
        _add_schedule_audit(
            lease,
            organization_id,
            authorization.actor_id,
            schedule,
            (
                "rent_schedule_created"
                if payload.charge_category == "base_rent"
                else "charge_created"
            ),
            [
                "amount_per_period",
                "charge_category",
                "description",
                "payment_frequency",
                "start_date",
                "end_date",
                "due_day",
                "short_month_rule",
                "status",
                "installments",
            ],
        )
        session.commit()
        return _rent_schedule_response(schedule, lease.currency)
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=409, detail="Rent schedule conflicts with existing data"
        ) from None
    except SQLAlchemyError:
        session.rollback()
        _raise_database_unavailable()


@app.patch(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/leases/{{lease_id}}/rent-schedules/{{schedule_id}}",
    response_model=RentScheduleResponse,
)
def update_rent_schedule(
    organization_id: UUID,
    lease_id: UUID,
    schedule_id: UUID,
    payload: RentScheduleUpdateRequest,
    authorization: AuthorizedOrganization = Depends(get_update_authorization),
    session: Session = Depends(_database_session),
) -> RentScheduleResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    lease = _lease_for_schedule(session, organization_id, lease_id)
    try:
        schedule = session.scalar(
            select(RentSchedule)
            .options(selectinload(RentSchedule.installments))
            .where(
                RentSchedule.id == schedule_id,
                RentSchedule.lease_id == lease_id,
                RentSchedule.organization_id == organization_id,
            )
            .with_for_update()
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    if schedule is None:
        raise HTTPException(status_code=404, detail="Rent schedule not found")
    updates = {field: getattr(payload, field) for field in payload.model_fields_set}
    if schedule.status == RentScheduleStatus.ACTIVE.value:
        if set(updates) == {"status"} and updates["status"] == schedule.status:
            return _rent_schedule_response(schedule, lease.currency)
        raise HTTPException(
            status_code=409,
            detail="Active rent schedules cannot be edited or deactivated",
        )

    merged_start = updates.get("start_date", schedule.start_date)
    merged_end = updates.get("end_date", schedule.end_date)
    _validate_schedule_term(lease, merged_start, merged_end)
    next_status = updates.get("status", schedule.status)
    if next_status == RentScheduleStatus.ACTIVE.value:
        if lease.status != "active":
            raise HTTPException(
                status_code=422,
                detail="Only an active lease can have an active rent schedule",
            )
        candidate = RentSchedule(
            organization_id=organization_id,
            lease_id=lease.id,
            charge_category=updates.get("charge_category", schedule.charge_category),
            description=updates.get("description", schedule.description),
            amount_per_period=updates.get(
                "amount_per_period", schedule.amount_per_period
            ),
            payment_frequency=updates.get(
                "payment_frequency", schedule.payment_frequency
            ),
            start_date=merged_start,
            end_date=merged_end,
            due_day=updates.get("due_day", schedule.due_day),
            short_month_rule=updates.get("short_month_rule", schedule.short_month_rule),
            status=next_status,
            manual_review_reasons=[],
        )
        if _active_schedule_conflict(
            session, candidate, exclude_schedule_id=schedule.id
        ):
            raise HTTPException(
                status_code=409,
                detail="An active rent schedule already overlaps this date range",
            )
    try:
        for field, value in updates.items():
            setattr(schedule, field, value)
        schedule.installments.clear()
        session.flush()
        _ensure_schedule_installments(session, schedule, lease)
        _add_schedule_audit(
            lease,
            organization_id,
            authorization.actor_id,
            schedule,
            (
                (
                    "rent_schedule_activated"
                    if schedule.charge_category == "base_rent"
                    else "charge_activated"
                )
                if next_status == RentScheduleStatus.ACTIVE.value
                else (
                    "rent_schedule_updated"
                    if schedule.charge_category == "base_rent"
                    else "charge_updated"
                )
            ),
            list(updates),
        )
        session.commit()
        return _rent_schedule_response(schedule, lease.currency)
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=409, detail="Rent schedule conflicts with existing data"
        ) from None
    except SQLAlchemyError:
        session.rollback()
        _raise_database_unavailable()


@app.post(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/leases/{{lease_id}}/rent-schedules/{{schedule_id}}/generate",
    response_model=RentScheduleResponse,
)
def generate_rent_schedule_installments(
    organization_id: UUID,
    lease_id: UUID,
    schedule_id: UUID,
    authorization: AuthorizedOrganization = Depends(get_update_authorization),
    session: Session = Depends(_database_session),
) -> RentScheduleResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    lease = _lease_for_schedule(session, organization_id, lease_id)
    try:
        schedule = session.scalar(
            select(RentSchedule)
            .options(selectinload(RentSchedule.installments))
            .where(
                RentSchedule.id == schedule_id,
                RentSchedule.lease_id == lease_id,
                RentSchedule.organization_id == organization_id,
            )
            .with_for_update()
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    if schedule is None:
        raise HTTPException(status_code=404, detail="Rent schedule not found")
    old_review_reasons = list(schedule.manual_review_reasons)
    try:
        inserted = _ensure_schedule_installments(session, schedule, lease)
        changed = inserted > 0 or old_review_reasons != schedule.manual_review_reasons
        if changed:
            _add_schedule_audit(
                lease,
                organization_id,
                authorization.actor_id,
                schedule,
                (
                    "rent_schedule_generated"
                    if schedule.charge_category == "base_rent"
                    else "charge_generated"
                ),
                ["installments"],
            )
            session.commit()
        return _rent_schedule_response(schedule, lease.currency)
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Rent schedule generation conflicts with existing data",
        ) from None
    except SQLAlchemyError:
        session.rollback()
        _raise_database_unavailable()


@app.get(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/leases/{{lease_id}}/eligible-installments",
    response_model=list[EligibleInstallmentResponse],
)
def list_eligible_installments(
    organization_id: UUID,
    lease_id: UUID,
    authorization: AuthorizedOrganization = Depends(get_read_authorization),
    session: Session = Depends(_database_session),
) -> list[EligibleInstallmentResponse]:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        lease = session.scalar(
            select(Lease).where(
                Lease.id == lease_id, Lease.organization_id == organization_id
            )
        )
        if lease is None:
            raise HTTPException(status_code=404, detail="Lease not found")
        rows = session.execute(
            select(RentInstallment, RentSchedule)
            .join(
                RentSchedule,
                (RentSchedule.id == RentInstallment.schedule_id)
                & (RentSchedule.organization_id == RentInstallment.organization_id),
            )
            .outerjoin(
                InvoiceLine,
                (InvoiceLine.source_installment_id == RentInstallment.id)
                & (InvoiceLine.organization_id == organization_id),
            )
            .where(
                RentInstallment.organization_id == organization_id,
                RentSchedule.lease_id == lease_id,
                RentSchedule.status == "active",
                RentInstallment.status == "expected",
                InvoiceLine.id.is_(None),
            )
            .order_by(RentInstallment.due_date, RentInstallment.id)
            .limit(500)
        )
    except HTTPException:
        raise
    except SQLAlchemyError:
        _raise_database_unavailable()
    return [
        EligibleInstallmentResponse(
            id=installment.id,
            lease_id=lease_id,
            schedule_id=schedule.id,
            description=schedule.description,
            charge_category=schedule.charge_category,
            due_date=installment.due_date,
            amount=_money_text(installment.amount),
            currency=installment.currency,
        )
        for installment, schedule in rows
    ]


def _invoice_query(organization_id: UUID):
    return (
        select(Invoice)
        .options(selectinload(Invoice.lines), selectinload(Invoice.audit_events))
        .where(Invoice.organization_id == organization_id)
    )


@app.get(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/invoices",
    response_model=list[InvoiceResponse],
)
def list_invoices(
    organization_id: UUID,
    status_filter: str | None = Query(default=None, alias="status"),
    receivable_status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
    authorization: AuthorizedOrganization = Depends(get_read_authorization),
    session: Session = Depends(_database_session),
) -> list[InvoiceResponse]:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if status_filter not in (None, "draft", "issued") or receivable_status not in (
        None,
        "draft",
        "due",
        "overdue",
        "paid",
    ):
        raise HTTPException(status_code=422, detail="Invalid invoice filter")
    try:
        allocated_amount = (
            select(func.coalesce(func.sum(PaymentAllocation.amount), 0))
            .where(
                PaymentAllocation.organization_id == organization_id,
                PaymentAllocation.invoice_id == Invoice.id,
            )
            .scalar_subquery()
        )
        invoice_query = _invoice_query(organization_id)
        if status_filter is not None:
            invoice_query = invoice_query.where(Invoice.status == status_filter)
        if receivable_status == "draft":
            invoice_query = invoice_query.where(Invoice.status == "draft")
        elif receivable_status == "due":
            invoice_query = invoice_query.where(
                Invoice.status == "issued",
                Invoice.total > allocated_amount,
                Invoice.due_date >= date.today(),
            )
        elif receivable_status == "overdue":
            invoice_query = invoice_query.where(
                Invoice.status == "issued",
                Invoice.total > allocated_amount,
                Invoice.due_date < date.today(),
            )
        elif receivable_status == "paid":
            invoice_query = invoice_query.where(
                Invoice.status == "issued",
                Invoice.total <= allocated_amount,
            )
        invoices = list(
            session.scalars(
                invoice_query
                .order_by(Invoice.issue_date.desc(), Invoice.invoice_number)
                .limit(limit)
                .offset(offset)
            )
        )
        lease_ids = {invoice.lease_id for invoice in invoices}
        leases = (
            {
                lease.id: lease
                for lease in session.scalars(
                    select(Lease).where(
                        Lease.organization_id == organization_id,
                        Lease.id.in_(lease_ids),
                    )
                )
            }
            if lease_ids
            else {}
        )
        results = [
            _invoice_response(session, invoice, leases[invoice.lease_id])
            for invoice in invoices
            if invoice.lease_id in leases
        ]
    except SQLAlchemyError:
        _raise_database_unavailable()
    return results


@app.post(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/invoices",
    response_model=InvoiceResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_invoice(
    organization_id: UUID,
    payload: InvoiceCreateRequest,
    authorization: AuthorizedOrganization = Depends(get_create_authorization),
    session: Session = Depends(_database_session),
) -> InvoiceResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    lease = _lease_for_schedule(session, organization_id, payload.lease_id)
    if payload.currency != lease.currency:
        raise HTTPException(status_code=422, detail="Invoice currency must match its lease")
    invoice = Invoice(
        id=uuid4(),
        organization_id=organization_id,
        lease_id=lease.id,
        invoice_number=payload.invoice_number,
        issue_date=payload.issue_date,
        due_date=payload.due_date,
        currency=payload.currency,
        subtotal=Decimal("0.00"),
        total=Decimal("0.00"),
        status="draft",
    )
    try:
        invoice.lines, subtotal = _invoice_line_models(
            session, organization_id, lease, invoice.id, payload.lines
        )
        invoice.subtotal = subtotal
        invoice.total = subtotal
        invoice.audit_events.append(
            InvoiceAuditEvent(
                organization_id=organization_id,
                actor_id=authorization.actor_id,
                event_type="created",
                changed_fields=[
                    "invoice_number",
                    "lease_id",
                    "issue_date",
                    "due_date",
                    "currency",
                    "lines",
                    "subtotal",
                    "total",
                ],
            )
        )
        session.add(invoice)
        session.commit()
        return _invoice_response(session, invoice, lease)
    except HTTPException:
        session.rollback()
        raise
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Invoice number or scheduled charge conflicts with existing data",
        ) from None
    except SQLAlchemyError:
        session.rollback()
        _raise_database_unavailable()


@app.get(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/invoices/{{invoice_id}}",
    response_model=InvoiceResponse,
)
def get_invoice(
    organization_id: UUID,
    invoice_id: UUID,
    authorization: AuthorizedOrganization = Depends(get_read_authorization),
    session: Session = Depends(_database_session),
) -> InvoiceResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        invoice = session.scalar(
            _invoice_query(organization_id).where(Invoice.id == invoice_id)
        )
        lease = (
            session.scalar(
                select(Lease).where(
                    Lease.id == invoice.lease_id,
                    Lease.organization_id == organization_id,
                )
            )
            if invoice is not None
            else None
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    if invoice is None or lease is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return _invoice_response(session, invoice, lease)


@app.patch(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/invoices/{{invoice_id}}",
    response_model=InvoiceResponse,
)
def update_invoice(
    organization_id: UUID,
    invoice_id: UUID,
    payload: InvoiceUpdateRequest,
    authorization: AuthorizedOrganization = Depends(get_update_authorization),
    session: Session = Depends(_database_session),
) -> InvoiceResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        invoice = session.scalar(
            _invoice_query(organization_id)
            .where(Invoice.id == invoice_id)
            .with_for_update()
        )
        if invoice is None:
            raise HTTPException(status_code=404, detail="Invoice not found")
        if invoice.status != "draft":
            raise HTTPException(
                status_code=409, detail="Issued invoice financial content is immutable"
            )
        lease = session.scalar(
            select(Lease)
            .where(
                Lease.id == invoice.lease_id,
                Lease.organization_id == organization_id,
            )
            .with_for_update()
        )
        if lease is None:
            raise HTTPException(status_code=404, detail="Lease not found")
        updates = payload.model_dump(exclude_unset=True)
        next_issue = updates.get("issue_date", invoice.issue_date)
        next_due = updates.get("due_date", invoice.due_date)
        if next_due < next_issue:
            raise HTTPException(
                status_code=422, detail="Due date must not precede invoice issue date"
            )
        if "invoice_number" in updates:
            invoice.invoice_number = updates["invoice_number"]
        invoice.issue_date = next_issue
        invoice.due_date = next_due
        changed_fields = list(updates)
        if "lines" in updates:
            next_lines, subtotal = _invoice_line_models(
                session,
                organization_id,
                lease,
                invoice.id,
                updates["lines"],
            )
            invoice.lines.clear()
            session.flush()
            invoice.lines.extend(next_lines)
            invoice.subtotal = subtotal
            invoice.total = subtotal
            changed_fields.extend(["subtotal", "total"])
        invoice.audit_events.append(
            InvoiceAuditEvent(
                organization_id=organization_id,
                actor_id=authorization.actor_id,
                event_type="updated",
                changed_fields=changed_fields,
            )
        )
        session.commit()
        return _invoice_response(session, invoice, lease)
    except HTTPException:
        session.rollback()
        raise
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Invoice number or scheduled charge conflicts with existing data",
        ) from None
    except SQLAlchemyError:
        session.rollback()
        _raise_database_unavailable()


@app.post(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/invoices/{{invoice_id}}/issue",
    response_model=InvoiceResponse,
)
def issue_invoice(
    organization_id: UUID,
    invoice_id: UUID,
    authorization: AuthorizedOrganization = Depends(get_update_authorization),
    session: Session = Depends(_database_session),
) -> InvoiceResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        invoice = session.scalar(
            _invoice_query(organization_id)
            .where(Invoice.id == invoice_id)
            .with_for_update()
        )
        if invoice is None:
            raise HTTPException(status_code=404, detail="Invoice not found")
        if invoice.status != "draft":
            raise HTTPException(status_code=409, detail="Invoice is already issued")
        if not invoice.lines or invoice.total <= 0:
            raise HTTPException(
                status_code=422, detail="An invoice must contain a positive line total"
            )
        lease = session.scalar(
            select(Lease).where(
                Lease.id == invoice.lease_id,
                Lease.organization_id == organization_id,
            )
        )
        if lease is None:
            raise HTTPException(status_code=404, detail="Lease not found")
        invoice.status = "issued"
        invoice.issued_at = datetime.now(timezone.utc)
        invoice.audit_events.append(
            InvoiceAuditEvent(
                organization_id=organization_id,
                actor_id=authorization.actor_id,
                event_type="issued",
                changed_fields=["status", "issued_at", "total"],
            )
        )
        session.commit()
        return _invoice_response(session, invoice, lease)
    except HTTPException:
        session.rollback()
        raise
    except SQLAlchemyError:
        session.rollback()
        _raise_database_unavailable()


@app.get(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/leases/{{lease_id}}/receivables",
    response_model=LeaseReceivablesResponse,
)
def lease_receivables(
    organization_id: UUID,
    lease_id: UUID,
    authorization: AuthorizedOrganization = Depends(get_read_authorization),
    session: Session = Depends(_database_session),
) -> LeaseReceivablesResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        lease = session.scalar(
            select(Lease).where(
                Lease.id == lease_id, Lease.organization_id == organization_id
            )
        )
        if lease is None:
            raise HTTPException(status_code=404, detail="Lease not found")
        invoices = list(
            session.scalars(
                _invoice_query(organization_id)
                .where(Invoice.lease_id == lease_id, Invoice.status == "issued")
                .order_by(Invoice.due_date, Invoice.invoice_number)
            )
        )
        items = [
            _invoice_response(session, invoice, lease) for invoice in invoices
        ]
    except HTTPException:
        raise
    except SQLAlchemyError:
        _raise_database_unavailable()
    return LeaseReceivablesResponse(
        lease_id=lease.id,
        lease_reference=lease.lease_reference,
        currency=lease.currency,
        issued_total=_money_text(
            sum((Decimal(item.total) for item in items), Decimal("0.00"))
        ),
        allocated_total=_money_text(
            sum((Decimal(item.allocated_amount) for item in items), Decimal("0.00"))
        ),
        outstanding_total=_money_text(
            sum(
                (Decimal(item.outstanding_balance) for item in items),
                Decimal("0.00"),
            )
        ),
        overdue_total=_money_text(
            sum(
                (
                    Decimal(item.outstanding_balance)
                    for item in items
                    if item.receivable_status == "overdue"
                ),
                Decimal("0.00"),
            )
        ),
        invoices=items,
    )


def _payment_fingerprint(payload: PaymentCreateRequest) -> str:
    canonical = payload.model_dump(mode="json", exclude={"idempotency_key"})
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


@app.get(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/payments",
    response_model=list[PaymentResponse],
)
def list_payments(
    organization_id: UUID,
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
    authorization: AuthorizedOrganization = Depends(get_read_authorization),
    session: Session = Depends(_database_session),
) -> list[PaymentResponse]:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        payments = list(
            session.scalars(
                select(Payment)
                .options(selectinload(Payment.audit_events))
                .where(Payment.organization_id == organization_id)
                .order_by(Payment.received_on.desc(), Payment.id)
                .limit(limit)
                .offset(offset)
            )
        )
        return [_payment_response(session, payment) for payment in payments]
    except SQLAlchemyError:
        _raise_database_unavailable()


@app.post(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/payments",
    response_model=PaymentResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_payment(
    organization_id: UUID,
    payload: PaymentCreateRequest,
    authorization: AuthorizedOrganization = Depends(get_create_authorization),
    session: Session = Depends(_database_session),
) -> PaymentResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    fingerprint = _payment_fingerprint(payload)
    try:
        existing = session.scalar(
            select(Payment)
            .options(selectinload(Payment.audit_events))
            .where(
                Payment.organization_id == organization_id,
                Payment.idempotency_key == payload.idempotency_key,
            )
        )
        if existing is not None:
            if existing.request_fingerprint != fingerprint:
                raise HTTPException(
                    status_code=409,
                    detail="Idempotency key was already used for different payment data",
                )
            return _payment_response(session, existing)

        invoice_ids = sorted({item.invoice_id for item in payload.allocations}, key=str)
        invoices = list(
            session.scalars(
                select(Invoice)
                .where(
                    Invoice.organization_id == organization_id,
                    Invoice.id.in_(invoice_ids),
                )
                .order_by(Invoice.id)
                .with_for_update()
            )
        )
        by_id = {invoice.id: invoice for invoice in invoices}
        if len(by_id) != len(invoice_ids):
            raise HTTPException(status_code=404, detail="An allocated invoice was not found")
        existing = session.scalar(
            select(Payment)
            .options(selectinload(Payment.audit_events))
            .where(
                Payment.organization_id == organization_id,
                Payment.idempotency_key == payload.idempotency_key,
            )
        )
        if existing is not None:
            if existing.request_fingerprint != fingerprint:
                raise HTTPException(
                    status_code=409,
                    detail="Idempotency key was already used for different payment data",
                )
            return _payment_response(session, existing)
        for item in payload.allocations:
            invoice = by_id[item.invoice_id]
            if invoice.status != "issued":
                raise HTTPException(
                    status_code=409, detail="Payments may only be allocated to issued invoices"
                )
            if invoice.currency != payload.currency:
                raise HTTPException(
                    status_code=422, detail="Payment and invoice currencies must match"
                )
            outstanding = Decimal(invoice.total) - _invoice_allocated_amount(
                session, invoice.id, organization_id
            )
            if item.amount > outstanding:
                raise HTTPException(
                    status_code=409,
                    detail="Payment allocation exceeds invoice outstanding balance",
                )

        payment = Payment(
            organization_id=organization_id,
            idempotency_key=payload.idempotency_key,
            request_fingerprint=fingerprint,
            reference=payload.reference,
            received_on=payload.received_on,
            currency=payload.currency,
            amount=payload.amount,
            method_description=payload.method_description,
        )
        payment.allocations = [
            PaymentAllocation(
                organization_id=organization_id,
                invoice_id=item.invoice_id,
                amount=item.amount,
            )
            for item in payload.allocations
        ]
        payment.audit_events.append(
            PaymentAuditEvent(
                organization_id=organization_id,
                actor_id=authorization.actor_id,
                event_type="recorded",
                changed_fields=[
                    "reference",
                    "received_on",
                    "currency",
                    "amount",
                    "method_description",
                    "allocations",
                ],
            )
        )
        session.add(payment)
        session.commit()
        return _payment_response(session, payment)
    except HTTPException:
        session.rollback()
        raise
    except IntegrityError:
        session.rollback()
        try:
            existing = session.scalar(
                select(Payment)
                .options(selectinload(Payment.audit_events))
                .where(
                    Payment.organization_id == organization_id,
                    Payment.idempotency_key == payload.idempotency_key,
                )
            )
        except SQLAlchemyError:
            _raise_database_unavailable()
        if existing is not None and existing.request_fingerprint == fingerprint:
            return _payment_response(session, existing)
        raise HTTPException(
            status_code=409, detail="Payment conflicts with existing data"
        ) from None
    except SQLAlchemyError:
        session.rollback()
        _raise_database_unavailable()


@app.get(
    f"{API_V1_PREFIX}/organizations/{{organization_id}}/leases",
    response_model=LeaseListResponse,
)
def list_leases(
    organization_id: UUID,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
    status_filter: str | None = Query(default=None, alias="status"),
    search: str | None = Query(default=None, min_length=1, max_length=100),
    sort_by: str = Query(default="updated_at"),
    sort_direction: str = Query(default="desc"),
    authorization: AuthorizedOrganization = Depends(get_read_authorization),
    session: Session = Depends(_database_session),
) -> LeaseListResponse:
    if authorization.organization_id != organization_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if status_filter is not None and status_filter not in {
        "draft",
        "active",
        "expired",
        "terminated",
    }:
        raise HTTPException(status_code=422, detail="Invalid lease status")
    search_term = search.strip() if search is not None else None
    if search is not None and not search_term:
        raise HTTPException(status_code=422, detail="Invalid lease search")
    sort_columns = {
        "lease_reference": Lease.lease_reference,
        "status": Lease.status,
        "start_date": Lease.start_date,
        "expiry_date": Lease.expiry_date,
        "rent_amount": Lease.rent_amount,
        "updated_at": Lease.updated_at,
    }
    if sort_by not in sort_columns or sort_direction not in {"asc", "desc"}:
        raise HTTPException(status_code=422, detail="Invalid lease sort")

    filters = [Lease.organization_id == organization_id]
    if status_filter is not None:
        filters.append(Lease.status == status_filter)
    if search_term is not None:
        term = f"%{search_term}%"
        matching_party = (
            select(LeaseParty.id)
            .where(
                LeaseParty.lease_id == Lease.id,
                LeaseParty.organization_id == organization_id,
                LeaseParty.legal_name.ilike(term),
            )
            .exists()
        )
        filters.append(or_(Lease.lease_reference.ilike(term), matching_party))
    try:
        total = session.scalar(select(func.count(Lease.id)).where(*filters)) or 0
        leases = list(
            session.scalars(
                select(Lease)
                .options(selectinload(Lease.units), selectinload(Lease.parties))
                .where(*filters)
                .order_by(
                    getattr(sort_columns[sort_by], sort_direction)(),
                    Lease.id.asc(),
                )
                .limit(limit)
                .offset(offset)
            )
        )
    except SQLAlchemyError:
        _raise_database_unavailable()
    return LeaseListResponse(
        items=[_summary_response(lease) for lease in leases],
        total=total,
        limit=limit,
        offset=offset,
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
    unavailable = _verify_units(
        organization_id,
        lease.units,
        user_token,
        allow_unavailable=True,
    )
    return _response(lease, unavailable)


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
            .with_for_update()
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
    if "start_date" in updates or "expiry_date" in updates:
        try:
            conflicting_schedule = session.scalar(
                select(RentSchedule.id)
                .where(
                    RentSchedule.organization_id == organization_id,
                    RentSchedule.lease_id == lease_id,
                    (
                        (RentSchedule.start_date < merged_start)
                        | (RentSchedule.end_date > merged_expiry)
                    ),
                )
                .limit(1)
            )
        except SQLAlchemyError:
            _raise_database_unavailable()
        if conflicting_schedule is not None:
            raise HTTPException(
                status_code=409,
                detail="Lease dates cannot exclude an existing rent schedule",
            )
    if "currency" in updates and updates["currency"] != lease.currency:
        try:
            has_schedule = session.scalar(
                select(RentSchedule.id)
                .where(
                    RentSchedule.organization_id == organization_id,
                    RentSchedule.lease_id == lease_id,
                )
                .limit(1)
            )
        except SQLAlchemyError:
            _raise_database_unavailable()
        if has_schedule is not None:
            raise HTTPException(
                status_code=409,
                detail="Lease currency cannot change while rent schedules exist",
            )
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
