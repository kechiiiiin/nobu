// バーコードの読み取り結果から「確定」を決める（誤読防止）。純粋関数なのでテストできる。
//   - 書籍の ISBN-13（978/979・検算合格）だけを拾う。2段目（192…）などは黙って捨てる
//   - 同じ値を連続2回読んだら確定（間が CONFIRM_GAP_MS 以上空いたら数え直し）
//   - 直前に確定したのと同じ ISBN は SAME_IGNORE_MS の間は無視

import { isBookIsbn13 } from "./isbn.ts";

export const CONFIRM_GAP_MS = 1500;
export const SAME_IGNORE_MS = 10_000;

export class ScanGate {
  private candidate: { code: string; at: number } | null = null;
  private lastConfirmed: { code: string; at: number } | null = null;

  /** 1フレーム分の読み取り結果（複数可）を渡す。確定した ISBN があれば返す */
  feed(codes: string[], now: number): string | null {
    const isbn = codes.find((c) => isBookIsbn13(c));
    if (!isbn) return null;
    if (this.lastConfirmed && this.lastConfirmed.code === isbn && now - this.lastConfirmed.at < SAME_IGNORE_MS) {
      return null;
    }
    if (this.candidate && this.candidate.code === isbn && now - this.candidate.at <= CONFIRM_GAP_MS) {
      this.candidate = null;
      this.lastConfirmed = { code: isbn, at: now };
      return isbn;
    }
    this.candidate = { code: isbn, at: now };
    return null;
  }

  /** 取り消したときなど、同じ本をすぐ読み直せるようにする */
  forget(code: string) {
    if (this.lastConfirmed?.code === code) this.lastConfirmed = null;
  }
}
