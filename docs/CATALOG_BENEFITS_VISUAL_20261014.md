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
