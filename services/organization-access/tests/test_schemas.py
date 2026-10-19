from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.main import API_V1_PREFIX, api_router, app
from app.models import MembershipRole, MembershipStatus, OrganizationStatus
from app.schemas import (
    APIErrorResponse,
    MembershipResponse,
    OrganizationChooserItemResponse,
    OrganizationChooserPageResponse,
    OrganizationResponse,
    UserResponse,
)


def test_organization_response_validates_model_attributes():
    now = datetime.now(UTC)
    organization_id = uuid4()
    response = OrganizationResponse.model_validate(
        type(
            "OrganizationRecord",
            (),
            {
                "id": organization_id,
                "name": "Fictional Organization",
                "status": "active",
                "created_at": now,
                "updated_at": now,
            },
        )()
    )

    assert response.id == organization_id
    assert response.status is OrganizationStatus.ACTIVE
    assert datetime.fromisoformat(
        response.model_dump(mode="json")["created_at"].replace("Z", "+00:00")
    ) == now


def test_organization_chooser_response_exposes_only_id_and_name():
    organization_id = uuid4()
    response = OrganizationChooserPageResponse.model_validate(
        {
            "organizations": [{"id": organization_id, "name": "Fictional"}],
            "next_cursor": None,
        }
    )

    assert response.organizations == [
        OrganizationChooserItemResponse(id=organization_id, name="Fictional")
    ]
    assert set(response.organizations[0].model_dump()) == {"id", "name"}


def test_user_response_contains_only_declared_user_fields():
    now = datetime.now(UTC)
    user_id = uuid4()
    response = UserResponse.model_validate(
        {
            "id": user_id,
            "external_subject": "fictional-subject",
            "created_at": now,
        }
    )

    assert response.id == user_id
    assert set(response.model_dump()) == {"id", "external_subject", "created_at"}


def test_membership_response_validates_ids_and_enum_values():
    membership_id = uuid4()
    organization_id = uuid4()
    user_id = uuid4()
    now = datetime.now(UTC)
    response = MembershipResponse.model_validate(
        {
            "id": membership_id,
            "organization_id": organization_id,
            "user_id": user_id,
            "role": "admin",
            "status": "active",
            "created_at": now,
        }
    )

    assert response.id == membership_id
    assert response.organization_id == organization_id
    assert response.user_id == user_id
    assert response.role is MembershipRole.ADMIN
    assert response.status is MembershipStatus.ACTIVE


@pytest.mark.parametrize(
    ("schema", "payload"),
    [
        (
            OrganizationResponse,
            {
                "id": uuid4(),
                "name": "Fictional",
                "status": "unknown",
                "created_at": datetime.now(UTC),
                "updated_at": datetime.now(UTC),
            },
        ),
        (
            MembershipResponse,
            {
                "id": uuid4(),
                "organization_id": uuid4(),
                "user_id": uuid4(),
                "role": "superuser",
                "status": "active",
                "created_at": datetime.now(UTC),
            },
        ),
    ],
)
def test_response_schemas_reject_unsupported_values(schema, payload):
    with pytest.raises(ValidationError):
        schema.model_validate(payload)


def test_api_error_response_has_consistent_envelope():
    response = APIErrorResponse.model_validate(
        {"error": {"code": "not_found", "message": "Resource not found"}}
    )

    assert response.model_dump() == {
        "error": {"code": "not_found", "message": "Resource not found"}
    }


def test_my_organizations_route_is_registered_under_versioned_api():
    assert API_V1_PREFIX == "/api/v1"
    assert api_router.prefix == API_V1_PREFIX
    paths = set(app.openapi()["paths"])
    assert paths >= {
        "/health",
        "/ready",
        f"{API_V1_PREFIX}/users/me/organizations",
    }
