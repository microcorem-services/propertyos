from uuid import uuid4

import httpx
import pytest
from app.security import (
    AuthorizedOrganization,
    ServiceDependencyUnavailable,
    UnitReference,
    UnitReferenceInvalid,
)

from app import security


def test_registry_client_sends_user_and_workload_credentials_and_checks_identity(
    monkeypatch,
):
    organization_id = uuid4()
    reference = UnitReference(
        portfolio_id=uuid4(),
        site_id=uuid4(),
        building_id=uuid4(),
        unit_id=uuid4(),
    )
    calls = []
    monkeypatch.setattr(
        security.config, "PROPERTY_ASSETS_REGISTRY_URL", "https://registry.example"
    )
    monkeypatch.setattr(security, "get_workload_token", lambda: "fictional-workload")

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(
            200,
            json={
                "id": str(reference.unit_id),
                "organization_id": str(organization_id),
                "building_id": str(reference.building_id),
                "status": "active",
            },
        )

    monkeypatch.setattr(security.httpx, "get", fake_get)

    result = security.validate_unit_reference(
        organization_id, reference, "fictional.user.token"
    )

    assert result == "active"
    url, kwargs = calls[0]
    assert url.endswith(
        f"/portfolios/{reference.portfolio_id}/sites/{reference.site_id}"
        f"/buildings/{reference.building_id}/units/{reference.unit_id}"
    )
    assert kwargs["params"] == {"organization_id": str(organization_id)}
    assert kwargs["headers"]["Authorization"] == "Bearer fictional.user.token"
    assert kwargs["headers"]["X-Service-Authorization"] == ("Bearer fictional-workload")
    assert kwargs["follow_redirects"] is False


@pytest.mark.parametrize(
    ("organization_matches", "building_matches", "unit_status"),
    [
        (False, True, "active"),
        (True, False, "active"),
        (True, True, "inactive"),
    ],
)
def test_registry_rejects_cross_organization_or_inactive_unit(
    monkeypatch, organization_matches, building_matches, unit_status
):
    organization_id = uuid4()
    reference = UnitReference(
        portfolio_id=uuid4(),
        site_id=uuid4(),
        building_id=uuid4(),
        unit_id=uuid4(),
    )
    other_organization_id = organization_id if organization_matches else uuid4()
    returned_building_id = reference.building_id if building_matches else uuid4()
    monkeypatch.setattr(
        security.config, "PROPERTY_ASSETS_REGISTRY_URL", "https://registry.example"
    )
    monkeypatch.setattr(security, "get_workload_token", lambda: "fictional-workload")
    monkeypatch.setattr(
        security.httpx,
        "get",
        lambda *_args, **_kwargs: httpx.Response(
            200,
            json={
                "id": str(reference.unit_id),
                "organization_id": str(other_organization_id),
                "building_id": str(returned_building_id),
                "status": unit_status,
            },
        ),
    )

    with pytest.raises(UnitReferenceInvalid):
        security.validate_unit_reference(
            organization_id, reference, "fictional.user.token"
        )


def test_registry_transport_failure_fails_closed(monkeypatch):
    reference = UnitReference(
        portfolio_id=uuid4(),
        site_id=uuid4(),
        building_id=uuid4(),
        unit_id=uuid4(),
    )
    monkeypatch.setattr(
        security.config, "PROPERTY_ASSETS_REGISTRY_URL", "https://registry.example"
    )
    monkeypatch.setattr(security, "get_workload_token", lambda: "fictional-workload")
    monkeypatch.setattr(
        security.httpx,
        "get",
        lambda *_args, **_kwargs: httpx.Response(503),
    )

    with pytest.raises(ServiceDependencyUnavailable):
        security.validate_unit_reference(uuid4(), reference, "fictional.user.token")


def test_authorization_decision_preserves_organization_and_actor(monkeypatch):
    organization_id = uuid4()
    actor_id = uuid4()
    calls = []
    monkeypatch.setattr(
        security.config, "ORGANIZATION_ACCESS_URL", "https://access.example"
    )

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(
            200,
            json={
                "organization_id": str(organization_id),
                "operation": "lease-management.leases.create",
                "allowed": True,
                "actor_id": str(actor_id),
            },
        )

    monkeypatch.setattr(security.httpx, "post", fake_post)
    result = security.authorize_organization(
        organization_id,
        "lease-management.leases.create",
        "fictional.user.token",
        "fictional.workload.token",
    )

    assert result == AuthorizedOrganization(organization_id, actor_id)
    _url, kwargs = calls[0]
    assert kwargs["json"] == {
        "organization_id": str(organization_id),
        "operation": "lease-management.leases.create",
    }
    assert kwargs["headers"]["Authorization"] == "Bearer fictional.user.token"
    assert kwargs["headers"]["X-Service-Authorization"] == (
        "Bearer fictional.workload.token"
    )
