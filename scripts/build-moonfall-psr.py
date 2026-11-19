#!/usr/bin/env python3
"""Convert the pinned Barker et al. PSR vectors for the MoonFall catalog."""
import argparse
import hashlib
import json
from itertools import groupby
from pathlib import Path
from tempfile import TemporaryDirectory

from osgeo import ogr, osr

SOURCE = {
    "shp": "39a9906545188ea4d9b844d34f946de7a6721993f778076d85778650cbbfb741",
    "shx": "3bc10378025d62ded5805e2eebe4c016e461a8c6fe661f15367e4019f2b85827",
    "dbf": "23c3e3a01cde8d8c2114196f7430c46c24505c1a6e75fcdb522670d8efcc62da",
    "prj": "793b80952f23fbff90f48f9e13868b6b7fc5dc07ba0b1633b124c3db52462854",
}


def ring_coordinates(ring):
    # The shapefile repeats some adjacent positions. Omit zero-length edges.
    return [list(point) for point, _ in groupby(
        tuple(round(value, 9) for value in position) for position in ring
    )]


def build(source):
    ogr.UseExceptions()
    osr.UseExceptions()
    with TemporaryDirectory() as directory:
        # A lowercase basename and suffixes also work on case-sensitive filesystems.
        directory = Path(directory)
        for suffix, digest in SOURCE.items():
            original = source / f"psr.{suffix}"
            with original.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                    raise ValueError(f"Unexpected source SHA-256 for {original}")
            (directory / original.name).symlink_to(original.resolve())
        dataset = ogr.Open(str(directory / "psr.shp"))
        layer = dataset.GetLayer()
        projected = layer.GetSpatialRef()
        geographic = projected.CloneGeogCS()
        geographic.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        inverse_projection = osr.CoordinateTransformation(projected, geographic)
        forward_projection = osr.CoordinateTransformation(geographic, projected)
        shackleton = ogr.Geometry(ogr.wkbPoint)
        shackleton.AddPoint_2D(129.78, -89.67)
        shackleton.Transform(forward_projection)
        features = []
        for feature in layer:
            gid = int(feature.GetField("gid"))
            shape = feature.GetGeometryRef()
            if shape.Distance(shackleton) > 16_000:
                continue
            if not shape.IsValid():
                raise ValueError(f"Invalid source polygon {gid}")
            # Keep complete source polygons, including all components and rings.
            shape = shape.Clone()
            shape.Transform(inverse_projection)
            geometry = json.loads(shape.ExportToJson())
            coordinates = geometry["coordinates"]
            if geometry["type"] == "Polygon":
                geometry["coordinates"] = [ring_coordinates(ring) for ring in coordinates]
            else:
                geometry["coordinates"] = [[ring_coordinates(ring) for ring in polygon] for polygon in coordinates]
            features.append({
                "type": "Feature",
                "id": gid,
                "properties": {
                    "name": "Shackleton PSR" if gid == 13 else f"PSR {gid}",
                    "gid": gid,
                    "area_km2": float(feature.GetField("area_km2")),
                    "source_name": feature.GetField("name").strip('"'),
                },
                "geometry": geometry,
            })
    return {"type": "FeatureCollection", "features": sorted(features, key=lambda feature: feature["id"])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_directory", type=Path)
    parser.add_argument("output_directory", type=Path)
    args = parser.parse_args()
    output = (json.dumps(build(args.source_directory), separators=(",", ":"), allow_nan=False) + "\n").encode()
    revision = hashlib.sha256(output).hexdigest()
    path = args.output_directory / f"moonfall-psr-{revision[:16]}.geojson"
    path.write_bytes(output)
    print(f"{revision}  {path}")
