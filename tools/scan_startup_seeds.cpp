// Exhaustively rank Melee startup RNG seeds for Peach BTT bomb -> beam sword.
//
// Build:
//   c++ -O3 -march=native -std=c++20 -pthread tools/scan_startup_seeds.cpp -o tools/scan_startup_seeds
//
// The scanner walks HSD_Rand's full-period LCG cycle.  A bomb pull whose item
// roll uses chain position t is produced by the startup seed 13 rolls earlier
// with the default 12 stage-load rolls.  A sword at viewer offset k uses pull
// positions t+k+2.  Delaying each bomb by max_offset+2 therefore lets a
// 101-entry sliding sword window score it in O(1), using one LCG advance per
// scanned seed instead of replaying all 101 offsets for every seed.

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cinttypes>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr std::uint32_t kMultiplier = 214013;
constexpr std::uint32_t kIncrement = 2531011;
constexpr std::uint64_t kFullPeriod = UINT64_C(1) << 32;
// Calibration captured with the Dolphin configuration used for these scans.
// CustomRTCValue is Unix seconds; changing it by one second advances the
// GameCube tick seed by 40,500,000 modulo 2^32.
constexpr std::uint32_t kCalibrationSeed = 0x10adb866;
constexpr std::uint64_t kCalibrationRtc = 1735689600;
constexpr std::uint32_t kRtcGcd = 32;
constexpr std::uint64_t kRtcPeriod = kFullPeriod / kRtcGcd;
constexpr std::uint64_t kRtcInverse = 5128297; // inverse of 40,500,000/32 mod 2^27

struct Affine {
  std::uint32_t multiplier;
  std::uint32_t increment;
};

struct Options {
  std::uint32_t stage_load_rolls = 12;
  std::uint32_t min_offset = 2290;
  std::uint32_t max_offset = 2330;
  std::uint32_t minimum_swords = 3;
  std::uint64_t positions = kFullPeriod;
  unsigned threads = std::max(1u, std::thread::hardware_concurrency());
  std::filesystem::path output = "seed-scan-results.csv";
  bool self_test = false;
};

struct Result {
  std::uint32_t seed;
  std::uint32_t post_bomb_seed;
  std::vector<std::uint32_t> sword_offsets;
};

std::string hex32(std::uint32_t value);

std::string custom_rtc_hex(std::uint32_t seed) {
  const std::uint32_t difference = seed - kCalibrationSeed;
  if (difference % kRtcGcd != 0)
    return "N/A";
  const std::uint64_t delta =
      (static_cast<std::uint64_t>(difference / kRtcGcd) * kRtcInverse) % kRtcPeriod;
  return hex32(static_cast<std::uint32_t>(kCalibrationRtc + delta));
}

struct ThreadResult {
  std::vector<Result> matches;
  std::array<std::uint64_t, 102> histogram{};
  std::uint64_t bombs = 0;
};

std::uint32_t advance(std::uint32_t seed) {
  return seed * kMultiplier + kIncrement;
}

// outer(inner(x)), with arithmetic intentionally reduced modulo 2^32.
Affine compose(Affine outer, Affine inner) {
  return {outer.multiplier * inner.multiplier,
          outer.multiplier * inner.increment + outer.increment};
}

Affine power(Affine base, std::uint64_t exponent) {
  Affine result{1, 0};
  while (exponent != 0) {
    if ((exponent & 1) != 0)
      result = compose(base, result);
    base = compose(base, base);
    exponent >>= 1;
  }
  return result;
}

std::uint32_t apply(Affine transform, std::uint32_t seed) {
  return transform.multiplier * seed + transform.increment;
}

std::uint32_t inverse_odd(std::uint32_t value) {
  std::uint32_t inverse = 1;
  for (int i = 0; i < 5; ++i)
    inverse *= 2u - value * inverse;
  return inverse;
}

Affine inverse_lcg() {
  const std::uint32_t inverse_multiplier = inverse_odd(kMultiplier);
  return {inverse_multiplier, 0u - inverse_multiplier * kIncrement};
}

std::uint32_t rng_int(std::uint32_t state, std::uint32_t maximum) {
  return (maximum * (state >> 16)) >> 16;
}

bool is_item_roll(std::uint32_t state) {
  return rng_int(state, 128) == 0;
}

bool is_bomb_type(std::uint32_t state) {
  return rng_int(state, 6) <= 1;
}

bool is_sword_type(std::uint32_t state) {
  return rng_int(state, 6) == 5;
}

std::vector<std::uint32_t> sword_offsets(std::uint32_t post_bomb_seed,
                                         std::uint32_t minimum,
                                         std::uint32_t maximum) {
  std::vector<std::uint32_t> offsets;
  std::uint32_t current = advance(post_bomb_seed);
  std::uint32_t next = advance(current);
  for (std::uint32_t k = 0; k < minimum; ++k) {
    current = next;
    next = advance(next);
  }
  for (std::uint32_t k = minimum; k <= maximum; ++k) {
    if (is_item_roll(current) && is_sword_type(next))
      offsets.push_back(k);
    current = next;
    next = advance(next);
  }
  return offsets;
}

bool startup_seed_pulls_bomb(std::uint32_t seed,
                             std::uint32_t stage_load_rolls,
                             std::uint32_t* post_bomb_seed) {
  std::uint32_t state = apply(
      power({kMultiplier, kIncrement}, stage_load_rolls), seed);
  state = advance(state);
  if (!is_item_roll(state))
    return false;
  state = advance(state);
  if (!is_bomb_type(state))
    return false;
  *post_bomb_seed = state;
  return true;
}

std::uint64_t parse_u64(const std::string& text, const char* option) {
  std::size_t consumed = 0;
  const std::uint64_t value = std::stoull(text, &consumed, 0);
  if (consumed != text.size())
    throw std::runtime_error(std::string("invalid value for ") + option + ": " + text);
  return value;
}

void usage(const char* executable) {
  std::cerr
      << "Usage: " << executable << " [options]\n"
      << "  --output PATH          CSV path (default seed-scan-results.csv)\n"
      << "  --threads N            worker threads (default hardware concurrency)\n"
      << "  --stage-load N         RNG advances before the pull (default 12)\n"
      << "  --min-offset N         first sword offset, inclusive (default 2300)\n"
      << "  --max-offset N         last sword offset, inclusive (default 2400)\n"
      << "  --minimum-swords N     record seeds with at least N swords (default 3)\n"
      << "  --positions N          cycle positions to scan (default 2^32)\n"
      << "  --self-test            validate optimized predicates/mapping and exit\n"
      << "  --help                 show this message\n";
}

Options parse_options(int argc, char** argv) {
  Options options;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    auto value = [&](const char* name) -> std::string {
      if (++i == argc)
        throw std::runtime_error(std::string("missing value for ") + name);
      return argv[i];
    };
    if (arg == "--output") {
      options.output = value("--output");
    } else if (arg == "--threads") {
      options.threads = static_cast<unsigned>(parse_u64(value("--threads"), "--threads"));
    } else if (arg == "--stage-load") {
      options.stage_load_rolls = static_cast<std::uint32_t>(
          parse_u64(value("--stage-load"), "--stage-load"));
    } else if (arg == "--min-offset") {
      options.min_offset = static_cast<std::uint32_t>(
          parse_u64(value("--min-offset"), "--min-offset"));
    } else if (arg == "--max-offset") {
      options.max_offset = static_cast<std::uint32_t>(
          parse_u64(value("--max-offset"), "--max-offset"));
    } else if (arg == "--minimum-swords") {
      options.minimum_swords = static_cast<std::uint32_t>(
          parse_u64(value("--minimum-swords"), "--minimum-swords"));
    } else if (arg == "--positions") {
      options.positions = parse_u64(value("--positions"), "--positions");
    } else if (arg == "--self-test") {
      options.self_test = true;
    } else if (arg == "--help" || arg == "-h") {
      usage(argv[0]);
      std::exit(0);
    } else {
      throw std::runtime_error("unknown option: " + arg);
    }
  }
  if (options.threads == 0)
    throw std::runtime_error("--threads must be at least 1");
  if (options.min_offset > options.max_offset)
    throw std::runtime_error("--min-offset must not exceed --max-offset");
  if (options.max_offset - options.min_offset + 1 > 101)
    throw std::runtime_error("this scanner currently supports windows of at most 101 offsets");
  if (options.positions == 0 || options.positions > kFullPeriod)
    throw std::runtime_error("--positions must be in [1, 2^32]");
  if (options.minimum_swords > options.max_offset - options.min_offset + 1)
    throw std::runtime_error("--minimum-swords exceeds the offset-window size");
  options.threads = static_cast<unsigned>(
      std::min<std::uint64_t>(options.threads, options.positions));
  return options;
}

ThreadResult scan_segment(std::uint64_t begin, std::uint64_t end,
                          const Options& options,
                          std::atomic<std::uint64_t>* completed);

void run_self_test() {
  const Affine forward{kMultiplier, kIncrement};
  const Affine backward = inverse_lcg();
  const std::array<std::uint32_t, 8> values{
      0, 1, 2, 0x12345678, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff};
  for (const std::uint32_t value : values) {
    if (apply(backward, advance(value)) != value)
      throw std::runtime_error("LCG inverse self-test failed");
    std::uint32_t repeated = value;
    for (int i = 0; i < 37; ++i)
      repeated = advance(repeated);
    if (apply(power(forward, 37), value) != repeated)
      throw std::runtime_error("LCG jump self-test failed");
  }

  // Cross-check the event-position reverse mapping against direct startup
  // simulation for a deterministic sample of seeds.
  const Affine back_13 = power(backward, 13);
  std::uint32_t item_state = 0;
  for (int i = 0; i < 100000; ++i) {
    const std::uint32_t seed = apply(back_13, item_state);
    std::uint32_t post_bomb = 0;
    const bool direct = startup_seed_pulls_bomb(seed, 12, &post_bomb);
    const std::uint32_t type_state = advance(item_state);
    const bool mapped = is_item_roll(item_state) && is_bomb_type(type_state);
    if (direct != mapped || (direct && post_bomb != type_state))
      throw std::runtime_error("stage-load reverse-mapping self-test failed");
    item_state = advance(item_state);
  }

  // Check the optimized two-state sword predicate against viewer.html's
  // rngInt semantics over another deterministic sample.
  std::uint32_t state = 0x12345678;
  for (int i = 0; i < 100000; ++i) {
    const std::uint32_t next = advance(state);
    const bool optimized = is_item_roll(state) && is_sword_type(next);
    const bool literal = rng_int(state, 128) == 0 && rng_int(next, 6) == 5;
    if (optimized != literal)
      throw std::runtime_error("sword predicate self-test failed");
    state = next;
  }

  // Compare the complete rolling-window scanner against the straightforward
  // viewer-style evaluator on a small cycle segment.  Recording every bomb
  // makes this validate bomb detection, stage-load reversal, offsets, and all
  // delay/window boundaries (including the segment edges).
  Options options;
  options.positions = 100000;
  options.threads = 1;
  options.minimum_swords = 0;
  std::atomic<std::uint64_t> completed{0};
  ThreadResult optimized = scan_segment(0, options.positions, options, &completed);
  std::vector<Result> reference;
  std::array<std::uint64_t, 102> reference_histogram{};
  std::uint32_t reference_item_state = 0;
  const Affine startup_from_item = power(backward, 13);
  for (std::uint64_t i = 0; i < options.positions; ++i) {
    const std::uint32_t type_state = advance(reference_item_state);
    if (is_item_roll(reference_item_state) && is_bomb_type(type_state)) {
      const std::uint32_t seed = apply(startup_from_item, reference_item_state);
      const auto offsets = sword_offsets(type_state, options.min_offset,
                                         options.max_offset);
      ++reference_histogram[offsets.size()];
      reference.push_back({seed, type_state, offsets});
    }
    reference_item_state = type_state;
  }
  if (optimized.bombs != reference.size() ||
      optimized.histogram != reference_histogram ||
      optimized.matches.size() != reference.size())
    throw std::runtime_error("rolling-window aggregate self-test failed");
  for (std::size_t i = 0; i < reference.size(); ++i) {
    if (optimized.matches[i].seed != reference[i].seed ||
        optimized.matches[i].post_bomb_seed != reference[i].post_bomb_seed ||
        optimized.matches[i].sword_offsets != reference[i].sword_offsets)
      throw std::runtime_error("rolling-window result self-test failed");
  }
  std::cout << "self-test passed\n";
}

ThreadResult scan_segment(std::uint64_t begin, std::uint64_t end,
                          const Options& options,
                          std::atomic<std::uint64_t>* completed) {
  ThreadResult output;
  const std::uint32_t window_size = options.max_offset - options.min_offset + 1;
  const std::uint32_t report_delay = options.max_offset + 2;
  const std::uint32_t warmup = window_size - 1;

  // Global event position zero uses item-roll state 0.  Begin early enough
  // to populate the sliding sword window before the first report.
  const std::uint64_t start_position = (begin + kFullPeriod - warmup) % kFullPeriod;
  std::uint32_t item_state = apply(
      power({kMultiplier, kIncrement}, start_position), 0);

  struct BombSlot {
    std::uint32_t item_state = 0;
    bool is_bomb = false;
  };
  std::vector<BombSlot> bomb_delay(report_delay);
  std::vector<std::uint8_t> sword_window(window_size, 0);
  std::uint32_t sword_cursor = 0;
  std::uint32_t swords_in_window = 0;
  std::uint32_t bomb_cursor = 0;
  std::uint64_t iterations = 0;

  const Affine startup_from_item = power(
      inverse_lcg(), static_cast<std::uint64_t>(options.stage_load_rolls) + 1);
  const std::int64_t first_position =
      static_cast<std::int64_t>(begin) - warmup;
  const std::int64_t last_position =
      static_cast<std::int64_t>(end) - 1 + report_delay;

  for (std::int64_t position = first_position;
       position <= last_position; ++position) {
    const std::uint32_t type_state = advance(item_state);
    const bool item = is_item_roll(item_state);
    const bool sword = item && is_sword_type(type_state);
    const bool bomb = item && is_bomb_type(type_state);

    swords_in_window -= sword_window[sword_cursor];
    sword_window[sword_cursor] = static_cast<std::uint8_t>(sword);
    swords_in_window += sword_window[sword_cursor];
    if (++sword_cursor == window_size)
      sword_cursor = 0;

    BombSlot& delayed = bomb_delay[bomb_cursor];
    if (iterations >= report_delay) {
      const std::int64_t bomb_position = position - report_delay;
      if (bomb_position >= static_cast<std::int64_t>(begin) &&
          bomb_position < static_cast<std::int64_t>(end) && delayed.is_bomb) {
        ++output.bombs;
        ++output.histogram[std::min<std::uint32_t>(swords_in_window, 101)];
        if (swords_in_window >= options.minimum_swords) {
          const std::uint32_t seed = apply(startup_from_item, delayed.item_state);
          const std::uint32_t post_bomb_seed = advance(delayed.item_state);
          auto offsets = sword_offsets(post_bomb_seed, options.min_offset,
                                       options.max_offset);
          if (offsets.size() != swords_in_window)
            throw std::runtime_error("internal sliding-window mismatch");
          output.matches.push_back({seed, post_bomb_seed, std::move(offsets)});
        }
      }
    }
    delayed = {item_state, bomb};
    if (++bomb_cursor == report_delay)
      bomb_cursor = 0;

    item_state = type_state;
    ++iterations;
  }

  completed->fetch_add(end - begin, std::memory_order_relaxed);
  return output;
}

std::string hex32(std::uint32_t value) {
  std::ostringstream out;
  out << "0x" << std::hex << std::setw(8) << std::setfill('0') << value;
  return out.str();
}

void write_results(const Options& options, const std::vector<Result>& results,
                   const std::array<std::uint64_t, 102>& histogram,
                   std::uint64_t bombs, double seconds) {
  if (!options.output.parent_path().empty())
    std::filesystem::create_directories(options.output.parent_path());
  std::ofstream csv(options.output);
  if (!csv)
    throw std::runtime_error("could not open output: " + options.output.string());
  csv << "seed_hex,seed_decimal,post_bomb_seed_hex,sword_count,sword_offsets,custom_rtc_hex\n";
  for (const Result& result : results) {
    csv << hex32(result.seed) << ',' << result.seed << ','
        << hex32(result.post_bomb_seed) << ',' << result.sword_offsets.size()
        << ',' << '"';
    for (std::size_t i = 0; i < result.sword_offsets.size(); ++i) {
      if (i != 0)
        csv << ' ';
      csv << result.sword_offsets[i];
    }
    csv << "\"," << custom_rtc_hex(result.seed) << "\n";
  }
  csv.close();

  std::filesystem::path summary_path = options.output;
  summary_path += ".summary.json";
  std::ofstream summary(summary_path);
  if (!summary)
    throw std::runtime_error("could not open summary: " + summary_path.string());
  const std::size_t best = results.empty() ? 0 : results.front().sword_offsets.size();
  summary << "{\n"
          << "  \"positions_scanned\": " << options.positions << ",\n"
          << "  \"full_32_bit_space\": "
          << (options.positions == kFullPeriod ? "true" : "false") << ",\n"
          << "  \"stage_load_rolls\": " << options.stage_load_rolls << ",\n"
          << "  \"min_offset\": " << options.min_offset << ",\n"
          << "  \"max_offset\": " << options.max_offset << ",\n"
          << "  \"minimum_swords\": " << options.minimum_swords << ",\n"
          << "  \"threads\": " << options.threads << ",\n"
          << "  \"elapsed_seconds\": " << std::fixed << std::setprecision(3)
          << seconds << ",\n"
          << "  \"bomb_seeds\": " << bombs << ",\n"
          << "  \"recorded_seeds\": " << results.size() << ",\n"
          << "  \"maximum_swords\": " << best << ",\n"
          << "  \"histogram\": {";
  bool first = true;
  for (std::size_t count = 0; count < histogram.size(); ++count) {
    if (histogram[count] == 0)
      continue;
    summary << (first ? "\n" : ",\n") << "    \"" << count << "\": "
            << histogram[count];
    first = false;
  }
  if (!first)
    summary << '\n';
  summary << "  }\n}\n";
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const Options options = parse_options(argc, argv);
    if (options.self_test) {
      run_self_test();
      return 0;
    }

    std::cerr << "Scanning " << options.positions << " LCG positions with "
              << options.threads << " threads; stage-load="
              << options.stage_load_rolls << ", sword window="
              << options.min_offset << "-" << options.max_offset << "\n";
    const auto started = std::chrono::steady_clock::now();
    std::atomic<std::uint64_t> completed{0};
    std::vector<ThreadResult> thread_results(options.threads);
    std::vector<std::thread> workers;
    workers.reserve(options.threads);
    for (unsigned index = 0; index < options.threads; ++index) {
      const std::uint64_t begin = options.positions * index / options.threads;
      const std::uint64_t end = options.positions * (index + 1) / options.threads;
      workers.emplace_back([&, index, begin, end] {
        thread_results[index] = scan_segment(begin, end, options, &completed);
      });
    }
    for (std::thread& worker : workers)
      worker.join();

    std::vector<Result> results;
    std::array<std::uint64_t, 102> histogram{};
    std::uint64_t bombs = 0;
    for (ThreadResult& part : thread_results) {
      bombs += part.bombs;
      for (std::size_t i = 0; i < histogram.size(); ++i)
        histogram[i] += part.histogram[i];
      results.insert(results.end(),
                     std::make_move_iterator(part.matches.begin()),
                     std::make_move_iterator(part.matches.end()));
    }
    std::sort(results.begin(), results.end(), [](const Result& left, const Result& right) {
      if (left.sword_offsets.size() != right.sword_offsets.size())
        return left.sword_offsets.size() > right.sword_offsets.size();
      return left.seed < right.seed;
    });
    const double elapsed = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
    write_results(options, results, histogram, bombs, elapsed);

    std::cerr << "Done in " << std::fixed << std::setprecision(2) << elapsed
              << "s: " << bombs << " bomb seeds, " << results.size()
              << " recorded, best="
              << (results.empty() ? 0 : results.front().sword_offsets.size())
              << " swords\nWrote " << options.output << " and "
              << options.output.string() << ".summary.json\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "error: " << error.what() << '\n';
    return 1;
  }
}
