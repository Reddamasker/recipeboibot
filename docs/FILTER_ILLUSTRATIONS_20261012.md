# Отдельные изображения фильтров

Запрос: заменить фотографии рецептов в кнопках кухонь и ингредиентов отдельными минималистичными изображениями. Выпуск только в тестовую веб-версию `?filters=visual`.

Создано встроенным image_gen: 15 иллюстраций кухонь и 10 ингредиентов. Финальные файлы: `public/assets/filters/*.webp`, 320 × 320. Изображения генерируются отдельно, без исходных фотографий рецептов. Для загрузки в браузере уменьшены и сжаты в WebP. Фильтры используют object-fit: contain, сохраняющий предмет целиком. Карточки рецептов не изменялись.

Общий промпт (SUBJECT заменяется темой из списка ниже):

```
Use case: stylized-concept. Asset type: a single standalone minimalist food illustration for a recipe website filter button. Subject: SUBJECT. Refined soft matte clay illustration, very simple rounded volumes, restrained natural colors, warm ivory and sage accents, no outlines, no photographic textures. Isolated centered object in a square canvas, three-quarter view, fills about 65 percent of canvas, ample clean space. Very subtle soft shadow. Consistent calm premium editorial food icon. Plain solid warm off-white background #f4f3ed. No plate or scene unless explicitly part of subject. No text, no letters, no flags, no emoji styling, no border, no watermark. Generate one image only.
```

- `cuisine-everyday.webp`: a small ivory cooking pot with a muted sage lid
- `cuisine-italian.webp`: one folded golden raviolo with one basil leaf
- `cuisine-georgian.webp`: one ivory khinkali dumpling with elegant pleats
- `cuisine-asian.webp`: a small ivory bowl of noodles with two simple chopsticks
- `cuisine-japanese.webp`: two simple salmon nigiri sushi
- `cuisine-russian.webp`: a small stack of three golden blini pancakes
- `cuisine-ukrainian.webp`: three crescent shaped varenyky dumplings
- `cuisine-belarusian.webp`: two small golden potato pancakes
- `cuisine-greek.webp`: an ivory feta cube and two muted green olives
- `cuisine-indian.webp`: one folded golden samosa
- `cuisine-hungarian.webp`: one deep terracotta paprika pepper with green stem
- `cuisine-uzbek.webp`: a small ivory bowl of golden pilaf with a few carrot strips
- `cuisine-eastern.webp`: a small ivory bowl of hummus with a swirl and one chickpea
- `cuisine-european.webp`: one simple golden croissant
- `cuisine-caucasian.webp`: one short skewer with three grilled meat cubes
- `ingredient-chicken.webp`: one raw pale pink chicken drumstick
- `ingredient-beef.webp`: one simple raw red beef steak with thin cream edge
- `ingredient-pork.webp`: one simple pale pink pork chop
- `ingredient-fish.webp`: one whole small silvery sage fish, side view
- `ingredient-rice.webp`: a tiny ivory bowl of white rice
- `ingredient-potato.webp`: two golden whole unpeeled potatoes
- `ingredient-mushroom.webp`: two cream button mushrooms
- `ingredient-egg.webp`: one whole cream egg and one egg half with golden yolk
- `ingredient-tomato.webp`: one terracotta red tomato with green stem
- `ingredient-cheese.webp`: one small golden cheese wedge with two holes

Проверки и результат публикации будут зафиксированы после выпуска.
