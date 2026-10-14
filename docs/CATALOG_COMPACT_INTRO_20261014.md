# Удаление поясняющих строк каталога

14 октября 2026. По скриншоту владельца удалены две обведённые строки: «Готовить дома — в удовольствие» и пояснение под «Что приготовим сегодня?». Удалён общий intro-подзаголовок в HTML и присваивание его текста для визуального режима в JS, чтобы отсутствующий элемент не ломал фильтры. Сам h1 сохранён, его нижний отступ обнулён. Копирайт и описание отдельного рецепта не меняются. Cache: catalog CSS v4, visual brand-2, catalog JS compact-intro-1.

Только текст и отступы; действия и аналитика прежние: catalog_list/search/filter/empty/open, favorites/share/print и benefits_view/cta/close. Новые события, поля и агрегаты не нужны; client_error/telemetry_health, durationMs, очередь, идемпотентность, dashboard и bridge v7 сохраняются. UI проверяется с изолированной локальной БД, публичный preview исключён из сбора.

Продолжение тестового ревью: публикация только в test; основной Telegram/MAX не переиздаются. Ссылка: https://recipeboibot-test.89-223-123-75.sslip.io/recipes?filters=visual .

Проверки UI: 390×844 и 320×568, обычный каталог на desktop 1440×1000; обведённых строк нет, заголовок и каталог доступны, горизонтального переполнения нет. Фильтр «Японская» даёт 12 результатов, общий каталог 340. На изолированной БД реальные действия дали catalog_list=2, catalog_filter=1, без client_error. Снимки outputs/catalog-compact-intro/. Код main 05dfc24, release a46121c; новые тесты на статический текст не добавлялись.

Выпуск test завершён штатными --check/--apply. 641/641 тестов локально и в контейнере. Архив d9a2085f08fc700dbd955e460daed6719375800c5657e6a2b0ee7773d096fbd9. Резерв /opt/recipeboibot-test/backups/recipes-before-parity-20261014T100015Z.sqlite.enc. Все 481 файла src/public совпадают с release Git-архивом, SHA256 fa64e57e1ed5e8a938c08014765a65eead0d7906b50ed18f6dc624fb4b444a8f. Healthy/ready, restart 0, OOM false, integrity ok, FK 0; данные, окружение и агрегаты сохранены. Снимки .tmp/compact-intro-test-before.json и .tmp/compact-intro-test-after.json. Публичный браузер подтвердил отсутствие обеих строк и выдачу 340 рецептов. Итоговый снимок outputs/catalog-compact-intro/published-mobile.png.
