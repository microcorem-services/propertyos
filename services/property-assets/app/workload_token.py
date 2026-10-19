from dataclasses import dataclass, field
import ipaddress
import math
import threading
import time
from typing import Protocol
from urllib.parse import urlsplit

import httpx

from app import config


class WorkloadTokenError(RuntimeError):
    pass


class TokenEndpointClient(Protocol):
    def post(self, url: str, **kwargs) -> httpx.Response: ...


@dataclass(frozen=True)
class WorkloadTokenSettings:
    token_endpoint_url: str
    client_id: str
    client_secret: str = field(repr=False)
    required_scope: str
    connect_timeout_seconds: float = 2
    read_timeout_seconds: float = 3
    allow_insecure_local_http: bool = False

    @classmethod
    def from_environment(cls) -> "WorkloadTokenSettings":
        try:
            connect_timeout = float(config.COGNITO_TOKEN_CONNECT_TIMEOUT_SECONDS)
            read_timeout = float(config.COGNITO_TOKEN_READ_TIMEOUT_SECONDS)
        except (TypeError, ValueError):
            raise WorkloadTokenError(
                "Workload token provider configuration is invalid"
            ) from None
        return cls(
            token_endpoint_url=config.COGNITO_TOKEN_ENDPOINT_URL,
            client_id=config.COGNITO_WORKLOAD_CLIENT_ID,
            client_secret=config.COGNITO_WORKLOAD_CLIENT_SECRET,
            required_scope=config.COGNITO_WORKLOAD_REQUIRED_SCOPE,
            connect_timeout_seconds=connect_timeout,
            read_timeout_seconds=read_timeout,
            allow_insecure_local_http=config.COGNITO_ALLOW_INSECURE_TOKEN_ENDPOINT,
        )


class WorkloadTokenProvider:
    def __init__(
        self,
        settings: WorkloadTokenSettings,
        *,
        client: TokenEndpointClient | None = None,
        clock=time.monotonic,
    ):
        self._settings = settings
        self._client = client
        self._clock = clock
        self._lock = threading.Lock()
        self._cached_token: str | None = None
        self._refresh_at = 0.0

    def get_token(self) -> str:
        with self._lock:
            now = self._clock()
            if self._cached_token is not None and now < self._refresh_at:
                return self._cached_token

            self._validate_settings()
            timeout = httpx.Timeout(
                connect=self._settings.connect_timeout_seconds,
                read=self._settings.read_timeout_seconds,
                write=self._settings.read_timeout_seconds,
                pool=self._settings.connect_timeout_seconds,
            )
            try:
                if self._client is None:
                    response = httpx.post(
                        self._settings.token_endpoint_url,
                        data={
                            "grant_type": "client_credentials",
                            "scope": self._settings.required_scope,
                        },
                        auth=(
                            self._settings.client_id,
                            self._settings.client_secret,
                        ),
                        headers={"Accept": "application/json"},
                        timeout=timeout,
                    )
                else:
                    response = self._client.post(
                        self._settings.token_endpoint_url,
                        data={
                            "grant_type": "client_credentials",
                            "scope": self._settings.required_scope,
                        },
                        auth=(
                            self._settings.client_id,
                            self._settings.client_secret,
                        ),
                        headers={"Accept": "application/json"},
                        timeout=timeout,
                    )
                response.raise_for_status()
                payload = response.json()
            except (httpx.HTTPError, UnicodeError, ValueError):
                raise WorkloadTokenError(
                    "Workload token endpoint request failed"
                ) from None

            if not isinstance(payload, dict):
                raise WorkloadTokenError(
                    "Workload token endpoint returned an invalid response"
                )

            access_token = payload.get("access_token")
            token_type = payload.get("token_type")
            expires_in = payload.get("expires_in")
            if (
                not isinstance(access_token, str)
                or not access_token.strip()
                or access_token != access_token.strip()
                or not isinstance(token_type, str)
                or token_type.lower() != "bearer"
                or isinstance(expires_in, bool)
                or not isinstance(expires_in, int)
                or expires_in <= 0
            ):
                raise WorkloadTokenError(
                    "Workload token endpoint returned an invalid response"
                )

            self._cached_token = access_token
            refresh_skew = min(30.0, max(1.0, expires_in * 0.1))
            self._refresh_at = self._clock() + max(0.0, expires_in - refresh_skew)
            return access_token

    def _validate_settings(self) -> None:
        settings = self._settings
        if (
            not settings.token_endpoint_url.strip()
            or not settings.client_id.strip()
            or not settings.client_secret.strip()
            or not settings.required_scope.strip()
            or not math.isfinite(settings.connect_timeout_seconds)
            or settings.connect_timeout_seconds <= 0
            or not math.isfinite(settings.read_timeout_seconds)
            or settings.read_timeout_seconds <= 0
        ):
            raise WorkloadTokenError(
                "Workload token provider configuration is incomplete"
            )

        try:
            parsed = urlsplit(settings.token_endpoint_url)
            hostname = parsed.hostname
        except ValueError:
            raise WorkloadTokenError(
                "Workload token endpoint URL is invalid"
            ) from None
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and settings.allow_insecure_local_http
        ):
            raise WorkloadTokenError(
                "Workload token endpoint must use HTTPS"
            )
        if (
            hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or not parsed.path
        ):
            raise WorkloadTokenError(
                "Workload token endpoint URL is invalid"
            )
        if parsed.scheme == "https":
            return

        try:
            is_loopback = ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            is_loopback = hostname.lower() == "localhost"
        if not is_loopback:
            raise WorkloadTokenError(
                "Insecure workload token endpoints are limited to loopback"
            )


_default_provider: WorkloadTokenProvider | None = None
_default_provider_lock = threading.Lock()


def get_workload_access_token() -> str:
    global _default_provider
    if _default_provider is None:
        with _default_provider_lock:
            if _default_provider is None:
                _default_provider = WorkloadTokenProvider(
                    WorkloadTokenSettings.from_environment()
                )
    return _default_provider.get_token()
