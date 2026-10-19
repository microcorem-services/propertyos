from alembic import op
import sqlalchemy as sa


revision = "0001_initial_portfolio"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "portfolios",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
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
            "length(trim(name)) > 0",
            name="ck_portfolios_name_not_empty",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'inactive')",
            name="ck_portfolios_status",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_portfolios_organization_id",
        "portfolios",
        ["organization_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_portfolios_organization_id", table_name="portfolios")
    op.drop_table("portfolios")
