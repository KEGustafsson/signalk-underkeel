# RFC draft: aggregated crowdsourced depth cells

Status: draft. The schemas define a publisher format; they are not part of signalk-underkeel's
HTTP contract or its configured inputs.

## Motivation

To let crowdsourced bathymetry (CSB) lower the chart, signalk-underkeel needs more than a depth
per area: how many soundings, platforms and dates stand behind it, and their uncertainty, as
the living chart's discrepancy rule does (plan §4.13). This RFC defines Web Mercator cells on
the same grid as the min-depth pyramid (plan §4.3) that carry only measured depths and those
statistics.

## Cell

`schemas/navigation-safety/csb-cell.json`. Depths are positive-down metres below the set's
chart datum.

| Field                               | Meaning                                                               |
| ----------------------------------- | --------------------------------------------------------------------- |
| `quadkey`                           | Web Mercator tile key; its length is the zoom                         |
| `dMin`                              | shallowest reduced sounding                                           |
| `dShoal`                            | the set's `shoalQuantile` (for example 0.05) of the reduced soundings |
| `dMedian`, `spread`                 | median and sample standard deviation; leaf zoom only                  |
| `sigmaZ`, `sigmaXY`                 | 1σ vertical and horizontal uncertainty of one sounding                |
| `nSoundings`, `nPlatforms`, `nDays` | soundings, distinct `UNIQUE_ID`s, distinct UTC dates                  |
| `tFirst`, `tLast`                   | first and last sounding time                                          |
| `reduction`                         | weakest reduction in the cell: `gauge`, `model` or `none`             |
| `ref`                               | least known reference: `surface`, `transducer` or `unknown`           |
| `providers`                         | trusted nodes behind the soundings                                    |

A cell exists only where an accepted sounding lies in it. The leaf zoom is the set's
`leafZoom`; 18 (about 76 m at 60° N) matches the living chart's cells.

Coarser cells aggregate their children so that zooming out never reads deeper:

- `dMin` and `dShoal` are the minimum of the children's;
- `sigmaZ` and `sigmaXY` are the largest of the children's;
- `nSoundings` is the sum; `nPlatforms` and `nDays` are counted again from the soundings,
  since distinct counts do not add;
- `tFirst` is the earliest, `tLast` the latest;
- `dMedian` and `spread` are left out.

## Set

`schemas/navigation-safety/csb-cell-set.json` describes one publication: `provider`,
`licence` (SPDX), `attribution`, `edition`, `issued`, the chart datum as an S-57 `verdat`
code, `leafZoom`, `minZoom` (`1 ≤ minZoom ≤ leafZoom`), `shoalQuantile`, `bbox` and `sources`.
It carries `cells`, `tiles`, or both, which then describe the same cells:

- `cells`: an area extract with every cell from `minZoom` to `leafZoom`, for download
  before a passage;
- `tiles`: a Mapbox Vector Tiles URL template and layer name, whose features are the cell
  polygons with the cell fields as properties.

`edition` increases whenever any cell changes, so a client rebuilds as it does for a new ENC
cell edition.

## Rules every publisher follows

- No cell without a sounding in it; no interpolation, no smoothing.
- Rounding of any field errs shallow; a coarser cell is never deeper than a finer one.
- Soundings from waters a coastal state has not released (IHO B-12 positive list) are not
  published.
- A sounding not reduced to the set's datum is counted in `reduction: none`, never mixed in
  as reduced.

## Use in signalk-underkeel

Proposed for an ingest beside the ENC and Traficom WFS readers (plan §4.2), off by default:

1. A cell is used only when `reduction` is not `none`, `nPlatforms ≥ 2` and `nDays ≥ 2`
   (both configurable).
2. `dLeaf` is the leaf's current effective depth: the charted `dMin` after any earlier
   lowering, such as `LIVECHART_ADJUSTED`. The cell lowers the leaf where
   `dShoal < dLeaf − 2·√(sigmaZ² + sigmaD²)`: the leaf's `dMin` becomes `min(dLeaf, dShoal)`
   and `sigmaD` becomes at least `sigmaZ`, burnt in with a
   `2·sigmaXY` position buffer as `SOUNDG` is. The leaf gains a new flag, `CSB_ADJUSTED`.
3. It never raises a depth and never sets coverage: a leaf with `NO_COVERAGE` stays
   `unverified` in route checks and is never `clear` on the overlay (invariants 1, 4, 5).
4. A set whose `verdat` the plugin cannot map to its water-level source is rejected with a
   reason on `/status`, as an unmapped ENC datum widens σ (plan §4.5).
5. Explanations name the evidence: providers, `nSoundings`, `nPlatforms`, `tLast` and the
   depth below chart.

Cells with `ref: transducer` or `unknown` read shallower than the true depth; they are used,
since an error there only adds caution, and the explanation names the reference.

## Open questions

- Whether publishers publish the per-platform offset they estimated, so a client can weigh
  platforms itself.
- Whether `shoalQuantile` and `leafZoom` are fixed by this contract or chosen per set.
- An age limit: whether a cell with an old `tLast` should still lower the chart.
- Whether `explanation` (`defs.json`) gains a `csb` object for the evidence in step 5.
