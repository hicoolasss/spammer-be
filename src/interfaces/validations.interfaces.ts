export interface ValidationOptions<T = unknown> {
  defaultValue?: T;
  required?: boolean;
  enumValues?: T[];
  customValidator?: (value: T) => boolean;
}
