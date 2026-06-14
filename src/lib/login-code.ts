/** Generate a random 6-digit login passcode for general users. */
export function generateLoginCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
