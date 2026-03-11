export interface ResourceLayer {
  readonly name: string;
  readonly resourceNames: string[];
  getValue(resourceName: string, et: number): number | boolean | string | undefined;
}
