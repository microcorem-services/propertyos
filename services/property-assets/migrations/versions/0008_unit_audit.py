from alembic import op
import sqlalchemy as sa


revision = "0008_unit_audit"
down_revision = "0007_building_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "unit_audit_events",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("unit_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("operation", sa.String(length=64), nullable=False),
        sa.Column("actor_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("changed_fields", sa.JSON(), nullable=False),
        sa.CheckConstraint(
            "operation IN ('property-assets.units.create', "
            "'property-assets.units.update')",
            name="ck_unit_audit_operation",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_unit_audit_organization_unit",
        "unit_audit_events",
        ["organization_id", "unit_id"],
        unique=False,
    )
    op.create_index(
        "ix_unit_audit_occurred_at",
        "unit_audit_events",
        ["occurred_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_unit_audit_occurred_at", table_name="unit_audit_events")
    op.drop_index(
        "ix_unit_audit_organization_unit",
        table_name="unit_audit_events",
    )
    op.drop_table("unit_audit_events")
