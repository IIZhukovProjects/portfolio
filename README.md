# Portfolio

Визитка для iizhukov.ru. Статический фронтенд, Python API, PostgreSQL и S3.

## Локальный запуск

Установи версию platform-codegen из `codegen.lock.yaml` с runtime-зависимостями и запусти:

```sh
codegen validate
codegen generate --mode platform --scope services
python scripts/test.py
codegen run --port-offset 8000
```

Сайт открывается на `http://localhost:8080`. После первого запуска вручную выполни `python -m import_content` в контейнере backend с его штатным окружением. Повторный импорт пропускает существующий контент.

## Платформа

Приложение использует PostgreSQL на одном экземпляре и публичный S3-бакет. Бэкапы не требуются. После создания публичного подключения к бакету передай в backend `S3_PUBLIC_BASE=https://s3.iizhukov.ru/<connection-id>/<bucket>`. Адрес задаётся через окружение, а параметры записи в бакет платформенный деплой выдаёт по ресурсам сервиса.

На платформе установи для OAuth-клиента `portfolio` callback `https://iizhukov.ru/api/v1/admin/callback` и доступ только для администраторов. Клиентский секрет привязывается к backend через секретницу. После применения миграций выполни `python -m import_content` в работающем backend.

Редактор открывается на `/admin/`. Карандаш включает редактирование страницы. Изображения отправляются при сохранении, а изменения текста применяются одной ревизией.
