# ESP32-S3-ETH-8DI-8RO-OT-EQ-Valve-Controller

Firmware pro inteligentní řídicí jednotku pro topný systém založenou na desce Waveshare ESP32-S3-ETH-8DI-8RO. Projekt kombinuje Ethernet, WiFi, webový portál, OpenTherm komunikaci, DS18B20 senzory, BLE senzor, MQTT a řídící logiku pro vytápění, zásobování TUV a směšovací ventil.

Tento firmware je navržen pro ovládání a monitoring topného systému s následujícími funkcemi:

- řízení výstupních relé pro topení, zásobování TUV a cirkulaci
- práce s externími vstupy pro den/noční režim, požadavky a servis
- integrace s OpenTherm kotlem
- ekvitermní regulace a řízení směšovacího ventilu
- podpora DS18B20 senzorů pro měření teplot
- webový portál pro konfiguraci a diagnostiku
- WiFiManager a OTA aktualizace
- MQTT/Home Assistant integrace
- BLE podpora pro meteorologický/venkovní sensor
- logování událostí, historie a alarmy

## Obsah

- [Přehled projektu](#přehled-projektu)
- [Hardware a pinout](#hardware-a-pinout)
- [Funkce a režimy](#funkce-a-režimy)
- [Struktura projektu](#struktura-projektu)
- [Začínáme](#začínáme)
- [Konfigurace](#konfigurace)
- [Konzolové příkazy](#konzolové-příkazy)
- [Bezpečnostní poznámky](#bezpečnostní-poznámky)
- [Licence](#licence)

## Přehled projektu

Jedná se o univerzální firmware pro ESP32-S3 s Ethernet rozhraním a 8 digitálními vstupy a 8 relé výstupy. Projekt je zaměřen na řízení topného systému s rozšířenou logikou pro:

- topné těleso / cirkulační okruh
- bojler / TUV a cirkulaci TUV
- směšovací ventil (A/B/AB regulace s interlockem)
- ekvitermní křivku a denní/noční režim
- měření teplot na několika cestách
- dálkový monitoring a vzdálené nastavení

V základním běhu firmware inicializuje síťové rozhraní, OpenTherm komunikaci, BLE klienta, webový portál, MQTT a řídicí moduly pro ekvitermii a směšovací ventil.

## Hardware a pinout

Projekt je navržen pro desku Waveshare ESP32-S3-ETH-8DI-8RO a využívá:

- ESP32-S3 s Ethernet rozhraním
- 8 digitálních vstupů (IN1 až IN8)
- 8 reléových výstupů přes expander TCA9554
- RGB LED na GPIO38
- pasivní buzzer na GPIO46
- I2C sběrnici pro RTC a IO expander
- OneWire pro DS18B20 senzory
- OpenTherm adaptér na GPIO47/48

### Základní pinové mapování

```cpp
// Digital inputs
#define INPUT1_PIN 4
#define INPUT2_PIN 5
#define INPUT3_PIN 6
#define INPUT4_PIN 7
#define INPUT5_PIN 8
#define INPUT6_PIN 9
#define INPUT7_PIN 10
#define INPUT8_PIN 11

// I2C
#define I2C_SCL_PIN 41
#define I2C_SDA_PIN 42

// RGB + buzzer
#define RGB_LED_PIN 38
#define BUZZER_PIN 46

// DS18B20 OneWire
#define DS18B20_PIN_1 0
#define DS18B20_PIN_2 1
#define DS18B20_PIN_3 2
#define DS18B20_PIN_4 3

// OpenTherm
#define OT_TX_PIN 47
#define OT_RX_PIN 48
```

### Reléový mapování

Firmware pracuje s následující logikou relé:

- R1 + R2 = směšovací ventil (motor OPEN/CLOSE)
- R3 = přepínací 3cestný ventil TUV/CH
- R4 = cirkulační čerpadlo TUV
- R5 = požadavek kotle pro TUV
- R6 = den/noc ekvitermní křivka na kotli
- R7 = omezovací relé výkonu kotle
- R8 = stykač topné tyče (akumulační nádrž)

### Vstupní mapování

- IN1 = denní/noční křivka (ACTIVE = noční režim)
- IN2 = požadavek TUV (ACTIVE)
- IN3 = požadavek cirkulace (ACTIVE)
- IN8 = servis: při bootu vynutí WiFiManager portal

## Funkce a režimy

### 1. OpenTherm integrace

Firmware komunikuje s kotlem přes OpenTherm protokol. V kódu jsou implementovány funkce pro:

- polling stavu kotle
- skenování podporovaných Data ID
- diagnostiku a JSON status
- přístup k parametrům kotle a datům teplot

Některé příkazy umožňují:

- `OT` – status OpenTherm v JSON
- `OTSCAN START` – zahájit skenování datových ID
- `OTSCAN ALL` – skenování s rozšířeným souborem dat
- `OTSCAN STATUS` – zobrazení stavu skenování
- `OTSCAN STOP` – zastavení skenování

### 2. Ekvitermní regulace

Projekt obsahuje modul `EquithermController`, který řídí:

- denní a noční režim
- výpočet cílové teploty podle venkovní teploty
- přepínání mezi denním a nočním režimem
- integraci s OpenTherm požadavkem a stavy systému

Příkazy:

- `EQ` – status ekvitermní logiky
- `EQ MODE DAY` / `NIGHT` / `AUTO`

### 3. Směšovací ventil

Firmware obsahuje samostatný kontroler pro směšovací ventil s adaptivním řízením:

- práce s A/B a AB provozem
- interlock mezi relé R1/R2
- řízení podle teplotních rolí a zpoždění
- přehled stavu v JSON

### 4. TUV, cirkulace a DHW

Modul `DhwController` řídí:

- přístup k teplotám nádrže a zpátečky
- cirkulaci zbytkového okruhu
- prioritizaci TUV vůči vytápění
- alarmy a diagnostiku

### 5. DS18B20 teplotní sítě

Firmware pracuje se čtyřmi OneWire zónami pro DS18B20 senzory. Teploty se centralizují přes `TemperatureManager`, který je schopen:

- přiřadit senzory do rolí (např. topná nádrž, zpátečka, venkovní teplota, TUV)
- udržovat konzistentní hodnoty v čase
- používat data z Dallas senzoru nebo příchozí datové zdroje

### 6. Webový portál a konfigurace

Webový portál je součástí firmware a slouží pro přehled stavu systému a konfiguraci. Obsahuje:

- webové rozhraní pro monitorování a konfiguraci
- API pro operace z prohlížeče
- možnost konfigurovat NVS / runtime nastavení
- přístup přes WiFi nebo Ethernet

Pokud je při bootu aktivní vstup IN8, firmware vynutí konfiguraci přes WiFiManager portal.

### 7. MQTT a Home Assistant

Firmware podporuje MQTT komunikaci a publikaci dat pro domovské automatizační systémy. To umožňuje integraci s Home Assistant nebo jinými brokerovými řešeními.

### 8. BLE klient

Je podporována BLE komunikace se senzory, zejména s platformou ESP-Meteostanice-Outdoor. To umožňuje získávat venkovní teplotu a další meteorologická data přes BLE bez nutnosti přímého připojení k externímu cloudu.

### 9. OTA a diagnostika

Projekt obsahuje:

- OTA aktualizace přes síť
- logování událostí (`EventLog`)
- historii naměřených hodnot (`HistoryBuffer`)
- signální buzzer pro stavové a alarmové indikace
- tlakové alarmy a další ochranné mechanizmy

## Struktura projektu

Hlavní soubory v kořeni repozitáře:

```text
.
├── ESP32-S3-ETH-8DI-8RO-Controller.ino   # hlavní Arduino sketch
├── config_pins.h                          # mapování pinů a hardware
├── Features.h                             # přepínání funkcí
├── FeatureNetwork.h                       # WiFiManager / síť
├── FeatureOpenTherm.h                     # OpenTherm
├── FeatureBle.h                           # BLE
├── FeatureWebPortal.h                     # webový portál
├── FeatureOta.h                           # OTA
├── FeatureEquitherm.h                     # ekviterm
├── ConfigStore.h                          # persistované nastavení
├── ConfigRuntime.cpp / .h                 # runtime konfigurace
├── NetworkController.*                    # síť a WiFiManager
├── OpenThermController.*                  # OpenTherm logika
├── EquithermController.*                  # ekvitermní regulace
├── MixingValveController.*                 # směšovací ventil
├── DhwController.*                        # TUV a cirkulace
├── TemperatureManager.*                   # teplotní registry
├── DallasController.*                     # DS18B20 senzory
├── MqttController.*                       # MQTT
├── BleController.*                        # BLE klient
├── WebPortalController.*                  # webová aplikace
├── RelayController.*                       # relé a interlocky
├── InputController.*                      # vstupy a callbacky
├── BuzzerController.*                      # signalizace
├── PressureAlarmController.*               # tlakovou alarmy
├── EventLog.*                             # logování
├── HistoryBuffer.*                         # krátká historie
├── partitions.csv                          # oddíly flash paměti
├── LICENSE                                 # MIT licence
├── README.md                               # dokumentace projektu
├── docs/                                   # dokumentace a screenshoty
├── data/                                   # data web portálu / assety
└── ...
```

## Začínáme

### Požadavky

- ESP32 Arduino core pro ESP32-S3
- Arduino IDE nebo PlatformIO
- správné připojené senzory a relé na desce
- stabilní napájení pro reléové výstupy a čidla
- síťové připojení (Ethernet nebo WiFi)

### Postup flashování

1. Otevřete soubor `ESP32-S3-ETH-8DI-8RO-Controller.ino` v Arduino IDE nebo PlatformIO.
2. Zvolte správnou desku ESP32-S3 a port sériového připojení.
3. Ujistěte se, že jsou nainstalovány všechny závislosti požadované projektem.
4. Flashujte firmware do desky.
5. Po prvním startu zkontrolujte sériový monitor.
6. Pokud je aktivní IN8, firmware spustí WiFiManager portal.

### První start

Po spuštění se inicializují:

- vstupy a relé
- síťové rozhraní
- OpenTherm a BLE moduly
- webový portal
- MQTT a ekvitermní logika
- TUV a směšovací ventil

V sériovém monitoru lze následně používat základní příkazy.

## Konfigurace

### WiFiManager

Po prvním spuštění se zařízení může připojit k WiFi přes konfiguraci. Pokud je aktivní servisní vstup IN8, firmware přejde do konfiguračního portálu pro nastavení připojení.

### Webový portál

Webový portál slouží k:

- přístupu ke stavu topného systému
- zobrazení teplot a veličin
- úpravám základních parametrů
- diagnostice a historii

### Runtime a NVS

Firmware ukládá konfiguraci do NVS / runtime konfigurace, která se používá během provozu. Nejdůležitější parametry se aktualizují v době běhu bez nutnosti opětovného flashování.

## Konzolové příkazy

Firmware podporuje základní ovládací příkazy přes sériový monitor:

```text
HELP
STATE
INPUTS
TEMP
OT
OTSCAN START
OTSCAN ALL
OTSCAN STATUS
OTSCAN STOP
BLE
OTA
EQ
MIX
EQ MODE DAY
EQ MODE NIGHT
EQ MODE AUTO
WIFI PORTAL
R3 ON
R3 OFF
R3 TOGGLE
```

### Význam některých příkazů

- `STATE` – zobrazení stavu relé
- `INPUTS` – raw a logické stavy vstupů
- `TEMP` – přehled teplot pro jednotlivé role
- `OT` – JSON status OpenTherm komunikace
- `BLE` – status BLE klienta
- `OTA` – status OTA režimu
- `EQ` – status ekvitermní logiky
- `MIX` – status směšovacího ventilu

Důležité: relé R1 a R2 jsou vyhrazené pro směšovací ventil. Jejich přímé ovládání přes relé příkazy není doporučeno; použijte nástroje pro ruční řízení ventilu.

## Bezpečnostní poznámky

- Projekt pracuje s relé a topným systémem – vždy dbejte na bezpečné zapojení a ochranu obvodů.
- Přímé ovládání relé R1/R2 je omezeno a je řízeno interlockem směšovacího ventilu.
- Před připojením k kotli nebo zařízení s výkonem zvažte galvanickou izolaci a odporové ochrany.
- Připojení k měřicím a řídicím prvkům provádějte podle konkrétního zařízení a výrobce.
- Firmware je určena pro zkušené konstrukce a servisní techniky.

## Licence

Tento projekt je licencován pod MIT licencí. Podrobnosti najdete v souboru `LICENSE`.

## Shrnutí

Tento firmware je vhodný pro pokročilé domácí či komerční topné systémy, kde je potřeba:

- řídit kotel přes OpenTherm
- pracovat s DS18B20 senzory a ekvitermní logikou
- ovládat mixovací ventil a cirkulaci TUV
- monitorovat a upravovat systém přes webový portál nebo MQTT
- připojit další diagnostiku a senzory přes BLE nebo Ethernet/WiFi

Pokud jste v projektu noví, doporučuje se nejprve ověřit hardware pinout, správně připojit senzory a zkontrolovat sériový monitor po prvním spuštění.

---

Tento README pokrývá základní návrh funkčnosti, architekturu a konfiguraci projektu. Pro produkční nasazení je vhodné doplnit ještě konkrétní schéma zapojení, fotodokumentaci, seznam použitých senzorů a přesnou konfiguraci pro konkrétní typ kotle a topného systému.
