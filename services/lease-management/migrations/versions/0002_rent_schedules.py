import sqlalchemy as sa
from alembic import op

revision = "0002_rent_schedules"
down_revision = "0001_lease_management_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "lease_audit_events",
        "event_type",
        existing_type=sa.String(length=20),
        type_=sa.String(length=30),
        existing_nullable=False,
    )
    op.drop_constraint("ck_lease_audit_event_type", "lease_audit_events", type_="check")
    op.create_check_constraint(
        "ck_lease_audit_event_type",
        "lease_audit_events",
        "event_type IN ('created', 'updated', 'rent_schedule_created', "
        "'rent_schedule_updated', 'rent_schedule_activated', "
        "'rent_schedule_generated')",
    )
    op.create_table(
        "rent_schedules",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("lease_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column(
            "charge_category",
            sa.String(length=40),
            server_default="base_rent",
            nullable=False,
        ),
        sa.Column(
            "amount_per_period", sa.Numeric(precision=14, scale=2), nullable=False
        ),
        sa.Column("payment_frequency", sa.String(length=20), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("due_day", sa.Integer(), nullable=False),
        sa.Column(
            "short_month_rule",
            sa.String(length=32),
            server_default="clamp_to_month_end",
            nullable=False,
        ),
        sa.Column(
            "status", sa.String(length=20), server_default="draft", nullable=False
        ),
        sa.Column("manual_review_reasons", sa.JSON(), nullable=False),
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
            "charge_category = 'base_rent'", name="ck_rent_schedules_category"
        ),
        sa.CheckConstraint(
            "amount_per_period > 0", name="ck_rent_schedules_amount_positive"
        ),
        sa.CheckConstraint(
            "payment_frequency IN ('monthly', 'quarterly', 'annually')",
            name="ck_rent_schedules_frequency",
        ),
        sa.CheckConstraint(
            "due_day BETWEEN 1 AND 31", name="ck_rent_schedules_due_day"
        ),
        sa.CheckConstraint(
            "short_month_rule = 'clamp_to_month_end'",
            name="ck_rent_schedules_short_month_rule",
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'active')", name="ck_rent_schedules_status"
        ),
        sa.CheckConstraint("end_date >= start_date", name="ck_rent_schedules_dates"),
        sa.ForeignKeyConstraint(
            ["lease_id", "organization_id"],
            ["leases.id", "leases.organization_id"],
            name="fk_rent_schedules_lease_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "id", "organization_id", name="uq_rent_schedules_id_organization"
        ),
    )
    op.create_index(
        "ix_rent_schedules_organization_lease",
        "rent_schedules",
        ["organization_id", "lease_id", "status"],
    )
    op.create_table(
        "rent_installments",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("schedule_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default="expected", nullable=False
        ),
        sa.CheckConstraint("amount > 0", name="ck_rent_installments_amount_positive"),
        sa.CheckConstraint(
            "currency IN ('GBP', 'EUR', 'USD')",
            name="ck_rent_installments_currency",
        ),
        sa.CheckConstraint("status = 'expected'", name="ck_rent_installments_status"),
        sa.ForeignKeyConstraint(
            ["schedule_id", "organization_id"],
            ["rent_schedules.id", "rent_schedules.organization_id"],
            name="fk_rent_installments_schedule_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "organization_id",
            "schedule_id",
            "due_date",
            name="uq_rent_installments_schedule_due_date",
        ),
    )
    op.create_index(
        "ix_rent_installments_organization_due_date",
        "rent_installments",
        ["organization_id", "due_date"],
    )


def downgrade() -> None:
    op.execute(
        "UPDATE lease_audit_events SET event_type = 'updated' "
        "WHERE event_type NOT IN ('created', 'updated')"
    )
    op.drop_index(
        "ix_rent_installments_organization_due_date",
        table_name="rent_installments",
    )
    op.drop_table("rent_installments")
    op.drop_index("ix_rent_schedules_organization_lease", table_name="rent_schedules")
    op.drop_table("rent_schedules")
    op.drop_constraint("ck_lease_audit_event_type", "lease_audit_events", type_="check")
    op.create_check_constraint(
        "ck_lease_audit_event_type",
        "lease_audit_events",
        "event_type IN ('created', 'updated')",
    )
    op.alter_column(
        "lease_audit_events",
        "event_type",
        existing_type=sa.String(length=30),
        type_=sa.String(length=20),
        existing_nullable=False,
    )
