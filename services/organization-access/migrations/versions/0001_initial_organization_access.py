from alembic import op
import sqlalchemy as sa


revision = "0001_org_access_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "organizations",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
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
            name="ck_organizations_name_not_empty",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'suspended')",
            name="ck_organizations_status",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_organizations_name", "organizations", ["name"], unique=False)
    op.create_index("ix_organizations_status", "organizations", ["status"], unique=False)

    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("external_subject", sa.String(length=255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "length(trim(external_subject)) > 0",
            name="ck_users_external_subject_not_empty",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_users_external_subject",
        "users",
        ["external_subject"],
        unique=True,
    )

    op.create_table(
        "memberships",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("organization_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("user_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('owner', 'admin', 'member')",
            name="ck_memberships_role",
        ),
        sa.CheckConstraint(
            "status IN ('invited', 'active', 'suspended')",
            name="ck_memberships_status",
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "organization_id",
            "user_id",
            name="uq_memberships_organization_user",
        ),
    )
    op.create_index(
        "ix_memberships_user_id",
        "memberships",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        "ix_memberships_organization_status",
        "memberships",
        ["organization_id", "status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_memberships_organization_status", table_name="memberships")
    op.drop_index("ix_memberships_user_id", table_name="memberships")
    op.drop_table("memberships")
    op.drop_index("ix_users_external_subject", table_name="users")
    op.drop_table("users")
    op.drop_index("ix_organizations_status", table_name="organizations")
    op.drop_index("ix_organizations_name", table_name="organizations")
    op.drop_table("organizations")
