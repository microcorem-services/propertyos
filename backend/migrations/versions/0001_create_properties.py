from alembic import op
import sqlalchemy as sa

revision = "0001_create_properties"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "properties",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("location", sa.String(length=120), nullable=False),
        sa.Column("units", sa.Integer(), nullable=False),
        sa.Column("occupied", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.CheckConstraint("units > 0", name="ck_properties_units_positive"),
        sa.CheckConstraint(
            "occupied >= 0 AND occupied <= units", name="ck_properties_occupancy"
        ),
        sa.CheckConstraint(
            "status IN ('Operational', 'Review', 'Maintenance')",
            name="ck_properties_status",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_properties_name"), "properties", ["name"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_properties_name"), table_name="properties")
    op.drop_table("properties")