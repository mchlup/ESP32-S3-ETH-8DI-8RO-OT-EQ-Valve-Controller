#pragma once

#include <Arduino.h>

// Centralized I2C init for the board.
void i2cInit();
bool i2cIsReady();

// Force a physical + driver-level recovery of the shared I2C bus.
// Intended for rare fault handling when the TCA9554/RTC bus remains wedged
// after a failed transaction. The routine releases SDA/SCL, clocks a stuck
// slave up to 9 times, generates a STOP condition and restarts Wire.
bool i2cRecover();
