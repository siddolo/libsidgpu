#include "sid.h"
#include <cmath>
#include <iostream>

/* Generate digital reference vectors from reSID (MOS8580) by stepping the chip
 * with the exact integer cycle delta elapsed at each audio sample. Clearing
 * shift_pipeline disables the 2-cycle LFSR reset delay so the probe measures
 * pure accumulator and LFSR stepping. */
int main() {
  std::cout << "[\n";
  bool first = true;
  for (int rate : {44100, 48000}) {
    for (int frequency : {0, 7492, 65535}) {
      reSID::SID sid;
      sid.set_chip_model(reSID::MOS8580);
      auto state = sid.read_state();
      for (int voice = 0; voice < 3; ++voice) {
        state.accumulator[voice] = 0;
        state.shift_register[voice] = 0x7fffff;
        state.shift_pipeline[voice] = 0;
        state.sid_register[voice * 7] = frequency & 255;
        state.sid_register[voice * 7 + 1] = frequency >> 8;
        state.sid_register[voice * 7 + 4] = 0x80;
      }
      sid.write_state(state);
      int elapsed = 0;
      for (int sample = 1; sample <= 4096; ++sample) {
        const int cycles = static_cast<int>(std::floor(sample * 985248.0 / rate));
        sid.clock(cycles - elapsed);
        elapsed = cycles;
        if (sample == 128 || sample == 1024 || sample == 4096) {
          const auto current = sid.read_state();
          if (!first) std::cout << ",\n";
          first = false;
          std::cout << "  {\"sampleRate\":" << rate << ",\"frequency\":" << frequency
                    << ",\"samples\":" << sample << ",\"phase\":" << current.accumulator[0]
                    << ",\"lfsr\":" << current.shift_register[0] << "}";
        }
      }
    }
  }
  std::cout << "\n]\n";
}
