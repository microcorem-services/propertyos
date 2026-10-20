from alembic import op
import sqlalchemy as sa


revision = "0005_portfolio_audit"
down_revision = "0004_units"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "portfolio_audit_events",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("portfolio_id", sa.Uuid(as_uuid=True), nullable=False),
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
            "operation IN ('property-assets.portfolios.create', "
            "'property-assets.portfolios.update')",
            name="ck_portfolio_audit_operation",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_portfolio_audit_organization_portfolio",
        "portfolio_audit_events",
        ["organization_id", "portfolio_id"],
        unique=False,
    )
    op.create_index(
        "ix_portfolio_audit_occurred_at",
        "portfolio_audit_events",
        ["occurred_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_portfolio_audit_occurred_at",
        table_name="portfolio_audit_events",
    )
    op.drop_index(
        "ix_portfolio_audit_organization_portfolio",
        table_name="portfolio_audit_events",
    )
    op.drop_table("portfolio_audit_events")
