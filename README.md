# Тест інвентарю — Inventory History Overlay

Мінімальне MV3-розширення для Steam Inventory (`appid=730`, `contextid=2`), яке додає control bar біля `#inventory_logos` та підсвічує тайли інвентарю на основі Market History.

## Що вміє
- Кнопка `Sync History` біля лого інвентарю.
- Обмеження завантаження історії: лише `By count` (останні N записів).
- Опція `Only new` для інкрементального підвантаження лише нових записів історії (з кешем між сесіями).
- Запити history йдуть з паузою `200ms`; при `HTTP 429` синхронізація автоматично чекає `60s` і повторює сторінку без спаму.
- Кнопка `Clear Sync` для очищення кешу синхронізації та зняття overlay.
- Парсинг ціни/дати пріоритетно з `results_html` (як у Steam Rebuy Manager), щоб зберігати формат валюти Steam, включно з форматом `3,--€`.
- Для покупок, де в HTML є лише базова назва (без wear), `market_hash_name` мапиться через listing id з `history_row_*` та `Inspect`-лінків у `assets` (`M<listingid>`).
- Підсвітка тайлів:
  - `SELL` → зелений фон/рамка + `S: <ціна>`
  - `BUY` → червоний фон/рамка + `B: <ціна>`
- Авто-підфарбовування нових тайлів через `MutationObserver`.

## Файли
- `manifest.json` — опис контент-скрипта.
- `inventory-history-overlay.js` — логіка UI, history fetch/parse, mapping assetid → market_hash_name, overlay apply.
- `inventory-history-overlay.css` — мінімальні стилі control bar та бейджів.
