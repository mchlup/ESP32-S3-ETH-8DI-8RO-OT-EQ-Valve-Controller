#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

// Three-way mixing valve controller for the fixed R1/R2 actuator pair.
//
// Hydraulic convention used throughout this module:
//   B = 0 %   (cold/return branch)
//   A = 100 % (hot branch from the accumulator)
//   AB        (mixed outlet / controlled temperature)
//
// The controller combines a feed-forward estimate based on A/B with an
// adaptive closed loop around AB. A normal automatic correction is always a
// bounded pulse followed by a thermal settling/measurement phase; it never
// continuously drives the actuator from a temperature error.

struct MixingValveConfig {
  bool enabled = false;

  // What to do when automatic control is disabled or when the heat source is
  // not usable. Values: "hold" | "a" | "b".
  String disabledAction = "hold";
  String noHeatAction = "b";

  // "normal": logical A -> physical open channel R1, B -> R2.
  // "reversed": logical A -> R2, B -> R1.
  String openingDirection = "normal";

  // Temperature source keys resolved by TemperatureManager.
  String sourceA = "mix_a_dallas";
  String sourceB = "mix_b_dallas";
  String sourceAB = "mix_ab_dallas";
  String sourceTank = "tank_top";
  uint32_t tempMaxAgeMs = 600000UL;

  // Final valve target = Equitherm heating point + targetOffsetC, limited by
  // the Equitherm min/max flow limits.
  float targetOffsetC = 0.0f;
  float deadbandC = 0.5f;

  // Heat-source permission with hysteresis:
  // enable when tank >= target + tankMinDeltaC,
  // disable when tank <= target + tankMinDeltaC - tankHysteresisC.
  float tankMinDeltaC = 2.0f;
  float tankHysteresisC = 1.0f;

  // Closed-loop timing.
  uint32_t controlPeriodMs = 15000UL;
  uint32_t settleMinMs = 5000UL;
  uint32_t responseTimeoutMs = 30000UL;
  float settleTrendCPerMin = 0.25f;

  // Feed-forward + adaptive pulse sizing.
  bool feedForwardEnabled = true;
  float minMixSpanC = 2.0f;
  float minStepPct = 1.0f;
  float maxStepPct = 15.0f;
  float initialMaxStepPct = 25.0f;
  float proportionalPctPerC = 4.0f;
  bool learnResponse = true;

  // User-selectable policies. "track_center" may trim the valve inside the
  // deadband, while "reverse_immediately" allows an early opposite correction
  // if the measured thermal trend is clearly moving away from the target.
  String inRangeAction = "hold";
  String oppositeTrendAction = "wait_then_reverse";

  // Actuator timing. Values are full travel B->A / A->B.
  uint32_t travelToAMs = 6000UL;
  uint32_t travelToBMs = 6000UL;
  uint32_t calibrationSeatMs = 1500UL;
  uint32_t manualPulseMs = 600UL;
  uint32_t manualHoldMs = 30000UL;

  // Independent high-temperature safety for floor heating. This has a higher
  // priority than normal automatic regulation and sends the valve toward B.
  bool floorProtectionEnabled = true;
  float floorMaxC = 45.0f;
  float floorReleaseHysteresisC = 2.0f;
};

struct MixingValveStatus {
  bool enabled = false;
  bool automaticAllowed = false;
  bool heatAvailable = false;
  bool externalBlocked = false;
  bool dhwOverride = false;

  String state;
  String reason;
  String direction; // stop | a | b

  float aC = NAN;
  float bC = NAN;
  float abC = NAN;
  float tankC = NAN;
  uint32_t aAgeMs = 0;
  uint32_t bAgeMs = 0;
  uint32_t abAgeMs = 0;
  uint32_t tankAgeMs = 0;
  String sourceA;
  String sourceB;
  String sourceAB;
  String sourceTank;

  float baseTargetC = NAN;
  float targetC = NAN;
  float errorC = NAN;
  float feedForwardPct = NAN;
  float thermalPositionPct = NAN;

  // Diagnostic validity of the simple A/B mixing model. The model is used
  // only as feed-forward guidance; AB remains the closed-loop process value.
  bool hydraulicModelValid = false;
  String hydraulicModelReason; // ok | missing_a_or_b | a_not_hotter | insufficient_span
  bool targetReachable = false;
  String targetReachabilityReason; // ok | target_below_b | target_above_a | model_invalid

  float positionPct = 50.0f;
  bool positionTrusted = false;

  bool moving = false;
  bool movingManual = false;
  uint32_t pulseRequestedMs = 0;
  uint32_t pulseElapsedMs = 0;
  uint32_t pulseRemainingMs = 0;
  float pulseStepPct = NAN;

  float trendCPerMin = 0.0f;
  bool responsePending = false;
  float lastResponseDeltaC = NAN;
  float learnedRiseCPerPct = NAN;
  float learnedFallCPerPct = NAN;

  uint32_t lastDecisionMs = 0;
  uint32_t nextDecisionInMs = 0;
  uint32_t lastCalibrationMs = 0;
  String lastCalibrationEnd;

  bool floorProtectionActive = false;
  bool relayOk = true;
  uint8_t relayMask = 0;
};

void mixingValveInit();
void mixingValveLoop();
void mixingValveReloadFromStore();

MixingValveConfig mixingValveGetConfig();
MixingValveStatus mixingValveGetStatus();
String mixingValveGetStatusJson();

// Fill the valve's own configuration object. Weather-curve configuration is
// intentionally owned by EquithermController and may be appended by the web
// layer to present a single UI page.
void mixingValveFillConfigJson(JsonObject& out);
void mixingValveFillFastJson(JsonObject& out);

// Expects the mixing object itself (or a root object containing "mixing").
// Applies and persists the new configuration immediately.
bool mixingValveApplyConfig(const String& json, String* outErr = nullptr);

// Commands include:
//   {"enabled":true|false}
//   {"action":"pulse_a|pulse_b|end_a|end_b|stop|calibrate_a|calibrate_b|invalidate"}
// Legacy aliases mixPulse/mixMove/mixCalibrate are accepted during migration.
bool mixingValveHandleCmdJson(const String& json, String& outErr);

// Stops/resumes automatic regulation without changing the persisted enabled
// switch. Used by higher-priority subsystems.
void mixingValveSetExternalBlock(bool blocked, const char* reason = nullptr);

// DHW owns the actuator while changing hydraulic position. The call is
// non-blocking; ready becomes true only after the required end position is
// reached and both relays are off. openToA=true means 100 % / A.
bool mixingValveDhwPrepare(bool openToA, bool& ready, String& outErr);
void mixingValveDhwRelease();

// Lightweight service hook safe to call while another subsystem waits.
void mixingValveBackgroundService();
