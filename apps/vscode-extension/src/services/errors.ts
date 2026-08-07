export class Ask2GPTError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Ask2GPTError";
  }
}
