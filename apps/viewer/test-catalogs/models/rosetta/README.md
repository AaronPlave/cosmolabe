# Rosetta and Philae visual models

Original ESA SPICE Service Cosmographia assets:
https://spiftp.esac.esa.int/cosmographia/missions/ROS/models/

Configuration defining their origins, frames, and separation switch:
https://spiftp.esac.esa.int/cosmographia/missions/ROS/config/spacecraft_ROS_arcs.json

The six 3DS files are unmodified archive downloads, already in body-fixed
kilometres. The catalog preserves SPICE trajectories and articulation, using
the bus structure origin rather than the spacecraft centre of mass. The two
bus versions include/exclude the stowed lander. Comet/asteroid physical surfaces
continue to use native DSKs.

Run `bash scripts/fetch-rosetta-models.sh` from the repository root to obtain
the four original texture maps (not committed). That script verifies all ten
assets against `scripts/rosetta-models.sha256`. `fetch-all.sh` and Pages builds
also run it. No imagery is generated or reconstructed by the application.
