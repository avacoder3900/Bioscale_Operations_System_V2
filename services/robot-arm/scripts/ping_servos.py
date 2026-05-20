#!/usr/bin/env python3
"""
Ping every servo ID 1..MAX on a Feetech bus and report ones that respond.

Usage:
    python scripts/ping_servos.py [--port /dev/cu.usbmodemXXX] [--baud 1000000] [--max-id 20]

The SO-100 / SO-ARM100 follower has 6 STS3215 servos at IDs 1..6 with a
default baud of 1 Mbps. If nothing responds, try --baud 500000 (older units).
"""
import argparse
import sys
import scservo_sdk as scs

ADDR_PRESENT_POSITION = 56
ADDR_PRESENT_VOLTAGE = 62
ADDR_PRESENT_TEMPERATURE = 63
ADDR_MODEL_NUMBER = 3


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", default="/dev/cu.usbmodem5C4C1280501")
    p.add_argument("--baud", type=int, default=1_000_000)
    p.add_argument("--max-id", type=int, default=20)
    args = p.parse_args()

    port = scs.PortHandler(args.port)
    packet = scs.PacketHandler(0)  # 0 = SCS protocol

    if not port.openPort():
        print(f"FAIL: could not open {args.port}")
        sys.exit(1)
    if not port.setBaudRate(args.baud):
        print(f"FAIL: could not set baud {args.baud}")
        sys.exit(1)

    print(f"Scanning IDs 1..{args.max_id} on {args.port} @ {args.baud} baud\n")
    found = []
    for servo_id in range(1, args.max_id + 1):
        model, comm, err = packet.ping(port, servo_id)
        if comm == scs.COMM_SUCCESS:
            pos, _, _ = packet.read2ByteTxRx(port, servo_id, ADDR_PRESENT_POSITION)
            volt, _, _ = packet.read1ByteTxRx(port, servo_id, ADDR_PRESENT_VOLTAGE)
            temp, _, _ = packet.read1ByteTxRx(port, servo_id, ADDR_PRESENT_TEMPERATURE)
            found.append(servo_id)
            print(f"  ID {servo_id:2d}: model={model}  pos={pos:>5}  V={volt/10:.1f}  T={temp}C  err=0x{err:02x}")

    port.closePort()

    if not found:
        print("\nNo servos responded. Check power, cable, baud rate, and port.")
        sys.exit(2)
    print(f"\nOK: {len(found)} servo(s) responded — IDs {found}")


if __name__ == "__main__":
    main()
