from alembic import op
import sqlalchemy as sa


revision = "0006_site_audit"
down_revision = "0005_portfolio_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "site_audit_events",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("site_id", sa.Uuid(as_uuid=True), nullable=False),
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
            "operation IN ('property-assets.sites.create', "
            "'property-assets.sites.update')",
            name="ck_site_audit_operation",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_site_audit_organization_site",
        "site_audit_events",
        ["organization_id", "site_id"],
        unique=False,
    )
    op.create_index(
        "ix_site_audit_occurred_at",
        "site_audit_events",
        ["occurred_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_site_audit_occurred_at", table_name="site_audit_events")
    op.drop_index(
        "ix_site_audit_organization_site",
        table_name="site_audit_events",
    )
    op.drop_table("site_audit_events")
