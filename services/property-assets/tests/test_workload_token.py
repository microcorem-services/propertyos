import base64
from concurrent.futures import ThreadPoolExecutor
import threading
import time

import httpx
import pytest

from app import config
from app.workload_token import (
    WorkloadTokenError,
    WorkloadTokenProvider,
    WorkloadTokenSettings,
)


TOKEN_URL = "https://example.test/oauth2/token"
CLIENT_ID = "fictional-property-assets-client"
CLIENT_SECRET = "fictional-client-secret"
SCOPE = "property-assets/authorization"


def make_settings(**overrides):
    settings = {
        "token_endpoint_url": TOKEN_URL,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "required_scope": SCOPE,
    }
    settings.update(overrides)
    return WorkloadTokenSettings(**settings)


def token_response(
    *,
    access_token="fictional-workload-token",
    token_type="Bearer",
    expires_in=3600,
):
    return httpx.Response(
        200,
        json={
            "access_token": access_token,
            "token_type": token_type,
            "expires_in": expires_in,
        },
    )


def make_client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_successful_retrieval_uses_oauth_client_credentials_request():
    requests = []

    def handler(request):
        requests.append(request)
        return token_response()

    with make_client(handler) as client:
        provider = WorkloadTokenProvider(
            make_settings(
                connect_timeout_seconds=1.25,
                read_timeout_seconds=4.5,
            ),
            client=client,
        )
        access_token = provider.get_token()

    assert access_token == "fictional-workload-token"
    assert len(requests) == 1
    request = requests[0]
    assert request.url == TOKEN_URL
    assert request.method == "POST"
    assert request.headers["accept"] == "application/json"
    assert request.headers["authorization"] == "Basic " + base64.b64encode(
        f"{CLIENT_ID}:{CLIENT_SECRET}".encode()
    ).decode()
    assert request.content.decode() == (
        "grant_type=client_credentials&scope=property-assets%2Fauthorization"
    )
    assert request.extensions["timeout"] == {
        "connect": 1.25,
        "read": 4.5,
        "write": 4.5,
        "pool": 1.25,
    }


@pytest.mark.parametrize(
    "settings",
    [
        make_settings(token_endpoint_url=""),
        make_settings(client_id=""),
        make_settings(client_secret=""),
        make_settings(required_scope=""),
        make_settings(connect_timeout_seconds=0),
        make_settings(read_timeout_seconds=-1),
    ],
)
def test_missing_or_invalid_configuration_fails_closed(settings):
    provider = WorkloadTokenProvider(settings)

    with pytest.raises(WorkloadTokenError):
        provider.get_token()


def test_environment_configuration_requires_credentials(monkeypatch):
    monkeypatch.setattr(config, "COGNITO_TOKEN_ENDPOINT_URL", "")
    monkeypatch.setattr(config, "COGNITO_WORKLOAD_CLIENT_ID", "")
    monkeypatch.setattr(config, "COGNITO_WORKLOAD_CLIENT_SECRET", "")
    monkeypatch.setattr(config, "COGNITO_WORKLOAD_REQUIRED_SCOPE", "")
    settings = WorkloadTokenSettings.from_environment()

    with pytest.raises(WorkloadTokenError, match="configuration is incomplete"):
        WorkloadTokenProvider(settings).get_token()


def test_client_secret_is_not_in_settings_representation():
    settings = make_settings()

    assert CLIENT_SECRET not in repr(settings)


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"access_token": "", "token_type": "Bearer", "expires_in": 60},
        {"access_token": "token", "token_type": "Basic", "expires_in": 60},
        {"access_token": "token", "token_type": "Bearer", "expires_in": 0},
        {"access_token": "token", "token_type": "Bearer", "expires_in": -1},
        {"access_token": "token", "token_type": "Bearer", "expires_in": True},
        {"access_token": "token", "token_type": "Bearer", "expires_in": "60"},
        {"access_token": "token", "token_type": "Bearer"},
    ],
)
def test_invalid_token_responses_fail_closed(payload):
    with make_client(lambda request: httpx.Response(200, json=payload)) as client:
        provider = WorkloadTokenProvider(make_settings(), client=client)
        with pytest.raises(WorkloadTokenError):
            provider.get_token()


def test_non_json_token_response_fails_closed():
    with make_client(
        lambda request: httpx.Response(200, content=b"not-json")
    ) as client:
        provider = WorkloadTokenProvider(make_settings(), client=client)

        with pytest.raises(WorkloadTokenError):
            provider.get_token()


def test_cached_token_is_reused_until_refresh_time():
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return token_response()

    with make_client(handler) as client:
        provider = WorkloadTokenProvider(make_settings(), client=client)
        first = provider.get_token()
        second = provider.get_token()

    assert first == second == "fictional-workload-token"
    assert calls == 1


def test_token_is_refreshed_shortly_before_expiry():
    now = [100.0]
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return token_response(access_token=f"fictional-token-{calls}", expires_in=10)

    with make_client(handler) as client:
        provider = WorkloadTokenProvider(
            make_settings(),
            client=client,
            clock=lambda: now[0],
        )
        first = provider.get_token()
        now[0] += 9
        second = provider.get_token()

    assert first == "fictional-token-1"
    assert second == "fictional-token-2"
    assert calls == 2


def test_concurrent_requests_share_a_single_refresh():
    calls = 0
    calls_lock = threading.Lock()

    def handler(request):
        nonlocal calls
        with calls_lock:
            calls += 1
        time.sleep(0.05)
        return token_response()

    with make_client(handler) as client:
        provider = WorkloadTokenProvider(make_settings(), client=client)
        with ThreadPoolExecutor(max_workers=8) as pool:
            tokens = list(pool.map(lambda _: provider.get_token(), range(16)))

    assert tokens == ["fictional-workload-token"] * 16
    assert calls == 1


@pytest.mark.parametrize(
    "failure",
    [
        httpx.ConnectError("connection unavailable"),
        httpx.ReadTimeout("request timed out"),
    ],
)
def test_network_and_timeout_failures_are_sanitized(failure):
    def handler(request):
        raise failure

    with make_client(handler) as client:
        provider = WorkloadTokenProvider(make_settings(), client=client)

        with pytest.raises(WorkloadTokenError) as error:
            provider.get_token()

    assert CLIENT_SECRET not in str(error.value)
    assert "fictional-workload-token" not in str(error.value)


def test_token_endpoint_http_status_failure_is_sanitized():
    with make_client(
        lambda request: httpx.Response(503, text="secret endpoint detail")
    ) as client:
        provider = WorkloadTokenProvider(make_settings(), client=client)

        with pytest.raises(WorkloadTokenError) as error:
            provider.get_token()

    assert "secret endpoint detail" not in str(error.value)


@pytest.mark.parametrize(
    ("settings", "message"),
    [
        (make_settings(token_endpoint_url="http://auth.example.test/token"), "HTTPS"),
        (
            make_settings(
                token_endpoint_url="http://localhost:8000/token",
                allow_insecure_local_http=True,
            ),
            None,
        ),
        (
            make_settings(
                token_endpoint_url="http://auth.example.test/token",
                allow_insecure_local_http=True,
            ),
            "loopback",
        ),
        (make_settings(token_endpoint_url="file:///tmp/token"), "HTTPS"),
    ],
)
def test_endpoint_transport_security(settings, message):
    provider = WorkloadTokenProvider(settings)
    if message is None:
        provider._validate_settings()
    else:
        with pytest.raises(WorkloadTokenError, match=message):
            provider._validate_settings()
