# PSID Player

A PSID file contains a 6502 program, music data, and entry points for initialization (`init`) and periodic playback (`play`). The player runs the 6502 CPU on the main thread, records writes to the SID registers, and schedules them at the corresponding sample indices on `SIDEngine`.

```text
PSID > 64 KiB RAM > init(song - 1) > initial register image
                          |
                    periodic play
                          |
                  SID writes, CPU cycle
                          |
            floor(cycle * sampleRate / clock)
                          |
                events > SIDEngine > PCM
```

## Supported Formats and Memory Map

The parser accepts single-SID (`$d400`) PSID v1-v4 files with a non-zero `playAddress`. The RAM load address is read from the header or, when zero, from the first two payload bytes (little-endian). A zero `initAddress` defaults to the load address. Up to 256 subsongs are supported.

6502 execution uses `BatchedAccessCpu` from `6502.ts` over 64 KiB of RAM with `$00/$01` processor port banking:

- when the I/O area (`$d000-$dfff`) is mapped in, writes to `$d400-$d7ff` decode to the 25 writable SID registers (`$d400-$d418`);
- writes to CIA 1 Timer A registers (`$dc04`, `$dc05`, `$dc0e`) control play-call timing in CIA mode;
- writes to the VIC-II control register (`$d011`) store its lower seven bits, while reads from `$d011` and `$d012` return the current raster line derived from the CPU cycle counter so raster wait loops can terminate;
- potentiometer reads (`$d419`, `$d41a`) return `255`, and CIA interrupt status reads (`$dc0d`, `$dd0d`) return `0`.

RSID files, MUS/PlaySID files, multi-SID tunes, and files with `playAddress = 0` (which install an autonomous IRQ handler) are rejected on load. At runtime, accesses to C64 ROMs, `BRK` instructions, unsupported opcodes, and `OSC3`/`ENV3` register reads stop playback with an error message.

## Routine Timing

The CPU and synthesizer clock is set to `985248 Hz` (PAL) or `1022727 Hz` (NTSC) according to the PSID header flags (defaulting to PAL).

When a subsong starts, `init` is called with the zero-based subsong index in the `A` register and a budget of half a second of CPU cycles. Once `init` returns, the final values written to the 25 SID registers are scheduled at sample `0`.

Subsequent calls to `play` are governed by the subsong bit in the header's `speed` field (subsongs above 32 reuse bit 31):

- with `speed = 0` (VBlank), `play` runs every `19656` cycles in PAL (50 Hz) or `17095` cycles in NTSC (~60 Hz);
- with `speed = 1` (CIA Timer A), the initial period is ~60 Hz and the tune can update it by writing the 16-bit latch at `$dc04/$dc05` (`period = latch + 1` cycles).

Each SID write during `play` is mapped to sample index `floor(cycle * sampleRate / clock)` measured from the end of `init`. Cycle counts are tracked from the start of playback to avoid cumulative rounding drift across frames.

## UI Register Monitor

During PSID playback, `SIDFileSource` retains a queue of scheduled register writes and updates the three voice panels and filter controls up to the sample position consumed by the AudioWorklet, keeping the displayed registers aligned with audible output.

## References

- [SID File Format Description](https://www.hvsc.c64.org/download/C64Music/DOCUMENTS/SID_file_format.txt), PSID and RSID format specification from HVSC.
- [6502.ts](https://github.com/6502ts/6502.ts), MOS 6502 CPU emulator in TypeScript.
