import sqlalchemy as sa
from alembic import op

revision = "0001_lease_management_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "leases",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("lease_reference", sa.String(length=100), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("expiry_date", sa.Date(), nullable=False),
        sa.Column("break_date", sa.Date(), nullable=True),
        sa.Column("rent_amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("payment_frequency", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
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
            "length(trim(lease_reference)) > 0", name="ck_leases_reference"
        ),
        sa.CheckConstraint("rent_amount > 0", name="ck_leases_rent_positive"),
        sa.CheckConstraint(
            "currency IN ('GBP', 'EUR', 'USD')", name="ck_leases_currency"
        ),
        sa.CheckConstraint(
            "payment_frequency IN ('monthly', 'quarterly', 'annually')",
            name="ck_leases_payment_frequency",
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'active', 'expired', 'terminated')",
            name="ck_leases_status",
        ),
        sa.CheckConstraint("expiry_date >= start_date", name="ck_leases_dates"),
        sa.CheckConstraint(
            "break_date IS NULL OR (break_date >= start_date "
            "AND break_date <= expiry_date)",
            name="ck_leases_break_date",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "organization_id",
            "lease_reference",
            name="uq_leases_organization_reference",
        ),
        sa.UniqueConstraint("id", "organization_id", name="uq_leases_id_organization"),
    )
    op.create_index(
        "ix_leases_organization_status", "leases", ["organization_id", "status"]
    )
    op.create_index(
        "ix_leases_organization_expiry", "leases", ["organization_id", "expiry_date"]
    )

    op.create_table(
        "lease_parties",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("lease_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("legal_name", sa.String(length=250), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("party_type", sa.String(length=20), nullable=False),
        sa.CheckConstraint(
            "length(trim(legal_name)) > 0", name="ck_lease_parties_name"
        ),
        sa.CheckConstraint(
            "role IN ('landlord', 'tenant', 'guarantor')", name="ck_lease_parties_role"
        ),
        sa.CheckConstraint(
            "party_type IN ('individual', 'organization')",
            name="ck_lease_parties_type",
        ),
        sa.ForeignKeyConstraint(
            ["lease_id", "organization_id"],
            ["leases.id", "leases.organization_id"],
            name="fk_lease_parties_lease_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_lease_parties_organization_lease",
        "lease_parties",
        ["organization_id", "lease_id"],
    )

    op.create_table(
        "lease_units",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("lease_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("unit_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("portfolio_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("site_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("building_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["lease_id", "organization_id"],
            ["leases.id", "leases.organization_id"],
            name="fk_lease_units_lease_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "organization_id", "lease_id", "unit_id", name="uq_lease_units_unit"
        ),
    )
    op.create_index(
        "ix_lease_units_organization_unit",
        "lease_units",
        ["organization_id", "unit_id"],
    )

    op.create_table(
        "lease_audit_events",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("lease_id", sa.Uuid(as_uuid=True), nullable=False),
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
            "event_type IN ('created', 'updated')", name="ck_lease_audit_event_type"
        ),
        sa.ForeignKeyConstraint(
            ["lease_id", "organization_id"],
            ["leases.id", "leases.organization_id"],
            name="fk_lease_audit_lease_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_lease_audit_organization_lease_occurred",
        "lease_audit_events",
        ["organization_id", "lease_id", "occurred_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_lease_audit_organization_lease_occurred",
        table_name="lease_audit_events",
    )
    op.drop_table("lease_audit_events")
    op.drop_index("ix_lease_units_organization_unit", table_name="lease_units")
    op.drop_table("lease_units")
    op.drop_index("ix_lease_parties_organization_lease", table_name="lease_parties")
    op.drop_table("lease_parties")
    op.drop_index("ix_leases_organization_expiry", table_name="leases")
    op.drop_index("ix_leases_organization_status", table_name="leases")
    op.drop_table("leases")
