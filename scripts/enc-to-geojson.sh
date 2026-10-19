#!/bin/sh
# Exports the S-57 layers the index reads from one ENC cell into a
# directory of GeoJSON files (one FeatureCollection per layer, plus DSID),
# the layout src/ingest/cell-reader.ts expects.
#
#   scripts/enc-to-geojson.sh FI5ABCDE.000 data/cells/FI5ABCDE
#
# Needs GDAL's ogr2ogr; inside signalk-container use an image such as
# ghcr.io/osgeo/gdal. Update files (.001, .002, …) next to the .000 are
# applied by the driver (UPDATES=APPLY).
set -eu

if [ $# -ne 2 ]; then
  echo "usage: $0 <cell.000> <output-dir>" >&2
  exit 2
fi

src=$1
out=$2
# Checked up front: in the loop below a failing ogrinfo reads as "layer
# absent", so a missing GDAL or source would end in an empty export and exit 0.
if [ ! -r "$src" ]; then
  echo "$src: not a readable file" >&2
  exit 1
fi
for tool in ogrinfo ogr2ogr; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool not found; install GDAL" >&2
    exit 1
  fi
done
if ! ogrinfo -q -so "$src" >/dev/null; then
  echo "GDAL cannot open $src" >&2
  exit 1
fi

# The GeoJSON driver will not overwrite a file, and a layer dropped from a
# new edition must not survive from an old export: start from an empty
# directory every time.
if [ -d "$out" ] && [ -n "$(ls -A "$out")" ]; then
  echo "$out is not empty; export each edition into a new directory" >&2
  exit 1
fi
mkdir -p "$out"

export OGR_S57_OPTIONS="RETURN_PRIMITIVES=OFF,RETURN_LINKAGES=OFF,LNAM_REFS=ON,UPDATES=APPLY,SPLIT_MULTIPOINT=ON,ADD_SOUNDG_DEPTH=ON"

for layer in DSID DEPARE DRGARE SWPARE SOUNDG UWTROC WRECKS OBSTRN LNDARE COALNE SLCONS PONTON FLODOC HULKES UNSARE M_QUAL M_COVR M_SDAT M_VDAT; do
  # Layers absent from the cell make ogr2ogr fail; skip them.
  if ogrinfo -q -so "$src" "$layer" >/dev/null 2>&1; then
    ogr2ogr -f GeoJSON -t_srs EPSG:4326 "$out/$layer.geojson" "$src" "$layer"
  fi
done

# Without coverage the cell reader refuses the directory; say so here instead.
if [ ! -f "$out/M_COVR.geojson" ]; then
  echo "$src has no M_COVR coverage layer; $out is not a usable cell" >&2
  exit 1
fi
