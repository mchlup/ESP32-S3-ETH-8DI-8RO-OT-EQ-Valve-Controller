#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

// Ekviterm controller.
//
// This module intentionally has no mixing-valve actuator logic. It only:
// - resolves day/night mode and weekly schedule,
// - computes the requested heating-water temperature from a 2-point or 4-point
//   weather curve,
// - applies configured min/max limits,
// - optionally publishes the CH request through the OpenTherm arbiter,
// - optionally drives the day/night relay.
//
// The three-way valve is owned exclusively by MixingValveController.

static constexpr uint8_t HEATING_MAX_INTERVALS_PER_DAY = 6;

struct EquithermInterval {
  uint16_t startMin = 360;
  uint16_t endMin = 1320;
};

struct EquithermCurve {
  float outColdC  = -12.0f;
  float flowColdC = 55.0f;
  float outWarmC  = 20.0f;
  float flowWarmC = 25.0f;
};

struct EquithermConfig {
  bool enabled = false;
  String mode = "auto"; // auto | day | night
  bool useIn1NightOverride = true;

  bool summerModeEnabled = false;
  float summerOffAboveC = 18.0f;
  float summerOnBelowC = 16.0f;

  bool scheduleEnabled = false;
  uint8_t intervalCount[7] = {1,1,1,1,1,1,1};
  EquithermInterval intervals[7][HEATING_MAX_INTERVALS_PER_DAY] = {};

  EquithermCurve day;
  EquithermCurve night;

  // Weather-curve preset. The 4-point variant follows the TECH i-3 outside
  // points -20 / -10 / 0 / +10 C. Linear extrapolation is used outside them.
  String curveMode = "linear2"; // linear2 | tech_i3_4point
  float day4FlowC[4] = {45.0f, 40.0f, 35.0f, 30.0f};
  float night4FlowC[4] = {42.0f, 37.0f, 32.0f, 27.0f};

  float minFlowC = 22.0f;
  float maxFlowC = 60.0f;
  float minChSetpointC = 22.0f;
  float maxChSetpointC = 60.0f;

  uint32_t tempMaxAgeMs = 600000UL;
  uint32_t minSendIntervalMs = 60000UL;
  float minSendDeltaC = 0.5f;

  bool useOpenTherm = true;
  bool applyBoilerMaxCh = false;
  float boilerMaxChC = 60.0f;

  bool driveNightRelay = true;
  uint8_t nightRelayIndex = 5; // R6
  bool nightRelayOnWhenNight = true;

  // Boiler-only temperature boost for COMFORT (DAY): the boiler OpenTherm
  // CH setpoint is raised by deltaC, while the mixing target stays unchanged.
  bool boilerAssistEnabled = false;
  float boilerAssistDeltaC = 5.0f;
  bool boilerAssistForceChEnable = false;
};

struct EquithermStatus {
  bool enabled = false;
  bool active = false;
  bool externalBlocked = false;
  String reason;

  String modeReq;
  String modeEff;
  bool scheduleUsed = false;
  bool in1Active = false;
  bool in1ForcingNight = false;
  bool summerActive = false;

  float outsideC = NAN;
  uint32_t outsideAgeMs = 0;
  String outsideSrc;

  float flowC = NAN;
  uint32_t flowAgeMs = 0;
  String flowSrc;

  // targetBaseFlowC is deliberately computed even when OpenTherm output is
  // disabled. MixingValveController uses it as the common heating point.
  float targetFlowC = NAN;
  float targetBaseFlowC = NAN;
  float boilerSetpointC = NAN;

  float lastSentChC = NAN;
  bool lastSendOk = false;
  String lastSendErr;
  uint32_t lastSendMs = 0;

  float boilerMaxChC = NAN;
  float boilerMaxBoundMinC = NAN;
  float boilerMaxBoundMaxC = NAN;
  float boilerClampMinC = NAN;
  float boilerClampMaxC = NAN;

  bool timeValid = false;
  String timeIso;
};

void equithermInit();
void equithermLoop();
void equithermReloadFromStore();

EquithermConfig equithermGetConfig();
EquithermStatus equithermGetStatus();
String equithermGetStatusJson();

// Returns the currently computable heating point from the selected weather
// curve. This works independently of cfg.enabled; false means no valid outside
// temperature is available.
bool equithermGetHeatingPoint(float& outC, String* outMode = nullptr);

// Apply runtime + persist (expects the equitherm object itself).
void equithermApplyConfig(const String& json);

// Commands: {"mode":"day|night|auto"} / {"enabled":true|false}
bool equithermHandleCmdJson(const String& json, String& outErr);

void equithermFillFastJson(JsonObject& out);

// Used by DHW priority to suspend the OpenTherm heating request. It does not
// control R1/R2; that responsibility belongs to MixingValveController.
void equithermSetExternalBlock(bool blocked);
void equithermRequestRecompute();

// Lightweight service hook used by blocking OpenTherm waits.
void equithermBackgroundService();
