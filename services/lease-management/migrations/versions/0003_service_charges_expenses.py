import sqlalchemy as sa
from alembic import op

revision = "0003_service_charges_expenses"
down_revision = "0002_rent_schedules"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rent_schedules",
        sa.Column("description", sa.String(length=250), nullable=True),
    )
    op.execute(
        "UPDATE rent_schedules SET description = 'Base rent' WHERE description IS NULL"
    )
    op.alter_column(
        "rent_schedules",
        "description",
        existing_type=sa.String(length=250),
        nullable=False,
    )
    op.drop_constraint(
        "ck_rent_schedules_category", "rent_schedules", type_="check"
    )
    op.create_check_constraint(
        "ck_rent_schedules_category",
        "rent_schedules",
        "charge_category IN ('base_rent', 'service_charge', "
        "'building_maintenance', 'insurance_contribution', "
        "'shared_facilities', 'other_property_charge')",
    )
    op.create_check_constraint(
        "ck_rent_schedules_description",
        "rent_schedules",
        "length(trim(description)) > 0",
    )

    op.drop_constraint(
        "ck_lease_audit_event_type", "lease_audit_events", type_="check"
    )
    op.create_check_constraint(
        "ck_lease_audit_event_type",
        "lease_audit_events",
        "event_type IN ('created', 'updated', 'rent_schedule_created', "
        "'rent_schedule_updated', 'rent_schedule_activated', "
        "'rent_schedule_generated', 'charge_created', 'charge_updated', "
        "'charge_activated', 'charge_generated')",
    )

    op.create_table(
        "property_expenses",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("idempotency_key", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("asset_level", sa.String(length=20), nullable=False),
        sa.Column("portfolio_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("site_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("building_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("unit_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("category", sa.String(length=40), nullable=False),
        sa.Column("description", sa.String(length=250), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("expense_date", sa.Date(), nullable=False),
        sa.Column("recoverability", sa.String(length=20), nullable=False),
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
            "asset_level IN ('portfolio', 'site', 'building', 'unit')",
            name="ck_property_expenses_asset_level",
        ),
        sa.CheckConstraint(
            "category IN ('utilities', 'maintenance', 'insurance', 'repairs', "
            "'cleaning', 'security', 'shared_facilities', 'other')",
            name="ck_property_expenses_category",
        ),
        sa.CheckConstraint(
            "length(trim(description)) > 0", name="ck_property_expenses_description"
        ),
        sa.CheckConstraint("amount > 0", name="ck_property_expenses_amount_positive"),
        sa.CheckConstraint(
            "currency IN ('GBP', 'EUR', 'USD')", name="ck_property_expenses_currency"
        ),
        sa.CheckConstraint(
            "recoverability IN ('recoverable', 'non_recoverable')",
            name="ck_property_expenses_recoverability",
        ),
        sa.CheckConstraint(
            "(asset_level = 'portfolio' AND site_id IS NULL "
            "AND building_id IS NULL AND unit_id IS NULL) OR "
            "(asset_level = 'site' AND site_id IS NOT NULL "
            "AND building_id IS NULL AND unit_id IS NULL) OR "
            "(asset_level = 'building' AND site_id IS NOT NULL "
            "AND building_id IS NOT NULL AND unit_id IS NULL) OR "
            "(asset_level = 'unit' AND site_id IS NOT NULL "
            "AND building_id IS NOT NULL AND unit_id IS NOT NULL)",
            name="ck_property_expenses_asset_hierarchy",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "id", "organization_id", name="uq_property_expenses_id_organization"
        ),
        sa.UniqueConstraint(
            "organization_id",
            "idempotency_key",
            name="uq_property_expenses_idempotency",
        ),
    )
    op.create_index(
        "ix_property_expenses_organization_date",
        "property_expenses",
        ["organization_id", "expense_date"],
    )
    op.create_index(
        "ix_property_expenses_organization_asset_date",
        "property_expenses",
        [
            "organization_id",
            "asset_level",
            "portfolio_id",
            "site_id",
            "building_id",
            "unit_id",
            "expense_date",
        ],
    )
    op.create_table(
        "property_expense_audit_events",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("expense_id", sa.Uuid(as_uuid=True), nullable=False),
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
            "event_type IN ('created', 'updated')",
            name="ck_property_expense_audit_event_type",
        ),
        sa.ForeignKeyConstraint(
            ["expense_id", "organization_id"],
            ["property_expenses.id", "property_expenses.organization_id"],
            name="fk_property_expense_audit_expense_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_property_expense_audit_organization_expense_occurred",
        "property_expense_audit_events",
        ["organization_id", "expense_id", "occurred_at"],
    )


def downgrade() -> None:
    connection = op.get_bind()
    has_expenses = connection.execute(
        sa.text("SELECT EXISTS (SELECT 1 FROM property_expenses)")
    ).scalar()
    has_non_base_charges = connection.execute(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM rent_schedules "
            "WHERE charge_category <> 'base_rent')"
        )
    ).scalar()
    if has_expenses or has_non_base_charges:
        raise RuntimeError(
            "Cannot downgrade while service charges or property expenses exist."
        )

    op.drop_index(
        "ix_property_expense_audit_organization_expense_occurred",
        table_name="property_expense_audit_events",
    )
    op.drop_table("property_expense_audit_events")
    op.drop_index(
        "ix_property_expenses_organization_asset_date",
        table_name="property_expenses",
    )
    op.drop_index(
        "ix_property_expenses_organization_date", table_name="property_expenses"
    )
    op.drop_table("property_expenses")

    op.execute(
        "UPDATE lease_audit_events SET event_type = "
        "CASE event_type "
        "WHEN 'charge_created' THEN 'rent_schedule_created' "
        "WHEN 'charge_updated' THEN 'rent_schedule_updated' "
        "WHEN 'charge_activated' THEN 'rent_schedule_activated' "
        "WHEN 'charge_generated' THEN 'rent_schedule_generated' "
        "ELSE event_type END"
    )
    op.drop_constraint(
        "ck_lease_audit_event_type", "lease_audit_events", type_="check"
    )
    op.create_check_constraint(
        "ck_lease_audit_event_type",
        "lease_audit_events",
        "event_type IN ('created', 'updated', 'rent_schedule_created', "
        "'rent_schedule_updated', 'rent_schedule_activated', "
        "'rent_schedule_generated')",
    )

    op.drop_constraint(
        "ck_rent_schedules_description", "rent_schedules", type_="check"
    )
    op.drop_constraint(
        "ck_rent_schedules_category", "rent_schedules", type_="check"
    )
    op.create_check_constraint(
        "ck_rent_schedules_category",
        "rent_schedules",
        "charge_category = 'base_rent'",
    )
    op.drop_column("rent_schedules", "description")
