#!/usr/bin/env python3
"""
Terminal REPL for driving the SO-100 / SO-ARM100 follower arm directly.

  python scripts/teleop_cli.py [--port PORT] [--baud BAUD]

Commands (type `help` once it's running):
  status                       print full state of all 6 servos
  pos                          print current positions only
  jog <id> <delta> [speed]     move one servo by Δ steps
  move <id> <pos> [speed]      set goal position (one servo)
  move-all <p1>..<p6> [speed]  set all 6 goal positions
  torque on|off [id]           enable/disable torque (id optional)
  pause                        freeze in place (torque stays on)
  estop                        drop torque on every servo (limp)
  save <name>                  save current pose under <name>
  poses                        list saved poses
  goto <name>                  move to a saved pose
  delete <name>                forget a saved pose
  help                         show this help
  quit                         exit (does NOT e-stop; arm holds last state)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Allow running this file directly without installing as a package.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from arm.driver import ArmDriver, DEFAULT_PORT, DEFAULT_BAUD, POS_MIN, POS_MAX  # noqa: E402

POSE_FILE = Path.home() / ".bims-arm" / "poses.json"


def load_poses() -> dict[str, list[int]]:
    if not POSE_FILE.exists():
        return {}
    try:
        return json.loads(POSE_FILE.read_text())
    except Exception:
        return {}


def save_poses(poses: dict[str, list[int]]) -> None:
    POSE_FILE.parent.mkdir(parents=True, exist_ok=True)
    POSE_FILE.write_text(json.dumps(poses, indent=2))


def fmt_state(s, torque: bool) -> str:
    tq = "ON " if torque else "off"
    return (
        f"  ID {s.id}: pos={s.position:>4}  vel={s.speed:>4}  "
        f"load={s.load:>4}  V={s.voltage:.1f}  T={s.temperature}C  torque={tq}"
    )


def warn_torque_off(arm: ArmDriver, sids: list[int]) -> None:
    """Print a warning if torque is off on any of the given servos.
    Motion commands still go through — the servo just queues the goal."""
    off = [sid for sid in sids if not arm.get_torque(sid)]
    if off:
        print(f"  WARN: torque off on {off} — goal queued but arm won't move. Run 'torque on' first.")


def cmd_status(arm: ArmDriver) -> None:
    torques = arm.get_torques()
    for s in arm.list_states():
        print(fmt_state(s, torques.get(s.id, False)))


def cmd_pos(arm: ArmDriver) -> None:
    positions = arm.get_positions()
    print("  " + "  ".join(f"{sid}:{pos}" for sid, pos in positions.items()))


def cmd_jog(arm: ArmDriver, args: list[str]) -> None:
    sid = int(args[0])
    delta = int(args[1])
    speed = int(args[2]) if len(args) > 2 else None
    warn_torque_off(arm, [sid])
    new_pos = arm.jog(sid, delta, speed=speed)
    print(f"  ID {sid}: -> {new_pos}")


def cmd_move(arm: ArmDriver, args: list[str]) -> None:
    sid = int(args[0])
    pos = int(args[1])
    speed = int(args[2]) if len(args) > 2 else None
    warn_torque_off(arm, [sid])
    arm.set_position(sid, pos, speed=speed)
    print(f"  ID {sid}: goal {pos}")


def cmd_move_all(arm: ArmDriver, args: list[str]) -> None:
    if len(args) < 6:
        print("  move-all needs 6 positions")
        return
    positions = [int(x) for x in args[:6]]
    speed = int(args[6]) if len(args) > 6 else None
    goals = dict(zip(arm.servo_ids, positions))
    warn_torque_off(arm, list(arm.servo_ids))
    arm.set_positions(goals, speed=speed)
    print(f"  goals: {goals}")


def cmd_torque(arm: ArmDriver, args: list[str]) -> None:
    if not args or args[0] not in ("on", "off"):
        print("  usage: torque on|off [id]")
        return
    on = args[0] == "on"
    if len(args) > 1:
        sid = int(args[1])
        arm.set_torque(sid, on)
        print(f"  ID {sid}: torque {'on' if on else 'off'}")
    else:
        arm.set_torque_all(on)
        print(f"  all: torque {'on' if on else 'off'}")


def cmd_pause(arm: ArmDriver) -> None:
    warn_torque_off(arm, list(arm.servo_ids))
    arm.pause()
    print("  paused (frozen in place)")


def cmd_estop(arm: ArmDriver) -> None:
    arm.e_stop()
    print("  E-STOP — torque dropped on all servos. ARM WILL SAG.")


def cmd_save(arm: ArmDriver, args: list[str]) -> None:
    if not args:
        print("  usage: save <name>")
        return
    name = args[0]
    positions = list(arm.get_positions().values())
    poses = load_poses()
    poses[name] = positions
    save_poses(poses)
    print(f"  saved '{name}': {positions}")


def cmd_poses() -> None:
    poses = load_poses()
    if not poses:
        print("  (no saved poses)")
        return
    for name, positions in poses.items():
        print(f"  {name}: {positions}")


def cmd_goto(arm: ArmDriver, args: list[str]) -> None:
    if not args:
        print("  usage: goto <name>")
        return
    poses = load_poses()
    name = args[0]
    if name not in poses:
        print(f"  no pose named '{name}'")
        return
    goals = dict(zip(arm.servo_ids, poses[name]))
    speed = int(args[1]) if len(args) > 1 else None
    warn_torque_off(arm, list(arm.servo_ids))
    arm.set_positions(goals, speed=speed)
    print(f"  moving to '{name}': {goals}")


def cmd_delete(args: list[str]) -> None:
    if not args:
        print("  usage: delete <name>")
        return
    poses = load_poses()
    name = args[0]
    if name not in poses:
        print(f"  no pose named '{name}'")
        return
    del poses[name]
    save_poses(poses)
    print(f"  deleted '{name}'")


HELP = __doc__ or ""


def repl(arm: ArmDriver) -> None:
    print(f"connected to {arm.port_name} @ {arm.baud} baud — type 'help' or 'quit'")
    while True:
        try:
            line = input("arm> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        parts = line.split()
        cmd, args = parts[0].lower(), parts[1:]
        try:
            if cmd in ("quit", "q", "exit"):
                return
            elif cmd in ("help", "?", "h"):
                print(HELP)
            elif cmd in ("status", "s"):
                cmd_status(arm)
            elif cmd in ("pos", "p"):
                cmd_pos(arm)
            elif cmd == "jog":
                cmd_jog(arm, args)
            elif cmd == "move":
                cmd_move(arm, args)
            elif cmd == "move-all":
                cmd_move_all(arm, args)
            elif cmd == "torque":
                cmd_torque(arm, args)
            elif cmd == "pause":
                cmd_pause(arm)
            elif cmd in ("estop", "e-stop", "stop"):
                cmd_estop(arm)
            elif cmd == "save":
                cmd_save(arm, args)
            elif cmd == "poses":
                cmd_poses()
            elif cmd == "goto":
                cmd_goto(arm, args)
            elif cmd == "delete":
                cmd_delete(args)
            else:
                print(f"  unknown command '{cmd}' — type 'help'")
        except Exception as e:
            print(f"  error: {e}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--port", default=DEFAULT_PORT)
    p.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    args = p.parse_args()

    with ArmDriver(port=args.port, baud=args.baud) as arm:
        repl(arm)


if __name__ == "__main__":
    main()
