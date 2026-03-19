export interface Args {
  command: string;
  json: boolean;
  workflow: string;
  verbose: boolean;
  foreground: boolean;
  follow: boolean;
  shortF: boolean;
  lines: number;
  all: boolean;
  instanceId: string | null;
  strict: boolean;
}
