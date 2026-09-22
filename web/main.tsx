import { render } from "preact";
import { Link, ToastHost, useLocation } from "./ui.tsx";
import { SearchPage } from "./search.tsx";
import { ScanPage } from "./scan.tsx";
import { ShelfPage } from "./shelf.tsx";
import { BookPage } from "./book.tsx";

function App() {
  const { path } = useLocation();
  let page;
  let tab: "search" | "scan" | "shelf" | "" = "";
  const m = path.match(/^\/books\/(\d+)$/);
  if (m) page = <BookPage id={Number(m[1])} />;
  else if (path === "/scan") {
    page = <ScanPage />;
    tab = "scan";
  } else if (path === "/shelf") {
    page = <ShelfPage />;
    tab = "shelf";
  } else {
    page = <SearchPage />;
    tab = "search";
  }

  return (
    <>
      <header class="top">
        <Link href="/" class="brand">
          NoBu
        </Link>
      </header>
      <main>
        {page}
        {tab !== "scan" && <footer class="credit">書誌・書影：楽天ブックス／国立国会図書館サーチ（NDL サーチ API）／openBD／版元ドットコム</footer>}
      </main>
      <ToastHost />
      <nav class="tabbar">
        <Link href="/" class={tab === "search" ? "on" : ""}>
          <Icon d="M10.5 18a7.5 7.5 0 1 1 5.3-2.2L21 21" />
          さがす
        </Link>
        <Link href="/scan" class={tab === "scan" ? "on" : ""}>
          <Icon d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3M8 8v8M11 8v8M13.5 8v8M16 8v8" />
          スキャン
        </Link>
        <Link href="/shelf" class={tab === "shelf" ? "on" : ""}>
          <Icon d="M4 4h4v16H4zM10 4h4v16h-4zM15.5 5.2l3.8-1 3.9 14.6-3.8 1z" />
          本棚
        </Link>
      </nav>
    </>
  );
}

function Icon(props: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={props.d} />
    </svg>
  );
}

render(<App />, document.getElementById("app")!);
