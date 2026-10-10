#include "RtcController.h"
#include "config_pins.h"
#include "I2cBus.h"

#include <Wire.h>
#include <time.h>
#include <stdint.h>
#include <string.h>

// Waveshare board: PCF85063ATL on the same I2C bus as the relay expander.
// RTC registers are stored in UTC. The configured POSIX TZ is only applied
// when displaying local time, so DST never shifts the persisted RTC clock.
namespace {
  static constexpr uint8_t RTC_ADDR = 0x51;
  static constexpr uint8_t REG_SEC  = 0x04; // seconds, bit 7: oscillator stop
  static bool s_present = false;

  uint8_t bcd2bin(uint8_t v) { return (uint8_t)((v & 0x0Fu) + 10u * ((v >> 4) & 0x0Fu)); }
  uint8_t bin2bcd(uint8_t v) { return (uint8_t)(((v / 10u) << 4) | (v % 10u)); }

  bool leapYear(unsigned y) { return (y % 4u == 0u) && ((y % 100u != 0u) || (y % 400u == 0u)); }

  unsigned monthDays(unsigned y, unsigned m) {
    static const uint8_t days[12] = {31,28,31,30,31,30,31,31,30,31,30,31};
    if (m < 1 || m > 12) return 0;
    return (unsigned)days[m - 1] + ((m == 2 && leapYear(y)) ? 1u : 0u);
  }

  // Gregorian UTC calendar -> days since 1970-01-01. Not mktime(): mktime()
  // applies the configured local timezone and is wrong at CET/CEST changes.
  int64_t utcDaysFromCivil(int y, unsigned m, unsigned d) {
    y -= (m <= 2);
    const int era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153u * (m + (m > 2 ? (unsigned)-3 : 9u)) + 2u) / 5u + d - 1u;
    const unsigned ycycle = yoe * 365u + yoe / 4u - yoe / 100u + doy;
    return (int64_t)era * 146097 + (int64_t)ycycle - 719468;
  }

  bool readRegisters(uint8_t reg, uint8_t* buf, size_t size) {
    Wire.beginTransmission(RTC_ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((int)RTC_ADDR, (int)size) != (int)size) return false;
    for (size_t i = 0; i < size; ++i) buf[i] = (uint8_t)Wire.read();
    return true;
  }

  bool writeRegisters(uint8_t reg, const uint8_t* buf, size_t size) {
    Wire.beginTransmission(RTC_ADDR);
    Wire.write(reg);
    for (size_t i = 0; i < size; ++i) Wire.write(buf[i]);
    return Wire.endTransmission() == 0;
  }
}

void rtcInit() {
  i2cInit();
  Wire.beginTransmission(RTC_ADDR);
  s_present = (Wire.endTransmission() == 0);
  Serial.println(s_present ? F("[RTC] PCF85063 detected (0x51)") : F("[RTC] PCF85063 not detected"));
}

bool rtcIsPresent() { return s_present; }

bool rtcGetEpoch(time_t& outEpoch) {
  if (!s_present) return false;
  uint8_t data[7] = {0};
  if (!readRegisters(REG_SEC, data, sizeof(data))) return false;
  // An oscillator-stop event means the calendar is *not* trustworthy.
  if (data[0] & 0x80u) {
    Serial.println(F("[RTC] Oscillator-stop flag: refusing stale clock"));
    return false;
  }

  const unsigned sec = bcd2bin(data[0] & 0x7Fu);
  const unsigned min = bcd2bin(data[1] & 0x7Fu);
  const unsigned hour = bcd2bin(data[2] & 0x3Fu);
  const unsigned day = bcd2bin(data[3] & 0x3Fu);
  const unsigned month = bcd2bin(data[5] & 0x1Fu);
  const unsigned year = 2000u + bcd2bin(data[6]);

  if (year < 2023u || year > 2099u || month < 1u || month > 12u ||
      day < 1u || day > monthDays(year, month) ||
      sec > 59u || min > 59u || hour > 23u) {
    Serial.println(F("[RTC] Invalid stored UTC date"));
    return false;
  }

  const int64_t unixSeconds = utcDaysFromCivil((int)year, month, day) * 86400 +
                              (int64_t)hour * 3600 + (int64_t)min * 60 + sec;
  if (unixSeconds <= 1672531200LL ||
      (sizeof(time_t) < 8 && unixSeconds > 2147483647LL)) return false;
  outEpoch = (time_t)unixSeconds;
  return true;
}

bool rtcSetEpoch(time_t epoch) {
  if (!s_present || epoch <= (time_t)1672531200) return false;
  struct tm utc = {};
  if (!gmtime_r(&epoch, &utc)) return false;
  const unsigned year = (unsigned)(utc.tm_year + 1900);
  if (year < 2023u || year > 2099u) return false;
  uint8_t data[7] = {
    (uint8_t)(bin2bcd((uint8_t)utc.tm_sec) & 0x7Fu), // clear OS flag
    (uint8_t)(bin2bcd((uint8_t)utc.tm_min) & 0x7Fu),
    (uint8_t)(bin2bcd((uint8_t)utc.tm_hour) & 0x3Fu),
    (uint8_t)(bin2bcd((uint8_t)utc.tm_mday) & 0x3Fu),
    (uint8_t)bin2bcd((uint8_t)utc.tm_wday), // PCF85063 uses Sunday=0
    (uint8_t)(bin2bcd((uint8_t)(utc.tm_mon + 1)) & 0x1Fu),
    bin2bcd((uint8_t)(year - 2000u))
  };
  if (!writeRegisters(REG_SEC, data, sizeof(data))) {
    Serial.println(F("[RTC] Write failed"));
    return false;
  }
  Serial.println(F("[RTC] UTC synchronized"));
  return true;
}
