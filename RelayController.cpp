#include "RelayController.h"
#include <Wire.h>
#include "I2cBus.h"
#include "config_pins.h"
#include "RetryPolicy.h"
#include "Log.h"

// Minimal driver for TCA9554 output register
static constexpr uint8_t REG_INPUT  = 0x00;
static constexpr uint8_t REG_OUTPUT = 0x01;
static constexpr uint8_t REG_POL    = 0x02;
static constexpr uint8_t REG_CFG    = 0x03;

static bool s_ok = false;
static uint8_t s_mask = 0x00; // logical ON bits (bit0=R1 ... bit7=R8)

// Safety interlock: configured mixing valve relays must never be ON at the same time.
// Default remains R1/R2, but Equitherm can remap the pair.
static uint8_t s_mixInterlockOpenIdx = 0;
static uint8_t s_mixInterlockCloseIdx = 1;

static inline void applyMixingInterlock(uint8_t& logicalMask) {
  if (s_mixInterlockOpenIdx >= RELAY_COUNT || s_mixInterlockCloseIdx >= RELAY_COUNT) return;
  if (s_mixInterlockOpenIdx == s_mixInterlockCloseIdx) return;

  const uint8_t openBit = (uint8_t)(1U << s_mixInterlockOpenIdx);
  const uint8_t closeBit = (uint8_t)(1U << s_mixInterlockCloseIdx);
  const uint8_t bothBits = (uint8_t)(openBit | closeBit);
  if ((logicalMask & bothBits) == bothBits) {
    logicalMask &= (uint8_t)~bothBits;
    LOGW("RELAY interlock: R%u+R%u requested -> forcing OFF",
         (unsigned)(s_mixInterlockOpenIdx + 1),
         (unsigned)(s_mixInterlockCloseIdx + 1));
  }
}

// ---- Non-blocking apply state ----
static bool     s_applyPending = false;
static uint8_t  s_pendingMask  = 0x00;
static RetryPolicy s_applyRetry(50, 1.7f, 1000, 0.2f);
static RetryPolicy s_recoverRetry(500, 1.7f, 30000, 0.2f);

// ---- Telemetry ----
static uint32_t s_i2cErrors     = 0;
static uint32_t s_i2cRecoveries = 0;
static uint32_t s_lastI2cErrMs  = 0;
static char     s_lastI2cErr[96] = {0};
static uint32_t s_lastI2cLogMs  = 0;

// Last verified TCA9554 register snapshot. REG_OUTPUT is only the output latch;
// it can read back correctly even when REG_CFG was corrupted back to inputs.
// REG_INPUT is therefore also checked so the software state cannot claim that
// R1/R2 changed direction while the expander pins are not actually driving it.
static bool    s_hwSnapshotValid = false;
static uint8_t s_lastHwOutputReg = 0x00;
static uint8_t s_lastHwInputReg  = 0x00;
static uint8_t s_lastHwConfigReg = 0xFF;
static uint8_t s_lastHwPolReg    = 0x00;

// Pokud by se ukázalo, že relé je active-low, přepni na 1.
#ifndef RELAY_ACTIVE_LOW
#define RELAY_ACTIVE_LOW 0
#endif

static uint8_t toHw(uint8_t logicalMask) {
#if RELAY_ACTIVE_LOW
  return (uint8_t)~logicalMask;
#else
  return logicalMask;
#endif
}

static uint8_t fromHw(uint8_t hwMask) {
#if RELAY_ACTIVE_LOW
  return (uint8_t)~hwMask;
#else
  return hwMask;
#endif
}

static void noteI2cErrorThrottled(const char* msg) {
  s_i2cErrors++;
  s_lastI2cErrMs = millis();
  if (msg) {
    snprintf(s_lastI2cErr, sizeof(s_lastI2cErr), "%s", msg);
  }

  const uint32_t now = s_lastI2cErrMs;
  // Throttle: do not spam Serial during bus faults
  if ((uint32_t)(now - s_lastI2cLogMs) >= 5000) {
    s_lastI2cLogMs = now;
    LOGW("RELAY I2C error: %s", s_lastI2cErr);
  }
}

static bool writeRegRaw(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(TCA9554_ADDR);
  Wire.write(reg);
  Wire.write(val);
  const uint8_t rc = Wire.endTransmission();
  if (rc != 0) {
    char buf[64];
    snprintf(buf, sizeof(buf), "write reg 0x%02X rc=%u", reg, (unsigned)rc);
    noteI2cErrorThrottled(buf);
    return false;
  }
  return true;
}

static bool readRegRaw(uint8_t reg, uint8_t &out) {
  Wire.beginTransmission(TCA9554_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    char buf[64];
    snprintf(buf, sizeof(buf), "read reg 0x%02X addrNACK", reg);
    noteI2cErrorThrottled(buf);
    return false;
  }
  const uint8_t n = Wire.requestFrom((int)TCA9554_ADDR, 1);
  if (n != 1) {
    char buf[64];
    snprintf(buf, sizeof(buf), "read reg 0x%02X req=%u", reg, (unsigned)n);
    noteI2cErrorThrottled(buf);
    return false;
  }
  out = Wire.read();
  return true;
}

static bool verifyTcaState(uint8_t expectedLogicalMask, const char* context) {
  const uint8_t expectedHw = toHw(expectedLogicalMask);
  uint8_t outReg = 0, inReg = 0, cfgReg = 0xFF, polReg = 0xFF;

  const bool readOk = readRegRaw(REG_OUTPUT, outReg)
      && readRegRaw(REG_INPUT, inReg)
      && readRegRaw(REG_CFG, cfgReg)
      && readRegRaw(REG_POL, polReg);

  if (readOk) {
    s_lastHwOutputReg = outReg;
    s_lastHwInputReg = inReg;
    s_lastHwConfigReg = cfgReg;
    s_lastHwPolReg = polReg;
    s_hwSnapshotValid = true;
  } else {
    s_hwSnapshotValid = false;
    return false;
  }

  const bool ok = outReg == expectedHw
      && inReg == expectedHw
      && cfgReg == 0x00
      && polReg == 0x00;
  if (!ok) {
    char buf[96];
    snprintf(buf, sizeof(buf),
             "%s state mismatch out=%02X in=%02X cfg=%02X pol=%02X exp=%02X",
             context ? context : "verify",
             (unsigned)outReg, (unsigned)inReg, (unsigned)cfgReg,
             (unsigned)polReg, (unsigned)expectedHw);
    noteI2cErrorThrottled(buf);
  }
  return ok;
}

static bool initTca();

static bool recoverTcaNow() {
  // A controller restart used to be the only way out of some rare Wire/TCA9554
  // lockups. Recover the shared bus in-place, then reinitialize and verify the
  // expander using the current desired logical mask.
  if (!i2cRecover()) {
    s_ok = false;
    s_recoverRetry.onFail(millis());
    return false;
  }
  const bool ok = initTca();
  if (ok) {
    s_ok = true;
    s_i2cRecoveries++;
    s_recoverRetry.onSuccess(millis());
    s_applyPending = false; // initTca() already wrote + verified s_mask
    s_applyRetry.onSuccess(millis());
    return true;
  }

  s_ok = false;
  s_recoverRetry.onFail(millis());
  return false;
}

static void scheduleApply(uint8_t logicalMask) {
  s_applyPending = true;
  s_pendingMask  = logicalMask;
  s_applyRetry.reset(millis());
}

static void processPending(uint32_t now) {
  if (!s_applyPending) return;
  if (!s_ok) return;
  if (!s_applyRetry.canAttempt(now)) return;

  const uint8_t hw = toHw(s_pendingMask);

  bool ok = writeRegRaw(REG_OUTPUT, hw);
  if (ok) ok = verifyTcaState(s_pendingMask, "pending");

  if (ok) {
    s_applyPending = false;
    s_applyRetry.onSuccess(now);
    return;
  }

  // A complete-state verification failed. Repeating only the output-latch
  // write cannot repair a corrupted direction/configuration register, so hand
  // control to the full bus/TCA recovery path immediately.
  s_applyRetry.onFail(now);
  s_ok = false;
}

// Apply one complete logical mask synchronously and verify the TCA9554 output
// register. This is used by the mixing-valve pair so the control state is only
// advanced after the physical expander accepted the complete R1/R2 state.
static bool applyMaskImmediate(uint8_t logicalMask, bool forceBusRecovery) {
  applyMixingInterlock(logicalMask);
  s_pendingMask = logicalMask;
  s_applyPending = true;

  if (!s_ok) {
    if (!forceBusRecovery || !recoverTcaNow()) {
      scheduleApply(logicalMask);
      return false;
    }
    // recoverTcaNow() re-applied and verified s_mask. The caller always updates
    // s_mask before entering this function, so the requested mask is complete.
    return true;
  }

  const uint8_t hw = toHw(logicalMask);
  bool ok = writeRegRaw(REG_OUTPUT, hw);
  if (ok) ok = verifyTcaState(logicalMask, "immediate");

  if (ok) {
    s_applyPending = false;
    s_applyRetry.onSuccess(millis());
    return true;
  }

  // A failed immediate command is a bus-health event. For safety-critical OFF
  // or explicit manual commands we perform one full driver/physical bus recovery
  // immediately. Automatic regulation can fall back to the non-blocking recovery
  // path to avoid repeatedly resetting the bus every 200 ms.
  s_ok = false;
  if (forceBusRecovery && recoverTcaNow()) {
    return true;
  }

  scheduleApply(logicalMask);
  return false;
}

static bool initTca() {
  i2cInit();

  // TCA9554 powers up with REG_OUTPUT=0xFF and REG_CFG=0xFF (all inputs).
  // Preload the desired output latch BEFORE changing the pins to outputs. If the
  // chip has reset, writing CFG first would briefly drive all eight relay lines
  // high, including both directions of the mixing actuator.
  const uint8_t hw = toHw(s_mask);
  if (!writeRegRaw(REG_POL, 0x00)) return false;
  if (!writeRegRaw(REG_OUTPUT, hw)) return false;
  if (!writeRegRaw(REG_CFG, 0x00)) return false;
  delayMicroseconds(50);

  return verifyTcaState(s_mask, "init");
}

void relayInit() {
  s_mask = 0x00;        // default OFF
  s_hwSnapshotValid = false;
  scheduleApply(s_mask);
  s_ok = initTca();
  if (s_ok) {
    s_i2cRecoveries++; // first successful init
    s_recoverRetry.onSuccess(millis());
    processPending(millis());
  }
}

void relayUpdate() {
  const uint32_t now = millis();

  // Apply pending mask if needed (non-blocking)
  processPending(now);

  // Periodic health-check. Checking REG_OUTPUT alone is insufficient because
  // it is only a latch; REG_CFG may have reset to inputs while the latch still
  // contains the requested R1/R2 mask. Verify actual pin level as well.
  static uint32_t lastCheckMs = 0;
  if (s_ok && (uint32_t)(now - lastCheckMs) >= 1000) {
    lastCheckMs = now;
    if (!verifyTcaState(s_mask, "health")) s_ok = false;
  }

  // Auto-recovery if expander is not OK
  if (!s_ok) {
    if (!s_recoverRetry.canAttempt(now)) return;

    // Reinitialize the ESP32 I2C peripheral and physically recover the bus before
    // reinitializing the expander. This is what allows the relay subsystem to
    // recover without rebooting the whole controller.
    if (recoverTcaNow()) {
      // recoverTcaNow() already wrote and verified s_mask.
      s_applyPending = false;
    }
  }
}

void relaySet(RelayId id, bool on) {
  if ((uint8_t)id >= RELAY_COUNT) return;

  const uint8_t idx = (uint8_t)id;
  if (idx == s_mixInterlockOpenIdx || idx == s_mixInterlockCloseIdx) {
    // Generic single-relay writes would bypass the valve pulse state machine and
    // corrupt its position estimate. Mixing outputs must use
    // relaySetMixingDirection(), which applies the pair atomically and verifies it.
    LOGW("RELAY reserved mixing output R%u ignored by generic relaySet", (unsigned)(idx + 1));
    return;
  }

  const uint8_t bit = (uint8_t)(1U << idx);
  if (on) s_mask |= bit;
  else    s_mask &= (uint8_t)~bit;

  applyMixingInterlock(s_mask);

  scheduleApply(s_mask);
  processPending(millis());
}

void relayToggle(RelayId id) {
  relaySet(id, !relayGetState(id));
}

bool relayGetState(RelayId id) {
  if ((uint8_t)id >= RELAY_COUNT) return false;
  return (s_mask & (1U << (uint8_t)id)) != 0;
}

void relayAllOff() {
  relaySetMask(0x00);
}

void relayAllOn() {
  relaySetMask(0xFF);
}

void relaySetMixingInterlockRelays(uint8_t openRelayIndex, uint8_t closeRelayIndex) {
  if (openRelayIndex >= RELAY_COUNT) openRelayIndex = 0;
  if (closeRelayIndex >= RELAY_COUNT) closeRelayIndex = 1;
  if (openRelayIndex == closeRelayIndex) closeRelayIndex = (openRelayIndex == 0 ? 1 : 0);

  s_mixInterlockOpenIdx = openRelayIndex;
  s_mixInterlockCloseIdx = closeRelayIndex;

  applyMixingInterlock(s_mask);
  scheduleApply(s_mask);
  processPending(millis());
}

bool relaySetMixingDirection(int8_t direction, uint8_t* appliedMask, bool forceBusRecovery) {
  if (direction < -1 || direction > 1) return false;
  if (s_mixInterlockOpenIdx >= RELAY_COUNT || s_mixInterlockCloseIdx >= RELAY_COUNT) return false;
  if (s_mixInterlockOpenIdx == s_mixInterlockCloseIdx) return false;

  const uint8_t openBit = (uint8_t)(1U << s_mixInterlockOpenIdx);
  const uint8_t closeBit = (uint8_t)(1U << s_mixInterlockCloseIdx);
  const uint8_t pairBits = (uint8_t)(openBit | closeBit);

  uint8_t targetMask = (uint8_t)(s_mask & (uint8_t)~pairBits);
  if (direction > 0) targetMask |= openBit;
  else if (direction < 0) targetMask |= closeBit;

  // Update the desired logical state first so diagnostics and retry handling use
  // the same target. The immediate write below verifies the actual expander state.
  s_mask = targetMask;
  const bool ok = applyMaskImmediate(targetMask, forceBusRecovery);
  if (ok) {
    if (appliedMask) *appliedMask = s_mask;
    return true;
  }

  // Fail safe: a failed ON command must not be applied later by the retry queue
  // after the controller has already rejected the pulse. Keep both valve relays OFF.
  const uint8_t safeMask = (uint8_t)(s_mask & (uint8_t)~pairBits);
  s_mask = safeMask;
  (void)applyMaskImmediate(safeMask, true);
  if (appliedMask) *appliedMask = s_mask;
  return false;
}

uint8_t relayGetMask() {
  return s_mask;
}

void relaySetMask(uint8_t mask) {
  s_mask = mask;
  applyMixingInterlock(s_mask);
  scheduleApply(s_mask);
  processPending(millis());
}

// !!! Print& (ne Stream&) – aby sedělo na LogicController/.ino
void relayPrintStates(Print &out) {
  out.print(F("[RELAY] mask=0b"));
  for (int i = 7; i >= 0; i--) out.print((s_mask >> i) & 1);
  out.print(F(" ["));
  for (uint8_t i = 0; i < RELAY_COUNT; i++) {
    out.print(F("R")); out.print(i + 1);
    out.print(F("=")); out.print(relayGetState((RelayId)i) ? F("ON") : F("OFF"));
    if (i != RELAY_COUNT - 1) out.print(F(", "));
  }
  out.println(F("]"));
}

// --- Diagnostics / telemetry ---
uint32_t relayGetI2cErrorCount() {
  return s_i2cErrors;
}

uint32_t relayGetI2cRecoveryCount() {
  return s_i2cRecoveries;
}

uint32_t relayGetI2cLastErrorMs() {
  return s_lastI2cErrMs;
}

const char* relayGetI2cLastError() {
  return s_lastI2cErr;
}

bool relayIsOk() {
  return s_ok;
}

uint32_t relayGetI2cNextRetryInMs() {
  const uint32_t now = millis();
  if (s_ok) return 0;
  const uint32_t nextAt = s_recoverRetry.nextAttemptAt();
  if ((int32_t)(nextAt - now) <= 0) return 0;
  return nextAt - now;
}

uint32_t relayGetI2cFailCount() {
  return (uint32_t)s_recoverRetry.failCount();
}

bool relayGetHardwareSnapshot(uint8_t* logicalPinMask, uint8_t* outputReg,
                              uint8_t* configReg, uint8_t* polarityReg) {
  if (!s_hwSnapshotValid) return false;
  if (logicalPinMask) *logicalPinMask = fromHw(s_lastHwInputReg);
  if (outputReg) *outputReg = s_lastHwOutputReg;
  if (configReg) *configReg = s_lastHwConfigReg;
  if (polarityReg) *polarityReg = s_lastHwPolReg;
  return true;
}
