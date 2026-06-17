# PRD: FW-MAG — Magnetometer Data Acquisition (Firmware)

**Author:** Alejandro Valdez
**Date:** 2026-04-02
**Status:** Draft
**Priority:** P1
**Repo:** `brevitest-device-SPU_Firmware_v69_AV`
**File:** `firmware/src/brevitest-firmware.ino`

---

## 1. Problem Statement

The BIMS (Bioscale Operations System) reads the `magnet_validation` Particle variable from the SPU to fetch magnetometer test results. After 3 consecutive physical test runs on the same SPU, the variable returns identical data every time. The BIMS cannot distinguish between runs, and cannot confirm whether new test data was actually acquired.

## 2. Current Data Flow

```
Physical test triggered (magnetometer cartridge inserted into SPU)
  │
  ▼
Firmware: barcode scan detects magnetometer prefix
  │
  ▼
Firmware: state → VALIDATING_MAGNETOMETER
  │
  ▼
Firmware: heater_debounced() → magnet_validation_loop()
  │
  ▼
validate_magnets()
  ├── BLE.scan() for magnetometer device (matches barcode UUID)
  ├── BLE.connect(magnetometer_address)
  ├── create_magnet_validation_file()
  │     └── opens /validation/<unix_timestamp>.txt
  ├── check_magnets_in_one_well(0..4, fd)
  │     └── reads BleCharacteristic for each well
  │     └── writes "wellNum\tT\tX\tY\tZ\tT\tX\tY\tZ\tT\tX\tY\tZ\r\n" per well
  ├── close_magnet_validation_file(fd)
  └── magnetometer.disconnect()
  │
  ▼
load_latest_magnet_validation(false)
  ├── opendir("/validation")
  ├── find file with highest timestamp in filename
  ├── read(fd, magnet_validation_data, MAGNETOMETER_BUFFER_SIZE)  ← BUG: no null termination
  └── close(fd)
  │
  ▼
Particle variable "magnet_validation" → bound to magnet_validation_data buffer
  │
  ▼
BIMS: GET https://api.particle.io/v1/devices/{id}/magnet_validation
  └── Returns the buffer contents as a string
```

## 3. Identified Issues

### 3.1 No Null Termination After File Read (Bug)

**File:** `brevitest-firmware.ino` line ~1255

```cpp
bytes_read = read(fd, magnet_validation_data, MAGNETOMETER_BUFFER_SIZE);
close(fd);
// BUG: missing magnet_validation_data[bytes_read] = '\0';
```

If a new test file is shorter than or equal to the previous one, stale data from the old buffer persists. The Particle API returns the full buffer up to the old null terminator, making new results look identical to old ones.

**Fix:**
```cpp
bytes_read = read(fd, magnet_validation_data, MAGNETOMETER_BUFFER_SIZE - 1);
magnet_validation_data[bytes_read] = '\0';
close(fd);
```

### 3.2 No Test Counter or Timestamp in Variable

The `magnet_validation_data` buffer contains the file contents which start with the filename (includes timestamp), followed by column headers, followed by well data. However:

- The filename line format is `/validation/<timestamp>.txt` which acts as a de facto test ID
- But if the BIMS parser skips non-numeric first lines, the test ID is lost
- There is no explicit, machine-readable test counter that increments per run

**Recommendation:** Prepend a counter line to the variable data:

```
#<3-digit-counter>\t<unix-timestamp>\r\n
```

Example: `#004\t1743566400\r\n` followed by well data.

This allows BIMS to detect changes by comparing the counter/timestamp without parsing the full data.

### 3.3 No Cloud Function to Reload Variable

The `particle_command(73)` loads the latest validation file into the buffer, but it is only accessible via serial port — not exposed as a Particle cloud function.

**Current cloud functions:**
- `run_test` (test_runner) — takes a cartridge barcode ID, not a command number
- `load_assay`, `set_wifi_credentials`, `reset_cartridge`, `get_state`, etc.

**Recommendation:** Expose a new cloud function:

```cpp
Particle.function("reload_mag", reload_magnet_validation);

int reload_magnet_validation(String arg) {
    return load_latest_magnet_validation(false);
}
```

This allows BIMS to force the device to reload the latest file into the variable before reading it, ensuring fresh data.

### 3.4 File Accumulation Risk

`MAGNETOMETER_MAX_FILES` is set to 50. The directory scan in `load_latest_magnet_validation()` stops after 50 entries. If more than 50 test files accumulate in `/validation/`, the function may not find the latest file.

**Recommendation:** Either:
- Auto-clean old files after successful validation (keep last N)
- Or increase the limit
- Or use `clear_validation_files()` (command 72) periodically

## 4. What BIMS Expects

BIMS reads the `magnet_validation` variable and expects:

**Input format (tab-separated, one line per well):**
```
1\t44.6\t101.2\t-157.3\t3952.1\t44.4\t79.1\t-146.2\t4196.3\t44.5\t64.0\t-185.1\t4264.2
2\t44.5\t98.7\t-155.1\t3908.4\t44.3\t77.8\t-144.9\t4156.1\t44.4\t62.8\t-183.7\t4260.8
3\t...
4\t...
5\t...
```

**Per line:** `wellNumber\tchA_T\tchA_X\tchA_Y\tchA_Z\tchB_T\tchB_X\tchB_Y\tchB_Z\tchC_T\tchC_X\tchC_Y\tchC_Z`

- Wells: 1–5
- Channels: A, B, C (each has Temperature, X, Y, Z gauss values)
- BIMS evaluates Z values against criteria (default: 3900–4500 gauss)
- Lines starting with `#` are treated as metadata (counter/timestamp)
- Lines not matching `/^\d+\t/` are skipped (headers, filenames, etc.)

**What BIMS needs to detect a new test:**
- A different raw string than the last fetch (currently the only method)
- Ideally: a `#counter\ttimestamp` line that changes per test

## 5. Proposed Firmware Changes

| # | Change | File/Line | Priority |
|---|--------|-----------|----------|
| 1 | Null-terminate buffer after `read()` | `brevitest-firmware.ino` ~L1255 | Critical |
| 2 | Add `#counter\ttimestamp` line to variable | `magnet_validation_loop()` or `load_latest_magnet_validation()` | High |
| 3 | Expose `reload_mag` cloud function | `setup()` ~L4801 | Medium |
| 4 | Auto-clean old validation files (keep last 10) | After `close_magnet_validation_file()` | Low |

### Change 1: Null-terminate buffer

```cpp
// In load_latest_magnet_validation(), after read():
bytes_read = read(fd, magnet_validation_data, MAGNETOMETER_BUFFER_SIZE - 1);
magnet_validation_data[bytes_read] = '\0';
close(fd);
```

### Change 2: Prepend counter/timestamp

After `load_latest_magnet_validation()` loads the file, prepend a metadata line:

```cpp
// In magnet_validation_loop(), after load_latest_magnet_validation():
static int mag_test_counter = 0;
mag_test_counter++;
char header[32];
snprintf(header, sizeof(header), "#%03d\t%lu\r\n", mag_test_counter, (unsigned long)Time.now());

// Shift existing data and prepend header
int header_len = strlen(header);
int data_len = strlen(magnet_validation_data);
if (header_len + data_len < MAGNETOMETER_BUFFER_SIZE) {
    memmove(magnet_validation_data + header_len, magnet_validation_data, data_len + 1);
    memcpy(magnet_validation_data, header, header_len);
}
```

### Change 3: Expose reload function

```cpp
// Add to setup():
Particle.function("reload_mag", reload_magnet_validation);

// New function:
int reload_magnet_validation(String arg) {
    return load_latest_magnet_validation(false);
}
```

### Change 4: Auto-clean old files

```cpp
// After close_magnet_validation_file() in validate_magnets():
// Delete all but the 10 most recent files in /validation/
void cleanup_old_validation_files(int keep_count = 10) {
    // ... list files, sort by timestamp, delete oldest if count > keep_count
}
```

## 6. Testing

### After firmware update:

1. **Null termination test:**
   - Run 3 magnetometer tests back-to-back
   - Read `magnet_validation` variable after each
   - Confirm data changes between runs (different timestamp in `#counter` line)

2. **Counter test:**
   - Verify `#001`, `#002`, `#003` appear in the variable
   - Verify BIMS poll endpoint detects changes via counter

3. **Reload function test:**
   - Call `reload_mag` via Particle console
   - Verify variable refreshes with latest file data

4. **BIMS integration test:**
   - Physical test on SPU → BIMS fetch → confirm new session with unique data
   - Run 3 tests → confirm 3 distinct sessions in BIMS with different timestamps

## 7. BIMS-Side Changes (Already Done)

The BIMS is ready to consume the updated data:
- Poll endpoint already parses `#counter\ttimestamp` lines for change detection
- Fetch results page shows data inline (no redirect)
- Every fetch is logged as a ValidationSession
- SPU DHR only updates on pass
- Session history visible on SPU detail page

## 8. Reference Files

**Firmware:**
- `firmware/src/brevitest-firmware.ino` — main firmware
- `firmware/src/brevitest-firmware.h` — constants (MAGNETOMETER_MAX_FILES = 50, MAGNETOMETER_BUFFER_SIZE)
- `magnetometer/src/magnetometer-v2.ino` — magnetometer cartridge firmware (BLE peripheral)

**BIMS:**
- `src/routes/validation/magnetometer/+page.server.ts` — fetch action
- `src/routes/api/validation/magnetometer/poll/+server.ts` — auto-poll endpoint
- `src/lib/server/particle.ts` — Particle API client (callFunction, getVariable)
- `src/lib/server/db/models/validation-session.ts` — session model
