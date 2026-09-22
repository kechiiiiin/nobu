// node --test（Node 24 の型除去で .ts をそのまま動かす）
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBookIsbn13, isValidEan13, toIsbn13 } from "../shared/isbn.ts";
import { ScanGate, SAME_IGNORE_MS } from "../shared/scangate.ts";
import {
  normalizeNdlCreator,
  normalizeNdlDate,
  normalizeOpenbdDate,
  normalizeRakutenDate,
  parseNdl,
  parseOpenbd,
  parseRakuten,
  rakutenCover,
  decodeXml,
} from "../src/lookup.ts";

test("ISBN: 検算と正規化", () => {
  assert.equal(isValidEan13("9784862762108"), true);
  assert.equal(isValidEan13("9784862762109"), false);
  assert.equal(isBookIsbn13("9784862762108"), true);
  // 書籍の2段目（192…）は EAN-13 として正しくても本の ISBN ではない
  assert.equal(isBookIsbn13("1920336016001"), false);
  assert.equal(toIsbn13("4-495-35351-9"), "9784495353513");
  assert.equal(toIsbn13("978-4-86276-210-8"), "9784862762108");
  assert.equal(toIsbn13("4-495-35351-0"), null);
  assert.equal(toIsbn13("12345"), null);
});

test("スキャン: 2回連続で確定・2段目は無視・同じ本は10秒無視", () => {
  const g = new ScanGate();
  const isbn = "9784862762108";
  const lower = "1920336016001";
  assert.equal(g.feed([lower], 0), null);
  assert.equal(g.feed([isbn], 100), null);
  assert.equal(g.feed([lower, isbn], 250), isbn);
  assert.equal(g.feed([isbn], 400), null);
  assert.equal(g.feed([isbn], 550), null);
  assert.equal(g.feed([isbn], SAME_IGNORE_MS + 600), null); // 候補に戻るだけ
  assert.equal(g.feed([isbn], SAME_IGNORE_MS + 700), isbn);
  // 取り消した直後、本がカメラ前に残っていても再登録しない
  const T = SAME_IGNORE_MS;
  g.holdUntilGone(isbn, T + 750);
  for (let t = 800; t < 5000; t += 150) {
    // ときどき読み損じのフレーム（空）が混ざっても解けない
    assert.equal(g.feed(t % 600 === 200 ? [] : [isbn], T + t), null);
  }
  // 1秒以上写らなければ外れたとみなし、戻せばまた読める
  assert.equal(g.feed([], T + 5100), null);
  assert.equal(g.feed([], T + 6000), null);
  g.feed([isbn], T + 6100);
  assert.equal(g.feed([isbn], T + 6200), isbn);
  // 別の本を写しても解ける
  g.holdUntilGone(isbn, T + 5300);
  const other = "9784334033071";
  assert.equal(g.feed([other], SAME_IGNORE_MS + 5400), null);
  assert.equal(g.feed([other], SAME_IGNORE_MS + 5500), other);
  // 間が空きすぎたら数え直し
  const g2 = new ScanGate();
  g2.feed([isbn], 0);
  assert.equal(g2.feed([isbn], 5000), null);
  assert.equal(g2.feed([isbn], 5100), isbn);
});

test("楽天: 画像サイズの差し替え・日付・formatVersion 1/2", () => {
  assert.equal(
    rakutenCover("https://thumbnail.image.rakuten.co.jp/@0_mall/book/cabinet/2108/9784862762108_1_3.jpg?_ex=200x200"),
    "https://thumbnail.image.rakuten.co.jp/@0_mall/book/cabinet/2108/9784862762108_1_3.jpg?_ex=600x600",
  );
  assert.equal(rakutenCover("https://thumbnail.image.rakuten.co.jp/@0_mall/book/cabinet/noimage_01.gif?_ex=200x200"), null);
  assert.equal(normalizeRakutenDate("2017年06月20日頃"), "2017-06-20");
  assert.equal(normalizeRakutenDate("2017年06月"), "2017-06");
  const item = {
    title: "「学習する組織」入門",
    author: "小田理一郎",
    publisherName: "英治出版",
    salesDate: "2017年06月",
    isbn: "9784862762108",
    largeImageUrl: "https://thumbnail.image.rakuten.co.jp/@0_mall/book/cabinet/2108/9784862762108_1_3.jpg?_ex=200x200",
  };
  const v2 = parseRakuten({ Items: [item] });
  const v1 = parseRakuten({ Items: [{ Item: item }] });
  assert.deepEqual(v1, v2);
  assert.equal(v2[0]!.isbn13, "9784862762108");
  assert.equal(v2[0]!.cover_kind, "rakuten");
  assert.equal(v2[0]!.meta_source, "rakuten");
});

test("NDL: OpenSearch の RSS から候補を作る", () => {
  const xml = `<rss><channel>
    <item>
      <title>学習する組織 : 近未来型組織戦略</title>
      <category>図書</category><category>紙</category>
      <dc:title>学習する組織 : 近未来型組織戦略</dc:title>
      <dc:creator>寺本, 義也, 1942-</dc:creator>
      <dc:publisher>同文館出版</dc:publisher>
      <dc:date xsi:type="dcterms:W3CDTF">1993</dc:date>
      <dcterms:issued>1993.1</dcterms:issued>
      <dc:identifier xsi:type="dcndl:ISBN">4-495-35351-9</dc:identifier>
    </item>
    <item>
      <category>図書</category><category>電子</category>
      <dc:title>無料お試し版 &amp; ほか</dc:title>
    </item>
    <item>
      <category>図書</category><category>紙</category>
      <dc:title>ISBN の無い紙の本 &lt;上&gt;</dc:title>
      <dc:creator>山田, 太郎</dc:creator>
    </item>
  </channel></rss>`;
  const list = parseNdl(xml);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.isbn13, "9784495353513");
  assert.equal(list[0]!.author, "寺本義也");
  assert.equal(list[0]!.pubdate, "1993-01");
  assert.equal(list[0]!.cover_url, "https://img.hanmoto.com/bd/img/9784495353513.jpg");
  assert.equal(list[0]!.cover_unverified, true);
  assert.equal(list[1]!.title, "ISBN の無い紙の本 <上>");
  assert.equal(list[1]!.isbn13, null);
  assert.equal(list[1]!.cover_url, null);
  assert.equal(normalizeNdlCreator("Senge, Peter M., 1947-2020"), "Peter M. Senge");
  assert.equal(normalizeNdlDate("2017.6"), "2017-06");
});

test("openBD: summary から候補を作る", () => {
  const c = parseOpenbd(
    [{ summary: { isbn: "9784862762108", title: "「学習する組織」入門", volume: "", publisher: "英治出版", pubdate: "201706", cover: "", author: "小田,理一郎" } }],
    "9784862762108",
  );
  assert.equal(c?.author, "小田理一郎");
  assert.equal(c?.pubdate, "2017-06");
  assert.equal(parseOpenbd([null], "9784862762108"), null);
  assert.equal(normalizeOpenbdDate("20170620"), "2017-06-20");
});

test("XML: 範囲外の数値文字参照で落ちない", () => {
  assert.equal(decodeXml("A&#x110000;B&#65;&amp;"), "A&#x110000;BA&");
  assert.equal(decodeXml("&#99999999;"), "&#99999999;");
  const list = parseNdl("<item><category>紙</category><dc:title>壊れた &#x110000; 題</dc:title></item><item><category>紙</category><dc:title>普通の本</dc:title></item>");
  assert.equal(list.length, 2);
});
