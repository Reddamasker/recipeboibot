# Единая сетка продуктов — 14 ноября 2026

Выбор продуктов в «Подобрать» теперь использует пять колонок на мобильных ширинах, без разделения на изображения и текстовый список. Все 24 продукта имеют фото; поиск сохраняет карточки с изображениями. Выбор, черновик, отмена, сброс, лимит 12 продуктов и серверная фильтрация сохранены. Доступны клавиатурный фокус и нативные checkbox; выбранное состояние отмечено рамкой и галочкой средствами CSS.

11 недостающих изображений созданы встроенным image_gen по навыку imagegen: гречка, творог, капуста, свёкла, кабачок, огурцы, молоко, фасоль, горох, чечевица, яблоки. Морковь использует существующий variant2/carrot. Новые WebP 480×480 сохранены в public/assets/filters/ingredients-v4; исходные сгенерированные PNG сохранены в локальном каталоге generated_images. Обработка для доставки — только масштабирование и кодирование WebP, без изменения содержания.

Общий промпт: «Use case: product-mockup. Create one square photorealistic ingredient thumbnail for a Russian recipe app: [ingredient]. Centered isolated studio food photograph, entire subject visible, occupying 78 percent of frame, three-quarter angle, soft diffused light, subtle contact shadow. Seamless extremely pale lavender-white background #f2eff7 matching an existing ingredient photo set. App displays it at 50px: immediately recognizable, simple silhouette. No text, letters, logos, utensils, hands, decoration or borders. This is one ingredient asset only.» Подстановки: mound of dry roasted buckwheat; bowl of Russian tvorog; cabbage head with wedge; beetroots with cut half; zucchini with slices; cucumbers with slice; glass of milk; red kidney beans; peas with open pod; dry red lentils; red-green apples with half.

## Аналитика и проверки

Изменение визуальное: прежние screen_view(other), step_submit, request_started, request_visible(selection), client_error(network) покрывают тот же сценарий. Новые поля, события, показатели, даты начала сбора и схема MAX bridge не вводятся; определения дашборда из ANALYTICS_CONTRACT сохраняются.

Браузер Chromium, отдельные preview-БД Telegram/MAX: шесть проверок 320/393/430 px. Все 24 изображения загружены, ровно пять карточек в первом ряду, горизонтального переполнения нет. Проверены выбор, отмена без применения, поиск «твор», изображение в результатах поиска, применение и выдача. Ошибок JavaScript нет. После уплотнения отступов повторены шесть проверок; скриншот 393 px визуально проверен, все 24 подписи и кнопки помещаются. Физические телефоны не проверялись.

## Выпуск

Повторный полный браузерный сценарий Telegram/MAX на 320/393/430 px: по 21 принятому событию, два selection, без ошибок JavaScript; проверены сброс и сетевой отказ с повтором. Отдельно скрытый документ не создаёт request_visible, после видимости — одна запись с latency 1307/1278 мс; потерянное подтверждение отправки не создаёт дубль. Определения и проверки внутренних аккаунтов/источников покрываются неизменённым общим набором. Первый локальный полный прогон: 1088 pass, 0 fail/skip.

Первый серверный прогон test остановил выпуск: существующий тест dinner-buffer «fresh client» превысил порог 1000 мс (1509 мс на весь тест). Штатный откат восстановил прежний код/образ без сброса БД. Серверная логика не изменялась; отдельно та же группа прошла 32/32, затем полный повтор на том же архиве — 1086 pass, 0 fail, 2 Python skip. Порог и тест не менялись; Python-проверки входят в локальные 1088/1088 без пропусков. Достоверная причина единичной задержки не установлена.

Test опубликован 14 ноября около 17:31 МСК; резерв recipes-before-parity-20261114T143148Z.sqlite.gz.enc. Архив SHA-256 93fd2215c30d5e29683207d4e8757de4ec27b05fbef4950c9c48356ceed32282. Опубликованные ресурсы и каталог проверены в Chromium: 24 изображения, 5 колонок, выбор/поиск/отмена работают, ошибок JS нет. Личные API и аналитика QA направлены только в локальный preview.

Финальный runtime 9615e65c310f2c8343536d00044eac316115669f. Контейнеры запущены 14 ноября 2026: test 17:31:52 → основной Telegram/сайт 17:38:47 → MAX 17:54:58 МСК. Все healthy, readyz ok, restarts=0, OOM=false. Во всех трёх локальных выпусках 1088 pass, 0 fail/skip. Успешные серверные test/MAX — каждый 1086 pass, 0 fail, 2 Python skip. Выпуск выполнен штатными --check/--apply; повтор test использовал тот же штатный серверный скрипт и проверенный архив. Основной резерв recipes-20261114T143752Z.sqlite.gz.enc; MAX recipes-before-max-20261114T145446Z.sqlite.gz.enc; политика хранения проверена.

Опубликованные UI и фактический каталог test, dishfinder.ru и MAX проверены в Chromium: 24 загруженных изображения, пять колонок, выбор/отмена/поиск/применение, без ошибок JS. Личные API и QA-аналитика направлены в локальный preview. Все 627 файлов src/public трёх работающих контейнеров совпадают с Git; SHA-256 путей и содержимого eec196fa62bd5fa4e35bbdf8eccae7ca51fd3b366d445f6831c18081829f5bb3. Штатный source hash MAX 92f6e89dc2b349580817dacd65732c7942bf9a07003d4630bfb27fd476461a5e.

SQLite integrity_check=ok и foreign_key_check без нарушений во всех контурах. Количество пользователей, рецептов, стартов, заказов и запросов провайдера совпало с началом работы; SHA-256 окружений также совпали. Живой дашборд all и ya-product-landing-202611: MAX bridge ready, Telegram/MAX представлены с latency/workspace, схема MAX валидна.
