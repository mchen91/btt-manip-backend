# Peach BTT RNG Manip
Web tool for Melee RNG manipulation in Peach's break the targets.  Use the CSS to locate your seed then perform the specified actions to manip.

This project is heavily inspired by and based on the previous manip work done by Savestate https://github.com/Savestate2A03/ssbm_rng_manip/. Huge thanks to Savestate and their contributions.

# Usage
Every manip consists of two parts:
* Locating the Seed by rolling random characters
* Performing the Manip via in-game actions

To Manip for a pull:

**Roll** random characters in-game and enter them with the UI on the page. Click the "search" button once enough characters have been entered.

![Example of a search being performed](https://i.imgur.com/qGTNOZk.png "Example search")

The first search requires 9 characters, while all subsequent searches require at least 4.

Once the seed is found, an **action sequence** will be displayed along with corresponding information regarding the RNG event. An example action sequence may be:
```
----------------------------------
Achievable in 7 actions
----------------------------------
Manip Stage: [PEACH]
Target: 1077 rolls

1 - Stage Load (12)
2 - Charged Upsmash (400)
2 - Jump Fair Land (88)
1 - Jump Airdodge Land (62)
1 - Up Tilt (27)
```

**Perform** the specified actions in __Peach's break the targets__ to execute the manip. After completing the manip, your next run will start at the configured pull.

![Example of manip in process](https://i.imgur.com/mqtg0P3.png "Example manip action")

For a good (very long) example of what it looks like to manip, see [this video](https://youtu.be/K2MecScQkx8)

***Note*: It's possible for your game's seed and the application's internal seed to become desynced for a number of reasons. If you feel this may have happened or keep missing pulls, you can always click the "reset" button to re-locate the seed with a new 9-character sequence

# Running Locally
This is a fully static site — all seed location runs client-side in the browser (a
direct CVP / Hidden-Number-Problem reconstruction; see [`RSS_IMPLEMENTATION.md`](RSS_IMPLEMENTATION.md)).
There is no server and no Python runtime dependency.

The published site lives in [`docs/`](docs/). To preview it locally:

```bash
./run.sh                 # serves docs/ at http://localhost:8000/
# or directly:
python3 -m http.server 8000 --directory docs
```

# Deploying
Enable **GitHub Pages** for this repository with the source set to the `/docs` folder on
the default branch. Asset paths are relative, so the site works correctly under the
`https://<user>.github.io/<repo>/` subpath. (`docs/.nojekyll` disables Jekyll so files
are served verbatim.)

# Validation tooling
The C++ implementation (`rng.cpp`) is retained only as an independent brute-force oracle
to cross-check the client-side algorithm. The validation suite (pure-Python RSS, the JS
differential test, and the optional C++ oracle comparison) lives in [`tools/`](tools/):

```bash
./setup.sh           # OPTIONAL: builds the C++ oracle (venv + pybind11 + compile rng.cpp)
./run_all_tests.sh   # runs every validation suite
```

See [`tools/README.md`](tools/README.md) for details on each tool. Only the C++ oracle
step needs `./setup.sh`; the Python and JS validations run with no setup.