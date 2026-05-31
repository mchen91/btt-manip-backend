"""
charrss.py  -- Proof-of-concept "linear" Reverse Seed Search for Melee's random
*character* selection, mirroring tauKhan's tag RSS (tagrss.py).

The tag RSS is fully general: it only relies on (a) the LCG being affine and
(b) the random-int function carving the seed space into contiguous intervals.
The character problem differs in exactly three ways:

  1. Each character consumes TWO rolls (char = rand_int(s,25), then one unused
     roll). So consecutive characters live two LCG steps apart -> the relevant
     advance map is next2 = next o next  (multiplier A^2, not A).
  2. The bound is 25 (characters) instead of 145 (tags).
  3. There is NO uniqueness / re-roll logic, so the whole combinatorial
     re-roll wrapper around tag search disappears. Character search is strictly
     simpler.

The only artifact in tagrss.py that is specific to tags is the hand-tuned table
of linear-combination vectors (CONSTRICTS / CONSTMULTIP). Those encode integer
coefficient vectors c with  sum_j c_j * A^(exp_j)  either == 0 (global feasibility
screen) or == small M (a slowly-advancing "clock"). This file GENERATES the
equivalent vectors for the character setting via lattice reduction (LLL) and a
Babai nearest-plane CVP step, closing the one real gap to a character port.

Author: proof-of-concept for btt-manip-backend
"""

from fractions import Fraction as F

MASK = (1 << 32) - 1
SIZE = 1 << 32
MAXINT = MASK
HSIZE = 65536

A = 214013          # LCG multiplier
C = 2531011         # LCG increment
BOUND = 25          # number of selectable characters

# next2 = one *character* step = two LCG steps
A2 = (A * A) & MASK
C2 = (A * C + C) & MASK
# inverse of next2 (for mapping an ending seed back one character step)
A_INV = pow(A, -1, SIZE)
A2_INV = (A_INV * A_INV) & MASK


def next(seed):
    return (seed * A + C) & MASK


def next2(seed):
    return (seed * A2 + C2) & MASK


def prev2(seed):
    return ((seed - C2) * A2_INV) & MASK


def rand_int(seed, bound=BOUND):
    return ((seed >> 16) * bound) >> 16


# ---------------------------------------------------------------------------
# Affine coefficients of next2^k :  next2^k(s) = A2^k * s + B2[k]   (mod 2^32)
# ---------------------------------------------------------------------------
def char_affine(n):
    a = [1]
    b = [0]
    for _ in range(1, n + 1):
        a.append((a[-1] * A2) & MASK)
        b.append((b[-1] * A2 + C2) & MASK)
    return a, b


# ===========================================================================
# Lattice machinery: generate the coefficient vectors that tagrss ships as
# hand-tuned constants.
# ===========================================================================
def _lll(B, delta=F(3, 4)):
    B = [[F(x) for x in row] for row in B]
    n = len(B)

    def dot(u, v):
        return sum(x * y for x, y in zip(u, v))

    def gram():
        Bs, mu = [], [[F(0)] * n for _ in range(n)]
        for i in range(n):
            bi = B[i][:]
            for j in range(i):
                mu[i][j] = dot(B[i], Bs[j]) / dot(Bs[j], Bs[j])
                bi = [x - mu[i][j] * y for x, y in zip(bi, Bs[j])]
            Bs.append(bi)
        return Bs, mu

    Bs, mu = gram()
    k = 1
    while k < n:
        for j in range(k - 1, -1, -1):
            if abs(mu[k][j]) > F(1, 2):
                q = round(mu[k][j])
                B[k] = [x - q * y for x, y in zip(B[k], B[j])]
                Bs, mu = gram()
        if dot(Bs[k], Bs[k]) >= (delta - mu[k][k - 1] ** 2) * dot(Bs[k - 1], Bs[k - 1]):
            k += 1
        else:
            B[k], B[k - 1] = B[k - 1], B[k]
            Bs, mu = gram()
            k = max(k - 1, 1)
    return [[int(x) for x in row] for row in B]


def _lattice(avec, W):
    """Rows (e_i, W*a_i) plus modulus row (0, W*2^32)."""
    n = len(avec)
    B = [[0] * (n + 1) for _ in range(n + 1)]
    for i in range(n):
        B[i][i] = 1
        B[i][n] = W * avec[i]
    B[n][n] = W * SIZE
    return B


def _residue(c, avec):
    return sum(ci * ai for ci, ai in zip(c, avec)) & MASK


def null_vectors(avec, W=1 << 24, count=6):
    """Short c with  sum c_j a_j == 0 (mod 2^32). Used for global screening."""
    red = _lll(_lattice(avec, W))
    out = []
    for row in red:
        c = row[:len(avec)]
        if any(c) and _residue(c, avec) == 0:
            out.append(c)
    out.sort(key=lambda c: sum(abs(x) for x in c))
    return out[:count]


def clock_vector(avec, target_M, W=1 << 22):
    """
    Small-coefficient c with  sum c_j a_j == target_M (mod 2^32)  (a "clock"
    ticking at speed target_M). Babai nearest-plane CVP against the LLL-reduced
    lattice, targeting the point (0,...,0, W*target_M).

    A large W makes Babai prioritise hitting target_M exactly while still
    minimising the coefficient norm -- essential at bound=25 where the usable
    coefficient budget (sum|c| < 25) barely exceeds the lattice minimum (~16).
    """
    n = len(avec)
    red = _lll(_lattice(avec, W))
    # Gram-Schmidt of reduced basis (as Fractions)
    Bf = [[F(x) for x in row] for row in red]

    def dot(u, v):
        return sum(x * y for x, y in zip(u, v))

    Bs = []
    for i in range(n + 1):
        bi = Bf[i][:]
        for bs in Bs:
            bi = [x - (dot(Bf[i], bs) / dot(bs, bs)) * y for x, y in zip(bi, bs)]
        Bs.append(bi)

    t = [F(0)] * n + [F(W * target_M)]
    b = t[:]
    coeffs = [0] * (n + 1)
    for i in range(n, -1, -1):
        ci = round(dot(b, Bs[i]) / dot(Bs[i], Bs[i]))
        coeffs[i] = ci
        b = [x - ci * y for x, y in zip(b, red[i])]
    lattice_pt = [sum(coeffs[i] * red[i][k] for i in range(n + 1)) for k in range(n + 1)]
    c = lattice_pt[:n]
    M = _residue(c, avec)
    if M > SIZE // 2:                       # normalise to small positive tick
        c = [-x for x in c]
        M = (-M) & MASK
    return c, M


def make_constrictors(num_samples, stage_targets):
    """
    Build the CONSTRICTS analogue. `stage_targets` is a list (per stage) of lists
    of target M speeds. Sample exponents are 1..num_samples under next2 (i.e. the
    characters AFTER the anchor character), matching tagrss's orig_sequence[1:].
    """
    a, _ = char_affine(num_samples + 2)
    avec = [a[k + 1] for k in range(num_samples)]      # exponents 1..num_samples
    stages = []
    for targets in stage_targets:
        stage = []
        for M_t in targets:
            c, M = clock_vector(avec, M_t)
            stage.append([c, M])
        stages.append(stage)
    return stages


def make_screen(num_samples):
    """CONSTMULTIP analogue: null vectors over ALL samples (exponents 0..n-1)."""
    a, b = char_affine(num_samples + 1)
    avec = [a[k] for k in range(num_samples)]          # exponents 0..n-1
    bvec = [b[k] for k in range(num_samples)]
    screen = []
    for c in null_vectors(avec):
        K = sum(ci * bi for ci, bi in zip(c, bvec)) & MASK
        screen.append([c, K])
    return screen


# ===========================================================================
# Direct CVP reconstruction (truncated-LCG / Hidden-Number-Problem solver)
# ---------------------------------------------------------------------------
# An alternative to the clock method above that has NO  sum|c| < bound  budget,
# so it works at 9 characters (where clocks are infeasible). Each character pins
# s_k = a_k*u + b_k (mod 2^32) to a known interval; we recover the anchor u with
# a single Babai nearest-plane closest-vector solve. Validated 5000/5000 at 9-10
# chars with no brute-force residual (see CHARRSS_9CHAR_FINDINGS.md). This is the
# shipped runtime algorithm (ported to charrss.js); the clock CharRss above is
# retained as an offline oracle / history.
# ===========================================================================
def cvp_basis(n):
    """LLL-reduced basis R (n x n) of the HNP lattice for an n-character search:
    row 0 = (a_0..a_{n-1}) (coeff of the anchor u; a_0=1), rows 1..n-1 = 2^32*e_k.
    Depends only on n, so it is generated offline once and baked."""
    a, _ = char_affine(n)
    avec = a[:n]
    G = [avec[:]]
    for k in range(1, n):
        row = [0] * n
        row[k] = SIZE
        G.append(row)
    return _lll(G)


def cvp_gram_schmidt(R):
    """Exact-rational Gram-Schmidt of the reduced basis (b*_i and <b*_i,b*_i>)."""
    n = len(R)
    Rf = [[F(x) for x in row] for row in R]

    def dot(u, v):
        return sum(x * y for x, y in zip(u, v))

    Bs, den = [], []
    for i in range(n):
        bi = Rf[i][:]
        for j, bs in enumerate(Bs):
            bi = [x - (dot(Rf[i], bs) / den[j]) * y for x, y in zip(bi, bs)]
        Bs.append(bi)
        den.append(dot(bi, bi))
    return Bs, den


def cvp_prepare(R):
    """Precompute the float Gram-Schmidt data the enumeration needs. Returns a
    dict that is also exactly what gets baked into charrss_constants.js:
      basis  -- R (int), gsStar -- b*_i (float), gsDen -- ||b*_i||^2 (float),
      mu     -- mu[j][i] = <R[j],b*_i>/||b*_i||^2 (float), r0 -- column 0 of R.
    Lattice arithmetic is float; correctness comes from the exact regenerate-and-
    verify at each enumeration leaf, so double precision is sufficient."""
    n = len(R)
    Bs_f, den_f = cvp_gram_schmidt(R)
    gs_star = [[float(x) for x in row] for row in Bs_f]
    gs_den = [float(d) for d in den_f]
    mu = [[0.0] * n for _ in range(n)]
    for j in range(n):
        for i in range(j):
            mu[j][i] = sum(R[j][k] * gs_star[i][k] for k in range(n)) / gs_den[i]
    return {"n": n, "basis": R, "gsStar": gs_star, "gsDen": gs_den, "mu": mu,
            "r0": [R[i][0] for i in range(n)]}


def cvp_search(chars, prep, pad=1.5):
    """Recover ALL anchor seeds u (rand_int(u,25)==chars[0]) that reproduce the
    character sequence, via Schnorr-Euchner closest-vector enumeration with a
    radius covering the interval half-widths. Every enumerated candidate is
    verified by regenerating the sequence (so no false positives, and float
    lattice math is safe). Returns a sorted list (normally a single anchor)."""
    n = len(chars)
    gs_star, gs_den, mu, r0 = prep["gsStar"], prep["gsDen"], prep["mu"], prep["r0"]
    _, b = char_affine(n)
    bvec = b[:n]

    t = [0.0] * n
    halfw2 = 0.0
    for k, v in enumerate(chars):
        lo, up = get_l_and_u_bounds(v)
        t[k] = float(((lo + up) // 2 - bvec[k]) & MASK)
        hw = (up - lo) / 2.0
        halfw2 += hw * hw
    r2 = halfw2 * pad
    tstar = [sum(t[k] * gs_star[i][k] for k in range(n)) / gs_den[i] for i in range(n)]

    x = [0] * n
    found = set()

    def rec(i, dacc):
        if i < 0:
            u = 0
            for k in range(n):
                u += x[k] * r0[k]
            u &= MASK
            if generate_chars(u, n) == chars:
                found.add(u)
            return
        s = 0.0
        for j in range(i + 1, n):
            s += x[j] * mu[j][i]
        center = tstar[i] - s
        rem = r2 - dacc
        if rem < 0:
            return
        bound = (rem / gs_den[i]) ** 0.5
        lo_x = int(center - bound) - 1
        hi_x = int(center + bound) + 1
        for xi in range(lo_x, hi_x + 1):
            d = xi - center
            dnew = dacc + gs_den[i] * d * d
            if dnew <= r2:
                x[i] = xi
                rec(i - 1, dnew)

    rec(n - 1, 0.0)
    return sorted(found)


# ===========================================================================
# Interval helpers (identical in spirit to tagrss, bound defaulted to 25)
# ===========================================================================
def lower_bound(val, bound=BOUND):
    return int(HSIZE / bound * val + 1) * HSIZE


def get_l_and_u_bounds(val, bound=BOUND):
    if val == 0:
        return 0, lower_bound(1, bound) - 1
    elif val == bound - 1:
        return lower_bound(val, bound), MAXINT
    else:
        return lower_bound(val, bound), lower_bound(val + 1, bound) - 1


def get_low_and_up_borders(seq, bound=BOUND):
    low, up = [], []
    for v in seq:
        l, u = get_l_and_u_bounds(v, bound)
        low.append(l)
        up.append(u)
    return low, up


def sum_of_elements(lst):
    s = 0
    for e in lst:
        s = (e + s) & MAXINT
    return s


def list_mul(l1, l2):
    return [x * y for x, y in zip(l1, l2)]


def list_mul_conditional_to_sign(l1, l2, l3, s):
    return [l1[i] * l2[i] if s * l1[i] >= 0 else l1[i] * l3[i] for i in range(len(l1))]


def calc_mrestrict_accept_area(mult, seed_maxes, seed_mins):
    return (sum_of_elements(list_mul_conditional_to_sign(mult, seed_maxes, seed_mins, -1)),
            sum_of_elements(list_mul_conditional_to_sign(mult, seed_maxes, seed_mins, 1)))


def sequence_list2(seed, length):
    out = []
    for _ in range(length):
        seed = next2(seed)
        out.append(seed)
    return out


# ---- clock window stepping (verbatim logic from tagrss, short_period=1) ----
def find_next_aperiod_and_remainder_split(start_val, abound_l, abound_u, interval, shift=0):
    distance, end_dist = abound_l - start_val, abound_u - start_val
    if end_dist < 0:
        end_dist += SIZE
    if distance <= 0:
        return shift, end_dist // interval + shift, -distance
    if start_val <= abound_u:
        return shift, end_dist // interval + shift, 0
    steps = distance // interval + int(distance % interval != 0)
    return steps + shift, end_dist // interval + shift, steps * interval + start_val - abound_l


def find_next_aperiod_and_remainder_rising(start_val, abound_l, abound_u, interval, shift=0):
    distance, end_dist = abound_l - start_val, abound_u - start_val
    if (distance <= 0) and (end_dist >= 0):
        return shift, end_dist // interval + shift, -distance
    if end_dist < 0:
        distance, end_dist = distance + SIZE, end_dist + SIZE
    steps = distance // interval + int(distance % interval != 0)
    return steps + shift, end_dist // interval + shift, ((steps * interval + start_val) & MAXINT) - abound_l


# ===========================================================================
# Core search (port of tagrss.find_matching_seed)
# ===========================================================================
class CharRss:
    def __init__(self, num_samples, stage_targets):
        self.num_samples = num_samples
        self.constricts = make_constrictors(num_samples, stage_targets)
        self.screen = make_screen(num_samples + 1)
        self.max_stages = len(self.constricts) - 1
        self.visited = 0          # seeds touched by the final brute-force pass

    # ---- global feasibility screen ----
    def screen_sequence(self, full_seq):
        mins, maxs = get_low_and_up_borders(full_seq)
        for c, K in self.screen:
            al, au = calc_mrestrict_accept_area(c, maxs, mins)
            if al < au:
                if K < al or K > au:
                    return False
            else:
                if al > K > au:
                    return False
        return True

    def find_matching_seed(self, full_seq, lo, up, stage=0):
        results = []
        seq = full_seq[1:]                # characters after the anchor
        seq_len = len(seq)
        constrictors = self.constricts[stage]
        mins, maxs = get_low_and_up_borders(seq)
        n_l = [0] * len(constrictors)
        n_u = [0] * len(constrictors)
        curr = lo
        while curr <= up:
            seeds = sequence_list2(curr, seq_len)
            for i, (c, M) in enumerate(constrictors):
                if n_u[i] > curr:
                    continue
                al, au = calc_mrestrict_accept_area(c, maxs, mins)
                start = sum_of_elements(list_mul(seeds, c))
                if au < al:
                    l, u, _ = find_next_aperiod_and_remainder_split(start, al, au, M)
                else:
                    l, u, _ = find_next_aperiod_and_remainder_rising(start, al, au, M)
                n_l[i], n_u[i] = l + curr, u + curr
            L, U = max(n_l), min(n_u)
            if L < U:
                if (U - L > 300) and (stage < self.max_stages):
                    results += self.find_matching_seed(full_seq, L, U, stage + 1)
                else:
                    results += self.brute(full_seq, L, U)
            curr = min(n_u) + 1
        return results

    def brute(self, full_seq, lo, up):
        """Verify a small residual u-window by generating characters directly."""
        out = []
        lo0, up0 = get_l_and_u_bounds(full_seq[0])
        lo = max(lo, lo0)
        up = min(up, up0)
        rest = full_seq[1:]
        for u in range(lo, up + 1):
            self.visited += 1
            s = u
            ok = True
            for ch in rest:
                s = next2(s)
                if rand_int(s) != ch:
                    ok = False
                    break
            if ok:
                out.append(u)
        return out

    def search(self, chars):
        """Return list of anchor seeds u (rand_int(u,25)==chars[0]) producing `chars`."""
        assert len(chars) == self.num_samples + 1, \
            f"expected {self.num_samples + 1} characters, got {len(chars)}"
        self.visited = 0
        if not self.screen_sequence(chars):
            return []
        lo, up = get_l_and_u_bounds(chars[0])
        return self.find_matching_seed(chars, lo, up)


# ---- reference generators for validation ----
def generate_chars(u, length):
    """Characters produced starting from anchor seed u (u itself yields char0)."""
    out = [rand_int(u)]
    s = u
    for _ in range(1, length):
        s = next2(s)
        out.append(rand_int(s))
    return out


# Default staged clock speeds for a 16-character first search (num_samples=15).
# Speeds escalate ~bound^k so each stage resolves within the previous window.
DEFAULT_STAGES = [
    [25, 40, 60, 90, 140],
    [220, 360, 560, 900],
    [1500, 2400, 4000, 6500],
    [11000, 18000, 30000],
    [50000, 90000, 160000],
]


def dump_constants(engine):
    """Emit the generated CONSTRICTS/CONSTMULTIP tables so they can be baked into
    a runtime (exactly how tagrss.py ships a fixed table) -- generation is a slow
    one-time step and must not run per-search."""
    print("# CONSTRICTS (per stage: [coeff_vector, M])")
    for st, stage in enumerate(engine.constricts):
        print(f"#  stage {st}")
        for c, M in stage:
            print(f"    {[c, M]},")
    print("# CONSTMULTIP screen ([coeff_vector, K])")
    for c, K in engine.screen:
        print(f"    {[c, K]},")


if __name__ == "__main__":
    import random
    import time

    print("Generating constant vectors via LLL+Babai (one-time, slow)...")
    t0 = time.time()
    engine = CharRss(15, DEFAULT_STAGES)
    print(f"  done in {time.time() - t0:.0f}s\n")

    random.seed(0)
    trials = 10
    ok = visited = 0
    for _ in range(trials):
        u_true = random.randrange(SIZE)
        chars = generate_chars(u_true, engine.num_samples + 1)
        res = engine.search(chars)
        visited += engine.visited
        if u_true in res and all(generate_chars(u, len(chars)) == chars for u in res):
            ok += 1
    print(f"self-test: {ok}/{trials} sequences solved correctly")
    print(f"avg seeds brute-checked: {visited // trials:,} "
          f"(full brute force = {SIZE // BOUND:,}, "
          f"~{(SIZE // BOUND) // max(visited // trials, 1)}x fewer)")
