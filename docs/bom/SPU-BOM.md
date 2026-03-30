# SPU Bill of Materials (BOM)

**Document:** SPU-BOM-001  
**Revision:** 1.0  
**Date:** 2026-03-30  
**Approved by:** Alejandro Valdez  

---

## Overview

This document defines the complete Bill of Materials for one (1) SPU (Sample Processing Unit). All parts listed below are required to assemble a single SPU. The "Buildable SPUs" metric on the BIMS dashboard is calculated from this BOM.

## BOM Table

| # | Part Number | Description | Qty/Unit | Category |
|---|---|---|---|---|
| 1 | IFU-SPU-001 | Instructions For Use | 1 | Documentation |
| 2 | PT-SPU-002 | M3 x 40 mm SHCS | 2 | Fasteners |
| 3 | PT-SPU-003 | M3 Self-Retaining Washer - Nylon | 4 | Fasteners |
| 4 | PT-SPU-004 | M3.12 x 8 mm - Torx PlasticThread-Forming | 8 | Fasteners |
| 5 | PT-SPU-005 | M3 x 25 mm - low profile SHCS | 4 | Fasteners |
| 6 | PT-SPU-006 | M3 split lock washer | 2 | Fasteners |
| 7 | PT-SPU-007 | M3 High Hex Nut | 2 | Fasteners |
| 8 | PT-SPU-008 | Main Magnet - Spherical | 3 | Magnets |
| 9 | PT-SPU-009 | Support Magnet - Cylindrical | 9 | Magnets |
| 10 | PT-SPU-010 | Holding Magnet - Bar | 1 | Magnets |
| 11 | PT-SPU-012 | Upper Magnet Bracket | 1 | Mechanical |
| 12 | PT-SPU-013 | Heater Block | 1 | Thermal |
| 13 | PT-SPU-014 | Proximal Stage Bracket | 1 | Mechanical |
| 14 | PT-SPU-015 | Distal Bracket | 1 | Mechanical |
| 15 | PT-SPU-016 | Stepper Motor | 1 | Electromechanical |
| 16 | PT-SPU-017 | 20 Tooth GT-2 Pulley | 1 | Mechanical |
| 17 | PT-SPU-018 | Barcode Scanner | 1 | Electronics |
| 18 | PT-SPU-019 | #4 x 1/4 Flat Head Thread-Forming Screw | 4 | Fasteners |
| 19 | PT-SPU-020 | Led Lens Cap | 1 | Optics |
| 20 | PT-SPU-021 | Black Sheet Metal Enclosure | 1 | Enclosure |
| 21 | PT-SPU-022 | Enclosure Front | 1 | Enclosure |
| 22 | PT-SPU-023 | Enclosure Back | 1 | Enclosure |
| 23 | PT-SPU-024 | Heavy Duty Unthreaded Bumpers | 4 | Mechanical |
| 24 | PT-SPU-027 | Structure Top | 1 | Structure |
| 25 | PT-SPU-028 | Linear Rail Assembly | 1 | Mechanical |
| 26 | PT-SPU-029 | M3 x 10 mm SHCS | 2 | Fasteners |
| 27 | PT-SPU-030 | M3.12 x 12 mm - Torx PlasticThread-Forming | 11 | Fasteners |
| 28 | PT-SPU-031 | Cartridge Heater | 1 | Thermal |
| 29 | PT-SPU-032 | Timing Belt 350 mm (6mm x 3000mm) | 350 | Mechanical |
| 30 | PT-SPU-033 | Torx T5 - M1.6x3 (Screws - Barcode Scanner) | 2 | Fasteners |
| 31 | PT-SPU-034 | Motion to Sensor Flat Flex Cable | 1 | Electronics |
| 32 | PT-SPU-036 | Acrylic Mirror - 23mm X 27mm | 1 | Optics |
| 33 | PT-SPU-041 | Oil-Embedded Sleeve Bearing | 2 | Mechanical |
| 34 | PT-SPU-044 | Structure Bottom | 1 | Structure |
| 35 | PT-SPU-046 | Barrel Jack Assembly | 1 | Electronics |
| 36 | PT-SPU-051 | Undersized Dowel Pin 18-8 Stainless | 2 | Mechanical |
| 37 | PT-SPU-052 | Off-White Nylon Unthreaded Spacer | 2 | Mechanical |
| 38 | PT-SPU-054 | Adhesive Tape for Antenna | 1 | Consumables |
| 39 | PT-SPU-078 | Laser Diode | 3 | Optics |
| 40 | PT-SPU-082 | Particle M-SOM | 1 | Electronics |
| 41 | PT-SPU-087 | Lazer Hazard Label | 1 | Labels |
| 42 | PT-SPU-091 | LED Light Assembly | 1 | Electronics |
| 43 | PT-SPU-092 | MSOM Brass Screw | 1 | Fasteners |
| 44 | PT-SPU-093 | Labeled Front Enclosure | 1 | Enclosure |
| 45 | PT-SPU-096 | Laser Filter | 1 | Optics |
| 46 | PT-SPU-097 | Main Board Fuse 5A | 1 | Electronics |
| 47 | PT-SPU-098 | Structural Manifold | 1 | Structure |
| 48 | PT-SPU-099 | Aluminum Tape | 60 | Consumables |
| 49 | PT-SPU-100 | Heater Block Nylon Spacer | 3 | Thermal |
| 50 | SBA-SPU-003 | Main Board | 1 | Electronics |
| 51 | SBA-SPU-004 | Stage Board | 1 | Electronics |

**Total unique parts:** 51  
**Total components per SPU:** 510

## Non-BOM SPU Parts (tracked in General Inventory)

These parts are related to SPU but are NOT included in the BOM calculation:

| Part Number | Description | Reason |
|---|---|---|
| PT-SPU-047 | Stepper Motor Screw | Not part of assembly |
| PT-SPU-049 | Stepper Motor Connector Housing | Not part of assembly |

## Build Capacity Calculation

```
Buildable SPUs = MIN(inventory / quantityPerUnit) across all 51 BOM parts
```

The bottleneck part (lowest ratio) determines how many complete SPUs can be assembled.

## Revision History

| Rev | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2026-03-30 | Alejandro Valdez | Initial BOM — 51 parts, approved |
