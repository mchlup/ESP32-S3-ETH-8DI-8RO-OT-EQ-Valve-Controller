#include "MixingValveController.h"

#include <math.h>

#include "ConfigStore.h"
#include "EquithermController.h"
#include "RelayController.h"
#include "TemperatureManager.h"

namespace {
constexpr int8_t DIR_A = +1;
constexpr int8_t DIR_B = -1;
constexpr uint8_t MIX_RELAY_A = 0; // physical R1
constexpr uint8_t MIX_RELAY_B = 1; // physical R2
constexpr uint32_t LOOP_PERIOD_MS = 200UL;
constexpr float RESPONSE_MIN_C = 0.04f;
constexpr float LEARN_ALPHA = 0.30f;

MixingValveConfig s_cfg;
MixingValveStatus s_st;
bool s_inited = false;
uint32_t s_lastLoopMs = 0;
bool s_externalBlock = false;
String s_externalBlockReason;

struct Motion {
  bool active = false;
  int8_t dir = 0;
  bool manual = false;
  bool forceEnd = false;
  bool calibration = false;
  bool dhw = false;
  float endPct = NAN;
  uint32_t startedMs = 0;
  uint32_t untilMs = 0;
  uint32_t requestedMs = 0;
  float stepPct = NAN;
  bool startAbValid = false;
  float startAbC = NAN;
};
Motion s_motion;

struct ResponseObserver {
  bool pending = false;
  int8_t dir = 0;
  float startC = NAN;
  float stepPct = NAN;
  uint32_t pulseEndMs = 0;
};
ResponseObserver s_response;

bool s_heatLatch = false;
bool s_floorLatch = false;
bool s_initialApproachDone = false;
float s_lastTargetC = NAN;
float s_prevAbC = NAN;
uint32_t s_prevAbMs = 0;
float s_trendCPerMin = 0.0f;
float s_learnedRiseCPerPct = NAN;
float s_learnedFallCPerPct = NAN;
float s_lastResponseDeltaC = NAN;
uint32_t s_lastDecisionMs = 0;
uint32_t s_manualHoldUntilMs = 0;

bool s_dhwOverride = false;
int8_t s_dhwDir = 0;
uint32_t s_dhwRetryAfterMs = 0;

float clampf(float v, float lo, float hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

uint32_t clampu32(uint32_t v, uint32_t lo, uint32_t hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

String normalizedAction(String v, const char* fallback) {
  v.trim();
  v.toLowerCase();
  if (v == "a" || v == "b" || v == "hold") return v;
  return String(fallback);
}

String normalizedDirection(String v) {
  v.trim();
  v.toLowerCase();
  return v == "reversed" ? String("reversed") : String("normal");
}

String normalizedInRangeAction(String v) {
  v.trim();
  v.toLowerCase();
  return v == "track_center" ? String("track_center") : String("hold");
}

String normalizedOppositeTrendAction(String v) {
  v.trim();
  v.toLowerCase();
  return v == "reverse_immediately" ? String("reverse_immediately") : String("wait_then_reverse");
}

const char* dirName(int8_t dir) {
  if (dir > 0) return "a";
  if (dir < 0) return "b";
  return "stop";
}

int8_t physicalDirection(int8_t logicalDir) {
  if (s_cfg.openingDirection == "reversed") return (int8_t)-logicalDir;
  return logicalDir;
}

uint32_t travelMsFor(int8_t dir) {
  uint32_t ms = dir == DIR_A ? s_cfg.travelToAMs : s_cfg.travelToBMs;
  return clampu32(ms, 1000UL, 900000UL);
}

uint32_t fullTravelMsFor(int8_t dir) {
  return travelMsFor(dir) + clampu32(s_cfg.calibrationSeatMs, 0UL, 10000UL);
}

bool atTrustedEnd(int8_t dir) {
  if (!s_st.positionTrusted) return false;
  return dir == DIR_A ? s_st.positionPct >= 99.8f : s_st.positionPct <= 0.2f;
}

void invalidatePosition(bool recenter = false) {
  s_st.positionTrusted = false;
  if (recenter || !isfinite(s_st.positionPct)) s_st.positionPct = 50.0f;
}

bool relayOff(bool forceRecovery = false) {
  uint8_t mask = relayGetMask();
  const bool ok = relaySetMixingDirection(0, &mask, forceRecovery);
  s_st.relayOk = ok;
  s_st.relayMask = mask;
  return ok;
}

void setState(const char* state, const char* reason = nullptr) {
  s_st.state = state ? state : "idle";
  s_st.reason = reason ? reason : "";
}

void resetResponse() {
  s_response = ResponseObserver{};
  s_st.responsePending = false;
}

void resetAutomaticCycle() {
  s_heatLatch = false;
  s_st.heatAvailable = false;
  s_initialApproachDone = false;
  s_lastTargetC = NAN;
  resetResponse();
}

void updatePositionByMotion(uint32_t elapsedMs, int8_t dir) {
  const uint32_t travel = travelMsFor(dir);
  if (!travel) return;
  const float step = 100.0f * ((float)elapsedMs / (float)travel);
  if (!isfinite(s_st.positionPct)) s_st.positionPct = 50.0f;
  s_st.positionPct = clampf(s_st.positionPct + (dir == DIR_A ? step : -step), 0.0f, 100.0f);
}

void finalizeMotion(uint32_t now, bool naturalEnd = true) {
  if (!s_motion.active) {
    relayOff(false);
    return;
  }

  const Motion finished = s_motion;
  uint32_t elapsed = now - finished.startedMs;
  if (finished.requestedMs && elapsed > finished.requestedMs) elapsed = finished.requestedMs;

  const bool offOk = relayOff(true);
  updatePositionByMotion(elapsed, finished.dir);

  if (finished.forceEnd) {
    if (naturalEnd && offOk && isfinite(finished.endPct)) {
      s_st.positionPct = clampf(finished.endPct, 0.0f, 100.0f);
      s_st.positionTrusted = true;
      if (finished.calibration) {
        s_st.lastCalibrationMs = now;
        s_st.lastCalibrationEnd = finished.dir == DIR_A ? "a" : "b";
      }
    } else {
      invalidatePosition(false);
    }
  }

  s_st.pulseElapsedMs = elapsed;
  s_st.pulseRemainingMs = 0;
  s_st.moving = false;
  s_st.movingManual = false;
  s_st.direction = "stop";
  s_motion = Motion{};

  if (!finished.manual && !finished.forceEnd && !finished.dhw && finished.startAbValid
      && isfinite(finished.startAbC) && isfinite(finished.stepPct) && finished.stepPct > 0.05f) {
    s_response.pending = true;
    s_response.dir = finished.dir;
    s_response.startC = finished.startAbC;
    s_response.stepPct = finished.stepPct;
    s_response.pulseEndMs = now;
    s_st.responsePending = true;
    setState("settling", "waiting_for_thermal_response");
  }
}

void stopMotion(bool updatePosition = true) {
  const uint32_t now = millis();
  if (s_motion.active && updatePosition) {
    finalizeMotion(now, false);
  } else {
    if (s_motion.active) invalidatePosition(false);
    relayOff(true);
    s_motion = Motion{};
    s_st.moving = false;
    s_st.movingManual = false;
    s_st.direction = "stop";
    s_st.pulseRemainingMs = 0;
  }
}

bool startMotion(int8_t dir, uint32_t durationMs, bool manual, bool forceEnd,
                 float endPct, bool calibration, bool dhw, float stepPct) {
  if (dir != DIR_A && dir != DIR_B) return false;
  const uint32_t now = millis();
  if (s_motion.active) stopMotion(true);

  if (!manual && !dhw && !relayIsOk()) {
    s_st.relayOk = false;
    setState("fault_relay", "relay_controller_not_ready");
    return false;
  }
  if (forceEnd && atTrustedEnd(dir)) {
    relayOff(manual || dhw);
    return true;
  }

  durationMs = clampu32(durationMs, 50UL, fullTravelMsFor(dir));
  uint8_t mask = relayGetMask();
  const bool ok = relaySetMixingDirection(physicalDirection(dir), &mask, manual || dhw);
  s_st.relayOk = ok;
  s_st.relayMask = mask;
  if (!ok) {
    setState("fault_relay", "mix_relay_write_failed");
    return false;
  }

  s_motion = Motion{};
  s_motion.active = true;
  s_motion.dir = dir;
  s_motion.manual = manual;
  s_motion.forceEnd = forceEnd;
  s_motion.calibration = calibration;
  s_motion.dhw = dhw;
  s_motion.endPct = endPct;
  s_motion.startedMs = now;
  s_motion.requestedMs = durationMs;
  s_motion.untilMs = now + durationMs;
  s_motion.stepPct = stepPct;
  s_motion.startAbValid = isfinite(s_st.abC);
  s_motion.startAbC = s_st.abC;

  s_st.moving = true;
  s_st.movingManual = manual;
  s_st.direction = dirName(dir);
  s_st.pulseRequestedMs = durationMs;
  s_st.pulseElapsedMs = 0;
  s_st.pulseRemainingMs = durationMs;
  s_st.pulseStepPct = stepPct;
  setState(manual ? "manual" : (dhw ? "dhw_override" : "moving"), dir == DIR_A ? "toward_a" : "toward_b");
  return true;
}

bool startStepPct(int8_t dir, float pct, bool manual = false) {
  pct = clampf(pct, 0.05f, 100.0f);
  uint32_t ms = (uint32_t)lroundf((float)travelMsFor(dir) * pct / 100.0f);
  if (ms < 50UL) ms = 50UL;
  resetResponse();
  return startMotion(dir, ms, manual, false, NAN, false, false, pct);
}

bool startFullEnd(int8_t dir, bool manual, bool calibration, bool dhw) {
  resetResponse();
  const float endPct = dir == DIR_A ? 100.0f : 0.0f;
  return startMotion(dir, fullTravelMsFor(dir), manual, true, endPct, calibration, dhw, 100.0f);
}

void updateMotion(uint32_t now) {
  if (!s_motion.active) return;
  const uint32_t elapsed = now - s_motion.startedMs;
  s_st.pulseElapsedMs = elapsed > s_motion.requestedMs ? s_motion.requestedMs : elapsed;
  s_st.pulseRemainingMs = s_motion.requestedMs > s_st.pulseElapsedMs
    ? s_motion.requestedMs - s_st.pulseElapsedMs : 0;
  if ((int32_t)(now - s_motion.untilMs) >= 0) finalizeMotion(now, true);
}

void readTemperatures(uint32_t now) {
  const TempValue a = TemperatureManager::getBySourceKey(s_cfg.sourceA, s_cfg.tempMaxAgeMs);
  const TempValue b = TemperatureManager::getBySourceKey(s_cfg.sourceB, s_cfg.tempMaxAgeMs);
  const TempValue ab = TemperatureManager::getBySourceKey(s_cfg.sourceAB, s_cfg.tempMaxAgeMs);
  const TempValue tank = TemperatureManager::getBySourceKey(s_cfg.sourceTank, s_cfg.tempMaxAgeMs);

  s_st.sourceA = s_cfg.sourceA;
  s_st.sourceB = s_cfg.sourceB;
  s_st.sourceAB = s_cfg.sourceAB;
  s_st.sourceTank = s_cfg.sourceTank;

  s_st.aC = a.valid && isfinite(a.c) ? a.c : NAN;
  s_st.bC = b.valid && isfinite(b.c) ? b.c : NAN;
  s_st.abC = ab.valid && isfinite(ab.c) ? ab.c : NAN;
  s_st.tankC = tank.valid && isfinite(tank.c) ? tank.c : NAN;
  s_st.aAgeMs = a.ageMs;
  s_st.bAgeMs = b.ageMs;
  s_st.abAgeMs = ab.ageMs;
  s_st.tankAgeMs = tank.ageMs;

  if (isfinite(s_st.abC)) {
    if (isfinite(s_prevAbC) && s_prevAbMs != 0 && now != s_prevAbMs) {
      const uint32_t dt = now - s_prevAbMs;
      if (dt >= 500UL) {
        const float raw = (s_st.abC - s_prevAbC) * (60000.0f / (float)dt);
        if (isfinite(raw) && fabsf(raw) < 120.0f) {
          s_trendCPerMin = 0.70f * s_trendCPerMin + 0.30f * raw;
        }
        s_prevAbC = s_st.abC;
        s_prevAbMs = now;
      }
    } else {
      s_prevAbC = s_st.abC;
      s_prevAbMs = now;
      s_trendCPerMin = 0.0f;
    }
  } else {
    s_prevAbC = NAN;
    s_prevAbMs = 0;
    s_trendCPerMin = 0.0f;
  }
  s_st.trendCPerMin = s_trendCPerMin;
}

void updateTargets() {
  float base = NAN;
  String mode;
  if (equithermGetHeatingPoint(base, &mode) && isfinite(base)) {
    s_st.baseTargetC = base;
    const EquithermConfig eq = equithermGetConfig();
    const float lo = fminf(eq.minFlowC, eq.maxFlowC);
    const float hi = fmaxf(eq.minFlowC, eq.maxFlowC);
    s_st.targetC = clampf(base + s_cfg.targetOffsetC, lo, hi);
  } else {
    s_st.baseTargetC = NAN;
    s_st.targetC = NAN;
  }
  s_st.errorC = (isfinite(s_st.targetC) && isfinite(s_st.abC)) ? s_st.targetC - s_st.abC : NAN;

  // The A/B formula is deliberately only a hydraulic model / feed-forward
  // hint. It is valid only when A is measurably hotter than B. Reversed or
  // nearly equal branch temperatures must never invert the controller.
  s_st.feedForwardPct = NAN;
  s_st.thermalPositionPct = NAN;
  s_st.hydraulicModelValid = false;
  s_st.hydraulicModelReason = "missing_a_or_b";
  s_st.targetReachable = false;
  s_st.targetReachabilityReason = "model_invalid";

  if (isfinite(s_st.aC) && isfinite(s_st.bC)) {
    const float span = s_st.aC - s_st.bC;
    if (span <= 0.0f) {
      s_st.hydraulicModelReason = "a_not_hotter";
    } else if (span < s_cfg.minMixSpanC) {
      s_st.hydraulicModelReason = "insufficient_span";
    } else {
      s_st.hydraulicModelValid = true;
      s_st.hydraulicModelReason = "ok";
      if (isfinite(s_st.targetC)) {
        s_st.feedForwardPct = clampf((s_st.targetC - s_st.bC) / span * 100.0f, 0.0f, 100.0f);
        if (s_st.targetC < s_st.bC - s_cfg.deadbandC) {
          s_st.targetReachabilityReason = "target_below_b";
        } else if (s_st.targetC > s_st.aC + s_cfg.deadbandC) {
          s_st.targetReachabilityReason = "target_above_a";
        } else {
          s_st.targetReachable = true;
          s_st.targetReachabilityReason = "ok";
        }
      }
      if (isfinite(s_st.abC)) {
        s_st.thermalPositionPct = clampf((s_st.abC - s_st.bC) / span * 100.0f, 0.0f, 100.0f);
      }
    }
  }
}

void updateHeatLatch() {
  if (!(isfinite(s_st.targetC) && isfinite(s_st.tankC))) {
    s_heatLatch = false;
    s_st.heatAvailable = false;
    return;
  }
  const float onLimit = s_st.targetC + s_cfg.tankMinDeltaC;
  const float offLimit = s_st.targetC + fmaxf(0.0f, s_cfg.tankMinDeltaC - s_cfg.tankHysteresisC);
  if (s_heatLatch) {
    if (s_st.tankC <= offLimit) s_heatLatch = false;
  } else {
    if (s_st.tankC >= onLimit) s_heatLatch = true;
  }
  s_st.heatAvailable = s_heatLatch;
}

void learnResponse(float signedDeltaC, float stepPct, int8_t dir) {
  if (!s_cfg.learnResponse || !isfinite(stepPct) || stepPct < 0.1f) return;
  float effective = dir == DIR_A ? signedDeltaC : -signedDeltaC;
  if (!isfinite(effective) || effective < RESPONSE_MIN_C) return;
  const float perPct = effective / stepPct;
  if (!(perPct > 0.001f && perPct < 2.0f)) return;
  float& learned = dir == DIR_A ? s_learnedRiseCPerPct : s_learnedFallCPerPct;
  learned = isfinite(learned) ? ((1.0f - LEARN_ALPHA) * learned + LEARN_ALPHA * perPct) : perPct;
}

bool responseSettled(uint32_t now) {
  if (!s_response.pending || !isfinite(s_st.abC) || !isfinite(s_response.startC)) return false;
  const uint32_t elapsed = now - s_response.pulseEndMs;
  if (elapsed < s_cfg.settleMinMs) return false;
  if (elapsed >= s_cfg.responseTimeoutMs) return true;

  // Do not mistake the hydraulic/transport delay for a settled response. A
  // slow floor circuit can stay almost flat for several seconds after a pulse;
  // stacking another pulse during that dead time is a common cause of large
  // overshoots. Wait until AB has measurably reacted at least once, then use
  // the trend to decide when that response has calmed down. The timeout above
  // remains the escape path when no measurable response arrives at all.
  const float responseDeltaC = fabsf(s_st.abC - s_response.startC);
  if (responseDeltaC < RESPONSE_MIN_C) return false;
  return fabsf(s_trendCPerMin) <= s_cfg.settleTrendCPerMin;
}

bool responseNeedsEarlyReverse(uint32_t now) {
  if (!s_response.pending || s_cfg.oppositeTrendAction != "reverse_immediately") return false;
  if (!isfinite(s_st.targetC) || !isfinite(s_st.abC)) return false;
  if ((uint32_t)(now - s_response.pulseEndMs) < s_cfg.settleMinMs) return false;

  const float error = s_st.targetC - s_st.abC;
  if (fabsf(error) <= s_cfg.deadbandC) return false;
  return (error > 0.0f && s_trendCPerMin < -s_cfg.settleTrendCPerMin)
      || (error < 0.0f && s_trendCPerMin >  s_cfg.settleTrendCPerMin);
}

void finishResponseObservation(uint32_t now) {
  if (!s_response.pending) return;
  if (isfinite(s_st.abC) && isfinite(s_response.startC)) {
    const float delta = s_st.abC - s_response.startC;
    s_lastResponseDeltaC = delta;
    learnResponse(delta, s_response.stepPct, s_response.dir);
  }
  resetResponse();
  s_lastDecisionMs = now;
}

float computeRegularStepPct(float absError, int8_t dir) {
  float step = absError * s_cfg.proportionalPctPerC;
  const float learned = dir == DIR_A ? s_learnedRiseCPerPct : s_learnedFallCPerPct;
  if (s_cfg.learnResponse && isfinite(learned) && learned > 0.002f) {
    // Aim for roughly 70 % of the measured error. The remaining margin plus the
    // mandatory settle phase deliberately favours stability over oscillation.
    step = (absError / learned) * 0.70f;
  }
  return clampf(step, s_cfg.minStepPct, s_cfg.maxStepPct);
}

void parkForAction(const String& action, const char* state, const char* reason) {
  const String a = normalizedAction(action, "hold");
  if (a == "hold") {
    if (s_motion.active && !s_motion.manual && !s_motion.dhw) stopMotion(true);
    else relayOff(false);
    setState(state, reason);
    return;
  }
  const int8_t dir = a == "a" ? DIR_A : DIR_B;
  if (s_motion.active) {
    if (s_motion.dir == dir && s_motion.forceEnd) {
      setState(state, reason);
      return;
    }
    stopMotion(true);
  }
  if (atTrustedEnd(dir)) {
    relayOff(false);
    setState(state, reason);
    return;
  }
  if (startFullEnd(dir, false, false, false)) setState("parking", reason);
  else setState("fault_relay", "park_relay_write_failed");
}

void applyFloorProtection() {
  s_st.floorProtectionActive = s_floorLatch;
  if (s_motion.active) {
    if (s_motion.dir == DIR_B && s_motion.forceEnd) {
      setState("floor_protection", "closing_to_b");
      return;
    }
    stopMotion(true);
  }
  if (atTrustedEnd(DIR_B)) {
    relayOff(false);
    setState("floor_protection", "safe_at_b");
  } else if (startFullEnd(DIR_B, false, false, false)) {
    setState("floor_protection", "closing_to_b");
  } else {
    setState("fault_relay", "floor_protection_relay_failed");
  }
}

void controlAutomatic(uint32_t now) {
  s_st.enabled = s_cfg.enabled;
  s_st.externalBlocked = s_externalBlock;
  s_st.dhwOverride = s_dhwOverride;
  s_st.automaticAllowed = false;

  if (s_dhwOverride) {
    resetResponse();
    s_initialApproachDone = false;
    setState("dhw_override", "dhw_owns_valve");
    return;
  }

  if (s_externalBlock) {
    resetResponse();
    s_initialApproachDone = false;
    if (s_motion.active && !s_motion.manual) stopMotion(true);
    else relayOff(false);
    setState("blocked_external", s_externalBlockReason.length() ? s_externalBlockReason.c_str() : "external_block");
    return;
  }

  if (s_motion.active && s_motion.manual) {
    setState("manual", s_motion.dir == DIR_A ? "pulse_a" : "pulse_b");
    return;
  }
  if (s_manualHoldUntilMs != 0 && (int32_t)(s_manualHoldUntilMs - now) > 0) {
    relayOff(false);
    setState("manual_hold", "automatic_resume_delay");
    return;
  }
  s_manualHoldUntilMs = 0;

  // The master switch is authoritative for normal valve automation. When it is
  // off, the controller only enforces the configured disabled position; it
  // does not start temperature-based protection moves behind the user's back.
  // DHW/manual ownership above remains available even with automation off.
  if (!s_cfg.enabled) {
    s_floorLatch = false;
    s_st.floorProtectionActive = false;
    resetAutomaticCycle();
    parkForAction(s_cfg.disabledAction, "disabled", "automatic_control_disabled");
    return;
  }

  if (s_cfg.floorProtectionEnabled && isfinite(s_st.abC)) {
    if (s_floorLatch) {
      if (s_st.abC <= s_cfg.floorMaxC - s_cfg.floorReleaseHysteresisC) s_floorLatch = false;
    } else if (s_st.abC >= s_cfg.floorMaxC) {
      s_floorLatch = true;
    }
  } else {
    s_floorLatch = false;
  }
  if (s_floorLatch) {
    applyFloorProtection();
    return;
  }
  s_st.floorProtectionActive = false;

  if (!isfinite(s_st.targetC)) {
    resetAutomaticCycle();
    parkForAction(s_cfg.noHeatAction, "blocked_target", "weather_target_unavailable");
    return;
  }
  if (!isfinite(s_st.abC)) {
    s_initialApproachDone = false;
    resetResponse();
    if (s_motion.active && !s_motion.manual) stopMotion(true);
    else relayOff(false);
    setState("fault_ab_sensor", "ab_temperature_unavailable");
    return;
  }
  if (!isfinite(s_st.tankC)) {
    resetAutomaticCycle();
    parkForAction(s_cfg.noHeatAction, "blocked_tank_sensor", "tank_temperature_unavailable");
    return;
  }

  updateHeatLatch();
  if (!s_heatLatch) {
    s_initialApproachDone = false;
    resetResponse();
    parkForAction(s_cfg.noHeatAction, "blocked_no_heat", "accumulator_too_cold");
    return;
  }
  s_st.automaticAllowed = true;

  // A time-only actuator has no absolute position feedback. Before the first
  // automatic regulation after boot (or after explicit invalidation), create a
  // deterministic reference by seating the valve at B / 0 %. This prevents an
  // unknown initial position from accumulating into unsafe repeated pulses.
  if (!s_st.positionTrusted) {
    resetResponse();
    s_initialApproachDone = false;
    if (s_motion.active) {
      // An old parking/motion command may still be running when automatic
      // regulation gets enabled. Only a real full-end motion toward B is a
      // valid reference sequence; any other automatic motion is stopped first.
      if (s_motion.forceEnd && s_motion.dir == DIR_B) {
        setState("referencing_b", "waiting_for_b_reference");
        return;
      }
      stopMotion(true);
    }
    if (startFullEnd(DIR_B, false, true, false)) {
      setState("referencing_b", "automatic_position_reference");
    } else {
      setState("fault_relay", "reference_b_relay_failed");
    }
    return;
  }

  if (isfinite(s_lastTargetC) && fabsf(s_st.targetC - s_lastTargetC) > fmaxf(1.0f, s_cfg.deadbandC * 2.0f)) {
    s_initialApproachDone = false;
    resetResponse();
  }
  s_lastTargetC = s_st.targetC;

  if (s_motion.active) return;

  if (s_response.pending) {
    const bool earlyReverse = responseNeedsEarlyReverse(now);
    setState("settling", earlyReverse ? "opposite_trend_reverse" : "waiting_for_thermal_response");
    if (!earlyReverse && !responseSettled(now)) return;
    finishResponseObservation(now);
    updateTargets();
  }

  const float error = s_st.targetC - s_st.abC;
  s_st.errorC = error;
  if (fabsf(error) <= s_cfg.deadbandC) {
    relayOff(false);
    // Default policy is a true dead band: once AB is inside the configured
    // range, the actuator is left untouched. Optional track_center mode uses
    // only the minimum pulse and only outside the inner 35 % of the band.
    if (s_cfg.inRangeAction == "track_center"
        && fabsf(error) > s_cfg.deadbandC * 0.35f
        && (s_lastDecisionMs == 0 || (uint32_t)(now - s_lastDecisionMs) >= s_cfg.controlPeriodMs)) {
      const int8_t centerDir = error > 0.0f ? DIR_A : DIR_B;
      s_lastDecisionMs = now;
      if (startStepPct(centerDir, s_cfg.minStepPct, false)) {
        setState("moving", centerDir == DIR_A ? "center_tracking_a" : "center_tracking_b");
        return;
      }
    }
    setState("in_range", s_cfg.inRangeAction == "track_center" ? "center_band" : "target_band_hold");
    return;
  }

  // If the measured temperature is currently moving away from the requested
  // target, the conservative policy still waits for the normal control period.
  // Service installations that need a faster recovery can explicitly choose
  // reverse_immediately; in that mode the period gate below is bypassed.
  const bool movingAway = (error > 0.0f && s_trendCPerMin < -s_cfg.settleTrendCPerMin)
                       || (error < 0.0f && s_trendCPerMin > s_cfg.settleTrendCPerMin);
  const bool immediateReverse = movingAway && s_cfg.oppositeTrendAction == "reverse_immediately";

  if (!immediateReverse && s_lastDecisionMs != 0 && (uint32_t)(now - s_lastDecisionMs) < s_cfg.controlPeriodMs) {
    setState("tracking", movingAway ? "opposite_trend_wait" : "control_period_wait");
    return;
  }

  if (!s_initialApproachDone) {
    s_initialApproachDone = true;
    if (s_cfg.feedForwardEnabled && isfinite(s_st.feedForwardPct)) {
      float currentPct = NAN;
      if (s_st.positionTrusted && isfinite(s_st.positionPct)) currentPct = s_st.positionPct;
      else if (isfinite(s_st.thermalPositionPct)) currentPct = s_st.thermalPositionPct;
      if (isfinite(currentPct)) {
        float delta = s_st.feedForwardPct - currentPct;
        delta = clampf(delta, -s_cfg.initialMaxStepPct, s_cfg.initialMaxStepPct);
        if (fabsf(delta) >= s_cfg.minStepPct) {
          const int8_t dir = delta > 0 ? DIR_A : DIR_B;
          s_lastDecisionMs = now;
          if (startStepPct(dir, fabsf(delta), false)) {
            setState("initial_approach", dir == DIR_A ? "feed_forward_a" : "feed_forward_b");
            return;
          }
        }
      }
    }
  }

  // Do not add another pulse while AB is already moving toward the target fast
  // enough to cover the current error in roughly one control period.
  const bool towardTarget = (error > 0.0f && s_trendCPerMin > s_cfg.settleTrendCPerMin)
                         || (error < 0.0f && s_trendCPerMin < -s_cfg.settleTrendCPerMin);
  if (towardTarget) {
    const float projected = s_st.abC + s_trendCPerMin * ((float)s_cfg.controlPeriodMs / 60000.0f);
    if ((error > 0.0f && projected >= s_st.targetC - s_cfg.deadbandC)
        || (error < 0.0f && projected <= s_st.targetC + s_cfg.deadbandC)) {
      setState("tracking", "predictive_hold");
      s_lastDecisionMs = now;
      return;
    }
  }

  const int8_t dir = error > 0.0f ? DIR_A : DIR_B;
  if (atTrustedEnd(dir)) {
    relayOff(false);
    s_lastDecisionMs = now;
    if (dir == DIR_A) {
      setState("at_limit", s_st.targetReachabilityReason == "target_above_a"
        ? "target_above_available_hot_branch" : "at_a_100_percent");
    } else {
      setState("at_limit", s_st.targetReachabilityReason == "target_below_b"
        ? "target_below_available_cold_branch" : "at_b_0_percent");
    }
    return;
  }

  const float stepPct = computeRegularStepPct(fabsf(error), dir);
  s_lastDecisionMs = now;
  if (startStepPct(dir, stepPct, false)) {
    setState("moving", dir == DIR_A ? "correction_a" : "correction_b");
  } else {
    setState("fault_relay", "automatic_pulse_rejected");
  }
}

void refreshStatusTiming(uint32_t now) {
  s_st.enabled = s_cfg.enabled;
  s_st.externalBlocked = s_externalBlock;
  s_st.dhwOverride = s_dhwOverride;
  s_st.positionPct = clampf(isfinite(s_st.positionPct) ? s_st.positionPct : 50.0f, 0.0f, 100.0f);
  s_st.trendCPerMin = s_trendCPerMin;
  s_st.responsePending = s_response.pending;
  s_st.lastResponseDeltaC = s_lastResponseDeltaC;
  s_st.learnedRiseCPerPct = s_learnedRiseCPerPct;
  s_st.learnedFallCPerPct = s_learnedFallCPerPct;
  s_st.lastDecisionMs = s_lastDecisionMs;
  s_st.relayMask = relayGetMask();
  if (s_motion.active) {
    const uint32_t elapsed = now - s_motion.startedMs;
    s_st.pulseElapsedMs = elapsed > s_motion.requestedMs ? s_motion.requestedMs : elapsed;
    s_st.pulseRemainingMs = s_motion.requestedMs > s_st.pulseElapsedMs ? s_motion.requestedMs - s_st.pulseElapsedMs : 0;
  }
  if (s_lastDecisionMs && s_cfg.controlPeriodMs > (uint32_t)(now - s_lastDecisionMs)) {
    s_st.nextDecisionInMs = s_cfg.controlPeriodMs - (uint32_t)(now - s_lastDecisionMs);
  } else {
    s_st.nextDecisionInMs = 0;
  }
}

void sanitizeConfig() {
  s_cfg.disabledAction = normalizedAction(s_cfg.disabledAction, "hold");
  s_cfg.noHeatAction = normalizedAction(s_cfg.noHeatAction, "b");
  s_cfg.openingDirection = normalizedDirection(s_cfg.openingDirection);
  s_cfg.sourceA = TemperatureManager::normalizeSourceKey(s_cfg.sourceA, "mix_a_dallas");
  s_cfg.sourceB = TemperatureManager::normalizeSourceKey(s_cfg.sourceB, "mix_b_dallas");
  s_cfg.sourceAB = TemperatureManager::normalizeSourceKey(s_cfg.sourceAB, "mix_ab_dallas");
  s_cfg.sourceTank = TemperatureManager::normalizeSourceKey(s_cfg.sourceTank, "tank_top");
  s_cfg.tempMaxAgeMs = clampu32(s_cfg.tempMaxAgeMs, 5000UL, 3600000UL);
  s_cfg.targetOffsetC = clampf(s_cfg.targetOffsetC, -20.0f, 20.0f);
  s_cfg.deadbandC = clampf(s_cfg.deadbandC, 0.1f, 10.0f);
  s_cfg.tankMinDeltaC = clampf(s_cfg.tankMinDeltaC, 0.0f, 30.0f);
  s_cfg.tankHysteresisC = clampf(s_cfg.tankHysteresisC, 0.0f, 20.0f);
  if (s_cfg.tankHysteresisC > s_cfg.tankMinDeltaC) s_cfg.tankHysteresisC = s_cfg.tankMinDeltaC;
  s_cfg.controlPeriodMs = clampu32(s_cfg.controlPeriodMs, 1000UL, 300000UL);
  s_cfg.settleMinMs = clampu32(s_cfg.settleMinMs, 500UL, 120000UL);
  s_cfg.responseTimeoutMs = clampu32(s_cfg.responseTimeoutMs, s_cfg.settleMinMs, 600000UL);
  s_cfg.settleTrendCPerMin = clampf(s_cfg.settleTrendCPerMin, 0.01f, 20.0f);
  s_cfg.minMixSpanC = clampf(s_cfg.minMixSpanC, 0.5f, 30.0f);
  s_cfg.minStepPct = clampf(s_cfg.minStepPct, 0.1f, 50.0f);
  s_cfg.maxStepPct = clampf(s_cfg.maxStepPct, s_cfg.minStepPct, 100.0f);
  s_cfg.initialMaxStepPct = clampf(s_cfg.initialMaxStepPct, s_cfg.minStepPct, 100.0f);
  s_cfg.proportionalPctPerC = clampf(s_cfg.proportionalPctPerC, 0.1f, 50.0f);
  s_cfg.inRangeAction = normalizedInRangeAction(s_cfg.inRangeAction);
  s_cfg.oppositeTrendAction = normalizedOppositeTrendAction(s_cfg.oppositeTrendAction);
  s_cfg.travelToAMs = clampu32(s_cfg.travelToAMs, 1000UL, 900000UL);
  s_cfg.travelToBMs = clampu32(s_cfg.travelToBMs, 1000UL, 900000UL);
  s_cfg.calibrationSeatMs = clampu32(s_cfg.calibrationSeatMs, 0UL, 10000UL);
  s_cfg.manualPulseMs = clampu32(s_cfg.manualPulseMs, 50UL, 60000UL);
  s_cfg.manualHoldMs = clampu32(s_cfg.manualHoldMs, 0UL, 300000UL);
  s_cfg.floorMaxC = clampf(s_cfg.floorMaxC, 20.0f, 80.0f);
  s_cfg.floorReleaseHysteresisC = clampf(s_cfg.floorReleaseHysteresisC, 0.1f, 20.0f);
}

void loadAdvancedConfig(MixingValveConfig& c) {
  String raw = ConfigStore::getEqMixAdvancedJson();
  if (!raw.length()) return;
  DynamicJsonDocument doc(8192);
  if (deserializeJson(doc, raw) || !doc.is<JsonObject>()) return;
  JsonObjectConst root = doc.as<JsonObjectConst>();
  if (!root["newMix"].is<JsonObjectConst>()) {
    // One-time migration hints from the previous schema. Only harmless,
    // directly equivalent settings are imported.
    if (root.containsKey("openingDirection")) c.openingDirection = String((const char*)(root["openingDirection"] | "normal"));
    return;
  }
  JsonObjectConst m = root["newMix"].as<JsonObjectConst>();
  // Safety rule: a newly installed controller never inherits the legacy
  // eqMixingEnabled flag. Automatic motion becomes active only after this new
  // schema has explicitly persisted enabled=true.
  if (m.containsKey("enabled")) c.enabled = (bool)(m["enabled"] | false);
  if (m.containsKey("disabledAction")) c.disabledAction = String((const char*)(m["disabledAction"] | "hold"));
  if (m.containsKey("noHeatAction")) c.noHeatAction = String((const char*)(m["noHeatAction"] | "b"));
  if (m.containsKey("openingDirection")) c.openingDirection = String((const char*)(m["openingDirection"] | "normal"));
  if (m.containsKey("sourceA")) c.sourceA = String((const char*)(m["sourceA"] | "mix_a_dallas"));
  if (m.containsKey("sourceB")) c.sourceB = String((const char*)(m["sourceB"] | "mix_b_dallas"));
  if (m.containsKey("sourceAB")) c.sourceAB = String((const char*)(m["sourceAB"] | "mix_ab_dallas"));
  if (m.containsKey("sourceTank")) c.sourceTank = String((const char*)(m["sourceTank"] | "tank_top"));
  if (m.containsKey("tempMaxAgeMs")) c.tempMaxAgeMs = m["tempMaxAgeMs"].as<uint32_t>();
  if (m.containsKey("targetOffsetC")) c.targetOffsetC = m["targetOffsetC"].as<float>();
  if (m.containsKey("deadbandC")) c.deadbandC = m["deadbandC"].as<float>();
  if (m.containsKey("tankMinDeltaC")) c.tankMinDeltaC = m["tankMinDeltaC"].as<float>();
  if (m.containsKey("tankHysteresisC")) c.tankHysteresisC = m["tankHysteresisC"].as<float>();
  if (m.containsKey("controlPeriodMs")) c.controlPeriodMs = m["controlPeriodMs"].as<uint32_t>();
  if (m.containsKey("settleMinMs")) c.settleMinMs = m["settleMinMs"].as<uint32_t>();
  if (m.containsKey("responseTimeoutMs")) c.responseTimeoutMs = m["responseTimeoutMs"].as<uint32_t>();
  if (m.containsKey("settleTrendCPerMin")) c.settleTrendCPerMin = m["settleTrendCPerMin"].as<float>();
  if (m.containsKey("feedForwardEnabled")) c.feedForwardEnabled = (bool)(m["feedForwardEnabled"] | true);
  if (m.containsKey("minMixSpanC")) c.minMixSpanC = m["minMixSpanC"].as<float>();
  if (m.containsKey("minStepPct")) c.minStepPct = m["minStepPct"].as<float>();
  if (m.containsKey("maxStepPct")) c.maxStepPct = m["maxStepPct"].as<float>();
  if (m.containsKey("initialMaxStepPct")) c.initialMaxStepPct = m["initialMaxStepPct"].as<float>();
  if (m.containsKey("proportionalPctPerC")) c.proportionalPctPerC = m["proportionalPctPerC"].as<float>();
  if (m.containsKey("learnResponse")) c.learnResponse = (bool)(m["learnResponse"] | true);
  if (m.containsKey("inRangeAction")) c.inRangeAction = String((const char*)(m["inRangeAction"] | "hold"));
  if (m.containsKey("oppositeTrendAction")) c.oppositeTrendAction = String((const char*)(m["oppositeTrendAction"] | "wait_then_reverse"));
  if (m.containsKey("travelToAMs")) c.travelToAMs = m["travelToAMs"].as<uint32_t>();
  if (m.containsKey("travelToBMs")) c.travelToBMs = m["travelToBMs"].as<uint32_t>();
  if (m.containsKey("calibrationSeatMs")) c.calibrationSeatMs = m["calibrationSeatMs"].as<uint32_t>();
  if (m.containsKey("manualPulseMs")) c.manualPulseMs = m["manualPulseMs"].as<uint32_t>();
  if (m.containsKey("manualHoldMs")) c.manualHoldMs = m["manualHoldMs"].as<uint32_t>();
  if (m.containsKey("floorProtectionEnabled")) c.floorProtectionEnabled = (bool)(m["floorProtectionEnabled"] | true);
  if (m.containsKey("floorMaxC")) c.floorMaxC = m["floorMaxC"].as<float>();
  if (m.containsKey("floorReleaseHysteresisC")) c.floorReleaseHysteresisC = m["floorReleaseHysteresisC"].as<float>();
}

void loadFromStore() {
  MixingValveConfig c;
  // Deliberately keep c.enabled=false until loadAdvancedConfig() sees an
  // explicit newMix.enabled value. This prevents an old firmware setting from
  // moving the valve immediately after upgrading to the redesigned controller.
  c.sourceA = ConfigStore::getEqMixTempSourceA();
  c.sourceB = ConfigStore::getEqMixTempSourceB();
  c.sourceAB = ConfigStore::getEqMixTempSourceAB();
  c.travelToAMs = ConfigStore::getEqMixTravelToAMs();
  c.travelToBMs = ConfigStore::getEqMixTravelToBMs();
  if (c.travelToAMs < 1000UL) c.travelToAMs = ConfigStore::getEqMixTravelMs();
  if (c.travelToBMs < 1000UL) c.travelToBMs = ConfigStore::getEqMixTravelMs();
  c.calibrationSeatMs = ConfigStore::getEqMixCalibrationSeatMs();
  c.manualPulseMs = ConfigStore::getEqMixPulseMs();
  loadAdvancedConfig(c);
  s_cfg = c;
  sanitizeConfig();
}

void saveAdvancedConfig() {
  // The old firmware stored a large TECH-i3 regulator object in this NVS
  // string. Keep only the two new owners of this shared document: weather
  // curve data and the redesigned mixing controller. This both removes stale
  // logic and keeps the persisted JSON small and deterministic.
  DynamicJsonDocument oldDoc(8192);
  const String old = ConfigStore::getEqMixAdvancedJson();
  if (old.length() && old != "{}") deserializeJson(oldDoc, old);
  JsonObjectConst oldRoot = oldDoc.is<JsonObject>() ? oldDoc.as<JsonObjectConst>() : JsonObjectConst();

  DynamicJsonDocument doc(8192);
  JsonObject root = doc.to<JsonObject>();
  if (!oldRoot.isNull() && oldRoot.containsKey("curveMode")) {
    root["curveMode"] = oldRoot["curveMode"];
  }
  if (!oldRoot.isNull() && oldRoot["weather4"].is<JsonObjectConst>()) {
    JsonObjectConst srcW = oldRoot["weather4"].as<JsonObjectConst>();
    JsonObject dstW = root.createNestedObject("weather4");
    if (srcW["day"].is<JsonArrayConst>()) {
      JsonArray a = dstW.createNestedArray("day");
      for (JsonVariantConst v : srcW["day"].as<JsonArrayConst>()) a.add(v);
    }
    if (srcW["night"].is<JsonArrayConst>()) {
      JsonArray a = dstW.createNestedArray("night");
      for (JsonVariantConst v : srcW["night"].as<JsonArrayConst>()) a.add(v);
    }
  }

  JsonObject m = root.createNestedObject("newMix");
  m["schemaVersion"] = 1;
  m["enabled"] = s_cfg.enabled;
  m["disabledAction"] = s_cfg.disabledAction;
  m["noHeatAction"] = s_cfg.noHeatAction;
  m["openingDirection"] = s_cfg.openingDirection;
  m["sourceA"] = s_cfg.sourceA;
  m["sourceB"] = s_cfg.sourceB;
  m["sourceAB"] = s_cfg.sourceAB;
  m["sourceTank"] = s_cfg.sourceTank;
  m["tempMaxAgeMs"] = s_cfg.tempMaxAgeMs;
  m["targetOffsetC"] = s_cfg.targetOffsetC;
  m["deadbandC"] = s_cfg.deadbandC;
  m["tankMinDeltaC"] = s_cfg.tankMinDeltaC;
  m["tankHysteresisC"] = s_cfg.tankHysteresisC;
  m["controlPeriodMs"] = s_cfg.controlPeriodMs;
  m["settleMinMs"] = s_cfg.settleMinMs;
  m["responseTimeoutMs"] = s_cfg.responseTimeoutMs;
  m["settleTrendCPerMin"] = s_cfg.settleTrendCPerMin;
  m["feedForwardEnabled"] = s_cfg.feedForwardEnabled;
  m["minMixSpanC"] = s_cfg.minMixSpanC;
  m["minStepPct"] = s_cfg.minStepPct;
  m["maxStepPct"] = s_cfg.maxStepPct;
  m["initialMaxStepPct"] = s_cfg.initialMaxStepPct;
  m["proportionalPctPerC"] = s_cfg.proportionalPctPerC;
  m["learnResponse"] = s_cfg.learnResponse;
  m["inRangeAction"] = s_cfg.inRangeAction;
  m["oppositeTrendAction"] = s_cfg.oppositeTrendAction;
  m["travelToAMs"] = s_cfg.travelToAMs;
  m["travelToBMs"] = s_cfg.travelToBMs;
  m["calibrationSeatMs"] = s_cfg.calibrationSeatMs;
  m["manualPulseMs"] = s_cfg.manualPulseMs;
  m["manualHoldMs"] = s_cfg.manualHoldMs;
  m["floorProtectionEnabled"] = s_cfg.floorProtectionEnabled;
  m["floorMaxC"] = s_cfg.floorMaxC;
  m["floorReleaseHysteresisC"] = s_cfg.floorReleaseHysteresisC;

  String raw;
  serializeJson(doc, raw);
  ConfigStore::setEqMixAdvancedJson(raw);
}

void fillConfigObject(JsonObject& o) {
  o["enabled"] = s_cfg.enabled;
  o["disabledAction"] = s_cfg.disabledAction;
  o["noHeatAction"] = s_cfg.noHeatAction;
  o["openingDirection"] = s_cfg.openingDirection;
  o["sourceA"] = s_cfg.sourceA;
  o["sourceB"] = s_cfg.sourceB;
  o["sourceAB"] = s_cfg.sourceAB;
  o["sourceTank"] = s_cfg.sourceTank;
  o["tempMaxAgeMs"] = s_cfg.tempMaxAgeMs;
  o["targetOffsetC"] = s_cfg.targetOffsetC;
  o["deadbandC"] = s_cfg.deadbandC;
  o["tankMinDeltaC"] = s_cfg.tankMinDeltaC;
  o["tankHysteresisC"] = s_cfg.tankHysteresisC;
  o["controlPeriodMs"] = s_cfg.controlPeriodMs;
  o["settleMinMs"] = s_cfg.settleMinMs;
  o["responseTimeoutMs"] = s_cfg.responseTimeoutMs;
  o["settleTrendCPerMin"] = s_cfg.settleTrendCPerMin;
  o["feedForwardEnabled"] = s_cfg.feedForwardEnabled;
  o["minMixSpanC"] = s_cfg.minMixSpanC;
  o["minStepPct"] = s_cfg.minStepPct;
  o["maxStepPct"] = s_cfg.maxStepPct;
  o["initialMaxStepPct"] = s_cfg.initialMaxStepPct;
  o["proportionalPctPerC"] = s_cfg.proportionalPctPerC;
  o["learnResponse"] = s_cfg.learnResponse;
  o["inRangeAction"] = s_cfg.inRangeAction;
  o["oppositeTrendAction"] = s_cfg.oppositeTrendAction;
  o["travelToAMs"] = s_cfg.travelToAMs;
  o["travelToBMs"] = s_cfg.travelToBMs;
  o["calibrationSeatMs"] = s_cfg.calibrationSeatMs;
  o["manualPulseMs"] = s_cfg.manualPulseMs;
  o["manualHoldMs"] = s_cfg.manualHoldMs;
  o["floorProtectionEnabled"] = s_cfg.floorProtectionEnabled;
  o["floorMaxC"] = s_cfg.floorMaxC;
  o["floorReleaseHysteresisC"] = s_cfg.floorReleaseHysteresisC;
}

void fillStatusObject(JsonObject& o) {
  o["enabled"] = s_st.enabled;
  o["automaticAllowed"] = s_st.automaticAllowed;
  o["heatAvailable"] = s_st.heatAvailable;
  o["externalBlocked"] = s_st.externalBlocked;
  o["dhwOverride"] = s_st.dhwOverride;
  o["state"] = s_st.state;
  o["reason"] = s_st.reason;
  o["direction"] = s_st.direction;
  if (isfinite(s_st.aC)) o["aC"] = s_st.aC; else o["aC"] = nullptr;
  if (isfinite(s_st.bC)) o["bC"] = s_st.bC; else o["bC"] = nullptr;
  if (isfinite(s_st.abC)) o["abC"] = s_st.abC; else o["abC"] = nullptr;
  if (isfinite(s_st.tankC)) o["tankC"] = s_st.tankC; else o["tankC"] = nullptr;
  o["aAgeMs"] = s_st.aAgeMs;
  o["bAgeMs"] = s_st.bAgeMs;
  o["abAgeMs"] = s_st.abAgeMs;
  o["tankAgeMs"] = s_st.tankAgeMs;
  o["sourceA"] = s_st.sourceA;
  o["sourceB"] = s_st.sourceB;
  o["sourceAB"] = s_st.sourceAB;
  o["sourceTank"] = s_st.sourceTank;
  if (isfinite(s_st.baseTargetC)) o["baseTargetC"] = s_st.baseTargetC; else o["baseTargetC"] = nullptr;
  if (isfinite(s_st.targetC)) o["targetC"] = s_st.targetC; else o["targetC"] = nullptr;
  if (isfinite(s_st.errorC)) o["errorC"] = s_st.errorC; else o["errorC"] = nullptr;
  if (isfinite(s_st.feedForwardPct)) o["feedForwardPct"] = s_st.feedForwardPct; else o["feedForwardPct"] = nullptr;
  if (isfinite(s_st.thermalPositionPct)) o["thermalPositionPct"] = s_st.thermalPositionPct; else o["thermalPositionPct"] = nullptr;
  o["hydraulicModelValid"] = s_st.hydraulicModelValid;
  o["hydraulicModelReason"] = s_st.hydraulicModelReason;
  o["targetReachable"] = s_st.targetReachable;
  o["targetReachabilityReason"] = s_st.targetReachabilityReason;
  o["positionPct"] = s_st.positionPct;
  o["positionTrusted"] = s_st.positionTrusted;
  o["moving"] = s_st.moving;
  o["movingManual"] = s_st.movingManual;
  o["pulseRequestedMs"] = s_st.pulseRequestedMs;
  o["pulseElapsedMs"] = s_st.pulseElapsedMs;
  o["pulseRemainingMs"] = s_st.pulseRemainingMs;
  if (isfinite(s_st.pulseStepPct)) o["pulseStepPct"] = s_st.pulseStepPct; else o["pulseStepPct"] = nullptr;
  o["trendCPerMin"] = s_st.trendCPerMin;
  o["responsePending"] = s_st.responsePending;
  if (isfinite(s_st.lastResponseDeltaC)) o["lastResponseDeltaC"] = s_st.lastResponseDeltaC; else o["lastResponseDeltaC"] = nullptr;
  if (isfinite(s_st.learnedRiseCPerPct)) o["learnedRiseCPerPct"] = s_st.learnedRiseCPerPct; else o["learnedRiseCPerPct"] = nullptr;
  if (isfinite(s_st.learnedFallCPerPct)) o["learnedFallCPerPct"] = s_st.learnedFallCPerPct; else o["learnedFallCPerPct"] = nullptr;
  o["lastDecisionMs"] = s_st.lastDecisionMs;
  o["nextDecisionInMs"] = s_st.nextDecisionInMs;
  o["lastCalibrationMs"] = s_st.lastCalibrationMs;
  o["lastCalibrationEnd"] = s_st.lastCalibrationEnd;
  o["floorProtectionActive"] = s_st.floorProtectionActive;
  o["relayOk"] = s_st.relayOk;
  o["relayMask"] = s_st.relayMask;
}

void applyConfigObject(JsonObjectConst o) {
  MixingValveConfig c = s_cfg;
  if (o.containsKey("enabled")) c.enabled = (bool)(o["enabled"] | false);
  if (o.containsKey("disabledAction")) c.disabledAction = String((const char*)(o["disabledAction"] | "hold"));
  if (o.containsKey("noHeatAction")) c.noHeatAction = String((const char*)(o["noHeatAction"] | "b"));
  if (o.containsKey("openingDirection")) c.openingDirection = String((const char*)(o["openingDirection"] | "normal"));
  if (o.containsKey("sourceA")) c.sourceA = String((const char*)(o["sourceA"] | "mix_a_dallas"));
  if (o.containsKey("sourceB")) c.sourceB = String((const char*)(o["sourceB"] | "mix_b_dallas"));
  if (o.containsKey("sourceAB")) c.sourceAB = String((const char*)(o["sourceAB"] | "mix_ab_dallas"));
  if (o.containsKey("sourceTank")) c.sourceTank = String((const char*)(o["sourceTank"] | "tank_top"));
  if (o.containsKey("tempMaxAgeMs")) c.tempMaxAgeMs = o["tempMaxAgeMs"].as<uint32_t>();
  if (o.containsKey("targetOffsetC")) c.targetOffsetC = o["targetOffsetC"].as<float>();
  if (o.containsKey("deadbandC")) c.deadbandC = o["deadbandC"].as<float>();
  if (o.containsKey("tankMinDeltaC")) c.tankMinDeltaC = o["tankMinDeltaC"].as<float>();
  if (o.containsKey("tankHysteresisC")) c.tankHysteresisC = o["tankHysteresisC"].as<float>();
  if (o.containsKey("controlPeriodMs")) c.controlPeriodMs = o["controlPeriodMs"].as<uint32_t>();
  if (o.containsKey("settleMinMs")) c.settleMinMs = o["settleMinMs"].as<uint32_t>();
  if (o.containsKey("responseTimeoutMs")) c.responseTimeoutMs = o["responseTimeoutMs"].as<uint32_t>();
  if (o.containsKey("settleTrendCPerMin")) c.settleTrendCPerMin = o["settleTrendCPerMin"].as<float>();
  if (o.containsKey("feedForwardEnabled")) c.feedForwardEnabled = (bool)(o["feedForwardEnabled"] | true);
  if (o.containsKey("minMixSpanC")) c.minMixSpanC = o["minMixSpanC"].as<float>();
  if (o.containsKey("minStepPct")) c.minStepPct = o["minStepPct"].as<float>();
  if (o.containsKey("maxStepPct")) c.maxStepPct = o["maxStepPct"].as<float>();
  if (o.containsKey("initialMaxStepPct")) c.initialMaxStepPct = o["initialMaxStepPct"].as<float>();
  if (o.containsKey("proportionalPctPerC")) c.proportionalPctPerC = o["proportionalPctPerC"].as<float>();
  if (o.containsKey("learnResponse")) c.learnResponse = (bool)(o["learnResponse"] | true);
  if (o.containsKey("inRangeAction")) c.inRangeAction = String((const char*)(o["inRangeAction"] | "hold"));
  if (o.containsKey("oppositeTrendAction")) c.oppositeTrendAction = String((const char*)(o["oppositeTrendAction"] | "wait_then_reverse"));
  if (o.containsKey("travelToAMs")) c.travelToAMs = o["travelToAMs"].as<uint32_t>();
  if (o.containsKey("travelToBMs")) c.travelToBMs = o["travelToBMs"].as<uint32_t>();
  if (o.containsKey("calibrationSeatMs")) c.calibrationSeatMs = o["calibrationSeatMs"].as<uint32_t>();
  if (o.containsKey("manualPulseMs")) c.manualPulseMs = o["manualPulseMs"].as<uint32_t>();
  if (o.containsKey("manualHoldMs")) c.manualHoldMs = o["manualHoldMs"].as<uint32_t>();
  if (o.containsKey("floorProtectionEnabled")) c.floorProtectionEnabled = (bool)(o["floorProtectionEnabled"] | true);
  if (o.containsKey("floorMaxC")) c.floorMaxC = o["floorMaxC"].as<float>();
  if (o.containsKey("floorReleaseHysteresisC")) c.floorReleaseHysteresisC = o["floorReleaseHysteresisC"].as<float>();

  s_cfg = c;
  sanitizeConfig();

  ConfigStore::BatchGuard batch;
  ConfigStore::setEqMixingEnabled(s_cfg.enabled);
  ConfigStore::setEqMixTempSourceA(s_cfg.sourceA);
  ConfigStore::setEqMixTempSourceB(s_cfg.sourceB);
  ConfigStore::setEqMixTempSourceAB(s_cfg.sourceAB);
  ConfigStore::setEqMixDeadbandC(s_cfg.deadbandC);
  ConfigStore::setEqMixTravelToAMs(s_cfg.travelToAMs);
  ConfigStore::setEqMixTravelToBMs(s_cfg.travelToBMs);
  ConfigStore::setEqMixTravelMs((s_cfg.travelToAMs + s_cfg.travelToBMs) / 2UL);
  ConfigStore::setEqMixCalibrationSeatMs(s_cfg.calibrationSeatMs);
  // Signed targetOffsetC is deliberately stored in newMix. The legacy setter
  // clamps negative values and therefore must not be authoritative anymore.
  saveAdvancedConfig();
}

bool executeAction(String action, String& err) {
  action.trim();
  action.toLowerCase();
  err = "";
  if (action == "stop") {
    stopMotion(true);
    resetResponse();
    s_manualHoldUntilMs = millis() + s_cfg.manualHoldMs;
    setState("manual_hold", "manual_stop");
    return true;
  }
  if (action == "pulse_a" || action == "pulse_b") {
    const int8_t dir = action.endsWith("a") ? DIR_A : DIR_B;
    resetResponse();
    if (!startMotion(dir, s_cfg.manualPulseMs, true, false, NAN, false, false,
                     100.0f * (float)s_cfg.manualPulseMs / (float)travelMsFor(dir))) {
      err = "mix_relay_write_failed";
      return false;
    }
    s_manualHoldUntilMs = millis() + s_cfg.manualPulseMs + s_cfg.manualHoldMs;
    return true;
  }
  if (action == "end_a" || action == "end_b" || action == "calibrate_a" || action == "calibrate_b") {
    const int8_t dir = action.endsWith("a") ? DIR_A : DIR_B;
    const bool calibration = action.startsWith("calibrate_");
    if (!startFullEnd(dir, true, calibration, false)) {
      err = "mix_relay_write_failed";
      return false;
    }
    s_manualHoldUntilMs = millis() + fullTravelMsFor(dir) + s_cfg.manualHoldMs;
    return true;
  }
  if (action == "invalidate") {
    stopMotion(true);
    invalidatePosition(true);
    resetResponse();
    setState("manual_hold", "position_invalidated");
    s_manualHoldUntilMs = millis() + s_cfg.manualHoldMs;
    return true;
  }
  err = "bad_action";
  return false;
}

} // namespace

void mixingValveInit() {
  if (s_inited) return;
  s_inited = true;
  ConfigStore::begin();
  TemperatureManager::begin();
  relaySetMixingInterlockRelays(MIX_RELAY_A, MIX_RELAY_B);
  loadFromStore();
  s_st = MixingValveStatus{};
  s_st.positionPct = 50.0f;
  s_st.positionTrusted = false;
  s_st.direction = "stop";
  setState("startup", "position_unreferenced");
  relayOff(true);
  Serial.println("[MIX] Init adaptive A/B/AB controller");
}

void mixingValveLoop() {
  mixingValveInit();
  const uint32_t now = millis();
  updateMotion(now);
  if (s_lastLoopMs != 0 && (uint32_t)(now - s_lastLoopMs) < LOOP_PERIOD_MS) {
    refreshStatusTiming(now);
    return;
  }
  s_lastLoopMs = now;
  readTemperatures(now);
  updateTargets();
  updateHeatLatch();
  controlAutomatic(now);
  refreshStatusTiming(now);
}

void mixingValveReloadFromStore() {
  mixingValveInit();
  const String oldDir = s_cfg.openingDirection;
  loadFromStore();
  relaySetMixingInterlockRelays(MIX_RELAY_A, MIX_RELAY_B);
  if (oldDir != s_cfg.openingDirection) {
    stopMotion(true);
    invalidatePosition(true);
  }
  resetAutomaticCycle();
}

MixingValveConfig mixingValveGetConfig() {
  mixingValveInit();
  return s_cfg;
}

MixingValveStatus mixingValveGetStatus() {
  mixingValveInit();
  mixingValveLoop();
  return s_st;
}

String mixingValveGetStatusJson() {
  mixingValveInit();
  mixingValveLoop();
  DynamicJsonDocument doc(12288);
  doc["ok"] = true;
  JsonObject cfg = doc.createNestedObject("config");
  fillConfigObject(cfg);
  JsonObject st = doc.createNestedObject("status");
  fillStatusObject(st);
  String out;
  serializeJson(doc, out);
  return out;
}

void mixingValveFillConfigJson(JsonObject& out) {
  mixingValveInit();
  fillConfigObject(out);
}

void mixingValveFillFastJson(JsonObject& out) {
  mixingValveInit();
  mixingValveLoop();
  out["en"] = s_cfg.enabled;
  out["ac"] = s_st.automaticAllowed;
  out["ha"] = s_st.heatAvailable;
  out["st"] = s_st.state;
  out["rs"] = s_st.reason;
  out["dir"] = s_st.direction;
  if (isfinite(s_st.aC)) out["ma"] = s_st.aC; else out["ma"] = nullptr;
  if (isfinite(s_st.bC)) out["mb"] = s_st.bC; else out["mb"] = nullptr;
  if (isfinite(s_st.abC)) out["mf"] = s_st.abC; else out["mf"] = nullptr;
  if (isfinite(s_st.tankC)) out["tk"] = s_st.tankC; else out["tk"] = nullptr;
  if (isfinite(s_st.baseTargetC)) out["bt"] = s_st.baseTargetC; else out["bt"] = nullptr;
  if (isfinite(s_st.targetC)) out["tf"] = s_st.targetC; else out["tf"] = nullptr;
  if (isfinite(s_st.errorC)) out["er"] = s_st.errorC; else out["er"] = nullptr;
  if (isfinite(s_st.feedForwardPct)) out["ff"] = s_st.feedForwardPct; else out["ff"] = nullptr;
  out["hm"] = s_st.hydraulicModelValid;
  out["hmr"] = s_st.hydraulicModelReason;
  out["rch"] = s_st.targetReachable;
  out["rchr"] = s_st.targetReachabilityReason;
  out["pct"] = s_st.positionPct;
  out["pt"] = s_st.positionTrusted;
  out["mv"] = s_st.moving;
  out["man"] = s_st.movingManual;
  out["prm"] = s_st.pulseRemainingMs;
  out["elp"] = s_st.pulseElapsedMs;
  out["tr"] = s_st.trendCPerMin;
  out["rsp"] = s_st.responsePending;
  out["nd"] = s_st.nextDecisionInMs;
  out["fp"] = s_st.floorProtectionActive;
}

bool mixingValveApplyConfig(const String& json, String* outErr) {
  mixingValveInit();
  DynamicJsonDocument doc(12288);
  const DeserializationError e = deserializeJson(doc, json);
  if (e || !doc.is<JsonObject>()) {
    if (outErr) *outErr = "bad_json";
    return false;
  }
  JsonObjectConst root = doc.as<JsonObjectConst>();
  if (root["mixing"].is<JsonObjectConst>()) root = root["mixing"].as<JsonObjectConst>();
  const String oldDir = s_cfg.openingDirection;
  applyConfigObject(root);
  if (oldDir != s_cfg.openingDirection) {
    stopMotion(true);
    invalidatePosition(true);
  }
  resetAutomaticCycle();
  TemperatureManager::invalidateAll();
  if (outErr) *outErr = "";
  mixingValveLoop();
  return true;
}

bool mixingValveHandleCmdJson(const String& json, String& outErr) {
  mixingValveInit();
  outErr = "";
  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, json) || !doc.is<JsonObject>()) {
    outErr = "bad_json";
    return false;
  }
  JsonObjectConst o = doc.as<JsonObjectConst>();

  if (o.containsKey("enabled")) {
    s_cfg.enabled = (bool)(o["enabled"] | false);
    ConfigStore::setEqMixingEnabled(s_cfg.enabled);
    saveAdvancedConfig();
    resetAutomaticCycle();
  }

  String action;
  if (o.containsKey("action")) action = String((const char*)(o["action"] | ""));
  else if (o.containsKey("mixPulse")) {
    String x = String((const char*)(o["mixPulse"] | "")); x.toLowerCase();
    if (x == "open" || x == "a") action = "pulse_a";
    else if (x == "close" || x == "b") action = "pulse_b";
    else if (x == "stop") action = "stop";
  } else if (o.containsKey("mixMove")) {
    String x = String((const char*)(o["mixMove"] | "")); x.toLowerCase();
    if (x == "open" || x == "a") action = "end_a";
    else if (x == "close" || x == "b") action = "end_b";
    else if (x == "stop") action = "stop";
  } else if (o.containsKey("mixCalibrate")) {
    String x = String((const char*)(o["mixCalibrate"] | "")); x.toLowerCase();
    if (x == "a" || x == "open") action = "calibrate_a";
    else if (x == "b" || x == "close" || x == "auto") action = "calibrate_b";
    else if (x == "invalidate") action = "invalidate";
  }

  if (action.length()) {
    // Optional per-command pulse duration for compatibility and service work.
    if ((action == "pulse_a" || action == "pulse_b") && o.containsKey("pulseMs")) {
      const uint32_t old = s_cfg.manualPulseMs;
      s_cfg.manualPulseMs = clampu32(o["pulseMs"].as<uint32_t>(), 50UL, 60000UL);
      const bool ok = executeAction(action, outErr);
      s_cfg.manualPulseMs = old;
      return ok;
    }
    return executeAction(action, outErr);
  }
  return true;
}

void mixingValveSetExternalBlock(bool blocked, const char* reason) {
  mixingValveInit();
  s_externalBlock = blocked;
  s_externalBlockReason = blocked && reason ? String(reason) : String();
  if (blocked) {
    resetResponse();
    s_initialApproachDone = false;
    if (s_motion.active && !s_motion.manual && !s_motion.dhw) stopMotion(true);
  } else {
    s_lastDecisionMs = 0;
  }
}

bool mixingValveDhwPrepare(bool openToA, bool& ready, String& outErr) {
  mixingValveInit();
  ready = false;
  outErr = "";
  const uint32_t now = millis();
  updateMotion(now);
  const int8_t dir = openToA ? DIR_A : DIR_B;

  if (s_dhwOverride && s_dhwDir != dir) {
    if (s_motion.active) stopMotion(true);
    s_dhwOverride = false;
    s_dhwDir = 0;
  }
  s_dhwOverride = true;
  s_dhwDir = dir;

  if (!s_motion.active && atTrustedEnd(dir)) {
    if (!relayOff(true)) {
      outErr = "mix_relay_write_failed";
      return false;
    }
    ready = true;
    setState("dhw_override", openToA ? "ready_a" : "ready_b");
    return true;
  }

  if (s_motion.active) {
    if (s_motion.dhw && s_motion.dir == dir) return true;
    stopMotion(true);
  }

  if (s_dhwRetryAfterMs && (int32_t)(s_dhwRetryAfterMs - now) > 0) {
    outErr = "mix_relay_retry_wait";
    return false;
  }
  if (!startFullEnd(dir, false, false, true)) {
    s_dhwRetryAfterMs = now + 1000UL;
    outErr = "mix_relay_write_failed";
    return false;
  }
  s_dhwRetryAfterMs = 0;
  setState("dhw_override", openToA ? "moving_a" : "moving_b");
  return true;
}

void mixingValveDhwRelease() {
  mixingValveInit();
  if (s_dhwOverride && s_motion.active && s_motion.dhw) stopMotion(true);
  s_dhwOverride = false;
  s_dhwDir = 0;
  s_dhwRetryAfterMs = 0;
  s_lastDecisionMs = 0;
  s_initialApproachDone = false;
}

void mixingValveBackgroundService() {
  mixingValveInit();
  const uint32_t now = millis();
  updateMotion(now);
  refreshStatusTiming(now);
}
