from alembic import op
import sqlalchemy as sa


revision = "0007_building_audit"
down_revision = "0006_site_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "building_audit_events",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("building_id", sa.Uuid(as_uuid=True), nullable=False),
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
            "operation IN ('property-assets.buildings.create', "
            "'property-assets.buildings.update')",
            name="ck_building_audit_operation",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_building_audit_organization_building",
        "building_audit_events",
        ["organization_id", "building_id"],
        unique=False,
    )
    op.create_index(
        "ix_building_audit_occurred_at",
        "building_audit_events",
        ["occurred_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_building_audit_occurred_at",
        table_name="building_audit_events",
    )
    op.drop_index(
        "ix_building_audit_organization_building",
        table_name="building_audit_events",
    )
    op.drop_table("building_audit_events")
