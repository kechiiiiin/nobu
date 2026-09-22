// バーコードの読み取り結果から「確定」を決める（誤読防止）。純粋関数なのでテストできる。
//   - 書籍の ISBN-13（978/979・検算合格）だけを拾う。2段目（192…）などは黙って捨てる
//   - 同じ値を連続2回読んだら確定（間が CONFIRM_GAP_MS 以上空いたら数え直し）
//   - 直前に確定したのと同じ ISBN は SAME_IGNORE_MS の間は無視
//   - 取り消し・失敗した ISBN は「一度カメラから外れるまで」確定しない（カメラ前に本が残っていても再登録しない）

import { isBookIsbn13 } from "./isbn.ts";

export const CONFIRM_GAP_MS = 1500;
export const SAME_IGNORE_MS = 10_000;
/** 取り消した本が「外れた」とみなすまでの、写らない時間（1フレームの読み損じで解けないように） */
export const GONE_MS = 1000;

export class ScanGate {
  private candidate: { code: string; at: number } | null = null;
  private lastConfirmed: { code: string; at: number } | null = null;
  /** この ISBN が GONE_MS 以上写らないか、別の本が写るまで確定しない */
  private held: { code: string; lastSeen: number } | null = null;

  /** 1フレーム分の読み取り結果（何も読めなかったフレームは空配列）を渡す。確定した ISBN があれば返す */
  feed(codes: string[], now: number): string | null {
    const isbn = codes.find((c) => isBookIsbn13(c));
    if (this.held) {
      if (isbn === this.held.code) {
        this.held.lastSeen = now;
        this.candidate = null;
        return null;
      }
      // 別の本が写った、または GONE_MS 以上写っていない → 解く
      if (isbn || now - this.held.lastSeen >= GONE_MS) this.held = null;
      else return null;
    }
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

  /**
   * 取り消したとき・登録に失敗したとき。10秒の無視は解くが、
   * その本が一度カメラから外れる（GONE_MS 以上写らない）か別の本が写るまでは確定しない
   */
  holdUntilGone(code: string, now: number) {
    if (this.lastConfirmed?.code === code) this.lastConfirmed = null;
    if (this.candidate?.code === code) this.candidate = null;
    this.held = { code, lastSeen: now };
  }
}
