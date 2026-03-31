/**
 * Compute LVLH (Local Vertical Local Horizontal) frame from position/velocity,
 * and compose with a body-relative quaternion to get inertial orientation.
 *
 * LVLH frame definition (ISS convention):
 *   X = velocity direction (along-track, RAM)
 *   Z = -R (nadir, toward Earth center)
 *   Y = Z × X (cross-track, completes right-hand system)
 *
 * The ISS attitude quaternion from Lightstreamer is rotation from LVLH to body.
 * To get inertial orientation: q_inertial = q_LVLH_to_ECI * q_body_to_LVLH
 */

import * as Cesium from 'cesium';

/**
 * Compute the LVLH-to-inertial rotation matrix from ECI position and velocity.
 *
 * @param positionEci ECI position in meters
 * @param velocityEci ECI velocity in m/s
 * @returns Cesium.Quaternion representing LVLH→ECI rotation
 */
export function computeLvlhQuaternion(
  positionEci: Cesium.Cartesian3,
  velocityEci: Cesium.Cartesian3,
): Cesium.Quaternion {
  // Z_lvlh = -position (nadir)
  const zAxis = Cesium.Cartesian3.negate(positionEci, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(zAxis, zAxis);

  // X_lvlh = velocity direction (approximate — should subtract radial component)
  // More precisely: X = V - (V·Z)Z to get along-track component
  const vDotZ = Cesium.Cartesian3.dot(velocityEci, zAxis);
  const xAxis = Cesium.Cartesian3.subtract(
    velocityEci,
    Cesium.Cartesian3.multiplyByScalar(zAxis, vDotZ, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  Cesium.Cartesian3.normalize(xAxis, xAxis);

  // Y_lvlh = Z × X (right-hand completion)
  const yAxis = Cesium.Cartesian3.cross(zAxis, xAxis, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(yAxis, yAxis);

  // Build rotation matrix [X Y Z] (columns are LVLH axes in ECI)
  const rotMatrix = new Cesium.Matrix3(
    xAxis.x, yAxis.x, zAxis.x,
    xAxis.y, yAxis.y, zAxis.y,
    xAxis.z, yAxis.z, zAxis.z,
  );

  return Cesium.Quaternion.fromRotationMatrix(rotMatrix);
}

/**
 * Compose LVLH frame quaternion with body-relative attitude to get
 * inertial orientation suitable for Cesium entity.orientation.
 *
 * @param lvlhQuat LVLH→ECI rotation
 * @param bodyQuat Body→LVLH rotation (from ISS telemetry, scalar-first [q0,q1,q2,q3])
 * @returns Cesium.Quaternion for entity.orientation (ECI frame)
 */
export function composeAttitude(
  lvlhQuat: Cesium.Quaternion,
  bodyQuat: [number, number, number, number],
): Cesium.Quaternion {
  // bodyQuat is [q0, q1, q2, q3] scalar-first
  // Cesium.Quaternion is (x, y, z, w) scalar-last
  const bodyQ = new Cesium.Quaternion(bodyQuat[1], bodyQuat[2], bodyQuat[3], bodyQuat[0]);

  // q_inertial = q_LVLH_to_ECI * q_body_to_LVLH
  return Cesium.Quaternion.multiply(lvlhQuat, bodyQ, new Cesium.Quaternion());
}
