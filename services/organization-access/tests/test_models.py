from datetime import UTC

from sqlalchemy import CheckConstraint, DateTime, ForeignKeyConstraint, UniqueConstraint
from sqlalchemy.sql.sqltypes import Uuid

from app.models import (
    Base,
    Membership,
    MembershipRole,
    MembershipStatus,
    Organization,
    OrganizationStatus,
    User,
)


def test_model_tables_and_primary_keys_are_declared():
    assert set(Base.metadata.tables) == {"organizations", "users", "memberships"}

    for model in (Organization, User, Membership):
        table = model.__table__
        assert len(table.primary_key.columns) == 1
        assert isinstance(table.primary_key.columns[0].type, Uuid)
        assert table.primary_key.columns[0].nullable is False


def test_required_fields_and_utc_timestamps_are_declared():
    required_columns = (
        (Organization, ("name", "status", "created_at", "updated_at")),
        (User, ("external_subject", "created_at")),
        (
            Membership,
            ("organization_id", "user_id", "role", "status", "created_at"),
        ),
    )
    for model, names in required_columns:
        for name in names:
            column = model.__table__.c[name]
            assert column.nullable is False
            if name.endswith("_at"):
                assert isinstance(column.type, DateTime)
                assert column.type.timezone is True


def test_timestamp_python_defaults_are_utc():
    timestamp_columns = (
        Organization.__table__.c.created_at,
        Organization.__table__.c.updated_at,
        User.__table__.c.created_at,
        Membership.__table__.c.created_at,
    )
    for column in timestamp_columns:
        assert column.default is not None
        assert column.default.arg(None).utcoffset() == UTC.utcoffset(None)

    assert (
        Organization.__table__.c.updated_at.onupdate.arg(None).utcoffset()
        == UTC.utcoffset(None)
    )


def test_user_subject_and_organization_membership_pairs_are_unique():
    assert User.__table__.c.external_subject.unique is True
    assert User.__table__.c.external_subject.index is True

    membership_unique_constraints = {
        constraint.name: tuple(column.name for column in constraint.columns)
        for constraint in Membership.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert membership_unique_constraints == {
        "uq_memberships_organization_user": ("organization_id", "user_id")
    }


def test_membership_foreign_keys_and_lookup_indexes_are_declared():
    foreign_keys = {
        foreign_key.target_fullname
        for constraint in Membership.__table__.constraints
        if isinstance(constraint, ForeignKeyConstraint)
        for foreign_key in constraint.elements
    }
    assert foreign_keys == {"organizations.id", "users.id"}

    indexes = {
        tuple(column.name for column in index.columns)
        for index in Membership.__table__.indexes
    }
    assert ("user_id",) in indexes
    assert ("organization_id", "status") in indexes


def test_organization_lookup_indexes_are_declared():
    indexes = {
        tuple(column.name for column in index.columns)
        for index in Organization.__table__.indexes
    }
    assert ("name",) in indexes
    assert ("status",) in indexes


def test_database_checks_and_supported_values_are_explicit():
    def check_names(model):
        return {
            constraint.name
            for constraint in model.__table__.constraints
            if isinstance(constraint, CheckConstraint)
        }

    assert check_names(Organization) == {
        "ck_organizations_name_not_empty",
        "ck_organizations_status",
    }
    assert check_names(User) == {"ck_users_external_subject_not_empty"}
    assert check_names(Membership) == {
        "ck_memberships_role",
        "ck_memberships_status",
    }
    assert {value.value for value in OrganizationStatus} == {"active", "suspended"}
    assert {value.value for value in MembershipRole} == {"owner", "admin", "member"}
    assert {value.value for value in MembershipStatus} == {
        "invited",
        "active",
        "suspended",
    }
