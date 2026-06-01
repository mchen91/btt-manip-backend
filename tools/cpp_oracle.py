"""Thin binding to the compiled C++ brute-force oracle (rng.cpp).

The C++ implementation no longer serves the app at runtime -- the browser resolves
seeds with the client-side CVP reconstruction (charrss.js / charrss.py). It is kept
solely as an independent oracle to cross-validate that reconstruction; this module is
the only consumer of the compiled `rng` extension.

Requires the compiled `rng` module (built by ../setup.sh) to be importable. Import will
raise ImportError if it is absent; callers (validate_cpp_oracle.py) handle that by
skipping the C++ step.
"""
import os
import sys

# rng*.so is compiled at the repo root; make it importable regardless of CWD.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import rng

# Character index (0..24, as produced by rng_int(seed, 25)) -> C++ CHARACTER enum.
CHARACTER_IDS = [
    rng.DOC,
    rng.MARIO,
    rng.LUIGI,
    rng.BOWSER,
    rng.PEACH,
    rng.YOSHI,
    rng.DONKEY_KONG,
    rng.CAPTAIN_FALCON,
    rng.GANON,
    rng.FALCO,
    rng.FOX,
    rng.NESS,
    rng.ICE_CLIMBERS,
    rng.KIRBY,
    rng.SAMUS,
    rng.ZELDA,
    rng.LINK,
    rng.YOUNG_LINK,
    rng.PICHU,
    rng.PIKACHU,
    rng.JIGGLYPUFF,
    rng.MEWTWO,
    rng.MR_GAME_AND_WATCH,
    rng.MARTH,
    rng.ROY,
]


def find_seed(char_ids):
    """Return the seed the C++ brute-force oracle locates for a character sequence."""
    seq = rng.CharacterSequence()
    for cid in char_ids:
        seq.addCharacter(CHARACTER_IDS[int(cid)])
    return rng.locateCharSequence(seq)
