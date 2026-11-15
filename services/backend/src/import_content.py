"""Import the portfolio once, using the application's existing database and S3 permissions."""

import asyncio
import json
from pathlib import Path

from platform_codegen.runtime.database import Database
from platform_codegen.runtime.storage import S3

from media import upload_image
from persistence import Repository
from settings import Settings


async def main():
    settings = Settings()
    if settings.portfolio_origin.startswith("https://") and not settings.portfolio_media_base:
        raise SystemExit("Set PORTFOLIO_MEDIA_BASE before importing production content.")
    database = Database(settings.database_url.get_secret_value())
    storage = S3(settings)
    try:
        repository = Repository(database)
        from fastapi import HTTPException

        try:
            await repository.get_content()
        except HTTPException as error:
            if error.status_code != 404:
                raise
        else:
            print("Content already exists. Import skipped.")
            return
        folder = Path(__file__).parent
        document = json.loads(folder.joinpath("portfolio-content.json").read_text(encoding="utf-8"))
        document["photo"] = await upload_image(
            storage, folder.joinpath("initial-photo.jpg").read_bytes(), settings.portfolio_media_base,
        )
        print("Content imported." if await repository.seed(document) else "Content already exists.")
    finally:
        await storage.close()
        await database.close()


if __name__ == "__main__":
    asyncio.run(main())
