export function generateFbclid(): string {
  const firstPart = generateRandomString(67, 72);
  const secondPart = generateRandomString(20, 24);

  return `lwZXh0bgNhZW0BMABhZGlkAas${firstPart}_aem_${secondPart}`;
}

function generateRandomString(minLength: number, maxLength: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const length =
    Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;

  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
}