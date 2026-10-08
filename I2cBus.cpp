#include "I2cBus.h"

#include <Wire.h>
#include "config_pins.h"

static bool s_i2cReady = false;

namespace {
  static constexpr uint16_t kI2cTimeoutMs = 40;
  static constexpr uint8_t kRecoveryClockPulses = 9;
  static constexpr uint16_t kRecoveryHalfClockUs = 8;

  static bool beginWire() {
    const bool ok = Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
    if (ok) {
      Wire.setClock(I2C_FREQ_HZ);
      // Prevent a physically wedged bus from blocking the whole control loop for
      // an excessive time. Arduino-ESP32 3.x exposes this timeout directly.
      Wire.setTimeOut(kI2cTimeoutMs);
    }
    s_i2cReady = ok;
    return ok;
  }

  static inline void releaseLine(uint8_t pin) {
    pinMode(pin, OUTPUT_OPEN_DRAIN);
    digitalWrite(pin, HIGH); // open drain HIGH = released to the pull-up
  }
}

void i2cInit() {
  if (s_i2cReady) return;
  (void)beginWire();
}

bool i2cIsReady() {
  return s_i2cReady;
}

bool i2cRecover() {
  // Restart both the Arduino Wire driver and the physical bus. A simple
  // initTca() retry is not sufficient if the ESP32 I2C peripheral or a slave
  // remains in the middle of a byte after a disturbed transaction.
  Wire.end();
  s_i2cReady = false;
  delayMicroseconds(20);

  releaseLine(I2C_SDA_PIN);
  releaseLine(I2C_SCL_PIN);
  delayMicroseconds(kRecoveryHalfClockUs);

  // If a slave is holding SDA low, clock it out of the unfinished transfer.
  // Nine clocks cover the remaining bits plus ACK of one I2C byte.
  for (uint8_t i = 0; i < kRecoveryClockPulses && digitalRead(I2C_SDA_PIN) == LOW; ++i) {
    digitalWrite(I2C_SCL_PIN, LOW);
    delayMicroseconds(kRecoveryHalfClockUs);
    digitalWrite(I2C_SCL_PIN, HIGH);
    delayMicroseconds(kRecoveryHalfClockUs);
  }

  // Generate an explicit STOP: SDA low while SCL is released high, then SDA high.
  digitalWrite(I2C_SDA_PIN, LOW);
  delayMicroseconds(kRecoveryHalfClockUs);
  digitalWrite(I2C_SCL_PIN, HIGH);
  delayMicroseconds(kRecoveryHalfClockUs);
  digitalWrite(I2C_SDA_PIN, HIGH);
  delayMicroseconds(kRecoveryHalfClockUs);

  pinMode(I2C_SDA_PIN, INPUT_PULLUP);
  pinMode(I2C_SCL_PIN, INPUT_PULLUP);
  delayMicroseconds(20);

  return beginWire();
}
