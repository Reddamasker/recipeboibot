# Крестик без круглой обводки

14 октября 2026, продолжение версии 2, только тестовый контур.

По запросу владельца удалён круг вокруг крестика справа сверху: круглая форма и фоновая заливка hover убраны, focus-visible показывает сам крестик ягодным цветом и более толстыми линиями, без обводки. Область нажатия остаётся 44×44 px. Шапка, тексты, остальные элементы, ссылки и логика не меняются. Cache benefits CSS v16.

Аналитика прежняя: benefits_view / benefits_close / benefits_cta, durationMs, catalog_open после закрытия, client_error и telemetry_health. CSS не меняет действие, события, агрегаты или начало сбора; новые события не добавлены.

Проверка на 390×844: у кнопки outline none, border 0, radius 0, фон прозрачный, размер 44×44. Нажатие закрывает экран и возвращает фокус на заголовок рецепта. Скриншот outputs/benefits-close-plain/mobile-390.png.

На 320×568 дополнительно проверены Tab и Shift+Tab: фокус виден по самому крестику, круг отсутствует; диалог client/scroll 320×568. События и JS не менялись.

Выпуск test завершён: main 14103a0, runtime e806e36, штатные --check/--apply; 641/641 локально и в контейнере. Архив 14413d8d6a1d9877e1f4e7b3c4d0f5f3b664c943d941b379c3bac6c563eae1ff. Резерв /opt/recipeboibot-test/backups/recipes-before-parity-20261014T104830Z.sqlite.enc. Все 481 файла совпадают, SHA256 d831a6c8513c5695ad58d6aa57386b7e50bc008e5db9e06b3571f6d570c71a92. Healthy/ready, restart 0, OOM false, integrity ok, FK 0. Данные, окружение и агрегаты сохранены. Основной Telegram/MAX не переиздавались.

Публичный браузер подтвердил отсутствие круглого контура и прозрачный фон при области44×44. Снимок outputs/benefits-close-plain/published-mobile.png. Ссылка: https://recipeboibot-test.89-223-123-75.sslip.io/recipes/pork-cabbage?benefits=preview .
