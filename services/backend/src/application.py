from fastapi import HTTPException
from fastapi.responses import JSONResponse, Response
from generated.api.portfolio import Portfolio
from generated.app import create_app as generated_app
import httpx

from auth import Identity, NO_STORE, SESSION_COOKIE, SESSION_PATH
from media import MAX_UPLOAD, read_local_image, upload_image
from persistence import Repository
from settings import Settings


class API(Portfolio):
    async def read_content(self, *, context):
        return JSONResponse(await context.runtime.repository.get_content(), headers={"Cache-Control": "no-cache"})

    async def login(self, *, context):
        return await context.runtime.identity.launch()

    async def callback(self, *, context):
        return await context.runtime.identity.callback(context.request)

    async def get_session(self, *, context):
        row = await context.runtime.identity.require_admin(context.request)
        return JSONResponse({"isAdmin": True, "csrf": row["csrf"]}, headers=NO_STORE)

    async def logout(self, *, context):
        await context.runtime.identity.logout(context.request)
        response = Response(status_code=204, headers=NO_STORE)
        response.delete_cookie(SESSION_COOKIE, path=SESSION_PATH)
        return response

    async def update_content(self, *, context, body):
        await context.runtime.identity.require_admin(context.request, write=True)
        result = await context.runtime.repository.save_content(body.revision, body.edits)
        return JSONResponse(result, headers=NO_STORE)

    async def upload_image(self, *, context):
        runtime = context.runtime
        await runtime.identity.require_admin(context.request, write=True)
        public_base = runtime.settings.s3_public_base
        if runtime.identity.secure and not public_base:
            raise HTTPException(503, "Публичный адрес хранилища не настроен.")
        data = bytearray()
        async for chunk in context.request.stream():
            if len(data) + len(chunk) > MAX_UPLOAD:
                raise HTTPException(413, "Максимальный размер изображения — 5 МБ.")
            data.extend(chunk)
        url = await upload_image(runtime.s3, data, public_base)
        return JSONResponse({"url": url}, status_code=201, headers=NO_STORE)

    async def read_local_image(self, *, context, name):
        runtime = context.runtime
        if runtime.identity.secure:
            raise HTTPException(404, "Изображение не найдено.")
        return await read_local_image(runtime.s3, name)


async def start(runtime):
    runtime.repository = Repository(runtime.database)
    runtime.oidc_http = httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False)
    runtime.identity = Identity(runtime.repository, runtime.settings, runtime.oidc_http)


async def stop(runtime):
    await runtime.oidc_http.aclose()


def create_app():
    return generated_app(http=[API()], settings_class=Settings, startup=start, shutdown=stop)
