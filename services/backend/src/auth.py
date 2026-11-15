from base64 import urlsafe_b64encode
from hashlib import sha256
from hmac import compare_digest
from secrets import token_urlsafe
from time import time
from urllib.parse import urlencode

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from fastapi.responses import RedirectResponse
import httpx
import jwt

FLOW_COOKIE = "portfolio_login"
SESSION_COOKIE = "portfolio_session"
SESSION_PATH = "/api/v1/admin"
NO_STORE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}


def digest(value):
    return sha256(value.encode()).hexdigest()


class Identity:
    def __init__(self, repository, settings, client):
        self.repository = repository
        self.http = client
        self.issuer = settings.oidc_issuer.rstrip("/")
        self.client_id = settings.oidc_client_id
        self.client_secret = settings.oidc_client_secret.get_secret_value()
        self.origin = settings.portfolio_origin.rstrip("/")
        self.secure = self.origin.startswith("https://")
        self.cipher = Fernet(urlsafe_b64encode(sha256(
            ("portfolio-session-v1:" + self.client_secret).encode()
        ).digest()))

    def cookie(self, response, name, value, lifetime):
        response.set_cookie(
            name, value, max_age=lifetime, path=SESSION_PATH,
            secure=self.secure, httponly=True, samesite="lax",
        )

    async def launch(self):
        if not all((self.issuer, self.client_id, self.client_secret)):
            raise HTTPException(503, "Вход через платформу не настроен.")
        cookie, state, nonce = (token_urlsafe(32) for _ in range(3))
        verifier = token_urlsafe(48)
        now = int(time())
        await self.repository.start_login(
            now, digest=digest(cookie), state=state, verifier=verifier, nonce=nonce, expires=now + 600,
        )
        challenge = urlsafe_b64encode(sha256(verifier.encode()).digest()).decode().rstrip("=")
        query = urlencode({
            "client_id": self.client_id, "redirect_uri": self.origin + SESSION_PATH + "/callback",
            "response_type": "code", "scope": "openid profile", "state": state, "nonce": nonce,
            "code_challenge": challenge, "code_challenge_method": "S256",
        })
        response = RedirectResponse(f"{self.issuer}/authorize?{query}", 303, headers=NO_STORE)
        self.cookie(response, FLOW_COOKIE, cookie, 600)
        return response

    async def provider_profile(self, token):
        try:
            response = await self.http.get(f"{self.issuer}/userinfo", headers={"Authorization": "Bearer " + token})
            if response.status_code in (401, 403):
                raise HTTPException(403, "Нужен действующий аккаунт администратора.")
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise HTTPException(503, "Платформа авторизации недоступна.") from error
        if not isinstance(data, dict) or data.get("platformRole") != "administrator":
            raise HTTPException(403, "Нужен аккаунт администратора платформы.")
        return data

    async def callback(self, request):
        now = int(time())
        state = request.query_params.get("state", "")
        cookie = request.cookies.get(FLOW_COOKIE, "")
        flow = await self.repository.finish_login(digest(cookie), state, now) if cookie and state else None
        response = RedirectResponse("/admin/?error=forbidden", 303, headers=NO_STORE)
        response.delete_cookie(FLOW_COOKIE, path=SESSION_PATH)
        if not flow or "error" in request.query_params:
            return response
        code = request.query_params.get("code")
        if not code:
            return response
        try:
            exchange = await self.http.post(
                f"{self.issuer}/token",
                auth=(self.client_id, self.client_secret),
                data={
                    "grant_type": "authorization_code", "code": code,
                    "redirect_uri": self.origin + SESSION_PATH + "/callback",
                    "code_verifier": flow["verifier"],
                },
            )
            exchange.raise_for_status()
            tokens = exchange.json()
            access_token = tokens["access_token"]
            id_token = tokens["id_token"]
            jwks = await self.http.get(f"{self.issuer}/jwks")
            jwks.raise_for_status()
            kid = jwt.get_unverified_header(id_token)["kid"]
            key = next(item for item in jwks.json()["keys"] if item.get("kid") == kid)
            claims = jwt.decode(
                id_token, jwt.PyJWK.from_dict(key, algorithm="RS256").key,
                algorithms=["RS256"], issuer=self.issuer, audience=self.client_id,
                options={"require": ["exp", "iat", "sub", "nonce"]},
            )
            if claims["nonce"] != flow["nonce"] or claims.get("platformRole") != "administrator":
                return response
            actor = await self.provider_profile(access_token)
            lifetime = min(int(tokens["expires_in"]), 8 * 3600)
            if actor.get("sub") != claims["sub"] or lifetime <= 0:
                return response
        except (HTTPException, httpx.HTTPError, jwt.PyJWTError, KeyError, TypeError, ValueError, StopIteration):
            return response
        session, csrf = token_urlsafe(32), token_urlsafe(32)
        previous = request.cookies.get(SESSION_COOKIE)
        if previous:
            await self.repository.stop_session(digest(previous))
        await self.repository.start_session(
            now, digest=digest(session), subject=claims["sub"],
            token=self.cipher.encrypt(access_token.encode()), csrf=csrf, expires=now + lifetime,
        )
        response.headers["location"] = "/admin/"
        self.cookie(response, SESSION_COOKIE, session, lifetime)
        return response

    async def require_admin(self, request, *, write=False):
        cookie = request.cookies.get(SESSION_COOKIE, "")
        row = await self.repository.get_session(digest(cookie), int(time())) if cookie else None
        if row is None:
            raise HTTPException(401, "Войди через платформу.")
        if write and (
            request.headers.get("origin") != self.origin
            or not compare_digest(request.headers.get("x-csrf-token", "").encode(), row["csrf"].encode())
        ):
            raise HTTPException(403, "Проверка запроса не пройдена.")
        try:
            token = self.cipher.decrypt(row["token"]).decode()
        except InvalidToken as error:
            raise HTTPException(401, "Войди через платформу заново.") from error
        actor = await self.provider_profile(token)
        if actor.get("sub") != row["subject"]:
            raise HTTPException(403, "Нужен аккаунт администратора платформы.")
        return row

    async def logout(self, request):
        cookie = request.cookies.get(SESSION_COOKIE)
        if cookie:
            await self.require_admin(request, write=True)
            await self.repository.stop_session(digest(cookie))
