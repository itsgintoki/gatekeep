import crypto from "crypto";

const BASE62_CHARSET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CHARSET_LENGTH = BigInt(BASE62_CHARSET.length);

export function generateSlug(length: number = 7): string {
  const bytes = crypto.randomBytes(length);
  let slug = "";
  for (let i = 0; i < length; i++) {
    slug += BASE62_CHARSET[bytes[i] % 62];
  }
  return slug;
}

export function encodeBase62(num: bigint | number): string {
  let value = typeof num === "bigint" ? num : BigInt(num);
  if (value === 0n) return BASE62_CHARSET[0];

  let result = "";
  while (value > 0n) {
    const remainder = Number(value % CHARSET_LENGTH);
    result = BASE62_CHARSET[remainder] + result;
    value = value / CHARSET_LENGTH;
  }
  return result;
}

export function decodeBase62(str: string): bigint {
  let result = 0n;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const index = BASE62_CHARSET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid Base62 character: ${char}`);
    }
    result = result * CHARSET_LENGTH + BigInt(index);
  }
  return result;
}
