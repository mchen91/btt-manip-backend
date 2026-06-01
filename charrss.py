"""
charrss.py  -- Reverse Seed Search for Melee's random *character* selection.

The canonical runtime algorithm is a direct truncated-LCG / Hidden-Number-Problem
(HNP) reconstruction: given N observed character IDs (ints 0..24), it recovers the
32-bit RNG anchor seed via a single Babai closest-vector solve against an
LLL-reduced lattice. Functions: cvp_basis / cvp_prepare / cvp_search.

Character-RSS specifics:
  - Each character consumes TWO LCG rolls: char = rand_int(s,25), then one unused
    roll. So consecutive characters are two LCG steps apart; the relevant advance
    map is next2 = next ∘ next (multiplier A², not A).
  - bound = 25 (characters), not 145 (tags). Each character pins the anchor to a
    1/25 interval of the 32-bit seed space (see RSS_IMPLEMENTATION.md §1–§2).

Author: btt-manip-backend
"""

import random as _random

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
# Lattice machinery: LLL reduction and coefficient-vector construction for
# the character seed-recovery problem.
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


# ===========================================================================
# Direct CVP reconstruction (truncated-LCG / Hidden-Number-Problem solver)
# ---------------------------------------------------------------------------
# The shipped runtime algorithm (ported to charrss.js). Each character pins
# s_k = a_k*u + b_k (mod 2^32) to a known interval; we recover the anchor u
# with a single Babai nearest-plane closest-vector solve. Validated
# 5000/5000 at 9-10 chars with no brute-force residual (RSS_IMPLEMENTATION.md).
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
# Interval helpers (bound defaulted to 25)
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


# ---- reference generators and shared validation ----
def validate_cvp(prep, num_chars, trials, rng_seed=12345, extra_seeds=()):
    """Run cvp_search over extra_seeds then trials random seeds and check
    correctness. Returns a dict:
      found, not_found, false_pos, multi  -- counts
      failures                            -- list of human-readable failure strings
    extra_seeds are tested first and tagged 'edge' in failure messages;
    random seeds are tagged 'random'."""
    rng = _random.Random(rng_seed)
    found = not_found = false_pos = multi = 0
    failures = []
    extra_set = set(extra_seeds)
    all_seeds = list(extra_seeds) + [rng.randrange(SIZE) for _ in range(trials)]
    for u in all_seeds:
        chars = generate_chars(u, num_chars)
        res = cvp_search(chars, prep)
        for x in res:
            if generate_chars(x, num_chars) != chars:
                false_pos += 1
                failures.append(f"false positive: anchor {x} for seed {u}")
        if len(res) > 1:
            multi += 1
        if u in res:
            found += 1
        else:
            not_found += 1
            tag = "edge" if u in extra_set else "random"
            failures.append(f"not found ({tag}): seed {u}, chars={chars}, got={res}")
    return {"found": found, "not_found": not_found, "false_pos": false_pos,
            "multi": multi, "failures": failures}


def generate_chars(u, length):
    """Characters produced starting from anchor seed u (u itself yields char0)."""
    out = [rand_int(u)]
    s = u
    for _ in range(1, length):
        s = next2(s)
        out.append(rand_int(s))
    return out

