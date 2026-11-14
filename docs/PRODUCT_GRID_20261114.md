# Единая сетка продуктов — 14 ноября 2026

Выбор продуктов в «Подобрать» теперь использует пять колонок на мобильных ширинах, без разделения на изображения и текстовый список. Все 24 продукта имеют фото; поиск сохраняет карточки с изображениями. Выбор, черновик, отмена, сброс, лимит 12 продуктов и серверная фильтрация сохранены. Доступны клавиатурный фокус и нативные checkbox; выбранное состояние отмечено рамкой и галочкой средствами CSS.

11 недостающих изображений созданы встроенным image_gen по навыку imagegen: гречка, творог, капуста, свёкла, кабачок, огурцы, молоко, фасоль, горох, чечевица, яблоки. Морковь использует существующий variant2/carrot. Новые WebP 480×480 сохранены в public/assets/filters/ingredients-v4; исходные сгенерированные PNG сохранены в локальном каталоге generated_images. Обработка для доставки — только масштабирование и кодирование WebP, без изменения содержания.

Общий промпт: «Use case: product-mockup. Create one square photorealistic ingredient thumbnail for a Russian recipe app: [ingredient]. Centered isolated studio food photograph, entire subject visible, occupying 78 percent of frame, three-quarter angle, soft diffused light, subtle contact shadow. Seamless extremely pale lavender-white background #f2eff7 matching an existing ingredient photo set. App displays it at 50px: immediately recognizable, simple silhouette. No text, letters, logos, utensils, hands, decoration or borders. This is one ingredient asset only.» Подстановки: mound of dry roasted buckwheat; bowl of Russian tvorog; cabbage head with wedge; beetroots with cut half; zucchini with slices; cucumbers with slice; glass of milk; red kidney beans; peas with open pod; dry red lentils; red-green apples with half.

## Аналитика и проверки

Изменение визуальное: прежние screen_view(other), step_submit, request_started, request_visible(selection), client_error(network) покрывают тот же сценарий. Новые поля, события, показатели, даты начала сбора и схема MAX bridge не вводятся; определения дашборда из ANALYTICS_CONTRACT сохраняются.

Браузер Chromium, отдельные preview-БД Telegram/MAX: шесть проверок 320/393/430 px. Все 24 изображения загружены, ровно пять карточек в первом ряду, горизонтального переполнения нет. Проверены выбор, отмена без применения, поиск «твор», изображение в результатах поиска, применение и выдача. Ошибок JavaScript нет. После уплотнения отступов повторены шесть проверок; скриншот 393 px визуально проверен, все 24 подписи и кнопки помещаются. Физические телефоны не проверялись.

## Выпуск

Выполняется; фактические версии, резервные копии и паритет будут записаны после публикации.
