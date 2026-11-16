"""Exercise the generated HTTP routes and the actual OIDC client."""

from io import BytesIO
from types import SimpleNamespace
from time import time
from urllib.parse import parse_qs, urlsplit

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.testclient import TestClient
import httpx
import jwt
from PIL import Image
from pydantic import SecretStr

from application import create_app
from auth import Identity, SESSION_COOKIE
from persistence import edit_document

ORIGIN = "https://iizhukov.ru"
ISSUER = "https://platform.iizhukov.ru/api/v1/oidc"
PUBLIC_S3 = "https://s3.iizhukov.ru/conn_test/portfolio-media"


class Repository:
    def __init__(self):
        self.logins = {}
        self.sessions = {}
        self.content = {"document": {"name": "Илья"}, "revision": 1}

    async def start_login(self, now, **values):
        self.logins[values["digest"]] = values

    async def finish_login(self, digest, state, now):
        row = self.logins.get(digest)
        if row and row["state"] == state:
            return self.logins.pop(digest)

    async def start_session(self, now, **values):
        self.sessions[values["digest"]] = values

    async def get_session(self, digest, now):
        return self.sessions.get(digest)

    async def stop_session(self, digest):
        self.sessions.pop(digest, None)

    async def get_content(self):
        return self.content

    async def save_content(self, revision, edits, **list_changes):
        if revision != self.content["revision"]:
            raise HTTPException(409)
        self.content = {
            "document": edit_document(self.content["document"], edits, **list_changes),
            "revision": revision + 1,
        }
        return self.content


class Storage:
    def __init__(self):
        self.objects = {}

    async def put(self, key, body, mime):
        self.objects[key] = (body, mime)


class Provider:
    def __init__(self):
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.role = "administrator"

    def request(self, request):
        if request.url.path.endswith("/token"):
            assert request.headers["Authorization"].startswith("Basic ")
            assert b"code_verifier=" in request.content
            now = int(time())
            return httpx.Response(200, json={
                "access_token": "access-from-platform",
                "expires_in": 3600,
                "id_token": jwt.encode(
                    {"iss": ISSUER, "aud": "portfolio", "sub": "user-1", "iat": now,
                     "exp": now + 60, "nonce": self.nonce, "platformRole": self.role},
                    self.key, algorithm="RS256", headers={"kid": "test"},
                ),
            })
        if request.url.path.endswith("/jwks"):
            key = jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key(), as_dict=True)
            return httpx.Response(200, json={"keys": [{**key, "kid": "test"}]})
        assert request.url.path.endswith("/userinfo")
        assert request.headers["Authorization"] == "Bearer access-from-platform"
        return httpx.Response(200, json={"sub": "user-1", "platformRole": self.role})


def setup(document=None):
    database, storage, provider = Repository(), Storage(), Provider()
    if document is not None:
        database.content["document"] = document
    settings = SimpleNamespace(
        portfolio_origin=ORIGIN, oidc_issuer=ISSUER, oidc_client_id="portfolio",
        oidc_client_secret=SecretStr("testing-client-secret"), portfolio_media_base=PUBLIC_S3,
    )
    application = create_app()
    upstream = httpx.AsyncClient(transport=httpx.MockTransport(provider.request))
    application.state.runtime = SimpleNamespace(
        identity=Identity(database, settings, upstream), repository=database, telemetry=None,
        s3=storage, settings=settings,
    )
    return TestClient(application, base_url=ORIGIN), provider, storage


def login(client, provider):
    start = client.get("/api/v1/admin/login", follow_redirects=False)
    assert start.status_code == 303
    auth = parse_qs(urlsplit(start.headers["Location"]).query)
    provider.nonce = auth["nonce"][0]
    assert auth["code_challenge_method"] == ["S256"]
    assert auth["redirect_uri"] == [ORIGIN + "/api/v1/admin/callback"]
    return client.get(
        "/api/v1/admin/callback",
        params={"state": auth["state"][0], "code": "test-code"}, follow_redirects=False,
    )


def test_admin_can_edit_and_upload_and_revocation_takes_effect():
    client, provider, storage = setup()
    assert client.get("/api/v1/admin/session").status_code == 401
    assert login(client, provider).headers["Location"] == "/admin/"
    session = client.get("/api/v1/admin/session").json()
    assert session["isAdmin"] is True
    headers = {"Origin": ORIGIN, "X-CSRF-Token": session["csrf"]}
    assert client.patch("/api/v1/admin/content", json={
        "revision": 1, "edits": [{"key": "profile", "values": ["Илья", "**Текст**", ""]}],
    }).status_code == 403
    assert client.post("/api/v1/admin/media", content=b"<svg/>", headers=headers).status_code == 422
    stream = BytesIO()
    Image.new("RGB", (10, 20), "red").save(stream, "PNG")
    response = client.post("/api/v1/admin/media", content=stream.getvalue(), headers=headers)
    assert response.status_code == 201
    photo = response.json()["url"]
    assert photo.startswith(PUBLIC_S3 + "/media/")
    body, mime = next(iter(storage.objects.values()))
    assert mime == "image/webp" and Image.open(BytesIO(body)).size == (10, 20)
    edit = {"revision": 1, "edits": [{"key": "profile", "values": ["Илья", "**Текст**", photo]}]}
    result = client.patch("/api/v1/admin/content", json=edit, headers=headers)
    assert result.json()["revision"] == 2
    assert client.get("/api/v1/content").json()["document"] == {
        "name": "Илья", "intro": "**Текст**", "photo": photo,
    }
    assert client.patch("/api/v1/admin/content", json=edit, headers=headers).status_code == 409
    provider.role = "member"
    assert client.patch("/api/v1/admin/content", json=edit, headers=headers).status_code == 403


def test_member_never_receives_admin_session():
    client, provider, _ = setup()
    provider.role = "member"
    assert login(client, provider).headers["Location"] == "/admin/?error=forbidden"
    assert client.cookies.get(SESSION_COOKIE) is None
    assert client.get("/api/v1/admin/session").status_code == 401


def test_administrator_can_publish_a_new_project():
    client, provider, _ = setup()
    assert login(client, provider).headers["Location"] == "/admin/"
    headers = {"Origin": ORIGIN, "X-CSRF-Token": client.get("/api/v1/admin/session").json()["csrf"]}
    identifier = "project-" + "a" * 32
    result = client.patch("/api/v1/admin/content", headers=headers, json={
        "revision": 1, "edits": [{
            "key": f"projects/{identifier}", "values": ["Demo", "Summary", "", "**Details**"],
        }],
    })
    assert result.status_code == 200
    assert client.get("/api/v1/content").json()["document"]["projects"][0] == {
        "id": identifier, "name": "Demo", "summary": "Summary", "status": "", "details": ["**Details**"],
    }


def test_administrator_can_add_and_position_education():
    client, provider, _ = setup({"education": [["University", "Degree", "2022", "Details"]]})
    assert login(client, provider).headers["Location"] == "/admin/"
    headers = {"Origin": ORIGIN, "X-CSRF-Token": client.get("/api/v1/admin/session").json()["csrf"]}
    first = ["Course", "Topic", "2024", "Details"]
    second = ["School", "Track", "2025", "Details"]
    payload = {
        "revision": 1,
        "edits": [{"key": "education/1", "values": first}, {"key": "education/2", "values": second}],
        "educationOrder": [2, 0, 1],
    }
    result = client.patch("/api/v1/admin/content", headers=headers, json=payload)
    assert result.status_code == 200
    assert result.json()["document"]["education"] == [
        second, ["University", "Degree", "2022", "Details"], first,
    ]


def test_administrator_can_reorder_and_remove_entries():
    client, provider, _ = setup({
        "projects": [{"id": "one"}, {"id": "two"}, {"id": "obsolete"}],
        "experience": [{"id": "first"}, {"id": "second"}, {"id": "third"}],
        "education": [["University"], ["School"], ["Course"]],
    })
    assert login(client, provider).headers["Location"] == "/admin/"
    headers = {"Origin": ORIGIN, "X-CSRF-Token": client.get("/api/v1/admin/session").json()["csrf"]}
    endpoint = "/api/v1/admin/content"
    changes = {
        "revision": 1, "edits": [{"key": "education/2", "values": ["Course", "Role", "2024", "Description"]}],
        "removeExperience": ["second"],
        "experienceOrder": ["third", "first"], "projectOrder": ["two", "one"],
        "removeProjects": ["obsolete"], "educationOrder": [2, 0], "removeEducation": [1],
    }
    invalid = {**changes, "projectOrder": ["two", "two"]}
    assert client.patch(endpoint, headers=headers, json=invalid).status_code == 422
    assert client.patch(endpoint, headers=headers, json={**changes, "removeEducation": [3]}).status_code == 422
    for invalid_order in ([2, 2], [2], [2, 1]):
        assert client.patch(endpoint, headers=headers, json={**changes, "educationOrder": invalid_order}).status_code == 422
    assert client.get("/api/v1/content").json()["revision"] == 1
    assert client.patch(endpoint, headers=headers, json=changes).status_code == 200
    assert client.get("/api/v1/content").json() == {"revision": 2, "document": {
        "projects": [{"id": "two"}, {"id": "one"}],
        "experience": [{"id": "third"}, {"id": "first"}],
        "education": [["Course", "Role", "2024", "Description"], ["University"]],
    }}
    assert client.patch(endpoint, headers=headers, json=changes).status_code == 409
