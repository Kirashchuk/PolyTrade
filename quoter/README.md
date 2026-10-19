# Perps Quoter

Котирувальник для [Liquidity Rewards](https://docs.polymarket.com/perps/liquidity-rewards) Polymarket Perps. Тримає post-only GTC ордери з обох боків від mid у діапазонах 0–5 / 5–10 / 10–20 bps і переставляє їх через modify. Специфікація: [`../perps-quoter-architecture.md`](../perps-quoter-architecture.md). Рішення: [ADR-0003](../docs/adr/0003-perps-quoter.md).

Увесь трафік до API (REST і WebSocket) йде через HTTP-проксі з `QUOTER_EGRESS_PROXIES` у `quoter/.env`. Прямого з'єднання немає, доки `egress.allow_direct: false`.

## Команди

```powershell
cd C:\PolyTrade\quoter
bun run probe      # проксі, серверний час, інструмент, публічний WS (лише читання)
bun run dry-run    # живі дані, симульована сітка й метрики score/uptime, без записів
bun run status     # приватний стан акаунта (потрібні ключі, див. нижче)
bun run start      # live: run --live
bun run cancel-all # скасувати всі ордери на інструменті
bun run check      # tsc --strict + тести
```

Зупинка: Ctrl+C, SIGTERM або файл `quoter/STOP`. Штатна зупинка виконує `cancelAll`, перевіряє `/open-orders` і вимикає `autoCancel`. Якщо процес упаде, біржа зніме ордери за дедлайном `autoCancel` (≤60 с).

## Налаштування

1. `copy config\example.yaml config\quoter.yaml` (файл у `.gitignore`). Головні поля: `instrument`, `levels`, `inventory`, `risk`.
2. Для live: `mode: live` і `operator.jurisdiction` / `operator.region`, тобто де ви фізично перебуваєте. Без них, а також для US, CA, CU, IR, KP, SY, Криму, Донецької й Луганської областей, `run --live` відмовить до будь-якого підпису. Країна проксі на це не впливає.
3. Ключі експортуються лише в оболонці. `.env` їх не приймає:

```powershell
$env:PERPS_OWNER_PRIVATE_KEY = '0x...'   # на старті реєструє proxy-ключ (TTL credentials.proxy_ttl_hours), тримає його в пам'яті
# або вже зареєстрований proxy-ключ:
$env:PERPS_PROXY_PRIVATE_KEY = '0x...'; $env:PERPS_PROXY_SECRET = '...'; $env:PERPS_PROXY_EXPIRES_AT = '1792500000000'
```

## Що робить live-цикл

Старт: синхронізація годинника, перевірка інструмента й конфігу на ліміти, приватний WS (`orders`, `fills`, `portfolio`), REST-знімок, `cancelAll` чужих ордерів (`risk.startup_cancel_all`), плече, `autoCancel` +60 с з re-arm кожні 20 с, два публічні потоки через різні проксі.

Кожна зміна mid (debounce `min_interval_ms`) проходить шлях QuoteEngine → RiskManager → Executor. Executor надсилає один батч на тип операції в порядку cancel → modify → place. Кожен підписаний запис робить одну спробу. Невизначений результат зупиняє записи до REST-звірки.

| Тригер | Дія |
|---|---|
| Стакан старший за `stale_book_ms` або обидва публічні потоки впали | `cancelAll`, пауза |
| Пропуск `sq` або перепідключення приватного потоку | заморозка, REST-звірка |
| Рух mid > `move_bps` за `window_s` | `cancelAll` на `pause_s` (або розширення сітки) |
| \|позиція\| ≥ `max_position_usd` | сторона, що збільшує позицію, не котирується (`zero`) або мінімальна (`shrink`) |
| Маржа < `min_available_margin_usd` | розміри пропорційно зменшуються |
| Ліквідація, денний PnL < −`max_daily_loss_usd`, settled/close-only, kill switch | `cancelAll`, зупинка процесу |
| `post_only_rejected` N разів | слот відсувається на `ticks` на `for_s` |

Метрики пишуться в `quoter/data/metrics-<mode>-<date>.jsonl`: uptime, середній liquidity score, notional по діапазонах, глибина чужого стакану по діапазонах, maker share з `/v1/account/stats`, оцінка raw score, обсяги, комісії. Dry-run-рядки мають `"simulated": true`.

## Обмеження

- Live-шлях перевірено лише проти локальної мок-біржі з перевіркою підписів. Реальних ордерів під час розробки не було. Перший live-крок за спекою: $1k на рівень.
- Семантика `sq` у приватних каналах не перевірена наживо: пропуск запускає REST-звірку, і вона ж повторюється кожні `reconcile_every_s`.
- Бот вважає інструмент своїм: пауза і зупинка виконують `cancelAll` на ньому, тож ручні ордери на тому самому інструменті теж будуть скасовані. `autoCancel` діє на весь акаунт.
- `status` і `cancel-all` з `PERPS_OWNER_PRIVATE_KEY` реєструють новий proxy-ключ. Щоб цього уникнути, передайте готовий `PERPS_PROXY_*`.
- Сесії акцій визначаються за розкладом NYSE без свят.
- Тунелі через проксі зрідка обриваються (1006). Публічні дані дубльовані, приватний потік перепідключається і звіряє стан, ордери на цей час заморожені, але лишаються в книзі.
