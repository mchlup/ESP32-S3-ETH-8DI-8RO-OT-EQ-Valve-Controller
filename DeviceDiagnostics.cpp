#include "DeviceDiagnostics.h"

#include <Arduino.h>
#include <LittleFS.h>
#include <esp_attr.h>
#include <esp_system.h>
#include <time.h>
#include "EventLog.h"

namespace {
constexpr uint32_t kRtcMagic = 0x54484432UL; // THD2
constexpr size_t kQueueCap = 40;
constexpr size_t kFileLimit = 96U * 1024U;
constexpr size_t kFreeReserve = 96U * 1024U;
constexpr uint32_t kFlushIntervalMs = 2000;
constexpr uint32_t kSlowStageUs = 500000;
constexpr uint32_t kSlowLoopUs = 700000;
const char* const kPaths[] = {
  "/diagnostics/events.jsonl",
  "/diagnostics/events.1.jsonl",
  "/diagnostics/events.2.jsonl",
  "/diagnostics/events.3.jsonl"
};

struct Breadcrumb {
  uint32_t magic = 0;
  uint32_t boot = 0;
  uint32_t atMs = 0;
  uint8_t stage = 0;
  uint8_t reserved[3] = {};
};
RTC_NOINIT_ATTR Breadcrumb g_rtc;

struct JournalEntry {
  uint32_t ms = 0;
  uint32_t epoch = 0;
  uint32_t boot = 0;
  char source[18] = {};
  char event[26] = {};
  char detail[112] = {};
  char level[8] = {};
};

JournalEntry g_queue[kQueueCap] = {};
size_t g_first = 0;
size_t g_queued = 0;
bool g_started = false;
bool g_storageReady = false;
uint32_t g_boot = 1;
uint32_t g_resetReason = 0;
uint8_t g_previousStage = 0;
uint32_t g_previousUptimeMs = 0;
uint32_t g_previousBoot = 0;
uint32_t g_queueDrops = 0;
uint32_t g_fileErrors = 0;
uint32_t g_rotations = 0;
uint32_t g_written = 0;
uint32_t g_nextFsRetryMs = 0;
uint32_t g_lastFlushMs = 0;
uint32_t g_lastHealthMs = 0;
bool g_heapAlarm = false;
uint32_t g_slowestStageUs = 0;
DeviceDiagnostics::Stage g_slowestStage = DeviceDiagnostics::Stage::None;
uint32_t g_stageStartedUs = 0;
DeviceDiagnostics::Stage g_activeStage = DeviceDiagnostics::Stage::None;
uint32_t g_stageSlowCount = 0;
uint32_t g_slowLoopCount = 0;
uint32_t g_maxLoopUs = 0;
uint32_t g_loopStartedUs = 0;
uint32_t g_lastSlowReportMs = 0;
uint32_t g_otOk = 0, g_otTimeout = 0, g_otInvalid = 0, g_otHardTimeout = 0;
uint32_t g_lastOtFailureMs = 0, g_lastOtReportMs = 0;
uint8_t g_otConsecutive = 0;
bool g_otAlarm = false;
uint8_t g_lastOtTimeoutId = 0;
uint32_t g_wsConnects = 0, g_wsDisconnects = 0;
uint8_t g_wsCount = 0, g_wsMaxCount = 0;
bool g_netKnown = false, g_wifiUp = false, g_ethUp = false;

const char* stageName(DeviceDiagnostics::Stage s) {
  switch (s) {
    case DeviceDiagnostics::Stage::Serial: return "serial";
    case DeviceDiagnostics::Stage::Inputs: return "inputs";
    case DeviceDiagnostics::Stage::Relays: return "relays";
    case DeviceDiagnostics::Stage::Dallas: return "dallas";
    case DeviceDiagnostics::Stage::Network: return "network";
    case DeviceDiagnostics::Stage::Http: return "http";
    case DeviceDiagnostics::Stage::WebSocket: return "websocket";
    case DeviceDiagnostics::Stage::OpenTherm: return "opentherm";
    case DeviceDiagnostics::Stage::Ble: return "ble";
    case DeviceDiagnostics::Stage::History: return "history";
    case DeviceDiagnostics::Stage::Temperatures: return "temperatures";
    case DeviceDiagnostics::Stage::Ota: return "ota";
    case DeviceDiagnostics::Stage::Mqtt: return "mqtt";
    case DeviceDiagnostics::Stage::Buzzer: return "buzzer";
    case DeviceDiagnostics::Stage::Pressure: return "pressure";
    case DeviceDiagnostics::Stage::Dhw: return "dhw";
    case DeviceDiagnostics::Stage::Equitherm: return "equitherm";
    case DeviceDiagnostics::Stage::Mixing: return "mixing";
    case DeviceDiagnostics::Stage::Diagnostics: return "diagnostics";
    default: return "none";
  }
}

const char* resetName(uint32_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_EXT: return "external";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "interrupt_wdt";
    case ESP_RST_TASK_WDT: return "task_wdt";
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    default: return "other";
  }
}

void copyText(char* dst, size_t cap, const char* text) {
  if (!cap) return;
  snprintf(dst, cap, "%s", text ? text : "");
}

size_t fileSize(const char* path) {
  if (!g_storageReady || !path || !LittleFS.exists(path)) return 0;
  File file = LittleFS.open(path, "r");
  if (!file) return 0;
  const size_t bytes = file.size();
  file.close();
  return bytes;
}

bool keepFreeSpace() {
  if (!g_storageReady) return false;
  const size_t total = LittleFS.totalBytes();
  size_t used = LittleFS.usedBytes();
  if (!total || used > total) return false;
  // Never delete the active log or other application data to free space.
  // Remove only the oldest journal archives when LittleFS is nearly full.
  for (int part = 3; part >= 1 && total - used < kFreeReserve; --part) {
    if (LittleFS.exists(kPaths[part])) {
      LittleFS.remove(kPaths[part]);
      used = LittleFS.usedBytes();
    }
  }
  return total - used >= kFreeReserve;
}

bool rotateFile() {
  if (LittleFS.exists(kPaths[3]) && !LittleFS.remove(kPaths[3])) return false;
  for (int i = 2; i >= 0; --i) {
    if (!LittleFS.exists(kPaths[i])) continue;
    if (!LittleFS.rename(kPaths[i], kPaths[i + 1])) return false;
  }
  ++g_rotations;
  return true;
}

bool appendBatch(size_t maxRecords) {
  if (!g_storageReady || !g_queued) return false;
  if (!LittleFS.exists("/diagnostics") && !LittleFS.mkdir("/diagnostics")) {
    ++g_fileErrors;
    return false;
  }
  if (!keepFreeSpace()) { ++g_fileErrors; return false; }
  if (fileSize(kPaths[0]) >= kFileLimit && !rotateFile()) {
    ++g_fileErrors;
    return false;
  }
  File file = LittleFS.open(kPaths[0], FILE_APPEND);
  if (!file) { ++g_fileErrors; return false; }
  bool ok = true;
  const size_t count = g_queued < maxRecords ? g_queued : maxRecords;
  for (size_t i = 0; i < count; ++i) {
    const JournalEntry& entry = g_queue[g_first];
    StaticJsonDocument<384> doc;
    doc["boot"] = entry.boot;
    doc["uptimeMs"] = entry.ms;
    if (entry.epoch) doc["epoch"] = entry.epoch;
    else doc["epoch"] = nullptr;
    doc["level"] = entry.level;
    doc["source"] = entry.source;
    doc["event"] = entry.event;
    doc["detail"] = entry.detail;
    char line[384];
    const size_t bytes = serializeJson(doc, line, sizeof(line) - 2);
    if (!bytes || bytes >= sizeof(line) - 2) {
      ++g_fileErrors;
      g_first = (g_first + 1) % kQueueCap;
      --g_queued;
      ++g_queueDrops;
      continue;
    }
    line[bytes] = '\n';
    if (file.write((const uint8_t*)line, bytes + 1) != bytes + 1) {
      ++g_fileErrors;
      ok = false;
      break; // Keep the uncommitted record in RAM for a later attempt.
    }
    g_first = (g_first + 1) % kQueueCap;
    --g_queued;
    ++g_written;
  }
  file.flush();
  file.close();
  if (!ok) g_nextFsRetryMs = millis() + 30000UL;
  return ok;
}

void slowReport(const char* event, const char* what, uint32_t us) {
  const uint32_t now = millis();
  if (g_lastSlowReportMs && (uint32_t)(now - g_lastSlowReportMs) < 30000UL) return;
  g_lastSlowReportMs = now ? now : 1;
  char detail[112];
  snprintf(detail, sizeof(detail), "%s duration_ms=%lu", what,
           (unsigned long)(us / 1000UL));
  EventLog::record("runtime", event, detail, "warn");
}
} // namespace

namespace DeviceDiagnostics {
void begin() {
  if (g_started) return;
  g_started = true;
  g_resetReason = (uint32_t)esp_reset_reason();
  if (g_rtc.magic == kRtcMagic && g_rtc.stage <= (uint8_t)Stage::Diagnostics) {
    g_previousStage = g_rtc.stage;
    g_previousUptimeMs = g_rtc.atMs;
    g_previousBoot = g_rtc.boot;
    g_boot = g_rtc.boot + 1;
    if (!g_boot) g_boot = 1;
  }
  g_rtc.magic = kRtcMagic;
  g_rtc.boot = g_boot;
  g_rtc.stage = (uint8_t)Stage::None;
  g_rtc.atMs = 0;

  char detail[112];
  snprintf(detail, sizeof(detail),
           "reason=%s code=%lu previous_boot=%lu previous_stage=%s previous_uptime_ms=%lu",
           resetName(g_resetReason), (unsigned long)g_resetReason,
           (unsigned long)g_previousBoot, stageName((Stage)g_previousStage),
           (unsigned long)g_previousUptimeMs);
  const bool unexpected = g_resetReason == ESP_RST_PANIC ||
    g_resetReason == ESP_RST_TASK_WDT || g_resetReason == ESP_RST_INT_WDT ||
    g_resetReason == ESP_RST_WDT || g_resetReason == ESP_RST_BROWNOUT;
  EventLog::record("system", "boot", detail, unexpected ? "warn" : "info");
}

void setStorageAvailable(bool mounted) {
  g_storageReady = mounted;
  g_nextFsRetryMs = 0;
  if (!mounted) Serial.println("[DIAG] LittleFS unavailable; keeping only bounded RAM queue");
}

void enqueue(const char* source, const char* event, const char* detail, const char* level) {
  if (!g_started) return;
  if (g_queued == kQueueCap) {
    g_first = (g_first + 1) % kQueueCap;
    --g_queued;
    ++g_queueDrops;
  }
  JournalEntry& e = g_queue[(g_first + g_queued) % kQueueCap];
  e.ms = millis();
  const time_t epoch = time(nullptr);
  e.epoch = epoch > 1672531200 ? (uint32_t)epoch : 0;
  e.boot = g_boot;
  copyText(e.source, sizeof(e.source), source);
  copyText(e.event, sizeof(e.event), event);
  copyText(e.detail, sizeof(e.detail), detail);
  copyText(e.level, sizeof(e.level), level);
  ++g_queued;
}

void startLoop() {
  g_loopStartedUs = micros();
  markStage(Stage::Serial);
}

void markStage(Stage next) {
  const uint32_t nowUs = micros();
  if (g_activeStage != Stage::None && g_stageStartedUs != 0) {
    const uint32_t elapsed = nowUs - g_stageStartedUs;
    if (elapsed > g_slowestStageUs) {
      g_slowestStageUs = elapsed;
      g_slowestStage = g_activeStage;
    }
    if (elapsed >= kSlowStageUs) {
      ++g_stageSlowCount;
      slowReport("slow_stage", stageName(g_activeStage), elapsed);
    }
  }
  g_activeStage = next;
  g_stageStartedUs = nowUs;
  g_rtc.stage = (uint8_t)next; // Last executed stage survives most warm resets.
  g_rtc.atMs = millis();
}

void endLoop() {
  const uint32_t elapsed = micros() - g_loopStartedUs;
  if (elapsed > g_maxLoopUs) g_maxLoopUs = elapsed;
  if (elapsed >= kSlowLoopUs) {
    ++g_slowLoopCount;
    slowReport("slow_loop", "main_loop", elapsed);
  }
}

void noteOtResponse(uint8_t status) {
  if (!g_started) return;
  if (status == 0) {
    ++g_otOk;
    if (g_otAlarm) {
      char detail[112];
      snprintf(detail, sizeof(detail), "recovered after failures; uptime_ms=%lu",
               (unsigned long)millis());
      EventLog::record("opentherm", "link_recovered", detail);
    }
    g_otConsecutive = 0;
    g_otAlarm = false;
    return;
  }
  if (status == 1) ++g_otTimeout;
  else if (status == 2) ++g_otInvalid;
  else return;
  g_lastOtFailureMs = millis();
  if (g_otConsecutive < 255) ++g_otConsecutive;
  const uint32_t now = millis();
  if (g_otConsecutive >= 3 &&
      (!g_otAlarm || (uint32_t)(now - g_lastOtReportMs) >= 60000UL)) {
    g_otAlarm = true;
    g_lastOtReportMs = now;
    char detail[112];
    snprintf(detail, sizeof(detail), "consecutive=%u timeouts=%lu invalid=%lu hard=%lu last_id=%u",
             (unsigned)g_otConsecutive, (unsigned long)g_otTimeout,
             (unsigned long)g_otInvalid, (unsigned long)g_otHardTimeout,
             (unsigned)g_lastOtTimeoutId);
    EventLog::record("opentherm", "communication_errors", detail, "warn");
  }
}

void noteOtHardTimeout(uint8_t dataId, uint32_t elapsedMs) {
  ++g_otHardTimeout;
  g_lastOtTimeoutId = dataId;
  const uint32_t now = millis();
  if (g_otHardTimeout != 1 && (uint32_t)(now - g_lastOtReportMs) < 60000UL) return;
  g_lastOtReportMs = now;
  char detail[112];
  snprintf(detail, sizeof(detail), "id=%u duration_ms=%lu hard_timeouts=%lu",
           (unsigned)dataId, (unsigned long)elapsedMs, (unsigned long)g_otHardTimeout);
  EventLog::record("opentherm", "hard_timeout", detail, "warn");
}

void noteNetwork(bool wifiUp, bool ethernetUp) {
  if (g_netKnown && g_wifiUp == wifiUp && g_ethUp == ethernetUp) return;
  g_netKnown = true;
  g_wifiUp = wifiUp;
  g_ethUp = ethernetUp;
  char detail[64];
  snprintf(detail, sizeof(detail), "wifi=%u ethernet=%u",
           (unsigned)wifiUp, (unsigned)ethernetUp);
  EventLog::record("network", "link_state", detail,
                   (!wifiUp && !ethernetUp) ? "warn" : "info");
}

void noteWebSocketClients(uint8_t clients) {
  if (clients == g_wsCount) return;
  if (clients > g_wsCount) g_wsConnects += clients - g_wsCount;
  else g_wsDisconnects += g_wsCount - clients;
  if (clients > g_wsMaxCount) g_wsMaxCount = clients;
  const bool relevant = (g_wsCount == 0) != (clients == 0);
  g_wsCount = clients;
  if (relevant) {
    char detail[64];
    snprintf(detail, sizeof(detail), "clients=%u connects=%lu disconnects=%lu",
             (unsigned)clients, (unsigned long)g_wsConnects,
             (unsigned long)g_wsDisconnects);
    EventLog::record("websocket", "clients", detail);
  }
}

void service() {
  if (!g_started) return;
  const uint32_t now = millis();
  if (!g_lastHealthMs || (uint32_t)(now - g_lastHealthMs) >= 300000UL) {
    g_lastHealthMs = now ? now : 1;
    const uint32_t heapFree = ESP.getFreeHeap();
    const uint32_t maxAlloc = ESP.getMaxAllocHeap();
    const bool low = heapFree < 32768 || maxAlloc < 16384;
    if (low != g_heapAlarm) {
      g_heapAlarm = low;
      char detail[104];
      snprintf(detail, sizeof(detail), "free=%lu max_alloc=%lu",
               (unsigned long)heapFree, (unsigned long)maxAlloc);
      EventLog::record("memory", low ? "heap_low" : "heap_recovered",
                       detail, low ? "warn" : "info");
    }
    char detail[112];
    snprintf(detail, sizeof(detail),
             "heap=%lu max_alloc=%lu loop_max_ms=%lu slow_loops=%lu ot_to=%lu ws=%u",
             (unsigned long)heapFree, (unsigned long)maxAlloc,
             (unsigned long)(g_maxLoopUs / 1000UL), (unsigned long)g_slowLoopCount,
             (unsigned long)g_otTimeout, (unsigned)g_wsCount);
    EventLog::record("runtime", "heartbeat", detail);
  }

  if (g_storageReady && g_queued &&
      (!g_lastFlushMs || (uint32_t)(now - g_lastFlushMs) >= kFlushIntervalMs) &&
      (!g_nextFsRetryMs || (int32_t)(now - g_nextFsRetryMs) >= 0)) {
    g_lastFlushMs = now ? now : 1;
    if (!appendBatch(8)) g_nextFsRetryMs = now + 30000UL;
    else g_nextFsRetryMs = 0;
  }
}

void flushNow() {
  if (!g_storageReady) return;
  if (g_nextFsRetryMs && (int32_t)(millis() - g_nextFsRetryMs) < 0) return;
  for (unsigned i = 0; g_queued && i < 5; ++i) {
    if (!appendBatch(8)) break;
  }
}

const char* logPath(uint8_t part) {
  return part < sizeof(kPaths) / sizeof(kPaths[0]) ? kPaths[part] : nullptr;
}

String readTail(size_t maxBytes) {
  if (!g_storageReady || !LittleFS.exists(kPaths[0])) return String();
  File file = LittleFS.open(kPaths[0], "r");
  if (!file) return String();
  if (maxBytes > 8192) maxBytes = 8192;
  const size_t size = file.size();
  const size_t start = size > maxBytes ? size - maxBytes : 0;
  if (start) {
    file.seek(start, SeekSet);
    while (file.available()) {
      const int c = file.read();
      if (c < 0 || c == '\n') break;
    }
  }
  String tail;
  if (!tail.reserve(maxBytes + 1)) { file.close(); return String(); }
  char buf[129];
  while (file.available() && tail.length() < maxBytes) {
    size_t wanted = maxBytes - tail.length();
    if (wanted > sizeof(buf) - 1) wanted = sizeof(buf) - 1;
    const size_t got = file.read((uint8_t*)buf, wanted);
    if (!got) break;
    buf[got] = 0;
    tail += buf;
  }
  file.close();
  return tail;
}

bool clearFiles() {
  if (!g_storageReady) return false;
  bool success = true;
  for (const char* path : kPaths) {
    if (LittleFS.exists(path) && !LittleFS.remove(path)) success = false;
  }
  if (success) { g_first = 0; g_queued = 0; g_nextFsRetryMs = 0; }
  return success;
}

void fillStatus(JsonObject out) {
  out["ready"] = g_started;
  out["littlefs"] = g_storageReady;
  out["boot"] = g_boot;
  out["uptimeMs"] = millis();
  out["resetReason"] = resetName(g_resetReason);
  out["resetCode"] = g_resetReason;
  out["previousBoot"] = g_previousBoot;
  out["previousStage"] = stageName((Stage)g_previousStage);
  out["previousUptimeMs"] = g_previousUptimeMs;
  out["currentStage"] = stageName(g_activeStage);
  out["loopMaxMs"] = g_maxLoopUs / 1000UL;
  out["slowLoops"] = g_slowLoopCount;
  out["slowStages"] = g_stageSlowCount;
  out["slowestStage"] = stageName(g_slowestStage);
  out["slowestStageMs"] = g_slowestStageUs / 1000UL;
  out["heapFree"] = (uint32_t)ESP.getFreeHeap();
  out["heapMin"] = (uint32_t)ESP.getMinFreeHeap();
  out["heapMaxAlloc"] = (uint32_t)ESP.getMaxAllocHeap();
  out["psramFree"] = (uint32_t)ESP.getFreePsram();
  out["otOk"] = g_otOk;
  out["otTimeouts"] = g_otTimeout;
  out["otInvalid"] = g_otInvalid;
  out["otHardTimeouts"] = g_otHardTimeout;
  out["otConsecutiveErrors"] = g_otConsecutive;
  out["lastOtFailureMs"] = g_lastOtFailureMs;
  out["lastOtTimeoutId"] = g_lastOtTimeoutId;
  out["wsClients"] = g_wsCount;
  out["wsConnects"] = g_wsConnects;
  out["wsDisconnects"] = g_wsDisconnects;
  out["wsMaxClients"] = g_wsMaxCount;
  out["wifi"] = g_wifiUp;
  out["ethernet"] = g_ethUp;
  out["queuePending"] = (uint32_t)g_queued;
  out["queueDropped"] = g_queueDrops;
  out["fileErrors"] = g_fileErrors;
  out["rotations"] = g_rotations;
  out["recordsWritten"] = g_written;
  JsonArray files = out.createNestedArray("files");
  for (uint8_t i = 0; i < sizeof(kPaths)/sizeof(kPaths[0]); ++i) {
    JsonObject f = files.createNestedObject();
    f["part"] = i;
    f["path"] = kPaths[i];
    f["bytes"] = (uint32_t)fileSize(kPaths[i]);
  }
}
} // namespace DeviceDiagnostics
