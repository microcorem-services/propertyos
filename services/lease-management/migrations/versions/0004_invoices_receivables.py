import sqlalchemy as sa
from alembic import op

revision = "0004_invoices_receivables"
down_revision = "0003_service_charges_expenses"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_rent_installments_id_organization",
        "rent_installments",
        ["id", "organization_id"],
    )
    op.create_table(
        "invoices",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("lease_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("invoice_number", sa.String(length=100), nullable=False),
        sa.Column("issue_date", sa.Date(), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("subtotal", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("total", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "length(trim(invoice_number)) > 0", name="ck_invoices_number"
        ),
        sa.CheckConstraint(
            "currency IN ('GBP', 'EUR', 'USD')", name="ck_invoices_currency"
        ),
        sa.CheckConstraint("due_date >= issue_date", name="ck_invoices_dates"),
        sa.CheckConstraint(
            "status IN ('draft', 'issued')", name="ck_invoices_status"
        ),
        sa.CheckConstraint("subtotal >= 0 AND total >= 0", name="ck_invoices_totals"),
        sa.ForeignKeyConstraint(
            ["lease_id", "organization_id"],
            ["leases.id", "leases.organization_id"],
            name="fk_invoices_lease_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_invoices_id_organization"),
        sa.UniqueConstraint(
            "organization_id",
            "invoice_number",
            name="uq_invoices_organization_number",
        ),
    )
    op.create_index(
        "ix_invoices_organization_status_due",
        "invoices",
        ["organization_id", "status", "due_date"],
    )
    op.create_index(
        "ix_invoices_organization_lease", "invoices", ["organization_id", "lease_id"]
    )
    op.create_table(
        "invoice_lines",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("invoice_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("source_installment_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("description", sa.String(length=250), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=12, scale=3), nullable=False),
        sa.Column("unit_amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("line_total", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.CheckConstraint(
            "length(trim(description)) > 0", name="ck_invoice_lines_description"
        ),
        sa.CheckConstraint("quantity > 0", name="ck_invoice_lines_quantity"),
        sa.CheckConstraint("unit_amount >= 0", name="ck_invoice_lines_unit_amount"),
        sa.CheckConstraint("line_total >= 0", name="ck_invoice_lines_total"),
        sa.ForeignKeyConstraint(
            ["invoice_id", "organization_id"],
            ["invoices.id", "invoices.organization_id"],
            name="fk_invoice_lines_invoice_organization",
        ),
        sa.ForeignKeyConstraint(
            ["source_installment_id", "organization_id"],
            ["rent_installments.id", "rent_installments.organization_id"],
            name="fk_invoice_lines_installment_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "source_installment_id", name="uq_invoice_lines_source_installment"
        ),
    )
    op.create_index(
        "ix_invoice_lines_organization_invoice",
        "invoice_lines",
        ["organization_id", "invoice_id"],
    )
    op.create_table(
        "invoice_audit_events",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("invoice_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("actor_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.String(length=20), nullable=False),
        sa.Column("changed_fields", sa.JSON(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "event_type IN ('created', 'updated', 'issued')",
            name="ck_invoice_audit_event_type",
        ),
        sa.ForeignKeyConstraint(
            ["invoice_id", "organization_id"],
            ["invoices.id", "invoices.organization_id"],
            name="fk_invoice_audit_invoice_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_invoice_audit_organization_invoice_occurred",
        "invoice_audit_events",
        ["organization_id", "invoice_id", "occurred_at"],
    )
    op.create_table(
        "payments",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("idempotency_key", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("reference", sa.String(length=100), nullable=False),
        sa.Column("received_on", sa.Date(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("method_description", sa.String(length=100), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "length(trim(reference)) > 0", name="ck_payments_reference"
        ),
        sa.CheckConstraint(
            "length(trim(method_description)) > 0", name="ck_payments_method"
        ),
        sa.CheckConstraint("amount > 0", name="ck_payments_amount"),
        sa.CheckConstraint(
            "currency IN ('GBP', 'EUR', 'USD')", name="ck_payments_currency"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_payments_id_organization"),
        sa.UniqueConstraint(
            "organization_id", "idempotency_key", name="uq_payments_idempotency"
        ),
    )
    op.create_index(
        "ix_payments_organization_received",
        "payments",
        ["organization_id", "received_on"],
    )
    op.create_table(
        "payment_allocations",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("payment_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("invoice_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_payment_allocations_amount"),
        sa.ForeignKeyConstraint(
            ["payment_id", "organization_id"],
            ["payments.id", "payments.organization_id"],
            name="fk_payment_allocations_payment_organization",
        ),
        sa.ForeignKeyConstraint(
            ["invoice_id", "organization_id"],
            ["invoices.id", "invoices.organization_id"],
            name="fk_payment_allocations_invoice_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "payment_id",
            "invoice_id",
            name="uq_payment_allocations_payment_invoice",
        ),
    )
    op.create_index(
        "ix_payment_allocations_organization_invoice",
        "payment_allocations",
        ["organization_id", "invoice_id"],
    )
    op.create_table(
        "payment_audit_events",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("payment_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("actor_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.String(length=20), nullable=False),
        sa.Column("changed_fields", sa.JSON(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "event_type = 'recorded'", name="ck_payment_audit_event_type"
        ),
        sa.ForeignKeyConstraint(
            ["payment_id", "organization_id"],
            ["payments.id", "payments.organization_id"],
            name="fk_payment_audit_payment_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_payment_audit_organization_payment_occurred",
        "payment_audit_events",
        ["organization_id", "payment_id", "occurred_at"],
    )
    op.execute(
        """
        CREATE FUNCTION reject_issued_invoice_mutation() RETURNS trigger AS $$
        BEGIN
            IF TG_OP <> 'INSERT' AND OLD.status = 'issued' THEN
                RAISE EXCEPTION 'Issued invoice content is immutable';
            END IF;
            IF TG_OP = 'DELETE' THEN
                RETURN OLD;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        CREATE FUNCTION reject_issued_invoice_line_mutation() RETURNS trigger AS $$
        BEGIN
            IF TG_OP <> 'INSERT' AND EXISTS (
                SELECT 1 FROM invoices
                WHERE id = OLD.invoice_id AND status = 'issued'
            ) THEN
                RAISE EXCEPTION 'Issued invoice lines are immutable';
            END IF;
            IF TG_OP <> 'DELETE' AND EXISTS (
                SELECT 1 FROM invoices
                WHERE id = NEW.invoice_id AND status = 'issued'
            ) THEN
                RAISE EXCEPTION 'Issued invoice lines are immutable';
            END IF;
            IF TG_OP = 'DELETE' THEN
                RETURN OLD;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_issued_invoice_immutable
        BEFORE UPDATE OR DELETE ON invoices
        FOR EACH ROW EXECUTE FUNCTION reject_issued_invoice_mutation()
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_issued_invoice_lines_immutable
        BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
        FOR EACH ROW EXECUTE FUNCTION reject_issued_invoice_line_mutation()
        """
    )


def downgrade() -> None:
    connection = op.get_bind()
    has_records = any(
        connection.execute(
            sa.text(f"SELECT EXISTS (SELECT 1 FROM {table_name})")
        ).scalar()
        for table_name in (
            "payment_audit_events",
            "payment_allocations",
            "payments",
            "invoice_audit_events",
            "invoice_lines",
            "invoices",
        )
    )
    if has_records:
        raise RuntimeError("Cannot downgrade while invoices or payment records exist.")
    op.execute("DROP TRIGGER IF EXISTS trg_issued_invoice_lines_immutable ON invoice_lines")
    op.execute("DROP TRIGGER IF EXISTS trg_issued_invoice_immutable ON invoices")
    op.execute("DROP FUNCTION IF EXISTS reject_issued_invoice_line_mutation()")
    op.execute("DROP FUNCTION IF EXISTS reject_issued_invoice_mutation()")
    for index, table_name in (
        ("ix_payment_audit_organization_payment_occurred", "payment_audit_events"),
        ("ix_payment_allocations_organization_invoice", "payment_allocations"),
        ("ix_payments_organization_received", "payments"),
        ("ix_invoice_audit_organization_invoice_occurred", "invoice_audit_events"),
        ("ix_invoice_lines_organization_invoice", "invoice_lines"),
        ("ix_invoices_organization_lease", "invoices"),
        ("ix_invoices_organization_status_due", "invoices"),
    ):
        op.drop_index(index, table_name=table_name)
    for table_name in (
        "payment_audit_events",
        "payment_allocations",
        "payments",
        "invoice_audit_events",
        "invoice_lines",
        "invoices",
    ):
        op.drop_table(table_name)
    op.drop_constraint(
        "uq_rent_installments_id_organization",
        "rent_installments",
        type_="unique",
    )
