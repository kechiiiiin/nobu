// ISBN の正規化と検算。Worker と画面の両方で使う（依存なし）

/** 数字と X 以外を落とす */
export function digitsOnly(s: string): string {
  return s.replace(/[^0-9Xx]/g, "").toUpperCase();
}

/** EAN-13 のチェックディジットが合っているか */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

/** 書籍の ISBN-13（978/979 始まり・検算合格）か。2段目（192…）などは false */
export function isBookIsbn13(code: string): boolean {
  return /^97[89]\d{10}$/.test(code) && isValidEan13(code);
}

export function isValidIsbn10(code: string): boolean {
  if (!/^\d{9}[\dX]$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (code[i] === "X" ? 10 : Number(code[i])) * (10 - i);
  return sum % 11 === 0;
}

export function isbn10to13(code10: string): string {
  const body = "978" + code10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

/** 入力（ハイフン入り・10桁・13桁）を ISBN-13 に。書籍の ISBN でなければ null */
export function toIsbn13(input: string): string | null {
  const d = digitsOnly(input);
  if (d.length === 13) return isBookIsbn13(d) ? d : null;
  if (d.length === 10) return isValidIsbn10(d) ? isbn10to13(d) : null;
  return null;
}
