/**
 * Styling configuration for Cesium entities.
 */

/** Style options for a body rendered as a Cesium entity. */
export interface EntityStyleOptions {
  /** Point pixel size. Default: 10. */
  pointSize?: number;
  /** CSS color string. Default: '#00ff00'. */
  color?: string;
  /** Show label. Default: true. */
  showLabel?: boolean;
  /** Label font. Default: '14px sans-serif'. */
  labelFont?: string;
  /** Label vertical offset in pixels. Default: -20. */
  labelOffset?: number;
  /** Pulse animation on event. Default: false. */
  pulseOnEvent?: boolean;
  /** Pulse duration in ms. Default: 1000. */
  pulseDuration?: number;
  /** Pulse max pixel size. Default: 40. */
  pulseMaxSize?: number;
}

/** Resolved style with all defaults applied. */
export interface ResolvedEntityStyle {
  pointSize: number;
  color: string;
  showLabel: boolean;
  labelFont: string;
  labelOffset: number;
  pulseOnEvent: boolean;
  pulseDuration: number;
  pulseMaxSize: number;
}

export function resolveEntityStyle(opts?: EntityStyleOptions): ResolvedEntityStyle {
  return {
    pointSize: opts?.pointSize ?? 10,
    color: opts?.color ?? '#00ff00',
    showLabel: opts?.showLabel ?? true,
    labelFont: opts?.labelFont ?? '14px sans-serif',
    labelOffset: opts?.labelOffset ?? -20,
    pulseOnEvent: opts?.pulseOnEvent ?? false,
    pulseDuration: opts?.pulseDuration ?? 1000,
    pulseMaxSize: opts?.pulseMaxSize ?? 40,
  };
}
