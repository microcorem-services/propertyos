from alembic import op
import sqlalchemy as sa


revision = "0002_sites"
down_revision = "0001_initial_portfolio"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_portfolios_id_organization",
        "portfolios",
        ["id", "organization_id"],
    )
    op.create_table(
        "sites",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("portfolio_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("address", sa.Text(), nullable=True),
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
            name="ck_sites_name_not_empty",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'inactive')",
            name="ck_sites_status",
        ),
        sa.ForeignKeyConstraint(
            ["portfolio_id", "organization_id"],
            ["portfolios.id", "portfolios.organization_id"],
            name="fk_sites_portfolio_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_sites_organization_id",
        "sites",
        ["organization_id"],
        unique=False,
    )
    op.create_index(
        "ix_sites_portfolio_id",
        "sites",
        ["portfolio_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_sites_portfolio_id", table_name="sites")
    op.drop_index("ix_sites_organization_id", table_name="sites")
    op.drop_table("sites")
    op.drop_constraint(
        "uq_portfolios_id_organization",
        "portfolios",
        type_="unique",
    )
