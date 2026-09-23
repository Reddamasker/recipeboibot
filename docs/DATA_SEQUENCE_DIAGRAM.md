# Data sequence diagram

Актуально по локальной реализации на 23 сентября 2026 года.

## 1. Импорт рецепта

```mermaid
sequenceDiagram
    title Импорт рецепта в личную коллекцию
    participant User as Пользователь
    participant Client as Telegram / Mini App
    participant Backend
    participant Source as Источник данных
    participant OpenAI
    participant SQLite

    User->>Client: Отправляет ссылку, текст, фото или голос
    Client->>Backend: Telegram update или POST /api/import
    Backend->>SQLite: Upsert пользователя и claim sourceKey
    SQLite-->>Backend: existing / processing / claimed
    Backend->>Source: Получить страницу, субтитры или медиа
    Source-->>Backend: Текст, метаданные и preview
    Backend->>OpenAI: ASR для голоса или видео
    OpenAI-->>Backend: Расшифровка речи
    Backend->>OpenAI: Нормализовать рецепт в JSON
    OpenAI-->>Backend: Ингредиенты, шаги и предупреждения
    Backend->>SQLite: Сохранить рецепт и status=ready
    SQLite-->>Backend: Recipe
    Backend-->>Client: created / existing / processing
    Client-->>User: Карточка сохранённого рецепта
```

`sourceKey` обеспечивает дедупликацию: повторный источник возвращает существующий рецепт или текущую задачу и не создаёт лишний AI-вызов. Для обычного текста, изображения и страницы шаг ASR пропускается. Для текстового импорта шаг получения внешнего источника также пропускается.

## 2. Поиск в личной коллекции

```mermaid
sequenceDiagram
    title Поиск рецепта
    participant User as Пользователь
    participant Client as Telegram / Mini App
    participant Backend
    participant SQLite
    participant AI as OpenAI

    User->>Client: Вводит запрос обычными словами
    Client->>Backend: Команда поиска или GET /api/search
    Backend->>SQLite: Поиск только по userId
    SQLite-->>Backend: Подходящие ready-рецепты
    alt Есть совпадения
        Backend-->>Client: Список результатов
        Client-->>User: Карточки и ссылка на рецепт
    else Совпадений нет
        Client->>Backend: Запросить новый рецепт
        Backend->>AI: Составить один рецепт по запросу
        AI-->>Backend: Ингредиенты и шаги
        Backend->>SQLite: Сохранить предложение отдельно
        Backend-->>Client: AI-предложение
        Client-->>User: Показать рецепт и спросить о добавлении
        User->>Client: Подтвердить сохранение
        Client->>Backend: Добавить предложение
        Backend->>SQLite: Создать рецепт с origin=generated
    end
```

Поиск локальный. При пустом результате отдельный AI-вызов составляет предложение, которое сохраняется в коллекции только после явного подтверждения. Все чтения и записи рецептов изолированы по Telegram-пользователю.
