import asyncio
from io import BytesIO
import re
from threading import Lock
from uuid import uuid4

from botocore.exceptions import ClientError
from fastapi import HTTPException
from fastapi.responses import Response
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_UPLOAD = 5 * 1024 * 1024
MAX_PIXELS = 24_000_000
NAME = re.compile(r"[0-9a-f]{32}\.webp")
_conversion_lock = Lock()


def convert_image(data):
    with _conversion_lock, Image.open(BytesIO(data)) as source:
        if source.format not in ("JPEG", "PNG", "WEBP", "GIF", "AVIF"):
            raise ValueError("Unsupported format")
        if source.width * source.height > MAX_PIXELS:
            raise ValueError("Image exceeds dimension limit")
        source.thumbnail((2048, 2048))
        ImageOps.exif_transpose(source, in_place=True)
        transparent = "A" in source.getbands() or "transparency" in source.info
        output = BytesIO()
        with source.convert("RGBA" if transparent else "RGB") as converted:
            converted.save(output, format="WEBP", quality=88)
        return output.getvalue()


async def upload_image(storage, data, public_base):
    try:
        image = await asyncio.to_thread(convert_image, data)
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError, ValueError) as error:
        raise HTTPException(422, "Файл должен быть изображением JPG, PNG, WebP, GIF или AVIF.") from error
    name = uuid4().hex + ".webp"
    await storage.put(f"media/{name}", image, "image/webp")
    url = f"{public_base.rstrip('/')}/media/{name}" if public_base else f"/api/v1/media/{name}"
    return url


async def read_local_image(storage, name):
    if not NAME.fullmatch(name):
        raise HTTPException(404, "Изображение не найдено.")
    try:
        data = await storage.get(f"media/{name}", max_bytes=MAX_UPLOAD)
    except ClientError as error:
        if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
            raise HTTPException(404, "Изображение не найдено.") from error
        raise
    return Response(data.body, media_type="image/webp", headers={
        "Cache-Control": "public, max-age=31536000, immutable", "ETag": data.etag,
        "X-Content-Type-Options": "nosniff",
    })
