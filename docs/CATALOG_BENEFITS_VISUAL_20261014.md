# Одноэкранное приглашение в бот — 14 октября 2026

Эта итерация заменяет оформление из CATALOG_BENEFITS_REDESIGN_20261014.md. Владелец отклонил многословный экран с прокруткой и оливковой палитрой. Область выпуска остаётся тестовой для проверки с телефона.

## Сообщение и оформление

Применён [nmt-craft-go-to-market Ивана Замесина](https://github.com/zamesin/Next-Move-Theory-Canon-and-Skills/blob/main/Skills/codex/nmt-craft-go-to-market/SKILL.md), включая обязательные страницы канона [Product Communication](https://github.com/zamesin/Next-Move-Theory-Canon-and-Skills/blob/main/Next-Move-Theory-Canon/Advanced-Jobs-To-Be-Done/communication.md) и [Consideration Activators](https://github.com/zamesin/Next-Move-Theory-Canon-and-Skills/blob/main/Next-Move-Theory-Canon/Advanced-Jobs-To-Be-Done/consideration-activators.md). Локальная опора: docs/LANDING_COPY.md и результат исследования Skills-Results/recipes/craft-go-to-market/2026-09-22_19-06_recipes-craft-go-to-market-result.md. Старые ограничения продукта из исследования не подменяют текущие функции.

Функции переведены в короткие призывы к результату: готовить из имеющихся продуктов, выбирать под свой вкус, собирать любимые рецепты вместе. Иллюстрация показывает готовый ужин. Это адаптация канона для одного экрана, а не каноническое требование писать по 3–4 слова. Конверсия нового текста пока не подтверждена экспериментом; обещания экономии времени и денег не добавлены.

Цвета взяты из основного Mini App public/styles.css: сиреневый фон, сливовый текст, ягодное действие. Основное место занимает новая прозрачная иллюстрация. Крестик, явный переход в Telegram и возврат к текущему рецепту сохранены. Пример не выдаётся за персональный результат. Бесплатные семь дней — для новых пользователей, запуск в боте.

## Иллюстрация

Файл: `public/assets/benefits-dinner-v3.png`. Создан встроенным инструментом image_gen, режим generate, transparent_background=true, без референсов. Финальный PNG скопирован в проект с сохранением прозрачности; внешние API и CLI не использовались.

Финальный промпт:

```text
Use case: ads-marketing. Create a premium editorial food collage asset for a Russian recipe assistant's MOBILE one-screen offer, not a complete UI. Square canvas, genuinely transparent background. No text, no letters, no logo, no watermark, no UI cards. Main subject: a large beautiful shallow pale lilac ceramic bowl filled with appetizing golden chicken pieces in a creamy lemon-and-dill sauce. Three-quarter overhead photographic perspective, handmade ceramic rim, soft realistic natural shadows. Bowl occupies about 72% of composition, towards lower right but fully inside canvas. Around upper left arrange a compact still life of a cut lemon, a small white ceramic cup of sour cream with a silver spoon, and a modest sprig of dill; distinguish ingredients from the finished dish through spacing. Elegant art-directed cutout photography, tactile, warm, sophisticated, generous clear silhouette; food is hero, not decoration. Brand material colors are pale lilac #e7def0, off-white #f8f5fa, dark plum #302537, tiny berry #a4415c accents in a folded linen napkin under one edge of the bowl. No olive-colored background or green graphic shapes; natural tiny herbs can be green. Everything should read clearly when rendered at 300 pixels. Tight composition with only 4% empty margin; no floating confetti, sparkles, cartoon faces, app mockups, gradients, or complex background. Actual transparent alpha around objects.
```

## Аналитика

Изменяется представление, а не сценарий. Повторно используются `benefits_view`, `benefits_cta`, `benefits_close`, `flowId`, `durationMs`, `catalog_open`, `client_error` и `telemetry_health`. Новых событий, полей, агрегатов и начала сбора нет. Показ по `?benefits=preview` исключён из аналитики на весь документ. Обработчики, очередь, определения дашборда и схема MAX bridge v7 сохранены.

## Проверка и публикация

Независимый frontend-review выполнен отдельным агентом. Исправлены замечания: safe-area в горизонтальном положении и размер условий до 11 px. Итоговое ревью без блокеров. Разработку вёрстки, ревью и проверку агрегатов выполняли отдельные субагенты, интеграцию и браузерную проверку — основной агент.

Браузерные проверки: 320×568, 360×640, 390×664, 390×844, 844×390 и 1440×1000. На всех проверенных размерах scrollHeight совпадает с clientHeight диалога, горизонтального переполнения нет. Дополнительно 320×480 помещается с уменьшенным изображением. На 320×568 CTA заканчивается на 524 px, возврат — на 568 px, крестик 44×44. Ничего не скрыто через overflow:hidden внутри диалога: высота иллюстрации подстраивается под оставшееся место. Вырезы экрана учтены через safe-area. Физический телефон и системное увеличение шрифтов не эмулировались.

Крестик закрывает диалог, возвращает фокус к H1, снимает фиксацию body и оставляет выбранный рецепт. Ошибок JS не обнаружено. Финальная версия CSS v7. Скриншоты сохранены в `outputs/catalog-benefits-v3/`.

Полный локальный набор: 640/640. Финальные изменения после ревью — только CSS и версия его ресурса; полный набор повторяется штатным deploy перед загрузкой и в контейнере. Выпуск выполняется из чистой копии `.tmp/benefits-visual-release-20261014`, release-коммит `6b70530`. В архив не попадают посторонние незавершённые файлы, окружение и данные.

## Выпущено только в test

Штатные `deploy-test.js --check` и `--apply` завершены. Повторный полный набор перед отправкой и в контейнере: 640/640 в каждом запуске. Код в main: `c6bf058`, отправка в origin/main подтверждена. Основной Telegram/MAX в этой итерации не переиздавались.

- Архив выпуска: `1eac3270ffc19623be968630a2c8f6ea44afb09373ceab5750674c236548b26f`.
- Резерв БД: `/opt/recipeboibot-test/backups/recipes-before-parity-20261014T070153Z.sqlite.enc`.
- Паритет всех 479 файлов src/public с Git-архивом подтверждён. Source SHA256 `b67a58b0704771701442df571cce6b70f8dc19f9f46e6d96ebe04689883f9bea`.
- Healthy/readyz, integrity ok, FK errors 0, restartCount 0. Хеш окружения не изменился. Users 2, recipes 2, trials 1, provider_requests 404, ai_reservations 406, orders/subscriptions 0 сохранены; содержимое персональных данных не извлекалось.
- Внешняя страница открыта браузером на 390×844: CSS v7, изображение загружено, clientHeight=scrollHeight=844. Реальное нажатие CTA открывает `https://t.me/recipeboi_test_bot?start=dinner`; Start не отправлялся. Снимок опубликованной страницы: `outputs/catalog-benefits-v3/published-mobile-390.png`.
- Агрегат после preview-проверки неизменен: 1 view, 1 CTA, 1 close, unmatchedActions 0; это прежние контрольные события, а не новая оценка конверсии. Рекламный срез null, bridge v7. Новых счётчиков и сбросов нет.

Ссылка для телефона: https://recipeboibot-test.89-223-123-75.sslip.io/recipes/pork-cabbage?benefits=preview . Открывать исходную ссылку повторно: preview-параметр удаляется после показа, сохранение обычного URL не гарантирует повторное открытие экрана.
