from alembic import op
import sqlalchemy as sa


revision = "0003_buildings"
down_revision = "0002_sites"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_sites_id_organization",
        "sites",
        ["id", "organization_id"],
    )
    op.create_table(
        "buildings",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("site_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("building_code", sa.String(length=100), nullable=True),
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
            name="ck_buildings_name_not_empty",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'inactive')",
            name="ck_buildings_status",
        ),
        sa.ForeignKeyConstraint(
            ["site_id", "organization_id"],
            ["sites.id", "sites.organization_id"],
            name="fk_buildings_site_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_buildings_organization_id",
        "buildings",
        ["organization_id"],
        unique=False,
    )
    op.create_index(
        "ix_buildings_site_id",
        "buildings",
        ["site_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_buildings_site_id", table_name="buildings")
    op.drop_index("ix_buildings_organization_id", table_name="buildings")
    op.drop_table("buildings")
    op.drop_constraint(
        "uq_sites_id_organization",
        "sites",
        type_="unique",
    )
