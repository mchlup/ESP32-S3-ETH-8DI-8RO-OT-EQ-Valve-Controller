#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

// Lightweight ESP32 diagnostics. Logging only queues fixed-size records in RAM;
// LittleFS I/O is performed from service(), never from the OT wait loop or ISR.
namespace DeviceDiagnostics {
  enum class Stage : uint8_t {
    None, Serial, Inputs, Relays, Dallas, Network, Http, WebSocket,
    OpenTherm, Ble, History, Temperatures, Ota, Mqtt, Buzzer,
    Pressure, Dhw, Equitherm, Mixing, Diagnostics
  };

  void begin();
  void setStorageAvailable(bool mounted);
  void enqueue(const char* source, const char* event, const char* detail,
               const char* level = "info");
  void startLoop();
  void markStage(Stage stage);
  void endLoop();
  void service();
  void flushNow();

  // status: 0=SUCCESS, 1=TIMEOUT, 2=INVALID.
  void noteOtResponse(uint8_t status);
  void noteOtHardTimeout(uint8_t dataId, uint32_t elapsedMs);
  void noteNetwork(bool wifiUp, bool ethernetUp);
  void noteWebSocketClients(uint8_t clients);

  void fillStatus(JsonObject out);
  const char* logPath(uint8_t part); // 0=current, 1..3=rotated archives
  String readTail(size_t maxBytes = 8192);
  bool clearFiles();
}
