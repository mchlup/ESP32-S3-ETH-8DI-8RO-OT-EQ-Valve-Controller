#include "Features.h"
#include "EquithermController.h"

#ifndef FEATURE_EQUITHERM
#define FEATURE_EQUITHERM 1
#endif

#if defined(FEATURE_EQUITHERM)

#include <math.h>
#include <time.h>

#include "ConfigStore.h"
#include "InputController.h"
#include "NetworkController.h"
#include "OpenThermController.h"
#include "RelayController.h"
#include "TemperatureManager.h"
#include "WebPortalController.h"
#include "MixingValveController.h"

namespace {
  EquithermConfig s_cfg;
  EquithermStatus s_st;
  bool s_inited = false;
  bool s_externalBlock = false;
  bool s_summerLatched = false;
  uint32_t s_lastComputeMs = 0;
  bool s_forceRecompute = true;

  constexpr uint32_t kComputeIntervalMs = 1000UL;

  inline void clampFloat(float& v, float lo, float hi) {
    if (!isfinite(v)) return;
    if (v < lo) v = lo;
    if (v > hi) v = hi;
  }

  String srcName(TempSource src) {
    switch (src) {
      case TempSource::OpenTherm: return "opentherm";
      case TempSource::Dallas: return "dallas";
      case TempSource::Ble: return "ble";
      default: return "none";
    }
  }

  uint16_t parseHmToMin(const String& text, bool& ok) {
    ok = false;
    const int colon = text.indexOf(':');
    if (colon < 0) return 0;
    const int hh = text.substring(0, colon).toInt();
    const int mm = text.substring(colon + 1).toInt();
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return 0;
    ok = true;
    return (uint16_t)(hh * 60 + mm);
  }

  float linear2(const EquithermCurve& c, float outsideC) {
    const float dx = c.outColdC - c.outWarmC;
    if (fabsf(dx) < 0.001f) return c.flowColdC;
    const float k = (c.flowColdC - c.flowWarmC) / dx;
    return c.flowWarmC + k * (outsideC - c.outWarmC);
  }

  float curve4(const float flow[4], float outsideC) {
    static constexpr float outsidePts[4] = {-20.0f, -10.0f, 0.0f, 10.0f};
    uint8_t lo = 0;
    uint8_t hi = 1;
    if (outsideC >= 10.0f) { lo = 2; hi = 3; }
    else if (outsideC >= 0.0f) { lo = 2; hi = 3; }
    else if (outsideC >= -10.0f) { lo = 1; hi = 2; }
    const float dx = outsidePts[hi] - outsidePts[lo];
    if (fabsf(dx) < 0.001f) return flow[lo];
    const float t = (outsideC - outsidePts[lo]) / dx;
    return flow[lo] + (flow[hi] - flow[lo]) * t;
  }

  float curveTarget(const String& mode, float outsideC) {
    float result = NAN;
    if (s_cfg.curveMode == "tech_i3_4point") {
      result = curve4(mode == "night" ? s_cfg.night4FlowC : s_cfg.day4FlowC, outsideC);
    } else {
      result = linear2(mode == "night" ? s_cfg.night : s_cfg.day, outsideC);
    }
    clampFloat(result, s_cfg.minFlowC, s_cfg.maxFlowC);
    return result;
  }

  bool getLocalTimeParts(struct tm& outTm) {
    outTm = {};
    if (!networkIsTimeValid()) return false;
    const time_t now = (time_t)networkGetTimeEpoch();
    if (now <= (time_t)1672531200) return false;
    localtime_r(&now, &outTm);
    return true;
  }

  int localWeekdayIndex(const struct tm& tmv) {
    int idx = tmv.tm_wday == 0 ? 6 : tmv.tm_wday - 1;
    if (idx < 0) idx = 0;
    if (idx > 6) idx = 6;
    return idx;
  }

  bool comfortByDay(int dayIdx, uint16_t nowMin, bool carryOnly) {
    if (dayIdx < 0 || dayIdx > 6) return false;
    const uint8_t count = s_cfg.intervalCount[dayIdx] > HEATING_MAX_INTERVALS_PER_DAY
      ? HEATING_MAX_INTERVALS_PER_DAY : s_cfg.intervalCount[dayIdx];

    for (uint8_t i = 0; i < count; ++i) {
      const uint16_t start = s_cfg.intervals[dayIdx][i].startMin;
      const uint16_t end = s_cfg.intervals[dayIdx][i].endMin;
      if (start == end) continue;
      if (start < end) {
        if (!carryOnly && nowMin >= start && nowMin < end) return true;
      } else {
        if (!carryOnly && nowMin >= start) return true;
        if (carryOnly && nowMin < end) return true;
      }
    }
    return false;
  }

  bool isNightBySchedule(bool& used, String& outIso) {
    used = false;
    outIso = networkGetTimeIso();
    if (!s_cfg.scheduleEnabled) return false;

    struct tm tmv;
    if (!getLocalTimeParts(tmv)) return false;
    const int day = localWeekdayIndex(tmv);
    const int previous = (day + 6) % 7;
    const uint16_t nowMin = (uint16_t)(tmv.tm_hour * 60 + tmv.tm_min);
    const bool comfort = comfortByDay(day, nowMin, false) || comfortByDay(previous, nowMin, true);
    used = true;
    return !comfort;
  }

  String effectiveMode(bool& scheduleUsed, bool& in1Forced, bool& timeValid, String& timeIso) {
    scheduleUsed = false;
    in1Forced = false;
    timeValid = networkIsTimeValid();
    timeIso = networkGetTimeIso();

    if (s_cfg.mode == "day") return "day";
    if (s_cfg.mode == "night") return "night";

    if (s_cfg.useIn1NightOverride && inputGetState(InputId::IN1)) {
      in1Forced = true;
      return "night";
    }

    bool used = false;
    String iso;
    const bool night = isNightBySchedule(used, iso);
    if (used) {
      scheduleUsed = true;
      if (iso.length()) timeIso = iso;
      return night ? "night" : "day";
    }
    return "day";
  }

  bool isSummerActive(float outsideC) {
    if (!s_cfg.summerModeEnabled || !isfinite(outsideC)) {
      s_summerLatched = false;
      return false;
    }
    if (!s_summerLatched && outsideC >= s_cfg.summerOffAboveC) s_summerLatched = true;
    else if (s_summerLatched && outsideC <= s_cfg.summerOnBelowC) s_summerLatched = false;
    return s_summerLatched;
  }

  void driveNightRelay(const String& mode) {
    if (!s_cfg.driveNightRelay || s_cfg.nightRelayIndex > 7) return;
    const bool night = mode == "night";
    relaySet((RelayId)s_cfg.nightRelayIndex, s_cfg.nightRelayOnWhenNight ? night : !night);
  }

  void clearNightRelayToDay() {
    if (!s_cfg.driveNightRelay || s_cfg.nightRelayIndex > 7) return;
    relaySet((RelayId)s_cfg.nightRelayIndex, s_cfg.nightRelayOnWhenNight ? false : true);
  }

  void loadAdvancedCurveFromStore() {
    const String raw = ConfigStore::getEqMixAdvancedJson();
    if (!raw.length() || raw == "{}") return;
    DynamicJsonDocument doc(8192);
    if (deserializeJson(doc, raw) || !doc.is<JsonObject>()) return;
    JsonObjectConst root = doc.as<JsonObjectConst>();

    if (root.containsKey("curveMode")) {
      s_cfg.curveMode = String((const char*)(root["curveMode"] | "linear2"));
    }
    if (root["weather4"].is<JsonObjectConst>()) {
      JsonObjectConst w = root["weather4"].as<JsonObjectConst>();
      if (w["day"].is<JsonArrayConst>()) {
        JsonArrayConst a = w["day"].as<JsonArrayConst>();
        for (uint8_t i = 0; i < 4 && i < a.size(); ++i) s_cfg.day4FlowC[i] = a[i].as<float>();
      }
      if (w["night"].is<JsonArrayConst>()) {
        JsonArrayConst a = w["night"].as<JsonArrayConst>();
        for (uint8_t i = 0; i < 4 && i < a.size(); ++i) s_cfg.night4FlowC[i] = a[i].as<float>();
      }
    }
  }

  void saveAdvancedCurveToStore(const String* curveMode, JsonObjectConst weather4) {
    // Rewrite the shared advanced document in the new compact schema. Preserve
    // only newMix from MixingValveController; all former TECH-i3 regulator
    // fields are intentionally discarded.
    DynamicJsonDocument oldDoc(8192);
    const String old = ConfigStore::getEqMixAdvancedJson();
    if (old.length() && old != "{}") deserializeJson(oldDoc, old);
    JsonObjectConst oldRoot = oldDoc.is<JsonObject>() ? oldDoc.as<JsonObjectConst>() : JsonObjectConst();

    DynamicJsonDocument doc(8192);
    JsonObject root = doc.to<JsonObject>();

    String effectiveMode = s_cfg.curveMode;
    if (!oldRoot.isNull() && oldRoot.containsKey("curveMode")) {
      effectiveMode = String((const char*)(oldRoot["curveMode"] | effectiveMode.c_str()));
    }
    if (curveMode) effectiveMode = *curveMode;
    effectiveMode.trim(); effectiveMode.toLowerCase();
    if (effectiveMode != "tech_i3_4point") effectiveMode = "linear2";
    root["curveMode"] = effectiveMode;

    JsonObject dstW = root.createNestedObject("weather4");
    auto copy4 = [&](const char* key, JsonArrayConst replacement, const float fallback[4]) {
      JsonArray out = dstW.createNestedArray(key);
      if (!replacement.isNull()) {
        for (uint8_t i = 0; i < 4; ++i) {
          out.add(i < replacement.size() ? replacement[i].as<float>() : fallback[i]);
        }
        return;
      }
      if (!oldRoot.isNull() && oldRoot["weather4"].is<JsonObjectConst>()) {
        JsonObjectConst oldW = oldRoot["weather4"].as<JsonObjectConst>();
        if (oldW[key].is<JsonArrayConst>()) {
          JsonArrayConst a = oldW[key].as<JsonArrayConst>();
          for (uint8_t i = 0; i < 4; ++i) out.add(i < a.size() ? a[i].as<float>() : fallback[i]);
          return;
        }
      }
      for (uint8_t i = 0; i < 4; ++i) out.add(fallback[i]);
    };

    JsonArrayConst dayReplacement;
    JsonArrayConst nightReplacement;
    if (!weather4.isNull()) {
      if (weather4["day"].is<JsonArrayConst>()) dayReplacement = weather4["day"].as<JsonArrayConst>();
      if (weather4["night"].is<JsonArrayConst>()) nightReplacement = weather4["night"].as<JsonArrayConst>();
    }
    copy4("day", dayReplacement, s_cfg.day4FlowC);
    copy4("night", nightReplacement, s_cfg.night4FlowC);

    if (!oldRoot.isNull() && oldRoot["newMix"].is<JsonObjectConst>()) {
      JsonObject dst = root.createNestedObject("newMix");
      JsonObjectConst src = oldRoot["newMix"].as<JsonObjectConst>();
      for (JsonPairConst kv : src) dst[kv.key()] = kv.value();
    }

    String out;
    serializeJson(root, out);
    ConfigStore::setEqMixAdvancedJson(out);
  }


  void loadFromStore() {
    s_cfg = EquithermConfig{};
    s_cfg.enabled = ConfigStore::getEqEnabled();
    s_cfg.mode = ConfigStore::getEqMode();
    s_cfg.useIn1NightOverride = ConfigStore::getEqUseIn1NightOverride();
    s_cfg.summerModeEnabled = ConfigStore::getEqSummerModeEnabled();
    s_cfg.summerOffAboveC = ConfigStore::getEqSummerOffAboveC();
    s_cfg.summerOnBelowC = ConfigStore::getEqSummerOnBelowC();
    s_cfg.scheduleEnabled = ConfigStore::getEqScheduleEnabled();

    uint8_t counts[7] = {};
    uint16_t starts[7][HEATING_MAX_INTERVALS_PER_DAY] = {};
    uint16_t ends[7][HEATING_MAX_INTERVALS_PER_DAY] = {};
    ConfigStore::getEqScheduleIntervals(counts, starts, ends);
    for (uint8_t d = 0; d < 7; ++d) {
      s_cfg.intervalCount[d] = counts[d] > HEATING_MAX_INTERVALS_PER_DAY ? HEATING_MAX_INTERVALS_PER_DAY : counts[d];
      for (uint8_t i = 0; i < HEATING_MAX_INTERVALS_PER_DAY; ++i) {
        s_cfg.intervals[d][i].startMin = starts[d][i];
        s_cfg.intervals[d][i].endMin = ends[d][i];
      }
    }

    s_cfg.day.outColdC = ConfigStore::getEqDayOutColdC();
    s_cfg.day.flowColdC = ConfigStore::getEqDayFlowColdC();
    s_cfg.day.outWarmC = ConfigStore::getEqDayOutWarmC();
    s_cfg.day.flowWarmC = ConfigStore::getEqDayFlowWarmC();
    s_cfg.night.outColdC = ConfigStore::getEqNightOutColdC();
    s_cfg.night.flowColdC = ConfigStore::getEqNightFlowColdC();
    s_cfg.night.outWarmC = ConfigStore::getEqNightOutWarmC();
    s_cfg.night.flowWarmC = ConfigStore::getEqNightFlowWarmC();

    s_cfg.minFlowC = ConfigStore::getEqMinFlowC();
    s_cfg.maxFlowC = ConfigStore::getEqMaxFlowC();
    s_cfg.minChSetpointC = ConfigStore::getEqMinChSetpointC();
    s_cfg.maxChSetpointC = ConfigStore::getEqMaxChSetpointC();
    s_cfg.tempMaxAgeMs = ConfigStore::getEqTempMaxAgeMs();
    s_cfg.minSendIntervalMs = ConfigStore::getEqMinSendIntervalMs();
    s_cfg.minSendDeltaC = ConfigStore::getEqMinSendDeltaC();
    s_cfg.useOpenTherm = ConfigStore::getEqUseOpenTherm();
    s_cfg.applyBoilerMaxCh = ConfigStore::getEqApplyBoilerMaxCh();
    s_cfg.boilerMaxChC = ConfigStore::getEqBoilerMaxChC();
    s_cfg.driveNightRelay = ConfigStore::getEqDriveNightRelay();
    s_cfg.nightRelayIndex = ConfigStore::getEqNightRelayIndex();
    s_cfg.nightRelayOnWhenNight = ConfigStore::getEqNightRelayOnWhenNight();
    s_cfg.boilerAssistEnabled = ConfigStore::getEqBoilerAssistEnabled();
    s_cfg.boilerAssistDeltaC = ConfigStore::getEqBoilerAssistDeltaC();
    s_cfg.boilerAssistForceChEnable = ConfigStore::getEqBoilerAssistForceChEnable();

    loadAdvancedCurveFromStore();

    s_cfg.mode.trim(); s_cfg.mode.toLowerCase();
    if (s_cfg.mode != "auto" && s_cfg.mode != "day" && s_cfg.mode != "night") s_cfg.mode = "auto";
    s_cfg.curveMode.trim(); s_cfg.curveMode.toLowerCase();
    if (s_cfg.curveMode != "linear2" && s_cfg.curveMode != "tech_i3_4point") s_cfg.curveMode = "linear2";
    if (s_cfg.summerOnBelowC > s_cfg.summerOffAboveC) {
      const float tmp = s_cfg.summerOnBelowC;
      s_cfg.summerOnBelowC = s_cfg.summerOffAboveC;
      s_cfg.summerOffAboveC = tmp;
    }
    clampFloat(s_cfg.minFlowC, 10.0f, 90.0f);
    clampFloat(s_cfg.maxFlowC, 10.0f, 90.0f);
    if (s_cfg.minFlowC > s_cfg.maxFlowC) {
      const float t = s_cfg.minFlowC; s_cfg.minFlowC = s_cfg.maxFlowC; s_cfg.maxFlowC = t;
    }
    clampFloat(s_cfg.minChSetpointC, 10.0f, 90.0f);
    clampFloat(s_cfg.maxChSetpointC, 10.0f, 90.0f);
    if (s_cfg.minChSetpointC > s_cfg.maxChSetpointC) {
      const float t = s_cfg.minChSetpointC; s_cfg.minChSetpointC = s_cfg.maxChSetpointC; s_cfg.maxChSetpointC = t;
    }
    for (uint8_t i = 0; i < 4; ++i) {
      clampFloat(s_cfg.day4FlowC[i], 10.0f, 90.0f);
      clampFloat(s_cfg.night4FlowC[i], 10.0f, 90.0f);
    }
  }

  void ensureOpenThermControlMode() {
    if (!s_cfg.enabled || !s_cfg.useOpenTherm) return;
    if (!ConfigStore::getOtEnabled()) ConfigStore::setOtEnabled(true);
    if (!ConfigStore::getOtAutoStart()) ConfigStore::setOtAutoStart(true);
    if (ConfigStore::getOtMode() == "readOnly") ConfigStore::setOtMode("control");

    DynamicJsonDocument wrap(256);
    JsonObject ot = wrap.createNestedObject("opentherm");
    ot["enabled"] = true;
    ot["autoStart"] = true;
    ot["mode"] = "control";
    ot["boilerControl"] = "opentherm";
    String json;
    serializeJson(wrap, json);
    openthermApplyConfig(json);
  }

  bool setBoilerMaxIfNeeded(float requestedC, String& outErr) {
    outErr = "";
    if (!s_cfg.applyBoilerMaxCh || !isfinite(requestedC)) return true;

    static uint32_t lastTryMs = 0;
    const uint32_t now = millis();
    if (lastTryMs && (uint32_t)(now - lastTryMs) < 60000UL) return true;
    lastTryMs = now;

    OpenThermStatusSnapshot ot = openthermGetStatus();
    float desired = requestedC;
    if (isfinite(ot.maxChBoundMinC)) desired = fmaxf(desired, ot.maxChBoundMinC);
    if (isfinite(ot.maxChBoundMaxC)) desired = fminf(desired, ot.maxChBoundMaxC);
    if (isfinite(ot.maxChSetpointC) && ot.maxChSetpointC + 0.25f >= desired) return true;
    return openthermSetMaxChSetpointC(desired, outErr);
  }

  bool publishHeatingRequest(float targetC, String& outErr) {
    outErr = "";
    OpenThermSourceRequest req;
    req.active = true;
    req.chSetpointSet = true;
    req.chSetpointC = targetC;
    return openthermSetEquithermRequest(req, outErr);
  }

  void compute(bool forceSend) {
    s_st.enabled = s_cfg.enabled;
    s_st.modeReq = s_cfg.mode;
    s_st.externalBlocked = s_externalBlock;
    s_st.in1Active = inputGetState(InputId::IN1);

    bool scheduleUsed = false;
    bool in1Forced = false;
    bool timeValid = false;
    String timeIso;
    const String mode = effectiveMode(scheduleUsed, in1Forced, timeValid, timeIso);
    s_st.modeEff = mode;
    s_st.scheduleUsed = scheduleUsed;
    s_st.in1ForcingNight = in1Forced;
    s_st.timeValid = timeValid;
    s_st.timeIso = timeIso;

    const TempValue outside = TemperatureManager::get(TempRole::Outside, s_cfg.tempMaxAgeMs);
    const bool outsideOk = outside.valid && isfinite(outside.c);
    s_st.outsideC = outsideOk ? outside.c : NAN;
    s_st.outsideAgeMs = outsideOk ? outside.ageMs : 0;
    s_st.outsideSrc = outsideOk ? srcName(outside.src) : "none";

    const TempValue flow = TemperatureManager::get(TempRole::Flow, s_cfg.tempMaxAgeMs);
    const bool flowOk = flow.valid && isfinite(flow.c);
    s_st.flowC = flowOk ? flow.c : NAN;
    s_st.flowAgeMs = flowOk ? flow.ageMs : 0;
    s_st.flowSrc = flowOk ? srcName(flow.src) : "none";

    if (!outsideOk) {
      s_st.targetBaseFlowC = NAN;
      s_st.targetFlowC = NAN;
      s_st.boilerSetpointC = NAN;
      s_st.active = false;
      s_st.summerActive = false;
      s_st.reason = "outside_temp_missing";
      if (s_cfg.enabled) openthermClearEquithermRequest();
      return;
    }

    const float baseTarget = curveTarget(mode, outside.c);
    s_st.targetBaseFlowC = baseTarget;
    s_st.targetFlowC = baseTarget;
    s_st.summerActive = isSummerActive(outside.c);

    if (!s_cfg.enabled) {
      s_st.active = false;
      s_st.reason = "disabled";
      s_st.boilerSetpointC = NAN;
      openthermClearEquithermRequest();
      clearNightRelayToDay();
      return;
    }

    if (s_externalBlock) {
      s_st.active = false;
      s_st.reason = "external_block";
      s_st.boilerSetpointC = NAN;
      openthermClearEquithermRequest();
      clearNightRelayToDay();
      return;
    }

    if (s_st.summerActive) {
      s_st.active = false;
      s_st.reason = "summer_mode";
      s_st.boilerSetpointC = NAN;
      openthermClearEquithermRequest();
      clearNightRelayToDay();
      return;
    }

    driveNightRelay(mode);

    if (!s_cfg.useOpenTherm) {
      s_st.active = true;
      s_st.reason = "target_only";
      s_st.boilerSetpointC = NAN;
      openthermClearEquithermRequest();
      return;
    }

    OpenThermStatusSnapshot ot = openthermGetStatus();
    s_st.boilerMaxChC = ot.maxChSetpointC;
    s_st.boilerMaxBoundMinC = ot.maxChBoundMinC;
    s_st.boilerMaxBoundMaxC = ot.maxChBoundMaxC;

    if (!(ot.present && ot.ready && ot.lastUpdateMs != 0)) {
      s_st.active = false;
      s_st.reason = "opentherm_not_ready";
      s_st.boilerSetpointC = NAN;
      openthermClearEquithermRequest();
      return;
    }

    float clampMin = s_cfg.minFlowC;
    float clampMax = s_cfg.maxFlowC;
    if (isfinite(ot.maxChSetpointC)) clampMax = fminf(clampMax, ot.maxChSetpointC);
    if (s_cfg.applyBoilerMaxCh && isfinite(s_cfg.boilerMaxChC)) clampMax = fminf(clampMax, s_cfg.boilerMaxChC);
    if (clampMin > clampMax) clampMin = clampMax;
    s_st.boilerClampMinC = clampMin;
    s_st.boilerClampMaxC = clampMax;

    float boilerTarget = baseTarget;
    clampFloat(boilerTarget, clampMin, clampMax);
    s_st.boilerSetpointC = boilerTarget;
    s_st.active = true;

    const uint32_t now = millis();
    const bool intervalOk = !s_st.lastSendMs || (uint32_t)(now - s_st.lastSendMs) >= s_cfg.minSendIntervalMs;
    const bool deltaOk = !isfinite(s_st.lastSentChC) || fabsf(boilerTarget - s_st.lastSentChC) >= s_cfg.minSendDeltaC;
    if (!forceSend && !intervalOk) {
      s_st.reason = "hold_interval";
      return;
    }
    if (!forceSend && !deltaOk) {
      s_st.reason = "hold_delta";
      return;
    }

    String maxErr;
    if (s_cfg.applyBoilerMaxCh) setBoilerMaxIfNeeded(s_cfg.boilerMaxChC, maxErr);

    String err;
    const bool ok = publishHeatingRequest(boilerTarget, err);
    s_st.lastSendOk = ok;
    s_st.lastSendErr = ok ? maxErr : err;
    if (ok) {
      s_st.lastSentChC = boilerTarget;
      s_st.lastSendMs = now;
      s_st.reason = "sent";
    } else {
      s_st.reason = "send_failed";
    }
  }

  void fillConfigJson(JsonObject out) {
    out["enabled"] = s_cfg.enabled;
    out["mode"] = s_cfg.mode;
    out["useIn1NightOverride"] = s_cfg.useIn1NightOverride;
    out["summerModeEnabled"] = s_cfg.summerModeEnabled;
    out["summerOffAboveC"] = s_cfg.summerOffAboveC;
    out["summerOnBelowC"] = s_cfg.summerOnBelowC;
    out["curveMode"] = s_cfg.curveMode;

    JsonObject schedule = out.createNestedObject("schedule");
    schedule["enabled"] = s_cfg.scheduleEnabled;
    JsonArray week = schedule.createNestedArray("week");
    static const char* dayNames[7] = {"mon","tue","wed","thu","fri","sat","sun"};
    for (uint8_t d = 0; d < 7; ++d) {
      JsonObject day = week.createNestedObject();
      day["day"] = dayNames[d];
      day["intervalCount"] = s_cfg.intervalCount[d];
      JsonArray intervals = day.createNestedArray("intervals");
      for (uint8_t i = 0; i < s_cfg.intervalCount[d] && i < HEATING_MAX_INTERVALS_PER_DAY; ++i) {
        JsonObject iv = intervals.createNestedObject();
        iv["startMin"] = s_cfg.intervals[d][i].startMin;
        iv["endMin"] = s_cfg.intervals[d][i].endMin;
      }
    }

    JsonObject day = out.createNestedObject("day");
    day["outColdC"] = s_cfg.day.outColdC;
    day["flowColdC"] = s_cfg.day.flowColdC;
    day["outWarmC"] = s_cfg.day.outWarmC;
    day["flowWarmC"] = s_cfg.day.flowWarmC;
    JsonObject night = out.createNestedObject("night");
    night["outColdC"] = s_cfg.night.outColdC;
    night["flowColdC"] = s_cfg.night.flowColdC;
    night["outWarmC"] = s_cfg.night.outWarmC;
    night["flowWarmC"] = s_cfg.night.flowWarmC;

    JsonObject weather4 = out.createNestedObject("weather4");
    JsonArray outsidePts = weather4.createNestedArray("outsideC");
    outsidePts.add(-20); outsidePts.add(-10); outsidePts.add(0); outsidePts.add(10);
    JsonArray day4 = weather4.createNestedArray("day");
    JsonArray night4 = weather4.createNestedArray("night");
    for (uint8_t i = 0; i < 4; ++i) { day4.add(s_cfg.day4FlowC[i]); night4.add(s_cfg.night4FlowC[i]); }

    JsonObject limits = out.createNestedObject("limits");
    limits["minFlowC"] = s_cfg.minFlowC;
    limits["maxFlowC"] = s_cfg.maxFlowC;
    limits["minChSetpointC"] = s_cfg.minChSetpointC;
    limits["maxChSetpointC"] = s_cfg.maxChSetpointC;

    JsonObject temps = out.createNestedObject("temps");
    temps["maxAgeMs"] = (uint32_t)s_cfg.tempMaxAgeMs;
    JsonObject send = out.createNestedObject("send");
    send["minIntervalMs"] = (uint32_t)s_cfg.minSendIntervalMs;
    send["minDeltaC"] = s_cfg.minSendDeltaC;

    JsonObject output = out.createNestedObject("output");
    output["useOpenTherm"] = s_cfg.useOpenTherm;
    output["applyBoilerMaxCh"] = s_cfg.applyBoilerMaxCh;
    output["boilerMaxChC"] = s_cfg.boilerMaxChC;
    output["driveNightRelay"] = s_cfg.driveNightRelay;
    output["nightRelay"] = (uint32_t)(s_cfg.nightRelayIndex + 1);
    output["nightRelayOnWhenNight"] = s_cfg.nightRelayOnWhenNight;

    JsonObject ba = out.createNestedObject("boilerAssist");
    ba["enabled"] = s_cfg.boilerAssistEnabled;
    ba["deltaC"] = s_cfg.boilerAssistDeltaC;
    ba["forceChEnable"] = s_cfg.boilerAssistForceChEnable;
  }

  void fillStatusJson(JsonObject out) {
    out["enabled"] = s_st.enabled;
    out["active"] = s_st.active;
    out["externalBlocked"] = s_st.externalBlocked;
    out["reason"] = s_st.reason;

    JsonObject mode = out.createNestedObject("mode");
    mode["requested"] = s_st.modeReq;
    mode["effective"] = s_st.modeEff;
    mode["scheduleUsed"] = s_st.scheduleUsed;
    mode["in1Active"] = s_st.in1Active;
    mode["in1ForcingNight"] = s_st.in1ForcingNight;
    mode["summerActive"] = s_st.summerActive;

    JsonObject temps = out.createNestedObject("temps");
    if (isfinite(s_st.outsideC)) temps["outsideC"] = s_st.outsideC; else temps["outsideC"] = nullptr;
    temps["outsideAgeMs"] = (uint32_t)s_st.outsideAgeMs;
    temps["outsideSrc"] = s_st.outsideSrc;
    if (isfinite(s_st.flowC)) temps["flowC"] = s_st.flowC; else temps["flowC"] = nullptr;
    temps["flowAgeMs"] = (uint32_t)s_st.flowAgeMs;
    temps["flowSrc"] = s_st.flowSrc;

    JsonObject targets = out.createNestedObject("targets");
    if (isfinite(s_st.targetBaseFlowC)) targets["baseFlowC"] = s_st.targetBaseFlowC; else targets["baseFlowC"] = nullptr;
    if (isfinite(s_st.targetFlowC)) targets["flowC"] = s_st.targetFlowC; else targets["flowC"] = nullptr;
    if (isfinite(s_st.boilerSetpointC)) targets["boilerC"] = s_st.boilerSetpointC; else targets["boilerC"] = nullptr;

    JsonObject last = out.createNestedObject("lastSend");
    if (isfinite(s_st.lastSentChC)) last["chC"] = s_st.lastSentChC; else last["chC"] = nullptr;
    last["ok"] = s_st.lastSendOk;
    last["err"] = s_st.lastSendErr;
    last["ms"] = (uint32_t)s_st.lastSendMs;

    JsonObject boiler = out.createNestedObject("boiler");
    if (isfinite(s_st.boilerMaxChC)) boiler["maxChC"] = s_st.boilerMaxChC; else boiler["maxChC"] = nullptr;
    if (isfinite(s_st.boilerMaxBoundMinC)) boiler["boundMinC"] = s_st.boilerMaxBoundMinC; else boiler["boundMinC"] = nullptr;
    if (isfinite(s_st.boilerMaxBoundMaxC)) boiler["boundMaxC"] = s_st.boilerMaxBoundMaxC; else boiler["boundMaxC"] = nullptr;
    if (isfinite(s_st.boilerClampMinC)) boiler["clampMinC"] = s_st.boilerClampMinC; else boiler["clampMinC"] = nullptr;
    if (isfinite(s_st.boilerClampMaxC)) boiler["clampMaxC"] = s_st.boilerClampMaxC; else boiler["clampMaxC"] = nullptr;

    JsonObject time = out.createNestedObject("time");
    time["valid"] = s_st.timeValid;
    if (s_st.timeIso.length()) time["iso"] = s_st.timeIso; else time["iso"] = nullptr;
  }

  void applyConfigObject(JsonObjectConst root) {
    ConfigStore::BatchGuard batch;

    if (root.containsKey("enabled")) ConfigStore::setEqEnabled((bool)(root["enabled"] | false));
    if (root.containsKey("mode")) {
      String m = String((const char*)(root["mode"] | "auto")); m.trim(); m.toLowerCase();
      if (m == "auto" || m == "day" || m == "night") ConfigStore::setEqMode(m);
    }
    if (root.containsKey("useIn1NightOverride")) ConfigStore::setEqUseIn1NightOverride((bool)(root["useIn1NightOverride"] | true));
    if (root.containsKey("summerModeEnabled")) ConfigStore::setEqSummerModeEnabled((bool)(root["summerModeEnabled"] | false));
    if (root.containsKey("summerOffAboveC")) ConfigStore::setEqSummerOffAboveC(root["summerOffAboveC"].as<float>());
    if (root.containsKey("summerOnBelowC")) ConfigStore::setEqSummerOnBelowC(root["summerOnBelowC"].as<float>());

    if (root["schedule"].is<JsonObjectConst>()) {
      JsonObjectConst schedule = root["schedule"].as<JsonObjectConst>();
      if (schedule.containsKey("enabled")) ConfigStore::setEqScheduleEnabled((bool)(schedule["enabled"] | false));
      if (schedule["week"].is<JsonArrayConst>()) {
        uint8_t counts[7] = {};
        uint16_t starts[7][HEATING_MAX_INTERVALS_PER_DAY] = {};
        uint16_t ends[7][HEATING_MAX_INTERVALS_PER_DAY] = {};
        ConfigStore::getEqScheduleIntervals(counts, starts, ends);

        JsonArrayConst week = schedule["week"].as<JsonArrayConst>();
        uint8_t d = 0;
        for (JsonVariantConst item : week) {
          if (d >= 7) break;
          if (!item.is<JsonObjectConst>()) { ++d; continue; }
          JsonObjectConst day = item.as<JsonObjectConst>();
          if (day["intervals"].is<JsonArrayConst>()) {
            uint8_t count = 0;
            for (JsonVariantConst ivv : day["intervals"].as<JsonArrayConst>()) {
              if (count >= HEATING_MAX_INTERVALS_PER_DAY || !ivv.is<JsonObjectConst>()) break;
              JsonObjectConst iv = ivv.as<JsonObjectConst>();
              uint16_t start = 0, end = 0;
              bool okStart = false, okEnd = false;
              if (iv.containsKey("startMin")) { start = (uint16_t)(iv["startMin"] | 0); okStart = true; }
              if (iv.containsKey("endMin")) { end = (uint16_t)(iv["endMin"] | 0); okEnd = true; }
              if (iv.containsKey("start")) { bool ok = false; uint16_t v = parseHmToMin(String((const char*)(iv["start"] | "")), ok); if (ok) { start = v; okStart = true; } }
              if (iv.containsKey("end")) { bool ok = false; uint16_t v = parseHmToMin(String((const char*)(iv["end"] | "")), ok); if (ok) { end = v; okEnd = true; } }
              if (okStart && okEnd && start != end) { starts[d][count] = start; ends[d][count] = end; ++count; }
            }
            counts[d] = count;
          }
          ++d;
        }
        ConfigStore::setEqScheduleIntervals(counts, starts, ends);
      }
    }

    auto applyCurve = [&](const char* key, bool night) {
      if (!root[key].is<JsonObjectConst>()) return;
      JsonObjectConst c = root[key].as<JsonObjectConst>();
      const EquithermCurve current = night ? s_cfg.night : s_cfg.day;
      const float oc = c.containsKey("outColdC") ? c["outColdC"].as<float>() : current.outColdC;
      const float fc = c.containsKey("flowColdC") ? c["flowColdC"].as<float>() : current.flowColdC;
      const float ow = c.containsKey("outWarmC") ? c["outWarmC"].as<float>() : current.outWarmC;
      const float fw = c.containsKey("flowWarmC") ? c["flowWarmC"].as<float>() : current.flowWarmC;
      if (night) ConfigStore::setEqNightCurve(oc, fc, ow, fw);
      else ConfigStore::setEqDayCurve(oc, fc, ow, fw);
    };
    applyCurve("day", false);
    applyCurve("night", true);

    if (root["limits"].is<JsonObjectConst>()) {
      JsonObjectConst l = root["limits"].as<JsonObjectConst>();
      float minF = l.containsKey("minFlowC") ? l["minFlowC"].as<float>() : s_cfg.minFlowC;
      float maxF = l.containsKey("maxFlowC") ? l["maxFlowC"].as<float>() : s_cfg.maxFlowC;
      ConfigStore::setEqFlowLimits(minF, maxF);
      float minC = l.containsKey("minChSetpointC") ? l["minChSetpointC"].as<float>() : minF;
      float maxC = l.containsKey("maxChSetpointC") ? l["maxChSetpointC"].as<float>() : maxF;
      ConfigStore::setEqChSetpointLimits(minC, maxC);
    }

    if (root["temps"].is<JsonObjectConst>()) {
      JsonObjectConst t = root["temps"].as<JsonObjectConst>();
      if (t.containsKey("maxAgeMs")) ConfigStore::setEqTempMaxAgeMs((uint32_t)(t["maxAgeMs"] | s_cfg.tempMaxAgeMs));
    }
    if (root["send"].is<JsonObjectConst>()) {
      JsonObjectConst send = root["send"].as<JsonObjectConst>();
      if (send.containsKey("minIntervalMs")) ConfigStore::setEqMinSendIntervalMs((uint32_t)(send["minIntervalMs"] | s_cfg.minSendIntervalMs));
      if (send.containsKey("minDeltaC")) ConfigStore::setEqMinSendDeltaC(send["minDeltaC"].as<float>());
    }
    if (root["output"].is<JsonObjectConst>()) {
      JsonObjectConst o = root["output"].as<JsonObjectConst>();
      if (o.containsKey("useOpenTherm")) ConfigStore::setEqUseOpenTherm((bool)(o["useOpenTherm"] | true));
      if (o.containsKey("applyBoilerMaxCh")) ConfigStore::setEqApplyBoilerMaxCh((bool)(o["applyBoilerMaxCh"] | false));
      if (o.containsKey("boilerMaxChC")) ConfigStore::setEqBoilerMaxChC(o["boilerMaxChC"].as<float>());
      if (o.containsKey("driveNightRelay")) ConfigStore::setEqDriveNightRelay((bool)(o["driveNightRelay"] | true));
      if (o.containsKey("nightRelay")) {
        int relay = o["nightRelay"] | 6;
        if (relay < 1) relay = 1; if (relay > 8) relay = 8;
        ConfigStore::setEqNightRelayIndex((uint8_t)(relay - 1));
      }
      if (o.containsKey("nightRelayOnWhenNight")) ConfigStore::setEqNightRelayOnWhenNight((bool)(o["nightRelayOnWhenNight"] | true));
    }

    if (root["boilerAssist"].is<JsonObjectConst>()) {
      JsonObjectConst ba = root["boilerAssist"].as<JsonObjectConst>();
      if (ba.containsKey("enabled")) ConfigStore::setEqBoilerAssistEnabled((bool)(ba["enabled"] | false));
      if (ba.containsKey("deltaC")) ConfigStore::setEqBoilerAssistDeltaC(ba["deltaC"].as<float>());
      if (ba.containsKey("forceChEnable")) ConfigStore::setEqBoilerAssistForceChEnable((bool)(ba["forceChEnable"] | false));
    }

    String curveMode;
    const String* curveModePtr = nullptr;
    if (root.containsKey("curveMode")) {
      curveMode = String((const char*)(root["curveMode"] | "linear2")); curveMode.trim(); curveMode.toLowerCase();
      if (curveMode != "tech_i3_4point") curveMode = "linear2";
      curveModePtr = &curveMode;
    }
    JsonObjectConst weather4;
    if (root["weather4"].is<JsonObjectConst>()) weather4 = root["weather4"].as<JsonObjectConst>();

    // Backward compatibility with the previous schema, where curveMode/weather4
    // lived under equitherm.mixing.
    if (root["mixing"].is<JsonObjectConst>()) {
      JsonObjectConst oldMix = root["mixing"].as<JsonObjectConst>();
      if (!curveModePtr && oldMix.containsKey("curveMode")) {
        curveMode = String((const char*)(oldMix["curveMode"] | "linear2")); curveMode.trim(); curveMode.toLowerCase();
        if (curveMode != "tech_i3_4point") curveMode = "linear2";
        curveModePtr = &curveMode;
      }
      if (weather4.isNull() && oldMix["weather4"].is<JsonObjectConst>()) weather4 = oldMix["weather4"].as<JsonObjectConst>();
    }
    if (curveModePtr || !weather4.isNull()) saveAdvancedCurveToStore(curveModePtr, weather4);
  }
}

void equithermInit() {
  if (s_inited) return;
  s_inited = true;
  ConfigStore::begin();
  loadFromStore();
  s_st = EquithermStatus{};
  s_forceRecompute = true;
  s_lastComputeMs = 0;
  ensureOpenThermControlMode();
  compute(true);
  Serial.println("[EQ] Init (mixing valve logic separated)");
}

void equithermLoop() {
  equithermInit();
  const uint32_t now = millis();
  if (!s_forceRecompute && s_lastComputeMs && (uint32_t)(now - s_lastComputeMs) < kComputeIntervalMs) return;
  const bool force = s_forceRecompute;
  s_forceRecompute = false;
  s_lastComputeMs = now;
  compute(force);
}

void equithermReloadFromStore() {
  if (!s_inited) { equithermInit(); return; }
  loadFromStore();
  ensureOpenThermControlMode();
  s_forceRecompute = true;
}

EquithermConfig equithermGetConfig() {
  equithermInit();
  return s_cfg;
}

EquithermStatus equithermGetStatus() {
  equithermInit();
  return s_st;
}

bool equithermGetHeatingPoint(float& outC, String* outMode) {
  equithermInit();
  bool scheduleUsed = false, in1Forced = false, timeValid = false;
  String iso;
  const String mode = effectiveMode(scheduleUsed, in1Forced, timeValid, iso);
  const TempValue outside = TemperatureManager::get(TempRole::Outside, s_cfg.tempMaxAgeMs);
  if (!(outside.valid && isfinite(outside.c))) {
    outC = NAN;
    if (outMode) *outMode = mode;
    return false;
  }
  outC = curveTarget(mode, outside.c);
  if (outMode) *outMode = mode;
  return isfinite(outC);
}

void equithermFillFastJson(JsonObject& out) {
  equithermInit();
  out["en"] = s_cfg.enabled;
  out["m"] = s_st.modeReq;
  out["me"] = s_st.modeEff;
  out["su"] = s_st.scheduleUsed;
  out["ia"] = s_st.in1Active;
  out["i1"] = s_st.in1ForcingNight;
  out["sm"] = s_st.summerActive;
  out["tv"] = s_st.timeValid;
  out["ac"] = s_st.active;
  out["rs"] = s_st.reason;
  if (isfinite(s_st.outsideC)) out["oc"] = s_st.outsideC; else out["oc"] = nullptr;
  if (isfinite(s_st.flowC)) out["fc"] = s_st.flowC; else out["fc"] = nullptr;
  if (isfinite(s_st.targetBaseFlowC)) out["tb"] = s_st.targetBaseFlowC; else out["tb"] = nullptr;
  if (isfinite(s_st.targetFlowC)) out["tf"] = s_st.targetFlowC; else out["tf"] = nullptr;
  out["ok"] = s_st.lastSendOk;
}

String equithermGetStatusJson() {
  equithermInit();
  DynamicJsonDocument doc(12288);
  doc["ok"] = true;
  JsonObject cfg = doc.createNestedObject("config");
  fillConfigJson(cfg);
  JsonObject status = doc.createNestedObject("status");
  fillStatusJson(status);
  String out;
  serializeJson(doc, out);
  return out;
}

void equithermApplyConfig(const String& json) {
  equithermInit();
  DynamicJsonDocument doc(16384);
  if (deserializeJson(doc, json)) return;
  JsonObjectConst root = doc.as<JsonObjectConst>();
  if (root.isNull()) return;
  if (root["equitherm"].is<JsonObjectConst>()) root = root["equitherm"].as<JsonObjectConst>();
  applyConfigObject(root);
  loadFromStore();
  ensureOpenThermControlMode();
  s_forceRecompute = true;
  compute(true);
}

bool equithermHandleCmdJson(const String& json, String& outErr) {
  equithermInit();
  outErr = "";
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, json) || !doc.is<JsonObject>()) {
    outErr = "bad_json";
    return false;
  }
  JsonObjectConst root = doc.as<JsonObjectConst>();
  bool changed = false;
  if (root.containsKey("enabled")) {
    ConfigStore::setEqEnabled((bool)(root["enabled"] | false));
    changed = true;
  }
  if (root.containsKey("mode")) {
    String mode = String((const char*)(root["mode"] | "auto")); mode.trim(); mode.toLowerCase();
    if (mode != "auto" && mode != "day" && mode != "night") {
      outErr = "bad_mode";
      return false;
    }
    ConfigStore::setEqMode(mode);
    changed = true;
  }
  if (root.containsKey("mixPulse") || root.containsKey("mixMove") || root.containsKey("mixCalibrate")) {
    outErr = "mixing_moved_to_mixing_controller";
    return false;
  }
  if (changed) {
    loadFromStore();
    ensureOpenThermControlMode();
  }
  s_forceRecompute = true;
  compute(true);
  return true;
}

void equithermSetExternalBlock(bool blocked) {
  equithermInit();
  if (s_externalBlock == blocked) return;
  s_externalBlock = blocked;
  if (blocked) {
    openthermClearEquithermRequest();
    clearNightRelayToDay();
  }
  s_forceRecompute = true;
}

void equithermRequestRecompute() {
  equithermInit();
  s_forceRecompute = true;
}

void equithermBackgroundService() {
  webPortalBackgroundService();
  mixingValveBackgroundService();
}

extern "C" void openThermBackgroundService(void) {
  equithermBackgroundService();
}

#else

void equithermInit() {}
void equithermLoop() {}
void equithermReloadFromStore() {}
EquithermConfig equithermGetConfig() { return EquithermConfig{}; }
EquithermStatus equithermGetStatus() { return EquithermStatus{}; }
String equithermGetStatusJson() { return String("{\"ok\":false,\"err\":\"disabled\"}"); }
bool equithermGetHeatingPoint(float& outC, String* outMode) { outC = NAN; if (outMode) *outMode = "day"; return false; }
void equithermApplyConfig(const String&) {}
bool equithermHandleCmdJson(const String&, String& outErr) { outErr = "disabled"; return false; }
void equithermFillFastJson(JsonObject&) {}
void equithermSetExternalBlock(bool) {}
void equithermRequestRecompute() {}
void equithermBackgroundService() {}
extern "C" void openThermBackgroundService(void) {}

#endif
