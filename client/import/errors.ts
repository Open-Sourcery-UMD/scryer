export class ImportError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ImportError';
    this.code = code;
  }
}
