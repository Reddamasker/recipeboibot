# Подтверждения кнопок MAX — 6 октября 2026

Владелец сообщил, что «Да, сбросить» не работает. Чтение max_inbox подтвердило поступление настоящих test:reset:confirm/cancel, корректные привязки владельца и сообщения, повторные ошибки обработчика до удаления профиля. Ранее аналогично завершались trial:start.

Причина в общей MAX-транспортной реализации answerCallbackQuery: вызов без текста отправлял POST /answers с телом `{}`. Реальный API вернул HTTP 400, code=proto.payload, message=`Invalid request. message or notification required`. Исключение останавливало общий обработчик перед бизнес-действием. Официальное описание метода: [MAX — POST /answers](https://dev.max.ru/docs-api/methods/POST/answers).

Теперь MAX отправляет notification с непустым текстом: явный ответ обработчика либо «Принято». Это подтверждение получения нажатия, а не преждевременное сообщение о завершении действия. Изменение общее для кнопок сброса, trial, меню и других callback-действий MAX. Отправка Telegram и ограничения сброса только аккаунтом владельца сохраняются.

В прежнем тесте mock API разрешал пустой запрос и не воспроизводил настоящий контракт. После включения реального отказа обе проверки отмены и подтверждения сброса упали с тем же 400; после исправления прошли. Отдельная транспортная проверка покрывает отсутствие текста и явный текст ответа. Реальные аккаунты и квоты для проверки не сбрасывались; старые события, завершившиеся ошибкой, вручную не переигрывались. Для живой проверки владелец повторно отправляет /test_reset и подтверждает новую кнопку.

## Фактический выпуск

Runtime `1bbf8097098610d65e66c052a1c41e9e87214683` штатно опубликован --check/--apply сначала в @recipeboi_test_bot, затем @Recipeboibot и MAX @id500912857935_bot. 491/491 локальных и 491/491 изолированных серверных проверок на test и MAX; основной deploy также прошёл 491/491 локально. Серверные проверки без сети, секретов и рабочих томов.

Все 146 файлов src/public работающих контейнеров совпадают: SHA-256 `c7d22e64c000cc812fa80a1e9c5bc35b1c46c9090cb29c6e16377b3f1afd3787`. Все healthy/readyz, integrity_check=ok, foreign_key_check без ошибок. Хеши .env.local трёх контуров не изменились, настройки оплаты и MAX_TEST_RESET_USER_ID сохранены. Пользовательские таблицы не уменьшились; за время выпуска добавились обычные acquisition/landing события. AI-учёт не изменился.

Резервы: test recipes-before-parity-20261006T085312Z.sqlite.enc; main recipes-20261006T085534Z.sqlite.enc; MAX recipes-before-max-20261006T085705Z.sqlite.enc в отдельных backups. Test archive SHA-256 `24e5d98ed84889cc968df0de8b1494263a22dca5657007273bc77186f3e2d7b5`; MAX archive `e42486d9f7b7c6cd0a77ef4e4295c62699bc052737cc3007bfa3e3f98b6d4498`.

Локальный аудит: data/max-callback-before-20261006.json, data/max-callback-after-20261006.json. Логи: outputs/max-reset-callback-before-fix-20261006.log, outputs/max-reset-callback-focused-20261006.log, outputs/max-callback-deploy-test-20261006.log, outputs/max-callback-deploy-main-20261006.log, outputs/max-callback-deploy-max-20261006.log. Runtime сохраняется меткой release/max-callbacks-20261006; main и метка публикуются в origin с проверкой удалённых SHA.
