# Recipeboibot ERD

Схема соответствует SQLite-модели в `src/db.js` на 23 сентября 2026 года. Для читаемости показаны ключевые поля; полный DDL остаётся источником истины.

```mermaid
erDiagram
    direction LR

    users ||--o{ recipes : owns
    recipes ||--o| recipeImages : has
    recipes ||--o| recipeShares : sharedAs
    users ||--o{ importJobs : starts
    recipes o|..o{ importJobs : linkedFrom
    users o|..o{ providerRequests : logs
    users ||--o| pendingIntents : has
    users ||--o{ recipeSuggestions : requests
    recipes o|..o{ recipeSuggestions : materializes
    users ||--o{ searchOffers : receives
    users ||--o{ telegramGroups : owns

    users["users"] {
        text id PK
        text telegramId UK
        text username
        text displayName
        integer isAllowed
        integer groupAccess
        datetime createdAt
        datetime updatedAt
    }

    recipes["recipes"] {
        text id PK
        text userId FK
        text status
        text title
        json ingredientsJson
        json stepsJson
        text sourceKey "Unique per user"
        text sourceType
        datetime createdAt
        datetime updatedAt
    }

    recipeImages["recipe_images"] {
        text recipeId PK, FK
        text mime
        blob bytes
    }

    recipeShares["recipe_shares"] {
        text token PK
        text recipeId FK, UK
        datetime createdAt
    }

    importJobs["import_jobs"] {
        text id PK
        text userId FK
        text recipeId FK "Nullable"
        text sourceKey "Unique per user"
        text sourceType
        text status
        text errorCode
        datetime createdAt
        datetime updatedAt
    }

    providerRequests["provider_requests"] {
        text id PK
        text userId FK "Nullable"
        text operation
        text model
        text status
        integer totalUnits
        text requestId
        datetime createdAt
    }

    processedUpdates["processed_updates"] {
        text updateId PK
        text status
        datetime createdAt
        datetime updatedAt
    }

    aiReservations["ai_reservations"] {
        text id PK
        datetime createdAt
    }

    pendingIntents["pending_intents"] {
        text userId PK, FK
        json payloadJson
        datetime createdAt
        datetime updatedAt
    }

    recipeSuggestions["recipe_suggestions"] {
        text id PK
        text userId FK
        text query
        json recipeJson
        text recipeId FK "Nullable"
        datetime createdAt
    }

    searchOffers["search_offers"] {
        text id PK
        text userId FK
        text query
        datetime createdAt
    }

    telegramGroups["telegram_groups"] {
        text chatId PK
        text ownerUserId FK
        text type
        text title
        text status
        datetime createdAt
        datetime updatedAt
    }
```

Таблицы `processed_updates` и `ai_reservations` не имеют внешних ключей. Они отвечают соответственно за идемпотентность Telegram updates и учёт попыток AI-вызовов. Историческое имя `ai_reservations` сохранено для совместимости с существующей БД.

Составные уникальные индексы:

- `recipes(user_id, source_key)` при непустом `source_key`;
- `import_jobs(user_id, source_key)` при непустом `source_key`.
