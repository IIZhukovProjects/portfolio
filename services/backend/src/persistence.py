from copy import deepcopy
import re

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, insert
from fastapi import HTTPException

metadata = sa.MetaData()
content = sa.Table(
    "portfolio_content", metadata,
    sa.Column("id", sa.Integer, primary_key=True),
    sa.Column("revision", sa.Integer, nullable=False),
    sa.Column("document", JSONB, nullable=False),
)
login = sa.Table(
    "portfolio_login", metadata,
    sa.Column("digest", sa.String(64), primary_key=True),
    sa.Column("state", sa.String(64), nullable=False),
    sa.Column("verifier", sa.String(100), nullable=False),
    sa.Column("nonce", sa.String(64), nullable=False),
    sa.Column("expires", sa.BigInteger, nullable=False),
)
sessions = sa.Table(
    "portfolio_session", metadata,
    sa.Column("digest", sa.String(64), primary_key=True),
    sa.Column("subject", sa.String(100), nullable=False),
    sa.Column("token", sa.LargeBinary, nullable=False),
    sa.Column("csrf", sa.String(64), nullable=False),
    sa.Column("expires", sa.BigInteger, nullable=False),
)


def permitted_url(value, image=False):
    from urllib.parse import urlsplit

    if not value or any(char.isspace() or char == "\\" for char in value):
        return False
    try:
        url = urlsplit(value)
        if value.startswith("/") and not value.startswith("//"):
            return True
        if url.scheme in ("http", "https"):
            return bool(url.hostname) and url.username is None and url.password is None
        return not image and url.scheme == "mailto" and bool(url.path) and not url.netloc
    except ValueError:
        return False


def update_order(document, section, order, removed=()):
    if order is None and not removed:
        return
    items = document.get(section, [])
    entries = dict(enumerate(items)) if section == "education" else {entry["id"]: entry for entry in items}
    removed_ids = set(removed)
    if len(removed_ids) != len(removed) or not removed_ids.issubset(entries):
        raise HTTPException(422, "Проверь список удаляемых записей.")
    for identifier in removed_ids:
        del entries[identifier]
    if order is None:
        order = list(entries)
    if len(order) != len(entries) or set(order) != entries.keys():
        raise HTTPException(422, "Порядок должен включать все оставшиеся записи по одному разу.")
    document[section] = [entries[identifier] for identifier in order]


def edit_document(
    document, edits, *, project_order=None, experience_order=None, education_order=None,
    remove_experience=(), remove_projects=(), remove_education=(),
):
    if not (edits or project_order is not None or experience_order is not None or education_order is not None
            or remove_experience or remove_projects or remove_education):
        raise HTTPException(422, "Нет изменений для сохранения.")
    result = deepcopy(document)
    seen = set()
    for edit in edits:
        key, values = edit.key, edit.values
        if key in seen:
            raise HTTPException(422, "Запись указана несколько раз.")
        seen.add(key)
        if key == "profile" and len(values) == 3:
            name, intro, photo = values
            if name.strip() and intro.strip() and (not photo or permitted_url(photo, image=True)):
                result.update(name=name.strip(), intro=intro, photo=photo)
                continue
        section, _, item_id = key.partition("/")
        if section in ("contacts", "education") and item_id.isascii() and item_id.isdigit():
            index = int(item_id)
            entries = result.get(section, [])
            width = 3 if section == "contacts" else 4
            if (section == "education" and index == len(entries) and len(values) == width
                    and all(value.strip() for value in values)):
                result.setdefault(section, []).append(list(values))
                continue
            if index < len(entries) and len(values) == width and all(value.strip() for value in values):
                if section == "education" or permitted_url(values[1]):
                    entries[index][:width] = values
                    continue
        if section in ("projects", "experience"):
            item = next((entry for entry in result.get(section, []) if entry["id"] == item_id), None)
            fields = ("name", "summary", "status") if section == "projects" else ("name", "summary", "role", "dates")
            if len(values) == len(fields) + 1 and all(
                value.strip() or (section == "projects" and index == 2)
                for index, value in enumerate(values)
            ):
                if item is None and section == "projects" and re.fullmatch(r"project-[a-f0-9]{32}", item_id):
                    item = {"id": item_id}
                    result.setdefault("projects", []).append(item)
                if item is not None:
                    item.update(zip(fields, values[:-1]))
                    item["details"] = [values[-1]]
                    continue
        raise HTTPException(422, "Проверь поля записи.")
    update_order(result, "projects", project_order, remove_projects)
    update_order(result, "experience", experience_order, remove_experience)
    update_order(result, "education", education_order, remove_education)
    return result


class Repository:
    def __init__(self, db):
        self.db = db

    async def seed(self, document):
        async with self.db.transaction() as conn:
            result = await conn.execute(insert(content).values(
                id=1, document=document, revision=1,
            ).on_conflict_do_nothing().returning(content.c.id))
            return result.scalar_one_or_none() is not None

    async def get_content(self):
        async with self.db.transaction() as conn:
            row = (await conn.execute(
                sa.select(content.c.document, content.c.revision).where(content.c.id == 1)
            )).mappings().one_or_none()
        if row is None:
            raise HTTPException(404, "Портфолио ещё не заполнено.")
        return dict(row)

    async def save_content(self, revision, edits, **list_changes):
        async with self.db.transaction() as conn:
            row = (await conn.execute(
                sa.select(content.c.document, content.c.revision)
                .where(content.c.id == 1).with_for_update()
            )).mappings().one_or_none()
            if not row or row["revision"] != revision:
                raise HTTPException(409, "Страница изменилась. Обнови её перед сохранением.")
            document = edit_document(row["document"], edits, **list_changes)
            next_revision = revision + 1
            await conn.execute(content.update().where(content.c.id == 1).values(
                document=document, revision=next_revision,
            ))
        return {"document": document, "revision": next_revision}

    async def start_login(self, now, **values):
        async with self.db.transaction() as conn:
            await conn.execute(login.delete().where(login.c.expires <= now))
            await conn.execute(login.insert().values(**values))

    async def finish_login(self, digest, state, now):
        async with self.db.transaction() as conn:
            return (await conn.execute(login.delete().where(
                login.c.digest == digest, login.c.state == state, login.c.expires > now,
            ).returning(login))).mappings().one_or_none()

    async def start_session(self, now, **values):
        async with self.db.transaction() as conn:
            await conn.execute(sessions.delete().where(sessions.c.expires <= now))
            await conn.execute(sessions.insert().values(**values))

    async def get_session(self, digest, now):
        async with self.db.transaction() as conn:
            return (await conn.execute(sa.select(sessions).where(
                sessions.c.digest == digest, sessions.c.expires > now,
            ))).mappings().one_or_none()

    async def stop_session(self, digest):
        async with self.db.transaction() as conn:
            await conn.execute(sessions.delete().where(sessions.c.digest == digest))
