# THERMA — trvalá diagnostika ESP32

Diagnostika zachovává události v **LittleFS** přes reset a umožňuje vyšetřit nedostupnost HTTP/WS, OpenTherm timeouty, zpomalení hlavní smyčky a paměť. Ovládání ventilu ani časování OpenTherm není touto změnou upravováno.

## Data

- Aktuální soubor: `/diagnostics/events.jsonl` (JSON Lines; každý řádek je samostatné JSON).
- Archiv: `/diagnostics/events.1.jsonl` až `.3.jsonl`.
- Rotace při velikosti aktuálního souboru nejméně **96 KiB**; až čtyři soubory (cca 384 KiB celkem).
- Volná rezerva LittleFS nejméně 96 KiB. Při nedostatku místa se odstraňují pouze staré archivy diagnostiky, nikdy konfigurace ani webové soubory.
- Zápisy pouze ze servisní části hlavní smyčky, nikoli v přerušení, při synchronním čekání na OT ani ze síťových callbacků.
- Fronta 40 událostí, vyprazdňování obvykle každé 2 s nejvýše po 8 záznamech. Pokud selže úložiště, přetrvá omezený RAM buffer, nic se cyklicky nezapisuje.
- `boot` je orientační čítač v RTC paměti (může se vynulovat po úplném vypnutí napájení); `uptimeMs` je čas od startu, `epoch` jen při platném systémovém čase.

## Jak číst log

- `system/boot`: reset reason (například panic, task_wdt, brownout, software), číslo resetu a poslední známý modul ze zálohy v RTC paměti. **Poslední modul není důkazem příčiny resetu**.
- `runtime/slow_stage` a `slow_loop`: překročení prahů 500 ms na modul a 700 ms na smyčku. Opakované logování je omezeno na jednou za 30 s. Metriky v API zachovávají počty/maxima.
- `opentherm/communication_errors`, `link_recovered`, `hard_timeout`: opakované timeouty a následné zotavení; jednotlivé běžné rámce se neukládají na flash.
- `network/link_state`: změna připojení Wi-Fi/ETH.
- `websocket/clients`: přechod mezi nulovým a nenulovým počtem klientů.
- `memory/heap_low`, `heap_recovered`, `runtime/heartbeat`: paměť a pětiminutový souhrn.
- `admin/*`: existující servisní příkazy a změny konfigurace (bez uložení obsahu konfigurace nebo hesel).

## Rozhraní

- **Diagnostika → Logy → Trvalá diagnostika ESP32**: náhled posledních ~8 KiB, statistiky, stažení logů, potvrzené smazání.
- `GET /api/diagnostics/status`: JSON s reset reason, heap, maxima latencí, OT počítadly, WS a soubory.
- `GET /api/diagnostics/tail`: omezený textový náhled, bez velkého JSON dokumentu.
- `GET /api/diagnostics/download?part=0..3`: stažení aktuálního nebo archivního souboru.
- `POST /api/diagnostics/clear`: vymaže jen čtyři diagnostické soubory; potvrzení je ve webovém UI. **Endpoint je součástí stávajícího lokálního API a nepřidává autorizaci**; zařízení nepublikujte do veřejného internetu.

## Ověření na zařízení před sloučením

1. Kompilovat sketch se všemi novými `.h/.cpp` soubory, aktualizovat firmware i LittleFS.
2. Vyzkoušet restart ESP32, přepnutí linky Ethernet/Wi-Fi, připojení/odpojení WS klienta, přerušení OT komunikace a opětovné navázání.
3. Zkontrolovat příčinu restartu, posloupnost událostí a odpovědi uvedených endpointů.
4. Ověřit, že při chybném/malém LittleFS systém nezacyklí formátování ani nekontrolovaně nezaplňuje úložiště.
5. Ověřit, že ruční ovládání směšovacího ventilu, bezpečnostní relé a komunikace OpenTherm fungují stejně jako před změnou.

**Důležité omezení:** Během skutečného hard resetu nelze synchronně uložit poslední sekundy stavu flash: v RTC se drží jen poslední jméno vykonávaného modulu a čas, ostatní logy se ukládají průběžně. Při brownoutu mohou být poslední buffered záznamy ztraceny. Nový firmware také zatím neřeší původní blokující OT request (až 3 s); pouze ho měří a zaznamenává.
