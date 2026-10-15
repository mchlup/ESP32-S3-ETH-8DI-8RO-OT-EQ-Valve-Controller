#include "ConfigRuntime.h"

#include <ArduinoJson.h>

#include "BleController.h"
#include "ConfigStore.h"
#include "DallasController.h"
#include "DhwController.h"
#include "EquithermController.h"
#include "MqttController.h"
#include "MixingValveController.h"
#include "NetworkController.h"
#include "OpenThermController.h"
#include "OtaController.h"
#include "PressureAlarmController.h"

namespace {
  String buildOpenThermConfigJson() {
    DynamicJsonDocument doc(2048);
    JsonObject ot = doc.createNestedObject("opentherm");
    ot["enabled"] = ConfigStore::getOtEnabled();
    ot["autoStart"] = ConfigStore::getOtAutoStart();
    ot["pollMs"] = ConfigStore::getOtPollMs();
    ot["bootDelayMs"] = ConfigStore::getOtBootDelayMs();
    const String mode = ConfigStore::getOtMode();
    ot["mode"] = mode;
    ot["allowRawWrite"] = ConfigStore::getOtAllowRawWrite();
    ot["boilerControl"] = mode == "control" ? "opentherm" : "relay";
    // Durable advanced OpenTherm settings are applied before fixed transport
    // and safety fields, so an imported JSON cannot remap Waveshare GPIOs.
    DynamicJsonDocument extra(2048);
    if (!deserializeJson(extra, ConfigStore::getOtAdvancedJson()) && extra.is<JsonObject>()) {
      for (JsonPairConst kv : extra.as<JsonObjectConst>()) {
        const String key(kv.key().c_str());
        if (key != "enabled" && key != "autoStart" && key != "pollMs" &&
            key != "bootDelayMs" && key != "mode" && key != "allowRawWrite" &&
            key != "boilerControl" && key != "rxPin" && key != "txPin" &&
            key != "invertRx" && key != "invertTx" && key != "autoDetectLogic") {
          ot[kv.key()] = kv.value();
        }
      }
    }
    String out;
    serializeJson(doc, out);
    return out;
  }

  String buildBleConfigJson() {
    DynamicJsonDocument doc(256);
    doc["enabled"] = ConfigStore::getBleEnabled();
    doc["namePrefix"] = ConfigStore::getBleNamePrefix();
    doc["scanIntervalMs"] = ConfigStore::getBleScanIntervalMs();
    String out;
    serializeJson(doc, out);
    return out;
  }

  String buildTimeConfigJson() {
    DynamicJsonDocument doc(256);
    JsonObject t = doc.createNestedObject("time");
    t["enabled"] = ConfigStore::getTimeEnabled();
    t["tz"] = ConfigStore::getTimeTz();
    JsonArray ntp = t.createNestedArray("ntp");
    ntp.add(ConfigStore::getTimeNtp1());
    ntp.add(ConfigStore::getTimeNtp2());
    ntp.add(ConfigStore::getTimeNtp3());
    String out;
    serializeJson(doc, out);
    return out;
  }

  String buildOtaConfigJson() {
    DynamicJsonDocument doc(256);
    doc["enabled"] = ConfigStore::getOtaEnabled();
    doc["hostname"] = ConfigStore::getOtaHostname();
    doc["port"] = ConfigStore::getOtaPort();
    doc["password"] = ConfigStore::getOtaPassword();
    String out;
    serializeJson(doc, out);
    return out;
  }
}

namespace ConfigRuntime {
  void loadAllFromStore() {
    ConfigStore::begin();
  }

  void applyAllRuntime() {
    openthermApplyConfig(buildOpenThermConfigJson());
    bleApplyConfig(buildBleConfigJson());
    networkApplyConfig(buildTimeConfigJson());
    otaApplyConfig(buildOtaConfigJson());
    dallasApplyConfig(String("{\"enabled\":") + (ConfigStore::getDallasEnabled() ? "true}" : "false}"));
    equithermReloadFromStore();
    mixingValveReloadFromStore();
    dhwReloadFromStore();
    mqttApplyConfig(String());
    pressureAlarmReloadFromStore();
  }
}
