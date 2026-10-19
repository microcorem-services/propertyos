from alembic import op
import sqlalchemy as sa


revision = "0004_units"
down_revision = "0003_buildings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_buildings_id_organization",
        "buildings",
        ["id", "organization_id"],
    )
    op.create_table(
        "units",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("building_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("unit_code", sa.String(length=100), nullable=True),
        sa.Column("floor", sa.String(length=50), nullable=True),
        sa.Column("area_sqm", sa.Numeric(precision=12, scale=2), nullable=True),
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
            name="ck_units_name_not_empty",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'inactive')",
            name="ck_units_status",
        ),
        sa.CheckConstraint(
            "area_sqm IS NULL OR area_sqm > 0",
            name="ck_units_area_sqm_positive",
        ),
        sa.ForeignKeyConstraint(
            ["building_id", "organization_id"],
            ["buildings.id", "buildings.organization_id"],
            name="fk_units_building_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_units_organization_id",
        "units",
        ["organization_id"],
        unique=False,
    )
    op.create_index(
        "ix_units_building_id",
        "units",
        ["building_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_units_building_id", table_name="units")
    op.drop_index("ix_units_organization_id", table_name="units")
    op.drop_table("units")
    op.drop_constraint(
        "uq_buildings_id_organization",
        "buildings",
        type_="unique",
    )
